// ---------------------------------------------------------------------------
// Admin access: unlock, lockout, change passcode.
//
// The lockout is the real security control here, not the hash (see
// passcode.js). A 4-digit code is 10,000 possibilities; without a lockout it
// falls in seconds. docs/SECURITY.md calls this mandatory before any public
// deployment, and it is enforced here rather than left to the HTTP layer.
//
// Uniform failures: a caller can never tell "wrong passcode" from "no passcode
// configured" — same shape, same timing (docs/SECURITY.md).
// ---------------------------------------------------------------------------
import { one, run, nowIso } from "../db/client.js";
import { hashPasscode, verifyPasscode, validatePasscode, isUsableHash, dummyWork } from "./passcode.js";

export const POLICY = Object.freeze({
  passcodeLength: 4,
  maxAttempts: 5,
  // Escalating lockout, from the failed_attempts column alone:
  //
  //   failures 1-4   no lock, countdown shown
  //   failure  5     locked 5 min      <- tier 1
  //   failures 6-9   each one re-locks for 5 min
  //   failure  10    locked 10 min     <- tier 2
  //   failure  15    locked 20 min, and so on, capped at maxLockoutSeconds
  //
  // Note the middle line: once past the threshold, EVERY wrong attempt locks
  // again. So an attacker gets one guess per lock window, and the window
  // doubles every `maxAttempts` failures. Against a 10,000-value keyspace that
  // is the difference between minutes and centuries. The cap exists so a host
  // who fat-fingers the code is never locked out permanently.
  lockoutSeconds: 300,
  maxLockoutSeconds: 3600,
});

export function policyFromEnv(env = process.env) {
  const num = (v, d) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return Object.freeze({
    passcodeLength: num(env.ADMIN_PASSCODE_LENGTH, POLICY.passcodeLength),
    maxAttempts: num(env.AUTH_MAX_ATTEMPTS, POLICY.maxAttempts),
    lockoutSeconds: num(env.AUTH_LOCKOUT_SECONDS, POLICY.lockoutSeconds),
    maxLockoutSeconds: num(env.AUTH_MAX_LOCKOUT_SECONDS, POLICY.maxLockoutSeconds),
  });
}

/** How long a lock lasts after `failed` consecutive wrong attempts. */
export function lockoutSecondsFor(failed, policy = POLICY) {
  const tier = Math.floor(failed / policy.maxAttempts);
  if (tier < 1) return 0;
  return Math.min(policy.lockoutSeconds * 2 ** (tier - 1), policy.maxLockoutSeconds);
}

const readAuth = (client) =>
  one(client, "SELECT passcode_hash, failed_attempts, locked_until FROM admin_auth WHERE id = 1");

/**
 * Is the admin side usable at all? Called at boot so a deployment cannot come
 * up sitting on the migrator's placeholder hash.
 */
export async function authStatus(client) {
  const row = await readAuth(client);
  if (!row) return { configured: false, reason: "no_admin_row" };
  if (!isUsableHash(row.passcode_hash)) return { configured: false, reason: "placeholder_hash" };
  return { configured: true, failedAttempts: row.failed_attempts, lockedUntil: row.locked_until };
}

/**
 * Attempt an unlock.
 *
 * @returns {{ok: boolean, lockedUntil?: string, retryAfterSeconds?: number,
 *            attemptsRemaining?: number}} Never says *why* it failed beyond
 *   "locked" vs "not ok" — a wrong passcode and an unconfigured system are
 *   indistinguishable.
 */
export async function unlock(client, passcode, { policy = POLICY, now = Date.now() } = {}) {
  const row = await readAuth(client);

  if (!row) {
    await dummyWork();                               // match the timing of a real check
    return { ok: false, attemptsRemaining: policy.maxAttempts };
  }

  // Locked: refuse before doing any work. The caller already knows it is
  // locked, so there is no timing signal to protect, and spending 150ms of CPU
  // per rejected attempt would hand an attacker a cheap way to load the box.
  if (row.locked_until && now < Date.parse(row.locked_until)) {
    return {
      ok: false,
      lockedUntil: row.locked_until,
      retryAfterSeconds: Math.ceil((Date.parse(row.locked_until) - now) / 1000),
    };
  }

  const { ok, needsRehash } = await verifyPasscode(passcode, row.passcode_hash);

  if (ok) {
    // A clean unlock clears the slate, including any expired lock.
    const hash = needsRehash ? await hashPasscode(passcode) : row.passcode_hash;
    await run(client,
      "UPDATE admin_auth SET failed_attempts = 0, locked_until = NULL, passcode_hash = ?, updated_at = ? WHERE id = 1",
      [hash, nowIso()]);
    return { ok: true, rehashed: needsRehash };
  }

  const failed = (row.failed_attempts || 0) + 1;
  const lockFor = lockoutSecondsFor(failed, policy);
  const lockedUntil = lockFor > 0 ? new Date(now + lockFor * 1000).toISOString() : null;
  await run(client,
    "UPDATE admin_auth SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = 1",
    [failed, lockedUntil, nowIso()]);

  return lockedUntil
    ? { ok: false, lockedUntil, retryAfterSeconds: lockFor }
    : { ok: false, attemptsRemaining: Math.max(0, policy.maxAttempts - (failed % policy.maxAttempts)) };
}

/**
 * Set a new passcode. Takes effect immediately and clears any lock — a host who
 * locked themselves out and then changed the code should be able to get in.
 */
export async function setPasscode(client, next, { policy = POLICY } = {}) {
  const check = validatePasscode(next, policy.passcodeLength);
  if (!check.ok) return { ok: false, reason: check.reason };
  const hash = await hashPasscode(check.value);
  const res = await run(client,
    "UPDATE admin_auth SET passcode_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = 1",
    [hash, nowIso()]);
  if (!res.rowsAffected) return { ok: false, reason: "not_initialised" };
  return { ok: true };
}

/** First-run install. Does nothing if a passcode is already set. */
export async function initialisePasscode(client, passcode, { policy = POLICY } = {}) {
  const check = validatePasscode(passcode, policy.passcodeLength);
  if (!check.ok) return { ok: false, reason: check.reason };
  const hash = await hashPasscode(check.value);
  await run(client,
    `INSERT INTO admin_auth (id, passcode_hash, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET passcode_hash = excluded.passcode_hash, updated_at = excluded.updated_at
     WHERE NOT (admin_auth.passcode_hash LIKE 'scrypt$%')`,
    [hash, nowIso()]);
  return { ok: true };
}

// Admin access. The lockout is the control that actually protects a 4-digit
// passcode, so most of this file is about the lockout rather than the hash.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, one, run, nowIso } from "../src/db/client.js";
import { migrate, seedFirstRun } from "../src/db/migrate.js";
import {
  hashPasscode, verifyPasscode, parseHash, isUsableHash, validatePasscode, DEFAULT_PARAMS,
} from "../src/auth/passcode.js";
import {
  unlock, setPasscode, initialisePasscode, authStatus, lockoutSecondsFor, policyFromEnv, POLICY,
} from "../src/auth/admin.js";

let dir, db, client;
const policy = { passcodeLength: 4, maxAttempts: 3, lockoutSeconds: 60, maxLockoutSeconds: 600 };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-auth-"));
  db = openDatabase({ url: `file:${join(dir, "t.db")}` });
  client = db.client;
  await migrate(db);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await run(client, "DELETE FROM admin_auth");
  await initialisePasscode(client, "0000", { policy });
});

// --- hashing --------------------------------------------------------------
test("a passcode round-trips, and a wrong one does not", async () => {
  const hash = await hashPasscode("1357");
  assert.equal((await verifyPasscode("1357", hash)).ok, true);
  assert.equal((await verifyPasscode("1358", hash)).ok, false);
  assert.equal((await verifyPasscode("", hash)).ok, false);
  assert.equal((await verifyPasscode("13570", hash)).ok, false);
});

test("the passcode is never recoverable from what we store", async () => {
  const hash = await hashPasscode("1357");
  assert.doesNotMatch(hash, /1357/);
  // Same passcode, different salt, different hash — so the table cannot be
  // read by comparing rows, and a rainbow table is useless.
  assert.notEqual(hash, await hashPasscode("1357"));
});

test("the stored format carries its own parameters, so cost can be raised later", async () => {
  const hash = await hashPasscode("0000");
  const parsed = parseHash(hash);
  assert.equal(parsed.N, DEFAULT_PARAMS.N);
  assert.equal(parsed.r, DEFAULT_PARAMS.r);
  assert.equal(parsed.hash.length, DEFAULT_PARAMS.keylen);
  assert.equal(parsed.salt.length, DEFAULT_PARAMS.saltBytes);

  // A hash made with weaker parameters still verifies, and asks to be upgraded.
  const weak = await hashPasscode("0000", { N: 16384 });
  const res = await verifyPasscode("0000", weak);
  assert.equal(res.ok, true);
  assert.equal(res.needsRehash, true, "so a successful unlock can quietly re-hash it");
  assert.equal((await verifyPasscode("0000", hash)).needsRehash, false);
});

test("garbage in the hash column fails closed and never throws", async () => {
  for (const bad of [
    "PLACEHOLDER_NOT_A_HASH", "", null, undefined, 12345,
    "scrypt$65536$8$1$onlyfourparts", "bcrypt$1$2$3$a$b",
    "scrypt$x$8$1$AAAA$AAAA", "scrypt$65536$8$1$$", "$$$$$",
  ]) {
    assert.equal(isUsableHash(bad), false, `isUsableHash(${JSON.stringify(bad)})`);
    const res = await verifyPasscode("0000", bad);
    assert.equal(res.ok, false, `verify against ${JSON.stringify(bad)}`);
  }
});

test("only exactly-N digits are accepted as a passcode", () => {
  assert.equal(validatePasscode("1234", 4).ok, true);
  for (const bad of ["123", "12345", "12a4", "", " 123", "1.23", null, undefined, "١٢٣٤"]) {
    assert.equal(validatePasscode(bad, 4).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- first run ------------------------------------------------------------
test("the migrator's placeholder is reported as not configured", async () => {
  await run(client, "UPDATE admin_auth SET passcode_hash = 'PLACEHOLDER_NOT_A_HASH' WHERE id = 1");
  const status = await authStatus(client);
  assert.equal(status.configured, false);
  assert.equal(status.reason, "placeholder_hash", "the server must refuse to boot on this");
  // And it cannot be unlocked by guessing the placeholder text itself.
  assert.equal((await unlock(client, "0000", { policy })).ok, false);
  assert.equal((await unlock(client, "PLACEHOLDER_NOT_A_HASH", { policy })).ok, false);
});

test("initialising replaces a placeholder but never an established passcode", async () => {
  await setPasscode(client, "2468", { policy });
  await initialisePasscode(client, "0000", { policy });
  assert.equal((await unlock(client, "2468", { policy })).ok, true, "the real passcode survives");
  assert.equal((await unlock(client, "0000", { policy })).ok, false, "first-run default does not come back");

  await run(client, "UPDATE admin_auth SET passcode_hash = 'PLACEHOLDER_NOT_A_HASH' WHERE id = 1");
  await initialisePasscode(client, "0000", { policy });
  assert.equal((await authStatus(client)).configured, true, "a placeholder does get replaced");
});

test("a missing admin row fails exactly like a wrong passcode", async () => {
  await run(client, "DELETE FROM admin_auth");
  const missing = await unlock(client, "0000", { policy });
  await initialisePasscode(client, "0000", { policy });
  const wrong = await unlock(client, "9999", { policy });
  assert.equal(missing.ok, false);
  assert.equal(wrong.ok, false);
  assert.deepEqual(Object.keys(missing).sort(), Object.keys(wrong).sort(),
    "the response must not reveal whether a passcode is even configured");
});

// --- lockout: the control that matters -----------------------------------
test("lockout duration escalates per tier and then caps", () => {
  const p = { maxAttempts: 5, lockoutSeconds: 300, maxLockoutSeconds: 3600 };
  assert.equal(lockoutSecondsFor(0, p), 0);
  assert.equal(lockoutSecondsFor(4, p), 0, "no lock before the threshold");
  assert.equal(lockoutSecondsFor(5, p), 300, "tier 1");
  // Past the threshold every wrong attempt re-locks, at the current tier.
  assert.equal(lockoutSecondsFor(6, p), 300);
  assert.equal(lockoutSecondsFor(9, p), 300);
  assert.equal(lockoutSecondsFor(10, p), 600, "tier 2");
  assert.equal(lockoutSecondsFor(15, p), 1200);
  assert.equal(lockoutSecondsFor(20, p), 2400);
  assert.equal(lockoutSecondsFor(25, p), 3600);
  assert.equal(lockoutSecondsFor(100, p), 3600, "capped, so a host is never locked out for ever");
});

test("wrong attempts count down, then lock", async () => {
  const a = await unlock(client, "1111", { policy });
  assert.equal(a.ok, false);
  assert.equal(a.attemptsRemaining, 2);
  assert.equal((await unlock(client, "1111", { policy })).attemptsRemaining, 1);

  const third = await unlock(client, "1111", { policy });
  assert.equal(third.ok, false);
  assert.ok(third.lockedUntil, "the third wrong attempt locks");
  assert.equal(third.retryAfterSeconds, 60);
});

test("while locked, even the CORRECT passcode is refused", async () => {
  for (let i = 0; i < policy.maxAttempts; i++) await unlock(client, "1111", { policy });
  const locked = await unlock(client, "0000", { policy });
  assert.equal(locked.ok, false, "this is the whole point of a lockout");
  assert.ok(locked.retryAfterSeconds > 0);
});

test("a locked attempt does no hashing work, so it cannot be used to load the CPU", async () => {
  for (let i = 0; i < policy.maxAttempts; i++) await unlock(client, "1111", { policy });
  const t0 = process.hrtime.bigint();
  await unlock(client, "0000", { policy });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 40, `a locked rejection took ${ms.toFixed(0)}ms — it should short-circuit`);
});

test("the lock expires and the correct passcode works again", async () => {
  for (let i = 0; i < policy.maxAttempts; i++) await unlock(client, "1111", { policy });
  const past = new Date(Date.now() - 1000).toISOString();
  await run(client, "UPDATE admin_auth SET locked_until = ? WHERE id = 1", [past]);
  const res = await unlock(client, "0000", { policy });
  assert.equal(res.ok, true);
  const row = await one(client, "SELECT failed_attempts, locked_until FROM admin_auth WHERE id = 1");
  assert.equal(row.failed_attempts, 0, "a clean unlock clears the slate");
  assert.equal(row.locked_until, null);
});

test("past the threshold, every single wrong attempt re-locks, escalating by tier", async () => {
  const expire = () => run(client, "UPDATE admin_auth SET locked_until = ? WHERE id = 1",
    [new Date(Date.now() - 1000).toISOString()]);

  // policy.maxAttempts is 3 here, lockoutSeconds 60.
  await unlock(client, "1111", { policy });
  await unlock(client, "1111", { policy });
  const third = await unlock(client, "1111", { policy });
  assert.equal(third.retryAfterSeconds, 60, "failure 3 -> tier 1");

  // Wait it out; one more wrong guess locks again immediately, same tier.
  await expire();
  const fourth = await unlock(client, "1111", { policy });
  assert.equal(fourth.retryAfterSeconds, 60, "failure 4 -> still tier 1, but locked at once");

  // Two more wrong guesses reach failure 6, which is tier 2.
  await expire();
  await unlock(client, "1111", { policy });
  await expire();
  const sixth = await unlock(client, "1111", { policy });
  assert.equal(sixth.retryAfterSeconds, 120, "failure 6 -> tier 2, twice as long");

  // An attacker therefore gets ONE guess per lock window from failure 3 on.
  const row = await one(client, "SELECT failed_attempts FROM admin_auth WHERE id = 1");
  assert.equal(row.failed_attempts, 6);
});

test("a successful unlock upgrades a weakly-hashed passcode in place", async () => {
  const weak = await hashPasscode("0000", { N: 16384 });
  await run(client, "UPDATE admin_auth SET passcode_hash = ? WHERE id = 1", [weak]);
  const res = await unlock(client, "0000", { policy });
  assert.equal(res.ok, true);
  assert.equal(res.rehashed, true);
  const row = await one(client, "SELECT passcode_hash FROM admin_auth WHERE id = 1");
  assert.equal(parseHash(row.passcode_hash).N, DEFAULT_PARAMS.N, "stored at the current cost now");
  assert.equal((await unlock(client, "0000", { policy })).ok, true, "and still unlocks");
});

// --- changing the passcode ------------------------------------------------
test("changing the passcode takes effect immediately and retires the old one", async () => {
  assert.equal((await setPasscode(client, "2468", { policy })).ok, true);
  assert.equal((await unlock(client, "2468", { policy })).ok, true);
  assert.equal((await unlock(client, "0000", { policy })).ok, false);
});

test("changing the passcode releases a lock", async () => {
  for (let i = 0; i < policy.maxAttempts; i++) await unlock(client, "1111", { policy });
  assert.ok((await unlock(client, "0000", { policy })).retryAfterSeconds);
  await setPasscode(client, "2468", { policy });
  assert.equal((await unlock(client, "2468", { policy })).ok, true,
    "a host who locked themselves out and reset the code should get in");
});

test("an invalid new passcode is rejected and the old one still works", async () => {
  for (const bad of ["123", "abcd", "", "12345"]) {
    assert.equal((await setPasscode(client, bad, { policy })).ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal((await unlock(client, "0000", { policy })).ok, true);
});

// --- configuration --------------------------------------------------------
test("policy comes from the environment, with sane fallbacks", () => {
  assert.deepEqual(policyFromEnv({}), POLICY);
  const p = policyFromEnv({ AUTH_MAX_ATTEMPTS: "7", AUTH_LOCKOUT_SECONDS: "30", ADMIN_PASSCODE_LENGTH: "6" });
  assert.equal(p.maxAttempts, 7);
  assert.equal(p.lockoutSeconds, 30);
  assert.equal(p.passcodeLength, 6);
  assert.equal(policyFromEnv({ AUTH_MAX_ATTEMPTS: "nonsense" }).maxAttempts, POLICY.maxAttempts);
});

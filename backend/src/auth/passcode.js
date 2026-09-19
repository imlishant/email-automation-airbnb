// ---------------------------------------------------------------------------
// Passcode hashing. node:crypto only — no new dependency.
//
// A HONEST NOTE ON WHAT THIS BUYS, because it is easy to over-trust:
//
// The admin passcode is 4 digits. That is 10,000 possibilities. No key
// derivation function makes that safe against an attacker who has the hash —
// at ~150ms per guess, the whole keyspace falls in under half an hour, and
// raising the cost tenfold only buys hours. So:
//
//   - What actually stops ONLINE guessing is the attempt lockout in admin.js.
//     That is the real control, and it is mandatory before deployment.
//   - What this KDF buys is that a leaked database is not INSTANTLY a leaked
//     passcode, and that the passcode is not readable by anyone who glances at
//     the table. Worth having; not a substitute for the lockout.
//   - The only thing that would make the hash genuinely strong is a longer
//     passcode, which is a product decision (docs/DECISIONS.md, access model)
//     and deliberately not taken: a 4-digit shared code is what makes the tool
//     usable for the host.
//
// scrypt is chosen over bcrypt/argon2 because it is built into Node. OWASP
// suggests N=2^17 as a floor; we use 2^16 (64MB, ~150ms locally) because the
// target is a 512MB Render instance and, per the above, the extra factor of two
// protects nothing that matters here.
// ---------------------------------------------------------------------------
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const DEFAULT_PARAMS = Object.freeze({ N: 65536, r: 8, p: 1, keylen: 32, saltBytes: 16 });

/** scrypt needs to be told it may use this much memory; the default is 32MB. */
const maxmemFor = ({ N, r, p }) => 256 * N * r * p;

const b64 = (buf) => buf.toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

/**
 * "scrypt$N$r$p$salt$hash" — self-describing, so the cost can be raised later
 * without invalidating hashes made under the old parameters.
 */
export async function hashPasscode(passcode, params = DEFAULT_PARAMS) {
  const { N, r, p, keylen, saltBytes } = { ...DEFAULT_PARAMS, ...params };
  const salt = randomBytes(saltBytes);
  const derived = await scrypt(String(passcode), salt, keylen, { N, r, p, maxmem: maxmemFor({ N, r, p }) });
  return `scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(derived)}`;
}

/** Parse a stored hash. Returns null for anything we did not write. */
export function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, N, r, p, salt, hash] = parts;
  if (![N, r, p].every((n) => /^\d+$/.test(n))) return null;
  try {
    const saltBuf = unb64(salt), hashBuf = unb64(hash);
    if (!saltBuf.length || !hashBuf.length) return null;
    return { N: Number(N), r: Number(r), p: Number(p), salt: saltBuf, hash: hashBuf, keylen: hashBuf.length };
  } catch { return null; }
}

/**
 * Is this a hash at all? The migrator writes a placeholder on a fresh install,
 * and the server must refuse to run on it rather than silently accept nothing.
 */
export const isUsableHash = (stored) => parseHash(stored) !== null;

/**
 * Constant-time verification.
 *
 * @returns {{ok: boolean, needsRehash: boolean}} `needsRehash` when the stored
 *   hash used weaker parameters than we now use, so a successful unlock can
 *   quietly upgrade it.
 */
export async function verifyPasscode(passcode, stored) {
  const parsed = parseHash(stored);
  if (!parsed) {
    // Spend comparable time so an unusable hash is not distinguishable from a
    // wrong passcode by how fast the answer comes back.
    await dummyWork();
    return { ok: false, needsRehash: false };
  }
  const { N, r, p, salt, keylen, hash } = parsed;
  let derived;
  try {
    derived = await scrypt(String(passcode), salt, keylen, { N, r, p, maxmem: maxmemFor({ N, r, p }) });
  } catch {
    return { ok: false, needsRehash: false };
  }
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal, so the lengths are checked first and the compare is still
  // performed against a same-length buffer.
  const ok = derived.length === hash.length && timingSafeEqual(derived, hash);
  const needsRehash = ok && (N < DEFAULT_PARAMS.N || r < DEFAULT_PARAMS.r || keylen < DEFAULT_PARAMS.keylen);
  return { ok, needsRehash };
}

/** Burn roughly one verification's worth of time. */
export async function dummyWork() {
  const { N, r, p, keylen } = DEFAULT_PARAMS;
  await scrypt("", randomBytes(16), keylen, { N, r, p, maxmem: maxmemFor(DEFAULT_PARAMS) });
}

/** A passcode is exactly `length` digits. Nothing else is accepted. */
export function validatePasscode(passcode, length) {
  const value = String(passcode ?? "");
  if (value.length !== length) return { ok: false, reason: `must be exactly ${length} digits` };
  if (!/^\d+$/.test(value)) return { ok: false, reason: "digits only" };
  return { ok: true, value };
}

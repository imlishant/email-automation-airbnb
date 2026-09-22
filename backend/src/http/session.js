// ---------------------------------------------------------------------------
// Admin sessions. A signed cookie, not a bearer token in localStorage: an
// HTTP-only cookie cannot be read by script, which is the point
// (docs/SECURITY.md).
//
// Stateless and signed rather than a sessions table, because there is one
// admin passcode and no per-user state to keep. Rotating SESSION_SECRET
// invalidates every session, which is the emergency control.
// ---------------------------------------------------------------------------
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "gp_admin";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload, secret) => b64u(createHmac("sha256", secret).update(payload).digest());

/** "<issuedAt>.<expiresAt>.<signature>" */
/**
 * "<issuedAt>.<expiresAt>.<role>.<signature>". The role is inside the signed
 * payload, so it cannot be edited from "admin" to "owner" by the client.
 */
export function issueSession(secret, { ttlHours, role = "admin", now = Date.now() } = {}) {
  const expires = now + ttlHours * 3600_000;
  const payload = `${now}.${expires}.${role}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string") return { ok: false };
  const parts = token.split(".");
  // Three parts is the pre-owner format; it can only ever mean "admin".
  if (parts.length !== 3 && parts.length !== 4) return { ok: false };
  const [issued, expires] = parts;
  const role = parts.length === 4 ? parts[2] : "admin";
  const sig = parts[parts.length - 1];
  if (!/^\d+$/.test(issued) || !/^\d+$/.test(expires)) return { ok: false };
  if (role !== "admin" && role !== "owner") return { ok: false };

  const payload = parts.length === 4 ? `${issued}.${expires}.${role}` : `${issued}.${expires}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  if (now > Number(expires)) return { ok: false, expired: true };
  return { ok: true, role, issuedAt: Number(issued), expiresAt: Number(expires) };
}

export function cookieOptions({ production, ttlHours }) {
  return {
    httpOnly: true,            // unreadable by script
    secure: production,        // https only, once there is https
    sameSite: "lax",           // survives a normal link click, blocks cross-site POSTs
    path: "/",
    maxAge: ttlHours * 3600,
  };
}

/** Development-only fallback so the server runs without a configured secret. */
export const ephemeralSecret = () => randomBytes(32).toString("base64url");

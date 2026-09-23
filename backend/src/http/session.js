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

/**
 * "v2.<payload>.<signature>", where payload is base64url JSON carrying who is
 * signed in (`u`, a user id), which account they are working in (`a`) and
 * their role there (`r`). It is inside the signed payload, so none of it can
 * be edited in the browser. Stateless still: no sessions table, and rotating
 * SESSION_SECRET signs everyone out.
 */
export function issueSession(secret, { ttlHours, role = "admin", userId, accountId, email = null, now = Date.now() } = {}) {
  // The email rides along only so the audit log can say who acted without a
  // lookup on every request. Authority still comes from the memberships table.
  const claims = { i: now, e: now + ttlHours * 3600_000, r: role, u: userId || null, a: accountId || null, m: email };
  const payload = b64u(JSON.stringify(claims));
  return `v2.${payload}.${sign(payload, secret)}`;
}

export function verifySession(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string") return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return { ok: false };
  const [, payload, sig] = parts;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { ok: false }; }
  if (claims?.r !== "admin" && claims?.r !== "owner") return { ok: false };
  if (!Number.isFinite(claims.i) || !Number.isFinite(claims.e)) return { ok: false };
  if (now > claims.e) return { ok: false, expired: true };
  return { ok: true, role: claims.r, userId: claims.u || null, accountId: claims.a || null,
    email: claims.m || null, issuedAt: claims.i, expiresAt: claims.e };
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

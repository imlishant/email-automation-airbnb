// ---------------------------------------------------------------------------
// Guest links.
//
// The token IS the access control (docs/DECISIONS.md): no account, no passcode,
// nothing else asked. So it has to be genuinely unguessable, and every guest
// request must resolve its booking FROM the token — never from an id in the
// request. Getting that wrong shows one guest another guest's passport.
// ---------------------------------------------------------------------------
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { one, run, newId, nowIso } from "../db/client.js";
import { Derive } from "../../../shared/rules.js";
import { appSettings } from "./bookings.js";

// 16 bytes = 128 bits from a CSPRNG. Brute forcing that is not a thing.
const TOKEN_BYTES = 16;

/**
 * "<random>.<signature>" — the signature lets an invalid token be rejected
 * without touching the database, so a flood of guesses costs nothing.
 */
function signToken(raw, secret) {
  return createHmac("sha256", secret).update(raw).digest("base64url").slice(0, 27);
}
export function mintToken(secret) {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return `${raw}.${signToken(raw, secret)}`;
}
export function tokenLooksValid(token, secret) {
  if (typeof token !== "string" || token.length > 128) return false;
  const [raw, sig] = token.split(".");
  if (!raw || !sig) return false;
  const expected = signToken(raw, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The booking's live link, minted on first use. One live link per booking. */
export async function ensureGuestLink(client, bookingId, secret) {
  const existing = await one(client,
    "SELECT token, expires_at FROM guest_links WHERE booking_id = ? AND revoked_at IS NULL", [bookingId]);
  const booking = await one(client, "SELECT check_out FROM bookings WHERE id = ?", [bookingId]);
  if (!booking) return null;

  const settings = await appSettings(client);
  const expiresAt = new Date(Derive.guestLinkExpiresAt({ checkOut: booking.check_out }, settings)).toISOString();

  if (existing && !tokenLooksValid(existing.token, secret)) {
    // Signed under a secret that has since changed. Copying it would send the
    // guest a dead link, so retire it and mint a fresh one.
    await run(client, "UPDATE guest_links SET revoked_at = ? WHERE token = ?", [nowIso(), existing.token]);
  } else if (existing) {
    // The window moves if the host changes the check-out time, so keep it current.
    if (existing.expires_at !== expiresAt) {
      await run(client, "UPDATE guest_links SET expires_at = ? WHERE token = ?", [expiresAt, existing.token]);
    }
    return { token: existing.token, expiresAt };
  }
  const token = mintToken(secret);
  await run(client, "INSERT INTO guest_links (token, booking_id, expires_at, created_at) VALUES (?,?,?,?)",
    [token, bookingId, expiresAt, nowIso()]);
  return { token, expiresAt };
}

/** Invalidate the current link and mint a new one. */
export async function regenerateGuestLink(client, bookingId, secret) {
  await run(client, "UPDATE guest_links SET revoked_at = ? WHERE booking_id = ? AND revoked_at IS NULL",
    [nowIso(), bookingId]);
  return ensureGuestLink(client, bookingId, secret);
}

/**
 * Resolve a token to its booking id, or null.
 *
 * Expiry is checked HERE, server-side, from the booking's own check-out and the
 * host's times. The client's opinion about whether a link is still live is
 * irrelevant.
 */
export async function bookingIdForToken(client, token, secret, { now = Date.now() } = {}) {
  if (!tokenLooksValid(token, secret)) return null;
  const row = await one(client,
    "SELECT booking_id, expires_at, revoked_at FROM guest_links WHERE token = ?", [token]);
  if (!row || row.revoked_at) return null;
  if (now > Date.parse(row.expires_at)) return null;
  return row.booking_id;
}

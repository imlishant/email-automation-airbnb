// ---------------------------------------------------------------------------
// The owner: one person, identified by the email address the tool sends from,
// signing in with a single-use link to that inbox. No password, no OAuth app,
// and nothing another admin can change to lock them out.
// ---------------------------------------------------------------------------
import { randomBytes, createHash } from "node:crypto";
import { one, run, nowIso } from "../db/client.js";

export const LINK_TTL_MINUTES = 15;
const hash = (token) => createHash("sha256").update(token).digest("hex");

export async function createOwnerLink(client, { baseUrl, now = Date.now() } = {}) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now + LINK_TTL_MINUTES * 60_000).toISOString();
  await run(client, "INSERT INTO owner_links (token_hash, expires_at, created_at) VALUES (?,?,?)",
    [hash(token), expires, nowIso()]);
  return { url: `${baseUrl}/api/auth/owner/verify?token=${encodeURIComponent(token)}`, expiresAt: expires };
}

/**
 * Consume a link. Single use: marked used in the same statement that checks
 * it, so a link forwarded or replayed after the first click signs no one in.
 */
export async function consumeOwnerLink(client, token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false };
  const res = await run(client,
    "UPDATE owner_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    [nowIso(), hash(token), new Date(now).toISOString()]);
  return { ok: res.rowsAffected === 1 };
}

export function ownerLinkMessage({ to, from, url }) {
  return {
    from, to,
    subject: "GatePass sign-in link",
    body:
      `Here is your owner sign-in link for GatePass:\n\n${url}\n\n` +
      `It works once and expires in ${LINK_TTL_MINUTES} minutes.\n\n` +
      `If you did not ask for this, ignore it — nothing happens unless the link is opened.`,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Sending through the Gmail API.
//
// Why not SMTP: Render blocks outbound SMTP, so smtp.gmail.com:587 simply
// times out from there. The Gmail API is HTTPS on 443, which nothing blocks.
//
// The permission asked for is `gmail.send` and nothing else. It cannot list,
// read or delete a message — the host's mailbox stays private to them, which
// is the promise in docs/SECURITY.md. The refresh token is encrypted at rest;
// the short-lived access token is kept in memory only.
//
// MIME is built by nodemailer's own composer rather than by hand: getting
// multipart boundaries, base64 and header encoding right matters when the
// attachment is somebody's passport.
// ---------------------------------------------------------------------------
import { MailNotConfigured } from "./errors.js";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Refreshed a minute early, so a send never races the expiry. */
const EARLY_MS = 60_000;

/** Swap the long-lived refresh token for a short-lived access token. */
export async function accessTokenFrom({ refreshToken, clientId, clientSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // invalid_grant means the host revoked access in their Google account, or
    // the token was unused for months. Either way it must be reconnected, and
    // saying so beats a generic failure.
    const why = body.error === "invalid_grant"
      ? "Google access was revoked or expired — reconnect the Gmail in Settings"
      : body.error_description || body.error || `Google refused the token (${res.status})`;
    const err = new Error(why);
    err.code = body.error === "invalid_grant" ? "mail_reconnect" : "mail_token_failed";
    throw err;
  }
  return { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
}

async function toRawMessage(message, from) {
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
  const built = await new MailComposer({
    from: message.from || from,
    to: message.to,
    cc: message.cc || undefined,
    replyTo: message.replyTo || undefined,
    subject: message.subject,
    text: message.body,
    attachments: (message.attachments || []).map((a) => ({
      filename: a.filename, content: a.content, contentType: a.contentType,
    })),
  }).compile().build();
  // Gmail wants the whole RFC 822 message, base64url, in one JSON field.
  return built.toString("base64url");
}

/**
 * A transport for one account. `refreshToken` is already decrypted by the
 * caller; nothing here touches the database.
 */
export function gmailApiTransport({ refreshToken, from, clientId, clientSecret, maxAttachmentBytes, fetchImpl = fetch }) {
  if (!refreshToken || !clientId || !clientSecret) {
    return {
      name: "gmail_api", configured: false,
      async send() { throw new MailNotConfigured("a connected Gmail"); },
    };
  }
  let cached = null;

  async function token() {
    if (cached && cached.expiresAt - EARLY_MS > Date.now()) return cached.token;
    cached = await accessTokenFrom({ refreshToken, clientId, clientSecret, fetchImpl });
    return cached.token;
  }

  return {
    name: "gmail_api",
    configured: true,
    maxAttachmentBytes,
    async send(message) {
      const raw = await toRawMessage(message, from);
      const res = await fetchImpl(SEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body?.error?.message || `Gmail refused the send (${res.status})`;
        const err = new Error(res.status === 403 && /insufficient/i.test(detail)
          ? "Gmail did not allow sending — reconnect the Gmail in Settings"
          : detail);
        err.code = res.status === 401 || res.status === 403 ? "mail_reconnect" : "send_failed";
        // A refused send must never leave a stale token behind.
        cached = null;
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      return { id: body.id || "gmail", accepted: true, transport: "gmail_api" };
    },
    /** Proves the token still works without sending anything. */
    async verify() {
      await token();
      return true;
    },
  };
}

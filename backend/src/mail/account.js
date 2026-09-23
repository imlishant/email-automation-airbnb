// ---------------------------------------------------------------------------
// Each account's own sending Gmail.
//
// The host pastes their address and a Gmail App Password; the password is
// encrypted with FILE_ENCRYPTION_KEY — the same key and the same AES-256-GCM
// as an ID photo — so the database alone does not let anyone send mail as
// them. It is decrypted only to build a transport for one send.
//
// An App Password rather than OAuth on purpose (docs/DECISIONS.md): it works
// today without Google's review of a send scope, and it can only send. The
// tool never reads the mailbox.
//
// A transport is cached per account, keyed on the password that built it, so a
// tick sending five bookings for one host opens one SMTP connection, and a
// changed password is picked up at once.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { one, run, nowIso } from "../db/client.js";
import { encrypt, decrypt } from "../files/crypto.js";
import { smtpTransport } from "./smtp.js";
import { MailNotConfigured } from "./errors.js";

export const GMAIL = Object.freeze({ host: "smtp.gmail.com", port: 587, secure: false });

export async function setAccountMail(client, accountId, { fromEmail, smtpUser, smtpPass }, key) {
  if (!key) throw new MailNotConfigured("FILE_ENCRYPTION_KEY");
  const at = nowIso();
  await run(client,
    `INSERT INTO account_mail (account_id, from_email, smtp_user, smtp_pass_enc, verified_at, last_error, updated_at)
     VALUES (?,?,?,?,NULL,NULL,?)
     ON CONFLICT(account_id) DO UPDATE SET from_email = excluded.from_email, smtp_user = excluded.smtp_user,
       smtp_pass_enc = excluded.smtp_pass_enc, verified_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
    // App passwords are shown with spaces; Gmail wants them without.
    [accountId, fromEmail.trim(), smtpUser.trim(), encrypt(Buffer.from(String(smtpPass).replace(/\s+/g, ""), "utf8"), key), at]);
  return readAccountMail(client, accountId);
}

/** What the UI may see: never the password, not even its length. */
export async function readAccountMail(client, accountId) {
  const row = await one(client,
    `SELECT from_email, smtp_user, verified_at, last_error, updated_at FROM account_mail WHERE account_id = ?`,
    [accountId]);
  if (!row) return null;
  return {
    fromEmail: row.from_email, smtpUser: row.smtp_user,
    verifiedAt: row.verified_at || null, lastError: row.last_error || null, updatedAt: row.updated_at,
  };
}

export async function clearAccountMail(client, accountId) {
  const res = await run(client, "DELETE FROM account_mail WHERE account_id = ?", [accountId]);
  cache.delete(accountId);
  return res.rowsAffected > 0;
}

export async function recordMailCheck(client, accountId, { ok, error = null }) {
  await run(client, "UPDATE account_mail SET verified_at = ?, last_error = ? WHERE account_id = ?",
    [ok ? nowIso() : null, ok ? null : String(error || "").slice(0, 300), accountId]);
}

const cache = new Map();   // accountId -> { fingerprint, transport }

/**
 * The transport for one account, or null when that host has not connected a
 * Gmail yet. Null means the send is refused and stays visibly unsent — it is
 * never faked (src/mail/transport.js).
 */
export async function transportForAccount(client, accountId, key, { maxAttachmentBytes } = {}) {
  const row = await one(client,
    "SELECT from_email, smtp_user, smtp_pass_enc FROM account_mail WHERE account_id = ?", [accountId]);
  if (!row || !key) return null;

  const pass = decrypt(Buffer.from(row.smtp_pass_enc), key).toString("utf8");
  const fingerprint = createHash("sha256").update(`${row.smtp_user}|${pass}|${row.from_email}`).digest("base64url");
  const hit = cache.get(accountId);
  if (hit && hit.fingerprint === fingerprint) return hit.transport;

  const transport = smtpTransport({
    ...GMAIL, user: row.smtp_user, pass, from: row.from_email, maxAttachmentBytes,
  });
  cache.set(accountId, { fingerprint, transport });
  return transport;
}

/** Forget a cached connection, e.g. after the credentials change. */
export const forgetAccountTransport = (accountId) => cache.delete(accountId);

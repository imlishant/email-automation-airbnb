// ---------------------------------------------------------------------------
// The SMTP transport: the host's own Gmail (docs/DECISIONS.md).
//
// nodemailer rather than hand-rolled SMTP, because MIME encoding, STARTTLS and
// AUTH are three things you do not want to get subtly wrong when the payload is
// someone's passport. It has no dependencies of its own.
// ---------------------------------------------------------------------------
import { MailNotConfigured } from "./errors.js";

export function smtpTransport(config) {
  const { host, port, user, pass, from, replyTo, secure, ignoreTLS, maxAttachmentBytes } = config;
  if (!host || !user || !pass) {
    return { name: "smtp", configured: false, async send() { throw new MailNotConfigured("SMTP_HOST, SMTP_USER and SMTP_PASS"); } };
  }

  let transporter;
  async function get() {
    if (!transporter) {
      const nodemailer = await import("nodemailer");
      transporter = nodemailer.createTransport({
        host, port,
        secure: Boolean(secure),          // 465 implicit TLS; 587 upgrades via STARTTLS
        requireTLS: !ignoreTLS,           // never fall back to plaintext on a real server
        ignoreTLS: Boolean(ignoreTLS),    // tests only, against a local sink
        auth: { user, pass },
      });
    }
    return transporter;
  }

  return {
    name: "smtp",
    configured: true,
    maxAttachmentBytes,
    async send(message) {
      const mailer = await get();
      const info = await mailer.sendMail({
        from: message.from || from,
        to: message.to,
        cc: message.cc || undefined,
        replyTo: message.replyTo || replyTo || undefined,
        subject: message.subject,
        text: message.body,
        attachments: (message.attachments || []).map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      return { id: info.messageId, accepted: (info.accepted || []).length > 0, transport: "smtp" };
    },
    async verify() {
      const mailer = await get();
      await mailer.verify();
      return true;
    },
  };
}

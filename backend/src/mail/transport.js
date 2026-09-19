// ---------------------------------------------------------------------------
// The mail transport boundary.
//
// This exists now, before Phase 4 builds the SMTP transport, for one reason:
// `sent_at` must never be set unless mail actually left. A booking that reads
// "Sent" while nothing reached the security desk is precisely the failure this
// product exists to prevent — the host stops worrying, and the guest is held at
// the gate.
//
// So the send path is complete and tested end to end, and the transport is the
// only missing piece. In production, no configured transport means the send is
// REFUSED, not faked.
// ---------------------------------------------------------------------------
import { MailNotConfigured } from "./errors.js";
import { smtpTransport } from "./smtp.js";

export { MailNotConfigured };

/** Refuses every send, loudly. The default until SMTP is configured. */
export function unconfiguredTransport() {
  return {
    name: "unconfigured",
    configured: false,
    async send() { throw new MailNotConfigured("set SMTP_HOST, SMTP_USER and SMTP_PASS"); },
  };
}

/**
 * Records messages instead of sending them. For tests and local development
 * only — `configured` stays false so nothing mistakes it for delivery, and the
 * server refuses to use it in production.
 */
export function recordingTransport() {
  const sent = [];
  return {
    name: "recording",
    configured: false,
    sent,
    async send(message) {
      sent.push(message);
      return { id: `rec_${sent.length}`, accepted: true, transport: "recording" };
    },
  };
}

/**
 * Pick a transport from the environment. Phase 4 adds the SMTP one here; until
 * then production gets a transport that refuses.
 */
export function chooseTransport(config) {
  if (config.mail?.transport === "recording") return recordingTransport();
  if (config.mail?.transport === "smtp") return smtpTransport(config.mail);
  return unconfiguredTransport();
}

// ---------------------------------------------------------------------------
// Keeping a resend in the same email thread as the first send.
//
// Mail clients thread on headers, not on the subject: a reply carries
// `In-Reply-To` and `References` pointing at the Message-ID of the message it
// answers. So the only thing GatePass needs is to KNOW the Message-ID of what
// it sent — and the one way to be sure of that without reading the mailbox is
// to write it ourselves. Gmail accepts a Message-ID supplied on a raw send and
// keeps it; the id it returns in response is its own internal resource id,
// which no mail client has ever heard of.
//
// Not reading the mailbox is the point. `gmail.send` cannot list or read a
// message, and that limit is a promise to the host (docs/SECURITY.md), not an
// inconvenience to work around.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";

/**
 * A Message-ID in the sender's own domain, as RFC 5322 wants.
 *
 * The domain half must be something we plausibly own, or spam filters take
 * note; the local half is random, because two sends must never collide.
 */
export function newMessageId(from, rand = () => randomBytes(12).toString("hex")) {
  const domain = String(from || "").match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase() || "gatepass.local";
  return `<gatepass.${Date.now().toString(36)}.${rand()}@${domain}>`;
}

/** Reply subjects get one "Re:", however many times they are resent. */
export function replySubject(subject) {
  const clean = String(subject || "").trim();
  if (!clean) return "Re:";
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`;
}

/**
 * The headers for this send: a fresh id always, plus the reply headers when
 * there is a thread to join.
 *
 * `root` is the Message-ID of the FIRST email about this booking, and stays
 * the anchor for every later resend — so a third email threads under the
 * original rather than dangling off the second.
 */
export function threadHeaders({ from, root = null, subject, rand }) {
  const messageId = newMessageId(from, rand);
  if (!root) return { messageId, subject };
  return { messageId, inReplyTo: root, references: root, subject: replySubject(subject) };
}

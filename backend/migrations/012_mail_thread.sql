-- A resend should land in the gate desk's existing thread, not as a second
-- unrelated email about the same guests. That needs three things remembered
-- from the first send: the Message-ID we put on it, the subject as it actually
-- went out (the society's template may be edited in between), and Gmail's own
-- thread id so the host's Sent folder threads too.
--
-- We generate the Message-ID ourselves rather than reading it back, because
-- reading the mailbox is a permission this tool must never hold
-- (docs/SECURITY.md). The Gmail API returns its internal resource id, not the
-- RFC header, so there is nothing to read back anyway.
ALTER TABLE bookings ADD COLUMN sent_message_id TEXT;
ALTER TABLE bookings ADD COLUMN sent_subject    TEXT;
ALTER TABLE bookings ADD COLUMN sent_thread_id  TEXT;

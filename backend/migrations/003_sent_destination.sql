-- 003 — remember where an email actually went.
--
-- Before this, a booking's destination was resolved live through its listing's
-- society. That meant changing a listing's society silently changed where a
-- RESEND of an already-sent booking would go. Wrong: a resend is the same mail
-- to the same desk, and must not follow a later edit.
--
-- The address is therefore pinned at send time. The live resolution still
-- applies to bookings that have not been sent yet.
ALTER TABLE bookings ADD COLUMN sent_to TEXT;
ALTER TABLE bookings ADD COLUMN sent_cc TEXT;
ALTER TABLE bookings ADD COLUMN sent_society_id TEXT;

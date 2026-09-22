-- 004 — an audit trail for admin actions that are not about one booking.
--
-- Booking events already live in `activity` with a booking_id. Admin actions —
-- a passcode change, a society's desk address edited, a listing deleted — have
-- no booking, so they are stored with booking_id NULL. The passcode is shared,
-- so "who" can only ever be "an admin, from this address".
ALTER TABLE activity ADD COLUMN ip TEXT;
CREATE INDEX activity_admin ON activity(at DESC) WHERE booking_id IS NULL;

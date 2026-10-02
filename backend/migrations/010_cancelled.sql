-- 010 — a cancelled booking is not a conflict.
--
-- When a booking vanished from the Airbnb feed, sync flagged it `conflict = 1`
-- with the reason "No longer in the Airbnb calendar". That put a routine
-- cancellation under the same red pill as the dangerous case — two
-- reservations overlapping the same nights — so the host read "Sync conflict",
-- went looking for a double booking that did not exist, and had no way to
-- clear it. It then sat at the top of the attention list until checkout.
--
-- The two are now separate states:
--   conflict      two reservations in the feed overlap. Needs a decision.
--   cancelled_at  it is gone from the feed. Routine, and quiet.

ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;

-- Repair the live data: anything flagged conflict for having vanished becomes
-- cancelled instead, keeping the moment it was noticed.
UPDATE bookings
   SET cancelled_at = updated_at,
       conflict = 0,
       conflict_reason = NULL
 WHERE conflict = 1
   AND conflict_reason LIKE 'No longer in the Airbnb calendar%';

-- Cancelled bookings are read on every list and every tick.
CREATE INDEX bookings_cancelled ON bookings(cancelled_at) WHERE cancelled_at IS NOT NULL;

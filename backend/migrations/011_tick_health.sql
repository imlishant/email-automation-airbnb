-- 011 — make silence visible.
--
-- Two failures reached the host only when they tried to send: the Gmail
-- connection had been revoked, and (earlier) the scheduler ping was returning
-- 415 so nothing automatic ran at all. Both were invisible until a guest was
-- nearly standing at a gate.
--
-- So the tick records when it last ran. Combined with account_mail.last_error
-- and listings.last_sync_error, that is enough for the Bookings page to say
-- "this has not run since Tuesday" instead of looking perfectly healthy.

ALTER TABLE app_settings ADD COLUMN jobs_last_tick_at TEXT;

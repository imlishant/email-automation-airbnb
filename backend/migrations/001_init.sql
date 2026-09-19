-- 001_init — the whole schema.
--
-- Conventions, applied everywhere:
--   ids          TEXT, prefixed (bkg_, lst_, soc_, per_, doc_) — readable in logs
--   calendar days TEXT 'YYYY-MM-DD'. A booking's dates are DAYS, not instants:
--                the Airbnb feed has no clock time, and shared/rules.js parses
--                these as local days. Never store a booking date as a timestamp.
--   timestamps   TEXT ISO 8601 in UTC ('2026-09-19T08:30:00.000Z')
--   booleans     INTEGER 0/1
--
-- What is deliberately NOT a column, because it is derived in
-- shared/rules.js and a stored copy could disagree with reality:
--   bookings.status, bookings.adults, bookings.nights,
--   bookings.society_id  (resolved through the listing)

CREATE TABLE societies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  desk_email_to   TEXT NOT NULL,
  desk_email_cc   TEXT,
  template        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE listings (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  ical_url         TEXT NOT NULL,
  -- RESTRICT, not CASCADE: deleting a society must never silently orphan a
  -- listing and misroute its guests' IDs.
  society_id       TEXT NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  last_synced_at   TEXT,
  last_sync_error  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX listings_society ON listings(society_id);

CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,
  -- The Airbnb reservation code. Unique so the sync worker can upsert on it.
  -- Nullable: some feed entries carry no code, and the booking still syncs.
  airbnb_code    TEXT UNIQUE,
  -- Fallback identity when there is no code: the feed's own event UID.
  ical_uid       TEXT,
  listing_id     TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  check_in       TEXT NOT NULL,
  check_out      TEXT NOT NULL,
  children       INTEGER NOT NULL DEFAULT 0,
  -- Never invented from the feed. Populated only when genuinely known.
  lead_guest     TEXT,
  phone_last4    TEXT,
  automation     TEXT NOT NULL DEFAULT 'allids' CHECK (automation IN ('before','allids')),
  sent_at        TEXT,
  conflict       INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0,1)),
  conflict_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (check_out >= check_in)
);
-- The retention filter plus the chronological order, in one index.
CREATE INDEX bookings_list    ON bookings(check_out, check_in, id);
CREATE INDEX bookings_listing ON bookings(listing_id, check_in, id);
CREATE INDEX bookings_uid     ON bookings(ical_uid);

CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- "Lead guest" until an ID or the host tells us otherwise.
  name        TEXT NOT NULL,
  is_lead     INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX people_booking ON people(booking_id);
-- At most one lead guest per booking.
CREATE UNIQUE INDEX people_one_lead ON people(booking_id) WHERE is_lead = 1;

CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL,
  -- Opaque key in object storage. NULLED when the file is deleted on schedule;
  -- the row itself survives, so "3 IDs were sent" stays provable after the
  -- bytes are gone, and the booking does not fall back to "awaiting".
  file_ref     TEXT,
  byte_size    INTEGER,
  content_type TEXT,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL CHECK (uploaded_by IN ('admin','guest')),
  deleted_at   TEXT,
  created_at   TEXT NOT NULL
);
-- One ID per adult.
CREATE UNIQUE INDEX documents_person ON documents(person_id);

CREATE TABLE guest_links (
  token       TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);
-- One live link per booking; regenerating revokes the old one.
CREATE UNIQUE INDEX guest_links_live ON guest_links(booking_id) WHERE revoked_at IS NULL;

-- Append-only. Doubles as the booking timeline in the UI and the audit log.
CREATE TABLE activity (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('system','admin','guest')),
  text        TEXT NOT NULL
);
CREATE INDEX activity_booking ON activity(booking_id, at DESC);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('sync_listing','send_booking','delete_id_files','purge_records')),
  subject_id   TEXT,
  run_after    TEXT NOT NULL,
  claimed_at   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL
);
-- The tick's query: what is due and unclaimed.
CREATE INDEX jobs_due ON jobs(run_after, claimed_at, completed_at);
-- One pending job per subject per kind, so repeated ticks cannot pile work up.
CREATE UNIQUE INDEX jobs_one_pending ON jobs(kind, subject_id) WHERE completed_at IS NULL;
-- At-most-once automated send, enforced by the database rather than by care.
-- A double-send means a security desk receives someone's passport twice.
CREATE UNIQUE INDEX jobs_one_send_ever ON jobs(subject_id) WHERE kind = 'send_booking';

-- Singleton tables. The CHECK is what makes them singletons.
CREATE TABLE admin_auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  passcode_hash  TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE app_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  -- The feed gives dates with no clock time; the automation needs a moment.
  -- One pair, global to every listing (docs/DECISIONS.md).
  check_in_time  TEXT NOT NULL,
  check_out_time TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

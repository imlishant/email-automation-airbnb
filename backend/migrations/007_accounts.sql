-- 007 — many hosts on one deployment.
--
-- Until now a deployment served one host: one shared passcode, one owner
-- email, one Gmail sender. Now each host has an ACCOUNT holding their own
-- listings, societies, times and sending Gmail, and people sign in as
-- themselves with Google (docs/DECISIONS.md, "Multi-host accounts").
--
--   users        a person, identified by the email Google vouches for
--   accounts     one host's workspace: their listings, societies, settings
--   memberships  which people may open which account, and as what
--   invites      a co-host asked for by email, before they first sign in
--   approvals    the emails the platform owner allows to start an account
--
-- Existing data belongs to one host, so it is moved into a single account
-- here. The platform owner is attached to it at boot, from PLATFORM_OWNER_EMAIL.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  -- Lowercased. Unique: one person, one row, whichever account they open.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 'owner' is the host: they alone can change the sending Gmail, a society's
-- desk address, or who else has access. 'admin' is a co-host or helper.
CREATE TABLE memberships (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin')),
  created_at  TEXT NOT NULL,
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);
-- Exactly one owner per account: nobody can be locked out of their own data.
CREATE UNIQUE INDEX memberships_one_owner ON memberships(account_id) WHERE role = 'owner';

-- A co-host invited before they have ever signed in. Matched on email at
-- sign-in and then turned into a membership, so no invitation link is emailed
-- (the tool's Gmail sends security emails only — docs/SECURITY.md).
CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin')),
  created_at  TEXT NOT NULL,
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT
);
CREATE UNIQUE INDEX invites_pending ON invites(account_id, email) WHERE accepted_at IS NULL;
CREATE INDEX invites_email ON invites(email) WHERE accepted_at IS NULL;

-- Who may start a NEW account. Signing in with Google proves who someone is,
-- not that they were invited to use this deployment.
CREATE TABLE approvals (
  email      TEXT PRIMARY KEY,
  note       TEXT,
  added_at   TEXT NOT NULL,
  added_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Each account sends from its own Gmail. The app password is encrypted with
-- FILE_ENCRYPTION_KEY, exactly like an ID photo: the database alone must not
-- let anyone send mail as the host.
CREATE TABLE account_mail (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  from_email     TEXT NOT NULL,
  smtp_user      TEXT NOT NULL,
  smtp_pass_enc  BLOB NOT NULL,
  verified_at    TEXT,
  last_error     TEXT,
  updated_at     TEXT NOT NULL
);

-- Check-in/check-out times were global; they are now per account.
CREATE TABLE account_settings (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  check_in_time  TEXT NOT NULL,
  check_out_time TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Whose data each row is. Nullable only so this migration can add the column;
-- every write sets it, and reads always filter on it.
ALTER TABLE societies ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE listings  ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE activity  ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX societies_account ON societies(account_id);
CREATE INDEX listings_account  ON listings(account_id);
-- The admin log, per account: the rows with no booking, newest first.
CREATE INDEX activity_account  ON activity(account_id, at DESC) WHERE booking_id IS NULL;

-- Who did it, now that logins are people rather than a shared passcode.
ALTER TABLE activity ADD COLUMN actor_email TEXT;

-- Everything already here belongs to the one host this deployment was for.
INSERT INTO accounts (id, name, created_at, updated_at)
SELECT 'acc_first', 'My listings', datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM listings) OR EXISTS (SELECT 1 FROM societies);

UPDATE societies SET account_id = 'acc_first' WHERE account_id IS NULL;
UPDATE listings  SET account_id = 'acc_first' WHERE account_id IS NULL;
UPDATE activity  SET account_id = 'acc_first' WHERE account_id IS NULL;

INSERT INTO account_settings (account_id, check_in_time, check_out_time, updated_at)
SELECT 'acc_first', check_in_time, check_out_time, updated_at FROM app_settings
WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'acc_first');

-- admin_auth and owner_links stay for now, unused: the shared passcode and the
-- owner magic link are replaced by Google sign-in. They are dropped in a later
-- migration, once no deployment needs to roll back to them.

-- 008 — sending through the Gmail API instead of SMTP.
--
-- Render blocks outbound SMTP, so a host's own Gmail is unreachable on port
-- 587 from there. The Gmail API is ordinary HTTPS, which nothing blocks, and
-- the permission asked for is send-only: the tool still cannot read a mailbox
-- (docs/DECISIONS.md, "Sending through the Gmail API").
--
-- So account_mail now holds either a refresh token (gmail_api) or an app
-- password (smtp). The table is rebuilt because smtp_pass_enc was NOT NULL,
-- and a Gmail-API account has no password at all.

CREATE TABLE account_mail_new (
  account_id         TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'gmail_api' is the way in; 'smtp' stays for a host running this somewhere
  -- that allows SMTP, and for local work.
  method             TEXT NOT NULL CHECK (method IN ('gmail_api','smtp')),
  from_email         TEXT NOT NULL,
  smtp_user          TEXT,
  -- Both secrets are AES-256-GCM encrypted with FILE_ENCRYPTION_KEY, exactly
  -- like an ID photo: the database alone must not let anyone send as the host.
  smtp_pass_enc      BLOB,
  oauth_refresh_enc  BLOB,
  verified_at        TEXT,
  last_error         TEXT,
  updated_at         TEXT NOT NULL,
  -- Whichever way it sends, it must actually have the credential for it.
  CHECK ((method = 'smtp'      AND smtp_pass_enc     IS NOT NULL)
      OR (method = 'gmail_api' AND oauth_refresh_enc IS NOT NULL))
);

INSERT INTO account_mail_new
  (account_id, method, from_email, smtp_user, smtp_pass_enc, oauth_refresh_enc, verified_at, last_error, updated_at)
SELECT account_id, 'smtp', from_email, smtp_user, smtp_pass_enc, NULL, verified_at, last_error, updated_at
FROM account_mail;

DROP TABLE account_mail;
ALTER TABLE account_mail_new RENAME TO account_mail;

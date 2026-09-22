-- 005 — single-use sign-in links for the owner (docs/DECISIONS.md, "Admin tiers").
-- Only a HASH of the token is stored: a leaked database must not yield a link
-- that signs someone in.
CREATE TABLE owner_links (
  token_hash  TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

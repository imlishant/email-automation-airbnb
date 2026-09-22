-- 006 — encrypted ID documents stored in the database itself.
--
-- R2 was dropped (docs/DECISIONS.md): photos are resized to a few hundred KB in
-- the browser and deleted the day after checkout, so only a few current
-- bookings' worth ever exist at once. That fits comfortably in the database and
-- saves an entire account to create and secure.
--
-- Bytes are AES-256-GCM ciphertext, exactly as they were on disk. The database
-- never holds a readable ID.
CREATE TABLE file_blobs (
  ref         TEXT PRIMARY KEY,
  bytes       BLOB NOT NULL,
  created_at  TEXT NOT NULL
);

// ---------------------------------------------------------------------------
// Encryption for stored ID documents.
//
// AES-256-GCM: authenticated, so a tampered file fails to decrypt rather than
// returning altered bytes. A fresh random IV per file — reusing one with GCM
// is catastrophic, not merely weak.
//
// Stored layout:  [12-byte IV][16-byte auth tag][ciphertext]
// The tag is up front so a reader knows everything before the stream starts.
// ---------------------------------------------------------------------------
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
export const HEADER_BYTES = IV_BYTES + TAG_BYTES;

/** The key comes from the environment and never from the repository. */
export function loadKey(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FILE_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  }
  return key;
}

export function encrypt(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Throws if the bytes were altered — which is the point of GCM. */
export function decrypt(stored, key) {
  if (!Buffer.isBuffer(stored) || stored.length < HEADER_BYTES) throw new Error("stored file is truncated");
  const iv = stored.subarray(0, IV_BYTES);
  const tag = stored.subarray(IV_BYTES, HEADER_BYTES);
  const body = stored.subarray(HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

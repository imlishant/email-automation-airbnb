// ---------------------------------------------------------------------------
// Receiving one ID document.
//
// The order matters and is deliberate:
//   1. cap the size while reading, so a hostile upload cannot exhaust memory
//   2. sniff the BYTES — never the filename or the client's content-type
//   3. strip metadata (a photo of a passport carries GPS)
//   4. encrypt
//   5. store under an opaque ref
//   6. only then record it in the database
//
// If anything fails, nothing is recorded: a `documents` row pointing at bytes
// that were never written would read as "ID collected" when none was.
// ---------------------------------------------------------------------------
import { sniff, stripJpegMetadata } from "./sniff.js";
import { encrypt } from "./crypto.js";
import { newFileRef } from "./store.js";

export class UploadRejected extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** One wording for "too big", wherever the limit is hit. A guest reading this
 *  on a phone at a gate needs to know what to do, not just that it failed. */
export const tooLargeMessage = (maxBytes) =>
  `That file is larger than ${Math.round(maxBytes / 1048576)}MB. A photo taken with your phone camera is fine — a full-resolution scan is usually too big.`;

/** Read a stream into memory, refusing anything over the cap. */
export async function readCapped(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new UploadRejected("too_large", tooLargeMessage(maxBytes));
    }
    chunks.push(chunk);
  }
  if (!total) throw new UploadRejected("empty", "That file was empty.");
  return Buffer.concat(chunks);
}

/**
 * Validate, clean, encrypt and store. Returns what the caller needs to record.
 * @param key null means encryption is not configured — which is fatal, not optional.
 */
export async function receiveDocument(raw, { store, key, allowedTypes, maxBytes }) {
  if (!key) throw new UploadRejected("not_configured", "File encryption is not configured, so IDs cannot be accepted.");
  if (raw.length > maxBytes) throw new UploadRejected("too_large", tooLargeMessage(maxBytes));

  const kind = sniff(raw);
  if (!kind) {
    throw new UploadRejected("unsupported_type",
      "That does not look like a photo or a PDF. A phone photo of the ID is fine.");
  }
  if (allowedTypes.length && !allowedTypes.includes(kind.type)) {
    throw new UploadRejected("unsupported_type", `${kind.type} is not accepted here.`);
  }

  // The browser re-encodes before upload, which removes this. A raw POST past
  // the browser does not, so it is stripped here too.
  const cleaned = kind.type === "image/jpeg" ? stripJpegMetadata(raw) : raw;

  const ref = newFileRef();
  await store.put(ref, encrypt(cleaned, key));
  return { ref, contentType: kind.type, byteSize: cleaned.length, strippedBytes: raw.length - cleaned.length };
}

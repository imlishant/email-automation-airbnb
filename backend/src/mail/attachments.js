// ---------------------------------------------------------------------------
// Turning stored documents into email attachments.
//
// The governing rule: an email with a MISSING ID is worse than no email. The
// desk would see an attachment count that looks right, clear the guests it has
// IDs for, and stop the one it does not — at the gate. So if any single file
// cannot be fetched or decrypted, the whole send is refused.
// ---------------------------------------------------------------------------
import { decrypt } from "../files/crypto.js";

/** A filename a security desk can match to a person standing in front of them. */
export function attachmentName(personName, docType, contentType) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[contentType] || "bin";
  const clean = (s) => String(s || "").trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").slice(0, 60) || "guest";
  return `${clean(personName)}_${clean(docType)}.${ext}`;
}

export class AttachmentsUnavailable extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param people rows carrying { name, documentType, fileRef, contentType }
 * @returns attachments with their decrypted bytes in memory. Never written to
 *   disk in the clear.
 */
export async function buildAttachments(people, { store, key, maxTotalBytes }) {
  const withDocuments = people.filter((p) => p.documentType);
  if (!withDocuments.length) throw new AttachmentsUnavailable("no_documents", "There are no IDs to attach.");

  const attachments = [];
  let total = 0;
  for (const person of withDocuments) {
    if (!person.fileRef) {
      throw new AttachmentsUnavailable("file_deleted",
        `${person.name}'s ID file has been deleted, so it cannot be attached.`);
    }
    const stored = await store.get(person.fileRef);
    if (!stored) {
      throw new AttachmentsUnavailable("file_missing",
        `${person.name}'s ID file could not be found in storage. Nothing was sent.`);
    }
    let content;
    try {
      content = decrypt(stored, key);
    } catch {
      // Altered bytes or a rotated key. Either way, do not send something we
      // cannot vouch for.
      throw new AttachmentsUnavailable("undecryptable",
        `${person.name}'s ID file could not be decrypted. Nothing was sent.`);
    }
    total += content.length;
    attachments.push({
      filename: attachmentName(person.name, person.documentType, person.contentType),
      content,
      contentType: person.contentType || "application/octet-stream",
      personId: person.id,
    });
  }

  if (maxTotalBytes && total > maxTotalBytes) {
    throw new AttachmentsUnavailable("too_large",
      `The ID files come to ${Math.round(total / 1048576)}MB, over the ${Math.round(maxTotalBytes / 1048576)}MB the mail provider allows. Ask the guests to send smaller photos.`);
  }
  return { attachments, totalBytes: total };
}

// ---------------------------------------------------------------------------
// Uploading and reading an ID document.
//
// Admin and guest share one pipeline: the same size cap, the same byte
// sniffing, the same metadata stripping, the same encryption. A guest is not
// trusted less here — they are trusted exactly the same, which is to say not at
// all (docs/SECURITY.md).
//
// Reading back is ADMIN ONLY. A guest can put an ID in and can replace it, but
// can never download one — not even their own. There is no reason for us to
// hand a document back to the person who already has it.
// ---------------------------------------------------------------------------
import { requireAdmin } from "./auth.js";
import { readCapped, receiveDocument, UploadRejected, tooLargeMessage } from "../../files/receive.js";
import { decrypt } from "../../files/crypto.js";
import { putDocument } from "../../repo/bookingWrites.js";
import { bookingIdForToken } from "../../repo/guestLinks.js";
import { one, run, nowIso } from "../../db/client.js";
import { getBooking, appSettings, bookingInAccount } from "../../repo/bookings.js";

const errOut = { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } };
const okOut = {
  type: "object",
  properties: {
    ok: { type: "boolean" }, replaced: { type: "boolean" },
    docType: { type: "string" }, byteSize: { type: "integer" },
  },
};

/** Pull one file part plus the docType field out of a multipart body. */
async function readUpload(req, maxBytes) {
  let file = null, docType = "";
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (file) throw new UploadRejected("too_many_files", "Send one file at a time.");
      file = { bytes: await readCapped(part.file, maxBytes), filename: part.filename };
      if (part.file.truncated) throw new UploadRejected("too_large", tooLargeMessage(maxBytes));
    } else if (part.fieldname === "docType") {
      docType = String(part.value || "").slice(0, 60);
    }
  }
  if (!file) throw new UploadRejected("no_file", "No file was sent.");
  if (!docType) throw new UploadRejected("no_doc_type", "Say which kind of ID this is.");
  return { file, docType };
}

export async function registerUploads(app) {
  const client = app.db.client;
  const admin = requireAdmin(app);
  const { maxBytes, allowedTypes } = app.config.storage;

  /**
   * Store the bytes, then record the row. Never the other way round: a row
   * pointing at bytes that were never written reads as "ID collected" when none
   * was, and the booking would send with a missing attachment.
   */
  async function accept(bookingId, personId, file, docType, actor) {
    const stored = await receiveDocument(file.bytes, {
      store: app.files, key: app.fileKey, allowedTypes, maxBytes,
    });
    const res = await putDocument(client, bookingId, personId, {
      docType, fileRef: stored.ref, byteSize: stored.byteSize, contentType: stored.contentType, actor,
    });
    if (!res.ok) {
      // The row was refused (window closed, wrong person). Do not leave an
      // orphan encrypted blob behind.
      await app.files.remove(stored.ref).catch(() => {});
      return { ok: false, reason: res.reason };
    }
    return { ok: true, replaced: res.replaced, ...stored };
  }

  function rejection(reply, e) {
    if (e instanceof UploadRejected) {
      const status = e.code === "too_large" ? 413 : e.code === "not_configured" ? 503 : 400;
      return reply.code(status).send({ error: e.code, message: e.message });
    }
    throw e;
  }

  // --- admin -------------------------------------------------------------
  app.post("/bookings/:id/people/:personId/upload", {
    onRequest: admin,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: { response: { 200: okOut, 400: errOut, 403: errOut, 404: errOut, 409: errOut, 413: errOut, 503: errOut } },
  }, async (req, reply) => {
    // Scope before anything is read or stored: an id from another account is
    // not a 403 to probe, it simply does not exist here.
    if (!await bookingInAccount(client, req.accountId, req.params.id)) {
      return reply.code(404).send({ error: "not_found" });
    }
    try {
      const { file, docType } = await readUpload(req, maxBytes);
      const res = await accept(req.params.id, req.params.personId, file, docType, "admin");
      if (!res.ok) return reply.code(res.reason === "window_closed" ? 409 : 404).send({ error: res.reason });
      req.log.info({ booking: req.params.id, bytes: res.byteSize }, "id document stored");
      return { ok: true, replaced: res.replaced, docType, byteSize: res.byteSize };
    } catch (e) { return rejection(reply, e); }
  });

  // --- reading one back: admin only --------------------------------------
  app.get("/documents/:documentId", {
    onRequest: admin,
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const doc = await one(client,
      `SELECT d.id, d.file_ref, d.content_type, d.doc_type, d.deleted_at, p.name, b.id AS booking_id
       FROM documents d JOIN people p ON p.id = d.person_id JOIN bookings b ON b.id = p.booking_id
       JOIN listings l ON l.id = b.listing_id
       WHERE d.id = ? AND l.account_id = ?`, [req.params.documentId, req.accountId]);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    if (!doc.file_ref) {
      return reply.code(410).send({ error: "deleted", message: "This file was deleted on the retention schedule." });
    }
    const stored = await app.files.get(doc.file_ref);
    if (!stored) {
      req.log.error({ document: doc.id }, "document row exists but its bytes are missing");
      return reply.code(410).send({ error: "missing", message: "The stored file could not be found." });
    }
    let bytes;
    try {
      bytes = decrypt(stored, app.fileKey);
    } catch (e) {
      // GCM failing means the bytes were altered or the key changed. Either way
      // this must be loud, not a corrupt download.
      req.log.error({ document: doc.id, err: e.message }, "document failed to decrypt");
      return reply.code(500).send({ error: "undecryptable" });
    }
    return reply
      .header("content-type", doc.content_type || "application/octet-stream")
      // inline, so viewing an ID does not litter the host's Downloads folder.
      .header("content-disposition", `inline; filename="${doc.doc_type.replace(/[^\w.-]/g, "_")}"`)
      .header("cache-control", "no-store, private")
      .send(bytes);
  });

  /** Delete the bytes, keep the row. Retention, and the "remove" action. */
  app.delete("/documents/:documentId/file", {
    onRequest: admin,
    schema: { response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 404: errOut } },
  }, async (req, reply) => {
    const doc = await one(client,
      `SELECT d.id, d.file_ref FROM documents d
        JOIN people p ON p.id = d.person_id JOIN bookings b ON b.id = p.booking_id
        JOIN listings l ON l.id = b.listing_id
       WHERE d.id = ? AND l.account_id = ?`, [req.params.documentId, req.accountId]);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    if (doc.file_ref) await app.files.remove(doc.file_ref).catch(() => {});
    // The row survives so "an ID was collected and sent" stays provable.
    await run(client, "UPDATE documents SET file_ref = NULL, deleted_at = ? WHERE id = ?", [nowIso(), doc.id]);
    return { ok: true };
  });
}

/**
 * The guest half, registered WITHOUT a prefix: /u/:token/... is a URL a person
 * pastes into a phone, so it stays short. Same pipeline as the admin route —
 * a guest is trusted exactly as little.
 */
export async function registerGuestUploads(app) {
  const client = app.db.client;
  const { maxBytes, allowedTypes } = app.config.storage;

  app.post("/u/:token/people/:personId/upload", {
    config: { rateLimit: { max: app.config.rateLimits.guestPerMinute, timeWindow: "1 minute" } },
    schema: { response: { 200: okOut, 400: errOut, 404: errOut, 409: errOut, 413: errOut, 503: errOut } },
  }, async (req, reply) => {
    const bookingId = await bookingIdForToken(client, req.params.token, app.guestSecret);
    if (!bookingId) return reply.code(404).send({ error: "link_not_active", message: "This link is no longer active." });
    try {
      const { file, docType } = await readUpload(req, maxBytes);
      const stored = await receiveDocument(file.bytes, { store: app.files, key: app.fileKey, allowedTypes, maxBytes });
      const res = await putDocument(client, bookingId, req.params.personId, {
        docType, fileRef: stored.ref, byteSize: stored.byteSize, contentType: stored.contentType, actor: "guest",
      });
      if (!res.ok) {
        // Never leave an orphan blob behind when the row is refused.
        await app.files.remove(stored.ref).catch(() => {});
        return reply.code(res.reason === "window_closed" ? 409 : 404).send({ error: res.reason });
      }
      req.log.info({ booking: bookingId, bytes: stored.byteSize }, "id document stored (guest)");
      return { ok: true, replaced: res.replaced, docType, byteSize: stored.byteSize };
    } catch (e) {
      if (e instanceof UploadRejected) {
        const status = e.code === "too_large" ? 413 : e.code === "not_configured" ? 503 : 400;
        return reply.code(status).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });
}

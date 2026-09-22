// ---------------------------------------------------------------------------
// Everything that changes a booking.
//
// Two rules hold throughout:
//
//   1. The window is enforced HERE, not in the UI. `Derive.documentsEditable`
//      is the same test the browser uses, so a request that arrives after the
//      retention moment is refused however it was made.
//   2. Anything a human would later ask about writes an `activity` row, in the
//      same transaction as the change.
// ---------------------------------------------------------------------------
import { one, run, query, newId, nowIso, transaction } from "../db/client.js";
import { getBooking, appSettings } from "./bookings.js";
import { Derive, fillTemplate } from "../../../shared/rules.js";
import { buildAttachments, AttachmentsUnavailable } from "../mail/attachments.js";
import { bookingChanged } from "../events.js";

const MAX_ADULTS = 30;

async function logActivity(exec, bookingId, { kind, actor, text, at = nowIso() }) {
  await exec.execute({
    sql: "INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)",
    args: [newId("act"), bookingId, at, kind, actor, text],
  });
}

/** Load just enough to evaluate the rules, without the society and activity. */
async function loadForRules(client, id) {
  const row = await one(client, `
    SELECT b.*, l.name AS listing_name FROM bookings b
    JOIN listings l ON l.id = b.listing_id WHERE b.id = ?`, [id]);
  if (!row) return null;
  const people = await query(client, `
    SELECT p.id, p.name, p.is_lead, d.doc_type, d.file_ref, d.content_type
    FROM people p LEFT JOIN documents d ON d.person_id = p.id
    WHERE p.booking_id = ? ORDER BY p.is_lead DESC, p.rowid`, [id]);
  return {
    id: row.id, code: row.airbnb_code, listingId: row.listing_id, listingName: row.listing_name,
    checkIn: row.check_in, checkOut: row.check_out, children: Number(row.children || 0),
    leadGuest: row.lead_guest || null, automation: row.automation,
    sentAt: row.sent_at || null, conflict: Boolean(row.conflict),
    sentTo: row.sent_to || null, sentCc: row.sent_cc || null,
    people: people.map((p) => ({ id: p.id, name: p.name, lead: Boolean(p.is_lead), documentType: p.doc_type || null, fileRef: p.file_ref, contentType: p.content_type })),
  };
}

/** The guard every mutation starts with. */
async function editable(client, id) {
  const booking = await loadForRules(client, id);
  if (!booking) return { ok: false, reason: "not_found" };
  const settings = await appSettings(client);
  if (!Derive.documentsEditable(booking, settings)) return { ok: false, reason: "window_closed" };
  return { ok: true, booking, settings };
}

// --- the adult count ------------------------------------------------------
export async function setAdultCount(client, id, count, { actor = "admin" } = {}) {
  const g = await editable(client, id);
  if (!g.ok) return g;
  const { booking } = g;
  const target = Math.max(1, Math.min(Number(count) || 1, MAX_ADULTS));
  const current = booking.people.length;
  if (target === current) return { ok: true, adults: current, blocked: false };

  let blocked = false;
  await transaction(client, async (tx) => {
    if (target > current) {
      for (let i = current; i < target; i++) {
        await tx.execute({
          sql: "INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,0,?)",
          args: [newId("per"), id, `Adult ${i + 1}`, nowIso()],
        });
      }
    } else {
      // Remove from the end, but never the lead guest and never someone whose
      // ID is already collected — losing that would mean asking them again.
      const removable = [...booking.people].reverse().filter((p) => !p.lead && !p.documentType);
      const wanted = current - target;
      const toRemove = removable.slice(0, wanted);
      blocked = toRemove.length < wanted;
      for (const p of toRemove) await tx.execute({ sql: "DELETE FROM people WHERE id = ?", args: [p.id] });
    }
    const now = await tx.execute({ sql: "SELECT COUNT(*) AS n FROM people WHERE booking_id = ?", args: [id] });
    const adults = Number(now.rows[0].n);
    await logActivity(tx, id, { kind: "party", actor, text: `Adults set to ${adults}${actor === "guest" ? " (guest)" : ""}` });
    await tx.execute({ sql: "UPDATE bookings SET updated_at = ? WHERE id = ?", args: [nowIso(), id] });
  });

  const after = await loadForRules(client, id);
  bookingChanged(id);
  return { ok: true, adults: after.people.length, blocked };
}

// --- naming ---------------------------------------------------------------
export async function renamePerson(client, id, personId, name, { actor = "admin" } = {}) {
  const g = await editable(client, id);
  if (!g.ok) return g;
  const person = g.booking.people.find((p) => p.id === personId);
  if (!person) return { ok: false, reason: "no_person" };

  const next = String(name || "").trim().replace(/\s+/g, " ");
  if (!next) return { ok: false, reason: "empty_name" };
  if (next.length > 120) return { ok: false, reason: "name_too_long" };
  if (next === person.name) return { ok: true, changed: false };

  await transaction(client, async (tx) => {
    await tx.execute({ sql: "UPDATE people SET name = ? WHERE id = ?", args: [next, personId] });
    await tx.execute({ sql: "UPDATE bookings SET updated_at = ? WHERE id = ?", args: [nowIso(), id] });
    // The lead guest's name is the booking's identifying name; keep the two in
    // step rather than deriving it twice.
    if (person.lead) {
      await tx.execute({
        sql: "UPDATE bookings SET lead_guest = ?, updated_at = ? WHERE id = ?",
        args: [Derive.isPlaceholderName(next) ? null : next, nowIso(), id],
      });
    }
    await logActivity(tx, id, {
      kind: "rename", actor,
      text: Derive.isPlaceholderName(person.name)
        ? `${next} named${actor === "guest" ? " (guest)" : ""}`
        : `${person.name} renamed to ${next}${actor === "guest" ? " (guest)" : ""}`,
    });
  });
  bookingChanged(id);
  return { ok: true, changed: true };
}

// --- documents ------------------------------------------------------------
/**
 * Record one adult's ID. The same call adds or replaces, because the schema
 * allows one document per person — a replacement is an update, not a new row.
 *
 * Phase 3 adds the actual bytes; this records the metadata the rest of the
 * system reasons about.
 */
export async function putDocument(client, id, personId, { docType, fileRef = null, byteSize = null, contentType = null, actor = "admin" } = {}) {
  const g = await editable(client, id);
  if (!g.ok) return g;
  const person = g.booking.people.find((p) => p.id === personId);
  if (!person) return { ok: false, reason: "no_person" };

  const replacing = Boolean(person.documentType);
  const first = person.name.split(" ")[0];
  await transaction(client, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO documents (id,person_id,doc_type,file_ref,byte_size,content_type,uploaded_at,uploaded_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(person_id) DO UPDATE SET
              doc_type = excluded.doc_type, file_ref = excluded.file_ref,
              byte_size = excluded.byte_size, content_type = excluded.content_type,
              uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by,
              deleted_at = NULL`,
      args: [newId("doc"), personId, docType, fileRef, byteSize, contentType, nowIso(), actor, nowIso()],
    });
    await logActivity(tx, id, {
      kind: replacing ? "replace" : "upload", actor,
      text: replacing
        ? `${first} replaced ${person.documentType} with ${docType}${actor === "guest" ? " (guest)" : ""}`
        : `${first} uploaded ${docType}${actor === "guest" ? " (guest)" : ""}`,
    });
    await tx.execute({ sql: "UPDATE bookings SET updated_at = ? WHERE id = ?", args: [nowIso(), id] });
  });
  bookingChanged(id);
  return { ok: true, replaced: replacing };
}

export async function removeDocument(client, id, personId, { actor = "admin" } = {}) {
  const g = await editable(client, id);
  if (!g.ok) return g;
  const person = g.booking.people.find((p) => p.id === personId);
  if (!person) return { ok: false, reason: "no_person" };
  if (!person.documentType) return { ok: false, reason: "no_document" };

  await transaction(client, async (tx) => {
    await tx.execute({ sql: "DELETE FROM documents WHERE person_id = ?", args: [personId] });
    await logActivity(tx, id, {
      kind: "remove", actor,
      text: `${person.name.split(" ")[0]}'s ${person.documentType} removed${actor === "guest" ? " (guest)" : ""}`,
    });
    await tx.execute({ sql: "UPDATE bookings SET updated_at = ? WHERE id = ?", args: [nowIso(), id] });
  });
  bookingChanged(id);
  return { ok: true };
}

// --- automation -----------------------------------------------------------
export async function setAutomation(client, id, mode, { actor = "admin" } = {}) {
  const booking = await loadForRules(client, id);
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.automation === mode) return { ok: true, changed: false };
  await transaction(client, async (tx) => {
    await tx.execute({ sql: "UPDATE bookings SET automation = ?, updated_at = ? WHERE id = ?", args: [mode, nowIso(), id] });
    await logActivity(tx, id, {
      kind: "automation", actor,
      text: mode === "before" ? "Auto-send set to 1 hour before check-in" : "Auto-send set to when all IDs are collected",
    });
  });
  bookingChanged(id);
  return { ok: true, changed: true };
}

// --- sending --------------------------------------------------------------
/**
 * Send the security email.
 *
 * `sent_at` is written ONLY after the transport reports success, and in the
 * same transaction as the activity row. A booking must never read "Sent" when
 * nothing left — that is the failure the whole product exists to prevent.
 */
export async function sendBooking(client, id, transport, { actor = "admin", auto = false, mailFrom, files, fileKey, maxAttachmentBytes, allowIncomplete = false } = {}) {
  const booking = await loadForRules(client, id);
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.conflict) return { ok: false, reason: "conflict" };
  // A MANUAL send is locked until every adult ID is in. The "1 hour before
  // check-in" automation is the deliberate exception — its whole purpose is to
  // reach the desk on time with whatever has been collected
  // (docs/DECISIONS.md, "Automation"). Even then, zero IDs is nothing worth
  // sending.
  const missing = booking.people.filter((p) => !p.documentType);
  if (!Derive.complete(booking)) {
    if (!allowIncomplete) return { ok: false, reason: "incomplete" };
    if (missing.length === booking.people.length) {
      return { ok: false, reason: "no_documents", message: "No IDs have been collected yet, so there is nothing to send." };
    }
  }

  const settings = await appSettings(client);
  const resend = Boolean(booking.sentAt);
  // Past the file delete there is nothing to attach, so a resend is impossible.
  if (resend && !Derive.canResend(booking, settings)) return { ok: false, reason: "files_deleted" };

  // The destination is pinned on the first send; a resend reuses it and does
  // not follow a later change to the listing's society.
  let to = booking.sentTo, cc = booking.sentCc, societyId = null, societyName = booking.sentSocietyName;
  let society;
  if (!to) {
    society = await one(client, `
      SELECT s.id, s.name, s.desk_email_to, s.desk_email_cc, s.template
      FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN societies s ON s.id = l.society_id
      WHERE b.id = ?`, [id]);
    if (!society) return { ok: false, reason: "no_society" };
    to = society.desk_email_to; cc = society.desk_email_cc || ""; societyId = society.id; societyName = society.name;
  } else {
    society = await one(client, "SELECT id, name, template FROM societies WHERE id = ?", [booking.sentSocietyId || ""]) || null;
  }
  const template = society?.template
    || (await one(client, `SELECT s.template FROM bookings b JOIN listings l ON l.id = b.listing_id
         JOIN societies s ON s.id = l.society_id WHERE b.id = ?`, [id]))?.template
    || "";

  // Decrypt every ID into memory. If ANY of them cannot be produced, the send
  // is refused: an email with a missing ID is worse than no email, because the
  // desk clears the guests it has and stops the one it does not, at the gate.
  let built;
  try {
    built = await buildAttachments(booking.people, { store: files, key: fileKey, maxTotalBytes: maxAttachmentBytes });
  } catch (e) {
    if (e instanceof AttachmentsUnavailable) return { ok: false, reason: e.code, message: e.message };
    throw e;
  }

  // The desk must be told that someone is arriving without an ID on file —
  // otherwise an attachment count that looks short reads as a mistake, and they
  // cannot tell who to stop.
  const body = fillTemplate(template, { ...booking, societyName }, (iso) => iso)
    + (missing.length
        ? `\n\n---\nStill awaiting an ID for: ${missing.map((p) => p.name).join(", ")}.`
          + `\nThese will follow before arrival; please contact the host if they do not.`
        : "");

  const message = {
    from: mailFrom,
    to, cc,
    // Plain ASCII on purpose: an em-dash forces RFC 2047 encoding and folding,
    // which every modern client decodes but an old mail system at a society
    // desk may render as gibberish. The subject is the first thing they read.
    subject: `Guest IDs - ${booking.listingName} - arriving ${booking.checkIn}`,
    body,
    attachments: built.attachments,
    bookingId: id,
  };

  let delivery;
  try {
    delivery = await transport.send(message);
  } catch (e) {
    // A failed send leaves the booking exactly as it was, and says why.
    return { ok: false, reason: e.code || "send_failed", message: e.message };
  }

  const at = nowIso();
  await transaction(client, async (tx) => {
    await tx.execute({
      sql: `UPDATE bookings SET sent_at = ?, sent_to = ?, sent_cc = ?, sent_society_id = COALESCE(sent_society_id, ?), updated_at = ? WHERE id = ?`,
      args: [at, to, cc, societyId, at, id],
    });
    await logActivity(tx, id, {
      at, kind: "send", actor,
      text: `${resend ? "Resent" : `Email ${auto ? "auto-" : ""}sent`} to ${to} with ${built.attachments.length} ID file(s)`
        + (missing.length ? `, ${missing.length} still awaited` : ""),
    });
  });

  bookingChanged(id);
  return { ok: true, resend, to, cc, delivery, attachments: built.attachments.length, totalBytes: built.totalBytes };
}

export { loadForRules };

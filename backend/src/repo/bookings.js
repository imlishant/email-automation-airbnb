// ---------------------------------------------------------------------------
// Bookings: the one hot read in the system.
//
// Two rules shape everything here:
//
//   1. Status, adult count, nights and every retention window are DERIVED, in
//      shared/rules.js, which the browser imports too. This file returns facts
//      and never a computed status.
//   2. The list is bounded by retention, not by hope. It is keyset-paginated
//      anyway (docs/TECH_STACK.md §5) so cost stays flat if that ever changes.
// ---------------------------------------------------------------------------
import { query, one } from "../db/client.js";
import { Derive, addDays } from "../../../shared/rules.js";

/** The shape shared/rules.js expects. Nothing derived is included. */
function shapeBooking(row, people = []) {
  return {
    id: row.id,
    code: row.airbnb_code,
    listingId: row.listing_id,
    listingName: row.listing_name,
    societyId: row.society_id,
    societyName: row.society_name,
    checkIn: row.check_in,
    checkOut: row.check_out,
    children: Number(row.children || 0),
    leadGuest: row.lead_guest || null,
    phoneLast4: row.phone_last4 || null,
    automation: row.automation,
    sentAt: row.sent_at || null,
    conflict: Boolean(row.conflict),
    conflictReason: row.conflict_reason || null,
    lastDocumentAt: row.last_document_at || null,
    // Pinned at send time: a resend goes where the first send went
    // (migration 003).
    sentTo: row.sent_to || null,
    sentCc: row.sent_cc || null,
    sentSocietyName: row.sent_society_name || null,
    people,
  };
}

const shapePerson = (r) => ({
  id: r.id,
  name: r.name,
  lead: Boolean(r.is_lead),
  documentType: r.doc_type || null,
  documentId: r.document_id || null,
  // Once the file is deleted the row survives, so the booking still reads as
  // complete but cannot be resent.
  fileDeleted: Boolean(r.doc_type && !r.file_ref),
});

const BASE = `
  SELECT b.*,
         l.name AS listing_name, l.society_id,
         s.name AS society_name,
         ss.name AS sent_society_name,
         (SELECT MAX(d.uploaded_at) FROM documents d
            JOIN people p ON p.id = d.person_id WHERE p.booking_id = b.id) AS last_document_at
  FROM bookings b
  JOIN listings l ON l.id = b.listing_id
  JOIN societies s ON s.id = l.society_id
  LEFT JOIN societies ss ON ss.id = b.sent_society_id`;

const encodeCursor = (b) => Buffer.from(`${b.checkIn}|${b.id}`).toString("base64url");
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [checkIn, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !id) return null;
    return { checkIn, id };
  } catch { return null; }
}

/**
 * The admin list.
 *
 * The retention filter is applied in two steps on purpose. SQL narrows on
 * `check_out` — index-friendly, and it discards the overwhelming majority of
 * rows. The exact cutoff then comes from `Derive.visible`, because it depends on
 * the host's check-out TIME and must be the same rule the browser uses. The
 * over-fetch is bounded to a day either side, so it is a handful of rows.
 */
export async function listBookings(client, { listingId = null, cursor = null, limit = 25, settings, now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const sqlCutoff = addDays(today, -2);

  const args = [sqlCutoff];
  let where = "b.check_out >= ?";
  if (listingId) { where += " AND b.listing_id = ?"; args.push(listingId); }

  const rows = await query(client, `${BASE} WHERE ${where} ORDER BY b.check_in, b.id`, args);
  const ids = rows.map((r) => r.id);
  const peopleByBooking = await peopleFor(client, ids);

  // Derived, in one place, from the same module the browser uses.
  const all = rows
    .map((r) => shapeBooking(r, peopleByBooking.get(r.id) || []))
    .filter((b) => Derive.visible(b, settings, now));

  // Attention first, then chronological (docs/DECISIONS.md, "Sorting").
  const ordered = [...all.filter((b) => Derive.needsAttention(b)), ...all.filter((b) => !Derive.needsAttention(b))];

  const start = cursor
    ? ordered.findIndex((b) => b.id === decodeCursor(cursor)?.id) + 1
    : 0;
  const page = ordered.slice(start, start + limit);

  return {
    rows: page,
    nextCursor: start + limit < ordered.length ? encodeCursor(page[page.length - 1]) : null,
    counts: {
      attention: all.filter((b) => Derive.needsAttention(b)).length,
      settled: all.filter((b) => !Derive.needsAttention(b)).length,
    },
    // Cheap ETag input: the newest change plus how many rows there are, so both
    // an edit and a deletion move it.
    version: `${all.length}-${all.reduce((m, b) => (b.lastDocumentAt > m ? b.lastDocumentAt : m), "") || "0"}`,
  };
}

async function peopleFor(client, bookingIds) {
  const map = new Map();
  if (!bookingIds.length) return map;
  // One query for every booking's people, not one per booking: the database is
  // a network hop away now (docs/TECH_STACK.md §2a), so N+1 is a real cost.
  const placeholders = bookingIds.map(() => "?").join(",");
  const rows = await query(client, `
    SELECT p.id, p.booking_id, p.name, p.is_lead, d.doc_type, d.file_ref, d.id AS document_id
    FROM people p
    LEFT JOIN documents d ON d.person_id = p.id
    WHERE p.booking_id IN (${placeholders})
    ORDER BY p.is_lead DESC, p.created_at, p.id`, bookingIds);
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push(shapePerson(r));
  }
  return map;
}

export async function getBooking(client, id) {
  const row = await one(client, `${BASE} WHERE b.id = ?`, [id]);
  if (!row) return null;
  const people = (await peopleFor(client, [id])).get(id) || [];
  const booking = shapeBooking(row, people);

  // The society is resolved through the listing, live, for an unsent booking.
  const society = await one(client,
    "SELECT id, name, desk_email_to, desk_email_cc, template FROM societies WHERE id = ?", [row.society_id]);
  booking.society = society
    ? { id: society.id, name: society.name, to: society.desk_email_to, cc: society.desk_email_cc || "", template: society.template }
    : null;

  booking.activity = (await query(client,
    "SELECT at, kind, actor, text FROM activity WHERE booking_id = ? ORDER BY at DESC, rowid DESC LIMIT 100", [id]))
    .map((a) => ({ at: a.at, kind: a.kind, actor: a.actor, text: a.text }));

  return booking;
}

export async function appSettings(client) {
  const row = await one(client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
  return { checkInTime: row.check_in_time, checkOutTime: row.check_out_time };
}

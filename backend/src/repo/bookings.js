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
 * The admin list, in two round trips whatever the size.
 *
 *   1. NARROW: one small row per visible booking — dates, flags and two counts.
 *      Enough for Derive to decide visibility, status and order, so the rule
 *      stays in shared/rules.js rather than being re-implemented in SQL.
 *   2. FULL: names, people and documents, but only for the page being shown.
 *
 * This replaced loading every booking and every guest on each request, which
 * the load test showed growing the server from 177MB to ~400MB at 100x data —
 * too close to a 512MB host.
 */
export async function listBookings(client, { listingId = null, cursor = null, limit = 25, settings, now = Date.now() } = {}) {
  const sqlCutoff = addDays(new Date(now).toISOString().slice(0, 10), -2);
  const args = [sqlCutoff];
  let where = "b.check_out >= ?";
  if (listingId) { where += " AND b.listing_id = ?"; args.push(listingId); }

  const narrow = (await query(client, `
    SELECT b.id, b.check_in, b.check_out, b.conflict, b.sent_at, b.updated_at,
           (SELECT COUNT(*) FROM people p WHERE p.booking_id = b.id) AS adults,
           (SELECT COUNT(*) FROM people p JOIN documents d ON d.person_id = p.id WHERE p.booking_id = b.id) AS docs,
           (SELECT MAX(d.uploaded_at) FROM people p JOIN documents d ON d.person_id = p.id WHERE p.booking_id = b.id) AS last_doc
    FROM bookings b WHERE ${where} ORDER BY b.check_in, b.id`, args))
    .map((r) => ({
      id: r.id, checkIn: r.check_in, checkOut: r.check_out,
      conflict: Boolean(r.conflict), sentAt: r.sent_at || null,
      updatedAt: r.updated_at, lastDoc: r.last_doc || "",
      // A stand-in with exactly what Derive reads from people — how many there
      // are and how many have an ID — without loading a single name.
      people: Array.from({ length: Number(r.adults) }, (_, k) => ({ documentType: k < Number(r.docs) ? "held" : null })),
    }))
    .filter((b) => Derive.visible(b, settings, now));

  // Attention first, then chronological (docs/DECISIONS.md, "Sorting").
  const ordered = [...narrow.filter((b) => Derive.needsAttention(b)), ...narrow.filter((b) => !Derive.needsAttention(b))];
  const start = cursor ? ordered.findIndex((b) => b.id === decodeCursor(cursor)?.id) + 1 : 0;
  const pageIds = ordered.slice(start, start + limit).map((b) => b.id);

  let rows = [];
  if (pageIds.length) {
    const marks = pageIds.map(() => "?").join(",");
    const [full, people] = await client.batch([
      { sql: `${BASE} WHERE b.id IN (${marks})`, args: pageIds },
      { sql: `SELECT p.id, p.booking_id, p.name, p.is_lead, d.doc_type, d.file_ref, d.id AS document_id
              FROM people p LEFT JOIN documents d ON d.person_id = p.id
              WHERE p.booking_id IN (${marks}) ORDER BY p.is_lead DESC, p.rowid`, args: pageIds },
    ], "read");
    const byBooking = new Map();
    for (const r of people.rows) {
      if (!byBooking.has(r.booking_id)) byBooking.set(r.booking_id, []);
      byBooking.get(r.booking_id).push(shapePerson(r));
    }
    const byId = new Map(full.rows.map((r) => [r.id, shapeBooking(r, byBooking.get(r.id) || [])]));
    rows = pageIds.map((id) => byId.get(id)).filter(Boolean);     // keep the decided order
  }

  return {
    rows,
    nextCursor: start + limit < ordered.length && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    counts: {
      attention: narrow.filter((b) => Derive.needsAttention(b)).length,
      settled: narrow.filter((b) => !Derive.needsAttention(b)).length,
    },
    // The ETag input: every change bumps updated_at or adds a document, and the
    // count catches a booking dropping off the list.
    version: `${narrow.length}-${narrow.reduce((m, b) => (b.updatedAt > m ? b.updatedAt : m), "")}-${narrow.reduce((m, b) => (b.lastDoc > m ? b.lastDoc : m), "")}`,
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
    ORDER BY p.is_lead DESC, p.rowid`, bookingIds);
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push(shapePerson(r));
  }
  return map;
}

/**
 * One booking, fully loaded, in ONE database round trip.
 *
 * Five statements, sent together with batch(). On a local file that barely
 * matters; on Turso every separate query is a network hop (~10-30ms), and this
 * used to make nine of them — the load test put the detail page at roughly
 * 180ms in production against a 90ms budget.
 */
export async function getBooking(client, id) {
  const [bookingRes, peopleRes, activityRes, settingsRes, linkRes] = await client.batch([
    { sql: `${BASE.replace("s.name AS society_name", "s.name AS society_name, s.desk_email_to AS s_to, s.desk_email_cc AS s_cc, s.template AS s_template")} WHERE b.id = ?`, args: [id] },
    { sql: `SELECT p.id, p.booking_id, p.name, p.is_lead, d.doc_type, d.file_ref, d.id AS document_id
            FROM people p LEFT JOIN documents d ON d.person_id = p.id
            WHERE p.booking_id = ? ORDER BY p.is_lead DESC, p.rowid`, args: [id] },
    { sql: "SELECT at, kind, actor, text FROM activity WHERE booking_id = ? ORDER BY at DESC, rowid DESC LIMIT 100", args: [id] },
    { sql: "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1", args: [] },
    { sql: "SELECT token, expires_at FROM guest_links WHERE booking_id = ? AND revoked_at IS NULL", args: [id] },
  ], "read");

  const row = bookingRes.rows[0];
  if (!row) return null;
  const booking = shapeBooking(row, peopleRes.rows.map(shapePerson));
  // Resolved through the listing, live, for an unsent booking.
  booking.society = row.society_id
    ? { id: row.society_id, name: row.society_name, to: row.s_to, cc: row.s_cc || "", template: row.s_template }
    : null;
  booking.activity = activityRes.rows.map((a) => ({ at: a.at, kind: a.kind, actor: a.actor, text: a.text }));
  const st = settingsRes.rows[0];
  booking.times = { checkInTime: st.check_in_time, checkOutTime: st.check_out_time };
  // Handed to ensureGuestLink so it does not look these up again.
  booking._liveLink = linkRes.rows[0] || null;
  return booking;
}

export async function appSettings(client) {
  const row = await one(client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
  return { checkInTime: row.check_in_time, checkOutTime: row.check_out_time };
}

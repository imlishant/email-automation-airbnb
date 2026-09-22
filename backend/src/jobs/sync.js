// ---------------------------------------------------------------------------
// Turning an Airbnb calendar into bookings.
//
// The governing rule is docs/PRODUCT_PRINCIPLES.md 9: degrade visibly, never
// silently. A feed that fails, contradicts itself, or drops a booking must
// never cause data loss — it surfaces as something a human can act on.
// ---------------------------------------------------------------------------
import { query, one, run, newId, nowIso, transaction } from "../db/client.js";
import { connectListing } from "../ical/connect.js";
import { findOverlaps } from "../ical/parse.js";
import { recordSync } from "../repo/listings.js";
import { listChanged } from "../events.js";

async function logActivity(exec, bookingId, kind, text) {
  await exec.execute({
    sql: "INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)",
    args: [newId("act"), bookingId, nowIso(), kind, "system", text],
  });
}

/** Match a feed event to an existing booking: by code first, then by feed UID. */
function matchExisting(existing, event) {
  if (event.code) {
    const byCode = existing.find((b) => b.airbnb_code === event.code);
    if (byCode) return byCode;
  }
  if (event.uid) {
    const byUid = existing.find((b) => b.ical_uid === event.uid);
    if (byUid) return byUid;
  }
  return null;
}

/**
 * Sync one listing.
 *
 * @returns a summary the UI and the logs can both use. Never throws for a feed
 *   problem — a broken calendar is a state, not an exception.
 */
export async function syncListing(client, listing, { now = Date.now(), read = connectListing, allowPrivate = false } = {}) {
  if (!listing.icalUrl) {
    return { ok: false, code: "disconnected", message: "This listing has no calendar link.", created: 0, updated: 0, conflicts: 0 };
  }

  const report = await read(listing.icalUrl, { allowPrivate });
  if (!report.ok) {
    // Keep every booking we already have. A feed that is down for an hour must
    // not empty the host's list.
    await recordSync(client, listing.id, { error: `${report.code}: ${report.message}` });
    return { ok: false, code: report.code, message: report.message, created: 0, updated: 0, conflicts: 0 };
  }

  const existing = await query(client,
    "SELECT id, airbnb_code, ical_uid, check_in, check_out, conflict, conflict_reason, sent_at FROM bookings WHERE listing_id = ?",
    [listing.id]);

  // Overlapping reservations in the feed itself are a conflict on both.
  const overlapping = new Set();
  for (const [a, b] of findOverlaps(report.reservations)) {
    overlapping.add(a.code || a.uid);
    overlapping.add(b.code || b.uid);
  }

  const seen = new Set();
  let created = 0, updated = 0, conflicts = 0;

  for (const event of report.reservations) {
    const key = event.code || event.uid;
    const match = matchExisting(existing, event);
    const isConflicted = overlapping.has(key);
    if (match) seen.add(match.id);

    if (!match) {
      const bookingId = newId("bkg");
      await transaction(client, async (tx) => {
        await tx.execute({
          sql: `INSERT INTO bookings (id,airbnb_code,ical_uid,listing_id,check_in,check_out,children,automation,
                  phone_last4,conflict,conflict_reason,created_at,updated_at)
                VALUES (?,?,?,?,?,?,0,'allids',?,?,?,?,?)`,
          args: [bookingId, event.code, event.uid, listing.id, event.checkIn, event.checkOut,
                 event.phoneLast4 || null, isConflicted ? 1 : 0,
                 isConflicted ? "Dates overlap another reservation in the Airbnb calendar" : null,
                 nowIso(), nowIso()],
        });
        // One unnamed lead guest. The feed carries no name and none is invented;
        // the host or the guest types it (docs/DECISIONS.md).
        await tx.execute({
          sql: "INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)",
          args: [newId("per"), bookingId, "Lead guest", nowIso()],
        });
        await logActivity(tx, bookingId, "sync", "Booking synced from Airbnb");
        if (isConflicted) await logActivity(tx, bookingId, "conflict", "Sync conflict: dates overlap another reservation");
      });
      created++;
      if (isConflicted) conflicts++;
      continue;
    }

    const datesChanged = match.check_in !== event.checkIn || match.check_out !== event.checkOut;
    const conflictChanged = Boolean(match.conflict) !== isConflicted;
    if (!datesChanged && !conflictChanged) continue;

    await transaction(client, async (tx) => {
      await tx.execute({
        sql: `UPDATE bookings SET check_in = ?, check_out = ?, conflict = ?, conflict_reason = ?,
                airbnb_code = COALESCE(airbnb_code, ?), ical_uid = COALESCE(ical_uid, ?), updated_at = ?
              WHERE id = ?`,
        args: [event.checkIn, event.checkOut, isConflicted ? 1 : 0,
               isConflicted ? "Dates overlap another reservation in the Airbnb calendar" : null,
               event.code, event.uid, nowIso(), match.id],
      });
      if (datesChanged) {
        // Said explicitly: a moved checkout moves every retention window with it.
        await logActivity(tx, match.id, "sync",
          `Dates changed on Airbnb: ${match.check_in} → ${match.check_out} became ${event.checkIn} → ${event.checkOut}`);
      }
      if (conflictChanged) {
        await logActivity(tx, match.id, "conflict",
          isConflicted ? "Sync conflict: dates overlap another reservation" : "Sync conflict resolved");
      }
    });
    updated++;
    if (isConflicted) conflicts++;
  }

  // A booking that has vanished from the feed was probably cancelled — but the
  // feed also only covers a window, and a parse quirk could drop one. So it is
  // FLAGGED, never deleted: the host decides.
  const today = new Date(now).toISOString().slice(0, 10);
  let vanished = 0;
  for (const b of existing) {
    if (seen.has(b.id) || b.check_out < today) continue;
    if (b.conflict) continue;
    await transaction(client, async (tx) => {
      await tx.execute({
        sql: "UPDATE bookings SET conflict = 1, conflict_reason = ?, updated_at = ? WHERE id = ?",
        args: ["No longer in the Airbnb calendar — cancelled, or the calendar link changed", nowIso(), b.id],
      });
      await logActivity(tx, b.id, "conflict", "This booking is no longer in the Airbnb calendar");
    });
    vanished++;
  }

  await recordSync(client, listing.id, { at: nowIso() });
  if (created || updated || vanished) listChanged();
  return { ok: true, created, updated, conflicts, vanished, reservations: report.reservations.length, notes: report.notes };
}

/** Sync every connected listing. One bad feed does not stop the others. */
export async function syncAllListings(client, { log = () => {}, allowPrivate = false } = {}) {
  const listings = await query(client,
    "SELECT id, name, ical_url AS icalUrl FROM listings WHERE ical_url != '' ORDER BY name");
  const results = [];
  for (const listing of listings) {
    try {
      const r = await syncListing(client, listing, { allowPrivate });
      results.push({ listing: listing.id, name: listing.name, ...r });
      log(`sync ${listing.name}: ${r.ok ? `${r.created} new, ${r.updated} updated` : r.code}`);
    } catch (e) {
      await recordSync(client, listing.id, { error: `unexpected: ${e.message}` });
      results.push({ listing: listing.id, name: listing.name, ok: false, code: "error", message: e.message });
      log(`sync ${listing.name}: failed — ${e.message}`);
    }
  }
  return results;
}

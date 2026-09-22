// ---------------------------------------------------------------------------
// Retention: at checkout + 24h, everything about a booking is deleted — the ID
// files, then the booking, its people, its activity and its guest link
// (docs/DECISIONS.md, "Retention"). Nothing is kept.
//
// Order matters. BYTES FIRST, rows second. If the row went first and the byte
// delete then failed, the encrypted file would be orphaned with nothing
// pointing at it — and never deleted. That is holding an identity document
// indefinitely, the one outcome this job exists to prevent. So a booking whose
// files cannot all be removed keeps its row, and the next tick tries again.
// ---------------------------------------------------------------------------
import { query, run } from "../db/client.js";
import { appSettings } from "../repo/bookings.js";
import { Derive, addDays } from "../../../shared/rules.js";
import { listChanged } from "../events.js";

export async function findExpired(client, { now = Date.now() } = {}) {
  const settings = await appSettings(client);
  // SQL narrows to anything whose checkout is at least a day gone; Derive
  // decides exactly, using the host's check-out time.
  const cutoff = addDays(new Date(now).toISOString().slice(0, 10), -1);
  const rows = await query(client, "SELECT id, airbnb_code, check_in, check_out FROM bookings WHERE check_out <= ?", [cutoff]);
  return rows.filter((r) => Derive.fullyExpired({ checkIn: r.check_in, checkOut: r.check_out }, settings, now));
}

export async function purgeExpired(client, { store, now = Date.now(), log = () => {} } = {}) {
  const expired = await findExpired(client, { now });
  const results = [];

  for (const b of expired) {
    const files = await query(client, `
      SELECT d.file_ref FROM documents d JOIN people p ON p.id = d.person_id
      WHERE p.booking_id = ? AND d.file_ref IS NOT NULL`, [b.id]);

    let failed = 0;
    for (const f of files) {
      try { await store.remove(f.file_ref); }
      catch (e) { failed++; log(`purge: could not delete a file for ${b.airbnb_code || b.id}: ${e.message}`); }
    }
    if (failed) {
      // Keep the row, so the file stays reachable and the next tick retries.
      results.push({ booking: b.id, purged: false, failedFiles: failed });
      continue;
    }

    // jobs.subject_id is not a foreign key, so it does not cascade.
    await run(client, "DELETE FROM jobs WHERE subject_id = ?", [b.id]);
    // Cascades to people, documents, activity and guest_links.
    await run(client, "DELETE FROM bookings WHERE id = ?", [b.id]);
    results.push({ booking: b.id, purged: true, files: files.length });
  }
  if (results.some((r) => r.purged)) listChanged();
  if (results.length) log(`purge: ${results.filter((r) => r.purged).length} booking(s) deleted`);
  return results;
}

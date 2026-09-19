// ---------------------------------------------------------------------------
// Listings. A listing is the join between an Airbnb calendar and a society, so
// this is where the "never guess the destination" rule is enforced: a society
// must be chosen explicitly and must exist.
// ---------------------------------------------------------------------------
import { query, one, run, newId, nowIso } from "../db/client.js";

const shape = (r) => ({
  id: r.id,
  name: r.name,
  icalUrl: r.ical_url || "",
  societyId: r.society_id,
  societyName: r.society_name || "",
  lastSyncedAt: r.last_synced_at || null,
  lastSyncError: r.last_sync_error || null,
  connected: Boolean(r.ical_url),
});

const SELECT = `
  SELECT l.*, s.name AS society_name
  FROM listings l JOIN societies s ON s.id = l.society_id`;

export async function listListings(client) {
  return (await query(client, `${SELECT} ORDER BY l.name`)).map(shape);
}

export async function getListing(client, id) {
  const row = await one(client, `${SELECT} WHERE l.id = ?`, [id]);
  return row ? shape(row) : null;
}

export async function createListing(client, { name, icalUrl, societyId }) {
  const society = await one(client, "SELECT id FROM societies WHERE id = ?", [societyId]);
  if (!society) return { ok: false, reason: "no_society" };
  const id = newId("lst");
  const at = nowIso();
  await run(client, `INSERT INTO listings (id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`, [id, name.trim(), icalUrl.trim(), societyId, at, at]);
  return { ok: true, listing: await getListing(client, id) };
}

export async function updateListing(client, id, patch) {
  const current = await one(client, "SELECT * FROM listings WHERE id = ?", [id]);
  if (!current) return { ok: false, reason: "not_found" };

  const sets = [], args = [];
  if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name.trim()); }
  if (patch.societyId !== undefined && patch.societyId !== current.society_id) {
    const society = await one(client, "SELECT id FROM societies WHERE id = ?", [patch.societyId]);
    if (!society) return { ok: false, reason: "no_society" };
    sets.push("society_id = ?"); args.push(patch.societyId);
  }
  if (patch.icalUrl !== undefined && patch.icalUrl.trim() !== (current.ical_url || "")) {
    sets.push("ical_url = ?"); args.push(patch.icalUrl.trim());
    // A different calendar means the old sync state is meaningless.
    sets.push("last_synced_at = NULL", "last_sync_error = NULL");
  }
  if (!sets.length) return { ok: true, listing: await getListing(client, id) };
  sets.push("updated_at = ?"); args.push(nowIso(), id);
  await run(client, `UPDATE listings SET ${sets.join(", ")} WHERE id = ?`, args);
  return { ok: true, listing: await getListing(client, id) };
}

/** What a listing is carrying, so the UI can explain a refusal. */
export async function listingUsage(client, id) {
  const row = await one(client, `SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent
    FROM bookings WHERE listing_id = ?`, [id]);
  return { total: Number(row.total || 0), sent: Number(row.sent || 0) };
}

/**
 * Stop syncing, keep everything. The answer for "I do not rent this place any
 * more" that does not destroy records.
 */
export async function disconnectListing(client, id) {
  const res = await run(client,
    "UPDATE listings SET ical_url = '', last_synced_at = NULL, last_sync_error = NULL, updated_at = ? WHERE id = ?",
    [nowIso(), id]);
  if (!res.rowsAffected) return { ok: false, reason: "not_found" };
  return { ok: true, listing: await getListing(client, id) };
}

/**
 * Delete is refused while the listing has bookings. The FK cascades, so this
 * would otherwise silently take bookings, people, documents and the activity
 * log with it.
 */
export async function deleteListing(client, id) {
  const usage = await listingUsage(client, id);
  if (usage.total > 0) return { ok: false, reason: "has_bookings", ...usage };
  const res = await run(client, "DELETE FROM listings WHERE id = ?", [id]);
  return res.rowsAffected ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function recordSync(client, id, { at = nowIso(), error = null } = {}) {
  await run(client, "UPDATE listings SET last_synced_at = ?, last_sync_error = ?, updated_at = ? WHERE id = ?",
    [error ? null : at, error, nowIso(), id]);
  return getListing(client, id);
}

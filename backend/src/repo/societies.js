// ---------------------------------------------------------------------------
// Societies: the security desk and the email template. Parameterised SQL, no
// ORM (docs/TECH_STACK.md §3).
// ---------------------------------------------------------------------------
import { query, one, run, newId, nowIso } from "../db/client.js";

const shape = (r) => ({
  id: r.id,
  name: r.name,
  to: r.desk_email_to,
  cc: r.desk_email_cc || "",
  template: r.template,
  listingCount: r.listing_count ?? 0,
});

export async function listSocieties(client) {
  // One query with an aggregate, not a query per society: the network hop is
  // the cost now that the database is remote (docs/TECH_STACK.md §2a).
  const rows = await query(client, `
    SELECT s.*, (SELECT COUNT(*) FROM listings l WHERE l.society_id = s.id) AS listing_count
    FROM societies s ORDER BY s.name`);
  return rows.map(shape);
}

export async function getSociety(client, id) {
  const row = await one(client, "SELECT * FROM societies WHERE id = ?", [id]);
  return row ? shape(row) : null;
}

export async function createSociety(client, { name, to, cc = "", template }) {
  const id = newId("soc");
  const at = nowIso();
  await run(client, `INSERT INTO societies (id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [id, name.trim(), to.trim(), cc.trim(), template, at, at]);
  return getSociety(client, id);
}

export async function updateSociety(client, id, patch) {
  const existing = await one(client, "SELECT id FROM societies WHERE id = ?", [id]);
  if (!existing) return null;
  const sets = [], args = [];
  // Only the fields actually supplied, so a partial update cannot blank the rest.
  if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name.trim()); }
  if (patch.to !== undefined) { sets.push("desk_email_to = ?"); args.push(patch.to.trim()); }
  if (patch.cc !== undefined) { sets.push("desk_email_cc = ?"); args.push((patch.cc || "").trim()); }
  if (patch.template !== undefined) { sets.push("template = ?"); args.push(patch.template); }
  if (!sets.length) return getSociety(client, id);
  sets.push("updated_at = ?"); args.push(nowIso(), id);
  await run(client, `UPDATE societies SET ${sets.join(", ")} WHERE id = ?`, args);
  return getSociety(client, id);
}

/**
 * Deleting a society is refused while a listing points at it — the schema's
 * ON DELETE RESTRICT would refuse anyway, but a clear reason beats a constraint
 * error reaching the UI.
 */
export async function deleteSociety(client, id) {
  const used = await one(client, "SELECT COUNT(*) AS n FROM listings WHERE society_id = ?", [id]);
  if (used.n > 0) return { ok: false, reason: "has_listings", count: Number(used.n) };
  const res = await run(client, "DELETE FROM societies WHERE id = ?", [id]);
  return res.rowsAffected ? { ok: true } : { ok: false, reason: "not_found" };
}

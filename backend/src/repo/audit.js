// ---------------------------------------------------------------------------
// Admin audit trail. Rows in `activity` with no booking.
//
// Text describes WHAT changed, never a value that is a secret: "Passcode
// changed", never the passcode. Names of societies and listings are fine; they
// are the host's own configuration, not guest data.
// ---------------------------------------------------------------------------
import { query, run, newId, nowIso } from "../db/client.js";

export async function recordAudit(client, { kind, text, ip = null, actor = "admin" }) {
  await run(client, "INSERT INTO activity (id,booking_id,at,kind,actor,text,ip) VALUES (?,NULL,?,?,?,?,?)",
    [newId("act"), nowIso(), kind, actor, text, ip]);
}

export async function listAudit(client, { before = null, limit = 50 } = {}) {
  const rows = await query(client, `
    SELECT at, kind, actor, text, ip FROM activity
    WHERE booking_id IS NULL ${before ? "AND at < ?" : ""}
    ORDER BY at DESC, rowid DESC LIMIT ?`, before ? [before, limit] : [limit]);
  return rows.map((r) => ({ at: r.at, kind: r.kind, actor: r.actor, text: r.text, ip: r.ip || null }));
}

// ---------------------------------------------------------------------------
// Admin audit trail. Rows in `activity` with no booking.
//
// Text describes WHAT changed, never a value that is a secret: "Passcode
// changed", never the passcode. Names of societies and listings are fine; they
// are the host's own configuration, not guest data.
// ---------------------------------------------------------------------------
import { query, run, newId, nowIso } from "../db/client.js";

// Logins are people now, so the row also records WHO — the email they signed
// in with. Still never a value that is a secret.
export async function recordAudit(client, { accountId = null, kind, text, ip = null, actor = "admin", actorEmail = null }) {
  await run(client,
    "INSERT INTO activity (id,booking_id,at,kind,actor,text,ip,account_id,actor_email) VALUES (?,NULL,?,?,?,?,?,?,?)",
    [newId("act"), nowIso(), kind, actor, text, ip, accountId, actorEmail]);
}

export async function listAudit(client, accountId, { before = null, limit = 50 } = {}) {
  const args = before ? [accountId, before, limit] : [accountId, limit];
  const rows = await query(client, `
    SELECT at, kind, actor, text, ip, actor_email FROM activity
    WHERE booking_id IS NULL AND account_id = ? ${before ? "AND at < ?" : ""}
    ORDER BY at DESC, rowid DESC LIMIT ?`, args);
  return rows.map((r) => ({ at: r.at, kind: r.kind, actor: r.actor, text: r.text, ip: r.ip || null,
    by: r.actor_email || null }));
}

// ---------------------------------------------------------------------------
// The database connection. One dependency: @libsql/client.
//
// The same client speaks to a local file in development and to Turso in
// production — the only difference is DATABASE_URL, so nothing in the app
// knows which it is talking to.
//
// There is no ORM. The whole schema is ten tables and the hot query is one
// SELECT; plain parameterised SQL in src/db/ is fewer moving parts and is
// easier to read, review and change than a query builder would be in untyped
// JavaScript. See docs/TECH_STACK.md.
// ---------------------------------------------------------------------------
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase({ url, authToken } = {}) {
  const dbUrl = url || process.env.DATABASE_URL || "file:./data/gatepass.db";

  // SQLite will not create a missing directory; it just reports error 14. A
  // fresh clone has no data/ folder, so make it rather than make that a
  // documented manual step.
  if (dbUrl.startsWith("file:")) {
    const path = dbUrl.slice("file:".length);
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* already there */ }
  }

  const client = createClient({
    url: dbUrl,
    authToken: authToken ?? process.env.DATABASE_AUTH_TOKEN,
  });
  return { client, url: dbUrl, isLocal: dbUrl.startsWith("file:") };
}

/**
 * Settings that must be applied to every local connection.
 *
 * Foreign keys are OFF by default in SQLite, which would make every
 * `REFERENCES` clause in the schema decorative. WAL lets reads continue during
 * a write. Turso manages both itself, so these are local-only.
 */
export async function applyPragmas({ client, isLocal }) {
  if (!isLocal) return;
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
}

/** Never build SQL by interpolation. `args` is always parameterised. */
export async function query(client, sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}
export async function one(client, sql, args = []) {
  const rows = await query(client, sql, args);
  return rows[0] ?? null;
}
export async function run(client, sql, args = []) {
  return client.execute({ sql, args });
}

/**
 * Several statements, all or nothing.
 *
 * The at-most-once send depends on this: marking `bookings.sent_at` and
 * completing the send job happen together, or neither happens.
 */
export async function transaction(client, fn) {
  const tx = await client.transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** Timestamps are ISO 8601 UTC everywhere. */
export const nowIso = () => new Date().toISOString();

let counter = 0;
/** Readable, sortable, collision-resistant ids: "bkg_lk3f9a2b7c1". */
export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  const c = (counter = (counter + 1) % 1296).toString(36).padStart(2, "0");
  return `${prefix}_${t}${r}${c}`;
}

// ---------------------------------------------------------------------------
// Forward-only migrations from numbered .sql files. No tool, no DSL.
//
// Rules:
//   - A file that has been applied is never edited. Add 002_, 003_, …
//   - Each file runs inside one transaction, so a failure leaves nothing half
//     applied.
//   - Running twice is a no-op, which is what makes it safe on every boot.
// ---------------------------------------------------------------------------
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPragmas, nowIso } from "./client.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Split on semicolons that end a statement, ignoring those inside strings. */
export function splitStatements(sql) {
  const out = [];
  let buf = "", inSingle = false, inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (inLineComment) { if (c === "\n") { inLineComment = false; buf += c; } continue; }
    if (!inSingle && c === "-" && next === "-") { inLineComment = true; continue; }
    if (c === "'") inSingle = !inSingle;
    if (c === ";" && !inSingle) { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function ensureLedger(client) {
  await client.execute(`CREATE TABLE IF NOT EXISTS _migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const { client } = db;
  await applyPragmas(db);
  await ensureLedger(client);

  const applied = new Set(
    (await client.execute("SELECT version FROM _migrations")).rows.map((r) => r.version)
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const statements = splitStatements(sql);

    // One transaction per file: a broken migration leaves no partial schema.
    const tx = await client.transaction("write");
    try {
      for (const statement of statements) await tx.execute(statement);
      await tx.execute({ sql: "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", args: [version, nowIso()] });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw new Error(`migration ${file} failed: ${e.message}`);
    }
    ran.push(version);
    log(`applied ${version} (${statements.length} statements)`);
  }
  return { ran, alreadyApplied: [...applied].sort(), total: files.length };
}

/**
 * First-run rows. Separate from the schema so a migration never carries data.
 *
 * `passcodeHash` must already be a real hash — see src/auth/passcode.js. This
 * function does no hashing itself, so the crypto lives in one place and the
 * migrator cannot accidentally write a plaintext passcode.
 */
export async function seedFirstRun(db, { passcodeHash, checkInTime, checkOutTime }) {
  const { client } = db;
  const at = nowIso();
  await client.execute({
    sql: `INSERT INTO admin_auth (id, passcode_hash, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [passcodeHash, at],
  });
  await client.execute({
    sql: `INSERT INTO app_settings (id, check_in_time, check_out_time, updated_at) VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [checkInTime, checkOutTime, at],
  });
}

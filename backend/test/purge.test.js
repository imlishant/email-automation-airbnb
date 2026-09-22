// Retention. The job that stands between us and holding identity documents
// indefinitely, so it is tested for what it must NOT leave behind.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase, applyPragmas, newId, nowIso, run, one, query } from "../src/db/client.js";
import { migrate, seedFirstRun } from "../src/db/migrate.js";
import { localStore } from "../src/files/store.js";
import { findExpired, purgeExpired } from "../src/jobs/purge.js";
import { addDays, toDay } from "../../shared/rules.js";

let dir, db, client, store, lst;
const today = () => toDay(new Date());

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-purge-"));
  db = openDatabase({ url: `file:${join(dir, "t.db")}` });
  client = db.client;
  await applyPragmas(db); await migrate(db);
  await seedFirstRun(db, { passcodeHash: "x", checkInTime: "14:00", checkOutTime: "11:00" });
  store = localStore({ dir: join(dir, "uploads") });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await rm(join(dir, "uploads"), { recursive: true, force: true });
  for (const t of ["jobs", "guest_links", "documents", "people", "activity", "bookings", "listings", "societies"]) await run(client, `DELETE FROM ${t}`);
  const soc = newId("soc"); lst = newId("lst");
  await run(client, `INSERT INTO societies (id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [soc, "S", "d@x.example", "t", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [lst, "L", "https://a.example/c.ics", soc, nowIso(), nowIso()]);
});

async function booking(checkOut, { files = 1 } = {}) {
  const id = newId("bkg");
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [id, newId("HM"), lst, addDays(checkOut, -2), checkOut, nowIso(), nowIso()]);
  await run(client, `INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)`,
    [newId("act"), id, nowIso(), "sync", "system", "synced"]);
  await run(client, `INSERT INTO guest_links (token,booking_id,expires_at,created_at) VALUES (?,?,?,?)`,
    [randomBytes(12).toString("hex"), id, nowIso(), nowIso()]);
  await run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,completed_at,created_at) VALUES (?,'send_booking',?,?,?,?)`,
    [newId("job"), id, nowIso(), nowIso(), nowIso()]);
  const refs = [];
  for (let i = 0; i < files; i++) {
    const per = newId("per"), ref = `t/${randomBytes(8).toString("hex")}`;
    await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,?,?)`, [per, id, "P", i === 0 ? 1 : 0, nowIso()]);
    await store.put(ref, randomBytes(64));
    await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,uploaded_at,uploaded_by,created_at) VALUES (?,?,?,?,?,'guest',?)`,
      [newId("doc"), per, "Aadhaar", ref, nowIso(), nowIso()]);
    refs.push(ref);
  }
  return { id, refs };
}
const count = async (t) => Number((await one(client, `SELECT COUNT(*) AS n FROM ${t}`)).n);
const filesOnDisk = async () => (await readdir(join(dir, "uploads", "t")).catch(() => [])).length;

test("an expired booking leaves NOTHING behind — no row, no file", async () => {
  await booking(addDays(today(), -3), { files: 2 });
  assert.equal(await filesOnDisk(), 2);

  const res = await purgeExpired(client, { store });
  assert.equal(res[0].purged, true);
  for (const t of ["bookings", "people", "documents", "activity", "guest_links", "jobs"]) {
    assert.equal(await count(t), 0, `${t} must be empty`);
  }
  assert.equal(await filesOnDisk(), 0, "the encrypted ID files are gone too");
});

test("a booking inside its window is untouched", async () => {
  await booking(addDays(today(), 3));            // not checked out yet
  await booking(today());                        // checked out today: +24h not reached
  assert.equal((await findExpired(client)).length, 0);
  await purgeExpired(client, { store });
  assert.equal(await count("bookings"), 2);
  assert.equal(await filesOnDisk(), 2);
});

test("the boundary is checkout + 24h at the host's check-out time", async () => {
  const { id } = await booking(addDays(today(), -1));
  const checkoutAt = new Date(`${addDays(today(), -1)}T11:00:00`).getTime();
  assert.equal((await findExpired(client, { now: checkoutAt + 24 * 3600e3 - 1000 })).length, 0, "a second early");
  assert.deepEqual((await findExpired(client, { now: checkoutAt + 24 * 3600e3 + 1000 })).map((b) => b.id), [id]);
});

test("if a file cannot be deleted, the row is KEPT so the file is never orphaned", async () => {
  await booking(addDays(today(), -3));
  const broken = { remove: async () => { throw new Error("storage unreachable"); } };
  const res = await purgeExpired(client, { store: broken });
  assert.equal(res[0].purged, false);
  assert.equal(await count("bookings"), 1, "an orphaned encrypted file would never be deleted");
  assert.equal(await count("documents"), 1);

  // Storage comes back; the next tick finishes the job.
  const again = await purgeExpired(client, { store });
  assert.equal(again[0].purged, true);
  assert.equal(await count("bookings"), 0);
  assert.equal(await filesOnDisk(), 0);
});

test("running twice is harmless", async () => {
  await booking(addDays(today(), -3));
  await purgeExpired(client, { store });
  assert.deepEqual(await purgeExpired(client, { store }), []);
});

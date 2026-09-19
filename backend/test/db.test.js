// Schema checks. Every one runs against a real throwaway database — a
// constraint that is not exercised is a constraint you do not have.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyPragmas, query, one, run, newId, nowIso, transaction } from "../src/db/client.js";
import { migrate, seedFirstRun, splitStatements } from "../src/db/migrate.js";
import { Derive, RULES } from "../../shared/rules.js";

let dir, db, client;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-test-"));
  db = openDatabase({ url: `file:${join(dir, "t.db")}` });
  client = db.client;
  await migrate(db);
  await seedFirstRun(db, { passcodeHash: "hash-placeholder", checkInTime: "14:00", checkOutTime: "11:00" });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

// --- fixtures -------------------------------------------------------------
const at = () => nowIso();
async function makeSociety(name = "Greenwood Society") {
  const id = newId("soc");
  // A distinct desk address per society, so tests about routing can actually
  // tell them apart.
  await run(client, `INSERT INTO societies (id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [id, name, `desk-${id}@example.com`, null, "Dear {{listing}}", at(), at()]);
  return id;
}
async function makeListing(societyId, name = "Sea Breeze 2BHK") {
  const id = newId("lst");
  await run(client, `INSERT INTO listings (id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`, [id, name, "https://example.com/c.ics", societyId, at(), at()]);
  return id;
}
async function makeBooking(listingId, over = {}) {
  const id = newId("bkg");
  const b = { code: newId("HM").toUpperCase(), checkIn: "2026-09-20", checkOut: "2026-09-23", children: 0, automation: "allids", ...over };
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [id, b.code, listingId, b.checkIn, b.checkOut, b.children, b.automation, at(), at()]);
  return id;
}
async function makePerson(bookingId, { name = "Lead guest", lead = 1 } = {}) {
  const id = newId("per");
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,?,?)`,
    [id, bookingId, name, lead, at()]);
  return id;
}
async function makeDocument(personId, docType = "Aadhaar") {
  const id = newId("doc");
  await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,uploaded_at,uploaded_by,created_at)
    VALUES (?,?,?,?,?,?,?)`, [id, personId, docType, "r2/" + id, at(), "guest", at()]);
  return id;
}

// --- migrations -----------------------------------------------------------
test("splitStatements ignores semicolons inside comments and strings", () => {
  assert.equal(splitStatements("CREATE TABLE a(x); -- a; comment\nCREATE TABLE b(y);").length, 2);
  assert.equal(splitStatements("INSERT INTO a VALUES ('x;y');").length, 1);
  assert.equal(splitStatements("   \n -- only a comment\n").length, 0);
});

test("migrating twice is a no-op", async () => {
  const second = await migrate(db);
  assert.deepEqual(second.ran, [], "nothing re-applied");
  assert.ok(second.alreadyApplied.includes("001_init"));
});

test("foreign keys are actually enforced", async () => {
  const fk = await one(client, "PRAGMA foreign_keys");
  assert.equal(fk.foreign_keys, 1, "without this every REFERENCES clause is decorative");
  await assert.rejects(
    run(client, `INSERT INTO bookings (id,listing_id,check_in,check_out,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [newId("bkg"), "lst_does_not_exist", "2026-09-20", "2026-09-23", at(), at()])
  );
});

test("seeding first-run rows is idempotent, and they are singletons", async () => {
  await seedFirstRun(db, { passcodeHash: "second-attempt", checkInTime: "09:00", checkOutTime: "09:00" });
  const settings = await query(client, "SELECT * FROM app_settings");
  assert.equal(settings.length, 1, "still one row");
  assert.equal(settings[0].check_in_time, "14:00", "the first write wins; re-seeding does not clobber");
  await assert.rejects(
    run(client, `INSERT INTO app_settings (id,check_in_time,check_out_time,updated_at) VALUES (2,'1','2',?)`, [at()]),
    /CHECK|constraint/i, "a second settings row is impossible"
  );
});

// --- the rules the schema has to support ---------------------------------
test("a booking's society is reached through its listing, and is never stored on it", async () => {
  const soc = await makeSociety("Hillcrest Residency");
  const lst = await makeListing(soc, "Hillview Studio");
  const bkg = await makeBooking(lst);

  const cols = (await query(client, "SELECT * FROM bookings WHERE id = ?", [bkg]))[0];
  for (const forbidden of ["society_id", "status", "adults", "nights"]) {
    assert.equal(forbidden in cols, false, `bookings.${forbidden} must not exist — it is derived`);
  }
  const row = await one(client, `SELECT s.name AS society, s.desk_email_to AS desk
    FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN societies s ON s.id = l.society_id
    WHERE b.id = ?`, [bkg]);
  assert.equal(row.society, "Hillcrest Residency");
  assert.match(row.desk, /^desk-soc_.+@example\.com$/, "the desk address comes from the society row");
});

test("deleting a society is refused while a listing points at it", async () => {
  const soc = await makeSociety();
  await makeListing(soc);
  await assert.rejects(run(client, "DELETE FROM societies WHERE id = ?", [soc]), /constraint/i,
    "RESTRICT: a listing must never be orphaned and its guests misrouted");
});

test("deleting a booking cascades to its people and their documents", async () => {
  const bkg = await makeBooking(await makeListing(await makeSociety()));
  const per = await makePerson(bkg);
  await makeDocument(per);
  await run(client, "DELETE FROM bookings WHERE id = ?", [bkg]);
  assert.equal((await query(client, "SELECT 1 FROM people WHERE booking_id = ?", [bkg])).length, 0);
  assert.equal((await query(client, "SELECT 1 FROM documents WHERE person_id = ?", [per])).length, 0);
});

test("the schema enforces one booking code, one lead guest, one ID per adult", async () => {
  const lst = await makeListing(await makeSociety());
  await makeBooking(lst, { code: "HMDUPLICATE" });
  await assert.rejects(makeBooking(lst, { code: "HMDUPLICATE" }), /UNIQUE|constraint/i);

  const bkg = await makeBooking(lst);
  await makePerson(bkg, { lead: 1 });
  await assert.rejects(makePerson(bkg, { name: "Second lead", lead: 1 }), /UNIQUE|constraint/i);
  await makePerson(bkg, { name: "Rohit", lead: 0 });   // non-leads are unrestricted

  const per = await makePerson(await makeBooking(lst));
  await makeDocument(per);
  await assert.rejects(makeDocument(per, "Passport"), /UNIQUE|constraint/i, "one ID per adult");
});

test("check_out cannot precede check_in", async () => {
  const lst = await makeListing(await makeSociety());
  await assert.rejects(makeBooking(lst, { checkIn: "2026-09-23", checkOut: "2026-09-20" }), /CHECK|constraint/i);
  await makeBooking(lst, { checkIn: "2026-09-20", checkOut: "2026-09-20" });   // same-day is allowed
});

test("automation and uploaded_by only accept known values", async () => {
  const lst = await makeListing(await makeSociety());
  await assert.rejects(makeBooking(lst, { automation: "whenever" }), /CHECK|constraint/i);
  const per = await makePerson(await makeBooking(lst));
  await assert.rejects(
    run(client, `INSERT INTO documents (id,person_id,doc_type,uploaded_at,uploaded_by,created_at)
      VALUES (?,?,?,?,?,?)`, [newId("doc"), per, "Aadhaar", at(), "stranger", at()]),
    /CHECK|constraint/i
  );
});

// --- at-most-once send ----------------------------------------------------
test("the database itself prevents a second automated send", async () => {
  const bkg = await makeBooking(await makeListing(await makeSociety()));
  const job = () => run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,created_at) VALUES (?,?,?,?,?)`,
    [newId("job"), "send_booking", bkg, at(), at()]);
  await job();
  await assert.rejects(job(), /UNIQUE|constraint/i, "a double-send emails a passport twice");

  // Completing it does not open the door to another.
  await run(client, "UPDATE jobs SET completed_at = ? WHERE subject_id = ? AND kind = 'send_booking'", [at(), bkg]);
  await assert.rejects(job(), /UNIQUE|constraint/i, "send-once is forever, not just while pending");
});

test("repeated ticks cannot pile up duplicate pending work", async () => {
  const lst = await makeListing(await makeSociety());
  const sync = () => run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,created_at) VALUES (?,?,?,?,?)`,
    [newId("job"), "sync_listing", lst, at(), at()]);
  await sync();
  await assert.rejects(sync(), /UNIQUE|constraint/i);
  // Once finished, the next tick may queue another.
  await run(client, "UPDATE jobs SET completed_at = ? WHERE kind='sync_listing' AND subject_id = ?", [at(), lst]);
  await sync();
});

test("a send marks the booking and completes its job atomically, or not at all", async () => {
  const bkg = await makeBooking(await makeListing(await makeSociety()));
  const jobId = newId("job");
  await run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,created_at) VALUES (?,?,?,?,?)`,
    [jobId, "send_booking", bkg, at(), at()]);

  await assert.rejects(transaction(db.client, async (tx) => {
    await tx.execute({ sql: "UPDATE bookings SET sent_at = ? WHERE id = ?", args: [at(), bkg] });
    throw new Error("mail provider refused");
  }), /mail provider refused/);

  const after = await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [bkg]);
  assert.equal(after.sent_at, null, "a failed send must not leave the booking looking sent");
});

// --- the payoff: rows out of SQL, fed to the shared rules ----------------
test("a row read back from SQL produces the right status from shared/rules.js", async () => {
  const soc = await makeSociety();
  const lst = await makeListing(soc, "Sea Breeze 2BHK");
  const bkg = await makeBooking(lst, { checkIn: "2026-09-20", checkOut: "2026-09-23", children: 1 });
  const lead = await makePerson(bkg, { name: "Lead guest", lead: 1 });
  await makePerson(bkg, { name: "Adult 2", lead: 0 });

  /** Shape a booking exactly as the API will, then hand it to the shared rules. */
  async function load(id) {
    const b = await one(client, `SELECT b.*, l.name AS listing_name FROM bookings b
      JOIN listings l ON l.id = b.listing_id WHERE b.id = ?`, [id]);
    const people = await query(client, `SELECT p.id, p.is_lead, d.doc_type FROM people p
      LEFT JOIN documents d ON d.person_id = p.id WHERE p.booking_id = ? ORDER BY p.is_lead DESC, p.created_at`, [id]);
    return {
      code: b.airbnb_code, listingName: b.listing_name, leadGuest: b.lead_guest,
      checkIn: b.check_in, checkOut: b.check_out, children: b.children,
      conflict: Boolean(b.conflict), sentAt: b.sent_at, automation: b.automation,
      people: people.map((p) => ({ lead: Boolean(p.is_lead), documentType: p.doc_type })),
    };
  }
  const times = await one(client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
  const s = { checkInTime: times.check_in_time, checkOutTime: times.check_out_time };

  let b = await load(bkg);
  assert.equal(Derive.adults(b), 2, "derived from the people rows, not a column");
  assert.equal(Derive.nights(b), 3, "derived from the dates");
  assert.equal(Derive.status(b), "awaiting");
  assert.equal(Derive.title(b), "Sea Breeze 2BHK", "titled by the listing; the feed gives no name");
  assert.equal(Derive.leadGuestKnown(b), false);
  assert.equal(Derive.sendDue(b, s, Date.now()), false);

  await makeDocument(lead, "Aadhaar");
  assert.equal(Derive.status(await load(bkg)), "awaiting", "one of two IDs in");

  const second = (await query(client, "SELECT id FROM people WHERE booking_id = ? AND is_lead = 0", [bkg]))[0].id;
  await makeDocument(second, "Passport");
  b = await load(bkg);
  assert.equal(Derive.status(b), "ready");
  assert.equal(Derive.sendDue(b, s, Date.now()), true, "automation 'allids' fires on completion");

  // Check-out is 11:00 the day it says, and every window hangs off that.
  assert.equal(Derive.checkOutAt(b, s).getHours(), 11);
  assert.equal(Derive.idFilesDeletedAt(b, s) - Derive.checkOutAt(b, s).getTime(), RULES.deleteIdFilesAfterCheckoutHours * 3600e3);
});

test("deleting the ID files keeps the booking sent, and only blocks a resend", async () => {
  const lst = await makeListing(await makeSociety());
  const bkg = await makeBooking(lst);
  const per = await makePerson(bkg);
  const doc = await makeDocument(per);
  await run(client, "UPDATE bookings SET sent_at = ? WHERE id = ?", [at(), bkg]);

  // Retention deletes the BYTES and nulls the reference. The row survives as
  // proof the ID was collected and sent.
  await run(client, "UPDATE documents SET file_ref = NULL, deleted_at = ? WHERE id = ?", [at(), doc]);

  const row = await one(client, `SELECT d.doc_type, d.file_ref, d.deleted_at, b.sent_at FROM documents d
    JOIN people p ON p.id = d.person_id JOIN bookings b ON b.id = p.booking_id WHERE d.id = ?`, [doc]);
  assert.equal(row.doc_type, "Aadhaar", "we still know what was sent");
  assert.equal(row.file_ref, null, "the bytes are gone");
  assert.ok(row.deleted_at);

  const b = { conflict: false, sentAt: row.sent_at, checkIn: "2026-09-20", checkOut: "2026-09-23",
              people: [{ lead: true, documentType: row.doc_type }] };
  assert.equal(Derive.status(b), "sent", "it must not fall back to 'awaiting' once the files go");
  assert.equal(Derive.complete(b), true);
});

// Every one of these runs on a real request, so each gets a plan assertion.
// A missing index does not fail a test by being slow at this data volume — it
// fails years later in production. EXPLAIN catches it today.
test("every hot query uses an index and never sorts in memory", async () => {
  const lst = await makeListing(await makeSociety());
  await makeBooking(lst, { checkIn: "2026-09-25", checkOut: "2026-09-29" });
  await makeBooking(lst, { checkIn: "2026-09-20", checkOut: "2026-09-23" });

  const plan = async (sql, args) =>
    (await query(client, "EXPLAIN QUERY PLAN " + sql, args)).map((r) => r.detail).join(" | ");

  const cases = [
    ["list, all listings",
     `SELECT b.id FROM bookings b WHERE b.check_out >= ? ORDER BY b.check_in, b.id LIMIT 25`,
     ["2026-09-01"]],
    ["list, filtered by listing",
     `SELECT b.id FROM bookings b WHERE b.check_out >= ? AND b.listing_id = ? ORDER BY b.check_in, b.id LIMIT 25`,
     ["2026-09-01", lst]],
    ["list, keyset page 2",
     `SELECT b.id FROM bookings b WHERE b.check_out >= ? AND (b.check_in, b.id) > (?, ?) ORDER BY b.check_in, b.id LIMIT 25`,
     ["2026-09-01", "2026-09-20", "bkg_x"]],
    ["booking by Airbnb code (the sync upsert)",
     `SELECT id FROM bookings WHERE airbnb_code = ?`, ["HMABCD1234"]],
    ["guest link by token",
     `SELECT booking_id FROM guest_links WHERE token = ?`, ["tok"]],
    ["people of a booking",
     `SELECT id FROM people WHERE booking_id = ?`, ["bkg_x"]],
    ["due jobs (every tick)",
     `SELECT id FROM jobs WHERE run_after <= ? AND claimed_at IS NULL AND completed_at IS NULL ORDER BY run_after LIMIT 10`,
     ["2026-09-19T00:00:00Z"]],
    ["booking timeline",
     `SELECT text FROM activity WHERE booking_id = ? ORDER BY at DESC LIMIT 50`, ["bkg_x"]],
  ];

  for (const [label, sql, args] of cases) {
    const text = await plan(sql, args);
    assert.match(text, /USING (COVERING )?INDEX/, `${label}: no index — ${text}`);
    assert.doesNotMatch(text, /TEMP B-TREE/, `${label}: sorts in memory — ${text}`);
  }

  const rows = await query(client,
    `SELECT b.check_in FROM bookings b WHERE b.check_out >= ? AND b.listing_id = ? ORDER BY b.check_in, b.id LIMIT 25`,
    ["2026-09-01", lst]);
  assert.deepEqual(rows.map((r) => r.check_in), [...rows.map((r) => r.check_in)].sort(), "chronological");
});

test("every migration file on disk is applied, in order", async () => {
  // Read the directory rather than hardcode a list, so adding a migration does
  // not break this test but forgetting to apply one does.
  const { readdir } = await import("node:fs/promises");
  const migDir = join(import.meta.dirname, "..", "migrations");
  const onDisk = (await readdir(migDir)).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
  const applied = (await query(client, "SELECT version FROM _migrations ORDER BY version")).map((r) => r.version);
  assert.deepEqual(applied, onDisk);
  assert.ok(onDisk.length >= 3, `expected at least 3 migrations, found ${onDisk.length}`);
});

test("a send pins its recipient, so a resend cannot follow a later edit", async () => {
  const socA = await makeSociety("Greenwood Society");
  const socB = await makeSociety("Hillcrest Residency");
  const lst = await makeListing(socA);
  const bkg = await makeBooking(lst);

  // The columns exist and start empty (migration 003).
  const before = await one(client, "SELECT sent_to, sent_cc, sent_society_id FROM bookings WHERE id = ?", [bkg]);
  assert.equal(before.sent_to, null);

  // Sending resolves through the listing ONCE, then records the address.
  const desk = await one(client, `SELECT s.id AS sid, s.desk_email_to AS to_addr, s.desk_email_cc AS cc
    FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN societies s ON s.id = l.society_id
    WHERE b.id = ?`, [bkg]);
  await run(client, "UPDATE bookings SET sent_at = ?, sent_to = ?, sent_cc = ?, sent_society_id = ? WHERE id = ?",
    [at(), desk.to_addr, desk.cc, desk.sid, bkg]);

  // The admin later moves the listing to a different society.
  await run(client, "UPDATE listings SET society_id = ? WHERE id = ?", [socB, lst]);

  const after = await one(client, `SELECT b.sent_to, b.sent_society_id, s.desk_email_to AS live_to
    FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN societies s ON s.id = l.society_id
    WHERE b.id = ?`, [bkg]);
  assert.equal(after.sent_to, desk.to_addr, "a resend goes to the address the first send used");
  assert.equal(after.sent_society_id, socA);
  assert.notEqual(after.live_to, after.sent_to, "the live resolution has moved, and is correctly ignored");
});

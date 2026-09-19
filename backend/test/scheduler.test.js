// The automatic send. The at-most-once guarantee is the point: emailing a
// passport twice is worse than emailing it late.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { newId, nowIso, run, one, query } from "../src/db/client.js";
import { recordingTransport } from "../src/mail/transport.js";
import { localStore } from "../src/files/store.js";
import { encrypt, loadKey } from "../src/files/crypto.js";
import { findDueBookings, runDueSends } from "../src/jobs/send.js";
import { Derive, addDays, toDay } from "../../shared/rules.js";

const KEY = randomBytes(32).toString("base64");
const today = () => toDay(new Date());
let dir, uploads, app, client, soc, lst;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-sched-"));
  uploads = join(dir, "uploads");
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`, FILE_ENCRYPTION_KEY: KEY, UPLOAD_DIR: uploads,
    JOBS_TICK_SECRET: "tick-secret", MAIL_FROM: "host@example.com",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  client = app.db.client;
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const t of ["jobs", "documents", "people", "activity", "bookings", "listings", "societies"]) await run(client, `DELETE FROM ${t}`);
  soc = newId("soc"); lst = newId("lst");
  await run(client, `INSERT INTO societies (id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [soc, "Greenwood", "desk@greenwood.example", "IDs for {{listing}}", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [lst, "Sea Breeze", "https://airbnb.com/c.ics", soc, nowIso(), nowIso()]);
  app.mail = recordingTransport();
});

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(120), Buffer.from([0xff, 0xd9])]);

async function booking({ automation = "allids", checkIn = addDays(today(), 3), adults = 1, withIds = 0, conflict = 0 } = {}) {
  const id = newId("bkg");
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,conflict,created_at,updated_at)
    VALUES (?,?,?,?,?,0,?,?,?,?)`,
    [id, newId("HM").toUpperCase(), lst, checkIn, addDays(checkIn, 2), automation, conflict, nowIso(), nowIso()]);
  for (let i = 0; i < adults; i++) {
    const per = newId("per");
    await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,?,?)`,
      [per, id, i === 0 ? "Priya Menon" : `Adult ${i + 1}`, i === 0 ? 1 : 0, nowIso()]);
    if (i < withIds) {
      const ref = `t/${randomBytes(8).toString("hex")}`;
      await localStore({ dir: uploads }).put(ref, encrypt(jpeg(), loadKey(KEY)));
      await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,content_type,uploaded_at,uploaded_by,created_at)
        VALUES (?,?,?,?,?,?,'guest',?)`, [newId("doc"), per, "Aadhaar", ref, "image/jpeg", nowIso(), nowIso()]);
    }
  }
  return id;
}
const deps = () => ({ transport: app.mail, mailFrom: "host@example.com", files: app.files, fileKey: app.fileKey, maxAttachmentBytes: 10e6 });
const jobs = () => query(client, "SELECT kind, subject_id, attempts, completed_at, last_error FROM jobs");

// --- the two triggers -----------------------------------------------------
test("'when all IDs are collected' fires as soon as the last ID is in", async () => {
  const incomplete = await booking({ automation: "allids", adults: 2, withIds: 1 });
  assert.equal((await findDueBookings(client)).length, 0, "not while an adult is missing an ID");

  const complete = await booking({ automation: "allids", adults: 2, withIds: 2 });
  const due = await findDueBookings(client);
  assert.deepEqual(due.map((b) => b.id), [complete]);

  const res = await runDueSends(client, deps());
  assert.equal(res.filter((r) => r.sent).length, 1);
  assert.equal(app.mail.sent.length, 1);
  assert.ok((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [complete])).sent_at);
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [incomplete])).sent_at, null);
});

test("'1 hour before check-in' fires on the clock, even with IDs missing", async () => {
  const b = await booking({ automation: "before", adults: 2, withIds: 1, checkIn: addDays(today(), 1) });
  const settings = { checkInTime: "14:00", checkOutTime: "11:00" };
  const loaded = await (await import("../src/repo/bookingWrites.js")).loadForRules(client, b);
  const fireAt = Derive.scheduledSendAt(loaded, settings);

  assert.equal((await findDueBookings(client, { now: fireAt - 1000 })).length, 0, "not a second early");
  assert.deepEqual((await findDueBookings(client, { now: fireAt })).map((x) => x.id), [b], "on the hour");

  const res = await runDueSends(client, deps(), { now: fireAt });
  assert.equal(res[0].sent, true, "it goes with one ID missing — that is what this mode is for");
  assert.equal(app.mail.sent[0].attachments.length, 1);
});

test("a conflicted booking is never sent automatically", async () => {
  await booking({ automation: "allids", adults: 1, withIds: 1, conflict: 1 });
  assert.equal((await findDueBookings(client)).length, 0);
  assert.equal((await runDueSends(client, deps())).length, 0);
});

// --- at-most-once ---------------------------------------------------------
test("a second tick does not send the same booking twice", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  await runDueSends(client, deps());
  assert.equal(app.mail.sent.length, 1);

  await runDueSends(client, deps());
  await runDueSends(client, deps());
  assert.equal(app.mail.sent.length, 1, "emailing a passport twice is worse than emailing it late");
  assert.equal((await jobs()).filter((j) => j.subject_id === b).length, 1);
});

test("the database refuses a second send job even if the code tries", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  await run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,created_at) VALUES (?,'send_booking',?,?,?)`,
    [newId("job"), b, nowIso(), nowIso()]);
  await assert.rejects(
    run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,created_at) VALUES (?,'send_booking',?,?,?)`,
      [newId("job"), b, nowIso(), nowIso()]),
    /UNIQUE|constraint/i);
});

// --- failure ---------------------------------------------------------------
test("a failed send retries next tick, and says why on the booking", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  let attempts = 0;
  app.mail = { name: "flaky", configured: true, async send() { attempts++; throw Object.assign(new Error("connection reset"), { code: "smtp_failed" }); } };

  await runDueSends(client, deps());
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [b])).sent_at, null);
  const job = (await jobs())[0];
  assert.equal(job.completed_at, null, "left open so the next tick retries");
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /smtp_failed/);

  // The host is told, rather than just never seeing it send.
  const note = await one(client, "SELECT text FROM activity WHERE booking_id = ? AND kind = 'send_failed'", [b]);
  assert.match(note.text, /did not go out/);

  await runDueSends(client, deps());
  assert.equal(attempts, 2, "it tried again");
  assert.equal((await jobs())[0].attempts, 2);
});

test("it stops retrying after five attempts rather than hammering for ever", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  app.mail = { name: "broken", configured: true, async send() { throw Object.assign(new Error("nope"), { code: "smtp_failed" }); } };
  for (let i = 0; i < 8; i++) await runDueSends(client, deps());
  const job = (await jobs())[0];
  assert.equal(job.attempts, 5, "capped");
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [b])).sent_at, null,
    "and it stays visibly unsent rather than silently given up on");
});

test("a booking whose ID file has vanished is not marked sent", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  const doc = await one(client, `SELECT d.file_ref FROM documents d JOIN people p ON p.id = d.person_id WHERE p.booking_id = ?`, [b]);
  await localStore({ dir: uploads }).remove(doc.file_ref);

  await runDueSends(client, deps());
  assert.equal(app.mail.sent.length, 0);
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [b])).sent_at, null);
  assert.match((await jobs())[0].last_error, /file_missing/);
});

// --- through the tick -----------------------------------------------------
test("the tick syncs and sends in one call", async () => {
  await booking({ adults: 1, withIds: 1 });
  const res = await app.inject({ method: "POST", url: "/api/jobs/tick", headers: { "x-jobs-secret": "tick-secret" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sent, 1);
  assert.equal(app.mail.sent.length, 1);
});

test("a manual send stops the automation from sending again", async () => {
  const b = await booking({ adults: 1, withIds: 1 });
  await run(client, "UPDATE bookings SET sent_at = ? WHERE id = ?", [nowIso(), b]);
  assert.equal((await findDueBookings(client)).length, 0, "sendDue is false once sent_at is set");
  await runDueSends(client, deps());
  assert.equal(app.mail.sent.length, 0);
});

test("a scheduled send with IDs missing tells the desk who is still awaited", async () => {
  const b = await booking({ automation: "before", adults: 3, withIds: 1, checkIn: addDays(today(), 1) });
  const loaded = await (await import("../src/repo/bookingWrites.js")).loadForRules(client, b);
  const fireAt = Derive.scheduledSendAt(loaded, { checkInTime: "14:00", checkOutTime: "11:00" });

  await runDueSends(client, deps(), { now: fireAt });
  assert.equal(app.mail.sent.length, 1);
  const body = app.mail.sent[0].body;
  assert.match(body, /Still awaiting an ID for: Adult 2, Adult 3/,
    "a short attachment count must not read as a mistake — the desk needs to know who to stop");
  assert.match(body, /contact the host/);
  assert.equal(app.mail.sent[0].attachments.length, 1);
});

test("a scheduled send with NO IDs at all does not go", async () => {
  const b = await booking({ automation: "before", adults: 2, withIds: 0, checkIn: addDays(today(), 1) });
  const loaded = await (await import("../src/repo/bookingWrites.js")).loadForRules(client, b);
  const fireAt = Derive.scheduledSendAt(loaded, { checkInTime: "14:00", checkOutTime: "11:00" });

  await runDueSends(client, deps(), { now: fireAt });
  assert.equal(app.mail.sent.length, 0, "an email with no IDs is not worth sending");
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [b])).sent_at, null);
  assert.match((await one(client, "SELECT text FROM activity WHERE booking_id = ? AND kind = 'send_failed'", [b])).text,
    /nothing to send/i);
});

test("a manual send is still locked until every ID is in", async () => {
  const b = await booking({ automation: "before", adults: 2, withIds: 1 });
  const { sendBooking } = await import("../src/repo/bookingWrites.js");
  const res = await sendBooking(client, b, app.mail, { ...deps(), actor: "admin" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "incomplete", "only the scheduler may send an incomplete booking");
});

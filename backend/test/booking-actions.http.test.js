// Changing a booking. The send tests matter most: a booking that reads "Sent"
// with nothing delivered is the failure this product exists to prevent.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run, one, query } from "../src/db/client.js";
import { recordingTransport } from "../src/mail/transport.js";
import { randomBytes } from "node:crypto";
import { Derive, addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, auth, client;
const today = () => toDay(new Date());

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-act-"));
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
    MAIL_FROM: "host@example.com",
    FILE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    UPLOAD_DIR: join(dir, "uploads"),
  }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  auth = { cookie: session.cookie };
  client = app.db.client;
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const req = (method, url, payload) => app.inject({ method, url, payload, headers: auth });
const activity = (id) => query(client, "SELECT kind, actor, text FROM activity WHERE booking_id = ? ORDER BY at DESC, rowid DESC", [id]);

// A real JPEG, uploaded through the real route. Sending refuses a document row
// with no bytes behind it, so these tests must put actual files in.
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(200), Buffer.from([0xff, 0xd9])]);
async function uploadFor(personId, docType = "Aadhaar") {
  const b = "----t" + randomBytes(8).toString("hex");
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="docType"\r\n\r\n${docType}\r\n` +
                `--${b}\r\nContent-Disposition: form-data; name="file"; filename="id.jpg"\r\n\r\n`),
    jpeg(), Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: "POST", url: `/api/bookings/${bkg}/people/${personId}/upload`,
    payload, headers: { "content-type": `multipart/form-data; boundary=${b}`, ...auth } });
}

let soc, lst, bkg, lead;
beforeEach(async () => {
  for (const t of ["documents", "people", "activity", "bookings", "listings", "societies"]) await run(client, `DELETE FROM ${t}`);
  soc = newId("soc"); lst = newId("lst"); bkg = newId("bkg"); lead = newId("per");
  await run(client, `INSERT INTO societies (id,account_id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [soc, acc, "Greenwood Society", "desk@greenwood.example", "cc@greenwood.example",
    "Dear team, {{listing}} {{booking_id}} {{adult_count}} adults", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [lst, acc, "Sea Breeze 2BHK", "https://airbnb.com/c.ics", soc, nowIso(), nowIso()]);
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [bkg, "HMABCD1234", lst, addDays(today(), 2), addDays(today(), 5), 1, "allids", nowIso(), nowIso()]);
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`,
    [lead, bkg, "Lead guest", nowIso()]);
  app.mail = recordingTransport();
});

const peopleOf = () => query(client, "SELECT id, name, is_lead FROM people WHERE booking_id = ? ORDER BY is_lead DESC, created_at, id", [bkg]);

// --- adult count ----------------------------------------------------------
test("the adult count can be raised and lowered, and is logged", async () => {
  const up = await req("POST", `/api/bookings/${bkg}/people`, { adults: 3 });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().adults, 3);
  assert.equal((await peopleOf()).length, 3);
  assert.equal((await activity(bkg))[0].kind, "party");

  const down = await req("POST", `/api/bookings/${bkg}/people`, { adults: 1 });
  assert.equal(down.json().adults, 1);
  assert.equal(down.json().blocked, false);
});

test("an adult whose ID is already in cannot be removed, and the caller is told", async () => {
  await req("POST", `/api/bookings/${bkg}/people`, { adults: 3 });
  const [, second] = await peopleOf();
  await req("PUT", `/api/bookings/${bkg}/people/${second.id}/document`, { docType: "Aadhaar" });

  const res = await req("POST", `/api/bookings/${bkg}/people`, { adults: 1 });
  assert.equal(res.json().adults, 2, "the lead and the one with an ID survive");
  assert.equal(res.json().blocked, true, "and the caller is told, rather than it silently half-working");
});

test("the count is validated at the edge", async () => {
  for (const bad of [{ adults: 0 }, { adults: 31 }, { adults: "3" }, { adults: 2.5 }, {}, { adults: 2, extra: 1 }]) {
    assert.equal((await req("POST", `/api/bookings/${bkg}/people`, bad)).statusCode, 400, JSON.stringify(bad));
  }
});

// --- naming ---------------------------------------------------------------
test("naming the lead guest sets the booking's identifying name", async () => {
  const res = await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "  Priya   Menon " });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().changed, true);

  const row = await one(client, "SELECT lead_guest FROM bookings WHERE id = ?", [bkg]);
  assert.equal(row.lead_guest, "Priya Menon", "whitespace collapsed, and mirrored onto the booking");
  assert.equal((await activity(bkg))[0].text, "Priya Menon named");

  // Putting it back to a placeholder clears the booking's name again.
  await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "Adult 1" });
  assert.equal((await one(client, "SELECT lead_guest FROM bookings WHERE id = ?", [bkg])).lead_guest, null);
});

test("renames are validated and idempotent", async () => {
  assert.equal((await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "   " })).statusCode, 400);
  assert.equal((await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "x".repeat(121) })).statusCode, 400);
  assert.equal((await req("PATCH", `/api/bookings/${bkg}/people/per_nope`, { name: "X" })).statusCode, 404);

  await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "Priya Menon" });
  const again = await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "Priya Menon" });
  assert.equal(again.json().changed, false, "a no-op rename must not write an activity row");
  assert.equal((await activity(bkg)).filter((a) => a.kind === "rename").length, 1);
});

// --- documents ------------------------------------------------------------
test("a document is added, then replaced in place rather than duplicated", async () => {
  const added = await req("PUT", `/api/bookings/${bkg}/people/${lead}/document`, { docType: "Aadhaar" });
  assert.equal(added.json().replaced, false);

  const replaced = await req("PUT", `/api/bookings/${bkg}/people/${lead}/document`, { docType: "Passport" });
  assert.equal(replaced.json().replaced, true);

  const docs = await query(client, "SELECT doc_type FROM documents WHERE person_id = ?", [lead]);
  assert.equal(docs.length, 1, "one ID per adult — a replacement is an update");
  assert.equal(docs[0].doc_type, "Passport");
  assert.match((await activity(bkg))[0].text, /replaced Aadhaar with Passport/);
});

test("a document can be removed, and removing an absent one is refused", async () => {
  assert.equal((await req("DELETE", `/api/bookings/${bkg}/people/${lead}/document`)).statusCode, 404);
  await req("PUT", `/api/bookings/${bkg}/people/${lead}/document`, { docType: "Aadhaar" });
  assert.equal((await req("DELETE", `/api/bookings/${bkg}/people/${lead}/document`)).statusCode, 200);
  assert.equal((await query(client, "SELECT 1 FROM documents WHERE person_id = ?", [lead])).length, 0);
});

// --- the retention window is enforced on the SERVER -----------------------
test("every mutation is refused once the booking is past its window", async () => {
  // Checked out three days ago: well past checkout + 24h.
  await run(client, "UPDATE bookings SET check_in = ?, check_out = ? WHERE id = ?",
    [addDays(today(), -6), addDays(today(), -3), bkg]);

  const calls = [
    ["POST", `/api/bookings/${bkg}/people`, { adults: 2 }],
    ["PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "Priya Menon" }],
    ["PUT", `/api/bookings/${bkg}/people/${lead}/document`, { docType: "Aadhaar" }],
    ["DELETE", `/api/bookings/${bkg}/people/${lead}/document`, undefined],
  ];
  for (const [method, url, payload] of calls) {
    const res = await req(method, url, payload);
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    assert.equal(res.json().error, "window_closed");
    assert.match(res.json().message, /past its window/);
  }
});

// --- automation -----------------------------------------------------------
test("automation can be switched between the two modes only", async () => {
  const res = await req("PATCH", `/api/bookings/${bkg}/automation`, { automation: "before" });
  assert.equal(res.json().changed, true);
  assert.equal((await one(client, "SELECT automation FROM bookings WHERE id = ?", [bkg])).automation, "before");
  assert.match((await activity(bkg))[0].text, /1 hour before check-in/);

  assert.equal((await req("PATCH", `/api/bookings/${bkg}/automation`, { automation: "whenever" })).statusCode, 400);
  assert.equal((await req("PATCH", `/api/bookings/${bkg}/automation`, { automation: "before" })).json().changed, false);
});

// --- sending: the part that must never lie --------------------------------
test("sending is REFUSED, not faked, when no mail transport is configured", async () => {
  await uploadFor(lead);
  app.mail = (await import("../src/mail/transport.js")).unconfiguredTransport();

  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "mail_not_configured");

  const row = await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [bkg]);
  assert.equal(row.sent_at, null, "a booking must NEVER read as sent when nothing left");
  assert.equal((await activity(bkg)).filter((a) => a.kind === "send").length, 0, "and nothing is logged as sent");
});

test("a transport failure leaves the booking exactly as it was", async () => {
  await uploadFor(lead);
  app.mail = { name: "broken", configured: true, async send() { const e = new Error("connection reset"); e.code = "smtp_failed"; throw e; } };

  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.statusCode, 400);
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [bkg])).sent_at, null);
});

test("sending is refused while any adult still has no ID", async () => {
  await req("POST", `/api/bookings/${bkg}/people`, { adults: 2 });
  await uploadFor(lead);
  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "incomplete");
});

test("sending is refused while the booking has a sync conflict", async () => {
  await uploadFor(lead);
  await run(client, "UPDATE bookings SET conflict = 1 WHERE id = ?", [bkg]);
  assert.equal((await req("POST", `/api/bookings/${bkg}/send`)).json().error, "conflict");
});

test("a successful send pins the recipient and composes from the society's template", async () => {
  await req("PATCH", `/api/bookings/${bkg}/people/${lead}`, { name: "Priya Menon" });
  await uploadFor(lead);

  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().resend, false);
  assert.equal(res.json().attachments, 1);

  const [message] = app.mail.sent;
  assert.equal(message.to, "desk@greenwood.example");
  assert.equal(message.cc, "cc@greenwood.example");
  assert.equal(message.from, "host@example.com");
  assert.match(message.subject, /Sea Breeze 2BHK/);
  assert.equal(message.body, "Dear team, Sea Breeze 2BHK HMABCD1234 1 adults", "filled from the society's template");
  assert.equal(message.attachments[0].filename, "Priya_Menon_Aadhaar.jpg", "a desk can match this to a person");
  assert.ok(Buffer.isBuffer(message.attachments[0].content), "the real decrypted bytes are attached");

  const row = await one(client, "SELECT sent_at, sent_to, sent_cc, sent_society_id FROM bookings WHERE id = ?", [bkg]);
  assert.ok(row.sent_at);
  assert.equal(row.sent_to, "desk@greenwood.example");
  assert.equal(row.sent_society_id, soc);
  assert.match((await activity(bkg))[0].text, /^Email sent to desk@greenwood\.example with 1 ID file\(s\)$/);
});

test("a resend goes to the same address even after the listing moves society", async () => {
  await uploadFor(lead);
  await req("POST", `/api/bookings/${bkg}/send`);

  // The admin moves the listing to a different society.
  const other = newId("soc");
  await run(client, `INSERT INTO societies (id,account_id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [other, acc, "Hillcrest", "gate@hillcrest.example", "", "Hello", nowIso(), nowIso()]);
  await run(client, "UPDATE listings SET society_id = ? WHERE id = ?", [other, lst]);

  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.json().resend, true);
  assert.equal(app.mail.sent[1].to, "desk@greenwood.example", "a resend is the same mail to the same desk");
  assert.match((await activity(bkg))[0].text, /^Resent to desk@greenwood\.example with 1 ID file\(s\)$/);
});

test("a resend is refused once the ID files have been deleted", async () => {
  await uploadFor(lead);
  await req("POST", `/api/bookings/${bkg}/send`);
  // Past the retention moment the files are gone, so there is nothing to attach.
  await run(client, "UPDATE bookings SET check_in = ?, check_out = ? WHERE id = ?",
    [addDays(today(), -6), addDays(today(), -3), bkg]);
  const res = await req("POST", `/api/bookings/${bkg}/send`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "files_deleted");
});

test("every action is admin-only", async () => {
  const calls = [
    ["POST", `/api/bookings/${bkg}/people`], ["PATCH", `/api/bookings/${bkg}/people/${lead}`],
    ["PUT", `/api/bookings/${bkg}/people/${lead}/document`], ["DELETE", `/api/bookings/${bkg}/people/${lead}/document`],
    ["PATCH", `/api/bookings/${bkg}/automation`], ["POST", `/api/bookings/${bkg}/send`],
  ];
  for (const [method, url] of calls) {
    assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 401, `${method} ${url}`);
  }
});

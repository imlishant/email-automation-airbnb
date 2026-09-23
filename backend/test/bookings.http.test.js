// Reading bookings over HTTP. The list is the one hot read in the system.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run } from "../src/db/client.js";
import { Derive, addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, auth, client;
const today = () => toDay(new Date());

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-bk-"));
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  auth = { cookie: session.cookie };
  client = app.db.client;
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const get = (url, headers) => app.inject({ method: "GET", url, headers: { ...auth, ...headers } });

let soc, lst;
beforeEach(async () => {
  for (const t of ["documents", "people", "activity", "bookings", "listings", "societies"]) {
    await run(client, `DELETE FROM ${t}`);
  }
  soc = newId("soc"); lst = newId("lst");
  await run(client, `INSERT INTO societies (id,account_id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [soc, acc, "Greenwood Society", "desk@greenwood.example", "cc@greenwood.example", "Dear {{listing}}", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [lst, acc, "Sea Breeze 2BHK", "https://airbnb.com/c.ics", soc, nowIso(), nowIso()]);
});

async function booking(over = {}) {
  const id = newId("bkg");
  const b = { code: newId("HM").toUpperCase(), checkIn: addDays(today(), 3), checkOut: addDays(today(), 6),
              conflict: 0, sentAt: null, automation: "allids", lead: "Lead guest", ...over };
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,conflict,sent_at,lead_guest,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.code, b.listingId || lst, b.checkIn, b.checkOut, 0, b.automation, b.conflict, b.sentAt, b.leadGuest || null, nowIso(), nowIso()]);
  const per = newId("per");
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`,
    [per, id, b.lead, nowIso()]);
  if (b.withDocument) {
    await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,uploaded_at,uploaded_by,created_at)
      VALUES (?,?,?,?,?,?,?)`, [newId("doc"), per, "Aadhaar", b.fileRef === null ? null : "r2/x", nowIso(), "guest", nowIso()]);
  }
  return { id, personId: per };
}

// --- shape ----------------------------------------------------------------
test("the list is admin-only", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/bookings" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/bookings/x" })).statusCode, 401);
});

test("the API returns facts, never a computed status", async () => {
  await booking();
  const row = (await get("/api/bookings")).json().rows[0];
  for (const derived of ["status", "adults", "nights", "needsAttention"]) {
    assert.equal(derived in row, false, `${derived} must be derived by the client, not sent`);
  }
  // Everything the shared rules need to derive it, though, is present.
  for (const fact of ["checkIn", "checkOut", "conflict", "sentAt", "automation", "people", "listingName"]) {
    assert.ok(fact in row, `missing fact: ${fact}`);
  }
});

test("the client can derive the same status the server would", async () => {
  await booking();                                   // one adult, no ID
  await booking({ withDocument: true, code: "HMREADY01" });
  const body = (await get("/api/bookings")).json();
  const times = body.times;
  const byCode = (c) => body.rows.find((r) => r.code === c);

  assert.equal(Derive.status(body.rows.find((r) => !r.people[0].documentType)), "awaiting");
  assert.equal(Derive.status(byCode("HMREADY01")), "ready");
  assert.equal(Derive.adults(byCode("HMREADY01")), 1, "derived from the people array");
  assert.equal(Derive.nights(byCode("HMREADY01")), 3, "derived from the dates");
  assert.ok(Derive.guestLinkExpiresAt(byCode("HMREADY01"), times) > Date.now());
});

// --- retention ------------------------------------------------------------
test("the list is bounded by retention, using the host's check-out time", async () => {
  await booking({ code: "HMFUTURE1" });
  // Checked out two days ago: past the window however you count it.
  await booking({ code: "HMGONE001", checkIn: addDays(today(), -5), checkOut: addDays(today(), -2) });
  // Checked out today: still inside checkout + 24h.
  await booking({ code: "HMEDGE001", checkIn: addDays(today(), -3), checkOut: today() });

  const codes = (await get("/api/bookings")).json().rows.map((r) => r.code);
  assert.ok(codes.includes("HMFUTURE1"));
  assert.ok(codes.includes("HMEDGE001"), "checkout + 24h has not passed yet");
  assert.ok(!codes.includes("HMGONE001"), "past the retention moment");
});

// --- ordering and counts --------------------------------------------------
test("attention first, then chronological, with counts for both groups", async () => {
  await booking({ code: "HMSENT001", checkIn: addDays(today(), 1), checkOut: addDays(today(), 2), withDocument: true, sentAt: nowIso() });
  await booking({ code: "HMAWAIT02", checkIn: addDays(today(), 9), checkOut: addDays(today(), 10) });
  await booking({ code: "HMCONFL03", checkIn: addDays(today(), 5), checkOut: addDays(today(), 6), conflict: 1 });

  const body = (await get("/api/bookings")).json();
  assert.deepEqual(body.rows.map((r) => r.code), ["HMCONFL03", "HMAWAIT02", "HMSENT001"],
    "attention group first, in check-in order, then the settled one");
  assert.deepEqual(body.counts, { attention: 2, settled: 1 });
});

// --- pagination -----------------------------------------------------------
test("keyset pagination pages without overlap or gaps", async () => {
  for (let i = 0; i < 7; i++) {
    await booking({ code: `HMPAGE${String(i).padStart(3, "0")}`, checkIn: addDays(today(), i + 1), checkOut: addDays(today(), i + 2) });
  }
  const p1 = (await get("/api/bookings?limit=3")).json();
  assert.equal(p1.rows.length, 3);
  assert.ok(p1.nextCursor);

  const p2 = (await get(`/api/bookings?limit=3&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
  assert.equal(p2.rows.length, 3);
  const p3 = (await get(`/api/bookings?limit=3&cursor=${encodeURIComponent(p2.nextCursor)}`)).json();
  assert.equal(p3.rows.length, 1);
  assert.equal(p3.nextCursor, null, "the last page says so");

  const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.code);
  assert.equal(new Set(seen).size, 7, "no row appears twice and none is skipped");
  assert.equal(p1.counts.attention, 7, "counts describe the whole set, not the page");

  // A junk cursor must not 500 or silently return page one's duplicate.
  assert.equal((await get("/api/bookings?cursor=not-a-cursor")).statusCode, 200);
});

test("the listing filter narrows the list", async () => {
  const other = newId("lst");
  await run(client, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [other, acc, "Hillview Studio", "https://airbnb.com/d.ics", soc, nowIso(), nowIso()]);
  await booking({ code: "HMHERE001" });
  await booking({ code: "HMTHERE01", listingId: other });

  const filtered = (await get(`/api/bookings?listingId=${other}`)).json();
  assert.deepEqual(filtered.rows.map((r) => r.code), ["HMTHERE01"]);
  assert.equal((await get("/api/bookings")).json().rows.length, 2);
});

// --- ETag -----------------------------------------------------------------
test("an unchanged list returns 304 with no body", async () => {
  const { personId } = await booking();
  const first = await get("/api/bookings");
  const etag = first.headers.etag;
  assert.ok(etag, "an ETag is sent");

  const again = await get("/api/bookings", { "if-none-match": etag });
  assert.equal(again.statusCode, 304, "the common case — reopening the tab — costs nothing");
  assert.equal(again.body, "");

  // A change must move the ETag, or the host would never see it.
  await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,uploaded_at,uploaded_by,created_at)
    VALUES (?,?,?,?,?,?,?)`, [newId("doc"), personId, "Aadhaar", "r2/y", nowIso(), "guest", nowIso()]);
  const changed = await get("/api/bookings", { "if-none-match": etag });
  assert.equal(changed.statusCode, 200, "a new ID must not be hidden behind a stale ETag");
  assert.notEqual(changed.headers.etag, etag);
});

test("the ETag distinguishes different queries", async () => {
  await booking();
  const all = (await get("/api/bookings")).headers.etag;
  const paged = (await get("/api/bookings?limit=1")).headers.etag;
  assert.notEqual(all, paged, "a different page must not reuse another page's ETag");
});

// --- detail ---------------------------------------------------------------
test("the detail carries the society, the activity and the times", async () => {
  const { id } = await booking({ withDocument: true });
  await run(client, `INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)`,
    [newId("act"), id, nowIso(), "sync", "system", "Booking synced from Airbnb"]);

  const res = await get(`/api/bookings/${id}`);
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.society.to, "desk@greenwood.example");
  assert.equal(b.society.template, "Dear {{listing}}");
  assert.equal(b.activity.length, 1);
  assert.equal(b.times.checkOutTime, "11:00");
  assert.equal(b.people[0].documentType, "Aadhaar");
  assert.equal(b.people[0].fileDeleted, false);
  assert.equal((await get("/api/bookings/bkg_nope")).statusCode, 404);
});

test("a deleted file keeps the booking complete but blocks a resend", async () => {
  const { id } = await booking({ withDocument: true, fileRef: null, sentAt: nowIso() });
  const b = (await get(`/api/bookings/${id}`)).json();
  assert.equal(b.people[0].documentType, "Aadhaar", "we still know what was sent");
  assert.equal(b.people[0].fileDeleted, true, "but the bytes are gone");
  assert.equal(Derive.complete(b), true, "it must not fall back to awaiting");
  assert.equal(Derive.status(b), "sent");
});

// --- efficiency -----------------------------------------------------------
test("the list does not issue a query per booking", async () => {
  for (let i = 0; i < 12; i++) await booking({ code: `HMN1${String(i).padStart(3, "0")}`, withDocument: i % 2 === 0 });

  // The database is a network hop away now, so N+1 is a real cost
  // (docs/TECH_STACK.md §2a).
  const original = client.execute.bind(client);
  let calls = 0;
  client.execute = (...a) => { calls++; return original(...a); };
  try {
    const rows = (await get("/api/bookings")).json().rows;
    assert.equal(rows.length, 12);
    assert.ok(calls <= 4, `expected a constant number of queries, made ${calls}`);
  } finally {
    client.execute = original;
  }
});

// Calendar sync. The feed is the one input we do not control, so most of this
// is about what happens when it misbehaves.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run, one, query } from "../src/db/client.js";
import { syncListing } from "../src/jobs/sync.js";
import { addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, client, auth, feed, feedUrl;
const today = () => toDay(new Date());

// A local stand-in for Airbnb, so the tests drive a real HTTP fetch.
let feedBody = "", feedStatus = 200, feedType = "text/calendar";
before(async () => {
  feed = createServer((req, res) => {
    res.writeHead(feedStatus, { "content-type": feedType });
    res.end(feedBody);
  });
  await new Promise((r) => feed.listen(0, "127.0.0.1", r));
  feedUrl = `http://127.0.0.1:${feed.address().port}/cal.ics`;

  dir = await mkdtemp(join(tmpdir(), "gatepass-sync-"));
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`, JOBS_TICK_SECRET: "tick-secret-value",
    ICAL_ALLOW_PRIVATE_HOSTS: "true",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  auth = { cookie: session.cookie };
  client = app.db.client;
});
after(async () => { await app?.close(); feed?.close(); await rm(dir, { recursive: true, force: true }); });

let soc, lst;
beforeEach(async () => {
  for (const t of ["documents", "people", "activity", "bookings", "listings", "societies"]) await run(client, `DELETE FROM ${t}`);
  soc = newId("soc"); lst = newId("lst");
  await run(client, `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [soc, acc, "Greenwood", "desk@greenwood.example", "Dear {{listing}}", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [lst, acc, "Sea Breeze", feedUrl, soc, nowIso(), nowIso()]);
  feedStatus = 200; feedType = "text/calendar";
});

const listing = () => ({ id: lst, name: "Sea Breeze", icalUrl: feedUrl });
// The loopback feed server is a private host, which the SSRF guard blocks by
// default. Tests opt in explicitly; production cannot (config.js makes it fatal).
const sync = (over = {}) => syncListing(client, listing(), { allowPrivate: true, ...over });
const bookings = () => query(client, "SELECT * FROM bookings ORDER BY check_in");
const activity = (id) => query(client, "SELECT kind, text FROM activity WHERE booking_id = ? ORDER BY at DESC, rowid DESC", [id]);

/** Build a feed. `url:false` omits the reservation URL, so there is no code. */
function calendar(events) {
  const body = events.map((e) => [
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${e.from.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${e.to.replace(/-/g, "")}`,
    `SUMMARY:${e.summary || "Reserved"}`,
    `UID:${e.uid}`,
    e.code ? `DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/${e.code}\\nPhone Number (Last 4 Digits): ${e.phone || "1234"}` : "",
    "END:VEVENT",
  ].filter(Boolean).join("\r\n")).join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Airbnb Inc//Hosting Calendar 1.0.0//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

// --- the happy path -------------------------------------------------------
test("a reservation becomes a booking with one unnamed lead guest", async () => {
  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMABCD1234", from: addDays(today(), 3), to: addDays(today(), 6), phone: "4417" }]);
  const r = await sync();
  assert.equal(r.ok, true);
  assert.equal(r.created, 1);

  const [b] = await bookings();
  assert.equal(b.airbnb_code, "HMABCD1234");
  assert.equal(b.check_in, addDays(today(), 3));
  assert.equal(b.phone_last4, "4417");
  assert.equal(b.lead_guest, null, "the feed carries no name and none is invented");

  const people = await query(client, "SELECT name, is_lead FROM people WHERE booking_id = ?", [b.id]);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "Lead guest");
  assert.equal(people[0].is_lead, 1);
  assert.match((await activity(b.id))[0].text, /synced from Airbnb/);

  // Syncing again changes nothing.
  const again = await sync();
  assert.deepEqual([again.created, again.updated], [0, 0]);
  assert.equal((await bookings()).length, 1);
});

test("blocked dates are not bookings", async () => {
  feedBody = calendar([
    { uid: "block@airbnb.com", from: addDays(today(), 3), to: addDays(today(), 5), summary: "Airbnb (Not available)" },
    { uid: "res@airbnb.com", code: "HMREAL0001", from: addDays(today(), 8), to: addDays(today(), 9) },
  ]);
  await sync();
  const rows = await bookings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].airbnb_code, "HMREAL0001");
});

// --- changes --------------------------------------------------------------
test("a date change updates the booking and says so", async () => {
  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMABCD1234", from: addDays(today(), 3), to: addDays(today(), 6) }]);
  await sync();
  const before = (await bookings())[0];

  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMABCD1234", from: addDays(today(), 3), to: addDays(today(), 8) }]);
  const r = await sync();
  assert.equal(r.updated, 1);
  assert.equal(r.created, 0, "matched by code, not duplicated");

  const after = (await bookings())[0];
  assert.equal(after.id, before.id, "the same booking, so its IDs and history survive");
  assert.equal(after.check_out, addDays(today(), 8));
  assert.match((await activity(after.id))[0].text, /Dates changed on Airbnb/);
});

test("a booking with no code is matched by the feed's UID", async () => {
  feedBody = calendar([{ uid: "nocode@airbnb.com", from: addDays(today(), 3), to: addDays(today(), 5) }]);
  await sync();
  assert.equal((await bookings()).length, 1);
  // Same UID, new dates: an update, not a second booking.
  feedBody = calendar([{ uid: "nocode@airbnb.com", from: addDays(today(), 4), to: addDays(today(), 6) }]);
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal((await bookings()).length, 1);
});

// --- conflicts ------------------------------------------------------------
test("overlapping reservations are flagged on both, not silently merged", async () => {
  feedBody = calendar([
    { uid: "a@airbnb.com", code: "HMOVER0001", from: addDays(today(), 3), to: addDays(today(), 7) },
    { uid: "b@airbnb.com", code: "HMOVER0002", from: addDays(today(), 5), to: addDays(today(), 9) },
  ]);
  const r = await sync();
  assert.equal(r.created, 2, "neither is dropped");
  assert.equal(r.conflicts, 2);
  for (const b of await bookings()) {
    assert.equal(b.conflict, 1);
    assert.match(b.conflict_reason, /overlap/);
  }

  // Fixed on Airbnb: the conflict clears and says so.
  feedBody = calendar([
    { uid: "a@airbnb.com", code: "HMOVER0001", from: addDays(today(), 3), to: addDays(today(), 5) },
    { uid: "b@airbnb.com", code: "HMOVER0002", from: addDays(today(), 5), to: addDays(today(), 9) },
  ]);
  await sync();
  for (const b of await bookings()) assert.equal(b.conflict, 0);
  assert.match((await activity((await bookings())[0].id))[0].text, /conflict resolved/i);
});

// --- failure must never lose data ----------------------------------------
test("a feed that is down keeps every booking and records the error", async () => {
  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMABCD1234", from: addDays(today(), 3), to: addDays(today(), 6) }]);
  await sync();
  await run(client, "UPDATE listings SET last_synced_at = ? WHERE id = ?", [nowIso(), lst]);

  feedStatus = 500;
  const r = await sync();
  assert.equal(r.ok, false);
  assert.equal((await bookings()).length, 1, "a five-minute outage must not empty the list");

  const l = await one(client, "SELECT last_synced_at, last_sync_error FROM listings WHERE id = ?", [lst]);
  assert.equal(l.last_synced_at, null, "last-synced goes stale so the host can see it");
  assert.match(l.last_sync_error, /upstream_error/);
});

test("a login page instead of a calendar is an error, not an empty calendar", async () => {
  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMABCD1234", from: addDays(today(), 3), to: addDays(today(), 6) }]);
  await sync();
  feedStatus = 200; feedType = "text/html"; feedBody = "<!doctype html><html><body>Log in</body></html>";
  const r = await sync();
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_a_calendar");
  assert.equal((await bookings()).length, 1, "nothing was treated as a cancellation");
});

test("a booking that vanishes from the feed is FLAGGED, never deleted", async () => {
  feedBody = calendar([
    { uid: "a@airbnb.com", code: "HMSTAY0001", from: addDays(today(), 3), to: addDays(today(), 6) },
    { uid: "b@airbnb.com", code: "HMGONE0002", from: addDays(today(), 8), to: addDays(today(), 10) },
  ]);
  await sync();
  assert.equal((await bookings()).length, 2);

  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMSTAY0001", from: addDays(today(), 3), to: addDays(today(), 6) }]);
  const r = await sync();
  assert.equal(r.vanished, 1);
  assert.equal((await bookings()).length, 2, "it is still there — the host decides, not the feed");

  const gone = (await bookings()).find((b) => b.airbnb_code === "HMGONE0002");
  assert.equal(gone.conflict, 1);
  assert.match(gone.conflict_reason, /No longer in the Airbnb calendar/);
  assert.match((await activity(gone.id))[0].text, /no longer in the Airbnb calendar/i);
});

test("a disconnected listing is skipped, not treated as a failure", async () => {
  const r = await syncListing(client, { id: lst, name: "Sea Breeze", icalUrl: "" }, { allowPrivate: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "disconnected");
});

// --- the tick -------------------------------------------------------------
test("the job tick needs its secret", async () => {
  const no = await app.inject({ method: "POST", url: "/api/jobs/tick" });
  assert.equal(no.statusCode, 401, "it is a public URL that does real work");
  const wrong = await app.inject({ method: "POST", url: "/api/jobs/tick", headers: { "x-jobs-secret": "nope" } });
  assert.equal(wrong.statusCode, 401);

  feedBody = calendar([{ uid: "a@airbnb.com", code: "HMTICK0001", from: addDays(today(), 3), to: addDays(today(), 6) }]);
  const ok = await app.inject({ method: "POST", url: "/api/jobs/tick", headers: { "x-jobs-secret": "tick-secret-value" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ran, 1);
  assert.equal((await bookings()).length, 1, "the tick actually synced");
});

test("manual sync reports failures by name instead of a cheerful total", async () => {
  feedStatus = 500;
  const res = await app.inject({ method: "POST", url: "/api/sync", headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.failures.length, 1);
  assert.equal(body.failures[0].name, "Sea Breeze");
  assert.ok(body.failures[0].message.length > 5);
});

test("sync endpoints are admin-only; the tick is secret-only", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/sync" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: `/api/listings/${lst}/sync` })).statusCode, 401);
});

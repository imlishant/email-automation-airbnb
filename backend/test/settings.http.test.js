// Societies, listings and the global times, over HTTP.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run } from "../src/db/client.js";

let dir, app, auth;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-set-"));
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  const un = await app.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
  auth = { cookie: `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}` };
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const req = (method, url, payload) => app.inject({ method, url, payload, headers: auth });
const anon = (method, url, payload) => app.inject({ method, url, payload });
const society = (over = {}) => ({
  name: "Greenwood Society", to: "security@greenwood.example", cc: "", template: "Dear team, {{listing}}", ...over,
});

beforeEach(async () => {
  await run(app.db.client, "DELETE FROM bookings");
  await run(app.db.client, "DELETE FROM listings");
  await run(app.db.client, "DELETE FROM societies");
});

// --- everything here is admin-only ---------------------------------------
test("every settings route refuses an anonymous caller", async () => {
  const routes = [
    ["GET", "/api/societies"], ["POST", "/api/societies"], ["PATCH", "/api/societies/x"],
    ["DELETE", "/api/societies/x"], ["GET", "/api/listings"], ["POST", "/api/listings"],
    ["POST", "/api/listings/check"], ["PATCH", "/api/listings/x"], ["DELETE", "/api/listings/x"],
    ["GET", "/api/listings/x/usage"], ["POST", "/api/listings/x/disconnect"],
    ["GET", "/api/settings/times"], ["PATCH", "/api/settings/times"],
  ];
  for (const [method, url] of routes) {
    const res = await anon(method, url, {});
    assert.equal(res.statusCode, 401, `${method} ${url} should be 401, got ${res.statusCode}`);
  }
});

// --- societies ------------------------------------------------------------
test("a society round-trips, and its desk address is validated", async () => {
  const created = await req("POST", "/api/societies", society());
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().listingCount, 0);

  for (const bad of ["not-an-email", "a@b", "@b.example", "a b@c.example", ""]) {
    const res = await req("POST", "/api/societies", society({ to: bad }));
    assert.equal(res.statusCode, 400, `should reject desk address ${JSON.stringify(bad)}`);
  }
  // A misrouted ID is the worst bug in this system, so the address is checked.
  assert.equal((await req("POST", "/api/societies", { name: "X" })).statusCode, 400, "template and desk required");
  assert.equal((await req("POST", "/api/societies", society({ extra: 1 }))).statusCode, 400, "unknown field");
});

test("a partial society update leaves the other fields alone", async () => {
  const id = (await req("POST", "/api/societies", society())).json().id;
  const patched = await req("PATCH", `/api/societies/${id}`, { cc: "manager@greenwood.example" });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().cc, "manager@greenwood.example");
  assert.equal(patched.json().to, "security@greenwood.example", "the desk address survived");
  assert.equal(patched.json().template, "Dear team, {{listing}}", "the template survived");

  assert.equal((await req("PATCH", `/api/societies/${id}`, {})).statusCode, 400, "an empty patch is meaningless");
  assert.equal((await req("PATCH", "/api/societies/soc_nope", { cc: "x@y.z" })).statusCode, 404);
});

test("a society cannot be deleted while a listing still sends to it", async () => {
  const sid = (await req("POST", "/api/societies", society())).json().id;
  await req("POST", "/api/listings", { name: "Sea Breeze", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: sid });

  const refused = await req("DELETE", `/api/societies/${sid}`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "has_listings");
  assert.equal(refused.json().count, 1);
  assert.match(refused.json().message, /Point them elsewhere/);

  assert.equal((await req("GET", "/api/societies")).json().length, 1, "still there");
  assert.equal((await req("GET", "/api/societies")).json()[0].listingCount, 1, "counted in one query");
});

// --- listings -------------------------------------------------------------
test("a listing must name a society that exists", async () => {
  const base = { name: "Sea Breeze", icalUrl: "https://www.airbnb.co.in/calendar/ical/1.ics?s=a" };
  const missing = await req("POST", "/api/listings", { ...base, societyId: "soc_nope" });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "no_society");
  // The destination is never guessed or defaulted (docs/DECISIONS.md).
  assert.equal((await req("POST", "/api/listings", base)).statusCode, 400, "societyId is required");
});

test("the calendar link's shape is enforced before it is stored", async () => {
  const sid = (await req("POST", "/api/societies", society())).json().id;
  for (const [url, code] of [
    ["http://insecure.example/c.ics", "not_https"],
    ["https://localhost/c.ics", "private_host"],
    ["https://127.0.0.1/c.ics", "private_host"],
    ["nonsense", "bad_url"],
  ]) {
    const res = await req("POST", "/api/listings", { name: "X", icalUrl: url, societyId: sid });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, code, url);
  }
});

test("changing the calendar link resets the sync state", async () => {
  const sid = (await req("POST", "/api/societies", society())).json().id;
  const id = (await req("POST", "/api/listings",
    { name: "Sea Breeze", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: sid })).json().id;

  await run(app.db.client, "UPDATE listings SET last_synced_at = ?, last_sync_error = 'stale' WHERE id = ?",
    [nowIso(), id]);
  const patched = await req("PATCH", `/api/listings/${id}`, { icalUrl: "https://airbnb.com/calendar/ical/2.ics" });
  assert.equal(patched.json().lastSyncedAt, null, "a different calendar makes the old sync state meaningless");
  assert.equal(patched.json().lastSyncError, null);

  // A rename must NOT reset it.
  await run(app.db.client, "UPDATE listings SET last_synced_at = ? WHERE id = ?", [nowIso(), id]);
  const renamed = await req("PATCH", `/api/listings/${id}`, { name: "Renamed" });
  assert.equal(renamed.json().name, "Renamed");
  assert.notEqual(renamed.json().lastSyncedAt, null, "renaming is not a resync");
});

test("moving a listing to another society is allowed; a nonexistent one is not", async () => {
  const a = (await req("POST", "/api/societies", society())).json().id;
  const b = (await req("POST", "/api/societies", society({ name: "Hillcrest", to: "gate@hillcrest.example" }))).json().id;
  const id = (await req("POST", "/api/listings",
    { name: "Sea Breeze", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: a })).json().id;

  const moved = await req("PATCH", `/api/listings/${id}`, { societyId: b });
  assert.equal(moved.json().societyId, b);
  assert.equal(moved.json().societyName, "Hillcrest");
  assert.equal((await req("PATCH", `/api/listings/${id}`, { societyId: "soc_nope" })).statusCode, 400);
});

test("disconnect keeps the listing and its bookings; delete is refused", async () => {
  const sid = (await req("POST", "/api/societies", society())).json().id;
  const id = (await req("POST", "/api/listings",
    { name: "Sea Breeze", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: sid })).json().id;

  // A booking, already sent — exactly the record a delete would destroy.
  await run(app.db.client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,sent_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    [newId("bkg"), "HMTEST0001", id, "2026-09-20", "2026-09-23", nowIso(), nowIso(), nowIso()]);

  const usage = await req("GET", `/api/listings/${id}/usage`);
  assert.deepEqual(usage.json(), { total: 1, sent: 1 });

  const refused = await req("DELETE", `/api/listings/${id}`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "has_bookings");
  assert.match(refused.json().message, /disconnect it instead/);

  const disc = await req("POST", `/api/listings/${id}/disconnect`, {});
  assert.equal(disc.json().connected, false);
  assert.equal(disc.json().icalUrl, "");
  assert.equal((await req("GET", `/api/listings/${id}/usage`)).json().total, 1, "the booking survived");

  // With no bookings, deleting is fine.
  await run(app.db.client, "DELETE FROM bookings WHERE listing_id = ?", [id]);
  assert.equal((await req("DELETE", `/api/listings/${id}`)).statusCode, 200);
  assert.equal((await req("GET", "/api/listings")).json().length, 0);
});

// --- reading a calendar before committing to it ---------------------------
test("a calendar check reports a bad link instead of saving a broken listing", async () => {
  // The classic mistake: the Airbnb page URL instead of the Export link.
  for (const [url, code] of [
    ["http://x.example/c.ics", "not_https"],
    ["https://localhost/c.ics", "private_host"],
    ["not a url", "bad_url"],
  ]) {
    const res = await req("POST", "/api/listings/check", { icalUrl: url });
    assert.equal(res.statusCode, 200, "a bad link is a report, not an HTTP error");
    assert.equal(res.json().ok, false, url);
    assert.equal(res.json().code, code, url);
    assert.ok(res.json().message.length > 10, "the message has to be actionable");
  }
  assert.equal((await req("POST", "/api/listings/check", {})).statusCode, 400, "icalUrl required");
});

// --- the global times -----------------------------------------------------
test("the check-in and check-out times can be read and changed, and are validated", async () => {
  assert.deepEqual((await req("GET", "/api/settings/times")).json(), { checkInTime: "14:00", checkOutTime: "11:00" });

  const patched = await req("PATCH", "/api/settings/times", { checkInTime: "15:30" });
  assert.deepEqual(patched.json(), { checkInTime: "15:30", checkOutTime: "11:00" }, "a partial update");

  // Every retention window hangs off these, so a nonsense value must not land.
  for (const bad of [{ checkInTime: "25:00" }, { checkInTime: "9:00" }, { checkInTime: "2pm" },
                     { checkOutTime: "11:60" }, {}, { checkInTime: "11:00", nope: 1 }]) {
    assert.equal((await req("PATCH", "/api/settings/times", bad)).statusCode, 400, JSON.stringify(bad));
  }
  await req("PATCH", "/api/settings/times", { checkInTime: "14:00" });
});

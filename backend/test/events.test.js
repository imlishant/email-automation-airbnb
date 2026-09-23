// Live updates. The stream must carry no data, and a guest must hear only
// about their own booking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run } from "../src/db/client.js";
import { bus } from "../src/events.js";
import { addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, port, cookie, bkgA, bkgB, personA, tokenA;
const today = () => toDay(new Date());

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-sse-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500" }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  cookie = session.cookie;
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
  const c = app.db.client;

  const soc = newId("soc"), lst = newId("lst");
  await run(c, `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [soc, acc, "S", "d@x.example", "t", nowIso(), nowIso()]);
  await run(c, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [lst, acc, "L", "https://a.example/c.ics", soc, nowIso(), nowIso()]);
  for (const [id, per] of [[bkgA = newId("bkg"), personA = newId("per")], [bkgB = newId("bkg"), newId("per")]]) {
    await run(c, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      [id, newId("HM"), lst, addDays(today(), 2), addDays(today(), 5), nowIso(), nowIso()]);
    await run(c, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`, [per, id, "Lead guest", nowIso()]);
  }
  tokenA = (await app.inject({ method: "GET", url: `/api/bookings/${bkgA}`, headers: { cookie } })).json().guestLink.token;
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

/** Open a stream and collect `change` events until closed. */
function stream(path, headers = {}) {
  return new Promise((resolve) => {
    const events = [];
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      });
      resolve({ status: res.statusCode, headers: res.headers, events, close: () => req.destroy() });
    });
    req.end();
  });
}
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const rename = (bkg, per, name) => app.inject({ method: "PATCH", url: `/api/bookings/${bkg}/people/${per}`, payload: { name }, headers: { cookie } });

test("the admin stream hears a change the moment it happens", async () => {
  const s = await stream("/api/events", { cookie });
  assert.equal(s.status, 200);
  assert.match(s.headers["content-type"], /text\/event-stream/);
  await wait();
  await rename(bkgA, personA, "Priya Menon");
  await wait();
  s.close();
  assert.deepEqual(s.events, [{ bookingId: bkgA }]);
});

test("the stream carries an id and nothing else — no names, no data", async () => {
  const s = await stream("/api/events", { cookie });
  await wait();
  await rename(bkgA, personA, "Anita Desai");
  await wait();
  s.close();
  assert.deepEqual(Object.keys(s.events[0]), ["bookingId"]);
  assert.ok(!JSON.stringify(s.events).includes("Anita"), "a name must never ride the stream");
});

test("a guest hears about their own booking only", async () => {
  const guest = await stream(`/u/${tokenA}/events`);
  assert.equal(guest.status, 200);
  await wait();
  const personB = (await app.db.client.execute({ sql: "SELECT id FROM people WHERE booking_id = ?", args: [bkgB] })).rows[0].id;
  await rename(bkgB, personB, "Someone Else");      // not theirs
  await rename(bkgA, personA, "Priya Menon");       // theirs
  await wait();
  guest.close();
  assert.deepEqual(guest.events, [{ bookingId: bkgA }],
    "another guest's booking changing must not even be announced");
});

test("streams refuse the unauthorised", async () => {
  const anon = await stream("/api/events");
  assert.equal(anon.status, 401); anon.close();
  const forged = await stream("/u/forged.token/events");
  assert.equal(forged.status, 404); forged.close();
});

test("a closed tab releases its listener, so nothing leaks", async () => {
  const baseline = bus.listenerCount("change");
  const s = await stream("/api/events", { cookie });
  await wait();
  assert.equal(bus.listenerCount("change"), baseline + 1);
  s.close();
  await wait(150);
  assert.equal(bus.listenerCount("change"), baseline);
});

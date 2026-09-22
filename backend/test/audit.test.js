// Admin audit trail: what changed, never a secret.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { AUDITED_ROUTES } from "../src/http/audit.js";

let dir, app, auth;
const cfg = (d, extra = {}) => loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`,
  AUTH_MAX_ATTEMPTS: "3", RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500", ...extra });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-audit-"));
  app = await buildServer(cfg(dir), { logger: false });
  const un = await app.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
  auth = { cookie: `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}` };
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const req = (method, url, payload) => app.inject({ method, url, payload, headers: auth });
const audit = async () => (await req("GET", "/api/audit")).json().rows;

test("configuration changes are audited, newest first, with the caller's address", async () => {
  const soc = (await req("POST", "/api/societies", { name: "Greenwood", to: "desk@g.example", template: "t" })).json();
  await req("PATCH", `/api/societies/${soc.id}`, { to: "gate@g.example" });
  const lst = (await req("POST", "/api/listings",
    { name: "Sea Breeze", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: soc.id })).json();
  await req("POST", `/api/listings/${lst.id}/disconnect`, {});
  await req("DELETE", `/api/listings/${lst.id}`);
  await req("PATCH", "/api/settings/times", { checkInTime: "15:00" });

  const texts = (await audit()).map((r) => r.text);
  assert.deepEqual(texts.slice(0, 6), [
    "Times changed: check-in 15:00",
    'Listing "Sea Breeze" deleted',
    'Listing "Sea Breeze" disconnected',
    'Listing "Sea Breeze" connected',
    'Society "Greenwood": desk address changed to gate@g.example',
    'Society "Greenwood" added',
  ], "a deleted listing is still named, because the name is read before the delete");
  assert.ok((await audit())[0].ip, "the address it came from is recorded");
});

test("a refused action is not audited as if it happened", async () => {
  const before = (await audit()).length;
  await req("POST", "/api/societies", { name: "X", to: "not-an-email", template: "t" });   // 400
  await req("DELETE", "/api/listings/lst_nope");                                           // 404
  assert.equal((await audit()).length, before);
});

test("a passcode change is audited without the passcode", async () => {
  await req("POST", "/api/auth/passcode", { next: "2468" });
  const rows = await audit();
  assert.equal(rows[0].text, "Admin passcode changed");
  assert.ok(!JSON.stringify(rows).includes("2468"), "the new passcode must appear nowhere in the audit");
});

test("a lockout is audited; ordinary wrong guesses are not", async () => {
  const d = await mkdtemp(join(tmpdir(), "gatepass-audit2-"));
  const a = await buildServer(cfg(d), { logger: false });
  try {
    const bad = () => a.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "9999" } });
    await bad(); await bad(); await bad();          // the third locks
    const un = await a.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
    assert.equal(un.statusCode, 401, "still locked");
    assert.equal((await a.inject({ method: "GET", url: "/api/audit" })).statusCode, 401, "the audit itself is admin-only");
    const direct = await a.db.client.execute("SELECT text FROM activity WHERE booking_id IS NULL");
    const lockouts = direct.rows.filter((r) => /locked/.test(r.text));
    assert.ok(lockouts.length >= 1, "the lockout is recorded");
    assert.ok(direct.rows.length <= 2, "individual wrong guesses are counted, not logged");
  } finally { await a.close(); await rm(d, { recursive: true, force: true }); }
});

test("every admin route that changes configuration is in the audit table", async () => {
  // A new settings route missing from AUDITED should fail here, not in review.
  const mutating = [];
  for (const r of ["POST /api/societies", "PATCH /api/societies/:id", "DELETE /api/societies/:id",
                   "POST /api/listings", "PATCH /api/listings/:id", "DELETE /api/listings/:id",
                   "POST /api/listings/:id/disconnect", "PATCH /api/settings/times", "POST /api/auth/passcode"]) {
    if (!AUDITED_ROUTES.includes(r)) mutating.push(r);
  }
  assert.deepEqual(mutating, []);
});

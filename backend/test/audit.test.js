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
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, auth;
const cfg = (d, extra = {}) => loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`,
  AUTH_MAX_ATTEMPTS: "3", RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500", ...extra });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-audit-"));
  app = await buildServer(cfg(dir), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  auth = { cookie: session.cookie };
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

test("the log says WHO, because logins are people now", async () => {
  await req("POST", "/api/societies", { name: "Whodunnit", to: "d@w.example", template: "t" });
  const row = (await audit())[0];
  assert.equal(row.text, 'Society "Whodunnit" added');
  assert.equal(row.by, "host@example.com", "the address they signed in with");
});

test("access changes are audited, and one account cannot read another's log", async () => {
  await req("POST", "/api/members", { email: "cohost@example.com" });
  assert.equal((await audit())[0].text, "cohost@example.com invited as a co-host");

  // A second host on the same deployment sees only their own entries.
  const other = await signIn(app, { email: "other@example.com", accountName: "Other listings" });
  const theirs = await app.inject({ method: "GET", url: "/api/audit", headers: { cookie: other.cookie } });
  assert.equal(theirs.statusCode, 200);
  assert.deepEqual(theirs.json().rows, [], "another host's account has its own, empty log");
});

test("every admin route that changes configuration is in the audit table", async () => {
  // A new settings route missing from AUDITED should fail here, not in review.
  const mutating = [];
  for (const r of ["POST /api/societies", "PATCH /api/societies/:id", "DELETE /api/societies/:id",
                   "POST /api/listings", "PATCH /api/listings/:id", "DELETE /api/listings/:id",
                   "POST /api/listings/:id/disconnect", "PATCH /api/settings/times",
                   "POST /api/members", "DELETE /api/members/:id", "PUT /api/mail", "DELETE /api/mail"]) {
    if (!AUDITED_ROUTES.includes(r)) mutating.push(r);
  }
  assert.deepEqual(mutating, []);
});

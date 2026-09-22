// The owner tier: a single-use link to one fixed inbox, and the actions it guards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { recordingTransport } from "../src/mail/transport.js";
import { one, run, nowIso } from "../src/db/client.js";

let dir, app, adminCookie;
const OWNER = "owner@example.com";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-owner-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`, OWNER_EMAIL: OWNER,
    MAIL_FROM: OWNER, APP_BASE_URL: "http://localhost:8080", RATE_LIMIT_OWNER_LINK_PER_10MIN: "100",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500" }), { logger: false });
  app.mail = recordingTransport();
  const un = await app.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
  adminCookie = `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}`;
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const as = (cookie) => (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } });

async function ownerCookie() {
  app.mail.sent.length = 0;
  const r = await app.inject({ method: "POST", url: "/api/auth/owner/request" });
  assert.equal(r.statusCode, 200, r.body);
  const url = app.mail.sent[0].body.match(/https?:\/\/\S+/)[0];
  const v = await app.inject({ method: "GET", url: url.replace("http://localhost:8080", "") });
  return { cookie: `${COOKIE}=${v.cookies.find((c) => c.name === COOKIE).value}`, url, verify: v };
}

test("the link goes only to OWNER_EMAIL — the request cannot name an address", async () => {
  app.mail.sent.length = 0;
  const r = await app.inject({ method: "POST", url: "/api/auth/owner/request", payload: { to: "attacker@evil.example" } });
  assert.equal(r.statusCode, 200);
  assert.equal(app.mail.sent.length, 1);
  assert.equal(app.mail.sent[0].to, OWNER, "the body is ignored; only the configured owner is ever mailed");
  assert.match(app.mail.sent[0].body, /expires in 15 minutes/);
});

test("only a hash of the link is stored", async () => {
  const { url } = await ownerCookie();
  const token = new URL(url).searchParams.get("token");
  const rows = (await app.db.client.execute("SELECT token_hash FROM owner_links")).rows;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.token_hash !== token), "a leaked database must not contain a usable link");
});

test("the link signs the owner in once, and then never again", async () => {
  const { url, verify } = await ownerCookie();
  assert.equal(verify.statusCode, 302);
  assert.equal(verify.headers.location, "/frontend/index.html");

  const replay = await app.inject({ method: "GET", url: url.replace("http://localhost:8080", "") });
  assert.equal(replay.headers.location, "/frontend/index.html#owner-link-expired", "single use");
  assert.equal(replay.cookies.find((c) => c.name === COOKIE), undefined);
});

test("an expired or forged link signs no one in", async () => {
  const { url } = await (async () => { app.mail.sent.length = 0; await app.inject({ method: "POST", url: "/api/auth/owner/request" });
    return { url: app.mail.sent[0].body.match(/https?:\/\/\S+/)[0] }; })();
  await run(app.db.client, "UPDATE owner_links SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);
  const expired = await app.inject({ method: "GET", url: url.replace("http://localhost:8080", "") });
  assert.match(expired.headers.location, /owner-link-expired/);
  const forged = await app.inject({ method: "GET", url: "/api/auth/owner/verify?token=" + "A".repeat(43) });
  assert.match(forged.headers.location, /owner-link-expired/);
});

test("an ordinary admin is refused the owner-only actions; the owner is not", async () => {
  const admin = as(adminCookie);
  const soc = (await admin("POST", "/api/societies", { name: "S", to: "d@s.example", template: "t" })).json();
  const lst = (await admin("POST", "/api/listings", { name: "L", icalUrl: "https://airbnb.com/calendar/ical/1.ics", societyId: soc.id })).json();

  const guarded = [
    ["POST", "/api/auth/passcode", { next: "2468" }],
    ["PATCH", `/api/societies/${soc.id}`, { to: "evil@s.example" }],
    ["POST", `/api/listings/${lst.id}/disconnect`, {}],
    ["DELETE", `/api/listings/${lst.id}`],
    ["DELETE", `/api/societies/${soc.id}`],
  ];
  for (const [m, u, b] of guarded) {
    const r = await admin(m, u, b);
    assert.equal(r.statusCode, 403, `${m} ${u} should be owner-only`);
    assert.equal(r.json().error, "owner_only");
  }
  assert.equal((await one(app.db.client, "SELECT desk_email_to FROM societies WHERE id = ?", [soc.id])).desk_email_to,
    "d@s.example", "the desk address was not changed by the refused request");

  // Everyday work stays open to every admin.
  assert.equal((await admin("GET", "/api/bookings")).statusCode, 200);
  assert.equal((await admin("POST", "/api/listings", { name: "L2", icalUrl: "https://airbnb.com/calendar/ical/2.ics", societyId: soc.id })).statusCode, 201);

  const owner = as((await ownerCookie()).cookie);
  assert.equal((await owner("PATCH", `/api/societies/${soc.id}`, { to: "gate@s.example" })).statusCode, 200);
  assert.equal((await owner("POST", `/api/listings/${lst.id}/disconnect`, {})).statusCode, 200);
});

test("the session says who you are", async () => {
  const admin = (await as(adminCookie)("GET", "/api/auth/session")).json();
  assert.deepEqual(admin, { admin: true, role: "admin", ownerTier: true });
  const owner = (await as((await ownerCookie()).cookie)("GET", "/api/auth/session")).json();
  assert.equal(owner.role, "owner");
});

test("with no OWNER_EMAIL, the tier is off and every admin can do everything", async () => {
  const d = await mkdtemp(join(tmpdir(), "gp-noowner-"));
  const a = await buildServer(loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500" }), { logger: false });
  try {
    const un = await a.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
    const cookie = `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}`;
    const r = await a.inject({ method: "POST", url: "/api/auth/passcode", payload: { next: "2468" }, headers: { cookie } });
    assert.equal(r.statusCode, 200, "otherwise the host is locked out of their own settings until email exists");
    assert.equal((await a.inject({ method: "POST", url: "/api/auth/owner/request" })).statusCode, 404);
  } finally { await a.close(); await rm(d, { recursive: true, force: true }); }
});

test("with no mail transport, requesting a link fails loudly rather than pretending", async () => {
  const good = app.mail;
  app.mail = (await import("../src/mail/transport.js")).unconfiguredTransport();
  const r = await app.inject({ method: "POST", url: "/api/auth/owner/request" });
  assert.equal(r.statusCode, 503);
  app.mail = good;
});

test("sign-in links are audited, and the link itself never is", async () => {
  const { url } = await ownerCookie();
  const texts = (await app.db.client.execute("SELECT text FROM activity WHERE booking_id IS NULL")).rows.map((r) => r.text);
  assert.ok(texts.includes("Owner sign-in link requested"));
  assert.ok(texts.includes("Owner signed in"));
  assert.ok(!texts.some((t) => t.includes(new URL(url).searchParams.get("token"))));
});

test("requesting links is rate-limited, because each one sends an email", async () => {
  const d = await mkdtemp(join(tmpdir(), "gp-owner-rl-"));
  const a = await buildServer(loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`, OWNER_EMAIL: OWNER, MAIL_FROM: OWNER }), { logger: false });
  a.mail = recordingTransport();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await a.inject({ method: "POST", url: "/api/auth/owner/request" })).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal(a.mail.sent.length, 3, "no more than three emails in ten minutes");
  } finally { await a.close(); await rm(d, { recursive: true, force: true }); }
});

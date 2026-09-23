// The HTTP layer. Uses app.inject(), so no port is bound and no server leaks
// between tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE, issueSession, verifySession } from "../src/http/session.js";
import { signIn } from "./fixtures/session.js";

let dir, app;
const POLICY = { AUTH_MAX_ATTEMPTS: "3", AUTH_LOCKOUT_SECONDS: "60", RATE_LIMIT_AUTH_PER_MINUTE: "50",
                 RATE_LIMIT_GLOBAL_PER_MINUTE: "500" };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-http-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`,
    PLATFORM_OWNER_EMAIL: "site@example.com", ...POLICY }), { logger: false });
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const post = (url, payload, headers) => app.inject({ method: "POST", url, payload, headers });
const get = (url, headers) => app.inject({ method: "GET", url, headers });
const cookieOf = (res) => res.cookies.find((c) => c.name === COOKIE);
const asAdmin = (res) => ({ cookie: `${COOKIE}=${cookieOf(res).value}` });

// --- boot -----------------------------------------------------------------
test("production refuses to start without its secrets", async () => {
  const cfg = loadConfig({ NODE_ENV: "production", DATABASE_URL: "file:/tmp/nope.db" });
  assert.ok(cfg.fatal.length >= 3);
  await assert.rejects(buildServer(cfg, { logger: false }), /refusing to start/);
});

test("production refuses a plain-http base URL, because guest tokens are in the URL", async () => {
  const cfg = loadConfig({
    NODE_ENV: "production", SESSION_SECRET: "s".repeat(40), JOBS_TICK_SECRET: "j".repeat(20),
    APP_BASE_URL: "http://gatepass.example.com",
  });
  assert.ok(cfg.fatal.some((f) => /https/.test(f)), cfg.fatal.join("; "));
});

test("a bad check-in time is fatal, not silently ignored", () => {
  assert.ok(loadConfig({ DEFAULT_CHECK_IN_TIME: "2pm" }).fatal.some((f) => /HH:MM/.test(f)));
});

// --- health ---------------------------------------------------------------
test("/healthz reports the database and nothing else", async () => {
  const res = await get("/healthz");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  // It must not leak whether a passcode is configured.
  assert.deepEqual(Object.keys(body).sort(), ["db", "ok", "uptime"]);
});

// --- security headers -----------------------------------------------------
test("every response carries the security headers", async () => {
  for (const url of ["/healthz", "/api/auth/session"]) {
    const h = (await get(url)).headers;
    assert.equal(h["x-content-type-options"], "nosniff", url);
    assert.equal(h["x-frame-options"], "DENY", url);
    // Guest tokens travel in the URL; a referrer would leak one.
    assert.equal(h["referrer-policy"], "no-referrer", url);
    assert.equal(h["x-robots-tag"], "noindex, nofollow", url);
  }
  // Personal data must never sit in a cache.
  assert.equal((await get("/api/auth/session")).headers["cache-control"], "no-store");
});

// --- request validation ---------------------------------------------------
test("bodies are validated, and unknown fields are REJECTED not stripped", async () => {
  // Silently dropping a field the client believes it sent is a bug that hides
  // itself, so ajv runs with removeAdditional off.
  const extra = await post("/api/auth/dev-login", { email: "a@b.example", admin: true });
  assert.equal(extra.statusCode, 400);
  assert.match(extra.json().message, /additional properties/i);

  for (const bad of [{ email: "" }, { email: 5 }, {}]) {
    const res = await post("/api/auth/dev-login", bad);
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- signing in -----------------------------------------------------------
test("signing in returns an HttpOnly, SameSite cookie", async () => {
  const { cookie } = await signIn(app, { email: "cookie@example.com" });
  const res = await post("/api/auth/dev-login", { email: "cookie@example.com" });
  assert.equal(res.statusCode, 200);
  const c = cookieOf(res);
  assert.ok(c, "a session cookie was set");
  assert.equal(c.httpOnly, true, "unreadable by script");
  assert.equal(c.sameSite, "Lax");
  assert.equal(c.path, "/");
  assert.ok(cookie.startsWith(`${COOKIE}=`));
});

test("an address nobody approved cannot start an account", async () => {
  const res = await post("/api/auth/dev-login", { email: "stranger@example.com" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "not_approved");
  assert.equal(cookieOf(res), undefined, "no cookie for someone turned away");
});

test("development sign-in cannot exist in production", () => {
  const cfg = loadConfig({ NODE_ENV: "production", DEV_LOGIN: "true" });
  assert.ok(cfg.fatal.some((f) => /DEV_LOGIN/.test(f)), cfg.fatal.join("; "));
});

test("protected routes need a valid session", async () => {
  assert.equal((await get("/api/members")).statusCode, 401);
  assert.equal((await get("/api/members", { cookie: `${COOKIE}=forged` })).statusCode, 401);
  // A well-formed token signed with the wrong key is still refused.
  const foreign = issueSession("a-different-secret-entirely", { ttlHours: 1, userId: "usr_x", accountId: "acc_x" });
  assert.equal((await get("/api/members", { cookie: `${COOKIE}=${foreign}` })).statusCode, 401);

  const { cookie } = await signIn(app, { email: "member@example.com" });
  assert.equal((await get("/api/members", { cookie })).statusCode, 200);
});

test("a session for an account you are no longer a member of is refused", async () => {
  // The role is read from the memberships table, not the cookie, so losing
  // access takes effect on the next request rather than when the cookie
  // expires. (The lookup is cached for a few seconds and the cache is dropped
  // whenever access changes, so removal through the API is immediate.)
  const owner = await signIn(app, { email: "owner2@example.com", accountName: "Owned" });
  const helper = await signIn(app, { email: "helper2@example.com", accountId: owner.accountId, role: "admin" });
  assert.equal((await get("/api/members", { cookie: helper.cookie })).statusCode, 200);

  const removed = await app.inject({ method: "DELETE", url: `/api/members/${helper.userId}`,
    headers: { cookie: owner.cookie } });
  assert.equal(removed.statusCode, 200);
  assert.equal((await get("/api/members", { cookie: helper.cookie })).statusCode, 401);
});

test("an expired session is refused", async () => {
  const stale = issueSession(app.sessionSecret, { ttlHours: -1, userId: "usr_x", accountId: "acc_x" });
  assert.equal(verifySession(stale, app.sessionSecret).ok, false);
  assert.equal((await get("/api/members", { cookie: `${COOKIE}=${stale}` })).statusCode, 401);
});

test("/auth/session answers without needing a session", async () => {
  const anon = await get("/api/auth/session");
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.json().signedIn, false);

  const { cookie } = await signIn(app, { email: "who@example.com", accountName: "Their listings" });
  const mine = (await get("/api/auth/session", { cookie })).json();
  assert.equal(mine.signedIn, true);
  assert.equal(mine.email, "who@example.com");
  assert.equal(mine.role, "owner");
  assert.equal(mine.account.name, "Their listings");
});

test("signing out clears the cookie", async () => {
  const { cookie } = await signIn(app, { email: "bye@example.com" });
  const out = await post("/api/auth/lock", {}, { cookie });
  assert.equal(out.statusCode, 200);
  assert.equal(cookieOf(out).value, "", "the cookie is emptied");
});

// --- errors ---------------------------------------------------------------
test("unknown routes 404 as JSON and leak nothing", async () => {
  const res = await get("/api/does-not-exist");
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "not_found" });
});

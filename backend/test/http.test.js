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

let dir, app;
const POLICY = { AUTH_MAX_ATTEMPTS: "3", AUTH_LOCKOUT_SECONDS: "60", RATE_LIMIT_AUTH_PER_MINUTE: "50",
                 RATE_LIMIT_GLOBAL_PER_MINUTE: "500" };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-http-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`, ...POLICY }), { logger: false });
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
  const extra = await post("/api/auth/unlock", { passcode: "0000", admin: true });
  assert.equal(extra.statusCode, 400);
  assert.match(extra.json().message, /additional properties/i);

  for (const bad of [{ passcode: "abc" }, { passcode: "12345" }, { passcode: "123" }, { passcode: 1234 }, {}]) {
    const res = await post("/api/auth/unlock", bad);
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
  }
});

// --- unlock / session -----------------------------------------------------
test("the wrong passcode is refused and counts down", async () => {
  const res = await post("/api/auth/unlock", { passcode: "9999" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthorised");
  assert.equal(res.json().attemptsRemaining, 2);
  assert.equal(cookieOf(res), undefined, "no cookie on failure");
});

test("the right passcode returns an HttpOnly, SameSite cookie", async () => {
  const res = await post("/api/auth/unlock", { passcode: "0000" });
  assert.equal(res.statusCode, 200);
  const c = cookieOf(res);
  assert.ok(c, "a session cookie was set");
  assert.equal(c.httpOnly, true, "unreadable by script");
  assert.equal(c.sameSite, "Lax");
  assert.equal(c.path, "/");
  // A successful unlock also clears the earlier failed attempts.
  assert.equal((await post("/api/auth/unlock", { passcode: "9999" })).json().attemptsRemaining, 2);
});

test("protected routes need a valid session", async () => {
  assert.equal((await get("/api/auth/status")).statusCode, 401);
  assert.equal((await get("/api/auth/status", { cookie: `${COOKIE}=forged` })).statusCode, 401);
  // A well-formed token signed with the wrong key is still refused.
  const foreign = issueSession("a-different-secret-entirely", { ttlHours: 1 });
  assert.equal((await get("/api/auth/status", { cookie: `${COOKIE}=${foreign}` })).statusCode, 401);

  const unlocked = await post("/api/auth/unlock", { passcode: "0000" });
  const ok = await get("/api/auth/status", asAdmin(unlocked));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().configured, true);
});

test("an expired session is refused", async () => {
  const stale = issueSession(app.sessionSecret, { ttlHours: -1 });
  assert.equal(verifySession(stale, app.sessionSecret).ok, false);
  assert.equal((await get("/api/auth/status", { cookie: `${COOKIE}=${stale}` })).statusCode, 401);
});

test("/auth/session answers without needing a session", async () => {
  assert.equal((await get("/api/auth/session")).json().admin, false);
  const unlocked = await post("/api/auth/unlock", { passcode: "0000" });
  assert.equal((await get("/api/auth/session", asAdmin(unlocked))).json().admin, true);
});

test("locking clears the cookie", async () => {
  const unlocked = await post("/api/auth/unlock", { passcode: "0000" });
  const locked = await post("/api/auth/lock", {}, asAdmin(unlocked));
  assert.equal(locked.statusCode, 200);
  assert.equal(cookieOf(locked).value, "", "the cookie is emptied");
});

// --- lockout over HTTP ----------------------------------------------------
test("the account lockout is enforced at the HTTP layer too, with Retry-After", async () => {
  // A fresh server, so this test's failures do not disturb the others.
  const d = await mkdtemp(join(tmpdir(), "gatepass-lock-"));
  const a = await buildServer(loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`, ...POLICY }), { logger: false });
  try {
    const bad = () => a.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "9999" } });
    assert.equal((await bad()).json().attemptsRemaining, 2);
    assert.equal((await bad()).json().attemptsRemaining, 1);
    const third = await bad();
    assert.equal(third.json().error, "locked");
    assert.equal(third.headers["retry-after"], "60");

    // The correct passcode is refused while locked — the point of a lockout.
    const correct = await a.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
    assert.equal(correct.statusCode, 401);
    assert.equal(correct.json().error, "locked");
    assert.equal(correct.cookies.find((c) => c.name === COOKIE), undefined);
  } finally {
    await a.close();
    await rm(d, { recursive: true, force: true });
  }
});

// --- changing the passcode ------------------------------------------------
test("changing the passcode needs a session, validates, and retires the session", async () => {
  const d = await mkdtemp(join(tmpdir(), "gatepass-pass-"));
  const a = await buildServer(loadConfig({ DATABASE_URL: `file:${join(d, "t.db")}`, ...POLICY }), { logger: false });
  try {
    const inj = (url, payload, headers) => a.inject({ method: "POST", url, payload, headers });
    assert.equal((await inj("/api/auth/passcode", { next: "2468" })).statusCode, 401, "no session");

    const un = await inj("/api/auth/unlock", { passcode: "0000" });
    const hdr = { cookie: `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}` };
    assert.equal((await inj("/api/auth/passcode", { next: "24" }, hdr)).statusCode, 400);
    assert.equal((await inj("/api/auth/passcode", { next: "abcd" }, hdr)).statusCode, 400);

    const changed = await inj("/api/auth/passcode", { next: "2468" }, hdr);
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.cookies.find((c) => c.name === COOKIE).value, "", "the session is retired");

    assert.equal((await inj("/api/auth/unlock", { passcode: "0000" })).statusCode, 401, "old code is dead");
    assert.equal((await inj("/api/auth/unlock", { passcode: "2468" })).statusCode, 200);
  } finally {
    await a.close();
    await rm(d, { recursive: true, force: true });
  }
});

// --- errors ---------------------------------------------------------------
test("unknown routes 404 as JSON and leak nothing", async () => {
  const res = await get("/api/does-not-exist");
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "not_found" });
});

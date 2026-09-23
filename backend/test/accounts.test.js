// Many hosts on one deployment: who gets in, what they can do, and the line
// between one host's data and another's. This is the test that has to hold —
// a leak here is one host reading another host's guests' passports.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { signIn } from "./fixtures/session.js";
import { newHandshake, authUrl, readIdToken } from "../src/auth/google.js";
import { newId, nowIso, run, one } from "../src/db/client.js";
import { randomBytes } from "node:crypto";
import { transportForAccount } from "../src/mail/account.js";
import { addDays, toDay } from "../../shared/rules.js";

let dir, app, host, other;
const today = () => toDay(new Date());
const SITE_OWNER = "site@example.com";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-accounts-"));
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`, PLATFORM_OWNER_EMAIL: SITE_OWNER,
    FILE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  host = await signIn(app, { email: "host@example.com", accountName: "Host listings" });
  other = await signIn(app, { email: "other@example.com", accountName: "Other listings" });
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const as = (who, method, url, payload) =>
  app.inject({ method, url, payload, headers: { cookie: who.cookie } });

/** A society, a listing and a booking belonging to one account. */
async function seed(accountId, code) {
  const c = app.db.client, soc = newId("soc"), lst = newId("lst"), bkg = newId("bkg");
  await run(c, `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [soc, accountId, `Soc ${code}`, `desk-${code}@example.com`, "t", nowIso(), nowIso()]);
  await run(c, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [lst, accountId, `Flat ${code}`, "https://a.example/c.ics", soc, nowIso(), nowIso()]);
  await run(c, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`, [bkg, code, lst, addDays(today(), 3), addDays(today(), 6), nowIso(), nowIso()]);
  await run(c, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`,
    [newId("per"), bkg, "Lead guest", nowIso()]);
  return { soc, lst, bkg };
}

// --- the wall between hosts -----------------------------------------------

test("a host sees only their own listings, societies and bookings", async () => {
  await seed(host.accountId, "HMHOST0001");
  await seed(other.accountId, "HMOTHER001");

  const mine = (await as(host, "GET", "/api/bookings")).json();
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].code, "HMHOST0001");

  assert.deepEqual((await as(host, "GET", "/api/listings")).json().map((l) => l.name), ["Flat HMHOST0001"]);
  assert.deepEqual((await as(other, "GET", "/api/societies")).json().map((s) => s.name), ["Soc HMOTHER001"]);
});

test("another host's booking reads as missing, not as forbidden", async () => {
  const theirs = await seed(other.accountId, "HMSECRET99");
  // 404, not 403: a wrong answer would confirm the id exists.
  assert.equal((await as(host, "GET", `/api/bookings/${theirs.bkg}`)).statusCode, 404);
  assert.equal((await as(host, "POST", `/api/bookings/${theirs.bkg}/people`, { adults: 2 })).statusCode, 404);
  assert.equal((await as(host, "POST", `/api/bookings/${theirs.bkg}/send`)).statusCode, 404);
  assert.equal((await as(host, "POST", `/api/bookings/${theirs.bkg}/guest-link/regenerate`)).statusCode, 404);
});

test("a listing cannot be pointed at another host's society", async () => {
  const theirs = await seed(other.accountId, "HMSOC00001");
  const res = await as(host, "POST", "/api/listings",
    { name: "Mine", icalUrl: "https://www.airbnb.com/calendar/ical/9.ics?s=x", societyId: theirs.soc });
  assert.equal(res.statusCode, 400, "or a guest's ID would be emailed to a stranger's gate desk");
  assert.equal(res.json().error, "no_society");
});

test("each account keeps its own check-in and check-out times", async () => {
  await as(host, "PATCH", "/api/settings/times", { checkInTime: "15:00" });
  assert.equal((await as(host, "GET", "/api/settings/times")).json().checkInTime, "15:00");
  assert.equal((await as(other, "GET", "/api/settings/times")).json().checkInTime, "14:00");
});

// --- co-hosts --------------------------------------------------------------

test("a co-host is invited by address and joins on their first sign-in", async () => {
  const invited = await as(host, "POST", "/api/members", { email: "Helper@Example.com" });
  assert.equal(invited.statusCode, 201);
  assert.equal(invited.json().joined, false, "nothing is emailed; they sign in themselves");
  assert.match(invited.json().message, /sign in with Google/i);

  const before = (await as(host, "GET", "/api/members")).json();
  assert.deepEqual(before.invites.map((i) => i.email), ["helper@example.com"], "addresses are matched lowercased");

  // Now they sign in for the first time.
  const helper = await signIn(app, { email: "helper@example.com", name: "Helper" });
  const seen = (await as(host, "GET", "/api/members")).json();
  assert.deepEqual(seen.invites, [], "the invitation is spent");
  assert.deepEqual(seen.members.map((m) => `${m.email}:${m.role}`).sort(),
    ["helper@example.com:admin", "host@example.com:owner"]);
  assert.equal(helper.email, "helper@example.com");
});

test("a co-host works in the host's account but cannot change who has access", async () => {
  await as(host, "POST", "/api/members", { email: "cohost@example.com" });
  const signedIn = await signIn(app, { email: "cohost@example.com" });
  // signIn() would have made them their own account if the invite had not
  // placed them first, so check which one they are actually in.
  const session = (await as(signedIn, "GET", "/api/auth/session")).json();
  assert.equal(session.role, "admin");
  assert.equal(session.account.id, host.accountId);

  assert.equal((await as(signedIn, "GET", "/api/bookings")).statusCode, 200, "they can do the daily work");
  for (const [method, url, payload] of [
    ["POST", "/api/members", { email: "someone@example.com" }],
    ["PATCH", "/api/account", { name: "Renamed" }],
    ["PUT", "/api/mail", { fromEmail: "x@gmail.com", appPassword: "abcdabcdabcdabcd" }],
  ]) {
    const res = await as(signedIn, method, url, payload);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.json().error, "owner_only");
  }
});

test("removing a co-host takes effect on their next request", async () => {
  await as(host, "POST", "/api/members", { email: "temp@example.com" });
  const temp = await signIn(app, { email: "temp@example.com" });
  assert.equal((await as(temp, "GET", "/api/bookings")).statusCode, 200);

  const gone = await as(host, "DELETE", `/api/members/${temp.userId}`);
  assert.equal(gone.statusCode, 200);
  // The cookie is still valid; the membership is not, and that is what counts.
  assert.equal((await as(temp, "GET", "/api/bookings")).statusCode, 401);
});

test("the host cannot be removed from their own account", async () => {
  const res = await as(host, "DELETE", `/api/members/${host.userId}`);
  assert.equal(res.statusCode, 404);
  const members = (await as(host, "GET", "/api/members")).json().members;
  assert.ok(members.some((m) => m.role === "owner"), "there is always an owner");
});

// --- who may start an account ---------------------------------------------

test("only the site owner may approve new hosts", async () => {
  assert.equal((await as(host, "GET", "/api/approvals")).statusCode, 403);
  assert.equal((await as(host, "POST", "/api/approvals", { email: "x@example.com" })).statusCode, 403);

  const site = await signIn(app, { email: SITE_OWNER, accountName: "Site owner" });
  assert.equal((await as(site, "POST", "/api/approvals", { email: "newhost@example.com", note: "a friend" })).statusCode, 201);
  assert.deepEqual((await as(site, "GET", "/api/approvals")).json().rows.map((r) => r.email), ["newhost@example.com"]);
});

test("an unapproved address is turned away; an approved one gets its own account", async () => {
  const turned = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "nobody@example.com" } });
  assert.equal(turned.statusCode, 403);
  assert.equal(turned.json().error, "not_approved");
  assert.equal(await one(app.db.client, "SELECT id FROM users WHERE email = ?", ["nobody@example.com"]) !== null, true,
    "the person is recorded, but with no account they can reach nothing");

  const site = await signIn(app, { email: SITE_OWNER });
  await as(site, "POST", "/api/approvals", { email: "approved@example.com" });
  const allowed = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "approved@example.com" } });
  assert.equal(allowed.statusCode, 200);
  assert.ok(allowed.json().accountId);
});

// --- each host's own sending Gmail ----------------------------------------

test("the app password is encrypted at rest and never handed back", async () => {
  const PASSWORD = "abcd efgh ijkl mnop";
  const saved = await as(host, "PUT", "/api/mail", { fromEmail: "host@gmail.com", appPassword: PASSWORD });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().fromEmail, "host@gmail.com");
  assert.ok(!JSON.stringify(saved.json()).includes("abcd"), "the password is not in the reply");

  const stored = await one(app.db.client, "SELECT smtp_pass_enc FROM account_mail WHERE account_id = ?", [host.accountId]);
  assert.ok(!Buffer.from(stored.smtp_pass_enc).includes("abcd"), "nor in the database");

  const read = (await as(host, "GET", "/api/mail")).json();
  assert.ok(!JSON.stringify(read).includes("abcd"));
  assert.equal(read.verifiedAt, null, "saving proves nothing; only a test email does");
});

test("a host's mail settings are their own, and drive their own sends", async () => {
  await as(host, "PUT", "/api/mail", { fromEmail: "host@gmail.com", appPassword: "abcd efgh ijkl mnop" });
  assert.equal((await as(other, "GET", "/api/mail")).body, "null", "the other host has none");

  // The transport is built from the decrypted password, with the spaces Gmail
  // shows the host stripped out.
  const mine = await app.mailFor(host.accountId);
  assert.equal(mine.from, "host@gmail.com");
  assert.equal(mine.transport.name, "smtp");
  assert.equal((await app.mailFor(other.accountId)).transport.name, "unconfigured",
    "a host who has connected nothing cannot send — it is never faked");
  assert.equal(await transportForAccount(app.db.client, other.accountId, app.fileKey), null);
});

test("disconnecting it stops the account sending at all", async () => {
  await as(host, "PUT", "/api/mail", { fromEmail: "host@gmail.com", appPassword: "abcd efgh ijkl mnop" });
  assert.equal((await as(host, "DELETE", "/api/mail")).statusCode, 200);
  assert.equal((await as(host, "GET", "/api/mail")).body, "null");
  assert.equal((await as(host, "POST", "/api/mail/test")).statusCode, 404, "nothing to test");
});

// --- Google's half ---------------------------------------------------------

test("the Google handshake asks only for identity, and pins the browser that started it", () => {
  const hs = newHandshake();
  const url = new URL(authUrl({ clientId: "cid", redirectUri: "https://x.example/cb", state: hs.state, challenge: hs.challenge }));
  assert.equal(url.searchParams.get("scope"), "openid email profile", "no mailbox, no calendar, no files");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(hs.verifier, hs.challenge, "the verifier is never the thing sent to Google");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("an ID token with an unverified email proves nothing", () => {
  const token = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  assert.equal(readIdToken(token({ email: "a@b.example", email_verified: true })).emailVerified, true);
  assert.equal(readIdToken(token({ email: "a@b.example", email_verified: false })).emailVerified, false);
  assert.equal(readIdToken(token({ name: "no email here" })), null);
  assert.equal(readIdToken("not-a-token"), null);
});

test("the callback refuses a state that did not come from this browser", async () => {
  const res = await app.inject({ method: "GET", url: "/api/auth/google/callback?code=abc&state=forged" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/#signin-failed", "and no session is issued");
  assert.equal(res.cookies.find((c) => c.name === "gp_admin"), undefined);
});

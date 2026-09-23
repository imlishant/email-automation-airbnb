// Guest links must survive what they should, and be re-issued when they can't.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run } from "../src/db/client.js";
import { addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

const GUEST = "g".repeat(40);
async function server(dir, env) {
  return buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500", ...env }), { logger: false });
}
async function seedAndLink(app) {
  // A fresh sign-in per server, since these tests restart it with new secrets.
  acc = (await signIn(app)).accountId;
  const c = app.db.client, soc = newId("soc"), lst = newId("lst"), bkg = newId("bkg");
  await run(c, `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [soc, acc, "S", "d@x.example", "t", nowIso(), nowIso()]);
  await run(c, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [lst, acc, "L", "https://a.example/c.ics", soc, nowIso(), nowIso()]);
  await run(c, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [bkg, "HMSECRET01", lst, addDays(toDay(new Date()), 2), addDays(toDay(new Date()), 5), nowIso(), nowIso()]);
  await run(c, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`, [newId("per"), bkg, "Lead guest", nowIso()]);
  return bkg;
}
async function linkFor(app, bkg) {
  const { cookie } = await signIn(app);
  return (await app.inject({ method: "GET", url: `/api/bookings/${bkg}`, headers: { cookie } })).json().guestLink.token;
}

test("rotating SESSION_SECRET logs admins out but does NOT kill guest links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-gs1-"));
  let a = await server(dir, { SESSION_SECRET: "a".repeat(40), GUEST_TOKEN_SECRET: GUEST });
  const bkg = await seedAndLink(a);
  const token = await linkFor(a, bkg);
  await a.close();

  // The emergency control: a new session secret.
  a = await server(dir, { SESSION_SECRET: "b".repeat(40), GUEST_TOKEN_SECRET: GUEST });
  const guest = await a.inject({ method: "GET", url: `/u/${token}` });
  assert.equal(guest.statusCode, 200, "a guest link already sent to someone at a gate must keep working");
  await a.close(); await rm(dir, { recursive: true, force: true });
});

test("rotating GUEST_TOKEN_SECRET kills old links, and the admin is handed a fresh working one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-gs2-"));
  let a = await server(dir, { GUEST_TOKEN_SECRET: GUEST });
  const bkg = await seedAndLink(a);
  const oldToken = await linkFor(a, bkg);
  await a.close();

  a = await server(dir, { GUEST_TOKEN_SECRET: "h".repeat(40) });
  assert.equal((await a.inject({ method: "GET", url: `/u/${oldToken}` })).statusCode, 404, "the old link is dead, as intended");
  const fresh = await linkFor(a, bkg);
  assert.notEqual(fresh, oldToken, "the admin is not handed the dead link to copy");
  assert.equal((await a.inject({ method: "GET", url: `/u/${fresh}` })).statusCode, 200);
  await a.close(); await rm(dir, { recursive: true, force: true });
});

test("production refuses to start without GUEST_TOKEN_SECRET", () => {
  const cfg = loadConfig({ NODE_ENV: "production", SESSION_SECRET: "s".repeat(40), JOBS_TICK_SECRET: "j".repeat(20),
    APP_BASE_URL: "https://x.example", FILE_ENCRYPTION_KEY: "k", STORAGE_DRIVER: "s3" });
  assert.ok(cfg.fatal.some((f) => /GUEST_TOKEN_SECRET/.test(f)), cfg.fatal.join("; "));
});

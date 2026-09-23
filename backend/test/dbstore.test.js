// Encrypted ID photos stored in the database: the path production now takes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run, one } from "../src/db/client.js";
import { recordingTransport } from "../src/mail/transport.js";
import { purgeExpired } from "../src/jobs/purge.js";
import { addDays, toDay } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

let dir, app, cookie, bkg, per;
const today = () => toDay(new Date());

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gp-dbstore-"));
  app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`, STORAGE_DRIVER: "db",
    FILE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), MAIL_FROM: "h@example.com",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500" }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  cookie = session.cookie;
  app.mail = recordingTransport();
  const c = app.db.client, soc = newId("soc"), lst = newId("lst"); bkg = newId("bkg"); per = newId("per");
  await run(c, `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [soc, acc, "S", "d@x.example", "t", nowIso(), nowIso()]);
  await run(c, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [lst, acc, "L", "https://a.example/c.ics", soc, nowIso(), nowIso()]);
  await run(c, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [bkg, "HMDBSTORE1", lst, addDays(today(), 2), addDays(today(), 5), nowIso(), nowIso()]);
  await run(c, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`, [per, bkg, "Priya Menon", nowIso()]);
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.from("PASSPORT-A1234567 "), randomBytes(200), Buffer.from([0xff, 0xd9])]);
function upload() {
  const b = "----t" + randomBytes(6).toString("hex");
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="docType"\r\n\r\nPassport\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\n\r\n`),
    photo, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: "POST", url: `/api/bookings/${bkg}/people/${per}/upload`, payload,
    headers: { cookie, "content-type": `multipart/form-data; boundary=${b}` } });
}

test("production uses the database for files by default", () => {
  const cfg = loadConfig({ NODE_ENV: "production" });
  assert.equal(cfg.storage.driver, "db");
  assert.ok(!cfg.fatal.some((f) => /STORAGE_DRIVER/.test(f)), "db is a valid production choice");
  assert.ok(loadConfig({ NODE_ENV: "production", STORAGE_DRIVER: "local" }).fatal.some((f) => /wiped on restart/.test(f)));
});

test("an upload lands in the database encrypted — the ID is never readable there", async () => {
  assert.equal((await upload()).statusCode, 200);
  const blob = await one(app.db.client, "SELECT bytes FROM file_blobs");
  const stored = Buffer.from(blob.bytes);
  assert.ok(!stored.includes("PASSPORT-A1234567"), "ciphertext only");
  assert.notEqual(stored[0], 0xff, "not even the JPEG header survives");
});

test("an admin reads it back decrypted, and the send attaches it", async () => {
  const docId = (await one(app.db.client, "SELECT id FROM documents WHERE person_id = ?", [per])).id;
  const read = await app.inject({ method: "GET", url: `/api/documents/${docId}`, headers: { cookie } });
  assert.equal(read.statusCode, 200);
  assert.ok(read.rawPayload.includes("PASSPORT-A1234567"), "decrypted on the way out");

  const sent = await app.inject({ method: "POST", url: `/api/bookings/${bkg}/send`, headers: { cookie } });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.ok(app.mail.sent[0].attachments[0].content.includes("PASSPORT-A1234567"));
});

test("the retention purge deletes the stored bytes too", async () => {
  await run(app.db.client, "UPDATE bookings SET check_in = ?, check_out = ? WHERE id = ?", [addDays(today(), -6), addDays(today(), -3), bkg]);
  const res = await purgeExpired(app.db.client, { store: app.files });
  assert.equal(res[0].purged, true);
  assert.equal(Number((await one(app.db.client, "SELECT COUNT(*) AS n FROM file_blobs")).n), 0, "no ID bytes left anywhere");
});

// Sending the security email. The refusals matter more than the happy path:
// an email with a missing ID is worse than no email at all.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run, one } from "../src/db/client.js";
import { attachmentName, buildAttachments, AttachmentsUnavailable } from "../src/mail/attachments.js";
import { localStore } from "../src/files/store.js";
import { encrypt, loadKey } from "../src/files/crypto.js";
import { addDays, toDay, fillTemplate } from "../../shared/rules.js";
import { signIn } from "./fixtures/session.js";
let acc;   // the signed-in account every row below belongs to

const KEY = randomBytes(32).toString("base64");
const today = () => toDay(new Date());
let dir, uploads, app, client, auth, sink, sinkPort, soc, lst, bkg, lead;

/**
 * A minimal SMTP sink: enough of the protocol for nodemailer to deliver, so the
 * tests exercise real SMTP rather than a mock of it.
 */
const received = [];
function startSink() {
  return new Promise((resolve) => {
    sink = createServer((socket) => {
      let data = "", inData = false;
      socket.write("220 sink ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            inData = false;
            received.push(data);
            data = "";
            socket.write("250 OK queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const verb = line.split(" ")[0].toUpperCase();
          if (verb === "EHLO" || verb === "HELO") socket.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (verb === "AUTH") socket.write("235 authenticated\r\n");
          else if (verb === "DATA") { inData = true; socket.write("354 go ahead\r\n"); }
          else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
          else socket.write("250 OK\r\n");
        }
      });
      socket.on("error", () => {});
    });
    sink.listen(0, "127.0.0.1", () => resolve(sink.address().port));
  });
}

before(async () => {
  sinkPort = await startSink();
  dir = await mkdtemp(join(tmpdir(), "gatepass-mail-"));
  uploads = join(dir, "uploads");
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`, FILE_ENCRYPTION_KEY: KEY, UPLOAD_DIR: uploads,
    MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sinkPort),
    SMTP_USER: "host@example.com", SMTP_PASS: "app-password", SMTP_IGNORE_TLS: "true",
    MAIL_FROM: "Arjun K. <host@example.com>", MAIL_MAX_ATTACHMENT_BYTES: "50000",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500",
  }), { logger: false });
  const session = await signIn(app);
  acc = session.accountId;
  auth = { cookie: session.cookie };
  client = app.db.client;
});
after(async () => { await app?.close(); sink?.close(); await rm(dir, { recursive: true, force: true }); });

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(300), Buffer.from([0xff, 0xd9])]);

beforeEach(async () => {
  received.length = 0;
  for (const t of ["documents", "people", "activity", "bookings", "listings", "societies"]) await run(client, `DELETE FROM ${t}`);
  soc = newId("soc"); lst = newId("lst"); bkg = newId("bkg"); lead = newId("per");
  await run(client, `INSERT INTO societies (id,account_id,name,desk_email_to,desk_email_cc,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [soc, acc, "Greenwood Society", "desk@greenwood.example", "cc@greenwood.example",
     "Dear Security Team,\n\nIDs for {{listing}}, booking {{booking_id}}, {{adult_count}} adult(s).", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [lst, acc, "Sea Breeze 2BHK", "https://airbnb.com/c.ics", soc, nowIso(), nowIso()]);
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,created_at,updated_at)
    VALUES (?,?,?,?,?,0,'allids',?,?)`, [bkg, "HMMAIL0001", lst, addDays(today(), 2), addDays(today(), 5), nowIso(), nowIso()]);
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`, [bkg && lead, bkg, "Priya Menon", nowIso()]);
});

async function storeDocument(personId, { bytes = jpeg(), docType = "Aadhaar", contentType = "image/jpeg" } = {}) {
  const ref = `test/${randomBytes(8).toString("hex")}`;
  await localStore({ dir: uploads }).put(ref, encrypt(bytes, loadKey(KEY)));
  await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,byte_size,content_type,uploaded_at,uploaded_by,created_at)
    VALUES (?,?,?,?,?,?,?,'admin',?)`, [newId("doc"), personId, docType, ref, bytes.length, contentType, nowIso(), nowIso()]);
  return ref;
}
const send = () => app.inject({ method: "POST", url: `/api/bookings/${bkg}/send`, headers: auth });

// --- filenames a desk can use --------------------------------------------
test("an attachment is named so a desk can match it to a person", () => {
  assert.equal(attachmentName("Priya Menon", "Aadhaar", "image/jpeg"), "Priya_Menon_Aadhaar.jpg");
  assert.equal(attachmentName("Rohit  Menon", "Driving licence", "application/pdf"), "Rohit_Menon_Driving_licence.pdf");
  // Nothing from a name can escape into the filename.
  assert.equal(attachmentName("../../etc/passwd", "Aadhaar", "image/png"), "etcpasswd_Aadhaar.png");
  assert.equal(attachmentName("", "Aadhaar", "image/jpeg"), "guest_Aadhaar.jpg");
});

// --- the refusals ---------------------------------------------------------
test("a missing ID file refuses the whole send", async () => {
  const ref = await storeDocument(lead);
  await localStore({ dir: uploads }).remove(ref);      // the bytes vanish

  const res = await send();
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, "file_missing");
  assert.match(res.json().message, /Priya Menon/, "it names whose file is missing");
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [bkg])).sent_at, null);
  assert.equal(received.length, 0, "nothing was sent at all — a partial send is worse than none");
});

test("an ID that cannot be decrypted refuses the send", async () => {
  const ref = `test/${randomBytes(8).toString("hex")}`;
  await localStore({ dir: uploads }).put(ref, Buffer.concat([randomBytes(28), Buffer.from("not really ciphertext")]));
  await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,content_type,uploaded_at,uploaded_by,created_at)
    VALUES (?,?,?,?,?,?,'admin',?)`, [newId("doc"), lead, "Aadhaar", ref, "image/jpeg", nowIso(), nowIso()]);

  const res = await send();
  assert.equal(res.json().error, "undecryptable");
  assert.equal(received.length, 0);
});

test("a deleted ID file refuses the send rather than sending without it", async () => {
  await run(client, `INSERT INTO documents (id,person_id,doc_type,file_ref,content_type,uploaded_at,uploaded_by,created_at,deleted_at)
    VALUES (?,?,?,NULL,?,?,'admin',?,?)`, [newId("doc"), lead, "Aadhaar", "image/jpeg", nowIso(), nowIso(), nowIso()]);
  const res = await send();
  assert.equal(res.json().error, "file_deleted");
  assert.equal(received.length, 0);
});

test("attachments over the provider's limit are refused with a usable message", async () => {
  await storeDocument(lead, { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(60000)]) });
  const res = await send();
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error, "too_large");
  assert.match(res.json().message, /smaller photos/, "it says what to do about it");
  assert.equal(received.length, 0);
});

// --- real delivery --------------------------------------------------------
test("a complete booking is delivered over SMTP, with the ID attached", async () => {
  await storeDocument(lead);
  const res = await send();
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  assert.equal(res.json().attachments, 1);

  assert.equal(received.length, 1, "it really went over SMTP");
  const wire = received[0];
  assert.match(wire, /^To: desk@greenwood\.example/m);
  assert.match(wire, /^Cc: cc@greenwood\.example/m);
  assert.match(wire, /From: "Arjun K\." <host@example\.com>/);
  // Plain ASCII, so it is not RFC 2047 encoded — an old desk mailbox reads it
  // as written.
  assert.match(wire, /^Subject: Guest IDs - Sea Breeze 2BHK - arriving \d{4}-\d{2}-\d{2}$/m);
  assert.doesNotMatch(wire, /Subject: =\?UTF-8/, "the subject must not need decoding");
  assert.match(wire, /Priya_Menon_Aadhaar\.jpg/, "the attachment is named for the desk");
  assert.match(wire, /Content-Type: image\/jpeg/);
  assert.match(wire, /base64/, "the file is encoded into the message");
  // The template was filled with the booking's values.
  assert.ok(/SURzIGZvciBTZWEgQnJlZXpl/.test(wire.replace(/=\r\n/g, "")) || /IDs for Sea Breeze 2BHK/.test(wire),
    "the society's template reached the body");

  const row = await one(client, "SELECT sent_at, sent_to FROM bookings WHERE id = ?", [bkg]);
  assert.ok(row.sent_at, "recorded only after delivery");
  assert.equal(row.sent_to, "desk@greenwood.example");
});

test("two adults means two attachments, both named", async () => {
  const second = newId("per");
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,0,?)`,
    [second, bkg, "Rohit Menon", nowIso()]);
  await storeDocument(lead);
  await storeDocument(second, { docType: "Passport", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.7\nx") });

  const res = await send();
  assert.equal(res.json().attachments, 2);
  assert.match(received[0], /Priya_Menon_Aadhaar\.jpg/);
  assert.match(received[0], /Rohit_Menon_Passport\.pdf/);
});

test("an SMTP failure leaves the booking unsent", async () => {
  await storeDocument(lead);
  const good = app.mail;
  app.mail = { name: "smtp", configured: true, async send() { const e = new Error("550 mailbox unavailable"); e.code = "smtp_failed"; throw e; } };
  const res = await send();
  assert.equal(res.statusCode, 400);
  assert.equal((await one(client, "SELECT sent_at FROM bookings WHERE id = ?", [bkg])).sent_at, null);
  app.mail = good;
});

// --- the unit under it ----------------------------------------------------
test("buildAttachments refuses rather than returning a partial set", async () => {
  const store = localStore({ dir: uploads });
  const key = loadKey(KEY);
  const ref = `test/${randomBytes(8).toString("hex")}`;
  await store.put(ref, encrypt(jpeg(), key));

  const people = [
    { id: "p1", name: "Priya Menon", documentType: "Aadhaar", fileRef: ref, contentType: "image/jpeg" },
    { id: "p2", name: "Rohit Menon", documentType: "Passport", fileRef: "test/does-not-exist", contentType: "image/jpeg" },
  ];
  await assert.rejects(buildAttachments(people, { store, key, maxTotalBytes: 1e6 }),
    (e) => e instanceof AttachmentsUnavailable && e.code === "file_missing");

  // With no documents at all there is nothing to send.
  await assert.rejects(buildAttachments([{ id: "p1", name: "X", documentType: null }], { store, key }),
    (e) => e.code === "no_documents");
});

test("every adult is named in the body, not only on the attachments", async () => {
  // Societies require the names in the text; an unnamed adult is still listed,
  // because a list shorter than the adult count reads as a mistake at a gate.
  const template = "Guests: {{guest_names}}\n\n{{guest_list}}\n\nTotal {{adult_count}}.";
  const b = {
    listingName: "Flat 1", code: "HM1", checkIn: "2026-10-01", checkOut: "2026-10-04",
    people: [{ name: "Viji" }, { name: "Srikant" }, { name: "Lead guest" }],
  };
  const body = fillTemplate(template, b, (iso) => iso);
  assert.match(body, /Guests: Viji, Srikant, \(name not given\)/);
  assert.match(body, /1\. Viji\n2\. Srikant\n3\. \(name not given\)/);
  assert.match(body, /Total 3\./);
});

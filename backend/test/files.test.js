// Storing an ID document. This is the code that holds passports, so most of
// these tests are about what it refuses.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { COOKIE } from "../src/http/session.js";
import { newId, nowIso, run, one } from "../src/db/client.js";
import { encrypt, decrypt, loadKey, HEADER_BYTES } from "../src/files/crypto.js";
import { sniff, stripJpegMetadata, hasExif } from "../src/files/sniff.js";
import { receiveDocument, readCapped, UploadRejected } from "../src/files/receive.js";
import { localStore, newFileRef } from "../src/files/store.js";
import { addDays, toDay } from "../../shared/rules.js";

const KEY = randomBytes(32).toString("base64");
let dir, app, client, auth, uploads, soc, lst, bkg, lead;
const today = () => toDay(new Date());

// --- fixtures: real file headers, not strings -----------------------------
const jpegBody = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(200), Buffer.from([0xff, 0xd9])]);
function jpegWithExif() {
  const exif = Buffer.alloc(120, 0x41);
  exif.write("Exif\0\0", 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(exif.length + 2); return b; })(), exif]);
  const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x08]), randomBytes(64), Buffer.from([0xff, 0xd9])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]), scan]);
}
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(100)]);
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(100)]);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "gatepass-files-"));
  uploads = join(dir, "uploads");
  app = await buildServer(loadConfig({
    DATABASE_URL: `file:${join(dir, "t.db")}`, FILE_ENCRYPTION_KEY: KEY, UPLOAD_DIR: uploads,
    UPLOAD_MAX_BYTES: "20000",
    RATE_LIMIT_GLOBAL_PER_MINUTE: "5000", RATE_LIMIT_AUTH_PER_MINUTE: "500", RATE_LIMIT_GUEST_PER_MINUTE: "500",
  }), { logger: false });
  client = app.db.client;
  const un = await app.inject({ method: "POST", url: "/api/auth/unlock", payload: { passcode: "0000" } });
  auth = { cookie: `${COOKIE}=${un.cookies.find((c) => c.name === COOKIE).value}` };
});
after(async () => { await app?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  for (const t of ["documents", "people", "activity", "bookings", "listings", "societies", "guest_links"]) await run(client, `DELETE FROM ${t}`);
  soc = newId("soc"); lst = newId("lst"); bkg = newId("bkg"); lead = newId("per");
  await run(client, `INSERT INTO societies (id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [soc, "Greenwood", "desk@greenwood.example", "Dear {{listing}}", nowIso(), nowIso()]);
  await run(client, `INSERT INTO listings (id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [lst, "Sea Breeze", "https://airbnb.com/c.ics", soc, nowIso(), nowIso()]);
  await run(client, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,created_at,updated_at)
    VALUES (?,?,?,?,?,0,'allids',?,?)`, [bkg, "HMFILE0001", lst, addDays(today(), 2), addDays(today(), 5), nowIso(), nowIso()]);
  await run(client, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,1,?)`, [lead, bkg, "Lead guest", nowIso()]);
});

/** Build a multipart body by hand — no client library involved. */
function multipart(bytes, { docType = "Aadhaar", filename = "id.jpg" } = {}) {
  const b = "----gatepass" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="docType"\r\n\r\n${docType}\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${b}--\r\n`)]),
           headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}
const upload = (bytes, opts) => {
  const m = multipart(bytes, opts);
  return app.inject({ method: "POST", url: `/api/bookings/${bkg}/people/${lead}/upload`,
                      payload: m.payload, headers: { ...m.headers, ...auth } });
};

// --- encryption -----------------------------------------------------------
test("encryption round-trips, and the plaintext never appears in the stored bytes", () => {
  const key = loadKey(KEY);
  const plain = Buffer.from("PASSPORT NUMBER A1234567");
  const stored = encrypt(plain, key);
  assert.equal(stored.includes("PASSPORT"), false, "the stored file must not contain readable content");
  assert.equal(stored.length, plain.length + HEADER_BYTES);
  assert.deepEqual(decrypt(stored, key), plain);
});

test("every file gets a fresh IV, so identical documents do not look identical", () => {
  const key = loadKey(KEY);
  const plain = Buffer.from("same bytes");
  assert.notDeepEqual(encrypt(plain, key), encrypt(plain, key));
});

test("tampered or truncated ciphertext fails loudly instead of returning garbage", () => {
  const key = loadKey(KEY);
  const stored = encrypt(Buffer.from("an identity document"), key);
  const flipped = Buffer.from(stored); flipped[flipped.length - 1] ^= 0xff;
  assert.throws(() => decrypt(flipped, key), /auth|unable/i, "GCM must reject altered bytes");
  assert.throws(() => decrypt(stored.subarray(0, 10), key), /truncated/);
  assert.throws(() => decrypt(stored, loadKey(randomBytes(32).toString("base64"))), /auth|unable/i);
});

test("a key of the wrong length is refused at load, not at first use", () => {
  assert.throws(() => loadKey(randomBytes(16).toString("base64")), /32 bytes/);
  assert.equal(loadKey(""), null);
});

// --- what is actually in the file ----------------------------------------
test("the bytes decide the type, not the filename", () => {
  assert.equal(sniff(jpegBody()).type, "image/jpeg");
  assert.equal(sniff(png()).type, "image/png");
  assert.equal(sniff(pdf()).type, "application/pdf");
  // A script named id.jpg is still a script.
  assert.equal(sniff(Buffer.from("#!/bin/sh\nrm -rf /                    ")), null);
  assert.equal(sniff(Buffer.from("<!doctype html><html><body>hello</body>")), null);
  assert.equal(sniff(Buffer.alloc(4)), null, "too short to judge");
});

test("JPEG metadata is stripped, because a photo of a passport carries GPS", () => {
  const withExif = jpegWithExif();
  assert.equal(hasExif(withExif), true);
  const cleaned = stripJpegMetadata(withExif);
  assert.equal(hasExif(cleaned), false);
  assert.ok(cleaned.length < withExif.length);
  assert.equal(cleaned[0], 0xff); assert.equal(cleaned[1], 0xd8);   // still a JPEG
  assert.equal(sniff(cleaned).type, "image/jpeg");
  // A file with no metadata is left alone.
  const plain = jpegBody();
  assert.deepEqual(stripJpegMetadata(plain), plain);
});

// --- the receive pipeline -------------------------------------------------
test("a document is stored encrypted under an opaque ref", async () => {
  const store = localStore({ dir: uploads });
  const res = await receiveDocument(jpegBody(), {
    store, key: loadKey(KEY), allowedTypes: ["image/jpeg"], maxBytes: 20000,
  });
  assert.match(res.ref, /^\d{4}-\d{2}\/[0-9a-f]{32}$/, "opaque: no name, no booking code, not guessable");
  const onDisk = await readFile(join(uploads, res.ref));
  assert.notDeepEqual(onDisk.subarray(0, 4), jpegBody().subarray(0, 4), "not stored in the clear");
  assert.equal(decrypt(onDisk, loadKey(KEY))[0], 0xff);
});

test("without an encryption key, uploads are refused rather than stored in the clear", async () => {
  await assert.rejects(
    receiveDocument(jpegBody(), { store: localStore({ dir: uploads }), key: null, allowedTypes: [], maxBytes: 20000 }),
    (e) => e instanceof UploadRejected && e.code === "not_configured");
});

test("readCapped stops at the limit instead of buffering a hostile upload", async () => {
  const { Readable } = await import("node:stream");
  const big = Readable.from([randomBytes(5000), randomBytes(5000)]);
  await assert.rejects(readCapped(big, 6000), (e) => e.code === "too_large");
  await assert.rejects(readCapped(Readable.from([]), 100), (e) => e.code === "empty");
});

test("a store refuses a ref that escapes its directory", async () => {
  const store = localStore({ dir: uploads });
  await assert.rejects(store.put("../../escaped", Buffer.from("x")), /outside the upload directory/);
});

// --- over HTTP ------------------------------------------------------------
test("an admin upload stores the file and records the document", async () => {
  const res = await upload(jpegBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().replaced, false);

  const doc = await one(client, "SELECT * FROM documents WHERE person_id = ?", [lead]);
  assert.equal(doc.doc_type, "Aadhaar");
  assert.equal(doc.content_type, "image/jpeg");
  assert.ok(doc.file_ref, "the bytes were stored before the row was written");
  assert.equal(doc.uploaded_by, "admin");
});

test("uploading again replaces, leaving one document for the person", async () => {
  await upload(jpegBody());
  const again = await upload(pdf(), { docType: "Passport" });
  assert.equal(again.json().replaced, true);
  const { rows } = await client.execute({ sql: "SELECT id FROM documents WHERE person_id = ?", args: [lead] });
  assert.equal(rows.length, 1, "one ID per adult");
});

test("a file that is not a photo or a PDF is refused", async () => {
  const res = await upload(Buffer.from("#!/bin/sh\necho pwned                       "), { filename: "id.jpg" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "unsupported_type");
  assert.equal(await one(client, "SELECT id FROM documents WHERE person_id = ?", [lead]), null,
    "nothing recorded when the bytes are refused");
});

test("an oversized file is refused with a message a guest can act on", async () => {
  const res = await upload(Buffer.concat([jpegBody(), randomBytes(30000)]));
  assert.equal(res.statusCode, 413);
  assert.match(res.json().message, /larger than/);
});

test("a missing file or doc type is refused", async () => {
  const m = multipart(jpegBody(), { docType: "" });
  const noType = await app.inject({ method: "POST", url: `/api/bookings/${bkg}/people/${lead}/upload`,
                                    payload: m.payload, headers: { ...m.headers, ...auth } });
  assert.equal(noType.statusCode, 400);
  assert.equal(noType.json().error, "no_doc_type");
});

test("EXIF is stripped on the way in, even when the browser did not", async () => {
  const withExif = jpegWithExif();
  assert.equal(hasExif(withExif), true, "the fixture really has EXIF");
  await upload(withExif);
  const doc = await one(client, "SELECT file_ref FROM documents WHERE person_id = ?", [lead]);
  const stored = decrypt(await readFile(join(uploads, doc.file_ref)), loadKey(KEY));
  assert.equal(hasExif(stored), false, "the GPS in a passport photo must not be kept");
});

test("uploading is refused once the booking is past its window", async () => {
  await run(client, "UPDATE bookings SET check_in = ?, check_out = ? WHERE id = ?",
    [addDays(today(), -6), addDays(today(), -3), bkg]);
  const res = await upload(jpegBody());
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "window_closed");
});

// --- reading one back -----------------------------------------------------
test("only an admin can read a document back", async () => {
  await upload(jpegBody());
  const docId = (await one(client, "SELECT id FROM documents WHERE person_id = ?", [lead])).id;

  const anon = await app.inject({ method: "GET", url: `/api/documents/${docId}` });
  assert.equal(anon.statusCode, 401, "a guest can put an ID in and never take one out");

  const asAdmin = await app.inject({ method: "GET", url: `/api/documents/${docId}`, headers: auth });
  assert.equal(asAdmin.statusCode, 200);
  assert.equal(asAdmin.headers["content-type"], "image/jpeg");
  assert.match(asAdmin.headers["cache-control"], /no-store/, "an ID must never sit in a cache");
  assert.equal(asAdmin.rawPayload[0], 0xff, "decrypted on the way out");
});

test("a deleted file reports gone, and the record survives to prove it was sent", async () => {
  await upload(jpegBody());
  const docId = (await one(client, "SELECT id FROM documents WHERE person_id = ?", [lead])).id;

  const del = await app.inject({ method: "DELETE", url: `/api/documents/${docId}/file`, headers: auth });
  assert.equal(del.statusCode, 200);

  const doc = await one(client, "SELECT doc_type, file_ref, deleted_at FROM documents WHERE id = ?", [docId]);
  assert.equal(doc.doc_type, "Aadhaar", "we still know what was collected");
  assert.equal(doc.file_ref, null);
  assert.ok(doc.deleted_at);

  const read = await app.inject({ method: "GET", url: `/api/documents/${docId}`, headers: auth });
  assert.equal(read.statusCode, 410);
  assert.equal(read.json().error, "deleted");
});

// --- the guest path -------------------------------------------------------
test("a guest uploads through their token, with the same checks", async () => {
  const detail = await app.inject({ method: "GET", url: `/api/bookings/${bkg}`, headers: auth });
  const token = detail.json().guestLink.token;

  const m = multipart(jpegWithExif(), { docType: "Passport" });
  const res = await app.inject({ method: "POST", url: `/u/${token}/people/${lead}/upload`,
                                 payload: m.payload, headers: m.headers });
  assert.equal(res.statusCode, 200);

  const doc = await one(client, "SELECT doc_type, uploaded_by, file_ref FROM documents WHERE person_id = ?", [lead]);
  assert.equal(doc.uploaded_by, "guest");
  assert.equal(doc.doc_type, "Passport");
  const stored = decrypt(await readFile(join(uploads, doc.file_ref)), loadKey(KEY));
  assert.equal(hasExif(stored), false, "a guest's photo is stripped too");

  // A forged token gets nothing, and a bad file through a good token is refused.
  const forged = multipart(jpegBody());
  assert.equal((await app.inject({ method: "POST", url: `/u/forged.token/people/${lead}/upload`,
    payload: forged.payload, headers: forged.headers })).statusCode, 404);
  const bad = multipart(Buffer.from("not a file at all, just some text here"));
  assert.equal((await app.inject({ method: "POST", url: `/u/${token}/people/${lead}/upload`,
    payload: bad.payload, headers: bad.headers })).statusCode, 400);
});

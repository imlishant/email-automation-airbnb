#!/usr/bin/env node
// ---------------------------------------------------------------------------
//   npm run loadtest            realistic size and 100x, side by side
//   npm run loadtest -- 250     a custom multiplier
//
// Seeds a THROWAWAY database, drives the real server in-process, and checks the
// performance budgets in docs/TECH_STACK.md §4. Server time only — network
// latency to Turso comes on top in production, which is why the budgets have
// headroom.
// ---------------------------------------------------------------------------
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/http/config.js";
import { buildServer } from "../src/http/server.js";
import { signIn, seedAccount } from "../test/fixtures/session.js";
import { newId, nowIso, openDatabase, applyPragmas } from "../src/db/client.js";
import { migrate, seedFirstRun } from "../src/db/migrate.js";
import { spawn, execSync } from "node:child_process";

// A realistic host today: 2 listings, ~15 upcoming bookings.
const BASE = { listings: 2, bookings: 15 };
const RUNS = 60;

const BUDGET = {
  listP95: 120, detailP95: 90, queriesPerRequest: 3,
  jsGzKB: 35, cssGzKB: 12,
  // Half of Render's 512MB free instance. The original 150MB was set without
  // measuring; the server's baseline alone is ~172MB (docs/TECH_STACK.md §4).
  rssMB: 256,
};

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const p = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function seed(client, { listings, bookings }, accountId) {
  const soc = newId("soc");
  const at = nowIso();
  const stmts = [{ sql: `INSERT INTO societies (id,account_id,name,desk_email_to,template,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
                   args: [soc, accountId, "Load Society", "desk@load.example", "Dear {{listing}}", at, at] }];
  const lst = [];
  for (let i = 0; i < listings; i++) {
    const id = newId("lst"); lst.push(id);
    stmts.push({ sql: `INSERT INTO listings (id,account_id,name,ical_url,society_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
                 args: [id, accountId, `Listing ${i}`, "https://airbnb.example/c.ics", soc, at, at] });
  }
  for (let i = 0; i < bookings; i++) {
    const id = newId("bkg");
    const ci = 1 + (i % 360);                       // spread across the coming year: all visible, the worst case
    stmts.push({ sql: `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,automation,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?)`,
                 args: [id, `HM${i}${randomBytes(3).toString("hex")}`.toUpperCase(), lst[i % lst.length], day(ci), day(ci + 2 + (i % 4)),
                        i % 2 ? "before" : "allids", at, at] });
    const adults = 1 + (i % 4);
    for (let a = 0; a < adults; a++) {
      const per = newId("per");
      stmts.push({ sql: `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,?,?)`,
                   args: [per, id, a === 0 ? `Guest ${i}` : `Adult ${a + 1}`, a === 0 ? 1 : 0, at] });
      if ((i + a) % 2 === 0) {
        stmts.push({ sql: `INSERT INTO documents (id,person_id,doc_type,file_ref,content_type,uploaded_at,uploaded_by,created_at)
                           VALUES (?,?,?,?,?,?,'guest',?)`, args: [newId("doc"), per, "Aadhaar", "x/y", "image/jpeg", at, at] });
      }
    }
    stmts.push({ sql: `INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)`,
                 args: [newId("act"), id, at, "sync", "system", "Booking synced from Airbnb"] });
  }
  for (let i = 0; i < stmts.length; i += 500) await client.batch(stmts.slice(i, i + 500), "write");
  return lst;
}

async function measure(multiplier) {
  const size = { listings: BASE.listings * multiplier, bookings: BASE.bookings * multiplier };
  const dir = await mkdtemp(join(tmpdir(), "gp-load-"));
  const app = await buildServer(loadConfig({ DATABASE_URL: `file:${join(dir, "t.db")}`,
    RATE_LIMIT_GLOBAL_PER_MINUTE: "1000000", RATE_LIMIT_AUTH_PER_MINUTE: "1000" }), { logger: false });
  try {
    const client = app.db.client;
    const session = await signIn(app);
    const listings = await seed(client, size, session.accountId);
    const headers = { cookie: session.cookie };

    // Count database round trips per request: the cost that matters once the
    // database is a network hop away.
    let queries = 0;
    const exec = client.execute.bind(client), batch = client.batch.bind(client);
    client.execute = (...a) => { queries++; return exec(...a); };
    client.batch = (...a) => { queries++; return batch(...a); };   // one round trip

    async function time(url) {
      const ms = [], q = [];
      for (let i = 0; i < RUNS; i++) {
        queries = 0;
        const t0 = process.hrtime.bigint();
        const res = await app.inject({ method: "GET", url, headers });
        ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
        q.push(queries);
        if (res.statusCode !== 200) throw new Error(`${url} -> ${res.statusCode}`);
      }
      return { p50: p(ms, 0.5), p95: p(ms, 0.95), queries: Math.max(...q) };
    }

    const first = (await app.inject({ method: "GET", url: "/api/bookings", headers })).json();
    const result = {
      size,
      list: await time("/api/bookings"),
      listFiltered: await time(`/api/bookings?listingId=${listings[0]}`),
      page2: await time(`/api/bookings?cursor=${encodeURIComponent(first.nextCursor || "")}`),
      detail: await time(`/api/bookings/${first.rows[0].id}`),
    };
    client.execute = exec; client.batch = batch;
    return result;
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The server's own memory: a real `node src/index.js` process serving the big
 * dataset, measured with ps after it has answered a burst of requests.
 */
async function serverMemory(multiplier) {
  const dir = await mkdtemp(join(tmpdir(), "gp-mem-"));
  const url = `file:${join(dir, "t.db")}`;
  const db = openDatabase({ url });
  await applyPragmas(db); await migrate(db);
  await seedFirstRun(db, { passcodeHash: "x", checkInTime: "14:00", checkOutTime: "11:00" });
  const accountId = await seedAccount(db.client);
  await seed(db.client, { listings: BASE.listings * multiplier, bookings: BASE.bookings * multiplier }, accountId);
  db.client.close();
  const port = 18000 + (process.pid % 1000);
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: url, PORT: String(port), RATE_LIMIT_GLOBAL_PER_MINUTE: "100000", NODE_ENV: "development" },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    // The child process signs itself in the way a browser would locally.
    const un = await fetch(`http://127.0.0.1:${port}/api/auth/dev-login`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "host@example.com" }) });
    const cookie = un.headers.get("set-cookie").split(";")[0];
    for (let i = 0; i < 100; i++) await (await fetch(`http://127.0.0.1:${port}/api/bookings`, { headers: { cookie } })).arrayBuffer();
    return Number(execSync(`ps -o rss= -p ${child.pid}`).toString().trim()) / 1024;
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

async function assetSizes() {
  const root = join(import.meta.dirname, "..", "..");
  const js = await Promise.all(["frontend/js/app.js", "frontend/js/data.js", "frontend/js/config.js", "frontend/js/upload.js", "shared/rules.js"]
    .map(async (f) => gzipSync(await readFile(join(root, f))).length));
  const css = gzipSync(await readFile(join(root, "frontend/css/styles.css"))).length;
  return { jsGzKB: js.reduce((a, b) => a + b, 0) / 1024, cssGzKB: css / 1024 };
}

// --- run ------------------------------------------------------------------
const mult = Number(process.argv[2] || 100);
const fmt = (n) => n.toFixed(1).padStart(7);
const mark = (v, limit) => (v <= limit ? "  ok" : "  OVER BUDGET");

const small = await measure(1);
const big = await measure(mult);
const assets = await assetSizes();
const serverRss1 = await serverMemory(1);
const serverRss = await serverMemory(mult);

console.log(`\n  sizes        1x: ${small.size.bookings} bookings / ${small.size.listings} listings` +
            `      ${mult}x: ${big.size.bookings} bookings / ${big.size.listings} listings\n`);
console.log("                         1x p95    " + `${mult}x p50`.padStart(9) + `   ${mult}x p95   budget`);
for (const [label, key, budget] of [["bookings list", "list", BUDGET.listP95], ["list, one listing", "listFiltered", BUDGET.listP95],
                                    ["list, page 2", "page2", BUDGET.listP95], ["booking detail", "detail", BUDGET.detailP95]]) {
  console.log(`  ${label.padEnd(20)} ${fmt(small[key].p95)}ms ${fmt(big[key].p50)}ms ${fmt(big[key].p95)}ms  ${String(budget).padStart(5)}ms${mark(big[key].p95, budget)}`);
}
console.log(`\n  queries/request      1x: ${small.list.queries}   ${mult}x: ${big.list.queries}   budget ${BUDGET.queriesPerRequest}${mark(big.list.queries, BUDGET.queriesPerRequest)}`);
console.log(`  detail queries       1x: ${small.detail.queries}   ${mult}x: ${big.detail.queries}   budget ${BUDGET.queriesPerRequest}${mark(big.detail.queries, BUDGET.queriesPerRequest)}`);
console.log(`  server memory (RSS)  1x: ${serverRss1.toFixed(0)}MB   ${mult}x: ${serverRss.toFixed(0)}MB   budget ${BUDGET.rssMB}MB${mark(serverRss, BUDGET.rssMB)}`);
console.log(`  JS shipped, gzipped  ${fmt(assets.jsGzKB)}KB   budget ${BUDGET.jsGzKB}KB${mark(assets.jsGzKB, BUDGET.jsGzKB)}`);
console.log(`  CSS shipped, gzipped ${fmt(assets.cssGzKB)}KB   budget ${BUDGET.cssGzKB}KB${mark(assets.cssGzKB, BUDGET.cssGzKB)}\n`);

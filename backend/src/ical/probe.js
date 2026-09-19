#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Does my listing connect?
//
//   npm run probe -- "https://www.airbnb.co.in/calendar/ical/123.ics?s=abc"
//   npm run probe -- ./test/fixtures/airbnb-typical.ics
//   npm run probe -- <url> --json
//
// Run this against your real Export link before any of the server exists. It
// answers the only question that matters at this stage: can we read your
// calendar, and what is actually in it?
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { connectListing } from "./connect.js";
import { parseCalendar, findOverlaps } from "./parse.js";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const asJson = args.includes("--json");

if (!target) {
  console.error("usage: npm run probe -- <ical-url|file.ics> [--json]");
  process.exit(2);
}

const b = { dim: "\x1b[2m", red: "\x1b[31m", amber: "\x1b[33m", green: "\x1b[32m", bold: "\x1b[1m", off: "\x1b[0m" };
const plain = !process.stdout.isTTY;
const c = (code, s) => (plain ? s : `${b[code]}${s}${b.off}`);

const report = target.startsWith("http") || target.startsWith("webcal")
  ? await connectListing(target)
  : await fromFile(target);

async function fromFile(path) {
  const text = await readFile(path, "utf8");
  const cal = parseCalendar(text);
  if (!cal.ok) return { ok: false, stage: "parse", code: cal.reason, message: "Not a calendar." };
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = cal.reservations.filter((r) => r.checkOut >= today);
  const overlaps = findOverlaps(cal.reservations);
  return {
    ok: true, url: path, bytes: text.length, fetchedAt: new Date().toISOString(), durationMs: 0,
    calendarName: cal.meta.calendarName || null, producer: cal.meta.prodId || null,
    counts: {
      events: cal.events.length, reservations: cal.reservations.length, upcomingReservations: upcoming.length,
      blocks: cal.blocks.length, unknown: cal.unknown.length,
      withBookingCode: cal.reservations.filter((r) => r.code).length, overlaps: overlaps.length,
    },
    reservations: cal.reservations, upcoming,
    overlaps: overlaps.map(([a, b]) => ({
      a: a.code || a.uid, b: b.code || b.uid,
      aDates: [a.checkIn, a.checkOut], bDates: [b.checkIn, b.checkOut],
    })),
    notes: [], warnings: cal.warnings,
  };
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (!report.ok) {
  console.log(`\n${c("red", "Could not connect.")}  ${c("dim", `(${report.stage}: ${report.code})`)}`);
  console.log(`  ${report.message}`);
  if (report.detail) console.log(c("dim", `  detail: ${report.detail}`));
  console.log();
  process.exit(1);
}

const n = report.counts;
console.log(`\n${c("green", "Connected.")} ${c("dim", `${report.bytes} bytes in ${report.durationMs}ms`)}`);
if (report.calendarName) console.log(`  calendar   ${report.calendarName}`);
if (report.producer) console.log(c("dim", `  producer   ${report.producer}`));
console.log(`  events     ${n.events}  ${c("dim", `(${n.reservations} reservations, ${n.blocks} blocked, ${n.unknown} unclassified)`)}`);
console.log(`  upcoming   ${n.upcomingReservations}  ${c("dim", `with a booking code: ${n.withBookingCode}/${n.reservations}`)}`);

if (report.upcoming.length) {
  console.log(`\n${c("bold", "  Upcoming reservations")}`);
  console.log(c("dim", "  code            check-in     check-out    nights  phone"));
  for (const r of report.upcoming.slice(0, 20)) {
    console.log(`  ${(r.code || c("dim", "(no code)")).padEnd(15)} ${r.checkIn}   ${r.checkOut}   ${String(r.nights).padStart(5)}  ${r.phoneLast4 || c("dim", "—")}`);
  }
  if (report.upcoming.length > 20) console.log(c("dim", `  … and ${report.upcoming.length - 20} more`));
}

if (n.overlaps) {
  console.log(`\n${c("amber", "  Overlapping reservations — these become sync conflicts:")}`);
  for (const o of report.overlaps) console.log(`  ${o.a} ${o.aDates.join("→")}  vs  ${o.b} ${o.bDates.join("→")}`);
}

if (report.warnings.length) {
  console.log(`\n${c("amber", "  Warnings")} ${c("dim", "(nothing was discarded)")}`);
  for (const w of report.warnings.slice(0, 15)) console.log(`  ${w.code.padEnd(22)} ${c("dim", String(w.detail ?? "").slice(0, 80))}`);
  if (report.warnings.length > 15) console.log(c("dim", `  … and ${report.warnings.length - 15} more`));
}

if (report.notes.length) {
  console.log(`\n${c("bold", "  Notes")}`);
  for (const note of report.notes) console.log(`  · ${note}`);
}
console.log();

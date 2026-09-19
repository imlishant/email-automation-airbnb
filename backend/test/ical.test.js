// Checks for the calendar reader. `node --test test/` — no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCalendar, findOverlaps, unfold, extractCode, daysBetween } from "../src/ical/parse.js";
import { validateIcalUrl, IcalFetchError } from "../src/ical/fetch.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, "fixtures", name), "utf8");

test("unfolds continuation lines (RFC 5545 §3.1)", () => {
  assert.equal(unfold("DESCRIPTION:one\r\n two"), "DESCRIPTION:onetwo");
  assert.equal(unfold("A:1\r\nB:2"), "A:1\nB:2");
  assert.equal(unfold("A:1\r\n\tcont"), "A:1cont");
});

test("daysBetween counts calendar days, not elapsed hours", () => {
  assert.equal(daysBetween("2026-09-20", "2026-09-23"), 3);
  // Across a DST transition in a northern-hemisphere zone.
  assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2);
  assert.equal(daysBetween("2026-12-31", "2027-01-02"), 2);
});

test("extractCode prefers the reservation URL over a bare code", () => {
  assert.equal(extractCode("Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCD1234"), "HMABCD1234");
  assert.equal(extractCode("Reservation URL: https://www.airbnb.co.in/hosting/reservations/details/HMIJKL9012"), "HMIJKL9012");
  assert.equal(extractCode("Reserved - HMBARE1234"), "HMBARE1234");
  assert.equal(extractCode("Reserved"), null);
  assert.equal(extractCode(null, undefined, ""), null);
});

test("a typical Airbnb feed reads correctly", async () => {
  const cal = parseCalendar(await fixture("airbnb-typical.ics"));
  assert.equal(cal.ok, true);
  assert.equal(cal.meta.calendarName, "Sea Breeze 2BHK, Candolim");
  assert.match(cal.meta.prodId, /Airbnb/);
  assert.equal(cal.reservations.length, 2);
  assert.equal(cal.blocks.length, 1);
  assert.equal(cal.unknown.length, 0);

  const [first] = cal.reservations;
  assert.equal(first.code, "HMABCD1234");        // came out of a FOLDED url
  assert.equal(first.checkIn, "2026-09-20");
  assert.equal(first.checkOut, "2026-09-23");    // DTEND is the checkout day
  assert.equal(first.nights, 3);
  assert.equal(first.phoneLast4, "4417");
  // The feed does not carry these, so we must not invent them.
  assert.equal(first.guestName, undefined);
  assert.equal(first.adults, undefined);

  assert.equal(cal.blocks[0].kind, "block");
  assert.equal(cal.warnings.length, 0);
});

test("date-only values keep their calendar day (no UTC shift)", async () => {
  const cal = parseCalendar(await fixture("airbnb-typical.ics"));
  // The bug this guards: parsing 20260920 through a Date and formatting it back
  // yields the 19th anywhere west of UTC.
  assert.equal(cal.reservations[0].checkIn, "2026-09-20");
  assert.equal(cal.reservations[1].checkIn, "2026-09-25");
});

test("a reservation with no code still syncs", async () => {
  const cal = parseCalendar(await fixture("airbnb-no-code.ics"));
  assert.equal(cal.reservations.length, 1);
  assert.equal(cal.reservations[0].code, null);
  assert.equal(cal.reservations[0].kind, "reservation");   // classified by SUMMARY
  assert.equal(cal.reservations[0].nights, 1);
});

test("a messy feed loses nothing and explains itself", async () => {
  const cal = parseCalendar(await fixture("airbnb-messy.ics"));
  assert.equal(cal.ok, true);
  const codes = (c) => cal.events.filter((e) => e.code === c);
  const warn = (code) => cal.warnings.filter((w) => w.code === code);

  assert.equal(codes("HMDUPE0001").length, 1, "the repeated event is collapsed");
  assert.equal(warn("duplicate_event").length, 1);

  const noEnd = codes("HMNOEND003")[0];
  assert.equal(noEnd.checkOut, "2026-12-21", "missing DTEND becomes one night");
  assert.equal(noEnd.nights, 1);
  assert.equal(warn("assumed_one_night").length, 1);

  const zero = codes("HMZERO0004")[0];
  assert.equal(zero.nights, 1, "a zero-length span is corrected, not dropped");
  assert.equal(warn("non_positive_span").length, 1);

  const weird = cal.unknown.find((e) => e.summary.includes("Maintenance"));
  assert.ok(weird, "an unclassifiable event is kept as unknown");
  assert.equal(weird.summary, "Maintenance; deep clean, no guests", "escaped ; and , are unescaped");
  assert.equal(warn("unclassified_event").length, 1);

  const dt = codes("HMDTIME006")[0];
  assert.equal(dt.checkIn, "2027-02-01", "DATE-TIME is handled defensively");
  assert.equal(dt.nights, 3);

  assert.equal(cal.events.length, 6, "6 distinct events survive from 7 entries");
});

test("events come back in check-in order", async () => {
  const cal = parseCalendar(await fixture("airbnb-messy.ics"));
  const days = cal.events.map((e) => e.checkIn);
  assert.deepEqual(days, [...days].sort());
});

test("overlapping reservations are detected; back-to-back stays are not", async () => {
  const cal = parseCalendar(await fixture("airbnb-messy.ics"));
  const overlaps = findOverlaps(cal.reservations);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0].map((r) => r.code).sort(), ["HMDUPE0001", "HMOVER0002"]);

  // Checkout day == next check-in day is a turnover, not a conflict.
  const backToBack = [
    { code: "A", checkIn: "2026-01-01", checkOut: "2026-01-03" },
    { code: "B", checkIn: "2026-01-03", checkOut: "2026-01-05" },
  ];
  assert.equal(findOverlaps(backToBack).length, 0);
});

test("an HTML login page is refused, not half-parsed", async () => {
  const cal = parseCalendar(await fixture("not-a-calendar.html"));
  assert.equal(cal.ok, false);
  assert.equal(cal.reason, "not_a_calendar");
  assert.equal(cal.events.length, 0);
});

test("empty and garbage input do not throw", () => {
  assert.equal(parseCalendar("").ok, false);
  assert.equal(parseCalendar("BEGIN:VCALENDAR\nEND:VCALENDAR").events.length, 0);
  assert.equal(parseCalendar("BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR").warnings[0].code, "no_dtstart");
});

test("URL validation accepts real export links and rejects unsafe ones", () => {
  const ok = validateIcalUrl("https://www.airbnb.co.in/calendar/ical/12345678.ics?s=abc123");
  assert.match(ok.url, /^https:\/\/www\.airbnb\.co\.in/);
  assert.deepEqual(ok.notes, []);

  // webcal:// is what some calendar apps hand you; rewrite rather than reject.
  const webcal = validateIcalUrl("webcal://www.airbnb.com/calendar/ical/9.ics");
  assert.match(webcal.url, /^https:/);
  assert.equal(webcal.notes.length, 1);

  // Permissive about the host, strict about the shape.
  assert.equal(validateIcalUrl("https://example.com/cal.ics").notes.length, 1);
  assert.equal(validateIcalUrl("https://www.airbnb.com/hosting/calendar").notes.length, 1);

  for (const bad of ["http://www.airbnb.com/c.ics", "https://localhost/c.ics", "https://127.0.0.1/c.ics", "not a url", ""]) {
    assert.throws(() => validateIcalUrl(bad), IcalFetchError, `should reject: ${bad}`);
  }
});

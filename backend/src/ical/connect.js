// ---------------------------------------------------------------------------
// "Connect this listing" — fetch the calendar, read it, and report what we can
// actually see. One function, used by the CLI probe today and by
// POST /listings in Phase 1 tomorrow, so the answer the host gets while
// connecting is the same answer the sync worker will act on.
// ---------------------------------------------------------------------------
import { fetchIcal, IcalFetchError, validateIcalUrl } from "./fetch.js";
import { parseCalendar, findOverlaps } from "./parse.js";

/**
 * @returns a report the UI can render directly. Never throws for a calendar
 *   problem — problems come back as `ok:false` plus a code and a message the
 *   host can act on, because "connect failed" with no reason is useless when
 *   you are trying to work out which link to paste.
 */
export async function connectListing(urlInput, options = {}) {
  let fetched;
  try {
    fetched = await fetchIcal(urlInput, options);
  } catch (e) {
    if (e instanceof IcalFetchError) return { ok: false, stage: "fetch", code: e.code, message: e.message, detail: e.detail ?? null };
    throw e;
  }

  const cal = parseCalendar(fetched.text);
  if (!cal.ok) {
    return { ok: false, stage: "parse", code: cal.reason, message: "The link responded, but it is not a calendar.", detail: fetched.contentType };
  }

  const overlaps = findOverlaps(cal.reservations);
  const withCode = cal.reservations.filter((r) => r.code);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = cal.reservations.filter((r) => r.checkOut >= today);

  return {
    ok: true,
    url: fetched.url,
    fetchedAt: fetched.fetchedAt,
    durationMs: fetched.durationMs,
    bytes: fetched.bytes,
    calendarName: cal.meta.calendarName || null,
    producer: cal.meta.prodId || null,
    counts: {
      events: cal.events.length,
      reservations: cal.reservations.length,
      upcomingReservations: upcoming.length,
      blocks: cal.blocks.length,
      unknown: cal.unknown.length,
      withBookingCode: withCode.length,
      overlaps: overlaps.length,
    },
    reservations: cal.reservations,
    upcoming,
    overlaps: overlaps.map(([a, b]) => ({ a: a.code || a.uid, b: b.code || b.uid, aDates: [a.checkIn, a.checkOut], bDates: [b.checkIn, b.checkOut] })),
    // Everything odd, surfaced rather than swallowed.
    notes: [...fetched.notes, ...healthNotes(cal, upcoming, withCode)],
    warnings: cal.warnings,
  };
}

/** Plain-language observations about the feed's usefulness, not just its syntax. */
function healthNotes(cal, upcoming, withCode) {
  const notes = [];
  if (cal.events.length === 0) notes.push("The calendar is valid but empty — no reservations and no blocks.");
  else if (cal.reservations.length === 0) notes.push("No reservations found, only blocked dates. Normal for a listing with nothing booked.");
  if (cal.reservations.length && withCode.length === 0)
    notes.push("No booking codes found in this feed. Bookings will sync, but they cannot be matched to an Airbnb reservation by code.");
  else if (withCode.length < cal.reservations.length)
    notes.push(`${cal.reservations.length - withCode.length} of ${cal.reservations.length} reservations have no booking code.`);
  if (cal.reservations.length && upcoming.length === 0) notes.push("Every reservation in this feed is in the past.");
  if (cal.unknown.length) notes.push(`${cal.unknown.length} event(s) could not be classified as a reservation or a block. They are kept, not dropped.`);
  // Stated every time, because it is the constraint the whole guest flow exists
  // to work around (docs/CONTEXT.md).
  notes.push("This feed carries dates and codes only — no guest names and no headcount. The adult count comes from the guest's link.");
  return notes;
}

export { validateIcalUrl };

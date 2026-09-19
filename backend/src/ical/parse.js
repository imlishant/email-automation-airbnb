// ---------------------------------------------------------------------------
// iCalendar reader, scoped to what an Airbnb listing export actually contains.
//
// Why hand-written rather than a library: the feed is one calendar from one
// producer, we need about six fields from it, and the parsing rules that matter
// here are Airbnb's conventions rather than RFC 5545's breadth. A dependency
// would be larger than this file and would still need the Airbnb-specific layer
// on top. If we ever have to read arbitrary calendars, revisit that.
//
// What the feed reliably gives (per docs/DECISIONS.md, "Airbnb calendar sync"):
//   dates, a stable UID, and usually a booking code inside DESCRIPTION.
// What it does NOT give: the guest's name, or the headcount. Do not invent them.
// ---------------------------------------------------------------------------

/** Unfold per RFC 5545 §3.1: a CRLF followed by one space or tab is a continuation. */
export function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

/** Split "NAME;PARAM=v:value" on the first colon that is not inside a quoted parameter. */
function splitProperty(line) {
  let inQuote = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const [rawName, ...rawParams] = line.slice(0, i).split(";");
  const params = {};
  for (const seg of rawParams) {
    const eq = seg.indexOf("=");
    if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: rawName.toUpperCase().trim(), params, value: line.slice(i + 1) };
}

/** Unescape a TEXT value per RFC 5545 §3.3.11. */
function unescapeText(v) {
  return String(v).replace(/\\[nN]/g, "\n").replace(/\\([;,\\])/g, "$1");
}

/**
 * A calendar day as "YYYY-MM-DD".
 *
 * Reservation events are VALUE=DATE, which is already a calendar day and must
 * be kept as one — converting it through a Date and back is how you end up a
 * day early west of UTC. DATE-TIME is a defensive path only.
 */
function toDay(value, params) {
  const v = String(value).trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (dateTime) {
    // No TZID and a trailing Z means UTC. We only need the calendar date, and
    // for an all-day-shaped feed the UTC date is the intended one.
    const [, y, m, d] = dateTime;
    return `${y}-${m}-${d}`;
  }
  if (params && params.VALUE === "DATE" && /^\d{8}$/.test(v)) return toDay(v, null);
  return null;
}

const dayMs = 86400000;
/** Whole days between two "YYYY-MM-DD" values, computed on the calendar, not on a clock. */
export function daysBetween(fromDay, toDayStr) {
  const [y1, m1, d1] = fromDay.split("-").map(Number);
  const [y2, m2, d2] = toDayStr.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / dayMs);
}
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Airbnb writes the reservation link into DESCRIPTION. That link is the only
// dependable place the booking code appears.
const RESERVATION_URL = /https?:\/\/[^\s]*airbnb\.[a-z.]+\/(?:hosting\/reservations\/details|reservations\/details|hosting\/reservations)\/([A-Z0-9]{6,})/i;
const BARE_CODE = /\b(HM[A-Z0-9]{6,})\b/;
const PHONE_LAST4 = /last\s*4\s*digits?\)?\s*[:\-]?\s*(\d{4})/i;
const BLOCK_SUMMARY = /not\s*available|unavailable|blocked|^block$/i;
const RESERVED_SUMMARY = /reserved|reservation|booked/i;

/** Pull the booking code out of wherever this feed decided to put it. */
export function extractCode(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const viaUrl = RESERVATION_URL.exec(t);
    if (viaUrl) return viaUrl[1].toUpperCase();
  }
  for (const t of texts) {
    if (!t) continue;
    const bare = BARE_CODE.exec(t);
    if (bare) return bare[1].toUpperCase();
  }
  return null;
}

/**
 * Parse a calendar into events, plus warnings describing everything we could
 * not make sense of. Nothing is discarded silently: an event we cannot classify
 * comes back as kind "unknown" with a warning attached, because dropping data
 * to make a screen tidy is how a guest ends up stuck at a gate
 * (docs/PRODUCT_PRINCIPLES.md, 9).
 */
export function parseCalendar(text) {
  const warnings = [];
  const raw = unfold(text);
  if (!/BEGIN:VCALENDAR/i.test(raw)) {
    return { ok: false, reason: "not_a_calendar", events: [], reservations: [], blocks: [], warnings, meta: {} };
  }

  const meta = {};
  const events = [];
  let current = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    const { name, params, value } = prop;

    if (name === "BEGIN" && value.toUpperCase() === "VEVENT") { current = { props: {} }; continue; }
    if (name === "END" && value.toUpperCase() === "VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (current) { current.props[name] = { value, params }; continue; }
    if (name === "PRODID") meta.prodId = unescapeText(value);
    if (name === "X-WR-CALNAME") meta.calendarName = unescapeText(value);
    if (name === "VERSION") meta.version = value;
  }

  const seen = new Set();
  const parsed = [];
  for (const [index, ev] of events.entries()) {
    const p = ev.props;
    const uid = p.UID ? p.UID.value.trim() : null;
    const summary = p.SUMMARY ? unescapeText(p.SUMMARY.value).trim() : "";
    const description = p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value).trim() : "";

    if (!p.DTSTART) { warnings.push({ index, uid, code: "no_dtstart", detail: summary }); continue; }
    const checkIn = toDay(p.DTSTART.value, p.DTSTART.params);
    if (!checkIn) { warnings.push({ index, uid, code: "unparseable_dtstart", detail: p.DTSTART.value }); continue; }

    let checkOut = p.DTEND ? toDay(p.DTEND.value, p.DTEND.params) : null;
    if (!checkOut) {
      // A missing or unreadable DTEND is rare but must not lose the booking.
      checkOut = addDays(checkIn, 1);
      warnings.push({ index, uid, code: "assumed_one_night", detail: p.DTEND ? p.DTEND.value : "missing DTEND" });
    }
    // For VALUE=DATE, DTEND is exclusive — which is exactly the checkout day.
    let nights = daysBetween(checkIn, checkOut);
    if (nights <= 0) {
      warnings.push({ index, uid, code: "non_positive_span", detail: `${checkIn} -> ${checkOut}` });
      checkOut = addDays(checkIn, 1);
      nights = 1;
    }

    const code = extractCode(description, summary, p.URL ? p.URL.value : null);
    const phoneMatch = PHONE_LAST4.exec(description);

    let kind;
    if (code) kind = "reservation";
    else if (BLOCK_SUMMARY.test(summary)) kind = "block";
    else if (RESERVED_SUMMARY.test(summary)) kind = "reservation";
    else { kind = "unknown"; warnings.push({ index, uid, code: "unclassified_event", detail: summary || "(no summary)" }); }

    // Feeds occasionally repeat an event. Keyed on UID plus dates so a genuine
    // date change is not mistaken for a duplicate.
    const key = `${uid || "anon"}|${checkIn}|${checkOut}`;
    if (seen.has(key)) { warnings.push({ index, uid, code: "duplicate_event", detail: key }); continue; }
    seen.add(key);

    parsed.push({
      uid, kind, code,
      checkIn, checkOut, nights,
      summary, description,
      phoneLast4: phoneMatch ? phoneMatch[1] : null,
      // Deliberately absent: guestName, adults. The feed does not carry them.
    });
  }

  parsed.sort((a, b) => (a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0));
  return {
    ok: true,
    meta,
    events: parsed,
    reservations: parsed.filter((e) => e.kind === "reservation"),
    blocks: parsed.filter((e) => e.kind === "block"),
    unknown: parsed.filter((e) => e.kind === "unknown"),
    warnings,
  };
}

/**
 * Overlapping reservations. Checkout day and check-in day touching is a
 * back-to-back stay, not an overlap, so the comparison is strict.
 */
export function findOverlaps(reservations) {
  const sorted = [...reservations].sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].checkIn >= sorted[i].checkOut) break;
      pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}

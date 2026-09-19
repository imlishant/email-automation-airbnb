// ---------------------------------------------------------------------------
// The rules. ONE implementation, imported by both the browser and the server.
//
// This file exists because a second copy of `status` is the most dangerous bug
// shape in this system: the client shows "ready to send", the server computes
// "awaiting", and the email silently never goes. Everything here is pure — no
// DOM, no database, no Node APIs, no imports — so both runtimes can use it
// unchanged.
//
// Nothing in here stores a value it can compute. See docs/DECISIONS.md,
// "Data, not code".
// ---------------------------------------------------------------------------

/** Retention and timing constants the product owns. The server is authoritative. */
export const RULES = Object.freeze({
  // One retention moment. Because check-out is a real time of day, "the day
  // after checkout" and "checkout + 24h" are the same instant, so the booking
  // leaving the list, the guest link dying and the ID files being deleted all
  // land together. docs/DECISIONS.md, "Retention".
  hideBookingAfterCheckoutHours: 24,
  guestLinkAfterCheckoutHours: 24,
  deleteIdFilesAfterCheckoutHours: 24,
  // Settled: the booking record goes at the same moment as everything else, so
  // there is exactly ONE retention instant and nothing lingers.
  //
  // The consequence, accepted knowingly: no record survives that a booking
  // existed or that its IDs reached security. If that ever needs revisiting,
  // the cheap answer is an anonymised receipt row (code, listing, sent_at,
  // recipient, adult count — no names, no files), not a longer window on the
  // personal data.
  purgeRecordAfterCheckoutHours: 24,
  // The "1 hour before check-in" automation.
  scheduledSendLeadHours: 1,
  // Defaults for a fresh install only; the live values are host settings.
  defaultCheckInTime: "14:00",
  defaultCheckOutTime: "11:00",
});

export const STATUS = Object.freeze({
  conflict: Object.freeze({ label: "Sync conflict", attention: true }),
  awaiting: Object.freeze({ label: "Awaiting IDs", attention: true }),
  ready: Object.freeze({ label: "Ready to send", attention: false }),
  sent: Object.freeze({ label: "Sent", attention: false }),
});

export const AUTOMATION = Object.freeze(["before", "allids"]);

// ---------- calendar days ----------
// A booking's dates are calendar days ("2026-09-20"), not instants. Parsing one
// through `new Date(iso)` yields UTC midnight and reads as the day before
// anywhere west of UTC, so the parts are read explicitly.

/** "YYYY-MM-DD" -> a local Date at midnight. */
export function parseDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d);
}
/** A local Date -> "YYYY-MM-DD". */
export function toDay(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
/** Whole calendar days between two day strings. Immune to DST. */
export function daysBetween(fromDay, toDayStr) {
  const [y1, m1, d1] = String(fromDay).split("-").map(Number);
  const [y2, m2, d2] = String(toDayStr).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
export function addDays(day, n) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return toDay(d);
}
/** Apply a "HH:MM" host setting to a calendar day. */
export function atTime(day, hhmm) {
  const [h, min] = String(hhmm || "00:00").split(":").map(Number);
  const d = parseDay(day);
  d.setHours(h || 0, min || 0, 0, 0);
  return d;
}

const hours = (n) => n * 3600000;
const defaultTimes = { checkInTime: RULES.defaultCheckInTime, checkOutTime: RULES.defaultCheckOutTime };

// ---------- derived values ----------
// A booking here is the minimum shape: { checkIn, checkOut, people[], children,
// conflict, sentAt, automation, leadGuest, listingName }. A person is
// { lead, documentType }.

export const Derive = {
  adults: (b) => (b.people ? b.people.length : 0),
  uploaded: (b) => (b.people ? b.people.filter((p) => p.documentType).length : 0),
  nights: (b) => Math.max(1, daysBetween(b.checkIn, b.checkOut)),
  complete: (b) => Derive.adults(b) > 0 && Derive.uploaded(b) === Derive.adults(b),

  /**
   * The only place a booking's status is decided. Precedence matters: a
   * conflicted booking reads as a conflict even if it was sent, because the
   * conflict is what a human has to act on.
   */
  status(b) {
    if (b.conflict) return "conflict";
    if (b.sentAt) return "sent";
    return Derive.complete(b) ? "ready" : "awaiting";
  },
  needsAttention: (b) => STATUS[Derive.status(b)].attention,

  // The feed gives dates with no clock time, so the moments come from the
  // host's global settings.
  checkInAt: (b, s = defaultTimes) => atTime(b.checkIn, s.checkInTime),
  checkOutAt: (b, s = defaultTimes) => atTime(b.checkOut, s.checkOutTime),

  guestLinkExpiresAt: (b, s) => Derive.checkOutAt(b, s).getTime() + hours(RULES.guestLinkAfterCheckoutHours),
  guestLinkActive: (b, s, now = Date.now()) => now <= Derive.guestLinkExpiresAt(b, s),
  visibleUntil: (b, s) => Derive.checkOutAt(b, s).getTime() + hours(RULES.hideBookingAfterCheckoutHours),
  visible: (b, s, now = Date.now()) => now <= Derive.visibleUntil(b, s),
  idFilesDeletedAt: (b, s) => Derive.checkOutAt(b, s).getTime() + hours(RULES.deleteIdFilesAfterCheckoutHours),
  /** Past the file delete there is nothing to attach, so a resend is impossible. */
  canResend: (b, s, now = Date.now()) => now < Derive.idFilesDeletedAt(b, s),
  recordExpiresAt: (b, s) => Derive.checkOutAt(b, s).getTime() + hours(RULES.purgeRecordAfterCheckoutHours),
  /** True once every retention window has passed and nothing should remain. */
  fullyExpired: (b, s, now = Date.now()) => now > Derive.recordExpiresAt(b, s),

  scheduledSendAt: (b, s) => Derive.checkInAt(b, s).getTime() - hours(RULES.scheduledSendLeadHours),

  /**
   * May IDs still be added or replaced?
   *
   * The same window as the guest link, deliberately: a guest who can open the
   * page can fix a blurry photo, and an admin has no reason to be more
   * restricted than the guest. Past it the files are deleted anyway, so there
   * would be nothing to replace.
   */
  documentsEditable: (b, s, now = Date.now()) => now <= Derive.guestLinkExpiresAt(b, s),

  /**
   * Where this booking's email goes.
   *
   * Once sent, the address is whatever it was sent to — pinned on the booking
   * at send time. A resend is the same mail to the same desk, and must not
   * follow a later edit of the listing's society. Only an unsent booking
   * resolves live through its listing.
   */
  destination(b) {
    if (b.sentAt && b.sentTo) {
      return { to: b.sentTo, cc: b.sentCc || "", societyName: b.sentSocietyName || "", pinned: true };
    }
    const s = b.society || {};
    return { to: s.to || "", cc: s.cc || "", societyName: s.name || b.societyName || "", pinned: false };
  },

  /**
   * Was a document added or replaced AFTER the email went out?
   *
   * If so the society is holding a stale attachment and a resend is owed. This
   * is the cost of allowing replacement after sending, and it has to be visible
   * rather than silent (docs/PRODUCT_PRINCIPLES.md, 9).
   */
  needsResend(b, s) {
    if (!b.sentAt || !b.lastDocumentAt) return false;
    if (!Derive.canResend(b, s)) return false;      // nothing left to send
    return Date.parse(b.lastDocumentAt) > Date.parse(b.sentAt);
  },

  /**
   * Should the automation send this booking now? The single answer both the
   * scheduler and the UI use, so neither can disagree about why nothing sent.
   */
  sendDue(b, s, now = Date.now()) {
    // Already sent: never automatically again. A replaced ID makes a resend
    // *owed* (needsResend), but sending someone's passport twice without the
    // host asking is worse than a stale attachment they can see and fix.
    if (b.conflict || b.sentAt) return false;
    if (b.automation === "allids") return Derive.complete(b);
    if (b.automation === "before") return now >= Derive.scheduledSendAt(b, s);
    return false;
  },

  /**
   * Is this name a placeholder rather than a real person?
   *
   * The Airbnb feed carries no guest names (docs/DECISIONS.md), so a synced
   * booking starts with "Lead guest" and any added adult with "Adult 3". Those
   * stand-ins must not reach a security desk: a desk receiving
   * "Adult_3_Aadhaar.pdf" cannot match it to the person at the gate.
   */
  isPlaceholderName: (name) => /^(lead guest|adult(\s+guest)?\s*\d*)$/i.test(String(name || "").trim()),

  /** People still carrying a stand-in name. The UI nudges about these. */
  unnamedPeople: (b) => (b.people || []).filter((p) => Derive.isPlaceholderName(p.name)),

  // What a booking is called. The feed carries no guest name, so the title is
  // the listing — always known, never blank.
  title: (b) => b.listingName || "Booking",
  leadGuestKnown: (b) => Boolean(b.leadGuest),
};

// ---------- email template ----------
/** One definition of the placeholders, so Settings and the filler cannot drift. */
export const TEMPLATE_VARS = Object.freeze([
  Object.freeze({ token: "listing", describe: "the listing's name" }),
  Object.freeze({ token: "guest_name", describe: "the lead guest, when known" }),
  Object.freeze({ token: "booking_id", describe: "the Airbnb booking code" }),
  Object.freeze({ token: "check_in", describe: "check-in date" }),
  Object.freeze({ token: "check_out", describe: "check-out date" }),
  Object.freeze({ token: "adult_count", describe: "how many adults" }),
  Object.freeze({ token: "society", describe: "the society's name" }),
]);

/**
 * @param formatDay a function turning "YYYY-MM-DD" into display text. The
 *   browser passes an Intl formatter; the server passes its own, so the same
 *   filler serves both without either owning a date format.
 */
export function templateValues(b, formatDay) {
  const day = formatDay || ((iso) => iso);
  return {
    listing: b.listingName || "",
    society: b.societyName || (b.society && b.society.name) || "",
    guest_name: b.leadGuest || "",
    booking_id: b.code || "",
    check_in: day(b.checkIn),
    check_out: day(b.checkOut),
    adult_count: String(Derive.adults(b)),
  };
}
export function fillTemplate(template, b, formatDay) {
  const values = templateValues(b, formatDay);
  return TEMPLATE_VARS.reduce(
    (out, v) => out.split(`{{${v.token}}}`).join(values[v.token] ?? ""),
    String(template || "")
  );
}

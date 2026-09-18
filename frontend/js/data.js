// ---------------------------------------------------------------------------
// The only place in the frontend that knows where data comes from.
//
// Every function here is async and returns the shape the planned API returns
// (docs/TECH_STACK.md, backend/README.md). Today they resolve against SEED
// below; swapping to the server means replacing the bodies with fetch() calls
// and deleting SEED. No screen changes, because no screen touches SEED.
//
// SEED is the ONLY mock data in the app. If you find yourself typing a name,
// an email, a date or a document type anywhere else, it belongs here or in
// CONFIG.
// ---------------------------------------------------------------------------

// ---------- dates ----------
// An Airbnb iCal feed gives date-only values. `new Date("2026-09-20")` parses
// those as UTC midnight, which then reads as the 19th anywhere west of UTC, so
// parse the parts explicitly as a local day instead.
function parseDay(iso) { const [y, m, d] = String(iso).split("-").map(Number); return new Date(y, m - 1, d); }
function endOfWindow(checkoutIso, hours) { return parseDay(checkoutIso).getTime() + hours * 3600 * 1000; }

// ---------- derived values ----------
// These rules are the product, so they live in one place and will be mirrored
// by the server. Nothing stores a status, a night count or an adult count.
const Derive = {
  adults: (b) => b.people.length,
  uploaded: (b) => b.people.filter((p) => p.documentType).length,
  nights: (b) => Math.max(1, Math.round((parseDay(b.checkOut) - parseDay(b.checkIn)) / 86400000)),
  complete: (b) => Derive.uploaded(b) === Derive.adults(b),
  status(b) {
    if (b.conflict) return "conflict";
    if (b.sentAt) return "sent";
    return Derive.complete(b) ? "ready" : "awaiting";
  },
  needsAttention: (b) => CONFIG.status[Derive.status(b)].attention,
  guestLinkExpiresAt: (b) => endOfWindow(b.checkOut, CONFIG.retention.guestLinkAfterCheckoutHours),
  guestLinkActive: (b) => Date.now() <= Derive.guestLinkExpiresAt(b),
  visibleUntil: (b) => endOfWindow(b.checkOut, CONFIG.retention.hideBookingAfterCheckoutHours),
  // The society a booking's IDs go to is resolved through its listing, never
  // stored on the booking and never inferred from the calendar.
  societyIdFor: (b, listings) => (listings.find((l) => l.id === b.listingId) || {}).societyId || null,
};

// ---------- template filling ----------
// Driven by CONFIG.templateVars so the placeholders offered in Settings and the
// placeholders actually replaced can never drift apart.
function resolveVars(ctx) {
  const { booking, listing, society, fmt } = ctx;
  return {
    listing: listing ? listing.name : "",
    society: society ? society.name : "",
    guest_name: booking.leadGuest || "",
    booking_id: booking.code,
    check_in: fmt.day(booking.checkIn),
    check_out: fmt.day(booking.checkOut),
    adult_count: String(Derive.adults(booking)),
  };
}
function fillTemplate(template, ctx) {
  const values = resolveVars(ctx);
  return CONFIG.templateVars.reduce(
    (out, v) => out.split(`{{${v.token}}}`).join(values[v.token] ?? ""),
    String(template || "")
  );
}

// ---------- seed (mock data only) ----------
// Stand-in for what the database will hold. Dates are relative to today so the
// prototype never goes stale and the retention rules stay demonstrable.
function daysFromNow(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function hoursAgo(n) { return new Date(Date.now() - n * 3600 * 1000).toISOString(); }

const SEED = {
  profile: { name: "Arjun K.", role: "Host" },
  societies: [
    { id: "soc_1", name: "Greenwood Society, Candolim",
      to: "security@greenwoodsociety.in", cc: "clubhouse@greenwoodsociety.in",
      template: "Dear Security Team,\n\nPlease find attached the ID proofs for guests arriving at {{listing}}.\n\nBooking reference: {{booking_id}}\nCheck-in: {{check_in}}\nCheck-out: {{check_out}}\nAdult guests: {{adult_count}}\n\nKindly allow entry as per society guidelines.\n\nRegards,\nArjun K. (Host)" },
    { id: "soc_2", name: "Hillcrest Residency, Coorg",
      to: "gate@hillcrestcoorg.in", cc: "manager@hillcrestcoorg.in",
      template: "Hello Gate Desk,\n\nGuest ID documents for the stay at {{listing}} are attached.\n\nRef {{booking_id}} · {{adult_count}} adult(s)\nArriving {{check_in}}, leaving {{check_out}}.\n\nThank you,\nArjun" },
  ],
  listings: [
    { id: "lst_1", name: "Sea Breeze 2BHK, Candolim", societyId: "soc_1",
      icalUrl: "https://www.airbnb.co.in/calendar/ical/12345678.ics?s=a1b2c3", lastSyncedAt: hoursAgo(0.3) },
    { id: "lst_2", name: "Hillview Studio, Coorg", societyId: "soc_2",
      icalUrl: "https://www.airbnb.co.in/calendar/ical/87654321.ics?s=d4e5f6", lastSyncedAt: hoursAgo(0.6) },
  ],
  bookings: [
    { id: "bkg_1", code: "HMABCD1234", listingId: "lst_1", leadGuest: "Priya Menon",
      checkIn: daysFromNow(2), checkOut: daysFromNow(5), children: 1,
      automation: "allids", sentAt: null, conflict: false,
      people: [
        { id: "per_1", name: "Priya Menon", lead: true, documentType: "Aadhaar", documentId: "doc_1" },
        { id: "per_2", name: "Rohit Menon", lead: false, documentType: null, documentId: null },
        { id: "per_3", name: "Adult guest 3", lead: false, documentType: null, documentId: null },
      ],
      activity: [
        { at: hoursAgo(30), kind: "sync", text: "Booking synced from Airbnb" },
        { at: hoursAgo(29), kind: "upload", text: "Priya uploaded Aadhaar" },
      ] },
    { id: "bkg_2", code: "HMEFGH5678", listingId: "lst_2", leadGuest: "Daniel Fernandes",
      checkIn: daysFromNow(3), checkOut: daysFromNow(5), children: 0,
      automation: "before", sentAt: null, conflict: false,
      people: [
        { id: "per_4", name: "Daniel Fernandes", lead: true, documentType: "Passport", documentId: "doc_2" },
        { id: "per_5", name: "Aisha Fernandes", lead: false, documentType: "Aadhaar", documentId: "doc_3" },
      ],
      activity: [
        { at: hoursAgo(46), kind: "sync", text: "Booking synced from Airbnb" },
        { at: hoursAgo(20), kind: "upload", text: "Both IDs uploaded" },
      ] },
    { id: "bkg_3", code: "HMIJKL9012", listingId: "lst_1", leadGuest: "Sana Kapoor",
      checkIn: daysFromNow(7), checkOut: daysFromNow(11), children: 2,
      automation: "allids", sentAt: hoursAgo(52), conflict: false,
      people: [
        { id: "per_6", name: "Sana Kapoor", lead: true, documentType: "Aadhaar", documentId: "doc_4" },
        { id: "per_7", name: "Vikram Kapoor", lead: false, documentType: "Driving licence", documentId: "doc_5" },
      ],
      activity: [
        { at: hoursAgo(72), kind: "sync", text: "Booking synced from Airbnb" },
        { at: hoursAgo(53), kind: "upload", text: "Both IDs uploaded" },
        { at: hoursAgo(52), kind: "send", text: "Email sent to security helpdesk" },
      ] },
    { id: "bkg_4", code: "HMMNOP3456", listingId: "lst_2", leadGuest: "Meera Nair",
      checkIn: daysFromNow(14), checkOut: daysFromNow(15), children: 0,
      automation: "before", sentAt: null, conflict: true,
      people: [{ id: "per_8", name: "Meera Nair", lead: true, documentType: null, documentId: null }],
      activity: [{ at: hoursAgo(33), kind: "conflict", text: "Sync conflict: dates overlap an existing block" }] },
    // Already gone from the list: checkout is past the retention window.
    { id: "bkg_5", code: "HMQRST7890", listingId: "lst_1", leadGuest: "Imran Shaikh",
      checkIn: daysFromNow(-4), checkOut: daysFromNow(-2), children: 0,
      automation: "allids", sentAt: hoursAgo(96), conflict: false,
      people: [{ id: "per_9", name: "Imran Shaikh", lead: true, documentType: "Aadhaar", documentId: "doc_6" }],
      activity: [{ at: hoursAgo(100), kind: "sync", text: "Booking synced from Airbnb" }] },
  ],
  auth: { passcode: CONFIG.auth.firstRunPasscode },
};

// ---------- the store ----------
// In-memory stand-in for the database. Cloned from SEED so SEED stays pristine
// and a reload is a clean slate.
const db = structuredClone(SEED);
let nextId = 100;
const newId = (prefix) => `${prefix}_${++nextId}`;
const clone = (v) => structuredClone(v);
// Keeps the UI honest about the fact that every one of these will be a network
// call. Zero today; raise it while developing to see the loading states.
const LATENCY_MS = 0;
const settle = (value) => new Promise((r) => (LATENCY_MS ? setTimeout(() => r(clone(value)), LATENCY_MS) : r(clone(value))));

function bookingRow(b) {
  const listing = db.listings.find((l) => l.id === b.listingId) || null;
  const society = listing ? db.societies.find((s) => s.id === listing.societyId) || null : null;
  return {
    ...clone(b),
    listingName: listing ? listing.name : "",
    societyId: society ? society.id : null,
    societyName: society ? society.name : "",
  };
}

const Data = {
  async config() { return settle({ retention: CONFIG.retention, documents: CONFIG.documents }); },
  async profile() {
    return settle({ ...db.profile, listingCount: db.listings.length });
  },
  async societies() { return settle(db.societies); },
  async listings() {
    return settle(db.listings.map((l) => ({
      ...l,
      societyName: (db.societies.find((s) => s.id === l.societyId) || {}).name || "",
    })));
  },

  // Keyset pagination, not offset: the server will page on (checkIn, id) with
  // an index, so cost stays flat however many bookings exist. Retention keeps
  // the visible set small on its own, but the list must not depend on that.
  async bookings({ listingId = null, cursor = null, limit = CONFIG.ui.pageSize } = {}) {
    const now = Date.now();
    let rows = db.bookings
      .filter((b) => Derive.visibleUntil(b) >= now)
      .filter((b) => !listingId || b.listingId === listingId)
      .sort((a, b) => parseDay(a.checkIn) - parseDay(b.checkIn) || a.id.localeCompare(b.id));
    // Attention first, then chronological. Settled in docs/DECISIONS.md.
    rows = [...rows.filter(Derive.needsAttention), ...rows.filter((b) => !Derive.needsAttention(b))];
    const start = cursor ? rows.findIndex((b) => b.id === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return settle({
      rows: page.map(bookingRow),
      nextCursor: start + limit < rows.length ? page[page.length - 1].id : null,
      counts: {
        attention: rows.filter(Derive.needsAttention).length,
        settled: rows.filter((b) => !Derive.needsAttention(b)).length,
      },
    });
  },

  async booking(id) {
    const b = db.bookings.find((x) => x.id === id);
    if (!b) throw new Error("not_found");
    const row = bookingRow(b);
    const society = db.societies.find((s) => s.id === row.societyId) || null;
    return settle({ ...row, society: society ? clone(society) : null });
  },

  async setAutomation(id, mode) {
    const b = db.bookings.find((x) => x.id === id);
    b.automation = mode;
    return settle(bookingRow(b));
  },

  async addDocument(bookingId, personId, { type = CONFIG.documents.types[0], by = "admin" } = {}) {
    const b = db.bookings.find((x) => x.id === bookingId);
    const p = b.people.find((x) => x.id === personId);
    p.documentType = type;
    p.documentId = newId("doc");
    b.activity.unshift({ at: new Date().toISOString(), kind: "upload",
      text: `${p.name.split(" ")[0]} uploaded ${type}${by === "guest" ? " (guest)" : ""}` });
    return settle(bookingRow(b));
  },

  async setAdultCount(bookingId, count) {
    const b = db.bookings.find((x) => x.id === bookingId);
    const people = b.people;
    while (people.length < count) people.push({ id: newId("per"), name: `Adult ${people.length + 1}`, lead: false, documentType: null, documentId: null });
    while (people.length > count) {
      const last = people[people.length - 1];
      if (last.lead || last.documentType) break;   // never drop the lead guest or an ID already in
      people.pop();
    }
    return settle(bookingRow(b));
  },

  async send(bookingId, { auto = false } = {}) {
    const b = db.bookings.find((x) => x.id === bookingId);
    if (!Derive.complete(b)) throw new Error("incomplete");
    b.sentAt = new Date().toISOString();
    b.activity.unshift({ at: b.sentAt, kind: "send",
      text: `Email ${auto ? "auto-" : ""}sent to security helpdesk` });
    return settle(bookingRow(b));
  },

  async saveSociety(id, patch) {
    const s = db.societies.find((x) => x.id === id);
    Object.assign(s, { to: patch.to, cc: patch.cc, template: patch.template });
    return settle(s);
  },

  async sync() {
    const at = new Date().toISOString();
    db.listings.forEach((l) => { l.lastSyncedAt = at; });
    return settle({ syncedAt: at, newBookings: 0 });
  },

  // Auth is a client-side comparison only while there is no server. It is
  // decoration, not access control (docs/SECURITY.md).
  async unlock(passcode) { return settle({ ok: passcode === db.auth.passcode }); },
  async passcode() { return settle({ value: CONFIG.dev ? db.auth.passcode : null }); },
  async setPasscode(next) { db.auth.passcode = next; return settle({ ok: true }); },

  // The guest's token. In the prototype it is the booking id in the hash;
  // Phase 3 makes it a signed token and this signature does not change.
  async guestBooking(token) {
    const b = db.bookings.find((x) => x.id === token || x.code === token);
    if (!b || !Derive.guestLinkActive(b)) return settle(null);
    const row = bookingRow(b);
    // Scoped to one booking: no society desk, no template, no other bookings.
    return settle({
      id: row.id, code: row.code, leadGuest: row.leadGuest, listingName: row.listingName,
      checkIn: row.checkIn, checkOut: row.checkOut, automation: row.automation,
      sentAt: row.sentAt, people: row.people,
    });
  },
};

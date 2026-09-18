// ---------------------------------------------------------------------------
// Every tunable in the app. Nothing here is a value the host owns (that is
// data — see data.js); everything here is a knob the *product* owns.
//
// When the backend lands, the server becomes the source of truth for the
// values it also enforces (retention, upload limits, passcode length) and
// serves them from GET /config. Until then this file is the single place to
// change them, so no screen carries its own copy.
// ---------------------------------------------------------------------------
const CONFIG = Object.freeze({
  // Turn off for anything reachable by someone other than you. It only gates
  // conveniences that must never ship: the demo passcode on the lock screen.
  dev: true,

  // undefined = follow the browser's own locale and time zone. Set a string
  // ("en-IN") only to force one.
  locale: undefined,

  retention: Object.freeze({
    // Both windows are measured from local midnight of the checkout date,
    // because an Airbnb iCal feed gives a date and no time. The server will
    // enforce these; the UI only reflects them.
    hideBookingAfterCheckoutHours: 24,
    guestLinkAfterCheckoutHours: 24,
  }),

  documents: Object.freeze({
    // The government IDs a society will accept. First entry is the default
    // when a guest uploads without picking.
    types: Object.freeze(["Aadhaar", "Passport", "Driving licence", "Voter ID", "Other govt ID"]),
    accept: "image/jpeg,image/png,application/pdf",
    maxBytes: 8 * 1024 * 1024,
  }),

  auth: Object.freeze({
    passcodeLength: 4,
    // Only the value a *fresh install* starts from, so nobody is locked out on
    // first use. The server stores a hash and must refuse to stay on this.
    firstRunPasscode: "0000",
  }),

  ui: Object.freeze({
    toastMs: 2200,
    // Lets the "all IDs in" toast land before the auto-send toast replaces it.
    autoSendDelayMs: 400,
    // How many bookings one page of the list asks for. Keeps the request, the
    // JSON and the DOM bounded however many bookings exist.
    pageSize: 25,
  }),

  // One definition of the email placeholders, used by both the template filler
  // and the hint chips in Settings, so the two can never disagree.
  templateVars: Object.freeze([
    Object.freeze({ token: "listing",      describe: "the listing's name" }),
    Object.freeze({ token: "guest_name",   describe: "the lead guest" }),
    Object.freeze({ token: "booking_id",   describe: "the Airbnb booking code" }),
    Object.freeze({ token: "check_in",     describe: "check-in date" }),
    Object.freeze({ token: "check_out",    describe: "check-out date" }),
    Object.freeze({ token: "adult_count",  describe: "how many adults" }),
    Object.freeze({ token: "society",      describe: "the society's name" }),
  ]),

  // Status is derived, never stored (see Derive.status in data.js). This is
  // only how each derived value is shown.
  status: Object.freeze({
    conflict: Object.freeze({ cls: "conflict", label: "Sync conflict", attention: true }),
    awaiting: Object.freeze({ cls: "awaiting", label: "Awaiting IDs",  attention: true }),
    ready:    Object.freeze({ cls: "ready",    label: "Ready to send", attention: false }),
    sent:     Object.freeze({ cls: "sent",     label: "Sent",          attention: false }),
  }),

  automation: Object.freeze([
    Object.freeze({ value: "before", title: "Auto-send 1 hour before check-in",
      describe: "Sends on schedule even if some IDs are still missing." }),
    Object.freeze({ value: "allids", title: "Auto-send when all IDs are collected",
      describe: "Fires the moment the last adult ID is uploaded — good for gate arrivals." }),
  ]),
});

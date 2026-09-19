// ---------------------------------------------------------------------------
// Presentation knobs only.
//
// The product's RULES — retention windows, status precedence, template
// placeholders, the send-due test — are NOT here. They live in
// ../../shared/rules.js, which the server imports too, so there is exactly one
// implementation of each (docs/DECISIONS.md, "Data, not code").
//
// What belongs here is what only a browser cares about: copy, timings, and the
// shape of a page. Anything the host owns is data — see data.js.
// ---------------------------------------------------------------------------
import { RULES, AUTOMATION } from "../../shared/rules.js";

export const CONFIG = Object.freeze({
  // Turn off for anything reachable by someone other than you. It only gates
  // conveniences that must never ship: the demo passcode on the lock screen.
  dev: true,

  // undefined = follow the browser's own locale and time zone.
  locale: undefined,

  documents: Object.freeze({
    // The government IDs a society will accept. First entry is the default.
    types: Object.freeze(["Aadhaar", "Passport", "Driving licence", "Voter ID", "Other govt ID"]),
    accept: "image/jpeg,image/png,application/pdf",
    maxBytes: 8 * 1024 * 1024,
  }),

  auth: Object.freeze({
    passcodeLength: 4,
    // The value a FRESH install starts from, so nobody is locked out on first
    // use. The server stores a hash and must refuse to stay on this.
    firstRunPasscode: "0000",
  }),

  ui: Object.freeze({
    toastMs: 2200,
    // Lets the "all IDs in" toast land before the auto-send toast replaces it.
    autoSendDelayMs: 400,
    // Keeps the request, the JSON and the DOM bounded however many bookings exist.
    pageSize: 25,
  }),

  // How each derived status is worded. The precedence and the attention flag
  // come from shared/rules.js; this is only the label the host reads. The CSS
  // class is the status key itself.
  statusLabel: Object.freeze({
    conflict: "Sync conflict",
    awaiting: "Awaiting IDs",
    ready: "Ready to send",
    sent: "Sent",
  }),

  // Copy for the two automation modes. The valid values come from shared.
  automation: Object.freeze(AUTOMATION.map((value) => Object.freeze({
    value,
    ...({
      before: {
        title: `Auto-send ${RULES.scheduledSendLeadHours} hour before check-in`,
        describe: "Sends on schedule even if some IDs are still missing.",
      },
      allids: {
        title: "Auto-send when all IDs are collected",
        describe: "Fires the moment the last adult ID is uploaded — good for gate arrivals.",
      },
    })[value],
  }))),
});

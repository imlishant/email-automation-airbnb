// The shared rules, tested on the server. The browser imports the same file,
// so a rule proved here is the rule the UI shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Derive, RULES, STATUS, fillTemplate, TEMPLATE_VARS, daysBetween, parseDay, toDay, addDays, atTime } from "../../shared/rules.js";

const times = { checkInTime: "14:00", checkOutTime: "11:00" };
const booking = (over = {}) => ({
  code: "HMABCD1234", listingName: "Sea Breeze 2BHK", leadGuest: null,
  checkIn: "2026-09-20", checkOut: "2026-09-23", children: 1,
  conflict: false, sentAt: null, automation: "allids",
  people: [{ lead: true, documentType: "Aadhaar" }, { lead: false, documentType: null }],
  ...over,
});

test("calendar arithmetic survives DST and year boundaries", () => {
  assert.equal(daysBetween("2026-09-20", "2026-09-23"), 3);
  assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2);
  assert.equal(daysBetween("2026-12-31", "2027-01-02"), 2);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(toDay(parseDay("2026-09-20")), "2026-09-20", "round-trips without a UTC shift");
  assert.equal(parseDay("2026-09-20").getDate(), 20);
  assert.equal(atTime("2026-09-23", "11:00").getHours(), 11);
});

test("adults, uploads and nights are derived, never read from a field", () => {
  const b = booking();
  assert.equal(Derive.adults(b), 2);
  assert.equal(Derive.uploaded(b), 1);
  assert.equal(Derive.nights(b), 3);
  assert.equal(Derive.complete(b), false);
  // A same-day booking still counts as one night rather than zero.
  assert.equal(Derive.nights(booking({ checkIn: "2026-09-20", checkOut: "2026-09-20" })), 1);
  // No people yet must not read as "complete".
  assert.equal(Derive.complete(booking({ people: [] })), false);
});

test("status precedence: conflict beats sent beats ready", () => {
  assert.equal(Derive.status(booking()), "awaiting");
  const all = [{ lead: true, documentType: "Aadhaar" }, { lead: false, documentType: "Passport" }];
  assert.equal(Derive.status(booking({ people: all })), "ready");
  assert.equal(Derive.status(booking({ people: all, sentAt: "2026-09-19T10:00:00Z" })), "sent");
  assert.equal(Derive.status(booking({ people: all, sentAt: "2026-09-19T10:00:00Z", conflict: true })), "conflict");
  assert.equal(Derive.needsAttention(booking()), true);
  assert.equal(Derive.needsAttention(booking({ people: all })), false);
  assert.deepEqual(Object.keys(STATUS).sort(), ["awaiting", "conflict", "ready", "sent"]);
});

test("one retention moment: hide, link death and file delete coincide", () => {
  const b = booking();
  assert.equal(Derive.visibleUntil(b, times), Derive.guestLinkExpiresAt(b, times));
  assert.equal(Derive.guestLinkExpiresAt(b, times), Derive.idFilesDeletedAt(b, times));
  // Measured from the checkout TIME, not from midnight.
  assert.equal(Derive.idFilesDeletedAt(b, times) - Derive.checkOutAt(b, times).getTime(), 24 * 3600e3);
  assert.equal(Derive.checkOutAt(b, times).getHours(), 11);
});

test("the retention windows open and shut at the right instants", () => {
  const b = booking();
  const shut = Derive.guestLinkExpiresAt(b, times);
  assert.equal(Derive.guestLinkActive(b, times, shut - 1), true);
  assert.equal(Derive.guestLinkActive(b, times, shut), true, "inclusive at the boundary");
  assert.equal(Derive.guestLinkActive(b, times, shut + 1), false);
  assert.equal(Derive.visible(b, times, shut + 1), false);
  assert.equal(Derive.canResend(b, times, shut - 1), true);
  assert.equal(Derive.canResend(b, times, shut + 1), false, "no files left to attach");
});

test("changing the host's times moves every window together", () => {
  const b = booking();
  const late = { checkInTime: "16:00", checkOutTime: "10:00" };
  assert.equal(Derive.checkInAt(b, late).getHours(), 16);
  assert.equal(Derive.checkOutAt(b, late).getHours(), 10);
  assert.equal(
    Derive.guestLinkExpiresAt(b, times) - Derive.guestLinkExpiresAt(b, late),
    3600e3,
    "an hour earlier checkout shifts the whole window an hour earlier"
  );
});

test("'1 hour before check-in' is exactly that", () => {
  const b = booking({ automation: "before" });
  assert.equal(Derive.checkInAt(b, times).getTime() - Derive.scheduledSendAt(b, times), RULES.scheduledSendLeadHours * 3600e3);
});

test("sendDue is the one answer the scheduler and the UI share", () => {
  const all = [{ lead: true, documentType: "Aadhaar" }, { lead: false, documentType: "Passport" }];
  const due = Derive.scheduledSendAt(booking({ automation: "before" }), times);

  // allids: fires on completion, regardless of the clock.
  assert.equal(Derive.sendDue(booking({ automation: "allids" }), times, 0), false, "incomplete");
  assert.equal(Derive.sendDue(booking({ automation: "allids", people: all }), times, 0), true);

  // before: fires on the clock, even with IDs missing.
  assert.equal(Derive.sendDue(booking({ automation: "before" }), times, due - 1), false);
  assert.equal(Derive.sendDue(booking({ automation: "before" }), times, due), true, "missing IDs do not block it");

  // Never twice, and never while conflicted.
  assert.equal(Derive.sendDue(booking({ automation: "allids", people: all, sentAt: "2026-09-19T00:00:00Z" }), times, 0), false);
  assert.equal(Derive.sendDue(booking({ automation: "allids", people: all, conflict: true }), times, 0), false);
  assert.equal(Derive.sendDue(booking({ automation: "nonsense", people: all }), times, 0), false);
});

test("a booking is titled by its listing, never by a guessed name", () => {
  assert.equal(Derive.title(booking()), "Sea Breeze 2BHK");
  assert.equal(Derive.title(booking({ listingName: "" })), "Booking", "never blank");
  assert.equal(Derive.leadGuestKnown(booking()), false);
  assert.equal(Derive.leadGuestKnown(booking({ leadGuest: "Priya Menon" })), true);
});

test("every template placeholder resolves, and unknown ones are left alone", () => {
  const b = booking({ leadGuest: "Priya Menon", societyName: "Greenwood Society" });
  const filled = fillTemplate(
    "{{listing}}|{{society}}|{{guest_name}}|{{booking_id}}|{{check_in}}|{{check_out}}|{{adult_count}}|{{nope}}",
    b, (iso) => iso
  );
  assert.equal(filled, "Sea Breeze 2BHK|Greenwood Society|Priya Menon|HMABCD1234|2026-09-20|2026-09-23|2|{{nope}}");
  for (const v of TEMPLATE_VARS) {
    assert.ok(!fillTemplate(`{{${v.token}}}`, b, (iso) => iso).includes("{{"), `${v.token} did not resolve`);
  }
  // Repeated placeholders all fill, and an absent value empties rather than throwing.
  assert.equal(fillTemplate("{{listing}} {{listing}}", b, null), "Sea Breeze 2BHK Sea Breeze 2BHK");
  assert.equal(fillTemplate("[{{guest_name}}]", booking(), null), "[]");
  assert.equal(fillTemplate(null, b, null), "");
});

test("the rules object is frozen, so nothing can quietly retune retention", () => {
  assert.throws(() => { "use strict"; RULES.hideBookingAfterCheckoutHours = 999; }, TypeError);
});

test("IDs stay editable for as long as the guest link lives", () => {
  const b = booking();
  const shut = Derive.guestLinkExpiresAt(b, times);
  assert.equal(Derive.documentsEditable(b, times, shut - 1), true);
  assert.equal(Derive.documentsEditable(b, times, shut), true);
  assert.equal(Derive.documentsEditable(b, times, shut + 1), false, "the files are gone by then anyway");
  // The same window the guest has — an admin is not more restricted.
  assert.equal(
    Derive.documentsEditable(b, times, shut - 1),
    Derive.guestLinkActive(b, times, shut - 1)
  );
});

test("replacing an ID after sending makes a resend owed, visibly", () => {
  const all = [{ lead: true, documentType: "Aadhaar" }, { lead: false, documentType: "Passport" }];
  const sent = "2026-09-19T10:00:00.000Z";
  // Pinned to a moment inside this booking's window. Without it the test read
  // "the files are long deleted" once real time passed the fixture's dates,
  // and quietly asserted nothing.
  const during = Date.parse("2026-09-21T12:00:00.000Z");

  assert.equal(Derive.needsResend(booking({ people: all, sentAt: sent }), times, during), false, "no document change");
  assert.equal(
    Derive.needsResend(booking({ people: all, sentAt: sent, lastDocumentAt: "2026-09-19T09:00:00.000Z" }), times, during),
    false, "the ID predates the send"
  );
  assert.equal(
    Derive.needsResend(booking({ people: all, sentAt: sent, lastDocumentAt: "2026-09-19T11:00:00.000Z" }), times, during),
    true, "the society is holding a stale attachment"
  );
  assert.equal(
    Derive.needsResend(booking({ people: all, lastDocumentAt: "2026-09-19T11:00:00.000Z" }), times, during),
    false, "never sent, so nothing to resend"
  );
  // Past the file delete there is nothing left to resend, so stop nagging.
  const b = booking({ people: all, sentAt: sent, lastDocumentAt: "2026-09-19T11:00:00.000Z" });
  const after = Derive.idFilesDeletedAt(b, times) + 1;
  assert.equal(Derive.canResend(b, times, after), false, "the files are gone");
  assert.equal(Derive.needsResend(b, times, after), false, "so the host is not nagged about a resend that cannot happen");
});

test("a replaced ID never triggers an automatic re-send", () => {
  const all = [{ lead: true, documentType: "Aadhaar" }, { lead: false, documentType: "Passport" }];
  const b = booking({ people: all, sentAt: "2026-09-19T10:00:00.000Z", lastDocumentAt: "2026-09-19T11:00:00.000Z" });
  // Pinned inside the booking's window, like the test above.
  const during = Date.parse("2026-09-21T12:00:00.000Z");
  assert.equal(Derive.sendDue(b, times, during), false,
    "sending a passport twice unasked is worse than a stale attachment the host can see");
  assert.equal(Derive.needsResend(b, times, during), true, "but the host is told");
});

test("there is exactly ONE retention instant: nothing outlives the others", () => {
  const b = booking();
  const moment = Derive.checkOutAt(b, times).getTime() + 24 * 3600e3;
  assert.equal(Derive.visibleUntil(b, times), moment);
  assert.equal(Derive.guestLinkExpiresAt(b, times), moment);
  assert.equal(Derive.idFilesDeletedAt(b, times), moment);
  assert.equal(Derive.recordExpiresAt(b, times), moment, "the record goes too — nothing is kept");
  assert.equal(Derive.fullyExpired(b, times, moment), false);
  assert.equal(Derive.fullyExpired(b, times, moment + 1), true);
});

test("placeholder names are recognised, so stand-ins never reach a security desk", () => {
  // These are what a synced booking starts with: the feed has no names.
  for (const p of ["Lead guest", "lead guest", "Adult 3", "adult 4", "Adult guest 3", "Adult", " Adult 2 "]) {
    assert.equal(Derive.isPlaceholderName(p), true, `should be a placeholder: ${JSON.stringify(p)}`);
  }
  for (const real of ["Priya Menon", "Adults Anonymous", "Rohit", "Adult Kumar", "", null]) {
    if (real) assert.equal(Derive.isPlaceholderName(real), false, `should be a real name: ${real}`);
  }
  // Empty is not a "real name" either, but it is not a placeholder pattern.
  assert.equal(Derive.isPlaceholderName(""), false);

  const b = booking({ people: [
    { lead: true, name: "Priya Menon", documentType: "Aadhaar" },
    { lead: false, name: "Adult 2", documentType: null },
    { lead: false, name: "Lead guest", documentType: null },
  ] });
  assert.equal(Derive.unnamedPeople(b).length, 2);
  assert.deepEqual(Derive.unnamedPeople(b).map((p) => p.name), ["Adult 2", "Lead guest"]);
});

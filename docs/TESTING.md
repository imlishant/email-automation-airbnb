# Testing

What we test, how, and — until there is a test runner — the manual checklist that
stands in for one.

## Current state

**`frontend/test.html` is the suite.** Open it in a browser, or serve the folder
and load `/test.html`. It needs no runner, no dependencies and no build: the page
title shows the score and every line must read PASS.

It covers the rules the product depends on — derived state, local date parsing,
retention, keyset pagination, listing filters, society resolution, template
filling, send gating, both automation modes, the adult-count guard, guest
scoping and link expiry, and passcode changes. Those are the things whose
failure would put a guest at a gate.

**There is still no CI and no runner for rendering or layout.** Those are checked
by hand against the checklist below. Be honest about which in pull requests: say
whether the checks passed and which flows you walked. A change is not verified
because the diff reads correctly.

## Strategy

The plan is deliberately lopsided, because the risk in this system is lopsided.

```
  few          End-to-end: calendar → booking → IDs → email
  some         Integration: API + database + token scoping
  most         Unit: the derivation rules and the parsers
  always       Manual: the guest flow on a real phone
```

### What gets tested first, and hard

Ranked by what it costs to get wrong:

1. **Society resolution.** A booking's society comes from its listing, always.
   Getting this wrong emails a passport to a stranger's security desk. Test that
   the resolution is correct, that it is re-read at send time, and that two
   listings in one society share a template while two societies do not.
2. **Guest token scoping.** A token grants access to exactly one booking. Test
   that a valid token cannot reach another booking by changing an id in the path
   or body, that an expired token is refused server-side, and that a forged or
   truncated token is refused without a database lookup.
3. **Send gating.** Send is locked until every adult ID is in. The
   "all IDs collected" automation fires once, on the last upload. The "1h before
   check-in" job fires once, even with IDs missing. Neither double-sends.
4. **Retention.** Bookings hide at checkout + 24h. Links die at the same moment.
   ID files delete on their schedule and the booking record outlives them.
5. **Passcode auth.** The hash is verified, lockout engages after the configured
   failures, a changed passcode takes effect immediately and invalidates nothing
   else by accident.
6. **iCal parsing.** Against real, ugly feed samples: missing guest name,
   missing headcount, cancellations, date changes, overlaps, timezones,
   duplicate booking codes.

### What is not worth testing

Rendering markup, exact copy, CSS. These change often and break visibly. Do not
write snapshot tests of HTML strings; they will produce noise and be deleted.

## Where the checks live

`frontend/test.html` asserts against `Data` and `Derive` in
[data.js](../frontend/js/data.js), which is where the rules are. That is
deliberate: the same file is meant to be shared with the server, so a check
written there keeps holding once the backend exists.

Add to it whenever you change a rule. The cases already covered, plus the ones
still to add:

- `statusOf()` — all four states, and their precedence: a conflicted booking
  that has been sent still reads as `conflict`; a sent booking with all IDs
  reads as `sent`, not `ready`.
- `uploaded()` / `total()` — including a booking whose adult count changed after
  some IDs were in.
- `soc()` — resolution through the listing; behaviour when a listing has no
  society yet.
- `fillTemplate()` — every placeholder replaced, all occurrences of each
  (the implementation uses `/g` — keep a test on that), and an unknown
  placeholder left alone rather than emptied.
- `esc()` — `&`, `<`, `>`; `null`/`undefined` coming back as `""`; and a test
  documenting that quotes are **not** escaped, so the rule in
  `CODING_STANDARDS.md` stays visible.
- `Derive.nights` across a DST boundary, and a same-day checkout.
- `fmt.ago` at the minute / hour / day thresholds.
- The ETag path, once the server exists: an unchanged list must return 304.
- `themePref()` — each stored value, an absent value, a junk value, and a
  `localStorage` that throws; all but the first must yield `"system"`.
- `guestLink()` — the id is percent-encoded, and the hash route decodes it back
  to the same id.
- `guestLinkActive()` — before checkout, one hour inside the window, one second
  past it, and across a timezone boundary.
- `fmtCal()` / `fmtLong()` — month and day-name boundaries.

## Manual checklist

Run the sections your change touches. Both themes; the guest flow on a real
phone, not a resized desktop window.

### Signing in
- [ ] Fresh load shows the sign-in screen, not the app.
- [ ] **Sign in with Google** lands on Bookings, and the sidebar names the
      account and the role (Host or Co-host).
- [ ] Locally, the development sign-in accepts the demo address and refuses an
      address nobody approved, with a reason on screen.
- [ ] **Sign out** returns to the sign-in screen and the session is dead: a
      reload does not get back in.
- [ ] A co-host sees the daily work but is told, not silently refused, when an
      action is the host's alone.

### Sending email (Settings → Sending email)
- [ ] **Connect with Google** asks only for permission to send, and coming back
      shows the connected address.
- [ ] **Send a test email** arrives, and the screen says when it was last
      tested.
- [ ] With nothing connected, **Send now** on a booking reports that no Gmail
      is connected — it never reads as sent.

### Bookings list
- [ ] Awaiting and conflict bookings are above ready and sent.
- [ ] Within each group, ordering is by check-in, nearest first.
- [ ] Each card shows the right status pill, with its dot, and the right ID
      count.
- [ ] A booking more than 24h past checkout is absent.
- [ ] The filter narrows the list and the empty state reads sensibly.

### Booking detail
- [ ] The destination card names the society reached through the booking's
      listing — check a booking on each listing.
- [ ] The mail preview shows the society's own template with every placeholder
      filled.
- [ ] One ID row per adult; the lead guest is tagged.
- [ ] Uploading an ID flips the row to done and adds a log entry.
- [ ] Send is disabled until every ID is in.
- [ ] With automation set to "when all IDs collected", the last upload sends by
      itself and logs an auto-send.
- [ ] Switching automation updates the selected radio and is keyboard-operable.

### Guest page
- [ ] "Copy guest upload link" copies a link that actually works when pasted.
- [ ] "Open the guest link" opens the guest page; the hash becomes `#u/<id>`.
- [ ] Loading that hash directly opens the guest page and nothing else — no
      sidebar, no settings, no other bookings.
- [ ] Only ID upload is offered. No send, no automation, no email.
- [ ] The adults stepper adds a row; it refuses to remove the lead guest or a
      row whose ID is already uploaded.
- [ ] All IDs in shows the done confirmation.
- [ ] A booking past checkout + 24h shows "link not active".
- [ ] Usable one-handed at 360px wide.

### Settings
- [ ] Listings show their society; connecting one requires choosing a society.
- [ ] Editing a society's desk email or template persists and is reflected in
      every booking on every listing in that society.
- [ ] Two listings in one society share the template; two societies do not.

### Appearance
- [ ] Light, Match system, and Dark each apply immediately.
- [ ] The choice survives a reload, with no flash of the wrong theme on load.
- [ ] Match system follows the OS when the OS setting is changed.
- [ ] The control appears, and works, on the sidebar, the lock screen, and the
      guest page, and all three agree on which state is selected.
- [ ] Nothing is unreadable in either theme — in particular any new `button`,
      `input`, `textarea`, or `select`, which do not inherit `color` from the
      browser.

### Layout
Check each screen at **320 · 390 · 600 · 768 · 1024 · 1600px**, in both themes.

- [ ] The page never scrolls sideways. The direct check is
      `document.documentElement.scrollWidth === window.innerWidth`.
- [ ] The mobile top bar stays on one row and nothing is pushed off it.
- [ ] Booking cards keep their status and ID count visible when they wrap.
- [ ] A long desk email or society name wraps instead of widening the page.
- [ ] Settings tabs scroll within their strip rather than widening the page.
- [ ] Every tappable target clears ~40px on a touch device.

A quick way to sweep this: load each screen in an iframe at each width and
compare `scrollWidth` to `innerWidth`, listing any element whose right edge
exceeds the viewport. It catches overflow far faster than looking at
screenshots, which crop rather than reflow.

### Cross-cutting
- [ ] Keyboard only: reach and operate every control on the screen you changed.
- [ ] `prefers-reduced-motion` stops the animation you added.
- [ ] No console errors and no `console.log`.

## When the backend arrives

- Tests run against a throwaway database per run, never a real one.
- **Never a real ID document in a fixture**, and never a real society's email
  address. Use synthetic files and `example.com`.
- The mail provider is stubbed. A test that sends a real email is a bug — and,
  given the attachments, an incident.
- The scheduler is tested by injecting a clock, not by waiting.
- iCal fixtures are checked-in sample feeds, including the malformed ones we have
  actually seen.
- CI runs the suite on every branch, and the checklist above shrinks as tests
  replace its items.

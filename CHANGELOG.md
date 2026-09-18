# Changelog

All notable changes to GatePass are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing is released or deployed yet, so there is no version tag. Work in
progress lives under **Unreleased** and moves into a dated version when the
first usable build ships — which, per `docs/ROADMAP.md`, means Phase 4:
bookings syncing in, IDs collected, email sending by itself.

**How to add an entry.** In the same commit as the change, if a user would
notice it. One line, past tense, from the host's or guest's point of view — not
the implementation's. `Guest link now stops working 24 hours after checkout`,
not `Added expiry check to token lookup`.

Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
Security entries are always listed, even when the fix is small.

---

## [Unreleased]

### Added
- `docs/TECH_STACK.md`: the stack, the reasoning per layer, the alternatives
  rejected and why, performance budgets, how the system stays fast as data
  grows, a failure behaviour for every dependency, and the trigger that would
  make each choice worth revisiting. This closes the backend-stack open
  decision: **Node 22 + Fastify + SQLite (WAL) + Drizzle**, in-process jobs, one
  small VPS.
- `frontend/test.html`: runnable checks with no runner and no dependencies —
  derived state, local date parsing, retention, keyset pagination, listing
  filters, society resolution, template filling, send gating, both automation
  modes, the adult-count guard, guest scoping and expiry, passcode changes.
  33 checks, all passing.
- `frontend/js/config.js` and `frontend/js/data.js`: every tunable the product
  owns, and the single boundary through which data arrives.
- ID type is now chosen when uploading, from the list in `config.js`, instead of
  every upload being recorded as an Aadhaar.
- The bookings list pages with a keyset cursor and a "Show more" that appends
  rather than re-rendering, so a long list stays cheap.

### Appearance
- Appearance control: Light / Match system / Dark, in the sidebar, on the lock
  screen, and on the guest page. The choice is remembered per device and is
  applied before the first paint, so there is no flash of the wrong theme.
  "Match system" stores nothing and follows the OS.
- Project documentation set: `CLAUDE.md` for contributor and agent orientation,
  and `docs/` covering context, architecture, product principles, design,
  coding standards, testing, security, review, triage, and project workflow.

### Changed
- **Nothing in the frontend is hardcoded any more.** Values the host owns moved
  to `data.js`, values the product owns to `config.js`, and `app.js` now holds
  no literal at all. Removed along the way: the `MONTHS` and weekday tables (now
  `Intl`), the hardcoded host name and listing count in the shell markup, the
  fabricated iCal URL in Settings, the `"Aadhaar"` default on every upload, the
  `24 * 3600 * 1000` retention arithmetic repeated in two places, the `"0000"`
  passcode in three, the template placeholder list duplicated between the filler
  and the Settings hints, and every inline `style` that carried a reusable rule.
- The data layer is **async and API-shaped** ahead of the server existing, so
  connecting the backend replaces function bodies in `data.js` and changes no
  screen. Renders are sequenced, so a slow response cannot paint over a newer
  screen.
- Adult count, night count and status are now **derived**, not stored. The
  stored `adults` and `nights` fields are gone.
- Dates are formatted with `Intl` in the viewer's own locale, and date-only
  values are parsed as a **local** day.
- "Copy guest upload link" now copies the guest's real link instead of only
  showing a toast, and a plain "Open the guest link" link sits beside it.
- The layout was checked at every width from 320px to 1600px on all four
  screens. The page no longer scrolls sideways at any of them; the mobile top
  bar keeps to one row, booking cards put their status on a second line, the
  settings tabs scroll on their own, and tap targets clear ~40px on touch.

### Removed
- "Preview guest page". The guest page is reached by the guest's own link, which
  the host can now copy or open, so a separate preview button was a second path
  to the same screen. The dead modal-based preview it once used went with it.

### Fixed
- Date-only values were parsed as UTC midnight, so every check-in and checkout
  displayed a day early for anyone west of UTC. `parseDay` now reads the parts
  as a local day.
- `initials()` threw on a single-word or empty name.
- Dark mode was close to unreadable: a booking card is a `<button>`, and
  `<button>` does not inherit `color`, so guest names fell back to the browser's
  near-black default button text on a near-black card. Buttons now inherit the
  ink colour. Secondary and faint text were also lifted for contrast, and
  `color-scheme` is declared per theme so native inputs and scrollbars follow.

### Security
- User-supplied strings — guest names, listing and society names, desk emails,
  ID types, templates — now go through `esc()` before reaching `innerHTML`. The
  two society email inputs set their value as a property after mounting, because
  `esc()` does not escape quotes and so must never fill an attribute.

### In progress
- Nothing. Phase 1 (backend foundations) has not started; see
  `docs/ROADMAP.md`.

---

## 0.1.0 — 2026-09-18 — prototype

The first commit. A working UI prototype over mock data, plus the written
decisions behind it. No server, no persistence, no email.

### Added

**Admin**
- Bookings list: attention first (awaiting IDs, sync conflicts), then ready and
  sent, each group ordered by check-in with the nearest first.
- Booking detail: one ID row per adult guest, upload, derived status, and an
  activity timeline.
- Email preview showing the society's own template with booking values filled
  in, and the ID files as attachments.
- Per-booking automation choice: send 1 hour before check-in, or send when all
  IDs are collected.
- Manual send, locked until every adult ID is in.
- Settings: connect listings (each assigned to one society by hand), edit each
  society's security-desk email and template, change the admin passcode.
- Bookings drop off the list 24 hours after checkout.

**Guest**
- Mobile-first guest page reached by the booking's own link, showing only that
  booking and only the ID upload.
- Adults stepper, so a guest can confirm the headcount the Airbnb calendar does
  not provide and add visitors mid-stay.
- Link active until checkout + 24 hours; past that it shows "link not active".

**Access**
- Admin side behind one shared 4-digit passcode, default `0000` on a fresh
  install, changeable in Settings.

**Design**
- Warm paper-toned visual system, tokenised in CSS variables, light and dark
  aware, with reduced-motion honoured.

**Documentation**
- `docs/DECISIONS.md` — every product decision made so far, and the open ones.
- `docs/ROADMAP.md` — phases 0 through 5.
- `backend/README.md` — planned data model, API surface, and jobs.
- `backend/.env.example` — the configuration surface.

### Known limitations

Properties of the prototype, not open bugs. Each closes with its roadmap phase.

- All data is mock data in `frontend/js/app.js`; every change is lost on reload.
- Sending sets a flag and shows a toast. No email is sent.
- Uploading sets a flag. No file is read, transferred, or stored.
- The passcode is compared in client-side JavaScript and is decoration, not
  access control.
- The guest link is `#u/<booking-id>` — guessable by construction. Real signed
  tokens are Phase 3.
- The "1 hour before check-in" automation never fires; there is no scheduler.
- No calendar sync. Bookings are hardcoded.
- No automated tests and no CI.

### Security

- Not deployable. See `docs/SECURITY.md` — the prototype has no security
  properties, deliberately, and must not be exposed on a public URL before
  Phases 1 and 3 land.

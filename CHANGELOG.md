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

- **Many hosts on one deployment.** Sign in with Google; each host gets their
  own account holding their listings, societies, times and sending Gmail, and
  can invite co-hosts by address. The site owner keeps the list of addresses
  allowed to start an account. Migration `007_accounts.sql`; existing data is
  moved into one account and adopted by `PLATFORM_OWNER_EMAIL` at first
  sign-in.
- **Each host connects their own Gmail** in Settings → Sending email, with a
  Gmail App Password stored encrypted and a "send a test email" button that
  proves it works before a guest's ID depends on it.
- Settings has new **Sending email** and **Access & activity** tabs; the
  activity log now names the person who made each change.

### Removed

- The shared 4-digit passcode and the owner magic-link sign-in, replaced by
  Google accounts. `src/auth/{admin,passcode,owner}.js` are gone.

- **ID photos stored encrypted in the database** (`STORAGE_DRIVER=db`, now the
  production default). Migration `006_file_blobs.sql`. No Cloudflare R2 account
  needed: Render + Turso + Gmail is the whole setup. The retention purge
  deletes the stored bytes along with the booking.
- `.node-version` pins Node 22 so Render doesn't pick an untested release.
- **Add a society** now opens a real form (name, desk email, Cc, a starter
  template). It was a placeholder that only showed a message, which also
  blocked connecting listings. "New society…" in the listing form opens it.
- Pasting a calendar link reads it straight away and fills the listing name.
- Switching browser tabs no longer re-renders Settings or anything mid-edit,
  so half-filled forms survive.
- Passcode change: admins signed in with the passcode now see that only the
  owner can change it, and how; before, the button failed silently. Every
  failure now shows a message. A **Lock** button (sidebar) signs out, which is
  also the way to reach the owner sign-in link.
- The sidebar listing count updates when listings change.
- **Every screen has its own address**: `#bookings` (home), `#bookings/<id>`,
  `#settings/listings|societies|access`. Refresh, Back/Forward and bookmarks
  keep your place. The GatePass logo goes home.
- The app loads at the site root (`/`) instead of `/frontend/index.html`; old
  links redirect. The server now serves only `frontend/` and `shared/` — it
  previously served the whole repo, including backend source and docs.
- **`npm run loadtest`** — seeds a throwaway database at realistic size and at
  100x, drives the real server, and checks every budget in `TECH_STACK.md` §4,
  including the memory of a real server process.
- **Owner tier.** The owner signs in with a single-use link emailed to
  `OWNER_EMAIL` — never an address taken from the request — which expires in 15
  minutes and is stored only as a hash. Changing the passcode, editing or
  deleting a society, and disconnecting or deleting a listing become owner-only.
  Opt-in: with no `OWNER_EMAIL`, every admin can still do everything.
- **Live updates.** Open tabs refresh themselves when a booking changes, over
  SSE. The stream carries only a booking id — never a name or a document — and
  each client re-fetches through the normal API; a guest's stream hears only
  about their own booking. Verified in a real second browser tab: the guest link
  showed 2 adults, the admin set 3 from elsewhere, the guest tab showed 3 with no
  reload.
- **Admin audit trail** in Settings → Admin access: configuration changes,
  passcode changes and lockouts, with the address each came from.
- **Automatic sending and the retention purge.** The tick now syncs, sends what
  is due, then purges what has expired. "When all IDs are collected" fires on
  the last upload; "1 hour before check-in" fires on the clock with whatever has
  arrived and tells the desk who is still awaited (never with zero IDs).
  At-most-once is a unique index; failures retry up to five times and are
  written to the booking's timeline. The purge deletes files before rows, so a
  failed file delete keeps the row and retries instead of orphaning an
  encrypted ID forever.
- `npm run demo` fills a local database for clicking through; `npm start`
  reads `backend/.env`.
- **The security email actually sends (Phase 4).** SMTP from the host's own
  Gmail via nodemailer, with the stored IDs decrypted into memory at send time
  — never written to disk in the clear — and attached as
  `Priya_Menon_Aadhaar.jpg` so a desk can match a file to the person in front of
  them. Tested against a real SMTP sink rather than a mock.

  **If any single ID cannot be produced, the entire send is refused**: a missing
  file, one that will not decrypt, one already deleted, or a set over the
  provider's limit. An email with a missing ID is worse than no email — the desk
  clears the guests it has and stops the one it does not, at the gate. The
  refusal names whose file is the problem.

  The subject line is deliberately plain ASCII. An em-dash forces RFC 2047
  encoding and line folding, which every modern client decodes but an old
  mailbox at a society desk may show as gibberish — and the subject is the first
  thing they read.
- **ID documents are actually stored now, encrypted (Phase 3).** Upload for the
  admin and for the guest, through one pipeline: the size capped while reading,
  the type decided by the **bytes** rather than the filename, JPEG metadata
  stripped, AES-256-GCM with a fresh IV per file, and an opaque storage ref.
  Bytes are written before the row, and a refused row deletes its blob.

  **The browser resizes and re-encodes before sending**, so the GPS a phone
  writes into a photo of a passport — usually someone's home — never leaves the
  device, and a 12-megapixel photo becomes a few hundred KB on a gate's mobile
  connection. The server strips it again, because a raw POST can bypass the
  browser. Verified end to end with a real GPS-bearing JPEG.

  **Reading a document back is admin-only.** A guest can put an ID in and replace
  it, and can never download one — not even their own.

  Local disk for development; Cloudflare R2 for production via `aws4fetch`
  (65KB, against the AWS SDK's 3.3MB). Production refuses to boot on
  `STORAGE_DRIVER=local` or without `FILE_ENCRYPTION_KEY`.
- **Calendar sync (Phase 2).** `POST /api/jobs/tick` — secret-authenticated,
  non-overlapping — polls every connected listing; `POST /api/sync` and
  `/api/listings/:id/sync` force a check. Bookings upsert by Airbnb code,
  falling back to the feed's own UID, so a date change updates in place and the
  IDs already collected survive. New bookings get one **unnamed** lead guest,
  because the feed carries no name and none is invented.

  Failure never loses data: a feed that is down leaves every booking alone and
  goes visibly stale; an Airbnb login page is an error, not an empty calendar;
  overlapping reservations flag **both** rather than merging; and a booking that
  disappears from the feed is **flagged, never deleted** — it may be a
  cancellation or a parse quirk, and the host decides.
- **The frontend now runs on the API.** `data.js` is `fetch` calls; `SEED` is
  deleted. **No screen changed** — the payoff for having written the data layer
  against an interface and made it async before there was a server to be async
  about.
- **Fastify serves the frontend**, from the same origin as the API, so the
  session cookie works with no CORS to configure or get wrong. `npm start` now
  serves the whole application at one URL.
- **Signed guest tokens**, brought forward from Phase 3 so the guest page did
  not break in the move: 128 bits from a CSPRNG, HMAC-signed so a forged token
  is rejected without a database hit, expiry enforced server-side, one live link
  per booking, regeneratable if a link is shared too widely. Every `/u/:token`
  route resolves its booking **from the token** and ignores any id in the
  request — the bug that would show one guest another guest's passport.
- **Browser checks rewritten as screen smoke tests** against the live server.
  The old suite tested the mock data layer, which no longer exists; the new one
  mounts every screen and asserts it renders, which is exactly the gap that let
  two bugs through (the missing `listingRow`, and the Societies tab).
- **Booking mutations over HTTP**: set the adult count, name a person, add or
  replace a document, remove one, switch automation, and send. The retention
  window is enforced on the **server** using the same `Derive.documentsEditable`
  the browser uses, so a late request is refused however it arrives. Every
  change writes an activity row in the same transaction.
- **The send path, with the transport boundary that keeps it honest.**
  `sent_at` is written only after the mail transport reports success. With no
  transport configured the endpoint returns **503** and the booking is left
  untouched — a booking reading "Sent" with nothing delivered would stop the
  host chasing and leave the guest at the gate. A transport failure changes
  nothing; `MAIL_TRANSPORT=recording` is fatal at boot in production. Phase 4
  adds SMTP and nothing else changes.
- **Bookings read endpoints.** `GET /api/bookings` is keyset-paginated,
  filterable by listing, ordered attention-first then chronologically, bounded
  by retention using the host's own check-out time, and carries an **ETag** so
  reopening the tab costs a 304 with no body. `GET /api/bookings/:id` adds the
  society, the activity log and the times.

  The API returns **facts, never a computed status** — no `status`, `adults` or
  `nights` field crosses the wire. The client derives them from
  `shared/rules.js`, the same module the server uses, so a second source of
  truth cannot appear. Tests assert both that those fields are absent and that
  the client reaches the answer the server would.
- **Guest names can be typed, by either side.** The Airbnb feed carries no
  names and nothing is read off an ID document, so a human typing is the only
  source — and the security desk sees the result. Names are now editable in
  place on the booking detail *and* on the guest page, for any person on the
  booking. Placeholders like "Lead guest" and "Adult 3" are recognised, styled
  as unfinished, and nudged about, because a desk receiving
  "Adult_3_Aadhaar.pdf" cannot match it to the person at the gate. Naming the
  lead guest also sets the booking's identifying name.
- **The adult count is on the booking detail**, not only the guest page. The
  host had to open the guest link to change it, which made no sense. Guards moved
  into the data layer: at least 1, at most 30, and an adult whose ID is already
  uploaded cannot be removed — the UI says which rather than silently refusing.
- Returning to a background tab re-reads everything, which covers most of the
  staleness between an admin tab and an open guest link.
- **Backend Phase 1b: the HTTP API.** Fastify with JSON Schema on every route
  and `removeAdditional` **off**, so an unknown field is rejected rather than
  silently stripped. Security headers on every response, `no-store` on anything
  carrying personal data, log redaction of cookies, passcodes and the guest
  token in the URL, and an error handler that never leaks an internal message.
  Signed HttpOnly `SameSite=Lax` session cookie. Per-IP rate limiting returning
  429 with `Retry-After`. Boot refuses an unsafe production config: no
  `SESSION_SECRET`, no `JOBS_TICK_SECRET`, or a plain-http `APP_BASE_URL`.
- **Societies and listings over HTTP.** Desk addresses validated, partial
  updates that cannot blank other fields, a society that cannot be deleted while
  a listing points at it, and a listing that must name a society that exists —
  the destination is never guessed. **Disconnect** keeps bookings; **delete** is
  refused while any exist.
- **`POST /api/listings/check`** reads a calendar and reports what it found
  *before* anything is saved, so connecting a listing is not an act of faith.
  Catches the classic mistake of pasting the Airbnb page URL instead of the
  Export link, with a message that says so.
- **Backend Phase 1b: admin passcode auth.** `scrypt` from `node:crypto`, so
  **no new dependency**. Self-describing hash format (`scrypt$N$r$p$salt$hash`)
  so the cost can be raised later without invalidating existing hashes, and a
  successful unlock silently upgrades one stored under weaker parameters.
  Constant-time compare, and a corrupt or non-scrypt value in the column fails
  closed rather than being accepted.

  The real control is the **escalating lockout**: past the attempt threshold
  every single wrong guess re-locks, and the duration doubles every
  `AUTH_MAX_ATTEMPTS` failures, capped at an hour so a host is never locked out
  permanently. An attacker therefore gets one guess per lock window. Locked
  attempts short-circuit before any scrypt work, so they cannot be used to load
  the CPU. A wrong passcode, an unconfigured system and a missing admin row are
  indistinguishable in both shape and timing.

  `passcode.js` opens with a blunt note on what the hash does *not* buy: a
  4-digit code is 10,000 possibilities and no KDF fixes that. Worth reading
  before trusting it.
- **Backend Phase 1b: schema and migrations.** Ten tables, forward-only numbered
  `.sql` files, and a ~40-line migrator that is a no-op when up to date
  (`npm run migrate`). The same code runs against a local file in development
  and Turso in production, distinguished only by an env var. The schema enforces
  the product's decisions instead of trusting care: one booking code, one lead
  guest per booking, one ID per adult, one live guest link, `check_out >=
  check_in`, enum CHECKs, RESTRICT so a society cannot be deleted from under a
  listing, and a partial unique index that makes a second automated send
  impossible. `bookings` has no `status`, `adults`, `nights` or `society_id`
  column, and a test asserts their absence. All eight hot queries carry an
  `EXPLAIN QUERY PLAN` assertion: an index is used, and nothing sorts in memory.
- **`shared/rules.js` — one implementation of the rules, imported by the
  frontend and the server.** Status precedence, retention windows, calendar
  arithmetic, `sendDue`, and template filling now exist once. Two copies of the
  status rule is the bug that makes the UI say "ready to send" while the server
  computes "awaiting" and the email silently never goes; that class of bug is
  now structurally impossible. 23 checks on the server, 49 in the browser,
  against the same file.
- **Backend Phase 1a: the Airbnb calendar reader.** `npm run probe -- <export
  link>` fetches a real listing calendar and reports what it can see. Handles
  RFC 5545 line folding, extracts the booking code from the reservation URL,
  treats `DTEND` as the checkout day, keeps date-only values as calendar days,
  distinguishes reservations from blocked dates, collapses duplicates, repairs
  missing `DTEND` and zero-length spans with a warning, and detects overlapping
  reservations without flagging back-to-back stays. Bounded fetching: https
  only, no private hosts, timeout, byte cap, and a clear message when a link
  returns Airbnb's login page instead of a calendar. 12 checks, zero
  dependencies.
- Global **check-in / check-out times** in Settings. The feed gives dates with
  no clock time, and "1 hour before check-in" needs a moment.
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
- **Retention collapsed further: nothing is kept.** The booking record, its
  people and its activity log are now deleted at the same instant as the ID
  files and the guest link — checkout + 24h. The plan had been to keep the
  record for 90 days as proof the IDs reached security; that was dropped
  deliberately. The accepted cost, recorded in `DECISIONS.md`: after that moment
  there is nothing to show a society that disputes receipt.
- **A resend now goes to the address the first send used.** The destination was
  resolving live through the listing, so changing a listing's society would
  silently redirect a resend. It is now pinned onto the booking at send time
  (migration `003`), which also removed the need for the warning the old
  behaviour required.
- **Drizzle dropped from the plan.** It was chosen for "SQL you can read, types
  you can trust", but this is plain JavaScript — there are no types to trust,
  and the benefit collapsed to a query builder over ten tables whose hot path is
  one `SELECT`. Replaced by parameterised SQL in `src/db/`, leaving
  `@libsql/client` as the single dependency for the whole data layer. Revisit if
  this ever moves to TypeScript.
- **The frontend is now ES modules.** One entry point, `js/app.js`, importing
  `config.js`, `data.js` and `shared/rules.js`. The globals are gone.
  **Breaking, deliberately:** `frontend/index.html` can no longer be opened from
  `file://`, because browsers block module imports over that scheme. Serve from
  the repo root instead — `python3 -m http.server`, then
  `/frontend/index.html`. The trade was one shared rules file against a
  convenience that already had a documented alternative.
- **Hosting reconsidered and Render reaffirmed** (2026-09-19). Cloudflare
  Workers + D1 + R2 is the better technical fit — never sleeps, free cron built
  in, D1 is SQLite so the schema would be unchanged — but it would cost Fastify
  → Hono and push image processing into the browser to fit a 10ms CPU budget.
  Oracle Cloud's always-free VM would let the original plan run untouched, at the
  cost of becoming a sysadmin. Both are recorded in `DECISIONS.md` with the
  reasoning, so the question is settled rather than merely answered. Nothing
  built is host-specific: the calendar reader has zero `node:` imports and uses
  only web-platform APIs, so it already runs on Workers, Deno or Bun unchanged.
- **Render's free tier revised the stack.** It has no persistent disk (a local
  SQLite file and a local `uploads/` directory both vanish on deploy) and sleeps
  after ~15 minutes idle, which would have stopped the scheduler entirely.
  Database moved to **Turso (libSQL)**, files to **Cloudflare R2** from day one,
  and an external free cron ping to `/jobs/tick` now both drives the job queue
  and keeps the instance awake so a guest never meets a cold start. Still €0.
  The schema, the rules, the API and the whole frontend were untouched by this.
- **Retention collapsed to one moment: checkout + 24h**, measured from the real
  checkout time rather than midnight. The booking leaves the list, the guest
  link dies, and the ID files are deleted together. Accepted consequence: past
  that point a booking cannot be resent, and the UI now says so instead of
  offering a button that would fail.
- **A booking is titled by its listing**, not by a guest name the feed never
  supplies. The booking code sits beside it, and the lead guest's name appears
  only once it is genuinely known. A freshly synced booking reads
  "Guest not yet identified · phone ends 7731" rather than showing a blank.
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
- **The bookings list loaded every booking and every guest on each request.**
  It then cut one page out in JavaScript, so page 2 cost the same as page 1 and
  memory grew with the data — to ~400MB at 100x, close to Render's 512MB limit.
  The docs claimed keyset pagination made cost flat; the code never did. Now it
  loads one narrow row per booking to decide the order, then full details for
  the page only: 2x faster, and 100x the data costs ~15MB instead of ~225MB.
- **The booking detail made 9 database round trips.** Harmless on a local file,
  ~180ms on Turso against a 90ms budget. Now 2, using `batch()`.
- **The memory budget had never been measured.** 150MB, against a real baseline
  of ~172MB. Now 256MB — half of Render's instance — with the reasoning written
  down.
- "Society saved" and "Passcode updated" were shown without checking whether
  the save worked, so a network error or an invalid desk address still read as
  success. Both now report the server's actual answer. Found while wiring the
  owner tier, which would have made them lie routinely.
- **Restarting the server killed every guest link already sent.** The guest
  signing secret was derived from the session secret, which is generated fresh
  on each boot when unset — and in production, rotating `SESSION_SECRET` (the
  documented way to log every admin out) would have killed them too. A code
  comment claimed the two were independent; they were not. Now
  `GUEST_TOKEN_SECRET` is its own setting, required in production, and a link
  that no longer verifies is replaced rather than handed to the admin to copy.
- **Guests on a booking could shuffle order between page loads.** Like the
  activity log before it, people inserted in the same millisecond tied on
  `created_at` and fell back to a random id. Now insertion order (`rowid`).
  Found by chasing a test that failed one run in three.
- **A booking's activity log could display out of order.** Rows written in the
  same millisecond tied on timestamp and fell back to `id DESC`, which is not
  monotonic. Now ordered by SQLite's `rowid`, which is. Found because a test
  passed alone and failed in a full run — worth chasing rather than dismissing
  as flake.
- The client no longer simulates an automatic send. It used to fake the "all IDs
  collected" trigger and toast "auto-sent"; with a real server that would claim
  mail left when none did. The scheduler owns that trigger (Phase 4).
- "Sync now" says calendar sync is not connected yet, rather than reporting
  "no new bookings" from a poll that never ran.
- The admin passcode is no longer displayed in Settings or hinted on the lock
  screen. The server stores only a hash and cannot read it back.
- `@fastify/static` was registered with `wildcard: false`, which globs the
  directory at boot — any file added afterwards 404s until a restart.
- **Settings → Societies & templates rendered nothing.** `socCard` still read
  `CONFIG.templateVars`, which had moved to `shared/rules.js` as
  `TEMPLATE_VARS` during the ES-module refactor — so it threw on `.map` of
  `undefined` and the whole tab came back empty. A second stale reference,
  `CONFIG.retention` in `Data.config()`, would have returned `undefined` to any
  caller; both are fixed, and a check now confirms every `CONFIG.<key>` used
  actually exists. The test suites did not catch either, because they exercise
  the data layer and never render.
- Seed and fixture email domains moved to RFC 2606 reserved names
  (`greenwood.example`, `hillcrest.example`). The previous `.in` domains did not
  resolve but were registrable, and a dev database still holding seed data would
  have emailed a stranger once SMTP was configured.
- `.gitignore` hardened to `.env.*`, `*.pem`, `*.key`, `backend/data/` and
  `*.db-journal`, verified with `git check-ignore` rather than by eye.
- Admin auth ran as a `preHandler`, which Fastify runs *after* body validation —
  so an anonymous caller got schema feedback, and made the server parse their
  body, before being refused. It now runs as `onRequest`.
- `@fastify/rate-limit` returned 500 instead of 429: its response builder threw
  a bare object with no `statusCode`, which the error handler read as a server
  error.
- `npm run migrate` no longer writes `PLACEHOLDER_NOT_A_HASH` as the admin
  passcode. It hashes the first-run passcode properly and **exits non-zero** if
  the passcode is unusable, so a misconfiguration fails the deploy instead of
  producing a server that accepts nothing. This was the last blocker on
  deploying at all.
- `TECH_STACK.md` claimed the bookings list was "one indexed scan". `EXPLAIN`
  disagreed — the retention index could not also satisfy `ORDER BY check_in`,
  so SQLite was sorting in memory. Migration 002 adds `bookings_chrono`, which
  the keyset cursor needs anyway, and the doc now states what the planner
  actually does.
- `openDatabase` created the `data/` directory rather than letting a fresh clone
  fail with SQLite error 14.
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

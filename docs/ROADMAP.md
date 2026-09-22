# Roadmap

> **Scope is frozen.** 19 items remain, listed below. Nothing is added to this
> file unless the maintainer asks for it. A build task does the item it names
> and stops; if it cannot be done without adjacent work, that is raised as a
> question rather than absorbed into the turn.

Phases in build order. Check items off as they land.

## Phase 0 — UI prototype (done)

- [x] Bookings list: attention on top, ready/sent below, chronological
- [x] Booking detail: adult ID rows, upload, status
- [x] Per-society email template and security desk
- [x] Booking → society resolved through its listing
- [x] Guest upload page, mobile-first, only IDs
- [x] Single guest link per booking, scoped to that booking
- [x] Guest link active until checkout + 24h; add-adults for visitors
- [x] Admin 4-digit passcode lock, default 0000, changeable in Settings
- [x] Auto-remove bookings 24h after checkout (list hide)
- [x] Automation choice: 1h before check-in / when all IDs collected
- [x] Settings: Listings, Societies & templates, Admin access
- [x] Light / Match system / Dark appearance control, remembered per device
- [x] Layout verified 320px → 1600px on every screen, no sideways scroll

## Phase 1 — Backend foundations

Stack and the schema-shaping decisions are settled — see `TECH_STACK.md` and
`DECISIONS.md`. Nothing in 1a/1b re-opens them.

- [x] Choose stack: Node + Fastify + Turso (libSQL) + Drizzle, hosted on Render
- [x] Settle the decisions that shape the schema: global check-in/out times,
      what a booking is called, guest access, retention (`DECISIONS.md`)

## Phase 1a — the calendar reader (done, no infrastructure)

Built first, deliberately: the feed is the one part of this system we do not
control, so it was proved against real data before a schema was designed around
it. Run `npm run probe -- <your export link>` in `backend/`.

- [x] RFC 5545 unfolding, property and parameter parsing, TEXT unescaping
- [x] Booking code extracted from the reservation URL, with a bare-code fallback
- [x] `DTEND` treated as the checkout day; nights derived on the calendar
- [x] Date-only values kept as calendar days — no UTC day-shift
- [x] Reservations distinguished from blocked dates; unclassifiable events kept,
      not dropped
- [x] Duplicate events collapsed; missing `DTEND` and zero-length spans repaired
      with a warning
- [x] Overlap detection, with back-to-back stays correctly not flagged
- [x] Bounded fetch: https only, no private hosts, timeout, byte cap, HTML-page
      detection with an actionable message
- [x] `connectListing()` — one report, used by the probe now and by
      `POST /listings` next
- [x] 12 checks in `backend/test/` (`npm test`)

## Phase 0c — gaps found by using it

- [x] **Name any guest, from either side.** Editable in place on the booking
      detail and on the guest page. Placeholders ("Lead guest", "Adult 3") are
      recognised and styled as unfinished, with a nudge on the booking, because
      the security desk reads these names.
- [x] **The adult count is on the booking detail too**, not only the guest page —
      the host no longer has to open the guest link to change it
- [x] Guards on the count moved into the data layer: min 1, max 30, and an
      adult whose ID is already in cannot be removed, with the UI saying why
- [x] Returning to a background tab re-reads everything
      (`visibilitychange`), which covers most of the two-tab staleness. Real
      live updates are the SSE item in Phase 5.

## Phase 0b — prototype gaps closed

Found by using the prototype rather than by planning.

- [x] Listing **edit** (name, calendar link, society), **disconnect**, and
      **delete guarded** by "has bookings" — with the society change logged
      against already-sent bookings, because a resend would misroute
- [x] **Replace an ID**, by admin *or* guest, for as long as the guest link
      lives; a replacement never auto-re-sends, it raises "Resend needed"
- [x] `dev.sh` and a root `index.html` redirect, so the dev server cannot be
      started from the wrong directory

## Phase 1b — server foundations

- [x] **One shared rules module** (`shared/rules.js`), imported by the browser
      and the server — status precedence, retention, calendar maths, `sendDue`,
      template filling. The frontend moved to ES modules to import it, and its
      duplicate was deleted. 23 checks server-side, 49 in the browser, one file.
- [x] **Schema and migrations.** Ten tables, forward-only numbered `.sql` files,
      a ~40-line migrator that is a no-op when up to date. `npm run migrate`.
      Runs against a local file in development and Turso in production with no
      code difference.
- [x] `app_settings`: the global check-in / check-out times
- [x] Constraints that enforce the decisions rather than trusting care: one
      booking code, one lead guest per booking, one ID per adult, one live guest
      link, `check_out >= check_in`, enum CHECKs, RESTRICT so a society cannot be
      deleted out from under a listing, and a **partial unique index making a
      second automated send impossible**
- [x] No `status`, `adults`, `nights` or `society_id` column on `bookings` —
      asserted by a test, since they are all derived
- [x] `EXPLAIN QUERY PLAN` assertions on all eight hot queries: an index is used
      and nothing sorts in memory
- [x] **Admin passcode auth.** `scrypt` from `node:crypto` — zero new
      dependencies — with a self-describing hash format, silent re-hash on
      upgrade, constant-time compare, and fail-closed handling of a corrupt
      hash. Escalating attempt lockout in which every wrong attempt past the
      threshold re-locks, doubling per tier and capped. Locked attempts
      short-circuit so they cannot load the CPU. Wrong passcode, unconfigured
      system and missing row are indistinguishable. 20 checks.
- [x] `npm run migrate` now writes a **real** hash on first run and exits
      non-zero if the passcode is unusable, so no deployment can sit on a
      placeholder
- [x] **Fastify skeleton.** JSON Schema on every route with `removeAdditional`
      **off**, so an unknown field is rejected rather than silently stripped.
      Security headers on every response, `no-store` on anything carrying
      personal data, log redaction of cookies, passcodes and the guest token in
      the URL, JSON 404s, and an error handler that never leaks an internal
      message. `/healthz` reports the database and nothing else.
- [x] **Boot-time config validation.** Production refuses to start without
      `SESSION_SECRET`, without `JOBS_TICK_SECRET`, or on a plain-http
      `APP_BASE_URL` — guest tokens travel in the URL. It also refuses if the
      admin passcode is not properly configured.
- [x] **Admin sessions.** Signed, stateless, HttpOnly + SameSite=Lax cookie,
      `Secure` in production. Rotating `SESSION_SECRET` invalidates every
      session; changing the passcode retires the current one.
- [x] **Per-IP rate limiting** on auth and globally, returning 429 with
      `Retry-After` — the HTTP half of the brute-force defence
- [x] Routes: `POST /api/auth/unlock`, `/auth/lock`, `/auth/passcode`,
      `GET /auth/session`, `/auth/status`. 15 HTTP checks.
- [x] Admin passcode auth: slow hash, constant-time compare, attempt lockout,
      HTTP-only `SameSite=Lax` cookie
- [x] **Societies CRUD.** Desk address pattern-validated, partial updates that
      cannot blank the other fields, listing count via one aggregate rather than
      N queries, and delete refused with a reason while a listing points at it.
- [x] **Listings CRUD.** A society must be named and must exist — the
      destination is never guessed. Calendar-link shape enforced before storage
      (https only, no private hosts). Changing the link resets the sync state; a
      rename does not. **Disconnect** keeps bookings, **delete** is refused
      while any exist.
- [x] **`POST /listings/check`** — fetches and reads a calendar and reports what
      it found *before* anything is saved, so connecting a listing is not an act
      of faith. Verified against the classic mistake of pasting the Airbnb page
      URL instead of the Export link.
- [x] **`GET/PATCH /settings/times`** for the global check-in/check-out times
- [x] Auth runs as `onRequest`, before body validation, so an anonymous caller
      gets a 401 rather than schema feedback. 25 more HTTP checks.
- [x] `POST /jobs/tick`, secret-authenticated and idempotent
- [x] Rate-limit the guest endpoints (per-IP, alongside auth and global)
- [x] **The frontend runs on the API.** `data.js` is `fetch` calls and `SEED` is
      deleted. No screen changed, which was the point of writing the data layer
      against an interface.
- [x] **The frontend is served by Fastify**, from the same origin as the API, so
      the session cookie works with no CORS to configure or get wrong. `npm
      start` now serves the whole application.
- [x] **Signed guest tokens**, pulled forward from Phase 3 so the guest page did
      not break: 128 bits from a CSPRNG, HMAC-signed so a forged one is rejected
      without a database hit, expiry enforced server-side, one live link per
      booking, regeneratable.
- [x] `/u/:token` guest routes — read, adult count, rename, document — each
      resolving the booking **from the token** and ignoring any id in the
      request
- [x] The passcode is no longer displayed anywhere. The server stores a hash and
      cannot read it back; the demo hint on the lock screen is gone.
- [x] **Browser checks rewritten as screen smoke tests** against the live
      server, covering the gap that let two render-time bugs through
- [x] **Bookings read endpoints.** `GET /bookings` — keyset-paginated, filtered
      by listing, attention-first then chronological, bounded by retention using
      the host's own check-out time, with counts for the whole set and an
      **ETag** so reopening the tab costs a 304 and no body. `GET /bookings/:id`
      adds the society, the activity log and the times.
- [x] The API returns **facts, never a computed status**: no `status`, `adults`
      or `nights` field. The client derives them from `shared/rules.js`, the same
      module the server uses, so a second source of truth cannot appear. A test
      asserts those fields are absent and that the client reaches the same
      answer.
- [x] A test caps the list at a **constant number of queries** regardless of how
      many bookings it returns — N+1 is a real cost now the database is a
      network hop away.

## Phase 2 — Airbnb calendar sync

- [x] Parse events into bookings (Phase 1a)
- [x] Handle overlaps as a sync conflict, without dropping data (Phase 1a)
- [x] Store each listing's iCal URL
- [x] Poll each calendar from the job tick (`POST /api/jobs/tick`, secret-authenticated, non-overlapping)
- [x] Upsert by booking code, falling back to the feed's UID; date changes
      update in place so IDs and history survive; a failed fetch changes
      nothing; a booking that vanishes from the feed is **flagged, never
      deleted**
- [x] One unnamed lead-guest row per new booking; the guest's stepper sets the
      real adult count
- [x] Surface "last synced" and manual "Sync now" — a feed that failed is named, not folded into a cheerful total

## Phase 3 — Guest upload

- [x] Generate a signed, unguessable token per booking (>=128 bits from a CSPRNG)
- [x] Guest page served from the token; scoped to one booking
- [x] **Upload, stored encrypted.** Size capped while reading; the TYPE decided
      by the bytes, never the filename or the client's content-type; JPEG
      metadata stripped server-side; AES-256-GCM with a fresh IV per file; an
      opaque storage ref. Bytes are stored BEFORE the row is written, and a
      refused row deletes its blob — a row pointing at bytes that were never
      written would read as "ID collected" when none was.
- [x] **Images resized and stripped in the browser** before sending: a
      12-megapixel photo becomes a few hundred KB, and the GPS a phone writes
      into a photo of a passport never leaves the device. The server strips it
      again, because a raw POST can bypass the browser.
- [x] **Reading a document back is admin-only.** A guest can put an ID in and
      replace it, and can never download one — not even their own.
- [x] Local disk for development, Cloudflare R2 for production via `aws4fetch`
      (65KB, against the AWS SDK's 3.3MB). Production refuses to boot on
      `STORAGE_DRIVER=local` or without `FILE_ENCRYPTION_KEY`.
- [x] Guest can set adult count, add visitor rows and name them
- [x] Token expires at checkout + 24h, enforced server-side

## Phase 4 — Email + automation

- [x] **The send path, minus the transport.** Completeness and conflict checks,
      the destination pinned on the first send, the template filled from the
      society, attachments listed, the activity row written in the same
      transaction as `sent_at`. A resend reuses the pinned address and is
      refused once the files are deleted.
- [x] **`sent_at` is written only after the transport reports success.** With no
      transport configured the send returns 503 and the booking is untouched —
      a booking that reads "Sent" with nothing delivered is the failure this
      product exists to prevent. `MAIL_TRANSPORT=recording` is fatal in
      production.

- [x] Compose the society email from its template + booking values
- [x] **Attach the adult ID files.** Decrypted into memory at send time, never
      written to disk in the clear, named `Priya_Menon_Aadhaar.jpg` so a desk can
      match an attachment to the person in front of them.
- [x] **If any single ID cannot be produced, the whole send is refused** — a
      missing file, an undecryptable one, one already deleted, or a set over the
      provider's size limit. An email with a missing ID is worse than no email:
      the desk clears the guests it has and stops the one it does not, at the
      gate. The refusal names whose file is the problem.
- [x] **Send over SMTP** from the host's own Gmail, via nodemailer (1.5MB but
      **no transitive dependencies**; MIME, STARTTLS and AUTH are not things to
      hand-roll when the payload is a passport). Tested against a real SMTP
      sink, not a mock. Production refuses to boot with `SMTP_IGNORE_TLS` set,
      or over SMTP without `MAIL_FROM`.
- [x] Scheduler for "1h before check-in" — sends with IDs missing (that is the mode's purpose), tells the desk who is still awaited, and does not send with zero IDs
- [x] Trigger for "when all IDs collected", from the same `Derive.sendDue` the UI uses; at-most-once enforced by a unique index; failures retry up to 5 times and are written to the booking's timeline
- [x] Manual send and resend
- [x] Record every send in an activity log

## Phase 5 — Retention, safety, polish

- [x] Hide bookings 24h after checkout (list rule already in UI)
- [x] **Scheduled purge at checkout + 24h** — files first, then the booking,
      its people, activity, guest link and jobs. If any file cannot be deleted
      the row is kept and retried, because an orphaned encrypted file would
      never be deleted. Runs last in every tick.
- [x] **Owner tier.** Single-use magic link to `OWNER_EMAIL` only (the request
      cannot name an address), 15-minute expiry, only a hash stored, 3 requests
      per 10 minutes. The role is inside the signed session so it cannot be
      edited client-side. Owner-only: passcode change, society edit/delete,
      listing disconnect/delete. **Opt-in** — with no `OWNER_EMAIL` every admin
      can do everything, so the host is never locked out of their own settings.
- [x] Audit log of admin actions — one table of audited routes, names captured before a delete, no secret ever in the text, lockouts recorded, shown in Settings → Admin access
- [x] SSE live updates — the stream carries only a booking id, never data; a guest hears only their own booking; verified in a real second browser tab
- [ ] Backups: Turso point-in-time restore plus a nightly SQL dump to R2, and a
      **restore rehearsal** — a backup never restored is a guess. (Replaces the
      Litestream item: the database is Turso, not a local SQLite file.)
- [x] **Load test** — `npm run loadtest`, 1x against 100x, every budget
      checked. It found three real problems, all fixed: the booking detail made
      9 database round trips (now 2, via `batch()`); the list loaded every
      booking and guest per request (now narrow-then-page — 2x faster, memory
      growth ~225MB → ~15MB); and the memory budget itself had never been
      measured (150MB, against a real baseline of ~172MB — now 256MB, half the
      host).
- [ ] Adopt Preact + htm **only** if `app.js` passes ~1,500 lines or two screens
      need the same stateful widget

## Backlog — raised by the host after first deploy (2026-09-22)

Not scheduled. Each is its own phase, agreed before building.

1. **Multi-host accounts.** Today one deployment = one host: one shared
   passcode, one `OWNER_EMAIL`, one Gmail sender. To let other hosts use the
   same site, each would sign in with their own email and see only their own
   listings; set up their own sending Gmail from the website (not Render env
   vars); and invite their own admins/co-hosts, the way Airbnb co-hosting works.
   Needs: user accounts, per-host data separation on every table, per-host
   encrypted SMTP credentials, invitations. Large — a new phase.
2. **(Done 2026-09-22)** **A URL per page.** Bookings, a booking's detail and Settings tabs all sit at
   `/`, so back/forward, refresh and bookmarks lose your place. Give each
   screen its own address (e.g. `/#bookings/<id>`, `/#settings/societies`).
3. **Telling bookings of the same flat apart.** Airbnb's calendar feed gives
   only the booking code, dates and the guest's phone last-4 — no name and no
   guest count, so every synced booking shows the flat name and 1 adult until
   someone edits it. Ideas: show the booking code more prominently and link it
   to the Airbnb reservation page; let the host add a short nickname/note per
   booking; nudge for the adult count on the list, not only in detail.

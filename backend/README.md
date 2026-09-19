# Backend

**Phase 1a is built: the calendar reader.** Everything else is still the plan.

## Try your own listing right now

```bash
cd backend
npm run probe -- "https://www.airbnb.co.in/calendar/ical/XXXXX.ics?s=YYYY"
```

Get that link from Airbnb: **your listing → Availability → Connect calendars →
Export calendar**. The probe fetches it, reads it, and tells you what it can
actually see — reservations, blocked dates, booking codes, overlaps, and
anything it could not make sense of. No server, no database, no account needed.

```bash
npm test                                          # 12 checks, no dependencies
npm run probe -- ./test/fixtures/airbnb-messy.ics  # what a bad feed looks like
npm run probe -- <url> --json                      # machine-readable
```

Source: `src/ical/parse.js` (the reader), `src/ical/fetch.js` (bounded
fetching), `src/ical/connect.js` (the one report the API will also return),
`src/ical/probe.js` (the CLI).

**What the feed gives:** dates, a stable UID, usually a booking code, sometimes
the guest's phone last 4 digits. **What it does not give:** the guest's name or
the headcount. That absence is why the guest link exists at all, and the code
never invents either.

## Run the server

```bash
npm start           # http://localhost:8080
npm run dev         # same, restarting on change
curl localhost:8080/healthz
```

Migrations run on boot, so there is no separate step. In development it uses
`file:./data/gatepass.db` and creates the folder.

**It refuses to start on an unsafe configuration.** In production that means no
`SESSION_SECRET`, no `JOBS_TICK_SECRET`, a plain-http `APP_BASE_URL` (guest
tokens travel in the URL), or an admin passcode that is not properly hashed.
Better a failed deploy than a server quietly accepting anything.

`src/http/config.js` is the only place the environment is read, and it is
validated once at boot.

## Sending mail

`src/mail/transport.js` is the boundary. Until Phase 4 configures SMTP there is
**no transport**, and `POST /api/bookings/:id/send` returns **503** rather than
marking the booking sent.

That is deliberate and worth not "fixing": `sent_at` is written only after a
transport reports success. A booking that reads "Sent" while nothing reached the
security desk would stop the host chasing it, and the guest would be held at the
gate. A refusal is visible; a false success is not.

`MAIL_TRANSPORT=recording` records messages instead of sending them, for tests
and local work. It is **fatal at boot in production**.

## Database

```bash
npm run migrate              # apply pending migrations + first-run rows
npm run migrate -- --status  # what is applied, without changing anything
```

Safe on every boot: applying twice is a no-op. With no `DATABASE_URL` it uses
`file:./data/gatepass.db` and creates the folder; in production the same code
talks to Turso by env var alone.

- `migrations/*.sql` — forward-only, numbered. **An applied file is never
  edited**; add the next number. Each runs in one transaction.
- `src/db/client.js` — the connection, the pragmas that matter (foreign keys are
  OFF in SQLite by default, which would make every `REFERENCES` decorative),
  and `transaction()`.
- `src/db/migrate.js` — the migrator and the first-run seed.

**The schema enforces the decisions rather than trusting us to remember them:**
one booking code, one lead guest per booking, one ID per adult, one live guest
link, `check_out >= check_in`, enum CHECKs, and a partial unique index that makes
a second automated send impossible. `bookings` deliberately has **no**
`status`, `adults`, `nights` or `society_id` column — all four are derived in
`shared/rules.js`, and a test asserts they are absent.

## Admin access

`src/auth/passcode.js` hashes; `src/auth/admin.js` owns the unlock flow. No
dependency — `scrypt` is in `node:crypto`.

`npm run migrate` hashes `ADMIN_FIRST_RUN_PASSCODE` (default `0000`) properly on
the first run and **exits non-zero** if it is unusable, so nothing can be
deployed sitting on a placeholder. It warns if `NODE_ENV=production` while the
passcode is still the default.

**Read the note at the top of `passcode.js` before trusting the hash.** A
4-digit code is 10,000 possibilities; the KDF protects a leaked database, but
the **attempt lockout** is what protects the passcode. Past the threshold every
wrong attempt re-locks, doubling per tier. Still owed: IP rate limiting at the
HTTP layer.

## The rest of the plan

## Stack (settled)

**Node 22 + Fastify + SQLite (WAL, via `better-sqlite3`) + Drizzle.** Jobs run
in-process against a `jobs` table rather than a queue. Files go to local disk,
then S3-compatible storage once hosted. Email via Resend. One small VPS with a
persistent volume, Litestream replicating the database file.

`../docs/TECH_STACK.md` is the authoritative version: it carries the reasoning
per layer, the alternatives that were rejected and why, the performance budgets,
and the trigger that would make each choice worth revisiting. Do not re-argue
the stack here — change that document.

The two things to keep in mind while building against it:

- **SQLite is in-process.** Queries are function calls, so the instinct to
  batch or cache to avoid round trips does not apply. Write the obvious query.
- **There is one writer.** Jobs and requests share a connection in WAL mode. A
  write transaction is short by construction; keep it that way.

## Data model

Tables (fields are the essentials, not exhaustive):

- **societies** — id, name, desk_email_to, desk_email_cc, template
- **listings** — id, name, ical_url, society_id, last_synced_at
- **bookings** — id, airbnb_code, listing_id, check_in, check_out,
  adults, children, status, automation ("before" | "allids"),
  sent_at, conflict (bool)
- **people** — id, booking_id, name, is_lead (bool)
- **documents** — id, person_id, doc_type, file_ref (encrypted), uploaded_at,
  uploaded_by ("admin" | "guest")
- **guest_links** — token, booking_id, expires_at (checkout + 24h)
- **admin_auth** — passcode_hash, updated_at, failed_attempts, locked_until
- **activity** — id, booking_id, at, text (for the booking timeline + audit)

Status is derived, not stored: `conflict → sent → ready → awaiting`. The
frontend already implements this once in `Derive.status`
(`frontend/js/data.js`); the server must share that file rather than carry a
second copy. The same applies to the adult count and the night count, which are
derived from `people` and from the dates.

Indexes are listed in `../docs/TECH_STACK.md` §5. The list query must not join
`documents`.

## API surface

Matches what the frontend already does.

Auth (admin)
- `POST /auth/unlock`            body: { passcode } → session
- `POST /auth/passcode`          change passcode (admin only)

Settings
- `GET/POST/PATCH /societies`
- `GET/POST/PATCH /listings`     connect listing = create with ical_url + society

Bookings (admin)
- `GET  /bookings`               keyset-paginated (`?cursor=&limit=`), filtered,
                                 attention first then chronological, hides past
                                 24h+, responds with an `ETag`
- `GET  /bookings/:id`
- `POST /bookings/:id/people`    add/adjust adults
- `POST /bookings/:id/send`      send or resend to society
- `PATCH /bookings/:id/automation`
- `POST /sync`                   force a calendar check

Documents
- `POST /bookings/:id/people/:pid/document`   upload one ID
- `GET  /documents/:docId`                    admin view/download

Guest (no auth, token in path)
- `GET  /u/:token`               booking + people, scoped to that booking
- `POST /u/:token/people`        set adult count / add visitor
- `POST /u/:token/people/:pid/document`  guest upload

Config
- `GET /config`                  the values the server enforces (retention
                                 windows, upload limits, passcode length), so
                                 the frontend stops holding its own copy

Jobs (internal, a `jobs` table claimed in a transaction)
- calendar poll per listing
- "1h before check-in" send
- "all IDs collected" send
- retention: hide, then delete ID files on schedule

A send writes `bookings.sent_at` and completes its job in **one transaction**,
with a unique constraint on (booking, kind). A double-send means a security desk
receives someone's passport twice; at-most-once matters more here than
throughput.

## Security notes

- Store the passcode as a hash, not plain text. Lock out after a few failed
  attempts.
- Guest tokens: long, random, signed; look up by token; expire at checkout+24h.
- ID files hold personal data. Encrypt at rest. Serve to admins only, never list
  them publicly. Delete on the retention schedule.
- Log admin actions (who sent what, when) for accountability.

## Env

See `.env.example`.

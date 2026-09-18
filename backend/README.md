# Backend (not built yet)

This is the plan. No server code exists yet. The point of this file is that we
can start building without re-deciding the shape.

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

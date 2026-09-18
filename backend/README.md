# Backend (not built yet)

This is the plan. No server code exists yet. The point of this file is that we
can start building without re-deciding the shape.

## Suggested stack

Pick one; both pair fine with the current vanilla frontend. The proposal:

- **Node + Express + SQLite (via Prisma)** to start. Small, one file to run,
  easy to move to Postgres later. File uploads to local disk first, then to an
  object store (S3-compatible) when hosted.
- Alternative: **Python + FastAPI + SQLite**. Equally fine if you prefer Python.

Email: any transactional provider (Resend, Postmark, Amazon SES, or SMTP).
Scheduler: a simple cron/worker process for the "1h before check-in" job and
the calendar poll.

Nothing here is locked. Decide in Phase 1.

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

Status is derived, not stored raw: conflict → sent → all-IDs-in (ready) →
awaiting.

## API surface

Matches what the frontend already does.

Auth (admin)
- `POST /auth/unlock`            body: { passcode } → session
- `POST /auth/passcode`          change passcode (admin only)

Settings
- `GET/POST/PATCH /societies`
- `GET/POST/PATCH /listings`     connect listing = create with ical_url + society

Bookings (admin)
- `GET  /bookings`               list, filtered, chronological, hides past 24h+
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

Jobs (internal)
- calendar poll per listing
- "1h before check-in" send
- retention: hide, then delete ID files on schedule

## Security notes

- Store the passcode as a hash, not plain text. Lock out after a few failed
  attempts.
- Guest tokens: long, random, signed; look up by token; expire at checkout+24h.
- ID files hold personal data. Encrypt at rest. Serve to admins only, never list
  them publicly. Delete on the retention schedule.
- Log admin actions (who sent what, when) for accountability.

## Env

See `.env.example`.

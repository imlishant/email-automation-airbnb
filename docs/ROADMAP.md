# Roadmap

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

Stack is settled — see `TECH_STACK.md`. Nothing here re-opens it.

- [x] Choose stack: Node 22 + Fastify + SQLite (WAL) + Drizzle
- [ ] Fastify skeleton with JSON Schema on every route, security headers, health check
- [ ] Schema + forward-only numbered `.sql` migrations, with the indexes listed
      in `TECH_STACK.md` §5
- [ ] Port `Derive` (status, adults, nights, retention) to the server as the
      single implementation, and share the file with the frontend
- [ ] Admin passcode auth: slow hash, constant-time compare, attempt lockout,
      HTTP-only `SameSite=Lax` session cookie
- [ ] CRUD: societies (desk email + template), listings (with society + iCal URL)
- [ ] `GET /bookings` with keyset pagination and an `ETag`
- [ ] Wire the frontend Settings screens to real endpoints — replace the bodies
      in `data.js` with `fetch`, delete `SEED`, change no screen
- [ ] CI: migrate, run `node:test` + the browser checks, enforce the JS/CSS budgets

## Phase 2 — Airbnb calendar sync

- [ ] Store each listing's iCal URL
- [ ] Background worker polls each calendar on a schedule
- [ ] Parse events into bookings; match on booking code; update on change
- [ ] Handle overlaps as a sync conflict, without dropping data
- [ ] Surface "last synced" and manual "Sync now"

## Phase 3 — Guest upload

- [ ] Generate a signed, unguessable token per booking (>=128 bits from a CSPRNG)
- [ ] Guest page served from the token; scoped to one booking
- [ ] Streamed upload with magic-byte type checks and a size cap; encrypted at
      rest; EXIF stripped; images resized before storage
- [ ] Guest can set adult count and add visitor rows
- [ ] Token expires at checkout + 24h

## Phase 4 — Email + automation

- [ ] Compose the society email from its template + booking values
- [ ] Attach the adult ID files
- [ ] Send via the chosen mail provider
- [ ] Scheduler for "1h before check-in"
- [ ] Trigger for "when all IDs collected"
- [ ] Manual send and resend
- [ ] Record every send in an activity log

## Phase 5 — Retention, safety, polish

- [ ] Hide bookings 24h after checkout (list rule already in UI)
- [ ] Retention window for records; scheduled delete of ID files
- [ ] Audit log of admin actions
- [ ] SSE live updates, replacing any polling
- [ ] Litestream replication of the SQLite file to object storage, and a
      restore rehearsal — a backup that has never been restored is a guess
- [ ] Load test at 100x current data to check the budgets in `TECH_STACK.md` §4
- [ ] Adopt Preact + htm **only** if `app.js` passes ~1,500 lines or two screens
      need the same stateful widget

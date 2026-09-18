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

## Phase 1 — Backend foundations

- [ ] Choose stack (see backend/README.md)
- [ ] Data store and schema for societies, listings, bookings, people, documents
- [ ] Admin passcode auth (verify, change, attempt lockout)
- [ ] CRUD: societies (desk email + template), listings (with society)
- [ ] Wire the frontend Settings screens to real endpoints

## Phase 2 — Airbnb calendar sync

- [ ] Store each listing's iCal URL
- [ ] Background worker polls each calendar on a schedule
- [ ] Parse events into bookings; match on booking code; update on change
- [ ] Handle overlaps as a sync conflict, without dropping data
- [ ] Surface "last synced" and manual "Sync now"

## Phase 3 — Guest upload

- [ ] Generate a signed, unguessable token per booking
- [ ] Guest page served from the token; scoped to one booking
- [ ] File upload with type/size checks; store encrypted at rest
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
- [ ] Passcode brute-force lockout
- [ ] Audit log of admin actions
- [ ] Split the single-page frontend into a framework if it grows

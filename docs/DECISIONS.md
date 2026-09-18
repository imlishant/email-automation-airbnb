# Decisions

Everything agreed so far. This is the source of truth for the product. If a
decision changes, change it here first.

## Purpose

Collect ID proofs for adult guests of an Airbnb booking and email them to the
correct society's security helpdesk, before arrival or as soon as all IDs are
in. One host, one or more listings.

## Core entities

- **Admin** — the host and anyone they trust. Sees everything. Enters a shared
  4-digit passcode to get in.
- **Society** — a residential society. Holds its own security-desk email
  (To + Cc) and its own email template. Two listings in the same society share
  one template; different societies each keep their own.
- **Listing** — one Airbnb property. Connected once with its Airbnb calendar
  link. Belongs to exactly one society.
- **Booking** — one reservation on one listing. Carries dates, a booking code,
  and the people on it. Inherits its society (and therefore desk + template)
  from its listing.
- **Person / adult guest** — one adult on a booking. Each needs one ID proof.
  Children are not counted and need no ID.
- **ID document** — an uploaded proof (Aadhaar, passport, driving licence, any
  government ID). One per adult.
- **Security email** — the message sent to the society desk, using the society
  template, with the adult IDs attached.

## The flow

1. A booking syncs in from the listing's Airbnb calendar.
2. The booking needs one ID per adult. IDs come in two ways:
   - the admin uploads them, or
   - the admin shares the booking's guest link and the guest uploads them.
3. When all adult IDs are in, the booking is ready. The email is sent to the
   society desk either on a schedule or on completion (see Automation).
4. After checkout + 24 hours the booking drops off the admin list.

## Access model

### Admin
- One shared **4-digit passcode** unlocks the whole admin side.
- Default passcode is **0000** on a fresh system, so no one is ever locked out
  on first use.
- Any admin can view and change the passcode in Settings → Admin access. A new
  code takes effect immediately.
- No email, no accounts, no long login.
- **To add later:** lock out briefly after a handful of wrong attempts, so the
  code cannot be brute-forced.

### Guest
- No account and no passcode. Access is the link itself.
- Each booking has one **unguessable link** (a long random token). Whoever opens
  it sees only that one booking — nothing else in the system.
- The guest page shows only the ID upload. No email, no send, no automation, no
  other bookings. Sending stays with the admin or the automation.
- The guest page is **mobile-first**, since guests are almost always on a phone.
- The link stays active until **checkout + 24 hours**. This lets guests add
  friends or visitors mid-stay and upload a separate ID for each new adult. After
  that window the link shows "link not active".

## Airbnb calendar sync

- Bookings sync automatically from each listing's Airbnb calendar (iCal link).
  No manual syncing needed day to day; a "Sync now" button exists for forcing a
  check.
- Uploaded IDs appear live, because uploads happen inside this tool, not on
  Airbnb.
- **Known limit:** the Airbnb iCal link reliably gives dates and a booking code,
  but usually **not** the guest's name or headcount. So the adult count is best
  confirmed by the guest through their link (the guest page has an adults
  stepper). The alternative is the official Airbnb API, which needs approval.
- The society is **never** guessed from the calendar. The admin assigns each
  listing's society by hand when connecting it, so there is no ambiguous
  extraction to resolve. The listing name is pre-filled from the calendar where
  available and stays editable.

## Automation (when the email is sent)

Per booking, one of:
- **1 hour before check-in** — sends on schedule even if some IDs are missing.
- **When all IDs are collected** — fires the moment the last adult ID is
  uploaded. Good for guests uploading at the gate.

The admin can also send manually. Send is locked until all adult IDs are in;
automation handles the timing otherwise.

## Retention

- A booking is **hidden** from the admin list 24 hours after checkout.
- Hiding and deleting are different. Proposed (decide before building):
  - keep the booking record and the sent-email log for a retention window
    (30–90 days) as proof the IDs were sent to security;
  - delete the ID document files themselves on a defined schedule for privacy.
- **Open:** exact retention window for records, and exact delete schedule for ID
  files.

## Sorting (settled — no special logic)

- Bookings needing attention (awaiting IDs, or a sync conflict) on top, in
  chronological order by check-in (nearest first).
- Ready and already-sent bookings below.

## Open decisions

- Retention window for booking records after checkout.
- Delete schedule for ID document files.
- Whether the guest link should also carry a light second check (for example
  last 4 digits of the guest's phone). Currently: link only.
- Whether there is one un-lockable owner, separate from other admins.
- Backend stack (see backend/README.md for the proposal).

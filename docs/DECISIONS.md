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
- **No second check. The link is the access, and nothing else is asked.**
  Considered and rejected: gating on the guest's phone last 4 digits, which the
  feed does provide. It would protect a forwarded link, but it costs the guest a
  step on the one page whose entire job is to cost them nothing
  (`PRODUCT_PRINCIPLES.md`, 2), and it fails outright for a guest whose Airbnb
  number is not the phone in their hand. The token is 128 random bits; that is
  the control.
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

## Appearance

- The admin and guest UIs follow the device's light/dark setting by default, and
  either can be overridden with a three-state control: **Light / Match system /
  Dark**. "Match system" is the default and stores nothing.
- The choice is remembered per device, not per account — there are no accounts,
  and the right theme is a property of the screen you are holding, not of the
  host.
- The guest page carries the control too. It is not a step in the flow and costs
  no taps, and a guest reading a dark page in sunlight at a gate has a real
  problem.

## Reaching the guest page

- There is exactly **one** way to open the guest page: the booking's own guest
  link. The admin can copy it or open it.
- An earlier "Preview guest page" button was removed. A second route to the same
  screen only invites the two to drift, and previewing a link is the same act as
  opening it.

## Check-in and check-out times (settled)

The Airbnb iCal feed gives **dates with no clock time**, but the automation
needs one: "1 hour before check-in" and every retention window are measured from
a moment, not a day.

- **One global check-in time and one global check-out time**, set in Settings and
  applying to every listing. Defaults 14:00 and 11:00.
- They are **data, not config** — the host owns them, so they live in the
  settings store and not in `config.js`.
- **Known limit, accepted:** the day a listing has different times from the
  others, this becomes wrong for that listing and the field has to move onto
  `listings`. The schema keeps the values in one row so that move is a migration,
  not a redesign.

## What a booking is called (settled)

The feed carries **no guest name and no headcount**. So a booking identifies
itself by what is actually known:

- **Title: the listing name.** Plus the arrival date, which the card already
  shows on its calendar tile and repeats in the meta line.
- The **booking code** sits beside it in muted text, so a booking can be matched
  against Airbnb at a glance.
- The **lead guest's name is shown only once it is known** — from an uploaded ID,
  or typed in by the host. It is never invented, never guessed from the feed, and
  the card never has a blank where a name should be.
- The feed's **phone last 4 digits** are stored and shown as a hint, because they
  are the only other thing that distinguishes two bookings on one day. They are
  **not** used as an access check — see the guest access decision below.

## Editing and removing a listing (settled)

- A listing can be **edited** in place: name, calendar link, and society.
  Changing the calendar link re-syncs from scratch.
- **Changing the society is logged against every booking on that listing,
  including ones already sent.** The society is resolved live through the
  listing, so a *resend* of an already-sent booking would go to the new desk.
  That is the worst plausible bug in this system, so it is written into the
  timeline rather than happening quietly.
- **Disconnect** clears the calendar link: no new bookings arrive, and every
  booking already synced — plus the record of what was sent to security —
  survives. This is the answer for "I do not rent this place any more".
- **Delete is refused while the listing has any bookings.** Deleting would
  cascade to its bookings, people, documents and send log, destroying the proof
  that IDs reached security. The UI says so and points at Disconnect. A listing
  with no bookings (a mistyped one, say) deletes freely.

## Changing an ID after it is uploaded (settled)

- **Either side can replace an ID**, for as long as the guest link lives
  (checkout + 24h). Past that the files are deleted, so there is nothing left to
  replace.
- The admin is **not** more restricted than the guest: the same window, the same
  action. A blurry photo is the common case and either party may notice it.
- A replacement is an update, not a second document — the schema allows one ID
  per adult.
- **A replacement never triggers an automatic re-send.** Emailing someone's
  passport twice unasked is worse than a stale attachment the host can see. So
  instead the booking shows **"Resend needed"** with the reason, and the host
  decides. `Derive.needsResend` is the single test for this.

## Who the email comes from (settled)

**The host's own Gmail, over SMTP, using an app password.**

The host already corresponds with each society's desk from that address. Mail
from anywhere else would arrive as a stranger to a desk that has a thread going
with them already — worse for both deliverability and for the human reading it.
So the tool sends *as* the host rather than on their behalf.

- **SMTP, not a transactional provider.** Resend and the like cannot send as an
  arbitrary `@gmail.com`; they require a verified domain. That rules them out
  for this requirement, so they become the fallback rather than the default.
- **An app password, not the account password.** It needs 2-Step Verification
  enabled on the Google account, and it is scoped to mail only and revocable
  without changing the account password.
- **This is a stored credential**, which the rest of the system deliberately
  avoids having. It is env-only, never in the database, never logged, and
  rotating it is one env change. See `SECURITY.md`.
- **Limits are not a concern at this scale:** a free Gmail allows on the order
  of 500 recipients a day and 25MB of attachments. A host sends a handful of
  emails a day with a few ID photos.
- **Scope, stated because it constrains the design:** this account is used for
  real conversations with the societies. The tool may only send the security
  email for a booking. It must never read the mailbox, never send anything else,
  and never mail a guest.

## Admin tiers (settled in principle, not built)

Two levels, because they answer different needs:

- **Owner.** One person, identified by email — the same address the tool sends
  from. Signs in with a **magic link** to that inbox rather than a password:
  the system already sends email, so this costs no new dependency and no
  OAuth app to register. This is the "un-lockable owner" that was open from the
  start: the owner cannot be locked out by another admin changing the passcode.
- **Admins.** Everyone else, on the shared 4-digit passcode, exactly as today.
  Day-to-day work: see bookings, upload IDs, send, share guest links.

**Owner-only, provisionally:** changing the passcode, deleting or disconnecting
a listing, editing a society's desk email or template, and seeing the mail
configuration. The reasoning is that each of those either changes where personal
data goes or destroys records — the two things worth putting behind the
stronger door.

**Rejected: Google OAuth sign-in.** It looks natural given the host signs in to
Airbnb with Google, but it needs an OAuth app, a consent screen and a
dependency, to identify one person we already know the email address of. A
magic link to a known address is the same guarantee with none of that.

**Built, and opt-in.** Set `OWNER_EMAIL` to turn it on; unset, every admin can
do everything — otherwise the host would be locked out of their own settings
until email was configured. In development the link is printed to the server
log (the recording transport sends nothing); in production it never is, because
a link is a credential.

## Airbnb access (settled — there is no API)

Worth writing down because it looks like there should be a better way:

- **There is no public Airbnb API for hosts.** Signing in to Airbnb with a
  Google account gives this tool nothing — no session, no listings, no
  reservations. The partner API requires an approved commercial relationship.
- **So listings are added by hand**, once, with their iCal export link. That is
  not a workaround pending something better; it is the only supported route.
- **Scraping an Airbnb session is rejected**: against their terms, breaks on any
  markup change, and would mean holding the host's Airbnb credentials.
- What this costs is the guest's name and the headcount, which the iCal feed
  omits. That absence is the entire reason the guest link exists.

## Sharing the guest link (settled)

The admin **copies the link and sends it however the guest is already talking to
them** — Airbnb messages, WhatsApp, SMS. The tool does not message guests.

- The iCal feed carries no guest contact details, so the tool has nothing to
  send to even if it wanted to.
- It also keeps the tool out of the conversation, which is the host's to manage.
- Automating this would need a PMS or the Airbnb messaging API. Out of scope.

## Party size (settled — no cap)

The guest's adults stepper is **not capped** by the tool. Each listing already
has its own occupancy limit on Airbnb, and that is where the real constraint
lives. A tool-side cap would either duplicate that number (and drift from it) or
block a legitimate visitor.

If a per-listing cap is ever wanted, the home for it is a `max_guests` column on
`listings`, not a global constant.

## Where guest names come from (settled)

**There are exactly two sources, and both are a human typing.** The Airbnb iCal
feed carries no names, and nothing is extracted from an ID document — there is no
OCR and none is planned, because reading a passport photo to auto-fill a field
would mean processing the document for a second purpose.

So:

- **The host types a name**, on the booking, at any point in the window.
- **Or the guest types it**, from their own link — including the names of friends
  and visitors they add, which the host has no way of knowing.

Either side may name **any** person on the booking. The guest knows their party;
the host may have learned a name from the Airbnb thread. Neither is privileged.

Until a name is typed, a person carries a **placeholder** — "Lead guest",
"Adult 3". These are recognised as placeholders
(`Derive.isPlaceholderName`) and are styled as unfinished, because **the
security desk sees these names** and a desk receiving "Adult_3_Aadhaar.pdf"
cannot match it to the person at the gate. The booking detail nudges about any
that remain.

Naming the **lead guest** also sets the booking's identifying name, which is why
a card can read "Lead guest Priya Menon" once it is known — and reverts to
"Guest not yet identified" if the name is put back to a placeholder.

## Who sets the adult count (settled)

**Both sides, on the same booking, with the same guard.** The feed carries no
headcount, so this is the only source of truth for it.

- It is on the **booking detail** for the host and on the **guest page** for the
  guest. Neither has to go through the other's screen to change it.
- Guards, enforced in the data layer rather than the UI: at least 1, at most 30,
  and **an adult whose ID is already uploaded cannot be removed** — nor can the
  lead guest. The UI says which, instead of silently doing nothing.
- Every change is logged to the booking's activity, with who did it.

**Known limitation, honestly:** with the admin page open in one tab and the guest
link in another, each holds whatever it last rendered, so the two can disagree
until one is refreshed. Returning to a tab now re-reads everything
(`visibilitychange`), which covers the common case. Genuine live updates need
server push and are Phase 5 — until then, two people editing the same booking in
the same minute can still see stale numbers.

## A booking never reads "Sent" unless mail left (settled)

`sent_at` is written **only after the mail transport reports success**, in the
same transaction as the activity row. Until a transport is configured, sending
is **refused with a 503**, not faked.

This is worth stating as a decision because the convenient alternative — mark it
sent now, wire the email later — would produce exactly the failure the product
exists to prevent: the host stops chasing, and the guest is held at the gate.
A refusal is visible; a false "Sent" is not.

It follows that:

- A transport failure leaves the booking **exactly** as it was. No partial state,
  no "sending…" limbo.
- `MAIL_TRANSPORT=recording`, which records instead of sending, is **fatal at
  boot in production**.
- The send path is complete and tested end to end today. Phase 4 adds the SMTP
  transport and nothing else changes.

## Retention

Hiding and deleting are different, and both are now settled.

**One retention moment: checkout + 24 hours.** Because the checkout time is a
real time of day (above), "the day after checkout" and "checkout + 24h" are the
same instant, and three separate rules collapse into one:

| At checkout + 24h | |
| --- | --- |
| The booking | leaves the admin list |
| The guest link | stops working |
| The ID document files | are **deleted** |
| The booking record, its people and its activity log | are **deleted** |

**Nothing is kept.** The record was originally going to survive 90 days as proof
the IDs reached security; that was dropped deliberately — there is no obligation
to hold it, and the safest thing to hold is nothing.

**The consequence, accepted knowingly:** after that moment there is no record
that the booking existed or that its IDs were sent. If a society ever disputes
it, there is nothing to show them. The cheap fix, if that day comes, is an
**anonymised receipt** — booking code, listing, sent_at, recipient, adult count,
with no names, no phone and no files — kept indefinitely because it holds
nothing personal. That is a better answer than a longer window on the real
data, and it is not built.

**The consequence, accepted deliberately:** once the files are gone, a booking
**cannot be resent**. If a society mislays the email two days after checkout,
the host has to ask the guest again — and the guest link is closed too, so that
means a new link. This is the privacy-maximal choice and it was made knowingly.
If it bites in practice, the fix is a grace window on the file delete only
(say checkout + 72h), which is one config value and changes nothing else.

**Still open:** whether 90 days is right for the record, or whether a society
ever requires longer.

## Sorting (settled — no special logic)

- Bookings needing attention (awaiting IDs, or a sync conflict) on top, in
  chronological order by check-in (nearest first).
- Ready and already-sent bookings below.

## Data, not code

- The frontend holds **no hardcoded values**. Anything the host owns is data and
  comes from the data layer (`frontend/js/data.js`); anything the product owns is
  a knob in `frontend/js/config.js`. No screen carries its own copy of a
  retention window, a document type, a placeholder name or a date format.
- Derived values are never stored: a booking's status, its adult count and its
  night count are all computed from the facts, in one place.
- The data layer is **async today**, before there is a server to be async
  about, so that connecting the real API changes one file and no screen.

## Hosting (settled, after reconsidering)

**Render's free tier**, reaffirmed on 2026-09-19 after weighing the
alternatives. It is the only one of the three where the platform works against
this particular app, so the reasons for staying are worth recording rather than
re-arguing later.

| Considered | Why not |
| --- | --- |
| **Cloudflare Workers + D1 + R2** | Genuinely the better technical fit: never sleeps, free Cron Triggers built in, D1 is SQLite so the schema is unchanged. Rejected on cost of change — Fastify would become Hono, and the free tier's 10ms-CPU-per-request limit pushes image resizing into the browser and puts app-level file encryption in doubt. |
| **Oracle Cloud Always Free VM** | The original plan would work untouched — local SQLite, local files, real cron. Rejected because it makes the maintainer a sysadmin: OS updates, TLS, deploy scripts, and an account that can be reclaimed. |
| **Fly.io** | Was the ideal fit (persistent volumes, always-on). No longer offers a free allowance to new accounts. |

The accepted consequences are in `TECH_STACK.md` §2a: Turso instead of a local
SQLite file, R2 from day one, an external cron ping standing in for both the
scheduler and a keep-warm, and the residual risk that a deploy or a missed ping
leaves one guest waiting ~50s at a gate.

**Why this is cheap to revisit:** nothing built is host-specific. The calendar
reader has zero `node:` imports and uses only web-platform APIs, so it already
runs unchanged on Workers, Deno or Bun. A host change costs a driver and a
router, not a rewrite — which is the whole reason the data layer was written
against an interface.

**The first thing worth paying for** is Render's paid instance tier, which
removes spin-down. Not a re-architecture; one line item.

## Backend stack (settled)

Node + Fastify + Turso (libSQL), with **no ORM** — parameterised SQL in
`backend/src/db/` — an in-process job table instead of a queue, files in
S3-compatible storage, and Render as the host. The reasoning, the rejected
alternatives and the triggers to revisit each choice are in `TECH_STACK.md`.

Drizzle was in the original plan and was **reversed** during Phase 1b: its main
benefit is types, and this is plain JavaScript. One dependency
(`@libsql/client`) now covers the whole data layer. Revisit if the project ever
moves to TypeScript.

The short version: there is **one writer**, the whole database will be
megabytes, and the retention rule already bounds the working set — so the
scarce resource is operational surface, not throughput.

## Open decisions

- Whether a second sender option is worth adding later (a verified domain via a
  transactional provider), for a host with no Gmail they already correspond
  from.
- Whether a repeat guest should be recognised across bookings. Explicitly out of
  scope for now: it would require keeping data past the retention moment, which
  is the opposite of the current direction.

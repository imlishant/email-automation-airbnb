# Architecture

How GatePass is put together. Two halves: **what exists today** (a prototype),
and **what is planned** (everything server-side). The planned half is clearly
marked; do not read it as describing running code.

## System view (target)

```
        Airbnb iCal feed (per listing)
                    │  poll
                    ▼
   ┌───────────────────────────────────┐        ┌──────────────────────┐
   │            GatePass server        │  SMTP  │  Society security    │
   │  api · sync worker · scheduler    ├───────►│  helpdesk (email)    │
   └──────┬─────────────────┬──────────┘        └──────────────────────┘
          │                 │
   admin  │                 │  token link
   (passcode)               │
          ▼                 ▼
   ┌─────────────┐    ┌─────────────┐      ┌────────────────────────┐
   │ Admin UI    │    │ Guest UI    │      │ Encrypted file store   │
   │ (desktop-   │    │ (mobile-    │      │ ID documents, deleted  │
   │  first)     │    │  first)     │      │ on a schedule          │
   └─────────────┘    └─────────────┘      └────────────────────────┘
```

Three actors, two of them human: the host with a passcode, the guest with a
link, and the scheduler with nobody watching. The security desk is downstream of
an email and never touches the system.

## What exists today

**A single-page vanilla web app. No build step, no framework, no dependencies**
beyond two Google Fonts. Three files:

| File | Role |
| --- | --- |
| [frontend/index.html](../frontend/index.html) | Shell only: sidebar nav, `#main` mount point, toast node, modal backdrop, and the pre-paint theme script. |
| [frontend/css/styles.css](../frontend/css/styles.css) | All styles. Tokens on `:root`, redefined for dark mode. |
| [frontend/js/config.js](../frontend/js/config.js) | Every tunable the *product* owns: retention windows, document types, template placeholders, timings, page size. |
| [frontend/js/data.js](../frontend/js/data.js) | The only place that knows where data comes from. `Derive` (the rules), `fillTemplate`, the async `Data` API, and `SEED` — the only mock values in the app. |
| [frontend/js/app.js](../frontend/js/app.js) | Rendering and behaviour. No data, no tunables, no literals. |
| [frontend/test.html](../frontend/test.html) | Runnable checks for the rules. Open it in a browser. |

**The boundary is the point.** `app.js` never touches `SEED` and never holds a
number of its own, so pointing the app at the real server means replacing the
function bodies in `data.js` with `fetch` calls and deleting `SEED`. No screen
changes. Every `Data` function is already `async` for exactly that reason —
the awkward part of the migration was paid up front, while it cost nothing.

### How the prototype is organised

`app.js` is one module in banner-commented sections, in this order: data model,
helpers, theme, state, list, detail, actions, guest page helpers, settings,
toast, admin lock, guest page, boot.

**Rendering is full re-render.** There is one mutable `view` object
(`{screen, bookingId, filter, tab, openSoc}`) and one `render()` that dispatches
to `renderList()`, `renderDetail()`, or `renderSettings()`. A screen function
builds an HTML string, assigns it to `main.innerHTML`, then attaches handlers to
the fresh nodes. Actions mutate module-level state and call `render()` again.
There is no diffing, no component model, and no framework — deliberately, at
this size.

**State is derived, not stored.** The important example is status:

```js
function statusOf(b){
  if(b.conflict) return "conflict";
  if(b.sent)     return "sent";
  if(uploaded(b)===total(b)) return "ready";
  return "awaiting";
}
```

Nothing writes a status field. The same rule is meant to hold server-side: the
API returns the inputs, and status is computed from them in one place.

**Relationships are resolved, not duplicated.** A booking holds a `listing` key;
the listing holds a `society` key; `soc(b)` walks the chain. A booking never
stores its society, its desk email, or its template — so changing a society's
desk email immediately and correctly affects every future send for every listing
in it.

**Two overlay surfaces sit outside the app shell.** The admin lock screen and
the guest page are appended to `document.body` and removed by `clearOverlays()`.
They are not screens inside `render()`, because neither is part of the admin
shell: the lock screen precedes it, and the guest page replaces it entirely.

**Routing is the hash, for one route only.** `#u/<id>` opens the guest page, at
boot and on `hashchange`. Everything else is in-memory `view` state and leaves no
URL. That is fine for a prototype and is the first thing to revisit when the
guest link becomes a real signed token (Phase 3) — the token, not a booking id,
belongs in the URL. There is deliberately no second route to the guest page:
`guestLink()` builds the one link, and copying it or following it are the only
ways in.

**Theme is document state, not view state.** `data-theme` on `<html>` plus
`localStorage["gatepass.theme"]`, with the attribute absent meaning "follow the
OS". It sits outside `view` because it survives reloads and applies to the lock
screen and guest page as much as to the admin shell, and because a four-line
script in `<head>` has to apply it before any of this code runs.

### Known prototype limits

These are properties of the prototype, not bugs to fix in place. Each resolves
when its phase lands.

- `bookings`, `listings`, and `societies` are module-level literals. All mutation
  is in-memory and lost on reload.
- "Sending" sets `b.sent = true` and shows a toast. No mail leaves the machine.
- "Uploading" sets `p.up = true`. No file is read, transferred, or stored.
- The passcode is compared in plain text in the client (`adminPasscode`), so it
  is decoration, not access control. Real enforcement is server-side (Phase 1).
- The guest link is `#u/<booking-id>` — guessable by construction. Real tokens
  are Phase 3.
- The automation timings are simulated: `allids` fires inline on the last
  upload, and `before` never fires because there is no scheduler.

## Planned backend

Status: **proposed, not built.** The current proposal is in
[backend/README.md](../backend/README.md); the stack choice is an open decision
recorded in `DECISIONS.md`.

The stack is settled — Node 22 + Fastify + SQLite (WAL) + Drizzle, with
in-process jobs. [TECH_STACK.md](TECH_STACK.md) carries the reasoning, the
rejected alternatives, the performance budgets and the triggers to revisit.

### Components

- **API** — serves the admin UI and the token-scoped guest UI. Thin: reads and
  writes the tables below and never contains a second copy of the status rule —
  it shares `Derive` with the frontend rather than reimplementing it.
- **Sync worker** — polls each listing's iCal URL on a schedule, upserts bookings
  by booking code, and marks overlaps as a conflict rather than dropping data.
- **Scheduler** — two jobs: "1h before check-in" sends, and retention (hide the
  booking, then delete ID files).
- **Mail sender** — renders the society template with booking values, attaches
  the adult IDs, sends via a transactional provider, and writes an activity row.
- **File store** — local disk first, an S3-compatible object store when hosted.
  Encrypted at rest either way.

### Data model

`societies` · `listings` · `bookings` · `people` · `documents` · `guest_links` ·
`admin_auth` · `activity` · `jobs`. Fields are listed in
[backend/README.md](../backend/README.md), which stays the authoritative version
so the shape lives in one place. Indexes and the list query are in
[TECH_STACK.md](TECH_STACK.md) §5.

The shape to preserve: a booking points at a listing, a listing points at a
society, and the desk email and template hang off the society. Documents hang
off people, people hang off bookings. `activity` is append-only and is both the
booking timeline in the UI and the audit log.

### API surface

Enumerated in [backend/README.md](../backend/README.md). It was written to match
what the prototype already does, so wiring Phase 1 should be substitution rather
than redesign.

### Trust boundaries

| Boundary | Carries | Enforced by |
| --- | --- | --- |
| Admin browser → API | Everything | Session from a passcode unlock; attempt lockout |
| Guest browser → API | One booking | A signed, long, random token; expires at checkout + 24h |
| API → mail provider | ID files as attachments | Provider credentials from env |
| API → iCal feed | Nothing outbound | Outbound only; treat the response as untrusted input |

The guest boundary is the sharp one: a token grants read and write on exactly one
booking's people and documents, and nothing else. Every guest endpoint must scope
by the token's booking, never by an id in the request body.

## Decisions worth knowing

- **No framework, for now.** At three files and one flow, a framework would add
  a build step and a dependency tree to buy structure we do not yet need. The
  trigger to revisit is `app.js` becoming unmanageable — a Phase 5 item.
- **Society assigned by hand.** Because the iCal feed cannot be trusted to
  identify a property's location, there is no inference to be wrong about.
- **SQLite first.** One file, no service to run; Postgres when it is hosted.
  Written down so the eventual move is a migration and not a surprise.
- **Status derived, never stored.** A stored status is a field that can disagree
  with reality. See `PRODUCT_PRINCIPLES.md`.

## Related documents

- `CONTEXT.md` — why any of this exists.
- `DECISIONS.md` — the product decisions these structures serve.
- `SECURITY.md` — the rules on tokens, files, and retention.
- `ROADMAP.md` — the order in which the planned half gets built.

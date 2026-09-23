# CLAUDE.md

Guidance for Claude Code (and any other agent or new contributor) working in this
repository. Read this first, then `docs/DECISIONS.md`.

## What this project is

GatePass collects government ID proofs for the adult guests of an Airbnb booking
and emails them to the correct residential society's security helpdesk — before
arrival, or the moment the last ID lands. A host has one or more listings, each
listing sits in exactly one society, and one deployment serves many hosts.

It is a small, single-purpose tool. It is not a PMS, not a channel manager, and
not a general document vault. See `docs/PRODUCT_PRINCIPLES.md` before adding
anything that looks like a new surface.

## Repository layout

```
gatepass/
├── CLAUDE.md             This file — orientation for agents and contributors.
├── README.md             Project overview and how to run.
├── CHANGELOG.md          What changed. Updated in the same commit as the change.
├── docs/                 The written record. See docs/CONTEXT.md for the map.
├── shared/rules.js       THE rules, imported by both the browser and the server:
│                         derived status, adult count, every window, the email
│                         template filler. One definition, never two.
├── frontend/             Vanilla ES modules, no build step, served by the server.
│   ├── index.html        Shell markup, fonts, pre-paint theme script.
│   ├── css/styles.css    All styles, CSS-variable themed, light/dark aware.
│   ├── js/config.js      Every tunable the product owns. No data.
│   ├── js/data.js        The data boundary: the async `Data` API over fetch.
│   ├── js/app.js         Rendering and behaviour. No data, no literals.
│   ├── js/upload.js      Client-side resize and EXIF strip before upload.
│   └── test.html         In-browser checks. Open /test.html with the server up.
└── backend/
    ├── migrations/       Forward-only numbered SQL, 001…008. Never edited once
    │                     applied; add a new file.
    ├── src/
    │   ├── index.js      Boot.
    │   ├── http/         server.js, config.js (all env, validated at boot),
    │   │                 session.js, audit.js, routes/ (ten route files).
    │   ├── repo/         SQL per table. Every function takes the accountId.
    │   ├── jobs/         sync (iCal) → send → purge, run by the tick.
    │   ├── mail/         transport boundary, gmail.js (API), smtp.js, account.js.
    │   ├── files/        encryption, sniffing, receive pipeline, stores.
    │   ├── ical/         fetch, parse, connect, and a CLI probe.
    │   ├── auth/google.js  OAuth: sign-in, and connecting a Gmail to send.
    │   └── db/           client, migrate, demo seeder, migrate CLI.
    ├── test/             node:test. `fixtures/session.js` signs a test in.
    └── scripts/loadtest.js   Budgets: round trips, memory, asset size.
```

## Current state

Working and deployed on Render, at `gatepass.paletteandpillows.space`, with
Turso (SQLite) for data and encrypted ID photos, and an external cron ping
driving the tick.

- **Many hosts per deployment.** People sign in with Google. Each host has an
  account holding their listings, societies, times and sending Gmail; co-hosts
  are invited by address. `PLATFORM_OWNER_EMAIL` is whoever runs the
  deployment and approves who may start an account.
- **Email goes out through the Gmail API** from each host's own address, with
  send-only permission, because Render blocks outbound SMTP.
- **Tests**: `cd backend && npm test` (206 server tests) plus `/test.html` in a
  browser (30 checks). `npm run loadtest` holds the performance budgets.
- **Phases 1–5 are done.** `docs/ROADMAP.md` has what is left, including a
  backlog raised by the host after first deploy.

## Working agreements

1. **Decisions live in `docs/DECISIONS.md`.** It is the product's source of
   truth. If your change contradicts it, change that file in the same commit —
   with the reasoning — or don't make the change.
2. **Follow the phase order in `docs/ROADMAP.md`**, and tick items off in the
   same commit that lands them.
3. **No new dependency without a line in `docs/DECISIONS.md`.** The frontend has
   zero runtime dependencies beyond two Google Fonts. The backend's budget is
   about eight (`docs/TECH_STACK.md`); it is at eight.
4. **Nothing hardcoded.** A value the host owns is data and belongs in the
   database; a value the product owns is a knob and belongs in `config.js` (or
   `src/http/config.js` on the server). Derived values — status, adult count,
   nights, every window — are computed in `shared/rules.js`, never stored.
5. **One definition of a rule.** If the browser and the server both need it, it
   goes in `shared/rules.js`. A rule implemented twice is a rule that will
   disagree with itself.
6. **Guest data is personal data.** IDs are Aadhaar, passports, driving
   licences. Read `docs/SECURITY.md` before touching upload, storage, tokens,
   email, or retention. Never log an ID, a guest token, a cookie, or a
   credential.
7. **Never claim a send that did not happen.** `sent_at` is written only after
   the transport succeeds, and the UI reports the real outcome. A false "Sent"
   is the failure this product exists to prevent.
8. **Don't widen guest scope.** The guest page shows one booking and does one
   thing: upload IDs. No sending, no other bookings, no automation controls.

## Running it

```bash
cd backend
npm ci
npm run demo          # a society, two listings, a few bookings (local file DB only)
npm start             # http://localhost:8080  — serves the API and the pages
```

Locally there is no Google app, so the sign-in screen offers a **development
sign-in**: type the demo address (`host@example.com`, or whatever `DEMO_EMAIL`
was) and you are in. It is refused in production, and `DEV_LOGIN=true` there is
fatal at boot. `backend/.env.example` documents every setting; a real `.env` is
gitignored and must stay that way.

The guest view is reached by a booking's own guest link — **Copy guest upload
link** or **Open the guest link** on a booking, which resolves to
`#u/<signed token>`.

## Verifying a change

1. `cd backend && npm test`. Add a test for any rule you change.
2. Open `/test.html` with the server running; every line must read PASS.
3. `npm run loadtest` if you touched a query, a route, or an asset.
4. Then drive the flows you touched in a real browser — `docs/TESTING.md` has
   the checklist. Screenshots in headless Chrome need the real-time runner, not
   `--virtual-time-budget`: an open EventSource stalls virtual time.

Do not report a change as verified on the basis of reading the diff.

## Conventions in the code as it stands

- **Every repo function takes the account whose data it may touch**, and the
  account is part of the SQL rather than a filter applied afterwards. An id
  belonging to another account returns **404, not 403** — a 403 confirms it
  exists. `test/accounts.test.js` holds this line; read it before touching
  scoping.
- Roles: `owner` is the host (sending Gmail, desk addresses, access,
  deletions), `admin` is a co-host (the daily work). The role is re-read from
  the memberships table on each request, never trusted from the cookie.
- `app.js` is organised in banner-commented sections
  (`// ---------- detail ----------`). Add to the matching section.
- Rendering is full re-render: mutate `view`, call `render()`. There is no
  diffing and no component model. Keep it that way for now.
- Each screen has an address: `#bookings`, `#bookings/<id>`,
  `#settings/<tab>`, `#u/<token>`. `routeToView` reads it, `syncAddress`
  writes it.
- All user-supplied strings go through `esc()` before entering a template
  literal. `esc()` does not escape quotes, so user data never fills an
  attribute — set it as a property after mounting
  (`docs/CODING_STANDARDS.md`).
- Colours, spacing and radii come from the CSS variables on `:root`. Never
  hardcode a hex value in a rule.
- A `button`, `input`, `textarea` or `select` does not inherit `color` from the
  browser. The global reset sets `color: inherit`; do not undo it.
- Theme state is `data-theme` on `<html>` plus `localStorage["gatepass.theme"]`,
  absent meaning "follow the OS". Read it through `themePref()`, write it
  through `setTheme()`.
- Live updates carry **only a booking id** over SSE, and the client re-fetches
  through the normal authenticated API, so the stream can never leak a name or
  a document.
- Fastify runs with `removeAdditional: false`: an unknown body field is a 400,
  not a silent drop. Response schemas also strip unlisted fields — if a new
  field does not reach the browser, the response schema is why.

## Document map

| File | What it is for |
| --- | --- |
| `docs/CONTEXT.md` | Why this exists, who it serves, the constraints around it. Start here. |
| `docs/DECISIONS.md` | Every product decision, and the open ones. Source of truth. |
| `docs/ARCHITECTURE.md` | How the system is put together. |
| `docs/PRODUCT_PRINCIPLES.md` | The rules that decide what gets built and what gets refused. |
| `docs/DESIGN.md` | The visual and interaction system: tokens, components, copy. |
| `docs/CODING_STANDARDS.md` | How to write code here. |
| `docs/TESTING.md` | What we test, how, and the manual checklist. |
| `docs/SECURITY.md` | Threat model, data handling rules, disclosure. |
| `docs/REVIEW.md` | What a reviewer looks for and what blocks a merge. |
| `docs/TRIAGE.md` | How bugs and incidents are classified and handled. |
| `docs/TECH_STACK.md` | The stack, the reasoning, the budgets, and how it stays fast as data grows. |
| `docs/PROJECT.md` | How work is planned, branched, committed, and shipped. |
| `docs/ROADMAP.md` | What is done, what is next, and the backlog. |
| `CHANGELOG.md` | What changed, per release. |

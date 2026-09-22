# GatePass

A small tool for Airbnb hosts to collect guest ID proofs and forward them to a
residential society's security helpdesk automatically, on time, per booking.

Built for the case of a host with one or more listings, where each listing sits
in a society that requires guest IDs to be emailed to its security desk before
arrival.

## What this repo contains

```
gatepass/
├── README.md            You are here. Project overview and how to run.
├── CLAUDE.md            Orientation for contributors and coding agents.
├── CHANGELOG.md         What changed, per release.
├── shared/
│   └── rules.js         THE RULES, imported by the frontend AND the server.
├── docs/                The written record. Start with CONTEXT.md.
│   ├── CONTEXT.md            Why this exists, who it serves, the constraints.
│   ├── DECISIONS.md          Every product decision made so far. Source of truth.
│   ├── PRODUCT_PRINCIPLES.md How we decide what to build and what to refuse.
│   ├── ARCHITECTURE.md       How the system is put together, now and as planned.
│   ├── DESIGN.md             The visual and interaction system.
│   ├── CODING_STANDARDS.md   How to write code here.
│   ├── TECH_STACK.md         The stack, the why, the budgets, the scaling plan.
│   ├── TESTING.md            What we test, and the manual checklist for now.
│   ├── SECURITY.md           Threat model and data-handling rules.
│   ├── REVIEW.md             What a reviewer looks for; what blocks a merge.
│   ├── TRIAGE.md             How bugs and incidents are classified and handled.
│   ├── PROJECT.md            How work is planned, branched, and shipped.
│   └── ROADMAP.md            What is done, what is next, in phases.
├── frontend/            The admin + guest UI (working prototype).
│   ├── index.html
│   ├── css/styles.css
│   ├── js/config.js          Presentation knobs. No data, no rules.
│   ├── js/data.js            The data boundary + the only mock values.
│   ├── js/app.js             Rendering only.
│   ├── test.html             Runnable checks — serve and open.
│   └── README.md
└── backend/             Phase 1a built: the Airbnb calendar reader.
    ├── src/ical/             parse · fetch · connect · probe (CLI)
    ├── test/                 checks + real-shaped .ics fixtures
    ├── README.md
    └── .env.example
```

## Current status

The **frontend is a working prototype** with mock data and no server. It covers
the full first flow end to end: calendar sync → a booking → collect adult IDs
(by admin or by the guest) → send to the correct society → auto-remove after
checkout. Admin and guest access are separated.

The **backend is started.** Phase 1a — the Airbnb calendar reader — is built and
tested; run `npm run probe` against your own listing. Everything else is still
the plan in `backend/README.md`, which describes the data model, API and jobs so
we can build without re-deciding anything.

## Run it

The server serves the frontend too, from the same origin, so there is one
command and no CORS.

```bash
cd backend
npm install
npm start
# open http://localhost:8080
```

Migrations run on boot. The admin passcode starts at `0000` — change it in
Settings → Admin access. The database is `backend/data/gatepass.db` by default.

> There is no static-only mode any more: the frontend calls the API for
> everything, and `file://` cannot load ES modules. `./dev.sh` still serves the
> files alone if you only want to look at the markup.

Admin passcode in the prototype starts at **0000** (change it in
Settings → Admin access). To see the guest page, open a booking and use **Copy
guest upload link** or **Open the guest link** — the same link a real guest
gets.

Light and dark both work. The **Appearance** control at the bottom of the
sidebar offers Light / Match system / Dark, and remembers the choice on that
device.

## Checks

```bash
open http://localhost:5173/test.html   # the UI's rules + data layer
cd backend && npm test                          # shared rules + calendar reader
```

No runner and no dependencies either side. The browser page's title shows the
score; every line must read PASS. **Both suites exercise the same
`shared/rules.js`.** Layout and rendering are still checked by hand — see
`docs/TESTING.md`.

## Try your Airbnb calendar

```bash
cd backend
npm run probe -- "https://www.airbnb.co.in/calendar/ical/XXXX.ics?s=YYYY"
```

Airbnb → your listing → Availability → Connect calendars → Export calendar.

## Where to start reading

- New here? `docs/CONTEXT.md`, then `docs/DECISIONS.md`.
- About to write code? `CLAUDE.md`, then `docs/CODING_STANDARDS.md`.
- Touching uploads, tokens, email, or retention? `docs/SECURITY.md` first.
- Planning the next piece of work? `docs/ROADMAP.md` and `docs/PROJECT.md`.
- Wondering why the stack is what it is? `docs/TECH_STACK.md`.

## Tracking work

This folder is a git repo. Use branches per piece of work (for example
`backend/auth`, `backend/ical-sync`), keep `docs/ROADMAP.md` checked off as
things land, and record anything a user would notice in `CHANGELOG.md`. The full
workflow is in `docs/PROJECT.md`.

# CLAUDE.md

Guidance for Claude Code (and any other agent or new contributor) working in this
repository. Read this first, then `docs/DECISIONS.md`.

## What this project is

GatePass collects government ID proofs for the adult guests of an Airbnb booking
and emails them to the correct residential society's security helpdesk — before
arrival, or the moment the last ID lands. One host, one or more listings, each
listing in exactly one society.

It is a small, single-purpose tool. It is not a PMS, not a channel manager, and
not a general document vault. See `docs/PRODUCT_PRINCIPLES.md` before adding
anything that looks like a new surface.

## Repository layout

```
gatepass/
├── CLAUDE.md             This file — orientation for agents and contributors.
├── README.md             Project overview and how to run.
├── docs/                 The written record. See docs/CONTEXT.md for the map.
├── frontend/             Working prototype: vanilla HTML + CSS + JS, no build.
│   ├── index.html        Shell markup, fonts, pre-paint theme script.
│   ├── css/styles.css    All styles, CSS-variable themed, light/dark aware.
│   ├── js/config.js      Every tunable the product owns. No data.
│   ├── js/data.js        The data boundary: Derive, the async Data API, and
│   │                     SEED — the only mock values in the app.
│   ├── js/app.js         Rendering and behaviour. No data, no literals.
│   └── test.html         Runnable checks. Open it in a browser.
└── backend/              Not built yet. README.md holds the plan; .env.example
                          holds the config surface.
```

## Current state — read this before you plan anything

- **Frontend**: a working prototype. Real interaction, **mock data only**. Every
  "send" writes to an in-memory store and shows a toast. No network calls exist.
  The data layer is already async and API-shaped, so connecting the server is a
  change to `data.js` alone.
- **Backend**: **does not exist.** `backend/README.md` is a plan, not code. The
  data model, API surface, and jobs described there are proposals that Phase 1
  is meant to confirm or replace.
- **Tests**: `frontend/test.html` runs real checks on the rules (derived state,
  retention, pagination, society resolution, template filling, send gating,
  automation, guest scoping, auth). Rendering and layout are still checked by
  hand — see `docs/TESTING.md`.
- **Git**: one commit on `master`. No CI, no dependency manifest, no linter
  config. Do not claim any of these run; they are not there yet.

If a task assumes a server, a database, or a test runner, say so and either
build that piece deliberately (following `docs/ROADMAP.md` phase order) or ask.

## Working agreements

1. **Decisions live in `docs/DECISIONS.md`.** It is the product's source of
   truth. If your change contradicts it, change that file in the same commit —
   with the reasoning — or don't make the change.
2. **Follow the phase order in `docs/ROADMAP.md`.** Phases are dependency-ordered,
   not a wish list. Check items off as they land, in the same commit.
3. **No new dependency without a line in `docs/DECISIONS.md`.** The frontend has
   zero runtime dependencies beyond two Google Fonts. Keep it that way until a
   dependency earns its place in writing. The backend's budget is about eight
   (`docs/TECH_STACK.md`).
4. **Nothing hardcoded.** A value the host owns is data and belongs in
   `data.js`; a value the product owns is a knob and belongs in `config.js`.
   If you are about to type a name, an email, a date format, a document type, a
   retention window or a timing into `app.js` or a stylesheet, it goes in one of
   those two files instead. Derived values (status, adult count, nights) are
   computed in `Derive`, never stored.
5. **No framework in the frontend yet.** The signal to reach for one is
   `app.js` becoming genuinely unmanageable — and that is a Phase 5 item, not an
   opportunistic refactor.
6. **Guest data is personal data.** IDs are Aadhaar, passports, driving licences.
   Read `docs/SECURITY.md` before touching upload, storage, tokens, email, or
   retention. Never log an ID, a file path, or a guest token.
7. **Don't widen guest scope.** The guest page shows one booking and does one
   thing: upload IDs. No sending, no other bookings, no automation controls.

## Running it

```bash
cd frontend
python3 -m http.server 5173
# http://localhost:5173
```

Admin passcode starts at `0000` (Settings → Admin access). The guest view is
reached by the booking's own guest link — **Copy guest upload link** or **Open
the guest link** on a booking, which resolves to `#u/<booking-id>` in the
prototype and to a signed token in Phase 3.

## Verifying a change

1. Open `frontend/test.html` (or serve the folder and load `/test.html`). The
   page title shows the score; every line must read PASS. Add a check there for
   any rule you change.
2. Then walk the flows you touched, following the checklist in
   `docs/TESTING.md`, and say in the PR which ones you ran and what you saw.

Do not report a change as verified on the basis of reading the diff.

## Conventions in the code as it stands

- `app.js` is organised in banner-commented sections (`// ---------- detail ----------`).
  Add to the matching section rather than appending at the end.
- Rendering is full re-render: mutate state, call `render()`. There is no
  diffing and no component model. Keep it that way for now.
- Status is **derived**, never stored: see `statusOf()` in
  [app.js](frontend/js/app.js). `conflict → sent → ready → awaiting`.
- A booking's society is resolved through its listing (`soc(b)`), never stored
  on the booking and never inferred from the calendar.
- All user-supplied strings go through `esc()` before entering a template
  literal. `esc()` does not escape quotes, so user data never fills an
  attribute — set it as a property after mounting. See
  `docs/CODING_STANDARDS.md`.
- Colours, spacing, and radii come from the CSS variables on `:root`. Never
  hardcode a hex value in a rule.
- A `button`, `input`, `textarea`, or `select` does not inherit `color` from the
  browser. The global reset now sets `color: inherit`; do not undo it, and do
  not rely on a UA default anywhere.
- Theme state is `data-theme` on `<html>` plus `localStorage["gatepass.theme"]`,
  with absent meaning "follow the OS". Read it through `themePref()` and write
  it through `setTheme()`; never touch the attribute directly.
- The guest page is reached by the booking's guest link only. There is no
  preview route, and adding one back needs a decision recorded first.

## Document map

| File | What it is for |
| --- | --- |
| `docs/CONTEXT.md` | Why this exists, who it serves, the constraints around it. Start here. |
| `docs/DECISIONS.md` | Every product decision, and the open ones. Source of truth. |
| `docs/ARCHITECTURE.md` | How the system is put together, now and as planned. |
| `docs/PRODUCT_PRINCIPLES.md` | The rules that decide what gets built and what gets refused. |
| `docs/DESIGN.md` | The visual and interaction system: tokens, components, copy. |
| `docs/CODING_STANDARDS.md` | How to write code here. |
| `docs/TESTING.md` | What we test, how, and the manual checklist until there's a runner. |
| `docs/SECURITY.md` | Threat model, data handling rules, disclosure. |
| `docs/REVIEW.md` | What a reviewer looks for and what blocks a merge. |
| `docs/TRIAGE.md` | How bugs and incidents are classified and handled. |
| `docs/TECH_STACK.md` | The stack, the reasoning, the budgets, and how it stays fast as data grows. |
| `docs/PROJECT.md` | How work is planned, branched, committed, and shipped. |
| `docs/ROADMAP.md` | What is done, what is next, in phases. |
| `CHANGELOG.md` | What changed, per release. |

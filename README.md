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
├── docs/
│   ├── DECISIONS.md      Every product decision made so far. Read this first.
│   └── ROADMAP.md        What is done, what is next, in phases.
├── frontend/            The admin + guest UI (working prototype).
│   ├── index.html
│   ├── css/styles.css
│   ├── js/app.js
│   └── README.md
└── backend/             The server, not built yet. Plan and API live here.
    ├── README.md
    └── .env.example
```

## Current status

The **frontend is a working prototype** with mock data and no server. It covers
the full first flow end to end: calendar sync → a booking → collect adult IDs
(by admin or by the guest) → send to the correct society → auto-remove after
checkout. Admin and guest access are separated.

The **backend does not exist yet.** `backend/README.md` describes the planned
data model, API, and jobs so we can build it without re-deciding anything.

## Run the frontend

No build step and no server needed for the prototype. Either:

- Open `frontend/index.html` directly in a browser, or
- Serve the folder (nicer for clean URLs while developing):

```bash
cd frontend
python3 -m http.server 5173
# open http://localhost:5173
```

Admin passcode in the prototype starts at **0000** (change it in
Settings → Admin access). To see the guest page, open a booking and click
**Preview guest page**.

## Tracking work

This folder is a git repo with an initial commit. Use branches per piece of
work (for example `backend/auth`, `backend/ical-sync`) and keep `docs/ROADMAP.md`
checked off as things land.

# Project State — GatePass

_Last updated: 2026-10-02 by Claude Code (Opus 5.5), during onboarding — confirm the objective and next action._

## Current objective
Live on Render (`gatepass.paletteandpillows.space`), phases 1–5 done. Work now comes from the host backlog and production findings in `docs/ROADMAP.md`.

## Completed (recent)
- 2026-10-02: cancellations expire 24h after cancellation (were lingering until their original checkout); "past" and "cancelled" merged into one collapsed section.
- 2026-10-02: tick health strip on Bookings (stale tick, failing mailbox, unreadable calendar, unconnected listing); cancellation separated from sync conflict, with a `past` group.
- 2026-09-29: iOS-style motion system made the standard.

## In progress
Nothing half-done; the working tree was clean at onboarding.

## Blocked / open questions
- Which backlog item is next? Open ones in `docs/ROADMAP.md` → *Backlog*: #3 telling bookings of the same flat apart, #4 a first run that explains itself, #5 drop the dead passcode tables (`admin_auth`, `owner_links`).
- Phase 5 leftover: off-Turso nightly backups.

## Next action
Two items planned on 2026-10-02 and awaiting the go-ahead — see `docs/ROADMAP.md` → *Planned*:
- **A.** Done 2026-10-02: cancellations expire 24h after the cancellation, files included, and "past" + "cancelled" are one collapsed section.
- **B.** Next, if the host agrees: Direct bookings (taken outside Airbnb). Blocker: sync would mark them cancelled within ten minutes, and overlaps with Airbnb reservations would go undetected.

## Gotchas
- Deployment breaks things tests can't see (see ROADMAP *Found by using it in production*). Verify on the deployed site, not only `npm test`.
- `FILE_ENCRYPTION_KEY.txt` and `db_turso_auth_token.txt` sit in the repo root; they are gitignored — never read, print or commit them.

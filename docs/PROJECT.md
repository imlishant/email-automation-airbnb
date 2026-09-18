# Project

How work gets planned, branched, committed, and shipped. Small project, one
maintainer, occasional agent help — the process is here so that a six-month gap
does not cost a week of re-reading code.

## People and roles

One maintainer, who is also the host using the tool. That is unusually good:
the feedback loop is a single person noticing a guest stuck at a gate. It is
also the main risk — nothing is written down unless it is written down
deliberately, which is why `docs/` is as large as it is relative to the code.

Agents are contributors, held to the same bar (`REVIEW.md`), with the extra
scrutiny that section describes.

## Planning

Work comes from three places, in priority order:

1. **A guest was affected.** Straight to `TRIAGE.md`.
2. **The roadmap.** `ROADMAP.md` is phase-ordered by dependency, not by appeal.
   Phase 1 before Phase 2, and so on — the sync worker needs a schema, the email
   needs a society.
3. **An open decision.** `DECISIONS.md` lists them. An open decision blocking a
   phase is the highest-value work available, because it is cheap now and
   expensive later.

Anything else is a "not now" until principle 1 in `PRODUCT_PRINCIPLES.md` says
otherwise.

### Phases

| Phase | What | Status |
| --- | --- | --- |
| 0 | UI prototype over mock data | Done |
| 1 | Backend foundations: stack, schema, auth, settings CRUD | Next |
| 2 | Airbnb calendar sync | Planned |
| 3 | Guest upload: real tokens, real files | Planned |
| 4 | Email and automation | Planned |
| 5 | Retention, safety, polish | Planned |

Phase 1 is where the remaining open decisions get closed — the stack, and the
retention windows. Do not start Phase 2 with them open.

## Branches

One branch per piece of work, named `area/thing`:

```
backend/auth
backend/ical-sync
frontend/guest-upload
docs/security
```

`master` is the trunk. Keep branches short-lived; a branch open for weeks is a
branch that will conflict with the docs as much as the code.

## Commits

- One logical change per commit.
- Imperative subject under ~70 characters: `Add attempt lockout to passcode unlock`.
- Body wrapped at 72 columns, explaining *why*, when the subject is not
  self-evident.
- **In the same commit** as the change: tick the `ROADMAP.md` item, update
  `DECISIONS.md` if a decision moved, add to `CHANGELOG.md` if it is
  user-visible. These going stale is the specific failure this process exists to
  prevent.

## Definition of done

A piece of work is done when all of these are true:

- [ ] It works, and you watched it work (`TESTING.md`).
- [ ] It follows `CODING_STANDARDS.md`.
- [ ] It does not contradict `DECISIONS.md`, or it updates it with reasoning.
- [ ] Anything touching documents, tokens, email, or retention has been checked
      against `SECURITY.md`.
- [ ] Docs and roadmap reflect reality.
- [ ] `CHANGELOG.md` has an entry if a user would notice.
- [ ] It passes `REVIEW.md`.

"The code is written" is not done.

## Releasing

There is nothing deployed yet, so there is nothing to release. When there is:

- Semantic-ish versions, dated, recorded in `CHANGELOG.md` (Keep a Changelog
  format — already set up).
- Tag the commit.
- Migrations run before the new code, and are forward-only.
- Deploy with the host's next booking in mind: never during a check-in window
  for a live booking. Check the bookings list first — that is what it is for.
- A release note the host can actually read: what is new, what changed, what to
  do differently.

## Rollback

Until the backend exists, rollback is `git revert`. After it exists: keep the
previous version deployable, never make a migration that cannot be rolled
forward past, and remember that a bad send cannot be recalled — which is why
send behaviour changes get the most verification (`TESTING.md`).

## Keeping the docs true

The documents are load-bearing here; stale ones are worse than none.

- `DECISIONS.md` and `ROADMAP.md` change in the same commit as the code they
  describe.
- At the end of each phase, re-read `ARCHITECTURE.md` and `CLAUDE.md` and delete
  anything that has stopped being true — particularly the "not built yet" and
  "prototype limits" passages, which are correct today and will become
  misleading the moment Phase 1 lands.
- If a document and the code disagree, the code is what runs and the document is
  the bug. Fix the document the same day.

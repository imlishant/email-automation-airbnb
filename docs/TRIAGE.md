# Triage

How a report becomes a fix. One maintainer, one host, real guests at a real gate
— so severity is judged by what happens to a guest or a document, not by how
broken the code looks.

## The question that sets severity

> Is a guest being held at a gate, or has personal data gone somewhere it
> should not be?

If either is yes, it is a P0 and everything else waits.

## Severity

### P0 — drop everything

- ID documents exposed to anyone without an admin session.
- A guest token reaching a booking that is not its own.
- An email with IDs attached sent to the wrong society.
- Admin access bypassed, or the passcode brute-forced.
- Sends failing silently for every booking — the tool appears to work and no
  guest is cleared.
- Documents deleted before their retention window.

**Response:** stop the bleeding before diagnosing. Take the surface down,
rotate tokens, rotate the passcode — whichever applies. For anything involving
exposed documents, taking the tool offline is the correct first move; the host
can send an email by hand for a day. Then establish scope from the `activity`
log, then fix, then write it up.

### P1 — same day

- One booking's automation does not fire; that host must send manually.
- Calendar sync stops for a listing, so new bookings do not appear.
- A guest cannot upload — the page errors, or the upload is rejected for a valid
  file.
- The admin cannot unlock with the correct passcode.
- A booking disappears that should still be visible.
- Wrong status shown on a booking, such that the host thinks something is done.

These do not leak data, but they put a guest at a gate. Ship the fix; an ugly
fix now beats a clean one tomorrow, with a follow-up issue filed for the clean
one.

### P2 — this week

- A sync conflict that is genuinely resolvable being surfaced as a conflict.
- A template placeholder not filling.
- Layout broken on a phone in the guest flow.
- The activity log missing an event that happened.
- Something slow enough to be annoying.

### P3 — when convenient

- Copy, spacing, dark-mode polish.
- A missing nicety the host worked around.
- Known prototype limits (`ARCHITECTURE.md`) — these are not bugs. They close
  with their phase.
- Refactors and tech-debt items.

## Intake

A report — from the host, a guest complaint relayed by the host, or your own
observation — gets written down before it gets debugged. Minimum:

```
What happened, in the reporter's words.
Which booking (code), which listing, which society.
When — and what the activity log says around that time.
Expected vs. actual.
Admin or guest side. Which browser, phone or desktop.
Severity, and the reason for it.
```

**Never paste an ID document, a guest token, or a passcode into an issue.**
Reference the booking code and the person's row, not the file. If reproducing
needs a document, use a synthetic one.

## Working a bug

1. **Assess severity first.** One sentence. If it is P0, act before you
   understand — revoke, then investigate.
2. **Reproduce.** On the prototype, that means the same booking shape in mock
   data; on the real system, the same booking. If you cannot reproduce it, say so
   in the issue rather than guessing at a fix.
3. **Read the activity log.** It is the audit trail and the timeline, and it is
   usually faster than reading code. It will tell you whether a send happened,
   when, and to whom.
4. **Locate, do not guess.** Narrow to one function. The derived-state helpers
   in [app.js](../frontend/js/app.js) — `statusOf`, `soc`, `uploaded`,
   `fillTemplate`, `guestLinkActive` — are where behaviour bugs concentrate,
   because everything reads through them.
5. **Fix the cause.** A wrong status is almost never fixed by writing a status
   field; it is fixed in `statusOf`. Resist the patch that makes the symptom go
   away in one screen.
6. **Add the test**, or add the case to the `TESTING.md` checklist if there is
   still no runner. A bug that reached a guest gets a permanent regression
   guard.
7. **Write it down.** If the bug existed because a decision was ambiguous, fix
   the ambiguity in `DECISIONS.md` — that is the actual fix.

## Common causes, checked in this order

Before debugging deeply, rule these out — they account for most reports:

- **The iCal feed.** It is thin and inconsistent: no guest name, no headcount,
  changed dates, cancellations reappearing, overlapping blocks. A "wrong booking
  data" report is usually the feed, not the parser.
- **Adult count.** It comes from the guest's stepper, not from Airbnb. A booking
  "missing an ID" is often a booking whose count was raised mid-stay.
- **Society assignment.** A listing connected without a society, or with the
  wrong one, produces a misroute that looks like a mail bug.
- **The guest link window.** Checkout + 24h. "The link doesn't work" is usually
  an expired link behaving correctly.
- **Retention.** "The booking vanished" is usually the 24h hide rule working.
- **Automation mode.** `before` versus `allids` explains most "why hasn't it
  sent" and "why did it send early" reports.

## After a P0

Write a short, blameless account in the same day, and put it where it will be
read — not in a commit message:

- Timeline, from first occurrence to resolution.
- Scope: which bookings, which documents, which recipients. From the log, not
  from memory.
- Cause. The mechanism, not the person.
- What made it possible: the missing control, the ambiguous decision, the
  untested path.
- What changed so it cannot recur — a test, a control, a decision written down.

One P0 involving guest documents justifies stopping feature work until its class
of cause is closed. That is the whole point of writing it up.

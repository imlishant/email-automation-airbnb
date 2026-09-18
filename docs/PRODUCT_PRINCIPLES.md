# Product principles

The rules we use to decide what gets built, what gets refused, and how a feature
should behave when the answer is not obvious. `DECISIONS.md` records *what* was
decided; this file records *how* to decide.

A principle earns its place here only if it has already caused us to say no to
something.

---

## 1. One job: IDs to the right desk, on time

GatePass exists to get adult ID proofs to a society security helpdesk before the
guests arrive. Everything else is out of scope until this one job is boring and
reliable.

**This rules out**, absent a decision recorded in `DECISIONS.md`: messaging
guests, check-in instructions, cleaning schedules, pricing, multi-channel
booking imports, analytics dashboards, invoicing.

**In practice:** a feature request that does not make an ID arrive sooner, more
reliably, or with less human attention is a "not now".

## 2. The guest owes us one tap

The guest did not sign up for this tool and may be standing at a gate. Their
whole obligation is: open a link, upload a photo, leave.

**Therefore:** no account, no password, no OTP, no app, no consent wall, no
tutorial. The guest page is mobile-first and shows only the ID upload — no
email, no send, no automation controls, no other bookings.

**The test:** count the taps between opening the link and the last ID being in.
If that number went up, justify it or revert it.

## 3. Automatic beats correct-if-you-remember

A tool that requires the host to remember something has already failed at the
thing it was built to prevent. Bookings arrive on their own. The email sends
itself. Old bookings leave on their own.

**Therefore:** every new capability ships with its automatic behaviour, not as a
button the host must find. A manual control is a fallback for when automation was
wrong — never the primary path. "Sync now" exists so a host who distrusts the
poll can force one, not because the poll is optional.

## 4. Never guess where personal data is going

An ID sent to the wrong security desk is worse than an ID sent late.

**Therefore:** the society is assigned by the admin, by hand, when a listing is
connected — never extracted from a calendar feed, never inferred from a name,
never defaulted. There is deliberately no clever matching to be wrong about.

**Generalised:** if a mistake in an inference would misroute personal data, do
not infer. Ask once and store the answer.

## 5. Derive state; do not store it

Status is computed from the facts (`conflict`, `sent`, IDs in vs. adults
expected). A booking's society is resolved through its listing. Neither is
stored.

**Why:** a stored status is a field that can disagree with reality, and a
duplicated desk email is an email that can be stale when it matters most.

**Cost we accept:** slightly more computation on read, and the discipline of
keeping exactly one implementation of each rule.

**The same rule applied to constants:** a value typed into a screen is a value
that will be typed differently into the next screen. Anything the host owns is
data; anything the product owns is one named knob. Neither lives in a render
function.

## 6. Hold as little as possible, for as short as possible

We hold Aadhaar numbers, passports, and driving licences. The safest posture is
not to have them.

**Therefore:** one ID per adult and nothing more. Children are not counted and
need no ID. Bookings leave the admin list 24 hours after checkout. Guest links
die at the same moment. ID files are deleted on a schedule, separately from and
sooner than the booking record that proves they were sent.

**Before adding any field, ask:** does the security desk need it, or does the
send need it? If neither, do not collect it.

## 7. The society owns the email, not us

Different desks expect different wording. We do not know better than the desk
that has to act on it.

**Therefore:** the email body is a per-society template the host edits, filled
with booking values. We supply the variables and the timing, not the prose. Two
listings in one society share one template; two societies keep their own.

## 8. Attention first, chronology second

The bookings list puts what needs a human on top — awaiting IDs, or a sync
conflict — in check-in order, nearest first. Ready and sent bookings sit below.

**That is the whole sorting rule.** It was considered and settled: no relevance
scoring, no pinning, no manual ordering. If the top of the list is empty, there
is nothing to do, and that is the signal the list exists to give.

## 9. Degrade visibly, never silently

The iCal feed is thin and sometimes contradicts itself. Overlapping dates become
a visible **sync conflict** on the booking, kept at the top of the list, with
nothing dropped. A guest link past its window says "link not active" rather than
failing blankly.

**Therefore:** when the system cannot resolve something, surface it as a state a
human can act on. Never discard data to make a screen look tidy, and never
proceed on a guess. This is the necessary counterweight to principle 3: the more
automatic the tool is, the louder its failures have to be.

## 10. Write the decision down before writing the code

Every product decision goes in `DECISIONS.md`, and the open questions go in the
same file with the word "open" next to them.

**Therefore:** a change that contradicts a recorded decision updates that record
in the same commit, with the reasoning. A change that settles an open question
closes it there. A new dependency gets a line. If it is not written down, the
next person re-decides it differently, and both of them will be right.

## 11. Keep the smallest thing that works

No framework, no build step, and zero runtime dependencies in the frontend
today, because one flow across three files does not need them. SQLite before
Postgres. Local disk before an object store.

**Not a vow of poverty:** each of these has a written trigger for when to
upgrade (see `ARCHITECTURE.md` and `ROADMAP.md`). The rule is that complexity
arrives when something has actually broken, not in anticipation.

---

## Using these

When a request arrives, in order:

1. Does it serve the one job (1)? If not, it is a "not now".
2. Does it cost the guest a tap (2)? If so, the value must be argued for.
3. Can it be automatic (3)? Then it should be, with visible failure (9).
4. Does it infer where data goes (4)? Then it must not.
5. Does it store something derivable (5) or something nobody needs (6)?
6. Write the decision down (10), then build the smallest version (11).

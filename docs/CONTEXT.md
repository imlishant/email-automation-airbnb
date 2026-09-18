# Context

Why GatePass exists, who it is for, and the constraints it lives inside. If you
are new — human or agent — read this before the code.

## The problem

Many gated residential societies in India require a host to email the government
ID proofs of every arriving adult to the society's security helpdesk **before**
the guests reach the gate. Miss it and the guests are held at the gate; the host
finds out by phone, usually at the worst moment.

Doing this by hand means, per booking: notice the booking, work out which
society it belongs to, chase each adult guest for an ID on WhatsApp, collect the
files, write the email the desk expects, attach the right files, and send it at
roughly the right time. It is perhaps ten minutes of fiddly work per booking,
and the cost of forgetting is disproportionate.

## Who it is for

**The host (admin).** Owns one or more Airbnb listings, each in a society with
its own desk email and its own preferred wording. Not technical. Checks the tool
on a phone or laptop between other things. Wants to glance at a list, see what
needs attention, and otherwise have it handled.

**The guest.** Arriving traveller, almost certainly on a phone, possibly at the
gate already, with no interest in this tool and no patience for signing up. Will
tolerate exactly one tap-through: open a link, upload a photo of an ID, done.

**The society's security desk.** Never uses the tool. Receives an email and must
be able to act on it without asking questions. The email's shape is therefore
the society's choice, not ours — hence a per-society template.

## The shape that follows from that

- **No accounts.** The admin side is behind one shared 4-digit passcode. The
  guest side is behind nothing but an unguessable link. Anything more and the
  tool is worse than WhatsApp.
- **Automatic by default.** Bookings arrive on their own from the listing's
  Airbnb iCal feed. The email sends itself, either an hour before check-in or
  the moment the last ID is in. Manual send exists as a fallback, not a step.
- **Per-society templates.** Two listings in one society share a template; two
  societies each keep their own.
- **Adults only.** One ID per adult guest. Children are not counted and need no
  ID.
- **Short-lived.** A booking leaves the admin list 24 hours after checkout. The
  guest link dies at the same moment. Nothing accumulates.

## Constraints we did not choose

- **The Airbnb iCal feed is thin.** It reliably gives dates and a booking code.
  It usually does **not** give the guest's name or headcount. So the adult count
  is confirmed by the guest, through the guest link, using a stepper on the guest
  page. The richer official Airbnb API needs approval we do not have.
- **The society is never inferred.** Because the feed cannot be trusted to say
  where a listing is, the admin assigns each listing's society by hand when
  connecting it. There is deliberately no extraction to get wrong.
- **Guests add people mid-stay.** Friends and visitors turn up after check-in
  and each needs their own ID. That is why the guest link stays live until
  checkout + 24h rather than dying at check-in.
- **We hold identity documents.** That single fact drives most of
  `SECURITY.md`: encryption at rest, admin-only reads, no public listing, and a
  scheduled delete.

## Where the project is right now

The frontend is a working prototype over mock data: the whole first flow is
walkable, and nothing is wired to a server. The backend is a written plan and no
code. `ROADMAP.md` has the build order; `DECISIONS.md` has what is settled and
what is still open.

## Related documents

- `DECISIONS.md` — what has been decided, and the open questions.
- `PRODUCT_PRINCIPLES.md` — how to decide the next thing.
- `ARCHITECTURE.md` — how the pieces fit.

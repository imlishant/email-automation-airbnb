# Tech stack and build plan

The stack, the reasoning behind each choice, what was rejected and why, and the
performance budgets the result has to hold. This closes the "backend stack" open
decision in `DECISIONS.md`.

The goal stated plainly: **as light as a Google utility page, fast enough that
nothing ever feels like it is loading, and unbothered when the amount of data
grows.** Everything below is chosen against that, not against what is
fashionable.

---

## 1. What the system actually has to do

Getting this right first is what keeps the stack small. The honest shape of the
workload:

| Dimension | Reality |
| --- | --- |
| Writers | **One.** The host, plus background jobs. Never a crowd. |
| Readers | The host on one or two devices, and a handful of guests per booking. |
| Data volume | A booking is ~1KB. A busy host with 10 listings produces maybe 1,500 bookings a year — **under 2MB of rows a year.** |
| Heavy objects | ID documents: 0.5–5MB each, write-once, read once or twice, deleted on a schedule. |
| Working set | Bounded **by the product**: a booking leaves the list 24h after checkout. Whatever the archive holds, the list is tens of rows. |
| Latency that matters | The guest at a gate on mobile data, and the host glancing at the list. |
| Failure that matters | A send that does not happen, or happens twice. |

Two things fall out of this table and drive every choice below.

**The database is small and will stay small.** Any competent store handles it.
So the right question is not "which database scales" but "which database adds
the least latency, the least operational surface and the least code" — and that
points somewhere very different from the default answer.

**The retention rule is the scaling strategy.** The admin list is bounded by
design, not by pagination. That is a rare and valuable property, and every
choice here is made so as not to throw it away.

---

## 2. The stack

| Layer | Choice | One-line reason |
| --- | --- | --- |
| Frontend | **Vanilla JS, no build step** | Already works, ~25KB total, nothing to out-perform. |
| Transport | **JSON over HTTP/2, ETags, SSE for live updates** | One long-lived connection beats polling; conditional GETs make repeat loads free. |
| Runtime | **Node 22 LTS** | Same language as the frontend, one mental model for one maintainer. |
| HTTP server | **Fastify** | Schema-first validation and serialisation; markedly faster than Express and less code. |
| Database | **Turso (libSQL)** — SQLite over the wire | Keeps SQLite semantics and the Drizzle SQLite dialect on a host with no persistent disk. |
| Query layer | **None — parameterised SQL in `src/db/`** | Drizzle's main benefit is types, and this is plain JS. §3 has the reversal. |
| Migrations | **Plain numbered `.sql` files** + a 40-line migrator | Forward-only, reviewable, no tool to learn. |
| Background work | **In-process scheduler + a `jobs` table** | Durable and restartable without Redis or a second service. |
| File storage | **Cloudflare R2** (S3-compatible), from day one | Encrypted at rest, 10GB free, zero egress fees. Local disk is not an option on Render. |
| Email | **The host's own Gmail over SMTP** (app password) | The societies already correspond with that address; a transactional provider cannot send as it. |
| Hosting | **Render free web service** | Chosen constraint. §2a covers what it costs and how each cost is handled. |
| Scheduler trigger | **External free cron pinging `/jobs/tick`** | Render free has no cron and sleeps after 15 minutes idle. One ping solves both. |
| Backups | **Turso point-in-time restore + a nightly SQL dump to R2** | No DB file to replicate when the DB is not local. |
| Tests | **`node:test` + `node:assert`** (built in) + the browser checks in `frontend/test.html` | Zero dependencies for the thing that guards correctness. |
| CI | **GitHub Actions**: migrate, test, build, deploy | One file. |

**Total production dependencies: about eight.** That is the number to defend in
review. Every addition is a place someone else's code runs next to identity
documents (`SECURITY.md`).

---

## 2a. Building on Render's free tier

**This is a chosen constraint, and it overrides two choices made in §2.** Written
out plainly because the failure modes are not obvious and two of them would have
broken the product rather than merely slowed it.

### What the free tier takes away

| Free-tier fact | What it breaks |
| --- | --- |
| **No persistent disk.** The filesystem is ephemeral and is wiped on every deploy and every restart. | A local SQLite file and a local `uploads/` directory both **silently vanish**. The original plan assumed a volume. |
| **Spins down after ~15 minutes idle**, cold start of roughly 30–60s. | A guest opening their link after a quiet spell waits a minute at the gate. And a sleeping process runs **no scheduled jobs** — so "auto-send 1 hour before check-in" simply never fires. |
| **No cron jobs** on the free plan. | Nothing to drive the calendar poll or the timed send. |
| Render's own free Postgres **expires after a trial window**. | Not a foundation to build on. |

The second row is the serious one. A tool whose whole promise is "automatic
beats correct-if-you-remember" (`PRODUCT_PRINCIPLES.md`, 3) cannot have a
scheduler that sleeps.

### How each is handled, still free

**Database → Turso (libSQL).** SQLite-compatible, hosted, persistent, with a
free tier. Drizzle keeps the same SQLite dialect and the schema is unchanged,
so this is a driver swap rather than a redesign.

What it costs, honestly: **the in-process advantage is gone.** A query is now a
network call of roughly 10–30ms instead of microseconds. That was the headline
reason for choosing SQLite, so it has to be paid for elsewhere:

- Fewer, larger queries per request. No N+1, ever — the list endpoint is one
  query plus one aggregate, never a query per booking.
- ETags on list responses, so the common repeat load costs nothing (§5).
- The working set is tens of rows, so a single round trip returns everything a
  screen needs.

The budget in §4 moves accordingly: **list p95 ≤ 120ms** instead of 25ms, which
is still comfortably below the point where a screen feels slow.

**Files → Cloudflare R2 from day one.** 10GB free and no egress charges. Local
disk is not a "start here and migrate later" option any more, because on this
host it loses data. Streamed and encrypted exactly as planned.

**Scheduler → an external cron ping.** A free scheduler (cron-job.org, or
UptimeRobot at 5-minute resolution) POSTs to `/jobs/tick` with a shared secret
every 10 minutes. That one arrangement does three jobs at once:

1. It drives the job queue — the tick claims and runs whatever is due.
2. It keeps the service **above** the 15-minute idle threshold, so the guest at
   the gate never meets a cold start.
3. It costs nothing and is visible: a missed ping shows up as a stale
   "last synced".

`/jobs/tick` must therefore be idempotent, fast to return, and authenticated by
a secret — it is a public URL that does real work.

> **GitHub Actions is the wrong tool here**, despite being the obvious one.
> Scheduled workflows bill a **minimum of one minute per run**, so a 10-minute
> cadence is ~4,300 billable minutes a month against a 2,000-minute free
> allowance on a private repo. It only works if the repo is public. A purpose-built
> free pinger does not have this problem.

**Email → the host's own Gmail over SMTP.** Free, and the societies already
know that address. A free Gmail allows on the order of 500 recipients a day and
25MB of attachments, which is far beyond a handful of bookings with a few ID
photos. See `DECISIONS.md` for why a transactional provider is the fallback
rather than the default: none of them can send as an arbitrary `@gmail.com`.

### The honest residual risks

- **Free tiers change.** Every limit above should be re-checked against the
  provider's current page before it is relied on, not taken from this document.
- **Cold starts are mitigated, not eliminated.** A deploy, a platform restart,
  or a missed run of pings can still leave one unlucky guest waiting ~50s.
- **The first thing worth paying for** is Render's paid instance tier, which
  removes spin-down entirely. Nothing else in this stack needs money before
  that.
- **Two network hops now sit in every request** (client → Render → Turso), and
  Render's free region may not be near Turso's. **Put both in the same region**
  — this is the single highest-value configuration choice on this stack.

### What did not change

The schema, the `Derive` rules, the job-table design, the API surface and the
entire frontend are untouched. That is the payoff for having written the data
layer against an interface rather than against a database — the host changed and
the application did not.

## 3. Why each choice — and what was rejected

### Frontend: stay vanilla

Measured, not estimated — the whole prototype as it ships today:

| File | Raw | Gzipped |
| --- | --- | --- |
| `index.html` | 2.8KB | 1.1KB |
| `css/styles.css` | 23.7KB | 5.4KB |
| `js/config.js` | 3.7KB | 1.5KB |
| `js/data.js` | 13.9KB | 4.7KB |
| `js/app.js` | 32.4KB | 9.8KB |
| **Total** | **76.6KB** | **21.7KB** |

**Zero dependencies, no build step.** First paint is one HTML request, one CSS
request and three small JS requests — and `data.js` disappears from that total
when `SEED` goes, which is most of its weight.

No framework can beat that, because the thing a framework buys — a component
model and diffed updates — is not what this app is short of. It has four
screens and one hot interaction.

What the code does instead of a framework:

- **One render function per screen**, full re-render on state change. At tens of
  rows this is imperceptible, and it removes an entire class of
  "the DOM and the state disagree" bugs.
- **A data layer that is already async** (`data.js`). Every screen `await`s its
  data, so pointing it at the server changes one file.
- **Derived state, computed in one place** (`Derive` in `data.js`). Status,
  adult count and night count are never stored, so they can never be stale.
- **Append, don't re-render, when paging.** "Show more" inserts the new cards
  and leaves the existing DOM alone.

**Rejected: React / Next.js.** ~45KB of framework before a line of app code, a
build step, and a toolchain to keep current — to render four screens. Next.js in
particular would add a server-rendering model this app has no use for, since
every screen is behind a passcode and none of it is public or indexable.

**Rejected: a full SPA rewrite in Svelte or Solid.** Both are genuinely small
and fast, and both would be a reasonable choice for a *new* app of this kind.
They are not worth a rewrite of something that already renders in one frame.

**The documented trigger to reconsider:** when `app.js` passes roughly 1,500
lines, or when two screens need the same stateful widget, adopt **Preact +
htm** (~4KB, no build step required) and migrate screen by screen. Not before.
It is in `ROADMAP.md` Phase 5 for that reason.

### Backend: Node + Fastify

One language across the whole stack, for one maintainer who is also the host.
That is worth more here than any per-request benchmark: the `Derive` rules can
eventually be **the same file** on both sides, which is the only real guarantee
that the client and server agree about what "ready" means.

Fastify over Express because it validates and serialises from JSON Schema.
That is not a micro-optimisation — it means every endpoint has a declared
contract, unknown fields are rejected rather than ignored
(`CODING_STANDARDS.md`), and the response serialiser is generated rather than
reflective. Express would need three middleware packages to reach the same place.

**Rejected: Python + FastAPI.** Excellent framework; wrong for this repo. It
would mean two languages, two dependency managers, and two implementations of
every derived rule.

**Rejected: Go.** Genuinely the fastest and leanest option, and a single static
binary is a lovely deploy story. Rejected because the maintainer writes
JavaScript, this workload is nowhere near needing Go's performance, and the
extra CRUD verbosity would be paid on every feature forever.

### Database: SQLite semantics, not Postgres

> Revised by §2a: the engine is **Turso (libSQL)** rather than a local SQLite
> file, because Render's free tier has no persistent disk. The argument below is
> why SQLite *semantics* are right for this workload, and it still holds. What
> no longer holds is the in-process latency claim.

This is the choice most likely to be questioned, so here is the whole argument.

A Postgres query from an app server costs **a network round trip plus connection
pool overhead — realistically 1–3ms** even on the same host. A `better-sqlite3`
query against a page already in the OS cache costs **microseconds**, because it
is a function call into a library holding an mmap'd file. For an endpoint that
runs five queries, that is the difference between ~10ms and well under 1ms of
database time.

At this data volume Postgres buys nothing in exchange:

- Concurrent writers? There is **one** writer. WAL mode lets readers run
  uninterrupted alongside it.
- Size? The whole database will be **megabytes**, and comfortably cached in RAM.
- Durability? Turso handles replication and point-in-time restore; a nightly
  SQL dump to R2 is the second copy.
- Complex queries? The hardest query in this system is "bookings by check-in
  with a status derivation", which is one indexed scan.

And it removes a service to run, monitor, patch, connection-pool and back up.
For a single-host tool, that operational surface *is* the cost.

**The documented triggers to move to Postgres** — write them down now so the
move is a decision and not a panic:

1. More than one app instance needs to write (horizontal scale, or multi-region).
2. The tool becomes genuinely multi-tenant with concurrent hosts writing.
3. The database exceeds a few tens of GB, or a single write transaction starts
   blocking reads for a perceptible time.
4. A feature needs something SQLite does not have.

Drizzle is chosen partly *because* it makes that migration a change of driver
and dialect rather than a rewrite.

**Reversed: Drizzle ORM** (2026-09-19, during Phase 1b). It was chosen for
"SQL you can read, types you can trust" — but this codebase is plain
JavaScript, so there are no types to trust, and the benefit collapsed to a query
builder over ten tables whose hot path is a single `SELECT`.

What replaced it: parameterised SQL in `src/db/`, one dependency
(`@libsql/client`) for the entire data layer, and a ~40-line migrator over
numbered `.sql` files. The schema is now readable as SQL by anyone — including
an assistant asked to change it later — rather than as a DSL. Every hot query
carries an `EXPLAIN QUERY PLAN` assertion in the test suite, which is a stronger
guarantee about performance than a query builder would have given.

The migration path to Postgres is unaffected: the SQL is confined to one folder
and is close to standard. **If this ever moves to TypeScript, revisit** — with
real types, Drizzle earns its place.

**Rejected: Prisma.** Ships a Rust query engine binary, a generate step, and a
heavy client. Directly against "lightweight".

**Rejected: Supabase / Firebase / PlanetScale.** Each replaces one small
dependency with a platform: a network hop on every query, a vendor-shaped data
model, and someone else's uptime in the path between a guest at a gate and a
security desk. Firebase additionally pushes the data model toward documents,
which is wrong for something this relational (booking → listing → society).

**Rejected: "just use Postgres, you'll need it later."** This is the reflex
answer and it is worth naming. If the triggers above fire, the move is a week of
work on a schema that was designed for it. Paying for it now, permanently, to
avoid a week later is a bad trade.

### Background work: no queue

Two jobs exist: poll each calendar, and send at the right moment. Plus
retention deletes.

The design: **a `jobs` table and one in-process loop.** A worker claims a job in
a transaction (`UPDATE ... WHERE id = ? AND claimed_at IS NULL`), does the work,
records the outcome. SQLite's transaction is the lock. Crashes are survivable
because an unclaimed or expired job is simply picked up on the next tick.

This gives what a queue gives — durability, retries, at-most-once sends,
visibility — with no Redis, no second process and no new failure mode.

**Rejected: BullMQ / Redis.** A whole extra service, plus its own persistence
story, to schedule a few dozen jobs a day.

**Rejected: system `cron`.** Not durable, not visible in the app, and cannot
record why a send failed in the activity log.

**The at-most-once send rule matters more than throughput.** A double-send
means a security desk receives someone's passport twice and the host looks
careless. So the `bookings.sent_at` write and the job's completion happen in
**one transaction**, and the send is guarded by a unique constraint on
(booking, kind). That guarantee is much easier to get right inside a single
SQLite transaction than across a network queue — which is a real argument for
this design, not just a simplicity one.

### Files, email, hosting

**Files:** local disk first, because it is one line and the volume is tiny.
S3-compatible (Cloudflare R2) once hosted, because R2 charges nothing for
egress, and IDs get read by the mail sender. Encrypted with AES-256-GCM, key
from the environment, streamed to storage rather than buffered — a 5MB upload
must never become 5MB of heap. Images are resized and EXIF-stripped on the way
in (a photo of a passport carries GPS), which also keeps the email under
provider attachment limits.

**Email:** the host's own Gmail over SMTP, with an app password.

This began as "Resend, with SMTP as a fallback" and was **reversed** once the
requirement became clear: the host already has an email thread with each
society's desk, and mail arriving from a different sender is worse on both
deliverability and human grounds. A transactional provider cannot send as an
arbitrary `@gmail.com` — they require a verified domain — so the provider is now
the fallback, for a host with no such address.

The cost is one stored credential, which is otherwise something this system
avoids. `SECURITY.md` sets the rules around it.

**Hosting:** Render's free web service, as chosen. §2a is the full account of
what that costs and how each cost is covered. The short version: a long-lived
process is still the right shape — this is a container that sleeps, not a
function that scales to zero — but its filesystem cannot be trusted and its
sleep has to be prevented.

**Function-style serverless remains rejected**, and the reasons survive the
move: the scheduler needs a process that exists between requests, and a
per-invocation cold start lands exactly on the guest standing at the gate.

---

## 4. Performance budgets

Numbers to hold, not aspirations. Anything that breaks one of these is a bug.

| Budget | Target | Why that number |
| --- | --- | --- |
| JS shipped | **≤ 35KB gzipped** | Currently 16KB across three files. The budget is the room to grow into. |
| CSS shipped | **≤ 12KB gzipped** | Currently 5.4KB. |
| Guest page interactive | **< 1.2s on mid-range Android over 4G** | They are standing at a gate. |
| Admin first paint | **< 1.0s** on a warm cache | Feels instant rather than loaded. |
| Cumulative layout shift | **0** | Fixed-height error slots and reserved space; nothing may jump. |
| API p95, list endpoint | **< 120ms** end to end | One indexed query plus one aggregate, over a network hop to Turso (§2a). |
| API p95, detail endpoint | **< 90ms** end to end | Point lookups, one round trip. |
| Queries per request | **≤ 3** | The hop is now the cost. N+1 is a blocking review finding. |
| Upload, 5MB over 4G | **< 6s, streamed** | Bounded by the network, not by us. |
| Memory, steady state | **< 256MB RSS** | Half of Render's 512MB free instance. Measured: ~172MB at realistic size, ~189MB at 100x. (Originally written as 150MB without measuring; the baseline alone exceeds that.) |
| Cold start after deploy | **< 1s to first request served** | |
| Guest page, warm service | **no cold start, ever** | The cron ping keeps the instance above the idle threshold (§2a). |

Measured in CI on every change, with the JS/CSS budgets failing the build.

---

## 5. Staying fast as the data grows

This is the part of the request that deserves the most precision, because
"handles a lot of data" is usually answered with the wrong tools. In order of
how much each actually buys:

**1. The retention rule bounds the working set.** A booking leaves the admin
list 24 hours after checkout. However many bookings exist in total, the list
query returns tens of rows. This is worth more than every other item on this
list combined, and it is free — it is already the product's behaviour. The
engineering job is simply never to build a screen that needs the unbounded set.

**2. Load narrow, then load the page.** *(Corrected after the load test — the
original text here claimed keyset pagination made cost flat. The code did not
do that: it loaded every visible booking and every guest on each request and
cut a page out in JavaScript, and page 2 cost exactly what page 1 did.)*

What it does now, in two round trips at any size: one narrow row per visible
booking (dates, flags, two counts) so `Derive` can decide visibility, status and
order without the rule being copied into SQL; then full names and guests for
**only** the 25 on the page. Measured at 100x data: list p95 45ms → 22ms,
page 2 40ms → 16ms, and memory growth from ~225MB to ~15MB.

The narrow scan still reads every *visible* booking, so its cost is linear in
upcoming bookings — tolerable because retention bounds that set (point 1). A
pure-SQL keyset query would need the status rule in SQL; that trigger is a host
with thousands of upcoming bookings, not a realistic one. The original sketch,
kept for reference:

```sql
SELECT ... FROM bookings
WHERE (check_in, id) > (:cursor_check_in, :cursor_id)
ORDER BY check_in, id
LIMIT :limit;
```

**3. Indexes that cover the hot queries.** These are the ones built, and each
has an `EXPLAIN QUERY PLAN` assertion in `backend/test/db.test.js` — asserting
both that an index is used *and* that no `TEMP B-TREE` sort appears.

```sql
CREATE INDEX bookings_list      ON bookings (check_out, check_in, id);  -- retention filter
CREATE INDEX bookings_chrono    ON bookings (check_in, id);             -- ORDER BY + keyset cursor
CREATE INDEX bookings_listing   ON bookings (listing_id, check_in, id); -- the listing filter
CREATE INDEX bookings_uid       ON bookings (ical_uid);                 -- sync fallback key
-- airbnb_code and guest_links.token get automatic unique indexes
CREATE INDEX people_booking     ON people (booking_id);
CREATE UNIQUE INDEX documents_person ON documents (person_id);          -- one ID per adult
CREATE INDEX activity_booking   ON activity (booking_id, at DESC);
CREATE INDEX jobs_due           ON jobs (run_after, claimed_at, completed_at);
```

`bookings_chrono` was added as migration 002 after `EXPLAIN` showed the original
index could not serve both the `check_out` range filter and `ORDER BY check_in`
— a range scan on a leading column leaves the second column unordered, so SQLite
was sorting in memory. Cost-free at this volume, but the keyset cursor needs a
genuinely ordered index to stay flat as pages deepen. A claim like "one indexed
scan" is worth checking with `EXPLAIN` rather than asserting.

Note what is *not* there: the list never joins `documents`. It needs a count per
booking, which comes from a cheap aggregate over `people`, not from touching the
heavy table.

**4. Status is computed in SQL, filtered server-side.** The client never
downloads bookings in order to decide which to show. This keeps the JSON small,
which matters far more on 4G than server time does.

**5. Conditional GETs.** Built. Each list response carries an `ETag` derived
from the row count, the newest change, the page parameters and the host's
times — so an edit, a deletion, a different page *and* a settings change all
move it. A revisit sends `If-None-Match` and gets a 304 with an empty body.
Verified: `304` with `size_download: 0`.

The row count matters as much as the timestamp. An ETag built only from
`max(updated_at)` does not change when a row is deleted, which would hide a
booking dropping off the list behind a stale cache.

**6. SSE, not polling, for live updates.** One long-lived
`text/event-stream` connection pushes "booking changed" events. Polling every
10s with 50 bookings open costs 8,640 requests a day per device to discover
almost nothing; SSE costs one connection and a few bytes per actual change.
WebSockets are not needed because the traffic is one-directional.

**7. Row-level DOM updates on the hot path.** An ID upload replaces one row, not
the screen. Paging appends. The full re-render stays for screen changes, where
it is both cheap and safest.

**8. Streamed uploads and a bounded body limit.** Files go to disk or object
storage as they arrive. Memory use does not scale with upload size or
concurrency.

**9. Virtualised list — deliberately deferred.** Windowing a list only pays
above roughly 200 visible rows. Retention means that will not happen. Written
down here so nobody builds it speculatively; the trigger is a real host with a
real list that long.

---

## 6. Robustness: what happens when each thing fails

Being fast is easy to demo. Being robust is what actually matters at a gate.
Every dependency gets a defined failure behaviour.

| Failure | Behaviour |
| --- | --- |
| Airbnb iCal unreachable | Keep the last good data. Surface "last synced" going stale. Never delete a booking because a feed hiccuped. |
| iCal returns contradictory dates | Mark the booking a **sync conflict** and keep both facts. Never silently pick one. |
| Mail provider down or rejecting | The job retries with backoff, stays visible in the activity log, and the host sees a send that has not completed. Never a silent success. |
| Mail attachment too large | Compress and retry once, then surface it. Never send the email without the IDs. |
| Object storage unreachable | Uploads fail loudly and the guest is told to retry. Never record an ID as received when the bytes are not stored. |
| Process crashes mid-send | Unclaimed jobs are re-picked on restart; the unique constraint on (booking, send) prevents a double-send. |
| Disk full | Refuse uploads with a clear error and alert. Never a truncated file with a database row saying it is fine. |
| Clock skew / DST | All timestamps stored UTC; date-only values parsed as local days (already fixed in `data.js`); retention computed from the stored date, not from a cached offset. |
| Guest token brute-forced | 128 bits of entropy makes it infeasible; rate-limit per IP regardless. |
| Passcode brute-forced | Attempt lockout, mandatory before any public deployment (`SECURITY.md`). |

The through-line: **degrade visibly, never silently** — principle 9 in
`PRODUCT_PRINCIPLES.md`. An automatic tool has to be loud when it fails, or the
host learns about it from a guest at a gate.

---

## 7. Cost

| Item | Free tier | Monthly |
| --- | --- | --- |
| Render web service | 750 instance-hours; sleeps when idle | €0 |
| Turso (libSQL) | enough storage and reads for orders of magnitude more than this | €0 |
| Cloudflare R2 | 10GB, zero egress | €0 |
| Email (the host's existing Gmail) | ~500 recipients/day | €0 |
| External cron ping | free scheduler | €0 |
| Domain (optional — Render gives a subdomain) | — | ~€1 amortised |
| **Total** | | **€0** |

**The first upgrade worth buying**, if and when it matters, is Render's paid
instance tier to remove spin-down. That is one line item, not a re-architecture
— which is the point of keeping the pieces swappable.

---

## 8. Build order

Detail lives in `ROADMAP.md`; this is the shape and what each phase de-risks.

| Phase | Delivers | De-risks |
| --- | --- | --- |
| **1** Foundations | Fastify skeleton, schema + migrations, passcode auth with lockout, societies and listings CRUD, frontend Settings wired to real endpoints | That the chosen stack is actually pleasant to work in, before anything depends on it |
| **2** Calendar sync | iCal fetch and parse, upsert by booking code, conflict detection, "last synced", manual sync | The messiest external input, against real feeds |
| **3** Guest upload | Signed tokens, token-scoped endpoints, streamed encrypted uploads, expiry | The part that touches personal data |
| **4** Email + automation | Template fill, attachments, provider send, the scheduler, at-most-once guarantees, activity log | The irreversible action |
| **5** Hardening | Retention deletes, audit log, SSE live updates, budgets enforced in CI, load test at 100× current data | The claims made in this document |

**Phase 1 wires the existing Settings screens to real endpoints before anything
else.** It is the smallest end-to-end slice — one screen, real auth, real
persistence — and it proves the whole path works while the cost of being wrong
about the stack is still one day's work.

---

## 9. What would change these choices

Written down so revisiting is a decision, not drift:

- **Multiple hosts as real tenants** → Postgres, per-tenant row-level security,
  and a rethink of the shared-passcode access model.
- **`app.js` past ~1,500 lines, or shared stateful widgets** → Preact + htm,
  migrated screen by screen.
- **Official Airbnb API access granted** → drop iCal parsing, get real guest
  names and headcounts, and the guest's adults stepper becomes a confirmation
  rather than the source of truth.
- **Attachment limits or deliverability problems** → host the IDs behind
  short-lived signed links and send links instead of attachments. This is a
  privacy trade-off and needs a decision in `DECISIONS.md`, not a quiet change.
- **More than one app instance** → Postgres, and the scheduler moves out of the
  web process.

## Related documents

- `DECISIONS.md` — the product decisions this stack serves.
- `ARCHITECTURE.md` — how the pieces fit together.
- `SECURITY.md` — the rules that constrain storage, tokens and email.
- `TESTING.md` — how the guarantees above get verified.
- `ROADMAP.md` — the phase-by-phase task list.

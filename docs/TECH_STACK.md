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
| Database | **SQLite, WAL mode, via `better-sqlite3`** | In-process. Queries cost microseconds, not milliseconds — there is no network hop to make. |
| Query layer | **Drizzle ORM** | SQL you can read, types you can trust, no query engine binary. |
| Migrations | **Plain numbered `.sql` files** | Forward-only, reviewable, no tool to learn. |
| Background work | **In-process scheduler + a `jobs` table** | Durable and restartable without Redis or a second service. |
| File storage | **Local disk → S3-compatible (Cloudflare R2)** | Encrypted at rest; R2 has no egress fees. |
| Email | **Resend** (Postmark as the fallback) | Attachment support, good deliverability, a small API. |
| Hosting | **One small VPS (Hetzner CX22 or Fly.io), persistent volume** | SQLite needs a filesystem; jobs need a live process. |
| Backups | **Litestream → object storage** | Continuous replication of the SQLite file. Point-in-time recovery, no DB server. |
| Tests | **`node:test` + `node:assert`** (built in) + the browser checks in `frontend/test.html` | Zero dependencies for the thing that guards correctness. |
| CI | **GitHub Actions**: migrate, test, build, deploy | One file. |

**Total production dependencies: about eight.** That is the number to defend in
review. Every addition is a place someone else's code runs next to identity
documents (`SECURITY.md`).

---

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

### Database: SQLite, not Postgres

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
- Durability? Litestream streams the WAL to object storage continuously.
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

**Email:** Resend. Attachments, a small API, good deliverability, generous free
tier. Postmark is the fallback if transactional deliverability to Indian society
mailboxes proves poor — worth measuring rather than assuming. SMTP stays
supported because some societies will want mail from the host's own domain.

**Hosting:** one small VPS with a persistent volume. **Serverless is rejected
outright**, and for concrete reasons, not taste: SQLite needs a durable
filesystem; the scheduler needs a long-lived process; and a cold start of
200–800ms lands exactly on the guest standing at the gate. A €4/month VM with
2GB of RAM serves this workload with room for orders of magnitude more, and it
is one `ssh` to debug.

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
| API p95, list endpoint | **< 25ms server time** | One indexed query with a bounded result. |
| API p95, detail endpoint | **< 15ms server time** | Point lookups. |
| Upload, 5MB over 4G | **< 6s, streamed** | Bounded by the network, not by us. |
| Memory, steady state | **< 150MB RSS** | Fits the smallest useful VM. |
| Cold start after deploy | **< 1s to first request served** | |

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

**2. Keyset pagination, never `OFFSET`.** `OFFSET 10000` makes the database
walk 10,000 rows it will discard. Paging on `(check_in, id)` with an index
costs the same at page 1,000 as at page 1. The data layer already works this
way, so the UI will not have to change:

```sql
SELECT ... FROM bookings
WHERE (check_in, id) > (:cursor_check_in, :cursor_id)
ORDER BY check_in, id
LIMIT :limit;
```

**3. Indexes that cover the list query.** The only hot query is the list.

```sql
CREATE INDEX bookings_list      ON bookings (check_out, check_in, id);  -- retention + order
CREATE INDEX bookings_listing   ON bookings (listing_id, check_in, id); -- the filter
CREATE UNIQUE INDEX bookings_code ON bookings (airbnb_code);            -- sync upsert
CREATE INDEX people_booking     ON people (booking_id);
CREATE INDEX documents_person   ON documents (person_id);
CREATE UNIQUE INDEX guest_links_token ON guest_links (token);           -- guest lookup
CREATE INDEX activity_booking   ON activity (booking_id, at DESC);
CREATE INDEX jobs_due           ON jobs (run_after, claimed_at);        -- scheduler tick
```

Note what is *not* there: the list never joins `documents`. It needs a count per
booking, which comes from a cheap aggregate over `people`, not from touching the
heavy table.

**4. Status is computed in SQL, filtered server-side.** The client never
downloads bookings in order to decide which to show. This keeps the JSON small,
which matters far more on 4G than server time does.

**5. Conditional GETs.** Each list response carries an `ETag` derived from the
newest `updated_at` in the result. A revisit sends `If-None-Match` and usually
gets a 304 with an empty body. The common case — the host reopening the tab —
becomes nearly free.

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

| Item | Monthly |
| --- | --- |
| VPS (2GB, Hetzner CX22 class) | ~€4 |
| Object storage (R2, a few GB, no egress fees) | < €1 |
| Email (Resend free tier covers this volume) | €0 |
| Domain | ~€1 amortised |
| **Total** | **well under €10** |

Serverless plus a hosted Postgres plus a managed queue would be several times
this, for a workload that does not need any of them.

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

# Security

GatePass holds government identity documents — Aadhaar cards, passports,
driving licences — belonging to people who are not its users and who uploaded
them under time pressure at a gate. That single fact sets the bar for everything
here.

Read this before touching uploads, storage, tokens, email, logging, or
retention.

## Current status — read first

The prototype has **no security properties at all**, by construction:

- The passcode is compared in client-side JavaScript. Anyone can read it or skip
  it from the console.
- The "guest link" is `#u/<booking-id>` — guessable, unsigned, never expiring in
  any enforceable way.
- No file is ever uploaded, so nothing is stored and nothing is encrypted.
- There is no server, so there is no boundary to enforce anything at.

This is acceptable **only** while the app runs locally over mock data. The
controls below are requirements for the real system, not descriptions of it.
Nothing in this repository should be exposed on a public URL until Phase 1 and
Phase 3 land.

## What we protect, and from whom

| Asset | Sensitivity | Worst case |
| --- | --- | --- |
| ID document files | Highest. Government identity. | Identity theft for a person who never chose to use this tool. |
| Guest names, dates, headcount | Moderate, plus location. | Reveals who is staying where and when. |
| Society desk emails | Low. | Spam to a security desk. |
| Admin passcode | High — it is the only admin control. | Full access to every document in the system. |
| Guest tokens | High per booking. | Access to one booking's documents. |
| Activity log | Moderate. | Destroys the record proving IDs were sent. |

Realistic adversaries, in rough order of likelihood:

1. **An opportunist with a URL.** Guesses or stumbles onto a guest link, or
   tries `0000` on the admin screen.
2. **A curious guest.** Holds a legitimate token and tries to reach another
   booking by changing an id.
3. **A crawler.** Indexes anything reachable without auth.
4. **A misconfiguration.** An open upload directory, a bucket left public, a
   `.env` committed, an ID attached to the wrong society's email.

Explicitly **not** in the threat model at this scale: a determined targeted
attacker, a hostile insider among the trusted admins (they share one passcode by
design), or side-channel attacks. Those become relevant if this ever becomes
multi-tenant, which is not the plan.

## Controls

### Admin access

- One shared 4-digit passcode for the whole admin side. This is a deliberate
  product decision (`DECISIONS.md`), not an oversight — accounts would make the
  tool worse than WhatsApp and it would go unused.
- **Store a hash, never the passcode.** Use a slow password hash (bcrypt,
  scrypt, or argon2) with per-install salt. Not SHA-256, not plain text.
- **Attempt lockout is mandatory before any public deployment.** A 4-digit code
  is 10,000 possibilities; without a lockout it falls in seconds. Count failures
  and lock for an increasing interval (`admin_auth.failed_attempts`,
  `locked_until` in the planned schema). Rate-limit by IP as well.
- Default `0000` on a fresh install, so a host is never locked out on first use.
  The UI must push visibly toward changing it, and the default must never survive
  a real deployment.
- Compare in constant time. Never return a different error for "wrong passcode"
  versus "no passcode set".
- Sessions: HTTP-only, `Secure`, `SameSite=Lax` cookies. A session is not a
  bearer token in `localStorage`.

### Guest links

The guest link is the entire guest access control, so it has to be strong.

- **At least 128 bits of entropy** from a CSPRNG, base64url-encoded. Never a
  booking id, never a counter, never a hash of anything predictable.
- **Sign it** so an invalid token is rejected without a database lookup.
- **Look up the booking by the token row.** Every guest endpoint derives its
  booking from the token and ignores any id in the path or body. This is the one
  bug in this system most likely to leak one person's passport to another.
- **Expire at checkout + 24h**, enforced server-side on every request. The
  client's opinion about expiry is irrelevant. Past the window, return the
  "link not active" state — not a 404 that leaks whether the booking existed.
- One token per booking. Regenerating invalidates the old one.
- `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` on every guest
  response, so the token does not travel in a referrer header or reach an index.
- Tokens are never logged, never in an error message, never in analytics.

### ID documents

- **Validate on upload**: allow-list content types (JPEG, PNG, PDF), cap the
  size, and verify the actual bytes rather than trusting the extension or the
  client's `Content-Type`.
- **Never serve from a guessable path.** Store under a random `file_ref` and
  serve through an authenticated endpoint that checks the session. No directory
  listing, ever. `uploads/` is in `.gitignore` — keep it there.
- **Encrypt at rest** (`FILE_ENCRYPTION_KEY` in `.env.example`). The key comes
  from the environment and never from the repository.
- **Admins read; guests write.** A guest can upload for their own booking and
  cannot read back anyone's document, including their own. There is no reason
  for a guest to download an ID from us.
- Strip EXIF on images. A photo of a passport carries GPS.
- **Delete on schedule** (`ID_FILE_DELETE_DAYS`). Deleting the file is separate
  from, and earlier than, deleting the booking record — the record is the proof
  that the IDs were sent, the file is the liability.

### Email

The send is the moment personal data leaves our control, and it cannot be
recalled.

- **The society is resolved through the listing, never guessed.** A misrouted
  send is the worst plausible bug in this system. Test it (`TESTING.md`).
- Re-resolve the desk address at send time from the society row. Never from a
  cached copy on the booking.
- The template is host-authored and is **data, not code**. Fill placeholders by
  substitution only. Never `eval` it, never let it reach a shell, and escape it
  if it is ever rendered as HTML.
- Provider credentials from env. Verify TLS to the provider.
- Record every send — recipients, booking, timestamp, attachment count — in
  `activity`. A resend is a separate row.

### Retention

Two schedules, deliberately different:

| What | When | Why |
| --- | --- | --- |
| Booking leaves the admin list | checkout + 24h | Keeps the list about what is ahead. |
| Guest link stops working | checkout + 24h | Closes the guest surface. |
| ID files deleted | scheduled, 30 days proposed | Minimise what we hold. |
| Booking + send log kept | 30–90 days, **open** | Proof the IDs reached security. |

Hiding is not deleting. The exact windows are open decisions in `DECISIONS.md`
and must be settled before Phase 5.

### Logging

Never log: ID file contents or paths, guest tokens, passcodes or their hashes,
full guest names alongside document types.

Do log: booking ids, event types, outcomes, timestamps, and admin actions for
accountability.

## Practices

- **Never commit a secret.** `.env` and `*.db` are gitignored. `.env.example`
  carries keys and comments, never values. If a secret is committed, rotate it —
  removing the commit is not enough.
- **Dependencies are the supply chain.** Every one is a place someone else's code
  runs next to identity documents. That is the real reason the zero-dependency
  frontend matters, and why a new dependency needs a written decision.
- **Security headers** on every response once a server exists: HSTS, `nosniff`,
  a restrictive CSP, `Referrer-Policy: no-referrer`.
- **HTTPS only** in any deployment. A guest token in a URL over plain HTTP is a
  token handed to the network.

## If something goes wrong

If you believe documents have been exposed, a token has leaked, or an email went
to the wrong society: treat it as a **P0** and follow `TRIAGE.md`. In outline —
revoke first (rotate tokens, rotate the passcode, take the surface down), then
determine scope from the activity log, then fix, then write it up. Guest data
exposure is one of the few cases where taking the tool offline is the right first
move.

**Reporting a vulnerability:** this is a private single-host project with no
public disclosure process. Contact the maintainer directly and do not open a
public issue containing details.

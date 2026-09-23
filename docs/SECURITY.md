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
- **Store a hash, never the passcode.** Built: `scrypt` from `node:crypto`
  (N=2^16, r=8, 16-byte random salt, 32-byte key), encoded as
  `scrypt$N$r$p$salt$hash` so the cost can be raised later without invalidating
  existing hashes. A successful unlock silently re-hashes anything stored under
  weaker parameters.

  **Be clear about what the hash buys.** A 4-digit passcode is 10,000
  possibilities. At ~150ms per guess the whole keyspace falls in under half an
  hour, and raising the cost tenfold only buys hours. The KDF means a leaked
  database is not *instantly* a leaked passcode and that the code is not
  readable by anyone glancing at the table. It is not what makes the passcode
  safe. The only thing that would is a longer passcode, and that is deliberately
  not taken — a short shared code is what makes the tool usable for the host.
- **Attempt lockout is the control that actually protects the passcode**, and it
  is built. After `AUTH_MAX_ATTEMPTS` failures the account locks for
  `AUTH_LOCKOUT_SECONDS`; **past that threshold every single wrong attempt locks
  again**, and the duration doubles every `maxAttempts` failures, capped at an
  hour so a host is never locked out permanently. So an attacker gets one guess
  per lock window. A locked attempt short-circuits before doing any scrypt work,
  so it cannot be used to load the CPU. Still to do: **rate-limit by IP** at the
  HTTP layer.
- **Uniform failures.** A wrong passcode, an unconfigured system and a missing
  admin row all return the same shape and comparable timing, so nothing reveals
  whether a passcode is even set. A test asserts the response keys match.
- Default `0000` on a fresh install, so a host is never locked out on first use.
  `npm run migrate` hashes it properly from the very first run — there is no
  placeholder or plaintext state to forget about — and prints a warning if
  `NODE_ENV=production` while the code is still the default. The UI must push
  visibly toward changing it.
- Compare in constant time: `crypto.timingSafeEqual`, with the length checked
  first because `timingSafeEqual` throws on a mismatch, which would itself be a
  signal.
- A corrupt, empty or non-scrypt value in `passcode_hash` **fails closed**.
  `authStatus()` reports it as unconfigured so the server can refuse to serve
  rather than accept anything.
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

- **Validate on upload.** Built. The size is capped *while reading*, so a
  hostile upload cannot exhaust memory. The type is decided by the **bytes** —
  the filename and the client's `Content-Type` are hints from an untrusted
  source and are ignored.
- **Never serve from a guessable path.** Store under a random `file_ref` and
  serve through an authenticated endpoint that checks the session. No directory
  listing, ever. `uploads/` is in `.gitignore` — keep it there.
- **Encrypt at rest.** Built: AES-256-GCM, a fresh random IV per file (reusing
  one with GCM is catastrophic, not merely weak), stored as
  `[IV][auth tag][ciphertext]`. Authenticated, so altered bytes fail to decrypt
  rather than returning something subtly different. The key is 32 bytes from
  `FILE_ENCRYPTION_KEY`, and **production refuses to boot without it**.
- **Bytes are stored before the row is written**, and a refused row deletes its
  blob. The other order would leave a `documents` row pointing at bytes that
  were never written — which reads as "ID collected" when none was, and sends
  with a missing attachment.
- **Admins read; guests write.** A guest can upload for their own booking and
  cannot read back anyone's document, including their own. There is no reason
  for a guest to download an ID from us.
- **Strip EXIF.** Built, in two places. The browser re-encodes the photo
  through a canvas before sending, which removes all metadata *and* shrinks a
  12-megapixel photo to a few hundred KB — so the GPS never leaves the device.
  The server strips JPEG APP1/APP2/COM segments again, because a raw POST can
  bypass the browser. Verified end to end with a JPEG carrying GPS coordinates:
  gone from what is stored and from what is read back.
- **Never serve a document from a guessable path.** Built: an opaque random
  ref, and reading one back is admin-only behind the session. A guest can put an
  ID in and replace it, but can never download one — not even their own. There
  is no reason to hand a document back to the person who already has it.
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
- **The Gmail app password is the one long-lived credential in this system.**
  Env only, never in the database, never logged, never echoed into an error.
  Rotating it is one env change, and revoking it in the Google account disturbs
  nothing else. It requires 2-Step Verification on that account.
- **Scope discipline.** The SMTP connection sends the security email for a
  booking and nothing else: no mailbox reads, no other mail, never a mail to a
  guest. That account carries the host's real correspondence with the societies,
  so a bug that sent something unexpected from it would be a reputational
  problem, not merely a technical one.
- Verify TLS to the SMTP server (port 587, STARTTLS).
- Record every send — recipients, booking, timestamp, attachment count — in
  `activity`. A resend is a separate row.

### Retention

Two schedules, deliberately different:

**One instant, checkout + 24h, for everything:**

| What | When |
| --- | --- |
| Booking leaves the admin list | checkout + 24h |
| Guest link stops working | checkout + 24h |
| ID files deleted | checkout + 24h |
| Booking record, people and activity log deleted | checkout + 24h |

**Nothing is retained.** This is the strongest possible privacy posture and it
was chosen deliberately over keeping a record as proof of sending
(`DECISIONS.md`, "Retention"). The accepted cost is that after that moment
there is nothing to show a society that disputes receipt.

Because the retention job is now the only thing standing between us and holding
identity documents indefinitely, **it is the single most important job to get
right**: it must run even if the process has been asleep, it must be idempotent,
and a failure must be loud.

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

## Before pushing to a remote

The repository is public-ready by design: it contains no credentials, no real
addresses and no personal data. Keeping it that way needs two habits.

**Run this before a push.** It is the check that was run on 2026-09-19 and
found the repo clean:

```bash
# 1. Nothing credential-shaped
git ls-files -co --exclude-standard | grep -v package-lock | while read -r f; do
  [ -f "$f" ] && grep -nHiE '(api[_-]?key|secret|token|password)[" ]*[:=][" ]*[A-Za-z0-9/_+=-]{12,}|-----BEGIN|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9]{20,}' "$f"
done

# 2. Every email address is reserved-for-documentation
git ls-files -co --exclude-standard | grep -v package-lock | while read -r f; do
  [ -f "$f" ] && grep -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$f"
done | sort -u

# 3. The files that must never be committed, are not
for f in backend/.env .env.production backend/data/gatepass.db; do
  git check-ignore -q "$f" && echo "ignored  $f" || echo "EXPOSED  $f"
done
```

**Use reserved domains in every fixture and seed.** RFC 2606 reserves
`.example`, `.test`, `.invalid` and `example.com`. Seed data originally used
`greenwoodsociety.in` and `hillcrestcoorg.in`, which do not resolve today but
could be registered by anyone tomorrow — and a dev database still holding seed
data, once SMTP is configured, would email a stranger someone's ID. Everything
is now `.example`.

**`.env.example` is the only env file that may be committed**, and only because
it holds keys and comments with no values. `.gitignore` covers `.env`, `.env.*`,
`*.pem`, `*.key`, `backend/data/` and `*.db*`. Verified by `git check-ignore`,
not by reading the file.

**If a secret is ever committed, rotate it.** Removing the commit is not enough —
assume anything pushed is public forever. For the Gmail app password that means
revoking it in the Google account, which costs nothing else.

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


## Sign-in and per-host isolation (2026-09-23)

- **Identity is Google's.** The app never sees a password and asks only for
  `openid email profile`. It cannot read anyone's mail, calendar or files. An
  ID token whose email is unverified is refused.
- **The session cookie** (HttpOnly, SameSite=Lax, signed) carries the user, the
  account and the role. The role is still re-read from the memberships table on
  each request, so the cookie cannot grant access that has been taken away.
- **Isolation is in SQL, not in the handlers.** Every listing, society,
  booking, document, activity row and setting is reached through
  `account_id`, and an id from another account returns 404 rather than 403 — a
  403 would confirm it exists. `test/accounts.test.js` holds this line.
- **Each host's Gmail app password** is AES-256-GCM encrypted with
  `FILE_ENCRYPTION_KEY`, never returned by any endpoint, and never logged. The
  database alone does not let anyone send mail as a host. Revoking the app
  password in Google ends it immediately.
- **No invitation emails.** A co-host is invited by address and matched when
  they sign in, so the tool never mails anyone except security desks.

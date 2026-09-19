# Coding standards

How to write code in this repository. These describe the conventions already in
the prototype, plus the rules the backend inherits. Where a rule exists because
of a specific hazard, the hazard is named.

## General

- **Match the surrounding code.** Its comment density, naming, and idiom are the
  standard, even where your own habits differ.
- **Small and boring beats clever.** This codebase is read by its single
  maintainer months after it was written.
- **No new dependency without a line in `DECISIONS.md`.** The frontend has zero
  runtime dependencies. That is a feature; spend it deliberately.
- **Comments explain why.** The code says what. `app.js` uses this well:
  `// Society holds its own security helpdesk + template.` Do not narrate
  syntax.
- **Delete rather than comment out.** Git has the old version.

## Frontend (vanilla JS)

### Three files, one boundary

| File | Holds | Never holds |
| --- | --- | --- |
| `shared/rules.js` | **The rules**, imported by the browser *and* the server: status precedence, retention windows, calendar maths, `sendDue`, template placeholders and filling. Pure — no DOM, no database, no `node:` imports. | Anything runtime-specific. |
| `frontend/js/config.js` | Presentation knobs: copy, timings, page size, document types. | Rules, or anything a host would edit. |
| `frontend/js/data.js` | Where data comes from: the async `Data` API and `SEED`. | Markup, DOM, or a second copy of a rule. |
| `frontend/js/app.js` | Rendering and behaviour. | Data, tunables, or any literal value. |

**A rule goes in `shared/rules.js` or it does not exist.** If the server will
ever need to agree with the browser about it — a status, a retention window,
whether a send is due — it belongs there, imported by both. A second
implementation of `status` is the bug that makes the UI say "ready" while the
server says "awaiting" and no email is ever sent. It is a blocking review
finding.

**The test for where something goes:** would the host change it? Then it is
data. Would we change it in a release? Then it is config. Is it neither, and you
are about to type it into `app.js`? Then it is probably a bug — status, adult
count and night count all look like fields and are actually `Derive` functions.

Every `Data` function is `async`, including the ones that need not be. That is
not ceremony: it means swapping `SEED` for `fetch` touches one file and no
screen. Keep new ones async too.

### File organisation

`app.js` is one module, sectioned by banner comment:

```js
// ---------- data model ----------
// ---------- helpers ----------
// ---------- state ----------
// ---------- list ----------
// ---------- detail ----------
// ---------- actions ----------
// ---------- guest preview ----------
// ---------- settings ----------
// ---------- toast ----------
// ---------- admin lock ----------
// ---------- guest page (mobile) ----------
// ---------- boot ----------
```

Put new code in the section it belongs to. Do not append to the end of the file,
and do not add a section for one function.

`styles.css` is ordered the same way — tokens, reset, shell, then screen by
screen. Keep rules next to their siblings.

### Naming

- `camelCase` functions and variables; `SCREAMING_CASE` module constants
  (`MONTHS`, `ADMIN_PASSCODE_DEFAULT`).
- `render*` builds and mounts a screen (`renderList`, `renderDetail`).
- `*HTML` returns a string and mounts nothing (`cardHTML`).
- `do*` performs an action and re-renders (`doUpload`, `doSend`).
- `fmt*` formats for display (`fmtCal`, `fmtLong`).
- Short names for the domain objects that appear on nearly every line — `b` for
  booking, `p` for person, `soc()` for a booking's society. This is established
  and consistent; keep it rather than half-renaming.

### Rendering

**One pattern, no exceptions:**

```js
function renderThing(){
  main.innerHTML = `...`;          // build the markup
  main.querySelectorAll("[data-x]")// then bind to the fresh nodes
      .forEach(n => n.onclick = ...);
}
```

- Mutate state, then call `render()`. Never hand-patch one node and re-render
  elsewhere — that is how the two diverge.
- Bind handlers by `data-*` attribute, not by tag position or nth-child.
- `view` is the only screen state. Do not stash state on DOM nodes.

### Escaping — non-negotiable

Everything here is built from template literals assigned to `innerHTML`. Guest
names, listing names, society names, and email templates are all
user-controlled.

**Every interpolated string that a user can influence goes through `esc()`.**

```js
`<div class="nm">${esc(p.name)}</div>`     // correct
`<div class="nm">${p.name}</div>`          // an XSS hole
```

Numbers and internal enum values (`b.auto`, a status key) do not need it.
`esc()` handles `& < >`; it does **not** escape quotes, so never interpolate
user data into an unquoted or single-quoted attribute value. If you need user
data in an attribute, use a double-quoted attribute and escape it, or set it as
a property after mounting.

Reviewers: a raw `${` next to a user field is a blocking finding
(`REVIEW.md`).

### Derived state

Compute; do not store. Status, ID counts, and a booking's society all have
exactly one implementation:

```js
function statusOf(b){ ... }   // the only place status is decided
function soc(b){ return societies[listings[b.listing].society]; }
```

If you need the same value in a second place, call the function. Never add a
`status` field, and never copy a desk email onto a booking.

### Things to avoid

- No `var`. `const` by default, `let` only when reassigned.
- No `==`. Use `===`.
- No hardcoded colours, radii, or shadows in CSS — use the tokens (`DESIGN.md`).
- No inline `style="..."` for anything reusable; add a class.
- No hand-rolled month or weekday tables, and no manual date arithmetic on
  strings. Use the `Intl` formatters in `app.js` and `parseDay` from `data.js` —
  `new Date("2026-09-20")` parses as **UTC** midnight and reads as the 19th
  anywhere west of UTC.
- No `setTimeout` to wait for a render. The render is synchronous.
- No `alert`, `confirm`, or `prompt`. Use the modal and the toast.
- No `console.log` in committed code.
- No framework, and no build step, until `ROADMAP.md` Phase 5 says so.

## Backend (when it exists)

Not yet written. These rules apply from the first commit.

- **One place per rule.** The status derivation, the retention window, and the
  template fill live in exactly one module each. Do not reimplement `statusOf`
  in a query.
- **Validate at the boundary.** Every request body is parsed and validated
  before it reaches business logic. Reject unknown fields rather than ignoring
  them.
- **Scope guest requests by the token, never by the request.** A guest endpoint
  derives its booking id from the token row. An id in the body or path is
  ignored. Getting this wrong exposes one guest's documents to another.
- **Never interpolate SQL.** Parameterised queries or an ORM, always.
- **All config from env, nothing secret in code.** Add new keys to
  `.env.example` with a comment, and never a real value.
- **Never log personal data.** No ID file contents, no file paths, no guest
  tokens, no passcodes — not even at debug level. Log ids and outcomes.
- **Errors are values at the boundary.** A failed send writes an activity row
  and surfaces a state the admin can act on; it does not vanish into a stack
  trace. See `PRODUCT_PRINCIPLES.md`, 9.
- **Every write that a human would ask about writes an `activity` row.** Sends,
  passcode changes, deletions, uploads.
- **Migrations are files, checked in, forward-only.** No hand-edited schemas.

## Commits

- One logical change per commit. Present-tense imperative subject under ~70
  characters: `Add attempt lockout to passcode unlock`.
- Body explains *why*, wrapped at 72 columns, when the subject is not
  self-evident.
- If the change affects a decision, update `DECISIONS.md` in the **same** commit.
  If it lands a roadmap item, tick it in `ROADMAP.md` in the same commit.
- Branch per piece of work: `backend/auth`, `frontend/guest-upload`,
  `docs/security`.

See `PROJECT.md` for the full workflow and `REVIEW.md` for what a reviewer
checks.

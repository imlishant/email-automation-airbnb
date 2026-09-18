# Review

What a reviewer looks for here, and what blocks a merge. This project has one
maintainer, so "review" often means reviewing your own branch before merging, or
reviewing an agent's work. The checklist matters more when nobody else is
watching.

## For the author, before requesting review

- [ ] Read your own diff, start to finish, as though someone else wrote it.
- [ ] One logical change. If the description needs the word "also", split it.
- [ ] You ran the flows you touched, in a browser, and can say what you saw
      (`TESTING.md`).
- [ ] No debug output, no commented-out code, no stray file.
- [ ] `DECISIONS.md` updated if the change touches a decision; `ROADMAP.md`
      ticked if the change lands an item; `CHANGELOG.md` updated if it is
      user-visible.
- [ ] No new dependency — or a written decision explaining it.

## Pull request description

Short, and in this shape:

```
What changed, in one or two sentences.

Why — the problem, or the decision or roadmap item this serves.

How it was verified — the flows you ran and what you observed.
Anything left out, and why.
```

Link the `DECISIONS.md` section or `ROADMAP.md` item. If the change contradicts
a recorded decision, say so explicitly in the description rather than letting the
reviewer find it.

## Blocking findings

Merge does not happen while any of these stand.

### Security and privacy
- An interpolated user-controlled string reaching `innerHTML` without `esc()`,
  or user data in an unquoted or single-quoted attribute.
- A guest endpoint that resolves its booking from the request rather than from
  the token row.
- A token, passcode, ID file path, or document content in a log, an error
  message, or a URL.
- An ID document reachable without an admin session, or from a guessable path.
- A secret, a real desk email, or a real ID file in the diff.
- A new dependency in the path that handles documents, without a decision.

### Correctness
- A misroute risk: anything that could send to a society other than the one
  resolved through the booking's listing.
- A second implementation of a derived rule — a stored `status`, a copied desk
  email, a duplicated retention window.
- A double-send, or an automation that can fire twice.
- An error swallowed silently instead of surfaced as an actionable state
  (`PRODUCT_PRINCIPLES.md`, 9).
- Data discarded to resolve a conflict rather than the conflict being surfaced.

### Product
- A new tap in the guest flow without a stated reason.
- Any capability added to the guest page beyond ID upload.
- Automation replaced by, or gated behind, a button the host must remember.
- Scope beyond the one job, without a decision recorded first.

### Craft
- A hardcoded colour, radius, or shadow instead of a token.
- A `var`, a `==`, an `alert`/`confirm`/`prompt`.
- A framework or a build step, ahead of Phase 5.
- Code appended to the end of `app.js` instead of its section.

## Non-blocking comments

Say so when a comment is a suggestion. Naming preferences, alternative
structures, and "consider this later" belong in the conversation, not in the
merge gate. Prefix them — `nit:` or `optional:` — so the author can tell the
difference at a glance.

## How to review

1. **Read the description first.** If you cannot tell what problem this solves,
   that is the first comment.
2. **Check it against the decisions.** Most defects in this project are not
   broken code; they are code that quietly contradicts something already
   settled. Open `DECISIONS.md`.
3. **Follow the personal data.** For anything touching uploads, tokens, email,
   or retention, trace the path a document takes and satisfy yourself about each
   hop. This is the part of the review that cannot be skipped.
4. **Then read the code** for correctness and clarity.
5. **Run it.** For anything user-facing, open it in a browser rather than
   reasoning from the diff.

## Reviewing agent-written changes

Same bar, plus:

- **Verify the claims.** If the description says something was tested, check
  that a test exists or that the manual steps were actually run. Do not accept
  "verified" on the basis of a confident summary.
- **Check for invented surface.** Agents readily add a helper, a config flag, or
  a screen that nobody asked for. Extra scope is a finding.
- **Check the docs were updated, not fabricated.** A plausible-sounding line in
  `DECISIONS.md` that records a decision nobody made is worse than no line.
- **Re-read the escaping and the token scoping yourself.** These two are where a
  confident-looking change does real harm.

## Reviewer's tone

Say what is wrong and why it matters, name the rule or the document, and offer
the fix when you have it. Review the change, not the person. If you and the
author disagree on a matter of taste, the author decides; if you disagree about a
decision, it goes in `DECISIONS.md` and the discussion happens there.

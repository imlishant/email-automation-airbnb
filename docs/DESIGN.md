# Design

The visual and interaction system as it exists in
[frontend/css/styles.css](../frontend/css/styles.css). This documents what is
built, so that new screens match it rather than inventing a second style.

## Intent

The tool handles someone's passport photo and talks to a security desk. It
should feel **calm, warm, and administrative** — closer to well-made stationery
than to a SaaS dashboard. Paper tones rather than grey-blue, a serif for
headings, generous line-height, one accent colour, no gradients, no illustration,
no marketing voice.

Two audiences, two postures:

- **Admin** — desktop-first, a sidebar and a wide column. Scanning many
  bookings.
- **Guest** — mobile-first, one centred card, one action. Doing one thing once,
  probably standing up.

## Tokens

Every colour, radius, and shadow is a CSS variable on `:root`. **Never write a
hex value in a rule.** If you need a colour that is not here, add a token.

### Colour

| Token | Role |
| --- | --- |
| `--paper` | Page background. The warm base the whole thing sits on. |
| `--surface`, `--surface-2` | Cards; recessed panels and hover fills. |
| `--ink`, `--muted`, `--faint` | Primary text; secondary text; labels and timestamps. |
| `--line`, `--line-strong` | Hairlines; borders that need to be noticed. |
| `--accent`, `--accent-soft`, `--accent-ink` | Deep green. Primary actions, the active nav item, the "ready" state. |
| `--amber`, `--amber-soft` | Awaiting — waiting on a human, not an error. |
| `--green`, `--green-soft` | Done — sent, uploaded. |
| `--red`, `--red-soft` | Conflict and errors. Also the calendar month label. |
| `--wa` | WhatsApp share button only. Never for anything else. |

### Everything else

`--radius` (14px, cards) · `--radius-sm` (10px, rows and inputs) · `--shadow`
(a tight 1px lift plus a wide soft drop). Buttons use 9px, the modal 18px, the
guest card 20px — larger surfaces get larger radii.

### Theming

Three blocks, in this order, and all three must stay in sync:

1. `:root` — light values, plus `color-scheme: light`.
2. `@media (prefers-color-scheme: dark)` scoped to `:root:not([data-theme="light"])`
   — follows the OS unless overridden.
3. `:root[data-theme="dark"]` — explicit override.

`color-scheme` is declared in each block so native controls, form fields, and
scrollbars follow the theme rather than staying light.

**The control** is three states — Light / Match system / Dark. "Match system"
removes `data-theme` and stores nothing; the other two set `data-theme` on
`<html>` and write `localStorage["gatepass.theme"]`. A four-line script in
`<head>` re-applies the stored value **before first paint**, so there is no
flash of the wrong theme. `themePref()` wraps every storage read in a
`try`/`catch`, because `localStorage` throws in a private window and comes back
empty with site data blocked. One function, `themeTogHTML()`, is the only source
of the control's markup; the sidebar, the lock screen, and the guest page all
mount it through `mountTheme()`.

**A `<button>` does not inherit `color`.** A booking card is a button, and
before the global `button{color:inherit}` rule its text fell back to the
browser's default button colour — which is near-black, on a near-black card.
Any new element that is a `button`, `input`, `textarea`, or `select` must get
its colour from a token or from `inherit`, never from the UA default.

Dark mode is not inverted: the paper warmth is kept (`#171614`, not black), the
accent lightens so it stays legible on dark, and the soft state fills gain alpha
so they read as tints rather than blocks.

## Typography

Two families, loaded from Google Fonts in `index.html`:

- **Fraunces** (500/600), serif — the brand mark, `h1`, `h2` in modals, the
  guest and lock headings. Headings only, with negative letter-spacing
  (`-.01em` to `-.015em`).
- **Plus Jakarta Sans** (400–700) — everything else. Body is 15px/1.5.

The scale is deliberately narrow and uses half-pixels for small text:
30px `h1` · 24px guest heading · 20px brand and modal heading · 15.5px card
title · 15px body · 14.5px row name · 13.5px secondary · 13px meta · 12.5px
pills, labels, timestamps · 12px hints.

Weights do the work: 600 for anything a user scans for (names, section headings,
buttons, pills), 500 for supporting text, 400 for prose.

## Layout

```
.app                     grid: 236px sidebar | minmax(0, 1fr) content
  .side                  sticky, full height, flex column; nav at top, host at bottom
  .main                  max-width 1000px, centred, gutters clamp(18px, 3vw, 40px)
```

The content column uses `minmax(0, 1fr)` rather than `1fr`, so a wide child
cannot push the grid past the viewport.

Breakpoints, widest first:

| Width | What changes |
| --- | --- |
| — | `.main` centres itself and its gutters shrink with the viewport. |
| ≤1000px | The rail narrows to 200px, so the content column keeps its width on a tablet. |
| ≤900px | The sync line's `·` separators go; the line wraps by then. |
| ≤760px | The rail becomes a **sticky top bar**: row layout, nav buttons back to `width: auto`, safe-area padding at the top, and the appearance control pushed to the right. |
| ≤620px | Booking cards wrap: calendar tile and body on one row, status and ID count on a second. The chevron goes. The page head stacks and the filter goes full width. |
| ≤560px | Nav labels and the host chip go, so the top bar stays one row. ID-row actions wrap onto their own line. |
| ≤480px | The activity log's timestamp column narrows. |
| ≤360px | The guest card's padding tightens. |
| ≤340px | The brand wordmark goes; the mark stays. |
| `pointer: coarse` | Buttons, nav items, tabs, and the guest stepper grow so every target clears ~40px. |

Long values that arrive from outside — desk emails, society names, templates —
carry `overflow-wrap: anywhere` and their flex parents carry `min-width: 0`.
Without both, one long address widens the whole page.

The settings tab strip scrolls horizontally on its own (`overflow-x: auto`)
below roughly 390px rather than widening the page.

The guest page (`.gpage`) ignores all of this. It is `position: fixed` over
everything, scrollable, with one centred `.gcard` at `max-width: 460px`, padded
for the safe area top and bottom.

## Components

**Booking card** (`.bk`) — a button, not a div, because the whole card is the
target. Left: a calendar tile (`.cal`, red month over a bold day). Middle: guest
name, listing, and a metadata row. Right: status pill and ID count. Hover lifts
it 1px and strengthens the border.

**Status pill** (`.pill`) — a dot and a label in a soft fill: `.awaiting` amber,
`.ready` accent, `.sent` green, `.conflict` red. **The dot is not decoration** —
it is what keeps the four states distinguishable without relying on colour. Never
ship a pill without one.

**Buttons** (`.btn`) — one bordered default on `--surface`; `.primary` filled
with the accent; `.wa` for WhatsApp only; `.sm` and `.lg` for size. A disabled
primary goes flat grey with `cursor: not-allowed` — used for Send while IDs are
missing, so the lock is visible rather than mysterious.

**ID row** (`.idrow`) — avatar with initials, name plus a `.tag` for the lead
guest, a status line that turns green and bold when done, and right-aligned
actions.

**Mail preview** (`.mail`) — labelled To/Cc/Subject rows over a
`white-space: pre-wrap` body, with attachments as `.chip`s. It shows the real
filled template, because the host's trust in the automation depends on seeing
exactly what the desk will get.

**Automation radios** (`.radio`) — full-width cards with a custom ring, a title,
and a one-line description of consequence. Selected state is accent border plus
accent-soft fill. `role="radio"`, `tabindex="0"`, `aria-checked`.

**Activity log** (`.log`) — a timestamp in a fixed 96px column, then the event.
Same data as the audit trail; newest first.

**Toast** (`.toast`) — ink-on-paper pill, bottom centre, tick icon, 2.2s. For
confirmations only. It is not an error channel: errors belong in place, next to
the thing that failed.

**Lock screen** (`.lock`) — full-screen, centred, 330px. Mark, heading, one
line of explanation, the passcode input, a fixed-height error slot
(`.lockerr`, `height: 18px`) so the layout does not jump when an error appears.

**Guest card** (`.gcard`) — the whole guest experience. Brand, heading, stay
dates, one `.grow` per adult with a big tap target, and a `.gdone` confirmation
block when every ID is in. Nothing else — no nav, no send, no settings.

## Interaction rules

- **Full re-render.** Mutate state, call `render()`. Never patch the DOM by hand
  in one place and re-render in another.
- **Optimistic and immediate.** Every action updates state, writes an activity
  entry, and toasts. When the backend lands, keep the optimism but reconcile on
  failure and surface the failure in place.
- **Motion is minimal.** 0.15s on colour and border, 0.1s on transform, 0.25s on
  the toast. The only continuous animation is the 2.4s pulse on the "live" sync
  dot. All of it is disabled under `prefers-reduced-motion` by a global rule —
  do not add an animation that escapes it.
- **No modal for anything destructive-by-mistake.** The modal is for focused
  input (editing a template, changing a passcode), not for confirmations.

## Copy

- Sentence case everywhere. No title case, no ALL CAPS except the calendar
  month.
- Say what will happen, not what the feature is called: "Sends 1 hour before
  check-in even if IDs are missing" beats "Scheduled dispatch".
- Name the actor in the log: "Priya uploaded Aadhaar", not "Document received".
- Never say "error occurred". Say what failed and what to do.
- No exclamation marks. This tool is handling someone's passport.

## Accessibility

Current state, honestly: the app is keyboard-reachable because it is built from
real `<button>` elements, the radio group carries `role`/`aria-checked`, focus
rings are left at the browser default, and `prefers-reduced-motion` is honoured.
Status is never colour-only — the pill's dot and its text label carry it. The
appearance control is a `role="group"` of icon buttons, each with a `title`, an
`aria-label`, and `aria-pressed`. Both themes can be chosen explicitly, so a
reader who needs one is not at the mercy of the OS setting.

Known gaps to close, not yet done: the full re-render moves focus to the top of
the page with no focus management or live-region announcement, so a screen
reader user gets no confirmation of an action; the toast is not a live region;
contrast has not been formally measured in either theme. Treat these as real
work, not as polish.

## Adding to the system

1. Use existing tokens. A new colour needs a token in all three theme blocks.
2. Reuse `.btn`, `.pill`, `.card`, `.idrow`, `.section` before writing a class.
3. Put the rule in the section of `styles.css` it belongs to, next to its
   siblings — the file is ordered by screen, not alphabetically.
4. Check it at 360px, 760px, and wide, in both themes.
5. If it is on the guest page, count the taps first (`PRODUCT_PRINCIPLES.md`, 2).
6. Confirm the page still does not scroll sideways. The quickest check is that
   `document.documentElement.scrollWidth` equals `window.innerWidth` at 320px.

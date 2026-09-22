# Frontend

Working prototype. Plain HTML, CSS and JS — no build step, no framework.

- `index.html` — shell markup, the two font links, and the pre-paint theme script
- `css/styles.css` — all styles, themed with CSS variables (light/dark aware)
- `js/config.js` — presentation knobs: copy, timings, page size, document types
- `../shared/rules.js` — **the rules**, imported by the server too: status
  precedence, retention, calendar maths, `sendDue`, template filling. One
  implementation, so the UI and the server cannot disagree
- `js/data.js` — the data boundary: every call to the API lives here, and
  nothing else in the frontend knows the server exists
- `js/app.js` — rendering and behaviour. No data, no tunables, no literals
- `test.html` — runnable checks. Open it; the title shows the score

## Run

Serve from the **repo root**, not this folder — `js/app.js` imports
`../../shared/rules.js`.

```bash
cd ..
python3 -m http.server 5173
# http://localhost:5173/
```

`file://` does not work any more: the page is an ES module and browsers block
module imports from the filesystem.

## Notes

- All mock data lives in `SEED` in `data.js`, and nowhere else. There is no
  server yet.
- Every `Data` function is already `async` and shaped like the planned API, so
  connecting the backend means replacing those function bodies with `fetch` and
  deleting `SEED` — no screen changes. See `../docs/TECH_STACK.md`.
- Admin passcode starts at 0000 (Settings → Admin access to change).
- Guest page: open a booking → "Open the guest link" (or paste the copied
  link). That is the same link a real guest gets, and it shows only that
  booking.
- Appearance: Light / Match system / Dark, in the sidebar, on the lock screen,
  and on the guest page. Stored in `localStorage["gatepass.theme"]` and
  re-applied by a small script in `index.html`'s `<head>` before first paint.
- Before committing, open `test.html` and confirm every line reads PASS.
- If the single `app.js` grows large, that is the signal to move to a framework.
  Not needed yet.

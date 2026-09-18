# Frontend

Working prototype. Plain HTML, CSS and JS — no build step, no framework.

- `index.html` — markup and the two font links
- `css/styles.css` — all styles, themed with CSS variables (light/dark aware)
- `js/app.js` — all behaviour and the mock data

## Run

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 5173
# http://localhost:5173
```

## Notes

- All data is mock data inside `app.js`. There is no server yet.
- Admin passcode starts at 0000 (Settings → Admin access to change).
- Guest page: open a booking → "Preview guest page". A real guest reaches it by
  the booking's own link and sees only that booking.
- When the backend exists, replace the mock data and the `toast()`-only actions
  with real API calls (see ../backend/README.md for the endpoints).
- If the single `app.js` grows large, that is the signal to move to a framework.
  Not needed yet.

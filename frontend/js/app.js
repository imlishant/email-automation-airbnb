// ---------------------------------------------------------------------------
// Rendering and behaviour. No data and no tunables live here: values come from
// Data (data.js) and knobs from CONFIG (config.js). Every screen awaits its
// data, so wiring the real API is a change in data.js alone.
// ---------------------------------------------------------------------------

// ---------- formatting ----------
// Intl rather than hand-rolled month and day tables: correct in every locale
// and time zone, and free of the "JAN"/"Sun" arrays that used to live here.
const L = CONFIG.locale;
const DTF = {
  monthShort: new Intl.DateTimeFormat(L, { month: "short" }),
  dayNum: new Intl.DateTimeFormat(L, { day: "numeric" }),
  dayLong: new Intl.DateTimeFormat(L, { weekday: "short", day: "numeric", month: "short" }),
  stamp: new Intl.DateTimeFormat(L, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  relative: new Intl.RelativeTimeFormat(L, { numeric: "auto" }),
};
const fmt = {
  // Date-only values are parsed as a local day (see parseDay in data.js).
  cal: (iso) => ({ mo: DTF.monthShort.format(parseDay(iso)).toUpperCase(), dy: DTF.dayNum.format(parseDay(iso)) }),
  day: (iso) => DTF.dayLong.format(parseDay(iso)),
  stamp: (iso) => DTF.stamp.format(new Date(iso)),
  ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return DTF.relative.format(-mins, "minute");
    if (mins < 60 * 24) return DTF.relative.format(-Math.round(mins / 60), "hour");
    return DTF.relative.format(-Math.round(mins / 1440), "day");
  },
  count: (n, one, many) => `${n} ${n === 1 ? one : many}`,
};

// ---------- helpers ----------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}
function pill(status) {
  const m = CONFIG.status[status];
  return `<span class="pill ${m.cls}"><span class="dot"></span>${esc(m.label)}</span>`;
}
function docTypeSelect(personId, current) {
  return `<select class="input docsel" data-doctype="${esc(personId)}" aria-label="ID type">${
    CONFIG.documents.types.map((t) => `<option ${t === current ? "selected" : ""}>${esc(t)}</option>`).join("")
  }</select>`;
}
function stayLine(b) {
  return `Check-in <b>${esc(fmt.day(b.checkIn))}</b> · ${esc(fmt.count(Derive.nights(b), "night", "nights"))}`;
}
function partyLine(b) {
  const adults = fmt.count(Derive.adults(b), "adult", "adults");
  return b.children ? `${adults} · ${fmt.count(b.children, "child", "children")}` : adults;
}

// ---------- theme ----------
// Three states. "system" stores nothing and lets the CSS follow the OS;
// "light"/"dark" set data-theme on <html>, which both theme blocks key off.
const THEME_KEY = "gatepass.theme";
const THEMES = [
  ["light", "Light", '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>'],
  ["system", "Match system", '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>'],
  ["dark", "Dark", '<path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5 8.6 8.6 0 1 0 20.5 14.3z"/>'],
];
function themePref() {
  // localStorage can throw or come back empty (private windows, blocked storage).
  try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; }
  catch (e) { return document.documentElement.getAttribute("data-theme") || "system"; }
}
function setTheme(mode) {
  const root = document.documentElement;
  if (mode === "system") { root.removeAttribute("data-theme"); try { localStorage.removeItem(THEME_KEY); } catch (e) {} }
  else { root.setAttribute("data-theme", mode); try { localStorage.setItem(THEME_KEY, mode); } catch (e) {} }
  syncThemeControls();
}
function themeTogHTML(label) {
  const pref = themePref();
  return `${label ? '<span class="tl">Appearance</span>' : ""}<div class="themetog" role="group" aria-label="Appearance">${
    THEMES.map(([k, t, path]) => `<button data-theme-set="${k}" class="${pref === k ? "on" : ""}" title="${t}" aria-label="${t}" aria-pressed="${pref === k}"><svg viewBox="0 0 24 24">${path}</svg></button>`).join("")
  }</div>`;
}
function syncThemeControls() {
  const pref = themePref();
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    const on = btn.dataset.themeSet === pref;
    btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on));
  });
}
function mountTheme(host, label) {
  if (!host) return;
  host.innerHTML = themeTogHTML(label);
  host.querySelectorAll("[data-theme-set]").forEach((btn) => btn.onclick = (e) => { e.stopPropagation(); setTheme(btn.dataset.themeSet); });
}

// ---------- state ----------
const view = { screen: "bookings", bookingId: null, listingId: null, tab: "listings", openSoc: null };
const main = document.getElementById("main");

// Every render awaits data, so a second render can start before the first
// finishes. The sequence number makes the stale one discard its result instead
// of painting over the newer screen.
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.nav === (view.screen === "detail" ? "bookings" : view.screen)));
  try {
    if (view.screen === "bookings") await renderList(seq);
    else if (view.screen === "detail") await renderDetail(seq);
    else await renderSettings(seq);
  } catch (e) {
    if (seq === renderSeq) main.innerHTML = `<div class="card"><div class="empty">Could not load that. ${esc(e.message)}</div></div>`;
  }
  if (seq === renderSeq) window.scrollTo(0, 0);
}
const fresh = (seq) => seq === renderSeq;

// ---------- list ----------
async function renderList(seq) {
  const [page, listings] = await Promise.all([
    Data.bookings({ listingId: view.listingId }),
    Data.listings(),
  ]);
  if (!fresh(seq)) return;
  const attention = page.rows.filter(Derive.needsAttention);
  const settled = page.rows.filter((b) => !Derive.needsAttention(b));
  const retain = CONFIG.retention.hideBookingAfterCheckoutHours;

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Bookings</h1><div class="sub">${page.counts.attention} need your attention · ${page.counts.settled} ready or sent</div></div>
      <select class="filter" id="flt" aria-label="Filter by listing">
        <option value="">All listings</option>
        ${listings.map((l) => `<option value="${esc(l.id)}" ${view.listingId === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}
      </select>
    </div>
    <div class="syncline">
      <span class="live"><span class="d"></span>Auto-syncing from Airbnb</span>
      <span class="sep">·</span><span>New bookings and IDs appear on their own; past bookings drop off ${retain}h after checkout</span>
      <span class="sep">·</span><button id="syncnow">Sync now</button>
    </div>
    <div class="group-label">Needs your attention</div>
    <div id="attn">${attention.length ? attention.map(cardHTML).join("")
      : `<div class="card"><div class="empty">Nothing waiting. Every upcoming booking has its IDs in.</div></div>`}</div>
    <div class="group-label" ${settled.length ? "" : 'hidden'}>Ready &amp; sent</div>
    <div id="settled">${settled.map(cardHTML).join("")}</div>
    <div id="more">${page.nextCursor ? `<button class="btn" id="showmore" data-cursor="${esc(page.nextCursor)}">Show more bookings</button>` : ""}</div>`;

  document.getElementById("flt").onchange = (e) => { view.listingId = e.target.value || null; render(); };
  document.getElementById("syncnow").onclick = async (e) => {
    e.target.disabled = true;
    const r = await Data.sync();
    toast(r.newBookings ? `Synced — ${fmt.count(r.newBookings, "new booking", "new bookings")}` : "Checked Airbnb — no new bookings");
    render();
  };
  bindCards(main);
  bindShowMore();
}

// Appends the next page instead of re-rendering the list, so a long list stays
// cheap however many pages the host walks through.
function bindShowMore() {
  const btn = document.getElementById("showmore");
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    const page = await Data.bookings({ listingId: view.listingId, cursor: btn.dataset.cursor });
    const attn = document.getElementById("attn"), settledBox = document.getElementById("settled");
    page.rows.forEach((b) => {
      const box = Derive.needsAttention(b) ? attn : settledBox;
      box.insertAdjacentHTML("beforeend", cardHTML(b));
    });
    document.getElementById("more").innerHTML = page.nextCursor
      ? `<button class="btn" id="showmore" data-cursor="${esc(page.nextCursor)}">Show more bookings</button>` : "";
    bindCards(main); bindShowMore();
  };
}
function bindCards(root) {
  root.querySelectorAll("[data-open]").forEach((el) => el.onclick = () => {
    view.bookingId = el.dataset.open; view.screen = "detail"; render();
  });
}
function cardHTML(b) {
  const c = fmt.cal(b.checkIn), s = Derive.status(b);
  const right = s === "conflict" ? pill(s)
    : `${pill(s)}<span class="idcount"><b>${Derive.uploaded(b)}</b> of ${Derive.adults(b)} adult IDs</span>`;
  return `<button class="bk" data-open="${esc(b.id)}">
    <div class="cal"><span class="mo">${esc(c.mo)}</span><span class="dy">${esc(c.dy)}</span></div>
    <div class="body">
      <div class="top"><span class="guest">${esc(b.leadGuest)}</span><span class="listing">· ${esc(b.listingName)}</span></div>
      <div class="meta"><span>${stayLine(b)}</span><span>${esc(partyLine(b))}</span></div>
    </div>
    <div class="right">${right}</div>
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </button>`;
}

// ---------- detail ----------
async function renderDetail(seq) {
  const b = await Data.booking(view.bookingId);
  if (!fresh(seq)) return;
  const s = Derive.status(b), allIn = Derive.complete(b), society = b.society;
  const body = b.conflict
    ? `<div class="mail" style="border-color:var(--red);background:var(--red-soft)"><div class="mbody" style="color:var(--red)"><b>Sync conflict.</b> This booking's dates overlap an existing block on ${esc(b.listingName)}. Fix it on Airbnb and it will sync cleanly. ID collection is paused until then.</div></div>`
    : `
    <div class="destcard">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/></svg>
      <div><b>IDs go to ${esc(society.name)}</b><div class="d2">${esc(society.to)}${society.cc ? ` · cc ${esc(society.cc)}` : ""}</div></div>
    </div>

    <div class="share">
      <button class="btn" id="copybk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy guest upload link</button>
      <a class="btn" href="${guestLink(b)}">Open the guest link</a>
      <span style="align-self:center;color:var(--muted);font-size:12.5px">Share this with the guest — it opens only this booking, and works until ${esc(fmt.stamp(Derive.guestLinkExpiresAt(b)))}.</span>
    </div>

    <div class="section">
      <div class="sechead"><h2>Guest IDs</h2></div>
      <p class="note">One ID proof per adult. Upload for them, or let the guest upload from the link above.</p>
      ${b.people.map((p) => idRow(p)).join("")}
    </div>

    <div class="section">
      <div class="sechead"><h2>Email to security</h2></div>
      <p class="note">Uses ${esc(society.name)}'s saved template and desk. Change it in Settings → Societies.</p>
      <div class="mail">
        <div class="mrow"><span class="k">To</span><span class="v">${esc(society.to)}</span></div>
        <div class="mrow"><span class="k">Cc</span><span class="v">${esc(society.cc || "—")}</span></div>
        <div class="mbody">${esc(fillTemplate(society.template, { booking: b, listing: { name: b.listingName }, society, fmt }))}</div>
        <div class="attn">${b.people.filter((p) => p.documentType).map((p) => `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>${esc(p.name.split(" ")[0])} — ${esc(p.documentType)}</span>`).join("")
          || `<span class="idcount">No files attached yet.</span>`}</div>
      </div>
      <div class="auto">${CONFIG.automation.map((a) => radio(b, a)).join("")}</div>
      <div class="sendbar">
        <button class="btn primary lg" id="send" ${allIn ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>${b.sentAt ? "Resend now" : "Send now"}</button>
        <span class="hint">${allIn
          ? (b.sentAt ? `Sent ${esc(fmt.ago(b.sentAt))} — you can resend if needed.` : "All IDs are in. You can send now.")
          : `Waiting on ${esc(fmt.count(Derive.adults(b) - Derive.uploaded(b), "ID", "IDs"))}. Auto-send will fire on its own.`}</span>
      </div>
    </div>

    <div class="section"><div class="sechead"><h2>Activity</h2></div>
      <ul class="log">${b.activity.map((a) => `<li><span class="bud"></span><span class="t">${esc(fmt.stamp(a.at))}</span><span>${esc(a.text)}</span></li>`).join("")}</ul>
    </div>`;

  main.innerHTML = `
    <button class="back" id="back"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Bookings</button>
    <div class="d-head">
      <div><h1>${esc(b.leadGuest)}</h1>
        <div class="stay">${esc(b.listingName)} · ${stayLine(b)} → Check-out <b>${esc(fmt.day(b.checkOut))}</b> · ${esc(partyLine(b))}</div>
        <div class="bkid">Airbnb booking ${esc(b.code)}</div></div>
      ${pill(s)}
    </div>${body}`;

  document.getElementById("back").onclick = () => { view.screen = "bookings"; render(); };
  if (b.conflict) return;
  document.getElementById("copybk").onclick = () => copyText(guestLink(b), "Guest upload link copied");
  main.querySelectorAll("[data-up]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.up;
    const type = (main.querySelector(`[data-doctype="${id}"]`) || {}).value;
    await Data.addDocument(b.id, id, { type, by: "admin" });
    toast("ID uploaded");
    await maybeAutoSend(b.id);
    render();
  });
  main.querySelectorAll("[data-view-doc]").forEach((el) => el.onclick = () => toast("Opening the stored ID"));
  main.querySelectorAll("[data-auto]").forEach((el) => el.onclick = async () => {
    await Data.setAutomation(b.id, el.dataset.auto); render();
  });
  const send = document.getElementById("send");
  if (send) send.onclick = async () => { await Data.send(b.id); toast("Sent to security helpdesk"); render(); };
}
function idRow(p) {
  return `<div class="idrow">
    <div class="av">${esc(initials(p.name))}</div>
    <div class="info"><div class="nm">${esc(p.name)}${p.lead ? '<span class="tag">LEAD GUEST</span>' : ""}</div>
      <div class="st ${p.documentType ? "done" : ""}">${p.documentType ? `${esc(p.documentType)} uploaded` : "No ID uploaded yet"}</div></div>
    <div class="acts">${p.documentType
      ? `<button class="btn" data-view-doc="${esc(p.id)}"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>View</button>`
      : `${docTypeSelect(p.id, CONFIG.documents.types[0])}<button class="btn primary" data-up="${esc(p.id)}"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>Upload ID</button>`}</div>
  </div>`;
}
function radio(b, a) {
  const on = b.automation === a.value;
  return `<div class="radio ${on ? "on" : ""}" data-auto="${esc(a.value)}" role="radio" tabindex="0" aria-checked="${on}"><div class="ring"></div><div><div class="rt">${esc(a.title)}</div><div class="rd">${esc(a.describe)}</div></div></div>`;
}

// ---------- actions ----------
// The "when all IDs are collected" rule. The server owns this once it exists;
// here it stands in for the trigger so the flow can be walked end to end.
async function maybeAutoSend(bookingId) {
  const b = await Data.booking(bookingId);
  if (b.automation !== "allids" || b.sentAt || !Derive.complete(b)) return;
  await new Promise((r) => setTimeout(r, CONFIG.ui.autoSendDelayMs));
  await Data.send(bookingId, { auto: true });
  toast("All IDs in — auto-sent to security");
}

// The guest's own link. In the prototype that is the booking id in the hash;
// Phase 3 replaces it with a signed token (see docs/ROADMAP.md).
function guestLink(b) { return location.href.split("#")[0] + "#u/" + encodeURIComponent(b.id); }
function copyText(text, msg) {
  const done = () => toast(msg);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px"; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed — the link is " + text); }
  ta.remove();
}

// ---------- settings ----------
const TABS = [
  { key: "listings", label: "Listings" },
  { key: "societies", label: "Societies & templates" },
  { key: "access", label: "Admin access" },
];
async function renderSettings(seq) {
  if (!fresh(seq)) return;
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Set these once. Bookings reuse them automatically.</div></div></div>
    <div class="tabs">${TABS.map((t) => `<button class="tab ${view.tab === t.key ? "active" : ""}" data-tab="${t.key}">${esc(t.label)}</button>`).join("")}</div>
    <div id="sbody"></div>`;
  main.querySelectorAll("[data-tab]").forEach((el) => el.onclick = () => { view.tab = el.dataset.tab; render(); });
  const body = document.getElementById("sbody");
  if (view.tab === "listings") await renderSetListings(body, seq);
  else if (view.tab === "societies") await renderSetSocieties(body, seq);
  else await renderSetAccess(body, seq);
}

async function renderSetListings(body, seq) {
  const [listings, societies] = await Promise.all([Data.listings(), Data.societies()]);
  if (!fresh(seq)) return;
  const socOpts = societies.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  body.innerHTML = `
    <p class="setnote">Connect each listing once with its Airbnb calendar link (Airbnb → your listing → Availability → Connect calendars → Export). After that, bookings sync on their own.</p>
    ${listings.map((l) => `<div class="listing-row">
      <div style="flex:1"><div class="nm">${esc(l.name)}</div><div class="url">${esc(l.icalUrl)}</div><span class="socbadge">${esc(l.societyName)}</span></div>
      <span class="syncdot"><span class="d"></span>Synced ${esc(fmt.ago(l.lastSyncedAt))}</span></div>`).join("")}
    <div class="listing-row" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="nm">Connect a new listing</div>
      <div style="color:var(--muted);font-size:12.5px">Paste the calendar link first. The name fills from the calendar where possible — edit it if needed. You pick the society yourself, so it is never guessed.</div>
      <input class="input" id="newIcal" placeholder="Paste Airbnb calendar link (.ics)" inputmode="url">
      <input class="input" id="newName" placeholder="Listing name (from the calendar — editable)">
      <select class="input" id="newSoc" aria-label="Society">${socOpts}<option value="new">＋ New society…</option></select>
      <button class="btn primary" id="addListing" style="align-self:flex-start">Connect listing</button>
    </div>`;
  document.getElementById("addListing").onclick = () => {
    const url = document.getElementById("newIcal").value.trim();
    if (!url) { toast("Paste the calendar link first"); return; }
    toast("Listing connected — it will start syncing");
  };
}

async function renderSetSocieties(body, seq) {
  const [societies, listings] = await Promise.all([Data.societies(), Data.listings()]);
  if (!fresh(seq)) return;
  body.innerHTML = `
    <p class="setnote">Each society keeps its own security desk email and its own template. Listings in the same society share one; different societies each use their own.</p>
    ${societies.map((s) => socCard(s, listings.filter((l) => l.societyId === s.id).length)).join("")}
    <button class="btn" id="addSoc" style="margin-top:6px"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>Add a society</button>`;
  // esc() leaves quotes alone, so these values are set as properties, never
  // through markup (docs/CODING_STANDARDS.md).
  societies.forEach((s) => {
    const to = body.querySelector(`#to_${s.id}`), cc = body.querySelector(`#cc_${s.id}`), tpl = body.querySelector(`#tpl_${s.id}`);
    if (to) to.value = s.to || "";
    if (cc) cc.value = s.cc || "";
    if (tpl) tpl.value = s.template || "";
  });
  body.querySelectorAll("[data-sochead]").forEach((el) => el.onclick = () => {
    view.openSoc = view.openSoc === el.dataset.sochead ? null : el.dataset.sochead; render();
  });
  body.querySelectorAll("[data-savesoc]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.savesoc;
    await Data.saveSociety(id, {
      to: body.querySelector(`#to_${id}`).value.trim(),
      cc: body.querySelector(`#cc_${id}`).value.trim(),
      template: body.querySelector(`#tpl_${id}`).value,
    });
    toast("Society saved");
  });
  document.getElementById("addSoc").onclick = () => toast("Name the society, add its desk email and template");
}
function socCard(s, listingCount) {
  const open = view.openSoc === s.id;
  return `<div class="soc ${open ? "open" : ""}">
    <div class="sh" data-sochead="${esc(s.id)}"><div><div class="snm">${esc(s.name)}</div>
      <div class="smeta">${esc(s.to)} · ${esc(fmt.count(listingCount, "listing", "listings"))}</div></div>
      <svg class="caret" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>
    <div class="sbody">
      <div class="field"><label for="to_${esc(s.id)}">Send to</label><div class="desc">The society's security / gate desk.</div><input class="input" id="to_${esc(s.id)}" type="email"></div>
      <div class="field"><label for="cc_${esc(s.id)}">Cc</label><div class="desc">Manager, clubhouse, etc. Comma-separated.</div><input class="input" id="cc_${esc(s.id)}"></div>
      <div class="field"><label for="tpl_${esc(s.id)}">Email template</label>
        <div class="desc">Placeholders fill per booking: ${CONFIG.templateVars.map((v) => `<span class="var" title="${esc(v.describe)}">{{${esc(v.token)}}}</span>`).join("")}</div>
        <textarea class="input" id="tpl_${esc(s.id)}"></textarea></div>
      <button class="btn primary" data-savesoc="${esc(s.id)}">Save society</button>
    </div></div>`;
}

async function renderSetAccess(body, seq) {
  const { value } = await Data.passcode();
  if (!fresh(seq)) return;
  const len = CONFIG.auth.passcodeLength;
  body.innerHTML = `
    <p class="setnote">One ${len}-digit passcode unlocks the admin side for everyone on your team. It starts at ${esc(CONFIG.auth.firstRunPasscode)}, so you're never locked out. Any admin can change it here.</p>
    ${value ? `<div class="field"><label>Current passcode</label>
      <div class="desc">Share this only with people you trust as admins.</div>
      <div class="pincode">${esc(value)}</div></div>` : ""}
    <div class="field"><label for="newpin">Change passcode</label>
      <div class="desc">Enter a new ${len}-digit code. It takes effect right away.</div>
      <input class="input pinput" id="newpin" inputmode="numeric" maxlength="${len}" autocomplete="off" placeholder="${"•".repeat(len)}">
    </div>
    <button class="btn primary" id="savepin">Update passcode</button>`;
  const inp = document.getElementById("newpin");
  inp.oninput = () => { inp.value = inp.value.replace(/\D/g, "").slice(0, len); };
  document.getElementById("savepin").onclick = async () => {
    if (inp.value.length !== len) { toast(`Enter ${len} digits`); return; }
    await Data.setPasscode(inp.value); toast("Passcode updated"); render();
  };
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>${esc(msg)}`;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), CONFIG.ui.toastMs);
}

// ---------- admin lock ----------
let unlocked = false;
async function showLock(err) {
  clearOverlays();
  const len = CONFIG.auth.passcodeLength;
  const { value: demo } = await Data.passcode();
  const el = document.createElement("div");
  el.className = "lock"; el.id = "lockScreen";
  el.innerHTML = `<div class="lockcard">
    <div class="mk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <h2>GatePass</h2><p>Enter the admin passcode to continue.</p>
    <div class="pin ${err ? "err" : ""}" id="pin">
      ${Array.from({ length: len }, (_, i) => `<input inputmode="numeric" maxlength="1" autocomplete="off" data-i="${i}" aria-label="Digit ${i + 1}">`).join("")}
    </div>
    <div class="lockerr" role="alert">${err ? "Wrong passcode. Try again." : ""}</div>
    ${demo ? `<div class="lockhint">Demo build · current code ${esc(demo)}</div>` : ""}
  </div>
  <div class="themerow" id="lockTheme"></div>`;
  document.body.appendChild(el);
  mountTheme(el.querySelector("#lockTheme"), false);
  const inputs = [...el.querySelectorAll(".pin input")];
  inputs[0].focus();
  inputs.forEach((inp, i) => {
    inp.oninput = async () => {
      inp.value = inp.value.replace(/\D/g, "");
      if (inp.value && i < len - 1) inputs[i + 1].focus();
      if (!inputs.every((x) => x.value)) return;
      const { ok } = await Data.unlock(inputs.map((x) => x.value).join(""));
      if (ok) { unlocked = true; el.remove(); mountApp(); }
      else { el.remove(); showLock(true); }
    };
    inp.onkeydown = (e) => { if (e.key === "Backspace" && !inp.value && i > 0) inputs[i - 1].focus(); };
  });
}

// ---------- guest page (mobile) ----------
function clearOverlays() {
  ["lockScreen", "guestScreen"].forEach((id) => { const n = document.getElementById(id); if (n) n.remove(); });
}
async function showGuest(token) {
  clearOverlays();
  const b = await Data.guestBooking(token);
  const el = document.createElement("div");
  el.className = "gpage"; el.id = "guestScreen";
  const brand = `<div class="gbrand"><div class="mk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18M7 3v4M17 3v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M9 15l2 2 4-4"/></svg></div><div class="nm">GatePass check-in</div><div class="themerow" data-guest-theme></div></div>`;

  if (!b) {
    const hrs = CONFIG.retention.guestLinkAfterCheckoutHours;
    el.innerHTML = `<div class="gcard gexpired">${brand}<h2>Link not active</h2>
      <p style="color:var(--muted);font-size:13.5px">This upload link has expired or isn't valid. Guest links stay open until ${hrs} hours after checkout. Please ask your host for a fresh link.</p></div>`;
    document.body.appendChild(el);
    mountTheme(el.querySelector("[data-guest-theme]"), false);
    return;
  }

  const allIn = Derive.complete(b);
  el.innerHTML = `<div class="gcard">
    ${brand}
    <h2>Upload your ID</h2>
    <div class="gsub">${esc(b.leadGuest)} · ${esc(b.listingName)}</div>
    <div class="gdates">Check-in ${esc(fmt.day(b.checkIn))} → Check-out ${esc(fmt.day(b.checkOut))}</div>
    <div class="banner">Only your booking is shown here. Your IDs go straight to the society's security desk — you don't need an account, and nothing else is sent to you.</div>
    <div class="stepper"><div class="lab">Adults in your party</div>
      <div class="ct"><button data-adj="-1" aria-label="One fewer adult">−</button><span class="n">${Derive.adults(b)}</span><button data-adj="1" aria-label="One more adult">+</button></div></div>
    <div style="color:var(--faint);font-size:12px;margin:-4px 0 14px">Add a row for every adult, including friends or visitors joining you — each needs their own ID.</div>
    ${b.people.map((p) => `<div class="grow"><div class="av">${esc(initials(p.name))}</div>
      <div class="gi"><div class="gn">${esc(p.name)}${p.lead ? " (you)" : ""}</div>
        <div class="gs ${p.documentType ? "done" : ""}">${p.documentType ? `${esc(p.documentType)} uploaded` : "Pick the ID type, then add a photo"}</div></div>
      ${p.documentType
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M20 6L9 17l-5-5"/></svg>'
        : `${docTypeSelect(p.id, CONFIG.documents.types[0])}<button class="btn primary" data-gup="${esc(p.id)}">Add ID</button>`}
    </div>`).join("")}
    ${allIn ? `<div class="gdone"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>All set — your host has your IDs. You can close this page.</div>` : ""}
    ${unlocked ? `<button class="gback" id="gback">← Back to admin</button>` : ""}
  </div>`;
  document.body.appendChild(el);
  mountTheme(el.querySelector("[data-guest-theme]"), false);

  el.querySelectorAll("[data-gup]").forEach((x) => x.onclick = async () => {
    const id = x.dataset.gup;
    const type = (el.querySelector(`[data-doctype="${id}"]`) || {}).value;
    await Data.addDocument(b.id, id, { type, by: "guest" });
    await maybeAutoSend(b.id);
    showGuest(token);
  });
  el.querySelectorAll("[data-adj]").forEach((x) => x.onclick = async () => {
    await Data.setAdultCount(b.id, Derive.adults(b) + Number(x.dataset.adj));
    showGuest(token);
  });
  const gb = el.querySelector("#gback");
  if (gb) gb.onclick = () => { try { location.hash = ""; } catch (e) {} clearOverlays(); unlocked ? mountApp() : showLock(); };
}

// ---------- boot ----------
async function mountApp() {
  clearOverlays();
  mountTheme(document.getElementById("themerow"), true);
  const profile = await Data.profile();
  const host = document.getElementById("hostchip");
  host.innerHTML = `<div class="av">${esc(initials(profile.name))}</div>
    <div class="who"><b>${esc(profile.name)}</b><br><span>${esc(profile.role)} · ${esc(fmt.count(profile.listingCount, "listing", "listings"))}</span></div>`;
  document.querySelectorAll(".nav-btn").forEach((b) => b.onclick = () => { view.screen = b.dataset.nav; render(); });
  render();
}
const guestToken = () => {
  const h = (location.hash || "").replace("#", "");
  return h.startsWith("u/") ? decodeURIComponent(h.slice(2)) : null;
};
function boot() {
  const token = guestToken();
  if (token) { showGuest(token); return; }
  unlocked ? mountApp() : showLock();
}
window.addEventListener("hashchange", () => { const t = guestToken(); if (t) showGuest(t); });
boot();

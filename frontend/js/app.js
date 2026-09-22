// ---------------------------------------------------------------------------
// Rendering and behaviour. No data and no tunables live here: values come from
// Data (data.js) and knobs from CONFIG (config.js). Every screen awaits its
// data, so wiring the real API is a change in data.js alone.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { prepareForUpload, FileRejected } from "./upload.js";
import { Data, Derive, parseDay, fillTemplate, RULES, TEMPLATE_VARS, setUnauthorisedHandler } from "./data.js";

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
  return `<span class="pill ${status}"><span class="dot"></span>${esc(CONFIG.statusLabel[status])}</span>`;
}
/**
 * A person's name, editable in place.
 *
 * Every name in this system was typed by a human — the Airbnb feed carries
 * none — so this is the only way a real name ever arrives, and it reaches the
 * security desk. Placeholders are styled as unfinished so they get noticed.
 */
function nameField(p, editable) {
  const placeholder = Derive.isPlaceholderName(p.name);
  if (!editable) return `<span class="nm-text">${esc(p.name)}</span>`;
  return `<input class="nameinput ${placeholder ? "unnamed" : ""}" data-rename="${esc(p.id)}"
    value="" maxlength="120" autocomplete="off" spellcheck="false"
    aria-label="Name for this guest" placeholder="Add their name">`;
}

/**
 * The file picker. `capture` is deliberately absent: a guest may already have a
 * photo of their ID in their gallery, and forcing the camera would make them
 * retake it.
 */
function fileInput(personId) {
  return `<input type="file" class="filepick" data-file="${esc(personId)}"
    accept="${esc(CONFIG.documents.accept)},image/*" hidden>`;
}

/**
 * Prepare and send one file. Shared by both surfaces so a guest and an admin
 * get the same resizing, the same stripping and the same messages.
 */
async function sendDocument({ personId, file, type, token, bookingId, onDone }) {
  let prepared;
  try {
    prepared = await prepareForUpload(file, { maxBytes: CONFIG.documents.maxBytes, accept: CONFIG.documents.accept });
  } catch (e) {
    toast(e instanceof FileRejected ? e.message : "That file could not be read.");
    return;
  }
  toast("Uploading\u2026");
  const res = token
    ? await Data.guestUploadDocument(token, personId, prepared, { type })
    : await Data.uploadDocument(bookingId, personId, prepared, { type });
  toast(res.ok ? (res.replaced ? `Replaced with ${type}` : "ID uploaded") : res.message);
  onDone();
}

function docTypeSelect(personId, current) {
  return `<select class="input docsel" data-doctype="${esc(personId)}" aria-label="ID type">${
    CONFIG.documents.types.map((t) => `<option ${t === current ? "selected" : ""}>${esc(t)}</option>`).join("")
  }</select>`;
}
function stayLine(b) {
  return `Arriving <b>${esc(fmt.day(b.checkIn))}</b> · ${esc(fmt.count(Derive.nights(b), "night", "nights"))}`;
}
/** Who is coming, when we know. The feed never tells us, so this is often absent. */
function whoLine(b) {
  if (Derive.leadGuestKnown(b)) return `Lead guest ${esc(b.leadGuest)}`;
  if (b.phoneLast4) return `Guest not yet identified · phone ends ${esc(b.phoneLast4)}`;
  return "Guest not yet identified";
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
const view = { screen: "bookings", bookingId: null, listingId: null, tab: "listings", openSoc: null, editListing: null };
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
  const retain = RULES.hideBookingAfterCheckoutHours;

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
  const syncBtn = document.getElementById("syncnow");
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Checking\u2026";
    const r = await Data.sync();
    // A feed that failed is named. A cheerful "nothing new" when the calendar
    // could not be read is exactly the silent failure to avoid.
    if (r.failures?.length) toast(`${r.failures[0].name}: ${r.failures[0].message}`);
    else if (!r.ok) toast(r.message || "Could not reach Airbnb");
    else if (r.created || r.updated) toast(`Synced — ${r.created} new, ${r.updated} updated`);
    else toast("Checked Airbnb — nothing new");
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
      <div class="top"><span class="guest">${esc(Derive.title(b))}</span><span class="listing">· ${esc(b.code)}</span></div>
      <div class="meta"><span>${stayLine(b)}</span><span>${esc(partyLine(b))}</span><span>${whoLine(b)}</span></div>
    </div>
    <div class="right">${right}</div>
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </button>`;
}

// ---------- detail ----------
async function renderDetail(seq) {
  const [b, times] = await Promise.all([Data.booking(view.bookingId), Data.settings()]);
  if (!fresh(seq)) return;
  const s = Derive.status(b), allIn = Derive.complete(b), society = b.society;
  const editable = Derive.documentsEditable(b, times);
  const dest = Derive.destination(b);
  const unnamed = Derive.unnamedPeople(b);
  const staleAttachment = Derive.needsResend(b, times);
  const body = b.conflict
    ? `<div class="mail" style="border-color:var(--red);background:var(--red-soft)"><div class="mbody" style="color:var(--red)"><b>Sync conflict.</b> This booking's dates overlap an existing block on ${esc(b.listingName)}. Fix it on Airbnb and it will sync cleanly. ID collection is paused until then.</div></div>`
    : `
    <div class="destcard">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/></svg>
      <div><b>${dest.pinned ? "IDs were sent to" : "IDs go to"} ${esc(dest.societyName)}</b><div class="d2">${esc(dest.to)}${dest.cc ? ` · cc ${esc(dest.cc)}` : ""}${dest.pinned ? " · a resend goes to this same address" : ""}</div></div>
    </div>

    <div class="share">
      <button class="btn" id="copybk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy guest upload link</button>
      <a class="btn" href="${guestLink(b)}">Open the guest link</a>
      <span style="align-self:center;color:var(--muted);font-size:12.5px">Share this with the guest — it opens only this booking, and works until ${esc(fmt.stamp(Derive.guestLinkExpiresAt(b, times)))}.</span>
    </div>

    ${staleAttachment ? `<div class="warnbar">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <div><b>Resend needed.</b> An ID was changed after the email went out, so ${esc(dest.societyName)} is holding the old attachment.</div>
    </div>` : ""}

    <div class="section">
      <div class="sechead"><h2>Guest IDs</h2></div>
      ${editable ? `<div class="stepper party">
        <div><div class="lab">Adults on this booking</div>
          <div class="desc">The Airbnb calendar does not say how many, so either you or the guest sets it.</div></div>
        <div class="ct"><button data-party="-1" aria-label="One fewer adult">\u2212</button><span class="n">${Derive.adults(b)}</span><button data-party="1" aria-label="One more adult">+</button></div>
      </div>` : ""}
      ${unnamed.length ? `<p class="note nudge">${esc(fmt.count(unnamed.length, "guest", "guests"))} still unnamed. The security desk sees these names \u2014 type them in below, or the guest can from their link.</p>` : ""}
      <p class="note">One ID proof per adult. Upload for them, or let the guest upload from the link above.
        ${editable
          ? `Either of you can replace an ID until ${esc(fmt.stamp(Derive.guestLinkExpiresAt(b, times)))}.`
          : "The window for changing IDs has closed and the files have been deleted."}</p>
      ${b.people.map((p) => idRow(p, editable)).join("")}
    </div>

    <div class="section">
      <div class="sechead"><h2>Email to security</h2></div>
      <p class="note">Uses ${esc(society.name)}'s saved template and desk. Change it in Settings → Societies.</p>
      <div class="mail">
        <div class="mrow"><span class="k">To</span><span class="v">${esc(dest.to)}</span></div>
        <div class="mrow"><span class="k">Cc</span><span class="v">${esc(dest.cc || "—")}</span></div>
        <div class="mbody">${esc(fillTemplate(society.template, { ...b, societyName: society.name }, fmt.day))}</div>
        <div class="attn">${b.people.filter((p) => p.documentType).map((p) => `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>${esc(p.name.split(" ")[0])} — ${esc(p.documentType)}</span>`).join("")
          || `<span class="idcount">No files attached yet.</span>`}</div>
      </div>
      <div class="auto">${CONFIG.automation.map((a) => radio(b, a)).join("")}</div>
      <div class="sendbar">
        <button class="btn primary lg" id="send" ${allIn && (!b.sentAt || Derive.canResend(b, times)) ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>${b.sentAt ? "Resend now" : "Send now"}</button>
        <span class="hint">${staleAttachment
          ? `An ID changed after this was sent \u2014 the desk is holding the old one. Resend to fix it.`
          : allIn
          ? (b.sentAt
              ? (Derive.canResend(b, times)
                  ? `Sent ${esc(fmt.ago(b.sentAt))}. Can be resent until the ID files are deleted at ${esc(fmt.stamp(Derive.idFilesDeletedAt(b, times)))}.`
                  : `Sent ${esc(fmt.ago(b.sentAt))}. The ID files have been deleted, so this cannot be resent.`)
              : "All IDs are in. You can send now.")
          : `Waiting on ${esc(fmt.count(Derive.adults(b) - Derive.uploaded(b), "ID", "IDs"))}. Auto-send will fire on its own.`}</span>
      </div>
    </div>

    <div class="section"><div class="sechead"><h2>Activity</h2></div>
      <ul class="log">${b.activity.map((a) => `<li><span class="bud"></span><span class="t">${esc(fmt.stamp(a.at))}</span><span>${esc(a.text)}</span></li>`).join("")}</ul>
    </div>`;

  main.innerHTML = `
    <button class="back" id="back"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Bookings</button>
    <div class="d-head">
      <div><h1>${esc(Derive.title(b))}</h1>
        <div class="stay">${stayLine(b)} → Check-out <b>${esc(fmt.day(b.checkOut))}</b> · ${esc(partyLine(b))}</div>
        <div class="bkid">Airbnb booking ${esc(b.code)} · ${whoLine(b)}</div></div>
      ${pill(s)}
    </div>${body}`;

  document.getElementById("back").onclick = () => { view.screen = "bookings"; render(); };
  if (b.conflict) return;
  const copy = document.getElementById("copybk");
  if (copy) copy.onclick = () => {
    const link = guestLink(b);
    if (!link) { toast("No guest link yet"); return; }
    copyText(link, "Guest upload link copied");
  };
  main.querySelectorAll("[data-up]").forEach((el) => el.onclick = () => {
    main.querySelector(`[data-file="${el.dataset.up}"]`)?.click();
  });
  main.querySelectorAll("[data-file]").forEach((input) => input.onchange = async () => {
    const personId = input.dataset.file;
    const file = input.files?.[0];
    input.value = "";   // so choosing the same file twice still fires
    if (!file) return;
    await sendDocument({
      personId, file, bookingId: b.id,
      type: (main.querySelector(`[data-doctype="${personId}"]`) || {}).value,
      onDone: render,
    });
  });
  // Names are set as properties, never through markup: esc() leaves quotes alone.
  b.people.forEach((p) => {
    const input = main.querySelector(`[data-rename="${p.id}"]`);
    if (!input) return;
    input.value = Derive.isPlaceholderName(p.name) ? "" : p.name;
    bindRename(input, b.id, p, "admin");
  });
  main.querySelectorAll("[data-party]").forEach((el) => el.onclick = async () => {
    const res = await Data.setAdultCount(b.id, Derive.adults(b) + Number(el.dataset.party), { by: "admin" });
    if (!res.ok) { toast("That booking is past its ID window"); render(); return; }
    if (res.blocked) toast("Cannot remove an adult whose ID is already in");
    render();
  });
  main.querySelectorAll("[data-auto]").forEach((el) => el.onclick = async () => {
    await Data.setAutomation(b.id, el.dataset.auto); render();
  });
  const send = document.getElementById("send");
  if (send) send.onclick = async () => { await Data.send(b.id); toast("Sent to security helpdesk"); render(); };
}
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const UP = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>';

/**
 * @param editable whether IDs may still be changed. Past the window the files
 *   are deleted, so there is nothing to view or replace.
 */
function idRow(p, editable) {
  const has = Boolean(p.documentType);
  let acts;
  if (has && editable) {
    // Replace, not remove-then-add: a blurry photo is the common case, and the
    // type may change with it.
    acts = `${docTypeSelect(p.id, p.documentType)}<button class="btn" data-up="${esc(p.id)}">${UP}Replace</button>` +
           `<a class="btn" href="${esc(Data.documentUrl(p.documentId))}" target="_blank" rel="noopener">${EYE}View</a>` +
           fileInput(p.id);
  } else if (has) {
    acts = `<span class="idcount">File deleted on schedule</span>`;
  } else if (editable) {
    acts = `${docTypeSelect(p.id, CONFIG.documents.types[0])}<button class="btn primary" data-up="${esc(p.id)}">${UP}Upload ID</button>` + fileInput(p.id);
  } else {
    acts = `<span class="idcount">Window closed</span>`;
  }
  return `<div class="idrow">
    <div class="av">${esc(initials(p.name))}</div>
    <div class="info"><div class="nm">${nameField(p, editable)}${p.lead ? '<span class="tag">LEAD GUEST</span>' : ""}</div>
      <div class="st ${has ? "done" : ""}">${has ? `${esc(p.documentType)} uploaded` : "No ID uploaded yet"}</div></div>
    <div class="acts">${acts}</div>
  </div>`;
}
function radio(b, a) {
  const on = b.automation === a.value;
  return `<div class="radio ${on ? "on" : ""}" data-auto="${esc(a.value)}" role="radio" tabindex="0" aria-checked="${on}"><div class="ring"></div><div><div class="rt">${esc(a.title)}</div><div class="rd">${esc(a.describe)}</div></div></div>`;
}

/**
 * Save a name on blur or Enter. Not on every keystroke: that would write a
 * partial name into the activity log on the way to a complete one.
 */
function bindRename(input, bookingId, person, by, token) {
  const commit = async () => {
    const next = input.value.trim();
    const current = Derive.isPlaceholderName(person.name) ? "" : person.name;
    if (next === current) return;
    if (!next) { input.value = current; return; }   // clearing a name is not a rename
    const res = by === "guest"
      ? await Data.guestRenamePerson(token, person.id, next)
      : await Data.renamePerson(bookingId, person.id, next);
    if (!res.ok) {
      toast(res.reason === "window_closed" ? "That booking is past its ID window" : "Could not save that name");
      input.value = current;
      return;
    }
    toast("Name saved");
    by === "guest" ? showGuest(token) : render();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = Derive.isPlaceholderName(person.name) ? "" : person.name; input.blur(); }
  };
}

// ---------- actions ----------
// There is deliberately no client-side "auto-send" here any more. The scheduler
// owns that trigger (Phase 4), and a toast saying "auto-sent" when the server
// sent nothing would be exactly the false "Sent" the transport boundary exists
// to prevent.

// The server mints a signed token per booking and returns it with the detail.
// This is a full URL, not a hash fragment appended to whatever page the admin
// happens to be on, so it survives being pasted into a message.
function guestLink(b) {
  return b.guestLink ? `${location.origin}/frontend/index.html#u/${encodeURIComponent(b.guestLink.token)}` : "";
}
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
const LISTING_ERRORS = {
  no_ical_url: "Paste the Airbnb calendar link first",
  no_name: "Give the listing a name",
  no_society: "Pick the society this listing sits in",
  has_bookings: "This listing has bookings \u2014 disconnect it instead",
  not_found: "That listing no longer exists",
};

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

/**
 * One listing, read-only until Edit is pressed. Edited in place rather than in
 * a modal, so the calendar link stays visible while it is being replaced.
 */
function listingRow(l, societies) {
  const editing = view.editListing === l.id;
  const connected = Boolean(l.icalUrl);
  if (!editing) {
    return `<div class="listing-row">
      <div style="flex:1">
        <div class="nm">${esc(l.name)}</div>
        <div class="url">${connected ? esc(l.icalUrl) : "Disconnected \u2014 no calendar link, so nothing will sync"}</div>
        <span class="socbadge">${esc(l.societyName)}</span>
      </div>
      ${connected
        ? `<span class="syncdot"><span class="d"></span>Synced ${esc(fmt.ago(l.lastSyncedAt))}</span>`
        : `<span class="idcount">Not syncing</span>`}
      <button class="btn sm" data-editlst="${esc(l.id)}">Edit</button>
    </div>`;
  }
  return `<div class="listing-row" style="flex-direction:column;align-items:stretch;gap:10px">
    <div class="field"><label for="ln_${esc(l.id)}">Listing name</label>
      <input class="input" id="ln_${esc(l.id)}"></div>
    <div class="field"><label for="lu_${esc(l.id)}">Airbnb calendar link (.ics)</label>
      <div class="desc">Changing this re-syncs the listing from scratch.</div>
      <input class="input" id="lu_${esc(l.id)}" inputmode="url"></div>
    <div class="field"><label for="ls_${esc(l.id)}">Society</label>
      <div class="desc">Where this listing's guest IDs are emailed. Changing it changes the destination for every future booking on it.</div>
      <select class="input" id="ls_${esc(l.id)}">
        ${societies.map((x) => `<option value="${esc(x.id)}" ${x.id === l.societyId ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
      </select></div>
    <div class="share">
      <button class="btn primary" data-savelst="${esc(l.id)}">Save changes</button>
      <button class="btn" data-cancellst="1">Cancel</button>
      ${connected ? `<button class="btn" data-disclst="${esc(l.id)}">Disconnect</button>` : ""}
      <button class="btn danger" data-dellst="${esc(l.id)}">Delete</button>
    </div>
    <div class="desc" id="lstwarn_${esc(l.id)}"></div>
  </div>`;
}

async function renderSetListings(body, seq) {
  const [listings, societies, times] = await Promise.all([Data.listings(), Data.societies(), Data.settings()]);
  if (!fresh(seq)) return;
  const socOpts = societies.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  body.innerHTML = `
    <div class="section">
      <div class="sechead"><h2>Check-in &amp; check-out times</h2></div>
      <p class="note">The Airbnb calendar gives dates but no times. These apply to every listing, and they are
        what "1 hour before check-in" and the 24-hour retention window are measured from.</p>
      <div class="timerow">
        <div class="field"><label for="ciTime">Check-in</label><input class="input" id="ciTime" type="time" step="300"></div>
        <div class="field"><label for="coTime">Check-out</label><input class="input" id="coTime" type="time" step="300"></div>
        <button class="btn primary" id="saveTimes">Save times</button>
      </div>
    </div>
    <p class="setnote">Connect each listing once with its Airbnb calendar link (Airbnb → your listing → Availability → Connect calendars → Export). After that, bookings sync on their own.</p>
    ${listings.map((l) => listingRow(l, societies)).join("")}
    <div class="listing-row" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="nm">Connect a new listing</div>
      <div style="color:var(--muted);font-size:12.5px">Paste the calendar link first. The name fills from the calendar where possible — edit it if needed. You pick the society yourself, so it is never guessed.</div>
      <input class="input" id="newIcal" placeholder="Paste Airbnb calendar link (.ics)" inputmode="url">
      <input class="input" id="newName" placeholder="Listing name (from the calendar — editable)">
      <select class="input" id="newSoc" aria-label="Society">${socOpts}<option value="new">＋ New society…</option></select>
      <button class="btn primary" id="addListing" style="align-self:flex-start">Connect listing</button>
    </div>`;
  // --- listing edit / disconnect / delete ---------------------------------
  // Values as properties, never through markup: esc() does not escape quotes.
  for (const l of listings) {
    const n = body.querySelector(`#ln_${l.id}`), u = body.querySelector(`#lu_${l.id}`);
    if (n) n.value = l.name;
    if (u) u.value = l.icalUrl;
  }
  body.querySelectorAll("[data-editlst]").forEach((el) => el.onclick = () => {
    view.editListing = el.dataset.editlst; render();
  });
  body.querySelectorAll("[data-cancellst]").forEach((el) => el.onclick = () => {
    view.editListing = null; render();
  });
  body.querySelectorAll("[data-savelst]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.savelst;
    const res = await Data.updateListing(id, {
      name: body.querySelector(`#ln_${id}`).value,
      icalUrl: body.querySelector(`#lu_${id}`).value,
      societyId: body.querySelector(`#ls_${id}`).value,
    });
    if (!res.ok) { toast(LISTING_ERRORS[res.reason] || res.message || "Could not save that"); return; }
    view.editListing = null; toast("Listing updated"); render();
  });
  body.querySelectorAll("[data-disclst]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.disclst;
    const warn = body.querySelector(`#lstwarn_${id}`);
    // Two-step, because it stops future bookings arriving.
    if (el.dataset.confirmed !== "1") {
      el.dataset.confirmed = "1"; el.textContent = "Confirm disconnect";
      warn.textContent = "Bookings already synced stay, along with the record of what was sent to security. No new ones will arrive.";
      return;
    }
    const res = await Data.disconnectListing(id);
    if (!res.ok) { toast(res.message || "Could not disconnect that"); return; }
    view.editListing = null; toast("Listing disconnected"); render();
  });
  body.querySelectorAll("[data-dellst]").forEach((el) => el.onclick = async () => {
    const id = el.dataset.dellst;
    const warn = body.querySelector(`#lstwarn_${id}`);
    const usage = await Data.listingUsage(id);
    // Deleting cascades to bookings, people, documents and the send log.
    // Refuse while anything is there, and point at Disconnect instead.
    if (usage.total) {
      warn.innerHTML = `<b>Cannot delete.</b> This listing has ${esc(fmt.count(usage.total, "booking", "bookings"))}` +
        `${usage.sent ? `, ${usage.sent} already sent to security` : ""}. Deleting it would destroy that record. ` +
        `Use <b>Disconnect</b> to stop syncing and keep the history.`;
      return;
    }
    if (el.dataset.confirmed !== "1") {
      el.dataset.confirmed = "1"; el.textContent = "Confirm delete";
      warn.textContent = "This listing has no bookings, so deleting it loses nothing.";
      return;
    }
    const res = await Data.deleteListing(id);
    if (!res.ok) { toast(LISTING_ERRORS[res.reason] || res.message || "Could not delete that"); return; }
    view.editListing = null; toast("Listing deleted"); render();
  });

  // Time inputs are set as properties, never through markup.
  const ci = document.getElementById("ciTime"), co = document.getElementById("coTime");
  ci.value = times.checkInTime; co.value = times.checkOutTime;
  document.getElementById("saveTimes").onclick = async () => {
    if (!ci.value || !co.value) { toast("Set both times"); return; }
    await Data.saveSettings({ checkInTime: ci.value, checkOutTime: co.value });
    toast("Times saved"); render();
  };
  document.getElementById("addListing").onclick = async () => {
    const res = await Data.addListing({
      icalUrl: document.getElementById("newIcal").value,
      name: document.getElementById("newName").value,
      societyId: document.getElementById("newSoc").value,
    });
    if (!res.ok) { toast(LISTING_ERRORS[res.reason] || "Could not connect that listing"); return; }
    toast("Listing connected — it will start syncing");
    render();
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
    const res = await Data.saveSociety(id, {
      to: body.querySelector(`#to_${id}`).value.trim(),
      cc: body.querySelector(`#cc_${id}`).value.trim(),
      template: body.querySelector(`#tpl_${id}`).value,
    });
    // Only claim success on success: this is the address IDs get emailed to.
    toast(res.ok ? "Society saved" : (res.message || "That was not saved"));
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
        <div class="desc">Placeholders fill per booking: ${TEMPLATE_VARS.map((v) => `<span class="var" title="${esc(v.describe)}">{{${esc(v.token)}}}</span>`).join("")}</div>
        <textarea class="input" id="tpl_${esc(s.id)}"></textarea></div>
      <button class="btn primary" data-savesoc="${esc(s.id)}">Save society</button>
    </div></div>`;
}

async function renderSetAccess(body, seq) {
  if (!fresh(seq)) return;
  const len = CONFIG.auth.passcodeLength;
  body.innerHTML = `
    <p class="setnote">One ${len}-digit passcode unlocks the admin side for everyone on your team. It starts at ${esc(CONFIG.auth.firstRunPasscode)}, so you're never locked out. Any admin can change it here.</p>
    <p class="setnote">The passcode itself is never shown. The server stores only a
      hash and cannot read it back, so if it is forgotten, set a new one here.</p>
    <div class="field"><label for="newpin">Change passcode</label>
      <div class="desc">Enter a new ${len}-digit code. It takes effect right away.</div>
      <input class="input pinput" id="newpin" inputmode="numeric" maxlength="${len}" autocomplete="off" placeholder="${"•".repeat(len)}">
    </div>
    <button class="btn primary" id="savepin">Update passcode</button>
    <div class="section" style="margin-top:32px">
      <div class="sechead"><h2>Admin activity</h2></div>
      <p class="note">Changes to settings, passcode changes and lockouts. The passcode is shared, so
        each entry shows the address it came from rather than a person.</p>
      <ul class="log" id="auditlog"><li><span>Loading\u2026</span></li></ul>
    </div>`;
  Data.audit().then((rows) => {
    const el = document.getElementById("auditlog");
    if (!el || !fresh(seq)) return;
    el.innerHTML = rows.length
      ? rows.map((r) => `<li><span class="bud"></span><span class="t">${esc(fmt.stamp(r.at))}</span><span>${esc(r.text)}${r.ip ? ` <span class="idcount">\u00b7 ${esc(r.ip)}</span>` : ""}</span></li>`).join("")
      : "<li><span>Nothing yet.</span></li>";
  }).catch(() => {});
  const inp = document.getElementById("newpin");
  inp.oninput = () => { inp.value = inp.value.replace(/\D/g, "").slice(0, len); };
  document.getElementById("savepin").onclick = async () => {
    if (inp.value.length !== len) { toast(`Enter ${len} digits`); return; }
    const res = await Data.setPasscode(inp.value);
    if (!res.ok) { toast(res.reason || "The passcode was not changed"); return; }
    // Changing it ends this session on the server, so go back to the lock.
    toast("Passcode updated \u2014 unlock with the new one");
    unlocked = false; showLock();
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
// { admin, role, ownerTier } from the server; only it can know, since the
// session is an HttpOnly cookie.
let sessionInfo = { admin: false, role: null, ownerTier: false };
async function showLock(err) {
  clearOverlays();
  const len = CONFIG.auth.passcodeLength;
  const el = document.createElement("div");
  el.className = "lock"; el.id = "lockScreen";
  el.innerHTML = `<div class="lockcard">
    <div class="mk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <h2>GatePass</h2><p>Enter the admin passcode to continue.</p>
    <div class="pin ${err ? "err" : ""}" id="pin">
      ${Array.from({ length: len }, (_, i) => `<input inputmode="numeric" maxlength="1" autocomplete="off" data-i="${i}" aria-label="Digit ${i + 1}">`).join("")}
    </div>
    ${sessionInfo.ownerTier ? `<button class="btn sm ownerlink" id="ownerLink">Owner? Email me a sign-in link</button>` : ""}
    ${location.hash === "#owner-link-expired" ? `<div class="lockhint">That sign-in link has expired or was already used. Ask for a new one.</div>` : ""}
    <div class="lockerr" role="alert">${err ? (err.locked ? "Too many attempts. Try again shortly." : "Wrong passcode. Try again.") : ""}</div>
    ${err && err.locked
      ? `<div class="lockhint">Locked for ${Math.ceil((err.retryAfterSeconds || 60) / 60)} more minute(s).</div>`
      : err && err.attemptsRemaining !== undefined
      ? `<div class="lockhint">${err.attemptsRemaining} attempt(s) left before it locks.</div>`
      : ""}
  </div>
  <div class="themerow" id="lockTheme"></div>`;
  document.body.appendChild(el);
  mountTheme(el.querySelector("#lockTheme"), false);
  const ol = el.querySelector("#ownerLink");
  if (ol) ol.onclick = async () => {
    ol.disabled = true;
    const r = await Data.requestOwnerLink();
    toast(r.message);
    ol.textContent = r.ok ? "Link sent \u2014 check the owner's inbox" : "Owner? Email me a sign-in link";
    ol.disabled = r.ok;
  };
  const inputs = [...el.querySelectorAll(".pin input")];
  inputs[0].focus();
  inputs.forEach((inp, i) => {
    inp.oninput = async () => {
      inp.value = inp.value.replace(/\D/g, "");
      if (inp.value && i < len - 1) inputs[i + 1].focus();
      if (!inputs.every((x) => x.value)) return;
      const res = await Data.unlock(inputs.map((x) => x.value).join(""));
      if (res.ok) { unlocked = true; el.remove(); mountApp(); }
      else { el.remove(); showLock(res); }
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
    const hrs = RULES.guestLinkAfterCheckoutHours;
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
    <div style="color:var(--faint);font-size:12px;margin:-4px 0 14px">Add a row for every adult, including friends or visitors joining you — each needs their own ID.
      Put each person's name in, as the security desk needs it to match them at the gate.
      If a photo came out blurry you can replace it any time before your stay ends.
      Photos are resized and stripped of location data on your phone before they are sent.</div>
    ${b.people.map((p) => `<div class="grow"><div class="av">${esc(initials(p.name))}</div>
      <div class="gi"><div class="gn">${nameField(p, true)}</div>
        <div class="gs ${p.documentType ? "done" : ""}">${p.lead ? '<span class="you">You</span> \u00b7 ' : ""}${p.documentType ? `${esc(p.documentType)} uploaded` : "pick the ID type, then add a photo"}</div></div>
      ${p.documentType
        // No tick alongside Replace: the green "uploaded" line already says
        // it is done, and on a 360px phone the name needs the room.
        ? `${docTypeSelect(p.id, p.documentType)}<button class="btn" data-gup="${esc(p.id)}">Replace</button>${fileInput(p.id)}`
        : `${docTypeSelect(p.id, CONFIG.documents.types[0])}<button class="btn primary" data-gup="${esc(p.id)}">Add ID</button>${fileInput(p.id)}`}
    </div>`).join("")}
    ${allIn ? `<div class="gdone"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>All set — your host has your IDs. You can close this page, or replace one above if you need to.</div>` : ""}
    ${unlocked ? `<button class="gback" id="gback">← Back to admin</button>` : ""}
  </div>`;
  document.body.appendChild(el);
  mountTheme(el.querySelector("[data-guest-theme]"), false);
  listenGuest(token);

  b.people.forEach((p) => {
    const input = el.querySelector(`[data-rename="${p.id}"]`);
    if (!input) return;
    input.value = Derive.isPlaceholderName(p.name) ? "" : p.name;
    bindRename(input, b.id, p, "guest", token);
  });
  el.querySelectorAll("[data-gup]").forEach((x) => x.onclick = () => {
    el.querySelector(`[data-file="${x.dataset.gup}"]`)?.click();
  });
  el.querySelectorAll("[data-file]").forEach((input) => input.onchange = async () => {
    const personId = input.dataset.file;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    // Scoped by the token: the server resolves the booking itself and ignores
    // any id we could send.
    await sendDocument({
      personId, file, token,
      type: (el.querySelector(`[data-doctype="${personId}"]`) || {}).value,
      onDone: () => showGuest(token),
    });
  });
  el.querySelectorAll("[data-adj]").forEach((x) => x.onclick = async () => {
    const res = await Data.guestSetAdultCount(token, Derive.adults(b) + Number(x.dataset.adj));
    if (!res.ok) toast(res.message || "This link is no longer active");
    showGuest(token);
  });
  const gb = el.querySelector("#gback");
  if (gb) gb.onclick = () => { try { location.hash = ""; } catch (e) {} clearOverlays(); unlocked ? mountApp() : showLock(); };
}

// ---------- boot ----------
async function mountApp() {
  clearOverlays();
  listenAdmin();
  mountTheme(document.getElementById("themerow"), true);
  const profile = await Data.profile();
  const host = document.getElementById("hostchip");
  host.innerHTML = `<div class="av">${esc(initials(profile.name))}</div>
    <div class="who"><b>${sessionInfo.role === "owner" ? "Owner" : "Admin"}</b><br><span>${esc(fmt.count(profile.listingCount, "listing", "listings"))}</span></div>`;
  document.querySelectorAll(".nav-btn").forEach((b) => b.onclick = () => { view.screen = b.dataset.nav; render(); });
  render();
}
const guestToken = () => {
  const h = (location.hash || "").replace("#", "");
  return h.startsWith("u/") ? decodeURIComponent(h.slice(2)) : null;
};
async function boot() {
  const token = guestToken();
  if (token) { showGuest(token); return; }
  // The session lives in an HttpOnly cookie, so only the server can say whether
  // this browser holds one.
  try { sessionInfo = await Data.session(); unlocked = sessionInfo.admin; } catch { unlocked = false; }
  unlocked ? mountApp() : showLock();
}
// A 401 mid-session means the cookie expired or the passcode changed. Show the
// lock rather than an empty screen.
setUnauthorisedHandler(() => {
  if (!unlocked) return;
  unlocked = false;
  showLock();
});
window.addEventListener("hashchange", () => { const t = guestToken(); if (t) showGuest(t); });

// ---------- live updates ----------
// One EventSource per tab. The stream says only "booking X changed"; this
// re-fetches through the normal API. Changes are debounced, so a burst (three
// uploads, one sync) causes one re-render rather than three.
let liveSource = null, liveTimer = null, liveFor = null;
function listenLive(url, onChange) {
  if (liveSource && liveFor === url) return;
  liveSource?.close();
  liveFor = url;
  try { liveSource = new EventSource(url, { withCredentials: true }); }
  catch { return; }          // no SSE: the focus-refresh below still works
  liveSource.addEventListener("change", (e) => {
    let id = null;
    try { id = JSON.parse(e.data).bookingId; } catch { /* ignore */ }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => onChange(id), 250);
  });
}
// Never re-render under someone mid-edit.
const editing = () => document.activeElement?.matches("input,textarea,select");
function listenAdmin() {
  listenLive("/api/events", (id) => {
    if (!unlocked || document.getElementById("guestScreen") || editing()) return;
    // The list cares about every change; a detail page only about its own.
    if (view.screen === "bookings" || (view.screen === "detail" && (!id || id === view.bookingId))) render();
  });
}
function listenGuest(token) {
  listenLive(`/u/${encodeURIComponent(token)}/events`, () => { if (!editing()) showGuest(token); });
}

// Coming back to a tab re-reads everything. Two surfaces can change the same
// booking — the admin page and the guest link, often open at once — and a tab
// left in the background holds whatever it last rendered. Refreshing on focus
// is the cheap 90% of the fix; live push (SSE) is Phase 5.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const token = guestToken();
  if (token) showGuest(token);
  else if (unlocked) render();
});
boot();

// Exported for frontend/test.html and the screenshot harness, which drive the
// app directly rather than through the lock screen.
export { CONFIG, Data, Derive, RULES, fmt, esc, initials, view, render, mountApp, showGuest, showLock, toast, guestLink, setTheme, themePref };
export function __setUnlocked(v) { unlocked = v; }

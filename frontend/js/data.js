// ---------------------------------------------------------------------------
// The only place in the frontend that knows where data comes from.
//
// Every function is a call to the API. There is no mock data any more: SEED is
// gone. The screens did not change when this file was rewritten, which was the
// whole point of making these async before there was a server to be async
// about.
//
// Shapes come back exactly as shared/rules.js expects, and the server sends
// FACTS — never a computed status. Both sides derive from the same module, so
// they cannot disagree about whether a booking is ready.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { Derive, RULES, parseDay, fillTemplate, TEMPLATE_VARS } from "../../shared/rules.js";

// Re-exported so screens import their rules from one place.
export { Derive, RULES, parseDay, fillTemplate, TEMPLATE_VARS };

const API = "/api";

/** Raised for any non-2xx. Carries the server's own reason, which is written for a human. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error === "owner_only"
      ? "Only the owner can do that — press Lock, then use \u201cOwner? Email me a sign-in link\u201d"
      : body?.message || body?.error || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.reason = body?.error || "request_failed";
    this.body = body || {};
  }
}

// Set when a request comes back 401, so the app can show the lock screen
// instead of rendering an empty page.
let onUnauthorised = () => {};
export function setUnauthorisedHandler(fn) { onUnauthorised = fn; }

async function request(path, { method = "GET", body, headers = {}, raw = false, root = false } = {}) {
  // `root` skips the /api prefix: the guest routes sit at /u/:token, because
  // that is a URL a human pastes into a phone.
  const res = await fetch(`${root ? "" : API}${path}`, {
    method,
    // Same origin, so the session cookie travels without any CORS setup.
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !root) { onUnauthorised(); throw new ApiError(401, { error: "unauthorised" }); }
  if (res.status === 401) throw new ApiError(401, { error: "unauthorised" });
  if (res.status === 304 || res.status === 204) return raw ? res : null;
  const payload = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, payload);
  return raw ? { res, payload } : payload;
}

/**
 * The host's check-in/check-out times, which every retention window depends on.
 *
 * They arrive with each bookings response, so the cache is normally warm and no
 * screen pays an extra round trip for them. Seeded from the shared defaults so
 * a first render is never wrong by an hour.
 */
let times = { checkInTime: RULES.defaultCheckInTime, checkOutTime: RULES.defaultCheckOutTime };
const rememberTimes = (t) => { if (t?.checkInTime) times = t; return t; };

const Data = {
  // --- session ------------------------------------------------------------
  async session() { return request("/auth/session"); },
  async lock() { return request("/auth/lock", { method: "POST", body: {} }); },
  /** Development only: sign in by address, with no Google app registered. */
  async devLogin(email) {
    try { return { ok: true, ...(await request("/auth/dev-login", { method: "POST", body: { email } })) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async switchAccount(accountId) {
    try { return { ok: true, ...(await request("/auth/switch", { method: "POST", body: { accountId } })) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async renameAccount(name) {
    try { return { ok: true, account: await request("/account", { method: "PATCH", body: { name } }) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },

  // --- who has access -----------------------------------------------------
  async members() { return request("/members"); },
  async inviteMember(email) {
    try { return { ok: true, ...(await request("/members", { method: "POST", body: { email } })) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async removeMember(userId) {
    try { await request(`/members/${encodeURIComponent(userId)}`, { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async revokeInvite(id) {
    try { await request(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  },

  // --- the account's sending Gmail ---------------------------------------
  async mailSettings() { return request("/mail"); },
  async connectMail({ fromEmail, appPassword }) {
    try { return { ok: true, mail: await request("/mail", { method: "PUT", body: { fromEmail, appPassword } }) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async disconnectMail() {
    try { await request("/mail", { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async testMail() {
    try { return { ok: true, ...(await request("/mail/test", { method: "POST", body: {} })) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },

  // --- who may start an account (the site owner only) --------------------
  async approvals() { return (await request("/approvals")).rows; },
  async approve(email, note) {
    try { return { ok: true, row: await request("/approvals", { method: "POST", body: { email, note } }) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },
  async unapprove(email) {
    try { await request(`/approvals/${encodeURIComponent(email)}`, { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, message: e.message }; }
  },

  async audit() { return (await request("/audit")).rows; },

  // --- settings -----------------------------------------------------------
  async settings() { return { ...times }; },
  async saveSettings(patch) {
    const body = {};
    if (patch.checkInTime) body.checkInTime = patch.checkInTime;
    if (patch.checkOutTime) body.checkOutTime = patch.checkOutTime;
    return rememberTimes(await request("/settings/times", { method: "PATCH", body }));
  },
  async profile() {
    const listings = await request("/listings");
    return { name: "Host", role: "Admin", listingCount: listings.length };
  },

  // --- societies ----------------------------------------------------------
  async societies() { return request("/societies"); },
  async addSociety({ name, to, cc, template }) {
    try { return { ok: true, society: await request("/societies", { method: "POST", body: { name, to, cc, template } }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async saveSociety(id, patch) {
    try { return { ok: true, society: await request(`/societies/${id}`, { method: "PATCH", body: patch }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },

  // --- listings -----------------------------------------------------------
  async listings() { return request("/listings"); },
  /** Read a calendar without saving anything, so connecting is not an act of faith. */
  async checkCalendar(icalUrl) { return request("/listings/check", { method: "POST", body: { icalUrl } }); },
  async addListing({ name, icalUrl, societyId }) {
    try { return { ok: true, listing: await request("/listings", { method: "POST", body: { name, icalUrl, societyId } }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async updateListing(id, patch) {
    try { return { ok: true, listing: await request(`/listings/${id}`, { method: "PATCH", body: patch }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async listingUsage(id) { return request(`/listings/${id}/usage`); },
  async disconnectListing(id) {
    try { return { ok: true, listing: await request(`/listings/${id}/disconnect`, { method: "POST", body: {} }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async deleteListing(id) {
    try { await request(`/listings/${id}`, { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message, ...e.body }; }
  },

  // --- bookings -----------------------------------------------------------
  async bookings({ listingId = null, cursor = null, limit = CONFIG.ui.pageSize } = {}) {
    const q = new URLSearchParams();
    if (listingId) q.set("listingId", listingId);
    if (cursor) q.set("cursor", cursor);
    if (limit) q.set("limit", String(limit));
    const page = await request(`/bookings?${q}`);
    rememberTimes(page.times);
    return page;
  },
  async booking(id) {
    const b = await request(`/bookings/${id}`);
    rememberTimes(b.times);
    return b;
  },
  async regenerateGuestLink(id) { return request(`/bookings/${id}/guest-link/regenerate`, { method: "POST", body: {} }); },

  async setAutomation(id, automation) {
    return request(`/bookings/${id}/automation`, { method: "PATCH", body: { automation } });
  },
  async setAdultCount(id, adults) {
    try { return { ok: true, ...(await request(`/bookings/${id}/people`, { method: "POST", body: { adults } })) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async renamePerson(id, personId, name) {
    try { return { ok: true, ...(await request(`/bookings/${id}/people/${personId}`, { method: "PATCH", body: { name } })) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  /** Upload the actual bytes. The file is prepared in the browser first. */
  async uploadDocument(id, personId, file, { type = CONFIG.documents.types[0] } = {}) {
    return sendFile(`/api/bookings/${id}/people/${personId}/upload`, file, type);
  },
  /** Record the ID type only. Used where there is no file, e.g. correcting a label. */
  async addDocument(id, personId, { type = CONFIG.documents.types[0] } = {}) {
    try { return { ok: true, ...(await request(`/bookings/${id}/people/${personId}/document`, { method: "PUT", body: { docType: type } })) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  /** The URL an admin views a stored ID at. Never given to a guest. */
  documentUrl(documentId) { return `${API}/documents/${encodeURIComponent(documentId)}`; },
  async removeDocument(id, personId) {
    try { await request(`/bookings/${id}/people/${personId}/document`, { method: "DELETE" }); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async send(id) {
    try { return { ok: true, ...(await request(`/bookings/${id}/send`, { method: "POST", body: {} })) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async sync() {
    try { return { ok: true, ...(await request("/sync", { method: "POST", body: {} })) }; }
    catch (e) { return { ok: false, message: e.message, failures: [] }; }
  },
  async syncListing(id) {
    try { return { ok: true, ...(await request(`/listings/${id}/sync`, { method: "POST", body: {} })) }; }
    catch (e) { return { ok: false, message: e.message }; }
  },

  // --- the guest surface (no session; the token is the access) ------------
  async guestBooking(token) {
    try {
      const b = await request(`/u/${encodeURIComponent(token)}`, { root: true });
      rememberTimes(b.times);
      return b;
    } catch (e) {
      if (e.status === 404) return null;   // expired, revoked, forged or unknown
      throw e;
    }
  },
  async guestSetAdultCount(token, adults) {
    try { return { ok: true, booking: await request(`/u/${encodeURIComponent(token)}/people`, { root: true, method: "POST", body: { adults } }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async guestRenamePerson(token, personId, name) {
    try { return { ok: true, booking: await request(`/u/${encodeURIComponent(token)}/people/${personId}`, { root: true, method: "PATCH", body: { name } }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
  async guestUploadDocument(token, personId, file, { type = CONFIG.documents.types[0] } = {}) {
    return sendFile(`/u/${encodeURIComponent(token)}/people/${personId}/upload`, file, type);
  },
  async guestAddDocument(token, personId, { type = CONFIG.documents.types[0] } = {}) {
    try { return { ok: true, booking: await request(`/u/${encodeURIComponent(token)}/people/${personId}/document`, { root: true, method: "PUT", body: { docType: type } }) }; }
    catch (e) { return { ok: false, reason: e.reason, message: e.message }; }
  },
};

/**
 * POST one file as multipart. Not through request(): the body is a FormData,
 * and the browser must set its own boundary — so no content-type is sent.
 */
async function sendFile(path, file, docType) {
  const form = new FormData();
  form.append("docType", docType);
  form.append("file", file, file.name || "id.jpg");
  try {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", body: form });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: payload?.error || "upload_failed", message: payload?.message || "That upload failed." };
    return { ok: true, ...payload };
  } catch {
    return { ok: false, reason: "offline", message: "Could not reach the server. Check your connection and try again." };
  }
}

export { Data };

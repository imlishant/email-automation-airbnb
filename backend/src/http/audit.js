// ---------------------------------------------------------------------------
// What gets audited, in one table.
//
// A hook rather than calls scattered through the routes, so the list of
// audited actions can be read in one place — and a new admin route that is
// missing from it is easy to spot in review.
//
// Names are looked up BEFORE the handler runs, because after a delete there is
// nothing left to name.
// ---------------------------------------------------------------------------
import { one } from "../db/client.js";
import { recordAudit } from "../repo/audit.js";

const nameOf = (table) => async (client, id) =>
  (await one(client, `SELECT name FROM ${table} WHERE id = ?`, [id]))?.name || id;
const fields = (body) => Object.keys(body || {}).join(", ");

// key: "METHOD route-pattern"
const AUDITED = {
  "POST /api/auth/passcode": { kind: "passcode", text: () => "Admin passcode changed" },
  "POST /api/auth/unlock": {
    kind: "lockout",
    // Only a lockout is worth a row; ordinary wrong guesses are counted, not logged.
    when: (status, payload) => status === 401 && /"error":"locked"/.test(payload),
    text: () => "Admin side locked after repeated wrong passcodes",
  },
  "POST /api/societies": { kind: "society", text: (req) => `Society "${req.body.name}" added` },
  "PATCH /api/societies/:id": {
    kind: "society", lookup: nameOf("societies"),
    // A changed desk address changes where IDs are emailed, so it is named.
    text: (req, name) => req.body.to !== undefined
      ? `Society "${name}": desk address changed to ${req.body.to}`
      : `Society "${name}" edited (${fields(req.body)})`,
  },
  "DELETE /api/societies/:id": { kind: "society", lookup: nameOf("societies"), text: (req, name) => `Society "${name}" deleted` },
  "POST /api/listings": { kind: "listing", text: (req) => `Listing "${req.body.name}" connected` },
  "PATCH /api/listings/:id": {
    kind: "listing", lookup: nameOf("listings"),
    text: (req, name) => `Listing "${name}" edited (${fields(req.body)})`,
  },
  "POST /api/listings/:id/disconnect": { kind: "listing", lookup: nameOf("listings"), text: (req, name) => `Listing "${name}" disconnected` },
  "DELETE /api/listings/:id": { kind: "listing", lookup: nameOf("listings"), text: (req, name) => `Listing "${name}" deleted` },
  "PATCH /api/settings/times": {
    kind: "settings",
    text: (req) => `Times changed: ${[req.body.checkInTime && `check-in ${req.body.checkInTime}`,
      req.body.checkOutTime && `check-out ${req.body.checkOutTime}`].filter(Boolean).join(", ")}`,
  },
  "POST /api/bookings/:id/guest-link/regenerate": {
    kind: "guest_link",
    lookup: async (client, id) => (await one(client, "SELECT airbnb_code FROM bookings WHERE id = ?", [id]))?.airbnb_code || id,
    text: (req, code) => `Guest link regenerated for booking ${code}; the old link no longer works`,
  },
};

export function registerAudit(app) {
  const client = app.db.client;
  const keyOf = (req) => `${req.method} ${req.routeOptions?.url}`;

  app.addHook("preHandler", async (req) => {
    const rule = AUDITED[keyOf(req)];
    if (rule?.lookup && req.params?.id) req.auditName = await rule.lookup(client, req.params.id);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const rule = AUDITED[keyOf(req)];
    if (!rule) return payload;
    const status = reply.statusCode;
    const recordIt = rule.when ? rule.when(status, String(payload || "")) : status >= 200 && status < 300;
    if (recordIt) {
      try {
        await recordAudit(client, { kind: rule.kind, text: rule.text(req, req.auditName), ip: req.ip });
      } catch (e) {
        // An audit failure must not fail the action — but it must be visible.
        req.log.error({ err: e.message }, "audit write failed");
      }
    }
    return payload;
  });
}

export const AUDITED_ROUTES = Object.keys(AUDITED);

// ---------------------------------------------------------------------------
// Reading bookings. Admin-only.
//
// Responses carry an ETag, so the common case — the host reopening the tab —
// costs a 304 with no body (docs/TECH_STACK.md §5). That matters more than
// server time on a mobile connection.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { requireAdmin } from "./auth.js";
import { listBookings, getBooking, appSettings } from "../../repo/bookings.js";
import { ensureGuestLink, regenerateGuestLink } from "../../repo/guestLinks.js";

const personOut = {
  type: "object",
  properties: {
    id: { type: "string" }, name: { type: "string" }, lead: { type: "boolean" },
    documentType: { type: ["string", "null"] }, documentId: { type: ["string", "null"] },
    fileDeleted: { type: "boolean" },
  },
};
// Deliberately absent: status, adults, nights. Those are derived by the client
// from shared/rules.js, the same module the server uses. Sending a computed
// status would create a second source of truth.
const bookingOut = {
  type: "object",
  properties: {
    id: { type: "string" }, code: { type: ["string", "null"] },
    listingId: { type: "string" }, listingName: { type: "string" },
    societyId: { type: "string" }, societyName: { type: "string" },
    checkIn: { type: "string" }, checkOut: { type: "string" },
    children: { type: "integer" },
    leadGuest: { type: ["string", "null"] }, phoneLast4: { type: ["string", "null"] },
    automation: { type: "string" },
    sentAt: { type: ["string", "null"] },
    conflict: { type: "boolean" }, conflictReason: { type: ["string", "null"] },
    lastDocumentAt: { type: ["string", "null"] },
    sentTo: { type: ["string", "null"] }, sentCc: { type: ["string", "null"] },
    sentSocietyName: { type: ["string", "null"] },
    people: { type: "array", items: personOut },
  },
};

const etagFor = (version) => `W/"${createHash("sha1").update(String(version)).digest("base64url").slice(0, 22)}"`;

export async function registerBookings(app) {
  const admin = requireAdmin(app);
  const client = app.db.client;

  app.get("/bookings", {
    onRequest: admin,
    schema: {
      querystring: {
        type: "object", additionalProperties: false,
        properties: {
          listingId: { type: "string", maxLength: 64 },
          cursor: { type: "string", maxLength: 256 },
          limit: { type: "string", pattern: "^[0-9]{1,3}$" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            rows: { type: "array", items: bookingOut },
            nextCursor: { type: ["string", "null"] },
            counts: { type: "object", properties: { attention: { type: "integer" }, settled: { type: "integer" } } },
            times: { type: "object", properties: { checkInTime: { type: "string" }, checkOutTime: { type: "string" } } },
          },
        },
      },
    },
  }, async (req, reply) => {
    const settings = await appSettings(client, req.accountId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const page = await listBookings(client, {
      accountId: req.accountId,
      listingId: req.query.listingId || null,
      cursor: req.query.cursor || null,
      limit, settings,
    });

    // The times go with the list so a client has everything it needs to derive
    // status and every window in one round trip.
    const etag = etagFor(`${page.version}|${limit}|${req.query.cursor || ""}|${req.query.listingId || ""}|${settings.checkInTime}${settings.checkOutTime}`);
    reply.header("ETag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();

    return { rows: page.rows, nextCursor: page.nextCursor, counts: page.counts, times: settings };
  });

  app.get("/bookings/:id", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
      response: {
        200: {
          type: "object",
          properties: {
            ...bookingOut.properties,
            society: {
              type: ["object", "null"],
              properties: {
                id: { type: "string" }, name: { type: "string" },
                to: { type: "string" }, cc: { type: "string" }, template: { type: "string" },
              },
            },
            activity: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  at: { type: "string" }, kind: { type: "string" },
                  actor: { type: "string" }, text: { type: "string" },
                },
              },
            },
            times: { type: "object", properties: { checkInTime: { type: "string" }, checkOutTime: { type: "string" } } },
            guestLink: {
              type: "object",
              properties: { token: { type: "string" }, expiresAt: { type: "string" } },
            },
          },
        },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (req, reply) => {
    const booking = await getBooking(client, req.params.id, { accountId: req.accountId });
    if (!booking) return reply.code(404).send({ error: "not_found" });
    // Minted on first view rather than at sync time: a booking nobody opens
    // never needs a link, and a link that exists is one more thing to leak.
    const { _liveLink, ...rest } = booking;
    const guestLink = await ensureGuestLink(client, booking.id, app.guestSecret,
      { existing: _liveLink, checkOut: booking.checkOut, settings: booking.times, accountId: booking.accountId });
    return { ...rest, guestLink };
  });

  /** Retire the current link and mint a new one, if a link is shared too widely. */
  app.post("/bookings/:id/guest-link/regenerate", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
      response: {
        200: { type: "object", properties: { token: { type: "string" }, expiresAt: { type: "string" } } },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (req, reply) => {
    // Scoped first: a booking id from another account must read as missing.
    if (!await getBooking(client, req.params.id, { accountId: req.accountId })) {
      return reply.code(404).send({ error: "not_found" });
    }
    const link = await regenerateGuestLink(client, req.params.id, app.guestSecret);
    if (!link) return reply.code(404).send({ error: "not_found" });
    req.log.info({ booking: req.params.id }, "guest link regenerated");
    return link;
  });
}

// ---------------------------------------------------------------------------
// The guest surface. No session, no passcode — the token is the access.
//
// The rule that matters: EVERY handler resolves its booking from the token and
// ignores any id in the request. A guest can only ever touch the booking their
// link belongs to.
//
// The payload is deliberately narrow: no desk address, no template, no other
// booking, no activity log. A guest sees their own party and nothing else.
// ---------------------------------------------------------------------------
import { bookingIdForToken } from "../../repo/guestLinks.js";
import { getBooking, appSettings } from "../../repo/bookings.js";
import { setAdultCount, renamePerson, putDocument } from "../../repo/bookingWrites.js";

const tokenParam = {
  type: "object", required: ["token"],
  properties: { token: { type: "string", minLength: 8, maxLength: 128 } },
};
const guestOut = {
  type: "object",
  properties: {
    id: { type: "string" },
    listingName: { type: "string" },
    leadGuest: { type: ["string", "null"] },
    checkIn: { type: "string" }, checkOut: { type: "string" },
    sentAt: { type: ["string", "null"] },
    lastDocumentAt: { type: ["string", "null"] },
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, name: { type: "string" },
          lead: { type: "boolean" }, documentType: { type: ["string", "null"] },
        },
      },
    },
    times: { type: "object", properties: { checkInTime: { type: "string" }, checkOutTime: { type: "string" } } },
  },
};
const goneOut = { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } };

/** Narrow a full booking down to what a guest may see. */
function forGuest(b, times) {
  return {
    id: b.id,
    listingName: b.listingName,
    leadGuest: b.leadGuest,
    checkIn: b.checkIn, checkOut: b.checkOut,
    sentAt: b.sentAt,
    lastDocumentAt: b.lastDocumentAt,
    people: b.people.map((p) => ({ id: p.id, name: p.name, lead: p.lead, documentType: p.documentType })),
    times,
  };
}

export async function registerGuest(app) {
  const client = app.db.client;
  const secret = app.guestSecret;

  /** Resolve the token, or end the request. Never trust an id from the caller. */
  async function resolve(req, reply) {
    const bookingId = await bookingIdForToken(client, req.params.token, secret);
    if (!bookingId) {
      // One answer for expired, revoked, forged and unknown: a guest never
      // learns whether a link ever existed.
      reply.code(404).send({ error: "link_not_active", message: "This link is no longer active. Ask your host for a new one." });
      return null;
    }
    return bookingId;
  }

  const limits = { max: app.config.rateLimits.guestPerMinute, timeWindow: "1 minute" };

  app.get("/u/:token", {
    config: { rateLimit: limits },
    schema: { params: tokenParam, response: { 200: guestOut, 404: goneOut } },
  }, async (req, reply) => {
    const id = await resolve(req, reply);
    if (!id) return reply;
    const booking = await getBooking(client, id);
    if (!booking) return reply.code(404).send({ error: "link_not_active", message: "This link is no longer active." });
    return forGuest(booking, await appSettings(client));
  });

  app.post("/u/:token/people", {
    config: { rateLimit: limits },
    schema: {
      params: tokenParam,
      body: { type: "object", required: ["adults"], additionalProperties: false,
              properties: { adults: { type: "integer", minimum: 1, maximum: 30 } } },
      response: { 200: guestOut, 404: goneOut, 409: goneOut },
    },
  }, async (req, reply) => {
    const id = await resolve(req, reply);
    if (!id) return reply;
    const res = await setAdultCount(client, id, req.body.adults, { actor: "guest" });
    if (!res.ok) return reply.code(409).send({ error: res.reason, message: "That change could not be made." });
    return forGuest(await getBooking(client, id), await appSettings(client));
  });

  app.patch("/u/:token/people/:personId", {
    config: { rateLimit: limits },
    schema: {
      params: {
        type: "object", required: ["token", "personId"],
        properties: { ...tokenParam.properties, personId: { type: "string", maxLength: 64 } },
      },
      body: { type: "object", required: ["name"], additionalProperties: false,
              properties: { name: { type: "string", minLength: 1, maxLength: 120 } } },
      response: { 200: guestOut, 400: goneOut, 404: goneOut, 409: goneOut },
    },
  }, async (req, reply) => {
    const id = await resolve(req, reply);
    if (!id) return reply;
    // personId is checked against THIS booking's people inside renamePerson,
    // so a token cannot reach a person on someone else's booking.
    const res = await renamePerson(client, id, req.params.personId, req.body.name, { actor: "guest" });
    if (!res.ok) {
      const status = res.reason === "no_person" ? 404 : res.reason === "window_closed" ? 409 : 400;
      return reply.code(status).send({ error: res.reason, message: "That name could not be saved." });
    }
    return forGuest(await getBooking(client, id), await appSettings(client));
  });

  app.put("/u/:token/people/:personId/document", {
    config: { rateLimit: limits },
    schema: {
      params: {
        type: "object", required: ["token", "personId"],
        properties: { ...tokenParam.properties, personId: { type: "string", maxLength: 64 } },
      },
      body: { type: "object", required: ["docType"], additionalProperties: false,
              properties: { docType: { type: "string", minLength: 1, maxLength: 60 } } },
      response: { 200: guestOut, 404: goneOut, 409: goneOut },
    },
  }, async (req, reply) => {
    const id = await resolve(req, reply);
    if (!id) return reply;
    // Phase 3 attaches the bytes; this records which ID is held.
    const res = await putDocument(client, id, req.params.personId, { docType: req.body.docType, actor: "guest" });
    if (!res.ok) {
      const status = res.reason === "no_person" ? 404 : 409;
      return reply.code(status).send({ error: res.reason, message: "That ID could not be saved." });
    }
    return forGuest(await getBooking(client, id), await appSettings(client));
  });
}

// ---------------------------------------------------------------------------
// Societies, listings, and the global times. All admin-only.
//
// The notable one is POST /listings/check: pasting a calendar link fetches and
// reads it, and reports what it found, BEFORE anything is saved. Connecting a
// listing should not be an act of faith.
// ---------------------------------------------------------------------------
import { requireAdmin } from "./auth.js";
import { one, run, nowIso } from "../../db/client.js";
import { connectListing, validateIcalUrl } from "../../ical/connect.js";
import { IcalFetchError } from "../../ical/fetch.js";
import {
  listSocieties, getSociety, createSociety, updateSociety, deleteSociety,
} from "../../repo/societies.js";
import {
  listListings, getListing, createListing, updateListing,
  listingUsage, disconnectListing, deleteListing,
} from "../../repo/listings.js";

const str = (max, min = 1) => ({ type: "string", minLength: min, maxLength: max });
const emailish = { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" };

const societyOut = {
  type: "object",
  properties: {
    id: { type: "string" }, name: { type: "string" }, to: { type: "string" },
    cc: { type: "string" }, template: { type: "string" }, listingCount: { type: "integer" },
  },
};
const listingOut = {
  type: "object",
  properties: {
    id: { type: "string" }, name: { type: "string" }, icalUrl: { type: "string" },
    societyId: { type: "string" }, societyName: { type: "string" },
    lastSyncedAt: { type: ["string", "null"] }, lastSyncError: { type: ["string", "null"] },
    connected: { type: "boolean" },
  },
};
const errorOut = {
  type: "object",
  properties: {
    error: { type: "string" }, message: { type: "string" },
    total: { type: "integer" }, sent: { type: "integer" }, count: { type: "integer" },
  },
};

export async function registerSettings(app) {
  const admin = requireAdmin(app);
  const client = app.db.client;

  // --- the global check-in / check-out times ------------------------------
  const timeOut = {
    type: "object",
    properties: { checkInTime: { type: "string" }, checkOutTime: { type: "string" } },
  };
  app.get("/settings/times", { onRequest: admin, schema: { response: { 200: timeOut } } }, async () => {
    const row = await one(client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
    return { checkInTime: row.check_in_time, checkOutTime: row.check_out_time };
  });

  app.patch("/settings/times", {
    onRequest: admin,
    schema: {
      body: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: {
          checkInTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
          checkOutTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        },
      },
      response: { 200: timeOut },
    },
  }, async (req) => {
    const sets = [], args = [];
    if (req.body.checkInTime) { sets.push("check_in_time = ?"); args.push(req.body.checkInTime); }
    if (req.body.checkOutTime) { sets.push("check_out_time = ?"); args.push(req.body.checkOutTime); }
    sets.push("updated_at = ?"); args.push(nowIso());
    await run(client, `UPDATE app_settings SET ${sets.join(", ")} WHERE id = 1`, args);
    const row = await one(client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
    // Every retention window and the send schedule hang off these, so the
    // change is worth a log line.
    req.log.info({ times: row }, "check-in/check-out times changed");
    return { checkInTime: row.check_in_time, checkOutTime: row.check_out_time };
  });

  // --- societies ----------------------------------------------------------
  app.get("/societies", {
    onRequest: admin,
    schema: { response: { 200: { type: "array", items: societyOut } } },
  }, async () => listSocieties(client));

  app.post("/societies", {
    onRequest: admin,
    schema: {
      body: {
        type: "object", required: ["name", "to", "template"], additionalProperties: false,
        properties: { name: str(200), to: emailish, cc: { type: "string", maxLength: 640 }, template: str(8000) },
      },
      response: { 201: societyOut },
    },
  }, async (req, reply) => reply.code(201).send(await createSociety(client, req.body)));

  app.patch("/societies/:id", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      body: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: { name: str(200), to: emailish, cc: { type: "string", maxLength: 640 }, template: str(8000) },
      },
      response: { 200: societyOut, 404: errorOut },
    },
  }, async (req, reply) => {
    const updated = await updateSociety(client, req.params.id, req.body);
    if (!updated) return reply.code(404).send({ error: "not_found" });
    // Changing a desk address changes where personal data goes.
    if (req.body.to !== undefined) req.log.info({ society: req.params.id }, "society desk address changed");
    return updated;
  });

  app.delete("/societies/:id", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 409: errorOut, 404: errorOut },
    },
  }, async (req, reply) => {
    const res = await deleteSociety(client, req.params.id);
    if (res.ok) return { ok: true };
    if (res.reason === "not_found") return reply.code(404).send({ error: "not_found" });
    return reply.code(409).send({
      error: res.reason, count: res.count,
      message: `${res.count} listing(s) still send to this society. Point them elsewhere first.`,
    });
  });

  // --- listings -----------------------------------------------------------
  app.get("/listings", {
    onRequest: admin,
    schema: { response: { 200: { type: "array", items: listingOut } } },
  }, async () => listListings(client));

  /**
   * Read a calendar without saving anything.
   *
   * The riskiest step in setup is pasting the wrong link — the Airbnb page URL
   * instead of the Export link is the classic mistake, and it would leave a
   * listing that silently never syncs. So this returns what we could actually
   * read, and the UI shows it before the host commits.
   */
  app.post("/listings/check", {
    onRequest: admin,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },   // it makes an outbound fetch
    schema: {
      body: { type: "object", required: ["icalUrl"], additionalProperties: false, properties: { icalUrl: str(2048) } },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            stage: { type: "string" }, code: { type: "string" }, message: { type: "string" },
            calendarName: { type: ["string", "null"] },
            counts: { type: "object", additionalProperties: true },
            upcoming: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  code: { type: ["string", "null"] }, checkIn: { type: "string" },
                  checkOut: { type: "string" }, nights: { type: "integer" },
                  phoneLast4: { type: ["string", "null"] },
                },
              },
            },
            notes: { type: "array", items: { type: "string" } },
            warnings: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
      },
    },
  }, async (req) => {
    const report = await connectListing(req.body.icalUrl, { allowPrivate: app.config.icalAllowPrivateHosts });
    if (!report.ok) {
      return { ok: false, stage: report.stage, code: report.code, message: report.message, notes: [], warnings: [] };
    }
    return {
      ok: true,
      calendarName: report.calendarName,
      counts: report.counts,
      // Just enough to show a preview; the full list is not needed to decide.
      upcoming: report.upcoming.slice(0, 10).map((r) => ({
        code: r.code, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, phoneLast4: r.phoneLast4,
      })),
      notes: report.notes,
      warnings: report.warnings.slice(0, 10),
    };
  });

  app.post("/listings", {
    onRequest: admin,
    schema: {
      body: {
        type: "object", required: ["name", "icalUrl", "societyId"], additionalProperties: false,
        properties: { name: str(200), icalUrl: str(2048), societyId: str(64) },
      },
      response: { 201: listingOut, 400: errorOut },
    },
  }, async (req, reply) => {
    // The URL is validated for shape here; whether it reads is /listings/check.
    try {
      validateIcalUrl(req.body.icalUrl, { allowPrivate: app.config.icalAllowPrivateHosts });
    } catch (e) {
      if (e instanceof IcalFetchError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
    const res = await createListing(client, req.body);
    if (!res.ok) {
      return reply.code(400).send({ error: res.reason, message: "Pick the society this listing sits in." });
    }
    return reply.code(201).send(res.listing);
  });

  app.patch("/listings/:id", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      body: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: { name: str(200), icalUrl: str(2048), societyId: str(64) },
      },
      response: { 200: listingOut, 400: errorOut, 404: errorOut },
    },
  }, async (req, reply) => {
    if (req.body.icalUrl !== undefined) {
      try {
        validateIcalUrl(req.body.icalUrl, { allowPrivate: app.config.icalAllowPrivateHosts });
      } catch (e) {
        if (e instanceof IcalFetchError) return reply.code(400).send({ error: e.code, message: e.message });
        throw e;
      }
    }
    const res = await updateListing(client, req.params.id, req.body);
    if (!res.ok) {
      const status = res.reason === "not_found" ? 404 : 400;
      return reply.code(status).send({ error: res.reason });
    }
    if (req.body.societyId !== undefined) {
      req.log.info({ listing: req.params.id }, "listing society changed");
    }
    return res.listing;
  });

  app.get("/listings/:id/usage", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      response: { 200: { type: "object", properties: { total: { type: "integer" }, sent: { type: "integer" } } } },
    },
  }, async (req) => listingUsage(client, req.params.id));

  app.post("/listings/:id/disconnect", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      response: { 200: listingOut, 404: errorOut },
    },
  }, async (req, reply) => {
    const res = await disconnectListing(client, req.params.id);
    if (!res.ok) return reply.code(404).send({ error: res.reason });
    req.log.info({ listing: req.params.id }, "listing disconnected");
    return res.listing;
  });

  app.delete("/listings/:id", {
    onRequest: admin,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: str(64) } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 409: errorOut, 404: errorOut },
    },
  }, async (req, reply) => {
    const res = await deleteListing(client, req.params.id);
    if (res.ok) { req.log.info({ listing: req.params.id }, "listing deleted"); return { ok: true }; }
    if (res.reason === "not_found") return reply.code(404).send({ error: "not_found" });
    return reply.code(409).send({
      error: res.reason, total: res.total, sent: res.sent,
      message: `This listing has ${res.total} booking(s)` +
        `${res.sent ? `, ${res.sent} already sent to security` : ""}. ` +
        `Deleting it would destroy that record — disconnect it instead.`,
    });
  });
}

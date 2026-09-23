// ---------------------------------------------------------------------------
// The job tick, and a manual sync.
//
// Render's free tier has no cron and sleeps after ~15 minutes idle, so an
// external scheduler POSTs here every 10 minutes (docs/TECH_STACK.md §2a). That
// one call drives the work AND keeps the instance awake.
//
// It is therefore a public URL that does real work: authenticated by a shared
// secret, and cheap to reject.
// ---------------------------------------------------------------------------
import { timingSafeEqual } from "node:crypto";
import { requireAdmin } from "./auth.js";
import { syncAllListings, syncListing } from "../../jobs/sync.js";
import { runDueSends } from "../../jobs/send.js";
import { purgeExpired } from "../../jobs/purge.js";
import { getListing } from "../../repo/listings.js";

const syncOut = {
  type: "object",
  properties: {
    ok: { type: "boolean" }, code: { type: "string" }, message: { type: "string" },
    created: { type: "integer" }, updated: { type: "integer" },
    conflicts: { type: "integer" }, vanished: { type: "integer" },
    reservations: { type: "integer" },
  },
};

function secretMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerJobs(app) {
  const client = app.db.client;
  const admin = requireAdmin(app);
  let running = false;

  app.post("/jobs/tick", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: {
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" }, ran: { type: "integer" }, sent: { type: "integer" }, purged: { type: "integer" }, skipped: { type: "boolean" } } },
        401: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (req, reply) => {
    const given = req.headers["x-jobs-secret"] || "";
    if (!secretMatches(given, app.config.jobs.tickSecret)) {
      return reply.code(401).send({ error: "unauthorised" });
    }
    // Idempotent and non-overlapping: a slow feed must not let ticks pile up.
    if (running) return { ok: true, ran: 0, skipped: true };
    running = true;
    try {
      // Sync first, so a booking that arrives in this tick can also be sent in
      // it — a reservation made an hour before check-in must not wait.
      const synced = await syncAllListings(client, { log: (m) => req.log.info(m), allowPrivate: app.config.icalAllowPrivateHosts });
      const sends = await runDueSends(client, {
        // Each booking goes out through its own account's Gmail.
        mailFor: app.mailFor,
        files: app.files, fileKey: app.fileKey,
        maxAttachmentBytes: app.config.mail.maxAttachmentBytes,
      }, { log: (m) => req.log.info(m) });
      // Last, so a booking is never purged in the same tick it could still have
      // been sent in.
      const purged = await purgeExpired(client, { store: app.files, log: (m) => req.log.info(m) });
      return { ok: true, ran: synced.length, sent: sends.filter((s) => s.sent).length,
               purged: purged.filter((p) => p.purged).length, skipped: false };
    } finally {
      running = false;
    }
  });

  /** Force a check now. The poll is not optional; this is for a host who doubts it. */
  app.post("/listings/:id/sync", {
    onRequest: admin,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
      response: { 200: syncOut, 404: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (req, reply) => {
    const listing = await getListing(client, req.params.id);
    if (!listing) return reply.code(404).send({ error: "not_found" });
    const r = await syncListing(client, listing, { allowPrivate: app.config.icalAllowPrivateHosts });
    req.log.info({ listing: listing.id, ...r }, "manual sync");
    return { ok: r.ok, code: r.code || "", message: r.message || "",
             created: r.created || 0, updated: r.updated || 0,
             conflicts: r.conflicts || 0, vanished: r.vanished || 0, reservations: r.reservations || 0 };
  });

  /** Sync every listing. What "Sync now" calls. */
  app.post("/sync", {
    onRequest: admin,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            created: { type: "integer" }, updated: { type: "integer" },
            conflicts: { type: "integer" }, listings: { type: "integer" },
            failures: { type: "array", items: { type: "object", properties: {
              name: { type: "string" }, message: { type: "string" } } } },
          },
        },
      },
    },
  }, async (req) => {
    const results = await syncAllListings(client, { log: (m) => req.log.info(m), allowPrivate: app.config.icalAllowPrivateHosts });
    const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
    return {
      ok: results.every((r) => r.ok !== false),
      created: sum("created"), updated: sum("updated"), conflicts: sum("conflicts"),
      listings: results.length,
      // A feed that failed is named, not swallowed into a cheerful total.
      failures: results.filter((r) => !r.ok).map((r) => ({ name: r.name, message: r.message || r.code })),
    };
  });
}

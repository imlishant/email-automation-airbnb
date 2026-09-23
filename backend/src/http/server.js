// ---------------------------------------------------------------------------
// The HTTP server.
//
// Fastify because every route declares a JSON Schema: unknown fields are
// rejected rather than ignored, and responses are serialised from a declared
// shape (docs/CODING_STANDARDS.md).
// ---------------------------------------------------------------------------
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { openDatabase, applyPragmas } from "../db/client.js";
import { migrate, seedFirstRun } from "../db/migrate.js";
import { ephemeralSecret } from "./session.js";
import { registerHealth } from "./routes/health.js";
import { registerAuth } from "./routes/auth.js";
import { registerSettings } from "./routes/settings.js";
import { registerAccount } from "./routes/account.js";
import { registerBookings } from "./routes/bookings.js";
import { registerBookingActions } from "./routes/booking-actions.js";
import { chooseTransport } from "../mail/transport.js";
import { transportForAccount, readAccountMail } from "../mail/account.js";
import { registerGuest } from "./routes/guest.js";
import { registerJobs } from "./routes/jobs.js";
import { registerAudit } from "./audit.js";
import { registerEvents } from "./routes/events.js";
import { listAudit } from "../repo/audit.js";
import { requireAdmin, forgetMembership } from "./routes/auth.js";
import { notifyMembershipChanges } from "../repo/accounts.js";
import { registerUploads, registerGuestUploads } from "./routes/uploads.js";
import multipart from "@fastify/multipart";
import { chooseStore } from "../files/store.js";
import { loadKey } from "../files/crypto.js";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildServer(config, { logger = true } = {}) {
  if (config.fatal.length) {
    throw new Error("refusing to start:\n  - " + config.fatal.join("\n  - "));
  }

  const app = Fastify({
    logger: logger === true
      ? {
          level: config.production ? "info" : "debug",
          // Never log a passcode, a guest token, or a cookie
          // (docs/SECURITY.md). Redaction is declared, not remembered.
          redact: {
            paths: [
              'req.headers.cookie', 'req.headers.authorization',
              'req.headers["x-jobs-secret"]',
              'req.body.passcode', 'req.body.next', 'req.body.passcodeHash',
              'req.params.token', 'req.query.token',
            ],
            censor: "[redacted]",
          },
          // A guest token lives in the path, so the raw URL must not be logged.
          serializers: {
            req: (r) => ({ method: r.method, url: String(r.url).replace(/\/u\/[^/?]+/, "/u/[token]"), ip: r.ip }),
          },
        }
      : false,
    trustProxy: config.trustProxy,
    // Fastify's default ajv SILENTLY STRIPS unknown properties. We want them
    // rejected: a field the client thinks it is sending and the server quietly
    // discards is a bug that hides itself (docs/CODING_STANDARDS.md).
    // Coercion is off for the same reason — a body must mean what it says.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true, allErrors: false } },
    bodyLimit: 1024 * 1024,           // JSON only here; uploads get their own route
  });

  app.decorate("config", config);
  // The mail transport. Until Phase 4 configures SMTP this refuses every send
  // rather than letting a booking read "Sent" with nothing delivered.
  app.decorate("mail", chooseTransport(config));
  // Where encrypted ID documents live, and the key they are encrypted with.

  app.decorate("fileKey", loadKey(config.storage.encryptionKey));

  // --- database -----------------------------------------------------------
  const db = openDatabase(config.database);
  await applyPragmas(db);
  await migrate(db, { log: (m) => app.log.info(m) });
  await seedFirstRun(db, { passcodeHash: "pending", ...camelTimes(config.times) });
  app.decorate("db", db);
  notifyMembershipChanges(forgetMembership);
  // Where encrypted ID documents live. "db" keeps them in the database itself.
  app.decorate("files", chooseStore(config, { client: db.client }));
  // What sends for one account: their own connected Gmail if they have one,
  // otherwise this deployment's transport (recording in development, or an
  // SMTP_* setup for a single-host install).
  app.decorate("mailFor", async (accountId) => {
    const own = accountId
      ? await transportForAccount(db.client, accountId, app.fileKey,
          { maxAttachmentBytes: config.mail.maxAttachmentBytes })
      : null;
    return own
      ? { transport: own, from: (await readAccountMail(db.client, accountId))?.fromEmail || config.mail.from }
      : { transport: app.mail, from: config.mail.from };
  });
  app.addHook("onClose", async () => { try { db.client.close(); } catch { /* already closed */ } });

  // --- cookies and rate limiting ------------------------------------------
  const secret = config.session.secret || ephemeralSecret();
  await app.register(cookie, { secret });
  app.decorate("sessionSecret", secret);
  // Genuinely independent of the session secret. (It used to be derived from
  // it, which meant rotating SESSION_SECRET — the documented emergency control —
  // silently killed every guest link too.)
  app.decorate("guestSecret", config.guestSecret || ephemeralSecret());

  // The HTTP half of the brute-force defence; the other half is the account
  // lockout in src/auth/admin.js.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimits.globalPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    // statusCode must be included: without it the thrown value is a bare
    // object, our error handler sees no status and turns a 429 into a 500.
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `Too many requests. Try again in ${Math.ceil((ctx.ttl || 60000) / 1000)}s.`,
    }),
  });

  // --- security headers on every response ---------------------------------
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    // Guest tokens are in the URL; a referrer would leak one to any third party.
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    if (config.production) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    // Nothing here should ever be indexed, and an ID must never be cached.
    reply.header("X-Robots-Tag", "noindex, nofollow");
    if (req.url.startsWith("/api/") || req.url.startsWith("/u/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found" }));
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    // Validation failures say what was wrong; anything else says nothing, so an
    // internal message can never leak to a caller.
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(500).send({ error: "server_error" });
    }
    return reply.code(status).send({ error: err.error || err.code || "bad_request", message: err.message });
  });

  registerAudit(app);

  // --- routes -------------------------------------------------------------
  await app.register(registerHealth);
  await app.register(registerAuth, { prefix: "/api" });
  await app.register(registerSettings, { prefix: "/api" });
  await app.register(registerAccount, { prefix: "/api" });
  await app.register(registerBookings, { prefix: "/api" });
  await app.register(registerBookingActions, { prefix: "/api" });
  await app.register(registerJobs, { prefix: "/api" });
  app.get("/api/audit", {
    onRequest: requireAdmin(app),
    schema: {
      querystring: { type: "object", additionalProperties: false,
        properties: { before: { type: "string", maxLength: 40 } } },
    },
  }, async (req) => ({ rows: await listAudit(app.db.client, req.accountId, { before: req.query.before || null }) }));
  await app.register(multipart, {
    limits: { fileSize: config.storage.maxBytes, files: 1, fields: 4 },
  });
  await app.register(registerUploads, { prefix: "/api" });
  await app.register(registerGuestUploads);   // /u/:token/... — no prefix
  await app.register(registerEvents);
  await app.register(registerGuest);   // /u/:token — no prefix, it is a link people paste

  // The frontend is served from this same origin, so the session cookie just
  // works and there is no CORS to configure or get wrong.
  if (config.serveFrontend) {
    // Only frontend/ and shared/ are public. Serving the repo root would hand
    // out backend source, docs and, on a dev machine, the local database.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    await app.register(fastifyStatic, { root: join(repoRoot, "frontend"), prefix: "/" });
    // The browser resolves js/config.js's ../../shared/rules.js to /shared/rules.js.
    await app.register(fastifyStatic, { root: join(repoRoot, "shared"), prefix: "/shared/", decorateReply: false });
    // Guest links shared before the app moved to "/" keep working; the
    // browser carries the #u/<token> fragment across the redirect.
    app.get("/frontend/index.html", async (req, reply) => reply.redirect("/"));
  }

  for (const w of config.warnings) app.log.warn(w);
  return app;
}

const camelTimes = (t) => ({ checkInTime: t.checkIn, checkOutTime: t.checkOut });

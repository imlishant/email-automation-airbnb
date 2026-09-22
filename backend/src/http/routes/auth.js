// ---------------------------------------------------------------------------
// Admin unlock and passcode change.
//
// The account lockout lives in src/auth/admin.js. What this file adds is the
// HTTP half: a per-IP rate limit, so an attacker cannot spread guesses across
// the lockout window from many addresses cheaply, and uniform responses.
// ---------------------------------------------------------------------------
import { unlock, setPasscode, authStatus } from "../../auth/admin.js";
import { COOKIE, issueSession, verifySession, cookieOptions } from "../session.js";
import { createOwnerLink, consumeOwnerLink, ownerLinkMessage } from "../../auth/owner.js";
import { recordAudit } from "../../repo/audit.js";

/**
 * Attach `req.admin` when a valid session cookie is present.
 *
 * Register this as `onRequest`, NOT `preHandler`: Fastify validates the body
 * before preHandler runs, so an anonymous caller would otherwise get schema
 * feedback (and make us parse their body) before being told to go away.
 */
export function requireAdmin(app) {
  return async (req, reply) => {
    const raw = req.cookies?.[COOKIE];
    const res = verifySession(raw, app.sessionSecret);
    if (!res.ok) {
      reply.code(401).send({ error: "unauthorised" });
      return reply;
    }
    req.admin = res;
    req.role = res.role;
  };
}

/**
 * For the actions that redirect personal data or destroy records
 * (docs/DECISIONS.md, "Admin tiers"). With no OWNER_EMAIL configured the tier
 * is off and this is exactly requireAdmin — otherwise the host would be locked
 * out of their own settings until email was set up.
 */
export function requireOwner(app) {
  const admin = requireAdmin(app);
  return async (req, reply) => {
    await admin(req, reply);
    if (reply.sent) return reply;
    if (app.config.ownerEmail && req.role !== "owner") {
      reply.code(403).send({ error: "owner_only",
        message: "Only the owner can do this. Sign in with the owner link sent to the owner's email." });
      return reply;
    }
  };
}

export async function registerAuth(app) {
  const { auth: policy, rateLimits, production, session } = app.config;
  const digits = { type: "string", pattern: `^\\d{${policy.passcodeLength}}$` };

  app.post("/auth/unlock", {
    config: { rateLimit: { max: rateLimits.authPerMinute, timeWindow: "1 minute" } },
    schema: {
      body: { type: "object", required: ["passcode"], additionalProperties: false, properties: { passcode: digits } },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" } } },
        401: {
          type: "object",
          properties: {
            error: { type: "string" },
            attemptsRemaining: { type: "integer" },
            retryAfterSeconds: { type: "integer" },
          },
        },
      },
    },
  }, async (req, reply) => {
    const res = await unlock(app.db.client, req.body.passcode, { policy });
    if (!res.ok) {
      // One error code for every failure: a wrong passcode, an unconfigured
      // system and a missing row are indistinguishable (docs/SECURITY.md).
      // Only the lock is distinguished, because the caller must be told to wait.
      if (res.retryAfterSeconds) {
        reply.header("Retry-After", String(res.retryAfterSeconds));
        return reply.code(401).send({ error: "locked", retryAfterSeconds: res.retryAfterSeconds });
      }
      return reply.code(401).send({ error: "unauthorised", attemptsRemaining: res.attemptsRemaining ?? 0 });
    }
    reply.setCookie(COOKIE, issueSession(app.sessionSecret, { ttlHours: session.ttlHours }),
      cookieOptions({ production, ttlHours: session.ttlHours }));
    return { ok: true };
  });

  app.post("/auth/lock", {
    schema: { response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } } },
  }, async (req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // Does this browser hold a valid session? Used by the UI to decide whether
  // to show the lock screen, so it must not require one itself.
  app.get("/auth/session", {
    schema: { response: { 200: { type: "object", properties: {
      admin: { type: "boolean" }, role: { type: ["string", "null"] }, ownerTier: { type: "boolean" } } } } },
  }, async (req) => {
    const s = verifySession(req.cookies?.[COOKIE], app.sessionSecret);
    return { admin: s.ok, role: s.ok ? s.role : null, ownerTier: Boolean(app.config.ownerEmail) };
  });

  // --- the owner's magic link ---------------------------------------------
  // No email address is taken from the request: the link only ever goes to
  // the configured OWNER_EMAIL, so this cannot be used to mail anyone else.
  app.post("/auth/owner/request", {
    config: { rateLimit: { max: app.config.rateLimits.ownerLinkPer10Min, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    if (!app.config.ownerEmail) return reply.code(404).send({ error: "no_owner", message: "No owner is configured." });
    const link = await createOwnerLink(app.db.client, { baseUrl: app.config.baseUrl });
    try {
      await app.mail.send(ownerLinkMessage({ to: app.config.ownerEmail, from: app.config.mail.from, url: link.url }));
    } catch (e) {
      return reply.code(503).send({ error: e.code || "send_failed",
        message: "The sign-in link could not be emailed. Email is not set up yet." });
    }
    // Development only: the recording transport sends nothing, so the link is
    // printed for the host to click. In production a link is a credential and
    // is never logged.
    if (!app.config.production) req.log.warn(`owner sign-in link (dev only): ${link.url}`);
    await recordAudit(app.db.client, { kind: "owner", text: "Owner sign-in link requested", ip: req.ip });
    return { ok: true, message: "A sign-in link has been sent to the owner's email." };
  });

  app.get("/auth/owner/verify", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: { querystring: { type: "object", properties: { token: { type: "string", maxLength: 100 } } } },
  }, async (req, reply) => {
    const res = await consumeOwnerLink(app.db.client, req.query.token);
    if (!res.ok) return reply.redirect("/#owner-link-expired");
    reply.setCookie(COOKIE, issueSession(app.sessionSecret, { ttlHours: session.ttlHours, role: "owner" }),
      cookieOptions({ production, ttlHours: session.ttlHours }));
    await recordAudit(app.db.client, { kind: "owner", text: "Owner signed in", ip: req.ip });
    return reply.redirect("/");
  });

  app.post("/auth/passcode", {
    // Owner-only once configured: the shared passcode must not be changeable by
    // the people it is shared with, or any admin could lock the others out.
    onRequest: requireOwner(app),
    config: { rateLimit: { max: rateLimits.authPerMinute, timeWindow: "1 minute" } },
    schema: {
      body: { type: "object", required: ["next"], additionalProperties: false, properties: { next: digits } },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" } } },
        400: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } },
      },
    },
  }, async (req, reply) => {
    const res = await setPasscode(app.db.client, req.body.next, { policy });
    if (!res.ok) return reply.code(400).send({ error: "invalid_passcode", message: res.reason });
    // Changing the passcode retires this browser's session too, so the new code
    // has to be used at least once.
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // Whether the admin side is usable at all. Deliberately says nothing about
  // the passcode itself.
  app.get("/auth/status", {
    onRequest: requireAdmin(app),
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            configured: { type: "boolean" },
            failedAttempts: { type: "integer" },
            lockedUntil: { type: ["string", "null"] },
            passcodeLength: { type: "integer" },
          },
        },
      },
    },
  }, async () => {
    const s = await authStatus(app.db.client);
    return {
      configured: s.configured,
      failedAttempts: s.failedAttempts ?? 0,
      lockedUntil: s.lockedUntil ?? null,
      passcodeLength: policy.passcodeLength,
    };
  });
}

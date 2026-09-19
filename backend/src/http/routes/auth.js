// ---------------------------------------------------------------------------
// Admin unlock and passcode change.
//
// The account lockout lives in src/auth/admin.js. What this file adds is the
// HTTP half: a per-IP rate limit, so an attacker cannot spread guesses across
// the lockout window from many addresses cheaply, and uniform responses.
// ---------------------------------------------------------------------------
import { unlock, setPasscode, authStatus } from "../../auth/admin.js";
import { COOKIE, issueSession, verifySession, cookieOptions } from "../session.js";

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
    schema: { response: { 200: { type: "object", properties: { admin: { type: "boolean" } } } } },
  }, async (req) => ({ admin: verifySession(req.cookies?.[COOKIE], app.sessionSecret).ok }));

  app.post("/auth/passcode", {
    onRequest: requireAdmin(app),
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

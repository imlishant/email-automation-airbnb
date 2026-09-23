// ---------------------------------------------------------------------------
// Signing in, and who is allowed to do what.
//
// People sign in with Google (src/auth/google.js). A session cookie then says
// which user they are and which account they are working in; the role comes
// from the memberships table on EVERY request, never from the cookie, so
// removing a co-host takes effect at once rather than when their cookie
// expires.
//
// Guards are `onRequest`, NOT `preHandler`: Fastify validates the body before
// preHandler runs, so an anonymous caller would otherwise get schema feedback
// (and make us parse their body) before being told to go away.
// ---------------------------------------------------------------------------
import { COOKIE, issueSession, verifySession, cookieOptions } from "../session.js";
import { newHandshake, authUrl, exchangeCode } from "../../auth/google.js";
import {
  upsertUser, findUserByEmail, accountsForUser, membership, createAccount,
  acceptInvites, isApproved, unclaimedAccount, addMember,
} from "../../repo/accounts.js";

const HANDSHAKE_COOKIE = "gp_oauth";
// Role and membership are read from the database, not the cookie, so access
// taken away takes effect at once. That is one statement on EVERY request, so
// the answer is held for a few seconds — and dropped the moment anything
// changes it (see forgetMembership), which keeps "at once" true.
const MEMBERSHIP_TTL_MS = 10_000;
const seen = new Map();   // "accountId|userId" -> { role, until }
export function forgetMembership(accountId = null, userId = null) {
  if (!accountId) return seen.clear();
  seen.delete(`${accountId}|${userId}`);
}
async function currentRole(client, accountId, userId) {
  const key = `${accountId}|${userId}`, now = Date.now();
  const hit = seen.get(key);
  if (hit && hit.until > now) return hit.role;
  const m = await membership(client, accountId, userId);
  seen.set(key, { role: m?.role || null, until: now + MEMBERSHIP_TTL_MS });
  return m?.role || null;
}
const HANDSHAKE_TTL_SECONDS = 600;

/** Signed in, a member of the account in the cookie, and that role is current. */
export function requireAdmin(app) {
  return async (req, reply) => {
    const res = verifySession(req.cookies?.[COOKIE], app.sessionSecret);
    if (!res.ok || !res.userId || !res.accountId) {
      reply.code(401).send({ error: "unauthorised" });
      return reply;
    }
    const role = await currentRole(app.db.client, res.accountId, res.userId);
    if (!role) {
      // Access was taken away, or the account is gone.
      reply.code(401).send({ error: "unauthorised" });
      return reply;
    }
    req.admin = res;
    req.userId = res.userId;
    req.accountId = res.accountId;
    req.actorEmail = res.email;
    req.role = role;
  };
}

/**
 * For the actions that redirect personal data, change who has access, or
 * destroy records: the host only, not their helpers
 * (docs/DECISIONS.md, "Multi-host accounts").
 */
export function requireOwner(app) {
  const admin = requireAdmin(app);
  return async (req, reply) => {
    await admin(req, reply);
    if (reply.sent) return reply;
    if (req.role !== "owner") {
      reply.code(403).send({ error: "owner_only",
        message: "Only the host who owns this account can do this." });
      return reply;
    }
  };
}

/** The person running the deployment: they decide who may start an account. */
export function requirePlatformOwner(app) {
  const admin = requireAdmin(app);
  return async (req, reply) => {
    await admin(req, reply);
    if (reply.sent) return reply;
    const user = await one(app.db.client, "SELECT email FROM users WHERE id = ?", [req.userId]);
    if (!user || !app.config.platformOwnerEmail || user.email !== app.config.platformOwnerEmail) {
      reply.code(403).send({ error: "platform_owner_only", message: "Only the site owner can do this." });
      return reply;
    }
  };
}

/**
 * Everything a fresh sign-in needs: the person, their account, the accounts
 * they can switch to. Returns `{ signedIn: false }` rather than a 401, because
 * the lock screen asks this before anyone has signed in.
 */
async function sessionView(app, req) {
  const res = verifySession(req.cookies?.[COOKIE], app.sessionSecret);
  const base = {
    signedIn: false, role: null, email: null, name: null,
    account: null, accounts: [], platformOwner: false,
    google: Boolean(app.config.google.clientId), devLogin: app.config.devLogin,
  };
  if (!res.ok || !res.userId) return base;
  const client = app.db.client;
  const user = await one(client, "SELECT id, email, name FROM users WHERE id = ?", [res.userId]);
  if (!user) return base;
  const accounts = await accountsForUser(client, user.id);
  const current = accounts.find((a) => a.id === res.accountId) || null;
  if (!current) return { ...base, email: user.email, name: user.name, accounts, needsAccount: accounts.length === 0 };
  return {
    signedIn: true, role: current.role, email: user.email, name: user.name,
    account: { id: current.id, name: current.name }, accounts,
    platformOwner: app.config.platformOwnerEmail === user.email,
    google: base.google, devLogin: base.devLogin,
  };
}

const one = (client, sql, args) => client.execute({ sql, args }).then((r) => r.rows[0] ?? null);

/**
 * Where a freshly signed-in person lands.
 *
 * An account they already belong to wins. Otherwise: the site owner adopts the
 * data that existed before accounts (so an upgraded deployment keeps working),
 * an approved address gets a new account, and anyone else is turned away —
 * signing in with Google proves who you are, not that you were invited here.
 */
export async function placeUser(app, user) {
  const client = app.db.client;
  await acceptInvites(client, user);
  const existing = await accountsForUser(client, user.id);
  if (existing.length) return { ok: true, account: existing[0] };

  const isPlatformOwner = app.config.platformOwnerEmail === user.email;
  if (isPlatformOwner) {
    const orphan = await unclaimedAccount(client);
    if (orphan) {
      await addMember(client, { accountId: orphan.id, userId: user.id, role: "owner" });
      return { ok: true, account: { ...orphan, role: "owner" }, adopted: true };
    }
  }
  if (isPlatformOwner || await isApproved(client, user.email)) {
    const name = user.name ? `${user.name.split(" ")[0]}'s listings` : "My listings";
    const account = await createAccount(client, {
      name, ownerUserId: user.id,
      checkInTime: app.config.times.checkIn, checkOutTime: app.config.times.checkOut,
    });
    return { ok: true, account, created: true };
  }
  return { ok: false, reason: "not_approved" };
}

function signIn(app, reply, { user, account }) {
  reply.setCookie(COOKIE,
    issueSession(app.sessionSecret, {
      ttlHours: app.config.session.ttlHours, role: account.role,
      userId: user.id, accountId: account.id, email: user.email,
    }),
    cookieOptions({ production: app.config.production, ttlHours: app.config.session.ttlHours }));
}

export async function registerAuth(app) {
  const { rateLimits, production, session, google } = app.config;
  const client = app.db.client;
  const redirectUri = `${app.config.baseUrl}/api/auth/google/callback`;

  app.get("/auth/session", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            signedIn: { type: "boolean" }, role: { type: ["string", "null"] },
            email: { type: ["string", "null"] }, name: { type: ["string", "null"] },
            account: { type: ["object", "null"], properties: { id: { type: "string" }, name: { type: "string" } } },
            accounts: { type: "array", items: { type: "object",
              properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" } } } },
            platformOwner: { type: "boolean" }, google: { type: "boolean" },
            devLogin: { type: "boolean" }, needsAccount: { type: "boolean" },
          },
        },
      },
    },
  }, async (req) => sessionView(app, req));

  // --- Google ---------------------------------------------------------------

  app.get("/auth/google/start", {
    config: { rateLimit: { max: rateLimits.authPerMinute, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!google.clientId) return reply.code(503).send({ error: "google_not_configured" });
    const hs = newHandshake();
    // The verifier and state stay in a short-lived cookie on this browser, so
    // a callback that did not start here cannot be completed.
    reply.setCookie(HANDSHAKE_COOKIE, `${hs.state}.${hs.verifier}`, {
      httpOnly: true, secure: production, sameSite: "lax", path: "/api/auth/google", maxAge: HANDSHAKE_TTL_SECONDS,
    });
    return reply.redirect(authUrl({ clientId: google.clientId, redirectUri, state: hs.state, challenge: hs.challenge }));
  });

  app.get("/auth/google/callback", {
    config: { rateLimit: { max: rateLimits.authPerMinute, timeWindow: "1 minute" } },
    schema: { querystring: { type: "object", properties: {
      code: { type: "string", maxLength: 2048 }, state: { type: "string", maxLength: 256 },
      error: { type: "string", maxLength: 256 } } } },
  }, async (req, reply) => {
    const fail = (why) => {
      reply.clearCookie(HANDSHAKE_COOKIE, { path: "/api/auth/google" });
      return reply.redirect(`/#signin-${why}`);
    };
    if (!google.clientId || req.query.error || !req.query.code || !req.query.state) return fail("failed");

    const [state, verifier] = String(req.cookies?.[HANDSHAKE_COOKIE] || "").split(".");
    if (!state || !verifier || state !== req.query.state) return fail("failed");

    const res = await exchangeCode({
      code: req.query.code, clientId: google.clientId, clientSecret: google.clientSecret,
      redirectUri, verifier,
    });
    if (!res.ok) {
      req.log.warn({ reason: res.message }, "google sign-in refused");
      return fail("failed");
    }
    reply.clearCookie(HANDSHAKE_COOKIE, { path: "/api/auth/google" });

    const user = await upsertUser(client, { email: res.identity.email, name: res.identity.name });
    const placed = await placeUser(app, user);
    if (!placed.ok) {
      req.log.info({ user: user.id }, "sign-in by an address that is not approved");
      return reply.redirect("/#signin-not-approved");
    }
    signIn(app, reply, { user, account: placed.account });
    req.log.info({ user: user.id, account: placed.account.id }, "signed in with google");
    return reply.redirect("/");
  });

  // --- development sign-in --------------------------------------------------
  // So the app can be run and tested without registering a Google app. Refused
  // outright in production, and config.js makes DEV_LOGIN fatal there.

  app.post("/auth/dev-login", {
    config: { rateLimit: { max: rateLimits.authPerMinute, timeWindow: "1 minute" } },
    schema: {
      body: { type: "object", required: ["email"], additionalProperties: false,
        properties: { email: { type: "string", minLength: 3, maxLength: 320 }, name: { type: "string", maxLength: 200 } } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" }, accountId: { type: "string" } } },
        403: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } } },
    },
  }, async (req, reply) => {
    if (production || !app.config.devLogin) return reply.code(403).send({ error: "not_available" });
    const user = await upsertUser(client, { email: req.body.email, name: req.body.name || null });
    const placed = await placeUser(app, user);
    if (!placed.ok) {
      return reply.code(403).send({ error: placed.reason, message: "That address is not approved to start an account." });
    }
    signIn(app, reply, { user, account: placed.account });
    return { ok: true, accountId: placed.account.id };
  });

  // --- session lifecycle ----------------------------------------------------

  app.post("/auth/switch", {
    onRequest: requireAdmin(app),
    schema: {
      body: { type: "object", required: ["accountId"], additionalProperties: false,
        properties: { accountId: { type: "string", maxLength: 64 } } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } },
        404: { type: "object", properties: { error: { type: "string" } } } },
    },
  }, async (req, reply) => {
    const m = await membership(client, req.body.accountId, req.userId);
    if (!m) return reply.code(404).send({ error: "not_found" });
    const user = await one(client, "SELECT id, email FROM users WHERE id = ?", [req.userId]);
    signIn(app, reply, { user, account: { id: req.body.accountId, role: m.role } });
    return { ok: true };
  });

  app.post("/auth/lock", {
    schema: { response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } } },
  }, async (req, reply) => {
    reply.clearCookie(COOKIE, cookieOptions({ production, ttlHours: session.ttlHours }));
    return { ok: true };
  });

  // Kept for the browser's boot check: is sign-in usable at all?
  app.get("/auth/status", {
    schema: { response: { 200: { type: "object",
      properties: { google: { type: "boolean" }, devLogin: { type: "boolean" } } } } },
  }, async () => ({ google: Boolean(google.clientId), devLogin: app.config.devLogin }));
}

export { findUserByEmail };

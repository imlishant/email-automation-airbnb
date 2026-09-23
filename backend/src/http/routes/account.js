// ---------------------------------------------------------------------------
// The account itself: its name, who may open it, and — for the person running
// the deployment — which addresses are allowed to start a new one.
//
// Who can do what:
//   admin (co-host)  read the member list
//   owner (the host) rename the account, invite and remove co-hosts
//   site owner       approve an address to start its own account
//
// No invitation email is ever sent. The host tells the co-host to sign in with
// Google; the invite is matched on their address when they do. The account's
// Gmail exists to mail security desks and nothing else (docs/SECURITY.md).
// ---------------------------------------------------------------------------
import { requireAdmin, requireOwner, requirePlatformOwner } from "./auth.js";
import {
  setAccountMail, readAccountMail, clearAccountMail, recordMailCheck, forgetAccountTransport,
} from "../../mail/account.js";
import {
  listMembers, inviteMember, listInvites, revokeInvite, removeMember,
  renameAccount, addApproval, removeApproval, listApprovals, normalizeEmail,
} from "../../repo/accounts.js";

const emailish = { type: "string", minLength: 3, maxLength: 320, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" };
const errorOut = { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } };
const memberOut = {
  type: "object",
  properties: {
    userId: { type: "string" }, email: { type: "string" },
    name: { type: ["string", "null"] }, role: { type: "string" }, since: { type: "string" },
  },
};

export async function registerAccount(app) {
  const client = app.db.client;
  const admin = requireAdmin(app);
  const owner = requireOwner(app);
  const siteOwner = requirePlatformOwner(app);

  app.patch("/account", {
    onRequest: owner,
    schema: {
      body: { type: "object", required: ["name"], additionalProperties: false,
        properties: { name: { type: "string", minLength: 1, maxLength: 120 } } },
      response: { 200: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
    },
  }, async (req) => renameAccount(client, req.accountId, req.body.name.trim()));

  // --- co-hosts -------------------------------------------------------------

  app.get("/members", {
    onRequest: admin,
    schema: {
      response: { 200: { type: "object", properties: {
        members: { type: "array", items: memberOut },
        invites: { type: "array", items: { type: "object", properties: {
          id: { type: "string" }, email: { type: "string" }, at: { type: "string" } } } },
      } } },
    },
  }, async (req) => ({
    members: await listMembers(client, req.accountId),
    invites: await listInvites(client, req.accountId),
  }));

  app.post("/members", {
    onRequest: owner,
    schema: {
      body: { type: "object", required: ["email"], additionalProperties: false, properties: { email: emailish } },
      response: {
        201: { type: "object", properties: {
          email: { type: "string" }, joined: { type: "boolean" }, message: { type: "string" } } },
        400: errorOut,
      },
    },
  }, async (req, reply) => {
    const email = normalizeEmail(req.body.email);
    if (email === req.actorEmail) {
      return reply.code(400).send({ error: "self", message: "That is your own address." });
    }
    const res = await inviteMember(client, { accountId: req.accountId, email, invitedBy: req.userId });
    if (!res.ok) {
      return reply.code(400).send({ error: res.reason, message: "That person already has access." });
    }
    req.log.info({ account: req.accountId }, "co-host invited");
    return reply.code(201).send({
      email: res.email, joined: res.joined,
      message: res.joined
        ? "They have access now."
        : "Ask them to open the site and sign in with Google using that address.",
    });
  });

  app.delete("/members/:id", {
    onRequest: owner,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 404: errorOut },
    },
  }, async (req, reply) => {
    if (req.params.id === req.userId) {
      return reply.code(404).send({ error: "not_found", message: "You cannot remove yourself." });
    }
    const gone = await removeMember(client, { accountId: req.accountId, userId: req.params.id });
    if (!gone) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.delete("/invites/:id", {
    onRequest: owner,
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 404: errorOut },
    },
  }, async (req, reply) => {
    const gone = await revokeInvite(client, { accountId: req.accountId, id: req.params.id });
    if (!gone) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // --- the account's sending Gmail -----------------------------------------
  // The host's own mailbox, so security desks see mail from the person they
  // deal with. Owner-only: it decides which mailbox guests' IDs leave from.

  const mailOut = {
    type: ["object", "null"],
    properties: {
      fromEmail: { type: "string" }, smtpUser: { type: "string" },
      verifiedAt: { type: ["string", "null"] }, lastError: { type: ["string", "null"] },
      updatedAt: { type: "string" },
    },
  };

  app.get("/mail", { onRequest: admin, schema: { response: { 200: mailOut } } },
    async (req) => readAccountMail(client, req.accountId));

  app.put("/mail", {
    onRequest: owner,
    schema: {
      body: { type: "object", required: ["fromEmail", "appPassword"], additionalProperties: false,
        properties: { fromEmail: emailish, appPassword: { type: "string", minLength: 12, maxLength: 200 } } },
      response: { 200: mailOut, 503: errorOut },
    },
  }, async (req, reply) => {
    if (!app.fileKey) {
      return reply.code(503).send({ error: "no_key", message: "This server has no encryption key set, so a password cannot be stored." });
    }
    // One address: Gmail will not let you send as anyone else anyway.
    const saved = await setAccountMail(client, req.accountId,
      { fromEmail: req.body.fromEmail, smtpUser: req.body.fromEmail, smtpPass: req.body.appPassword }, app.fileKey);
    forgetAccountTransport(req.accountId);
    req.log.info({ account: req.accountId }, "sending gmail set");
    return saved;
  });

  app.delete("/mail", {
    onRequest: owner,
    schema: { response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 404: errorOut } },
  }, async (req, reply) => {
    const gone = await clearAccountMail(client, req.accountId);
    if (!gone) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  /**
   * Prove it works before a guest's passport depends on it: a real email to
   * the host's own address, nobody else's.
   */
  app.post("/mail/test", {
    onRequest: owner,
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    schema: { response: {
      200: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } },
      400: errorOut, 404: errorOut } },
  }, async (req, reply) => {
    const settings = await readAccountMail(client, req.accountId);
    if (!settings) return reply.code(404).send({ error: "not_configured", message: "Connect a Gmail first." });
    const mail = await app.mailFor(req.accountId);
    try {
      await mail.transport.send({
        from: mail.from, to: settings.fromEmail,
        subject: "GatePass test email",
        body: "This is GatePass checking that it can send from your Gmail.\n\n"
          + "If you are reading this, guest IDs will reach your societies' security desks from this address.",
        attachments: [],
      });
      await recordMailCheck(client, req.accountId, { ok: true });
      return { ok: true, message: `Sent to ${settings.fromEmail}. Check that inbox.` };
    } catch (e) {
      await recordMailCheck(client, req.accountId, { ok: false, error: e.message });
      // Gmail's own wording is unhelpful; name the usual cause.
      const hint = /535|Username and Password not accepted|BadCredentials/i.test(e.message)
        ? "Gmail rejected the password. Use a 16-character App Password, not your normal password, and make sure 2-Step Verification is on."
        : e.message;
      return reply.code(400).send({ error: "send_failed", message: hint });
    }
  });

  // --- who may start an account (the site owner only) -----------------------

  app.get("/approvals", {
    onRequest: siteOwner,
    schema: { response: { 200: { type: "object", properties: {
      rows: { type: "array", items: { type: "object", properties: {
        email: { type: "string" }, note: { type: ["string", "null"] }, at: { type: "string" } } } } } } } },
  }, async () => ({ rows: await listApprovals(client) }));

  app.post("/approvals", {
    onRequest: siteOwner,
    schema: {
      body: { type: "object", required: ["email"], additionalProperties: false,
        properties: { email: emailish, note: { type: "string", maxLength: 200 } } },
      response: { 201: { type: "object", properties: { email: { type: "string" }, note: { type: ["string", "null"] } } } },
    },
  }, async (req, reply) => {
    const row = await addApproval(client, { email: req.body.email, note: req.body.note || null, addedBy: req.userId });
    req.log.info({ email: row.email }, "address approved to start an account");
    return reply.code(201).send(row);
  });

  app.delete("/approvals/:email", {
    onRequest: siteOwner,
    schema: {
      params: { type: "object", required: ["email"], properties: { email: { type: "string", maxLength: 320 } } },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } }, 404: errorOut },
    },
  }, async (req, reply) => {
    // Their existing account stays; this only stops a new one being started.
    const gone = await removeApproval(client, req.params.email);
    if (!gone) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Changing a booking. Admin-only for now; Phase 3 gives the guest routes their
// own token-scoped versions of the people and document endpoints.
// ---------------------------------------------------------------------------
import { requireAdmin } from "./auth.js";
import { AUTOMATION } from "../../../../shared/rules.js";
import {
  setAdultCount, renamePerson, putDocument, removeDocument, setAutomation, sendBooking,
} from "../../repo/bookingWrites.js";

const id64 = { type: "string", maxLength: 64 };
const params = (...names) => ({
  type: "object", required: names,
  properties: Object.fromEntries(names.map((n) => [n, id64])),
});
const okOut = { type: "object", additionalProperties: true, properties: { ok: { type: "boolean" } } };
const errOut = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
};

// One place that turns a repository refusal into an HTTP answer, so every
// route says the same thing about the same situation.
const REFUSALS = {
  not_found: [404, "That booking no longer exists."],
  no_person: [404, "That guest is not on this booking."],
  no_document: [404, "There is no ID to remove."],
  no_society: [409, "This listing has no society, so there is nowhere to send."],
  window_closed: [409, "This booking is past its window — the ID files have been deleted."],
  files_deleted: [409, "The ID files have been deleted, so this cannot be resent."],
  incomplete: [409, "Not every adult has an ID yet."],
  conflict: [409, "This booking has a sync conflict. Fix it on Airbnb first."],
  empty_name: [400, "A name cannot be empty."],
  name_too_long: [400, "That name is too long."],
  mail_not_configured: [503, "Email is not configured yet, so nothing was sent."],
  no_documents: [409, "There are no ID files to attach."],
  file_deleted: [409, "An ID file has been deleted, so it cannot be attached."],
  file_missing: [500, "An ID file is missing from storage. Nothing was sent."],
  undecryptable: [500, "An ID file could not be decrypted. Nothing was sent."],
  too_large: [413, "The ID files are too large for the mail provider."],
};
function refuse(reply, res) {
  const [status, message] = REFUSALS[res.reason] || [400, "That could not be done."];
  return reply.code(status).send({ error: res.reason, message: res.message || message });
}

export async function registerBookingActions(app) {
  const admin = requireAdmin(app);
  const client = app.db.client;

  app.post("/bookings/:id/people", {
    onRequest: admin,
    schema: {
      params: params("id"),
      body: { type: "object", required: ["adults"], additionalProperties: false,
              properties: { adults: { type: "integer", minimum: 1, maximum: 30 } } },
      response: { 200: okOut, 400: errOut, 404: errOut, 409: errOut },
    },
  }, async (req, reply) => {
    const res = await setAdultCount(client, req.params.id, req.body.adults, { actor: "admin" });
    if (!res.ok) return refuse(reply, res);
    // `blocked` means some could not be removed because their ID is already in.
    return { ok: true, adults: res.adults, blocked: res.blocked };
  });

  app.patch("/bookings/:id/people/:personId", {
    onRequest: admin,
    schema: {
      params: params("id", "personId"),
      body: { type: "object", required: ["name"], additionalProperties: false,
              properties: { name: { type: "string", minLength: 1, maxLength: 120 } } },
      response: { 200: okOut, 400: errOut, 404: errOut, 409: errOut },
    },
  }, async (req, reply) => {
    const res = await renamePerson(client, req.params.id, req.params.personId, req.body.name, { actor: "admin" });
    if (!res.ok) return refuse(reply, res);
    return { ok: true, changed: res.changed };
  });

  app.put("/bookings/:id/people/:personId/document", {
    onRequest: admin,
    schema: {
      params: params("id", "personId"),
      body: { type: "object", required: ["docType"], additionalProperties: false,
              properties: { docType: { type: "string", minLength: 1, maxLength: 60 } } },
      response: { 200: okOut, 400: errOut, 404: errOut, 409: errOut },
    },
  }, async (req, reply) => {
    // Phase 3 attaches the bytes; this records what kind of ID is held.
    const res = await putDocument(client, req.params.id, req.params.personId,
      { docType: req.body.docType, actor: "admin" });
    if (!res.ok) return refuse(reply, res);
    return { ok: true, replaced: res.replaced };
  });

  app.delete("/bookings/:id/people/:personId/document", {
    onRequest: admin,
    schema: { params: params("id", "personId"), response: { 200: okOut, 404: errOut, 409: errOut } },
  }, async (req, reply) => {
    const res = await removeDocument(client, req.params.id, req.params.personId, { actor: "admin" });
    if (!res.ok) return refuse(reply, res);
    return { ok: true };
  });

  app.patch("/bookings/:id/automation", {
    onRequest: admin,
    schema: {
      params: params("id"),
      body: { type: "object", required: ["automation"], additionalProperties: false,
              properties: { automation: { type: "string", enum: [...AUTOMATION] } } },
      response: { 200: okOut, 404: errOut },
    },
  }, async (req, reply) => {
    const res = await setAutomation(client, req.params.id, req.body.automation, { actor: "admin" });
    if (!res.ok) return refuse(reply, res);
    return { ok: true, changed: res.changed };
  });

  /**
   * Send, or resend, the security email.
   *
   * Returns 503 while no mail transport is configured — deliberately. Marking a
   * booking "Sent" when nothing left would be worse than refusing: the host
   * would stop chasing, and the guest would be held at the gate.
   */
  app.post("/bookings/:id/send", {
    onRequest: admin,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { params: params("id"), response: { 200: okOut, 400: errOut, 404: errOut, 409: errOut, 503: errOut } },
  }, async (req, reply) => {
    const res = await sendBooking(client, req.params.id, app.mail, {
      actor: "admin", mailFrom: app.config.mail.from,
      files: app.files, fileKey: app.fileKey,
      maxAttachmentBytes: app.config.mail.maxAttachmentBytes,
    });
    if (!res.ok) {
      if (res.reason !== "mail_not_configured") {
        req.log.warn({ booking: req.params.id, reason: res.reason }, "send refused");
      }
      return refuse(reply, res);
    }
    req.log.info({ booking: req.params.id, resend: res.resend, attachments: res.attachments }, "security email sent");
    return { ok: true, resend: res.resend, attachments: res.attachments };
  });
}

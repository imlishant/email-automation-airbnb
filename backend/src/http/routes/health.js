// Liveness. Render polls this, and so does the keep-warm ping. It must be
// cheap, must not touch personal data, and must not reveal whether a passcode
// is configured.
export async function registerHealth(app) {
  app.get("/healthz", {
    config: { rateLimit: false },     // a health check must not rate-limit itself out
    schema: {
      response: {
        200: {
          type: "object",
          properties: { ok: { type: "boolean" }, db: { type: "boolean" }, uptime: { type: "number" } },
        },
      },
    },
  }, async (req, reply) => {
    let dbOk = false;
    try {
      await app.db.client.execute("SELECT 1");
      dbOk = true;
    } catch (e) {
      req.log.error({ err: e }, "health: database unreachable");
    }
    return reply.code(dbOk ? 200 : 503).send({ ok: dbOk, db: dbOk, uptime: Math.round(process.uptime()) });
  });
}

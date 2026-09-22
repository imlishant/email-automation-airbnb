// ---------------------------------------------------------------------------
// Server-Sent Events: one long-lived connection per open tab, told when a
// booking changes so the page refreshes itself. Replaces "switch tabs to see
// the new count" (docs/DECISIONS.md, "Who sets the adult count").
//
// SSE rather than WebSockets because the traffic is one-way.
//
// Two streams, scoped like the rest of the API:
//   /api/events        admin session — every booking
//   /u/:token/events   a guest's link — THEIR booking only, filtered here
// ---------------------------------------------------------------------------
import { bus } from "../../events.js";
import { verifySession, COOKIE } from "../session.js";
import { bookingIdForToken } from "../../repo/guestLinks.js";

// Proxies (Render's included) close an idle connection. A comment line every
// 25s keeps it open without sending anything a client acts on.
const HEARTBEAT_MS = 25_000;

function openStream(req, reply, { filter }) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",          // stop a proxy buffering the stream
    "referrer-policy": "no-referrer",
  });
  res.write(": connected\n\n");

  const onChange = (event) => {
    if (!filter(event)) return;
    // An id and nothing else. The client re-fetches through the API.
    res.write(`event: change\ndata: ${JSON.stringify({ bookingId: event.bookingId })}\n\n`);
  };
  bus.on("change", onChange);
  const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

  const close = () => { clearInterval(beat); bus.off("change", onChange); };
  req.raw.on("close", close);
  res.on("error", close);
}

export async function registerEvents(app) {
  const client = app.db.client;

  app.get("/api/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!verifySession(req.cookies?.[COOKIE], app.sessionSecret).ok) {
      return reply.code(401).send({ error: "unauthorised" });
    }
    openStream(req, reply, { filter: () => true });
  });

  app.get("/u/:token/events", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const bookingId = await bookingIdForToken(client, req.params.token, app.guestSecret);
    if (!bookingId) return reply.code(404).send({ error: "link_not_active" });
    // A guest hears about their own booking and nothing else — not even that
    // another booking exists.
    openStream(req, reply, { filter: (e) => e.bookingId === bookingId });
  });
}

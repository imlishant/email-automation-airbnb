// ---------------------------------------------------------------------------
// "Something changed" notifications, for live updates over SSE.
//
// Deliberately carries NO data — only a booking id. A client that hears about
// a change re-fetches through the normal authenticated API. So the stream can
// never leak a name or a document to anyone, even a subscriber it should not
// have: the worst it reveals is that some booking changed.
//
// In-process, because there is one instance. With more than one instance this
// becomes a pub/sub; that trigger is written in docs/TECH_STACK.md §9.
// ---------------------------------------------------------------------------
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(200);   // one per open tab; generous for one host

// accountId, when known, keeps the nudge to the host it concerns. Null means
// "some booking changed somewhere", which is all a broadcast ever reveals.
export function bookingChanged(bookingId, accountId = null) {
  if (bookingId) bus.emit("change", { bookingId, accountId });
}
export function listChanged(accountId = null) {
  bus.emit("change", { bookingId: null, accountId });
}

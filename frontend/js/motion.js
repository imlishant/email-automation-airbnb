// ---------------------------------------------------------------------------
// Motion.
//
// The problem this file exists to solve: an element removed from the DOM
// cannot animate, because it is already gone. So anything leaving is kept
// mounted, marked `data-state="closing"`, and removed only once its exit
// animation has finished. That is the whole idea — everything else here is
// bookkeeping around it.
//
// The curves and durations live in css/styles.css as custom properties and are
// READ FROM THERE, so the timings can never drift apart from the animations
// they are timing. Change a duration in one place.
//
// Rules this file keeps (docs/DESIGN.md):
//   - only transform and opacity are ever animated;
//   - everything that appears also disappears, visibly;
//   - under prefers-reduced-motion, exits resolve immediately and nothing
//     waits on an animation that will not play.
// ---------------------------------------------------------------------------

const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
/** Live, not read once: someone can change the setting with the tab open. */
export const prefersReduced = () => Boolean(reduced?.matches);

/** A duration from the stylesheet, in milliseconds. "190ms" -> 190. */
function cssDuration(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}
export const ENTER = () => cssDuration("--dur-enter", 260);
export const EXIT = () => cssDuration("--dur-exit", 190);

/** Mark an element as present. CSS does the entering. */
export function enter(el) {
  if (!el) return;
  el.removeAttribute("aria-hidden");
  el.dataset.state = "open";
}

/**
 * Animate an element out and resolve when it is finished — still mounted, so
 * the caller decides whether to remove it, re-render over it, or reopen it.
 *
 * While closing it takes no clicks and is hidden from assistive technology:
 * it is on screen only to finish a gesture, and is not content any more.
 */
export function leave(el) {
  if (!el) return Promise.resolve();
  if (prefersReduced()) { el.dataset.state = "closed"; return Promise.resolve(); }
  el.dataset.state = "closing";
  el.setAttribute("aria-hidden", "true");
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // The animation's own end event, with a timer as the backstop: a tab in
    // the background may never fire it, and a promise that never resolves
    // would strand the element on screen for ever.
    el.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, EXIT() + 60);
  });
}

/** Animate out, then remove. The common case for an overlay. */
export async function leaveAndRemove(el) {
  if (!el) return;
  await leave(el);
  el.remove();
}

// --- elements that appear inside a re-render --------------------------------
// The app re-renders a whole screen on every change, including changes pushed
// from the server. So "this element is new" cannot be read from the DOM — a
// re-render replaces everything. Instead each animatable element carries
// data-anim="<key>", and we remember the keys a screen showed last time:
// anything whose key was not there is genuinely new and animates in. Without
// this, a guest uploading an ID would re-animate the entire page.

const seen = new Map();   // screen key -> Set of element keys

export function markNew(container, screenKey) {
  if (!container) return;
  const before = seen.get(screenKey);
  const now = new Set();
  for (const el of container.querySelectorAll("[data-anim]")) {
    const key = el.dataset.anim;
    now.add(key);
    if (prefersReduced()) continue;
    // First ever paint of a screen animates as a whole (see animateScreen),
    // so individual elements stay still rather than firing twice.
    if (before && !before.has(key)) el.classList.add(el.dataset.animStyle === "pop" ? "m-pop" : "m-in");
  }
  seen.set(screenKey, now);
}

/** Fresh screen: animate the whole thing once, and forget what it held. */
export function animateScreen(el, screenKey, changed) {
  if (!el || !changed || prefersReduced()) return;
  seen.delete(screenKey);
  el.classList.remove("m-screen");
  // Reading offsetWidth restarts the animation; without it the class is
  // removed and re-added within one frame and nothing plays.
  void el.offsetWidth;
  el.classList.add("m-screen");
}

// --- programmatic scrolling -------------------------------------------------

let gliding = null;

/**
 * Move the page with the same curve as everything else, and get out of the
 * way the instant the reader touches anything: a page that keeps scrolling
 * under your finger feels broken, however pretty the easing.
 */
export function glideTo(y = 0) {
  const start = window.scrollY;
  const distance = y - start;
  if (prefersReduced() || Math.abs(distance) < 2) { window.scrollTo(0, y); return; }

  if (gliding) gliding.cancel();
  const duration = ENTER();
  const t0 = performance.now();
  let cancelled = false;
  const stop = () => { cancelled = true; detach(); };
  const events = ["wheel", "touchstart", "pointerdown", "keydown"];
  const detach = () => events.forEach((e) => window.removeEventListener(e, stop));
  events.forEach((e) => window.addEventListener(e, stop, { passive: true, once: true }));
  gliding = { cancel: stop };

  const step = (now) => {
    if (cancelled) return;
    const t = Math.min(1, (now - t0) / duration);
    window.scrollTo(0, start + distance * easeOut(t));
    if (t < 1) requestAnimationFrame(step); else detach();
  };
  requestAnimationFrame(step);
}

/** cubic-bezier(.32,.72,0,1), the same curve as --ease-out, sampled. */
function easeOut(t) {
  // Newton's method on the x component, then read y. Cheap, and it means the
  // scroll and the CSS animations are genuinely the same motion.
  const cx = (u) => 3 * u * (1 - u) * (1 - u) * 0.32 + 3 * u * u * (1 - u) * 0.72 + u * u * u;
  const cy = (u) => 3 * u * u * (1 - u) * 1 + u * u * u;
  let u = t;
  for (let i = 0; i < 5; i++) {
    const x = cx(u) - t;
    const dx = 3 * (1 - u) * (1 - u) * 0.32 + 6 * u * (1 - u) * (0.72 - 0.32) + 3 * u * u * (1 - 0.72);
    if (Math.abs(dx) < 1e-6) break;
    u -= x / dx;
  }
  return cy(Math.min(1, Math.max(0, u)));
}

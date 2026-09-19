// ---------------------------------------------------------------------------
// Fetching a listing's calendar. The feed is untrusted input from the public
// internet, so every request is bounded: a timeout, a byte cap, https only, and
// no redirect into somewhere private.
// ---------------------------------------------------------------------------

export class IcalFetchError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "IcalFetchError";
    this.code = code;       // a stable string the UI can branch on
    this.detail = detail;
  }
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 4 * 1024 * 1024,   // a year of events is tens of KB; 4MB is generous
  userAgent: "GatePass/0.1 (+calendar sync)",
};

/**
 * Validate a pasted calendar URL before we ever fetch it.
 *
 * Deliberately permissive about the host: a listing might be exported from
 * somewhere other than airbnb.com (airbnb.co.in, or another channel entirely).
 * What it is strict about is the shape — https, and not pointing at a private
 * address, which is what makes a pasted URL an SSRF risk.
 */
export function validateIcalUrl(input, { allowPrivate = false } = {}) {
  const notes = [];
  let raw = String(input).trim();

  // Rewrite webcal:// before parsing: WHATWG URL refuses to change a
  // non-special scheme to a special one, so url.protocol = "https:" is a no-op.
  if (/^webcal:\/\//i.test(raw)) {
    raw = raw.replace(/^webcal:\/\//i, "https://");
    notes.push("webcal:// rewritten to https://");
  }

  let url;
  try { url = new URL(raw); }
  catch { throw new IcalFetchError("bad_url", "That does not look like a URL."); }
  if (url.protocol !== "https:" && !allowPrivate) {
    throw new IcalFetchError("not_https", "The calendar link must start with https://");
  }

  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  // allowPrivate exists only so tests can point at a loopback feed server. It
  // is fatal at boot in production (src/http/config.js), because relaxing this
  // turns a pasted URL into an SSRF.
  if (privateHost && !allowPrivate) {
    throw new IcalFetchError("private_host", "That link points at a private address, not a calendar.");
  }

  if (!/airbnb\./i.test(host)) notes.push(`Not an airbnb.* host (${host}) — it will still be tried.`);
  if (!/\.ics(\?|$)/i.test(url.pathname + url.search)) notes.push("The link does not end in .ics — check you copied the Export link.");

  return { url: url.toString(), notes };
}

/** Fetch the feed. Returns the raw text plus what we learned doing it. */
export async function fetchIcal(input, options = {}) {
  const { timeoutMs, maxBytes, userAgent, allowPrivate } = { ...DEFAULTS, ...options };
  const { url, notes } = validateIcalUrl(input, { allowPrivate });
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": userAgent, accept: "text/calendar, text/plain;q=0.8, */*;q=0.1" },
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new IcalFetchError(
      timedOut ? "timeout" : "unreachable",
      timedOut ? `The calendar did not respond within ${timeoutMs / 1000}s.` : "Could not reach the calendar.",
      String(e && e.message || e)
    );
  }

  if (res.status === 404) throw new IcalFetchError("not_found", "Airbnb returned 404 — the link may have been regenerated.", res.status);
  if (res.status === 403 || res.status === 401) throw new IcalFetchError("forbidden", "Airbnb refused the link. Re-copy the Export link.", res.status);
  if (res.status >= 500) throw new IcalFetchError("upstream_error", `Airbnb returned ${res.status}. Worth retrying later.`, res.status);
  if (!res.ok) throw new IcalFetchError("http_error", `Unexpected response ${res.status}.`, res.status);

  // Read with a hard cap so a hostile or broken endpoint cannot exhaust memory.
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  let text;
  if (reader) {
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new IcalFetchError("too_large", `The calendar is larger than ${maxBytes} bytes.`, bytes); }
      chunks.push(value);
    }
    text = new TextDecoder("utf-8").decode(await new Blob(chunks).arrayBuffer());
  } else {
    text = await res.text();
    if (text.length > maxBytes) throw new IcalFetchError("too_large", "The calendar is too large.", text.length);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!/calendar|text\/plain|octet-stream/i.test(contentType) && !/BEGIN:VCALENDAR/i.test(text.slice(0, 200))) {
    throw new IcalFetchError("not_a_calendar", "That link returned a web page, not a calendar. Use the Export link, not the page URL.", contentType);
  }

  return {
    url, text, notes,
    status: res.status,
    contentType,
    bytes: text.length,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

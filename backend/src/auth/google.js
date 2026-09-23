// ---------------------------------------------------------------------------
// Sign in with Google (OAuth 2.0 authorization code flow, with PKCE).
//
// Google is the only thing that proves someone owns an email address, and it
// costs nothing. The alternative — emailing sign-in links — would mean the
// host's Gmail sending mail to strangers, which docs/SECURITY.md forbids: that
// mailbox exists to mail security desks and nothing else.
//
// Only the identity scopes are asked for: "openid email profile". No access to
// anyone's mailbox, calendar or files, and nothing is stored but the address
// and display name. The tokens Google returns are used once, here, and thrown
// away; there is no refresh token and nothing to leak later.
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const SCOPES = "openid email profile";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** The random pair that ties a callback to the browser that started it. */
export function newHandshake() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()), state: b64u(randomBytes(16)) };
}

export function authUrl({ clientId, redirectUri, state, challenge, loginHint }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Always show the chooser: many hosts have several Google accounts, and
    // silently reusing the wrong one is how people end up in the wrong place.
    prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH_ENDPOINT}?${p}`;
}

/** The claims we keep, read from the ID token Google just handed us. */
export function readIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
  if (!claims?.email) return null;
  return {
    email: String(claims.email).toLowerCase(),
    // Google sets this false for some Workspace setups; an unverified address
    // proves nothing, so it is refused upstream.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name || claims.given_name || null,
    sub: claims.sub || null,
  };
}

/**
 * Swap the one-time code for the ID token. The response comes straight from
 * Google over TLS in reply to our own request carrying the client secret, so
 * its claims are trusted without a second signature check — the same reasoning
 * Google's own server-flow guidance gives.
 */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, verifier, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error_description || ""; } catch { /* body is not json */ }
    return { ok: false, status: res.status, message: detail || `Google refused the sign-in (${res.status})` };
  }
  const body = await res.json();
  const identity = readIdToken(body.id_token);
  if (!identity) return { ok: false, message: "Google's reply carried no usable identity" };
  if (!identity.emailVerified) return { ok: false, message: "That Google account's email is not verified" };
  return { ok: true, identity };
}

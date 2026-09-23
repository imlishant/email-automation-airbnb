// ---------------------------------------------------------------------------
// Everything the server reads from the environment, in one place, validated at
// boot. A misconfiguration should stop the process with a clear message, not
// surface as a mysterious 500 three hours later.
// ---------------------------------------------------------------------------
import { RULES } from "../../../shared/rules.js";

const num = (v, d) => (v && /^\d+$/.test(v) ? Number(v) : d);
const bool = (v, d) => (v === undefined ? d : v === "true" || v === "1");

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const cfg = {
    production,
    port: num(env.PORT, 8080),
    host: env.HOST || "0.0.0.0",
    baseUrl: (env.APP_BASE_URL || `http://localhost:${num(env.PORT, 8080)}`).replace(/\/$/, ""),
    corsOrigins: (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    database: { url: env.DATABASE_URL || "file:./data/gatepass.db", authToken: env.DATABASE_AUTH_TOKEN || null },
    session: { secret: env.SESSION_SECRET || null, ttlHours: num(env.SESSION_TTL_HOURS, 24 * 14) },
    // Independent of the session secret ON PURPOSE. Rotating SESSION_SECRET is
    // the emergency "log every admin out" control; it must not also kill every
    // guest link already sent to people standing at gates.
    guestSecret: env.GUEST_TOKEN_SECRET || null,
    // The person who runs this deployment: they approve who may start an
    // account, and they inherit the data from before accounts existed.
    platformOwnerEmail: (env.PLATFORM_OWNER_EMAIL || env.OWNER_EMAIL || "").trim().toLowerCase() || null,
    google: {
      clientId: (env.GOOGLE_CLIENT_ID || "").trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET || "").trim(),
    },
    // Development only: sign in by typing an address, with no Google app set
    // up. Refused in production, where it would be a way past sign-in.
    devLogin: bool(env.DEV_LOGIN, !production),
    jobs: { tickSecret: env.JOBS_TICK_SECRET || null },
    times: {
      checkIn: env.DEFAULT_CHECK_IN_TIME || RULES.defaultCheckInTime,
      checkOut: env.DEFAULT_CHECK_OUT_TIME || RULES.defaultCheckOutTime,
    },
    rateLimits: {
      authPerMinute: num(env.RATE_LIMIT_AUTH_PER_MINUTE, 10),
      guestPerMinute: num(env.RATE_LIMIT_GUEST_PER_MINUTE, 30),
      globalPerMinute: num(env.RATE_LIMIT_GLOBAL_PER_MINUTE, 300),
      // Each request sends an email, so this one is tight.
      ownerLinkPer10Min: num(env.RATE_LIMIT_OWNER_LINK_PER_10MIN, 3),
    },
    mail: {
      // "recording" is for tests and local work only; it records instead of
      // sending, and never claims a booking was sent.
      transport: env.MAIL_TRANSPORT || (env.SMTP_HOST ? "smtp" : "none"),
      from: env.MAIL_FROM || "",
      replyTo: env.MAIL_REPLY_TO || "",
      host: env.SMTP_HOST || "", user: env.SMTP_USER || "", pass: env.SMTP_PASS || "",
      port: num(env.SMTP_PORT, 587),
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: num(env.SMTP_PORT, 587) === 465,
      // Tests only, against a local sink. Fatal in production: it would allow
      // a passport to cross the network in plaintext.
      ignoreTLS: bool(env.SMTP_IGNORE_TLS, false),
      maxAttachmentBytes: num(env.MAIL_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024),
    },
    // Tests only: lets the calendar fetcher reach a loopback feed server.
    icalAllowPrivateHosts: bool(env.ICAL_ALLOW_PRIVATE_HOSTS, false),
    storage: {
      // Production defaults to the database; development to a local folder.
      driver: env.STORAGE_DRIVER || (production ? "db" : "local"),
      uploadDir: env.UPLOAD_DIR || "./data/uploads",
      encryptionKey: env.FILE_ENCRYPTION_KEY || "",
      maxBytes: num(env.UPLOAD_MAX_BYTES, 8 * 1024 * 1024),
      allowedTypes: (env.UPLOAD_ALLOWED_TYPES || "image/jpeg,image/png,application/pdf")
        .split(",").map((s) => s.trim()).filter(Boolean),
      endpoint: env.S3_ENDPOINT || "", bucket: env.S3_BUCKET || "",
      accessKeyId: env.S3_ACCESS_KEY_ID || "", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "",
    },
    serveFrontend: bool(env.SERVE_FRONTEND, true),
    trustProxy: bool(env.TRUST_PROXY, production),   // Render terminates TLS upstream
  };

  // Refuse to start on a configuration that is unsafe rather than merely wrong.
  const fatal = [];
  if (production) {
    if (!cfg.session.secret || cfg.session.secret.length < 32) {
      fatal.push("SESSION_SECRET must be set to at least 32 characters in production");
    }
    if (!cfg.guestSecret || cfg.guestSecret.length < 32) {
      fatal.push("GUEST_TOKEN_SECRET must be set to at least 32 characters in production");
    }
    if (!cfg.jobs.tickSecret || cfg.jobs.tickSecret.length < 16) {
      // Without this, a public URL that runs jobs is open to anyone.
      fatal.push("JOBS_TICK_SECRET must be set to at least 16 characters in production");
    }
    if (!cfg.baseUrl.startsWith("https://")) {
      // Guest tokens travel in the URL. Over plain HTTP that is a token handed
      // to the network (docs/SECURITY.md).
      fatal.push("APP_BASE_URL must be https:// in production — guest tokens travel in the URL");
    }
  }
  if (production) {
    if (!cfg.storage.encryptionKey) {
      // Identity documents at rest, unencrypted, is not a thing we ship.
      fatal.push("FILE_ENCRYPTION_KEY must be set in production (openssl rand -base64 32)");
    }
    if (cfg.storage.driver === "local") {
      // Render's filesystem is ephemeral: every ID would vanish on deploy.
      fatal.push("STORAGE_DRIVER=local loses files on Render (its disk is wiped on restart) — use db");
    }
  }
  if (production) {
    // Sign-in is Google's job now; without an app registered, nobody can get in.
    if (!cfg.google.clientId || !cfg.google.clientSecret) {
      fatal.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in production — sign-in needs them");
    }
    if (!cfg.platformOwnerEmail) {
      fatal.push("PLATFORM_OWNER_EMAIL must be set in production — it says who approves new hosts");
    }
    if (cfg.devLogin) {
      fatal.push("DEV_LOGIN must not be set in production — it would let anyone sign in as anyone");
    }
  }
  if (production && cfg.icalAllowPrivateHosts) {
    // A pasted calendar URL that may reach private addresses is an SSRF.
    fatal.push("ICAL_ALLOW_PRIVATE_HOSTS must not be set in production");
  }
  if (production && cfg.mail.ignoreTLS) {
    fatal.push("SMTP_IGNORE_TLS must not be set in production — it would send IDs in plaintext");
  }
  if (production && cfg.mail.transport === "smtp" && !cfg.mail.from) {
    fatal.push("MAIL_FROM must be set when sending over SMTP");
  }
  if (production && cfg.mail.transport === "recording") {
    // It records instead of sending. In production that would mean bookings
    // marked "Sent" with nothing delivered.
    fatal.push("MAIL_TRANSPORT=recording is for development only");
  }
  if (!/^\d{2}:\d{2}$/.test(cfg.times.checkIn)) fatal.push("DEFAULT_CHECK_IN_TIME must be HH:MM");
  if (!/^\d{2}:\d{2}$/.test(cfg.times.checkOut)) fatal.push("DEFAULT_CHECK_OUT_TIME must be HH:MM");

  const warnings = [];
  if (!production && !cfg.session.secret) warnings.push("SESSION_SECRET not set; admin sessions end on restart");
  if (!production && !cfg.guestSecret) warnings.push("GUEST_TOKEN_SECRET not set; guest links are re-issued after every restart");
  if (cfg.mail.transport === "none") warnings.push("no mail transport configured — sending is refused, not faked");
  if (!cfg.storage.encryptionKey) warnings.push("FILE_ENCRYPTION_KEY not set — uploads will be refused");

  return { ...cfg, fatal, warnings };
}

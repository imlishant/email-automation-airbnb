// ---------------------------------------------------------------------------
// The automatic send.
//
// Two triggers, both from Derive.sendDue in shared/rules.js — the same test the
// UI uses, so the host is never told "auto-send will fire" about a booking that
// the scheduler disagrees about:
//
//   allids  fires the moment the last adult ID is in
//   before  fires an hour before check-in, even with IDs missing
//
// At-most-once is enforced by the DATABASE, not by care: a partial unique index
// allows one `send_booking` job per booking, ever. Emailing a passport twice is
// the failure this guards.
// ---------------------------------------------------------------------------
import { query, one, run, newId, nowIso } from "../db/client.js";
import { allAccountTimes } from "../repo/bookings.js";
import { loadForRules, sendBooking } from "../repo/bookingWrites.js";
import { Derive } from "../../../shared/rules.js";

const MAX_ATTEMPTS = 5;

/**
 * Bookings the scheduler should send now.
 *
 * Narrowed in SQL to what could possibly be due, then decided by `Derive` —
 * the same two-step as the list, for the same reason: the rule must be the one
 * the browser uses, and it depends on the host's check-in time.
 */
export async function findDueBookings(client, { now = Date.now() } = {}) {
  // One account's 2pm is another's 11am, so the times are looked up per
  // account rather than once for the deployment.
  const times = await allAccountTimes(client);
  const candidates = await query(client, `
    SELECT b.id, l.account_id FROM bookings b JOIN listings l ON l.id = b.listing_id
    WHERE b.sent_at IS NULL AND b.conflict = 0
      AND b.check_out >= date('now', '-2 day')`);

  const due = [];
  for (const row of candidates) {
    const settings = times.get(row.account_id);
    if (!settings) continue;
    const booking = await loadForRules(client, row.id);
    if (booking && Derive.sendDue(booking, settings, now)) due.push(booking);
  }
  return due;
}

/** Claim a booking for sending. Returns false if it was already claimed or sent. */
async function claim(client, bookingId) {
  const existing = await one(client,
    "SELECT id, attempts, completed_at FROM jobs WHERE kind = 'send_booking' AND subject_id = ?", [bookingId]);

  if (!existing) {
    try {
      await run(client, `INSERT INTO jobs (id,kind,subject_id,run_after,claimed_at,attempts,created_at)
        VALUES (?,'send_booking',?,?,?,1,?)`, [newId("job"), bookingId, nowIso(), nowIso(), nowIso()]);
      return { ok: true, attempts: 1 };
    } catch {
      // Another tick got there first. The unique index did its job.
      return { ok: false, reason: "already_claimed" };
    }
  }
  if (existing.completed_at) return { ok: false, reason: "already_sent" };
  if (existing.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "gave_up" };
  await run(client, "UPDATE jobs SET attempts = attempts + 1, claimed_at = ? WHERE id = ?", [nowIso(), existing.id]);
  return { ok: true, attempts: existing.attempts + 1, jobId: existing.id };
}

async function finish(client, bookingId, { error = null } = {}) {
  await run(client,
    `UPDATE jobs SET completed_at = ?, claimed_at = NULL, last_error = ?
     WHERE kind = 'send_booking' AND subject_id = ?`,
    [error ? null : nowIso(), error, bookingId]);
}

/**
 * Send everything that is due.
 *
 * A failure is left uncompleted so the next tick retries, up to MAX_ATTEMPTS —
 * a five-minute mail outage should not permanently drop a booking. After that
 * it stops and stays visible as unsent rather than retrying forever.
 */
export async function runDueSends(client, deps, { now = Date.now(), log = () => {} } = {}) {
  const due = await findDueBookings(client, { now });
  const results = [];

  for (const booking of due) {
    const claimed = await claim(client, booking.id);
    if (!claimed.ok) { results.push({ booking: booking.id, skipped: claimed.reason }); continue; }

    const mail = deps.mailFor
      ? await deps.mailFor(booking.accountId)
      : { transport: deps.transport, from: deps.mailFrom };
    const res = await sendBooking(client, booking.id, mail.transport, {
      actor: "system", auto: true,
      // Only the scheduled mode may send without every ID; "allids" cannot be
      // due unless the booking is already complete.
      allowIncomplete: booking.automation === "before",
      mailFrom: mail.from, files: deps.files, fileKey: deps.fileKey,
      maxAttachmentBytes: deps.maxAttachmentBytes,
    });

    if (res.ok) {
      await finish(client, booking.id);
      log(`auto-sent ${booking.code || booking.id} to ${res.to} (${res.attachments} file(s))`);
      results.push({ booking: booking.id, sent: true, to: res.to });
    } else {
      await finish(client, booking.id, { error: `${res.reason}: ${res.message || ""}`.trim() });
      // Written to the booking's own timeline, so the host sees WHY nothing
      // went rather than just noticing it never did.
      await run(client, "INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)",
        [newId("act"), booking.id, nowIso(), "send_failed", "system",
         `Automatic send did not go out: ${res.message || res.reason}`]);
      log(`auto-send failed for ${booking.code || booking.id}: ${res.reason}`);
      results.push({ booking: booking.id, sent: false, reason: res.reason, attempt: claimed.attempts });
    }
  }
  return results;
}

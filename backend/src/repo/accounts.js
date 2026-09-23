// ---------------------------------------------------------------------------
// People, accounts and who may open which.
//
// A user is an email address Google has vouched for. An account is one host's
// workspace. A membership joins the two, as 'owner' (the host) or 'admin' (a
// co-host or helper). Nothing here decides policy; the HTTP layer does. This
// file only records and reads the facts.
// ---------------------------------------------------------------------------
import { query as all, one, run, newId, nowIso } from "../db/client.js";

// Set by the HTTP layer so a membership change is never masked by its cache.
let onMembershipChange = () => {};
export const notifyMembershipChanges = (fn) => { onMembershipChange = fn; };

/** Emails are compared lowercased everywhere, so they are stored that way. */
export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

export async function findUserByEmail(client, email) {
  return one(client, "SELECT id, email, name FROM users WHERE email = ?", [normalizeEmail(email)]);
}

/**
 * The person signing in. Their name comes from Google and may change; the
 * email is the identity and never does.
 */
export async function upsertUser(client, { email, name }) {
  const addr = normalizeEmail(email);
  const at = nowIso();
  await run(client,
    `INSERT INTO users (id, email, name, created_at, last_seen_at) VALUES (?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name), last_seen_at = excluded.last_seen_at`,
    [newId("usr"), addr, name || null, at, at]);
  return findUserByEmail(client, addr);
}

export async function accountsForUser(client, userId) {
  return all(client,
    `SELECT a.id, a.name, m.role FROM memberships m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = ? ORDER BY a.created_at, a.rowid`, [userId]);
}

export async function membership(client, accountId, userId) {
  return one(client, "SELECT account_id, user_id, role FROM memberships WHERE account_id = ? AND user_id = ?",
    [accountId, userId]);
}

/** A new host's workspace: the account, its owner, and its own times. */
export async function createAccount(client, { name, ownerUserId, checkInTime, checkOutTime }) {
  const id = newId("acc"), at = nowIso();
  await run(client, "INSERT INTO accounts (id, name, created_at, updated_at) VALUES (?,?,?,?)", [id, name, at, at]);
  await run(client, "INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?,?,?,?)",
    [id, ownerUserId, "owner", at]);
  await run(client, "INSERT INTO account_settings (account_id, check_in_time, check_out_time, updated_at) VALUES (?,?,?,?)",
    [id, checkInTime, checkOutTime, at]);
  return { id, name, role: "owner" };
}

export async function renameAccount(client, accountId, name) {
  await run(client, "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?", [name, nowIso(), accountId]);
  return one(client, "SELECT id, name FROM accounts WHERE id = ?", [accountId]);
}

/** An account with no owner yet: the data this deployment had before accounts. */
export async function unclaimedAccount(client) {
  return one(client,
    `SELECT id, name FROM accounts WHERE NOT EXISTS
       (SELECT 1 FROM memberships WHERE memberships.account_id = accounts.id) ORDER BY rowid LIMIT 1`);
}

export async function addMember(client, { accountId, userId, role, invitedBy = null }) {
  await run(client,
    `INSERT INTO memberships (account_id, user_id, role, created_at, invited_by) VALUES (?,?,?,?,?)
     ON CONFLICT(account_id, user_id) DO NOTHING`,
    [accountId, userId, role, nowIso(), invitedBy]);
  onMembershipChange(accountId, userId);
  return membership(client, accountId, userId);
}

export async function removeMember(client, { accountId, userId }) {
  // The owner is never removable: an account without its host is unreachable.
  const res = await run(client, "DELETE FROM memberships WHERE account_id = ? AND user_id = ? AND role <> 'owner'",
    [accountId, userId]);
  onMembershipChange(accountId, userId);
  return res.rowsAffected > 0;
}

export async function listMembers(client, accountId) {
  return all(client,
    `SELECT u.id AS "userId", u.email, u.name, m.role, m.created_at AS "since"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.account_id = ? ORDER BY (m.role = 'owner') DESC, u.email`, [accountId]);
}

// --- invites ---------------------------------------------------------------
// No email is sent. The host tells the co-host "sign in with Google"; the
// invite is matched on their address when they do.

export async function inviteMember(client, { accountId, email, invitedBy }) {
  const addr = normalizeEmail(email);
  const existing = await one(client,
    `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.account_id = ? AND u.email = ?`, [accountId, addr]);
  if (existing) return { ok: false, reason: "already_member" };
  const user = await findUserByEmail(client, addr);
  // Someone who already has an account here needs no invite row.
  if (user) {
    await addMember(client, { accountId, userId: user.id, role: "admin", invitedBy });
    return { ok: true, joined: true, email: addr };
  }
  await run(client,
    `INSERT INTO invites (id, account_id, email, role, created_at, invited_by) VALUES (?,?,?,'admin',?,?)
     ON CONFLICT(account_id, email) WHERE accepted_at IS NULL DO NOTHING`,
    [newId("inv"), accountId, addr, nowIso(), invitedBy]);
  return { ok: true, joined: false, email: addr };
}

export async function listInvites(client, accountId) {
  return all(client, `SELECT id, email, created_at AS "at" FROM invites
    WHERE account_id = ? AND accepted_at IS NULL ORDER BY created_at DESC, rowid DESC`, [accountId]);
}

export async function revokeInvite(client, { accountId, id }) {
  const res = await run(client, "DELETE FROM invites WHERE account_id = ? AND id = ? AND accepted_at IS NULL",
    [accountId, id]);
  return res.rowsAffected > 0;
}

/** Turn every pending invite for this address into a membership. */
export async function acceptInvites(client, user) {
  const pending = await all(client,
    "SELECT id, account_id AS \"accountId\", invited_by AS \"invitedBy\" FROM invites WHERE email = ? AND accepted_at IS NULL",
    [user.email]);
  for (const inv of pending) {
    await addMember(client, { accountId: inv.accountId, userId: user.id, role: "admin", invitedBy: inv.invitedBy });
    await run(client, "UPDATE invites SET accepted_at = ? WHERE id = ?", [nowIso(), inv.id]);
  }
  return pending.length;
}

// --- who may start an account ---------------------------------------------

export async function isApproved(client, email) {
  return Boolean(await one(client, "SELECT email FROM approvals WHERE email = ?", [normalizeEmail(email)]));
}

export async function addApproval(client, { email, note = null, addedBy = null }) {
  const addr = normalizeEmail(email);
  await run(client,
    `INSERT INTO approvals (email, note, added_at, added_by) VALUES (?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET note = excluded.note`,
    [addr, note, nowIso(), addedBy]);
  return { email: addr, note };
}

export async function removeApproval(client, email) {
  const res = await run(client, "DELETE FROM approvals WHERE email = ?", [normalizeEmail(email)]);
  return res.rowsAffected > 0;
}

export async function listApprovals(client) {
  return all(client, `SELECT email, note, added_at AS "at" FROM approvals ORDER BY added_at DESC, rowid DESC`);
}

// --- per-account settings --------------------------------------------------

export async function accountTimes(client, accountId) {
  return one(client,
    `SELECT check_in_time AS "checkInTime", check_out_time AS "checkOutTime" FROM account_settings WHERE account_id = ?`,
    [accountId]);
}

export async function setAccountTimes(client, accountId, { checkInTime, checkOutTime }) {
  const sets = [], args = [];
  if (checkInTime) { sets.push("check_in_time = ?"); args.push(checkInTime); }
  if (checkOutTime) { sets.push("check_out_time = ?"); args.push(checkOutTime); }
  if (!sets.length) return accountTimes(client, accountId);
  sets.push("updated_at = ?"); args.push(nowIso(), accountId);
  await run(client, `UPDATE account_settings SET ${sets.join(", ")} WHERE account_id = ?`, args);
  return accountTimes(client, accountId);
}

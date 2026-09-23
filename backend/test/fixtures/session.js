// ---------------------------------------------------------------------------
// Signing a test in.
//
// Sign-in itself is Google's, and tests do not talk to Google. So a test gets
// its session the way the callback would: a user, an account they own, and a
// signed cookie. Everything downstream — the guards, the scoping, the role —
// is the real code.
// ---------------------------------------------------------------------------
import { COOKIE, issueSession } from "../../src/http/session.js";
import { upsertUser, createAccount, accountsForUser, addMember, acceptInvites } from "../../src/repo/accounts.js";

/**
 * @returns { cookie, accountId, userId } — `cookie` goes straight into
 *   inject({ headers: { cookie } }).
 */
export async function signIn(app, {
  email = "host@example.com", name = "Test Host", role = "owner",
  accountId = null, accountName = "Test listings",
  checkInTime = "14:00", checkOutTime = "11:00",
} = {}) {
  const client = app.db.client;
  const user = await upsertUser(client, { email, name });
  // Signing in is where a pending invitation turns into access, so a test that
  // invites someone and then signs them in behaves like the real callback.
  await acceptInvites(client, user);

  let account;
  if (accountId) {
    account = { id: accountId, role };
    await addMember(client, { accountId, userId: user.id, role });
  } else {
    account = (await accountsForUser(client, user.id))[0]
      || await createAccount(client, { name: accountName, ownerUserId: user.id, checkInTime, checkOutTime });
  }

  const token = issueSession(app.sessionSecret, {
    ttlHours: 24, role: account.role || role, userId: user.id, accountId: account.id, email: user.email,
  });
  return { cookie: `${COOKIE}=${token}`, accountId: account.id, userId: user.id, email: user.email };
}

/** An account with no HTTP involved, for the repo- and job-level tests. */
export async function seedAccount(client, { email = "host@example.com", checkInTime = "14:00", checkOutTime = "11:00" } = {}) {
  const user = await upsertUser(client, { email, name: "Test Host" });
  const existing = (await accountsForUser(client, user.id))[0];
  if (existing) return existing.id;
  const account = await createAccount(client, { name: "Test listings", ownerUserId: user.id, checkInTime, checkOutTime });
  return account.id;
}

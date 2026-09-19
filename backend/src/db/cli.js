#!/usr/bin/env node
// ---------------------------------------------------------------------------
//   npm run migrate            apply pending migrations, then seed first-run rows
//   npm run migrate -- --status  show what is applied without changing anything
//
// Safe to run on every boot: applying twice is a no-op.
// ---------------------------------------------------------------------------
import { openDatabase, query, one } from "./client.js";
import { migrate, seedFirstRun } from "./migrate.js";
import { initialisePasscode, authStatus, policyFromEnv } from "../auth/admin.js";
import { RULES } from "../../../shared/rules.js";

const args = process.argv.slice(2);
const db = openDatabase();
console.log(`database  ${db.url}${db.isLocal ? "  (local file)" : "  (remote)"}`);

if (args.includes("--status")) {
  try {
    const rows = await query(db.client, "SELECT version, applied_at FROM _migrations ORDER BY version");
    if (!rows.length) console.log("no migrations applied yet");
    for (const r of rows) console.log(`  ${r.version}  ${r.applied_at}`);
  } catch {
    console.log("no migration ledger yet — run `npm run migrate`");
  }
  process.exit(0);
}

const result = await migrate(db, { log: (m) => console.log("  " + m) });
console.log(result.ran.length ? `applied ${result.ran.length} migration(s)` : "already up to date");

// First-run rows. The passcode is hashed with scrypt; a real hash from the
// start, so no deployment can ever sit on a placeholder.
const policy = policyFromEnv();
const firstRun = process.env.ADMIN_FIRST_RUN_PASSCODE || "0".repeat(policy.passcodeLength);
await seedFirstRun(db, {
  passcodeHash: "pending",   // replaced immediately below; never left in place
  checkInTime: process.env.DEFAULT_CHECK_IN_TIME || RULES.defaultCheckInTime,
  checkOutTime: process.env.DEFAULT_CHECK_OUT_TIME || RULES.defaultCheckOutTime,
});
const init = await initialisePasscode(db.client, firstRun, { policy });
if (!init.ok) {
  console.error(`\nADMIN_FIRST_RUN_PASSCODE is invalid: ${init.reason}`);
  process.exit(1);
}

const auth = await authStatus(db.client);
if (!auth.configured) {
  console.error(`\nadmin passcode is NOT configured (${auth.reason}) — refusing to report success`);
  process.exit(1);
}
console.log(`admin     passcode hashed (scrypt), ${policy.passcodeLength} digits, ` +
  `lockout after ${policy.maxAttempts} attempts`);
if (firstRun === "0".repeat(policy.passcodeLength) && process.env.NODE_ENV === "production") {
  console.warn(`\n  WARNING: still on the first-run passcode ${firstRun} in production.` +
    `\n  Change it in Settings -> Admin access before sharing any guest link.\n`);
}
const s = await one(db.client, "SELECT check_in_time, check_out_time FROM app_settings WHERE id = 1");
console.log(`settings  check-in ${s.check_in_time}  check-out ${s.check_out_time}`);

const counts = await query(db.client, `SELECT
  (SELECT COUNT(*) FROM societies) AS societies,
  (SELECT COUNT(*) FROM listings)  AS listings,
  (SELECT COUNT(*) FROM bookings)  AS bookings`);
const c = counts[0];
console.log(`rows      ${c.societies} societies, ${c.listings} listings, ${c.bookings} bookings`);

#!/usr/bin/env node
// ---------------------------------------------------------------------------
//   npm run demo
//
// Fills a LOCAL database with a society, a listing and a few bookings so the
// app can be clicked through without an Airbnb calendar or an SMTP account.
//
// Refuses to run against anything but a local file — this writes invented
// guests, and inventing guests in a real database would be its own kind of bug.
// ---------------------------------------------------------------------------
import { openDatabase, applyPragmas, run, query, newId, nowIso } from "./client.js";
import { migrate, seedFirstRun } from "./migrate.js";
import { initialisePasscode, policyFromEnv } from "../auth/admin.js";

const db = openDatabase();
if (!db.isLocal) {
  console.error("\nrefusing: `npm run demo` only writes to a local file database.\n");
  process.exit(1);
}
await applyPragmas(db);
await migrate(db);
await seedFirstRun(db, { passcodeHash: "pending", checkInTime: "14:00", checkOutTime: "11:00" });
await initialisePasscode(db.client, "0000", { policy: policyFromEnv() });
const c = db.client;

const existing = await query(c, "SELECT COUNT(*) AS n FROM bookings");
if (Number(existing[0].n) > 0) {
  console.log("there are already bookings here; leaving them alone");
  process.exit(0);
}

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const at = () => nowIso();

const soc = newId("soc");
await run(c, `INSERT INTO societies (id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`, [soc, "Greenwood Society, Candolim",
  "security@greenwood.example", "clubhouse@greenwood.example",
  "Dear Security Team,\n\nPlease find attached the ID proofs for guests arriving at {{listing}}.\n\n" +
  "Booking reference: {{booking_id}}\nCheck-in: {{check_in}}\nCheck-out: {{check_out}}\nAdult guests: {{adult_count}}\n\n" +
  "Kindly allow entry as per society guidelines.\n\nRegards,\nArjun K. (Host)", at(), at()]);

const soc2 = newId("soc");
await run(c, `INSERT INTO societies (id,name,desk_email_to,desk_email_cc,template,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`, [soc2, "Hillcrest Residency, Coorg",
  "gate@hillcrest.example", "", "Hello Gate Desk,\n\nGuest ID documents for {{listing}} are attached.\n" +
  "Ref {{booking_id}}, {{adult_count}} adult(s), arriving {{check_in}}.\n\nThank you,\nArjun", at(), at()]);

const lst = newId("lst"), lst2 = newId("lst");
await run(c, `INSERT INTO listings (id,name,ical_url,society_id,last_synced_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`, [lst, "Sea Breeze 2BHK, Candolim",
  "https://www.airbnb.co.in/calendar/ical/12345678.ics?s=demo", soc, at(), at(), at()]);
await run(c, `INSERT INTO listings (id,name,ical_url,society_id,last_synced_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?)`, [lst2, "Hillview Studio, Coorg",
  "https://www.airbnb.co.in/calendar/ical/87654321.ics?s=demo", soc2, at(), at(), at()]);

async function booking({ listing, code, ci, nights, children = 0, automation = "allids", people, phone = null, conflict = 0, reason = null, lead = null }) {
  const id = newId("bkg");
  await run(c, `INSERT INTO bookings (id,airbnb_code,listing_id,check_in,check_out,children,automation,lead_guest,phone_last4,conflict,conflict_reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, code, listing, day(ci), day(ci + nights), children, automation, lead, phone, conflict, reason, at(), at()]);
  for (const [i, name] of people.entries()) {
    await run(c, `INSERT INTO people (id,booking_id,name,is_lead,created_at) VALUES (?,?,?,?,?)`,
      [newId("per"), id, name, i === 0 ? 1 : 0, at()]);
  }
  await run(c, `INSERT INTO activity (id,booking_id,at,kind,actor,text) VALUES (?,?,?,?,?,?)`,
    [newId("act"), id, at(), "sync", "system", "Booking synced from Airbnb"]);
  return id;
}

// Deliberately covers each state the list can show.
await booking({ listing: lst, code: "HMABCD1234", ci: 2, nights: 3, children: 1,
  lead: "Priya Menon", phone: "4417", people: ["Priya Menon", "Rohit Menon", "Adult 3"] });
await booking({ listing: lst2, code: "HMEFGH5678", ci: 3, nights: 2, automation: "before",
  lead: "Daniel Fernandes", phone: "8802", people: ["Daniel Fernandes", "Aisha Fernandes"] });
await booking({ listing: lst, code: "HMIJKL9012", ci: 7, nights: 4, children: 2,
  phone: "6610", people: ["Lead guest", "Adult 2"] });
await booking({ listing: lst2, code: "HMMNOP3456", ci: 14, nights: 1, automation: "before",
  phone: "7731", people: ["Lead guest"], conflict: 1,
  reason: "Dates overlap another reservation in the Airbnb calendar" });

const n = await query(c, "SELECT COUNT(*) AS b FROM bookings");
console.log(`
  demo data ready — ${n[0].b} bookings, 2 listings, 2 societies
  passcode 0000

  Upload a photo to any guest to watch a booking become "Ready to send".
`);

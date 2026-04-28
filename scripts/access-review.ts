#!/usr/bin/env bun
/**
 * access-review.ts — Periodic access review for NyxHive pairing DB.
 *
 * Usage:
 *   bun run scripts/access-review.ts [--instance <name>] [--data-dir <path>]
 *
 * Prints a summary of all approved users: role, when approved, days since approval.
 * Flags accounts that may warrant review (e.g. approved > 90 days ago, no activity data).
 * Does not modify the DB — read-only.
 *
 * Suggested cadence: monthly, or whenever a team member leaves.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const args = Bun.argv.slice(2);
const instanceIdx = args.indexOf("--instance");
const dataDirIdx = args.indexOf("--data-dir");

const instanceName = instanceIdx !== -1 ? args[instanceIdx + 1] : "acme";
const dataDir =
  dataDirIdx !== -1
    ? args[dataDirIdx + 1]
    : `${process.env.HOME}/.nyxhive/instances/${instanceName.charAt(0).toUpperCase() + instanceName.slice(1)}/data`;

const dbPath = join(dataDir, `${instanceName}.db`);

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Could not open DB at ${dbPath}: ${err}`);
  process.exit(1);
}

const ROLE_ORDER: Record<string, number> = { operator: 0, engineer: 1, support: 2, viewer: 3 };
const REVIEW_THRESHOLD_DAYS = 90;
const now = Date.now();

type Row = { channel: string; sender_id: string; sender: string; role: string; approved_at: number };

const users = db
  .query("SELECT channel, sender_id, sender, role, approved_at FROM pairing_approved ORDER BY role, approved_at ASC")
  .all() as Row[];

db.close();

if (users.length === 0) {
  console.log("No approved users found.");
  process.exit(0);
}

const sorted = users.sort((a, b) => (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99));

const SEP = "─".repeat(72);
console.log(`\n${SEP}`);
console.log(` NyxHive Access Review — ${new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })}`);
console.log(` Instance: ${instanceName}  |  DB: ${dbPath}`);
console.log(`${SEP}\n`);

const flagged: Row[] = [];

let currentRole = "";
for (const u of sorted) {
  if (u.role !== currentRole) {
    currentRole = u.role;
    console.log(`  ${currentRole.toUpperCase()}`);
  }

  const approvedDate = new Date(u.approved_at).toLocaleDateString("en-GB");
  const daysSince = Math.floor((now - u.approved_at) / (1000 * 60 * 60 * 24));
  const stale = daysSince > REVIEW_THRESHOLD_DAYS;
  const flag = stale ? "  ⚠ REVIEW" : "";

  console.log(
    `    ${u.sender.padEnd(28)} ${u.sender_id.padEnd(14)} approved ${approvedDate}  (${daysSince}d ago)${flag}`
  );

  if (stale) flagged.push(u);
}

console.log(`\n${SEP}`);
console.log(`  Total: ${users.length} approved users`);

if (flagged.length > 0) {
  console.log(`\n  ⚠  ${flagged.length} account(s) approved > ${REVIEW_THRESHOLD_DAYS} days ago — consider verifying still needed:\n`);
  for (const u of flagged) {
    const days = Math.floor((now - u.approved_at) / (1000 * 60 * 60 * 24));
    console.log(`     ${u.sender} (${u.sender_id}) — ${u.role}, ${days}d`);
  }
} else {
  console.log(`  All accounts approved within the last ${REVIEW_THRESHOLD_DAYS} days.`);
}

console.log(`\n${SEP}\n`);

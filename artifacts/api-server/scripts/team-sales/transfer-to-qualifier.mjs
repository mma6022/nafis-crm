#!/usr/bin/env node
// One-time transfer: Hasani(3)/Ghasemi(4) in_progress customers with priority 2/3/none and
// no active loan application -> Kazemi(6). DRY RUN by default; pass --apply to write.
//   node transfer-to-qualifier.mjs [--db PATH] [--backup-dir DIR] [--batch NAME] [--apply] [--keep-notifications]
// On --apply: 1) full online backup (verified) 2) snapshot table rows 3) update, all in one transaction.
// Untouched: trainees (5, 19, 20), Kazemi's own customers, priority-1, completed/cancelled, merged rows,
// customers with requested/reviewing loan applications, reminders, contracts, users (incl. user 29). No SMS.
import fs from "node:fs";
import path from "node:path";
import {
  parseArgs, openWritable, fullBackup, summarize, stamp,
  TRANSFER_SET_SQL, STAYING_SQL, SNAPSHOT_TABLE, QUALIFIER_SALESPERSON_ID, TRAINEE_SALESPERSON_IDS,
} from "./common.mjs";
import { DatabaseSync } from "node:sqlite";

const args = parseArgs(process.argv.slice(2));
const batch = args.batch || `team-sales-${stamp()}`;
const backupDir = args.backupDir || path.join(path.dirname(args.db), "backups", "team-sales");

const ro = new DatabaseSync(args.db, { readOnly: true, timeout: 10000 });
const rows = ro.prepare(TRANSFER_SET_SQL).all();
const staying = ro.prepare(STAYING_SQL).all();
ro.close();
if (rows.some((r) => TRAINEE_SALESPERSON_IDS.includes(Number(r.salesperson_id)))) throw new Error("trainee in set");

const report = { mode: args.apply ? "apply" : "dry-run", db: args.db, batch,
  transfer: { total: rows.length, bySalespersonAndPriority: summarize(rows) },
  stayWithActiveLoanApplication: staying };

if (!args.apply) {
  console.log(JSON.stringify(report, null, 2));
  console.log("DRY RUN - nothing written. Re-run with --apply to back up, snapshot and transfer.");
  process.exit(0);
}

const bk = await fullBackup(args.db, backupDir, "before-team-sales-transfer");
report.backup = bk;

const db = openWritable(args.db);
db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  previous_salesperson_id INTEGER,
  previous_priority INTEGER,
  new_salesperson_id INTEGER NOT NULL,
  backup_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rolled_back_at TEXT,
  UNIQUE(batch, customer_id))`);
const now = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  if (db.prepare(`SELECT 1 FROM ${SNAPSHOT_TABLE} WHERE batch=? LIMIT 1`).get(batch)) throw new Error(`batch ${batch} already exists`);
  // Re-select inside the write lock so the snapshot matches exactly what is updated.
  const live = db.prepare(TRANSFER_SET_SQL).all();
  const maxEvt = Number(db.prepare("SELECT coalesce(max(id),0) m FROM site_notification_events").get().m);
  const ins = db.prepare(`INSERT INTO ${SNAPSHOT_TABLE}
    (batch, customer_id, previous_salesperson_id, previous_priority, new_salesperson_id, backup_path, created_at)
    VALUES (?,?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=?`);
  let changed = 0;
  for (const r of live) {
    ins.run(batch, r.customer_id, r.salesperson_id, r.priority, QUALIFIER_SALESPERSON_ID, bk.path, now);
    changed += Number(upd.run(QUALIFIER_SALESPERSON_ID, r.customer_id, r.salesperson_id).changes);
  }
  if (changed !== live.length) throw new Error(`changed ${changed} != selected ${live.length}`);
  let suppressed = 0;
  if (!args.keepNotifications) {
    // The customers UPDATE trigger writes one «پروندهٔ مشتری تغییر کرد» event per customer (848 bells for Kazemi).
    // Remove only the events this transaction created for this batch.
    suppressed = Number(db.prepare(`DELETE FROM site_notification_events WHERE id > ? AND resource_type='customer'
      AND customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE} WHERE batch=?)`).run(maxEvt, batch).changes);
  }
  db.exec("COMMIT");
  report.applied = { selected: live.length, updated: changed, notificationEventsSuppressed: suppressed, at: now };
} catch (e) {
  db.exec("ROLLBACK");
  console.error("TRANSFER ABORTED, nothing changed:", e.message);
  process.exit(2);
}
const after = db.prepare(`SELECT salesperson_id, count(*) n FROM customers WHERE merged_into_customer_id IS NULL GROUP BY 1 ORDER BY 1`).all();
db.close();
report.afterBySalesperson = after;
const reportPath = path.join(backupDir, `${batch}.report.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`Rollback: node rollback-transfer.mjs --db ${args.db} --batch ${batch} --apply`);

#!/usr/bin/env node
// Roll back a team-sales transfer batch from the snapshot table. DRY RUN by default.
//   node rollback-transfer.mjs --batch NAME [--db PATH] [--apply] [--force] [--keep-notifications]
// Only reverts rows still exactly as the transfer left them (salesperson = 6 and priority unchanged).
// Rows changed since (e.g. upgraded to priority 1 or reassigned) are reported as conflicts and kept,
// unless --force. The full-file backup recorded in each snapshot row is the last-resort restore.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { parseArgs, openWritable, fullBackup, SNAPSHOT_TABLE } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.batch) { console.error("--batch is required"); process.exit(1); }
const ro = new DatabaseSync(args.db, { readOnly: true, timeout: 10000 });
if (!ro.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(SNAPSHOT_TABLE)) {
  console.error("no snapshot table"); process.exit(1);
}
const SQL = `SELECT s.customer_id, s.previous_salesperson_id, s.previous_priority, s.new_salesperson_id,
    c.salesperson_id AS current_salesperson_id, c.priority AS current_priority, s.backup_path
  FROM ${SNAPSHOT_TABLE} s JOIN customers c ON c.id = s.customer_id
  WHERE s.batch = ? AND s.rolled_back_at IS NULL ORDER BY s.customer_id`;
const rows = ro.prepare(SQL).all(args.batch);
ro.close();
const clean = (r) => Number(r.current_salesperson_id) === Number(r.new_salesperson_id)
  && (r.current_priority ?? null) === (r.previous_priority ?? null);
const ok = rows.filter(clean), conflicts = rows.filter((r) => !clean(r));
const report = { mode: args.apply ? "apply" : "dry-run", batch: args.batch, pending: rows.length,
  revertable: ok.length, conflicts: conflicts.length,
  conflictRows: conflicts.slice(0, 50), backupPathFromSnapshot: rows[0]?.backup_path ?? null };
if (!args.apply) { console.log(JSON.stringify(report, null, 2)); console.log("DRY RUN - nothing written."); process.exit(0); }

report.backup = await fullBackup(args.db, path.join(path.dirname(args.db), "backups", "team-sales"), "before-team-sales-rollback");
const db = openWritable(args.db);
const now = new Date().toISOString();
db.exec("BEGIN IMMEDIATE");
try {
  const maxEvt = Number(db.prepare("SELECT coalesce(max(id),0) m FROM site_notification_events").get().m);
  const target = args.force ? db.prepare(SQL).all(args.batch) : db.prepare(SQL).all(args.batch).filter(clean);
  const upd = db.prepare("UPDATE customers SET salesperson_id=?, priority=? WHERE id=?");
  const mark = db.prepare(`UPDATE ${SNAPSHOT_TABLE} SET rolled_back_at=? WHERE batch=? AND customer_id=?`);
  for (const r of target) {
    upd.run(r.previous_salesperson_id, r.previous_priority, r.customer_id);
    mark.run(now, args.batch, r.customer_id);
  }
  let suppressed = 0;
  if (!args.keepNotifications) suppressed = Number(db.prepare(`DELETE FROM site_notification_events WHERE id > ?
    AND resource_type='customer' AND customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE} WHERE batch=?)`).run(maxEvt, args.batch).changes);
  db.exec("COMMIT");
  report.applied = { reverted: target.length, notificationEventsSuppressed: suppressed, at: now };
} catch (e) { db.exec("ROLLBACK"); console.error("ROLLBACK ABORTED, nothing changed:", e.message); process.exit(2); }
db.close();
console.log(JSON.stringify(report, null, 2));

#!/usr/bin/env node
// crm-nonp1-to-kazemi one-time catch-up: the CURRENT in_progress customers of Hasani(3)/Ghasemi(4) whose priority is
// not 1 (2, 3 or «بدون اولویت») -> Kazemi(6), with the same exceptions as the live rule (src/lib/nonp1-transfer.ts):
//   open case (loan application requested/reviewing, goods purchase not completed, payment order not paid,
//   pending loan draft, contract generated/sent, wallet payment intent created < 24h), customers #181 / #649,
//   trainees (5, 19, 20: never in the source set), merged rows, cancelled / completed (closed) customers.
// DRY RUN by default.   node nonp1-to-qualifier.mjs [--db PATH] [--batch NAME] [--csv PATH] [--backup-dir DIR] [--apply]
// --apply: verified full online backup, then ONE transaction (BEGIN IMMEDIATE, set re-selected inside the lock):
//   snapshot rows (team_sales_transfer_snapshot, own batch) + guarded UPDATE + one customer_priority_history row per
//   customer (source nonp1_auto_transfer) + drop the bell events of the move + mark the moved customers' older
//   events read for Kazemi's users. No SMS, no contracts, no commission tables, no users touched.
// CSV (no phone / national id / name): customer_id,from_salesperson_id,priority,action
// Rollback: node rollback-transfer.mjs --db PATH --batch NAME [--apply]
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, openWritable, fullBackup, stamp, SNAPSHOT_TABLE, QUALIFIER_SALESPERSON_ID, SOURCE_SALESPERSON_IDS, TRAINEE_SALESPERSON_IDS } from "./common.mjs";

export const PROTECTED_CUSTOMER_IDS = [181, 649];
const WALLET_INTENT_OPEN_MS = 24 * 60 * 60 * 1000;
const SOURCE = "nonp1_auto_transfer";
const REASON = "انتقال خودکار به کارشناس تماس اول (اولویت غیر ۱) — انتقال یک‌باره‌ی مشتریان فعلی";

const args = parseArgs(process.argv.slice(2));
const batch = args.batch || `nonp1-kazemi-${stamp()}`;
const backupDir = args.backupDir || path.join(path.dirname(args.db), "backups", "team-sales");
const csvPath = args.csv || null;
const nowDate = args.now ? new Date(args.now) : new Date();

const tableExists = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
function openCase(db, id) {
  const has = (t, sql, p = []) => tableExists(db, t) && Boolean(db.prepare(`SELECT 1 FROM ${t} WHERE customer_id=? AND ${sql} LIMIT 1`).get(id, ...p));
  if (has("loan_applications", "deleted_at IS NULL AND status IN ('requested','reviewing')")) return "loan_application";
  if (has("goods_purchases", "COALESCE(stage,'') <> 'completed'")) return "goods_purchase";
  if (has("customer_payment_orders", "COALESCE(stage,'') <> 'paid'")) return "payment_order";
  if (has("loan_request_drafts", "deleted_at IS NULL AND status='pending_registration'")) return "loan_draft";
  if (has("contract_generations", "deleted_at IS NULL AND superseded_at IS NULL AND status IN ('generated','sent')")) return "contract";
  if (has("wallet_payment_intents", "status='created' AND created_at >= ?", [new Date(nowDate.getTime() - WALLET_INTENT_OPEN_MS).toISOString()])) return "wallet_payment";
  return null;
}
/** Every non-P1 customer of 3/4 (any status) with the action the rule takes on it. */
function classify(db) {
  const rows = db.prepare(`SELECT id, salesperson_id, priority, status, merged_into_customer_id FROM customers
    WHERE salesperson_id IN (${SOURCE_SALESPERSON_IDS.join(",")}) AND (priority IS NULL OR priority <> 1) ORDER BY id`).all();
  return rows.map((r) => {
    let action = "move_to_kazemi";
    if (r.merged_into_customer_id != null) action = "stay_merged";
    else if (PROTECTED_CUSTOMER_IDS.includes(Number(r.id))) action = "stay_protected_customer";
    else if (TRAINEE_SALESPERSON_IDS.includes(Number(r.salesperson_id))) action = "stay_trainee";
    else if ((r.status ?? "in_progress") !== "in_progress") action = `stay_closed_${r.status}`;
    else { const oc = openCase(db, r.id); if (oc) action = `stay_open_case_${oc}`; }
    return { customer_id: Number(r.id), from_salesperson_id: Number(r.salesperson_id), priority: r.priority == null ? null : Number(r.priority), action };
  });
}
function groups(rows) {
  const g = {};
  for (const r of rows) { const k = `${r.action} sp${r.from_salesperson_id} p${r.priority ?? "none"}`; g[k] = (g[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(g).sort());
}
const toCsv = (rows) => "customer_id,from_salesperson_id,priority,action\n" + rows.map((r) => `${r.customer_id},${r.from_salesperson_id},${r.priority ?? ""},${r.action}`).join("\n") + (rows.length ? "\n" : "");
const writeCsv = (rows) => { if (csvPath) { fs.mkdirSync(path.dirname(csvPath), { recursive: true }); fs.writeFileSync(csvPath, toCsv(rows), { mode: 0o600 }); fs.chmodSync(csvPath, 0o600); } };

const ro = new DatabaseSync(args.db, { readOnly: true, timeout: 10000 });
const planned = classify(ro);
ro.close();
const report = { mode: args.apply ? "apply" : "dry-run", db: args.db, batch, now: nowDate.toISOString(),
  move: planned.filter((r) => r.action === "move_to_kazemi").length, groups: groups(planned), csv: csvPath };
if (!args.apply) {
  writeCsv(planned);
  console.log(JSON.stringify(report, null, 2));
  console.log("DRY RUN - nothing written. Re-run with --apply to back up, snapshot and transfer.");
  process.exit(0);
}

report.backup = await fullBackup(args.db, backupDir, "before-nonp1-kazemi");
const db = openWritable(args.db);
db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, customer_id INTEGER NOT NULL,
  previous_salesperson_id INTEGER, previous_priority INTEGER, new_salesperson_id INTEGER NOT NULL, backup_path TEXT NOT NULL,
  created_at TEXT NOT NULL, rolled_back_at TEXT, UNIQUE(batch, customer_id))`);
const now = new Date().toISOString();
let live;
db.exec("BEGIN IMMEDIATE");
try {
  if (db.prepare(`SELECT 1 FROM ${SNAPSHOT_TABLE} WHERE batch=? LIMIT 1`).get(batch)) throw new Error(`batch ${batch} already exists`);
  live = classify(db); // re-selected inside the write lock
  const move = live.filter((r) => r.action === "move_to_kazemi");
  const bells = tableExists(db, "site_notification_events");
  const maxEvt = bells ? Number(db.prepare("SELECT coalesce(max(id),0) m FROM site_notification_events").get().m) : 0;
  const ins = db.prepare(`INSERT INTO ${SNAPSHOT_TABLE} (batch, customer_id, previous_salesperson_id, previous_priority, new_salesperson_id, backup_path, created_at) VALUES (?,?,?,?,?,?,?)`);
  const upd = db.prepare("UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=? AND status='in_progress' AND merged_into_customer_id IS NULL");
  const hist = db.prepare(`INSERT INTO customer_priority_history (customer_id, old_priority, new_priority, old_salesperson_id, new_salesperson_id, actor_user_id, source, reason, created_at)
    VALUES (?,?,?,?,?,NULL,?,?,?)`);
  let changed = 0;
  for (const r of move) {
    ins.run(batch, r.customer_id, r.from_salesperson_id, r.priority, QUALIFIER_SALESPERSON_ID, report.backup.path, now);
    changed += Number(upd.run(QUALIFIER_SALESPERSON_ID, r.customer_id, r.from_salesperson_id).changes);
    hist.run(r.customer_id, r.priority, r.priority, r.from_salesperson_id, QUALIFIER_SALESPERSON_ID, SOURCE, REASON, now);
  }
  if (changed !== move.length) throw new Error(`changed ${changed} != selected ${move.length}`);
  let suppressed = 0, markedRead = 0;
  if (bells && move.length) {
    suppressed = Number(db.prepare(`DELETE FROM site_notification_events WHERE id > ? AND customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE} WHERE batch=?)`).run(maxEvt, batch).changes);
    if (tableExists(db, "site_notification_reads")) markedRead = Number(db.prepare(`INSERT OR IGNORE INTO site_notification_reads(user_id,event_id,read_at)
      SELECT u.id, e.id, ? FROM users u JOIN site_notification_events e ON e.id<=? AND e.customer_id IN (SELECT customer_id FROM ${SNAPSHOT_TABLE} WHERE batch=?)
      WHERE u.salesperson_id=? AND u.active=1`).run(now, maxEvt, batch, QUALIFIER_SALESPERSON_ID).changes);
  }
  db.exec("COMMIT");
  report.applied = { selected: move.length, updated: changed, historyRows: move.length, notificationEventsSuppressed: suppressed, markedReadForKazemi: markedRead, at: now };
  report.move = move.length; report.groups = groups(live);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("TRANSFER ABORTED, nothing changed:", e.message);
  process.exit(2);
}
db.close();
writeCsv(live);
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(backupDir, `${batch}.report.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`Rollback: node rollback-transfer.mjs --db ${args.db} --batch ${batch} --apply`);

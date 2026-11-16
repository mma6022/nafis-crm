// Rollback for scripts/request-drafts-migrate.mjs (schema-only migration).
//
//   node scripts/request-drafts-rollback.mjs --db /path/to/customers.db            # dry run (default)
//   node scripts/request-drafts-rollback.mjs --db /path/to/customers.db --apply    # full backup (VACUUM INTO) first, then one transaction
//   node scripts/request-drafts-rollback.mjs --db ... --apply --force              # also when staff already saved drafts (they are dropped)
//   optional: --backup /path/to/backup.db (default: <db>.bak-request-drafts-rollback-<timestamp>)
//
// Roll back the CODE first (otherwise the API re-creates the empty tables on start).
// --apply drops the three «در انتظار ثبت» tables and the marker. If they hold rows (drafts saved after the deploy) it refuses
// unless --force; with --force the in-CRM notifications about drafts (resource_type 'loan_draft') are removed too.
// loan_filing_fee_charges, wallets, ledgers, customers, cases, contracts and commissions are never touched:
// the migration never changed them, and a draft only ever pointed at a fee charge.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { DRAFT_TABLES, MARKER, backup } from "./request-drafts-migrate.mjs";

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

export function planRollback(db) {
  const tables = DRAFT_TABLES.filter((t) => tableExists(db, t)).map((t) => ({ table: t, rows: Number(db.prepare(`SELECT count(*) n FROM "${t}"`).get().n) }));
  const notifications = tableExists(db, "site_notification_events") ? Number(db.prepare("SELECT count(*) n FROM site_notification_events WHERE resource_type='loan_draft'").get().n) : 0;
  const marker = tableExists(db, "schema_migrations") && !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER);
  return { tables, rows: tables.reduce((a, t) => a + t.rows, 0), notifications, marker };
}

export function applyRollback(db, { force = false } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planRollback(db);
    if ((plan.rows > 0 || plan.notifications > 0) && !force) { db.exec("ROLLBACK"); return { applied: false, reason: "drafts_exist", plan }; }
    for (const t of plan.tables) db.exec(`DROP TABLE "${t.table}"`);
    if (force && plan.notifications) db.prepare("DELETE FROM site_notification_events WHERE resource_type='loan_draft'").run();
    if (plan.marker) db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MARKER);
    db.exec("COMMIT");
    return { applied: true, dropped: plan.tables.map((t) => t.table), droppedRows: plan.rows, removedNotifications: force ? plan.notifications : 0, plan };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "request-drafts-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply"); const force = args.includes("--force");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: request-drafts-rollback.mjs --db <path> [--apply] [--force] [--backup <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...plan }, null, 2));
  if (!apply) { console.log("Dry run: nothing written."); process.exit(0); }
  const target = val("--backup") ?? `${dbPath}.bak-request-drafts-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyRollback(db, { force });
  console.log(JSON.stringify({ applied: res.applied, reason: res.reason, dropped: res.dropped, droppedRows: res.droppedRows, removedNotifications: res.removedNotifications }, null, 2));
  db.close();
  if (!res.applied) process.exit(1);
}

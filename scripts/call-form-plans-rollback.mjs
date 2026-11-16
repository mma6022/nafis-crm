// Rollback for scripts/call-form-plans-migrate.mjs: drops team_sales_qualifications.selected_plans_json.
//
//   node scripts/call-form-plans-rollback.mjs --db /path/to/customers.db             # dry run (default): counts rows that hold a selection
//   node scripts/call-form-plans-rollback.mjs --db /path/to/customers.db --apply     # backup (VACUUM INTO) + JSON export, then DROP COLUMN
//   optional: --backup /path/to/backup.db  --export /path/to/selected-plans.json
//
// Deploy the previous server build first: the new build re-adds the column on its next start (ensureTeamSalesSchema).
// Nothing else is touched: answers_json / matches_json / priorities / call_logs written by the new form stay as they are
// (the old code reads them fine; the guarantor fields are extra JSON keys it ignores).
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COLUMN, TABLE, columnState } from "./call-form-plans-migrate.mjs";

export function planRollback(db) {
  const state = columnState(db);
  if (!state.column) return { ...state, rowsWithSelection: 0 };
  const n = db.prepare(`SELECT count(*) n FROM ${TABLE} WHERE ${COLUMN} IS NOT NULL AND ${COLUMN} NOT IN ('', '[]')`).get().n;
  return { ...state, rowsWithSelection: Number(n) };
}

export function exportSelections(db) {
  return db.prepare(`SELECT id, customer_id, created_at, ${COLUMN} AS selected FROM ${TABLE}
                     WHERE ${COLUMN} IS NOT NULL AND ${COLUMN} NOT IN ('', '[]') ORDER BY id`).all()
    .map((r) => ({ id: Number(r.id), customerId: Number(r.customer_id), createdAt: r.created_at, selectedPlans: JSON.parse(r.selected) }));
}

export function backup(db, target) {
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const b = new DatabaseSync(target, { readOnly: true });
  try {
    if (Object.values(b.prepare("PRAGMA integrity_check").get())[0] !== "ok") throw new Error("backup integrity_check failed");
    if (b.prepare(`SELECT count(*) n FROM ${TABLE}`).get().n !== db.prepare(`SELECT count(*) n FROM ${TABLE}`).get().n)
      throw new Error(`backup row count mismatch: ${TABLE}`);
  } finally { b.close(); }
}

export function applyRollback(db) {
  if (!columnState(db).column) return { applied: false, reason: "column not present" };
  db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  return { applied: true };
}

if (process.argv[1] && path.basename(process.argv[1]) === "call-form-plans-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: call-form-plans-rollback.mjs --db <path> [--apply] [--backup <path>] [--export <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...plan }, null, 2));
  if (!apply) { console.log(plan.column ? "Dry run: nothing written. Re-run with --apply to back up, export and drop the column." : "Dry run: nothing to roll back."); process.exit(0); }
  if (!plan.column) { console.log("Nothing to roll back."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-call-form-plans-rollback-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const exportPath = val("--export") ?? `${dbPath}.call-form-plans-selected-${stamp}.json`;
  const rows = exportSelections(db);
  writeFileSync(exportPath, JSON.stringify(rows, null, 2));
  console.log(`Exported ${rows.length} selection(s): ${exportPath}`);
  console.log(JSON.stringify(applyRollback(db)));
  db.close();
}

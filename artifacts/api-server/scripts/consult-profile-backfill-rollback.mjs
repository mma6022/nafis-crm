// Rollback for scripts/consult-profile-backfill.mjs: deletes ONLY the history rows it inserted (source='backfill').
//
//   node scripts/consult-profile-backfill-rollback.mjs --db /path/to/customers.db            # dry run (default)
//   node scripts/consult-profile-backfill-rollback.mjs --db /path/to/customers.db --apply    # backup + JSON export + delete
//   optional: --backup <path> --export <path> --drop-table-if-empty
//
// Rows written by the app itself (source 'first_call' / 'edit') are never touched. --drop-table-if-empty drops the
// history table only when nothing is left in it (deploy the previous build first; the new build re-creates it).
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TABLE } from "./consult-profile-backfill.mjs";

const hasTable = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);

export function planRollback(db) {
  if (!hasTable(db)) return { tableExists: false, backfillRows: 0, otherRows: 0 };
  const n = (w) => Number(db.prepare(`SELECT count(*) n FROM ${TABLE} WHERE ${w}`).get().n);
  return { tableExists: true, backfillRows: n("source='backfill'"), otherRows: n("source<>'backfill'") };
}
export function applyRollback(db, { dropIfEmpty = false } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted = Number(db.prepare(`DELETE FROM ${TABLE} WHERE source='backfill'`).run().changes);
    let dropped = false;
    if (dropIfEmpty && Number(db.prepare(`SELECT count(*) n FROM ${TABLE}`).get().n) === 0) { db.exec(`DROP TABLE ${TABLE}`); dropped = true; }
    db.exec("COMMIT");
    return { deleted, dropped };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "consult-profile-backfill-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: consult-profile-backfill-rollback.mjs --db <path> [--apply] [--drop-table-if-empty]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...plan }, null, 2));
  if (!apply) { console.log(plan.backfillRows ? `Dry run: would delete ${plan.backfillRows} backfill row(s).` : "Dry run: nothing to roll back."); process.exit(0); }
  if (!plan.tableExists) { console.log("Nothing to roll back."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-consult-profile-rollback-${stamp}`;
  if (existsSync(target)) { console.error(`backup target exists: ${target}`); process.exit(2); }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const exportPath = val("--export") ?? `${dbPath}.consult-profile-backfill-${stamp}.json`;
  writeFileSync(exportPath, JSON.stringify(db.prepare(`SELECT * FROM ${TABLE} WHERE source='backfill' ORDER BY id`).all(), null, 2));
  console.log(`Backup: ${target}\nExport: ${exportPath}`);
  console.log(JSON.stringify(applyRollback(db, { dropIfEmpty: args.includes("--drop-table-if-empty") })));
  db.close();
}

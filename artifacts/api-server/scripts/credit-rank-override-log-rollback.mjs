// Rollback for scripts/credit-rank-override-log-migrate.mjs: drops loan_credit_rank_override_log.
//
//   node scripts/credit-rank-override-log-rollback.mjs --db /path/to/customers.db            # dry run (default): counts log rows
//   node scripts/credit-rank-override-log-rollback.mjs --db /path/to/customers.db --apply    # backup (VACUUM INTO) + JSON export, then DROP TABLE
//   optional: --backup /path/to/backup.db  --export /path/to/override-log.json
//
// Deploy the previous server build first: the new build re-creates the table on the next override (ensureCreditRankOverrideSchema).
// Nothing else is touched. Cases created with an override keep their condition_snapshot_json.credit_rank_override
// (the reason inside it is an extra JSON key the old code ignores).
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TABLE, tableState } from "./credit-rank-override-log-migrate.mjs";

export function planRollback(db) { return tableState(db); }

export function exportRows(db) {
  if (!tableState(db).table) return [];
  return db.prepare(`SELECT * FROM ${TABLE} ORDER BY id`).all().map((r) => ({ ...r }));
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
  if (!tableState(db).table) return { applied: false, reason: "table not present" };
  db.exec(`DROP TABLE ${TABLE}`); // its indexes go with it
  return { applied: true };
}

if (process.argv[1] && path.basename(process.argv[1]) === "credit-rank-override-log-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: credit-rank-override-log-rollback.mjs --db <path> [--apply] [--backup <path>] [--export <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...plan }, null, 2));
  if (!apply) { console.log(plan.table ? "Dry run: nothing written. Re-run with --apply to back up, export and drop the table." : "Dry run: nothing to roll back."); process.exit(0); }
  if (!plan.table) { console.log("Nothing to roll back."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-credit-rank-override-log-rollback-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const exportPath = val("--export") ?? `${dbPath}.credit-rank-override-log-${stamp}.json`;
  const rows = exportRows(db);
  writeFileSync(exportPath, JSON.stringify(rows, null, 2));
  console.log(`Exported ${rows.length} log row(s): ${exportPath}`);
  console.log(JSON.stringify(applyRollback(db)));
  db.close();
}

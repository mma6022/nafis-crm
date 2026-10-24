// Additive migration for crm-grade-followups («نادیده گرفتن رتبه» audit log).
//
//   node scripts/credit-rank-override-log-migrate.mjs --db /path/to/customers.db            # dry run (default)
//   node scripts/credit-rank-override-log-migrate.mjs --db /path/to/customers.db --apply    # creates the table + indexes (idempotent)
//
// Only change: new table loan_credit_rank_override_log (+2 indexes). No existing table or row is touched.
// The server also creates it on first use (ensureCreditRankOverrideSchema), so running this is optional; older code ignores it.
// Undo: scripts/credit-rank-override-log-rollback.mjs.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const TABLE = "loan_credit_rank_override_log";
export const INDEXES = ["idx_credit_rank_override_customer", "idx_credit_rank_override_application"];
// Must stay identical to src/lib/credit-rank-override-log.ts (ensureCreditRankOverrideSchema).
export const DDL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    user_role TEXT,
    customer_id INTEGER NOT NULL,
    application_id INTEGER,
    plan_id INTEGER,
    condition_id INTEGER,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ${INDEXES[0]} ON ${TABLE}(customer_id, id DESC);
  CREATE INDEX IF NOT EXISTS ${INDEXES[1]} ON ${TABLE}(application_id, id DESC);
`;

export function tableState(db) {
  const table = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  const indexes = INDEXES.filter((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
  const rows = table ? Number(db.prepare(`SELECT count(*) n FROM ${TABLE}`).get().n) : 0;
  return { table, indexes, rows };
}

export function migrate(db) {
  const before = tableState(db);
  if (before.table && before.indexes.length === INDEXES.length) return { applied: false, reason: "already applied" };
  db.exec(DDL);
  return { applied: true, ...tableState(db) };
}

if (process.argv[1] && path.basename(process.argv[1]) === "credit-rank-override-log-migrate.mjs") {
  const args = process.argv.slice(2);
  const i = args.indexOf("--db"); const dbPath = i >= 0 ? args[i + 1] : undefined; const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: credit-rank-override-log-migrate.mjs --db <path> [--apply]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const state = tableState(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...state }, null, 2));
  if (!apply) {
    console.log(state.table && state.indexes.length === INDEXES.length ? "Dry run: nothing to do." : `Dry run: would create ${TABLE}. Re-run with --apply.`);
    process.exit(0);
  }
  console.log(JSON.stringify(migrate(db)));
  db.close();
}

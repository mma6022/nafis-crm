// Additive migration for crm-call-form-plans (Kazemi's first-call form with matching plans).
//
//   node scripts/call-form-plans-migrate.mjs --db /path/to/customers.db            # dry run (default): reports what would change
//   node scripts/call-form-plans-migrate.mjs --db /path/to/customers.db --apply    # adds the column (idempotent)
//
// Only change: team_sales_qualifications.selected_plans_json TEXT NULL (plans picked in step 5, snapshotted at submit time).
// The server also adds it on first use (ensureTeamSalesSchema), so running this is optional; older code ignores the column.
// Undo: scripts/call-form-plans-rollback.mjs.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const TABLE = "team_sales_qualifications";
export const COLUMN = "selected_plans_json";

export function columnState(db) {
  const table = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  const column = table && db.prepare(`SELECT name FROM pragma_table_info('${TABLE}')`).all().some((c) => c.name === COLUMN);
  return { table, column };
}

export function migrate(db) {
  const before = columnState(db);
  if (!before.table) return { applied: false, reason: `${TABLE} does not exist yet (the server creates it with the column)` };
  if (before.column) return { applied: false, reason: "already applied" };
  db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  return { applied: true };
}

if (process.argv[1] && path.basename(process.argv[1]) === "call-form-plans-migrate.mjs") {
  const args = process.argv.slice(2);
  const i = args.indexOf("--db"); const dbPath = i >= 0 ? args[i + 1] : undefined; const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: call-form-plans-migrate.mjs --db <path> [--apply]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const state = columnState(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...state }, null, 2));
  if (!apply) { console.log(state.table && !state.column ? `Dry run: would add ${TABLE}.${COLUMN}. Re-run with --apply.` : "Dry run: nothing to do."); process.exit(0); }
  console.log(JSON.stringify(migrate(db)));
  db.close();
}

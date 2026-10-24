// Additive migration for crm-no-plan-option («هیچ طرحی به این مشتری نمی‌خوره» + applicant military/job/city in Kazemi's first-call form).
//
//   node scripts/no-plan-option-migrate.mjs --db /path/to/customers.db            # dry run (default): reports what would change
//   node scripts/no-plan-option-migrate.mjs --db /path/to/customers.db --apply    # adds the columns (idempotent)
//
// Only changes (all nullable, no defaults, no data written):
//   team_sales_qualifications.no_plan_fit INTEGER     1 = expert ticked «هیچ طرحی به این مشتری نمی‌خوره»
//   team_sales_qualifications.no_plan_note TEXT       optional «چرا؟» (≤ 200 chars)
//   loan_plan_conditions.needs_military_service INTEGER  NULL on every plan = no requirement (nothing is set by this script)
//   customers.city TEXT                                city of residence; the form writes it only when empty
// and two new, empty tables (created explicitly here; the server's CREATE TABLE IF NOT EXISTS on first use is only a fallback):
//   customer_consult_profile_versions   versioned «اطلاعات مشاوره» card (first_call / edit / backfill rows)
//   customer_national_code_changes      log of national codes saved from «اعتبارسنجی سریع» (old value kept)
// The server also adds the columns on first use (ensureTeamSalesSchema / crm-db ensureColumn); older code ignores
// the columns and never reads the two tables. Undo: scripts/no-plan-option-rollback.mjs.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const COLUMNS = [
  { table: "team_sales_qualifications", column: "no_plan_fit", type: "INTEGER" },
  { table: "team_sales_qualifications", column: "no_plan_note", type: "TEXT" },
  { table: "loan_plan_conditions", column: "needs_military_service", type: "INTEGER" },
  { table: "customers", column: "city", type: "TEXT" },
];

// Same DDL as src/lib/consult-profile.ts (ensureConsultProfileSchema / ensureIdentityLogSchema) and scripts/consult-profile-backfill.mjs.
export const TABLES = [
  { table: "customer_consult_profile_versions", ddl: `
    CREATE TABLE IF NOT EXISTS customer_consult_profile_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('first_call','edit','backfill')),
      qualification_id INTEGER,
      data_json TEXT NOT NULL,
      changed_fields_json TEXT,
      actor_user_id INTEGER,
      actor_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_consult_profile_customer ON customer_consult_profile_versions(customer_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_consult_profile_qualification
      ON customer_consult_profile_versions(qualification_id) WHERE qualification_id IS NOT NULL;` },
  { table: "customer_national_code_changes", ddl: `
    CREATE TABLE IF NOT EXISTS customer_national_code_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      old_national_code TEXT,
      new_national_code TEXT NOT NULL,
      identity_changed INTEGER NOT NULL,
      source TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_national_code_changes_customer ON customer_national_code_changes(customer_id, id DESC);` },
];

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db, t, c) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().some((r) => r.name === c);

export function columnState(db) {
  return COLUMNS.map(({ table, column, type }) => {
    const t = hasTable(db, table);
    return { table, column, type, tableExists: t, present: t && hasColumn(db, table, column) };
  });
}

export function tableState(db) {
  return TABLES.map(({ table }) => ({ table, present: hasTable(db, table) }));
}

export function migrate(db) {
  const added = []; const skipped = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of columnState(db)) {
      if (!s.tableExists) { skipped.push(`${s.table}.${s.column} (table missing; the server creates it)`); continue; }
      if (s.present) { skipped.push(`${s.table}.${s.column} (already present)`); continue; }
      db.exec(`ALTER TABLE ${s.table} ADD COLUMN ${s.column} ${s.type}`);
      added.push(`${s.table}.${s.column}`);
    }
    for (const t of TABLES) {
      if (hasTable(db, t.table)) { skipped.push(`${t.table} (table already present)`); continue; }
      db.exec(t.ddl);
      added.push(`table ${t.table}`);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { applied: added.length > 0, added, skipped };
}

if (process.argv[1] && path.basename(process.argv[1]) === "no-plan-option-migrate.mjs") {
  const args = process.argv.slice(2);
  const i = args.indexOf("--db"); const dbPath = i >= 0 ? args[i + 1] : undefined; const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: no-plan-option-migrate.mjs --db <path> [--apply]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const state = columnState(db);
  const tables = tableState(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", columns: state, tables }, null, 2));
  const todo = [...state.filter((s) => s.tableExists && !s.present).map((s) => `${s.table}.${s.column}`),
    ...tables.filter((t) => !t.present).map((t) => `table ${t.table}`)];
  if (!apply) { console.log(todo.length ? `Dry run: would add ${todo.join(", ")}. Re-run with --apply.` : "Dry run: nothing to do."); process.exit(0); }
  console.log(JSON.stringify(migrate(db)));
  db.close();
}

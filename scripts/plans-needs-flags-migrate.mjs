// Data migration (crm-plans-consult phase 1): «چک / سفته / کسر از حقوق» as combinable needs_* flags next to collateral_type.
//
//   node scripts/plans-needs-flags-migrate.mjs --db /path/to/customers.db              # dry run (default): prints the plan, writes nothing
//   node scripts/plans-needs-flags-migrate.mjs --db /path/to/customers.db --apply      # full backup (VACUUM INTO) first, then one transaction
//   optional: --backup /path/to/backup.db   (default: <db>.bak-plans-needs-flags-<timestamp>)
//             --log /path/to/log.json        (default: <db>.plans-needs-flags-<timestamp>.log.json; written on --apply)
//
// Canonical storage (src/lib/plan-requirements.ts): collateral_type / guarantor_collateral_type keep the PRIMARY
// requirement exactly as today; needs_{customer,guarantor}_{check,promissory,salary_deduct} hold only the EXTRA ones.
// A flag that repeats its side's collateral_type (e.g. collateral_type=promissory AND needs_customer_promissory=1)
// counts the same requirement twice in the team-sales matcher, so it is cleared. NOTHING else is changed:
//  * collateral_type is never rewritten (no flag is ever derived from it → no requirement is added or removed);
//  * tables: loan_plans and loan_plan_conditions only. NEVER changed: consultation_forms (+ plan_matches_snapshot),
//    team_sales_qualifications, loan_applications(.condition_snapshot_json), customers, contracts, templates.
// Every changed flag is saved first in plans_needs_flags_snapshot (used by scripts/plans-needs-flags-rollback.mjs).
// Idempotent: records 'plans-needs-flags-v1' in schema_migrations in the same transaction.
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKER = "plans-needs-flags-v1";
export const SNAPSHOT = "plans_needs_flags_snapshot";
export const TABLES = ["loan_plans", "loan_plan_conditions"];
export const SIDES = {
  customer: { coll: "collateral_type", check: "needs_customer_check", promissory: "needs_customer_promissory", salary: "needs_customer_salary_deduct" },
  guarantor: { coll: "guarantor_collateral_type", check: "needs_guarantor_check", promissory: "needs_guarantor_promissory", salary: "needs_guarantor_salary_deduct" },
};

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const columns = (db, t) => tableExists(db, t) ? db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name) : [];
const isCheck = (c) => c === "physical_check" || c === "digital_check";
const on = (v) => Number(v ?? 0) === 1 || v === true;

/** Which flags of one side repeat its collateral_type (→ cleared). Same rule as normalizeSideFlags(). */
export function redundantFlags(coll, flags) {
  const c = typeof coll === "string" && coll.trim() ? coll.trim() : "none";
  const out = [];
  if (on(flags.check) && isCheck(c)) out.push("check");
  if (on(flags.promissory) && c === "promissory") out.push("promissory");
  if (on(flags.salary) && c === "salary_deduction") out.push("salary");
  return out;
}

export function planMigration(db) {
  const plan = { clear: [], combos: [], counts: {}, untouched: {} };
  for (const table of TABLES) {
    const cols = columns(db, table);
    const sides = Object.entries(SIDES).filter(([, s]) => Object.values(s).every((c) => cols.includes(c)));
    if (!sides.length) continue;
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
    plan.counts[table] = rows.length;
    for (const r of rows) for (const [side, s] of sides) {
      const flags = { check: r[s.check], promissory: r[s.promissory], salary: r[s.salary] };
      for (const k of redundantFlags(r[s.coll], flags)) plan.clear.push({ table, id: Number(r.id), side, column: s[k], from: r[s[k]], collateral: r[s.coll] });
      const extras = ["check", "promissory", "salary"].filter((k) => on(flags[k]) && !redundantFlags(r[s.coll], flags).includes(k));
      if (extras.length) plan.combos.push({ table, id: Number(r.id), side, collateral: r[s.coll] ?? null, extras });
    }
  }
  const count = (sql) => { try { return Number(db.prepare(sql).get().n); } catch { return null; } };
  plan.untouched = {
    consultation_plan_matches_snapshots: count("SELECT count(*) n FROM consultation_forms WHERE plan_matches_snapshot IS NOT NULL"),
    loan_application_condition_snapshots: count("SELECT count(*) n FROM loan_applications WHERE condition_snapshot_json IS NOT NULL"),
    team_sales_qualifications: count("SELECT count(*) n FROM team_sales_qualifications"),
  };
  return plan;
}

export function summary(plan) {
  return { rows: plan.counts, redundantFlagsToClear: plan.clear.length, routesWithCombinedRequirements: plan.combos.length, untouchedHistory: plan.untouched };
}

function ensureSnapshot(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    column_name TEXT NOT NULL,
    original_value TEXT,
    migrated_value TEXT,
    rolled_back_at TEXT
  )`);
}

export function applyMigration(db, now = new Date().toISOString()) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER)) { db.exec("ROLLBACK"); return { applied: false, reason: "already applied" }; }
    ensureSnapshot(db);
    const plan = planMigration(db);
    const snap = db.prepare(`INSERT INTO ${SNAPSHOT}(run_at,table_name,row_id,column_name,original_value,migrated_value) VALUES(?,?,?,?,?,?)`);
    let changed = 0;
    for (const c of plan.clear) {
      snap.run(now, c.table, c.id, c.column, String(c.from), "0");
      changed += Number(db.prepare(`UPDATE "${c.table}" SET "${c.column}"=0 WHERE id=?`).run(c.id).changes);
    }
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)").run(MARKER, now);
    db.exec("COMMIT");
    return { applied: true, changed, runAt: now, plan };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

export function backup(db, target) {
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const b = new DatabaseSync(target, { readOnly: true });
  try {
    const ok = b.prepare("PRAGMA integrity_check").get();
    if (Object.values(ok)[0] !== "ok") throw new Error("backup integrity_check failed");
    for (const t of TABLES.filter((t) => tableExists(db, t)))
      if (b.prepare(`SELECT count(*) n FROM "${t}"`).get().n !== db.prepare(`SELECT count(*) n FROM "${t}"`).get().n) throw new Error(`backup row count mismatch: ${t}`);
  } finally { b.close(); }
}

if (process.argv[1] && path.basename(process.argv[1]) === "plans-needs-flags-migrate.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: plans-needs-flags-migrate.mjs --db <path> [--apply] [--backup <path>] [--log <path>]  (explicit path required; no default)"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const done = tableExists(db, "schema_migrations") && db.prepare("SELECT applied_at FROM schema_migrations WHERE version=?").get(MARKER);
  const plan = planMigration(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", alreadyApplied: done ? done.applied_at : false, ...summary(plan),
    clear: plan.clear.map(({ table, id, column }) => ({ table, id, column })) }, null, 2));
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply to change data."); process.exit(0); }
  if (done) { console.log(`Already applied at ${done.applied_at}; no changes.`); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-plans-needs-flags-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyMigration(db);
  const logPath = val("--log") ?? `${dbPath}.plans-needs-flags-${stamp}.log.json`;
  if (res.applied) writeFileSync(logPath, JSON.stringify({ marker: MARKER, runAt: res.runAt, backup: target, changed: res.changed, ...summary(res.plan), clear: res.plan.clear }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(res.applied ? { applied: true, changed: res.changed, runAt: res.runAt, log: logPath } : res, null, 2));
  db.close();
}

// Data cleanup: bank-deposit collateral ('deposit') is not a product option and is removed.
//
//   node scripts/remove-deposit-collateral.mjs --db /path/to/customers.db                 # dry run (default): prints the plan, writes nothing
//   node scripts/remove-deposit-collateral.mjs --db /path/to/customers.db --apply         # full backup (VACUUM INTO) first, then one transaction
//   optional: --backup /path/to/backup.db   (default: <db>.bak-remove-deposit-collateral-<timestamp>)
//
// What --apply does, per record type (nothing else is touched):
//  * consult_options, field_key collateral_type / guarantor_collateral_type, option_value 'deposit':
//      deactivated (active=0). Not deleted; label kept so old records stay readable. Rows with any other
//      field_key and value 'deposit' are only listed for review.
//  * loan_plans and loan_plan_conditions, columns collateral_type / guarantor_collateral_type / customer_check /
//    guarantor_check:
//      - JSON list containing 'deposit' together with other values → 'deposit' removed from the list;
//      - single value 'deposit' (or a list of only 'deposit') → set to NULL only if the same side
//        (customer / guarantor) still has another requirement (a needs_<side>_check / _promissory /
//        _salary_deduct flag = 1, or another real collateral value on that side). Otherwise the row is
//        listed for MANUAL REVIEW and left unchanged.
//  * consultation_forms, loan_application_collateral, plan snapshots in loan applications and any other
//    table: never changed (history). Only counted and listed (ids) in the report.
// Idempotent: records 'remove-deposit-collateral-v1' in schema_migrations in the same transaction; a second
// --apply makes no changes. The marker is written even when some rows need manual review (they are reported).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const MARKER = "remove-deposit-collateral-v1";
const OPTION_FIELDS = ["collateral_type", "guarantor_collateral_type"];
const COLL = { collateral_type: "customer", customer_check: "customer", guarantor_collateral_type: "guarantor", guarantor_check: "guarantor" };
const FLAGS = { customer: ["needs_customer_check", "needs_customer_promissory", "needs_customer_salary_deduct"],
  guarantor: ["needs_guarantor_check", "needs_guarantor_promissory", "needs_guarantor_salary_deduct"] };
const isDepositToken = (v) => String(v ?? "").trim().toLowerCase() === "deposit";
const EMPTY = new Set(["", "none", "null", "undefined"]);

/** Returns { kind: 'none' } | { kind: 'single' } | { kind: 'list', rest: [...] } */
function parseValue(raw) {
  if (raw == null) return { kind: "none" };
  if (isDepositToken(raw)) return { kind: "single" };
  const s = String(raw).trim();
  if (!s.startsWith("[")) return { kind: "none" };
  try {
    const list = JSON.parse(s);
    if (!Array.isArray(list) || !list.some(isDepositToken)) return { kind: "none" };
    const rest = list.filter((x) => !isDepositToken(x));
    return rest.length ? { kind: "list", rest } : { kind: "single" };
  } catch { return { kind: "none" }; }
}
const realValue = (raw) => { const p = parseValue(raw); if (p.kind === "list") return true; if (p.kind === "single") return false;
  const s = String(raw ?? "").trim().toLowerCase(); if (EMPTY.has(s)) return false;
  if (s.startsWith("[")) { try { const l = JSON.parse(s); return Array.isArray(l) && l.some((x) => !EMPTY.has(String(x).trim().toLowerCase())); } catch { /* text */ } }
  return true; };

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const columns = (db, t) => tableExists(db, t) ? db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name) : [];

export function planRemoval(db) {
  const plan = { options: { deactivate: [], alreadyInactive: [], review: [] }, rows: { clear: [], trimList: [], review: [] }, untouched: {} };
  if (tableExists(db, "consult_options")) {
    for (const r of db.prepare("SELECT id, field_key, active FROM consult_options WHERE lower(trim(option_value))='deposit' ORDER BY id").all()) {
      if (!OPTION_FIELDS.includes(r.field_key)) plan.options.review.push({ id: r.id, field_key: r.field_key, active: r.active });
      else if (Number(r.active) === 1) plan.options.deactivate.push({ id: r.id, field_key: r.field_key });
      else plan.options.alreadyInactive.push({ id: r.id, field_key: r.field_key });
    }
  }
  for (const table of ["loan_plans", "loan_plan_conditions"]) {
    const cols = columns(db, table); const collCols = Object.keys(COLL).filter((c) => cols.includes(c));
    if (!collCols.length) continue;
    const join = table === "loan_plan_conditions" && tableExists(db, "loan_plans");
    const sel = join ? `SELECT t.*, lp.active AS __plan_active FROM loan_plan_conditions t LEFT JOIN loan_plans lp ON lp.id=t.plan_id` : `SELECT t.* FROM "${table}" t`;
    for (const r of db.prepare(`${sel} ORDER BY t.id`).all()) {
      for (const col of collCols) {
        const p = parseValue(r[col]);
        if (p.kind === "none") continue;
        const ref = { table, id: r.id, column: col, ...(table === "loan_plan_conditions" ? { plan_id: r.plan_id, plan_active: r.__plan_active ?? null } : { active: r.active ?? null }) };
        if (p.kind === "list") { plan.rows.trimList.push({ ...ref, to: JSON.stringify(p.rest) }); continue; }
        const side = COLL[col];
        const otherFlag = FLAGS[side].some((f) => cols.includes(f) && Number(r[f]) === 1);
        const otherValue = Object.keys(COLL).some((c) => c !== col && COLL[c] === side && cols.includes(c) && realValue(r[c]));
        if (otherFlag || otherValue) plan.rows.clear.push({ ...ref, reason: otherFlag ? "other requirement flag on this side" : "other collateral value on this side" });
        else plan.rows.review.push({ ...ref, reason: "deposit is the only collateral on this side — decide manually" });
      }
    }
  }
  const count = (sql) => { try { return db.prepare(sql).all().map((r) => r.id); } catch { return null; } };
  const fsCols = columns(db, "consultation_forms").filter((c) => c in COLL);
  if (fsCols.length) plan.untouched.consultation_forms = count(`SELECT id FROM consultation_forms WHERE ${fsCols.map((c) => `lower(trim(${c}))='deposit' OR ${c} LIKE '%"deposit"%'`).join(" OR ")} ORDER BY id`);
  if (tableExists(db, "loan_application_collateral")) plan.untouched.loan_application_collateral = count("SELECT id FROM loan_application_collateral WHERE lower(trim(collateral_type))='deposit' ORDER BY id");
  if (columns(db, "loan_applications").includes("plan_snapshot_json"))
    plan.untouched.loan_applications_plan_snapshot = count(`SELECT id FROM loan_applications WHERE plan_snapshot_json LIKE '%deposit%' AND (
      plan_snapshot_json LIKE '%"collateral_type":"deposit"%' OR plan_snapshot_json LIKE '%"guarantor_collateral_type":"deposit"%' OR
      plan_snapshot_json LIKE '%"collateralType":"deposit"%' OR plan_snapshot_json LIKE '%"guarantorCollateralType":"deposit"%') ORDER BY id`);
  return plan;
}

/** Re-plans inside the write transaction (BEGIN IMMEDIATE) so concurrent edits cannot slip between plan and write. */
export function applyRemoval(db, now = new Date().toISOString()) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER)) { db.exec("ROLLBACK"); return { applied: false, reason: "already applied" }; }
    const plan = planRemoval(db);
    let changed = 0;
    const deact = db.prepare("UPDATE consult_options SET active=0 WHERE id=? AND lower(trim(option_value))='deposit' AND active=1");
    for (const o of plan.options.deactivate) changed += Number(deact.run(o.id).changes);
    for (const r of plan.rows.clear) changed += Number(db.prepare(`UPDATE "${r.table}" SET "${r.column}"=NULL WHERE id=?`).run(r.id).changes);
    for (const r of plan.rows.trimList) changed += Number(db.prepare(`UPDATE "${r.table}" SET "${r.column}"=? WHERE id=?`).run(r.to, r.id).changes);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)").run(MARKER, now);
    db.exec("COMMIT");
    return { applied: true, changed, plan };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

export function backup(db, target) {
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const b = new DatabaseSync(target, { readOnly: true });
  try {
    const ok = b.prepare("PRAGMA integrity_check").get();
    if (Object.values(ok)[0] !== "ok") throw new Error("backup integrity_check failed");
    for (const t of ["consult_options", "loan_plans", "loan_plan_conditions"].filter((t) => tableExists(db, t)))
      if (b.prepare(`SELECT count(*) n FROM "${t}"`).get().n !== db.prepare(`SELECT count(*) n FROM "${t}"`).get().n) throw new Error(`backup row count mismatch: ${t}`);
  } finally { b.close(); }
}

if (process.argv[1] && path.basename(process.argv[1]) === "remove-deposit-collateral.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: remove-deposit-collateral.mjs --db <path> [--apply] [--backup <path>]  (explicit path required; no default)"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const done = tableExists(db, "schema_migrations") && db.prepare("SELECT applied_at FROM schema_migrations WHERE version=?").get(MARKER);
  const plan = planRemoval(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", alreadyApplied: done ? done.applied_at : false, plan }, null, 2));
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply to change data."); process.exit(0); }
  if (done) { console.log(`Already applied at ${done.applied_at}; no changes.`); process.exit(0); }
  const target = val("--backup") ?? `${dbPath}.bak-remove-deposit-collateral-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyRemoval(db);
  console.log(JSON.stringify(res.applied ? { applied: true, changed: res.changed, needsManualReview: [...res.plan.rows.review, ...res.plan.options.review] } : res, null, 2));
  db.close();
}

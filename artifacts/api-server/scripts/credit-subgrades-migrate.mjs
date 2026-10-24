// Data migration: credit grade («رتبه‌ی اعتبارسنجی») A–E → 15 sub-grades A1 … E3 (A1 best).
//
//   node scripts/credit-subgrades-migrate.mjs --db /path/to/customers.db              # dry run (default): prints the plan, writes nothing
//   node scripts/credit-subgrades-migrate.mjs --db /path/to/customers.db --apply      # full backup (VACUUM INTO) first, then one transaction
//   optional: --backup /path/to/backup.db   (default: <db>.bak-credit-subgrades-<timestamp>)
//             --log /path/to/log.json        (default: <db>.credit-subgrades-<timestamp>.log.json; written on --apply)
//
// What --apply does (nothing else is touched):
//  * loan_plans and loan_plan_conditions, columns customer_ranks / guarantor_ranks: every bare letter in the JSON
//    list becomes its three sub-grades, order kept (["A","C"] → ["A1","A2","A3","C1","C2","C3"]). Lists that already
//    hold only sub-grades, NULL and [] are left alone. Other values in a list are kept unchanged.
//  * consult_options, field_key credit_rank / guarantor_credit_rank:
//      - inserts A1 … E3 (label = value, sort_order 1–15, active) where missing;
//      - deactivates the A–E rows and relabels them «A (قدیمی)» (sort_order 101–105) so old records stay readable.
//  * NEVER changed (history): consultation_forms, team_sales_qualifications, customers, credit checks,
//    loan_applications.condition_snapshot_json, consultation_forms.plan_matches_snapshot, contracts.
// Every changed value is saved first in credit_subgrades_snapshot (original + written value), used by
// scripts/credit-subgrades-rollback.mjs. Idempotent: records 'credit-subgrades-v1' in schema_migrations in the same
// transaction; a second --apply makes no changes.
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKER = "credit-subgrades-v1";
export const SNAPSHOT = "credit_subgrades_snapshot";
export const LETTERS = ["A", "B", "C", "D", "E"];
export const SUBGRADES = LETTERS.flatMap((l) => [1, 2, 3].map((n) => `${l}${n}`));
export const OPTION_FIELDS = ["credit_rank", "guarantor_credit_rank"];
export const LEGACY_LABEL = (letter) => `${letter} (قدیمی)`;
const RANK_TABLES = { loan_plans: ["customer_ranks", "guarantor_ranks"], loan_plan_conditions: ["customer_ranks", "guarantor_ranks"] };

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const columns = (db, t) => tableExists(db, t) ? db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name) : [];

/** Returns the new JSON text, or null when the value needs no change (or is not a JSON list). */
export function expandStoredList(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s.startsWith("[")) return null;
  let list;
  try { list = JSON.parse(s); } catch { return null; }
  if (!Array.isArray(list) || !list.some((v) => /^[A-E]$/i.test(String(v).trim()))) return null;
  const out = [];
  const push = (v) => { if (!out.includes(v)) out.push(v); };
  for (const v of list) {
    const t = String(v).trim();
    if (/^[A-E]$/i.test(t)) for (const n of [1, 2, 3]) push(`${t.toUpperCase()}${n}`);
    else push(v);
  }
  return JSON.stringify(out);
}

export function planMigration(db) {
  const plan = { rankLists: [], options: { insert: [], deactivate: [], alreadyRetired: [], existingSubgrades: [] }, untouched: {} };
  for (const [table, cols] of Object.entries(RANK_TABLES)) {
    const have = cols.filter((c) => columns(db, table).includes(c));
    if (!have.length) continue;
    for (const r of db.prepare(`SELECT id, ${have.map((c) => `"${c}"`).join(",")} FROM "${table}" ORDER BY id`).all()) {
      for (const c of have) {
        const to = expandStoredList(r[c]);
        if (to != null) plan.rankLists.push({ table, id: Number(r.id), column: c, from: r[c], to });
      }
    }
  }
  if (tableExists(db, "consult_options")) {
    for (const field of OPTION_FIELDS) {
      const rows = db.prepare("SELECT id, option_value, label_fa, sort_order, active FROM consult_options WHERE field_key=?").all(field);
      SUBGRADES.forEach((value, i) => {
        const row = rows.find((r) => r.option_value === value);
        if (!row) plan.options.insert.push({ field, value, label: value, sort: i + 1 });
        else plan.options.existingSubgrades.push({ id: Number(row.id), field, value, active: Number(row.active) });
      });
      for (const r of rows.filter((r) => LETTERS.includes(String(r.option_value)))) {
        const letter = String(r.option_value);
        const target = { active: 0, label_fa: LEGACY_LABEL(letter), sort_order: 100 + LETTERS.indexOf(letter) + 1 };
        if (Number(r.active) === 0 && r.label_fa === target.label_fa) plan.options.alreadyRetired.push({ id: Number(r.id), field, value: letter });
        else plan.options.deactivate.push({ id: Number(r.id), field, value: letter,
          from: { active: Number(r.active), label_fa: r.label_fa, sort_order: r.sort_order }, to: target });
      }
    }
  }
  const count = (sql) => { try { return Number(db.prepare(sql).get().n); } catch { return null; } };
  plan.untouched = {
    consultation_forms_letter_credit_rank: count("SELECT count(*) n FROM consultation_forms WHERE credit_rank IN ('A','B','C','D','E')"),
    consultation_forms_letter_guarantor_rank: count("SELECT count(*) n FROM consultation_forms WHERE guarantor_credit_rank IN ('A','B','C','D','E')"),
    consultation_plan_matches_snapshots: count("SELECT count(*) n FROM consultation_forms WHERE plan_matches_snapshot IS NOT NULL"),
    loan_application_condition_snapshots: count("SELECT count(*) n FROM loan_applications WHERE condition_snapshot_json IS NOT NULL"),
    team_sales_qualifications: count("SELECT count(*) n FROM team_sales_qualifications"),
  };
  return plan;
}

export function summary(plan) {
  return {
    rankListsToExpand: plan.rankLists.length,
    rankListsByTable: plan.rankLists.reduce((a, r) => ({ ...a, [`${r.table}.${r.column}`]: (a[`${r.table}.${r.column}`] ?? 0) + 1 }), {}),
    optionsToInsert: plan.options.insert.length,
    optionsToRetire: plan.options.deactivate.length,
    optionsAlreadyRetired: plan.options.alreadyRetired.length,
    subgradeOptionsAlreadyPresent: plan.options.existingSubgrades.length,
    untouchedHistory: plan.untouched,
  };
}

function ensureSnapshot(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    kind TEXT NOT NULL,           -- rank_list | option_update | option_insert
    table_name TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    column_name TEXT,
    original_value TEXT,          -- exact original text (rank_list) or JSON of the original option row
    migrated_value TEXT,          -- what the migration wrote
    rolled_back_at TEXT
  )`);
}

/** Re-plans inside the write transaction (BEGIN IMMEDIATE) so concurrent edits cannot slip between plan and write. */
export function applyMigration(db, now = new Date().toISOString()) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER)) { db.exec("ROLLBACK"); return { applied: false, reason: "already applied" }; }
    ensureSnapshot(db);
    const plan = planMigration(db);
    const snap = db.prepare(`INSERT INTO ${SNAPSHOT}(run_at,kind,table_name,row_id,column_name,original_value,migrated_value) VALUES(?,?,?,?,?,?,?)`);
    let changed = 0;
    for (const r of plan.rankLists) {
      snap.run(now, "rank_list", r.table, r.id, r.column, r.from, r.to);
      changed += Number(db.prepare(`UPDATE "${r.table}" SET "${r.column}"=? WHERE id=? AND "${r.column}" IS ?`).run(r.to, r.id, r.from).changes);
    }
    for (const o of plan.options.deactivate) {
      snap.run(now, "option_update", "consult_options", o.id, null, JSON.stringify(o.from), JSON.stringify(o.to));
      changed += Number(db.prepare("UPDATE consult_options SET active=?, label_fa=?, sort_order=? WHERE id=?").run(o.to.active, o.to.label_fa, o.to.sort_order, o.id).changes);
    }
    const ins = db.prepare("INSERT INTO consult_options(field_key,option_value,label_fa,sort_order,active) VALUES(?,?,?,?,1)");
    for (const o of plan.options.insert) {
      const id = Number(ins.run(o.field, o.value, o.label, o.sort).lastInsertRowid);
      snap.run(now, "option_insert", "consult_options", id, null, null, JSON.stringify({ field_key: o.field, option_value: o.value, label_fa: o.label, sort_order: o.sort, active: 1 }));
      changed++;
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
    for (const t of ["consult_options", "loan_plans", "loan_plan_conditions"].filter((t) => tableExists(db, t)))
      if (b.prepare(`SELECT count(*) n FROM "${t}"`).get().n !== db.prepare(`SELECT count(*) n FROM "${t}"`).get().n) throw new Error(`backup row count mismatch: ${t}`);
  } finally { b.close(); }
}

if (process.argv[1] && path.basename(process.argv[1]) === "credit-subgrades-migrate.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: credit-subgrades-migrate.mjs --db <path> [--apply] [--backup <path>] [--log <path>]  (explicit path required; no default)"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const done = tableExists(db, "schema_migrations") && db.prepare("SELECT applied_at FROM schema_migrations WHERE version=?").get(MARKER);
  const plan = planMigration(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", alreadyApplied: done ? done.applied_at : false, ...summary(plan) }, null, 2));
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply to change data."); process.exit(0); }
  if (done) { console.log(`Already applied at ${done.applied_at}; no changes.`); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = val("--backup") ?? `${dbPath}.bak-credit-subgrades-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyMigration(db);
  const logPath = val("--log") ?? `${dbPath}.credit-subgrades-${stamp}.log.json`;
  if (res.applied) writeFileSync(logPath, JSON.stringify({ marker: MARKER, runAt: res.runAt, backup: target, changed: res.changed, ...summary(res.plan),
    rankLists: res.plan.rankLists, options: res.plan.options }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(res.applied ? { applied: true, changed: res.changed, runAt: res.runAt, log: logPath } : res, null, 2));
  db.close();
}

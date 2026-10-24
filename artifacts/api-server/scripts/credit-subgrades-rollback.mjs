// Rollback for scripts/credit-subgrades-migrate.mjs: restores the original values saved in credit_subgrades_snapshot.
//
//   node scripts/credit-subgrades-rollback.mjs --db /path/to/customers.db             # dry run (default): lists what would be restored and any conflicts
//   node scripts/credit-subgrades-rollback.mjs --db /path/to/customers.db --apply     # full backup (VACUUM INTO) first, then one transaction
//   node scripts/credit-subgrades-rollback.mjs --db ... --apply --force               # also restores rows that were edited after the migration
//   optional: --backup /path/to/backup.db   (default: <db>.bak-credit-subgrades-rollback-<timestamp>)
//
// Per snapshot row of the last un-rolled-back run:
//  * rank_list: the plan / condition column is set back to the exact original text — only if it still holds what
//    the migration wrote. Otherwise it is a conflict (someone edited the plan since); restored only with --force.
//  * option_update: the A–E consult_options row gets back its original active / label_fa / sort_order (same conflict rule).
//  * option_insert: the inserted A1 … E3 row is deleted (same conflict rule: still unchanged). Consultations that already
//    chose a sub-grade keep their value; the count is reported.
// Without --force, any conflict aborts the whole rollback (nothing written). Removes the 'credit-subgrades-v1' marker
// and stamps rolled_back_at on the snapshot rows (kept for audit), so the migration can be applied again later.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { MARKER, SNAPSHOT, backup } from "./credit-subgrades-migrate.mjs";

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

export function planRollback(db) {
  const out = { runAt: null, restore: [], conflicts: [], missing: [], subgradeUse: {} };
  if (!tableExists(db, SNAPSHOT)) return out;
  const last = db.prepare(`SELECT run_at FROM ${SNAPSHOT} WHERE rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`).get();
  if (!last) return out;
  out.runAt = last.run_at;
  for (const s of db.prepare(`SELECT * FROM ${SNAPSHOT} WHERE run_at=? AND rolled_back_at IS NULL ORDER BY id`).all(last.run_at)) {
    const item = { snapshotId: Number(s.id), kind: s.kind, table: s.table_name, id: Number(s.row_id), column: s.column_name };
    if (s.kind === "rank_list") {
      const row = db.prepare(`SELECT "${s.column_name}" v FROM "${s.table_name}" WHERE id=?`).get(s.row_id);
      if (!row) out.missing.push(item);
      else if (row.v === s.migrated_value) out.restore.push({ ...item, to: s.original_value });
      else out.conflicts.push({ ...item, to: s.original_value });
    } else {
      const row = db.prepare("SELECT field_key, option_value, label_fa, sort_order, active FROM consult_options WHERE id=?").get(s.row_id);
      const want = JSON.parse(s.migrated_value);
      const same = row && Object.keys(want).every((k) => String(row[k]) === String(want[k]));
      const entry = { ...item, to: s.kind === "option_update" ? JSON.parse(s.original_value) : "delete" };
      if (!row) out.missing.push(item);
      else if (same) out.restore.push(entry);
      else out.conflicts.push(entry);
    }
  }
  try {
    out.subgradeUse = {
      consultation_forms_credit_rank: Number(db.prepare("SELECT count(*) n FROM consultation_forms WHERE credit_rank GLOB '[A-E][1-3]'").get().n),
      consultation_forms_guarantor_rank: Number(db.prepare("SELECT count(*) n FROM consultation_forms WHERE guarantor_credit_rank GLOB '[A-E][1-3]'").get().n),
    };
  } catch { /* table missing in fixtures */ }
  return out;
}

export function applyRollback(db, { force = false, now = new Date().toISOString() } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planRollback(db);
    if (!plan.runAt) { db.exec("ROLLBACK"); return { applied: false, reason: "nothing to roll back" }; }
    if (plan.conflicts.length && !force) { db.exec("ROLLBACK"); return { applied: false, reason: "conflicts (use --force)", conflicts: plan.conflicts }; }
    let changed = 0;
    for (const r of [...plan.restore, ...(force ? plan.conflicts : [])]) {
      if (r.kind === "rank_list") changed += Number(db.prepare(`UPDATE "${r.table}" SET "${r.column}"=? WHERE id=?`).run(r.to, r.id).changes);
      else if (r.kind === "option_update") changed += Number(db.prepare("UPDATE consult_options SET active=?, label_fa=?, sort_order=? WHERE id=?").run(r.to.active, r.to.label_fa, r.to.sort_order, r.id).changes);
      else if (r.kind === "option_insert") changed += Number(db.prepare("DELETE FROM consult_options WHERE id=?").run(r.id).changes);
    }
    db.prepare(`UPDATE ${SNAPSHOT} SET rolled_back_at=? WHERE run_at=? AND rolled_back_at IS NULL`).run(now, plan.runAt);
    if (tableExists(db, "schema_migrations")) db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MARKER);
    db.exec("COMMIT");
    return { applied: true, changed, forced: force && plan.conflicts.length > 0, plan };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "credit-subgrades-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply"); const force = args.includes("--force");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: credit-subgrades-rollback.mjs --db <path> [--apply] [--force] [--backup <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  const brief = { runAt: plan.runAt, toRestore: plan.restore.length, conflicts: plan.conflicts.length, missingRows: plan.missing.length, subgradeUse: plan.subgradeUse };
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", ...brief, conflictRows: plan.conflicts.map(({ table, id, column, kind }) => ({ table, id, column, kind })) }, null, 2));
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply (and --force to override conflicts)."); process.exit(0); }
  if (!plan.runAt) { console.log("Nothing to roll back."); process.exit(0); }
  if (plan.conflicts.length && !force) { console.log("Conflicts found; nothing written. Review them, then re-run with --force."); process.exit(1); }
  const target = val("--backup") ?? `${dbPath}.bak-credit-subgrades-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyRollback(db, { force });
  console.log(JSON.stringify(res.applied ? { applied: true, changed: res.changed, forced: res.forced } : res, null, 2));
  db.close();
  if (!res.applied) process.exit(1);
}

// Rollback for scripts/plans-needs-flags-migrate.mjs: restores the needs_* flags saved in plans_needs_flags_snapshot.
//
//   node scripts/plans-needs-flags-rollback.mjs --db /path/to/customers.db             # dry run (default)
//   node scripts/plans-needs-flags-rollback.mjs --db /path/to/customers.db --apply     # full backup (VACUUM INTO) first, then one transaction
//   node scripts/plans-needs-flags-rollback.mjs --db ... --apply --force               # also restores flags edited after the migration
// A flag is restored only if it still holds what the migration wrote (0); otherwise it is a conflict (the plan was
// edited since) and the whole rollback aborts unless --force. Removes the 'plans-needs-flags-v1' marker and stamps
// rolled_back_at on the snapshot rows (kept for audit).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { MARKER, SNAPSHOT, backup } from "./plans-needs-flags-migrate.mjs";

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

export function planRollback(db) {
  const out = { runAt: null, restore: [], conflicts: [], missing: [] };
  if (!tableExists(db, SNAPSHOT)) return out;
  const last = db.prepare(`SELECT run_at FROM ${SNAPSHOT} WHERE rolled_back_at IS NULL ORDER BY id DESC LIMIT 1`).get();
  out.runAt = last?.run_at ?? (tableExists(db, "schema_migrations") && db.prepare("SELECT applied_at FROM schema_migrations WHERE version=?").get(MARKER)?.applied_at) ?? null;
  if (!last) return out;
  for (const s of db.prepare(`SELECT * FROM ${SNAPSHOT} WHERE run_at=? AND rolled_back_at IS NULL ORDER BY id`).all(last.run_at)) {
    const item = { snapshotId: Number(s.id), table: s.table_name, id: Number(s.row_id), column: s.column_name, to: s.original_value };
    const row = db.prepare(`SELECT "${s.column_name}" v FROM "${s.table_name}" WHERE id=?`).get(s.row_id);
    if (!row) out.missing.push(item);
    else if (String(row.v) === String(s.migrated_value)) out.restore.push(item);
    else out.conflicts.push(item);
  }
  return out;
}

export function applyRollback(db, { force = false, now = new Date().toISOString() } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planRollback(db);
    if (!plan.runAt) { db.exec("ROLLBACK"); return { applied: false, reason: "nothing to roll back" }; }
    if (plan.conflicts.length && !force) { db.exec("ROLLBACK"); return { applied: false, reason: "conflicts (use --force)", conflicts: plan.conflicts }; }
    let changed = 0;
    for (const r of [...plan.restore, ...(force ? plan.conflicts : [])])
      changed += Number(db.prepare(`UPDATE "${r.table}" SET "${r.column}"=? WHERE id=?`).run(Number(r.to), r.id).changes);
    if (tableExists(db, SNAPSHOT)) db.prepare(`UPDATE ${SNAPSHOT} SET rolled_back_at=? WHERE run_at=? AND rolled_back_at IS NULL`).run(now, plan.runAt);
    if (tableExists(db, "schema_migrations")) db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MARKER);
    db.exec("COMMIT");
    return { applied: true, changed, forced: force && plan.conflicts.length > 0, plan };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "plans-needs-flags-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply"); const force = args.includes("--force");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: plans-needs-flags-rollback.mjs --db <path> [--apply] [--force] [--backup <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", runAt: plan.runAt, toRestore: plan.restore.length, conflicts: plan.conflicts.length, missingRows: plan.missing.length }, null, 2));
  if (!apply) { console.log("Dry run: nothing written. Re-run with --apply (and --force to override conflicts)."); process.exit(0); }
  if (!plan.runAt) { console.log("Nothing to roll back."); process.exit(0); }
  if (plan.conflicts.length && !force) { console.log("Conflicts found; nothing written. Review them, then re-run with --force."); process.exit(1); }
  const target = val("--backup") ?? `${dbPath}.bak-plans-needs-flags-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyRollback(db, { force });
  console.log(JSON.stringify(res.applied ? { applied: true, changed: res.changed, forced: res.forced } : res, null, 2));
  db.close();
  if (!res.applied) process.exit(1);
}

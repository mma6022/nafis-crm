// Rollback for scripts/request-drafts-migrate.mjs.
//
//   node scripts/request-drafts-rollback.mjs --db /path/to/customers.db            # dry run (default)
//   node scripts/request-drafts-rollback.mjs --db /path/to/customers.db --apply    # full backup (VACUUM INTO) first, then one transaction
//   node scripts/request-drafts-rollback.mjs --db ... --apply --force              # also removes migrated drafts that staff edited since
//   node scripts/request-drafts-rollback.mjs --db ... --apply --drop-tables        # after a CODE rollback: drop all «در انتظار ثبت» tables
//   optional: --backup /path/to/backup.db (default: <db>.bak-request-drafts-rollback-<timestamp>)
//
// Per snapshot row not yet rolled back:
//  * draft_insert: the draft is deleted (with its audit events) if it is still open and unchanged (version 1).
//    Submitted drafts (a case exists) are never touched. Edited drafts are conflicts (removed only with --force).
//  * fee_attach: the draft gets back its original step / payload / version and fee_charge_id=NULL, if still open
//    and unchanged since the migration (same conflict rule).
// loan_filing_fee_charges, wallets, ledgers, customers and cases are never touched (the migration never changed them).
// NOTE: while the new API is running, its periodic sync (decision 6) re-creates drafts for fee charges without a
// case within minutes. Roll back the code first, or run the API with LOAN_REQUEST_DRAFTS_JOBS=off.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { MARKER, SNAPSHOT, backup } from "./request-drafts-migrate.mjs";

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
export const DRAFT_TABLES = ["loan_request_draft_events", "loan_request_draft_job_runs", "loan_request_drafts"];

export function planRollback(db) {
  const out = { restore: [], conflicts: [], keep: [], missing: [] };
  if (!tableExists(db, SNAPSHOT)) return out;
  for (const s of db.prepare(`SELECT * FROM ${SNAPSHOT} WHERE rolled_back_at IS NULL AND kind IN ('draft_insert','fee_attach') ORDER BY id`).all()) {
    const item = { snapshotId: Number(s.id), kind: s.kind, draftId: Number(s.draft_id), chargeId: Number(s.charge_id), customerId: Number(s.customer_id), amountToman: s.amount_toman };
    const d = db.prepare("SELECT d.*, f.application_id fee_app FROM loan_request_drafts d LEFT JOIN loan_filing_fee_charges f ON f.id=d.fee_charge_id WHERE d.id=?").get(s.draft_id);
    if (!d) { out.missing.push(item); continue; }
    if (d.status === "submitted" || d.application_id != null || d.fee_app != null) { out.keep.push({ ...item, reason: "became_case" }); continue; }
    const migrated = JSON.parse(s.migrated_value ?? "{}");
    const unchanged = Number(d.fee_charge_id) === Number(s.charge_id) && d.deleted_at == null && d.payload_json === migrated.payload_json
      && Number(d.step) === Number(migrated.step) && (s.kind === "draft_insert" ? Number(d.version) === 1 : true);
    (unchanged ? out.restore : out.conflicts).push(item);
  }
  return out;
}

export function applyRollback(db, { force = false, dropTables = false } = {}, now = new Date().toISOString()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const plan = planRollback(db);
    if (plan.conflicts.length && !force) { db.exec("ROLLBACK"); return { applied: false, reason: "conflicts", plan }; }
    let changed = 0;
    for (const it of [...plan.restore, ...(force ? plan.conflicts : [])]) {
      const s = db.prepare(`SELECT * FROM ${SNAPSHOT} WHERE id=?`).get(it.snapshotId);
      if (it.kind === "draft_insert") {
        db.prepare("DELETE FROM loan_request_draft_events WHERE draft_id=?").run(it.draftId);
        changed += Number(db.prepare("DELETE FROM loan_request_drafts WHERE id=? AND status<>'submitted' AND application_id IS NULL").run(it.draftId).changes);
      } else {
        const o = JSON.parse(s.original_value);
        changed += Number(db.prepare("UPDATE loan_request_drafts SET fee_charge_id=NULL,step=?,payload_json=?,version=?,updated_at=?,expiry_warned_at=? WHERE id=? AND status<>'submitted'")
          .run(o.step, o.payload_json, o.version, o.updated_at, o.expiry_warned_at ?? o.warned_at ?? null, it.draftId).changes);
        db.prepare("INSERT INTO loan_request_draft_events(draft_id,customer_id,action,actor_user_id,reason,detail_json,created_at) VALUES(?,?,'fee_unlinked',NULL,?,?,?)")
          .run(it.draftId, it.customerId, `${MARKER} rollback`, JSON.stringify({ feeChargeId: it.chargeId }), now);
      }
      db.prepare(`UPDATE ${SNAPSHOT} SET rolled_back_at=? WHERE id=?`).run(now, it.snapshotId);
    }
    db.prepare(`UPDATE ${SNAPSHOT} SET rolled_back_at=? WHERE rolled_back_at IS NULL AND kind='skip'`).run(now);
    if (tableExists(db, "schema_migrations")) db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MARKER);
    let dropped = [];
    if (dropTables) {
      const submitted = tableExists(db, "loan_request_drafts") ? Number(db.prepare("SELECT count(*) n FROM loan_request_drafts").get().n) : 0;
      for (const t of DRAFT_TABLES) if (tableExists(db, t)) { db.exec(`DROP TABLE "${t}"`); dropped.push(t); }
      if (tableExists(db, "site_notification_events")) db.prepare("DELETE FROM site_notification_events WHERE resource_type='loan_draft'").run();
      dropped.push(`(${submitted} draft rows incl. history; snapshot table kept)`);
    }
    db.exec("COMMIT");
    return { applied: true, changed, runAt: now, plan, dropped };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "request-drafts-rollback.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply"); const force = args.includes("--force"); const dropTables = args.includes("--drop-tables");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: request-drafts-rollback.mjs --db <path> [--apply] [--force] [--drop-tables] [--backup <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planRollback(db);
  const brief = (xs) => xs.map(({ draftId, chargeId, customerId, kind }) => ({ draftId, chargeId, customerId, kind }));
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", restore: plan.restore.length, conflicts: plan.conflicts.length, keepBecameCase: plan.keep.length,
    missing: plan.missing.length, items: { restore: brief(plan.restore), conflicts: brief(plan.conflicts), keep: brief(plan.keep) }, dropTables }, null, 2));
  if (!apply) { console.log("Dry run: nothing written."); process.exit(0); }
  const target = val("--backup") ?? `${dbPath}.bak-request-drafts-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyRollback(db, { force, dropTables });
  console.log(JSON.stringify({ applied: res.applied, reason: res.reason, changed: res.changed, dropped: res.dropped }, null, 2));
  db.close();
  if (!res.applied) process.exit(1);
}

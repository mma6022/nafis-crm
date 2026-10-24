// Backfill for crm-no-plan-option «اطلاعات مشاوره» (steering 2026-10-24 14:51).
//
//   node scripts/consult-profile-backfill.mjs --db /path/to/customers.db            # dry run (default): counts only, read-only
//   node scripts/consult-profile-backfill.mjs --db /path/to/customers.db --apply    # backup (VACUUM INTO) + insert versions
//   optional: --backup /path/to/backup.db
//
// Where the old answers live: Kazemi's first-call form answers are only in team_sales_qualifications.answers_json
// (mode "simple"; formVersion 2 = with guarantor/job/plan step, older rows = the 3-step form) plus selected_plans_json,
// no_plan_fit and no_plan_note. Each ANSWERED row becomes one history version (source 'backfill', its own created_at and
// author), oldest first, so the latest one is the current value. Additive only: one new table, rows only inserted.
// Skipped: no-answer/callback rows, non-first-call (full-form) rows, merged customers, customers owned by trainees
// (salespersons 5, 19, 20), and rows already in the history (idempotent: unique qualification_id).
// Undo: scripts/consult-profile-backfill-rollback.mjs (deletes only source='backfill' rows).
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

export const TABLE = "customer_consult_profile_versions";
export const TRAINEE_SALESPERSON_IDS = [5, 19, 20];
export const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
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
  CREATE INDEX IF NOT EXISTS idx_consult_profile_customer ON ${TABLE}(customer_id, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_consult_profile_qualification ON ${TABLE}(qualification_id) WHERE qualification_id IS NOT NULL;`;

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasColumn = (db, t, c) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().some((r) => r.name === c);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Same shape as src/lib/consult-profile.ts dataFromAnswers. */
export function dataFromRow(a, row) {
  const guarantor = str(a.guarantorAvailable);
  let selected = [];
  try { const v = row.selected_plans_json ? JSON.parse(row.selected_plans_json) : []; selected = Array.isArray(v) ? v : []; } catch { selected = []; }
  return {
    jobType: str(a.jobType), guarantorAvailable: guarantor,
    guarantorCheque: guarantor === "yes" ? str(a.guarantorCheque) : null,
    creditRank: str(a.creditRank), gRank: guarantor === "yes" ? str(a.gRank) : null,
    gJobType: guarantor === "yes" ? str(a.gJobType) : null, military: str(a.military), city: str(a.city),
    selectedPlans: selected.filter((p) => p && typeof p === "object").map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), status: p.status ?? null })),
    noPlanFit: Number(row.no_plan_fit) === 1, noPlanNote: str(row.no_plan_note),
    urgency: str(a.urgency), formDate: row.created_at, submitterName: row.submitter_name ?? null,
  };
}

export function planBackfill(db) {
  const counts = { qualificationRows: 0, answered: 0, firstCallForm: 0, formVersion2: 0, olderThreeStep: 0,
    skippedNotFirstCall: 0, skippedMerged: 0, skippedTrainee: 0, skippedMissingCustomer: 0, skippedBadJson: 0, alreadyInHistory: 0,
    toInsert: 0, customers: 0, withSelectedPlans: 0, withNoPlanFit: 0 };
  if (!hasTable(db, "team_sales_qualifications")) return { counts, rows: [], tableExists: hasTable(db, TABLE) };
  const extra = ["selected_plans_json", "no_plan_fit", "no_plan_note"].map((c) => (hasColumn(db, "team_sales_qualifications", c) ? `q.${c}` : `NULL AS ${c}`));
  const rows = db.prepare(`
    SELECT q.id, q.customer_id, q.actor_user_id, q.call_result, q.answers_json, q.created_at, ${extra.join(", ")},
           c.id AS cid, c.salesperson_id, c.merged_into_customer_id, COALESCE(s.name, u.full_name) AS submitter_name
    FROM team_sales_qualifications q
    LEFT JOIN customers c ON c.id=q.customer_id
    LEFT JOIN users u ON u.id=q.actor_user_id LEFT JOIN salespersons s ON s.id=u.salesperson_id
    ORDER BY q.created_at, q.id`).all();
  const existing = hasTable(db, TABLE)
    ? new Set(db.prepare(`SELECT qualification_id FROM ${TABLE} WHERE qualification_id IS NOT NULL`).all().map((r) => Number(r.qualification_id)))
    : new Set();
  const out = []; const customers = new Set();
  for (const r of rows) {
    counts.qualificationRows++;
    if (r.call_result !== "answered") continue;
    counts.answered++;
    let a;
    try { a = JSON.parse(r.answers_json) ?? {}; } catch { counts.skippedBadJson++; continue; }
    if (a.mode !== "simple") { counts.skippedNotFirstCall++; continue; }
    counts.firstCallForm++;
    if (a.formVersion === 2) counts.formVersion2++; else counts.olderThreeStep++;
    if (r.cid == null) { counts.skippedMissingCustomer++; continue; }
    if (r.merged_into_customer_id != null) { counts.skippedMerged++; continue; }
    if (TRAINEE_SALESPERSON_IDS.includes(Number(r.salesperson_id))) { counts.skippedTrainee++; continue; }
    if (existing.has(Number(r.id))) { counts.alreadyInHistory++; continue; }
    const data = dataFromRow(a, r);
    if (data.selectedPlans.length) counts.withSelectedPlans++;
    if (data.noPlanFit) counts.withNoPlanFit++;
    customers.add(Number(r.customer_id));
    out.push({ qualificationId: Number(r.id), customerId: Number(r.customer_id), actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
      actorName: r.submitter_name ?? null, createdAt: r.created_at, data });
  }
  counts.toInsert = out.length; counts.customers = customers.size;
  return { counts, rows: out, tableExists: hasTable(db, TABLE) };
}

export function applyBackfill(db, plan) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(CREATE_SQL);
    const ins = db.prepare(`INSERT OR IGNORE INTO ${TABLE} (customer_id, source, qualification_id, data_json, changed_fields_json, actor_user_id, actor_name, created_at)
      VALUES (?, 'backfill', ?, ?, NULL, ?, ?, ?)`);
    let inserted = 0;
    for (const r of plan.rows) inserted += Number(ins.run(r.customerId, r.qualificationId, JSON.stringify(r.data), r.actorUserId, r.actorName, r.createdAt).changes);
    db.exec("COMMIT");
    return { inserted };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

if (process.argv[1] && path.basename(process.argv[1]) === "consult-profile-backfill.mjs") {
  const args = process.argv.slice(2);
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = val("--db"); const apply = args.includes("--apply");
  if (!dbPath || dbPath.startsWith("--")) { console.error("Usage: consult-profile-backfill.mjs --db <path> [--apply] [--backup <path>]"); process.exit(2); }
  if (!existsSync(dbPath)) { console.error(`No such database: ${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: !apply, timeout: 15000 });
  const plan = planBackfill(db);
  console.log(JSON.stringify({ db: dbPath, mode: apply ? "apply" : "dry-run", historyTableExists: plan.tableExists, counts: plan.counts }, null, 2));
  if (!apply) { console.log(plan.rows.length ? `Dry run: would insert ${plan.rows.length} version(s). Re-run with --apply.` : "Dry run: nothing to do."); process.exit(0); }
  if (!plan.rows.length) { console.log("Nothing to backfill."); process.exit(0); }
  const target = val("--backup") ?? `${dbPath}.bak-consult-profile-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(target)) { console.error(`backup target exists: ${target}`); process.exit(2); }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`Backup written: ${target}`);
  console.log(JSON.stringify(applyBackfill(db, plan)));
  db.close();
}

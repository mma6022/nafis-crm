// Data migration: «در انتظار ثبت». Filing-fee charges that never became a case get a server-side draft.
//
//   node scripts/request-drafts-migrate.mjs --db /path/to/customers.db            # dry run (default): prints the plan, writes nothing
//   node scripts/request-drafts-migrate.mjs --db /path/to/customers.db --apply    # full backup (VACUUM INTO) first, then one transaction
//   optional: --backup /path/to/backup.db     (default: <db>.bak-request-drafts-<timestamp>)
//             --log /path/to/log.json          (default: <db>.request-drafts-<timestamp>.log.json; written on --apply, mode 600)
//             --include-zero                   also convert 0-toman charges (default: only charges with amount > 0)
//             --exclude-salespersons 5,19      leave customers of these salespersons alone (reported as skipped)
//             --grace-minutes 15               charges younger than this are left for the wizard (default 15)
//
// What --apply does (additive only):
//  * creates the tables loan_request_drafts / loan_request_draft_events / loan_request_draft_job_runs if missing
//    (same DDL as src/lib/loan-request-drafts.ts — the fixture checks they are identical);
//  * per orphan charge (loan_filing_fee_charges.application_id IS NULL and no draft points at it):
//      - customer has no open draft → INSERT a draft (step 8 «مدارک هویتی», source 'crm'/'portal' by where it was paid, created_at = charge time);
//      - customer has an open draft without a fee → that draft gets fee_charge_id (plan bound to the charge);
//      - otherwise skipped with a reason (merged customer, second orphan of the same customer, excluded salesperson…).
//  * NEVER changed: loan_filing_fee_charges, wallets / ledgers, customers, loan_applications, contracts, commissions,
//    team_sales_config. No notification, SMS or outbound message is created.
// Every change is recorded in loan_request_drafts_migration_snapshot (used by scripts/request-drafts-rollback.mjs).
// Idempotent: a charge that already has a draft is never a candidate, so a second --apply changes nothing.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKER = "request-drafts-v1";
export const SNAPSHOT = "loan_request_drafts_migration_snapshot";
export const ORPHAN_FEE_STEP = 8;
export const DRAFTS_DDL = `
  CREATE TABLE IF NOT EXISTS loan_request_drafts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending_registration' CHECK(status IN ('pending_registration','submitted','deleted','expired')),
    source TEXT NOT NULL DEFAULT 'crm' CHECK(source IN ('crm','portal')),
    created_by_user_id INTEGER,
    salesperson_id INTEGER,
    step INTEGER NOT NULL DEFAULT 1 CHECK(step BETWEEN 1 AND 10),
    payload_json TEXT NOT NULL DEFAULT '{}',
    fee_charge_id INTEGER UNIQUE REFERENCES loan_filing_fee_charges(id) ON DELETE RESTRICT,
    application_id INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER,
    expiry_warned_at TEXT,
    last_reminded_on TEXT,
    deleted_at TEXT,
    deleted_by INTEGER,
    delete_reason TEXT,
    delete_kind TEXT CHECK(delete_kind IS NULL OR delete_kind IN ('manual','auto_expired'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_request_drafts_one_open ON loan_request_drafts(customer_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_loan_request_drafts_open ON loan_request_drafts(deleted_at,updated_at);
  CREATE TABLE IF NOT EXISTS loan_request_draft_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_user_id INTEGER,
    reason TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_loan_request_draft_events_customer ON loan_request_draft_events(customer_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_loan_request_draft_events_draft ON loan_request_draft_events(draft_id,id);
  CREATE TABLE IF NOT EXISTS loan_request_draft_job_runs(
    job TEXT NOT NULL, day TEXT NOT NULL, ran_at TEXT NOT NULL, detail_json TEXT, PRIMARY KEY(job,day)
  );`;

const tableExists = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const toman = (v) => (/^\d+$/.test(String(v ?? "")) ? BigInt(String(v)) : 0n);

/** Same rules as orphanFeeCandidates() in src/lib/loan-request-drafts.ts (the fixture compares both). Read-only. */
export function planMigration(db, { nowMs = Date.now(), includeZero = false, graceMinutes = 15, excludeSalespersons = [] } = {}) {
  const hasDrafts = tableExists(db, "loan_request_drafts");
  const cutoff = new Date(nowMs - graceMinutes * 60_000).toISOString();
  const rows = db.prepare(`SELECT f.id,f.customer_id,f.plan_id,f.amount_toman,f.created_at,f.actor_user_id,f.actor_customer_id,c.salesperson_id,c.merged_into_customer_id
    FROM loan_filing_fee_charges f JOIN customers c ON c.id=f.customer_id
    WHERE f.application_id IS NULL AND f.created_at<=? ${includeZero ? "" : "AND CAST(f.amount_toman AS INTEGER)>0"}
      ${hasDrafts ? "AND NOT EXISTS (SELECT 1 FROM loan_request_drafts d WHERE d.fee_charge_id=f.id)" : ""}
    ORDER BY f.id`).all(cutoff);
  const seen = new Set();
  const openFor = hasDrafts ? db.prepare("SELECT id,fee_charge_id FROM loan_request_drafts WHERE customer_id=? AND deleted_at IS NULL") : null;
  return rows.map((r) => {
    const base = { chargeId: Number(r.id), customerId: Number(r.customer_id), planId: Number(r.plan_id), amountToman: String(r.amount_toman), createdAt: r.created_at,
      actorUserId: r.actor_user_id ?? null, actorCustomerId: r.actor_customer_id ?? null, salespersonId: r.salesperson_id ?? null };
    if (r.merged_into_customer_id != null) return { ...base, action: "skip", skipReason: "customer_merged" };
    if (excludeSalespersons.includes(Number(r.salesperson_id))) return { ...base, action: "skip", skipReason: "salesperson_excluded" };
    if (seen.has(base.customerId)) return { ...base, action: "skip", skipReason: "second_orphan_same_customer" };
    seen.add(base.customerId);
    const open = openFor?.get(base.customerId);
    if (open && open.fee_charge_id != null) return { ...base, action: "skip", draftId: Number(open.id), skipReason: "open_draft_has_other_fee" };
    if (open) return { ...base, action: "attach", draftId: Number(open.id) };
    return { ...base, action: "create" };
  });
}

/** Ids and counts only (no names / phones). */
export function summary(cands) {
  const sum = (xs) => xs.reduce((a, c) => a + toman(c.amountToman), 0n).toString();
  const act = cands.filter((c) => c.action !== "skip");
  const by = (xs, k) => xs.reduce((a, c) => ({ ...a, [c[k] ?? "none"]: (a[c[k] ?? "none"] ?? 0) + 1 }), {});
  return {
    candidates: cands.length, toCreate: cands.filter((c) => c.action === "create").length, toAttach: cands.filter((c) => c.action === "attach").length,
    skipped: cands.filter((c) => c.action === "skip").length, skipReasons: by(cands.filter((c) => c.action === "skip"), "skipReason"),
    paidCount: act.filter((c) => toman(c.amountToman) > 0n).length, zeroCount: act.filter((c) => toman(c.amountToman) === 0n).length,
    sumToman: sum(act), skippedSumToman: sum(cands.filter((c) => c.action === "skip")),
    portal: act.filter((c) => c.actorCustomerId != null).length, staff: act.filter((c) => c.actorCustomerId == null).length,
    bySalesperson: by(act, "salespersonId"),
    items: cands.map((c) => ({ chargeId: c.chargeId, customerId: c.customerId, amountToman: c.amountToman, action: c.action, ...(c.skipReason ? { skipReason: c.skipReason } : {}), ...(c.draftId ? { draftId: c.draftId } : {}) })),
  };
}

export function ensureTables(db) {
  db.exec(DRAFTS_DDL);
  db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    kind TEXT NOT NULL,              -- draft_insert | fee_attach | skip
    charge_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    amount_toman TEXT NOT NULL,
    draft_id INTEGER,
    original_value TEXT,             -- fee_attach: JSON of the draft row before (step, payload_json, version, updated_at, expiry_warned_at)
    migrated_value TEXT,             -- JSON of what the migration wrote
    skip_reason TEXT,
    rolled_back_at TEXT
  )`);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
}

/** Re-plans inside BEGIN IMMEDIATE so a concurrent wizard save cannot slip between plan and write. */
export function applyMigration(db, opts = {}, now = new Date().toISOString()) {
  ensureTables(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const cands = planMigration(db, { ...opts, nowMs: Date.parse(now) });
    const snap = db.prepare(`INSERT INTO ${SNAPSHOT}(run_at,kind,charge_id,customer_id,amount_toman,draft_id,original_value,migrated_value,skip_reason) VALUES(?,?,?,?,?,?,?,?,?)`);
    const audit = db.prepare("INSERT INTO loan_request_draft_events(draft_id,customer_id,action,actor_user_id,reason,detail_json,created_at) VALUES(?,?,?,NULL,?,?,?)");
    const planName = (id) => db.prepare("SELECT name FROM loan_plans WHERE id=?").get(id)?.name ?? null;
    const made = [];
    for (const c of cands) {
      if (c.action === "skip") { snap.run(now, "skip", c.chargeId, c.customerId, c.amountToman, c.draftId ?? null, null, null, c.skipReason); continue; }
      if (db.prepare("SELECT 1 FROM loan_request_drafts WHERE fee_charge_id=?").get(c.chargeId)) continue;
      if (c.action === "attach") {
        const d = db.prepare("SELECT step,payload_json,version,updated_at,expiry_warned_at FROM loan_request_drafts WHERE id=? AND deleted_at IS NULL AND fee_charge_id IS NULL").get(c.draftId);
        if (!d) continue;
        let payload = {}; try { payload = JSON.parse(d.payload_json) ?? {}; } catch { /* keep {} */ }
        const next = { step: Math.max(Number(d.step), ORPHAN_FEE_STEP), payload_json: JSON.stringify({ ...payload, planId: c.planId, planName: planName(c.planId) }) };
        db.prepare("UPDATE loan_request_drafts SET fee_charge_id=?,payload_json=?,step=?,version=version+1,updated_at=?,expiry_warned_at=NULL WHERE id=? AND fee_charge_id IS NULL")
          .run(c.chargeId, next.payload_json, next.step, now, c.draftId);
        snap.run(now, "fee_attach", c.chargeId, c.customerId, c.amountToman, c.draftId, JSON.stringify(d), JSON.stringify({ ...next, fee_charge_id: c.chargeId }), null);
        audit.run(c.draftId, c.customerId, "fee_linked", MARKER, JSON.stringify({ feeChargeId: c.chargeId }), now);
        made.push({ ...c });
        continue;
      }
      const portal = c.actorCustomerId != null;
      const payload = JSON.stringify({ planId: c.planId, planName: planName(c.planId), origin: portal ? "portal" : "crm" });
      const id = Number(db.prepare(`INSERT INTO loan_request_drafts(customer_id,source,created_by_user_id,salesperson_id,step,payload_json,fee_charge_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(c.customerId, portal ? "portal" : "crm", c.actorUserId, c.salespersonId, ORPHAN_FEE_STEP, payload, c.chargeId, c.createdAt, now).lastInsertRowid);
      snap.run(now, "draft_insert", c.chargeId, c.customerId, c.amountToman, id, null, JSON.stringify({ step: ORPHAN_FEE_STEP, payload_json: payload, version: 1 }), null);
      audit.run(id, c.customerId, "created_from_fee", MARKER, JSON.stringify({ feeChargeId: c.chargeId, portal }), now);
      made.push({ ...c, draftId: id });
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?,?)").run(MARKER, now);
    db.exec("COMMIT");
    return { applied: true, runAt: now, changed: made.length, plan: cands, made };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
}

// Protected tables: their row counts must be identical before and after (money, cases, contracts, commissions).
const COUNTED = ["loan_filing_fee_charges", "loan_applications", "customers", "wallet_ledger_v2", "wallet_accounts_v2", "company_wallet_ledger", "goods_finance_ledger",
  "team_commission_ledger_meta", "team_commission_purchases", "team_commission_settings", "team_sales_config", "contract_templates", "contract_generations",
  "wallet_payment_intents", "customer_payment_orders", "site_notification_events"];
export function fingerprint(db) {
  const out = {};
  for (const t of COUNTED.filter((t) => tableExists(db, t))) out[t] = Number(db.prepare(`SELECT count(*) n FROM "${t}"`).get().n);
  if (tableExists(db, "loan_filing_fee_charges")) {
    const r = db.prepare("SELECT COALESCE(SUM(CAST(amount_toman AS INTEGER)),0) s, SUM(application_id IS NULL) open FROM loan_filing_fee_charges").get();
    out.fee_sum_toman = String(r.s); out.fee_without_case = Number(r.open ?? 0);
  }
  return out;
}

export function backup(db, target) {
  if (existsSync(target)) throw new Error(`backup target exists: ${target}`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  chmodSync(target, 0o600); // full copy of customer data: owner-only
  const b = new DatabaseSync(target, { readOnly: true });
  try {
    const ok = b.prepare("PRAGMA integrity_check").get();
    if (Object.values(ok)[0] !== "ok") throw new Error("backup integrity_check failed");
    if (JSON.stringify(fingerprint(b)) !== JSON.stringify(fingerprint(db))) throw new Error("backup row count mismatch");
  } finally { b.close(); }
}

export function parseArgs(argv) {
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    db: val("--db"), apply: argv.includes("--apply"), backup: val("--backup"), log: val("--log"),
    includeZero: argv.includes("--include-zero"), graceMinutes: val("--grace-minutes") == null ? 15 : Number(val("--grace-minutes")),
    excludeSalespersons: String(val("--exclude-salespersons") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === "request-drafts-migrate.mjs") {
  const a = parseArgs(process.argv.slice(2));
  if (!a.db || a.db.startsWith("--")) { console.error("Usage: request-drafts-migrate.mjs --db <path> [--apply] [--backup <path>] [--log <path>] [--include-zero] [--exclude-salespersons 5,19] [--grace-minutes 15]  (explicit path required)"); process.exit(2); }
  if (!existsSync(a.db)) { console.error(`No such database: ${a.db}`); process.exit(2); }
  if (!Number.isFinite(a.graceMinutes) || a.graceMinutes < 0) { console.error("--grace-minutes must be >= 0"); process.exit(2); }
  const db = new DatabaseSync(a.db, { readOnly: !a.apply, timeout: 15000 });
  const opts = { includeZero: a.includeZero, graceMinutes: a.graceMinutes, excludeSalespersons: a.excludeSalespersons };
  const plan = planMigration(db, opts);
  const before = fingerprint(db);
  console.log(JSON.stringify({ db: a.db, mode: a.apply ? "apply" : "dry-run", options: opts, ...summary(plan) }, null, 2));
  if (!a.apply) { console.log("Dry run: nothing written. Re-run with --apply to change data."); process.exit(0); }
  if (!plan.some((c) => c.action !== "skip") && tableExists(db, SNAPSHOT)) { console.log("Nothing to convert (already applied); no changes, no backup."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = a.backup ?? `${a.db}.bak-request-drafts-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyMigration(db, opts);
  const after = fingerprint(db);
  if (JSON.stringify(after) !== JSON.stringify(before)) console.error("WARNING: protected table fingerprint changed during migration", { before, after });
  const logPath = a.log ?? `${a.db}.request-drafts-${stamp}.log.json`;
  writeFileSync(logPath, JSON.stringify({ marker: MARKER, runAt: res.runAt, backup: target, options: opts, changed: res.changed, ...summary(res.plan),
    made: res.made.map((m) => ({ chargeId: m.chargeId, customerId: m.customerId, draftId: m.draftId, action: m.action, amountToman: m.amountToman })),
    protectedTablesUnchanged: JSON.stringify(after) === JSON.stringify(before), fingerprint: after }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ applied: true, changed: res.changed, runAt: res.runAt, log: logPath, protectedTablesUnchanged: JSON.stringify(after) === JSON.stringify(before) }, null, 2));
  db.close();
}

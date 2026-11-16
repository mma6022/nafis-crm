// Schema migration: «در انتظار ثبت». SCHEMA ONLY — it converts no data (PM, 24 Oct 2026).
//
//   node scripts/request-drafts-migrate.mjs --db /path/to/customers.db            # dry run (default): prints the plan, writes nothing
//   node scripts/request-drafts-migrate.mjs --db /path/to/customers.db --apply    # full backup (VACUUM INTO) first, then one transaction
//   optional: --backup /path/to/backup.db     (default: <db>.bak-request-drafts-<timestamp>)
//             --log /path/to/log.json          (default: <db>.request-drafts-<timestamp>.log.json; written on --apply, mode 600)
//
// What --apply does (additive, schema only):
//  * creates the EMPTY tables loan_request_drafts / loan_request_draft_events / loan_request_draft_job_runs (+ indexes) if missing
//    (same DDL as src/lib/loan-request-drafts.ts — the fixture checks they are identical);
//  * records the marker 'request-drafts-v1' in schema_migrations.
//  * Orphan fee charges (paid or 0-toman, no case) are NOT converted. Admins see the paid ones read-only in the queue,
//    computed at read time. Old pre-registration cases at stage 'draft' are shown read-only too; nothing is written for them.
//  * NEVER changed: any existing row of any table (fee charges, wallets / ledgers, customers, loan_applications, contracts,
//    commissions, team_sales_config, notifications). The protected-table fingerprint is compared before/after.
// Idempotent: a second --apply finds nothing to do and exits without a backup.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MARKER = "request-drafts-v1";
export const DRAFT_TABLES = ["loan_request_drafts", "loan_request_draft_events", "loan_request_draft_job_runs"];
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
const markerPresent = (db) => tableExists(db, "schema_migrations") && !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(MARKER);

/** Read-only. Ids and counts only (no names / phones). `convert` is always 0: this migration converts nothing. */
export function planMigration(db) {
  const missing = DRAFT_TABLES.filter((t) => !tableExists(db, t));
  const info = {};
  if (tableExists(db, "loan_filing_fee_charges")) {
    const draftsJoin = tableExists(db, "loan_request_drafts") ? "AND NOT EXISTS (SELECT 1 FROM loan_request_drafts d WHERE d.fee_charge_id=f.id AND d.deleted_at IS NULL)" : "";
    const r = db.prepare(`SELECT count(*) n, COALESCE(SUM(CAST(amount_toman AS INTEGER)>0),0) paid, COALESCE(SUM(CAST(amount_toman AS INTEGER)),0) s
      FROM loan_filing_fee_charges f WHERE f.application_id IS NULL ${draftsJoin}`).get();
    info.feeChargesWithoutCase = Number(r.n); info.paidWithoutCase = Number(r.paid); info.paidWithoutCaseSumToman = String(r.s);
    info.paidWithoutCaseIds = db.prepare(`SELECT id FROM loan_filing_fee_charges f WHERE f.application_id IS NULL AND CAST(amount_toman AS INTEGER)>0 ${draftsJoin} ORDER BY id`).all().map((x) => Number(x.id));
  }
  if (tableExists(db, "loan_applications")) {
    info.hiddenPreRegistrationDraftCaseIds = db.prepare("SELECT id FROM loan_applications WHERE deleted_at IS NULL AND stage='draft' AND COALESCE(is_pre_registration,0)=1 ORDER BY id").all().map((x) => Number(x.id));
  }
  return { schemaOnly: true, tablesToCreate: missing, markerPresent: markerPresent(db), convert: 0, readTimeOnly: info };
}

export function ensureTables(db) {
  db.exec(DRAFTS_DDL);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
}

/** One BEGIN IMMEDIATE transaction: CREATE TABLE/INDEX IF NOT EXISTS + marker. No data row is inserted, updated or deleted elsewhere. */
export function applyMigration(db, now = new Date().toISOString()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = planMigration(db);
    ensureTables(db);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?,?)").run(MARKER, now);
    db.exec("COMMIT");
    return { applied: true, runAt: now, createdTables: before.tablesToCreate, converted: 0 };
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
  return { db: val("--db"), apply: argv.includes("--apply"), backup: val("--backup"), log: val("--log") };
}

if (process.argv[1] && path.basename(process.argv[1]) === "request-drafts-migrate.mjs") {
  const a = parseArgs(process.argv.slice(2));
  if (!a.db || a.db.startsWith("--")) { console.error("Usage: request-drafts-migrate.mjs --db <path> [--apply] [--backup <path>] [--log <path>]  (explicit path required)"); process.exit(2); }
  if (!existsSync(a.db)) { console.error(`No such database: ${a.db}`); process.exit(2); }
  const db = new DatabaseSync(a.db, { readOnly: !a.apply, timeout: 15000 });
  const plan = planMigration(db);
  const before = fingerprint(db);
  console.log(JSON.stringify({ db: a.db, mode: a.apply ? "apply" : "dry-run", ...plan }, null, 2));
  if (!a.apply) { console.log("Dry run: nothing written. Schema only; converts 0 rows. Re-run with --apply to create the tables."); process.exit(0); }
  if (!plan.tablesToCreate.length && plan.markerPresent) { console.log("Already applied; no changes, no backup."); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = a.backup ?? `${a.db}.bak-request-drafts-${stamp}`;
  backup(db, target);
  console.log(`Backup written and verified: ${target}`);
  const res = applyMigration(db);
  const after = fingerprint(db);
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  if (!unchanged) console.error("WARNING: protected table fingerprint changed during migration", { before, after });
  const logPath = a.log ?? `${a.db}.request-drafts-${stamp}.log.json`;
  writeFileSync(logPath, JSON.stringify({ marker: MARKER, runAt: res.runAt, backup: target, createdTables: res.createdTables, converted: 0,
    protectedTablesUnchanged: unchanged, fingerprint: after }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ applied: true, createdTables: res.createdTables, converted: 0, runAt: res.runAt, log: logPath, protectedTablesUnchanged: unchanged }, null, 2));
  db.close();
}

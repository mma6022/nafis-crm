/**
 * Additive schema for flag.multi_case_v1. Safe to run more than once.
 * The API also applies this on boot (ensureMultiCaseSchema / ensureLoanRequestDraftSchema).
 *
 *   node scripts/multi-case-migrate.mjs /path/to/customers.db
 *
 * Does not set the flag. Leave flag.multi_case_v1 absent (OFF) until release.
 * Does not edit contract templates or contract rows.
 */
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/multi-case-migrate.mjs <customers.db>"); process.exit(1); }
const db = new DatabaseSync(file);
const cols = (table) => { try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; } };
const has = (table) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(table);

db.exec(`CREATE TABLE IF NOT EXISTS loan_plan_open_slots (
  customer_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  charge_id INTEGER,
  application_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, plan_id)
);`);
if (has("call_logs") && !cols("call_logs").includes("loan_application_id")) db.exec("ALTER TABLE call_logs ADD COLUMN loan_application_id INTEGER");
if (has("reminders") && !cols("reminders").includes("loan_application_id")) db.exec("ALTER TABLE reminders ADD COLUMN loan_application_id INTEGER");
if (cols("call_logs").includes("loan_application_id")) db.exec("CREATE INDEX IF NOT EXISTS idx_call_logs_loan_app ON call_logs(loan_application_id)");
if (cols("reminders").includes("loan_application_id")) db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_loan_app ON reminders(loan_application_id)");
if (has("loan_applications") && ["status", "stage", "deleted_at", "plan_id"].every((c) => cols("loan_applications").includes(c))) {
  db.exec(`DROP TRIGGER IF EXISTS trg_mc_release_open_slot;
    CREATE TRIGGER trg_mc_release_open_slot
    AFTER UPDATE OF status, stage, deleted_at ON loan_applications
    FOR EACH ROW
    WHEN NEW.status = 'rejected' OR NEW.stage = 'completed' OR NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM loan_plan_open_slots WHERE application_id = NEW.id;
    END;`);
}
if (has("loan_request_drafts") && !cols("loan_request_drafts").includes("request_key")) {
  db.exec("ALTER TABLE loan_request_drafts ADD COLUMN request_key TEXT");
}
if (has("loan_request_drafts")) {
  db.exec(`DROP INDEX IF EXISTS idx_loan_request_drafts_one_open;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_request_drafts_one_legacy
      ON loan_request_drafts(customer_id) WHERE deleted_at IS NULL AND request_key IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_request_drafts_request
      ON loan_request_drafts(customer_id, request_key) WHERE deleted_at IS NULL AND request_key IS NOT NULL;`);
}
console.log("multi-case v1 schema applied (flag left OFF). Rollback: scripts/multi-case-rollback.mjs");
db.close();

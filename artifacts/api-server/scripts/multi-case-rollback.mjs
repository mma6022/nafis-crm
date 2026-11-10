/**
 * Roll back multi-case v1 schema after the flag is OFF.
 * Nullable columns stay: SQLite cannot drop a column without rewriting the table,
 * and unused NULL columns do not change flag-off behavior.
 *
 *   node scripts/multi-case-rollback.mjs /path/to/customers.db
 *
 * Refuses to restore the old one-draft unique index if two open drafts exist.
 * Does not touch contract templates, contract rows, wallets, or the flag row
 * beyond setting flag.multi_case_v1 and per-user keys to 0 when those rows exist.
 */
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/multi-case-rollback.mjs <customers.db>"); process.exit(1); }
const db = new DatabaseSync(file);
const has = (table) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(table);
db.exec("DROP TRIGGER IF EXISTS trg_mc_release_open_slot");
db.exec("DROP TABLE IF EXISTS loan_plan_open_slots");
if (has("call_queue_settings")) {
  db.prepare("UPDATE call_queue_settings SET value='0' WHERE key=? OR key LIKE 'flag.multi_case_v1.user.%'").run("flag.multi_case_v1");
}
if (has("loan_request_drafts")) {
  const dup = db.prepare("SELECT customer_id, COUNT(*) n FROM loan_request_drafts WHERE deleted_at IS NULL GROUP BY customer_id HAVING n>1").all();
  if (dup.length) {
    console.error("rollback stopped before restoring idx_loan_request_drafts_one_open: open drafts overlap", dup);
    process.exit(2);
  }
  db.exec(`DROP INDEX IF EXISTS idx_loan_request_drafts_request;
    DROP INDEX IF EXISTS idx_loan_request_drafts_one_legacy;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_request_drafts_one_open ON loan_request_drafts(customer_id) WHERE deleted_at IS NULL;`);
}
console.log("multi-case v1 guard removed and flag forced off. loan_application_id / request_key columns remain unused.");
db.close();

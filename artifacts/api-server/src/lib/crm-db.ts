import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { deriveCreditRank, invalidCreditScoreMessage } from "./credit-rank";

export const databasePath = path.resolve(
  process.cwd(),
  "..",
  "..",
  "attached_assets/customers_1789823100050.db",
);

const pendingDatabasePath = `${databasePath}.pending`;
if (fs.existsSync(pendingDatabasePath)) {
  const beforeImportDir = path.resolve(path.dirname(databasePath), "backups", "manual-imports");
  fs.mkdirSync(beforeImportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(databasePath)) {
    fs.copyFileSync(databasePath, path.join(beforeImportDir, `before-import-${stamp}.db`));
  }
  fs.renameSync(pendingDatabasePath, databasePath);
}

export type SqlValue = string | number | null;

export const crmDb = new DatabaseSync(databasePath);
crmDb.exec("PRAGMA foreign_keys = ON;");

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = crmDb
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    crmDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("users", "mobile", "TEXT");
ensureColumn("users", "priority_colors", "TEXT");
ensureColumn("reminders", "subject", "TEXT");
ensureColumn("reminders", "customer_id", "INTEGER");
ensureColumn("reminders", "notified_at", "TEXT");
ensureColumn("loan_plans", "installment_terms", "TEXT");
ensureColumn("loan_plans", "required_documents", "TEXT");
ensureColumn("loan_plan_conditions", "installment_options", "TEXT");
ensureColumn("loan_plan_conditions", "customer_jobs", "TEXT");
ensureColumn("loan_plan_conditions", "collateral_type", "TEXT");
ensureColumn("loan_plan_conditions", "guarantor_jobs", "TEXT");
ensureColumn("loan_plan_conditions", "guarantor_collateral_type", "TEXT");
ensureColumn("consultation_forms", "collateral_type", "TEXT");
ensureColumn("consultation_forms", "guarantor_collateral_type", "TEXT");
ensureColumn("customers", "national_code", "TEXT");
ensureColumn("customers", "credit_score", "REAL");
ensureColumn("customers", "credit_rank", "TEXT");
ensureColumn("customers", "credit_checked_at", "TEXT");
ensureColumn("customers", "birth_date_jalali", "TEXT");
ensureColumn("customers", "postal_code", "TEXT");
ensureColumn("customers", "verification_status", "TEXT NOT NULL DEFAULT 'unverified'");
ensureColumn("customers", "is_urgent", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("loan_plans", "primary_contract_template_id", "INTEGER");
ensureColumn("loan_plans", "invoice_template_id", "INTEGER");
ensureColumn("loan_plans", "acknowledgement_template_id", "INTEGER");
// Loan workflow is additive: the legacy consultation registration columns remain
// authoritative for old records and continue to be populated by the CRM route.
for (const [column, definition] of [
  ["duration_months", "INTEGER"],
  ["plan_id", "INTEGER"],
  ["approved_amount", "TEXT"],
  ["net_amount", "TEXT"],
  ["plan_snapshot_json", "TEXT"],
  ["condition_snapshot_json", "TEXT"],
  ["document_requirements_snapshot_json", "TEXT"],
  ["stage", "TEXT NOT NULL DEFAULT 'draft'"],
  ["deleted_at", "TEXT"],
  ["updated_at", "TEXT"],
  ["expert_reviewed_at", "TEXT"],
  ["admin_approved_at", "TEXT"],
] as const) ensureColumn("loan_applications", column, definition);

crmDb.exec(`
  CREATE TABLE IF NOT EXISTS allocation_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    cursor_item_index INTEGER NOT NULL DEFAULT 0,
    cursor_item_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allocation_program_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL,
    salesperson_id INTEGER NOT NULL,
    quota INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (program_id) REFERENCES allocation_programs(id) ON DELETE CASCADE,
    FOREIGN KEY (salesperson_id) REFERENCES salespersons(id),
    UNIQUE(program_id, salesperson_id)
  );

  CREATE INDEX IF NOT EXISTS idx_allocation_program_items_program
  ON allocation_program_items(program_id, sort_order);

  CREATE TABLE IF NOT EXISTS notification_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_notification_deliveries_customer
  ON notification_deliveries(customer_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS customer_credit_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    requested_by_user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'ics24',
    national_code TEXT NOT NULL,
    provider_reference TEXT,
    provider_status TEXT,
    status TEXT NOT NULL CHECK(status IN ('awaiting_otp','processing','report_generated','failed')),
    score REAL,
    score_label TEXT,
    summary TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_customer_credit_checks_customer
  ON customer_credit_checks(customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_customers_national_code
  ON customers(national_code);

  CREATE TABLE IF NOT EXISTS loan_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consultation_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    requested_by_user_id INTEGER NOT NULL,
    plan_ids TEXT NOT NULL,
    requested_amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested'
      CHECK(status IN ('requested','reviewing','approved','rejected')),
    notes TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (consultation_id) REFERENCES consultation_forms(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_loan_applications_consultation
  ON loan_applications(consultation_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS consultation_ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_consultation_ai_conversations_user_customer
  ON consultation_ai_conversations(user_id, customer_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS consultation_ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES consultation_ai_conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_consultation_ai_messages_conversation
  ON consultation_ai_messages(conversation_id, created_at, id);

  CREATE TABLE IF NOT EXISTS consultation_ai_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
    corrected_answer TEXT,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES consultation_ai_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_consultation_ai_feedback_approved
  ON consultation_ai_feedback(approved, created_at DESC);

  UPDATE customers
  SET status = CASE
    WHEN status = 'inactive' THEN 'cancelled'
    WHEN status IN ('cancelled', 'completed') THEN status
    ELSE 'in_progress'
  END
  WHERE status IS NULL OR status NOT IN ('in_progress', 'cancelled', 'completed');

  UPDATE customers
  SET priority = 3
  WHERE priority > 3;

  UPDATE reminders
  SET subject = COALESCE(NULLIF(subject, ''), substr(message, 1, 80))
  WHERE subject IS NULL OR subject = '';

  UPDATE reminders
  SET notified_at = COALESCE(notified_at, created_at)
  WHERE customer_id IS NULL;

  CREATE INDEX IF NOT EXISTS idx_reminders_user_due
  ON reminders(user_id, done, remind_at);

  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO consult_options (field_key, option_value, label_fa, sort_order, active) VALUES
    ('required_document', 'national_card', 'کارت ملی پشت و رو', 1, 1),
    ('required_document', 'birth_certificate_all_pages', 'تمام صفحات شناسنامه', 2, 1),
    ('required_document', 'employment_proof', 'مدرک شغلی', 3, 1),
    ('required_document', 'residence_proof', 'مدرک محل سکونت', 4, 1),
    ('required_document', 'juale_contract', 'قرارداد جعاله', 5, 1),
    ('required_document', 'guarantee_check', 'چک ضمانت', 6, 1),
    ('required_document', 'guarantee_promissory', 'سفته ضمانت', 7, 1),
    ('required_document', 'account_turnover_3_months', 'گردش حساب 3 ماهه', 8, 1),
    ('required_document', 'account_turnover_6_months', 'گردش حساب 6 ماهه', 9, 1),
    ('required_document', 'average_balance_3_months', 'میانگین موجودی 3 ماهه', 10, 1),
    ('required_document', 'average_balance_6_months', 'میانگین موجودی 6 ماهه', 11, 1),
    ('collateral_type', 'none', 'بدون وثیقه', 1, 1),
    ('collateral_type', 'physical_check', 'چک فیزیکی', 2, 1),
    ('collateral_type', 'digital_check', 'چک دیجیتال', 3, 1),
    ('collateral_type', 'promissory', 'سفته', 4, 1),
    ('collateral_type', 'salary_deduction', 'گواهی کسر از حقوق', 5, 1),
    ('collateral_type', 'property', 'سند ملکی', 6, 1),
    ('collateral_type', 'vehicle', 'سند خودرو', 7, 1),
    ('collateral_type', 'deposit', 'سپرده بانکی', 8, 1);
`);

// Contracts schema migration v1. Artifacts are private files; database paths
// are never served directly and foreign keys enforce lifecycle cleanup.
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS contract_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL, sha256 TEXT NOT NULL, variables_json TEXT NOT NULL,
    mappings_json TEXT NOT NULL, deleted_at TEXT, created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_contract_templates_created ON contract_templates(created_at DESC);
  CREATE TABLE IF NOT EXISTS contract_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
    docx_path TEXT NOT NULL, pdf_path TEXT, docx_sha256 TEXT NOT NULL, pdf_sha256 TEXT,
    manual_values_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
    provider_file_id TEXT, provider_contract_id TEXT, provider_status TEXT, error_message TEXT,
    created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT,
    FOREIGN KEY(template_id) REFERENCES contract_templates(id) ON DELETE RESTRICT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_contract_generations_customer ON contract_generations(customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_contract_generations_status ON contract_generations(status);
`);
// Contract lifecycle migration is deliberately versioned: deployments with the
// original tables get additive columns, while fresh databases receive the same
// schema.  Never mark this version until SQLite's FK checker is clean.
ensureColumn("contract_generations", "send_claim_id", "TEXT");
ensureColumn("contract_generations", "send_claim_expires_at", "TEXT");
ensureColumn("contract_generations", "job_token", "TEXT");
ensureColumn("contract_generations", "job_lease_expires_at", "TEXT");
ensureColumn("contract_generations", "provider_idempotency_key", "TEXT");
ensureColumn("contract_generations", "deleted_at", "TEXT");
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS contract_template_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    staged_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    variables_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_contract_analyses_expiry
    ON contract_template_analyses(expires_at, consumed_at);
`);
// Normalized loan workflow data. These tables intentionally reference the
// existing application so legacy consultation-created applications remain valid.
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS loan_application_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL,
    requirement_key TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'plan',
    status TEXT NOT NULL DEFAULT 'pending', incomplete_reason TEXT, storage_path TEXT,
    original_name TEXT, mime_type TEXT, size_bytes INTEGER, created_at TEXT NOT NULL,
    reviewed_at TEXT, FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS loan_application_guarantors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL UNIQUE,
    full_name TEXT NOT NULL, national_code TEXT, mobile TEXT, data_json TEXT,
    created_at TEXT NOT NULL, FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS loan_application_guarantor_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guarantor_id INTEGER NOT NULL, requirement_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', storage_path TEXT, original_name TEXT, mime_type TEXT,
    size_bytes INTEGER, created_at TEXT NOT NULL, FOREIGN KEY(guarantor_id) REFERENCES loan_application_guarantors(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS loan_application_collateral (
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL, collateral_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', data_json TEXT, storage_path TEXT, created_at TEXT NOT NULL,
    reviewed_at TEXT, FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS loan_application_stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL, from_stage TEXT,
    to_stage TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS wallet_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL UNIQUE, balance TEXT NOT NULL DEFAULT '0',
    created_at TEXT NOT NULL, FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, application_id INTEGER,
    amount TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    FOREIGN KEY(account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS loan_application_generated_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL, kind TEXT NOT NULL,
    contract_generation_id INTEGER, link TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_loan_app_docs_app ON loan_application_documents(application_id);
  CREATE INDEX IF NOT EXISTS idx_loan_app_history_app ON loan_application_stage_history(application_id, id);
`);
if (!crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get("contracts-lifecycle-v2")) {
  const violations = crmDb.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error("Contract migration foreign-key check failed");
  crmDb.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)")
    .run("contracts-lifecycle-v2", new Date().toISOString());
}

// Keep legacy customer databases compatible with the nullable API contract.
// Most installations already have a nullable column, so no rebuild is done.
function migrateCustomerNationalCodeNullability(): void {
  const column = (crmDb.prepare("PRAGMA table_info(customers)").all() as unknown as Array<{ name: string; notnull: number }>)
    .find((item) => item.name === "national_code");
  if (!column || column.notnull === 0) return;
  const marker = crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get("customers-national-code-nullable-v1");
  if (marker) return;
  const table = crmDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get() as { sql: string } | undefined;
  if (!table?.sql) throw new Error("Cannot migrate customers national_code nullability: schema unavailable");
  const replacement = table.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?customers["']?/i, "CREATE TABLE customers_new")
    .replace(/national_code\s+TEXT\s+NOT\s+NULL/i, "national_code TEXT");
  if (replacement === table.sql || !/national_code\s+TEXT/i.test(replacement)) {
    throw new Error("Cannot migrate customers national_code nullability safely");
  }
  const indexes = crmDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers' AND sql IS NOT NULL")
    .all() as unknown as Array<{ sql: string }>;
  crmDb.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    crmDb.exec(replacement);
    const columns = (crmDb.prepare("PRAGMA table_info(customers)").all() as unknown as Array<{ name: string }>).map((item) => item.name);
    crmDb.exec(`INSERT INTO customers_new (${columns.map((name) => `"${name}"`).join(",")}) SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM customers`);
    crmDb.exec("DROP TABLE customers; ALTER TABLE customers_new RENAME TO customers;");
    for (const index of indexes) crmDb.exec(index.sql);
    crmDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run("customers-national-code-nullable-v1", new Date().toISOString());
    crmDb.exec("COMMIT; PRAGMA foreign_keys = ON");
  } catch (error) {
    crmDb.exec("ROLLBACK; PRAGMA foreign_keys = ON");
    throw error;
  }
}

migrateCustomerNationalCodeNullability();

if (!crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get("customer-profile-defaults-v1")) {
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    crmDb.exec(`
      UPDATE customers SET verification_status = 'unverified'
      WHERE verification_status IS NULL OR verification_status NOT IN ('unverified', 'verified');
      UPDATE customers SET is_urgent = 0 WHERE is_urgent IS NULL;
    `);
    crmDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run("customer-profile-defaults-v1", new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}

// Reconcile legacy provider labels and customer snapshots. This is deliberately
// idempotent and ordered by the same timestamp/id tie-break used by the API.
function backfillCreditRanks(): void {
  const migration = crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get("credit-rank-reconciliation-v1");
  if (migration) return;
  // Acquire SQLite's write lock before reading the work set so two service
  // processes cannot both perform this one-time reconciliation.
  crmDb.exec("BEGIN IMMEDIATE");
  const checks = crmDb.prepare(
    "SELECT id, score FROM customer_credit_checks WHERE status = 'report_generated'",
  ).all() as unknown as Array<{ id: number; score: number | null }>;
  try {
    for (const check of checks) {
      const rank = deriveCreditRank(check.score);
      crmDb.prepare(
        `UPDATE customer_credit_checks
         SET score_label = ?, error_message = ?
         WHERE id = ?`,
      ).run(
        rank.ok ? rank.rank : null,
        rank.ok ? null : invalidCreditScoreMessage(rank.reason),
        check.id,
      );
    }
    const customers = crmDb.prepare("SELECT id FROM customers").all() as unknown as Array<{ id: number }>;
    for (const customer of customers) {
      const latest = crmDb.prepare(
        `SELECT score, completed_at
         FROM customer_credit_checks
         WHERE customer_id = ?
           AND status = 'report_generated'
           AND score IS NOT NULL
           AND score >= 0
           AND score <= 900
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(customer.id) as unknown as { score: number | null; completed_at: string | null } | undefined;
      const rank = deriveCreditRank(latest?.score);
      crmDb.prepare(
        "UPDATE customers SET credit_score = ?, credit_rank = ?, credit_checked_at = ? WHERE id = ?",
      ).run(latest?.score ?? null, rank.ok ? rank.rank : null, latest?.completed_at ?? null, customer.id);
    }
    crmDb.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      "credit-rank-reconciliation-v1",
      new Date().toISOString(),
    );
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}

backfillCreditRanks();

export function queryRows<T>(
  sql: string,
  params: SqlValue[] = [],
): T[] {
  return crmDb.prepare(sql).all(...params) as unknown as T[];
}

export function queryRow<T>(
  sql: string,
  params: SqlValue[] = [],
): T | undefined {
  return queryRows<T>(sql, params)[0];
}

export function execute(
  sql: string,
  params: SqlValue[] = [],
): number {
  const result = crmDb.prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}

export function executeChanges(
  sql: string,
  params: SqlValue[] = [],
): number {
  const result = crmDb.prepare(sql).run(...params);
  return Number(result.changes);
}

export function runTransaction<T>(operation: () => T): T {
  crmDb.exec("BEGIN");
  try {
    const result = operation();
    crmDb.exec("COMMIT");
    return result;
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
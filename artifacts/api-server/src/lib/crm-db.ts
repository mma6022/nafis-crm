import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { deriveCreditRank, invalidCreditScoreMessage } from "./credit-rank";
import { reconcileSalespersonUserIdentities } from "./salesperson-identity";
import { logger } from "./logger";
import { ensureSchemaObject, schemaObjectMatches } from "./schema-objects";
import { installCustomerIdentityGuards, registerCustomerIdentityFunctions } from "./customer-integrity";

export const databasePath = process.env.CRM_DATABASE_PATH
  ? path.resolve(process.env.CRM_DATABASE_PATH)
  : path.resolve(
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
crmDb.exec("PRAGMA busy_timeout=5000");
// Existing databases may already contain triggers using these functions before
// the migration below updates customers. Register them before any SQL executes.
registerCustomerIdentityFunctions(crmDb);
crmDb.exec("PRAGMA foreign_keys = ON;");
// Keep chronological last-call lookup bounded per customer, including timestamps
// with different UTC offsets. The same prefix also supports customer call counts.
crmDb.exec(`CREATE INDEX IF NOT EXISTS idx_call_logs_customer_actual_time
  ON call_logs(customer_id, julianday(created_at) DESC, id DESC)`);

crmDb.exec(`
  CREATE TABLE IF NOT EXISTS instagram_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT,
    request TEXT,
    customer_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    paused INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT,
    last_reply_at TEXT,
    requested_field TEXT CHECK(requested_field IN ('name','phone','request')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    duplicate_review INTEGER NOT NULL DEFAULT 0,
    full_name TEXT,
    is_urgent INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_threads_recent
    ON instagram_threads(last_message_at DESC);
  CREATE TABLE IF NOT EXISTS instagram_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    mid TEXT NOT NULL UNIQUE,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    content TEXT NOT NULL,
    sensitive_name INTEGER NOT NULL DEFAULT 0 CHECK(sensitive_name IN (0,1)),
    sent_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES instagram_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_messages_thread
    ON instagram_messages(thread_id, sent_at, id);
  CREATE TABLE IF NOT EXISTS instagram_crm_automation_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    episode_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    customer_id INTEGER,
    name_snapshot TEXT,
    phone_snapshot TEXT,
    request_summary TEXT,
    is_urgent INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    question_delivered_at TEXT,
    delivery_reset INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    provenance TEXT NOT NULL DEFAULT 'instagram_automation',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finalized_at TEXT,
    FOREIGN KEY(thread_id) REFERENCES instagram_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_crm_sessions_thread
    ON instagram_crm_automation_sessions(thread_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_instagram_crm_sessions_due
    ON instagram_crm_automation_sessions(state, due_at);
  CREATE TABLE IF NOT EXISTS instagram_send_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending', 'sending', 'sent', 'failed')),
    revision INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error TEXT,
    requested_field TEXT CHECK(requested_field IN ('name','phone','request')),
    reply_messages_json TEXT,
    next_message_index INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(thread_id) REFERENCES instagram_threads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_queue_due
    ON instagram_send_queue(state, due_at);
  CREATE TABLE IF NOT EXISTS instagram_send_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    last_sent_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    lease_queue_id INTEGER,
    lease_revision INTEGER,
    lease_stage TEXT CHECK(lease_stage IN ('processing', 'sending'))
  );
  INSERT OR IGNORE INTO instagram_send_state(id, last_sent_at) VALUES(1, NULL);
  CREATE TABLE IF NOT EXISTS instagram_oauth_states (
    state_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    admin_user_id INTEGER NOT NULL,
    connection_generation INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_oauth_states_expiry
    ON instagram_oauth_states(expires_at);
  CREATE TABLE IF NOT EXISTS instagram_connections (
    id INTEGER PRIMARY KEY CHECK(id=1),
    account_id TEXT NOT NULL,
    account_username TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    token_nonce TEXT NOT NULL,
    token_auth_tag TEXT NOT NULL,
    token_key_version TEXT NOT NULL DEFAULT 'legacy-session',
    token_expires_at TEXT,
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manychat_connections (
    id INTEGER PRIMARY KEY CHECK(id=1),
    account_id TEXT NOT NULL,
    provider_page_id TEXT NOT NULL,
    token_sealed TEXT NOT NULL,
    bridge_sealed TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'api' CHECK(mode IN ('api','flow')),
    verified_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS manychat_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    reply_mode TEXT NOT NULL DEFAULT 'intake' CHECK(reply_mode IN ('intake','ai')),
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO manychat_settings(id, reply_mode, updated_at)
    VALUES(1, 'intake', CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS instagram_flow_replies (
    thread_id INTEGER PRIMARY KEY REFERENCES instagram_threads(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK(state IN ('pending','processing','ready','handed_off','failed')),
    reply_text TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lease_expires_at TEXT,
    error TEXT,
    requested_field TEXT CHECK(requested_field IN ('name','phone','request')),
    reply_messages_json TEXT,
    next_item_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_flow_replies_jobs
    ON instagram_flow_replies(state, updated_at);
  CREATE TABLE IF NOT EXISTS instagram_flow_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES instagram_threads(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(thread_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS instagram_flow_handoff_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES instagram_threads(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(thread_id, request_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_instagram_flow_handoffs_thread
    ON instagram_flow_handoffs(thread_id, created_at, id);
  CREATE TABLE IF NOT EXISTS instagram_account_binding (
    id INTEGER PRIMARY KEY CHECK(id=1),
    account_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO instagram_account_binding(id, account_id, generation, updated_at)
    VALUES(1, NULL, 0, CURRENT_TIMESTAMP);
  UPDATE instagram_account_binding
    SET account_id=(SELECT account_id FROM instagram_connections WHERE id=1),
        updated_at=CURRENT_TIMESTAMP
    WHERE id=1 AND account_id IS NULL
      AND EXISTS(SELECT 1 FROM instagram_connections WHERE id=1);
`);
const instagramOAuthStateColumns = crmDb
  .prepare("PRAGMA table_info(instagram_oauth_states)")
  .all() as unknown as Array<{ name: string }>;
const manychatColumns = crmDb.prepare("PRAGMA table_info(manychat_connections)").all() as unknown as Array<{ name: string }>;
if (!manychatColumns.some((item) => item.name === "generation")) {
  crmDb.exec("ALTER TABLE manychat_connections ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
}
if (!manychatColumns.some((item) => item.name === "mode")) {
  crmDb.exec("ALTER TABLE manychat_connections ADD COLUMN mode TEXT NOT NULL DEFAULT 'api' CHECK(mode IN ('api','flow'))");
}
if (!instagramOAuthStateColumns.some((item) => item.name === "connection_generation")) {
  crmDb.exec("ALTER TABLE instagram_oauth_states ADD COLUMN connection_generation INTEGER NOT NULL DEFAULT 0");
}
const instagramConnectionColumns = crmDb
  .prepare("PRAGMA table_info(instagram_connections)")
  .all() as unknown as Array<{ name: string }>;
if (!instagramConnectionColumns.some((item) => item.name === "token_key_version")) {
  crmDb.exec("ALTER TABLE instagram_connections ADD COLUMN token_key_version TEXT NOT NULL DEFAULT 'legacy-session'");
}
const instagramStateColumns = crmDb
  .prepare("PRAGMA table_info(instagram_send_state)")
  .all() as unknown as Array<{ name: string }>;
for (const [column, definition] of [
  ["lease_token", "TEXT"],
  ["lease_expires_at", "TEXT"],
  ["lease_queue_id", "INTEGER"],
  ["lease_revision", "INTEGER"],
  ["lease_stage", "TEXT"],
] as const) {
  if (!instagramStateColumns.some((item) => item.name === column)) {
    crmDb.exec(`ALTER TABLE instagram_send_state ADD COLUMN ${column} ${definition}`);
  }
}

// Browser VoIP stores only local WebRTC configuration and browser-reported
// call events. It deliberately contains no provider credentials or sync state.
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS voip_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    wss_url TEXT NOT NULL DEFAULT '',
    sip_domain TEXT NOT NULL DEFAULT 'phone.avabom.com',
    stun_urls_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER,
    FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  INSERT OR IGNORE INTO voip_config
    (id, enabled, wss_url, sip_domain, stun_urls_json, updated_at)
  VALUES (1, 0, '', 'phone.avabom.com', '[]', CURRENT_TIMESTAMP);

  CREATE TABLE IF NOT EXISTS voip_extensions (
    user_id INTEGER PRIMARY KEY,
    extension TEXT,
    authorization_username TEXT,
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(updated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_voip_extensions_unique_extension
    ON voip_extensions(extension) WHERE extension IS NOT NULL AND extension <> '';

  CREATE TABLE IF NOT EXISTS voip_browser_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    call_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
    phone TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ringing', 'answered', 'completed', 'missed', 'rejected', 'failed')),
    started_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    customer_id INTEGER,
    extension TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    UNIQUE(user_id, call_id)
  );
  CREATE INDEX IF NOT EXISTS idx_voip_browser_calls_user_started
    ON voip_browser_calls(user_id, started_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_voip_browser_calls_customer_started
    ON voip_browser_calls(customer_id, started_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS customer_portal_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    mobile TEXT NOT NULL,
    customer_id INTEGER,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_sessions_expires
    ON customer_portal_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_customer_portal_sessions_mobile
    ON customer_portal_sessions(mobile);

  CREATE TABLE IF NOT EXISTS customer_portal_otp_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mobile TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_otp_mobile_created
    ON customer_portal_otp_challenges(mobile, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_customer_portal_otp_ip_created
    ON customer_portal_otp_challenges(ip_hash, created_at DESC);

  CREATE TABLE IF NOT EXISTS customer_portal_profile_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    actor_mobile TEXT NOT NULL,
    old_values_json TEXT NOT NULL,
    new_values_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_profile_audit_customer
    ON customer_portal_profile_audit(customer_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS customer_portal_verification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    checks_json TEXT NOT NULL,
    canonical_json TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_verification_customer
    ON customer_portal_verification_events(customer_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS customer_portal_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_conversations_customer
    ON customer_portal_conversations(customer_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS customer_portal_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    suggested_plan_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES customer_portal_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(suggested_plan_id) REFERENCES loan_plans(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customer_portal_messages_conversation
    ON customer_portal_messages(conversation_id, created_at, id);
`);

const CONTRACT_BINDING_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_contract_generations_application_binding
    ON contract_generations(loan_application_id,generation_purpose)
    WHERE loan_application_id IS NOT NULL AND superseded_at IS NULL`;

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
ensureColumn("instagram_threads", "reviewed_by_user_id", "INTEGER REFERENCES users(id)");
ensureColumn("instagram_threads", "reviewed_at", "TEXT");
ensureColumn("instagram_threads", "full_name", "TEXT");
ensureColumn("instagram_threads", "is_urgent", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("instagram_crm_automation_sessions", "delivery_reset", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("instagram_messages", "sensitive_name", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("instagram_threads", "requested_field", "TEXT");
ensureColumn("instagram_send_queue", "requested_field", "TEXT");
ensureColumn("instagram_send_queue", "reply_messages_json", "TEXT");
ensureColumn("instagram_send_queue", "next_message_index", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("instagram_flow_replies", "requested_field", "TEXT");
ensureColumn("instagram_flow_replies", "reply_messages_json", "TEXT");
ensureColumn("instagram_flow_replies", "next_item_index", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("reminders", "subject", "TEXT");
ensureColumn("reminders", "customer_id", "INTEGER");
ensureColumn("reminders", "notified_at", "TEXT");
ensureColumn("reminders", "call_id", "INTEGER REFERENCES call_logs(id) ON DELETE SET NULL");
ensureColumn("loan_plans", "installment_terms", "TEXT");
ensureColumn("loan_plans", "required_documents", "TEXT");
ensureColumn("loan_plans", "filing_fee_toman", "TEXT NOT NULL DEFAULT '0'");
for (const [column, definition] of [
  ["installments", "TEXT"],
  ["principal_amount", "TEXT"],
  ["deposit_percents", "TEXT"],
  ["needs_guarantor", "INTEGER"],
  ["needs_customer_promissory", "INTEGER"],
  ["needs_guarantor_promissory", "INTEGER"],
  ["needs_customer_check", "INTEGER"],
  ["needs_guarantor_check", "INTEGER"],
  ["needs_customer_salary_deduct", "INTEGER"],
  ["needs_guarantor_salary_deduct", "INTEGER"],
  ["customer_check", "TEXT"],
  ["guarantor_check", "TEXT"],
  ["collateral_type", "TEXT"],
  ["guarantor_collateral_type", "TEXT"],
] as const) ensureColumn("loan_plans", column, definition);
ensureColumn("loan_plan_conditions", "installment_options", "TEXT");
ensureColumn("loan_plan_conditions", "customer_jobs", "TEXT");
ensureColumn("loan_plan_conditions", "collateral_type", "TEXT");
ensureColumn("loan_plan_conditions", "guarantor_jobs", "TEXT");
ensureColumn("loan_plan_conditions", "guarantor_collateral_type", "TEXT");
// crm-no-plan-option (additive, NULL = no requirement; no plan has it set): applicant must have military service done
// (women exempt). Rollback: scripts/no-plan-option-rollback.mjs.
ensureColumn("loan_plan_conditions", "needs_military_service", "INTEGER");
// crm-no-plan-option: city of residence (first-call form writes it only while empty). There was no city field before.
ensureColumn("customers", "city", "TEXT");
for (const [column, definition] of [
  ["max_principal", "TEXT"],
  ["customer_ranks", "TEXT"],
  ["needs_guarantor", "INTEGER"],
  ["guarantor_ranks", "TEXT"],
  ["needs_customer_promissory", "INTEGER"],
  ["needs_guarantor_promissory", "INTEGER"],
  ["needs_customer_salary_deduct", "INTEGER"],
  ["needs_guarantor_salary_deduct", "INTEGER"],
  ["needs_customer_check", "INTEGER"],
  ["needs_guarantor_check", "INTEGER"],
  ["sort_order", "INTEGER"],
  ["notes", "TEXT"],
] as const) ensureColumn("loan_plan_conditions", column, definition);
ensureColumn("consultation_forms", "collateral_type", "TEXT");
ensureColumn("consultation_forms", "guarantor_collateral_type", "TEXT");
ensureColumn("consultation_forms", "created_at", "TEXT");
ensureColumn("consultation_forms", "questionnaire_version", "INTEGER NOT NULL DEFAULT 0");
// Deliberately nullable: old consultations have no known original match result.
ensureColumn("consultation_forms", "plan_matches_snapshot", "TEXT");
// crm-plans-consult (PM 2026-10-25): who recorded the consult (users.id; old rows stay NULL), the amount as a number
// in toman (old free text in requested_amount is never overwritten), and «پایان خدمت» (has_card / no_card / female /
// unknown, prefilled from Kazemi's «اطلاعات مشاوره»; NULL = «باید بررسی شود»).
ensureColumn("consultation_forms", "author_user_id", "INTEGER");
ensureColumn("consultation_forms", "requested_amount_toman", "INTEGER");
ensureColumn("consultation_forms", "military_status", "TEXT");
crmDb.exec("UPDATE consultation_forms SET created_at=updated_at WHERE created_at IS NULL");
// Boolean answer dictionaries reuse the administrator-maintained yes/no dictionary.
for (const field of ["has_customer_salary_deduct", "has_guarantor_salary_deduct"]) {
  crmDb.prepare(`INSERT INTO consult_options(field_key,option_value,label_fa,sort_order,active)
    SELECT ?,option_value,label_fa,sort_order,active FROM consult_options source
    WHERE source.field_key='has_guarantor' AND NOT EXISTS (
      SELECT 1 FROM consult_options target WHERE target.field_key=? AND target.option_value=source.option_value
    )`).run(field, field);
}
ensureColumn("customers", "national_code", "TEXT");
ensureColumn("customers", "credit_score", "REAL");
ensureColumn("customers", "credit_rank", "TEXT");
ensureColumn("customers", "credit_checked_at", "TEXT");
ensureColumn("customers", "birth_date_jalali", "TEXT");
ensureColumn("customers", "postal_code", "TEXT");
ensureColumn("customers", "verification_status", "TEXT NOT NULL DEFAULT 'unverified'");
ensureColumn("customers", "verification_version", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "identity_changed_at", "TEXT");
ensureColumn("customers", "is_urgent", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "father_name", "TEXT");
ensureColumn("customers", "address", "TEXT");
ensureColumn("customers", "email", "TEXT");
ensureColumn("customers", "first_name", "TEXT");
ensureColumn("customers", "last_name", "TEXT");
ensureColumn("customers", "verification_checked_at", "TEXT");
ensureColumn("customers", "verification_provider", "TEXT");
ensureColumn("customers", "shahkar_status", "TEXT");
ensureColumn("customers", "sana_status", "TEXT");
ensureColumn("customers", "person_info_status", "TEXT");
ensureColumn("customers", "postal_code_info_status", "TEXT");
ensureColumn("customers", "shahkar_ok", "INTEGER");
ensureColumn("customers", "person_info_ok", "INTEGER");
ensureColumn("customers", "postal_code_info_ok", "INTEGER");
ensureColumn("customers", "sana_ok", "INTEGER");
ensureColumn("customers", "official_first_name", "TEXT");
ensureColumn("customers", "official_last_name", "TEXT");
ensureColumn("customers", "official_father_name", "TEXT");
ensureColumn("customers", "official_address", "TEXT");
ensureColumn("customers", "official_postal_code", "TEXT");
ensureColumn("customers", "merged_into_customer_id", "INTEGER");
ensureColumn("call_logs", "salesperson_name_snapshot", "TEXT");
ensureColumn("loan_applications", "salesperson_id_snapshot", "INTEGER");
ensureColumn("loan_applications", "salesperson_name_snapshot", "TEXT");
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS customer_tag_catalog (
    tag TEXT PRIMARY KEY,
    label_fa TEXT NOT NULL,
    canonical_label TEXT
  );
  INSERT OR IGNORE INTO customer_tag_catalog(tag,label_fa)
    VALUES ('repeat_request','درخواست چند باره');

  CREATE TABLE IF NOT EXISTS customer_tags (
    customer_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(customer_id,tag),
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(tag) REFERENCES customer_tag_catalog(tag) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_customer_tags_tag_customer
    ON customer_tags(tag,customer_id);

  CREATE TABLE IF NOT EXISTS customer_repeat_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    requested_name TEXT NOT NULL,
    submitted_description TEXT,
    explanation TEXT NOT NULL CHECK(length(trim(explanation)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged')),
    created_by_user_id INTEGER,
    provenance TEXT NOT NULL DEFAULT 'human' CHECK(provenance IN ('human','instagram_automation')),
    source_thread_id INTEGER,
    source_message_id TEXT,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_customer_repeat_requests_customer
    ON customer_repeat_requests(customer_id,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_customer_repeat_requests_pending
    ON customer_repeat_requests(customer_id,status);
  CREATE TRIGGER IF NOT EXISTS customer_repeat_requests_immutable_update
    BEFORE UPDATE OF requested_name,submitted_description,explanation,created_by_user_id,created_at
    ON customer_repeat_requests
    BEGIN SELECT RAISE(ABORT,'customer repeat request is append-only'); END;
`);
ensureColumn("customer_tag_catalog", "canonical_label", "TEXT");
crmDb.exec(`
  UPDATE customer_tag_catalog
  SET canonical_label=lower(trim(label_fa))
  WHERE canonical_label IS NULL OR trim(canonical_label)='';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_tag_catalog_canonical_label
    ON customer_tag_catalog(canonical_label);
`);
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS loan_salesperson_attribution_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE RESTRICT,
    previous_salesperson_id INTEGER,
    previous_salesperson_name TEXT,
    salesperson_id INTEGER NOT NULL REFERENCES salespersons(id) ON DELETE RESTRICT,
    salesperson_name TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_loan_salesperson_audit_application
    ON loan_salesperson_attribution_audit(application_id, id DESC);
`);
// A legacy call has trustworthy attribution only when its recorded salesperson
// id exists; do not infer an owner for rows where that historic field is blank.
crmDb.exec(`
  UPDATE call_logs SET salesperson_name_snapshot = (
    SELECT name FROM salespersons WHERE salespersons.id = call_logs.salesperson_id
  )
  WHERE salesperson_id IS NOT NULL AND salesperson_name_snapshot IS NULL;
`);
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS customer_merge_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survivor_customer_id INTEGER NOT NULL,
    source_customer_id INTEGER NOT NULL UNIQUE,
    actor_user_id INTEGER NOT NULL,
    assigned_salesperson_id INTEGER,
    created_at TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(survivor_customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
    FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_customer_merge_audit_survivor
    ON customer_merge_audit(survivor_customer_id, created_at DESC);
`);
crmDb.exec(`
  UPDATE customers
  SET
    name = CASE
      WHEN (first_name IS NULL OR TRIM(first_name) = '')
       AND (last_name IS NULL OR TRIM(last_name) = '')
       AND (COALESCE(TRIM(official_first_name), '') <> '' OR COALESCE(TRIM(official_last_name), '') <> '')
      THEN TRIM(COALESCE(official_first_name, '') || ' ' || COALESCE(official_last_name, ''))
      ELSE name
    END,
    first_name = COALESCE(NULLIF(TRIM(first_name), ''), NULLIF(TRIM(official_first_name), '')),
    last_name = COALESCE(NULLIF(TRIM(last_name), ''), NULLIF(TRIM(official_last_name), '')),
    father_name = COALESCE(NULLIF(TRIM(father_name), ''), NULLIF(TRIM(official_father_name), '')),
    address = COALESCE(NULLIF(TRIM(address), ''), NULLIF(TRIM(official_address), '')),
    postal_code = COALESCE(NULLIF(TRIM(postal_code), ''), NULLIF(TRIM(official_postal_code), ''))
  WHERE official_first_name IS NOT NULL
     OR official_last_name IS NOT NULL
     OR official_father_name IS NOT NULL
     OR official_address IS NOT NULL
     OR official_postal_code IS NOT NULL
`);
ensureColumn("loan_plans", "primary_contract_template_id", "INTEGER");
ensureColumn("loan_plans", "contract_template_id", "INTEGER");
ensureColumn("loan_plans", "invoice_template_id", "INTEGER");
ensureColumn("loan_plans", "acknowledgement_template_id", "INTEGER");
for (const [column, definition] of [
  ["platform_company_name", "TEXT"],
  ["goods_store_name", "TEXT"],
  ["commission_percent", "REAL"],
  ["operation_costs_percent", "REAL"],
  ["granted_discount_percent", "REAL"],
  ["purchase_commission_percent", "REAL"],
  ["sales_commission_percent", "REAL"],
  ["loan_acquisition_fee_percent", "REAL"],
  ["penalty_mode", "TEXT"],
  ["penalty_value", "REAL"],
  ["contract_duration_days", "INTEGER"],
] as const) ensureColumn("loan_plans", column, definition);
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
  ["is_pre_registration", "INTEGER NOT NULL DEFAULT 0"],
  ["funder_decision", "TEXT"],
  ["funder_reason", "TEXT"],
  ["initial_approval_at", "TEXT"],
  ["initial_approval_by_user_id", "INTEGER"],
  ["initial_approval_reason", "TEXT"],
  ["primary_manual_values_json", "TEXT NOT NULL DEFAULT '{}'" ],
  ["approved_amount_source", "TEXT"],
  ["approved_amount_generation_id", "INTEGER"],
  ["approved_amount_reconciled_at", "TEXT"],
  ["approved_amount_reconciled_by_user_id", "INTEGER"],
  ["current_primary_generation_id", "INTEGER"],
  ["legacy_reopen_prior_stage", "TEXT"],
  ["new_case_workflow", "INTEGER NOT NULL DEFAULT 0"],
  ["initial_contract_retained", "INTEGER NOT NULL DEFAULT 0"],
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

  CREATE TABLE IF NOT EXISTS customer_verification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    requested_by_user_id INTEGER NOT NULL,
    national_code TEXT,
    mobile TEXT,
    checks_json TEXT NOT NULL,
    canonical_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('verified','failed')),
    error_message TEXT,
    created_at TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(requested_by_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_customer_verification_events_customer
    ON customer_verification_events(customer_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS customer_manual_verification_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    requested_by_user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','system_verified','superseded')),
    original_values_json TEXT NOT NULL,
    source_event_id INTEGER,
    source_failures_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(requested_by_user_id) REFERENCES users(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_verification_one_pending
    ON customer_manual_verification_requests(customer_id) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS idx_manual_verification_requests_status
    ON customer_manual_verification_requests(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS customer_manual_verification_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    actor_user_id INTEGER,
    decision TEXT NOT NULL CHECK(decision IN ('approved','system_verified')),
    source_failures_json TEXT NOT NULL,
    methods_json TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    original_values_json TEXT NOT NULL,
    corrected_values_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES customer_manual_verification_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
    FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE TRIGGER IF NOT EXISTS trg_manual_verification_decisions_immutable_update
    BEFORE UPDATE ON customer_manual_verification_decisions BEGIN
      SELECT RAISE(ABORT, 'manual verification decisions are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_manual_verification_decisions_immutable_delete
    BEFORE DELETE ON customer_manual_verification_decisions BEGIN
      SELECT RAISE(ABORT, 'manual verification decisions are immutable');
    END;
  CREATE TABLE IF NOT EXISTS customer_manual_check_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES customer_manual_verification_requests(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    check_key TEXT NOT NULL CHECK(check_key IN ('shahkarLite','personInfo','postalCodeInfo','sana')),
    decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
    reason TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS trg_manual_check_decisions_immutable_update
    BEFORE UPDATE ON customer_manual_check_decisions BEGIN
      SELECT RAISE(ABORT, 'manual check decisions are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS trg_manual_check_decisions_immutable_delete
    BEFORE DELETE ON customer_manual_check_decisions BEGIN
      SELECT RAISE(ABORT, 'manual check decisions are immutable');
    END;
  CREATE TABLE IF NOT EXISTS customer_identity_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    document_type TEXT NOT NULL CHECK(document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')),
    legacy_document_type TEXT,
    storage_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_latest INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by_user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_customer_identity_documents_customer
    ON customer_identity_documents(customer_id, document_type);

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
    ('collateral_type', 'vehicle', 'سند خودرو', 7, 1);
  -- No bank-deposit collateral option: it does not exist as a product (removed; live rows are deactivated by scripts/remove-deposit-collateral.mjs).
`);
function migrateAutomatedRepeatRequestProvenance(): void {
  const columns = crmDb
    .prepare("PRAGMA table_info(customer_repeat_requests)")
    .all() as unknown as Array<{ name: string; notnull: number }>;
  const actor = columns.find((column) => column.name === "created_by_user_id");
  if (!actor) throw new Error("Customer repeat request actor column is unavailable");
  if (actor.notnull) {
    crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      crmDb.exec(`
        CREATE TABLE customer_repeat_requests_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          requested_name TEXT NOT NULL,
          submitted_description TEXT,
          explanation TEXT NOT NULL CHECK(length(trim(explanation)) > 0),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged')),
          created_by_user_id INTEGER,
          provenance TEXT NOT NULL DEFAULT 'human' CHECK(provenance IN ('human','instagram_automation')),
          source_thread_id INTEGER,
          source_message_id TEXT,
          created_at TEXT NOT NULL,
          acknowledged_at TEXT,
          FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
          FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
        );
        INSERT INTO customer_repeat_requests_new
          (id,customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,created_at,acknowledged_at)
        SELECT id,customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,created_at,acknowledged_at
        FROM customer_repeat_requests;
        DROP TABLE customer_repeat_requests;
        ALTER TABLE customer_repeat_requests_new RENAME TO customer_repeat_requests;
        CREATE INDEX idx_customer_repeat_requests_customer
          ON customer_repeat_requests(customer_id,created_at DESC,id DESC);
        CREATE INDEX idx_customer_repeat_requests_pending
          ON customer_repeat_requests(customer_id,status);
      `);
      crmDb.exec("COMMIT; PRAGMA foreign_keys=ON");
    } catch (error) {
      crmDb.exec("ROLLBACK; PRAGMA foreign_keys=ON");
      throw error;
    }
  }
  ensureColumn("customer_repeat_requests", "provenance", "TEXT NOT NULL DEFAULT 'human'");
  ensureColumn("customer_repeat_requests", "source_thread_id", "INTEGER");
  ensureColumn("customer_repeat_requests", "source_message_id", "TEXT");
  ensureSchemaObject(crmDb, "trigger", "customer_repeat_requests_immutable_update", `
    CREATE TRIGGER customer_repeat_requests_immutable_update
      BEFORE UPDATE OF requested_name,submitted_description,explanation,created_by_user_id,provenance,
        source_thread_id,source_message_id,created_at
      ON customer_repeat_requests
      BEGIN SELECT RAISE(ABORT,'customer repeat request is append-only'); END`);
  crmDb.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_repeat_requests_source_message
      ON customer_repeat_requests(source_message_id) WHERE source_message_id IS NOT NULL;
  `);
}
migrateAutomatedRepeatRequestProvenance();
ensureColumn("loan_applications", "requested_duration_months", "INTEGER");
crmDb.exec(`
  UPDATE loan_applications
  SET requested_duration_months=duration_months
  WHERE requested_duration_months IS NULL AND duration_months IS NOT NULL;
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
ensureColumn("contract_generations", "loan_application_id", "INTEGER");
ensureColumn("contract_generations", "mappings_snapshot_json", "TEXT");
ensureColumn("contract_generations", "superseded_at", "TEXT");
crmDb.exec(`
  UPDATE contract_generations
  SET superseded_at=COALESCE(superseded_at,updated_at,created_at)
  WHERE loan_application_id IS NOT NULL AND status='failed' AND pdf_path IS NULL
    AND provider_contract_id IS NULL;
`);
// Legacy one-column binding index; skipped once the final (application, purpose) index below is in place,
// so a normal restart does not DROP/CREATE it twice (each DDL bumps schema_version).
if (!schemaObjectMatches(crmDb, "index", "idx_contract_generations_application_binding", CONTRACT_BINDING_INDEX_SQL))
  ensureSchemaObject(crmDb, "index", "idx_contract_generations_application_binding", `
  CREATE UNIQUE INDEX idx_contract_generations_application_binding
    ON contract_generations(loan_application_id)
    WHERE loan_application_id IS NOT NULL AND superseded_at IS NULL`);
crmDb.exec(`CREATE TRIGGER IF NOT EXISTS trg_contract_generation_application_binding_immutable
  BEFORE UPDATE OF loan_application_id ON contract_generations
  WHEN OLD.loan_application_id IS NOT NEW.loan_application_id
  BEGIN SELECT RAISE(ABORT, 'contract generation application binding is immutable'); END;`);
ensureColumn("contract_templates", "loan_plan_id", "INTEGER");
// Contract lifecycle migration is deliberately versioned: deployments with the
// original tables get additive columns, while fresh databases receive the same
// schema.  Never mark this version until SQLite's FK checker is clean.
ensureColumn("contract_generations", "send_claim_id", "TEXT");
ensureColumn("contract_generations", "send_claim_expires_at", "TEXT");
ensureColumn("contract_generations", "job_token", "TEXT");
ensureColumn("contract_generations", "job_lease_expires_at", "TEXT");
ensureColumn("contract_generations", "provider_idempotency_key", "TEXT");
ensureColumn("contract_generations", "deleted_at", "TEXT");
ensureColumn("contract_generations", "loan_plan_id", "INTEGER");
ensureColumn("contract_generations", "contract_number", "TEXT");
ensureColumn("contract_generations", "generation_purpose", "TEXT NOT NULL DEFAULT 'primary'");
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS contract_generation_rejected_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id INTEGER NOT NULL REFERENCES contract_generations(id),
    provider_contract_id TEXT NOT NULL,
    provider_file_id TEXT,
    provider_status TEXT NOT NULL,
    sent_at TEXT,
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    recorded_at TEXT NOT NULL,
    UNIQUE(generation_id, provider_contract_id)
  );
`);
ensureColumn("contract_generation_rejected_deliveries", "sent_at", "TEXT");
ensureSchemaObject(crmDb, "index", "idx_contract_generations_application_binding", CONTRACT_BINDING_INDEX_SQL);
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS contract_number_sequences (
    period TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL CHECK(next_value >= 1001),
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_generations_contract_number
    ON contract_generations(contract_number)
    WHERE contract_number IS NOT NULL;
`);
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
ensureColumn("customer_verification_events", "input_json", "TEXT");
ensureColumn("customer_verification_events", "is_current", "INTEGER NOT NULL DEFAULT 1");
function migrateManualVerificationSupersededStatus(): void {
  const marker = "manual-verification-superseded-v1";
  if (crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(marker)) return;
  const table = crmDb.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_manual_verification_requests'",
  ).get() as { sql: string } | undefined;
  if (!table?.sql) throw new Error("Manual verification request table is unavailable");
  if (/superseded/.test(table.sql)) {
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(marker, new Date().toISOString());
    return;
  }
  crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    crmDb.exec(`
      CREATE TABLE customer_manual_verification_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        requested_by_user_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','system_verified','superseded')),
        original_values_json TEXT NOT NULL,
        source_event_id INTEGER,
        source_failures_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY(requested_by_user_id) REFERENCES users(id)
      );
      INSERT INTO customer_manual_verification_requests_new
        (id,customer_id,requested_by_user_id,status,original_values_json,source_event_id,source_failures_json,created_at,resolved_at)
      SELECT id,customer_id,requested_by_user_id,status,original_values_json,source_event_id,source_failures_json,created_at,resolved_at
      FROM customer_manual_verification_requests;
      DROP TABLE customer_manual_verification_requests;
      ALTER TABLE customer_manual_verification_requests_new RENAME TO customer_manual_verification_requests;
      CREATE UNIQUE INDEX idx_manual_verification_one_pending
        ON customer_manual_verification_requests(customer_id) WHERE status='pending';
      CREATE INDEX idx_manual_verification_requests_status
        ON customer_manual_verification_requests(status,created_at DESC);
    `);
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(marker, new Date().toISOString());
    crmDb.exec("COMMIT; PRAGMA foreign_keys=ON");
  } catch (error) {
    crmDb.exec("ROLLBACK; PRAGMA foreign_keys=ON");
    throw error;
  }
}
migrateManualVerificationSupersededStatus();
if (!crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get("manual-identity-verification-v1")) {
  crmDb.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)")
    .run("manual-identity-verification-v1", new Date().toISOString());
}
// Reverse the legacy template-to-plan association once, preserving an
// explicitly selected primary template when one already exists.
if (!crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get("loan-plan-contract-template-v1")) {
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    crmDb.exec(`
      UPDATE loan_plans
      SET contract_template_id = COALESCE(
        contract_template_id,
        primary_contract_template_id,
        (SELECT t.id FROM contract_templates t WHERE t.loan_plan_id = loan_plans.id AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1)
      )
      WHERE contract_template_id IS NULL;
    `);
    crmDb.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)")
      .run("loan-plan-contract-template-v1", new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
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
crmDb.exec(`
  CREATE TABLE IF NOT EXISTS loan_physical_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    UNIQUE(application_id,source,source_id)
  );
  CREATE TABLE IF NOT EXISTS loan_physical_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_loan_physical_documents_app ON loan_physical_documents(application_id);
  CREATE TABLE IF NOT EXISTS loan_funder_defects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(application_id,source,source_id)
  );
`);
if (!queryRow("SELECT 1 FROM schema_migrations WHERE version=?", ["loan-funder-physical-workflow-v1"])) {
  crmDb.exec("BEGIN");
  try {
    // Existing admin-pending applications already passed the funder; do not
    // bypass the newly required physical-document review or charge early.
    crmDb.prepare("UPDATE loan_applications SET stage='funder_result_review',funder_decision='approved',updated_at=? WHERE stage='admin_approval' AND status<>'rejected' AND deleted_at IS NULL").run(new Date().toISOString());
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run("loan-funder-physical-workflow-v1", new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
ensureColumn("customer_identity_documents", "approved_at", "TEXT");
ensureColumn("customer_identity_documents", "approved_by_user_id", "INTEGER");
ensureColumn("customer_identity_documents", "review_reason", "TEXT");
ensureColumn("loan_application_documents", "identity_document_id", "INTEGER");
ensureColumn("loan_application_generated_documents", "status", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("loan_application_generated_documents", "review_reason", "TEXT");
ensureColumn("loan_application_generated_documents", "reviewed_at", "TEXT");
ensureColumn("loan_application_generated_documents", "reviewed_by_user_id", "INTEGER");
function rebuildPortalActorTable(table: string, userActorColumn: string, customerActorColumn: string): void {
  const columns = crmDb.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{
    name: string;
    notnull: number;
  }>;
  if (!columns.length) throw new Error(`portal_actor_migration_missing_table:${table}`);
  const actor = columns.find((column) => column.name === userActorColumn);
  if (!actor) throw new Error(`portal_actor_migration_missing_column:${table}.${userActorColumn}`);
  if (!actor.notnull && columns.some((column) => column.name === customerActorColumn)) return;
  const original = crmDb.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql: string } | undefined;
  if (!original?.sql) throw new Error(`portal_actor_migration_missing_schema:${table}`);
  const auxiliary = crmDb.prepare(
    "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name",
  ).all(table) as unknown as Array<{ sql: string }>;
  const oldColumns = columns.map((column) => `"${column.name.replace(/"/g, '""')}"`);
  const temporary = `${table}_customer_actor_migration`;
  let createSql = original.sql.replace(
    new RegExp(`^(CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?)(?:"${table}"|\\x60${table}\\x60|\\[${table}\\]|${table})`, "i"),
    `$1"${temporary}"`,
  );
  if (createSql === original.sql) throw new Error(`portal_actor_migration_rename_failed:${table}`);
  const actorColumnPattern = new RegExp(`(["\\x60]?${userActorColumn}["\\x60]?\\s+INTEGER)\\s+NOT\\s+NULL\\b`, "i");
  if (!actorColumnPattern.test(createSql)) throw new Error(`portal_actor_migration_nullable_actor_failed:${table}`);
  createSql = createSql.replace(actorColumnPattern, "$1");
  if (!columns.some((column) => column.name === customerActorColumn)) {
    const addition = `\n    ${customerActorColumn} INTEGER REFERENCES customers(id) ON DELETE SET NULL`;
    const foreignKey = createSql.search(/,\s*FOREIGN KEY\s*\(/i);
    if (foreignKey >= 0) createSql = `${createSql.slice(0, foreignKey)},${addition}${createSql.slice(foreignKey)}`;
    else {
      const close = createSql.lastIndexOf(")");
      if (close < 0) throw new Error(`portal_actor_migration_invalid_schema:${table}`);
      createSql = `${createSql.slice(0, close)},${addition}${createSql.slice(close)}`;
    }
  }
  crmDb.exec(createSql);
  crmDb.exec(
    `INSERT INTO "${temporary}" (${oldColumns.join(",")}) SELECT ${oldColumns.join(",")} FROM "${table}"`,
  );
  crmDb.exec(`DROP TABLE "${table}"`);
  crmDb.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`);
  for (const item of auxiliary) crmDb.exec(item.sql);
}

function migratePortalActorProvenance(): void {
  const version = "customer-portal-loan-actor-provenance-v1";
  if (crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)) return;
  crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    rebuildPortalActorTable("customer_credit_checks", "requested_by_user_id", "requested_by_customer_id");
    rebuildPortalActorTable("loan_applications", "requested_by_user_id", "requested_by_customer_id");
    rebuildPortalActorTable("customer_identity_documents", "created_by_user_id", "created_by_customer_id");
    ensureColumn("loan_application_documents", "created_by_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL");
    ensureColumn("loan_application_stage_history", "actor_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL");
    const violations = crmDb.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (violations.length) throw new Error(`portal_actor_migration_foreign_key_violations:${violations.length}`);
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version, new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  } finally {
    crmDb.exec("PRAGMA foreign_keys=ON");
  }
}
migratePortalActorProvenance();
function migratePortalStageHistoryNullableActor(): void {
  const version = "customer-portal-stage-history-actor-v1";
  if (crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)) return;
  crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    rebuildPortalActorTable("loan_application_stage_history", "actor_id", "actor_customer_id");
    const violations = crmDb.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (violations.length) throw new Error(`portal_stage_history_migration_foreign_key_violations:${violations.length}`);
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version, new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  } finally {
    crmDb.exec("PRAGMA foreign_keys=ON");
  }
}
migratePortalStageHistoryNullableActor();
if (!queryRow("SELECT 1 FROM schema_migrations WHERE version=?", ["loan-current-primary-marker-v1"])) {
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    crmDb.exec(`UPDATE loan_applications
      SET current_primary_generation_id=(
        SELECT d.contract_generation_id FROM loan_application_generated_documents d
        WHERE d.application_id=loan_applications.id AND d.kind='primary'
        ORDER BY d.id DESC LIMIT 1
      )
      WHERE current_primary_generation_id IS NULL
        AND EXISTS(SELECT 1 FROM loan_application_generated_documents d
          WHERE d.application_id=loan_applications.id AND d.kind='primary');`);
    crmDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run("loan-current-primary-marker-v1", new Date().toISOString());
    crmDb.exec("COMMIT");
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
ensureColumn("loan_application_guarantor_documents", "rejection_reason", "TEXT");
ensureColumn("loan_application_collateral", "rejection_reason", "TEXT");
function migrateIdentityDocumentTypes(): void {
  const marker = crmDb.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get("identity-document-types-v3");
  if (marker) return;
  const table = crmDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_identity_documents'").get() as { sql: string } | undefined;
  if (!table?.sql || (/birth_cert_p1/.test(table.sql) && !/UNIQUE\s*\(\s*customer_id\s*,\s*document_type/.test(table.sql))) {
    crmDb.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run("identity-document-types-v3", new Date().toISOString());
    return;
  }
  crmDb.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    crmDb.exec(`ALTER TABLE customer_identity_documents RENAME TO customer_identity_documents_legacy;
      CREATE TABLE customer_identity_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
        document_type TEXT NOT NULL CHECK(document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')),
        legacy_document_type TEXT, storage_path TEXT NOT NULL, original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        created_by_user_id INTEGER NOT NULL, created_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, is_latest INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id)
      );
      INSERT INTO customer_identity_documents
        (id,customer_id,document_type,legacy_document_type,storage_path,original_name,mime_type,size_bytes,sha256,created_by_user_id,created_at,version,is_latest)
      SELECT id,customer_id,
        CASE document_type WHEN 'birth_certificate' THEN 'birth_cert_p1'
          WHEN 'selfie' THEN 'birth_cert_p2' WHEN 'address_proof' THEN 'birth_cert_p3'
          ELSE document_type END,
        CASE WHEN document_type IN ('birth_certificate','selfie','address_proof') THEN document_type ELSE NULL END,
        storage_path,original_name,mime_type,size_bytes,sha256,created_by_user_id,created_at,1,1
      FROM customer_identity_documents_legacy;
      DROP TABLE customer_identity_documents_legacy;
      INSERT INTO schema_migrations(version,applied_at) VALUES('identity-document-types-v3', '${new Date().toISOString()}');
      CREATE INDEX IF NOT EXISTS idx_customer_identity_documents_customer ON customer_identity_documents(customer_id, document_type);`);
    crmDb.exec("COMMIT; PRAGMA foreign_keys=ON");
  } catch (error) {
    crmDb.exec("ROLLBACK; PRAGMA foreign_keys=ON");
    throw error;
  }
}
migrateIdentityDocumentTypes();
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
// The nullability migration can rebuild customers and drop table triggers.
// Install identity guards only after all customer-table rebuilds have finished.
// Legacy duplicate rows remain untouched; new writes use API-identical keys.
installCustomerIdentityGuards(crmDb);

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
reconcileSalespersonUserIdentities(crmDb, (userId, reason) => {
  logger.warn(
    { userId, reason },
    "Skipped ambiguous salesperson identity during reconciliation",
  );
});

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

export function runImmediateTransaction<T>(operation: () => T): T {
  crmDb.exec("PRAGMA busy_timeout=5000");
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    crmDb.exec("COMMIT");
    return result;
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
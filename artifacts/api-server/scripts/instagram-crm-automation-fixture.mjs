import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const artifactDir = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-ig-automation-"));
const databasePath = path.join(tempRoot, "synthetic-empty-crm.db");
const entryPath = path.join(artifactDir, `.crm-automation-entry-${process.pid}.ts`);
const bundlePath = path.join(artifactDir, `.crm-automation-test-${process.pid}.mjs`);

const baseline = new DatabaseSync(databasePath);
baseline.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL,mobile TEXT,active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE users(
    id INTEGER PRIMARY KEY,username TEXT NOT NULL,password_hash TEXT NOT NULL,full_name TEXT,
    mobile TEXT,priority_colors TEXT,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,salesperson_id INTEGER
  );
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,phone TEXT NOT NULL,description TEXT,
    national_code TEXT,birth_date_jalali TEXT,postal_code TEXT,father_name TEXT,verification_status TEXT,
    verification_checked_at TEXT,identity_changed_at TEXT,verification_version INTEGER DEFAULT 0,
    verification_provider TEXT,shahkar_status TEXT,sana_status TEXT,person_info_status TEXT,
    postal_code_info_status TEXT,shahkar_ok INTEGER,person_info_ok INTEGER,postal_code_info_ok INTEGER,
    sana_ok INTEGER,salesperson_id INTEGER,merged_into_customer_id INTEGER,is_urgent INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,priority TEXT,status TEXT DEFAULT 'in_progress',credit_score REAL,
    credit_rank TEXT,credit_checked_at TEXT,first_name TEXT,last_name TEXT,address TEXT,
    official_first_name TEXT,official_last_name TEXT,official_father_name TEXT,official_address TEXT,
    official_postal_code TEXT
  );
  CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,created_at TEXT);
  CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,done INTEGER,remind_at TEXT,message TEXT,created_at TEXT);
  CREATE TABLE consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER,requested_amount TEXT,updated_at TEXT);
  CREATE TABLE loan_applications(
    id INTEGER PRIMARY KEY,consultation_id INTEGER,customer_id INTEGER,requested_by_user_id INTEGER,
    plan_ids TEXT,plan_id INTEGER,requested_amount TEXT,status TEXT,notes TEXT,created_at TEXT
  );
  CREATE TABLE loan_plans(
    id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER DEFAULT 1,principal_amount TEXT,
    installment_terms TEXT,required_documents TEXT,bank_name TEXT,platform_name TEXT,
    annual_interest TEXT,installments TEXT,deposit_percents TEXT,customer_jobs TEXT,
    needs_guarantor INTEGER,notes TEXT
  );
  CREATE TABLE loan_plan_conditions(
    id INTEGER PRIMARY KEY,plan_id INTEGER,installment_options TEXT,customer_jobs TEXT,
    collateral_type TEXT,guarantor_jobs TEXT
  );
  CREATE TABLE consult_options(
    id INTEGER PRIMARY KEY,field_key TEXT NOT NULL,option_value TEXT NOT NULL,label_fa TEXT NOT NULL,
    sort_order INTEGER,active INTEGER,UNIQUE(field_key,option_value)
  );
  CREATE TABLE auth_sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE customer_repeat_requests(
    id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,requested_name TEXT NOT NULL,
    submitted_description TEXT,explanation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    created_by_user_id INTEGER NOT NULL,created_at TEXT NOT NULL,acknowledged_at TEXT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES
    ('customer-portal-loan-actor-provenance-v1',CURRENT_TIMESTAMP),
    ('customer-portal-stage-history-actor-v1',CURRENT_TIMESTAMP);
`);
const now = new Date().toISOString();
baseline.prepare("INSERT INTO salespersons(id,name,active) VALUES(1,'Synthetic Alloc 1',1),(2,'Synthetic Alloc 2',1)").run();
baseline.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active,created_at)
  VALUES(1,'synthetic-admin','not-used','Synthetic Admin','admin',1,?)`).run(now);
assert.equal(Number(baseline.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 0,
  "the isolated automation fixture starts with no CRM records");
baseline.close();

await writeFile(entryPath, `
  export { crmDb } from "./src/lib/crm-db";
  export { registerCustomerIdentityFunctions } from "./src/lib/customer-integrity";
  export {
    processInstagramCrmRegistration,
    getInstagramCrmReplyOverride,
    completeInstagramCrmRequestFromInbound,
    processInstagramCrmAutomationDue,
    markInstagramCrmQuestionDelivered,
  } from "./src/lib/instagram-crm-automation";
`);
await build({
  entryPoints: [entryPath],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  sourcemap: false,
});

process.env.CRM_DATABASE_PATH = databasePath;
process.env.NODE_ENV = "test";
let api = await import(pathToFileURL(bundlePath).href);
let db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
api.registerCustomerIdentityFunctions(db);
const repeatActorColumn = db.prepare("PRAGMA table_info(customer_repeat_requests)")
  .all().find((column) => column.name === "created_by_user_id");
assert.equal(repeatActorColumn.notnull, 0,
  "legacy NOT NULL actor schema is additively rebuilt to allow authentic automated provenance");
assert.ok(db.prepare("PRAGMA table_info(customer_repeat_requests)").all()
  .some((column) => column.name === "source_message_id"));
const allocation = db.prepare(`INSERT INTO allocation_programs
  (name,is_default,active,cursor_item_index,cursor_item_used,created_at,updated_at)
  VALUES('Synthetic strict default',1,1,0,0,?,?)`).run(now, now);
const programId = Number(allocation.lastInsertRowid);
db.prepare(`INSERT INTO allocation_program_items(program_id,salesperson_id,quota,sort_order)
  VALUES(?,1,1,0),(?,2,1,1)`).run(programId, programId);

let threadCounter = 0;
const thread = ({
  name = null,
  phone = null,
  request = null,
  customerId = null,
  isUrgent = 0,
} = {}) => {
  threadCounter += 1;
  return Number(db.prepare(`INSERT INTO instagram_threads
    (sender_id,name,full_name,phone,request,customer_id,is_urgent,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'open',?,?)`).run(
    `synthetic-sender-${threadCounter}`, name, name, phone, request, customerId, isUrgent, now, now,
  ).lastInsertRowid);
};
const inbound = (threadId, mid, content, sentAt = new Date().toISOString()) => {
  db.prepare(`INSERT INTO instagram_messages(thread_id,mid,direction,content,sent_at)
    VALUES(?,?,'inbound',?,?)`).run(threadId, mid, content, sentAt);
};
const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
const customerById = (id) => db.prepare(`SELECT id,name,phone,description,verification_status,
  priority,salesperson_id,is_urgent FROM customers WHERE id=?`).get(id);

try {
  // New registration does not wait for a request and has neither invented
  // priority nor a fabricated/human verification state.
  const first = thread({ name: "سارا احمدی", phone: "09110000001" });
  inbound(first, "new-phone", "شماره من 09110000001");
  const created = api.processInstagramCrmRegistration(first, "new-phone");
  assert.equal(created.kind, "created");
  const firstCustomer = customerById(created.customerId);
  assert.equal(firstCustomer.name, "سارا احمدی");
  assert.equal(firstCustomer.phone, "09110000001");
  assert.equal(firstCustomer.description, null, "request is optional for identity registration");
  assert.equal(firstCustomer.verification_status, "unverified");
  assert.equal(firstCustomer.priority, null);
  assert.equal(firstCustomer.salesperson_id, 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM customers"), 1);
  assert.equal(Number(db.prepare("SELECT cursor_item_index FROM allocation_programs WHERE id=?")
    .get(programId).cursor_item_index), 1);

  // A request sent before identity remains in the durable episode summary;
  // identity-only follow-up completes registration without overwriting it.
  const separated = thread();
  inbound(separated, "separate-request", "برای وام خودرو شرایط را لطفاً بفرمایید");
  assert.equal(api.processInstagramCrmRegistration(separated, "separate-request").kind, "waiting_fields");
  db.prepare("UPDATE instagram_threads SET full_name='مینا رضایی',name='مینا رضایی',phone='۰۹۱۱۰۰۰۰۰۰۲' WHERE id=?")
    .run(separated);
  inbound(separated, "separate-identity", "مینا رضایی شماره من ۰۹۱۱۰۰۰۰۰۰۲");
  const createdSeparated = api.processInstagramCrmRegistration(separated, "separate-identity");
  assert.equal(createdSeparated.kind, "created");
  assert.equal(customerById(createdSeparated.customerId).salesperson_id, 2);
  assert.match(customerById(createdSeparated.customerId).description, /وام خودرو/);
  assert.equal(count("SELECT COUNT(*) AS n FROM customers"), 2);

  // The deterministic intake urgency predicate rejects a negative statement
  // and an informational question rather than marking either as urgent.
  const negativeUrgency = thread({ name: "ندا محمدی", phone: "09110000004" });
  inbound(negativeUrgency, "negative-urgency", "من وام فوری نمی‌خواهم");
  const negativeCreated = api.processInstagramCrmRegistration(negativeUrgency, "negative-urgency");
  assert.equal(customerById(negativeCreated.customerId).is_urgent, 0);
  const questionUrgency = thread({ name: "الهام کریمی", phone: "09110000005" });
  inbound(questionUrgency, "question-urgency", "شرایط وام فوری چیست؟");
  const questionCreated = api.processInstagramCrmRegistration(questionUrgency, "question-urgency");
  assert.equal(customerById(questionCreated.customerId).is_urgent, 0);

  // Preserve a human-authored history row while automatic registration adds a
  // new repeat-request draft and the managed repeat_request tag.
  const existingId = Number(db.prepare(`INSERT INTO customers
    (name,phone,description,verification_status,created_at,status,priority,salesperson_id,is_urgent)
    VALUES('Original CRM Name','09123456789','keep this','verified',?,'in_progress',2,2,0)`)
    .run(now).lastInsertRowid);
  db.prepare(`INSERT INTO customer_repeat_requests
    (customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,created_at)
    VALUES(?,'Human Name','Human note','Human authored request','pending',1,?)`).run(existingId, now);
  const duplicate = thread({ name: "تغییر نام کاربر", phone: "+98 912 345 6789" });
  inbound(duplicate, "repeat-start", "شماره من +98 912 345 6789 برای خرید خودرو درخواست وام دارم");
  const repeat = api.processInstagramCrmRegistration(duplicate, "repeat-start");
  assert.equal(repeat.kind, "repeat");
  assert.equal(db.prepare(`SELECT is_urgent FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND source_message_id='repeat-start'`).get(duplicate).is_urgent, 0,
  "the normal repeat event is not incorrectly marked urgent");
  assert.equal(repeat.customerId, existingId);
  assert.equal(repeat.needsRequestQuestion, true);
  assert.equal(repeat.question, "برای این درخواست چه مبلغی نیاز دارید؟");
  assert.doesNotMatch(repeat.question, /عضو|مشتری|پرونده/);
  const preserved = customerById(existingId);
  assert.equal(preserved.name, "Original CRM Name");
  assert.equal(preserved.phone, "09123456789");
  assert.equal(Number(preserved.priority), 2);
  assert.equal(preserved.salesperson_id, 2);
  assert.equal(preserved.is_urgent, 0, "a normal repeat request does not set urgency");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId), 1,
    "a pending draft is durable before being finalized as a repeat request");
  assert.equal(db.prepare("SELECT tag FROM customer_tags WHERE customer_id=? AND tag='repeat_request'")
    .get(existingId).tag, "repeat_request");
  assert.equal(api.getInstagramCrmReplyOverride(duplicate).kind, "clarify",
    "the initial repeat event hands off the question even when its message had meaningful intent");

  const firstDue = db.prepare(`SELECT due_at,delivery_reset FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND source_message_id='repeat-start'`).get(duplicate);
  api.markInstagramCrmQuestionDelivered(duplicate);
  const handedOffDue = db.prepare(`SELECT due_at,delivery_reset FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND source_message_id='repeat-start'`).get(duplicate);
  assert.equal(handedOffDue.delivery_reset, 1);
  assert.ok(new Date(handedOffDue.due_at) > new Date(firstDue.due_at));
  api.markInstagramCrmQuestionDelivered(duplicate);
  assert.equal(db.prepare(`SELECT due_at FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND source_message_id='repeat-start'`).get(duplicate).due_at, handedOffDue.due_at,
  "delivery retries cannot reset the handoff fallback deadline repeatedly");
  assert.equal(api.processInstagramCrmRegistration(duplicate, "repeat-start").kind, "existing_session");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId), 1,
    "duplicate event replay creates no duplicate row");

  inbound(duplicate, "identity-phone-only", "شماره من 09123456789");
  api.completeInstagramCrmRequestFromInbound(duplicate, "identity-phone-only");
  api.processInstagramCrmRegistration(duplicate, "identity-phone-only");
  inbound(duplicate, "identity-name-only", "نام من است");
  api.completeInstagramCrmRequestFromInbound(duplicate, "identity-name-only");
  api.processInstagramCrmRegistration(duplicate, "identity-name-only");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId), 1,
    "phone declarations and name-only declarations cannot finalize a repeat request");

  inbound(duplicate, "repeat-thanks", "ممنون");
  const sessionsBeforeThanks = count(
    "SELECT COUNT(*) AS n FROM instagram_crm_automation_sessions WHERE thread_id=?",
    duplicate,
  );
  const thanksResult = api.processInstagramCrmRegistration(duplicate, "repeat-thanks");
  assert.equal(thanksResult.kind, "existing_session");
  assert.equal(thanksResult.needsRequestQuestion, undefined, "same episode does not re-ask on every inbound");
  assert.equal(api.getInstagramCrmReplyOverride(duplicate).kind, "clarify");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId), 1);
  inbound(duplicate, "membership-question", "آیا قبلاً در سیستم ثبت شده‌ام؟");
  api.processInstagramCrmRegistration(duplicate, "membership-question");
  const privacyOverride = api.getInstagramCrmReplyOverride(duplicate);
  assert.equal(privacyOverride.kind, "redirect");
  assert.match(privacyOverride.answer, /حریم خصوصی/);
  assert.doesNotMatch(privacyOverride.answer, /ثبت شده‌اید|مشتری هستید/);
  assert.equal(count(
    "SELECT COUNT(*) AS n FROM instagram_crm_automation_sessions WHERE thread_id=?",
    duplicate,
  ), sessionsBeforeThanks + 2);

  inbound(duplicate, "repeat-answer", "این بار برای خرید لوازم خانه وام فوری نیاز دارم");
  api.completeInstagramCrmRequestFromInbound(
    duplicate,
    "repeat-answer",
    "برای خرید لوازم خانه وام فوری نیاز دارم",
  );
  const completed = api.processInstagramCrmRegistration(duplicate, "repeat-answer");
  assert.equal(completed.kind, "existing_session",
    "a completed reply source replays as an existing finalized session");
  assert.equal(customerById(existingId).is_urgent, 1,
    "an urgent repeat answer marks the native customer flag before the existing-session replay");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId), 2);
  const automaticRequest = db.prepare(`SELECT created_by_user_id,provenance,source_thread_id,source_message_id,
    requested_name,submitted_description FROM customer_repeat_requests
    WHERE source_message_id='repeat-answer'`).get();
  assert.equal(automaticRequest.created_by_user_id, null, "automation never impersonates a CRM user");
  assert.equal(automaticRequest.provenance, "instagram_automation");
  assert.equal(automaticRequest.source_thread_id, duplicate);
  assert.equal(automaticRequest.requested_name, "تغییر نام کاربر");
  assert.match(automaticRequest.submitted_description, /خرید لوازم خانه/);
  assert.equal(db.prepare(`SELECT created_by_user_id,provenance FROM customer_repeat_requests
    WHERE customer_id=? ORDER BY id LIMIT 1`).get(existingId).created_by_user_id, 1,
  "a prior human request remains human-authored");
  assert.throws(() => db.prepare(`UPDATE customer_repeat_requests SET requested_name='changed'
    WHERE customer_id=? AND created_by_user_id=1`).run(existingId), /append-only/);
  assert.equal(customerById(existingId).name, "Original CRM Name");

  const requestCountBeforeThanks = count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId);
  inbound(duplicate, "after-complete-thanks", "سپاس");
  api.processInstagramCrmRegistration(duplicate, "after-complete-thanks");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId),
    requestCountBeforeThanks, "thanks cannot open another repeat-request episode");

  // After the amount-focused repeat question, identity and OTP noise still do
  // not finalize a request. A validated Persian/Arabic-digit amount is stored
  // verbatim from its inbound source and remains source-idempotent on replay.
  const amountThread = thread({ name: "تغییر نام کاربر", customerId: existingId });
  inbound(amountThread, "amount-repeat-start", "برای خرید خودرو درخواست وام دارم");
  const amountStart = api.processInstagramCrmRegistration(amountThread, "amount-repeat-start");
  assert.equal(amountStart.kind, "repeat");
  assert.equal(amountStart.question, "برای این درخواست چه مبلغی نیاز دارید؟");
  inbound(amountThread, "amount-otp-noise", "کد ورود 123456");
  api.completeInstagramCrmRequestFromInbound(amountThread, "amount-otp-noise");
  api.processInstagramCrmRegistration(amountThread, "amount-otp-noise");
  inbound(amountThread, "amount-phone-only", "0912 345 6789");
  api.completeInstagramCrmRequestFromInbound(amountThread, "amount-phone-only");
  api.processInstagramCrmRegistration(amountThread, "amount-phone-only");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId),
    requestCountBeforeThanks, "OTP and phone-only replies cannot finalize an amount request");
  inbound(amountThread, "amount-persian-arabic-digits", "٢٥٠ میلیون تومان");
  const amountResult = api.processInstagramCrmRegistration(amountThread, "amount-persian-arabic-digits");
  assert.equal(amountResult.kind, "repeat");
  const amountRequest = db.prepare(`SELECT created_by_user_id,provenance,source_thread_id,source_message_id,
    submitted_description FROM customer_repeat_requests WHERE source_message_id='amount-persian-arabic-digits'`).get();
  assert.equal(amountRequest.created_by_user_id, null);
  assert.equal(amountRequest.provenance, "instagram_automation");
  assert.equal(amountRequest.source_thread_id, amountThread);
  assert.equal(amountRequest.submitted_description, "٢٥٠ میلیون تومان",
    "amount summary preserves the exact Persian/Arabic-digit inbound source");
  assert.equal(api.processInstagramCrmRegistration(amountThread, "amount-persian-arabic-digits").kind, "existing_session");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE source_message_id='amount-persian-arabic-digits'"),
    1, "replaying an amount reply cannot create a second repeat request");

  const persianAmountThread = thread({ name: "تغییر نام کاربر", customerId: existingId });
  inbound(persianAmountThread, "persian-amount-start", "برای وام خرید کالا درخواست دارم");
  assert.equal(api.processInstagramCrmRegistration(persianAmountThread, "persian-amount-start").kind, "repeat");
  inbound(persianAmountThread, "persian-amount-reply", "۲۵۰ میلیون تومان");
  assert.equal(api.processInstagramCrmRegistration(persianAmountThread, "persian-amount-reply").kind, "repeat");
  assert.equal(db.prepare("SELECT submitted_description FROM customer_repeat_requests WHERE source_message_id='persian-amount-reply'")
    .get().submitted_description, "۲۵۰ میلیون تومان",
  "Persian digits and million-scale amounts are validated and preserved verbatim");

  // A bare numeric reply is permitted only after the amount question. Even if
  // a caller supplies a normalized extraction, the audit description is the
  // original inbound numeric source.
  const bareAmountThread = thread({ name: "تغییر نام کاربر", customerId: existingId });
  inbound(bareAmountThread, "bare-amount-start", "برای وام مسکن درخواست دارم");
  assert.equal(api.processInstagramCrmRegistration(bareAmountThread, "bare-amount-start").kind, "repeat");
  inbound(bareAmountThread, "bare-amount-reply", "150000000");
  api.completeInstagramCrmRequestFromInbound(bareAmountThread, "bare-amount-reply", "۱۵۰ میلیون تومان");
  assert.equal(api.processInstagramCrmRegistration(bareAmountThread, "bare-amount-reply").kind, "existing_session");
  assert.equal(db.prepare("SELECT submitted_description FROM customer_repeat_requests WHERE source_message_id='bare-amount-reply'")
    .get().submitted_description, "150000000");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE source_message_id='bare-amount-reply'"),
    1, "a bare numeric reply is source-idempotent");

  // A valid amount already present in the original consultation request
  // finalizes immediately rather than asking for the amount again.
  const beforeImmediateAmount = count(
    "SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?",
    existingId,
  );
  const immediateAmountThread = thread();
  const immediateAmountSource = "برای خرید لوازم خانگی وام ۲۵۰ میلیون تومان نیاز دارم";
  inbound(immediateAmountThread, "immediate-amount-repeat", immediateAmountSource);
  assert.equal(api.processInstagramCrmRegistration(
    immediateAmountThread,
    "immediate-amount-repeat",
  ).kind, "waiting_fields");
  db.prepare("UPDATE instagram_threads SET full_name='سارا احمدی',name='سارا احمدی',phone='09123456789' WHERE id=?")
    .run(immediateAmountThread);
  inbound(immediateAmountThread, "immediate-amount-identity", "سارا احمدی شماره من 09123456789");
  const immediateAmountResult = api.processInstagramCrmRegistration(
    immediateAmountThread,
    "immediate-amount-identity",
  );
  assert.equal(immediateAmountResult.kind, "repeat");
  assert.equal(immediateAmountResult.customerId, existingId);
  assert.equal(immediateAmountResult.needsRequestQuestion, undefined);
  assert.equal(immediateAmountResult.question, undefined);
  assert.equal(api.getInstagramCrmReplyOverride(immediateAmountThread), null);
  const immediateAmountRequest = db.prepare(`SELECT created_by_user_id,provenance,source_thread_id,
    source_message_id,submitted_description FROM customer_repeat_requests
    WHERE source_message_id='immediate-amount-repeat'`).get();
  assert.equal(immediateAmountRequest.created_by_user_id, null);
  assert.equal(immediateAmountRequest.provenance, "instagram_automation");
  assert.equal(immediateAmountRequest.source_thread_id, immediateAmountThread);
  assert.equal(immediateAmountRequest.source_message_id, "immediate-amount-repeat");
  assert.equal(immediateAmountRequest.submitted_description, immediateAmountSource,
    "immediate repeat history preserves the exact original amount-bearing request");
  assert.equal(db.prepare(`SELECT state FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND episode_id='immediate-amount-repeat' ORDER BY id DESC LIMIT 1`)
    .get(immediateAmountThread).state, "completed_repeat");
  assert.equal(api.processInstagramCrmRegistration(immediateAmountThread, "immediate-amount-repeat").kind,
    "existing_session");
  assert.equal(api.processInstagramCrmRegistration(immediateAmountThread, "immediate-amount-identity").kind,
    "existing_session");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE customer_id=?", existingId),
    beforeImmediateAmount + 1, "initial amount request finalization is replay-idempotent");
  assert.equal(customerById(existingId).name, "Original CRM Name");
  assert.equal(customerById(existingId).phone, "09123456789");
  assert.equal(Number(customerById(existingId).priority), 2);
  assert.equal(customerById(existingId).salesperson_id, 2);
  assert.equal(db.prepare("SELECT tag FROM customer_tags WHERE customer_id=? AND tag='repeat_request'")
    .get(existingId).tag, "repeat_request");

  const cancelledCustomerId = Number(db.prepare(`INSERT INTO customers
    (name,phone,verification_status,created_at,status,priority,salesperson_id,is_urgent)
    VALUES('Cancelled Legacy Customer','09123456780','unverified',?,'cancelled',3,1,0)`)
    .run(now).lastInsertRowid);
  const cancelledThread = thread({ name: "کاربر بازگشتی", phone: "09123456780" });
  inbound(cancelledThread, "cancelled-phone-repeat", "شماره من 09123456780");
  const cancelledRepeat = api.processInstagramCrmRegistration(cancelledThread, "cancelled-phone-repeat");
  assert.equal(cancelledRepeat.kind, "repeat");
  assert.equal(cancelledRepeat.customerId, cancelledCustomerId,
    "a previously registered cancelled number is never re-created as a new customer");
  const cancelledPreserved = customerById(cancelledCustomerId);
  assert.equal(db.prepare("SELECT status FROM customers WHERE id=?").get(cancelledCustomerId).status, "cancelled");
  assert.equal(cancelledPreserved.salesperson_id, 1);
  assert.equal(Number(cancelledPreserved.priority), 3);

  // A later explicit request opens a new episode. Its fallback is durable
  // across module/database restart and records only captured inbound summary.
  const fallbackThread = thread({
    name: "کاربر بازگشتی",
    phone: "09123456789",
    request: "موضوع قدیمی برای وام مسکن را پیگیری می‌کنم",
  });
  inbound(fallbackThread, "outside-episode", "برای خرید لوازم منزل وام مسکن می‌خواهم", "2999-01-01T00:00:00.000Z");
  inbound(fallbackThread, "fallback-start", "برای وام خودرو شرایط را لطفاً بفرمایید", "2001-01-01T00:00:00.000Z");
  const fallbackStart = api.processInstagramCrmRegistration(fallbackThread, "fallback-start");
  assert.equal(fallbackStart.kind, "repeat");
  assert.equal(fallbackStart.needsRequestQuestion, true);
  api.markInstagramCrmQuestionDelivered(fallbackThread);
  db.prepare(`UPDATE instagram_crm_automation_sessions SET request_summary=NULL
    WHERE thread_id=? AND episode_id='fallback-start'`).run(fallbackThread);
  db.prepare(`UPDATE instagram_crm_automation_sessions SET due_at=?
    WHERE thread_id=? AND state='repeat_waiting_request'`).run("2020-01-01T00:00:00.000Z", fallbackThread);

  const identityOnlyFallback = thread({
    name: "کاربر بازگشتی",
    phone: "09123456789",
    customerId: existingId,
    request: "legacy stale request must not be used",
  });
  inbound(identityOnlyFallback, "identity-fallback-start", "شماره من 09123456789", "2001-01-01T00:00:00.000Z");
  assert.equal(api.processInstagramCrmRegistration(identityOnlyFallback, "identity-fallback-start").kind, "repeat");
  db.prepare(`UPDATE instagram_crm_automation_sessions SET request_summary=NULL,due_at='2020-01-01T00:00:00.000Z'
    WHERE thread_id=? AND state='repeat_waiting_request'`).run(identityOnlyFallback);

  // Missing active default allocation must roll back customer creation and
  // quota advancement while retaining a durable retry session.
  const noAllocationThread = thread({ name: "ندا محمدی", phone: "09110000003" });
  inbound(noAllocationThread, "no-allocation", "شماره من 09110000003");
  const cursorBefore = db.prepare("SELECT cursor_item_index,cursor_item_used FROM allocation_programs WHERE id=?")
    .get(programId);
  db.prepare("UPDATE allocation_programs SET active=0 WHERE id=?").run(programId);
  const countBeforeNoAllocation = count("SELECT COUNT(*) AS n FROM customers");
  const noAllocation = api.processInstagramCrmRegistration(noAllocationThread, "no-allocation");
  assert.equal(noAllocation.kind, "error");
  assert.equal(count("SELECT COUNT(*) AS n FROM customers"), countBeforeNoAllocation);
  const retry = db.prepare(`SELECT state,error,due_at FROM instagram_crm_automation_sessions
    WHERE thread_id=? AND source_message_id='no-allocation'`).get(noAllocationThread);
  assert.equal(retry.state, "registration_retry");
  assert.equal(retry.error, "ALLOCATION_PROGRAM_UNAVAILABLE");
  const cursorAfterFailure = db.prepare("SELECT cursor_item_index,cursor_item_used FROM allocation_programs WHERE id=?")
    .get(programId);
  assert.deepEqual(cursorAfterFailure, cursorBefore, "allocation quota changes roll back atomically");
  db.prepare("UPDATE allocation_programs SET active=1 WHERE id=?").run(programId);
  db.prepare(`UPDATE instagram_crm_automation_sessions SET due_at=?
    WHERE thread_id=? AND state='registration_retry'`).run("2020-01-01T00:00:00.000Z", noAllocationThread);

  // Re-importing after closing the first connection simulates process restart;
  // both the due repeat fallback and allocation retry remain durable.
  db.close();
  api.crmDb.close();
  api = await import(`${pathToFileURL(bundlePath).href}?restart=1`);
  db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  api.registerCustomerIdentityFunctions(db);
  await api.processInstagramCrmAutomationDue(new Date());
  const fallbackRequest = db.prepare(`SELECT created_by_user_id,provenance,source_thread_id,source_message_id,
    submitted_description FROM customer_repeat_requests WHERE source_thread_id=? ORDER BY id DESC LIMIT 1`)
    .get(fallbackThread);
  assert.equal(fallbackRequest.created_by_user_id, null);
  assert.equal(fallbackRequest.provenance, "instagram_automation");
  assert.equal(fallbackRequest.source_message_id, "fallback-start");
  assert.match(fallbackRequest.submitted_description, /وام خودرو/);
  assert.doesNotMatch(fallbackRequest.submitted_description, /مسکن|لوازم منزل|legacy stale/);
  assert.equal(db.prepare("SELECT state FROM instagram_crm_automation_sessions WHERE thread_id=? ORDER BY id DESC LIMIT 1")
    .get(fallbackThread).state, "completed_repeat");
  assert.equal(db.prepare("SELECT state FROM instagram_crm_automation_sessions WHERE thread_id=? ORDER BY id DESC LIMIT 1")
    .get(identityOnlyFallback).state, "needs_human",
  "identity-only episode fallback retains no invented or stale legacy summary");
  assert.equal(count("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE source_thread_id=?",
    identityOnlyFallback), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone='09110000003'").get().n, 1,
    "durable allocation retry completes after the default program returns");
  assert.equal(db.prepare("SELECT state FROM instagram_crm_automation_sessions WHERE thread_id=? ORDER BY id DESC LIMIT 1")
    .get(noAllocationThread).state, "completed_new");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE source_message_id='fallback-start'")
    .get().n, 1, "restart fallback is source-event idempotent");
  process.stdout.write("Instagram CRM automation isolated fixture passed\n");
} finally {
  try { db.close(); } catch {}
  try { api?.crmDb?.close(); } catch {}
  await rm(entryPath, { force: true });
  await rm(bundlePath, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
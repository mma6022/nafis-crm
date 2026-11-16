import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-ig-runtime-"));
const databasePath = path.join(tempRoot, "synthetic-empty-crm.db");
const entryPath = path.join(artifactDir, `.instagram-intake-runtime-entry-${process.pid}.ts`);
const bundlePath = path.join(artifactDir, `.instagram-intake-runtime-test-${process.pid}.mjs`);
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
baseline.prepare("INSERT INTO salespersons(id,name,active) VALUES(1,'Synthetic Runtime One',1),(2,'Synthetic Runtime Two',1)").run();
baseline.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active,created_at)
  VALUES(1,'synthetic-runtime-admin','not-used','Synthetic Runtime Admin','admin',1,?)`).run(now);
assert.equal(Number(baseline.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 0,
  "the isolated runtime fixture starts with an empty synthetic CRM");
baseline.close();

await writeFile(entryPath, `
  export { crmDb } from "./src/lib/crm-db";
  export { registerCustomerIdentityFunctions } from "./src/lib/customer-integrity";
  export {
    acceptInstagramMessage,
    instagramThreadData,
    startInstagramWorker,
  } from "./src/lib/instagram";
  export {
    getInstagramCrmReplyOverride,
    markInstagramCrmQuestionDelivered,
  } from "./src/lib/instagram-crm-automation";
`);
process.env.CRM_DATABASE_PATH = databasePath;
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "synthetic-runtime-session-secret-for-instagram";
process.env.IG_APP_SECRET = "synthetic-instagram-app-secret";
process.env.IG_VERIFY_TOKEN = "synthetic-instagram-verify-token";
process.env.IG_ACCOUNT_ID = "synthetic-instagram-account";
process.env.IG_AUTOREPLY_ENABLED = "0";
process.env.MANYCHAT_ACCOUNT_ID = "synthetic-runtime-account";
process.env.MANYCHAT_BRIDGE_SECRET = "synthetic-runtime-bridge-secret-at-least-24";
process.env.MANYCHAT_API_TOKEN = "synthetic-runtime-api-token";
process.env.MANYCHAT_AUTOREPLY_ENABLED = "0";
process.env.INSTAGRAM_AI_TIMEOUT_MS = "1000";

const providerRequests = [];
globalThis.fetch = async (url, init = {}) => {
  providerRequests.push({ url: String(url), init });
  return new Response(JSON.stringify({ status: "success", message_id: `synthetic-${providerRequests.length}` }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

let api;
let db;
try {
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    sourcemap: false,
  });
  api = await import(pathToFileURL(bundlePath).href);
  db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  api.registerCustomerIdentityFunctions(db);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 0,
    "CRM automation migrations do not backfill old threads into customers");

  const allocation = db.prepare(`INSERT INTO allocation_programs
    (name,is_default,active,cursor_item_index,cursor_item_used,created_at,updated_at)
    VALUES('Synthetic runtime default',1,1,0,0,?,?)`).run(now, now);
  const programId = Number(allocation.lastInsertRowid);
  db.prepare(`INSERT INTO allocation_program_items(program_id,salesperson_id,quota,sort_order)
    VALUES(?,1,1,0),(?,2,1,1)`).run(programId, programId);

  const senderId = "mc:synthetic-runtime-account:123456";
  const recipientId = "mc:synthetic-runtime-account";
  let timestamp = Date.now() - 30_000;
  const inbound = (mid, text) => {
    timestamp += 1_000;
    assert.equal(api.acceptInstagramMessage({
      senderId,
      recipientId,
      mid,
      text,
      timestamp,
      source: "manychat",
    }), "accepted", `runtime inbound ${mid} is accepted once`);
  };
  const threadRow = () => db.prepare("SELECT * FROM instagram_threads WHERE sender_id=?").get(senderId);
  const customerById = (id) => db.prepare(`SELECT id,name,phone,description,verification_status,
    priority,salesperson_id,is_urgent FROM customers WHERE id=?`).get(id);

  inbound("need-first", "برای خرید خودرو وام میخوام");
  assert.equal(threadRow().request, "برای خرید خودرو وام میخوام",
    "a meaningful user need is persisted before identity fields arrive");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 0);

  inbound("identity-name", "من سارا احمدی هستم");
  assert.equal(threadRow().name, "سارا احمدی");
  assert.equal(threadRow().request, "برای خرید خودرو وام میخوام",
    "identity-only name messages do not erase the earlier meaningful request");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 0,
    "a name alone never creates a CRM customer");

  inbound("identity-phone", "شماره من ۰۹۱۱۰۰۰۰۰۰۱");
  const createdThread = threadRow();
  assert.ok(createdThread.customer_id, "the accepted identity pair automatically links a new CRM customer");
  assert.equal(createdThread.name, "سارا احمدی");
  assert.equal(createdThread.phone, "09110000001");
  assert.equal(createdThread.request, "برای خرید خودرو وام میخوام");
  const createdCustomer = customerById(createdThread.customer_id);
  assert.equal(createdCustomer.name, "سارا احمدی");
  assert.equal(createdCustomer.phone, "09110000001");
  assert.equal(createdCustomer.description, "برای خرید خودرو وام میخوام",
    "the request captured before name and phone remains the customer summary");
  assert.equal(createdCustomer.verification_status, "unverified");
  assert.equal(createdCustomer.priority, null);
  assert.equal(createdCustomer.salesperson_id, 1,
    "automatic registration uses default allocation without a manual conversion call");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 1);
  assert.equal(Number(db.prepare("SELECT cursor_item_index FROM allocation_programs WHERE id=?")
    .get(programId).cursor_item_index), 1);
  const threadData = api.instagramThreadData({
    ...createdThread,
    last_message: "شماره من ۰۹۱۱۰۰۰۰۰۰۱",
  });
  assert.equal(threadData.customerId, createdCustomer.id);
  assert.equal(threadData.request, "برای خرید خودرو وام میخوام",
    "the Instagram thread API retains the request for the inbox client");

  // The same accepted runtime hook recognizes an existing CRM customer, creates
  // an attributed repeat-request draft, and publishes the question only through
  // the mocked Manychat provider.
  process.env.MANYCHAT_AUTOREPLY_ENABLED = "1";
  inbound("repeat-urgent", "فوری وام نیاز دارم");
  const repeatSession = db.prepare(`SELECT * FROM instagram_crm_automation_sessions
    WHERE thread_id=? ORDER BY id DESC LIMIT 1`).get(createdThread.id);
  assert.equal(repeatSession.state, "repeat_waiting_request");
  assert.equal(repeatSession.is_urgent, 1);
  assert.equal(api.getInstagramCrmReplyOverride(createdThread.id).kind, "clarify");
  assert.equal(customerById(createdCustomer.id).is_urgent, 1);
  assert.equal(db.prepare("SELECT tag FROM customer_tags WHERE customer_id=? AND tag='repeat_request'")
    .get(createdCustomer.id).tag, "repeat_request");

  api.startInstagramWorker();
  const waitUntil = async (predicate, message, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(message);
  };
  await waitUntil(
    () => db.prepare(`SELECT 1 FROM instagram_messages
      WHERE thread_id=? AND direction='outbound' AND content LIKE '%چه مبلغی%' LIMIT 1`)
      .get(createdThread.id),
    "the real API worker delivers the CRM repeat question through the mock provider",
  );
  const outboundQuestion = db.prepare(`SELECT content FROM instagram_messages
    WHERE thread_id=? AND direction='outbound' ORDER BY id DESC LIMIT 1`).get(createdThread.id).content;
  assert.match(outboundQuestion, /چه مبلغی نیاز دارید/);
  assert.equal(providerRequests.length, 1);
  assert.match(providerRequests[0].url, /api\.manychat\.com/);
  const delivered = db.prepare(`SELECT delivery_reset,question_delivered_at FROM instagram_crm_automation_sessions
    WHERE thread_id=? ORDER BY id DESC LIMIT 1`).get(createdThread.id);
  assert.equal(delivered.delivery_reset, 1);
  assert.ok(delivered.question_delivered_at,
    "the service handoff is marked only after the mocked provider accepts the send");

  inbound("repeat-answer", "این بار برای تعمیر خانه درخواست وام دارم");
  const repeatRequest = db.prepare(`SELECT created_by_user_id,provenance,source_thread_id,source_message_id,
    requested_name,submitted_description FROM customer_repeat_requests WHERE source_message_id=?`)
    .get("repeat-answer");
  assert.ok(repeatRequest);
  assert.equal(repeatRequest.created_by_user_id, null,
    "the runtime does not impersonate a CRM user in the repeat-request API record");
  assert.equal(repeatRequest.provenance, "instagram_automation");
  assert.equal(repeatRequest.source_thread_id, createdThread.id);
  assert.match(repeatRequest.submitted_description, /تعمیر خانه/);
  assert.equal(db.prepare("SELECT requested_name FROM customer_repeat_requests WHERE source_message_id=?")
    .get("repeat-answer").requested_name, "سارا احمدی");
  assert.equal(customerById(createdCustomer.id).name, "سارا احمدی",
    "repeat intake does not mutate the existing CRM identity");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_repeat_requests WHERE source_message_id=?")
    .get("repeat-answer").n, 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n), 1,
    "repeat handling does not create a second customer for the same mobile");

  process.stdout.write("Instagram intake runtime isolated fixture passed\n");
} finally {
  try { db?.close(); } catch {}
  try { api?.crmDb?.close(); } catch {}
  await rm(entryPath, { force: true });
  await rm(bundlePath, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
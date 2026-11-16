import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => nativeFetch(input, {
  ...init,
  signal: init.signal ?? AbortSignal.timeout(8_000),
});
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-instagram-conversion-"));
const databasePath = path.join(tempRoot, "crm.db");
const db = new DatabaseSync(databasePath);
const sessionSecret = "instagram-conversion-fixture-session-secret";
const now = new Date().toISOString();
db.exec(`
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
  CREATE TABLE call_logs(
    id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,
    salesperson_name_snapshot TEXT,created_at TEXT
  );
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
  CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES
    ('customer-portal-loan-actor-provenance-v1',CURRENT_TIMESTAMP),
    ('customer-portal-stage-history-actor-v1',CURRENT_TIMESTAMP);
`);
db.prepare("INSERT INTO salespersons(id,name,active) VALUES(1,'Synthetic fixture salesperson',1)").run();
db.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active,created_at,salesperson_id)
  VALUES(1,'synthetic-admin','unused','Synthetic Admin','admin',1,?,NULL),
        (2,'synthetic-salesperson','unused','Synthetic Salesperson','salesperson',1,?,1),
        (3,'synthetic-registrar','unused','Synthetic Registrar','registrar',1,?,NULL)`)
  .run(now, now, now);
db.prepare(`INSERT INTO customers(name,phone,description,verification_status,created_at,status)
  VALUES('Synthetic protected customer','09123456789','privacy fixture','verified',?,'in_progress')`).run(now);
const sessionTokens = new Map();
for (const [id, role] of [[1, "admin"], [2, "salesperson"], [3, "registrar"]]) {
  const token = randomBytes(24).toString("base64url");
  sessionTokens.set(id, token);
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", sessionSecret).update(token).digest("hex"),
    id,
    new Date(Date.now() + 300_000).toISOString(),
    now,
  );
}
db.close();

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const child = spawn(process.execPath, [
  "--import", "./scripts/manychat-fetch-mock.mjs",
  "--enable-source-maps", "dist/index.mjs",
], {
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    PORT: String(port),
    CRM_DATABASE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    MANYCHAT_AUTOREPLY_ENABLED: "0",
    IG_AUTOREPLY_ENABLED: "1",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9/fixture-disabled",
    AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
const appendOutput = (chunk) => { childOutput = `${childOutput}${chunk.toString()}`.slice(-12000); };
child.stdout.on("data", appendOutput);
child.stderr.on("data", appendOutput);
const baseUrl = `http://127.0.0.1:${port}/api`;
const adminCookie = `crm_session=${sessionTokens.get(1)}`;
const registrarCookie = `crm_session=${sessionTokens.get(3)}`;
const salespersonCookie = `crm_session=${sessionTokens.get(2)}`;
const bridgeSecret = "synthetic-api-bridge-secret-for-fixture";
const apiToken = "synthetic-valid-manychat-api-token";
const openDb = () => {
  const connection = new DatabaseSync(databasePath);
  connection.exec("PRAGMA busy_timeout=3000");
  return connection;
};
const requestJson = async (pathName, body, cookie) => fetch(`${baseUrl}${pathName}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: JSON.stringify(body),
});
const inbound = async (subscriberId, text, messageId) => fetch(`${baseUrl}/manychat/inbound`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CRM-Bridge-Secret": bridgeSecret },
  body: JSON.stringify({ subscriberId, text, messageId }),
});
const waitForOutbound = async (threadId, previousCount, expectedContent) => {
  const queued = openDb();
  queued.prepare("UPDATE instagram_send_state SET last_sent_at=NULL WHERE id=1").run();
  queued.prepare("UPDATE instagram_send_queue SET due_at=?,state='pending' WHERE thread_id=?")
    .run(new Date(Date.now() - 1000).toISOString(), threadId);
  queued.close();
  // Production queue enforces a 10-second delay after each inbound message and
  // between sends; moving due_at earlier cannot bypass that safety limit.
  for (let attempt = 0; attempt < 220; attempt += 1) {
    const check = openDb();
    const rows = check.prepare(`SELECT content FROM instagram_messages
      WHERE thread_id=? AND direction='outbound' ORDER BY id`).all(threadId);
    check.close();
    if (rows.length > previousCount) {
      assert(rows.at(-1).content === expectedContent, `Unexpected deterministic reply: ${rows.at(-1).content}`);
      return rows.length;
    }
    if (child.exitCode !== null) throw new Error(`API exited while sending: ${childOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for outbound reply. Server output: ${childOutput}`);
};
const threadFor = (senderId) => {
  const read = openDb();
  const row = read.prepare("SELECT id,name,phone,request,customer_id,status FROM instagram_threads WHERE sender_id=?")
    .get(senderId);
  read.close();
  return row;
};
let healthy = false;
try {
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })).ok) { healthy = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, startupDeadline - Date.now()))));
  }
  assert(healthy, `API server did not start (exit=${child.exitCode}, signal=${child.signalCode}): ${childOutput}`);

  const configured = await requestJson("/instagram/manychat/config", { apiToken, bridgeSecret }, adminCookie);
  assert(configured.status === 200, "Synthetic API-mode Manychat credentials should configure");
  const accountId = (await (await fetch(`${baseUrl}/instagram/status`, {
    headers: { Cookie: adminCookie },
  })).json()).accountId;
  assert(typeof accountId === "string" && accountId.startsWith("manychat-"),
    "The isolated API-mode fixture should bind its synthetic page");
  const allocation = openDb();
  const programId = Number(allocation.prepare(`INSERT INTO allocation_programs
    (name,is_default,active,cursor_item_index,cursor_item_used,created_at,updated_at)
    VALUES('Synthetic default',1,1,0,0,?,?)`).run(now, now).lastInsertRowid);
  allocation.prepare(`INSERT INTO allocation_program_items(program_id,salesperson_id,quota,sort_order)
    VALUES(?,1,5,0)`).run(programId);
  allocation.close();
  const seedUnprocessedThread = ({ senderId, name = null, phone = null, request = null }) => {
    const seed = openDb();
    const id = Number(seed.prepare(`INSERT INTO instagram_threads
      (sender_id,name,phone,request,status,created_at,updated_at)
      VALUES(?,?,?,?,'open',?,?)`).run(senderId, name, phone, request, now, now).lastInsertRowid);
    seed.close();
    return id;
  };
  const manualDuplicateThreadId = seedUnprocessedThread({
    senderId: `mc:${accountId}:manual-duplicate`,
    name: "مریم رضایی",
    phone: "09123456789",
    request: "درخواست بررسی برای خرید کالا",
  });
  const manualIncompleteThreadId = seedUnprocessedThread({
    senderId: `mc:${accountId}:manual-incomplete`,
    name: "مینا احمدی",
    phone: "09118887766",
  });
  const manualCompleteThreadId = seedUnprocessedThread({
    senderId: `mc:${accountId}:manual-complete`,
    name: "سارا احمدی",
    phone: "09117776655",
    request: "درخواست مشاوره برای خرید لوازم منزل",
  });
  assert((await inbound("22222222", "قیمت لپتاپ", "price-only")).status === 200,
    "Two-word product-price DMs should be accepted as lead text");
  const priceThread = threadFor(`mc:${accountId}:22222222`);
  assert(priceThread?.name == null && priceThread.request === "قیمت لپتاپ",
    "Ambiguous two-word initial request must not be misclassified as a customer name");

  assert((await inbound("11111111", "سلام", "lead-greeting")).status === 200,
    "Initial greeting should persist as a lead without auto-creating a customer");
  const enabled = await requestJson("/instagram/manychat/autoreply", {
    enabled: true, confirmedLiveDelivery: true,
  }, adminCookie);
  assert(enabled.status === 200, "Staff may enable the paid API-mode test sender after inbound proof");

  let messageCount = 0;
  const promptForName = "برای تکمیل ثبت، لطفاً نام و نام خانوادگی‌تان را بفرمایید.";
  assert((await inbound("11111111", "سلام", "lead-name-prompt")).status === 200,
    "The name-stage message should be ingested");
  messageCount = await waitForOutbound(threadFor(`mc:${accountId}:11111111`).id, messageCount, promptForName);
  assert(threadFor(`mc:${accountId}:11111111`).name == null,
    "A first greeting must not populate the name field");

  const phonePrompt = "برای تکمیل ثبت، لطفاً شماره موبایل ۱۱ رقمی‌تان را بفرمایید.";
  assert((await inbound("11111111", "سارا احمدی", "lead-plain-name")).status === 200,
    "A plain full name following the sent name prompt should be accepted");
  const afterName = threadFor(`mc:${accountId}:11111111`);
  assert(afterName.name === "سارا احمدی" && afterName.request == null,
    "A prompted plain full name populates only the name field");
  messageCount = await waitForOutbound(afterName.id, messageCount, phonePrompt);

  assert((await inbound("11111111", "شماره من ۰۹۱۱۹۹۹۸۸۷۷", "lead-phone")).status === 200,
    "A Persian-digit Iranian mobile should finish identity intake and trigger automatic registration");
  const afterPhone = threadFor(`mc:${accountId}:11111111`);
  assert(afterPhone.phone === "09119998877" && afterPhone.request == null,
    "Mobile digits should be canonicalized without becoming a request");
  assert(afterPhone.customer_id != null,
    "A newly identified Manychat lead is automatically registered without a manual conversion call");
  const autoRegistered = openDb();
  const autoCustomer = autoRegistered.prepare(`SELECT name,phone,description,verification_status,priority,salesperson_id
    FROM customers WHERE id=?`).get(afterPhone.customer_id);
  assert(autoCustomer.name === "سارا احمدی" && autoCustomer.phone === "09119998877" &&
    autoCustomer.description === null && autoCustomer.verification_status === "unverified" &&
    autoCustomer.priority === null && autoCustomer.salesperson_id === 1,
  "Automatic registration creates an unverified customer with default allocation and no fabricated request");
  autoRegistered.close();
  const registrationReply = "ممنون، پیام شما دریافت شد. درباره نام طرح یا پرسش‌تان راهنمایی‌تان می‌کنم.";
  messageCount = await waitForOutbound(afterPhone.id, messageCount, registrationReply);

  const repeatQuestion = "برای این درخواست چه مبلغی نیاز دارید؟";
  assert((await inbound("11111111", "برای خرید لوازم منزل درخواست مشاوره دارم", "lead-request")).status === 200,
    "A post-registration request should begin the existing-customer repeat-request flow");
  const repeatThread = threadFor(`mc:${accountId}:11111111`);
  assert(repeatThread.name === "سارا احمدی" && repeatThread.phone === "09119998877" &&
    repeatThread.request.includes("لوازم منزل") &&
    repeatThread.customer_id === afterPhone.customer_id,
  "A matching existing mobile links the repeat request to the same customer without mutating identity");
  await waitForOutbound(repeatThread.id, messageCount, repeatQuestion);

  const convert = (threadId, body, cookie) => requestJson(`/instagram/threads/${threadId}/convert`, body, cookie);
  const duplicateResult = await convert(manualDuplicateThreadId, {
    name: "مریم رضایی",
    phone: "۰۹۱۲۳۴۵۶۷۸۹",
    request: "درخواست بررسی برای خرید کالا",
    reviewed: true,
  }, registrarCookie);
  assert(duplicateResult.status === 409 && (await duplicateResult.json()).code === "duplicate_mobile",
    "Normalized mobile matches against an existing customer must not link or mutate that customer");
  const incomplete = await convert(manualIncompleteThreadId, {
    name: "مینا احمدی", phone: "09118887766", request: "درخواست راهنمایی برای خرید", reviewed: true,
  }, registrarCookie);
  assert(incomplete.status === 409 && (await incomplete.json()).code === "incomplete_lead",
    "Manual fallback refuses staff-corrected values that are missing from an unprocessed lead");
  const unreviewed = await convert(manualCompleteThreadId, {
    name: "سارا احمدی", phone: "09117776655", request: "درخواست مشاوره برای خرید لوازم منزل", reviewed: false,
  }, registrarCookie);
  assert(unreviewed.status === 400 &&
    (await unreviewed.json()).code === "review_confirmation_required",
  "Conversion requires explicit reviewed=true confirmation");
  assert((await convert(manualCompleteThreadId, {
    name: "سارا احمدی", phone: "09117776655", request: "درخواست مشاوره برای خرید لوازم منزل", reviewed: true,
  })).status === 401, "Anonymous requests cannot convert leads");
  const nonStaff = await convert(manualCompleteThreadId, {
    name: "سارا احمدی", phone: "09117776655", request: "درخواست مشاوره برای خرید لوازم منزل", reviewed: true,
  }, salespersonCookie);
  assert(nonStaff.status === 403 && (await nonStaff.json()).code === "forbidden",
    "Non-staff callers cannot convert leads even when customer creation is otherwise allowed");

  const reviewed = {
    name: "سارا رضایی",
    phone: "۰۹۱۱۷۷۷۶۶۵۵",
    request: "درخواست بررسی برای خرید لوازم منزل",
    reviewed: true,
  };
  const customersBeforeManualCreateDb = openDb();
  const customersBeforeManualCreate = Number(customersBeforeManualCreateDb
    .prepare("SELECT COUNT(*) AS n FROM customers").get().n);
  customersBeforeManualCreateDb.close();
  const created = await convert(manualCompleteThreadId, reviewed, registrarCookie);
  const createdBody = await created.json();
  assert(created.status === 201 && Number.isSafeInteger(createdBody.customerId),
    "Reviewed complete DM should create one CRM customer");
  const afterCreateDb = openDb();
  const customer = afterCreateDb.prepare(`SELECT name,phone,description,verification_status,salesperson_id
    FROM customers WHERE id=?`).get(createdBody.customerId);
  let linked = afterCreateDb.prepare(`SELECT customer_id,status,reviewed_by_user_id,reviewed_at,name,request
    FROM instagram_threads WHERE id=?`).get(manualCompleteThreadId);
  const usedAfterCreate = afterCreateDb.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?")
    .get(programId).cursor_item_used;
  assert(customer?.name === reviewed.name && customer.phone === "09117776655" &&
    customer.description.includes(reviewed.request) && customer.verification_status === "unverified" &&
    customer.salesperson_id === 1,
  "Created CRM customer is unverified, assigned, and retains the reviewed DM request");
  assert(linked.customer_id === createdBody.customerId && linked.status === "converted" &&
    linked.reviewed_by_user_id === 3 && linked.reviewed_at && linked.name === reviewed.name &&
    linked.request === reviewed.request,
  "Thread conversion stores reviewed values and reviewer/time audit");
  assert(Number(afterCreateDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n) ===
    customersBeforeManualCreate + 1,
  "A successful manual fallback adds exactly one customer beyond automatic registrations");
  const privacyBefore = afterCreateDb.prepare(
    "SELECT name,phone,description,verification_status FROM customers WHERE id=1",
  ).get();
  assert(privacyBefore.name === "Synthetic protected customer" && privacyBefore.phone === "09123456789" &&
    privacyBefore.description === "privacy fixture" && privacyBefore.verification_status === "verified",
  "A duplicate phone must leave the pre-existing CRM record unchanged");
  afterCreateDb.close();

  const pause = await requestJson(`/instagram/threads/${manualCompleteThreadId}/pause`, { paused: true }, adminCookie);
  assert(pause.status === 200, "Admin can pause a converted thread without undoing its converted state");
  const pauseCheck = openDb();
  linked = pauseCheck.prepare("SELECT customer_id,status FROM instagram_threads WHERE id=?").get(manualCompleteThreadId);
  pauseCheck.close();
  assert(linked.customer_id === createdBody.customerId && linked.status === "converted",
    "Operational pause updates preserve converted status");
  const emulateLegacyOperationalStatus = openDb();
  emulateLegacyOperationalStatus.prepare(
    "UPDATE instagram_threads SET status='needs_human' WHERE id=?",
  ).run(manualCompleteThreadId);
  emulateLegacyOperationalStatus.close();
  const idempotent = await convert(manualCompleteThreadId, reviewed, registrarCookie);
  assert(idempotent.status === 200 && (await idempotent.json()).alreadyConverted === true,
    "customer_id is authoritative for repeat conversion after operational status changes");
  const idempotencyCheck = openDb();
  assert(idempotencyCheck.prepare("SELECT status FROM instagram_threads WHERE id=?").get(manualCompleteThreadId).status === "converted" &&
    Number(idempotencyCheck.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === customersBeforeManualCreate + 1 &&
    idempotencyCheck.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?").get(programId).cursor_item_used === usedAfterCreate,
  "Idempotent manual retries repair the linked thread without creating a customer or advancing assignment");
  idempotencyCheck.close();

  const noProgramDb = openDb();
  const noProgramThreadId = Number(noProgramDb.prepare(`INSERT INTO instagram_threads
    (sender_id,name,phone,request,status,created_at,updated_at)
    VALUES(?,'آرش کریمی','09133333333','درخواست مشاوره برای خرید خودرو','open',?,?)`)
    .run(`mc:${accountId}:44444444`, now, now).lastInsertRowid);
  noProgramDb.prepare("DELETE FROM allocation_program_items WHERE program_id=?").run(programId);
  const customerCountBeforeRollback = Number(noProgramDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n);
  const cursorBeforeRollback = noProgramDb.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?")
    .get(programId).cursor_item_used;
  noProgramDb.close();
  const noAllocation = await convert(noProgramThreadId, {
    name: "آرش کریمی", phone: "09133333333",
    request: "درخواست مشاوره برای خرید خودرو", reviewed: true,
  }, registrarCookie);
  assert(noAllocation.status === 409 && (await noAllocation.json()).code === "allocation_program_unavailable",
    "Missing/empty default allocation program must reject conversion");
  const rollback = openDb();
  assert(Number(rollback.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === customerCountBeforeRollback &&
    rollback.prepare("SELECT customer_id,status,reviewed_by_user_id FROM instagram_threads WHERE id=?")
      .get(noProgramThreadId).customer_id == null &&
    rollback.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?").get(programId).cursor_item_used === cursorBeforeRollback,
  "Failed allocation rolls back customer creation, thread link/audit, and cursor movement");
  rollback.close();
  console.log("Instagram Manychat API-mode conversion fixture passed");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await rm(tempRoot, { recursive: true, force: true });
}
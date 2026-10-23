import { createCipheriv, createHmac, randomBytes } from "node:crypto";
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
const FIXED_TRUST_REPLY = "مجموعه گروه مالی نفیس ۷ سال فعال است و به بیش از ۱۵ هزار مشتری خدمات داده است. شعار ما «خوش‌قولیم و مدارکتون پیش ما جاش امنه» است؛ پشتوانه مالی قدرتمندی داریم و نیازها را سریع رفع می‌کنیم.";
const normalizePersianDigits = (value) => value
  .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
const assertPublicPlanReply = (reply, fields = [
  "customerPayout", "installments", "customerDocuments", "guarantorDocuments",
]) => {
  assert(typeof reply === "string" && reply.includes("طرح: Synthetic Public Loan"),
    "Advice is rendered from the selected synthetic public plan");
  const normalized = normalizePersianDigits(reply).replace(/[٬,\s]/g, "");
  const expected = {
    customerPayout: normalized.includes("90000000تومان"),
    installments: normalized.includes("12قسط") &&
      reply.includes("مبلغ هر قسط در اطلاعات این طرح مشخص نشده"),
    customerDocuments: reply.includes("مدارک مشتری: مدرک شغلی."),
    guarantorDocuments: reply.includes("مدارک ضامن: اطلاعات این طرح در دسترس نیست"),
  };
  for (const field of fields) assert(expected[field], `Rendered reply includes only requested known field ${field}`);
  for (const field of Object.keys(expected).filter((item) => !fields.includes(item))) {
    if (field === "customerPayout") assert(!normalized.includes("90000000تومان"),
      "Unrequested customer payout is omitted");
    if (field === "installments") assert(!reply.includes("تعداد اقساط") && !reply.includes(" قسط"),
      "Unrequested installment details are omitted");
    if (field === "customerDocuments") assert(!reply.includes("مدارک مشتری:"),
      "Unrequested customer documents are omitted");
    if (field === "guarantorDocuments") assert(!reply.includes("مدارک ضامن:"),
      "Unrequested guarantor documents are omitted");
  }
  for (const forbidden of [
    "SYNTHETIC_", "Synthetic Bank", "Synthetic Platform", "PRIVATE_INTEREST_MARKER",
    "Synthetic Private Job", "fixture_internal_document_id", "guarantee_check",
    "75", "۷۵", "%", "درصد", "بانک", "سود", "بهره",
    "نرخ", "رتبه اعتباری", "اعتبار", "Gemini", "OpenAI", "Manychat", "provider",
    "credit", "rank", "Synthetic Bank promises", "provider details",
  ]) assert(!reply.includes(forbidden), `Reply must not contain model markers or forbidden context: ${forbidden}`);
};
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-instagram-fixture-"));
const databasePath = path.join(tempRoot, "crm.db");
const db = new DatabaseSync(databasePath);
const sessionSecret = "instagram-fixture-session-secret";
const tokenEncryptionKeyBase64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const tokenEncryptionKey = Buffer.from(tokenEncryptionKeyBase64, "base64");
const previousTokenEncryptionKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32));
const previousTokenEncryptionKeyBase64 = previousTokenEncryptionKey.toString("base64");
const now = new Date().toISOString();
// Build an isolated database from synthetic pre-migration tables and records.
// Never read or copy any attached_assets, development, or production database.
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
  CREATE TABLE reminders(
    id INTEGER PRIMARY KEY,user_id INTEGER,done INTEGER,remind_at TEXT,message TEXT,created_at TEXT
  );
  CREATE TABLE consultation_forms(
    id INTEGER PRIMARY KEY,customer_id INTEGER,requested_amount TEXT,updated_at TEXT
  );
  CREATE TABLE loan_applications(
    id INTEGER PRIMARY KEY,consultation_id INTEGER,customer_id INTEGER,requested_by_user_id INTEGER,
    plan_ids TEXT,plan_id INTEGER,requested_amount TEXT,status TEXT,notes TEXT,created_at TEXT
  );
  CREATE TABLE loan_plans(
    id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER DEFAULT 1,principal_amount TEXT,
    installment_terms TEXT,required_documents TEXT,bank_name TEXT,platform_name TEXT,
    annual_interest TEXT,installments TEXT,deposit_percents TEXT,customer_jobs TEXT,
    needs_guarantor INTEGER,notes TEXT,template_id TEXT
  );
  CREATE TABLE loan_plan_conditions(
    id INTEGER PRIMARY KEY,plan_id INTEGER,installment_options TEXT,customer_jobs TEXT,
    collateral_type TEXT,guarantor_jobs TEXT,max_principal TEXT,customer_ranks TEXT,
    needs_guarantor INTEGER,guarantor_ranks TEXT,guarantor_collateral_type TEXT,sort_order INTEGER
  );
  CREATE TABLE consult_options(
    id INTEGER PRIMARY KEY,field_key TEXT NOT NULL,option_value TEXT NOT NULL,label_fa TEXT NOT NULL,
    sort_order INTEGER,active INTEGER,UNIQUE(field_key,option_value)
  );
  CREATE TABLE auth_sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version, applied_at)
    VALUES ('customer-portal-loan-actor-provenance-v1', CURRENT_TIMESTAMP),
           ('customer-portal-stage-history-actor-v1', CURRENT_TIMESTAMP);
`);
db.prepare("INSERT INTO salespersons(id,name,active) VALUES(1,'Synthetic fixture salesperson',1)").run();
db.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active,created_at,salesperson_id)
  VALUES(1,'synthetic-admin','not-used','Synthetic Admin','admin',1,?,NULL),
        (2,'synthetic-salesperson','not-used','Synthetic Salesperson','salesperson',1,?,1),
        (3,'synthetic-registrar','not-used','Synthetic Registrar','registrar',1,?,NULL),
        (4,'synthetic-admin-two','not-used','Synthetic Admin Two','admin',1,?,NULL)`)
  .run(now, now, now, now);
const users = [
  { id: 1, role: "admin" },
  { id: 2, role: "salesperson" },
  { id: 3, role: "registrar" },
  { id: 4, role: "admin" },
];
const tokens = new Map();
for (const user of users) {
  const token = randomBytes(24).toString("base64url");
  tokens.set(user.id, token);
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", sessionSecret).update(token).digest("hex"),
    user.id,
    new Date(Date.now() + 600_000).toISOString(),
    now,
  );
}
const phone = "09123456789";
db.prepare(`INSERT INTO customers(name,phone,description,verification_status,created_at,status)
  VALUES('Synthetic existing CRM record',?,'must remain untouched','verified',?,'in_progress')`).run(phone, now);
db.close();

const modelStartWaiters = new Map();
const probe = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/ai-started") {
    const marker = url.searchParams.get("marker");
    modelStartWaiters.get(marker)?.();
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const controlPort = probe.address().port;
const apiPortProbe = createServer();
await new Promise((resolve) => apiPortProbe.listen(0, "127.0.0.1", resolve));
const port = apiPortProbe.address().port;
await new Promise((resolve) => apiPortProbe.close(resolve));
const withoutGeminiProvider = (environment) => {
  const isolatedEnvironment = { ...environment };
  delete isolatedEnvironment.GEMINI_API_KEY;
  delete isolatedEnvironment.GEMINI_MODEL;
  return isolatedEnvironment;
};
const child = spawn(process.execPath, [
  ...(process.env.TEST_MANYCHAT === "1" ? ["--import", "./scripts/manychat-fetch-mock.mjs"] : []),
  "--enable-source-maps", "dist/index.mjs",
], {
  cwd: process.cwd(),
  env: withoutGeminiProvider({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "test",
    PORT: String(port),
    CRM_DATABASE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    IG_APP_SECRET: "synthetic-instagram-app-secret",
    IG_VERIFY_TOKEN: "synthetic-verify-token",
    IG_ACCOUNT_ID: "111222333",
    IG_TOKEN_ENCRYPTION_KEY: tokenEncryptionKeyBase64,
    IG_AUTOREPLY_ENABLED: "1",
    MANYCHAT_ACCOUNT_ID: "synthetic-account",
    MANYCHAT_BRIDGE_SECRET: "synthetic-bridge-secret-for-tests-only",
    MANYCHAT_API_TOKEN: "synthetic-token-for-tests-only",
    MANYCHAT_AUTOREPLY_ENABLED: "0",
    AI_INTEGRATIONS_OPENAI_BASE_URL: "http://synthetic-openai.invalid/v1",
    AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
    INSTAGRAM_AI_TIMEOUT_MS: "1500",
    INSTAGRAM_FIXTURE_NOTIFY_URL: `http://127.0.0.1:${controlPort}/ai-started`,
  }),
  stdio: ["ignore", "pipe", "pipe"],
});
let oauthChild;
let childLogs = "";
const appendChildLog = (chunk) => {
  childLogs = `${childLogs}${chunk.toString()}`.slice(-20_000);
};
child.stdout.on("data", appendChildLog);
child.stderr.on("data", appendChildLog);
let childSpawnError = null;
child.on("error", (error) => {
  childSpawnError = error;
  appendChildLog(`\nChild process spawn error: ${error.message}\n`);
});
const baseUrl = `http://127.0.0.1:${port}`;
const cookie = `crm_session=${tokens.get(1)}`;
const registrarCookie = `crm_session=${tokens.get(3)}`;
const otherAdminCookie = `crm_session=${tokens.get(4)}`;
const purposeHash = (purpose, value) =>
  createHmac("sha256", sessionSecret).update(`${purpose}\0${value}`).digest("hex");
const postSigned = async (payload) => {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", "synthetic-instagram-app-secret").update(body).digest("hex");
  return fetch(`${baseUrl}/api/instagram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${signature}` },
    body,
  });
};
const postMessage = (senderId, mid, text, isEcho = false) => postSigned({
  object: "instagram",
  entry: [{
    id: "111222333",
    messaging: [{
      sender: { id: senderId },
      recipient: { id: "111222333" },
      timestamp: Date.now(),
      message: { mid, text, ...(isEcho ? { is_echo: true } : {}) },
    }],
  }],
});
try {
  let healthy = false;
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null || childSpawnError) break;
    try {
      if ((await fetch(`${baseUrl}/api/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, startupDeadline - Date.now()))));
  }
  assert(healthy,
    `API server did not start on port ${port} (exit=${child.exitCode}, signal=${child.signalCode}). Child process output:\n${childLogs || "(no stdout/stderr captured)"}`);
  let defaultProgramId = null;
  const ensureDefaultAllocation = () => {
    if (defaultProgramId != null) return defaultProgramId;
    const setupDb = new DatabaseSync(databasePath);
    defaultProgramId = Number(setupDb.prepare(`INSERT INTO allocation_programs
      (name,is_default,active,cursor_item_index,cursor_item_used,created_at,updated_at)
      VALUES('Synthetic default',1,1,0,0,?,?)`).run(now, now).lastInsertRowid);
    setupDb.prepare(`INSERT INTO allocation_program_items(program_id,salesperson_id,quota,sort_order)
      VALUES(?,1,100,0)`).run(defaultProgramId);
    setupDb.close();
    return defaultProgramId;
  };
  const seedUnprocessedThread = ({ senderId, name = null, phone = null, request = null }) => {
    const seed = new DatabaseSync(databasePath);
    const id = Number(seed.prepare(`INSERT INTO instagram_threads
      (sender_id,name,phone,request,status,created_at,updated_at)
      VALUES(?,?,?,?,'open',?,?)`).run(senderId, name, phone, request, now, now).lastInsertRowid);
    seed.close();
    return id;
  };

  if (process.env.TEST_MANYCHAT === "1") {
    const inbound = (headers, body) => fetch(`${baseUrl}/api/manychat/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const sample = { subscriberId: "123456789", text: "سلام، من دنبال وام هستم", messageId: "synthetic-event-1" };
    assert((await inbound({}, sample)).status === 401, "Unauthenticated bridge requests must fail");
    assert((await inbound({ "X-CRM-Bridge-Secret": "incorrect" }, sample)).status === 401, "Wrong bridge secret must fail");
    const auth = { "X-CRM-Bridge-Secret": "synthetic-bridge-secret-for-tests-only" };
    assert((await inbound(auth, { ...sample, subscriberId: "0" })).status === 400, "Invalid contact must fail");
    assert((await inbound(auth, { ...sample, text: "" })).status === 400, "Empty message must fail");
    const first = await inbound(auth, sample);
    assert(first.status === 200 && (await first.json()).status === "accepted", "First DM must be stored");
    const retry = await inbound(auth, sample);
    assert(retry.status === 200 && (await retry.json()).status === "duplicate", "Provider retry must be idempotent");
    const second = await inbound(auth, { ...sample, messageId: "synthetic-event-2", text: "نام من سارا احمدی است" });
    assert(second.status === 200 && (await second.json()).status === "accepted", "A second DM must be stored");
    const repeated = { subscriberId: sample.subscriberId, text: sample.text };
    assert((await inbound(auth, repeated)).status === 200 &&
      (await inbound(auth, repeated)).status === 200, "Repeated text without a message ID must still be accepted");
    const status = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(status.configured && !status.enabled && status.connected, "Admin must see tested but disabled bridge");
    assert(!JSON.stringify(status).includes("synthetic-token-for-tests-only"), "Never expose API credentials");
    const registrarStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: registrarCookie } }).then((r) => r.json());
    assert(!("accountId" in registrarStatus), "Registrar must not see the account identifier");
    const threads = await fetch(`${baseUrl}/api/instagram/threads`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(threads.length === 1 && threads[0].name === "سارا احمدی" &&
      threads[0].senderId === "mc:synthetic-account:123456789", "DM lead must stay separate from CRM customers");
    const messages = await fetch(`${baseUrl}/api/instagram/threads/${threads[0].id}/messages`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(messages.length === 4 && messages.every((item) => item.direction === "inbound"), "Repeated genuine DMs must not be discarded");
    const queueDb = new DatabaseSync(databasePath);
    assert(queueDb.prepare(`SELECT count(*) AS n FROM instagram_send_queue
      WHERE state IN ('pending','processing')`).get().n === 0 &&
      queueDb.prepare("SELECT count(*) AS n FROM instagram_messages WHERE direction='outbound'").get().n === 0,
    "Disabled automation may retain failed identity work but must not queue or send an automatic reply");
    queueDb.close();
    const direct = await fetch(`${baseUrl}/api/instagram/connect/start`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
    });
    assert(direct.status === 410, "Direct Meta-app onboarding must remain disabled");
    const adminPost = (path, body, authCookie = cookie) => fetch(`${baseUrl}/api/instagram/manychat/${path}`, {
      method: "POST", headers: { Cookie: authCookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const waitForModelStart = (marker) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        modelStartWaiters.delete(marker);
        reject(new Error(`Synthetic model request did not start for ${marker}. Server output: ${childLogs}`));
      }, 8_000);
      modelStartWaiters.set(marker, () => {
        clearTimeout(timer);
        modelStartWaiters.delete(marker);
        resolve();
      });
    });
    const apiThreadId = (subscriberId) => {
      const checkDb = new DatabaseSync(databasePath);
      const row = checkDb.prepare("SELECT id FROM instagram_threads WHERE sender_id LIKE ?").get(`%:${subscriberId}`);
      checkDb.close();
      if (!row) throw new Error(`Synthetic API thread missing: ${subscriberId}`);
      return row.id;
    };
    const makeApiJobDue = (subscriberId) => {
      const checkDb = new DatabaseSync(databasePath);
      checkDb.exec("PRAGMA busy_timeout=2000");
      const threadId = apiThreadId(subscriberId);
      const old = new Date(Date.now() - 20_000).toISOString();
      checkDb.prepare("UPDATE instagram_threads SET last_message_at=? WHERE id=?").run(old, threadId);
      checkDb.prepare("UPDATE instagram_send_queue SET due_at=? WHERE thread_id=? AND state='pending'").run(old, threadId);
      checkDb.prepare("UPDATE instagram_send_state SET last_sent_at=? WHERE id=1").run(old);
      checkDb.close();
      return threadId;
    };
    const waitForQueueState = async (subscriberId, expectedState, timeoutMs = 8_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const checkDb = new DatabaseSync(databasePath);
        checkDb.exec("PRAGMA busy_timeout=2000");
        const row = checkDb.prepare(
          `SELECT q.state, q.error, t.error AS thread_error FROM instagram_send_queue q
             JOIN instagram_threads t ON t.id=q.thread_id WHERE t.sender_id LIKE ?`,
        ).get(`%:${subscriberId}`);
        checkDb.close();
        if (row?.state === expectedState) return row;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Synthetic API queue ${subscriberId} did not reach ${expectedState}`);
    };
    const waitForSafeLogReason = async (reason, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (childLogs.includes(reason)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return childLogs.includes(reason);
    };
    const apiDm = (authHeaders, subscriberId, marker) => inbound(authHeaders, {
      subscriberId,
      text: `درباره شرایط وام راهنمایی می‌خواهم ${marker}`,
      messageId: `ai-${marker.toLowerCase()}`,
    });
    const newCredentials = {
      apiToken: "synthetic-valid-manychat-api-token",
      bridgeSecret: "synthetic-new-bridge-secret-for-fixture",
    };
    assert((await adminPost("config", newCredentials, registrarCookie)).status === 403, "Only admins may save credentials");
    assert((await adminPost("config", { ...newCredentials, apiToken: "synthetic-invalid-token" })).status === 400,
      "Rejected provider tokens must not be stored");
    const saved = await adminPost("config", newCredentials);
    assert(saved.status === 200 && (await saved.json()).enabled === false, "Verified credentials must save with automation off");
    const storedDb = new DatabaseSync(databasePath);
    const stored = storedDb.prepare("SELECT * FROM manychat_connections WHERE id=1").get();
    assert(stored && !JSON.stringify(stored).includes(newCredentials.apiToken) &&
      !JSON.stringify(stored).includes(newCredentials.bridgeSecret), "Database must contain encrypted credentials only");
    storedDb.close();
    const savedStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(savedStatus.source === "database" && savedStatus.configured && !savedStatus.connected && !savedStatus.enabled,
      "Saving credentials is not proof of an Instagram DM");
    assert(!JSON.stringify(savedStatus).includes(newCredentials.apiToken), "Status must not expose secrets");
    assert((await adminPost("autoreply", { enabled: true })).status === 409, "No auto reply before a DM arrives");
    assert((await adminPost("check", {})).status === 200, "Stored token can be checked again");
    assert((await inbound(auth, { subscriberId: "987654321", text: "سلام" })).status === 401,
      "Previous bridge secret must stop working after replacement");
    const newAuth = { "X-CRM-Bridge-Secret": newCredentials.bridgeSecret };
    const newInbound = await inbound(newAuth, { subscriberId: "987654321", text: "سلام، مشاوره می‌خواهم" });
    assert(newInbound.status === 200 && (await newInbound.json()).status === "accepted",
      "A real inbound route must accept the newly stored secret");
    const receivedStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(receivedStatus.connected && !receivedStatus.enabled, "Test DM must confirm inbound without enabling sends");
    assert((await adminPost("autoreply", { enabled: true })).status === 400, "Enablement needs explicit live delivery confirmation");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Admin can enable after inbound and explicit confirmation");
    assert((await adminPost("autoreply", { enabled: false })).status === 200, "Admin can disable automation");
    const pendingEnable = adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert((await adminPost("autoreply", { enabled: false })).status === 200, "Disable must succeed while token check is in progress");
    assert((await pendingEnable).status === 409, "An older in-flight enable must not undo a newer disable");
    const disabledStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(!disabledStatus.enabled, "Automation must remain disabled after the race");

    // Instagram-only accounts may successfully authenticate with a null page ID.
    // Bind by credential identity, never by the shared null ID or display name.
    const nullPageCredentials = {
      apiToken: "synthetic-null-page-manychat-token-a",
      bridgeSecret: "synthetic-null-page-bridge-secret",
    };
    const bindingDb = new DatabaseSync(databasePath);
    try {
      assert((await adminPost("config", nullPageCredentials)).status === 200,
        "A successful account response with explicit null ID must be accepted");
      const firstBinding = bindingDb.prepare("SELECT * FROM manychat_connections WHERE id=1").get();
      assert(firstBinding.provider_page_id.startsWith("token-binding-") && firstBinding.enabled === 0,
        "Null page ID must use an isolated binding and keep automatic replies off");
      assert(!JSON.stringify(firstBinding).includes(nullPageCredentials.apiToken),
        "Null-ID binding must not expose its token in the database");
      assert((await adminPost("check", {})).status === 200,
        "Null-ID credentials must also pass the stored-token recheck");
      assert((await adminPost("config", { ...nullPageCredentials,
        apiToken: ` Bearer ${nullPageCredentials.apiToken} ` })).status === 200,
        "Pasted Swagger Bearer prefix must be normalized before verification and storage");
      const sameBinding = bindingDb.prepare("SELECT account_id FROM manychat_connections WHERE id=1").get();
      assert(sameBinding.account_id === firstBinding.account_id,
        "Same token with a Bearer prefix must retain the same account binding");
      assert((await adminPost("check", {})).status === 200,
        "Normalized token must remain valid after encrypted storage");
      assert((await inbound(newAuth, {})).status === 401,
        "Previously stored bridge secret must remain invalid after replacement");
      assert((await inbound({ "X-CRM-Bridge-Secret": nullPageCredentials.bridgeSecret }, {})).status === 400,
        "New bridge secret authenticates independently of Public API token; empty body is rejected");
      assert((await adminPost("config", { ...nullPageCredentials,
        apiToken: "synthetic-null-page-manychat-token-b" })).status === 200,
        "Another valid null-ID token can be configured");
      const rotatedBinding = bindingDb.prepare("SELECT account_id FROM manychat_connections WHERE id=1").get();
      assert(rotatedBinding.account_id !== firstBinding.account_id,
        "Different null-ID tokens must never share one historical inbox binding");
      assert((await adminPost("config", { ...nullPageCredentials,
        apiToken: "synthetic-missing-page-manychat-token" })).status === 400,
        "Malformed provider response missing ID entirely must not be accepted");
      assert(bindingDb.prepare("SELECT account_id FROM manychat_connections WHERE id=1").get().account_id === rotatedBinding.account_id,
        "Rejected provider payload must not overwrite working credentials");
    } finally {
      bindingDb.close();
    }

    const privateContextDb = new DatabaseSync(databasePath);
    privateContextDb.prepare(`INSERT INTO loan_plans
      (id,name,active,principal_amount,installment_terms,deposit_percents,bank_name,platform_name,
       annual_interest,installments,required_documents,customer_jobs,needs_guarantor,notes,template_id)
      VALUES(1,'Synthetic Public Loan',1,'120000000','[{"installments":"۱۲","depositPercent":"75"}]',
       '{"6":"50","12":"75"}','Synthetic Bank','Synthetic Platform','PRIVATE_INTEREST_MARKER',
       '12','["employment_proof"]',
       'Synthetic Private Job fixture_internal_document_id',0,'Synthetic Internal Note','synthetic-template-id')`).run();
    privateContextDb.prepare(`INSERT INTO loan_plan_conditions
      (id,plan_id,max_principal,customer_ranks,installment_options,customer_jobs,collateral_type,
       needs_guarantor,guarantor_ranks,guarantor_jobs,guarantor_collateral_type)
      VALUES(1,1,'120000000','A','12','آزاد','چک',0,'A','آزاد','ندارد')`).run();
    privateContextDb.close();
    const nullPageAuth = { "X-CRM-Bridge-Secret": nullPageCredentials.bridgeSecret };
    const intakeStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(intakeStatus.replyMode === "intake", "Reply mode defaults to intake independently of the provider mode");
    assert((await adminPost("reply-mode", { replyMode: "ai" }, registrarCookie)).status === 403,
      "Only admins may change the reply mode");
    assert((await adminPost("reply-mode", { replyMode: "automatic" })).status === 400,
      "Reply mode accepts only intake or ai");
    assert((await (await adminPost("reply-mode", { replyMode: "ai" })).json()).replyMode === "ai",
      "Administrator can select AI without implicitly enabling replies");
    const aiProof = await inbound(nullPageAuth, {
      subscriberId: "424242424", text: "Synthetic test DM for AI mode proof", messageId: "ai-proof",
    });
    assert(aiProof.status === 200, "A synthetic DM can satisfy the existing enablement proof");
    const aiLead = await inbound(nullPageAuth, {
      subscriberId: "424242424",
      text: "من سارا احمدی هستم و شماره‌ام 09122223333؛ برای خرید لوازم منزل درخواست مشاوره دارم",
      messageId: "ai-lead-context",
    });
    assert(aiLead.status === 200, "Synthetic identity and request can be captured before AI advice is enabled");
    const registeredApiLeadId = apiThreadId("424242424");
    const registeredApiLeadDb = new DatabaseSync(databasePath);
    registeredApiLeadDb.exec("PRAGMA busy_timeout=3000");
    const registeredApiLead = registeredApiLeadDb.prepare(`SELECT t.name,t.phone,t.request,t.customer_id,
      s.state,s.error FROM instagram_threads t
      LEFT JOIN instagram_crm_automation_sessions s ON s.thread_id=t.id
      WHERE t.id=? ORDER BY s.id DESC LIMIT 1`).get(registeredApiLeadId);
    assert(registeredApiLead.name === "سارا احمدی" && registeredApiLead.phone === "09122223333" &&
      registeredApiLead.request?.includes("لوازم منزل") && registeredApiLead.customer_id == null &&
      registeredApiLead.state === "registration_retry" &&
      registeredApiLead.error === "ALLOCATION_PROGRAM_UNAVAILABLE",
    "Without a default allocation, automatic registration is durably deferred while captured identity and AI context remain available");
    registeredApiLeadDb.close();
    const aiEnabled = await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true });
    assert(aiEnabled.status === 200, "AI mode still requires the existing explicit enablement confirmation");

    const makeAiApiJob = async (subscriberId, marker) => {
      const started = waitForModelStart(marker);
      const accepted = await apiDm(nullPageAuth, subscriberId, marker);
      assert(accepted.status === 200, `Synthetic ${marker} DM must be accepted`);
      const threadId = makeApiJobDue(subscriberId);
      await started;
      return threadId;
    };
    let apiThread = await makeAiApiJob("424242424", "SYNTHETIC_AI_API_SUCCESS");
    const sentAiApi = await waitForQueueState("424242424", "sent");
    assert(!sentAiApi.thread_error, "A successful AI answer must not leave a staff preparation error");
    let apiDb = new DatabaseSync(databasePath);
    const apiLead = apiDb.prepare("SELECT name,phone,request,customer_id FROM instagram_threads WHERE id=?")
      .get(registeredApiLeadId);
    const apiAnswer = apiDb.prepare(
      "SELECT content FROM instagram_messages WHERE thread_id=? AND direction='outbound' ORDER BY id DESC LIMIT 1",
    ).get(apiThread)?.content;
    assert(apiLead.name === "سارا احمدی" && apiLead.phone === "09122223333" &&
      apiLead.request && apiLead.customer_id == null,
    "AI advice remains available with captured identity while unavailable allocation durably defers registration");
    assertPublicPlanReply(apiAnswer);
    assert(!apiAnswer.includes("SYNTHETIC_AI_API_SUCCESS"),
      "API mode does not echo request selectors into the final reply");
    assert(Buffer.byteLength(apiAnswer ?? "", "utf8") <= 900,
      "API mode delivers deterministic public-plan advice below the configured byte limit");
    apiDb.close();

    const outboundReplies = (threadId) => {
      const checkDb = new DatabaseSync(databasePath);
      const replies = checkDb.prepare(
        "SELECT content FROM instagram_messages WHERE thread_id=? AND direction='outbound' ORDER BY id",
      ).all(threadId);
      checkDb.close();
      return replies.map((reply) => reply.content);
    };
    const guidanceStarted = waitForModelStart("SYNTHETIC_OFFTOPIC");
    const guidanceAccepted = await inbound(nullPageAuth, {
      subscriberId: "424000002",
      text: "هوا امروز چطور است؟ SYNTHETIC_OFFTOPIC",
      messageId: "ai-offtopic-guidance",
    });
    assert(guidanceAccepted.status === 200, "An off-topic message is accepted for a loan-domain redirect");
    const guidanceThread = makeApiJobDue("424000002");
    await guidanceStarted;
    await waitForQueueState("424000002", "sent");
    const guidanceDb = new DatabaseSync(databasePath);
    const guidanceFields = guidanceDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field
      FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(guidanceThread);
    guidanceDb.close();
    const guidanceReplies = outboundReplies(guidanceThread);
    assert(guidanceReplies.length === 1 &&
      guidanceReplies[0].includes("طرح‌های وام") &&
      guidanceReplies[0].includes("دریافتی خالص") &&
      guidanceReplies[0].includes("اقساط ثبت‌شده") &&
      guidanceReplies[0].includes("مدارک") &&
      !guidanceReplies[0].includes("برای تکمیل ثبت") &&
      !guidanceReplies[0].includes("SYNTHETIC_OFFTOPIC"),
    "A structured redirect is delivered once with permitted topics and no intake suffix or selector echo");
    assert(guidanceFields.requested_field === null && guidanceFields.queued_field === null,
      "A clarification or redirect must not commit an unsent intake field");

    const trustStarted = waitForModelStart("SYNTHETIC_TRUST");
    assert((await inbound(nullPageAuth, {
      subscriberId: "424000004",
      text: "آیا این مجموعه قابل اعتماد است؟ SYNTHETIC_TRUST",
      messageId: "ai-trust-copy",
    })).status === 200, "A brand-trust question is accepted for the fixed-copy selector");
    const trustThread = makeApiJobDue("424000004");
    await trustStarted;
    await waitForQueueState("424000004", "sent");
    const trustReplies = outboundReplies(trustThread);
    assert(trustReplies.length === 1 && trustReplies[0] === FIXED_TRUST_REPLY,
      "API trust selection renders only the fixed approved brand copy");

    assert((await inbound(nullPageAuth, {
      subscriberId: "424000003",
      text: "سلام",
      messageId: "ai-exact-greeting",
    })).status === 200, "A genuine greeting is accepted");
    const greetingThread = makeApiJobDue("424000003");
    await waitForQueueState("424000003", "sent");
    const greetingReplies = outboundReplies(greetingThread);
    const greetingDb = new DatabaseSync(databasePath);
    const greetingFields = greetingDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field
      FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(greetingThread);
    greetingDb.close();
    assert(greetingReplies.length === 1 &&
      greetingReplies[0].startsWith("سلام!") &&
      greetingReplies[0].includes("گروه مالی نفیس") &&
      greetingReplies[0].includes("۷ سال است که فعالیت می‌کند") &&
      greetingReplies[0].includes("بیش از ۱۵ هزار مشتری") &&
      greetingReplies[0].includes("خوش‌قولیم و مدارکتون پیش ما جاش امنه") &&
      greetingReplies[0].includes("نام کدام طرح") &&
      !greetingReplies[0].includes("برای تکمیل ثبت") &&
      !greetingReplies[0].includes("شماره موبایل"),
    "An exact greeting receives the approved brand introduction and a plan question without an intake suffix");
    assert(greetingFields.requested_field === null && greetingFields.queued_field === null,
      "A deterministic greeting redirect must not request a missing intake field");

    const nameModelStarted = waitForModelStart("SYNTHETIC_NAME_MARKER");
    const nameSendStarted = waitForModelStart("API_SEND:SYNTHETIC_NAME_MARKER");
    const nameMarkerInbound = await inbound(nullPageAuth, {
      subscriberId: "424000001",
      text: "برای دریافت مشاوره درباره شرایط وام راهنمایی می‌خواهم SYNTHETIC_NAME_MARKER",
      messageId: "ai-name-marker",
    });
    assert(nameMarkerInbound.status === 200, "A synthetic lead without a name is accepted");
    const apiNameThread = makeApiJobDue("424000001");
    await nameModelStarted;
    let markerDb = new DatabaseSync(databasePath);
    let apiNameState = markerDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field, q.state
      FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(apiNameThread);
    assert(apiNameState.requested_field === null && apiNameState.queued_field === null,
      "Ordinary AI advice does not stage an identity prompt while the model is preparing");
    markerDb.close();
    await nameSendStarted;
    markerDb = new DatabaseSync(databasePath);
    apiNameState = markerDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field, q.state
      FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(apiNameThread);
    assert(apiNameState.requested_field === null && apiNameState.queued_field === null &&
      apiNameState.state === "sending",
    "The ordinary AI advice send stays free of name/phone intake markers");
    markerDb.close();
    await waitForQueueState("424000001", "sent");
    markerDb = new DatabaseSync(databasePath);
    apiNameState = markerDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field
      FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(apiNameThread);
    const apiNameAdviceReplies = outboundReplies(apiNameThread);
    assert(apiNameState.requested_field === null && apiNameState.queued_field === null &&
      apiNameAdviceReplies.length > 0 && apiNameAdviceReplies.every((reply) =>
        !reply.includes("نام و نام خانوادگی") && !reply.includes("شماره موبایل")),
    "A confirmed ordinary API advice send never asks for or commits identity fields");
    markerDb.close();
    const plainNameAccepted = await inbound(nullPageAuth, {
      subscriberId: "424000001", text: "مريم  يوسفي", messageId: "ai-plain-full-name",
    });
    assert(plainNameAccepted.status === 200, "A standalone full name is accepted without an identity prompt");
    markerDb = new DatabaseSync(databasePath);
    let capturedName = markerDb.prepare("SELECT name,requested_field FROM instagram_threads WHERE id=?").get(apiNameThread);
    let sensitiveNameMessage = markerDb.prepare(
      "SELECT sensitive_name FROM instagram_messages WHERE mid LIKE '%:ai-plain-full-name'",
    ).get();
    assert(capturedName.name === "مریم یوسفی" && capturedName.requested_field === null &&
      sensitiveNameMessage?.sensitive_name === 1,
    `A standalone name is normalized and redacted at rest for model context without an identity prompt: ${JSON.stringify({ capturedName, sensitiveNameMessage })}`);
    markerDb.close();
    const correctedNameAccepted = await inbound(nullPageAuth, {
      subscriberId: "424000001",
      text: "نامم را به ا\u0653رش  كريمي اصلاح کنید",
      messageId: "ai-corrected-name",
    });
    assert(correctedNameAccepted.status === 200, "A corrected name with decomposed Persian and Arabic variants is accepted");
    markerDb = new DatabaseSync(databasePath);
    capturedName = markerDb.prepare("SELECT name,requested_field FROM instagram_threads WHERE id=?").get(apiNameThread);
    sensitiveNameMessage = markerDb.prepare(
      "SELECT sensitive_name FROM instagram_messages WHERE mid LIKE '%:ai-corrected-name'",
    ).get();
    assert(capturedName.name === "آرش کریمی" && capturedName.requested_field === null &&
      sensitiveNameMessage?.sensitive_name === 1,
    `Corrected names normalize NFC, Arabic letters, and spacing while marking the inbound name as sensitive: ${JSON.stringify({ capturedName, sensitiveNameMessage })}`);
    markerDb.close();
    const redactionStarted = waitForModelStart("SYNTHETIC_NAME_REDACTION");
    assert((await inbound(nullPageAuth, {
      subscriberId: "424000001",
      text: "درباره شرایط طرح‌ها راهنمایی می‌خواهم SYNTHETIC_NAME_REDACTION",
      messageId: "ai-name-redaction",
    })).status === 200, "A later DM is accepted for the redaction check");
    makeApiJobDue("424000001");
    await redactionStarted;
    await waitForQueueState("424000001", "sent");
    const redactedNameReplies = outboundReplies(apiNameThread);
    assert(redactedNameReplies.length === 2 &&
      redactedNameReplies.every((reply) => {
        assertPublicPlanReply(reply);
        return !reply.includes("مریم یوسفی") && !reply.includes("آرش کریمی");
      }),
    "Replies after captured/corrected names use only safe plan DTO values and never repeat private names");

    const makeAiEnabled = async () => {
      assert((await (await adminPost("reply-mode", { replyMode: "ai" })).json()).replyMode === "ai",
        "AI mode can be restored without changing enablement");
      const result = await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true });
      assert(result.status === 200, "Existing confirmation permits re-enabling for the synthetic test");
    };
    await makeAiEnabled();
    apiThread = await makeAiApiJob("434343434", "SYNTHETIC_MODE_RACE");
    assert((await (await adminPost("reply-mode", { replyMode: "intake" })).json()).replyMode === "intake",
      "Mode changes are allowed during model preparation before a send starts");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert(!(await waitForQueueState("434343434", "failed")).thread_error &&
      outboundReplies(apiThread).length === 0,
    "Changing reply mode invalidates the in-progress AI result without sending it");

    await makeAiEnabled();
    apiThread = await makeAiApiJob("444444444", "SYNTHETIC_DISABLE_RACE");
    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "Automation can be disabled while AI is preparing before fetch");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert((await waitForQueueState("444444444", "failed")).error === "automation_disabled" &&
      outboundReplies(apiThread).length === 0,
    "Disabling automation invalidates an in-progress AI result");

    await makeAiEnabled();
    apiThread = await makeAiApiJob("454545454", "SYNTHETIC_PAUSE_RACE");
    assert((await fetch(`${baseUrl}/api/instagram/threads/${apiThread}/pause`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    })).status === 200, "Admin can pause while AI is preparing");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert(outboundReplies(apiThread).length === 0, "A paused conversation cannot send a generated AI answer");
    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "The fixture can disable after the pause guard");
    await fetch(`${baseUrl}/api/instagram/threads/${apiThread}/pause`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });

    await makeAiEnabled();
    apiThread = await makeAiApiJob("464646464", "SYNTHETIC_LATEST_RACE");
    const newerModelStarted = waitForModelStart("SYNTHETIC_LATEST_NEW");
    const newer = await apiDm(nullPageAuth, "464646464", "SYNTHETIC_LATEST_NEW");
    assert(newer.status === 200, "A newer DM during generation is accepted");
    makeApiJobDue("464646464");
    await newerModelStarted;
    const latestSent = await waitForQueueState("464646464", "sent");
    const latestReplies = outboundReplies(apiThread);
    assert(!latestSent.thread_error && latestReplies.length === 1 &&
      !latestReplies[0].includes("SYNTHETIC_LATEST_RACE") &&
      !latestReplies[0].includes("SYNTHETIC_LATEST_NEW"),
    "A newer DM suppresses the stale result, sends once, and neither selector marker reaches the customer");
    assertPublicPlanReply(latestReplies[0], ["installments"]);
    const stillEnabled = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(stillEnabled.enabled, "The latest-message guard is tested without disabling automation");

    const fallbackMarkers = [
      "SYNTHETIC_MODEL_ERROR",
      "SYNTHETIC_EMPTY_RESPONSE",
      "SYNTHETIC_OVERSIZE_RESPONSE",
      "SYNTHETIC_FORGED_ANSWER",
      "SYNTHETIC_MODEL_TIMEOUT",
    ];
    for (const [fallbackIndex, marker] of fallbackMarkers.entries()) {
      await makeAiEnabled();
      const forgedAnswerRegenerated = marker === "SYNTHETIC_FORGED_ANSWER"
        ? waitForModelStart("SYNTHETIC_FORGED_ANSWER_REGENERATED") : null;
      const subscriberId = String(470000000 + fallbackIndex);
      const failedThread = await makeAiApiJob(subscriberId, marker);
      if (forgedAnswerRegenerated) await forgedAnswerRegenerated;
      const fallback = await waitForQueueState(
        subscriberId,
        "sent",
        8_000,
      );
      const expectedError = marker === "SYNTHETIC_MODEL_ERROR" ? "ai_reply_provider_unavailable" :
        marker === "SYNTHETIC_MODEL_TIMEOUT" ? "ai_reply_timeout" : "ai_reply_incomplete";
      const fallbackDb = new DatabaseSync(databasePath);
      const fallbackFields = fallbackDb.prepare(`SELECT t.requested_field, q.requested_field AS queued_field
        FROM instagram_threads t JOIN instagram_send_queue q ON q.thread_id=t.id WHERE t.id=?`).get(failedThread);
      fallbackDb.close();
      const fallbackReplies = outboundReplies(failedThread);
      assert(fallback.error === null && fallback.thread_error === null &&
        fallbackReplies.length === 1 &&
        fallbackReplies[0].includes("فعلاً امکان بررسی شرایط وام را ندارم") &&
        !fallbackReplies[0].includes(marker),
      `${marker} must be categorized internally and send one honest, non-financial fallback`);
      if (marker === "SYNTHETIC_FORGED_ANSWER") {
        assert(forgedAnswerRegenerated,
          "An answer-bearing model response must trigger the selector-only regeneration attempt");
        for (const forbidden of ["Synthetic Bank", "75% interest", "credit rank", "provider details"]) {
          assert(!fallbackReplies[0].includes(forbidden),
            "A forged model-authored answer is rejected, regenerated, and never leaked to the customer");
        }
      }
      assert(await waitForSafeLogReason(expectedError),
        `${marker} must log only its safe categorized provider/preparation reason`);
      assert(fallbackFields.requested_field === null && fallbackFields.queued_field === null &&
        !fallbackReplies[0].includes("نام و نام خانوادگی"),
      `${marker} fallback must not be overridden by an intake suffix`);
    }
    await makeAiEnabled();
    apiThread = await makeAiApiJob("484848484", "SYNTHETIC_API_ROTATE_RACE");
    const rotatedApiCredentials = {
      apiToken: "synthetic-null-page-manychat-token-c",
      bridgeSecret: "synthetic-rotated-api-bridge-secret",
    };
    assert((await adminPost("config", rotatedApiCredentials)).status === 200,
      "API credentials can rotate while model preparation is in progress");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const apiRotationResult = await waitForQueueState("484848484", "failed");
    assert(apiRotationResult.error === "provider_credentials_changed" &&
      outboundReplies(apiThread).length === 0,
    "API credential rotation independently invalidates its in-progress model result");
    assert((await inbound(nullPageAuth, {
      subscriberId: "484848484", text: "سلام", messageId: "api-rotation-old-secret",
    })).status === 401, "API credential rotation immediately rejects the old bridge secret");
    assert((await inbound({ "X-CRM-Bridge-Secret": rotatedApiCredentials.bridgeSecret }, {
      subscriberId: "484848484", text: "سلام، مشاوره می‌خواهم", messageId: "api-rotation-new-secret",
    })).status === 200, "The rotated API bridge secret authenticates independently");
    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "Synthetic API AI tests leave automation disabled");
    assert((await (await adminPost("reply-mode", { replyMode: "intake" })).json()).replyMode === "intake",
      "The fixture restores the independent default mode before testing Flow");

    // Flow-only bridge: it must work with no Public API token. No real
    // Instagram/customer records or provider credentials are used here.
    ensureDefaultAllocation();
    const flowSecret = "synthetic-flow-secret-for-fixture-only";
    assert((await adminPost("flow-config", { bridgeSecret: flowSecret }, registrarCookie)).status === 403,
      "Only admins may switch to the Flow bridge");
    const flowSaved = await adminPost("flow-config", { bridgeSecret: flowSecret });
    assert(flowSaved.status === 200 && (await flowSaved.json()).enabled === false,
      "Flow bridge should save disabled, without Public API verification");
    const flowDb = new DatabaseSync(databasePath);
    const flowConnection = flowDb.prepare("SELECT mode, token_sealed, bridge_sealed FROM manychat_connections WHERE id=1").get();
    assert(flowConnection.mode === "flow" && flowConnection.token_sealed === "" &&
      !JSON.stringify(flowConnection).includes(flowSecret), "Flow stores only the encrypted bridge secret");
    flowDb.close();
    const flowStatus = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert(flowStatus.mode === "flow" && flowStatus.configured && !flowStatus.enabled &&
      !flowStatus.credentialsUnreadable && flowStatus.verifiedAt === null &&
      !JSON.stringify(flowStatus).includes(flowSecret), "Flow status cannot imply API verification or leak the bridge secret");
    const flowAuth = { "X-CRM-Bridge-Secret": flowSecret };
    const poll = (headers, body) => fetch(`${baseUrl}/api/manychat/reply`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const pollNext = (headers, body) => fetch(`${baseUrl}/api/manychat/reply/next`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    const disabledPayload = { subscriberId: "555556788", text: "سلام", messageId: "flow-disabled-test" };
    const payload = { subscriberId: "555556789", text: "سلام", messageId: "flow-test-1" };
    assert((await inbound(auth, payload)).status === 401, "Older bridge secret must stop working");
    assert((await poll({}, { subscriberId: payload.subscriberId, requestId: "a".repeat(32) })).status === 401,
      "Unauthenticated reply polls must fail");
    const disabledInbound = await inbound(flowAuth, disabledPayload);
    const disabledBody = await disabledInbound.json();
    assert(disabledInbound.status === 200 && disabledBody.ready === "no" &&
      /^[a-f0-9]{32}$/.test(disabledBody.requestId), "Disabled Flow accepts leads but never prepares replies");
    const disabledPoll = await poll(flowAuth, {
      subscriberId: disabledPayload.subscriberId, requestId: disabledBody.requestId,
    });
    assert((await disabledPoll.json()).ready === "no", "Disabled Flow cannot deliver a reply");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Flow enablement requires inbound proof but not a Public API token");
    const firstFlow = await inbound(flowAuth, { ...payload, messageId: "flow-test-2" });
    const firstBody = await firstFlow.json();
    assert(firstBody.status === "accepted" && firstBody.ready === "no" && firstBody.reply === "",
      "Inbound must return a correlation ID and clear stale mapped values");
    const sameRetry = await inbound(flowAuth, { ...payload, messageId: "flow-test-2" });
    assert((await sameRetry.json()).requestId === firstBody.requestId, "Retry must keep its request ID");
    const early = await poll(flowAuth, { subscriberId: payload.subscriberId, requestId: firstBody.requestId });
    assert((await early.json()).ready === "no", "Even prepared replies cannot bypass the one-minute delay");
    const awaitReady = async (requestId) => {
      // Queue pacing can legitimately defer a subsequent account reply by 10s.
      const deadline = Date.now() + 20_000;
      let lastState = null;
      while (Date.now() < deadline) {
        const checkDb = new DatabaseSync(databasePath);
        checkDb.exec("PRAGMA busy_timeout=2000");
        try {
          lastState = checkDb.prepare(`SELECT state,error,requested_field,reply_text
            FROM instagram_flow_replies WHERE request_id=?`).get(requestId) ?? null;
        } catch (error) {
          if (error?.code !== "ERR_SQLITE_ERROR" || error?.errstr !== "database is locked") throw error;
        } finally {
          checkDb.close();
        }
        if (lastState?.state === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`Synthetic Flow reply ${requestId} did not become ready; last state=${JSON.stringify(lastState)}`);
    };
    const makeDue = (requestId) => {
      const checkDb = new DatabaseSync(databasePath);
      checkDb.exec("PRAGMA busy_timeout=2000");
      // Simulate both the required minute and the two-minute overlap guard
      // elapsing without making the fixture wait in real time.
      const old = new Date(Date.now() - 121_000).toISOString();
      const row = checkDb.prepare("SELECT thread_id FROM instagram_flow_replies WHERE request_id=?").get(requestId);
      checkDb.prepare("UPDATE instagram_flow_replies SET received_at=? WHERE request_id=?").run(old, requestId);
      checkDb.prepare("UPDATE instagram_threads SET last_message_at=? WHERE id=?").run(old, row.thread_id);
      checkDb.close();
    };
    await awaitReady(firstBody.requestId);
    makeDue(firstBody.requestId);
    const otherContact = await poll(flowAuth, { subscriberId: "987654321", requestId: firstBody.requestId });
    assert((await otherContact.json()).ready === "no", "A different contact cannot claim another reply");
    const claimed = await poll(flowAuth, { subscriberId: payload.subscriberId, requestId: firstBody.requestId });
    const claimedBody = await claimed.json();
    assert(claimedBody.ready === "yes" && claimedBody.reply.includes("نام و نام خانوادگی") &&
      !claimedBody.reply.includes("هوش مصنوعی"),
    "Flow receives the deterministic name prompt without invoking or claiming AI");
    assert((await (await poll(flowAuth, { subscriberId: payload.subscriberId, requestId: firstBody.requestId })).json()).ready === "no",
      "Once handed to the Flow, a reply must not be issued again");
    assert((await pollNext(flowAuth, {
      subscriberId: payload.subscriberId, requestId: firstBody.requestId, ordinal: 0,
    }).then((response) => response.json())).ready === "no",
    "A legacy scalar claim prevents the ordinal endpoint from claiming the same single-message batch");
    const promptForNextTurn = async (text, messageId) => {
      const accepted = await inbound(flowAuth, { subscriberId: payload.subscriberId, text, messageId });
      const acceptedBody = await accepted.json();
      assert(accepted.status === 200 && acceptedBody.status === "accepted", "A later intake turn should be accepted");
      await awaitReady(acceptedBody.requestId);
      makeDue(acceptedBody.requestId);
      return poll(flowAuth, { subscriberId: payload.subscriberId, requestId: acceptedBody.requestId }).then((r) => r.json());
    };
    const phonePrompt = await promptForNextTurn("نام من سارا احمدی است", "flow-name-turn");
    assert(phonePrompt.ready === "yes" && phonePrompt.reply.includes("شماره موبایل"),
      "After name intake the deterministic prompt requests the mobile");
    const identityComplete = await promptForNextTurn("شماره من ۰۹۱۲۲۲۲۴۴۴۴", "flow-phone-turn");
    assert(identityComplete.ready === "yes" &&
      identityComplete.reply.includes("پیام شما دریافت شد") &&
      !identityComplete.reply.includes("موضوع درخواست"),
    "Completing the name/mobile pair automatically registers the unverified customer instead of requesting another CRM field");
    const flowIdentityId = apiThreadId(payload.subscriberId);
    const flowIdentityDb = new DatabaseSync(databasePath);
    flowIdentityDb.exec("PRAGMA busy_timeout=3000");
    const flowIdentity = flowIdentityDb.prepare(`SELECT t.customer_id,c.verification_status,c.salesperson_id
      FROM instagram_threads t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`).get(flowIdentityId);
    assert(flowIdentity.customer_id != null && flowIdentity.verification_status === "unverified" &&
      flowIdentity.salesperson_id === 1,
    "Flow intake uses the same automatic registration and default allocation as API mode");
    flowIdentityDb.close();
    const requestPrompt = await promptForNextTurn("برای خرید کالا درخواست مشاوره دارم", "flow-request-turn");
    assert(requestPrompt.ready === "yes" && requestPrompt.reply.includes("چه مبلغی نیاز دارید"),
      "An existing customer request is routed to the repeat-request clarification");
    const repeatAnswer = await promptForNextTurn(
      "این بار برای خرید لوازم منزل درخواست وام دارم",
      "flow-repeat-answer",
    );
    assert(repeatAnswer.ready === "yes" && !repeatAnswer.reply.includes("موضوع درخواست"),
      "A repeat-request answer is accepted without requesting the same topic again");
    const repeatAuditDb = new DatabaseSync(databasePath);
    repeatAuditDb.exec("PRAGMA busy_timeout=3000");
    const repeatAudit = repeatAuditDb.prepare(`SELECT created_by_user_id,provenance,source_thread_id,
      source_message_id,submitted_description FROM customer_repeat_requests
      WHERE source_message_id LIKE ?`).get("%:flow-repeat-answer");
    assert(repeatAudit && repeatAudit.created_by_user_id == null &&
      repeatAudit.provenance === "instagram_automation" && repeatAudit.source_thread_id === flowIdentityId &&
      repeatAudit.source_message_id.endsWith(":flow-repeat-answer") &&
      repeatAudit.submitted_description?.includes("لوازم منزل"),
    `Flow repeat requests retain automated provenance without impersonating a CRM actor; audit=${JSON.stringify(repeatAudit)}`);
    repeatAuditDb.close();

    const singleFlowSubscriber = "777778887";
    const singleFlowInbound = await inbound(flowAuth, {
      subscriberId: singleFlowSubscriber,
      text: "Synthetic single-message Flow handoff",
      messageId: "flow-single-message",
    });
    const singleFlowRequest = (await singleFlowInbound.json()).requestId;
    await awaitReady(singleFlowRequest);
    const singleFlowDb = new DatabaseSync(databasePath);
    singleFlowDb.prepare(
      "UPDATE instagram_flow_replies SET reply_text=?,reply_messages_json=?,next_item_index=0 WHERE request_id=?",
    ).run(
      "SYNTHETIC_FLOW_SINGLE_ITEM",
      JSON.stringify(["SYNTHETIC_FLOW_SINGLE_ITEM"]),
      singleFlowRequest,
    );
    singleFlowDb.close();
    makeDue(singleFlowRequest);
    const singleFlowClaim = await pollNext(flowAuth, {
      subscriberId: singleFlowSubscriber, requestId: singleFlowRequest, ordinal: 0,
    }).then((response) => response.json());
    assert(singleFlowClaim.ready === "yes" && singleFlowClaim.ordinal === 0 &&
      JSON.stringify(singleFlowClaim.messages) === JSON.stringify(["SYNTHETIC_FLOW_SINGLE_ITEM"]) &&
      singleFlowClaim.hasMore === false && singleFlowClaim.nextItem === null,
    "The ordinal endpoint consumes a one-message batch such as a greeting or question");
    assert((await poll(flowAuth, {
      subscriberId: singleFlowSubscriber, requestId: singleFlowRequest,
    }).then((response) => response.json())).ready === "no",
    "A one-message ordinal claim prevents the legacy scalar endpoint from claiming the same batch");
    assert((await pollNext(flowAuth, {
      subscriberId: singleFlowSubscriber, requestId: singleFlowRequest, ordinal: 0,
    }).then((response) => response.json())).ready === "no",
    "A one-message ordinal claim cannot be replayed");

    const multiFlowSubscriber = "777778888";
    const multiFlowInbound = await inbound(flowAuth, {
      subscriberId: multiFlowSubscriber,
      text: "Synthetic multi-message Flow handoff",
      messageId: "flow-multi-message",
    });
    const multiFlowRequest = (await multiFlowInbound.json()).requestId;
    await awaitReady(multiFlowRequest);
    const multiFlowDb = new DatabaseSync(databasePath);
    const multiFlowRecord = multiFlowDb.prepare(
      "SELECT thread_id,reply_text FROM instagram_flow_replies WHERE request_id=?",
    ).get(multiFlowRequest);
    const multiFlowMessages = [
      "SYNTHETIC_FLOW_ITEM_ZERO",
      "SYNTHETIC_FLOW_ITEM_ONE",
      "SYNTHETIC_FLOW_ITEM_TWO",
    ];
    multiFlowDb.prepare(
      "UPDATE instagram_flow_replies SET reply_messages_json=? WHERE request_id=?",
    ).run(JSON.stringify(multiFlowMessages), multiFlowRequest);
    multiFlowDb.close();
    makeDue(multiFlowRequest);
    assert((await poll(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest,
    }).then((response) => response.json())).ready === "no",
    "The legacy scalar claim refuses a multi-message batch rather than concatenating its text");
    const firstMultiItem = await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: 0,
    }).then((response) => response.json());
    assert(firstMultiItem.ready === "yes" &&
      firstMultiItem.requestId === multiFlowRequest && firstMultiItem.ordinal === 0 &&
      JSON.stringify(firstMultiItem.messages) === JSON.stringify([multiFlowMessages[0]]) &&
      firstMultiItem.hasMore === true && firstMultiItem.nextItem.ordinal === 1,
    "Flow claims and receives exactly one ordered message with explicit next ordinal context");
    const repeatedMultiItem = await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: 0,
    }).then((response) => response.json());
    const outOfOrderMultiItem = await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: 2,
    }).then((response) => response.json());
    assert(repeatedMultiItem.ready === "no" && outOfOrderMultiItem.ready === "no",
      "Repeated and out-of-order Flow claims fail closed instead of risking duplicate sends");
    const secondMultiItem = await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: firstMultiItem.nextItem.ordinal,
    }).then((response) => response.json());
    const thirdMultiItem = await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: secondMultiItem.nextItem.ordinal,
    }).then((response) => response.json());
    assert(secondMultiItem.ready === "yes" && secondMultiItem.ordinal === 1 &&
      secondMultiItem.hasMore && secondMultiItem.nextItem.ordinal === 2 &&
      thirdMultiItem.ready === "yes" && thirdMultiItem.ordinal === 2 &&
      thirdMultiItem.hasMore === false && thirdMultiItem.nextItem === null,
    "Flow advances a monotonic ordinal and marks the final item without concatenating messages");
    const multiFlowStateDb = new DatabaseSync(databasePath);
    const multiFlowState = multiFlowStateDb.prepare(
      "SELECT state,next_item_index FROM instagram_flow_replies WHERE request_id=?",
    ).get(multiFlowRequest);
    const multiFlowHandoffs = multiFlowStateDb.prepare(
      "SELECT ordinal,content FROM instagram_flow_handoff_items WHERE request_id=? ORDER BY ordinal",
    ).all(multiFlowRequest);
    assert(multiFlowState.state === "handed_off" && multiFlowState.next_item_index === 3 &&
      JSON.stringify(multiFlowHandoffs.map(({ ordinal, content }) => [ordinal, content])) ===
        JSON.stringify(multiFlowMessages.map((content, ordinal) => [ordinal, content])),
    "Flow durably records each item claim once and finishes only after the last ordinal");
    multiFlowStateDb.close();
    assert((await pollNext(flowAuth, {
      subscriberId: multiFlowSubscriber, requestId: multiFlowRequest, ordinal: 3,
    }).then((response) => response.json())).ready === "no" &&
      multiFlowRecord.reply_text !== multiFlowMessages.join("\n"),
    "Claiming a Flow batch never reports delivery or falls back to concatenated text");

    const noOutboundDb = new DatabaseSync(databasePath);
    assert(noOutboundDb.prepare(`SELECT count(*) AS n FROM instagram_messages m
      JOIN instagram_threads t ON t.id=m.thread_id
      WHERE m.direction='outbound' AND t.sender_id LIKE 'mc:manychat-flow-%'`).get().n === 0,
      "Flow handoff must not be recorded as confirmed Instagram delivery");
    noOutboundDb.close();

    assert((await (await adminPost("reply-mode", { replyMode: "ai" })).json()).replyMode === "ai",
      "The independent reply mode also selects AI for Manychat Flow");
    const flowAiSubscriber = "333334444";
    const firstFlowAiStarted = waitForModelStart("SYNTHETIC_FLOW_FIRST");
    const firstFlowAiInbound = await inbound(flowAuth, {
      subscriberId: flowAiSubscriber, text: "SYNTHETIC_FLOW_FIRST", messageId: "flow-ai-first",
    });
    const firstFlowAiRequest = (await firstFlowAiInbound.json()).requestId;
    await firstFlowAiStarted;
    await awaitReady(firstFlowAiRequest);
    makeDue(firstFlowAiRequest);
    const preparedFlowNameDb = new DatabaseSync(databasePath);
    const preparedFlowName = preparedFlowNameDb.prepare(`SELECT r.state, r.requested_field,
      t.requested_field AS committed_field FROM instagram_flow_replies r
      JOIN instagram_threads t ON t.id=r.thread_id WHERE r.request_id=?`).get(firstFlowAiRequest);
    preparedFlowNameDb.close();
    assert(preparedFlowName.state === "ready" && preparedFlowName.requested_field === null &&
      preparedFlowName.committed_field === null,
    "Ordinary Flow AI advice stays free of identity markers before handoff");
    const firstFlowAiReply = await poll(flowAuth, {
      subscriberId: flowAiSubscriber, requestId: firstFlowAiRequest,
    }).then((r) => r.json());
    assert(firstFlowAiReply.ready === "yes" &&
      !firstFlowAiReply.reply.includes("SYNTHETIC_FLOW_FIRST") &&
      !firstFlowAiReply.reply.includes("نام و نام خانوادگی") &&
      !firstFlowAiReply.reply.includes("شماره موبایل"),
    "Flow AI prepares rendered advice without echoing its request selector");
    assertPublicPlanReply(firstFlowAiReply.reply);
    const handedFlowNameDb = new DatabaseSync(databasePath);
    const handedFlowName = handedFlowNameDb.prepare(`SELECT r.state, r.requested_field,
      t.requested_field AS committed_field FROM instagram_flow_replies r
      JOIN instagram_threads t ON t.id=r.thread_id WHERE r.request_id=?`).get(firstFlowAiRequest);
    handedFlowNameDb.close();
    assert(handedFlowName.state === "handed_off" && handedFlowName.requested_field === null &&
      handedFlowName.committed_field === null,
    "A Flow AI advice handoff does not request or commit identity fields");

    const flowNameModelStarted = waitForModelStart("SYNTHETIC_UNMARKED");
    const flowPlainName = await inbound(flowAuth, {
      subscriberId: flowAiSubscriber, text: "نرگس‌  يوسفي", messageId: "flow-ai-plain-name",
    });
    const flowPlainNameRequest = (await flowPlainName.json()).requestId;
    const flowPlainNameDb = new DatabaseSync(databasePath);
    const flowCapturedName = flowPlainNameDb.prepare(`SELECT t.name, t.requested_field,
      m.sensitive_name FROM instagram_threads t JOIN instagram_messages m ON m.thread_id=t.id
      WHERE t.sender_id LIKE ? AND m.mid LIKE '%:flow-ai-plain-name'`).get(`%:${flowAiSubscriber}`);
    flowPlainNameDb.close();
    assert(flowCapturedName.name === "نرگس یوسفی" && flowCapturedName.requested_field === null &&
      flowCapturedName.sensitive_name === 1,
    "Flow captures a standalone sender name without requesting it, normalizes Arabic text, and redacts it");
    await flowNameModelStarted;
    await awaitReady(flowPlainNameRequest);
    makeDue(flowPlainNameRequest);
    const beforeFlowNameHandoffDb = new DatabaseSync(databasePath);
    const beforeFlowNameHandoff = beforeFlowNameHandoffDb.prepare(`SELECT r.state, r.requested_field,
      t.requested_field AS committed_field FROM instagram_flow_replies r
      JOIN instagram_threads t ON t.id=r.thread_id WHERE r.request_id=?`).get(flowPlainNameRequest);
    beforeFlowNameHandoffDb.close();
    assert(beforeFlowNameHandoff.state === "ready" && beforeFlowNameHandoff.requested_field === null &&
      beforeFlowNameHandoff.committed_field === null,
    "The Flow advice prepared after standalone name capture still has no identity prompt marker");
    const flowPlainNameReply = await poll(flowAuth, {
      subscriberId: flowAiSubscriber, requestId: flowPlainNameRequest,
    }).then((r) => r.json());
    const afterFlowNameHandoffDb = new DatabaseSync(databasePath);
    const afterFlowNameHandoff = afterFlowNameHandoffDb.prepare(
      "SELECT requested_field FROM instagram_threads WHERE sender_id LIKE ?",
    ).get(`%:${flowAiSubscriber}`);
    afterFlowNameHandoffDb.close();
    assert(flowPlainNameReply.ready === "yes" && afterFlowNameHandoff.requested_field === null &&
      !flowPlainNameReply.reply.includes("نام و نام خانوادگی") &&
      !flowPlainNameReply.reply.includes("شماره موبایل"),
    "Flow hands off safe advice after standalone name capture without asking for more identity details");

    const secondFlowAiStarted = waitForModelStart("SYNTHETIC_FLOW_SECOND");
    const secondFlowAiInbound = await inbound(flowAuth, {
      subscriberId: flowAiSubscriber, text: "SYNTHETIC_FLOW_SECOND", messageId: "flow-ai-second",
    });
    const secondFlowAiRequest = (await secondFlowAiInbound.json()).requestId;
    await secondFlowAiStarted;
    await awaitReady(secondFlowAiRequest);
    makeDue(secondFlowAiRequest);
    const secondFlowAiReply = await poll(flowAuth, {
      subscriberId: flowAiSubscriber, requestId: secondFlowAiRequest,
    }).then((r) => r.json());
    assert(secondFlowAiReply.ready === "yes" &&
      !secondFlowAiReply.reply.includes("SYNTHETIC_FLOW_SECOND") &&
      !secondFlowAiReply.reply.includes("نام و نام خانوادگی") &&
      !secondFlowAiReply.reply.includes("شماره موبایل"),
    "The next Flow turn uses same-thread history without echoing request selectors");
    assertPublicPlanReply(secondFlowAiReply.reply);
    const flowAiHistoryDb = new DatabaseSync(databasePath);
    const flowAiThread = flowAiHistoryDb.prepare(
      "SELECT id FROM instagram_threads WHERE sender_id LIKE ?",
    ).get(`%:${flowAiSubscriber}`);
    const flowAiHandoffs = flowAiHistoryDb.prepare(
      "SELECT count(*) AS n FROM instagram_flow_handoffs WHERE thread_id=?",
    ).get(flowAiThread.id).n;
    const flowAiOutbound = flowAiHistoryDb.prepare(
      "SELECT count(*) AS n FROM instagram_messages WHERE thread_id=? AND direction='outbound'",
    ).get(flowAiThread.id).n;
    flowAiHistoryDb.close();
    assert(flowAiHandoffs === 3 && flowAiOutbound === 0,
      "All three Flow handoffs persist in same-thread history and are never represented as confirmed delivery");

    const flowTrustStarted = waitForModelStart("SYNTHETIC_TRUST");
    const flowTrustInbound = await inbound(flowAuth, {
      subscriberId: "333334445",
      text: "آیا این مجموعه قابل اعتماد است؟ SYNTHETIC_TRUST",
      messageId: "flow-trust-copy",
    });
    const flowTrustRequest = (await flowTrustInbound.json()).requestId;
    await flowTrustStarted;
    await awaitReady(flowTrustRequest);
    makeDue(flowTrustRequest);
    const flowTrustReply = await poll(flowAuth, {
      subscriberId: "333334445", requestId: flowTrustRequest,
    }).then((r) => r.json());
    assert(flowTrustReply.ready === "yes" && flowTrustReply.reply === FIXED_TRUST_REPLY,
      "Flow trust selection hands off the exact same fixed approved brand copy");

    const flowModeRaceStarted = waitForModelStart("SYNTHETIC_MODE_RACE");
    const flowModeRace = await inbound(flowAuth, {
      subscriberId: "333335555", text: "SYNTHETIC_MODE_RACE", messageId: "flow-ai-mode-race",
    });
    const flowModeRaceRequest = (await flowModeRace.json()).requestId;
    await flowModeRaceStarted;
    assert((await (await adminPost("reply-mode", { replyMode: "intake" })).json()).replyMode === "intake",
      "Changing mode during Flow model generation is allowed before handoff");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const flowModeRacePoll = await poll(flowAuth, {
      subscriberId: "333335555", requestId: flowModeRaceRequest,
    }).then((r) => r.json());
    assert(flowModeRacePoll.ready === "no",
      "Flow cannot hand off an AI result after the reply mode changes");
    const flowModeDb = new DatabaseSync(databasePath);
    assert(flowModeDb.prepare(
      "SELECT state FROM instagram_flow_replies WHERE request_id=?",
    ).get(flowModeRaceRequest)?.state === "failed", "Flow mode changes permanently invalidate in-progress work");
    flowModeDb.close();
    assert((await (await adminPost("reply-mode", { replyMode: "ai" })).json()).replyMode === "ai",
      "Flow race fixture restores AI mode before the next turn");

    const flowDisableStarted = waitForModelStart("SYNTHETIC_DISABLE_RACE");
    const flowDisableInbound = await inbound(flowAuth, {
      subscriberId: "333336666", text: "SYNTHETIC_DISABLE_RACE", messageId: "flow-ai-disable-race",
    });
    const flowDisableRequest = (await flowDisableInbound.json()).requestId;
    await flowDisableStarted;
    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "Flow automation can be disabled while AI is preparing");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert((await poll(flowAuth, {
      subscriberId: "333336666", requestId: flowDisableRequest,
    }).then((r) => r.json())).ready === "no",
    "Disabling Flow invalidates its in-progress AI result");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Flow may be re-enabled only through the existing confirmation guard");

    const flowPauseStarted = waitForModelStart("SYNTHETIC_PAUSE_RACE");
    const flowPauseInbound = await inbound(flowAuth, {
      subscriberId: "333337777", text: "SYNTHETIC_PAUSE_RACE", messageId: "flow-ai-pause-race",
    });
    const flowPauseRequest = (await flowPauseInbound.json()).requestId;
    await flowPauseStarted;
    const flowPauseDb = new DatabaseSync(databasePath);
    const flowPauseThreadId = flowPauseDb.prepare(
      "SELECT thread_id FROM instagram_flow_replies WHERE request_id=?",
    ).get(flowPauseRequest).thread_id;
    flowPauseDb.close();
    assert((await fetch(`${baseUrl}/api/instagram/threads/${flowPauseThreadId}/pause`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    })).status === 200, "A Flow thread can be paused while AI is preparing");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert((await poll(flowAuth, {
      subscriberId: "333337777", requestId: flowPauseRequest,
    }).then((r) => r.json())).ready === "no",
    "Paused Flow threads cannot receive in-progress AI results");

    const flowLatestStarted = waitForModelStart("SYNTHETIC_LATEST_RACE");
    const flowLatestInbound = await inbound(flowAuth, {
      subscriberId: "333338888", text: "SYNTHETIC_LATEST_RACE", messageId: "flow-ai-latest-race",
    });
    const flowLatestRequest = (await flowLatestInbound.json()).requestId;
    await flowLatestStarted;
    const flowLatestNewer = await inbound(flowAuth, {
      subscriberId: "333338888", text: "SYNTHETIC_LATEST_NEW", messageId: "flow-ai-latest-newer",
    });
    assert((await flowLatestNewer.json()).status === "accepted", "A newer Flow DM is archived during AI generation");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert((await poll(flowAuth, {
      subscriberId: "333338888", requestId: flowLatestRequest,
    }).then((r) => r.json())).ready === "no",
    "A newer Flow message invalidates the older AI result");
    await fetch(`${baseUrl}/api/instagram/threads/${flowPauseThreadId}/pause`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });

    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "Flow synthetic AI tests leave automation disabled");
    assert((await (await adminPost("reply-mode", { replyMode: "intake" })).json()).replyMode === "intake",
      "The fixture restores default reply policy after Flow AI tests");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Legacy Flow checks explicitly re-enable automation through its confirmation guard");
    const stale = await inbound(flowAuth, { ...payload, messageId: "flow-test-3" });
    const staleId = (await stale.json()).requestId;
    await awaitReady(staleId);
    const newest = await inbound(flowAuth, { ...payload, messageId: "flow-test-4" });
    const newestId = (await newest.json()).requestId;
    assert((await (await poll(flowAuth, { subscriberId: payload.subscriberId, requestId: staleId })).json()).ready === "no",
      "A newer message must invalidate a prepared older reply");
    assert((await (await poll(flowAuth, { subscriberId: payload.subscriberId, requestId: newestId })).json()).ready === "no",
      "Overlapping Flow runs must fail closed rather than claim one another's contact-wide fields");
    const pausableContact = { subscriberId: "777778901", text: "سلام", messageId: "flow-pause-test" };
    const pausable = await inbound(flowAuth, pausableContact);
    const pausableId = (await pausable.json()).requestId;
    await awaitReady(pausableId);
    makeDue(pausableId);
    const threadForPause = new DatabaseSync(databasePath);
    const threadId = threadForPause.prepare("SELECT thread_id FROM instagram_flow_replies WHERE request_id=?").get(pausableId).thread_id;
    threadForPause.close();
    assert((await fetch(`${baseUrl}/api/instagram/threads/${threadId}/pause`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    })).status === 200, "Admin can pause a thread");
    assert((await (await poll(flowAuth, { subscriberId: pausableContact.subscriberId, requestId: pausableId })).json()).ready === "no",
      "Paused threads cannot hand replies to Manychat");
    const secondContact = { subscriberId: "666667890", text: "سلام", messageId: "flow-stop-test" };
    const pendingStop = await inbound(flowAuth, secondContact);
    const stopId = (await pendingStop.json()).requestId;
    await awaitReady(stopId);
    makeDue(stopId);
    assert((await adminPost("autoreply", { enabled: false })).status === 200,
      "Admin can stop Flow preparation");
    assert((await (await poll(flowAuth, { subscriberId: secondContact.subscriberId, requestId: stopId })).json()).ready === "no",
      "Stopping automation invalidates ready replies");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Automation can be re-enabled");
    assert((await (await poll(flowAuth, { subscriberId: secondContact.subscriberId, requestId: stopId })).json()).ready === "no",
      "Re-enabling must not revive a previously cancelled reply");
    const rotating = await inbound(flowAuth, { ...secondContact, messageId: "flow-rotate-test" });
    const rotatingId = (await rotating.json()).requestId;
    await awaitReady(rotatingId);
    makeDue(rotatingId);
    const nextSecret = "synthetic-rotated-flow-secret-for-fixture";
    assert((await adminPost("flow-config", { bridgeSecret: nextSecret })).status === 200,
      "Key rotation must succeed without Public API access");
    assert((await inbound(flowAuth, secondContact)).status === 401,
      "Old bridge secret must immediately stop authenticating");
    assert((await (await poll({ "X-CRM-Bridge-Secret": nextSecret }, {
      subscriberId: secondContact.subscriberId, requestId: rotatingId,
    })).json()).ready === "no", "Rotation must invalidate undelivered replies");

    assert((await inbound({ "X-CRM-Bridge-Secret": nextSecret }, {
      subscriberId: "888880000", text: "سلام", messageId: "flow-new-credential-test",
    })).status === 200, "The newly configured Flow bridge receives its required test event");
    assert((await adminPost("autoreply", { enabled: true, confirmedLiveDelivery: true })).status === 200,
      "Flow rotation race explicitly enables the new connection through its guard");
    assert((await (await adminPost("reply-mode", { replyMode: "ai" })).json()).replyMode === "ai",
      "Flow credential-rotation race selects AI independently of automation mode");
    const flowRotationStarted = waitForModelStart("SYNTHETIC_FLOW_ROTATE_RACE");
    const flowRotationInbound = await inbound({ "X-CRM-Bridge-Secret": nextSecret }, {
      subscriberId: "888889999", text: "SYNTHETIC_FLOW_ROTATE_RACE", messageId: "flow-ai-rotation-race",
    });
    const flowRotationRequest = (await flowRotationInbound.json()).requestId;
    await flowRotationStarted;
    const rotatedFlowSecret = "synthetic-second-rotated-flow-secret-for-fixture";
    assert((await adminPost("flow-config", { bridgeSecret: rotatedFlowSecret })).status === 200,
      "Flow credentials can rotate while model preparation is in progress");
    assert((await inbound({ "X-CRM-Bridge-Secret": nextSecret }, {
      subscriberId: "888889999", text: "سلام", messageId: "flow-rotation-old-secret",
    })).status === 401, "Flow credential rotation immediately rejects the old bridge secret");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert((await (await poll({ "X-CRM-Bridge-Secret": rotatedFlowSecret }, {
      subscriberId: "888889999", requestId: flowRotationRequest,
    })).json()).ready === "no", "Flow credential rotation independently invalidates its in-progress AI handoff");
    const flowRotationDb = new DatabaseSync(databasePath);
    const flowRotationState = flowRotationDb.prepare(
      "SELECT state, error, reply_text FROM instagram_flow_replies WHERE request_id=?",
    ).get(flowRotationRequest);
    flowRotationDb.close();
    assert(flowRotationState?.state === "failed" && !flowRotationState.reply_text,
      "A result prepared under the old Flow credentials is discarded");
    console.log("Manychat Flow synthetic fixture passed");
    console.log("Manychat synthetic fixture passed");
  } else {
  const unauthenticated = await fetch(`${baseUrl}/api/instagram/status`);
  assert(unauthenticated.status === 401, "Instagram status must require CRM authentication");
  const challenge = await fetch(`${baseUrl}/api/instagram/webhook?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=challenge-123`);
  assert(challenge.status === 200 && await challenge.text() === "challenge-123", "Meta GET challenge should verify");
  const badSignature = await fetch(`${baseUrl}/api/instagram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
    body: "{}",
  });
  assert(badSignature.status === 401, "Invalid raw-body signature must be rejected");

  const statusResponse = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: cookie } });
  const status = await statusResponse.json();
  assert(status.oauthReady === false && status.connected === false, "Missing Instagram app credentials must fail closed");
  assert(status.accountUsername === null && status.accountId === null && status.tokenExpiry === null, "No account details should be exposed before connection");
  assert(status.redirectUri === null && status.missingSetup.some((item) => item.includes("IG_OAUTH_CLIENT_ID")), "Missing setup must be actionable");
  assert(
    !JSON.stringify(status).includes("synthetic-instagram-app-secret") &&
      !JSON.stringify(status).includes("synthetic-encrypted-token-never-sent"),
    "Status must not expose provider credentials",
  );
  const registrarStatusResponse = await fetch(`${baseUrl}/api/instagram/status`, { headers: { Cookie: registrarCookie } });
  const registrarStatus = await registrarStatusResponse.json();
  assert(
    registrarStatusResponse.status === 200 &&
      Object.keys(registrarStatus).sort().join(",") === "configured,connected,enabled,replyMode",
    "Registrar status must contain only generic connection flags and the reply mode",
  );
  const startWithoutApp = await fetch(`${baseUrl}/api/instagram/connect/start`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert(startWithoutApp.status === 409, "Connect start must fail closed without app credentials");
  assert((await startWithoutApp.json()).missingSetup.some((item) => item.includes("IG_OAUTH_CLIENT_SECRET")), "409 must list missing setup");

  for (const [pathName, method] of [
    ["/api/instagram/connect/start", "POST"],
    ["/api/instagram/oauth/callback", "GET"],
    ["/api/instagram/connect/disconnect", "POST"],
  ]) {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: { Cookie: registrarCookie, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert(response.status === 403, `Registrar must be forbidden from ${pathName}`);
  }

  const callbackState = randomBytes(32).toString("base64url");
  const callbackDb = new DatabaseSync(databasePath);
  callbackDb.prepare(`INSERT INTO instagram_oauth_states(state_hash,session_hash,admin_user_id,expires_at,created_at)
    VALUES(?,?,?,?,?)`).run(
    purposeHash("instagram-state", callbackState),
    purposeHash("instagram-session", tokens.get(1)),
    1,
    new Date(Date.now() + 60_000).toISOString(),
    now,
  );
  callbackDb.close();
  const wrongAdminCallback = await fetch(`${baseUrl}/api/instagram/oauth/callback?state=${callbackState}`, {
    headers: { Cookie: otherAdminCookie },
    redirect: "manual",
  });
  assert(wrongAdminCallback.status === 303 && wrongAdminCallback.headers.get("location") === "/instagram-inbox?connection=error", "OAuth state must be bound to its initiating administrator session");
  const callbackFailure = await fetch(`${baseUrl}/api/instagram/oauth/callback?state=${callbackState}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert(callbackFailure.status === 303 && callbackFailure.headers.get("location") === "/instagram-inbox?connection=error", "Callback failure must redirect with a fixed safe code");
  assert(!callbackFailure.headers.get("location").includes(callbackState), "Callback state must not appear in redirect");
  const replay = await fetch(`${baseUrl}/api/instagram/oauth/callback?state=${callbackState}`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert(replay.status === 303 && replay.headers.get("location") === "/instagram-inbox?connection=error", "OAuth state must be one-time");
  assert(
    !childLogs.includes(callbackState) &&
      !childLogs.includes("synthetic-instagram-app-secret") &&
      !childLogs.includes("synthetic-encrypted-token-never-sent"),
    "OAuth state and confidential provider values must not appear in server logs",
  );

  // Synthetic encrypted credentials exercise the existing webhook pipeline
  // without allowing any Instagram provider request.
  const syntheticToken = "synthetic-encrypted-token-never-sent";
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey, nonce);
  const encryptedToken = Buffer.concat([cipher.update(syntheticToken, "utf8"), cipher.final()]);
  const seedDb = new DatabaseSync(databasePath);
  seedDb.prepare(`INSERT INTO instagram_connections
    (id,account_id,account_username,token_ciphertext,token_nonce,token_auth_tag,token_key_version,token_expires_at,connected_at,updated_at)
    VALUES(1,?,?,?,?,?, 'primary',?,?,?)`).run(
    "111222333",
    "synthetic_account",
    encryptedToken.toString("base64"),
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    now,
    now,
  );
  seedDb.close();

  const queueMark = new Date(Date.now() + 60_000).toISOString();
  const markDb = new DatabaseSync(databasePath);
  markDb.prepare("UPDATE instagram_send_state SET last_sent_at=? WHERE id=1").run(queueMark);
  const expiredTokenAt = new Date(Date.now() - 60_000).toISOString();
  markDb.prepare("UPDATE instagram_connections SET token_expires_at=? WHERE id=1").run(expiredTokenAt);
  markDb.close();
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-1", "سلام")).status === 200, "Valid signed webhook should be accepted");
  const expiredInboundDb = new DatabaseSync(databasePath);
  assert(
    Number(expiredInboundDb.prepare("SELECT COUNT(*) AS n FROM instagram_messages").get().n) === 1 &&
      Number(expiredInboundDb.prepare("SELECT COUNT(*) AS n FROM instagram_send_queue").get().n) === 0,
    "Signed webhook must persist inbound leads with an expired token without queuing outbound replies",
  );
  const encryptedSeed = expiredInboundDb.prepare(`SELECT token_ciphertext,token_nonce,token_auth_tag,
    token_key_version FROM instagram_connections WHERE id=1`).get();
  const validExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  expiredInboundDb.prepare("UPDATE instagram_connections SET token_ciphertext='invalid-ciphertext',token_expires_at=? WHERE id=1")
    .run(validExpiry);
  expiredInboundDb.close();
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-key-error", "پیام با کلید غیرقابل رمزگشایی")).status === 200, "Signed inbound webhook must survive token decryption failure");
  const decryptionFailureDb = new DatabaseSync(databasePath);
  assert(
    Number(decryptionFailureDb.prepare("SELECT COUNT(*) AS n FROM instagram_messages").get().n) === 2 &&
      Number(decryptionFailureDb.prepare("SELECT COUNT(*) AS n FROM instagram_send_queue").get().n) === 0,
    "Undecryptable token must not prevent inbound persistence or enable outbound work",
  );
  decryptionFailureDb.prepare(`UPDATE instagram_connections
    SET token_ciphertext=?,token_nonce=?,token_auth_tag=?,token_key_version='primary',token_expires_at=?
    WHERE id=1`).run(
    encryptedSeed.token_ciphertext,
    encryptedSeed.token_nonce,
    encryptedSeed.token_auth_tag,
    validExpiry,
  );
  decryptionFailureDb.close();
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-1", "سلام")).status === 200, "Duplicate webhook retry should be acknowledged");
  assert((await postMessage("synthetic-sender-456", "synthetic-echo", "echo", true)).status === 200, "Echo should be acknowledged");
  const triggerDb = new DatabaseSync(databasePath);
  triggerDb.exec(`CREATE TRIGGER instagram_fixture_abort_lead
    BEFORE UPDATE OF name ON instagram_threads
    WHEN NEW.name='سارا احمدی'
    BEGIN SELECT RAISE(ABORT,'synthetic lead write failure'); END;`);
  triggerDb.close();
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-2", "اسمم سارا احمدی است")).status === 500, "Lead write failure should roll back and allow Meta retry");
  const retryDb = new DatabaseSync(databasePath);
  retryDb.exec("DROP TRIGGER instagram_fixture_abort_lead");
  retryDb.close();
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-2", "اسمم سارا احمدی است")).status === 200, "Same webhook mid should succeed on retry after transient lead failure");
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-3", "برای گرفتن وام چه شرایطی دارم؟")).status === 200, "Later loan request should be accepted");
  assert((await postMessage("synthetic-sender-456", "synthetic-mid-4", `شماره من ${phone} کد پیگیری 123`)).status === 200, "Phone embedded alongside unrelated digits should be extracted");
  assert((await postMessage("synthetic-sender-789", "synthetic-mid-5", "من دنبال وام هستم")).status === 200, "Uncertain natural-language message should be accepted as a lead without guessing a name");
  assert((await postMessage("synthetic-sender-987", "synthetic-mid-6", "نام من علی رضایی است")).status === 200, "Explicit نام من form should be accepted");
  assert((await postMessage("synthetic-sender-convert", "synthetic-convert-name", "نام من مینا احمدی است")).status === 200,
    "A complete reviewable lead name should be ingested");
  assert((await postMessage("synthetic-sender-convert", "synthetic-convert-phone", "شماره من ۰۹۱۱۹۹۹۸۸۷۷")).status === 200,
    "Persian-digit mobile should be canonicalized into the lead");
  assert((await postMessage("synthetic-sender-convert", "synthetic-convert-request", "برای خرید لوازم منزل درخواست مشاوره دارم")).status === 200,
    "Meaningful free-text requests should be retained");

  const threadsResponse = await fetch(`${baseUrl}/api/instagram/threads`, { headers: { Cookie: cookie } });
  const threads = await threadsResponse.json();
  const legacyThreads = threads.filter((item) => item.senderId.startsWith("synthetic-sender-"));
  assert(legacyThreads.length === 4, "Echo and duplicate legacy webhook messages must not create extra threads");
  const thread = legacyThreads.find((item) => item.senderId === "synthetic-sender-456");
  const cautiousThread = legacyThreads.find((item) => item.senderId === "synthetic-sender-789");
  const explicitNameThread = legacyThreads.find((item) => item.senderId === "synthetic-sender-987");
  assert(thread && cautiousThread && explicitNameThread, "Synthetic sender threads should be available");
  assert(thread.senderId === "synthetic-sender-456" && thread.name === "سارا احمدی", "Lead name and sender should be captured");
  assert(thread.phone === phone && thread.customerId === null, "Instagram lead must not be linked to an existing CRM customer");
  assert(thread.request?.includes("وام") && thread.request.includes("شرایط"), "A meaningful request arriving after a greeting should be saved");
  assert(cautiousThread.name === null && cautiousThread.customerId === null && cautiousThread.request?.includes("وام"), "Do not infer identity from ordinary sentence words, but retain the explicit loan intent");
  assert(explicitNameThread.name === "علی رضایی" && explicitNameThread.customerId === null, "A clearly introduced name alone must not create a customer");
  const conversionThread = legacyThreads.find((item) => item.senderId === "synthetic-sender-convert");
  assert(conversionThread?.name === "مینا احمدی" && conversionThread.phone === "09119998877" &&
    conversionThread.request?.includes("لوازم منزل") && conversionThread.customerId === null,
  "The deterministic multi-turn intake should capture name, Persian-digit mobile, and free-text request without creating a customer");
  const readDb = new DatabaseSync(databasePath);
  const existingCrmRecord = readDb.prepare("SELECT name,phone,description,verification_status FROM customers").get();
  assert(existingCrmRecord?.name === "Synthetic existing CRM record" && existingCrmRecord.phone === phone && existingCrmRecord.description === "must remain untouched" && existingCrmRecord.verification_status === "verified", "Instagram processing must not mutate existing CRM customers");
  const expectedCustomersAfterTransportIntake = process.env.TEST_MANYCHAT === "1" ? 2 : 1;
  assert(Number(readDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === expectedCustomersAfterTransportIntake,
    "Only fully identified Manychat API/Flow leads auto-register; legacy webhook messages and partial leads do not");
  const sendStateColumns = readDb.prepare("PRAGMA table_info(instagram_send_state)").all().map((column) => column.name);
  assert(["lease_token", "lease_expires_at", "lease_queue_id", "lease_revision", "lease_stage"].every((column) => sendStateColumns.includes(column)), "Account-wide durable lease columns should be migrated");
  const messageCount = readDb.prepare("SELECT COUNT(*) AS n FROM instagram_messages WHERE thread_id=?").get(thread.id).n;
  assert(Number(messageCount) === 5, "Inbound mid must be deduplicated and echoes ignored");
  readDb.close();

  const conversionDb = new DatabaseSync(databasePath);
  const programId = ensureDefaultAllocation();
  conversionDb.close();
  const manualDuplicateThreadId = seedUnprocessedThread({
    senderId: "mc:synthetic-manual-duplicate",
    name: "سارا احمدی",
    phone,
    request: "درخواست بررسی شرایط وام",
  });
  const manualIncompleteThreadId = seedUnprocessedThread({
    senderId: "mc:synthetic-manual-incomplete",
    name: "سارا احمدی",
    phone: "09118887766",
  });
  const manualCompleteThreadId = seedUnprocessedThread({
    senderId: "mc:synthetic-manual-complete",
    name: "مینا احمدی",
    phone: "09119998877",
    request: "برای خرید لوازم منزل درخواست مشاوره دارم",
  });
  const convertLead = (threadId, body, authCookie) => fetch(`${baseUrl}/api/instagram/threads/${threadId}/convert`, {
    method: "POST",
    headers: { ...(authCookie ? { Cookie: authCookie } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reviewedLead = {
    name: "مینا رضایی",
    phone: "۰۹۱۱۹۹۹۸۸۷۷",
    request: "درخواست بررسی برای خرید لوازم منزل",
    reviewed: true,
  };
  const incompleteConversion = await convertLead(manualIncompleteThreadId, {
    name: "سارا احمدی", phone: "09118887766", request: "درخواست مشاوره برای تسهیلات", reviewed: true,
  }, registrarCookie);
  assert(incompleteConversion.status === 409 && (await incompleteConversion.json()).code === "incomplete_lead",
    "Staff corrections cannot bypass missing original fields on an unprocessed synthetic lead");
  assert((await convertLead(manualCompleteThreadId, reviewedLead)).status === 401,
    "Anonymous callers cannot convert Instagram leads");
  const unreviewedConversion = await convertLead(manualCompleteThreadId, { ...reviewedLead, reviewed: false }, registrarCookie);
  assert(unreviewedConversion.status === 400 &&
    (await unreviewedConversion.json()).code === "review_confirmation_required",
  "Conversion requires the explicit reviewed=true confirmation");
  const salespersonCookie = `crm_session=${tokens.get(2)}`;
  const nonStaffConversion = await convertLead(manualCompleteThreadId, reviewedLead, salespersonCookie);
  assert(nonStaffConversion.status === 403 && (await nonStaffConversion.json()).code === "forbidden",
    "Non-staff customer creators cannot convert Instagram leads");
  const duplicateConversion = await convertLead(manualDuplicateThreadId, {
    name: "سارا احمدی", phone, request: "درخواست بررسی شرایط وام", reviewed: true,
  }, registrarCookie);
  assert(duplicateConversion.status === 409 && (await duplicateConversion.json()).code === "duplicate_mobile",
    "A normalized duplicate mobile blocks conversion without linking to existing CRM records");
  const privacyCheck = new DatabaseSync(databasePath);
  const protectedExisting = privacyCheck.prepare("SELECT id,name,phone,description,verification_status FROM customers WHERE id=1").get();
  assert(protectedExisting?.name === "Synthetic existing CRM record" && protectedExisting.phone === phone &&
    protectedExisting.description === "must remain untouched" && protectedExisting.verification_status === "verified",
  "Duplicate review must preserve existing customer privacy and identity");
  privacyCheck.close();
  const beforeManualDb = new DatabaseSync(databasePath);
  const customersBeforeManualConversion = Number(beforeManualDb
    .prepare("SELECT COUNT(*) AS n FROM customers").get().n);
  beforeManualDb.close();
  const successfulConversion = await convertLead(manualCompleteThreadId, reviewedLead, registrarCookie);
  const convertedBody = await successfulConversion.json();
  assert(successfulConversion.status === 201 && Number.isSafeInteger(convertedBody.customerId),
    "A complete explicitly reviewed lead should create one CRM customer");
  const conversionAuditDb = new DatabaseSync(databasePath);
  const createdRecord = conversionAuditDb.prepare(`SELECT name,phone,description,verification_status,
    salesperson_id,merged_into_customer_id FROM customers WHERE id=?`).get(convertedBody.customerId);
  const convertedThread = conversionAuditDb.prepare(`SELECT customer_id,status,reviewed_by_user_id,reviewed_at,
    name,phone,request FROM instagram_threads WHERE id=?`).get(manualCompleteThreadId);
  const allocationBeforeRepeat = conversionAuditDb.prepare(
    "SELECT cursor_item_used FROM allocation_programs WHERE id=?",
  ).get(programId).cursor_item_used;
  assert(createdRecord?.name === reviewedLead.name && createdRecord.phone === "09119998877" &&
    createdRecord.description.includes(reviewedLead.request) && createdRecord.verification_status === "unverified" &&
    createdRecord.salesperson_id === 1 && createdRecord.merged_into_customer_id == null,
  "Conversion must create an unverified, assigned customer with the reviewed DM request");
  assert(Number(conversionAuditDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === customersBeforeManualConversion + 1,
    "The manual fallback creates exactly one customer in addition to any automatic registrations");
  assert(convertedThread?.customer_id === convertedBody.customerId && convertedThread.status === "converted" &&
    convertedThread.reviewed_by_user_id === 3 && convertedThread.reviewed_at &&
    convertedThread.name === reviewedLead.name && convertedThread.request === reviewedLead.request,
  "Conversion must link the thread and audit the staff reviewer and timestamp");
  conversionAuditDb.close();
  const repeatedConversion = await convertLead(manualCompleteThreadId, reviewedLead, registrarCookie);
  assert(repeatedConversion.status === 200 && (await repeatedConversion.json()).alreadyConverted === true,
    "Repeated conversion must be idempotent");
  const repeatCheckDb = new DatabaseSync(databasePath);
  assert(Number(repeatCheckDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === customersBeforeManualConversion + 1 &&
    repeatCheckDb.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?").get(programId).cursor_item_used === allocationBeforeRepeat,
  "Repeated conversion must neither duplicate the customer nor advance allocation");
  repeatCheckDb.close();
  const noProgramThreadId = seedUnprocessedThread({
    senderId: "mc:synthetic-manual-no-program",
    name: "نیما کریمی",
    phone: "09133333333",
    request: "درخواست راهنمایی برای خرید خودرو",
  });
  const rollbackSetup = new DatabaseSync(databasePath);
  rollbackSetup.prepare("DELETE FROM allocation_program_items WHERE program_id=?").run(programId);
  const customersBeforeRollback = Number(rollbackSetup.prepare("SELECT COUNT(*) AS n FROM customers").get().n);
  const allocationBeforeRollback = rollbackSetup.prepare(
    "SELECT cursor_item_used FROM allocation_programs WHERE id=?",
  ).get(programId).cursor_item_used;
  rollbackSetup.close();
  const noAllocation = await convertLead(noProgramThreadId, {
    name: "نیما کریمی", phone: "09133333333", request: "درخواست راهنمایی برای خرید خودرو", reviewed: true,
  }, registrarCookie);
  assert(noAllocation.status === 409 && (await noAllocation.json()).code === "allocation_program_unavailable",
    "A missing/empty default allocation program must fail conversion");
  const rollbackCheck = new DatabaseSync(databasePath);
  assert(Number(rollbackCheck.prepare("SELECT COUNT(*) AS n FROM customers").get().n) === customersBeforeRollback &&
    rollbackCheck.prepare("SELECT customer_id,status,reviewed_by_user_id FROM instagram_threads WHERE id=?").get(noProgramThreadId).customer_id == null &&
    rollbackCheck.prepare("SELECT cursor_item_used FROM allocation_programs WHERE id=?").get(programId).cursor_item_used === allocationBeforeRollback,
  "Allocation failure must roll back customer, thread link, audit, and allocation changes");
  rollbackCheck.close();
  const cleanupManualDb = new DatabaseSync(databasePath);
  cleanupManualDb.prepare("DELETE FROM instagram_threads WHERE id IN (?,?,?,?)")
    .run(manualDuplicateThreadId, manualIncompleteThreadId, manualCompleteThreadId, noProgramThreadId);
  cleanupManualDb.close();

  await new Promise((resolve) => setTimeout(resolve, 2_300));
  const spacingDb = new DatabaseSync(databasePath);
  const queue = spacingDb.prepare("SELECT due_at,state FROM instagram_send_queue WHERE thread_id=?").get(thread.id);
  assert(queue.state === "pending" && new Date(queue.due_at).getTime() >= new Date(queueMark).getTime() + 10_000, "Global last-send spacing should defer pending work across threads");
  spacingDb.close();

  const messagesResponse = await fetch(`${baseUrl}/api/instagram/threads/${thread.id}/messages`, { headers: { Cookie: cookie } });
  assert(messagesResponse.status === 200 && (await messagesResponse.json()).length === 5, "Authorized thread messages should be available");
  const paused = await fetch(`${baseUrl}/api/instagram/threads/${thread.id}/pause`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true }),
  });
  assert(paused.status === 200 && (await paused.json()).paused === true, "Staff should be able to pause/handoff a thread");
  const pauseDb = new DatabaseSync(databasePath);
  assert(pauseDb.prepare("SELECT paused FROM instagram_threads WHERE id=?").get(thread.id).paused === 1, "Pause must persist atomically");
  assert(pauseDb.prepare("SELECT state FROM instagram_send_queue WHERE thread_id=?").get(thread.id).state === "pending", "Pause must not leave a sending queue item");
  pauseDb.close();

  const forbidden = await fetch(`${baseUrl}/api/instagram/threads`, { headers: { Cookie: `crm_session=${tokens.get(2)}` } });
  assert(forbidden.status === 403, "Salesperson must not see Instagram leads");

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const oauthProbe = createServer();
  await new Promise((resolve) => oauthProbe.listen(0, "127.0.0.1", resolve));
  const oauthPort = oauthProbe.address().port;
  await new Promise((resolve) => oauthProbe.close(resolve));
  oauthChild = spawn(process.execPath, ["--enable-source-maps", "dist/index.mjs"], {
    cwd: process.cwd(),
    env: withoutGeminiProvider({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      PORT: String(oauthPort),
      CRM_DATABASE_PATH: databasePath,
      SESSION_SECRET: sessionSecret,
      IG_APP_SECRET: "synthetic-instagram-app-secret",
      IG_VERIFY_TOKEN: "synthetic-verify-token",
      IG_ACCOUNT_ID: "111222333",
      IG_TOKEN_ENCRYPTION_KEY: tokenEncryptionKeyBase64,
      IG_TOKEN_ENCRYPTION_KEY_PREVIOUS: previousTokenEncryptionKeyBase64,
      IG_OAUTH_CLIENT_ID: "synthetic-instagram-app-id",
      IG_OAUTH_CLIENT_SECRET: "synthetic-instagram-oauth-secret",
      IG_OAUTH_REDIRECT_URI: "https://crm.example/api/instagram/oauth/callback",
      IG_AUTOREPLY_ENABLED: "0",
      NODE_OPTIONS: `--import=${path.resolve("scripts/instagram-oauth-fetch-mock.mjs")}`,
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9/fixture-disabled",
      AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let oauthLogs = "";
  const appendOAuthLog = (chunk) => { oauthLogs = `${oauthLogs}${chunk.toString()}`.slice(-20_000); };
  oauthChild.stdout.on("data", appendOAuthLog);
  oauthChild.stderr.on("data", appendOAuthLog);
  const oauthBaseUrl = `http://127.0.0.1:${oauthPort}`;
  let oauthHealthy = false;
  const oauthStartupDeadline = Date.now() + 30_000;
  while (Date.now() < oauthStartupDeadline) {
    if (oauthChild.exitCode !== null) break;
    try {
      if ((await fetch(`${oauthBaseUrl}/api/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })).ok) {
        oauthHealthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, oauthStartupDeadline - Date.now()))));
  }
  assert(oauthHealthy, `Mocked OAuth API did not start. Output: ${oauthLogs || "(none)"}`);

  const beginConnection = async () => {
    const started = await fetch(`${oauthBaseUrl}/api/instagram/connect/start`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert(started.status === 200, "Configured admin should receive official Instagram authorization URL");
    const { authorizeUrl } = await started.json();
    const authorize = new URL(authorizeUrl);
    assert(authorize.origin === "https://www.instagram.com" && authorize.pathname === "/oauth/authorize", "Authorization URL must use official Instagram host");
    assert(authorize.searchParams.get("scope") === "instagram_business_basic,instagram_business_manage_messages", "Authorization URL must request both exact business permissions");
    return authorize.searchParams.get("state");
  };
  const failedSubscriptionState = await beginConnection();
  const failedSubscription = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-subscription-failure&state=${failedSubscriptionState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(
    failedSubscription.status === 303 &&
      failedSubscription.headers.get("location") === "/instagram-inbox?connection=error",
    "HTTP 200 with subscribed_apps success=false must not connect the account",
  );

  const successState = await beginConnection();
  const successfulCallback = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-oauth-code&state=${successState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(
    successfulCallback.status === 303 &&
      successfulCallback.headers.get("location") === "/instagram-inbox?connection=success",
    "Mocked Business Login exchange envelope and webhook subscription should complete successfully",
  );
  const rotationDb = new DatabaseSync(databasePath);
  const oldNonce = randomBytes(12);
  const oldCipher = createCipheriv("aes-256-gcm", previousTokenEncryptionKey, oldNonce);
  const oldCiphertext = Buffer.concat([
    oldCipher.update("synthetic-long-lived-token", "utf8"),
    oldCipher.final(),
  ]);
  rotationDb.prepare(`UPDATE instagram_connections
    SET token_ciphertext=?,token_nonce=?,token_auth_tag=?,token_key_version='previous'
    WHERE id=1`).run(
    oldCiphertext.toString("base64"),
    oldNonce.toString("base64"),
    oldCipher.getAuthTag().toString("base64"),
  );
  rotationDb.close();
  const connectedStatusResponse = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: cookie } });
  const connectedStatus = await connectedStatusResponse.json();
  const rewrappedDb = new DatabaseSync(databasePath);
  const rewrappedConnection = rewrappedDb.prepare("SELECT token_key_version,token_ciphertext FROM instagram_connections WHERE id=1").get();
  assert(rewrappedConnection.token_key_version === "primary" && rewrappedConnection.token_ciphertext !== oldCiphertext.toString("base64"), "Previous encryption key should be opportunistically rewrapped to the current key");
  rewrappedDb.close();
  assert(
    connectedStatus.connected &&
      connectedStatus.accountId === "111222333" &&
      connectedStatus.accountUsername === "synthetic_business" &&
      Boolean(connectedStatus.tokenExpiry),
    "Nested token exchange response should persist encrypted account credentials",
  );
  const registrarConnectedStatusResponse = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: registrarCookie } });
  const registrarConnectedStatus = await registrarConnectedStatusResponse.json();
  assert(
    registrarConnectedStatusResponse.status === 200 &&
      registrarConnectedStatus.connected === true &&
      Object.keys(registrarConnectedStatus).sort().join(",") === "configured,connected,enabled,replyMode" &&
      !JSON.stringify(registrarConnectedStatus).includes("123456789"),
    "Registrar must not see connected account identifiers or expiry",
  );
  assert(
    !JSON.stringify(connectedStatus).includes("synthetic-long-lived-token") &&
      !oauthLogs.includes("synthetic-long-lived-token") &&
      !oauthLogs.includes("synthetic-instagram-oauth-secret"),
    "Mocked OAuth must not expose credentials in status or logs",
  );

  const disconnectApiConnection = async () => {
    const response = await fetch(`${oauthBaseUrl}/api/instagram/connect/disconnect`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert(response.status === 200 && (await response.json()).connected === false, "Admin disconnect should succeed");
  };
  await disconnectApiConnection();
  const otherPageState = await beginConnection();
  const otherPageCallback = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-other-page&state=${otherPageState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(
    otherPageCallback.status === 303 &&
      otherPageCallback.headers.get("location") === "/instagram-inbox?connection=error",
    "A different Instagram page must be rejected after historical page-A leads exist",
  );
  const rejectedPageStatus = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((response) => response.json());
  assert(!rejectedPageStatus.connected && rejectedPageStatus.accountId === null, "Rejected page must not expose or bind account-B context");

  const samePageState = await beginConnection();
  const samePageCallback = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-oauth-code&state=${samePageState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(samePageCallback.headers.get("location") === "/instagram-inbox?connection=success", "The historically bound page may reconnect");

  const delayedState = await beginConnection();
  const delayedCallbackPromise = fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-delayed-connect&state=${delayedState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  await disconnectApiConnection();
  const delayedCallback = await delayedCallbackPromise;
  assert(
    delayedCallback.headers.get("location") === "/instagram-inbox?connection=error",
    "Delayed provider response must not reconnect after a generation-changing disconnect",
  );
  const delayedStatus = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((response) => response.json());
  assert(!delayedStatus.connected && delayedStatus.accountId === null, "A stale OAuth callback must not restore disconnected account context");
  const finalReconnectState = await beginConnection();
  const finalReconnect = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-oauth-code&state=${finalReconnectState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(finalReconnect.headers.get("location") === "/instagram-inbox?connection=success", "Bound page should reconnect after stale flow rejection");

  const disconnectDb = new DatabaseSync(databasePath);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  disconnectDb.prepare("UPDATE instagram_connections SET token_expires_at=? WHERE id=1").run(expiredAt);
  disconnectDb.prepare("UPDATE instagram_send_queue SET state='pending',error=NULL WHERE state='failed'")
    .run();
  const queueRows = disconnectDb.prepare(
    "SELECT id,thread_id,revision FROM instagram_send_queue WHERE state='pending' ORDER BY id LIMIT 2",
  ).all();
  assert(queueRows.length === 2, "Synthetic messages should have queued items for disconnect checks");
  disconnectDb.prepare("UPDATE instagram_send_queue SET state='sending' WHERE id IN (?,?)").run(queueRows[0].id, queueRows[1].id);
  disconnectDb.prepare(`UPDATE instagram_send_state SET lease_token='synthetic-prefetch',
    lease_expires_at=?,lease_queue_id=?,lease_revision=?,lease_stage='processing' WHERE id=1`)
    .run(new Date(Date.now() + 60_000).toISOString(), queueRows[0].id, queueRows[0].revision);
  disconnectDb.close();
  const expiredStatusResponse = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: cookie } });
  const expiredStatus = await expiredStatusResponse.json();
  assert(!expiredStatus.connected && expiredStatus.tokenExpiry === expiredAt, "Expired token must appear disconnected while retaining expiry for admin diagnosis");
  const disconnected = await fetch(`${oauthBaseUrl}/api/instagram/connect/disconnect`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert(disconnected.status === 200 && (await disconnected.json()).connected === false, "Admin disconnect should succeed");
  const disconnectReadDb = new DatabaseSync(databasePath);
  const prefetchQueue = disconnectReadDb.prepare("SELECT state,error FROM instagram_send_queue WHERE id=?").get(queueRows[0].id);
  const uncertainQueue = disconnectReadDb.prepare("SELECT state,error FROM instagram_send_queue WHERE id=?").get(queueRows[1].id);
  const preservedLeadCount = Number(disconnectReadDb.prepare("SELECT COUNT(*) AS n FROM instagram_threads").get().n);
  assert(prefetchQueue.state === "failed" && prefetchQueue.error === "connection_disconnected", "Pre-fetch send claim must be cancelled on disconnect");
  assert(uncertainQueue.state === "failed" && uncertainQueue.error === "send_outcome_uncertain", "Unclassified in-flight send must fail uncertain, never retry");
  assert(preservedLeadCount === 5, "Disconnect must preserve existing Instagram leads");
  disconnectReadDb.close();
  const disconnectedPayload = {
    object: "instagram",
    entry: [{
      id: "111222333",
      messaging: [{
        sender: { id: "synthetic-sender-456" },
        recipient: { id: "111222333" },
        timestamp: Date.now(),
        message: { mid: "synthetic-mid-after-disconnect", text: "پیام پس از قطع اتصال" },
      }],
    }],
  };
  const disconnectedBody = JSON.stringify(disconnectedPayload);
  const disconnectedSignature = createHmac("sha256", "synthetic-instagram-app-secret")
    .update(disconnectedBody).digest("hex");
  const disconnectedInbound = await fetch(`${oauthBaseUrl}/api/instagram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${disconnectedSignature}`,
    },
    body: disconnectedBody,
  });
  assert(disconnectedInbound.status === 200, "Disconnect retains signed inbound ingestion for the permanently bound page");
  const disconnectedInboundDb = new DatabaseSync(databasePath);
  assert(
    Number(disconnectedInboundDb.prepare("SELECT COUNT(*) AS n FROM instagram_messages WHERE mid='synthetic-mid-after-disconnect'").get().n) === 1 &&
      Number(disconnectedInboundDb.prepare("SELECT COUNT(*) AS n FROM instagram_send_queue WHERE state IN ('pending','sending')").get().n) === 0,
    "Post-disconnect inbound message must persist without creating outbound work",
  );
  disconnectedInboundDb.close();
  const registrarAfterDisconnect = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: registrarCookie } });
  const registrarAfterDisconnectStatus = await registrarAfterDisconnect.json();
  assert(
    registrarAfterDisconnectStatus.connected === false &&
      registrarAfterDisconnectStatus.configured === true &&
      Object.keys(registrarAfterDisconnectStatus).sort().join(",") === "configured,connected,enabled,replyMode",
    "Disconnected lead storage must remain available without leaking admin connection details",
  );
  const registrarThreadsAfterDisconnect = await fetch(`${oauthBaseUrl}/api/instagram/threads`, { headers: { Cookie: registrarCookie } });
  assert(registrarThreadsAfterDisconnect.status === 200 && (await registrarThreadsAfterDisconnect.json()).length === 5, "Registrar can still read stored leads after disconnect");
  const switchDb = new DatabaseSync(databasePath);
  switchDb.exec("PRAGMA foreign_keys=OFF; DELETE FROM instagram_send_queue; DELETE FROM instagram_messages; DELETE FROM instagram_threads;");
  const switchNow = new Date().toISOString();
  switchDb.prepare(`INSERT INTO instagram_send_queue(thread_id,state,due_at,created_at,updated_at)
    VALUES(900001,'pending',?,?,?)`).run(switchNow, switchNow, switchNow);
  switchDb.prepare(`INSERT INTO instagram_send_queue(thread_id,state,due_at,created_at,updated_at)
    VALUES(900002,'sending',?,?,?)`).run(switchNow, switchNow, switchNow);
  const prefetchSwitchQueue = switchDb.prepare("SELECT id,revision FROM instagram_send_queue WHERE thread_id=900002").get();
  switchDb.prepare(`UPDATE instagram_send_state SET lease_token='synthetic-switch-prefetch',
    lease_expires_at=?,lease_queue_id=?,lease_revision=?,lease_stage='processing' WHERE id=1`)
    .run(new Date(Date.now() + 60_000).toISOString(), prefetchSwitchQueue.id, prefetchSwitchQueue.revision);
  switchDb.close();
  const pageSwitchState = await beginConnection();
  const pageSwitchCallback = await fetch(
    `${oauthBaseUrl}/api/instagram/oauth/callback?code=synthetic-other-page&state=${pageSwitchState}`,
    { headers: { Cookie: cookie }, redirect: "manual" },
  );
  assert(pageSwitchCallback.headers.get("location") === "/instagram-inbox?connection=success", "A new page may bind when there is no historical lead context");
  const switchedStatus = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: cookie } }).then((response) => response.json());
  assert(switchedStatus.connected && switchedStatus.accountId === "999888777" && switchedStatus.accountUsername === "other_synthetic_business", "Account switch must expose only the newly bound page");
  const switchedDb = new DatabaseSync(databasePath);
  const invalidatedQueue = switchedDb.prepare("SELECT state,error FROM instagram_send_queue ORDER BY thread_id").all();
  const clearedSwitchLease = switchedDb.prepare("SELECT lease_token FROM instagram_send_state WHERE id=1").get();
  assert(
    invalidatedQueue.length === 2 &&
      invalidatedQueue.every((item) => item.state === "failed" && item.error === "account_changed") &&
      clearedSwitchLease.lease_token === null,
    "Account switch must invalidate pending and pre-fetch send jobs atomically",
  );
  switchedDb.close();
  const registrarAfterSwitch = await fetch(`${oauthBaseUrl}/api/instagram/status`, { headers: { Cookie: registrarCookie } }).then((response) => response.json());
  assert(Object.keys(registrarAfterSwitch).sort().join(",") === "configured,connected,enabled,replyMode", "Account identifiers remain admin-only after a page switch");
  assert(!oauthLogs.includes("synthetic-long-lived-token"), "OAuth token must not appear in API logs");
  console.log("Instagram synthetic fixture passed");
  }
} finally {
  child.kill("SIGTERM");
  oauthChild?.kill("SIGTERM");
  await new Promise((resolve) => probe.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(tempRoot, { recursive: true, force: true });
}
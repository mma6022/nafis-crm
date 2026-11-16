import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-dashboard-stats-"));
const databasePath = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"));
await backup(source, databasePath);
source.close();

const db = new DatabaseSync(databasePath);
const salesperson = db.prepare(`SELECT u.id,u.salesperson_id,c.id customer_id,cf.id consultation_id
  FROM users u
  JOIN customers c ON c.salesperson_id=u.salesperson_id
  JOIN consultation_forms cf ON cf.customer_id=c.id
  WHERE u.role='salesperson' AND u.active=1 AND u.salesperson_id IS NOT NULL
  ORDER BY u.id,c.id LIMIT 1`).get();
assert.ok(salesperson, "fixture requires a salesperson with an assigned customer and consultation");
const other = db.prepare(`SELECT c.id customer_id,cf.id consultation_id
  FROM customers c JOIN consultation_forms cf ON cf.customer_id=c.id
  WHERE c.salesperson_id IS NOT ? ORDER BY c.id LIMIT 1`).get(salesperson.salesperson_id);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
const plan = db.prepare("SELECT id FROM loan_plans ORDER BY id LIMIT 1").get();
assert.ok(other && admin && plan, "fixture requires another scoped customer, an admin, and a loan plan");
db.prepare("UPDATE app_roles SET customer_scope='assigned' WHERE slug='salesperson'").run();
db.prepare(`UPDATE contract_generations
  SET provider_contract_id=NULL,provider_file_id=NULL,send_claim_id=NULL,
      job_token=NULL,provider_idempotency_key=NULL`).run();

const timestamp = new Date().toISOString();
const insertApplication = db.prepare(`INSERT INTO loan_applications
  (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,created_at,duration_months,
   plan_id,plan_snapshot_json,condition_snapshot_json,stage,is_pre_registration,updated_at,deleted_at)
  VALUES(?,?,?,?,? ,?,?,?,?,?,?,?,?,?,?)`);
const add = ({ customer, consultation, stage, status = "reviewing", preRegistration = 0, deletedAt = null }) =>
  insertApplication.run(
    consultation, customer, salesperson.id, JSON.stringify([plan.id]), "10000", status, timestamp, 12,
    plan.id, "{}", "{}", stage, preRegistration, timestamp, deletedAt,
  );

for (let index = 0; index < 105; index++) {
  add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "draft" });
}
add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "customer_documents_review" });
add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "completed", status: "approved" });
add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "draft", status: "rejected" });
add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "draft", preRegistration: 1 });
add({ customer: salesperson.customer_id, consultation: salesperson.consultation_id, stage: "draft", deletedAt: timestamp });
add({ customer: other.customer_id, consultation: other.consultation_id, stage: "draft" });
add({ customer: other.customer_id, consultation: other.consultation_id, stage: "completed", status: "approved" });

const secret = randomBytes(32).toString("hex");
const session = (userId) => {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", secret).update(token).digest("hex"),
    userId, new Date(Date.now() + 180_000).toISOString(), timestamp,
  );
  return `crm_session=${token}`;
};
const salespersonCookie = session(salesperson.id);
const adminCookie = session(admin.id);

const salesStages = [
  "draft", "primary_contract_pending_signature", "customer_documents_upload", "guarantor_registration",
  "guarantor_documents_upload", "collateral_upload", "physical_documents_correction",
  "funder_documents_correction", "final_invoice_pending_signature",
];
const expected = (assignedSalespersonId = null, actionableStages = salesStages) => {
  const placeholders = actionableStages.map(() => "?").join(",");
  const params = [...actionableStages];
  const scope = assignedSalespersonId == null ? "" : " AND c.salesperson_id=?";
  if (assignedSalespersonId != null) params.push(assignedSalespersonId);
  const row = db.prepare(`SELECT
      COALESCE(SUM(a.status<>'rejected' AND a.stage IN (${placeholders})),0) awaitingAction,
      COALESCE(SUM(a.status<>'rejected' AND a.stage<>'completed'),0) inProgress,
      COALESCE(SUM(a.status<>'rejected' AND a.stage='completed'),0) completed
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL
      AND (COALESCE(a.is_pre_registration,0)=0 OR a.stage<>'draft')${scope}`).get(...params);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
};
const allActionStages = [
  ...salesStages, "customer_documents_review", "guarantor_documents_review", "collateral_review",
  "expert_approval", "funder_result_review", "physical_documents_review", "wallet_charge_pending", "admin_approval",
];
const salespersonExpected = expected(salesperson.salesperson_id);
const adminExpected = expected(null, allActionStages);
db.close();

const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
socket.close();
const childEnvironment = {
  ...process.env,
  PORT: String(port),
  CRM_DATABASE_PATH: databasePath,
  SESSION_SECRET: secret,
  AUTO_BACKUP_DIR: path.join(temp, "backups"),
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9/fixture-disabled",
  AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
};
for (const key of [
  "EMZAME_BASE_URL", "EMZAME_BUSINESS_ID", "EMZAME_CERTIFICATE_PATH", "EMZAME_NATIONAL_CODE", "EMZAME_PASSWORD",
  "ICS24_BASE_URL", "ICS24_BRIDGE_KEY_ID", "ICS24_BRIDGE_SHARED_SECRET", "ICS24_BRIDGE_URL", "ICS24_PASSWORD", "ICS24_USERNAME",
  "IR_RELAY_SHARED_SECRET", "OPENAI_API_KEY", "PAYMENT_CALLBACK_BASE_URL", "SAPI_API_BASE_URL", "SAPI_API_TOKEN", "SAPI_RELAY_URL",
  "TELEGRAM_BOT_TOKEN", "ZARINPAL_MERCHANT_ID", "GEMINI_API_KEY", "GEMINI_MODEL",
]) delete childEnvironment[key];
const child = spawn(process.execPath, ["--enable-source-maps", "dist/index.mjs"], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const apiBase = `http://127.0.0.1:${port}`;
const get = (route, cookie) => fetch(apiBase + route, { headers: { Cookie: cookie } });

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${apiBase}/api/healthz`)).ok) { ready = true; break; }
    } catch { /* API is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not start: ${logs.slice(-1200)}`);

  const salespersonResponse = await get("/api/loan-applications/dashboard-stats", salespersonCookie);
  assert.equal(salespersonResponse.status, 200);
  assert.deepEqual(await salespersonResponse.json(), salespersonExpected, "salesperson counts use action policy and assigned-customer scope");
  assert.ok(salespersonExpected.awaitingAction >= 105, "aggregate count is not capped at list page size");

  const listResponse = await get("/api/loan-applications?caseScope=in-progress&limit=100", salespersonCookie);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.items.length, 100, "filtered list remains paginated independently from aggregate stats");
  assert.ok(list.items.every((item) => item.status !== "rejected" && item.stage !== "completed"));

  const adminResponse = await get("/api/loan-applications/dashboard-stats", adminCookie);
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(await adminResponse.json(), adminExpected, "admin sees all customers and all actionable workflow stages");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
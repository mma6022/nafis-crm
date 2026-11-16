import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-loan-workflow-"));
const databasePath = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"));
await backup(source, databasePath);
source.close();

const db = new DatabaseSync(databasePath);
const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
ensureColumn("loan_applications", "requested_duration_months", "INTEGER");
ensureColumn("contract_generations", "loan_application_id", "INTEGER");
ensureColumn("contract_generations", "mappings_snapshot_json", "TEXT");
ensureColumn("contract_generations", "superseded_at", "TEXT");
db.exec("DROP INDEX IF EXISTS idx_contract_generations_application_binding");
const base = db.prepare(`SELECT c.id customer_id,cf.id consultation_id
  FROM customers c JOIN consultation_forms cf ON cf.customer_id=c.id ORDER BY cf.id LIMIT 1`).get();
const plan = db.prepare("SELECT id,contract_template_id,primary_contract_template_id FROM loan_plans ORDER BY id LIMIT 1").get();
assert.ok(base && plan, "fixture needs a customer consultation and plan");

// This fixture tests workflow roles rather than customer assignment.
db.prepare("UPDATE app_roles SET customer_scope='all' WHERE slug='salesperson'").run();
const timestamp = new Date().toISOString();
const fixturePassword = "FixtureOnly!Loan2026";
const passwordHash = (password) => {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  return `scrypt:32768:8:1$${salt}$${hash}`;
};
const makeUser = (username, role) => {
  db.prepare("DELETE FROM users WHERE username=?").run(username);
  return {
    id: Number(db.prepare(`INSERT INTO users(username,password_hash,full_name,role,active,created_at)
      VALUES(?,?,?,?,1,?)`).run(username, passwordHash(fixturePassword), `Fixture ${role}`, role, timestamp).lastInsertRowid),
    username,
  };
};
const admin = makeUser("fixture_loan_admin", "admin");
const registrar = makeUser("fixture_loan_registrar", "registrar");
const salesperson = makeUser("fixture_loan_sales", "salesperson");
const makeApplication = (stage) => {
  const result = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,created_at,duration_months,plan_id,plan_snapshot_json,condition_snapshot_json,stage,is_pre_registration,updated_at)
    VALUES(?,?,?,?,?,'reviewing',?,12,?,?,?, ?,0,?)`).run(
    base.consultation_id, base.customer_id, salesperson.id, JSON.stringify([plan.id]), "10000",
    timestamp, plan.id, JSON.stringify({ deduct_percents: "10" }), "{}", stage, timestamp,
  );
  return Number(result.lastInsertRowid);
};
const makeApprovalApplication = (requestedAmount = "10000", requestedDuration = 12, deductPercents = { 6: "20", 12: "10" }) => {
  const result = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,created_at,duration_months,requested_duration_months,plan_id,
     plan_snapshot_json,condition_snapshot_json,stage,is_pre_registration,updated_at)
     VALUES(?,?,?,?,?,'reviewing',?,?,?,?,?,?, 'funder_initial_approval',0,?)`).run(
    base.consultation_id, base.customer_id, salesperson.id, JSON.stringify([plan.id]), requestedAmount,
    timestamp, requestedDuration, requestedDuration, plan.id,
    JSON.stringify({ principal_amount: "50000", installment_terms: JSON.stringify([6, 12]), deduct_percents: JSON.stringify(deductPercents) }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([6, 12]) }), timestamp,
  );
  return Number(result.lastInsertRowid);
};
const higherApproval = makeApprovalApplication();
const lowerApproval = makeApprovalApplication();
const invalidApproval = makeApprovalApplication();
const concurrentApproval = makeApprovalApplication();
const initialRejectedApplication = makeApprovalApplication();
const wrongStageApproval = makeApplication("draft");
const failedPdfRetryApplication = makeApplication("draft");
const legacyFinalApproval = makeApprovalApplication();
db.prepare("UPDATE loan_applications SET stage='expert_approval',approved_amount=requested_amount,net_amount='9000' WHERE id=?").run(legacyFinalApproval);
const legacyAdminCredit = makeApprovalApplication();
db.prepare("UPDATE loan_applications SET stage='admin_approval',approved_amount=requested_amount,net_amount='9000',funder_decision='approved' WHERE id=?").run(legacyAdminCredit);
const addPhysicalCheck = (applicationId, status = "pending", sourceId = applicationId) => Number(db.prepare(`INSERT INTO loan_physical_checks
  (application_id,source,source_id,label,status) VALUES(?,'document',?,'مدرک آزمون',?)`)
  .run(applicationId, sourceId, status).lastInsertRowid);

const mainApplication = makeApplication("physical_documents_review");
addPhysicalCheck(mainApplication);
const repeatApplication = makeApplication("physical_documents_review");
const repeatCheck = addPhysicalCheck(repeatApplication);
const repeatPendingCheck = addPhysicalCheck(repeatApplication, "pending", repeatApplication + 1);
const customerReviewApplication = makeApplication("customer_documents_review");
db.prepare(`INSERT INTO loan_application_documents
  (application_id,requirement_key,label,source,status,incomplete_reason,created_at)
  VALUES(?,'fixture_defect','مدرک دارای نقص','manual','incomplete','دلیل نقص قبلی',?)`)
  .run(customerReviewApplication, timestamp);
db.prepare(`INSERT INTO loan_application_documents
  (application_id,requirement_key,label,source,status,created_at)
  VALUES(?,'fixture_pending','مدرک در انتظار','manual','pending',?)`)
  .run(customerReviewApplication, timestamp);
const overrideApplication = makeApplication("wallet_charge_pending");
const browserApplication = makeApplication("physical_documents_review");
addPhysicalCheck(browserApplication);
const legacyPhysicalApplication = makeApplication("physical_documents_review");
const legacyPhysicalFile = path.join(temp, "legacy-physical.pdf");
await writeFile(legacyPhysicalFile, "fixture physical document");
const fixturePdf = path.join(temp, "fixture-signed.pdf");
await writeFile(fixturePdf, "fixture signed contract pdf");
const fixturePdfHash = createHash("sha256").update("fixture signed contract pdf").digest("hex");
db.prepare(`INSERT INTO loan_application_documents
  (application_id,requirement_key,label,source,status,storage_path,created_at)
  VALUES(?,'fixture_legacy','مدرک قدیمی','manual','uploaded',?,?)`)
  .run(legacyPhysicalApplication, legacyPhysicalFile, timestamp);
const emptyPhysicalApplication = makeApplication("physical_documents_review");
// A copied production database must be inert: background signature polling
// must not have any provider identifiers to act on.
db.prepare(`UPDATE contract_generations
  SET provider_contract_id=NULL,provider_file_id=NULL,send_claim_id=NULL,
      job_token=NULL,provider_idempotency_key=NULL`).run();
const fixtureTemplate = Number(db.prepare(`INSERT INTO contract_templates
  (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
  VALUES('Fixture primary contract','fixture.docx','fixture.docx','fixture', '[]','[]',?,?,?)`)
  .run(admin.id, timestamp, timestamp).lastInsertRowid);
const failedPdfGeneration = Number(db.prepare(`INSERT INTO contract_generations
  (template_id,customer_id,loan_plan_id,loan_application_id,docx_path,docx_sha256,manual_values_json,status,error_message,
   superseded_at,created_by,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,'failed','PDF conversion failed',?,?,?,?)`).run(
  fixtureTemplate, base.customer_id, plan.id, failedPdfRetryApplication, fixturePdf, "failed-docx", "{}",
  timestamp, admin.id, timestamp, timestamp,
).lastInsertRowid);
const retriedPdfGeneration = Number(db.prepare(`INSERT INTO contract_generations
  (template_id,customer_id,loan_plan_id,loan_application_id,docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,
   created_by,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,'generated',?,?,?)`).run(
  fixtureTemplate, base.customer_id, plan.id, failedPdfRetryApplication, fixturePdf, fixturePdf, "retry-docx", "retry-pdf", "{}",
  admin.id, timestamp, timestamp,
).lastInsertRowid);
const makeSignedPrimary = (applicationId, persistedValues, mappingsSnapshot = null, applicationBound = false, createApplicationLink = true) => {
  const mappings = [
    { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
    ...(applicationBound ? [] : [{ variable: "installments", sourceType: "loanPlan", loanPlanField: "loanPlan.installments" }]),
  ];
  const manualMapping = { variable: "manualNote", sourceType: "manual", label: "توضیحات" };
  const templateMappings = applicationBound ? [...mappings, manualMapping] : mappings;
  const generationMappings = applicationBound ? templateMappings : mappingsSnapshot;
  const templateId = Number(fixtureWrite(`INSERT INTO contract_templates
    (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    `Fixture primary ${applicationId}`, "fixture.docx", fixturePdf, "fixture", JSON.stringify(templateMappings.map((mapping) => mapping.variable)),
    JSON.stringify(templateMappings), admin.id, timestamp, timestamp,
  ).lastInsertRowid);
  const appTerms = inspect("SELECT plan_snapshot_json FROM loan_applications WHERE id=?", applicationId);
  const termsSnapshot = JSON.parse(appTerms.plan_snapshot_json);
  termsSnapshot.id = plan.id;
  termsSnapshot.contract_template_id = templateId;
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=? WHERE id=?", JSON.stringify(termsSnapshot), applicationId);
  const generationId = Number(fixtureWrite(`INSERT INTO contract_generations
    (template_id,customer_id,loan_plan_id,loan_application_id,mappings_snapshot_json,docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,
     provider_contract_id,provider_status,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'signed',?,'signed',?,?,?)`,
    templateId, base.customer_id, plan.id, applicationBound ? applicationId : null, generationMappings == null ? null : JSON.stringify(generationMappings),
    fixturePdf, fixturePdf, "fixture-docx", fixturePdfHash, JSON.stringify(persistedValues),
    `fixture-primary-${applicationId}`, admin.id, timestamp, timestamp,
  ).lastInsertRowid);
  if (createApplicationLink) fixtureWrite(`INSERT INTO loan_application_generated_documents
    (application_id,kind,contract_generation_id,link,created_at) VALUES(?,'primary',? ,?,?)`,
  applicationId, generationId, `signed:fixture-primary-${applicationId}`, timestamp);
  return generationId;
};
const unboundGeneration = Number(db.prepare(`INSERT INTO contract_generations
  (template_id,customer_id,loan_plan_id,docx_path,pdf_path,docx_sha256,pdf_sha256,manual_values_json,status,
   provider_contract_id,provider_status,created_by,created_at,updated_at)
  VALUES(?,?,?, ?,?,?,?,?, 'sent','fixture-unrelated-contract','sent',?,?,?)`).run(
  fixtureTemplate, base.customer_id, plan.id, fixturePdf, fixturePdf, "fixture-docx", "fixture-pdf", "{}",
  admin.id, timestamp, timestamp,
).lastInsertRowid);

const secret = randomBytes(32).toString("hex");
const session = (userId) => {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", secret).update(token).digest("hex"),
    userId, new Date(Date.now() + 180_000).toISOString(), timestamp,
  );
  return `crm_session=${token}`;
};
const cookies = {
  admin: session(admin.id),
  registrar: session(registrar.id),
  salesperson: session(salesperson.id),
};
// Keep the fixture connection open: later scenarios create additional isolated cases.

const keepFixture = process.env.KEEP_FIXTURE === "1";
let port;
if (keepFixture) {
  port = Number(process.env.FIXTURE_PORT ?? 4317);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536, "FIXTURE_PORT must be a valid port");
} else {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  port = socket.address().port;
  socket.close();
}
const childEnvironment = {
  ...process.env,
  PORT: String(port),
  CRM_DATABASE_PATH: databasePath,
  SESSION_SECRET: secret,
  AUTO_BACKUP_DIR: path.join(temp, "backups"),
  // The integration client validates configuration at import time. Point it
  // at an unreachable local address with a fixture-only key so no real AI
  // credential or external endpoint is available to this process.
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9/fixture-disabled",
  AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-disabled",
};
for (const key of [
  "EMZAME_BASE_URL", "EMZAME_BUSINESS_ID", "EMZAME_CERTIFICATE_PATH", "EMZAME_NATIONAL_CODE", "EMZAME_PASSWORD",
  "ICS24_BASE_URL", "ICS24_BRIDGE_KEY_ID", "ICS24_BRIDGE_SHARED_SECRET", "ICS24_BRIDGE_URL", "ICS24_PASSWORD", "ICS24_USERNAME",
  "IR_RELAY_SHARED_SECRET", "OPENAI_API_KEY", "PAYMENT_CALLBACK_BASE_URL", "SAPI_API_BASE_URL", "SAPI_API_TOKEN", "SAPI_RELAY_URL",
  "TELEGRAM_BOT_TOKEN", "ZARINPAL_MERCHANT_ID", "GEMINI_API_KEY", "GEMINI_MODEL",
]) delete childEnvironment[key];
const provider = createHttpServer((req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && req.url?.endsWith("/login")) return respond(200, { accessToken: "fixture-provider-token" });
  if (req.method === "GET" && /^\/api\/v1\/backoffice\/contracts\/[^/]+$/.test(req.url ?? "")) {
    return respond(200, { status: "readyForSign" });
  }
  return respond(404, { error: "fixture_provider_route_not_found" });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
Object.assign(childEnvironment, {
  EMZAME_BASE_URL: `http://127.0.0.1:${provider.address().port}/api/v1/backoffice`,
  EMZAME_BUSINESS_ID: "fixture-business",
  EMZAME_NATIONAL_CODE: "fixture-national-code",
  EMZAME_PASSWORD: "fixture-password",
});
const child = spawn(process.execPath, ["--enable-source-maps", "dist/index.mjs"], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const apiBase = `http://127.0.0.1:${port}`;
const request = async (route, init) => {
  try {
    return await fetch(apiBase + route, init);
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error(`Fixture API request failed for ${route}: ${error instanceof Error ? error.message : error}; child exit=${child.exitCode}, signal=${child.signalCode}\n${logs.slice(-4000)}`);
  }
};
const get = (route, cookie) => request(route, { headers: { Cookie: cookie } });
const post = (route, body, cookie) => request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
const expectStatus = async (response, status, message) => {
  response = await response;
  const body = await response.json();
  assert.equal(response.status, status, `${message}: ${JSON.stringify(body)}`);
  return body;
};
const inspect = (sql, ...params) => {
  const check = new DatabaseSync(databasePath);
  try { return check.prepare(sql).get(...params); } finally { check.close(); }
};
const fixtureWrite = (sql, ...params) => {
  const check = new DatabaseSync(databasePath);
  try { return check.prepare(sql).run(...params); } finally { check.close(); }
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${apiBase}/api/healthz`)).ok) { ready = true; break; }
    } catch { /* API is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not start: ${logs.slice(-1200)}`);
  assert.equal(inspect("SELECT COUNT(*) count FROM contract_generations WHERE loan_application_id=?", failedPdfRetryApplication).count, 2,
    "failed generation audit row is retained alongside its retry");
  assert.ok(inspect("SELECT superseded_at FROM contract_generations WHERE id=?", failedPdfGeneration).superseded_at,
    "failed PDF generation releases its active application binding");
  assert.equal(inspect("SELECT superseded_at FROM contract_generations WHERE id=?", retriedPdfGeneration).superseded_at, null,
    "replacement generation holds the unique active application binding");
  assert.throws(() => fixtureWrite(`INSERT INTO contract_generations
    (template_id,customer_id,loan_plan_id,loan_application_id,docx_path,docx_sha256,manual_values_json,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'generated',?,?,?)`,
  fixtureTemplate, base.customer_id, plan.id, failedPdfRetryApplication, fixturePdf, "duplicate-active", "{}", admin.id, timestamp, timestamp),
  /UNIQUE constraint failed/, "a successful active generation cannot be replaced without superseding");

  const initialApprove = (id, approvedAmount, cookie = cookies.registrar, extra = {}) =>
    post(`/api/loan-applications/${id}/funder-initial-approve`, { approvedAmount, ...extra }, cookie);
  const increasedTerms = await expectStatus(initialApprove(higherApproval, "20000", cookies.registrar, { reason: "تأیید اولیه" }), 200,
    "higher initial approval within snapshotted ceiling is allowed");
  assert.equal(increasedTerms.stage, "draft");
  assert.equal(increasedTerms.approvedAmount, "20000");
  assert.equal(increasedTerms.requestedDurationMonths, 12);
  assert.equal(increasedTerms.durationMonths, 12);
  assert.equal(increasedTerms.netAmount, "18000");
  await expectStatus(initialApprove(higherApproval, "20000"), 403, "duplicate initial approval is denied");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='funder-initial-approve'", higherApproval).count, 1);
  assert.equal(inspect("SELECT initial_approval_by_user_id FROM loan_applications WHERE id=?", higherApproval).initial_approval_by_user_id, registrar.id);
  const decreasedTerms = await expectStatus(initialApprove(lowerApproval, "5000"), 200, "lower initial principal is allowed");
  assert.equal(decreasedTerms.stage, "draft");
  assert.equal(decreasedTerms.netAmount, "4500");
  await expectStatus(initialApprove(invalidApproval, "10000", cookies.salesperson), 403, "salesperson cannot approve initial terms");
  await expectStatus(initialApprove(wrongStageApproval, "10000"), 403, "initial approval is rejected outside initial stage");
  await expectStatus(initialApprove(invalidApproval, "0"), 400, "zero principal is invalid");
  await expectStatus(initialApprove(invalidApproval, 10000), 400, "principal must be supplied as a decimal integer string");
  await expectStatus(initialApprove(invalidApproval, "50001"), 422, "snapshotted plan ceiling is enforced");
  await expectStatus(initialApprove(invalidApproval, "10000"), 200, "valid initial approval proceeds after invalid requests");
  fixtureWrite("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?", JSON.stringify({ manualNote: "Fixture terms" }), invalidApproval);
  makeSignedPrimary(invalidApproval, { principal: "9999", manualNote: "Fixture terms" }, [
    { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
  ], true, false);
  const mismatchedPrimary = inspect("SELECT id FROM contract_generations WHERE loan_application_id=? AND superseded_at IS NULL", invalidApproval);
  await expectStatus(post(`/api/contracts/generations/${mismatchedPrimary.id}/send`, {}, cookies.salesperson), 409,
    "bound primary with an unapproved principal cannot be sent");
  await expectStatus(post(`/api/loan-applications/${invalidApproval}/generated-documents`, {
    kind: "primary", contractGenerationId: mismatchedPrimary.id,
  }, cookies.salesperson), 409, "bound primary with a principal different from approved terms is rejected");
  const rejectedInitial = await expectStatus(post(`/api/loan-applications/${initialRejectedApplication}/funder-initial-reject`, {
    reason: "شرایط تأیید نشد",
  }, cookies.registrar), 200, "initial provider rejection is terminal");
  assert.equal(rejectedInitial.status, "rejected");
  assert.equal(rejectedInitial.actionRequired, false);
  await expectStatus(initialApprove(initialRejectedApplication, "10000"), 403, "rejected initial application cannot be approved");
  const concurrentResponses = await Promise.all([
    initialApprove(concurrentApproval, "12000"),
    initialApprove(concurrentApproval, "12000"),
  ]);
  assert.equal(concurrentResponses.filter((response) => response.status === 200).length, 1, "only one concurrent initial approval wins");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='funder-initial-approve'", concurrentApproval).count, 1);
  fixtureWrite("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?", JSON.stringify({ manualNote: "Fixture terms" }), higherApproval);
  makeSignedPrimary(higherApproval, { principal: "20,000", manualNote: "Fixture terms" }, [
    { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
  ], true, false);
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
    JSON.stringify({ principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), mainApplication);
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
    JSON.stringify({ principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), overrideApplication);
  makeSignedPrimary(mainApplication, { principal: "10000", installments: "12" });
  makeSignedPrimary(overrideApplication, { principal: "10000", installments: "12" });
  makeSignedPrimary(legacyFinalApproval, { principal: "20,000", installments: "12" });
  makeSignedPrimary(legacyAdminCredit, { principal: "25,000", installments: "12" });
  const legacyPdfPath = path.join(temp, "contracts", "generations", "bbbbbbbbbbbbbbbbbbbbbbbb.pdf");
  await writeFile(legacyPdfPath, "fixture signed contract pdf");
  for (const legacyId of [mainApplication, overrideApplication, legacyFinalApproval, legacyAdminCredit]) fixtureWrite(
    "UPDATE contract_generations SET pdf_path=?,pdf_sha256=? WHERE provider_contract_id=?",
    legacyPdfPath, fixturePdfHash, `fixture-primary-${legacyId}`,
  );
  const boundPrimary = inspect("SELECT id FROM contract_generations WHERE loan_application_id=? AND superseded_at IS NULL", higherApproval);
  const sendPdfPath = path.join(temp, "contracts", "generations", "aaaaaaaaaaaaaaaaaaaaaaaa.pdf");
  await writeFile(sendPdfPath, "fixture preapproved primary pdf");
  const sendPdfHash = createHash("sha256").update("fixture preapproved primary pdf").digest("hex");
  fixtureWrite("UPDATE contract_generations SET status='generated',provider_contract_id=NULL,provider_status=NULL,pdf_path=?,pdf_sha256=? WHERE id=?",
    sendPdfPath, sendPdfHash, boundPrimary.id);
  const firstSend = await expectStatus(post(`/api/contracts/generations/${boundPrimary.id}/send`, {}, cookies.salesperson), 503,
    "approved bound primary passes stage/scope/value validation before disabled provider configuration");
  assert.equal(firstSend.error, "provider_configuration");
  fixtureWrite("UPDATE contract_generations SET status='signed',provider_contract_id=?,provider_status='signed' WHERE id=?",
    `fixture-primary-${higherApproval}`, boundPrimary.id);
  const boundSendRetry = await expectStatus(post(`/api/contracts/generations/${boundPrimary.id}/send`, {}, cookies.salesperson), 200,
    "matching approved bound primary supports an idempotent send retry");
  assert.equal(boundSendRetry.providerContractId, `fixture-primary-${higherApproval}`);
  await expectStatus(post(`/api/loan-applications/${higherApproval}/generated-documents`, {
    kind: "primary", contractGenerationId: unboundGeneration,
  }, cookies.salesperson), 409, "new preapproved app rejects unrelated unbound primary generations");
  await expectStatus(post(`/api/loan-applications/${higherApproval}/generated-documents`, {
    kind: "primary", contractGenerationId: boundPrimary.id,
  }, cookies.salesperson), 201, "matching application-bound primary generation links");
  await expectStatus(post(`/api/loan-applications/${higherApproval}/generated-documents`, {
    kind: "primary", contractGenerationId: boundPrimary.id,
  }, cookies.salesperson), 200, "primary generation link is idempotent");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", higherApproval).stage, "draft");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", higherApproval).count, 0,
    "no money is posted at initial approval or primary issuance");
  await expectStatus(post(`/api/loan-applications/${higherApproval}/admin-approve`, {}, cookies.admin), 409,
    "wallet credit remains gated before final provider approval and later stages");

  const finalApproval = makeApplication("expert_approval");
  fixtureWrite(`UPDATE loan_applications SET approved_amount='12345',net_amount='11110',initial_approval_at=?,initial_approval_by_user_id=?,
    approved_amount_source='initial_provider_approval',funder_decision=NULL,plan_snapshot_json=?,condition_snapshot_json=?,primary_manual_values_json=?
    WHERE id=?`,
  timestamp, registrar.id, JSON.stringify({ principal_amount: "50000", deduct_percents: "10" }),
  JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }),
  JSON.stringify({ manualNote: "Fixture terms" }), finalApproval);
  const finalPrimaryGeneration = makeSignedPrimary(finalApproval, { principal: "12345", manualNote: "Fixture terms" }, null, true);
  fixtureWrite("UPDATE contract_generations SET pdf_path=?,pdf_sha256=? WHERE id=?", legacyPdfPath, fixturePdfHash, finalPrimaryGeneration);
  fixtureWrite("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?", finalPrimaryGeneration, finalApproval);
  await expectStatus(post(`/api/loan-applications/${finalApproval}/expert-approve`, { approvedAmount: "1", durationMonths: 6 }, cookies.registrar), 400,
    "final approval does not accept financial edits");
  await expectStatus(post(`/api/loan-applications/${finalApproval}/expert-approve`, {}, cookies.salesperson), 403,
    "salesperson cannot make final provider decision");
  const finalResult = await expectStatus(post(`/api/loan-applications/${finalApproval}/expert-approve`, {}, cookies.registrar), 200,
    "registrar may make final approval");
  await expectStatus(post(`/api/loan-applications/${finalApproval}/expert-approve`, {}, cookies.registrar), 403,
    "final provider approval cannot be applied a second time");
  assert.equal(finalResult.stage, "funder_result_review");
  assert.deepEqual({ ...inspect("SELECT approved_amount,net_amount,duration_months FROM loan_applications WHERE id=?", finalApproval) },
    { approved_amount: "12345", net_amount: "11110", duration_months: 12 }, "final approval leaves financial terms unchanged");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", finalApproval).count, 0,
    "no money is credited by final provider approval");
  const legacyFinalResult = await expectStatus(post(`/api/loan-applications/${legacyFinalApproval}/expert-approve`, {}, cookies.registrar), 200,
    "legacy final approval reconciles terms from its signed primary");
  assert.equal(legacyFinalResult.approvedAmount, "20000");
  const legacyFinalTerms = inspect("SELECT requested_amount,approved_amount,net_amount,approved_amount_source,approved_amount_generation_id FROM loan_applications WHERE id=?", legacyFinalApproval);
  assert.deepEqual({ ...legacyFinalTerms }, {
    requested_amount: "10000", approved_amount: "20000", net_amount: "18000",
    approved_amount_source: "signed_primary_reconciliation",
    approved_amount_generation_id: inspect("SELECT id FROM contract_generations WHERE provider_contract_id=?", `fixture-primary-${legacyFinalApproval}`).id,
  }, "legacy reconciliation preserves request and audits signed-principal provenance");
  const legacyCreditResult = await expectStatus(post(`/api/loan-applications/${legacyAdminCredit}/admin-approve`, {}, cookies.admin), 200,
    "legacy case already past final reconciles before wallet credit");
  assert.equal(legacyCreditResult.approvedAmount, "25000");
  assert.equal(inspect("SELECT amount FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?", legacyAdminCredit, `loan-application:${legacyAdminCredit}:credit`).amount, "22500",
    "legacy admin credit is based on the verified signed principal, not the requested-amount fallback");
  const finalRejected = makeApplication("expert_approval");
  const finalRejectResult = await expectStatus(post(`/api/loan-applications/${finalRejected}/expert-reject`, {
    reason: "تأیید نهایی دریافت نشد",
  }, cookies.registrar), 200, "final provider rejection is terminal");
  assert.equal(finalRejectResult.status, "rejected");
  assert.equal(finalRejectResult.actionRequired, false);

  const customerReview = await expectStatus(get(`/api/loan-applications/${customerReviewApplication}`, cookies.registrar), 200, "registrar detail exposes checklist review state");
  assert.deepEqual(customerReview.registrarReview, {
    stage: "customer_documents_review",
    allReviewed: false,
    allApproved: false,
    hasDefect: true,
  }, "a document defect is reported independently of pending documents");
  await expectStatus(post(`/api/loan-applications/${customerReviewApplication}/review-customer-documents`, {}, cookies.registrar), 409, "registrar cannot advance before all review items are approved");
  const returnedCustomerReview = await expectStatus(post(`/api/loan-applications/${customerReviewApplication}/return-customer-documents`, {
    reason: "بازگشت برای اصلاح نقص ثبت‌شده",
  }, cookies.registrar), 200, "registrar can return a known defect while other review items are pending");
  assert.equal(returnedCustomerReview.stage, "customer_documents_upload");
  assert.equal(inspect("SELECT reason FROM loan_application_stage_history WHERE application_id=? AND action='return-customer-documents' ORDER BY id DESC LIMIT 1", customerReviewApplication).reason, "بازگشت برای اصلاح نقص ثبت‌شده");

  await expectStatus(post(`/api/loan-applications/${mainApplication}/approve-physical-documents`, {}, cookies.salesperson), 403, "salesperson cannot attest physical review");
  const pendingPhysical = await expectStatus(post(`/api/loan-applications/${mainApplication}/approve-physical-documents`, {}, cookies.registrar), 409, "pending physical checklist blocks advancement");
  assert.equal(pendingPhysical.code, "physical_documents_incomplete");
  const mainCheck = inspect("SELECT id FROM loan_physical_checks WHERE application_id=?", mainApplication);
  await expectStatus(post(`/api/loan-applications/${mainApplication}/physical-checks/${mainCheck.id}/review`, {
    decision: "approved",
  }, cookies.registrar), 200, "registrar approves each physical check individually");
  const physicalApproved = await expectStatus(post(`/api/loan-applications/${mainApplication}/approve-physical-documents`, {}, cookies.registrar), 200, "registrar aggregate physical approval");
  assert.equal(physicalApproved.stage, "wallet_charge_pending");
  assert.equal(physicalApproved.actionRequired, true);
  assert.equal(physicalApproved.actionRole, "registrar");
  assert.equal(inspect("SELECT status FROM loan_physical_checks WHERE application_id=?", mainApplication).status, "approved");
  await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/prepare-physical-checks`, {}, cookies.salesperson), 403, "physical checklist initialization is registrar-only");
  const preparedLegacy = await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/prepare-physical-checks`, {}, cookies.registrar), 200, "registrar initializes a legacy physical checklist");
  assert.equal(preparedLegacy.physicalChecks.length, 1);
  assert.equal(preparedLegacy.physicalChecks[0].status, "pending");
  await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/prepare-physical-checks`, {}, cookies.registrar), 200, "legacy checklist initialization is idempotent");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_physical_checks WHERE application_id=?", legacyPhysicalApplication).count, 1);
  const legacyPending = await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/approve-physical-documents`, {}, cookies.registrar), 409, "legacy pending checklist blocks advancement");
  assert.equal(legacyPending.code, "physical_documents_incomplete");
  await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/physical-checks/${preparedLegacy.physicalChecks[0].id}/review`, {
    decision: "approved",
  }, cookies.registrar), 200, "registrar reviews the initialized legacy check");
  await expectStatus(post(`/api/loan-applications/${legacyPhysicalApplication}/approve-physical-documents`, {}, cookies.registrar), 200, "approved legacy checklist advances");
  assert.equal(inspect("SELECT status FROM loan_physical_checks WHERE application_id=?", legacyPhysicalApplication).status, "approved");
  const noLegacySources = await expectStatus(post(`/api/loan-applications/${emptyPhysicalApplication}/prepare-physical-checks`, {}, cookies.registrar), 409, "legacy initialization without source documents is blocked");
  assert.equal(noLegacySources.code, "physical_documents_missing");
  const emptyPhysical = await expectStatus(post(`/api/loan-applications/${emptyPhysicalApplication}/approve-physical-documents`, {}, cookies.registrar), 409, "physical review with no real source remains blocked");
  assert.equal(emptyPhysical.code, "physical_documents_missing");

  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${repeatCheck}/review`, {
    decision: "incomplete", reason: "نقص مشخص",
  }, cookies.registrar), 200, "registrar marks known deficiency");
  const mixedReview = await expectStatus(get(`/api/loan-applications/${repeatApplication}`, cookies.registrar), 200, "registrar detail reports mixed review state");
  assert.deepEqual(mixedReview.registrarReview, {
    stage: "physical_documents_review",
    allReviewed: false,
    allApproved: false,
    hasDefect: true,
  }, "a known defect remains actionable while another item is pending");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/approve-physical-documents`, {}, cookies.registrar), 409, "known deficiency blocks aggregate approval");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/return-physical-documents`, {
    reason: "نقص عمومی مرحله اول",
  }, cookies.registrar), 200, "general return reason is recorded");
  assert.equal(inspect("SELECT reason FROM loan_physical_checks WHERE id=?", repeatCheck).reason, "نقص مشخص", "item deficiency reason is preserved through return");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${repeatCheck}/correct`, {
    note: "اصلاح مورد مشخص",
  }, cookies.salesperson), 200, "sales corrects marked check");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/resubmit-physical-documents`, {}, cookies.salesperson), 200, "first physical resubmit");

  const noPhysicalDefect = await expectStatus(post(`/api/loan-applications/${repeatApplication}/return-physical-documents`, {
    reason: "نقص عمومی مرحله دوم",
  }, cookies.registrar), 409, "reviewer cannot return physical checklist without an explicit defect");
  assert.equal(noPhysicalDefect.code, "physical_defect_required");
  const generalReview = await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/general/review`, {
    reason: "نقص عمومی مرحله دوم",
  }, cookies.registrar), 200, "registrar can explicitly mark a general physical deficiency");
  let general = inspect("SELECT id,status,reason FROM loan_physical_checks WHERE application_id=? AND source='general' AND source_id=0", repeatApplication);
  assert.equal(general.id, generalReview.id);
  assert.equal(general.reason, "نقص عمومی مرحله دوم");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/return-physical-documents`, {
    reason: "بازگشت مرحله دوم",
  }, cookies.registrar), 200, "reviewer can return after marking a general deficiency");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${general.id}/correct`, {
    note: "اصلاح مجدد",
  }, cookies.salesperson), 200, "sales can correct repeatedly");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/resubmit-physical-documents`, {}, cookies.salesperson), 200, "second physical resubmit");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${repeatCheck}/review`, {
    decision: "approved",
  }, cookies.registrar), 200, "registrar approves corrected physical check");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${repeatPendingCheck}/review`, {
    decision: "approved",
  }, cookies.registrar), 200, "registrar approves remaining physical check");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/physical-checks/${general.id}/review`, {
    decision: "approved",
  }, cookies.registrar), 200, "registrar approves corrected general deficiency");
  await expectStatus(post(`/api/loan-applications/${repeatApplication}/approve-physical-documents`, {}, cookies.registrar), 200, "resubmission receives a fresh aggregate review");
  assert.equal(inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=? AND action='resubmit-physical-documents'", repeatApplication).count, 2);

  const before = inspect(`SELECT
    COALESCE((SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'),'0') credit,
    COALESCE((SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'),'0') cash`,
    base.customer_id, base.customer_id);
  await expectStatus(post(`/api/loan-applications/${mainApplication}/approve-wallet-charge`, {}, cookies.salesperson), 403, "salesperson cannot perform registrar wallet review");
  const walletReviewed = await expectStatus(post(`/api/loan-applications/${mainApplication}/approve-wallet-charge`, {}, cookies.registrar), 200, "registrar advances wallet review");
  assert.equal(walletReviewed.stage, "admin_approval");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", mainApplication).count, 0, "registrar review must not credit");
  assert.deepEqual(inspect(`SELECT
    COALESCE((SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'),'0') credit,
    COALESCE((SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'),'0') cash`,
    base.customer_id, base.customer_id), before, "registrar review changes no wallet");
  await expectStatus(post(`/api/loan-applications/${overrideApplication}/approve-wallet-charge`, {}, cookies.admin), 200, "admin may override registrar wallet review");

  await expectStatus(post(`/api/loan-applications/${mainApplication}/admin-approve`, {}, cookies.registrar), 403, "admin approval is admin-only");
  const completed = await expectStatus(post(`/api/loan-applications/${mainApplication}/admin-approve`, {}, cookies.admin), 200, "admin completes without final signatures");
  assert.equal(completed.stage, "completed");
  assert.equal(completed.status, "approved");
  await expectStatus(post(`/api/loan-applications/${mainApplication}/admin-approve`, {}, cookies.admin), 200, "admin approval retry is idempotent");
  const after = inspect(`SELECT
    (SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit') credit,
    COALESCE((SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'),'0') cash,
    (SELECT COUNT(*) FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?) entries`,
    base.customer_id, base.customer_id, mainApplication, `loan-application:${mainApplication}:credit`);
  assert.equal(after.credit, (BigInt(before.credit) + 9000n).toString());
  assert.equal(after.cash, before.cash, "loan disbursement must not change cash wallet");
  assert.equal(after.entries, 1, "admin retry must create exactly one credit ledger entry");

  const cartable = await expectStatus(get("/api/loan-applications?actionable=true&stage=wallet_charge_pending", cookies.registrar), 200, "registrar cartable");
  assert.ok(cartable.items.some((item) => item.id === repeatApplication), "wallet-charge work belongs in registrar cartable");

  const signedReuse = makeApplication("primary_contract_pending_signature");
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
    JSON.stringify({ id: plan.id, principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), signedReuse);
  fixtureWrite("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?", JSON.stringify({ manualNote: "Fixture terms" }), signedReuse);
  const signedReuseGeneration = makeSignedPrimary(signedReuse, { principal: "10000", manualNote: "Fixture terms" }, null, true);
  fixtureWrite("UPDATE contract_generations SET provider_status='accept' WHERE id=?", signedReuseGeneration);
  const unsignedReuse = makeApplication("primary_contract_pending_signature");
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
    JSON.stringify({ id: plan.id, principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), unsignedReuse);
  fixtureWrite("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?", JSON.stringify({ manualNote: "Fixture terms" }), unsignedReuse);
  const unsignedReuseGeneration = makeSignedPrimary(unsignedReuse, { principal: "10000", manualNote: "Fixture terms" }, null, true);
  fixtureWrite("UPDATE contract_generations SET status='signed',provider_status='signed' WHERE id=?", unsignedReuseGeneration);
  fixtureWrite("UPDATE loan_application_generated_documents SET link=NULL WHERE application_id=? AND kind='primary'", unsignedReuse);
  const principalMismatch = makeApplication("collateral_upload");
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
    JSON.stringify({ id: plan.id, principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), principalMismatch);
  fixtureWrite("UPDATE loan_applications SET primary_manual_values_json=? WHERE id=?", JSON.stringify({ manualNote: "Fixture terms" }), principalMismatch);
  const staleSignedGeneration = makeSignedPrimary(principalMismatch, { principal: "10000", manualNote: "Fixture terms" }, null, true);
  const staleUnsignedApplication = makeApplication("primary_contract_pending_signature");
  fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=?,primary_manual_values_json=? WHERE id=?",
    JSON.stringify({ id: plan.id, principal_amount: "50000", deduct_percents: "10" }),
    JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }),
    JSON.stringify({ manualNote: "Fixture terms" }), staleUnsignedApplication);
  const staleUnsignedGeneration = makeSignedPrimary(staleUnsignedApplication, { principal: "10000", manualNote: "Fixture terms" }, null, true);
  fixtureWrite("UPDATE contract_generations SET status='sent',provider_status='sent' WHERE id=?", staleUnsignedGeneration);
  fixtureWrite("UPDATE loan_application_generated_documents SET link=NULL WHERE application_id=? AND kind='primary'", staleUnsignedApplication);
  const verifiedFixturePdf = path.join(temp, "contracts", "generations", "cccccccccccccccccccccccc.pdf");
  await writeFile(verifiedFixturePdf, "fixture signed contract pdf");
  for (const generationId of [signedReuseGeneration, unsignedReuseGeneration, staleSignedGeneration, staleUnsignedGeneration]) {
    fixtureWrite("UPDATE contract_generations SET pdf_path=?,pdf_sha256=? WHERE id=?", verifiedFixturePdf, fixturePdfHash, generationId);
  }
  const resetStages = [
    "draft", "primary_contract_pending_signature", "customer_documents_upload", "customer_documents_review",
    "guarantor_registration", "guarantor_documents_upload", "guarantor_documents_review", "collateral_upload",
    "collateral_review", "expert_approval", "funder_amendment_pending_signature", "funder_amendment_review",
    "funder_result_review", "funder_documents_correction", "physical_documents_review", "physical_documents_correction",
    "wallet_charge_pending", "admin_approval", "final_invoice_pending_signature", "draft",
  ];
  const resetCases = resetStages.map((stage) => makeApplication(stage));
  const inventoryMappings = [
    { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
    { variable: "installments", sourceType: "loanPlan", loanPlanField: "loanPlan.installments" },
  ];
  const inventoryGenerations = [];
  for (const [index, id] of resetCases.slice(0, 18).entries()) {
    if (index < 6) fixtureWrite("UPDATE loan_applications SET plan_snapshot_json=?,condition_snapshot_json=? WHERE id=?",
      JSON.stringify({ principal_amount: "50000", deduct_percents: "10" }),
      JSON.stringify({ max_principal: "50000", installment_options: JSON.stringify([12]) }), id);
    inventoryGenerations.push(makeSignedPrimary(id, { principal: "10000", installments: "12" }, inventoryMappings));
  }
  for (const id of resetCases.slice(13, 18)) {
    const generationId = inventoryGenerations[resetCases.indexOf(id)];
    fixtureWrite("UPDATE contract_generations SET status='sent',provider_status='sent' WHERE id=?", generationId);
    fixtureWrite("UPDATE loan_application_generated_documents SET link=NULL WHERE application_id=? AND kind='primary'", id);
  }
  for (const [index, providerStatus] of [
    "unsigned", "not_completed", "incomplete", "not yet signed", "ready to be signed", "readyForSign",
  ].entries()) {
    fixtureWrite("UPDATE contract_generations SET provider_status=? WHERE id=?", providerStatus, inventoryGenerations[index]);
  }
  fixtureWrite(`UPDATE loan_applications SET approved_amount='5432',net_amount='5000',
    approved_amount_source='signed_primary_reconciliation',approved_amount_generation_id=?,
    approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,funder_decision='rejected',
    funder_reason='preserve this decision',expert_reviewed_at=?,admin_approved_at=? WHERE id=?`,
  inventoryGenerations[0], timestamp, registrar.id, timestamp, timestamp, resetCases[0]);
  for (const generationId of inventoryGenerations.slice(0, 13)) {
    fixtureWrite("UPDATE contract_generations SET pdf_path=?,pdf_sha256=? WHERE id=?", verifiedFixturePdf, fixturePdfHash, generationId);
  }
  const excludedCompleted = makeApplication("completed");
  const excludedRejected = makeApplication("draft");
  fixtureWrite("UPDATE loan_applications SET status='rejected' WHERE id=?", excludedRejected);
  const excludedDeleted = makeApplication("draft");
  fixtureWrite("UPDATE loan_applications SET deleted_at=? WHERE id=?", timestamp, excludedDeleted);
  const excludedInitialApproved = makeApplication("expert_approval");
  fixtureWrite("UPDATE loan_applications SET initial_approval_at=?,initial_approval_by_user_id=? WHERE id=?",
    timestamp, registrar.id, excludedInitialApproved);
  const excludedWalletPosted = makeApplication("physical_documents_review");
  let fixtureWallet = inspect("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'", base.customer_id);
  if (!fixtureWallet) {
    fixtureWrite("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'credit','0',?)", base.customer_id, timestamp);
    fixtureWallet = inspect("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'", base.customer_id);
  }
  fixtureWrite(`INSERT INTO wallet_ledger_v2(wallet_id,application_id,amount,kind,idempotency_key,created_at)
    VALUES(?,?, '1','fixture_preexisting_posting',?,?)`, fixtureWallet.id, excludedWalletPosted, `fixture:${excludedWalletPosted}`, timestamp);
  const resetCandidates = [...resetCases, signedReuse, unsignedReuse, principalMismatch, staleUnsignedApplication];
  for (const [index, id] of resetCases.slice(0, 18).entries()) {
    fixtureWrite("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?", inventoryGenerations[index], id);
  }
  for (const [id, generationId] of [
    [signedReuse, signedReuseGeneration],
    [unsignedReuse, unsignedReuseGeneration],
    [principalMismatch, staleSignedGeneration],
    [staleUnsignedApplication, staleUnsignedGeneration],
  ]) fixtureWrite("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?", generationId, id);
  const resetSnapshots = new Map(resetCandidates.map((id) => [id, {
    documents: inspect("SELECT COUNT(*) count FROM loan_application_generated_documents WHERE application_id=?", id).count,
    generations: inspect("SELECT COUNT(*) count FROM contract_generations WHERE loan_application_id=? OR id IN (SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=?)", id, id).count,
    financialAndDecision: inspect(`SELECT requested_amount,requested_duration_months,duration_months,approved_amount,net_amount,
      approved_amount_source,approved_amount_generation_id,approved_amount_reconciled_at,approved_amount_reconciled_by_user_id,
      initial_approval_at,initial_approval_by_user_id,initial_approval_reason,funder_decision,funder_reason,expert_reviewed_at,admin_approved_at
      FROM loan_applications WHERE id=?`, id),
  }]));
  const resetEnv = { ...process.env, CRM_DATABASE_PATH: databasePath };
  const runResetScript = (...args) => execFileSync(process.execPath, ["scripts/reopen-legacy-loans.mjs", ...args], {
    cwd: process.cwd(), env: resetEnv, encoding: "utf8",
  });
  const resetManifestPath = path.join(temp, "legacy-reopen-manifest.json");
  const resetManifest = {
    version: 3,
    inventory: { active: 24, signed: 15, linked: 22, walletPosted: 0, previouslyInitialApproved: 0 },
    applications: resetCandidates.map((id) => {
      const row = inspect(`SELECT a.stage,a.status,a.updated_at,a.current_primary_generation_id,
        (SELECT d.contract_generation_id FROM loan_application_generated_documents d
          WHERE d.application_id=a.id AND d.kind='primary' AND d.contract_generation_id IS NOT NULL ORDER BY d.id DESC LIMIT 1)
          latest_primary_generation_id FROM loan_applications a WHERE a.id=?`, id);
      return {
        id, stage: row.stage, status: row.status, updatedAt: row.updated_at,
        currentPrimaryGenerationId: row.current_primary_generation_id == null ? null : Number(row.current_primary_generation_id),
        latestPrimaryGenerationId: row.latest_primary_generation_id == null ? null : Number(row.latest_primary_generation_id),
      };
    }),
  };
  await writeFile(resetManifestPath, JSON.stringify(resetManifest, null, 2));
  const resetManifestArg = `--manifest=${resetManifestPath}`;
  const resetDryRun = JSON.parse(runResetScript(resetManifestArg));
  assert.equal(resetDryRun.inventory.active, 24);
  assert.equal(resetDryRun.inventory.signed, 15);
  assert.equal(resetDryRun.inventory.linked, 22);
  assert.equal(resetDryRun.inventory.walletPosted, 0);
  assert.equal(resetDryRun.inventory.previouslyInitialApproved, 0);
  runResetScript(resetManifestArg, "--apply", `--backup=${path.join(temp, "before-legacy-reopen.db")}`);
  assert.throws(() => runResetScript(resetManifestArg),
    "repeated manifest run aborts rather than rescanning or reapplying");
  for (const id of resetCandidates) {
    const resetRow = inspect("SELECT stage,status,legacy_reopen_prior_stage,current_primary_generation_id FROM loan_applications WHERE id=?", id);
    assert.equal(resetRow.stage, "funder_initial_approval");
    assert.equal(resetRow.status, "reviewing");
    assert.equal(resetRow.current_primary_generation_id, null);
    assert.ok(resetRow.legacy_reopen_prior_stage);
    assert.equal(inspect("SELECT actor_id FROM loan_application_stage_history WHERE application_id=? AND action='legacy-applications-reopened-for-initial-provider-approval'", id).actor_id, 0);
    assert.deepEqual(inspect(`SELECT requested_amount,requested_duration_months,duration_months,approved_amount,net_amount,
      approved_amount_source,approved_amount_generation_id,approved_amount_reconciled_at,approved_amount_reconciled_by_user_id,
      initial_approval_at,initial_approval_by_user_id,initial_approval_reason,funder_decision,funder_reason,expert_reviewed_at,admin_approved_at
      FROM loan_applications WHERE id=?`, id), resetSnapshots.get(id).financialAndDecision,
    "reset preserves financial and final-decision provenance fields");
    const resetSnapshot = resetSnapshots.get(id);
    assert.deepEqual({
      documents: inspect("SELECT COUNT(*) count FROM loan_application_generated_documents WHERE application_id=?", id).count,
      generations: inspect("SELECT COUNT(*) count FROM contract_generations WHERE loan_application_id=? OR id IN (SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=?)", id, id).count,
    }, { documents: resetSnapshot.documents, generations: resetSnapshot.generations },
    "reset retains generated documents and contract generations");
  }
  for (const id of [excludedCompleted, excludedRejected, excludedDeleted, excludedWalletPosted, excludedInitialApproved]) {
    assert.notEqual(inspect("SELECT stage FROM loan_applications WHERE id=?", id).stage, "funder_initial_approval",
      `manifest reset leaves excluded fixture ${id} untouched`);
  }
  const signedResumed = await expectStatus(initialApprove(signedReuse, "10000"), 200, "matching signed primary resumes prior workflow");
  assert.equal(signedResumed.stage, "customer_documents_upload");
  assert.equal(Number(signedResumed.currentPrimaryGenerationId), signedReuseGeneration);
  const signedWithoutLocalLinkResumed = await expectStatus(initialApprove(unsignedReuse, "10000"), 200,
    "provider-signed generation without local signed link resumes signature verification");
  assert.equal(signedWithoutLocalLinkResumed.stage, "primary_contract_pending_signature");
  assert.equal(Number(signedWithoutLocalLinkResumed.currentPrimaryGenerationId), unsignedReuseGeneration);
  for (const [index, providerStatus] of [
    "unsigned", "not_completed", "incomplete", "not yet signed", "ready to be signed", "readyForSign",
  ].entries()) {
    const applicationId = resetCases[index];
    const routed = await expectStatus(initialApprove(applicationId, "10000"), 200,
      `${providerStatus} provider state cannot authorize signed reuse`);
    assert.equal(routed.stage, "draft");
    assert.equal(routed.currentPrimaryGenerationId, null);
    fixtureWrite("UPDATE loan_applications SET stage='admin_approval',current_primary_generation_id=? WHERE id=?",
      inventoryGenerations[index], applicationId);
    const blockedCredit = await expectStatus(post(`/api/loan-applications/${applicationId}/admin-approve`, {}, cookies.admin), 409,
      `${providerStatus} provider state cannot authorize final credit`);
    assert.equal(blockedCredit.code, "current_primary_contract_required");
    assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", applicationId).count, 0);
  }
  const mismatchRouted = await expectStatus(initialApprove(principalMismatch, "20000"), 200, "principal mismatch requires new bound contract");
  assert.equal(mismatchRouted.stage, "draft");
  assert.equal(mismatchRouted.currentPrimaryGenerationId, null);
  const stalePrimaryDocument = inspect("SELECT id FROM loan_application_generated_documents WHERE application_id=? AND kind='primary'", principalMismatch);
  const staleObservation = await expectStatus(post(`/api/loan-applications/${principalMismatch}/generated-documents/${stalePrimaryDocument.id}/verify-signature`, {}, cookies.salesperson), 200,
    "an authorized manual signature observation is available for a stale signed contract");
  assert.equal(staleObservation.signed, false);
  assert.equal(staleObservation.providerStatus, "readyForSign",
    "the stale document status is a fresh provider observation, not a locally cached signed result");
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", principalMismatch).stage, "draft",
    "observing a stale provider signature cannot advance the application");
  await expectStatus(post(`/api/contracts/generations/${staleSignedGeneration}/send`, {}, cookies.salesperson), 409,
    "stale signed generation cannot authorize sending after mismatch");
  await expectStatus(post(`/api/loan-applications/${principalMismatch}/submit-primary-contract`, {}, cookies.salesperson), 409,
    "stale signed contract cannot satisfy the primary transition");
  const staleUnsignedRouted = await expectStatus(initialApprove(staleUnsignedApplication, "20000"), 200, "unsigned contract principal mismatch routes to new draft");
  assert.equal(staleUnsignedRouted.stage, "draft");
  await expectStatus(post(`/api/contracts/generations/${staleUnsignedGeneration}/send`, {}, cookies.salesperson), 409,
    "stale unsigned contract cannot be sent after mismatch");
  assert.equal(inspect("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE application_id=?", principalMismatch).count, 0,
    "reset and mismatch never post wallet credit");
  console.log("Loan workflow fixture passed: role gates, repeat correction, registrar no-money review, atomic admin credit, retry, and completion.");
  if (keepFixture) {
    console.log(`KEEP_FIXTURE API: http://127.0.0.1:${port}/api`);
    console.log(`KEEP_FIXTURE untouched physical_documents_review loan id: ${browserApplication}`);
    console.log(`KEEP_FIXTURE users: ${salesperson.username}, ${registrar.username}, ${admin.username}`);
    console.log(`KEEP_FIXTURE password (all users): ${fixturePassword}`);
    console.log("Fixture uses an isolated temporary database only. Press Ctrl+C to stop and remove it.");
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  db.close();
  await rm(temp, { recursive: true, force: true });
}
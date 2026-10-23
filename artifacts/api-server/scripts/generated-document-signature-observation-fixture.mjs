import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Synthetic, isolated API/database/provider state; this fixture never opens
// attached_assets or contacts Emzame.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "generated-signature-observation-"));
const databasePath = path.join(temp, "fixture.sqlite");
const providerStatePath = path.join(temp, "provider-state.json");
const providerLogPath = path.join(temp, "provider-requests.log");
const bundlePath = path.join(apiRoot, `.signature-observation-fixture-${process.pid}.mjs`);
const timestamp = new Date().toISOString();
const db = new DatabaseSync(databasePath);
let child;

db.exec(`
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY,name TEXT NOT NULL,salesperson_id INTEGER,merged_into_customer_id INTEGER
  );
  CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
  CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
  CREATE TABLE loan_applications(
    id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,plan_ids TEXT,deleted_at TEXT,stage TEXT,status TEXT,
    requested_amount TEXT,approved_amount TEXT,net_amount TEXT,duration_months INTEGER,
    current_primary_generation_id INTEGER,approved_amount_generation_id INTEGER,
    approved_amount_source TEXT,funder_decision TEXT,funder_reason TEXT,admin_approved_at TEXT,
    approved_amount_reconciled_at TEXT,approved_amount_reconciled_by_user_id INTEGER,
    updated_at TEXT,initial_approval_at TEXT,new_case_workflow INTEGER,requested_duration_months INTEGER,
    condition_snapshot_json TEXT,is_pre_registration INTEGER DEFAULT 0,legacy_reopen_prior_stage TEXT,
    requested_by_user_id INTEGER,requested_by_customer_id INTEGER
  );
  CREATE TABLE contract_generations(
    id INTEGER PRIMARY KEY,template_id INTEGER,customer_id INTEGER,loan_plan_id INTEGER,pdf_path TEXT,pdf_sha256 TEXT,
    docx_sha256 TEXT,manual_values_json TEXT,mappings_snapshot_json TEXT,created_at TEXT,
    provider_contract_id TEXT,provider_status TEXT,status TEXT,updated_at TEXT,
    loan_application_id INTEGER,generation_purpose TEXT DEFAULT 'primary',
    superseded_at TEXT,deleted_at TEXT
  );
  CREATE TABLE loan_application_generated_documents(
    id INTEGER PRIMARY KEY,application_id INTEGER,kind TEXT,contract_generation_id INTEGER,link TEXT,
    status TEXT DEFAULT 'pending',created_at TEXT
  );
  CREATE TABLE loan_application_stage_history(
    id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,action TEXT,actor_id INTEGER,
    actor_customer_id INTEGER,created_at TEXT,reason TEXT
  );
`);

const ownerId = Number(db.prepare("INSERT INTO salespersons(name) VALUES('Synthetic assigned owner')").run().lastInsertRowid);
const otherOwnerId = Number(db.prepare("INSERT INTO salespersons(name) VALUES('Synthetic unrelated owner')").run().lastInsertRowid);
const customerId = Number(db.prepare("INSERT INTO customers(name,salesperson_id) VALUES('Synthetic customer A',?)").run(ownerId).lastInsertRowid);
const otherCustomerId = Number(db.prepare("INSERT INTO customers(name,salesperson_id) VALUES('Synthetic customer B',?)").run(otherOwnerId).lastInsertRowid);
const planId = Number(db.prepare("INSERT INTO loan_plans(name) VALUES('Synthetic plan')").run().lastInsertRowid);
const makeApplication = (customer, stage, condition = "{}") => Number(db.prepare(`INSERT INTO loan_applications
  (customer_id,plan_id,stage,status,requested_amount,approved_amount,net_amount,duration_months,
   current_primary_generation_id,approved_amount_generation_id,approved_amount_source,approved_amount_reconciled_at,
   approved_amount_reconciled_by_user_id,updated_at,initial_approval_at,new_case_workflow,
   condition_snapshot_json,requested_duration_months)
  VALUES(?,?,?,'reviewing','987654321','123456789','111111111',24,NULL,NULL,'initial_provider_approval',NULL,NULL,?,NULL,1,?,24)`)
  .run(customer, planId, stage, timestamp, condition).lastInsertRowid);
const makeGeneration = (contractId, providerStatus, status, overrides = {}) => Number(db.prepare(`INSERT INTO contract_generations
  (template_id,customer_id,loan_plan_id,manual_values_json,mappings_snapshot_json,created_at,
     provider_contract_id,provider_status,status,updated_at,loan_application_id,
     generation_purpose,superseded_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
   overrides.templateId ?? null, overrides.customerId ?? customerId, overrides.loanPlanId ?? planId,
  overrides.manualValues ?? "{}", overrides.mappingsSnapshot ?? null, timestamp,
  contractId, providerStatus, status, timestamp, overrides.applicationId ?? null,
    overrides.purpose ?? "primary", overrides.supersededAt ?? null,
).lastInsertRowid);
const makeDocument = (applicationId, generationId, kind, link = null) => Number(db.prepare(`INSERT INTO
  loan_application_generated_documents(application_id,kind,contract_generation_id,link,created_at)
  VALUES(?,?,?,?,?)`).run(applicationId, kind, generationId, link, timestamp).lastInsertRowid);

const blockedApplication = makeApplication(customerId, "primary_contract_pending_signature");
const blockedGeneration = makeGeneration("fixture-signed-blocked-financial-template", null, "sent", {
  applicationId: blockedApplication, customerId, loanPlanId: planId, templateId: 999, signerCustomerId: 909,
});
db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(blockedGeneration, blockedApplication);
const blockedDocument = makeDocument(blockedApplication, blockedGeneration, "primary", "provider:unsigned-document");
db.prepare("UPDATE loan_applications SET requested_by_customer_id=909 WHERE id=?").run(blockedApplication);

const cachedSignedApplication = makeApplication(customerId, "primary_contract_pending_signature");
const cachedSignedGeneration = makeGeneration("fixture-cached-signed-now-pending", "signed", "signed", {
  applicationId: cachedSignedApplication,
  supersededAt: timestamp,
});
const cachedSignedDocument = makeDocument(cachedSignedApplication, cachedSignedGeneration, "primary");

const stalePositiveApplication = makeApplication(customerId, "primary_contract_pending_signature");
const stalePositiveGeneration = makeGeneration("fixture-stale-positive-primary", null, "sent", {
  applicationId: stalePositiveApplication,
  supersededAt: timestamp,
});
const stalePositiveDocument = makeDocument(stalePositiveApplication, stalePositiveGeneration, "primary");

const currentPendingApplication = makeApplication(customerId, "primary_contract_pending_signature");
const currentPendingGeneration = makeGeneration("fixture-current-pending-primary", null, "sent", {
  applicationId: currentPendingApplication,
});
db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(currentPendingGeneration, currentPendingApplication);
const currentPendingDocument = makeDocument(currentPendingApplication, currentPendingGeneration, "primary");

const makeDraftStatusPendingPrimary = (contractId, stage = "primary_contract_pending_signature") => {
  const applicationId = makeApplication(customerId, stage);
  db.prepare("UPDATE loan_applications SET status='draft' WHERE id=?").run(applicationId);
  const generationId = makeGeneration(contractId, null, "sent", {
    applicationId, customerId, loanPlanId: planId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(generationId, applicationId);
  const documentId = makeDocument(applicationId, generationId, "primary");
  return { applicationId, generationId, documentId };
};
const draftStatusManual = makeDraftStatusPendingPrimary("fixture-draft-status-manual");
const draftStatusBackground = makeDraftStatusPendingPrimary("fixture-draft-status-background");
const unrelatedDraftStage = makeDraftStatusPendingPrimary("fixture-unrelated-draft-stage", "draft");

  const wrongCustomerApplication = makeApplication(customerId, "primary_contract_pending_signature");
  const wrongCustomerGeneration = makeGeneration("fixture-wrong-customer-primary", null, "sent", {
    applicationId: wrongCustomerApplication, customerId: otherCustomerId, loanPlanId: planId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(wrongCustomerGeneration, wrongCustomerApplication);
  const wrongCustomerDocument = makeDocument(wrongCustomerApplication, wrongCustomerGeneration, "primary");

  const otherPlanId = Number(db.prepare("INSERT INTO loan_plans(name) VALUES('Synthetic unrelated plan')").run().lastInsertRowid);
  const wrongPlanApplication = makeApplication(customerId, "primary_contract_pending_signature");
  const wrongPlanGeneration = makeGeneration("fixture-wrong-plan-primary", null, "sent", {
    applicationId: wrongPlanApplication, customerId, loanPlanId: otherPlanId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(wrongPlanGeneration, wrongPlanApplication);
  const wrongPlanDocument = makeDocument(wrongPlanApplication, wrongPlanGeneration, "primary");

  const otherLoanApplication = makeApplication(customerId, "completed");
  const wrongLoanApplication = makeApplication(customerId, "primary_contract_pending_signature");
  const wrongLoanGeneration = makeGeneration("fixture-wrong-loan-primary", null, "sent", {
    applicationId: otherLoanApplication, customerId, loanPlanId: planId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(wrongLoanGeneration, wrongLoanApplication);
  const wrongLoanDocument = makeDocument(wrongLoanApplication, wrongLoanGeneration, "primary");

  const rejectedDocumentApplication = makeApplication(customerId, "primary_contract_pending_signature");
  const rejectedDocumentGeneration = makeGeneration("fixture-rejected-document-primary", null, "sent", {
    applicationId: rejectedDocumentApplication, customerId, loanPlanId: planId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(rejectedDocumentGeneration, rejectedDocumentApplication);
  const rejectedDocument = makeDocument(rejectedDocumentApplication, rejectedDocumentGeneration, "primary");
  db.prepare("UPDATE loan_application_generated_documents SET status='rejected' WHERE id=?").run(rejectedDocument);

  const mismatchedPointerApplication = makeApplication(customerId, "primary_contract_pending_signature");
  const mismatchedPointerGeneration = makeGeneration("fixture-mismatched-current-pointer", null, "sent", {
    applicationId: mismatchedPointerApplication, customerId, loanPlanId: planId,
  });
  const actualCurrentPointerGeneration = makeGeneration("fixture-actual-current-pointer", null, "sent", {
    applicationId: mismatchedPointerApplication, customerId, loanPlanId: planId,
  });
  db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?")
    .run(actualCurrentPointerGeneration, mismatchedPointerApplication);
  const mismatchedPointerDocument = makeDocument(mismatchedPointerApplication, mismatchedPointerGeneration, "primary");

const declinedApplication = makeApplication(customerId, "final_invoice_pending_signature");
const declinedGeneration = makeGeneration("fixture-exact-declined-state", null, "generated", { applicationId: declinedApplication });
const declinedDocument = makeDocument(declinedApplication, declinedGeneration, "invoice", "original-delivery-link");

const approvedGuarantorApplication = makeApplication(customerId, "approved_contract_pending_signature", '{"needs_guarantor":true}');
db.prepare("UPDATE loan_applications SET initial_approval_at=?,approved_amount_generation_id=NULL,approved_amount_reconciled_at=NULL WHERE id=?")
  .run(timestamp, approvedGuarantorApplication);
const approvedGuarantorGeneration = makeGeneration("fixture-approved-primary-guarantor", null, "sent", {
  applicationId: approvedGuarantorApplication, customerId, loanPlanId: planId,
});
db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(approvedGuarantorGeneration, approvedGuarantorApplication);
const approvedGuarantorDocument = makeDocument(approvedGuarantorApplication, approvedGuarantorGeneration, "primary");

const approvedCollateralApplication = makeApplication(customerId, "approved_contract_pending_signature");
db.prepare("UPDATE loan_applications SET initial_approval_at=?,approved_amount_generation_id=NULL,approved_amount_reconciled_at=NULL WHERE id=?")
  .run(timestamp, approvedCollateralApplication);
const approvedCollateralGeneration = makeGeneration("fixture-approved-primary-collateral", null, "sent", {
  applicationId: approvedCollateralApplication, customerId, loanPlanId: planId,
});
db.prepare("UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?").run(approvedCollateralGeneration, approvedCollateralApplication);
const approvedCollateralDocument = makeDocument(approvedCollateralApplication, approvedCollateralGeneration, "primary");

const amendmentApplication = makeApplication(customerId, "funder_amendment_pending_signature");
const amendmentGeneration = makeGeneration("fixture-current-amendment", null, "sent", {
  applicationId: amendmentApplication, customerId, loanPlanId: planId, purpose: "amendment",
});
const amendmentDocument = makeDocument(amendmentApplication, amendmentGeneration, "amendment");

const finalDocumentsApplication = makeApplication(customerId, "final_invoice_pending_signature");
const invoiceGeneration = makeGeneration("fixture-final-invoice", null, "sent", { customerId, loanPlanId: planId });
const invoiceDocument = makeDocument(finalDocumentsApplication, invoiceGeneration, "invoice");
const acknowledgementGeneration = makeGeneration("fixture-final-acknowledgement", null, "sent", { customerId, loanPlanId: planId });
const acknowledgementDocument = makeDocument(finalDocumentsApplication, acknowledgementGeneration, "acknowledgement");

const unauthorizedApplication = makeApplication(otherCustomerId, "completed");
const unauthorizedGeneration = makeGeneration("fixture-must-not-be-queried", null, "sent", { applicationId: unauthorizedApplication });
const unauthorizedDocument = makeDocument(unauthorizedApplication, unauthorizedGeneration, "primary");

await writeFile(providerStatePath, JSON.stringify({
  "fixture-signed-blocked-financial-template": { status: "accept" },
  "fixture-cached-signed-now-pending": { status: "readyForSign" },
  "fixture-stale-positive-primary": { status: "signed" },
  "fixture-current-pending-primary": { status: "readyForSign" },
  "fixture-draft-status-manual": { status: "signed" },
  "fixture-draft-status-background": { status: "signed" },
  "fixture-unrelated-draft-stage": { status: "signed" },
  "fixture-wrong-customer-primary": { status: "signed" },
  "fixture-wrong-plan-primary": { status: "signed" },
  "fixture-wrong-loan-primary": { status: "signed" },
  "fixture-rejected-document-primary": { status: "signed" },
  "fixture-mismatched-current-pointer": { status: "signed" },
  "fixture-exact-declined-state": { status: "declined" },
  "fixture-approved-primary-guarantor": { status: "accepted" },
  "fixture-approved-primary-collateral": { status: "accepted" },
  "fixture-current-amendment": { status: "accepted" },
  "fixture-final-invoice": { status: "accepted" },
  "fixture-final-acknowledgement": { status: "accepted" },
  "fixture-must-not-be-queried": { status: "signed" },
}));
await writeFile(providerLogPath, "");

const workerSource = `
  import express from "express";
  import applications,{refreshGeneratedDocumentSignature} from "./src/routes/loan-applications";
  const app = express();
  const actors = {
    assigned: { id: 101, role: "salesperson", customerScope: "assigned", salespersonId: ${ownerId}, permissions: ["loan_applications.view", "loan_applications.update"] },
    unrelated: { id: 102, role: "salesperson", customerScope: "assigned", salespersonId: ${otherOwnerId}, permissions: ["loan_applications.view"] },
    noPermission: { id: 103, role: "registrar", customerScope: "all", salespersonId: null, permissions: [] },
    admin: { id: 104, role: "admin", customerScope: "all", salespersonId: null, permissions: ["loan_applications.view"] },
  };
  app.use(express.json());
  app.use((req, res, next) => {
    const match = String(req.headers.cookie ?? "").match(/fixture_actor=([^;]+)/);
    const actor = match && actors[match[1]];
    if (!actor) { res.status(401).json({ error: "unauthorized" }); return; }
    res.locals.authUser = actor;
    req.log = { warn() {}, info() {}, error() {} };
    next();
  });
  app.post("/fixture/background-refresh/:applicationId/:documentId", async (req, res) => {
    try {
      res.json(await refreshGeneratedDocumentSignature(Number(req.params.applicationId), Number(req.params.documentId)));
    } catch (err) {
      res.status(409).json({ error: String(err?.message ?? err) });
    }
  });
  app.use("/api", applications);
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message ?? err) }));
  const server = app.listen(0, "127.0.0.1", () => process.stdout.write("FIXTURE_PORT:" + server.address().port + "\\n"));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

await build({
  stdin: { contents: workerSource, resolveDir: apiRoot, sourcefile: "signature-observation-fixture.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: bundlePath,
  logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` },
  plugins: [{
    name: "signature-observation-fixture",
    setup(context) {
      context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "fixture-db", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-db$/, namespace: "signature-observation" }, () => ({
        contents: `
          import { DatabaseSync } from "node:sqlite";
          import path from "node:path";
          export const databasePath=path.resolve(process.env.CRM_DATABASE_PATH);
          export const crmDb=new DatabaseSync(databasePath);
          export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
          export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
          export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
          export const executeChanges=(sql,params=[])=>crmDb.prepare(sql).run(...params).changes;
          export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const value=fn();crmDb.exec("COMMIT");return value}catch(error){crmDb.exec("ROLLBACK");throw error}};
          export const runImmediateTransaction=runTransaction;
        `,
        loader: "js",
      }));
      context.onResolve({ filter: /\/access-control$/ }, () => ({ path: "fixture-access", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-access$/, namespace: "signature-observation" }, () => ({
        contents: `
          export const requirePermission=permission=>(req,res,next)=>{
            const actor=res.locals.authUser;
            if(!actor){res.status(401).json({error:"unauthorized"});return}
            if(actor.role!=="admin"&&!actor.permissions.includes(permission)){res.status(403).json({error:"forbidden"});return}
            next();
          };
        `,
        loader: "js",
      }));
      context.onResolve({ filter: /\/logger$/ }, () => ({ path: "fixture-logger", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-logger$/, namespace: "signature-observation" }, () => ({
        contents: `export const logger={warn(){},info(){},error(){}};`,
        loader: "js",
      }));
      context.onResolve({ filter: /\/wallets$/ }, () => ({ path: "fixture-wallets", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-wallets$/, namespace: "signature-observation" }, () => ({
        contents: `export const creditLoanWallet=()=>{throw Error("unexpected_wallet_credit")};export const wallet=()=>({id:1,balance:"0"});`,
        loader: "js",
      }));
      context.onResolve({ filter: /\/contract-evidence$/ }, () => ({ path: "fixture-contract-evidence", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-contract-evidence$/, namespace: "signature-observation" }, () => ({
        contents: `export const renderedPdfContainsInstallmentCount=()=>false;export const renderedPdfContainsPrincipal=()=>false;export const isAttestedTomanTemplate=()=>false;export const renderedPdfContainsLegacyRialPrincipal=()=>false;`,
        loader: "js",
      }));
      context.onResolve({ filter: /\/emzame-client$/ }, () => ({ path: "fixture-emzame", namespace: "signature-observation" }));
      context.onLoad({ filter: /^fixture-emzame$/, namespace: "signature-observation" }, () => ({
        contents: `
          import {appendFileSync,readFileSync} from "node:fs";
          export const emzameRequest=async(resource)=>{
            const contractId=decodeURIComponent(resource.slice("contracts/".length));
            appendFileSync(process.env.FIXTURE_PROVIDER_LOG,contractId+"\\n");
            const states=JSON.parse(readFileSync(process.env.FIXTURE_PROVIDER_STATE,"utf8"));
            return Response.json(states[contractId]??{});
          };
        `,
        loader: "js",
      }));
    },
  }],
});

try {
  child = (await import("node:child_process")).spawn(process.execPath, [bundlePath], {
    cwd: apiRoot,
    env: {
      ...process.env,
      CRM_DATABASE_PATH: databasePath,
      NODE_ENV: "production",
      FIXTURE_PROVIDER_LOG: providerLogPath,
      FIXTURE_PROVIDER_STATE: providerStatePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let origin;
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = logs.match(/FIXTURE_PORT:(\d+)/);
    if (match) {
      origin = `http://127.0.0.1:${match[1]}`;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(origin, `synthetic API fixture failed to start:\n${logs}`);

  const request = async (actor, applicationId, documentId) => {
    const response = await fetch(`${origin}/api/loan-applications/${applicationId}/generated-documents/${documentId}/verify-signature`, {
      method: "POST",
      headers: { Cookie: `fixture_actor=${actor}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  };
  const readStatusRequest = async (actor, applicationId, documentId) => {
    const response = await fetch(`${origin}/api/loan-applications/${applicationId}/generated-documents/${documentId}/signature-status`, {
      method: "GET",
      headers: { Cookie: `fixture_actor=${actor}` },
    });
    return { status: response.status, body: await response.json() };
  };
  const confirmRequest = async (actor, applicationId) => {
    const response = await fetch(`${origin}/api/loan-applications/${applicationId}/confirm-signed-primary`, {
      method: "POST",
      headers: { Cookie: `fixture_actor=${actor}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  };
  const backgroundRequest = async (actor, applicationId, documentId) => {
    const response = await fetch(`${origin}/fixture/background-refresh/${applicationId}/${documentId}`, {
      method: "POST",
      headers: { Cookie: `fixture_actor=${actor}` },
    });
    return { status: response.status, body: await response.json() };
  };
  const expect = async (actor, applicationId, documentId, status) => {
    const result = await request(actor, applicationId, documentId);
    assert.equal(result.status, status, `${actor} request: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const inspect = (sql, ...params) => {
    const row = db.prepare(sql).get(...params);
    return row ? { ...row } : undefined;
  };
  const snapshot = (applicationId, documentId, generationId) => ({
    application: inspect("SELECT stage,status,updated_at,is_pre_registration FROM loan_applications WHERE id=?", applicationId),
    financial: inspect(`SELECT requested_amount,approved_amount,net_amount,duration_months,
      current_primary_generation_id,approved_amount_generation_id,approved_amount_source,funder_decision,funder_reason,
      admin_approved_at,approved_amount_reconciled_at,
      approved_amount_reconciled_by_user_id FROM loan_applications WHERE id=?`, applicationId),
    document: inspect("SELECT link,status FROM loan_application_generated_documents WHERE id=?", documentId),
    historyCount: inspect("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=?", applicationId).count,
    generationStatus: inspect("SELECT status FROM contract_generations WHERE id=?", generationId).status,
  });

  const providerCallsBeforeInvalidConfirm = (await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length;
  const invalidConfirm = await confirmRequest("assigned", wrongPlanApplication);
  assert.equal(invalidConfirm.status, 409);
  assert.equal(invalidConfirm.body.error, "primary_contract_not_signed",
    "confirm-signed-primary shares the generation customer/plan/current-pointer eligibility predicate");
  assert.equal((await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length,
    providerCallsBeforeInvalidConfirm, "invalid confirmation identity does not poll the provider");

  const blockedBefore = snapshot(blockedApplication, blockedDocument, blockedGeneration);
  const blockedProviderStatusBefore = inspect("SELECT provider_status FROM contract_generations WHERE id=?", blockedGeneration);
  const readOnlyStatus = await readStatusRequest("assigned", blockedApplication, blockedDocument);
  assert.equal(readOnlyStatus.status, 200, JSON.stringify(readOnlyStatus.body));
  assert.deepEqual(readOnlyStatus.body, {
    id: blockedDocument, kind: "primary", providerStatus: "accept", providerStatusTitle: null,
    signed: true, checkedAt: readOnlyStatus.body.checkedAt, readOnly: true,
  }, "sales can fetch a fresh signature status without requesting a workflow transition");
  assert.deepEqual(snapshot(blockedApplication, blockedDocument, blockedGeneration), blockedBefore);
  assert.deepEqual(inspect("SELECT provider_status FROM contract_generations WHERE id=?", blockedGeneration), blockedProviderStatusBefore,
    "read-only inquiry does not persist provider status");
  const callsBeforeSalesMutation = (await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length;
  const salesMutation = await request("assigned", blockedApplication, blockedDocument);
  assert.equal(salesMutation.status, 403);
  assert.equal(salesMutation.body.error, "read_only_signature_status");
  assert.equal((await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length, callsBeforeSalesMutation,
    "sales cannot use the workflow-changing signature endpoint");
  const concurrentResults = await Promise.all([
    request("admin", blockedApplication, blockedDocument),
    request("admin", blockedApplication, blockedDocument),
  ]);
  assert.deepEqual(concurrentResults.map((result) => result.status), [200, 200]);
  const concurrentBodies = concurrentResults.map((result) => result.body);
  assert.equal(concurrentBodies.filter((result) => result.workflowAdvanced).length, 1,
    "concurrent positive observations apply exactly one stage transition");
  const signedBlocked = concurrentBodies.find((result) => result.workflowAdvanced);
  assert.deepEqual(signedBlocked, {
    id: blockedDocument, signed: true, kind: "primary", providerStatus: "accept",
    workflowAdvanced: true, nextStage: "customer_documents_upload",
  }, "provider acceptance advances the current primary even without financial-term evidence");
  const blockedAfter = snapshot(blockedApplication, blockedDocument, blockedGeneration);
  assert.equal(blockedAfter.application.stage, "customer_documents_upload");
  assert.equal(blockedAfter.application.status, "reviewing");
  assert.deepEqual(blockedAfter.financial, blockedBefore.financial, "signature observation must not attest financial terms");
  assert.equal(blockedAfter.document.link, "signed:fixture-signed-blocked-financial-template");
  assert.equal(blockedAfter.document.status, blockedBefore.document.status);
  assert.equal(blockedAfter.historyCount, blockedBefore.historyCount + 1, "signature transition adds exactly one history record");
  assert.deepEqual({ ...inspect("SELECT action,actor_id,actor_customer_id FROM loan_application_stage_history WHERE application_id=?",
    blockedApplication) }, {
    action: "primary_signature_verified", actor_id: null, actor_customer_id: 909,
  }, "signature is recorded as provider/customer reconciliation, not a staff financial decision");
  assert.equal(blockedAfter.generationStatus, "signed", "provider signature observation is persisted on its generation");
  assert.equal(inspect("SELECT provider_status FROM contract_generations WHERE id=?", blockedGeneration).provider_status, "accept");

  const cachedBefore = snapshot(cachedSignedApplication, cachedSignedDocument, cachedSignedGeneration);
  const freshlyObservedPending = await expect("admin", cachedSignedApplication, cachedSignedDocument, 200);
  assert.deepEqual(freshlyObservedPending, {
    id: cachedSignedDocument, signed: false, kind: "primary", providerStatus: "readyForSign",
    workflowAdvanced: false, nextStage: null,
  }, "manual verification must query Emzame even when the local generation was already signed");
  const cachedAfter = snapshot(cachedSignedApplication, cachedSignedDocument, cachedSignedGeneration);
  assert.deepEqual(cachedAfter.application, cachedBefore.application);
  assert.deepEqual(cachedAfter.financial, cachedBefore.financial);
  assert.deepEqual(cachedAfter.document, cachedBefore.document);
  assert.equal(cachedAfter.generationStatus, "signed", "a pending observation cannot silently downgrade historical signed generation state");
  assert.equal(inspect("SELECT provider_status FROM contract_generations WHERE id=?", cachedSignedGeneration).provider_status, "readyForSign");

  const stalePositiveBefore = snapshot(stalePositiveApplication, stalePositiveDocument, stalePositiveGeneration);
  const stalePositive = await expect("admin", stalePositiveApplication, stalePositiveDocument, 200);
  assert.equal(stalePositive.signed, true);
  assert.equal(stalePositive.workflowAdvanced, false, "a positive observation on a stale generation cannot advance the case");
  assert.equal(stalePositive.nextStage, null);
  const stalePositiveAfter = snapshot(stalePositiveApplication, stalePositiveDocument, stalePositiveGeneration);
  assert.deepEqual(stalePositiveAfter.application, stalePositiveBefore.application);
  assert.deepEqual(stalePositiveAfter.document, stalePositiveBefore.document);
  assert.equal(stalePositiveAfter.historyCount, stalePositiveBefore.historyCount);

  const pendingBefore = snapshot(currentPendingApplication, currentPendingDocument, currentPendingGeneration);
  const currentPending = await expect("admin", currentPendingApplication, currentPendingDocument, 200);
  assert.equal(currentPending.signed, false);
  assert.equal(currentPending.workflowAdvanced, false);
  assert.equal(currentPending.nextStage, null);
  const pendingAfter = snapshot(currentPendingApplication, currentPendingDocument, currentPendingGeneration);
  assert.deepEqual(pendingAfter.application, pendingBefore.application);
  assert.deepEqual(pendingAfter.document, pendingBefore.document);
  assert.equal(pendingAfter.historyCount, pendingBefore.historyCount);

  const draftStatusManualResult = await expect("admin", draftStatusManual.applicationId, draftStatusManual.documentId, 200);
  assert.equal(draftStatusManualResult.workflowAdvanced, true,
    "a current pending-signature stage advances even when legacy application status is draft");
  assert.equal(draftStatusManualResult.nextStage, "customer_documents_upload");
  assert.deepEqual(inspect("SELECT stage,status FROM loan_applications WHERE id=?", draftStatusManual.applicationId),
    { stage: "customer_documents_upload", status: "reviewing" });
  const draftStatusBackgroundResult = await backgroundRequest("assigned",
    draftStatusBackground.applicationId, draftStatusBackground.documentId);
  assert.equal(draftStatusBackgroundResult.status, 200, JSON.stringify(draftStatusBackgroundResult.body));
  assert.equal(draftStatusBackgroundResult.body.workflowAdvanced, true,
    "background refresh also advances current pending signatures with application status draft");
  assert.equal(draftStatusBackgroundResult.body.nextStage, "customer_documents_upload");
  assert.deepEqual(inspect("SELECT stage,status FROM loan_applications WHERE id=?", draftStatusBackground.applicationId),
    { stage: "customer_documents_upload", status: "reviewing" });
  const unrelatedDraftResult = await expect("admin", unrelatedDraftStage.applicationId, unrelatedDraftStage.documentId, 200);
  assert.equal(unrelatedDraftResult.signed, true);
  assert.equal(unrelatedDraftResult.workflowAdvanced, false, "a draft-stage financial application never advances on a signature observation");
  assert.equal(inspect("SELECT stage,status FROM loan_applications WHERE id=?", unrelatedDraftStage.applicationId).stage, "draft");
  assert.equal(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", unrelatedDraftStage.documentId).link, null);

  const wrongCustomerBefore = snapshot(wrongCustomerApplication, wrongCustomerDocument, wrongCustomerGeneration);
  const providerCallsBeforeWrongCustomer = (await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length;
  const wrongCustomerResult = await expect("assigned", wrongCustomerApplication, wrongCustomerDocument, 404);
  assert.equal(wrongCustomerResult.error, "generated_document_not_found");
  assert.deepEqual(snapshot(wrongCustomerApplication, wrongCustomerDocument, wrongCustomerGeneration), wrongCustomerBefore,
    "a generation owned by another customer is rejected before local status/link mutation");
  assert.equal((await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length,
    providerCallsBeforeWrongCustomer, "a foreign generation is rejected before provider polling");

  for (const [application, document, generation, identityFailure] of [
    [wrongPlanApplication, wrongPlanDocument, wrongPlanGeneration, "generation plan mismatch"],
    [wrongLoanApplication, wrongLoanDocument, wrongLoanGeneration, "generation loan-application mismatch"],
    [rejectedDocumentApplication, rejectedDocument, rejectedDocumentGeneration, "rejected linked document"],
    [mismatchedPointerApplication, mismatchedPointerDocument, mismatchedPointerGeneration, "current primary generation mismatch"],
  ]) {
    const before = snapshot(application, document, generation);
    const result = await expect("admin", application, document, 200);
    assert.equal(result.signed, true, `${identityFailure}: provider observation remains factual`);
    assert.equal(result.workflowAdvanced, false, `${identityFailure}: ineligible links cannot advance`);
    assert.equal(result.nextStage, null);
    const after = snapshot(application, document, generation);
    assert.deepEqual(after.application, before.application, `${identityFailure}: application stays put`);
    assert.deepEqual(after.document, before.document, `${identityFailure}: no signed link is attached`);
    assert.equal(after.historyCount, before.historyCount, `${identityFailure}: no transition history is written`);
  }

  const declinedBefore = snapshot(declinedApplication, declinedDocument, declinedGeneration);
  const exactNonSigned = await expect("admin", declinedApplication, declinedDocument, 200);
  assert.deepEqual(exactNonSigned, {
    id: declinedDocument, signed: false, kind: "invoice", providerStatus: "declined",
    workflowAdvanced: false, nextStage: null,
  }, "manual verification returns the provider's exact non-signed status");
  const declinedAfter = snapshot(declinedApplication, declinedDocument, declinedGeneration);
  assert.deepEqual(declinedAfter.application, declinedBefore.application, "non-signed observation must not change application state");
  assert.deepEqual(declinedAfter.financial, declinedBefore.financial, "non-signed observation must not change financials");
  assert.deepEqual(declinedAfter.document, declinedBefore.document, "non-signed observation must not change document links");
  assert.equal(declinedAfter.historyCount, declinedBefore.historyCount);
  assert.equal(declinedAfter.generationStatus, declinedBefore.generationStatus);
  assert.equal(inspect("SELECT provider_status FROM contract_generations WHERE id=?", declinedGeneration).provider_status, "declined");

  for (const [application, generation, document, nextStage] of [
    [approvedGuarantorApplication, approvedGuarantorGeneration, approvedGuarantorDocument, "guarantor_documents_upload"],
    [approvedCollateralApplication, approvedCollateralGeneration, approvedCollateralDocument, "collateral_upload"],
  ]) {
    const before = snapshot(application, document, generation);
    const result = await expect("admin", application, document, 200);
    assert.equal(result.signed, true);
    assert.equal(result.workflowAdvanced, true);
    assert.equal(result.nextStage, nextStage);
    const after = snapshot(application, document, generation);
    assert.equal(after.application.stage, nextStage);
    assert.equal(after.document.link, `signed:${inspect("SELECT provider_contract_id FROM contract_generations WHERE id=?", generation).provider_contract_id}`);
    assert.deepEqual(after.financial, before.financial, "approved signature advancement does not reconcile or attest terms");
    assert.equal(after.historyCount, before.historyCount + 1);
  }

  const amendmentBefore = snapshot(amendmentApplication, amendmentDocument, amendmentGeneration);
  const amendmentResult = await expect("admin", amendmentApplication, amendmentDocument, 200);
  assert.equal(amendmentResult.workflowAdvanced, true);
  assert.equal(amendmentResult.nextStage, "funder_amendment_review");
  const amendmentAfter = snapshot(amendmentApplication, amendmentDocument, amendmentGeneration);
  assert.equal(amendmentAfter.application.stage, "funder_amendment_review");
  assert.equal(amendmentAfter.document.link, "signed:fixture-current-amendment");
  assert.deepEqual(amendmentAfter.financial, amendmentBefore.financial);
  assert.equal(amendmentAfter.historyCount, amendmentBefore.historyCount + 1);

  const finalBefore = snapshot(finalDocumentsApplication, invoiceDocument, invoiceGeneration);
  const invoiceResult = await expect("admin", finalDocumentsApplication, invoiceDocument, 200);
  const acknowledgementResult = await expect("admin", finalDocumentsApplication, acknowledgementDocument, 200);
  assert.equal(invoiceResult.workflowAdvanced, false);
  assert.equal(acknowledgementResult.workflowAdvanced, false);
  assert.equal(invoiceResult.nextStage, null);
  assert.equal(acknowledgementResult.nextStage, null);
  assert.equal(inspect("SELECT stage FROM loan_applications WHERE id=?", finalDocumentsApplication).stage,
    "final_invoice_pending_signature", "signing final documents leaves existing explicit completion action intact");
  assert.equal(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", invoiceDocument).link,
    "signed:fixture-final-invoice");
  assert.equal(inspect("SELECT link FROM loan_application_generated_documents WHERE id=?", acknowledgementDocument).link,
    "signed:fixture-final-acknowledgement");
  assert.deepEqual(snapshot(finalDocumentsApplication, invoiceDocument, invoiceGeneration).financial, finalBefore.financial);

  const requestCountBeforeDeniedCalls = (await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length;
  await expect("noPermission", declinedApplication, declinedDocument, 403);
  await expect("assigned", unauthorizedApplication, unauthorizedDocument, 404);
  await expect("assigned", blockedApplication, unauthorizedDocument, 404);
  const foreignReadStatus = await readStatusRequest("assigned", unauthorizedApplication, unauthorizedDocument);
  assert.equal(foreignReadStatus.status, 404, "read-only signature inquiry preserves assigned-customer isolation");
  const requestCountAfterDeniedCalls = (await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean).length;
  assert.equal(requestCountAfterDeniedCalls, requestCountBeforeDeniedCalls, "permission, customer-scope, and application-link denials never query the provider");
  assert.deepEqual((await readFile(providerLogPath, "utf8")).trim().split("\n").filter(Boolean), [
    "fixture-signed-blocked-financial-template",
    "fixture-signed-blocked-financial-template",
    "fixture-signed-blocked-financial-template",
    "fixture-cached-signed-now-pending",
    "fixture-stale-positive-primary",
    "fixture-current-pending-primary",
    "fixture-draft-status-manual",
    "fixture-draft-status-background",
    "fixture-unrelated-draft-stage",
    "fixture-wrong-plan-primary",
    "fixture-wrong-loan-primary",
    "fixture-rejected-document-primary",
    "fixture-mismatched-current-pointer",
    "fixture-exact-declined-state",
    "fixture-approved-primary-guarantor",
    "fixture-approved-primary-collateral",
    "fixture-current-amendment",
    "fixture-final-invoice",
    "fixture-final-acknowledgement",
  ], "each allowed manual/background request queries its linked Emzame contract");

  process.stdout.write("Generated-document signature observation regression passed.\n");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  db.close();
  await rm(bundlePath, { force: true });
  await rm(temp, { recursive: true, force: true });
}
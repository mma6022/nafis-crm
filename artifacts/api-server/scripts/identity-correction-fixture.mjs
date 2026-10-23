import assert from "node:assert/strict";
import { checkCollateralRoleTransfer } from "./collateral-role-checks.mjs";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This fixture creates its own schema, users, files and sessions. It never opens
// the CRM database or reads customer uploads.
const temp = await mkdtemp(path.join(os.tmpdir(), "identity-correction-"));
const databasePath = path.join(temp, "fixture.sqlite");
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, { CRM_DATABASE_PATH: databasePath, SESSION_SECRET: secret, NODE_ENV: "production" });
const dbModule = `
  import { DatabaseSync } from "node:sqlite";
  export const databasePath = process.env.CRM_DATABASE_PATH;
  export const crmDb = new DatabaseSync(databasePath);
  crmDb.exec("PRAGMA foreign_keys=ON");
  export const queryRow = (sql, params=[]) => crmDb.prepare(sql).get(...params);
  export const queryRows = (sql, params=[]) => crmDb.prepare(sql).all(...params);
  export const execute = (sql, params=[]) => Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
  export const executeChanges = (sql, params=[]) => crmDb.prepare(sql).run(...params).changes;
  export const runTransaction = (fn) => { crmDb.exec("BEGIN"); try { const value=fn(); crmDb.exec("COMMIT"); return value; } catch(e) { crmDb.exec("ROLLBACK"); throw e; } };
  export const runImmediateTransaction = (fn) => { crmDb.exec("BEGIN IMMEDIATE"); try { const value=fn(); crmDb.exec("COMMIT"); return value; } catch(e) { crmDb.exec("ROLLBACK"); throw e; } };
`;
const bundle = path.join(temp, "server.mjs");
await build({
  stdin: {
    contents: `
      import express from "express";
      import cookieParser from "cookie-parser";
      import { requireAuth } from "./src/lib/auth";
      import loan from "./src/routes/loan-applications";
      export { crmDb } from "./src/lib/crm-db";
      export const app = express();
      app.use(express.json(), cookieParser(), requireAuth, loan);
    `,
    resolveDir: process.cwd(),
    sourcefile: "identity-correction-fixture.ts",
  },
  bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` },
  plugins: [{
    name: "isolated-db-and-unrelated-providers",
    setup(buildContext) {
      buildContext.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "fixture-db", namespace: "fixture" }));
      buildContext.onLoad({ filter: /^fixture-db$/, namespace: "fixture" }, () => ({ contents: dbModule, loader: "js" }));
      buildContext.onResolve({ filter: /\/(emzame-client|wallets)$/ }, () => ({ path: "unused-provider", namespace: "fixture" }));
      buildContext.onLoad({ filter: /^unused-provider$/, namespace: "fixture" }, () => ({
        contents: "export const providerContractState=()=>{throw Error('provider disabled')}; export const emzameRequest=()=>{throw Error('provider disabled')}; export const creditLoanWallet=()=>{throw Error('wallet disabled')}; export const wallet=()=>{throw Error('wallet disabled')};",
        loader: "js",
      }));
    },
  }],
});

let server, fixture;
try {
  // Only the columns used by the actual auth, access-control and loan routes
  // are needed; unrelated migrations and production records are excluded.
  const schema = new DatabaseSync(databasePath);
  schema.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,mobile TEXT,priority_colors TEXT,role TEXT, salesperson_id INTEGER,active INTEGER,created_at TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
    CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,consultation_id INTEGER,customer_id INTEGER,requested_by_user_id INTEGER,plan_ids TEXT,plan_id INTEGER,requested_amount TEXT,status TEXT,stage TEXT,is_pre_registration INTEGER DEFAULT 0,condition_snapshot_json TEXT,plan_snapshot_json TEXT,duration_months INTEGER,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,document_type TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,created_by_user_id INTEGER,created_at TEXT,version INTEGER,is_latest INTEGER,approved_at TEXT,approved_by_user_id INTEGER,review_reason TEXT);
    CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,requirement_key TEXT,label TEXT,source TEXT,status TEXT,incomplete_reason TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,created_at TEXT,reviewed_at TEXT);
    CREATE TABLE loan_application_generated_documents(id INTEGER PRIMARY KEY,application_id INTEGER,kind TEXT,contract_generation_id INTEGER,link TEXT,status TEXT,review_reason TEXT);
    CREATE TABLE contract_generations(id INTEGER PRIMARY KEY,pdf_path TEXT,deleted_at TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,action TEXT,reason TEXT,actor_id INTEGER,created_at TEXT);
    CREATE TABLE loan_physical_checks(id INTEGER PRIMARY KEY,application_id INTEGER,status TEXT);
    CREATE TABLE loan_physical_documents(id INTEGER PRIMARY KEY,application_id INTEGER,original_name TEXT,mime_type TEXT,size_bytes INTEGER,created_at TEXT,storage_path TEXT);
    CREATE TABLE loan_funder_defects(id INTEGER PRIMARY KEY,application_id INTEGER,source TEXT,source_id INTEGER,resolved_at TEXT);
    CREATE TABLE loan_application_guarantors(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_application_collateral(id INTEGER PRIMARY KEY,application_id INTEGER,collateral_type TEXT,status TEXT,data_json TEXT,storage_path TEXT,created_at TEXT,reviewed_at TEXT,rejection_reason TEXT);
    CREATE TABLE consult_options(field_key TEXT,option_value TEXT,label_fa TEXT);
  `);
  schema.close();
  fixture = await import(pathToFileURL(bundle).href);
  const db = fixture.crmDb;
  const now = new Date().toISOString();
  const owner = db.prepare("INSERT INTO salespersons(name) VALUES('Fixture owner')").run().lastInsertRowid;
  const otherOwner = db.prepare("INSERT INTO salespersons(name) VALUES('Fixture other')").run().lastInsertRowid;
  const cookies = {};
   for (const [role, salespersonId] of [["salesperson", owner], ["registrar", null], ["accounting", null], ["admin", null], ["other", otherOwner]]) {
    const actualRole = role === "other" ? "salesperson" : role;
    const id = db.prepare("INSERT INTO users(username,role,salesperson_id,active,created_at) VALUES(?,?,?,1,?)")
      .run(`fixture-${role}`, actualRole, salespersonId, now).lastInsertRowid;
    const token = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(createHmac("sha256", secret).update(token).digest("hex"), id, new Date(Date.now() + 300000).toISOString(), now);
    cookies[role] = `crm_session=${token}`;
  }
  const customerId = db.prepare("INSERT INTO customers(name,salesperson_id) VALUES('Fixture customer',?)").run(owner).lastInsertRowid;
  const applicationId = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,stage,condition_snapshot_json,updated_at)
    VALUES(1,?,1,'[1]','10000','reviewing','customer_documents_review','{}',?)`).run(customerId, now).lastInsertRowid;
  const base = `/loan-applications/${applicationId}`;
  // A signed contract and a completed loan-specific document are synthetic
  // prerequisites, not copies of customer documents.
  const supportingFile = path.join(temp, "synthetic-loan-document.pdf");
  const fs = await import("node:fs/promises");
  await fs.writeFile(supportingFile, "fixture loan file");
  db.prepare("INSERT INTO contract_generations(id,pdf_path) VALUES(1,?)").run(supportingFile);
  db.prepare("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,link,status) VALUES(?,'primary',1,'signed:fixture','approved')").run(applicationId);
  db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,storage_path,created_at) VALUES(?,'fixture','مدرک ساختگی','manual','approved',?,?)").run(applicationId, supportingFile, now);
  server = fixture.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(role, method, url, body, status = 200) {
    const response = await fetch(origin + url, {
      method, headers: { Cookie: cookies[role], ...(body instanceof FormData ? {} : body ? { "Content-Type": "application/json" } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    assert.equal(response.status, status, `${role} ${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  }
  async function upload(role, type, marker, status = 201) {
    const form = new FormData();
    form.set("documentType", type);
    form.set("file", new File([`%PDF-1.4\n${marker}\n%%EOF`], `${marker}.pdf`, { type: "application/pdf" }));
    return request(role, "POST", `/customers/${customerId}/identity-documents`, form, status);
  }
  if (process.env.COLLATERAL_ROLE_ONLY === "1") {
    db.prepare("UPDATE loan_applications SET stage='collateral_upload' WHERE id=?").run(applicationId);
    const page = await readFile(new URL("../../crm-dashboard/src/pages/LoanApplicationDetail.tsx", import.meta.url), "utf8");
    await checkCollateralRoleTransfer({ db, request, applicationId, page });
  } else {
  const types = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
  const ids = {};
  for (const type of types) ids[type] = (await upload("salesperson", type, `initial-${type}`)).id;
  const review = (role, id, decision, reason, status = 200) =>
    request(role, "POST", `${base}/identity-documents/${id}/review`, { decision, reason }, status);
  await review("salesperson", ids.national_card_front, "rejected", "not allowed", 403);
  await review("accounting", ids.national_card_front, "rejected", "not allowed", 403);
  await request("other", "GET", base, null, 404);
  await upload("other", "national_card_front", "unauthorized", 404);
  await upload("accounting", "national_card_front", "unauthorized", 403);
  for (const type of types.slice(1)) await review("registrar", ids[type], "approved");
  const reason = "تصویر روی کارت ملی ناخواناست";
  await review("registrar", ids.national_card_front, "rejected", "", 400);
  await review("registrar", ids.national_card_front, "rejected", reason);
  const rejected = await request("salesperson", "GET", base);
  assert.equal(rejected.identityDocuments.find(d => d.id === ids.national_card_front).reviewReason, reason);
  assert.equal(rejected.registrarReview.hasDefect, true);
  await request("salesperson", "POST", `${base}/return-customer-documents`, { reason }, 403);
  await request("registrar", "POST", `${base}/review-customer-documents`, {}, 409);
  await request("registrar", "POST", `${base}/return-customer-documents`, { reason: "  " }, 400);
  const returned = await request("registrar", "POST", `${base}/return-customer-documents`, { reason });
  assert.equal(returned.stage, "customer_documents_upload");
  await request("registrar", "POST", `${base}/submit-customer-documents`, {}, 409);
  const replacement = await upload("salesperson", "national_card_front", "corrected-front");
  assert.notEqual(replacement.id, ids.national_card_front);
  // Even an unrelated previously approved identity side loses approval when
  // its file is replaced; the superseded approved version remains in history.
  const approvedReplacement = await upload("salesperson", "national_card_back", "corrected-back");
  const backVersions = db.prepare("SELECT id,version,is_latest,approved_at FROM customer_identity_documents WHERE customer_id=? AND document_type='national_card_back' ORDER BY version").all(customerId);
  assert.deepEqual(backVersions.map(d => [d.version, d.is_latest, Boolean(d.approved_at)]), [[1, 0, true], [2, 1, false]]);
  assert.equal(backVersions[1].id, approvedReplacement.id);
  const versions = db.prepare("SELECT id,version,is_latest,approved_at,review_reason FROM customer_identity_documents WHERE customer_id=? AND document_type='national_card_front' ORDER BY version").all(customerId);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map(d => [d.version, d.is_latest]), [[1, 0], [2, 1]]);
  assert.equal(versions[1].approved_at, null, "replacement requires fresh approval");
  assert.equal(versions[1].review_reason, null, "old defect is not applied to new file");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_identity_documents WHERE customer_id=? AND document_type='national_card_back' AND approved_at IS NOT NULL AND is_latest=1").get(customerId).n, 0);
  const oldDownload = await fetch(origin + `${base}/identity-documents/${ids.national_card_front}/download`, { headers: { Cookie: cookies.salesperson } });
  assert.equal(oldDownload.status, 404, "old version is not available through the application");
  await review("registrar", ids.national_card_front, "approved", undefined, 403);
  const resubmitted = await request("salesperson", "POST", `${base}/submit-customer-documents`, {});
  assert.equal(resubmitted.stage, "customer_documents_review");
  await request("registrar", "POST", `${base}/review-customer-documents`, {}, 409);
  await review("registrar", replacement.id, "approved");
  await request("registrar", "POST", `${base}/review-customer-documents`, {}, 409);
  await review("registrar", approvedReplacement.id, "approved");
  const finished = await request("registrar", "POST", `${base}/review-customer-documents`, {});
  assert.equal(finished.stage, "collateral_upload");
  assert.equal(db.prepare("SELECT approved_by_user_id IS NOT NULL ok FROM customer_identity_documents WHERE id=?").get(replacement.id).ok, 1);
  assert.deepEqual(db.prepare("SELECT action FROM loan_application_stage_history WHERE application_id=? AND action IN ('return-customer-documents','submit-customer-documents','review-customer-documents') ORDER BY id").all(applicationId).map(d => d.action),
    ["return-customer-documents", "submit-customer-documents", "review-customer-documents"]);
  // A plan with no loan-specific requirements must still allow the explicit
  // handoff; the registrar reviews identity documents and the signed contract.
  const createSignedApplication = () => {
    const id = Number(db.prepare(`INSERT INTO loan_applications
      (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,stage,condition_snapshot_json,updated_at)
      VALUES(1,?,1,'[1]','10000','reviewing','customer_documents_upload','{}',?)`)
      .run(customerId, now).lastInsertRowid);
    db.prepare("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,link,status) VALUES(?,'primary',1,'signed:fixture','approved')")
      .run(id);
    return id;
  };
  const noRequirementsId = createSignedApplication();
  await request("registrar", "POST", `/loan-applications/${noRequirementsId}/submit-customer-documents`, {}, 409);
  const noRequirements = await request("salesperson", "POST", `/loan-applications/${noRequirementsId}/submit-customer-documents`, {});
  assert.equal(noRequirements.stage, "customer_documents_review");
  assert.equal((await request("registrar", "GET", `/loan-applications/${noRequirementsId}`)).registrarReview.allApproved, true);
  const noRequirementsReviewed = await request("registrar", "POST", `/loan-applications/${noRequirementsId}/review-customer-documents`, {});
  assert.equal(noRequirementsReviewed.stage, "collateral_upload");

  // A manually added requirement has no requirement_key; it must not disappear
  // from the SQL completeness or review checks just because that key is NULL.
  const manualId = createSignedApplication();
  const manualDoc = Number(db.prepare(`INSERT INTO loan_application_documents
    (application_id,requirement_key,label,source,status,created_at) VALUES(?,NULL,'مدرک دستی','manual','uploaded',?)`)
    .run(manualId, now).lastInsertRowid);
  await request("salesperson", "POST", `/loan-applications/${manualId}/submit-customer-documents`, {}, 409);
  db.prepare("UPDATE loan_application_documents SET storage_path=? WHERE id=?").run(supportingFile, manualDoc);
  const manualSubmitted = await request("salesperson", "POST", `/loan-applications/${manualId}/submit-customer-documents`, {});
  assert.equal(manualSubmitted.stage, "customer_documents_review");
  assert.equal((await request("registrar", "GET", `/loan-applications/${manualId}`)).registrarReview.allApproved, false);
  await request("registrar", "POST", `/loan-applications/${manualId}/review-customer-documents`, {}, 409);
  db.prepare("UPDATE loan_application_documents SET status='approved' WHERE id=?").run(manualDoc);
  const manualReviewed = await request("registrar", "POST", `/loan-applications/${manualId}/review-customer-documents`, {});
  assert.equal(manualReviewed.stage, "collateral_upload");
  // The UI contract must consume the detail reason and expose the correction
  // control only to an authorized salesperson during the returned stage.
  const page = await readFile(new URL("../../crm-dashboard/src/pages/LoanApplicationDetail.tsx", import.meta.url), "utf8");
  assert.match(page, /const rejectionReason = doc\?\.reviewReason \|\| doc\?\.review_reason/);
  assert.match(page, /\{rejectionReason && <div[^>]*>\{rejectionReason\}<\/div>\}/);
  assert.match(page, /data-testid=\{`identity-correction-upload-\$\{type\}`\}/);
  assert.match(page, /canUpload=\{Boolean\(canUpdate && \(user\?\.role === 'admin' \|\| user\?\.permissions\?\.includes\('customers\.update'\)\) && canSalespersonAct && app\.stage === 'customer_documents_upload'\)\}/);
  assert.match(page, /await upload\.mutateAsync\(\{ customerId, data: \{ documentType, file \} \}\)/);
  assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: getGetLoanApplicationQueryKey\(appId\) \}\)/);
  await checkCollateralRoleTransfer({ db, request, applicationId: manualId, page });
  console.log("Identity correction fixture passed: isolated roles, rejection reason/UI control, return, versioned upload, fresh review, resubmit and approval.");
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  fixture?.crmDb?.close();
  await rm(temp, { recursive: true, force: true });
}
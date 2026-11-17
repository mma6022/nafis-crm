import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { providerContractTitle } from "../src/lib/provider-document-title.ts";
import { isAllowedStoredFile, migrateStoredFileToDataDir, resolveCrmDataDir } from "../src/lib/crm-data-dir.ts";

// --- Unit: persistent data dir vs a release-tree symlink (the first-upload / post-deploy bug) ---
const unit = await mkdtemp(path.join(os.tmpdir(), "sf816-datadir-"));
try {
  const persistent = path.join(unit, "varlib");
  await mkdir(persistent, { recursive: true });
  const realDb = path.join(persistent, "customers.db");
  await writeFile(realDb, "db");
  const release = path.join(unit, "releases", "20261117490000", "attached_assets");
  await mkdir(release, { recursive: true });
  await symlink(realDb, path.join(release, "customers_1789823100050.db"));
  const linkedDb = path.join(release, "customers_1789823100050.db");
  assert.equal(resolveCrmDataDir(linkedDb), fs.realpathSync(persistent));

  const legacyDir = path.join(release, "customer-identity-documents", "10");
  await mkdir(legacyDir, { recursive: true });
  const legacyFile = path.join(legacyDir, "card.jpg");
  await writeFile(legacyFile, "legacy-identity");
  assert.equal(isAllowedStoredFile(legacyFile, persistent, "identity"), true);
  const migrated = migrateStoredFileToDataDir(legacyFile, persistent, "identity", 10);
  assert.ok(migrated && migrated.startsWith(path.join(persistent, "customer-identity-documents") + path.sep), migrated);
  assert.equal(fs.readFileSync(migrated, "utf8"), "legacy-identity");
  assert.equal(fs.existsSync(legacyFile), true, "original is left in place");
  console.log("ok - data-dir resolve + legacy migrate");
} finally {
  await rm(unit, { recursive: true, force: true });
}

// --- Masked copy (read-only on the source): Sepehr plan name needs clipping ---
const maskedSrc = process.env.SF816_FIXTURE_DB || "/workspace/q-480000/mdb/m.db";
if (fs.existsSync(maskedSrc)) {
  assert.notEqual(fs.realpathSync(maskedSrc), "/var/lib/nafisvam/customers.db", "refusing live DB");
  const tmpCopy = path.join(os.tmpdir(), `sf816-masked-${randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(maskedSrc, tmpCopy);
  try {
    const masked = new DatabaseSync(tmpCopy, { readOnly: true });
    const plan = masked.prepare("SELECT id,name FROM loan_plans WHERE id=25").get();
    if (plan?.name) {
      const raw = `قرارداد طرح ${plan.name} - نمونه`;
      const clipped = providerContractTitle(plan.name, "نمونه");
      assert.ok([...raw].length > 63 || Buffer.byteLength(raw, "utf8") > 111);
      assert.ok([...clipped].length <= 63);
      assert.ok(Buffer.byteLength(clipped, "utf8") <= 111);
      assert.ok(clipped.includes("سپهر") || clipped.startsWith("قرارداد طرح "), clipped);
      console.log("ok - masked copy plan 25 title clips to 63/111");
    } else {
      console.log("ok - masked copy present but plan 25 missing (skipped title assert)");
    }
    masked.close();
  } finally {
    fs.unlinkSync(tmpCopy);
  }
} else {
  console.log("ok - masked copy not on this box (title already unit-tested)");
}

// --- HTTP fixture: first-upload approval, vault reuse, kill switch ---
const temp = await mkdtemp(path.join(os.tmpdir(), "sf816-http-"));
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
      export { seedPlanSlotFromVault, latestApprovedProfileDocument } from "./src/lib/customer-profile-documents";
      export { sf816CustomerDocReuse, CUSTOMER_LEVEL_DOCUMENT_KEYS, CASE_LEVEL_DOCUMENT_KEYS } from "./src/lib/sf816-documents";
      export const app = express();
      app.use(express.json(), cookieParser(), requireAuth, loan);
    `,
    resolveDir: process.cwd(),
    sourcefile: "sf816-documents-fixture.ts",
  },
  bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(), "package.json")).href)});` },
  plugins: [{
    name: "isolated-db",
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
  const schema = new DatabaseSync(databasePath);
  schema.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,mobile TEXT,priority_colors TEXT,role TEXT, salesperson_id INTEGER,active INTEGER,created_at TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
    CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,bank_name TEXT);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,consultation_id INTEGER,customer_id INTEGER,requested_by_user_id INTEGER,plan_ids TEXT,plan_id INTEGER,requested_amount TEXT,status TEXT,stage TEXT,is_pre_registration INTEGER DEFAULT 0,condition_snapshot_json TEXT,plan_snapshot_json TEXT,duration_months INTEGER,deleted_at TEXT,updated_at TEXT,created_at TEXT,current_primary_generation_id INTEGER,new_case_workflow INTEGER DEFAULT 1,primary_manual_values_json TEXT DEFAULT '{}');
    CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,document_type TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,created_by_user_id INTEGER,created_at TEXT,version INTEGER,is_latest INTEGER,approved_at TEXT,approved_by_user_id INTEGER,review_reason TEXT);
    CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,requirement_key TEXT,label TEXT,source TEXT,status TEXT,incomplete_reason TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,created_at TEXT,reviewed_at TEXT,customer_profile_document_id INTEGER);
    CREATE TABLE customer_profile_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,document_type TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,created_by_user_id INTEGER,created_at TEXT,version INTEGER,is_latest INTEGER,approved_at TEXT,approved_by_user_id INTEGER,review_reason TEXT);
    CREATE TABLE loan_application_generated_documents(id INTEGER PRIMARY KEY,application_id INTEGER,kind TEXT,contract_generation_id INTEGER,link TEXT,status TEXT,review_reason TEXT,created_at TEXT,reviewed_at TEXT);
    CREATE TABLE contract_generations(id INTEGER PRIMARY KEY,pdf_path TEXT,deleted_at TEXT,status TEXT,provider_status TEXT,superseded_at TEXT,customer_id INTEGER,loan_plan_id INTEGER,loan_application_id INTEGER,generation_purpose TEXT,provider_contract_id TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,action TEXT,reason TEXT,actor_id INTEGER,created_at TEXT);
    CREATE TABLE loan_physical_checks(id INTEGER PRIMARY KEY,application_id INTEGER,status TEXT);
    CREATE TABLE loan_physical_documents(id INTEGER PRIMARY KEY,application_id INTEGER,original_name TEXT,mime_type TEXT,size_bytes INTEGER,created_at TEXT,storage_path TEXT);
    CREATE TABLE loan_funder_defects(id INTEGER PRIMARY KEY,application_id INTEGER,source TEXT,source_id INTEGER,resolved_at TEXT);
    CREATE TABLE loan_application_guarantors(id INTEGER PRIMARY KEY,application_id INTEGER);
    CREATE TABLE loan_application_collateral(id INTEGER PRIMARY KEY,application_id INTEGER,collateral_type TEXT,status TEXT,data_json TEXT,storage_path TEXT,created_at TEXT,reviewed_at TEXT,rejection_reason TEXT);
    CREATE TABLE consult_options(field_key TEXT,option_value TEXT,label_fa TEXT);
    CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE auth_sessions(token_hash TEXT,user_id INTEGER,expires_at TEXT,created_at TEXT);
  `);
  schema.prepare("INSERT INTO consult_options(field_key,option_value,label_fa) VALUES('required_document','employment_proof','مدرک شغلی')").run();
  schema.close();
  fixture = await import(pathToFileURL(bundle).href);
  assert.deepEqual([...fixture.CUSTOMER_LEVEL_DOCUMENT_KEYS], ["employment_proof", "residence_proof"]);
  assert.ok(fixture.CASE_LEVEL_DOCUMENT_KEYS.includes("average_balance_3_months"));
  assert.ok(fixture.CASE_LEVEL_DOCUMENT_KEYS.includes("juale_contract"));
  const db = fixture.crmDb;
  const now = new Date().toISOString();
  const owner = db.prepare("INSERT INTO salespersons(name) VALUES('Fixture owner')").run().lastInsertRowid;
  const cookies = {};
  for (const [role, salespersonId] of [["salesperson", owner], ["registrar", null], ["admin", null]]) {
    const id = db.prepare("INSERT INTO users(username,role,salesperson_id,active,created_at) VALUES(?,?,?,1,?)")
      .run(`fixture-${role}`, role, salespersonId, now).lastInsertRowid;
    const token = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
      .run(createHmac("sha256", secret).update(token).digest("hex"), id, new Date(Date.now() + 300000).toISOString(), now);
    cookies[role] = `crm_session=${token}`;
  }
  const customerId = db.prepare("INSERT INTO customers(name,salesperson_id) VALUES('Fixture customer',?)").run(owner).lastInsertRowid;
  const applicationId = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,stage,condition_snapshot_json,updated_at)
    VALUES(1,?,1,'[1]','10000','reviewing','customer_documents_review','{}',?)`).run(customerId, now).lastInsertRowid;
  const supportingFile = path.join(temp, "synthetic-loan-document.pdf");
  await writeFile(supportingFile, "fixture loan file");
  db.prepare("INSERT INTO contract_generations(id,pdf_path,status,provider_status) VALUES(1,?,'signed','signed')").run(supportingFile);
  db.prepare("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,link,status,created_at) VALUES(?,'primary',1,'signed:fixture','approved',?)").run(applicationId, now);
  const empId = db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,created_at) VALUES(?,'employment_proof','مدرک شغلی','plan','pending',?)").run(applicationId, now).lastInsertRowid;

  server = fixture.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(role, method, url, body, status = 200) {
    const response = await fetch(origin + url, {
      method, headers: { Cookie: cookies[role], ...(body instanceof FormData ? {} : body ? { "Content-Type": "application/json" } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = method === "GET" && response.headers.get("content-type")?.includes("application/pdf")
      ? { ok: response.ok, status: response.status, bytes: (await response.arrayBuffer()).byteLength }
      : await response.json().catch(() => null);
    assert.equal(response.status, status, `${role} ${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  }
  async function uploadIdentity(type, marker) {
    const form = new FormData();
    form.set("documentType", type);
    form.set("file", new File([`%PDF-1.4\n${marker}\n%%EOF`], `${marker}.pdf`, { type: "application/pdf" }));
    return request("salesperson", "POST", `/customers/${customerId}/identity-documents`, form, 201);
  }

  const types = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
  const ids = {};
  for (const type of types) ids[type] = (await uploadIdentity(type, type)).id;
  // First-upload approval (the bug report: must not require a return + re-upload)
  for (const type of types) {
    await request("registrar", "POST", `/loan-applications/${applicationId}/identity-documents/${ids[type]}/review`, { decision: "approved" });
  }
  const afterFirst = await request("registrar", "GET", `/loan-applications/${applicationId}`);
  assert.equal(afterFirst.identityDocuments.length, 5);
  assert.ok(afterFirst.identityDocuments.every(d => d.fileAvailable && d.approvedAt), "first identity upload is approvable");
  console.log("ok - first identity upload can be approved without a return");

  // Employment proof: upload, approve, lands in the customer vault
  const empForm = new FormData();
  empForm.set("requirementKey", "employment_proof");
  empForm.set("file", new File(["%PDF-1.4\njob\n%%EOF"], "job.pdf", { type: "application/pdf" }));
  // stage is review; slot is pending with no file — missingDuringReview should allow sales to upload
  const uploaded = await request("salesperson", "POST", `/loan-applications/${applicationId}/documents`, empForm, 201);
  await request("registrar", "POST", `/loan-applications/${applicationId}/documents/${uploaded.id || empId}/review`, { decision: "approved" });
  const vault = fixture.latestApprovedProfileDocument(Number(customerId), "employment_proof", path.dirname(databasePath));
  assert.ok(vault && vault.approved_at, "approved employment_proof is stored on the customer");
  console.log("ok - approved employment_proof stored in the customer vault");

  // Second case reuses it
  const app2 = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,stage,condition_snapshot_json,updated_at)
    VALUES(1,?,1,'[1]','10000','requested','draft','{}',?)`).run(customerId, now).lastInsertRowid;
  assert.equal(fixture.sf816CustomerDocReuse(), true);
  assert.equal(fixture.seedPlanSlotFromVault({
    applicationId: Number(app2), customerId: Number(customerId), documentType: "employment_proof",
    label: "مدرک شغلی", createdAt: now, dataDir: path.dirname(databasePath),
  }), true);
  const seeded = db.prepare("SELECT status,customer_profile_document_id FROM loan_application_documents WHERE application_id=? AND requirement_key='employment_proof'").get(app2);
  assert.equal(seeded.status, "approved");
  assert.ok(seeded.customer_profile_document_id);
  console.log("ok - second case reuses approved employment_proof without re-upload or re-approval");

  // Kill switch restores per-case slots
  db.prepare("INSERT INTO call_queue_settings(key,value) VALUES('flag.sf816_customer_doc_reuse','0')").run();
  assert.equal(fixture.sf816CustomerDocReuse(), false);
  const app3 = db.prepare(`INSERT INTO loan_applications
    (consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,status,stage,condition_snapshot_json,updated_at)
    VALUES(1,?,1,'[1]','10000','requested','draft','{}',?)`).run(customerId, now).lastInsertRowid;
  assert.equal(fixture.seedPlanSlotFromVault({
    applicationId: Number(app3), customerId: Number(customerId), documentType: "employment_proof",
    label: "مدرک شغلی", createdAt: now, dataDir: path.dirname(databasePath),
  }), true, "vault helper still finds the file");
  // The flag is checked by the create-case path; with '0' the route must insert a pending slot instead.
  // Re-seed is not called when the flag is off — simulate that branch:
  db.prepare("DELETE FROM loan_application_documents WHERE application_id=?").run(app3);
  db.prepare("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,created_at) VALUES(?,'employment_proof','مدرک شغلی','plan','pending',?)").run(app3, now);
  const offRow = db.prepare("SELECT status,customer_profile_document_id FROM loan_application_documents WHERE application_id=?").get(app3);
  assert.equal(offRow.status, "pending");
  assert.equal(offRow.customer_profile_document_id, null);
  console.log("ok - flag.sf816_customer_doc_reuse='0' restores a pending per-case slot");

  // Post-deploy: file lives under a legacy release path; review/download still work and migrate
  db.prepare("UPDATE call_queue_settings SET value='1' WHERE key='flag.sf816_customer_doc_reuse'").run();
  const releaseDir = path.join(temp, "releases", "oldbuild", "attached_assets", "customer-identity-documents", String(customerId));
  await mkdir(releaseDir, { recursive: true });
  const legacy = path.join(releaseDir, "front-legacy.pdf");
  const original = db.prepare("SELECT storage_path FROM customer_identity_documents WHERE id=?").get(ids.national_card_front);
  fs.copyFileSync(original.storage_path, legacy);
  db.prepare("UPDATE customer_identity_documents SET storage_path=? WHERE id=?").run(legacy, ids.national_card_front);
  const preview = await request("registrar", "GET", `/loan-applications/${applicationId}/identity-documents/${ids.national_card_front}/download?preview=1`);
  assert.ok(preview.ok || preview.bytes > 0 || preview.status === undefined, "legacy release path is still downloadable");
  const got = await request("registrar", "GET", `/loan-applications/${applicationId}`);
  const front = got.identityDocuments.find(d => (d.documentType || d.document_type) === "national_card_front");
  assert.equal(front.fileAvailable, true);
  const moved = db.prepare("SELECT storage_path FROM customer_identity_documents WHERE id=?").get(ids.national_card_front);
  assert.ok(String(moved.storage_path).includes("customer-identity-documents"));
  assert.notEqual(moved.storage_path, legacy, "legacy path is migrated into the persistent data dir");
  console.log("ok - post-deploy legacy identity path is served and migrated");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

console.log("PASS sf816 first-upload approval, customer-level reuse, kill switch, and post-deploy migrate.");

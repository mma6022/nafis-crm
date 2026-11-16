import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-physical-documents-"));
const databasePath = path.join(tempRoot, "crm.db");
const secret = "physical-documents-fixture-secret";
const timestamp = new Date().toISOString();
const tokens = {
  registrar: randomBytes(24).toString("base64url"),
  funder: randomBytes(24).toString("base64url"),
};
let db;
let api;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  db = new DatabaseSync(databasePath);
  // Minimal pre-migration schema and entirely synthetic records. Never copy a
  // workspace, development, or production customer database into this fixture.
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      salesperson_id INTEGER);
    CREATE TABLE salespersons (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
      status TEXT, priority INTEGER DEFAULT 0, salesperson_id INTEGER);
    CREATE TABLE call_logs (id INTEGER PRIMARY KEY, customer_id INTEGER, salesperson_id INTEGER,
      salesperson_name_snapshot TEXT, created_at TEXT);
    CREATE TABLE reminders (id INTEGER PRIMARY KEY, user_id INTEGER, done INTEGER,
      remind_at TEXT, message TEXT, created_at TEXT);
    CREATE TABLE consultation_forms (id INTEGER PRIMARY KEY, customer_id INTEGER,
      requested_amount TEXT, updated_at TEXT);
    CREATE TABLE loan_applications (id INTEGER PRIMARY KEY, consultation_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL, requested_by_user_id INTEGER NOT NULL,
      plan_ids TEXT NOT NULL, requested_amount TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
      notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE loan_plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, principal_amount TEXT,
      deduct_percents TEXT);
    CREATE TABLE loan_plan_conditions (id INTEGER PRIMARY KEY, plan_id INTEGER);
    CREATE TABLE consult_options (id INTEGER PRIMARY KEY, field_key TEXT NOT NULL,
      option_value TEXT NOT NULL, label_fa TEXT NOT NULL, sort_order INTEGER, active INTEGER,
      UNIQUE(field_key, option_value));
  `);
  db.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active,created_at)
    VALUES(1,'fixture-registrar','fixture-only','Fixture Registrar','registrar',1,?),
          (2,'fixture-funder','fixture-only','Fixture Funder','funder',1,?)`).run(timestamp, timestamp);
  db.prepare("INSERT INTO customers(id,name,phone,status) VALUES(1,'Synthetic Fixture Customer','09000000000','in_progress')").run();
  db.prepare("INSERT INTO loan_plans(id,name,principal_amount,deduct_percents) VALUES(1,'Synthetic Fixture Plan','1000000',?)")
    .run(JSON.stringify({ "12": "10" }));
  db.prepare("INSERT INTO consultation_forms(id,customer_id,requested_amount,updated_at) VALUES(1,1,'1000000',?)").run(timestamp);

  const port = await freePort();
  let logs = "";
  api = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, CRM_DATABASE_PATH: databasePath, SESSION_SECRET: secret, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [api.stdout, api.stderr]) stream.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  let readinessDetail = "health endpoint did not respond";
  for (let i = 0; i < 450; i++) {
    if (api.exitCode !== null) throw new Error(`API exited before ready:\n${logs}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) { ready = true; break; }
      readinessDetail = `health endpoint returned ${response.status}: ${await response.text()}`;
    } catch (error) { readinessDetail = String(error); /* wait for the isolated server */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not become ready (${readinessDetail}):\n${logs}`);

  const insertApplication = db.prepare(`INSERT INTO loan_applications
    (id,consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,
     duration_months,requested_duration_months,stage,status,plan_snapshot_json,condition_snapshot_json,created_at,updated_at)
    VALUES(?,1,1,1,'[1]',1,'1000000',12,12,'physical_documents_submission','reviewing',?,?,?,?)`);
  insertApplication.run(1, JSON.stringify({ deduct_percents: { "12": "10" } }), "{}", timestamp, timestamp);
  insertApplication.run(2, JSON.stringify({ deduct_percents: { "12": "10" } }), "{}", timestamp, timestamp);
  for (const [role, userId] of [["registrar", 1], ["funder", 2]]) {
    db.prepare(`INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at)
      VALUES(?,?,?,?)`).run(
      createHmac("sha256", secret).update(tokens[role]).digest("hex"),
      userId,
      new Date(Date.now() + 180_000).toISOString(),
      timestamp,
    );
  }

  const postJson = (applicationId, action, role, body) => fetch(
    `${base}/loan-applications/${applicationId}/${action}`,
    {
      method: "POST",
      headers: { Cookie: `crm_session=${tokens[role]}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const uploadFile = (applicationId, role, filename, content) => {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "application/pdf" }), filename);
    return fetch(`${base}/loan-applications/${applicationId}/physical-documents`, {
      method: "POST",
      headers: { Cookie: `crm_session=${tokens[role]}` },
      body: form,
    });
  };

  // A role with review/view permission but no update permission cannot upload
  // or submit physical-document choices.
  const unauthorizedUpload = await uploadFile(1, "funder", "unauthorized.pdf", "synthetic unauthorized upload");
  assert.equal(unauthorizedUpload.status, 403, "funder must not upload physical documents");
  const unauthorizedSubmit = await postJson(1, "submit-physical-documents", "funder", { noPhysicalDocuments: false });
  assert.equal(unauthorizedSubmit.status, 403, "funder must not submit physical documents");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM loan_physical_documents WHERE application_id=1").get().count, 0);
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=1").get().stage, "physical_documents_submission");

  // The registrar can upload multiple files using the single-file upload
  // endpoint; each file is stored privately under the isolated database root.
  const first = await uploadFile(1, "registrar", "fixture-check.pdf", "synthetic private check fixture");
  const firstText = await first.text();
  assert.equal(first.status, 201, firstText);
  const firstResult = JSON.parse(firstText);
  const second = await uploadFile(1, "registrar", "fixture-note.pdf", "synthetic private note fixture");
  const secondText = await second.text();
  assert.equal(second.status, 201, secondText);
  const secondResult = JSON.parse(secondText);
  assert.equal(firstResult.fileAvailable, true);
  assert.equal(secondResult.fileAvailable, true);
  assert.notEqual(firstResult.id, secondResult.id);
  // A successful upload is incomplete unless the detail DTO returns the files
  // again: this was the actual regression concealed by upload-only assertions.
  const detail = await fetch(`${base}/loan-applications/1`, {
    headers: { Cookie: `crm_session=${tokens.registrar}` },
  });
  assert.equal(detail.status, 200, await detail.clone().text());
  const detailBody = await detail.json();
  assert.equal(detailBody.physicalDocuments.length, 2);
  assert.deepEqual(detailBody.physicalDocuments.map(d => d.id), [firstResult.id, secondResult.id]);
  assert.ok(detailBody.physicalDocuments.every(d => d.fileAvailable && !("storage_path" in d)));
  const download = await fetch(`${base}/loan-applications/1/physical-documents/${firstResult.id}/download`, {
    headers: { Cookie: `crm_session=${tokens.registrar}` },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "synthetic private check fixture");

  const physicalFiles = db.prepare(`SELECT id,original_name,storage_path,mime_type,size_bytes,uploaded_by_user_id
    FROM loan_physical_documents WHERE application_id=1 ORDER BY id`).all();
  assert.equal(physicalFiles.length, 2);
  for (const file of physicalFiles) {
    assert.ok(file.storage_path.startsWith(path.join(tempRoot, "loan-application-files") + path.sep));
    assert.equal(file.mime_type, "application/pdf");
    assert.ok(file.size_bytes > 0);
    assert.equal(file.uploaded_by_user_id, 1);
    assert.equal((await stat(file.storage_path)).mode & 0o777, 0o600, "uploaded files must be private");
  }
  assert.deepEqual(
    physicalFiles.map(({ original_name }) => original_name),
    ["fixture-check.pdf", "fixture-note.pdf"],
  );

  const falseNoDocuments = await postJson(1, "submit-physical-documents", "registrar", { noPhysicalDocuments: true });
  assert.equal(falseNoDocuments.status, 409);
  assert.equal((await falseNoDocuments.json()).error, "physical_documents_already_uploaded");
  assert.equal(db.prepare("SELECT stage FROM loan_applications WHERE id=1").get().stage, "physical_documents_submission");

  const submitted = await postJson(1, "submit-physical-documents", "registrar", { noPhysicalDocuments: false });
  const submittedText = await submitted.text();
  assert.equal(submitted.status, 200, submittedText);
  const submittedApplication = JSON.parse(submittedText);
  assert.equal(submittedApplication.stage, "physical_documents_review");
  const checks = db.prepare(`SELECT source,source_id,status FROM loan_physical_checks
    WHERE application_id=1 ORDER BY id`).all();
  assert.deepEqual(checks.map(({ source, source_id, status }) => [source, source_id, status]),
    physicalFiles.map((file) => ["physical_upload", file.id, "pending"]));

  // An honest no-document declaration skips review straight to wallet charge.
  const noDocuments = await postJson(2, "submit-physical-documents", "registrar", { noPhysicalDocuments: true });
  const noDocumentsText = await noDocuments.text();
  assert.equal(noDocuments.status, 200, noDocumentsText);
  const noDocumentApplication = JSON.parse(noDocumentsText);
  assert.equal(noDocumentApplication.stage, "wallet_charge_pending");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM loan_physical_documents WHERE application_id=2").get().count, 0);
  assert.deepEqual(
    db.prepare(`SELECT from_stage,to_stage,action FROM loan_application_stage_history
      WHERE application_id=2 ORDER BY id`).all()
      .map(({ from_stage, to_stage, action }) => [from_stage, to_stage, action]),
    [
      ["physical_documents_submission", "physical_documents_review", "physical-documents-none-declared"],
      ["physical_documents_review", "wallet_charge_pending", "physical-review-auto-approved-no-documents"],
    ],
  );

  console.log("PASS synthetic physical-document fixture: private multi-file upload, submit-to-review, no-document shortcut, upload/no-document conflict, and unauthorized-role denial.");
} finally {
  if (api && api.exitCode === null) {
    api.kill("SIGTERM");
    await new Promise((resolve) => api.once("exit", resolve));
  }
  db?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
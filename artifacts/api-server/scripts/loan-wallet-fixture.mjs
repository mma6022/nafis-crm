import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "crm-loan-wallet-"));
const databasePath = path.join(tempRoot, "crm.db");
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
  // Only the pre-migration tables are needed. All rows are synthetic; no
  // workspace, development, or production customer database is copied.
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, full_name TEXT,
      role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, salesperson_id INTEGER);
    CREATE TABLE salespersons (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT,
      status TEXT, priority INTEGER DEFAULT 0, salesperson_id INTEGER);
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
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO users(id,username,full_name,role,active,created_at) VALUES(1,'fixture-admin','Test Admin','admin',1,?)").run(timestamp);
  db.prepare("INSERT INTO customers(id,name,phone,status) VALUES(1,'Test Customer','09000000000','in_progress')").run();
  db.prepare("INSERT INTO loan_plans(id,name,principal_amount,deduct_percents) VALUES(1,'Test Plan','1000000',?)")
    .run(JSON.stringify({ "12": "10", "24": "12.5" }));
  db.prepare("INSERT INTO consultation_forms(id,customer_id,requested_amount,updated_at) VALUES(1,1,'1000000',?)").run(timestamp);

  const secret = "loan-wallet-fixture-secret";
  const token = randomBytes(24).toString("base64url");
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
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error(`API exited before ready:\n${logs}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; }
    } catch { /* wait for the isolated server */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not become ready:\n${logs}`);

  // The server creates its own schema/migrations; insert fixture workflow rows
  // only after it is ready to avoid racing those migrations.
  db.prepare(`INSERT INTO loan_applications
    (id,consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,
     approved_amount,duration_months,stage,status,plan_snapshot_json,condition_snapshot_json,created_at,updated_at)
    VALUES(1,1,1,1,'[1]',1,'1000000','800000',24,'expert_approval','reviewing',?,?,?,?)`)
    .run(JSON.stringify({ deduct_percents: { "12": "10", "24": "12.5" } }), "{}", timestamp, timestamp);
  const documentId = Number(db.prepare(`INSERT INTO loan_application_documents
    (application_id,requirement_key,label,source,status,storage_path,created_at)
    VALUES(1,'fixture','Test document','plan','approved',?,?)`)
    .run(path.join(tempRoot, "test-document.pdf"), timestamp).lastInsertRowid);
  db.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(1,'cash','4321',?)").run(timestamp);
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,1,?,?)")
    .run(createHmac("sha256", secret).update(token).digest("hex"), new Date(Date.now() + 60_000).toISOString(), timestamp);

  const request = async (suffix, role, body = {}) => {
    db.prepare("UPDATE users SET role=? WHERE id=1").run(role);
    const response = await fetch(`${base}/loan-applications/1/${suffix}`, {
      method: "POST",
      headers: { cookie: `crm_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const move = async (suffix, role, expectedStage, body) => {
    const result = await request(suffix, role, body);
    assert.equal(result.status, 200, `${suffix}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.stage, expectedStage);
  };
  const walletState = () => ({
    accounts: db.prepare("SELECT wallet_type,balance FROM wallet_accounts_v2 WHERE customer_id=1 ORDER BY wallet_type").all(),
    ledger: db.prepare("SELECT application_id,amount,kind,idempotency_key,wallet_id FROM wallet_ledger_v2 ORDER BY id").all(),
  });

  await move("expert-approve", "funder", "funder_result_review");
  assert.equal(db.prepare("SELECT funder_decision FROM loan_applications WHERE id=1").get().funder_decision, "approved");
  await move("confirm-funder", "registrar", "physical_documents_review");
  const checks = db.prepare("SELECT id,source,source_id,status FROM loan_physical_checks WHERE application_id=1").all();
  assert.deepEqual(checks.map(({ source, source_id, status }) => [source, source_id, status]),
    [["document", documentId, "pending"]]);
  let result = await request("approve-physical-documents", "registrar");
  assert.equal(result.status, 409, "unreviewed physical documents must block approval");
  assert.equal(result.body.error, "physical_documents_incomplete");
  assert.equal(walletState().ledger.length, 0);
  result = await request(`physical-checks/${checks[0].id}/review`, "registrar", { decision: "approved" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  await move("approve-physical-documents", "registrar", "wallet_charge_pending");
  assert.equal(walletState().ledger.length, 0, "physical approval must not charge early");
  await move("approve-wallet-charge", "admin", "final_invoice_pending_signature");
  const first = walletState();
  assert.equal(db.prepare("SELECT net_amount FROM loan_applications WHERE id=1").get().net_amount, "700000");
  assert.deepEqual(first.accounts.map(({ wallet_type, balance }) => [wallet_type, balance]),
    [["cash", "4321"], ["credit", "700000"]]);
  assert.equal(first.ledger.length, 1);
  assert.equal(first.ledger[0].amount, "700000");
  assert.equal(first.ledger[0].application_id, 1);
  assert.equal(first.ledger[0].idempotency_key, "loan-application:1:credit");
  assert.match(first.ledger[0].kind, /^loan_credit:/);
  assert.equal(first.ledger[0].wallet_id,
    db.prepare("SELECT id FROM wallet_accounts_v2 WHERE customer_id=1 AND wallet_type='credit'").get().id);

  result = await request("approve-wallet-charge", "admin");
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "invalid_stage_transition");
  assert.deepEqual(walletState(), first, "retry must not add another ledger entry or change either balance");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM loan_application_stage_history WHERE application_id=1 AND action='approve-wallet-charge'").get().count, 1);

  // Simulate a stale stage being restored after a successful charge: the
  // ledger's idempotency key must still prevent a second credit.
  db.prepare("UPDATE loan_applications SET stage='wallet_charge_pending' WHERE id=1").run();
  await move("approve-wallet-charge", "admin", "final_invoice_pending_signature");
  assert.deepEqual(walletState(), first, "replayed charge must preserve the original wallet balances and ledger");
  console.log("PASS funder, physical review, duration deduction, single credit charge, unchanged cash, and retry");
} finally {
  if (api && api.exitCode === null) {
    api.kill("SIGTERM");
    await new Promise((resolve) => api.once("exit", resolve));
  }
  db?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
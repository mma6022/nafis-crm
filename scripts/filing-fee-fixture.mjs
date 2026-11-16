import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-filing-fee-fixture-"));
const file = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"));
await backup(source, file);
source.close();
const db = new DatabaseSync(file);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get();
const registrar = db.prepare("SELECT id FROM users WHERE role='registrar' AND active=1 LIMIT 1").get();
const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get();
assert.ok(admin && registrar && customer);
const secret = randomBytes(32).toString("hex");
function session(userId) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", secret).update(token).digest("hex"),
    userId, new Date(Date.now() + 180_000).toISOString(), new Date().toISOString());
  return `crm_session=${token}`;
}
const adminCookie = session(admin.id), registrarCookie = session(registrar.id);
db.close();

const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
socket.close();
const environment = { ...process.env, PORT: String(port), CRM_DATABASE_PATH: file, SESSION_SECRET: secret, AUTO_BACKUP_DIR: path.join(temp, "backups") };
const child = spawn(process.execPath, ["dist/index.mjs"], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
const get = (route, cookie) => fetch(base + route, { headers: { Cookie: cookie } });
const post = (route, data, cookie, key = randomUUID(), headers = {}) => fetch(base + route, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Cookie: cookie, ...headers },
  body: JSON.stringify(data),
});
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try { if ((await get("/api/healthz", adminCookie)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not start: ${logs.slice(-1200)}`);
  const setup = new DatabaseSync(file);
  const ts = new Date().toISOString();
  const templateId = setup.prepare(`INSERT INTO contract_templates(name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at)
    VALUES('Fixture','fixture.docx','fixture.docx','fixture','[]','[]',?,?,?)`).run(admin.id, ts, ts).lastInsertRowid;
  const planId = setup.prepare("INSERT INTO loan_plans(name,filing_fee_toman,principal_amount,installment_terms,contract_template_id,active,created_at) VALUES('Fixture','1200','10000','[{\"installments\":12}]',?,1,?)")
    .run(templateId, ts).lastInsertRowid;
  setup.prepare("INSERT INTO loan_plan_conditions(plan_id) VALUES(?)").run(planId);
  setup.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash','5000',?) ON CONFLICT(customer_id,wallet_type) DO UPDATE SET balance='5000'")
    .run(customer.id, ts);
  setup.prepare("UPDATE customers SET national_code=NULL,birth_date_jalali=NULL,verification_status='unverified' WHERE id=?").run(customer.id);
  setup.prepare("DELETE FROM customer_credit_checks WHERE customer_id=?").run(customer.id);
  setup.close();

  const plans = await get(`/api/loan-applications/filing-fee-plans?customerId=${customer.id}`, adminCookie);
  assert.equal(plans.status, 200);
  assert.equal((await plans.json()).plans.length, 0, "fee plans stay unavailable until profile and credit prerequisites pass");
  const invalidCreate = await post("/api/loan-applications", {
    customerId: customer.id, planId: Number(planId), requestedAmount: "10000", durationMonths: 12, conditionId: 1, planIds: [Number(planId)],
  }, adminCookie);
  assert.equal(invalidCreate.status, 422);
  assert.equal((await invalidCreate.json()).error, "filing_fee_required");
  assert.equal((await post(`/api/customers/${customer.id}/verify`, {}, adminCookie)).status, 400, "identity verification must not require a fee");
  assert.equal((await post(`/api/customers/${customer.id}/credit-checks`, { nationalCode: "1234567890" }, adminCookie)).status, 400, "credit checks must not require a fee");
  assert.equal((await get("/api/company-wallet", registrarCookie)).status, 403);
  const key = randomUUID();
  const payload = { customerId: customer.id, planId: Number(planId) };
  const premature = await post("/api/loan-applications/filing-fee-charges", payload, adminCookie, key);
  assert.equal(premature.status, 422);
  assert.equal((await premature.json()).error, "customer_profile_incomplete");
  const prerequisites = new DatabaseSync(file);
  prerequisites.prepare("UPDATE customers SET national_code='1234567890',phone='09123456789',birth_date_jalali='1370/01/01',verification_status='unverified' WHERE id=?").run(customer.id);
  prerequisites.close();
  const unverified = await post("/api/loan-applications/filing-fee-charges", payload, adminCookie, key);
  assert.equal(unverified.status, 422);
  assert.equal((await unverified.json()).error, "customer_identity_not_verified");
  const verifiedWithoutCredit = new DatabaseSync(file);
  verifiedWithoutCredit.prepare("UPDATE customers SET verification_status='verified' WHERE id=?").run(customer.id);
  verifiedWithoutCredit.close();
  const missingCredit = await post("/api/loan-applications/filing-fee-charges", payload, adminCookie, key);
  assert.equal(missingCredit.status, 422);
  assert.equal((await missingCredit.json()).error, "credit_check_stale");
  const prerequisitesWithCredit = new DatabaseSync(file);
  prerequisitesWithCredit.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,national_code,status,score,score_label,created_at,updated_at,completed_at)
    VALUES(?,?,'1234567890','report_generated',700,'A',?,?,?)`).run(customer.id, admin.id, ts, ts, ts);
  prerequisitesWithCredit.close();
  const eligiblePlans = await get(`/api/loan-applications/filing-fee-plans?customerId=${customer.id}`, adminCookie);
  assert.ok((await eligiblePlans.json()).plans.some((item) => item.planId === Number(planId) && item.filingFeeToman === "1200"));
  const first = await post("/api/loan-applications/filing-fee-charges", payload, adminCookie, key);
  assert.equal(first.status, 201);
  const charge = await first.json();
  assert.equal(charge.amountToman, "1200");
  const invalidatePrerequisites = new DatabaseSync(file);
  invalidatePrerequisites.prepare("UPDATE customers SET verification_status='unverified' WHERE id=?").run(customer.id);
  invalidatePrerequisites.prepare("DELETE FROM customer_credit_checks WHERE customer_id=?").run(customer.id);
  invalidatePrerequisites.close();
  assert.equal((await post("/api/loan-applications/filing-fee-charges", payload, adminCookie, key)).status, 200);
  assert.equal((await post("/api/loan-applications/filing-fee-charges", { ...payload, planId: Number(planId) + 1 }, adminCookie, key)).status, 409);
  const restorePrerequisites = new DatabaseSync(file);
  restorePrerequisites.prepare("UPDATE customers SET verification_status='verified' WHERE id=?").run(customer.id);
  restorePrerequisites.prepare(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,national_code,status,score,score_label,created_at,updated_at,completed_at)
    VALUES(?,?,'1234567890','report_generated',700,'A',?,?,?)`).run(customer.id, admin.id, ts, ts, ts);
  restorePrerequisites.close();
  const changeFee = new DatabaseSync(file);
  changeFee.prepare("UPDATE loan_plans SET filing_fee_toman='90000' WHERE id=?").run(planId);
  changeFee.close();
  assert.equal((await post("/api/loan-applications/filing-fee-charges", payload, adminCookie)).status, 409, "insufficient cash must not partially transfer");
  const adjustPayload = { walletType: "cash", direction: "withdrawal", amountToman: "200", reason: "اصلاح دستی آزمایشی" };
  const adjustKey = randomUUID();
  assert.equal((await post("/api/company-wallet/adjustments", adjustPayload, registrarCookie, adjustKey)).status, 403);
  assert.equal((await post("/api/company-wallet/adjustments", adjustPayload, adminCookie, adjustKey)).status, 201);
  assert.equal((await post("/api/company-wallet/adjustments", adjustPayload, adminCookie, adjustKey)).status, 200);
  const shortage = await post("/api/company-wallet/adjustments", { ...adjustPayload, amountToman: "999999" }, adminCookie);
  assert.equal(shortage.status, 409);
  const wallet = await (await get("/api/company-wallet", adminCookie)).json();
  assert.equal(wallet.cashBalanceToman, "1000");
  assert.equal(wallet.creditBalanceToman, "0");
  const verify = new DatabaseSync(file);
  try {
    assert.equal(verify.prepare("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'").get(customer.id).balance, "3800");
    assert.equal(verify.prepare("SELECT COUNT(*) count FROM loan_filing_fee_charges WHERE idempotency_key=?").get(key).count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE kind='filing_fee_out'").get().count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) count FROM company_wallet_ledger WHERE kind='filing_fee'").get().count, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) count FROM company_wallet_ledger WHERE kind='manual_withdrawal'").get().count, 1);
  } finally { verify.close(); }
  console.log("Filing-fee fixture passed: post-profile/credit gate, atomic fixed-fee postings, retry safety, shortage and admin-only company adjustments.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
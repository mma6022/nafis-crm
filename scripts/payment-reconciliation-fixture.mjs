import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-payment-reconcile-"));
const file = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("../..", "attached_assets", "customers_1789823100050.db"));
await backup(source, file);
source.close();
const db = new DatabaseSync(file);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get();
const staff = db.prepare("SELECT id FROM users WHERE role<>'admin' AND active=1 LIMIT 1").get();
const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get();
assert.ok(admin && staff && customer);
const secret = randomBytes(32).toString("hex");
function session(id) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", secret).update(token).digest("hex"), id, new Date(Date.now() + 180_000).toISOString(), new Date().toISOString());
  return `crm_session=${token}`;
}
const adminCookie = session(admin.id), staffCookie = session(staff.id);
db.close();

const mock = path.join(temp, "mock-provider.mjs");
await writeFile(mock, `
const original = globalThis.fetch;
let count = 0;
globalThis.fetch = (url, options) => {
  if (String(url) === "https://payment.zarinpal.com/pg/v4/payment/verify.json") {
    const { merchant_id, amount, authority } = JSON.parse(options.body);
    if (merchant_id !== "test-merchant" || amount !== 12500) throw new Error("provider request mismatch");
    const code = authority === "TEST_DENIED" ? -22 : authority === "TEST_NO_RECEIPT" ? 101 : ++count === 1 ? 100 : 101;
    return Promise.resolve(new Response(JSON.stringify({data:{code,ref_id: authority === "TEST_NO_RECEIPT" ? null : 987654321}}), {status:200,headers:{"Content-Type":"application/json"}}));
  }
  return original(url, options);
};
`);
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
socket.close();
const child = spawn(process.execPath, ["--import", mock, "dist/index.mjs"], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), CRM_DATABASE_PATH: file, SESSION_SECRET: secret, ZARINPAL_MERCHANT_ID: "test-merchant", AUTO_BACKUP_DIR: path.join(temp, "backups") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
const base = `http://127.0.0.1:${port}/api`;
const get = (route, cookie) => fetch(base + route, { headers: { Cookie: cookie }, redirect: "manual" });
const post = (route, cookie) => fetch(base + route, { method: "POST", headers: { Cookie: cookie }, redirect: "manual" });
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try { if ((await get("/healthz", adminCookie)).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not start: ${logs.slice(-1200)}`);
  const setup = new DatabaseSync(file);
  const account = setup.prepare("SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'").get(customer.id);
  const walletId = account?.id ?? Number(setup.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash','0',?)").run(customer.id, new Date().toISOString()).lastInsertRowid);
  const initial = BigInt(account?.balance ?? "0");
  const addIntent = authority => Number(setup.prepare(
    "INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,status,idempotency_key,created_at) VALUES(?,?, '1250','12500',?,'created',?,?)")
    .run(customer.id, walletId, authority, `fixture-${authority}`, new Date().toISOString()).lastInsertRowid);
  const id = addIntent("TEST_PAID");
  setup.exec(`CREATE TRIGGER abort_payment_ledger BEFORE INSERT ON wallet_ledger_v2 WHEN NEW.idempotency_key='cash-payment:${id}' BEGIN SELECT RAISE(ABORT, 'simulated crash before commit'); END`);
  const route = `/customers/${customer.id}/wallet`;
  assert.equal((await get(`/wallet/zarinpal/callback?Authority=TEST_PAID&Status=OK`, adminCookie)).status, 303);
  assert.equal(setup.prepare("SELECT status FROM wallet_payment_intents WHERE id=?").get(id).status, "created");
  assert.equal(setup.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=?").get(walletId).balance, initial.toString());
  assert.equal(setup.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE idempotency_key=?").get(`cash-payment:${id}`).n, 0);
  assert.equal((await get(`/wallet/zarinpal/callback?Authority=TEST_PAID&Status=OK`, adminCookie)).status, 303);
  assert.equal(setup.prepare("SELECT status FROM wallet_payment_intents WHERE id=?").get(id).status, "provider_already_verified");
  assert.equal(setup.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=?").get(walletId).balance, initial.toString());
  setup.exec("DROP TRIGGER abort_payment_ledger");
  assert.equal((await post(`${route}/payments/${id}/reconcile`, staffCookie)).status, 403);
  assert.equal((await get(`${route}/payment-reconciliation`, staffCookie)).status, 403);
  const result = await post(`${route}/payments/${id}/reconcile`, adminCookie);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "credited", providerRefId: "987654321" });
  assert.equal((await post(`${route}/payments/${id}/reconcile`, adminCookie)).status, 200);
  assert.equal(setup.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=?").get(walletId).balance, (initial + 1250n).toString());
  assert.equal(setup.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE idempotency_key=?").get(`cash-payment:${id}`).n, 1);
  assert.equal(setup.prepare("SELECT status,provider_ref_id,reconciled_by_user_id FROM wallet_payment_intents WHERE id=?").get(id).provider_ref_id, "987654321");
  for (const authority of ["TEST_DENIED", "TEST_NO_RECEIPT", "TEST_DUPLICATE_RECEIPT"]) {
    const rejectedId = addIntent(authority);
    assert.equal((await post(`${route}/payments/${rejectedId}/reconcile`, adminCookie)).status, 409);
  }
  assert.equal(setup.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=?").get(walletId).balance, (initial + 1250n).toString());
  setup.close();
  process.stdout.write("Payment recovery after verify/commit interruption, idempotence and authorization passed\n");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
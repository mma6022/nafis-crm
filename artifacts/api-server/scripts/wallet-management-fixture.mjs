import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-wallet-fixture-"));
const file = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("..", "..", "attached_assets", "customers_1789823100050.db"));
await backup(source, file);
source.close();
const db = new DatabaseSync(file);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get();
const staff = db.prepare("SELECT id FROM users WHERE role='registrar' AND active=1 LIMIT 1").get();
const salesperson = db.prepare("SELECT id,salesperson_id FROM users WHERE role='salesperson' AND active=1 LIMIT 1").get();
const customers = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 2").all();
assert.ok(admin && staff && customers.length === 2, "fixture needs an admin, registrar, and two customers");
const [from, to] = customers.map((c) => c.id);
const secret = randomBytes(32).toString("hex");
const session = (userId) => {
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    createHmac("sha256", secret).update(token).digest("hex"),
    userId, new Date(Date.now() + 180_000).toISOString(), new Date().toISOString(),
  );
  return `crm_session=${token}`;
};
const adminCookie = session(admin.id), staffCookie = session(staff.id);
const salespersonCookie = salesperson ? session(salesperson.id) : null;
const timestamp = new Date().toISOString();
for (const [customer, balance] of [[from, "5000"], [to, "0"]]) {
  db.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash',?,?) ON CONFLICT(customer_id,wallet_type) DO UPDATE SET balance=excluded.balance")
    .run(customer, balance, timestamp);
}
db.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'credit','200',?) ON CONFLICT(customer_id,wallet_type) DO UPDATE SET balance='200'").run(from,timestamp);
const creditWallet = db.prepare("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'").get(from);
db.prepare("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,created_at) VALUES(?,'200',?,?,?)")
  .run(creditWallet.id, `loan_credit:actor:${admin.id}`, `fixture-credit:${randomUUID()}`, timestamp);
const fromSalespersonId = db.prepare("SELECT salesperson_id FROM customers WHERE id=?").get(from).salesperson_id;
db.close();

const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
socket.close();
const environment = { ...process.env, PORT: String(port), CRM_DATABASE_PATH: file, SESSION_SECRET: secret, AUTO_BACKUP_DIR: path.join(temp, "backups") };
delete environment.ZARINPAL_MERCHANT_ID;
delete environment.PAYMENT_CALLBACK_BASE_URL;
const child = spawn(process.execPath, ["dist/index.mjs"], { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
const get = async (route, cookie) => fetch(base + route, { headers: cookie ? { Cookie: cookie } : undefined });
const post = async (route, data, cookie, key = randomUUID()) => fetch(base + route, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Cookie: cookie },
  body: JSON.stringify(data),
});
try {
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try { if ((await get("/api/healthz")).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `API did not start: ${logs.slice(-1200)}`);

  const denied = await post("/api/wallet-management/transfers", {
    fromCustomerId: from, toCustomerId: to, walletType: "cash", amountToman: "100", reason: "آزمون انتقال",
  }, staffCookie);
  assert.equal(denied.status, 403, "non-admin must not transfer");
  const transferKey = randomUUID();
  const transfer = { fromCustomerId: from, toCustomerId: to, walletType: "cash", amountToman: "1200", reason: "آزمون انتقال بین مشتریان" };
  const success = await post("/api/wallet-management/transfers", transfer, adminCookie, transferKey);
  assert.equal(success.status, 201);
  const transferId = (await success.json()).id;
  assert.equal((await post("/api/wallet-management/transfers", transfer, adminCookie, transferKey)).status, 200, "retry must not move funds again");
  const shortage = await post("/api/wallet-management/transfers", { ...transfer, amountToman: "99999999" }, adminCookie);
  assert.equal(shortage.status, 409);
  const failedTransferId = (await shortage.json()).id;
  assert.equal((await post("/api/wallet-management/transfers", { ...transfer, toCustomerId: from }, adminCookie)).status, 400);

  const payment = await post(`/api/customers/${from}/wallet/cash-payment`, { amountToman: "345" }, adminCookie);
  assert.equal(payment.status, 503, "missing gateway config should fail without contacting provider");
  const report = await get("/api/wallet-management/transactions?kind=payment&status=failed&limit=10", adminCookie);
  assert.equal(report.status, 200);
  const paymentRows = (await report.json()).items;
  assert.ok(paymentRows.some((r) => r.customerId === from && r.amountToman === "345" && r.actorId === admin.id && r.errorCode === "configuration_unavailable"), "pre-gateway attempt must be reported");
  const transfers = await get("/api/wallet-management/transactions?kind=transfer&walletType=cash&limit=100", adminCookie);
  assert.equal(transfers.status, 200);
  assert.ok((await transfers.json()).items.some((r) => r.recordId === failedTransferId && r.status === "failed"));
  const byActor = await get(`/api/wallet-management/transactions?actorId=${admin.id}&kind=transfer`, adminCookie);
  assert.ok((await byActor.json()).items.some((r) => r.recordId === transferId));
  const credits = await get(`/api/wallet-management/transactions?actorId=${admin.id}&kind=loan_credit&customerId=${from}`, adminCookie);
  assert.ok((await credits.json()).items.some((r) => r.amountToman === "200" && r.actorId === admin.id));
  const accountFrom = await get(`/api/wallet-management/accounts?search=${from}`, adminCookie);
  const accountTo = await get(`/api/wallet-management/accounts?search=${to}`, adminCookie);
  assert.equal(accountFrom.status, 200);
  assert.equal(accountTo.status, 200);
  assert.equal((await accountFrom.json()).items.find((r) => r.customerId === from).cashBalanceToman, "3800");
  assert.equal((await accountTo.json()).items.find((r) => r.customerId === to).cashBalanceToman, "1200");
  assert.equal((await get("/api/wallet-management/accounts?sortBy=balance;DROP%20TABLE%20customers", adminCookie)).status, 400);
  assert.equal((await get("/api/wallet-management/accounts?minCash=100&maxCash=10", adminCookie)).status, 400);
  const walletFilters = new DatabaseSync(file);
  walletFilters.prepare("UPDATE wallet_accounts_v2 SET balance=? WHERE customer_id=? AND wallet_type='cash'").run("90071992547409930", from);
  walletFilters.prepare("UPDATE wallet_accounts_v2 SET balance=? WHERE customer_id=? AND wallet_type='cash'").run("90071992547409931", to);
  const filterCustomer = walletFilters.prepare("SELECT name,phone FROM customers WHERE id=?").get(from);
  walletFilters.close();
  const high = "90071992547409930";
  const highQuery = `minCash=${high}&maxCash=90071992547409931&sortBy=cashBalanceToman&sortDir=desc&limit=1`;
  const firstBalancePage = await get(`/api/wallet-management/accounts?${highQuery}&page=1`, adminCookie);
  const secondBalancePage = await get(`/api/wallet-management/accounts?${highQuery}&page=2`, adminCookie);
  assert.equal((await firstBalancePage.json()).items[0].customerId, to, "money sorting must retain integer precision");
  assert.equal((await secondBalancePage.json()).items[0].customerId, from, "sort must apply across pagination");
  const byName = await get(`/api/wallet-management/accounts?name=${encodeURIComponent(filterCustomer.name)}&search=${from}`, adminCookie);
  assert.ok((await byName.json()).items.some((r) => r.customerId === from));
  const byPhone = await get(`/api/wallet-management/accounts?phone=${encodeURIComponent(filterCustomer.phone)}&search=${from}`, adminCookie);
  assert.ok((await byPhone.json()).items.some((r) => r.customerId === from));
  assert.equal((await get("/api/wallet-management/transactions", undefined)).status, 401);
  if (salespersonCookie && salesperson.salesperson_id !== null) {
    const scopedAccounts = await get(`/api/wallet-management/accounts?search=${from}`, salespersonCookie);
    assert.equal(scopedAccounts.status, 200);
    if (fromSalespersonId !== salesperson.salesperson_id) {
      assert.equal((await scopedAccounts.json()).items.some((r) => r.customerId === from), false);
      const scopedTransfers = await get(`/api/wallet-management/transactions?kind=transfer&customerId=${from}`, salespersonCookie);
      assert.equal((await scopedTransfers.json()).items.length, 0);
    }
  }

  const final = new DatabaseSync(file);
  try {
    assert.equal(final.prepare("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE idempotency_key LIKE ?").get(`wallet-transfer:${transferId}:%`).count, 2);
    assert.equal(final.prepare("SELECT COUNT(*) count FROM wallet_transfers WHERE id=?").get(transferId).count, 1);
    assert.equal(final.prepare("SELECT COUNT(*) count FROM wallet_ledger_v2 WHERE idempotency_key LIKE ?").get(`wallet-transfer:${failedTransferId}:%`).count, 0);
  } finally { final.close(); }
  console.log("Wallet management fixture passed: authorization, atomic transfer, retry, failure audit, pre-gateway payment, filters and balances.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
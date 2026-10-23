import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const temp = await mkdtemp(path.join(os.tmpdir(), "crm-wallet-share-"));
const file = path.join(temp, "customers.db");
const source = new DatabaseSync(path.resolve("../..", "attached_assets", "customers_1789823100050.db"));
await backup(source, file); source.close();
const db = new DatabaseSync(file);
const staff = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get();
const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get();
const otherCustomer = db.prepare("SELECT id FROM customers WHERE id<>? ORDER BY id LIMIT 1").get(customer?.id);
assert.ok(staff && customer && otherCustomer);
const secret = randomBytes(32).toString("hex");
const rawSession = randomBytes(24).toString("base64url");
db.prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
  createHmac("sha256", secret).update(rawSession).digest("hex"), staff.id,
  new Date(Date.now() + 180000).toISOString(), new Date().toISOString());
db.close();
const mock = path.join(temp, "provider.mjs");
await writeFile(mock, `
import { createHmac } from "node:crypto";
const original = globalThis.fetch; let requestNo = 0; let smsPosts = 0;
globalThis.fetch = async (url, options) => {
  if (String(url).includes(":18787/send")) {
    smsPosts++;
    const body = String(options.body);
    const expected = createHmac("sha256", "sms-secret").update(options.headers["X-Relay-Timestamp"] + "." + body).digest("hex");
    if (options.headers["X-Relay-Signature"] !== expected) return new Response(JSON.stringify({ok:false,error:"bad_signature"}), {status:401});
    const payload = JSON.parse(body);
    if (payload.code !== "uvqibx6zabmclkb" || Object.keys(payload.params).sort().join(",") !== "link,name") return new Response(JSON.stringify({ok:false}), {status:400});
    return new Response(JSON.stringify({ok:true}), {status:200});
  }
  if (String(url).includes("/pg/v4/payment/request.json")) {
    await new Promise(r => setTimeout(r, 60));
    const authority = ++requestNo === 3 ? "SHARE_PENDING" : "SHARE_AUTH_"+requestNo;
    return new Response(JSON.stringify({data:{code:100,authority}}), {status:200});
  }
  if (String(url).includes("/pg/v4/payment/verify.json")) {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({data:{code: body.authority === "SHARE_PENDING" ? 101 : 100,ref_id: 990000001}}), {status:200});
  }
  return original(url, options);
};
`);
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port; socket.close();
const child = spawn(process.execPath, ["--import", mock, "dist/index.mjs"], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), CRM_DATABASE_PATH: file,
     SESSION_SECRET: secret, IR_RELAY_SHARED_SECRET: "sms-secret", ZARINPAL_MERCHANT_ID: "fixture", PAYMENT_CALLBACK_BASE_URL: "https://pay.example.test",
    AUTO_BACKUP_DIR: path.join(temp, "backups") }, stdio: ["ignore", "pipe", "pipe"],
});
let logs = ""; child.stdout.on("data", x => { logs += x; }); child.stderr.on("data", x => { logs += x; });
const base = `http://127.0.0.1:${port}/api`, cookie = `crm_session=${rawSession}`;
const get = route => fetch(base + route, { headers: { Cookie: cookie }, redirect: "manual" });
const getWithoutAuth = route => fetch(base + route, { redirect: "manual" });
const post = (route, body, withCookie = false) => fetch(base + route, {
  method: "POST", headers: { "Content-Type": "application/json", ...(withCookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body), redirect: "manual",
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await get("/healthz")).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, logs.slice(-1000));
  const planDb = new DatabaseSync(file);
  const ts = new Date().toISOString();
  const template = planDb.prepare("INSERT INTO contract_templates(name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at) VALUES('Share','share.docx','share.docx','share','[]','[]',?,?,?)").run(staff.id, ts, ts).lastInsertRowid;
  const plan = planDb.prepare("INSERT INTO loan_plans(name,filing_fee_toman,principal_amount,installment_terms,contract_template_id,active,created_at) VALUES('Share plan','1500','100000','[{\"installments\":12}]',?,1,?)").run(template, ts).lastInsertRowid;
  planDb.prepare("INSERT INTO loan_plan_conditions(plan_id,customer_ranks,installment_options) VALUES(?,'[\"A\"]','[{\"installments\":12}]')").run(plan);
  planDb.prepare("UPDATE customers SET national_code='1111111111',phone='09120000000',birth_date_jalali='1370/01/01',verification_status='verified' WHERE id=?").run(customer.id);
  planDb.prepare("INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,national_code,status,score,score_label,created_at,updated_at,completed_at) VALUES(?,?,'1111111111','report_generated',700,'A',?,?,?)").run(customer.id, staff.id, ts, ts, ts);
  planDb.close();
  const planCreated = await post(`/customers/${customer.id}/wallet/share-links`, { planId: Number(plan) }, true);
  assert.equal(planCreated.status, 200);
  assert.equal((await planCreated.json()).amountToman, "1500", "object installment terms remain eligible");
  assert.equal((await getWithoutAuth(`/customers/${customer.id}/wallet/share-links`)).status, 401);
  const guarded = await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1000" }, true);
  assert.equal(guarded.status, 409);
  assert.deepEqual(await guarded.json(), { error: "active_share_link_exists" });
  assert.equal((await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1000" })).status, 401);
  const created = await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1000", confirmActiveRequest: true }, true);
  assert.equal(created.status, 200);
  const link = await created.json(); const parsed = new URL(link.url);
  const token = parsed.searchParams.get("token"); const query = parsed.search;
  assert.equal((await post(`/customers/${customer.id}/wallet/share-links/${token}/send-sms`, {}, false)).status, 401);
  const sms = await Promise.all([
    post(`/customers/${customer.id}/wallet/share-links/${token}/send-sms`, {}, true),
    post(`/customers/${customer.id}/wallet/share-links/${token}/send-sms`, {}, true),
  ]);
  assert.equal(sms.filter(r => r.ok).length, 1);
  assert.equal(sms.filter(r => r.status === 409).length, 1);
  assert.equal((await post(`/customers/${customer.id}/wallet/share-links/${token}/send-sms`, {}, true)).status, 409);
  assert.equal((await get(`/wallet/share-links/${token}${query}`)).status, 200);
  assert.equal((await get(`/wallet/share-links/${token}?token=${token}&customerId=999&amountToman=1000`)).status, 400);
  const starts = await Promise.all([post(`/wallet/share-links/${token}/start${query}`), post(`/wallet/share-links/${token}/start${query}`)]);
  assert.equal(starts.filter(r => r.ok).length, 1);
  const started = starts.find(r => r.ok); const payment = await started.json();
  assert.match(payment.paymentUrl, /SHARE_AUTH_1$/);
  const verifyDb = new DatabaseSync(file);
  assert.equal(verifyDb.prepare("SELECT count(*) n FROM wallet_payment_intents").get().n, 1);
  verifyDb.close();
  assert.equal((await post(`/wallet/share-links/${token}/start${query}`)).status, 200);
  const badCallback = await get(`/wallet/zarinpal/callback?Authority=SHARE_AUTH_1&Status=OK&token=wrong&customerId=${customer.id}&amountToman=1000`);
  assert.equal(badCallback.status, 400);
  const callbackQuery = query.slice(1);
  const goodCallback = await get(`/wallet/zarinpal/callback?Authority=SHARE_AUTH_1&Status=OK&${callbackQuery}`);
  assert.equal(goodCallback.status, 303);
  const check = new DatabaseSync(file);
  const intent = check.prepare("SELECT id,status FROM wallet_payment_intents WHERE authority='SHARE_AUTH_1'").get();
  assert.equal(intent.status, "credited");
  assert.equal(check.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE idempotency_key=?").get(`cash-payment:${intent.id}`).n, 1);
  check.close();
  assert.equal((await get(`/wallet/zarinpal/callback?Authority=SHARE_AUTH_1&Status=OK&${callbackQuery}`)).status, 303);
  const after = new DatabaseSync(file);
  assert.equal(after.prepare("SELECT count(*) n FROM wallet_ledger_v2 WHERE idempotency_key LIKE 'cash-payment:%'").get().n, 1);
  after.close();
  const cancelledCreate = await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1100", confirmActiveRequest: true }, true);
  const cancelledUrl = new URL((await cancelledCreate.json()).url);
  const cq = cancelledUrl.search;
  assert.equal((await post(`/wallet/share-links/${cancelledUrl.searchParams.get("token")}/start${cq}`)).status, 200);
  const cancelledCallback = await get(`/wallet/zarinpal/callback?Authority=SHARE_AUTH_2&Status=CANCEL&${cq.slice(1)}`);
  assert.equal(cancelledCallback.status, 303);
  const cancelledStatus = await get(`/wallet/share-links/${cancelledUrl.searchParams.get("token")}${cq}`);
  assert.equal((await cancelledStatus.json()).status, "cancelled");
  const pendingCreate = await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1200", confirmActiveRequest: true }, true);
  const pendingUrl = new URL((await pendingCreate.json()).url);
  const pq = pendingUrl.search;
  const pendingToken = pendingUrl.searchParams.get("token");
  assert.equal((await post(`/wallet/share-links/${pendingToken}/start${pq}`)).status, 200);
  assert.equal((await get(`/wallet/zarinpal/callback?Authority=SHARE_PENDING&Status=OK&${pq.slice(1)}`)).status, 303);
  const pendingStatus = await get(`/wallet/share-links/${pendingToken}${pq}`);
  assert.equal((await pendingStatus.json()).status, "reconciliation");
  const historyDb = new DatabaseSync(file);
  const historyWallet = historyDb.prepare("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'").get(customer.id);
  const historyFuture = new Date(Date.now() + 86400000).toISOString();
  const verificationIntent = historyDb.prepare("INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,status,idempotency_key,created_at) VALUES(?,?,'1600','16000','HISTORY_VERIFY','created','history-verify',?)")
    .run(customer.id, historyWallet.id, ts).lastInsertRowid;
  historyDb.prepare("INSERT INTO wallet_payment_attempts(customer_id,payment_intent_id,amount_toman,idempotency_key,status,created_at,updated_at) VALUES(?,?,'1600','history-verify','verification_pending',?,?)")
    .run(customer.id, verificationIntent, ts, ts);
  historyDb.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,status,payment_intent_id,expires_at,created_at) VALUES(?,?,'1600','started',?,?,?)")
    .run("fixture-verification-token-hash", customer.id, verificationIntent, historyFuture, ts);
  historyDb.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,status,expires_at,created_at) VALUES(?,?,'1501','starting',?,?)")
    .run("fixture-processing-token-hash", customer.id, historyFuture, ts);
  historyDb.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,status,expires_at,created_at) VALUES(?,?,'1502','failed',?,?)")
    .run("fixture-failed-token-hash", customer.id, historyFuture, ts);
  historyDb.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,status,expires_at,created_at) VALUES(?,?,'1300','created',?,?)")
    .run("fixture-expired-token-hash", customer.id, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 86400000).toISOString());
  historyDb.close();
  const historyResponse = await get(`/customers/${customer.id}/wallet/share-links`);
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.headers.get("cache-control"), "no-store");
  const history = (await historyResponse.json()).items;
  assert.equal(history.length, 8);
  for (const item of history) {
    assert.deepEqual(Object.keys(item).sort(), ["amountToman", "createdAt", "expiresAt", "id", "isActive", "paymentStatus", "planId", "planName", "smsStatus"].sort());
    assert.ok(!JSON.stringify(item).match(/token|hash|claim|https?:\/\//i), "history must redact bearer material");
  }
  const byAmount = Object.fromEntries(history.map(item => [item.amountToman, item]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(byAmount).map(([amount, item]) => [amount, [item.paymentStatus, item.isActive]])),
    {
      "1000": ["credited", false],
      "1100": ["cancelled", false],
      "1200": ["requires_reconciliation", true],
      "1300": ["expired", false],
      "1500": ["pending", true],
      "1501": ["processing", true],
      "1502": ["failed", false],
      "1600": ["verification_pending", true],
    },
  );
  assert.equal(byAmount["1000"].smsStatus, "sent");
  assert.equal(byAmount["1500"].planId, Number(plan));
  assert.equal(byAmount["1500"].planName, "Share plan");
  const isolatedHistory = await get(`/customers/${otherCustomer.id}/wallet/share-links`);
  assert.equal(isolatedHistory.status, 200);
  assert.deepEqual(await isolatedHistory.json(), { items: [] });
  const stillGuarded = await post(`/customers/${customer.id}/wallet/share-links`, { amountToman: "1400" }, true);
  assert.equal(stillGuarded.status, 409, "unresolved payment remains active even when other links expire");
  assert.deepEqual(await stillGuarded.json(), { error: "active_share_link_exists" });
  const staffDb = new DatabaseSync(file);
  const wallet = staffDb.prepare("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'").get(customer.id);
  const legacy = staffDb.prepare("INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,status,idempotency_key,created_at) VALUES(?,?, '10','100','STAFF_AUTH','created','staff-fixture',?)")
    .run(customer.id, wallet.id, new Date().toISOString()).lastInsertRowid;
  staffDb.close();
  const legacyCallback = await get(`/wallet/zarinpal/callback?Authority=STAFF_AUTH&Status=CANCEL`);
  assert.equal(legacyCallback.status, 303);
  assert.match(legacyCallback.headers.get("location"), new RegExp(`/customers/${customer.id}`));
  assert.ok(legacy);
  console.log("Wallet share fixture passed: auth, guarded creation, redacted isolated history, status derivation, tamper rejection, concurrent/repeated start, callback replay, cancellation, reconciliation and atomic single credit.");
} finally {
  child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve));
  await rm(temp, { recursive: true, force: true });
}
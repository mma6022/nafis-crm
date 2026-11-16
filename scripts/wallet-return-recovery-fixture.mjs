import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const temp = await mkdtemp(path.join(os.tmpdir(), "wallet-recovery-fixture-"));
let server;
const originalFetch = globalThis.fetch;
try {
  await symlink(path.resolve("node_modules"), path.join(temp, "node_modules"));
  process.env.SESSION_SECRET = "synthetic-wallet-receipt-secret-123456789";
  process.env.ZARINPAL_MERCHANT_ID = "synthetic-merchant";
  process.env.PAYMENT_CALLBACK_BASE_URL = "https://example.invalid";
  const db = `
    import {DatabaseSync} from "node:sqlite";
    export const crmDb=new DatabaseSync(":memory:");
    crmDb.exec(\`CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,merged_into_customer_id INTEGER);
      INSERT INTO customers VALUES(1,'Synthetic fixture',NULL);
      CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
      CREATE TABLE loan_applications(id INTEGER PRIMARY KEY);
      CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT);
      INSERT INTO schema_migrations VALUES('wallets-two-wallets-v1','2026-01-01');\`);
    export const queryRow=(sql,p=[])=>crmDb.prepare(sql).get(...p);
    export const queryRows=(sql,p=[])=>crmDb.prepare(sql).all(...p);
    export const execute=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).lastInsertRowid);
    export const executeChanges=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).changes);
    export const runTransaction=fn=>{crmDb.exec("BEGIN IMMEDIATE");try{const r=fn();crmDb.exec("COMMIT");return r;}catch(e){crmDb.exec("ROLLBACK");throw e;}};
  `;
  const stubs = {
    "crm-db": db,
    "auth": "export const requireAuth=(_q,_s,n)=>n();",
    "access-control": "export const requirePermission=()=>((_q,_s,n)=>n());",
    "customer-notifications": "export const getNotificationSettings=()=>({}); export const normalizeIranianMobile=v=>v; export const sendWalletShareSms=()=>{throw Error('network forbidden');};",
    "credit-rank-eligibility": "export const conditionAcceptsCreditRank=()=>true;",
    "company-purchase-receipts": "export const ensureCompanyPurchaseReceiptSchema=()=>{};",
    "goods-finance": "export const allocateGoodsLoanCredit=()=>{throw Error('not in scope');};",
    "logger": "export const logger={info:()=>{},warn:()=>{},error:()=>{}};",
  };
  await build({
    stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
      import express from "express";
      import router from "./src/routes/wallets";
      import {isPublicWalletRequest} from "./src/lib/wallet-public-access";
      export {isPublicWalletRequest};
      export {crmDb} from "./src/lib/crm-db";
      export {recoverPendingWalletPayments,createWalletPaymentReceipt,readWalletPaymentReceipt,verifyAndCreditWalletPayment} from "./src/lib/wallet-payment-recovery";
      export const app=express();app.use(express.json());
      app.use("/api",(req,res,next)=>isPublicWalletRequest(req.method,req.path)?next():res.status(401).json({error:"Unauthorized"}),router);
    ` },
    outfile: path.join(temp, "fixture.mjs"), bundle: true, format: "esm", platform: "node", external: ["express"],
    plugins: [{ name: "isolated", setup(b) {
      b.onResolve({ filter: /\/(?:crm-db|auth|access-control|customer-notifications|credit-rank-eligibility|company-purchase-receipts|goods-finance|logger)$/ },
        a => ({ path: a.path.split("/").pop(), namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, a => ({ contents: stubs[a.path], loader: "ts" }));
    } }],
  });
  const f = await import(pathToFileURL(path.join(temp, "fixture.mjs")).href);
  const modes = new Map(), checks = new Map(), receipts = new Map();
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("payment.zarinpal.com")) {
      const body = JSON.parse(options.body);
      assert.equal(body.merchant_id, "synthetic-merchant"); assert.equal(body.amount, 12500);
      if (String(url).endsWith("/request.json")) {
        assert.equal(new URL(body.callback_url).search, "");
        assert.equal(body.callback_url, "https://example.invalid/api/wallet/zarinpal/callback");
        return new Response(JSON.stringify({ data: { code: 100, authority: "MOCK_GENERATED" } }));
      }
      const n = (checks.get(body.authority) ?? 0) + 1; checks.set(body.authority, n);
      const mode = modes.get(body.authority);
      if (mode === "network") throw new TypeError("synthetic unavailable");
      if (mode === "denied") return new Response(JSON.stringify({ errors: { code: -51 } }), { status: 422 });
      const code = mode === "repeat" || n > 1 ? 101 : 100;
      return new Response(JSON.stringify({ data: { code, ref_id: mode === "missing" ? null : receipts.get(body.authority) } }));
    }
    return originalFetch(url, options);
  };
  const d = f.crmDb;
  const old = new Date(Date.now() - 120000).toISOString();
  const walletId = Number(d.prepare("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(1,'cash','0',?)").run(old).lastInsertRowid);
  const add = (authority, mode = "paid", shared = true) => {
    const id = Number(d.prepare("INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,idempotency_key,created_at) VALUES(1,?,'1250','12500',?,?,?)").run(walletId, authority, authority, old).lastInsertRowid);
    d.prepare("INSERT INTO wallet_payment_attempts(customer_id,payment_intent_id,amount_toman,idempotency_key,status,created_at,updated_at) VALUES(1,?,'1250',?,'gateway_ready',?,?)").run(id, authority, old, old);
    if (shared) d.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,status,payment_intent_id,expires_at,created_at) VALUES(?,1,'1250','started',?,?,?)").run(`hash-${id}`, id, new Date(Date.now() + 86400000).toISOString(), old);
    modes.set(authority, mode); receipts.set(authority, String(990000 + id)); return id;
  };
  server = f.app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(f.isPublicWalletRequest("POST", "/wallet/share-links/receipt/signed"), false);
  assert.equal(f.isPublicWalletRequest("GET", "/customers/1/wallet"), false);
  assert.equal(f.isPublicWalletRequest("GET", "/customers/1/wallet/payment-reconciliation"), false);
  assert.equal((await originalFetch(`${base}/api/customers/1/wallet`)).status, 401);
  const callback = authority => originalFetch(`${base}/api/wallet/zarinpal/callback?Authority=${authority}&Status=OK`, { redirect: "manual" });
  const posted = id => d.prepare("SELECT COUNT(*) n FROM wallet_ledger_v2 WHERE idempotency_key=?").get(`cash-payment:${id}`).n;
  const shareToken = "s".repeat(43);
  d.prepare("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,expires_at,created_at) VALUES(?,1,'1250',?,?)")
    .run(createHash("sha256").update(shareToken).digest("hex"), new Date(Date.now() + 86400000).toISOString(), old);
  const started = await originalFetch(`${base}/api/wallet/share-links/${shareToken}/start?customerId=1&amountToman=1250`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(started.status, 200);
  receipts.set("MOCK_GENERATED", "998888");
  await callback("MOCK_GENERATED");
  const first = add("MOCK_RETURN");
  const response = await callback("MOCK_RETURN");
  assert.equal(response.status, 303);
  const receipt = new URL(response.headers.get("location"), base).searchParams.get("receipt");
  assert.ok(receipt); assert.equal(posted(first), 1);
  const result = await originalFetch(`${base}/api/wallet/share-links/receipt/${receipt}`);
  const data = await result.json();
  assert.equal(data.status, "credited"); assert.equal(data.amountToman, "1250");
  assert.equal(data.customerId, undefined); assert.equal(data.customerName, undefined);
  assert.equal(data.wallet, undefined); assert.equal(data.token, undefined);
  assert.equal((await callback("MOCK_RETURN")).status, 303); assert.equal(posted(first), 1);
  assert.equal(checks.get("MOCK_RETURN"), 1);
  assert.equal((await originalFetch(`${base}/api/wallet/share-links/receipt/${receipt.slice(0, -1)}${receipt.endsWith("a") ? "b" : "a"}`)).status, 404);
  assert.equal(f.readWalletPaymentReceipt(`999.1.${"a".repeat(64)}`), null);
  const repeat = add("MOCK_PREVIOUSLY_VERIFIED", "repeat");
  await Promise.all([callback("MOCK_PREVIOUSLY_VERIFIED"), callback("MOCK_PREVIOUSLY_VERIFIED")]);
  assert.equal(posted(repeat), 1); assert.equal(checks.get("MOCK_PREVIOUSLY_VERIFIED"), 1);
  const absent = add("MOCK_CLOSED_BROWSER");
  const missing = add("MOCK_MISSING_RECEIPT", "missing");
  const denied = add("MOCK_UNPAID", "denied");
  const unavailable = add("MOCK_NETWORK", "network");
  await f.recoverPendingWalletPayments();
  assert.equal(posted(absent), 1);
  for (const id of [missing, denied, unavailable]) assert.equal(posted(id), 0);
  const crash = add("MOCK_CRASH");
  d.exec(`CREATE TRIGGER fixture_crash BEFORE INSERT ON wallet_ledger_v2 WHEN NEW.idempotency_key='cash-payment:${crash}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  await callback("MOCK_CRASH"); assert.equal(posted(crash), 0);
  d.exec("DROP TRIGGER fixture_crash");
  await callback("MOCK_CRASH"); assert.equal(posted(crash), 1);
  assert.equal(checks.get("MOCK_CRASH"), 2);
  const reused = add("MOCK_REUSED_RECEIPT");
  receipts.set("MOCK_REUSED_RECEIPT", receipts.get("MOCK_RETURN"));
  await callback("MOCK_REUSED_RECEIPT"); assert.equal(posted(reused), 0);
  const cancelled = add("MOCK_CANCELLED", "denied");
  await originalFetch(`${base}/api/wallet/zarinpal/callback?Authority=MOCK_CANCELLED&Status=NOK`, { redirect: "manual" });
  assert.equal(d.prepare("SELECT status FROM wallet_payment_intents WHERE id=?").get(cancelled).status, "cancelled");
  modes.set("MOCK_CANCELLED", "repeat");
  d.prepare("UPDATE wallet_payment_attempts SET updated_at=? WHERE payment_intent_id=?").run(old, cancelled);
  await f.recoverPendingWalletPayments(); assert.equal(posted(cancelled), 1);
  assert.equal(d.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=?").get(walletId).balance, "7500");
  console.log("Wallet recovery passed: callback without share parameters, signed read-only receipt, replay/tamper protection, closed browser recovery, 101/crash recovery, cancellation race, amount/receipt guards, unpaid/network/missing-receipt non-credit.");
} finally {
  globalThis.fetch = originalFetch;
  if (server) await new Promise(r => server.close(r));
  await rm(temp, { recursive: true, force: true });
}

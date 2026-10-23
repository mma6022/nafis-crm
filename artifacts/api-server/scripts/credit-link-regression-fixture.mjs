import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

// Entirely synthetic SQLite/auth/provider boundaries. Never open a CRM backup.
const temp = await mkdtemp(path.join(os.tmpdir(), "credit-link-regression-"));
process.env.PAYMENT_CALLBACK_BASE_URL = "https://crm.nafisvam.com";
process.env.IR_RELAY_SHARED_SECRET = "synthetic-fixture-only";
const crm = await readFile("src/routes/crm.ts", "utf8");
const notifications = await readFile("src/lib/customer-notifications.ts", "utf8");
const realMobile = notifications.slice(notifications.indexOf("export function normalizeIranianMobile"), notifications.indexOf("\nfunction fillTemplate"));
const realSms = notifications.slice(notifications.indexOf("export async function sendWalletShareSms"), notifications.indexOf("\nexport async function notifyNewCustomer"));
const start = crm.indexOf("async function refreshCreditCheck(");
const refresh = crm.slice(start, crm.indexOf("\nrouter.", start));
const dbModule = `
import {DatabaseSync} from "node:sqlite";
export const db=new DatabaseSync(":memory:");
export const queryRows=(s,p=[])=>s.includes("wallet_share_links")?[]:db.prepare(s).all(...p);
export const queryRow=(s,p=[])=>db.prepare(s).get(...p);
export const execute=(s,p=[])=>Number(db.prepare(s).run(...p).lastInsertRowid);
export const executeChanges=(s,p=[])=>Number(db.prepare(s).run(...p).changes);
export const runTransaction=f=>{db.exec("BEGIN");try{const x=f();db.exec("COMMIT");return x;}catch(e){db.exec("ROLLBACK");throw e;}};
`;
const modules = {
  "crm-db": dbModule,
  wallets: `export const ensureWalletSchema=()=>{};export const wallet=()=>({id:1,balance:"0"});
    export const creditVerifiedCashPayment=()=>{};export const getWalletSummary=()=>({});
    export const getWalletSummaryReadOnly=()=>({});`,
  auth: `export const requireAuth=(req,res,next)=>{if(req.headers["x-deny"])return res.sendStatus(401);
    res.locals.authUser={id:1,role:req.headers["x-role"]||"admin",customerScope:"all",permissions:["customers.view","customers.credit_check"]};next();};`,
  "wallet-payment-recovery": `export const verifyProvider=async()=>{throw Error("unexpected_payment_verification")};
    export const updatePaymentAttempt=()=>{};export const verifyAndCreditWalletPayment=()=>{throw Error("unexpected_wallet_credit")};
    export const createWalletPaymentReceipt=()=>{};export const readWalletPaymentReceipt=()=>{};
    export const walletPaymentReceiptData=()=>{};`,
  "access-control": `export const requirePermission=()=>((req,res,next)=>next());`,
  "customer-notifications": `import {createHmac} from "node:crypto";
    export const getNotificationSettings=()=>({ippanelEnabled:true,ippanelRelayUrl:"http://sms.synthetic.invalid/send",ippanelFromNumber:"+983000505"});
    ${realMobile}
    ${realSms}
    export const sent=[];let mode="accepted";export const setMode=value=>mode=value;
    const nativeFetch=globalThis.fetch;globalThis.fetch=async(input,options)=>{
      if(String(input)!=="http://sms.synthetic.invalid/send") return nativeFetch(input,options);
      const payload=JSON.parse(options.body);sent.push(payload.params.link);
      if(mode==="unknown") throw new Error("synthetic transport timeout");
      return new Response(JSON.stringify({ok:true,data:{meta:{status:mode!=="rejected"},
        data:mode==="rejected"?null:{message_outbox_ids:[12345]}}}),{status:200});
    };`,
};
const out = path.join(temp, "test.mjs");
const expressPath = createRequire(import.meta.url).resolve("express");
await build({
  stdin: { contents: `import express from "express";import router from "./src/routes/wallets";
    import {db,queryRow,execute,executeChanges,runTransaction} from "./src/lib/crm-db";
    import {sent,setMode} from "./src/lib/customer-notifications";
    import {creditProviderFailure} from "./src/lib/credit-provider-failure";
    export {db,sent,setMode,creditProviderFailure};
    export const app=express();app.use(express.json());app.use("/api",router);
    const ics24={status:async()=>({status:"NotMatchingRealPersonNationalCodeAndMobileNumber",statusTitle:"provider closed"})};
    const getCreditCheck=(customer,id)=>queryRow("SELECT * FROM customer_credit_checks WHERE customer_id=? AND id=?",[customer,id]);
    ${refresh}
    export {refreshCreditCheck};`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "node", format: "esm", packages: "external", outfile: out, logLevel: "silent",
  plugins: [{ name: "synthetic", setup(b) {
    if (process.env.TEST_WALLET_BASELINE) b.onLoad({ filter: /src\/routes\/wallets\.ts$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const baseline = await readFile(process.env.TEST_WALLET_BASELINE, "utf8");
      const nativeStart = baseline.indexOf('router6.post("/customers/:customerId/wallet/share-links"');
      const nativeEnd = baseline.indexOf('router6.post("/customers/:customerId/wallet/share-links/:token/send-sms"', nativeStart);
      const start = source.indexOf('router.post("/customers/:customerId/wallet/share-links"');
      const end = source.indexOf('router.post("/customers/:customerId/wallet/share-links/:token/send-sms"', start);
      assert.ok(nativeStart > 0 && nativeEnd > nativeStart && start > 0 && end > start);
      const handler = baseline.slice(nativeStart, nativeEnd).replaceAll("router6.", "router.")
        .replaceAll("randomBytes4(", "randomBytes(");
      return { contents: source.slice(0, start) + handler + source.slice(end), loader: "ts" };
    });
    b.onResolve({ filter: /^express$/ }, () => ({ path: expressPath, external: true }));
    b.onResolve({ filter: /\/lib\/(crm-db|wallets|auth|access-control|customer-notifications|wallet-payment-recovery)$/ }, ({ path: p }) =>
      ({ path: p.split("/").pop(), namespace: "synthetic" }));
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, ({ path: p }) => ({ contents: modules[p], loader: "ts" }));
  }}],
});
let server, db;
try {
  const f = await import(pathToFileURL(out)); db = f.db;
  db.exec(`
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,national_code TEXT,phone TEXT,birth_date_jalali TEXT,
      verification_status TEXT,merged_into_customer_id INTEGER,salesperson_id INTEGER,credit_rank TEXT);
    INSERT INTO customers VALUES(1,'Synthetic','0000000000','09120000000','1370/01/01','verified',NULL,NULL,'A1');
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,active INTEGER,contract_template_id INTEGER,
      primary_contract_template_id INTEGER,principal_amount TEXT,installment_terms TEXT,filing_fee_toman TEXT,name TEXT);
    INSERT INTO loan_plans VALUES(1,1,1,NULL,'100000000','[12]','1000000','Synthetic plan');
    CREATE TABLE loan_plan_conditions(plan_id INTEGER,customer_ranks TEXT,max_principal TEXT,installment_options TEXT);
    INSERT INTO loan_plan_conditions VALUES(1,'["D"]','100000000','[12]');
    CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT,score_label TEXT,
      completed_at TEXT,provider_reference TEXT,provider_status TEXT,error_message TEXT,updated_at TEXT);
    CREATE TABLE wallet_share_links(id INTEGER PRIMARY KEY,token_hash TEXT,customer_id INTEGER,amount_toman TEXT,
      plan_id INTEGER,status TEXT,expires_at TEXT,created_at TEXT,sms_status TEXT,sms_claim TEXT,
      sms_token_hash TEXT,sms_message_id TEXT,payment_intent_id INTEGER);
    CREATE TABLE wallet_payment_attempts(payment_intent_id INTEGER,status TEXT);
  `);
  db.prepare("INSERT INTO customer_credit_checks VALUES(1,1,'report_generated','D2',?,'synthetic',NULL,NULL,NULL)")
    .run(new Date().toISOString());
  server = f.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/customers/1/wallet/share-links`;
  const request = () => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"planId":1}' });
  const response = await request();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();assert.equal(body.amountToman, "1000000");
  const token = new URL(body.url).searchParams.get("token");assert.ok(token);
  const send = await fetch(`${base}/${token}/send-sms`, {method:"POST"});
  assert.equal(send.status, 200, await send.clone().text());
  assert.equal((await send.json()).status, "sent");assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].length,40);
  const shortToken = new URL(f.sent[0]).pathname.slice(1);
  const publicBase = `http://127.0.0.1:${server.address().port}/api/wallet/share-links`;
  const publicResponse = await fetch(`${publicBase}/${shortToken}`);
  assert.equal(publicResponse.status,200,await publicResponse.clone().text());
  assert.equal((await publicResponse.json()).amountToman,"1000000");
  assert.equal((await fetch(`${publicBase}/${shortToken}?amountToman=1`)).status,400);
  assert.equal((await fetch(`${publicBase}/~xxxxxxxxxxxxxx`)).status,404);
  assert.equal(db.prepare("SELECT sms_message_id FROM wallet_share_links WHERE id=1").get().sms_message_id,"12345");
  assert.equal((await fetch(`${base}/${token}/send-sms`, {method:"POST"})).status, 409);
  assert.equal(f.sent.length, 1);
  db.exec("UPDATE wallet_share_links SET sms_status=NULL,sms_message_id=NULL");
  f.setMode("rejected");
  assert.equal((await fetch(`${base}/${token}/send-sms`,{method:"POST"})).status,503);
  assert.equal(db.prepare("SELECT sms_status FROM wallet_share_links WHERE id=1").get().sms_status,null);
  f.setMode("unknown");
  assert.equal((await fetch(`${base}/${token}/send-sms`,{method:"POST"})).status,503);
  assert.equal(db.prepare("SELECT sms_status FROM wallet_share_links WHERE id=1").get().sms_status,"delivery_unknown");
  assert.equal((await fetch(`${base}/${token}/send-sms`,{method:"POST"})).status,409);
  db.exec("UPDATE customer_credit_checks SET score_label='A1'");
  assert.equal((await request()).status, 422); // Do not loosen rank restrictions.
  db.exec("UPDATE customer_credit_checks SET score_label='D2';UPDATE customers SET verification_status='failed'");
  assert.equal((await request()).status, 422);
  assert.equal((await fetch(base, {method:"POST",headers:{"x-deny":"yes","Content-Type":"application/json"},body:'{"planId":1}'})).status, 401);
  db.exec(`UPDATE customers SET verification_status='verified';
    INSERT INTO customer_credit_checks VALUES(2,1,'awaiting_otp',NULL,NULL,'synthetic','NotMatchingRealPersonNationalCodeAndMobileNumber','RequestProcessedBefore',NULL)`);
  const closed = await f.refreshCreditCheck(db.prepare("SELECT * FROM customer_credit_checks WHERE id=2").get());
  assert.equal(closed.status, "failed");assert.match(closed.error_message, /تطابق/);
  assert.equal(db.prepare("SELECT credit_rank FROM customers WHERE id=1").get().credit_rank, "A1");
  assert.equal(db.prepare("SELECT status FROM customer_credit_checks WHERE id=1").get().status, "report_generated");
  assert.equal(f.creditProviderFailure("Processing"), null);
  assert.equal(f.creditProviderFailure("AwaitingToken"), null);
  const expiry = f.creditProviderFailure("RequestExpired");
  assert.match(expiry, /پایان/);
  assert.equal(f.creditProviderFailure(null, "RequestExpired، تاریخ اعتبار این درخواست به اتمام رسیده است"), expiry);
  assert.equal(f.creditProviderFailure(null, "ResendWait، چند لحظه صبر کنید"), null);
  assert.equal(f.creditProviderFailure(null, "نشست سرویس اعتبارسنجی منقضی شده است."), null);
  db.exec(`INSERT INTO customer_credit_checks VALUES(3,1,'awaiting_otp',NULL,NULL,'synthetic','Entry','RequestExpired، درخواست منقضی شده است',NULL)`);
  const expired = await f.refreshCreditCheck(db.prepare("SELECT * FROM customer_credit_checks WHERE id=3").get());
  assert.equal(expired.status, "failed");
  assert.equal(expired.provider_status, "RequestExpired");
  assert.equal(db.prepare("SELECT credit_rank FROM customers WHERE id=1").get().credit_rank, "A1");
  assert.equal((await f.refreshCreditCheck(db.prepare("SELECT * FROM customer_credit_checks WHERE id=1").get())).status, "report_generated");
  // Same explicit staff exemption used by plan selection and filing-fee payment.
  db.exec("UPDATE customer_credit_checks SET completed_at='2000-01-01T00:00:00.000Z'");
  const exemptRequest = (input = {}, role = "admin") => fetch(base, { method: "POST",
    headers: { "Content-Type": "application/json", "x-role": role },
    body: JSON.stringify({ planId: 1, ...input }) });
  assert.equal((await exemptRequest()).status, 422, "ordinary links still require fresh successful credit");
  assert.equal((await exemptRequest({ ignoreCreditRank: "true" })).status, 400, "string flags are never authorization");
  assert.equal((await exemptRequest({ ignoreCreditRank: true }, "registrar")).status, 403);
  for (const role of ["admin", "salesperson"]) {
    const response = await exemptRequest({ ignoreCreditRank: true }, role);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).amountToman, "1000000");
  }
  db.exec("UPDATE customers SET verification_status='failed'");
  assert.equal((await exemptRequest({ ignoreCreditRank: true })).status, 422, "identity stays mandatory");
  db.exec("UPDATE customers SET verification_status='verified';UPDATE loan_plan_conditions SET installment_options='[]';UPDATE loan_plans SET installment_terms='[]'");
  assert.equal((await exemptRequest({ ignoreCreditRank: true })).status, 422, "duration configuration stays mandatory");
  db.exec("UPDATE loan_plan_conditions SET installment_options='[12]';UPDATE loan_plans SET installment_terms='[12]',filing_fee_toman='0'");
  assert.equal((await exemptRequest({ ignoreCreditRank: true })).status, 422, "only a positive genuine cash shortfall may be linked");
  assert.equal(f.sent.length, 3, "creating additional links never automatically resends SMS or starts payment");
  console.log("PASS actual wallet API: ordinary and exempt eligibility, strict role/type/identity/duration/shortfall checks, exact-once SMS; credit failures preserve successful historical rank");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.close(); await rm(temp, {recursive:true,force:true});
}
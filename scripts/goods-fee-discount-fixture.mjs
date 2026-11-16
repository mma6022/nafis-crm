import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temp = await mkdtemp(path.join(os.tmpdir(), "goods-fee-discount-"));
process.env.FEE_DISCOUNT_FIXTURE = path.join(temp, "synthetic.db");
const mockDb = `
  import { DatabaseSync } from "node:sqlite";
  export const crmDb = new DatabaseSync(process.env.FEE_DISCOUNT_FIXTURE);
  crmDb.exec("PRAGMA foreign_keys=ON");
  export const execute=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).lastInsertRowid);
  export const executeChanges=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).changes);
  export const queryRow=(sql,p=[])=>crmDb.prepare(sql).get(...p);
  export const queryRows=(sql,p=[])=>crmDb.prepare(sql).all(...p);
  export function runTransaction(fn) { crmDb.exec("BEGIN");try {const r=fn();crmDb.exec("COMMIT");return r;}
    catch(e){crmDb.exec("ROLLBACK");throw e;} }
`;
const bundle = path.join(temp, "fixture.mjs");
await build({
  stdin: { contents: `export * from "./src/lib/goods-finance";
    export * from "./src/lib/company-purchase-receipts"; export * from "./src/lib/goods-settlement-amounts";
    export * from "./src/lib/crm-db";`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "synthetic-only-boundaries",
    setup(b) {
      b.onResolve({ filter: /crm-db$/ }, () => ({ path: "synthetic-db", namespace: "fixture" }));
      b.onResolve({ filter: /goods-documents$/ }, () => ({ path: "signed-document-state", namespace: "fixture" }));
      b.onResolve({ filter: /customer-merge-access$/ }, () => ({ path: "merge-access", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({
        contents: name === "synthetic-db" ? mockDb : name === "merge-access"
          ? "export const assertArchivedCustomerSurvivorAccess=()=>{};"
          : `export const goodsDocumentState=()=>({signed:true,invoiceVersion:1});
             export const assertInvoiceEditable=()=>{};export const invalidateGoodsInvoice=()=>{};`,
        loader: "js",
      }));
    },
  }],
});
let db;
try {
  const f = await import(pathToFileURL(bundle));
  db = f.crmDb;
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE contract_templates(id INTEGER PRIMARY KEY);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY);
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT);
    INSERT INTO schema_migrations VALUES('goods-plan-allocation-v1','synthetic');
    INSERT INTO users VALUES(1);INSERT INTO salespersons VALUES(1,'Synthetic seller');
    INSERT INTO customers VALUES(1,'Synthetic customer',1,NULL);INSERT INTO loan_plans VALUES(1,'Synthetic plan');
    INSERT INTO contract_templates VALUES(1);INSERT INTO loan_applications VALUES(1);
    CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER,wallet_type TEXT,balance TEXT);
    CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,wallet_id INTEGER,application_id INTEGER,amount TEXT,
      kind TEXT,idempotency_key TEXT UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT);
    CREATE TABLE company_wallet_accounts(wallet_type TEXT PRIMARY KEY,balance TEXT);
    CREATE TABLE company_wallet_ledger(id INTEGER PRIMARY KEY,wallet_type TEXT,amount_toman TEXT,kind TEXT,
      fee_charge_id INTEGER,reason TEXT,actor_user_id INTEGER,actor_customer_id INTEGER,idempotency_key TEXT UNIQUE,created_at TEXT);
  `);
  f.ensureGoodsFinanceSchema();
  f.ensureCompanyPurchaseReceiptSchema(db);
  const originalSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='goods_purchases'").get().sql;
  assert.ok(originalSchema.includes("base_payout_amount_toman"));
  function reset() {
    db.exec(`DELETE FROM company_wallet_ledger;DELETE FROM goods_purchase_events;DELETE FROM goods_finance_ledger;
      DELETE FROM goods_credit_lots;DELETE FROM goods_purchases;DELETE FROM goods_plan_wallets;
      DELETE FROM wallet_ledger_v2;DELETE FROM wallet_accounts_v2;DELETE FROM goods_company_wallets;
      DELETE FROM goods_salesperson_wallets;DELETE FROM company_wallet_accounts;
      INSERT INTO company_wallet_accounts VALUES('cash','0'),('credit','0');
      INSERT INTO wallet_accounts_v2 VALUES(1,1,'credit','300000000');
      INSERT INTO wallet_ledger_v2 VALUES(1,1,1,'300000000','loan_credit:actor:1','loan:1',1,NULL,'synthetic');
      INSERT INTO goods_plan_wallets VALUES(1,1,1,'300000000');`);
    const p = {
      id: 1, customer_id: 1, plan_id: 1, salesperson_id: 1, wallet_id: 1,
      stage: "settlement_pending", credit_amount_toman: "300000000", principal_amount_toman: "300000000",
      payout_amount_toman: "180000000", base_payout_amount_toman: "180000000", fee_discount_toman: "0",
      development_discount_toman: "51000000", company_credit_toman: "249000000", payout_bps: 6000,
      development_discount_bps: 1700, acknowledgement_template_id: 1, invoice_version: 1,
      invoice_signed_version: 1, created_by: 1, created_at: "synthetic",
      commission_settings_json: JSON.stringify({ target1_toman: "200000000", target2_toman: "400000000",
        target3_toman: "600000000", rate0_bps: 100, rate1_bps: 100, rate2_bps: 100, rate3_bps: 100 }),
    };
    db.prepare(`INSERT INTO goods_purchases(${Object.keys(p).join(",")}) VALUES(${Object.keys(p).map(() => "?").join(",")})`)
      .run(...Object.values(p));
    db.exec(`INSERT INTO goods_credit_lots VALUES(1,1,1,'300000000','300000000',1,0);`);
  }
  for (const [delta, payout] of [["0", "180000000"], ["5000000", "185000000"], ["-5000000", "175000000"]]) {
    reset();
    const p = f.settleGoodsPurchase(1, 1, delta);
    assert.equal(p.payoutAmountToman, payout);
    assert.equal(p.feeDiscountToman, delta);
    assert.equal(p.basePayoutAmountToman, "180000000");
    assert.equal(f.settleGoodsPurchase(1, 1, delta).payoutAmountToman, payout);
    assert.equal(f.settleGoodsPurchase(1, 1).payoutAmountToman, payout);
    assert.throws(() => f.settleGoodsPurchase(1, 1, delta === "0" ? "1" : "0"), /discount_locked/);
    assert.equal(db.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance, "0");
    assert.equal(db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='credit'").get().balance, "249000000");
    assert.equal(db.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 1);
    assert.deepEqual(JSON.parse(db.prepare("SELECT detail FROM goods_purchase_events WHERE action='settled'").get().detail), {
      basePayoutAmountToman: "180000000", feeDiscountToman: delta, payoutAmountToman: payout,
    });
    // Fee adjustment affects customer payout only, not sale volume/commission.
    db.exec("UPDATE goods_purchases SET stage='registrar_confirmation',acknowledgement_signed=1");
    const complete = f.completeGoodsPurchase(1, 1);
    assert.equal(complete.payoutAmountToman, payout);
    assert.equal(complete.commissionToman ?? complete.commission_toman, "1800000");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  }
  for (const bad of [null, 1000, "1.5", "+500", "1e6", "-180000000", "-180000001", {}, "9".repeat(31)]) {
    reset();
    assert.throws(() => f.settleGoodsPurchase(1, 1, bad), /invalid_fee_discount|invalid_customer_payout/);
    assert.equal(f.getGoodsPurchase(1).stage, "settlement_pending");
    assert.equal(f.getGoodsPurchase(1).payoutAmountToman, "180000000");
    assert.equal(db.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance, "300000000");
    assert.equal(db.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 0);
  }
  reset();
  db.exec(`CREATE TRIGGER simulate_late_failure BEFORE INSERT ON goods_purchase_events
    BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END;`);
  assert.throws(() => f.settleGoodsPurchase(1, 1, "5000000"), /synthetic late failure/);
  assert.equal(f.getGoodsPurchase(1).payoutAmountToman, "180000000");
  assert.equal(db.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance, "300000000");
  assert.equal(db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='credit'").get().balance, "0");
  console.log("PASS real settlement on synthetic SQLite: zero/positive/negative, final payout, unchanged gross/company credit, immutable replay, completion/commission, invalid input and full rollback");
} finally {
  db?.close();
  await rm(temp, { recursive: true, force: true });
}
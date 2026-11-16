// Actual portal options/fee handlers; synthetic SQLite only, no provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(path.resolve('artifacts/api-server/package.json'));
const { transformSync, buildSync } = require('esbuild');
const express = require('express');
const portal = fs.readFileSync('artifacts/api-server/src/routes/customer-portal-loans.ts','utf8');
const loans = fs.readFileSync('artifacts/api-server/src/routes/loan-applications.ts','utf8');
function declaration(text, name) {
  const start = text.indexOf(`function ${name}(`); assert(start >= 0, name);
  return text.slice(start, text.indexOf('\n}',start)+2);
}
const helperNames = ['freshSuccessfulCredit','reusableFilingFeeCharge','planAcceptsCustomerCredit','effectivePlanTerms','payablePlan'];
const helpers = helperNames.map(n=>declaration(loans,n)).join('\n')+
  ['parseConditionRanks','profilePrerequisite','planConditions'].map(n=>declaration(portal,n)).join('\n');
const errorCode = portal.slice(portal.indexOf('const filingFeeMessages'),portal.indexOf('\ntype PortalCustomer'));
const optionsCode = portal.slice(portal.indexOf('router.get("/loan-options"'),portal.indexOf('\nrouter.get("/identity-documents"'));
const feeCode = portal.slice(portal.indexOf('router.post("/filing-fee"'),portal.indexOf('\nrouter.use("/applications/:id"'));
const rankModule = { exports: {} };
new Function('module','exports',buildSync({entryPoints:['artifacts/api-server/src/lib/credit-rank-eligibility.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text)(rankModule,rankModule.exports);
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE customers(id INTEGER PRIMARY KEY,phone TEXT,national_code TEXT,birth_date_jalali TEXT,identity_changed_at TEXT);
INSERT INTO customers VALUES(1,'09000000001','0012345678','1370/01/01',NULL);
CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT,created_at TEXT,completed_at TEXT,score_label TEXT,score INTEGER);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,active INTEGER,contract_template_id INTEGER,primary_contract_template_id INTEGER,principal_amount TEXT,installment_terms TEXT,filing_fee_toman TEXT,name TEXT,min_principal TEXT);
INSERT INTO loan_plans VALUES(7,1,1,NULL,'300000000','[24]','300000','آزمایشی','0');
CREATE TABLE loan_plan_conditions(id INTEGER PRIMARY KEY,plan_id INTEGER,sort_order INTEGER,customer_ranks TEXT,max_principal TEXT,installment_options TEXT,min_principal TEXT);
INSERT INTO loan_plan_conditions VALUES(71,7,0,'["A"]','300000000','[24]','0'),(72,7,1,'["B"]','200000000','[24]','0');
CREATE TABLE contract_templates(id INTEGER PRIMARY KEY,mappings_json TEXT,deleted_at TEXT);
INSERT INTO contract_templates VALUES(1,'[]',NULL);
CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,deleted_at TEXT,status TEXT);
CREATE TABLE loan_filing_fee_charges(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,amount_toman TEXT,idempotency_key TEXT UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT,application_id INTEGER);
CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER,wallet_type TEXT,balance TEXT);
INSERT INTO wallet_accounts_v2 VALUES(1,1,'cash','300000');
CREATE TABLE company_wallet_accounts(wallet_type TEXT PRIMARY KEY,balance TEXT);
INSERT INTO company_wallet_accounts VALUES('cash','0');
CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,wallet_id INTEGER,amount TEXT,kind TEXT,idempotency_key TEXT UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT);
CREATE TABLE company_wallet_ledger(id INTEGER PRIMARY KEY,wallet_type TEXT,amount_toman TEXT,kind TEXT,fee_charge_id INTEGER,actor_user_id INTEGER,actor_customer_id INTEGER,idempotency_key TEXT UNIQUE,created_at TEXT);
`);
const stamp = new Date().toISOString();
db.prepare("INSERT INTO customer_credit_checks VALUES(1,1,'report_generated',?,?,'B1',650)").run(stamp,stamp);
const queryRow=(sql,params=[])=>db.prepare(sql).get(...params);
const queryRows=(sql,params=[])=>db.prepare(sql).all(...params);
const bindings = {
  Router:express.Router, queryRow, queryRows,
  execute:(sql,p=[])=>Number(db.prepare(sql).run(...p).lastInsertRowid),
  executeChanges:(sql,p=[])=>Number(db.prepare(sql).run(...p).changes),
  runImmediateTransaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
  portalCustomer:()=>queryRow('SELECT * FROM customers WHERE id=1'),
  wallet:(id,type)=>queryRow('SELECT * FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?',[id,type]),
  conditionAcceptsCreditRank:rankModule.exports.conditionAcceptsCreditRank,
};
const js=transformSync(`const {${Object.keys(bindings)}}=deps;const router=Router();const now=()=>new Date().toISOString();function parseJson(v){try{return v?JSON.parse(v):null;}catch{return null;}}\n${helpers}\n${errorCode}\n${optionsCode}\n${feeCode}\nreturn router;`,{loader:'ts',target:'es2022'}).code;
const app=express();app.use(express.json(),new Function('deps',js)(bindings));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
const getOptions=async()=> (await (await fetch(base+'/loan-options')).json()).plans[0];
const pay=async(conditionId,key='synthetic-fee-0001')=>{
  const r=await fetch(base+'/filing-fee',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({planId:7,conditionId,requestedAmount:'100000000',durationMonths:24})});
  return {status:r.status,data:await r.json()};
};
try {
  assert.deepEqual((await getOptions()).conditions.map(c=>c.id),[72], 'B1 never auto-selects first A-only condition');
  assert.equal((await getOptions()).maximumAmount,'200000000','The customer sees their eligible cap, not A cap');
  const wrong=await pay(71);assert.equal(wrong.status,422);assert.equal(wrong.data.code,'loan_plan_condition_not_matched');assert.match(wrong.data.message,/شرایط/);
  assert.equal(queryRow('SELECT balance FROM wallet_accounts_v2').balance,'300000');
  db.exec("UPDATE wallet_accounts_v2 SET balance='299999'");
  const low=await pay(72);assert.equal(low.status,409);assert.equal(low.data.code,'insufficient_cash_balance');assert.match(low.data.message,/موجودی/);
  db.exec("UPDATE wallet_accounts_v2 SET balance='300000'");
  db.exec("CREATE TRIGGER synthetic_ledger_failure BEFORE INSERT ON company_wallet_ledger BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.equal((await pay(72)).status,500);
  assert.equal(queryRow('SELECT balance FROM wallet_accounts_v2').balance,'300000','Ledger failure rolls back debit');
  assert.equal(queryRow('SELECT count(*) n FROM loan_filing_fee_charges').n,0);
  assert.equal(queryRow('SELECT count(*) n FROM wallet_ledger_v2').n,0);
  db.exec('DROP TRIGGER synthetic_ledger_failure');
  const paid=await pay(72);assert.equal(paid.status,201);
  assert.equal(queryRow('SELECT balance FROM wallet_accounts_v2').balance,'0');
  assert.equal(queryRow('SELECT balance FROM company_wallet_accounts').balance,'300000');
  assert.equal((await pay(72)).data.chargeId,paid.data.chargeId);
  assert.equal((await pay(72,'synthetic-another-key')).data.chargeId,paid.data.chargeId);
  assert.equal(queryRow('SELECT count(*) n FROM wallet_ledger_v2').n,1,'Retries debit once');
  db.exec('DELETE FROM customer_credit_checks');
  assert.deepEqual((await getOptions()).conditions.map(c=>c.id),[71,72],'Pre-inquiry plan preview preserved');
  console.log('PASS real portal handlers: B1 rank matching, eligible limits, actionable errors, insufficient funds, atomic rollback, same/new-key fee reuse and preview before credit.');
} finally { await new Promise(r=>server.close(r)); db.close(); }

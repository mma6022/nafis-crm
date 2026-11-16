import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp=await mkdtemp(path.join(os.tmpdir(),"goods-http-"));
const file=path.join(temp,"fixture.db");
const original=new DatabaseSync(path.resolve("../../attached_assets/customers_1789823100050.db"),{readOnly:true});
await backup(original,file);original.close();
const secret=randomBytes(32).toString("hex");
Object.assign(process.env,{CRM_DATABASE_PATH:file,CONTRACTS_STORAGE_DIR:path.join(temp,"contracts"),SESSION_SECRET:secret,NODE_ENV:"production",
  EMZAME_BASE_URL:"https://fixture.invalid/emzame",EMZAME_NATIONAL_CODE:"fixture",EMZAME_PASSWORD:"fixture",
  SAPI_API_BASE_URL:"https://fixture.invalid",SAPI_API_TOKEN:"fixture"});
delete process.env.SAPI_RELAY_URL;
const nativeFetch=globalThis.fetch;let signature="rejected",bankMatch=true,bankSuccess=true,onBankMatch=()=>{},infoSuccess=true,infoActive=true,infoName="Fixture Owner";
globalThis.fetch=async (url,options)=>{
  if(String(url).startsWith("https://fixture.invalid/")) {
    const u=String(url);
    if(u.endsWith("/login"))return Response.json({accessToken:"fixture"});
    if(u.includes("/contracts/"))return Response.json({data:{status:signature}});
    if(u.endsWith("/IbanMatch")) {
      assert.deepEqual(JSON.parse(options.body), {nationalCode:"1111111111",birthDate:"1370/1/2",iban:"IR820540102680020817909002"});
      onBankMatch();
      return Response.json({success:bankSuccess,data:bankMatch});
    }
    if(u.endsWith("/IbanInfo")){
      assert.deepEqual(JSON.parse(options.body),{iban:"IR820540102680020817909002"});
      return Response.json({success:infoSuccess,data:{active:infoActive,name:infoName,bankName:"Fixture Bank"}});
    }
    throw new Error("Unexpected fixture provider operation");
  }
  if(!String(url).startsWith("http://127.0.0.1:"))throw new Error("External network forbidden in finance fixture");
  return nativeFetch(url,options);
};
const bundle=path.join(temp,"http.mjs");
await build({stdin:{contents:`
 import express from "express";import cookieParser from "cookie-parser";
 import {requireAuth} from "./src/lib/auth";
 import goods from "./src/routes/goods-purchases";import documents from "./src/routes/goods-documents";import payments from "./src/routes/payment-orders";
 export * from "./src/lib/crm-db";export * from "./src/lib/wallets";
 export const app=express();app.use(express.json(),cookieParser());app.use("/api",requireAuth,goods,documents,payments);
 `,resolveDir:process.cwd(),sourcefile:"http-fixture.ts"},bundle:true,platform:"node",format:"esm",outfile:bundle,logLevel:"silent",
 banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(process.cwd(),"package.json")).href)});`}});
let db,server;
try {
  const f=await import(pathToFileURL(bundle).href);db=f.crmDb;
  const ts=new Date().toISOString(),sp=f.execute("INSERT INTO salespersons(name,created_at) VALUES('HTTP fixture',?)",[ts]);
  const otherSp=f.execute("INSERT INTO salespersons(name,created_at) VALUES('Other fixture',?)",[ts]);
  const sessions={};
  for(const role of ["admin","registrar","salesperson","accounting","other"]) {
    const uid=f.execute("INSERT INTO users(username,password_hash,role,salesperson_id,created_at) VALUES(?,'unused',?,?,?)",[`fixture-${role}-${randomBytes(4).toString("hex")}`,role==="other"?"salesperson":role,role==="salesperson"?sp:role==="other"?otherSp:null,ts]);
    const token=randomBytes(24).toString("base64url");
    f.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",[createHmac("sha256",secret).update(token).digest("hex"),uid,new Date(Date.now()+180000).toISOString(),ts]);
    sessions[role]={uid,cookie:`crm_session=${token}`};
  }
  const c=f.execute("INSERT INTO customers(name,phone,national_code,salesperson_id,created_at) VALUES('HTTP isolated','09120000000','1111111111',?,?)",[sp,ts]);
  const consultation=db.prepare("SELECT id FROM consultation_forms LIMIT 1").get().id;
  const template=f.execute("INSERT INTO contract_templates(name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at) VALUES('HTTP','http.docx','http.docx','fixture','[]','[]',?,?,?)",[sessions.admin.uid,ts,ts]);
  const plan=f.execute("INSERT INTO loan_plans(name,principal_amount,installment_terms,active,created_at) VALUES('HTTP Plan','10000','[12]',1,?)",[ts]);
  const appId=f.execute("INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,requested_amount,approved_amount,plan_id,stage,status,created_at) VALUES(?,?,?,'[]','10000','10000',?,'completed','approved',?)",[consultation,c,sessions.admin.uid,plan,ts]);
  f.runTransaction(()=>f.creditLoanWallet(appId,c,"9000",sessions.admin.uid));
  server=f.app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const call=async(role,method,route,body)=>{
    const form=body instanceof FormData;
    const response=await fetch(base+route,{method,headers:{...(role?{Cookie:sessions[role].cookie}:{}),...(body&&!form?{"Content-Type":"application/json"}:{})},body:body?(form?body:JSON.stringify(body)):undefined});
    return {status:response.status,body:await response.json().catch(()=>null)};
  };
  const expect=async(role,method,route,body,status=200)=>{const r=await call(role,method,route,body);assert.equal(r.status,status,`${role} ${method} ${route}: ${JSON.stringify(r.body)}`);return r.body;};
  await expect(null,"GET","/goods-purchases",undefined,401);
  await expect("salesperson","POST","/goods-purchases",{customerId:c,planId:plan},403);
  await expect("registrar","PUT",`/goods-finance/plans/${plan}`,{},403);
  await expect("admin","PUT",`/goods-finance/plans/${plan}`,{customerPayoutPercent:80,developmentDiscountPercent:10,acknowledgementTemplateId:template});
  await expect("admin","PUT",`/goods-finance/salespersons/${sp}/settings`,{target1Toman:"1000",target2Toman:"5000",target3Toman:"10000",rate0Percent:1,rate1Percent:2,rate2Percent:3,rate3Percent:4});
  const parallel=await Promise.all([call("registrar","POST","/goods-purchases",{customerId:c,planId:plan}),call("registrar","POST","/goods-purchases",{customerId:c,planId:plan})]);
  assert.deepEqual(parallel.map(r=>r.status).sort(),[201,422]);const p=parallel.find(r=>r.status===201).body;
  await expect("other","GET",`/goods-purchases/${p.id}`,undefined,404);
  assert.equal((await expect("other","GET","/goods-purchases")).items.some(i=>i.id===p.id),false);
  await expect("salesperson","POST",`/goods-purchases/${p.id}/discharge`,{},403);
   await expect("registrar","POST",`/goods-purchases/${p.id}/settle`,{},403);
  await expect("registrar","POST",`/goods-purchases/${p.id}/discharge`,{});
  await expect("registrar","PUT",`/goods-purchases/${p.id}/invoice`,{items:[{title:"Fixture goods",quantity:3,unitPriceToman:"3000"}]});
  const doc=(kind,version)=>f.execute("INSERT INTO goods_purchase_documents(purchase_id,kind,version,source_invoice_version,status,source_hash,provider_contract_id,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,'sent','fixture','fixture-provider',?,?,?,?)",[p.id,kind,version,f.queryRow("SELECT invoice_version FROM goods_purchases WHERE id=?",[p.id]).invoice_version,`${kind}-${version}`,sessions.registrar.uid,ts,ts]);
  doc("invoice",1);
  await expect("registrar","PUT",`/goods-purchases/${p.id}/invoice`,{items:[{title:"Locked",quantity:1,unitPriceToman:"9000"}]},422);
  await expect("registrar","POST",`/goods-purchases/${p.id}/documents/invoice/refresh`,{});
  assert.equal((await expect("registrar","GET",`/goods-purchases/${p.id}`)).stage,"invoice_draft");
  await expect("registrar","PUT",`/goods-purchases/${p.id}/invoice`,{items:[{title:"Corrected goods",quantity:1,unitPriceToman:"9000"}]});
   doc("invoice",2);signature="accepted";
   const statusBeforeInquiry=f.queryRow("SELECT status,provider_status,updated_at FROM goods_purchase_documents WHERE purchase_id=? AND kind='invoice'",[p.id]);
   const stageBeforeInquiry=f.queryRow("SELECT stage FROM goods_purchases WHERE id=?",[p.id]);
   const inquiry=await expect("salesperson","GET",`/goods-purchases/${p.id}/documents/invoice/signature-status`);
   assert.equal(inquiry.signed,true);assert.equal(inquiry.status,"signed");assert.equal(inquiry.readOnly,true);
   assert.deepEqual(f.queryRow("SELECT status,provider_status,updated_at FROM goods_purchase_documents WHERE purchase_id=? AND kind='invoice'",[p.id]),statusBeforeInquiry);
   assert.deepEqual(f.queryRow("SELECT stage FROM goods_purchases WHERE id=?",[p.id]),stageBeforeInquiry);
   await expect("other","GET",`/goods-purchases/${p.id}/documents/invoice/signature-status`,undefined,404);
   await expect("salesperson","POST",`/goods-purchases/${p.id}/documents/invoice/refresh`,{},403);
  await expect("registrar","POST",`/goods-purchases/${p.id}/documents/invoice/refresh`,{});
   const settlement=await Promise.all([call("admin","POST",`/goods-purchases/${p.id}/settle`,{}),call("admin","POST",`/goods-purchases/${p.id}/settle`,{})]);
  assert.deepEqual(settlement.map(r=>r.status),[200,200]);
  assert.equal(f.wallet(c,"credit").balance,"0");
  doc("acknowledgement",1);
  await expect("registrar","POST",`/goods-purchases/${p.id}/documents/acknowledgement/refresh`,{});
  const completion=await Promise.all([call("registrar","POST",`/goods-purchases/${p.id}/complete`,{}),call("registrar","POST",`/goods-purchases/${p.id}/complete`,{})]);
  assert.deepEqual(completion.map(r=>r.status),[200,200]);
  const summary=await expect("salesperson","GET",`/goods-finance/salespersons/${sp}/summary`);
  assert.equal(summary.balanceToman,"240");assert.equal(summary.monthlySalesToman,"8000");
  await expect("other","GET",`/goods-finance/salespersons/${sp}/summary`,undefined,403);
  await expect("salesperson","POST","/payment-orders",{purchaseId:p.id},403);
  const order=await expect("registrar","POST","/payment-orders",{purchaseId:p.id});
  assert.equal((await expect("registrar","POST","/payment-orders",{purchaseId:p.id})).id,order.id);
  const mine = (role, extra = "") => expect(role,"GET",`/payment-orders?mine=1${extra}`);
  assert.equal((await mine("salesperson")).items.some(o=>o.id===order.id),true);
  assert.equal((await mine("salesperson","&stage=paid")).total,0);
  assert.equal((await mine("registrar")).total,0);
  assert.equal((await mine("other")).items.some(o=>o.id===order.id),false);
  assert.equal((await mine("accounting")).items.some(o=>o.id===order.id),false);
  assert.equal((await mine("admin")).items.some(o=>o.id===order.id),false);
  await expect("other","GET",`/payment-orders/${order.id}`,undefined,404);
  await expect("admin","POST",`/payment-orders/${order.id}/admin-approve`,{},409);
  await expect("salesperson","POST",`/payment-orders/${order.id}/sales-approve`,{customerBankAccountId:999999},422);
  const iban="IR820540102680020817909002";
  assert.equal((await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban,birthDate:"1370/1/2"},422)).error,"customer_birth_date_required");
  f.execute("UPDATE customers SET birth_date_jalali='۱۴۰۰/۱۲/۳۰' WHERE id=?",[c]);
  assert.equal((await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban},422)).error,"customer_birth_date_required");
  f.execute("UPDATE customers SET birth_date_jalali='۱۳۷۰/۰۱/۰۲' WHERE id=?",[c]);
  bankSuccess=false;await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban},503);
  assert.equal(f.queryRow("SELECT COUNT(*) n FROM customer_bank_accounts WHERE customer_id=?",[c]).n,0);
  bankSuccess=true;bankMatch=false;await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban},422);
  bankMatch=true;
  onBankMatch=()=>f.execute("UPDATE customers SET birth_date_jalali='1370/1/3' WHERE id=?",[c]);
  assert.equal((await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban},409)).error,"customer_changed_during_verification");
  assert.equal(f.queryRow("SELECT COUNT(*) n FROM customer_bank_accounts WHERE customer_id=?",[c]).n,0);
  onBankMatch=()=>{};
  f.execute("UPDATE customers SET birth_date_jalali='1370/01/02' WHERE id=?",[c]);
  const account=await expect("salesperson","POST",`/customers/${c}/bank-accounts/verify`,{iban,birthDate:"1380/1/1"});
  await expect("salesperson","POST",`/payment-orders/${order.id}/sales-approve`,{customerBankAccountId:account.id});
  assert.equal((await mine("salesperson")).items.some(o=>o.id===order.id),false);
  assert.equal((await mine("admin")).items.some(o=>o.id===order.id),true);
  await expect("registrar","POST",`/payment-orders/${order.id}/admin-approve`,{},403);
  await expect("admin","POST",`/payment-orders/${order.id}/admin-approve`,{});
  assert.equal((await mine("accounting")).items.some(o=>o.id===order.id),true);
  const bankInput={bankName:"Fixture",ownerName:"Forged Owner",fundName:"Forged Fund",iban,ownerType:"company"};
  const bankCount=()=>f.queryRow("SELECT COUNT(*) n FROM finance_bank_accounts").n;
  const beforeBanks=bankCount();
  await expect("salesperson","POST","/bank-accounts",bankInput,403);
  await expect("accounting","POST","/bank-accounts",{...bankInput,ownerType:""},400);
  infoSuccess=false;
  await expect("accounting","POST","/bank-accounts",bankInput,503);
  infoSuccess=true;infoActive=false;
  assert.equal((await expect("accounting","POST","/bank-accounts",bankInput,422)).error,"bank_account_inactive");
  infoActive=true;infoName="";
  await expect("accounting","POST","/bank-accounts",bankInput,503);
  assert.equal(bankCount(),beforeBanks);
  infoName="Fixture Owner";
  const bank=await expect("accounting","POST","/bank-accounts",bankInput,201);
  assert.equal(bank.ownerName,"Fixture Owner");
  assert.equal(bank.bankName,"Fixture");
  assert.equal(bank.fundName,"Fixture Fixture Owner");
  assert.equal(bank.ownerType,"company");
  await expect("accounting","POST","/bank-accounts",bankInput,409);
  assert.equal(bankCount(),beforeBanks+1);
  const receipt=()=>{const form=new FormData();form.set("sourceBankAccountId",String(bank.id));form.set("trackingNumber","fixture-123");form.set("paidAt",ts);form.set("receipt",new Blob(["%PDF-1.4\nfixture receipt"],{type:"application/pdf"}),"receipt.pdf");return form;};
  await expect("registrar","POST",`/payment-orders/${order.id}/pay`,receipt(),403);
  assert.equal((await expect("accounting","POST",`/payment-orders/${order.id}/pay`,receipt())).stage,"paid");
  assert.equal((await mine("accounting")).items.some(o=>o.id===order.id),false);
  assert.equal((await expect("accounting","POST",`/payment-orders/${order.id}/pay`,receipt())).stage,"paid");
  assert.equal((await fetch(`${base}/payment-orders/${order.id}/receipt`,{headers:{Cookie:sessions.accounting.cookie}})).status,200);
  assert.equal((await fetch(`${base}/payment-orders/${order.id}/receipt`,{headers:{Cookie:sessions.other.cookie}})).status,404);
  assert.equal(f.queryRow("SELECT COUNT(*) n FROM goods_finance_ledger WHERE purchase_id=? AND kind='salesperson_commission'",[p.id]).n,1);
  console.log("Goods HTTP passed: auth/scoped roles, simultaneous reservation/settlement/completion, invoice rejection/edit/verified signature, exact ledger, commission, payment approvals, authoritative bank match, accounting evidence, receipt scope and replay.");
} finally {
  if(server)await new Promise(r=>server.close(r));db?.close();globalThis.fetch=nativeFetch;await rm(temp,{recursive:true,force:true});
}
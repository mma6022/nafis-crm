import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import express from "express";

// Synthetic rows/files only; use real routes, real role policy, and forbid provider traffic.
const temp = await mkdtemp(path.join(os.tmpdir(),"accounting-fixture-"));
const db = new DatabaseSync(":memory:");
globalThis.accountingFixtureDb = db;
db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER,created_at TEXT,salesperson_id INTEGER);
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,national_code TEXT,birth_date_jalali TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
  CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
  CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY,base_payout_amount_toman TEXT,fee_discount_toman TEXT);
  CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,balance TEXT);
  INSERT INTO users VALUES(1,'admin','مدیر آزمایشی','admin',1,'2026-10-04',NULL),
    (2,'accountant','حسابدار آزمایشی','accounting',1,'2026-10-04',NULL),
    (3,'agent','کارشناس آزمایشی','salesperson',1,'2026-10-04',11);
  INSERT INTO salespersons VALUES(11,'کارشناس یک'),(12,'کارشناس دو');
  INSERT INTO customers VALUES(1,'مشتری آزمایشی','1234567890','1370/01/01',11,NULL);
  INSERT INTO goods_purchases VALUES(1,'300','0'),(2,'2000','0'),(3,'100','0'),(4,'100','0');
  INSERT INTO wallet_accounts_v2 VALUES(1,'987');
`);
let server;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  assert.equal(new URL(String(url)).hostname,"127.0.0.1","No provider may be contacted");
  return nativeFetch(url,init);
};
try {
  const bundle = path.join(temp,"routes.mjs");
  await build({
    stdin:{contents:`export{default as accounting}from'./src/routes/accounting.ts';export{default as payments}from'./src/routes/payment-orders.ts';export{permissionsForRole}from'./src/lib/access-control.ts';export{tehranDate}from'./src/lib/accounting.ts';`,resolveDir:path.resolve(".")},
    outfile:bundle,bundle:true,platform:"node",format:"esm",logLevel:"silent",
    banner:{js:`import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});`},
    plugins:[{name:"synthetic-db",setup(ctx){
      ctx.onResolve({filter:/\/crm-db$/},()=>({path:"db",namespace:"fixture"}));
      ctx.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:`
        export const crmDb=globalThis.accountingFixtureDb;
        export const databasePath=${JSON.stringify(path.join(temp,"customers.db"))};
        export const queryRow=(sql,args=[])=>crmDb.prepare(sql).get(...args);
        export const queryRows=(sql,args=[])=>crmDb.prepare(sql).all(...args);
        export const execute=(sql,args=[])=>Number(crmDb.prepare(sql).run(...args).lastInsertRowid);
        export const executeChanges=(sql,args=[])=>crmDb.prepare(sql).run(...args).changes;
        export const runTransaction=fn=>{crmDb.exec('BEGIN');try{const r=fn();crmDb.exec('COMMIT');return r;}catch(e){crmDb.exec('ROLLBACK');throw e;}};
      `}));
    }}],
  });
  const routes = await import(pathToFileURL(bundle).href);
  db.exec(`INSERT INTO finance_bank_accounts VALUES(1,'بانک آزمایشی','شرکت آزمایشی','صندوق یک','IR000000000000000000000001','company',1,'2026-10-04'),
    (2,'بانک آزمایشی','شرکت آزمایشی','صندوق دو','IR000000000000000000000002','company',1,'2026-10-04');`);
  const app=express(); app.use(express.json());
  app.use((req,res,next)=>{
    const name=req.headers["x-fixture-user"] || (process.env.ACCOUNTING_BROWSER_QA === "1" ? "admin" : undefined);
    if(name){
      const role=name==="admin"?"admin":name==="agent"?"salesperson":"accounting";
      const u=db.prepare("SELECT * FROM users WHERE role=?").get(role);
      res.locals.authUser={...u,permissions:routes.permissionsForRole(role),customerScope:name==="assigned"?"assigned":"all",salespersonId:name==="assigned"?12:u.salesperson_id};
    } next();
  });
  if (process.env.ACCOUNTING_BROWSER_QA === "1") app.get("/api/auth/session", (_req,res)=>{
    res.json({user:{id:1,username:"admin",fullName:"مدیر آزمایشی",role:"admin",active:true,
      permissions:routes.permissionsForRole("admin"),customerScope:"all",salespersonId:null}});
  });
  app.use("/api",routes.accounting);app.use("/api",routes.payments);
  app.use((error,_req,res,_next)=>res.status(500).json({error:error.message}));
  server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  if (process.env.ACCOUNTING_BROWSER_QA === "1") {
    db.prepare(`INSERT INTO customer_payment_orders(id,purchase_id,customer_id,amount_toman,stage,verified_national_code,created_by,created_at,updated_at)
      VALUES(1,1,1,'300','awaiting_payment','1234567890',1,?,?)`).run(new Date().toISOString(),new Date().toISOString());
    console.log(`ACCOUNTING_QA_API_PORT=${server.address().port}`);
    console.log(`ACCOUNTING_QA_TEMP=${temp}`);
    await new Promise(resolve=>process.once("SIGTERM",resolve));
  } else {
  const request=(route,{method="GET",body,user="admin"}={})=>fetch(base+route,{method,headers:{
    ...(user?{"x-fixture-user":user}:{}),...(body && !(body instanceof FormData)?{"Content-Type":"application/json"}:{})
  },body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const balance=()=>db.prepare("SELECT balance_toman FROM accounting_funds WHERE fund_id=1").get().balance_toman;
  const today=routes.tehranDate();
  const fileBytes=Buffer.from("%PDF-1.4\nsynthetic accounting document\n");
  const fields={requestKey:"fixture-request-0001",fundId:1,documentDate:today,transactionDate:today,
    amountToman:"500",purpose:"آزمون واریز",documentType:"debit",transactionType:"deposit"};
  const bban="0000000000000000000001";
  const iban=`IR${String(98n-BigInt(`${bban}182700`)%97n).padStart(2,"0")}${bban}`;
  const form=(overrides={},file=true)=>{
    const body=new FormData();for(const[k,v]of Object.entries({...fields,...overrides}))body.set(k,String(v));
    if(file)body.append("files",new Blob([fileBytes],{type:"application/pdf"}),"receipt.pdf");return body;
  };
  assert.equal((await request("/accounting/funds",{user:null})).status,401);
  assert.equal((await request("/accounting/documents",{user:"agent"})).status,403);
  assert.equal((await request("/accounting/funds/1/opening",{method:"POST",body:{amountToman:"1000"},user:"accountant"})).status,403);
  assert.equal((await request("/accounting/documents",{method:"POST",body:form(),user:"accountant"})).status,422);
  assert.equal((await request("/accounting/funds/1/opening",{method:"POST",body:{amountToman:"1000"}})).status,201);
  assert.equal((await request("/accounting/funds/1/opening",{method:"POST",body:{amountToman:"1000"}})).status,201);
  assert.equal((await request("/accounting/funds/1/opening",{method:"POST",body:{amountToman:"1001"}})).status,409);
  assert.equal(balance(),"1000");
  const saved=await request("/accounting/documents",{method:"POST",body:form(),user:"accountant"});
  assert.equal(saved.status,201);const doc=await saved.json();assert.equal(doc.attachments.length,1);assert.equal(balance(),"1500");
  assert.equal(doc.counterpartyAccountNumber,null,"Old documents without counterpart details remain readable");
  const repeated=await(await request("/accounting/documents",{method:"POST",body:form(),user:"accountant"})).json();
  assert.equal(repeated.id,doc.id);assert.equal(balance(),"1500");
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({amountToman:"501"}),user:"accountant"})).status,409);
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({requestKey:"fixture-too-large-01",amountToman:"2000",transactionType:"withdrawal"}),user:"accountant"})).status,422);
  assert.equal(balance(),"1500");assert.equal((await readdir(path.join(temp,"accounting-attachments"))).length,1);
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({requestKey:"fixture-bad-date-001",transactionDate:"2026-02-30"}),user:"accountant"})).status,400);
  const fake=form({requestKey:"fixture-bad-file-001"},false);fake.append("files",new Blob(["<html>fake</html>"],{type:"application/pdf"}),"fake.pdf");
  assert.equal((await request("/accounting/documents",{method:"POST",body:fake,user:"accountant"})).status,400);
  const download=await request(`/accounting/documents/${doc.id}/attachments/${doc.attachments[0].id}`,{user:"accountant"});
  assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),fileBytes);
  assert.equal((await request(`/accounting/documents/${doc.id}/attachments/${doc.attachments[0].id}`,{user:null})).status,401);
  const extra=new FormData();extra.append("files",new Blob([fileBytes],{type:"application/pdf"}),"receipt.pdf");
  assert.equal((await(await request(`/accounting/documents/${doc.id}/attachments`,{method:"POST",body:extra,user:"accountant"})).json()).attachments.length,1);
  for(const [orderId,cost]of[[1,"300"],[2,"2000"],[3,"100"],[4,"100"]])
    db.prepare(`INSERT INTO customer_payment_orders(id,purchase_id,customer_id,amount_toman,stage,verified_national_code,created_by,created_at,updated_at)
      VALUES(?,?,1,?,?,'1234567890',1,?,?)`).run(orderId,orderId,cost,orderId===4?"paid":"awaiting_payment",new Date().toISOString(),new Date().toISOString());
  db.prepare("UPDATE customer_payment_orders SET destination_iban=?,destination_owner_name=? WHERE id=1").run(iban,"صاحب مقصد آزمایشی");
  const paidAt=new Date(Date.now()-1000).toISOString();
  const payment=(orderId=1)=>{
    const f=new FormData();f.set("sourceBankAccountId","1");f.set("trackingNumber",`tracking-${orderId}`);f.set("paidAt",paidAt);
    f.append("receipt",new Blob([fileBytes],{type:"application/pdf"}),"paid.pdf");return f;
  };
  assert.equal((await request("/payment-orders/1/pay",{method:"POST",body:payment(),user:"accountant"})).status,200);
  assert.equal(balance(),"1200");
  assert.equal((await request("/payment-orders/1/pay",{method:"POST",body:payment(),user:"accountant"})).status,200);
  assert.equal(balance(),"1200");assert.equal(db.prepare("SELECT COUNT(*) n FROM accounting_documents WHERE source_order_id=1").get().n,1);
  const auto=db.prepare("SELECT id FROM accounting_documents WHERE source_order_id=1").get();
  assert.equal((await request(`/accounting/documents/${auto.id}`,{user:"assigned"})).status,404);
  const autoDoc=await(await request(`/accounting/documents/${auto.id}`,{user:"accountant"})).json();assert.equal(autoDoc.attachments.length,1);
  assert.equal(autoDoc.counterpartyAccountType,"iban");assert.equal(autoDoc.counterpartyAccountNumber,iban);
  assert.equal(autoDoc.counterpartyOwnerName,"صاحب مقصد آزمایشی","Automatic withdrawals retain the order's destination snapshot");
  assert.equal((await request(`/accounting/documents/${auto.id}/attachments/${autoDoc.attachments[0].id}`,{user:"accountant"})).status,200);
  assert.equal((await request("/payment-orders/2/pay",{method:"POST",body:payment(2),user:"accountant"})).status,422);
  assert.equal(balance(),"1200");assert.equal(db.prepare("SELECT stage FROM customer_payment_orders WHERE id=2").get().stage,"awaiting_payment");
  db.exec(`CREATE TRIGGER fail_payment_event BEFORE INSERT ON customer_payment_order_events WHEN NEW.order_id=3 BEGIN SELECT RAISE(ABORT,'synthetic commit failure');END;`);
  assert.equal((await request("/payment-orders/3/pay",{method:"POST",body:payment(3),user:"accountant"})).status,409);
  assert.equal(balance(),"1200");assert.equal(db.prepare("SELECT COUNT(*) n FROM accounting_documents WHERE source_order_id=3").get().n,0);
  assert.equal(db.prepare("SELECT stage FROM customer_payment_orders WHERE id=3").get().stage,"awaiting_payment");
  // Historical paid orders are neither backfilled nor counted again by retries.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounting_documents WHERE source_order_id=4").get().n,0);
  assert.throws(()=>db.prepare("UPDATE customer_payment_orders SET stage='paid' WHERE id=2").run(),/accounting journal required/,"Older releases cannot pay silently without a journal");
  assert.equal((await request("/accounting/funds/2/opening",{method:"POST",body:{amountToman:"0"}})).status,201);
  const large="9007199254740993";
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({requestKey:"fixture-large-deposit-1",fundId:2,amountToman:large},false)})).status,201);
  assert.equal(db.prepare("SELECT balance_toman FROM accounting_funds WHERE fund_id=2").get().balance_toman,large);
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({requestKey:"fixture-large-withdraw-1",fundId:2,amountToman:large,transactionType:"withdrawal"},false)})).status,201);
  assert.equal(db.prepare("SELECT balance_toman FROM accounting_funds WHERE fund_id=2").get().balance_toman,"0");
  const incoming={requestKey:"fixture-counterparty-in-1",amountToman:"1",counterpartyAccountType:"iban",
    counterpartyAccountNumber:iban.toLowerCase(),counterpartyOwnerName:"  صاحب مبدأ آزمایشی  "};
  const incomingResponse=await request("/accounting/documents",{method:"POST",body:form(incoming,false)});
  assert.equal(incomingResponse.status,201);const incomingDoc=await incomingResponse.json();
  assert.equal(incomingDoc.counterpartyAccountNumber,iban);assert.equal(incomingDoc.counterpartyOwnerName,"صاحب مبدأ آزمایشی");
  assert.equal((await(await request("/accounting/documents",{method:"POST",body:form({...incoming,counterpartyAccountNumber:iban},false)})).json()).id,incomingDoc.id);
  assert.equal((await request("/accounting/documents",{method:"POST",body:form({...incoming,counterpartyOwnerName:"نام متفاوت"},false)})).status,409);
  const outgoing={requestKey:"fixture-counterparty-out-1",amountToman:"1",transactionType:"withdrawal",counterpartyAccountType:"card",
    counterpartyAccountNumber:"۴۰۰۰-۰۰۰۰-۰۰۰۰-۰۰۰۲",counterpartyOwnerName:"صاحب مقصد آزمایشی"};
  const outgoingResponse=await request("/accounting/documents",{method:"POST",body:form(outgoing,false)});
  assert.equal(outgoingResponse.status,201);const outgoingDoc=await outgoingResponse.json();
  assert.equal(outgoingDoc.counterpartyAccountNumber,"4000000000000002");
  assert.equal((await(await request(`/accounting/documents/${outgoingDoc.id}`)).json()).counterpartyOwnerName,"صاحب مقصد آزمایشی");
  assert.equal(balance(),"1200");
  for(const override of [
    {counterpartyAccountType:"iban",counterpartyAccountNumber:"IR000000000000000000000000",counterpartyOwnerName:"نام آزمایشی"},
    {counterpartyAccountType:"card",counterpartyAccountNumber:"4000000000000003",counterpartyOwnerName:"نام آزمایشی"},
    {counterpartyAccountType:"card",counterpartyAccountNumber:"4000000000000002",counterpartyOwnerName:""},
    {counterpartyAccountType:"other",counterpartyAccountNumber:"4000000000000002",counterpartyOwnerName:"نام آزمایشی"},
  ]) assert.equal((await request("/accounting/documents",{method:"POST",body:form({requestKey:"fixture-invalid-account-1",...override},false)})).status,400);
  assert.equal(balance(),"1200","Invalid counterpart details cannot affect funds");
  db.exec(`CREATE TRIGGER fail_attachment BEFORE INSERT ON accounting_attachments WHEN NEW.name='failure.pdf' BEGIN SELECT RAISE(ABORT,'synthetic file save failure');END;`);
  const failFile=form({requestKey:"fixture-file-rollback-1"},false);
  failFile.append("files",new Blob([fileBytes],{type:"application/pdf"}),"failure.pdf");
  assert.equal((await request("/accounting/documents",{method:"POST",body:failFile})).status,500);
  assert.equal(balance(),"1200");assert.equal((await readdir(path.join(temp,"accounting-attachments"))).length,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounting_documents WHERE request_key LIKE '%fixture-file-rollback-1'").get().n,0);
  db.prepare("INSERT INTO customers VALUES(2,'بازمانده آزمایشی','9876543210','1370/01/01',12,NULL)").run();
  db.prepare("UPDATE customers SET merged_into_customer_id=2 WHERE id=1").run();
  assert.equal((await request(`/accounting/documents/${auto.id}`,{user:"assigned"})).status,404);
  db.prepare("INSERT INTO customer_merge_audit VALUES(1,2)").run();
  assert.equal((await request(`/accounting/documents/${auto.id}`,{user:"assigned"})).status,200,"Archived payment follows audited survivor scope");
  const futures=form({requestKey:"fixture-future-0001",transactionDate:"2099-01-01"});
  assert.equal((await request("/accounting/documents",{method:"POST",body:futures})).status,400);
  assert.equal((await request("/accounting/documents?from=2026-02-30")).status,400);
  assert.equal(db.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance,"987","Customer wallet remains unchanged");
  const ledger=db.prepare("SELECT amount_toman,transaction_type FROM accounting_documents WHERE fund_id=1").all()
    .reduce((sum,d)=>sum+(d.transaction_type==="deposit"?1n:-1n)*BigInt(d.amount_toman),0n);
  assert.equal(ledger.toString(),balance());
  console.log("PASS: real roles, opening once, exact balances, independent types, duplicate retries, insufficient funds, upload validation/private downloads, automatic payment journal once, scope and transaction rollback, no historical backfill and no customer wallet changes.");
  }
} finally {
  if(server)await new Promise(r=>server.close(r));
  globalThis.fetch=nativeFetch;db.close();delete globalThis.accountingFixtureDb;await rm(temp,{recursive:true,force:true});
}
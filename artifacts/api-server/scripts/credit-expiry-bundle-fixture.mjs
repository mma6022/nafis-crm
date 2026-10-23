import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const checks=JSON.parse(fs.readFileSync("/tmp/credit-expiry-checks.json","utf8"));
for(const test of checks.refreshes){
  for(const mode of ["stored","provider","transient","completed"]){
    const db=new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT,provider_status TEXT,error_message TEXT,updated_at TEXT,provider_reference TEXT);
      CREATE TABLE customers(id INTEGER PRIMARY KEY,credit_rank TEXT);
      INSERT INTO customers VALUES(1,'A1');`);
    db.prepare("INSERT INTO customer_credit_checks VALUES(1,1,?,?,?,?,?)").run(
      mode==="completed"?"report_generated":"awaiting_otp","Entry",mode==="stored"?"RequestExpired، درخواست منقضی شده است":null,"synthetic","synthetic");
    let calls=0;
    const status=async()=>{calls++;throw new Error(mode==="provider"?"RequestExpired، درخواست منقضی شده است":"network timeout")};
    const run=(sql,args=[])=>Number(db.prepare(sql).run(...args).changes);
    const queryRow=(sql,args=[])=>db.prepare(sql).get(...args);
    const context={Date,Error,status,execute:run,executeChanges:run,queryRow,now9:()=>new Date().toISOString(),
      getCreditCheck:(_,id)=>queryRow("SELECT * FROM customer_credit_checks WHERE id=?",[id])};
    const refresh=vm.runInNewContext(checks.helperCode+"\n"+test.code+"\n"+test.name,context);
    const out=await refresh(queryRow("SELECT * FROM customer_credit_checks WHERE id=1"));
    assert.equal(out.status,["stored","provider"].includes(mode)?"failed":mode==="completed"?"report_generated":"awaiting_otp");
    assert.equal(calls,["stored","completed"].includes(mode)?0:1);
    assert.equal(queryRow("SELECT credit_rank FROM customers").credit_rank,"A1");
    if(out.status==="failed")assert.equal(out.provider_status,"RequestExpired");
    db.close();
  }
}
for(const test of checks.catches){
  let updates=0,replyStatus=0;
  const row={id:123};
  const context={Date,Error,[test.row]:row,[test.error]:new Error("RequestExpired، درخواست منقضی شده است"),
    execute:(sql,args)=>{assert.match(sql,/status IN/);assert.equal(args.at(-1),123);updates++;},
    res:{status:n=>{replyStatus=n;return{json:b=>b}}}};
  const result=vm.runInNewContext(checks.helperCode+"\n(function(){"+test.code+"})()",context);
  assert.equal(updates,1);
  assert.equal(replyStatus,test.route.endsWith("/renew")?409:422);
  assert.match(result.error,/پایان/);
}
console.log("PASS staged production bundle: staff/portal stored and provider expiry, transient errors, successful-rank preservation, no extra OTP/status call for closed checks, four validation/resend catches");

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { conditionAcceptsCreditRank } from "../src/lib/credit-rank-eligibility.ts";

const db=new DatabaseSync(":memory:");
db.exec(`
 CREATE TABLE customers(id INTEGER PRIMARY KEY,salesperson_id INTEGER,merged_into_customer_id INTEGER,verification_status TEXT);
 CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,active INTEGER,principal_amount TEXT,installment_terms TEXT,required_documents TEXT,needs_guarantor INTEGER,contract_template_id INTEGER,primary_contract_template_id INTEGER);
 CREATE TABLE loan_plan_conditions(id INTEGER PRIMARY KEY,plan_id INTEGER,name TEXT,customer_ranks TEXT,max_principal TEXT,installment_options TEXT,sort_order INTEGER,notes TEXT,needs_guarantor INTEGER);
 CREATE TABLE contract_templates(id INTEGER,mappings_json TEXT,deleted_at TEXT);
 INSERT INTO customers VALUES(100,11,NULL,'verified'),(200,22,NULL,'verified'),(300,11,100,'verified');
 INSERT INTO loan_plans VALUES
  (1,'Rank C plan',1,'100000000','[12,24]','[]',0,NULL,NULL),
  (2,'Rank A plan',1,'80000000','[12]','[]',1,NULL,NULL),
  (3,'Inactive plan',0,'90000000','[12]','[]',0,NULL,NULL),
  (4,'No conditions',1,'50000000','[12]','[]',0,NULL,NULL);
 INSERT INTO loan_plan_conditions VALUES
  (10,1,'C condition','["C"]','20000000','[12]',0,NULL,0),
  (20,2,'A condition','["A"]','30000000','[12]',0,NULL,1),
  (30,3,'Hidden','[]','90000000','[12]',0,NULL,0);`);
const source=readFileSync("src/routes/loan-applications.ts","utf8");
const scoped=source.slice(source.indexOf("function getScopedCustomer("),source.indexOf("\nfunction netLoanAmount("));
const terms=source.slice(source.indexOf("export function effectivePlanTerms("),source.indexOf("\nexport function payablePlan(")).replace("export ","");
const route=source.slice(source.indexOf('router.get("/customers/:customerId/eligible-plans"'),source.indexOf('router.get("/loan-applications/filing-fee-plans"'));
let handler:any;
const queryRow=(sql:string,args:unknown[]=[])=>db.prepare(sql).get(...args as never[]);
const queryRows=(sql:string,args:unknown[]=[])=>db.prepare(sql).all(...args as never[]);
const parseJson=(value:any)=>{try{return value?JSON.parse(value):null;}catch{return null;}};
let currentCredit:any={status:"report_generated",score_label:"C",completed_at:"2026-10-10T20:00:00Z"};
const compiled=transformSync(scoped+"\n"+terms+"\n"+route,{loader:"ts"}).code;
new Function("router","requirePermission","user","queryRow","queryRows","parseJson","freshSuccessfulCredit","conditionAcceptsCreditRank","separateRequirementKeys","documentLabel","error",compiled)(
 {get:(_path:string,_permission:any,fn:any)=>{handler=fn;}},
 (permission:string)=>{assert.equal(permission,"loan_applications.view");},
 (res:any)=>res.actor,queryRow,queryRows,parseJson,()=>currentCredit,conditionAcceptsCreditRank,new Set(),(key:string)=>key,
 (res:any,status:number,code:string)=>res.status(status).json({error:code}),
);
const invoke=(role:string,flag:any,customerId=100,scope="assigned",salespersonId=11)=>{
 const res:any={actor:{role,customerScope:scope,salespersonId},statusCode:200,status(n:number){this.statusCode=n;return this;},json(body:any){this.body=body;return this;}};
 const query:any={};if(flag!==undefined)query.ignoreCreditRank=flag;
 handler({params:{customerId:String(customerId)},query},res);return res;
};
const normal=invoke("salesperson",undefined);
assert.equal(normal.statusCode,200);
assert.deepEqual(normal.body.plans.map((p:any)=>p.planId),[1]);
assert.equal(normal.body.plans[0].maximumAmount,"20000000");
assert.deepEqual(invoke("salesperson","false").body,normal.body);
for(const role of ["admin","salesperson"]){
 const preview=invoke(role,"true");
 assert.equal(preview.statusCode,200);
 assert.deepEqual(preview.body.plans.map((p:any)=>p.planId),[1,2,4]);
 assert.deepEqual(preview.body.plans.map((p:any)=>p.maximumAmount),["100000000","80000000","50000000"]);
 assert.deepEqual(preview.body.credit,normal.body.credit);
}
for(const role of ["registrar","staff","customer","custom_all_permissions"]){
 assert.equal(invoke(role,"true").statusCode,403);
 assert.equal(invoke(role,"false").statusCode,200);
}
for(const flag of ["1","TRUE","",["true"],["true","false"]])assert.equal(invoke("admin",flag).statusCode,400);
assert.equal(invoke("salesperson","true",200).statusCode,404);
assert.equal(invoke("salesperson","true",300).statusCode,404);
assert.equal(invoke("salesperson","true",999).statusCode,404);
currentCredit=null;
assert.equal(invoke("admin",undefined).body.plans.length,0);
assert.equal(invoke("admin","true").body.plans.length,3);
db.prepare("UPDATE customers SET verification_status='unverified' WHERE id=100").run();
assert.equal(invoke("admin",undefined).body.plans.length,0);
assert.equal(invoke("admin","true").body.plans.length,3);
// Display requests have no writes; configured rank/cap and normal submission
// helpers remain unchanged. No real provider or application bootstrap is used.
assert.equal(queryRow("SELECT max_principal FROM loan_plan_conditions WHERE id=10")?.max_principal,"20000000");
assert.equal(conditionAcceptsCreditRank("C",["A"]),false);
db.close();
console.log("PASS: actual display handler and customer scope; admin/sales only; false/invalid flags; inactive excluded; all active including no-condition plans; full ceilings; no-credit preview; unchanged rank/caps and normal mode.");

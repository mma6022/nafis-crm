// Real compiled handlers, synthetic SQLite only; no providers or real customer data.
import fs from"node:fs";import path from"node:path";import vm from"node:vm";import assert from"node:assert/strict";import{DatabaseSync}from"node:sqlite";import{createRequire}from"node:module";
const require=createRequire(path.resolve("artifacts/api-server/package.json"));
const parser=require(path.resolve([...fs.globSync("node_modules/.pnpm/@babel+parser@*/node_modules/@babel/parser/lib/index.js")][0]));
const code=fs.readFileSync(process.argv[2]||"artifacts/api-server/dist/index.mjs","utf8"),ast=parser.parse(code,{sourceType:"module"}).program;
function walk(n,f){if(!n||typeof n!=="object")return;if(n.type)f(n);for(const[k,v]of Object.entries(n)){if(["loc","start","end"].includes(k))continue;if(Array.isArray(v))v.forEach(x=>walk(x,f));else if(v&&typeof v==="object")walk(v,f)}}
function fn(name){let n;walk(ast,x=>{if(x.type==="FunctionDeclaration"&&x.id.name===name)n=x});assert(n,name);return code.slice(n.start,n.end)}
let handler;walk(ast,n=>{if(n.type==="CallExpression"&&n.arguments?.[0]?.value==="/loan-applications/:id/guarantor"){const f=n.arguments.at(-1);handler=code.slice(f.start,f.end)}});assert(handler);
const policy=ast.body.find(n=>n.type==="VariableDeclaration"&&n.declarations.some(d=>d.id.name==="actionPolicy"));
let passed=0;
function scenario(o={}){
 const db=new DatabaseSync(":memory:");db.exec(`
 CREATE TABLE customers(id INTEGER PRIMARY KEY,salesperson_id INTEGER);INSERT INTO customers VALUES(44,3);
 CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,stage TEXT,status TEXT,new_case_workflow INTEGER,legacy_reopen_prior_stage TEXT,initial_approval_at TEXT,approved_amount TEXT,current_primary_generation_id INTEGER,updated_at TEXT,deleted_at TEXT,condition_snapshot_json TEXT);
 CREATE TABLE loan_application_guarantors(id INTEGER PRIMARY KEY,application_id INTEGER UNIQUE,full_name TEXT,national_code TEXT,mobile TEXT,data_json TEXT,created_at TEXT);
 CREATE TABLE loan_application_guarantor_documents(id INTEGER PRIMARY KEY,guarantor_id INTEGER,requirement_key TEXT,status TEXT,storage_path TEXT,rejection_reason TEXT);
 CREATE TABLE loan_application_collateral(application_id INTEGER,status TEXT,data_json TEXT);
 CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,action TEXT,reason TEXT,actor_id INTEGER,created_at TEXT);
 INSERT INTO loan_applications VALUES(84,44,'${o.stage||"guarantor_documents_review"}','reviewing',${o.legacy||o.old?0:1},${o.legacy?"'customer_documents_review'":"NULL"},${o.unapproved?"NULL":"'old-decision'"} ,'90000000',97,'old',NULL,'{}');`);
 db.exec("ALTER TABLE loan_applications ADD COLUMN is_pre_registration INTEGER DEFAULT 0");
 if(!o.noGuarantor)db.exec("INSERT INTO loan_application_guarantors VALUES(5,84,'ضامن آزمایشی','0000000000',NULL,'{}','old')");
 if(o.document)db.prepare("INSERT INTO loan_application_guarantor_documents VALUES(9,5,'manual',? ,?,NULL)").run(o.document,o.missingFile?"missing":"exists");
 const queryRow=(s,p=[])=>db.prepare(s).get(...p),queryRows=(s,p=[])=>db.prepare(s).all(...p);
 const actor={id:2,role:o.role||"registrar",salespersonId:o.otherOwner?99:3,customerScope:"assigned"};
 const context=vm.createContext({Error,queryRow,queryRows,executeChanges:(s,p=[])=>db.prepare(s).run(...p).changes,execute:(s,p=[])=>db.prepare(s).run(...p),
 runTransaction:fn=>{if(o.stale)db.exec("UPDATE loan_applications SET stage='completed'");db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result}catch(e){db.exec("ROLLBACK");throw e}},
 fileExists:p=>p==="exists",parseJson:JSON.parse,latestTomanReplacementConsent:()=>null,
 stages:["guarantor_documents_review","collateral_upload","guarantor_documents_upload","guarantor_registration","funder_initial_approval"],
 workflowStatus:()=>"reviewing",now5:()=>"new",now:()=>"new",user:()=>actor,scoped:id=>queryRow("SELECT * FROM loan_applications WHERE id=?",[id]),
 loanCaseFinancialTermsLocked:()=>!!o.paid,approvedGuarantorTermsLocked:()=>!!o.paid,
 error:(res,s,c)=>res.status(s).json({error:c}),
 recordReview:(id,stage,action,reason,actorId)=>db.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,'new')").run(id,stage,stage,action,reason,actorId)});
 vm.runInContext(code.slice(policy.start,policy.end)+"\n"+fn("canAct")+"\n"+fn("registrarReviewState")+"\n"+fn("transition"),context);
 const before=queryRow("SELECT * FROM loan_applications WHERE id=84"),state=context.registrarReviewState(before);
 if(o.registration){
  let status=201,result;const res={status(s){status=s;return this},json(v){result=v;return this}};
  const call=()=>vm.runInContext("("+handler+")",context)({params:{id:84},body:{fullName:"ضامن آزمایشی",nationalCode:"0000000000"}},res);
  if(o.stale)assert.throws(call,/invalid_stage_transition/);else call();
  if(o.paid||o.otherOwner){assert.equal(status,o.paid?409:403);assert.equal(queryRow("SELECT stage FROM loan_applications WHERE id=84").stage,before.stage)}
  else if(!o.stale){assert.equal(status,201,JSON.stringify(result));assert.equal(queryRow("SELECT stage FROM loan_applications WHERE id=84").stage,o.target||"guarantor_documents_upload");assert.equal(result.full_name,"ضامن آزمایشی")}
  else assert.equal(queryRow("SELECT stage FROM loan_applications WHERE id=84").stage,"completed");
 }else{
  const blocked=o.noGuarantor||o.document&&o.document!=="approved"||o.missingFile;
  assert.equal(state.allApproved,!blocked,JSON.stringify(o));
  const advance=()=>context.transition(84,"collateral_upload","review-guarantor-documents",actor);
  if(o.role==="salesperson"||blocked)assert.throws(advance,o.role==="salesperson"?/action_forbidden/:/documents_incomplete/);
  else{advance();assert.equal(queryRow("SELECT stage FROM loan_applications WHERE id=84").stage,"collateral_upload");assert.equal(queryRow("SELECT COUNT(*) n FROM loan_application_stage_history").n,1)}
 }
 const after=queryRow("SELECT * FROM loan_applications WHERE id=84");
 for(const key of["initial_approval_at","approved_amount","current_primary_generation_id"])assert.equal(after[key],before[key],key);
 db.close();passed++;
}
scenario();scenario({noGuarantor:true});
for(const document of["uploaded","pending","approved","incomplete","rejected"])scenario({document});
scenario({document:"approved",missingFile:true});scenario({role:"salesperson"});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson"});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",unapproved:true,target:"funder_initial_approval"});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",legacy:true});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",legacy:true,unapproved:true,target:"funder_initial_approval"});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",old:true,target:"guarantor_registration"});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",otherOwner:true});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",paid:true});
scenario({registration:true,stage:"guarantor_registration",role:"salesperson",stale:true});
scenario({registration:true,stage:"guarantor_documents_review",role:"salesperson",document:"approved"});
console.log(JSON.stringify({passed,realCompiledHandlers:true,syntheticSQLite:true,financialTermsAndSignaturesUnchanged:true}));

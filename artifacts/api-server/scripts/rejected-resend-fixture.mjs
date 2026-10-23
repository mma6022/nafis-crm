import fs from"node:fs";import path from"node:path";import vm from"node:vm";import assert from"node:assert/strict";import crypto from"node:crypto";import{DatabaseSync}from"node:sqlite";import{createRequire}from"node:module";
const require=createRequire(path.resolve("artifacts/api-server/package.json"));
const parser=require(path.resolve([...fs.globSync("node_modules/.pnpm/@babel+parser@*/node_modules/@babel/parser/lib/index.js")][0]));
const code=fs.readFileSync(process.argv[2]||"/tmp/rejected-resend-fixes/index.mjs","utf8"),ast=parser.parse(code,{sourceType:"module"}).program;
function walk(n,f){if(!n||typeof n!=="object")return;if(n.type)f(n);for(const[k,v]of Object.entries(n)){if(["loc","start","end","extra"].includes(k))continue;if(Array.isArray(v))v.forEach(x=>walk(x,f));else if(v&&typeof v==="object")walk(v,f)}}
function route(url){let result;walk(ast,n=>{if(n.type==="CallExpression"&&n.arguments?.[0]?.value===url){const f=n.arguments.at(-1);result=code.slice(f.start,f.end)}});assert(result,url);return result}
const prepare=route("/contracts/generations/:id/prepare-resend"),send=route("/contracts/generations/:id/send");
const namespace=ast.body.find(n=>n.type==="VariableDeclaration"&&n.declarations.some(d=>d.id.name==="__rejectedContractResend"));
const rejected=ast.body.find(n=>n.type==="VariableDeclaration"&&n.declarations.some(d=>d.id.name==="rejectedBySigner"));
assert(namespace&&rejected);
let passed=0;
async function scenario(o={}){
 const db=new DatabaseSync(":memory:"),pdf=Buffer.from("%PDF-1.4 synthetic immutable contract");
 db.exec(`CREATE TABLE contract_generations(id INTEGER PRIMARY KEY,status TEXT,provider_contract_id TEXT,provider_file_id TEXT,provider_status TEXT,deleted_at TEXT,superseded_at TEXT,loan_application_id INTEGER,generation_purpose TEXT,customer_id INTEGER,loan_plan_id INTEGER,template_id INTEGER,send_claim_id TEXT,send_claim_expires_at TEXT,provider_idempotency_key TEXT,sent_at TEXT,error_message TEXT,updated_at TEXT,pdf_path TEXT,pdf_sha256 TEXT);
 CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,status TEXT,stage TEXT,current_primary_generation_id INTEGER,customer_id INTEGER,plan_id INTEGER,plan_snapshot_json TEXT,new_case_workflow INTEGER,initial_approval_at TEXT,approved_amount TEXT,requested_amount TEXT,duration_months INTEGER,requested_duration_months INTEGER);
 CREATE TABLE loan_application_generated_documents(id INTEGER PRIMARY KEY,application_id INTEGER,kind TEXT,contract_generation_id INTEGER,status TEXT,link TEXT);
 CREATE TABLE contract_generation_rejected_deliveries(id INTEGER PRIMARY KEY,generation_id INTEGER,provider_contract_id TEXT,provider_file_id TEXT,provider_status TEXT,sent_at TEXT,recorded_by INTEGER,recorded_at TEXT);
 CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO loan_plans VALUES(19,'طرح آزمایشی');
 INSERT INTO loan_applications VALUES(67,'${o.caseRejected?"rejected":"requested"}','${o.stage||"approved_contract_pending_signature"}',${o.notCurrent?99:155},44,19,'{"contract_template_id":7}',1,'approved','90000000','100000000',18,18);
 INSERT INTO loan_application_generated_documents VALUES(145,67,'primary',155,'${o.docStatus||"pending"}','${o.signedLink?"signed:old":"provider:old"}');`);
 db.prepare("INSERT INTO contract_generations VALUES(155,?,?,?,?,NULL,?,67,'primary',44,19,7,?,NULL,'old-key','old-time',NULL,'old','synthetic.pdf',?)")
 .run(o.signed?"signed":"sent","old-contract","old-file",o.pending?"readyForSign":"reject",o.superseded?"old":null,o.claim?"active":null,crypto.createHash("sha256").update(pdf).digest("hex"));
 if(o.pending&&!o.noRejectedAncestor)db.exec("INSERT INTO contract_generation_rejected_deliveries VALUES(1,155,'rejected-contract','old-file','reject','old',2,'old')");
 db.exec("ALTER TABLE loan_applications ADD COLUMN deleted_at TEXT");
 const queryRow=(s,p=[])=>db.prepare(s).get(...p),actor={id:2,role:o.role||"salesperson"};
 const requests=[],log={warn(){},error(){}};
 const ctx=vm.createContext({Error,Buffer,Blob,FormData,Date,JSON,process:{env:{EMZAME_BUSINESS_ID:"synthetic-business"}},crypto5:crypto,crypto,
 queryRow,crmDb:db,execute:(s,p=[])=>db.prepare(s).run(...p),
 user2:()=>actor,user:()=>actor,now6:()=>new Date().toISOString(),now:()=>new Date().toISOString(),
 assignedGeneration:id=>o.otherOwner?null:queryRow("SELECT * FROM contract_generations WHERE id=?",[id]),
 runImmediateTransaction:fn=>{if(o.race)db.exec("UPDATE contract_generations SET provider_contract_id='concurrent-contract'");db.exec("BEGIN IMMEDIATE");try{const v=fn();db.exec("COMMIT");return v}catch(e){db.exec("ROLLBACK");throw e}},
 emzameRequest:async(resource)=>{requests.push({kind:"observe",resource});return{ok:!o.providerUnavailable,json:async()=>({status:o.freshStatus||(o.pending?"readyForSign":"reject")})}},
 providerContractState:b=>({status:b.status,signed:b.status==="accept"}),TOMAN_REPLACEMENT_PURPOSE:"toman_replacement",
 reconcileGenerations(){},json:(v,fallback)=>{try{return JSON.parse(v)}catch{return fallback}},
 renderedPdfContainsPrincipal:()=>true,renderedPdfContainsInstallmentCount:()=>true,principalTemplateEvidence2:()=>({}),
 preapprovedGenerationMatches:()=>true,isCurrentApplicationPrimaryGeneration:()=>true,tomanReplacementDocumentTermsMatch:()=>true,
 customer:()=>({name:"مشتری آزمایشی",national_code:"0000000000",phone:"09000000000"}),
 normalizeIranNationalCode:v=>v,normalizeIranMobile:v=>v,regularPath:p=>p,fsp2:{readFile:async()=>pdf},sha2:v=>crypto.createHash("sha256").update(v).digest("hex"),
 emzameAuth:async()=>"synthetic",certificateActive2:()=>true,safeProviderPdfFilename:()=>"synthetic.pdf",providerResponsePaths:()=>[],providerErrorMessage:()=>undefined,
 emzameProviderId:(b,keys)=>keys.map(k=>b[k]).find(Boolean),
 fetchWithTimeout:async(url,init)=>{
   if(url.includes("checkUserActiveCertificate")){requests.push({kind:"certificate"});return{ok:true,status:200,json:async()=>({active:true})}}
   if(url.endsWith("/files")){requests.push({kind:"upload",key:init.headers["X-Idempotency-Key"],bytes:Buffer.from(await init.body.get("file").arrayBuffer())});return{ok:true,status:200,json:async()=>({fileId:"new-file"})}}
   if(url.endsWith("/contracts/sendContract")){const body=JSON.parse(init.body);requests.push({kind:"send",key:init.headers["X-Idempotency-Key"],body});return{ok:!o.sendFailure,status:o.sendFailure?503:200,json:async()=>o.sendFailure?{}:{contractId:"new-contract",status:"readyForSign"}}}
   throw Error("unexpected provider request")
 }});
 vm.runInContext(code.slice(namespace.start,namespace.end)+"\n"+code.slice(rejected.start,rejected.end),ctx);
 const before=queryRow("SELECT * FROM contract_generations WHERE id=155");
 assert.equal(ctx.__rejectedContractResend.rejectedDeliveryReusesFile(before,queryRow),!!(o.pending&&!o.noRejectedAncestor&&!o.signed&&!o.superseded));
 let status=200,result;const res={status(s){status=s;return this},json(v){result=v;return this}},req={params:{id:155},body:{},log};
 await vm.runInContext("("+prepare+")",ctx)(req,res);
 const expected=o.expected||200;assert.equal(status,expected,JSON.stringify({o,result}));
 if(expected!==200){assert.equal(requests.filter(r=>r.kind==="send"||r.kind==="upload").length,0);assert.equal(queryRow("SELECT provider_file_id FROM contract_generations WHERE id=155").provider_file_id,"old-file");assert.equal(queryRow("SELECT COUNT(*) n FROM contract_generation_rejected_deliveries").n,o.pending&&!o.noRejectedAncestor?1:0)}
 else{
  const prepared=queryRow("SELECT * FROM contract_generations WHERE id=155");assert.equal(prepared.provider_file_id,null);assert.equal(prepared.provider_contract_id,null);assert.equal(prepared.provider_idempotency_key,null);assert.equal(prepared.pdf_sha256,before.pdf_sha256);assert.equal(prepared.pdf_path,before.pdf_path);
  const archived=queryRow("SELECT * FROM contract_generation_rejected_deliveries ORDER BY id DESC LIMIT 1");assert.equal(archived.provider_file_id,"old-file");assert.equal(archived.provider_contract_id,"old-contract");assert.equal(archived.provider_status,o.pending?"readyForSign":"reject");
  await vm.runInContext("("+send+")",ctx)(req,res);
  assert.equal(status,o.sendFailure?502:200,JSON.stringify({o,result}));
  assert.equal(requests.filter(r=>r.kind==="upload").length,1);
  const posted=requests.find(r=>r.kind==="send"),uploaded=requests.find(r=>r.kind==="upload");assert.equal(posted.body.staticFileId,"new-file");assert.notEqual(posted.key,"old-key");assert.equal(posted.key,uploaded.key);assert.deepEqual(uploaded.bytes,pdf);
  if(!o.sendFailure){const after=queryRow("SELECT * FROM contract_generations WHERE id=155");assert.equal(after.status,"sent");assert.equal(after.provider_contract_id,"new-contract");assert.equal(after.provider_file_id,"new-file");const count=requests.length;await vm.runInContext("("+send+")",ctx)(req,res);assert.equal(requests.length,count,"repeat does not create duplicate provider requests")}
 }
 db.close();passed++;
}
await scenario();await scenario({pending:true});
for(const o of[{pending:true,noRejectedAncestor:true},{freshStatus:"accept"},{freshStatus:"unknown"},{pending:true,freshStatus:"processing"},{stage:"completed"},{caseRejected:true},{docStatus:"approved"},{docStatus:"rejected"},{signedLink:true},{superseded:true},{notCurrent:true},{claim:true},{signed:true},{race:true}])await scenario({...o,expected:409});
await scenario({otherOwner:true,expected:404});await scenario({role:"registrar",expected:403});await scenario({providerUnavailable:true,expected:502});await scenario({sendFailure:true});
console.log(JSON.stringify({passed,realStagedHandlers:true,syntheticProviderOnly:true,immutablePdf:true,freshUploadAndIdempotency:true,noDuplicateSend:true}));

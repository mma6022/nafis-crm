// Entirely synthetic: real admin routes, authorization, validators and schema.
import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagedFeatureArg = process.argv.indexOf("--staged-feature");
const stagedFeature = stagedFeatureArg < 0 ? null : await readFile(process.argv[stagedFeatureArg + 1], "utf8");
const source = await readFile(path.join(root, "src/routes/loan-applications.ts"), "utf8");
const schema = await readFile(path.join(root, "src/lib/crm-db.ts"), "utf8");
const names = new Set(["customers", "salespersons", "customer_merge_audit", "loan_plans", "loan_plan_conditions",
  "loan_applications", "contract_templates", "contract_generations", "loan_application_generated_documents",
  "loan_application_documents", "loan_application_guarantors", "loan_application_guarantor_documents",
  "loan_application_collateral", "loan_application_stage_history", "loan_physical_checks"]);
const definitions = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\s*\);/g)]
  .filter(m => names.has(m[1])).map(m => m[0]).join("\n");
const additions = [...schema.matchAll(/ensureColumn\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g)]
  .filter(m => names.has(m[1])).map(m => [m[1], m[2], m[3]]);
for (const loop of schema.matchAll(/for \(const \[(\w+),\s*(\w+)\] of \[([\s\S]*?)\] as const\) ensureColumn\("([^"]+)",\s*\1,\s*\2\);/g)) {
  if (!names.has(loop[4])) continue;
  for (const pair of loop[3].matchAll(/\["([^"]+)",\s*"([^"]+)"\s*\]/g)) additions.push([loop[4], pair[1], pair[2]]);
}
const database = `
import {DatabaseSync} from 'node:sqlite';
export const crmDb=new DatabaseSync(':memory:');crmDb.exec('PRAGMA foreign_keys=OFF');
export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
export const runImmediateTransaction=fn=>{crmDb.exec('BEGIN IMMEDIATE');try{const r=fn();crmDb.exec('COMMIT');return r}catch(e){crmDb.exec('ROLLBACK');throw e}};
export const runTransaction=runImmediateTransaction;
crmDb.exec(${JSON.stringify(definitions)});
// The legacy database's base tables predate the additive CRM migrations.
crmDb.exec(\`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,full_name TEXT,username TEXT);
CREATE TABLE IF NOT EXISTS consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
CREATE TABLE IF NOT EXISTS salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE IF NOT EXISTS customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
CREATE TABLE IF NOT EXISTS loan_plans(id INTEGER PRIMARY KEY,name TEXT,active INTEGER,principal_amount TEXT,installment_terms TEXT,contract_template_id INTEGER,required_documents TEXT);
CREATE TABLE IF NOT EXISTS loan_plan_conditions(id INTEGER PRIMARY KEY,plan_id INTEGER,name TEXT,max_principal TEXT,installment_options TEXT,needs_guarantor INTEGER);
\`);
for(const [table,column,type] of ${JSON.stringify(additions)}){
 if(!queryRows('PRAGMA table_info('+table+')').some(c=>c.name===column))crmDb.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+type);
}
crmDb.exec('CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,application_id INTEGER,idempotency_key TEXT UNIQUE,amount TEXT)');
`;
const scopedSource = source.slice(source.indexOf("function scoped("), source.indexOf("function error("));
const termsSource = source.slice(source.indexOf("export function effectivePlanTerms("), source.indexOf("export function payablePlan("));
const manualSource = source.slice(source.indexOf("export function validatedPrimaryManualValues("), source.indexOf("const actionPolicy:"));
const roleStageSource = source.slice(source.indexOf("const actionPolicy:"), source.indexOf("type CollateralSlot"));
const guarantorRouteSource = source.slice(source.indexOf('router.post("/loan-applications/:id/guarantor",'), source.indexOf("\nexport default router;"));
const guarantorUploadSource = source.slice(source.indexOf('router.post("/loan-applications/:id/guarantor/documents",'), source.indexOf('router.get("/loan-applications/:id/guarantor/documents/'));
const statusSource = source.slice(source.indexOf("function workflowStatus("), source.indexOf("const identityTypes"));
const finalFinancialGuard = source.match(/  if \(loanCaseFinancialTermsLocked\(r\) && !queryRow[\s\S]+?\n\s+return error\(res, 409, "financial_posting_history_unverified"\);/)?.[0];
if (!finalFinancialGuard) throw new Error("Native financial history guard not found");
const stages = JSON.parse(source.match(/const stages = (\[[\s\S]*?\]) as const/)[1]);
const serve = process.argv.includes("--serve");
const worker = `
import assert from 'node:assert/strict';import express from 'express';import {once} from 'node:events';import multer from 'multer';import fs from 'node:fs';
import {crmDb,queryRow,queryRows,execute,executeChanges,runTransaction} from './src/lib/crm-db';
import {registerLoanCaseAdminControls,loanCaseFinancialTermsLocked} from './src/lib/loan-case-admin-controls';
import {registerLoanCaseNotes} from './src/lib/loan-case-notes';
import {createSiteNotificationRouter} from './src/lib/site-notifications';
import {Readable} from 'node:stream';
import {requirePermission} from './src/lib/access-control';
import {loanRankOverrideSnapshot} from './src/lib/loan-credit-rank-override';
function parseJson(v){try{return v?JSON.parse(v):null}catch{return null}}
${scopedSource}${termsSource}${manualSource}${statusSource}
${roleStageSource}
const user=res=>res.locals.authUser;
const now=()=>new Date().toISOString();
const error=(res,status,code)=>res.status(status).json({error:code});
function recordReview(id,stage,action,reason,actor){execute('INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',[id,stage,stage,action,reason,actor,now()])}
function nativeFinalFinancialPreflight(r){const res={};const error=(_res,status,code)=>({status,code});${finalFinancialGuard}return null;}
const stages=${JSON.stringify(stages)},ts='2026-10-13T12:00:00.000Z';
function put(table,values){
 for(const c of queryRows('PRAGMA table_info('+table+')'))if(c.notnull&&!c.dflt_value&&!(c.name in values)&&!c.pk)
   values[c.name]=c.type.includes('INT')?1:c.name.endsWith('_at')?ts:'synthetic';
 const keys=Object.keys(values);return execute('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')',keys.map(k=>values[k]));
}
for(const id of [1,2,3,4])put('users',{id});
put('consultation_forms',{id:1,customer_id:1});
put('customers',{id:1,name:'مشتری آزمایشی اصلاح ادمین',phone:'09100000001',salesperson_id:11});
put('salespersons',{id:11,name:'کارشناس آزمایشی'});
put('contract_templates',{id:1,name:'قالب آزمایشی',mappings_json:JSON.stringify([{variable:'principal',sourceType:'loanPlan',loanPlanField:'loanPlan.principalAmount'},{variable:'details',sourceType:'manual',label:'توضیح قرارداد'}])});
put('loan_plans',{id:1,name:'طرح آزمایشی اول',active:1,principal_amount:'1000000',installment_terms:'[12,24]',contract_template_id:1,required_documents:'["bank_statement"]'});
put('loan_plans',{id:2,name:'طرح آزمایشی دوم',active:1,principal_amount:'1500000',installment_terms:'[12,24]',contract_template_id:1,required_documents:'["salary_slip","national_card_front","guarantee_check"]'});
put('loan_plan_conditions',{id:1,plan_id:1,name:'شرایط اول',max_principal:'1000000',installment_options:'[12,24]',needs_guarantor:1});
put('loan_plan_conditions',{id:2,plan_id:2,name:'شرایط دوم',max_principal:'1500000',installment_options:'[12,24]',needs_guarantor:1});
const actors={
 admin:{id:1,username:'synthetic-admin',name:'مدیر آزمایشی',role:'admin',customerScope:'all',permissions:['loan_applications.view','loan_applications.update','customers.view']},
 staff:{id:2,username:'synthetic-staff',name:'کارشناس آزمایشی',role:'salesperson',salespersonId:11,customerScope:'assigned',permissions:['loan_applications.view','loan_applications.update','customers.view']},
 registrar:{id:3,role:'registrar',customerScope:'all',permissions:['loan_applications.view','loan_applications.update']},
 custom:{id:4,role:'custom_admin_like',customerScope:'all',permissions:['loan_applications.view','loan_applications.update']},
  outsider:{id:5,username:'other-expert',fullName:'کارشناس دیگر',role:'salesperson',salespersonId:22,customerScope:'assigned',permissions:['loan_applications.view','loan_applications.update']},
  readonly:{id:6,username:'viewer',fullName:'بازبین آزمایشی',role:'viewer',customerScope:'all',permissions:['loan_applications.view']},
  noaccess:{id:7,username:'none',role:'none',customerScope:'all',permissions:[]},
};
for(const a of Object.values(actors)){a.fullName??=a.name??a.username??'کاربر آزمایشی';a.username??='fixture-'+a.id;crmDb.prepare('INSERT INTO users(id,full_name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,username=excluded.username').run(a.id,a.fullName,a.username);}
function seed(stage='customer_documents_review',funded=false,signed=true){
 const plan=queryRow('SELECT * FROM loan_plans WHERE id=1'),cond=queryRow('SELECT * FROM loan_plan_conditions WHERE id=1');
 const id=put('loan_applications',{customer_id:1,consultation_id:1,requested_by_user_id:1,stage,status:stage==='completed'?'approved':'reviewing',
  plan_id:1,plan_ids:'[1]',requested_amount:'600000',requested_duration_months:12,duration_months:12,approved_amount:'600000',net_amount:'550000',
  initial_approval_at:ts,primary_manual_values_json:'{"details":"توضیح اولیه"}',plan_snapshot_json:JSON.stringify(plan),condition_snapshot_json:JSON.stringify(cond),notes:'یادداشت اولیه',new_case_workflow:1});
 const g=put('loan_application_guarantors',{application_id:id,full_name:'ضامن آزمایشی',national_code:'0000000000',mobile:'09100000002',data_json:'{"creditRank":"A1","job":"retained-old-identity"}'});
 put('loan_application_guarantor_documents',{guarantor_id:g,requirement_key:'national_card',status:'approved',storage_path:'synthetic-original-file'});
 put('loan_application_documents',{application_id:id,requirement_key:'bank_statement',label:'گردش حساب آزمایشی',source:'plan',status:'approved',storage_path:'synthetic-original-file'});
 put('loan_physical_checks',{application_id:id,source:'document',source_id:1,label:'بررسی آزمایشی',status:'approved'});
 put('loan_application_collateral',{application_id:id,collateral_type:'customer_cheque',status:'approved',data_json:'{"amount":"600000"}'});
 if(signed){const generation=put('contract_generations',{template_id:1,customer_id:1,loan_application_id:id,status:'signed',provider_status:'signed',provider_contract_id:'synthetic-provider-'+id});
  put('loan_application_generated_documents',{application_id:id,kind:'primary',contract_generation_id:generation,link:'signed:synthetic-'+id,status:'approved'});
  crmDb.prepare('UPDATE loan_applications SET current_primary_generation_id=? WHERE id=?').run(generation,id);
 }
 if(funded)put('wallet_ledger_v2',{application_id:id,idempotency_key:'loan-application:'+id+':credit',amount:'550000'});
 return id;
}
const app=express();app.use(express.json());
app.use((req,res,next)=>{
 const cookie=String(req.headers.cookie??'').match(/fixture-role=(admin|staff|registrar|custom)/);
 res.locals.authUser=actors[req.headers['x-actor']??cookie?.[1]??'admin'];if(!res.locals.authUser)return res.sendStatus(401);next();
});
const router=express.Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:1024*1024}});
const uploadDirectory=fs.mkdtempSync('/tmp/synthetic-guarantor-uploads-');
const storeFile=(id,file)=>{const target=uploadDirectory+'/'+id+'-'+Date.now();fs.writeFileSync(target,file.buffer);return target};
const normalizedUploadName=name=>String(name);
${guarantorRouteSource}
${guarantorUploadSource}
router.get('/auth/session',(req,res)=>res.json({authenticated:true,user:res.locals.authUser}));
registerLoanCaseAdminControls(router,{scoped,stages,workflowStatus,effectivePlanTerms,validatedPrimaryManualValues,loanRankOverrideSnapshot,documentLabel:key=>({'bank_statement':'گردش حساب','salary_slip':'فیش حقوقی'}[key]??key)});
const noteFiles=new Map();let fileSequence=0;
registerLoanCaseNotes(router,scoped,{
  save:async bytes=>{const p='synthetic:'+ ++fileSequence;noteFiles.set(p,bytes);return p},
  read:p=>Readable.from([noteFiles.get(p)]),
  remove:async p=>{noteFiles.delete(p)},
});
function dto(id,actor){
 const a=scoped(id,actor);if(!a)return null;const g=queryRow('SELECT * FROM loan_application_guarantors WHERE application_id=?',[id]);
 const docs=queryRows('SELECT d.*,g.status generation_status,g.provider_status,g.superseded_at generation_superseded_at FROM loan_application_generated_documents d JOIN contract_generations g ON g.id=d.contract_generation_id WHERE d.application_id=?',[id]);
 return {id:a.id,customerId:1,customerName:a.customer_name,customerSalespersonId:11,customerSalespersonName:'کارشناس آزمایشی',planId:a.plan_id,planName:a.plan_name,planIds:[a.plan_id],
 requestedAmount:a.requested_amount,requestedDurationMonths:a.requested_duration_months,approvedAmount:a.approved_amount,netAmount:a.net_amount,durationMonths:a.duration_months,
 stage:a.stage,status:a.status,createdAt:a.created_at,updatedAt:a.updated_at,newCaseWorkflow:true,notes:a.notes,actionRequired:false,actionRole:'registrar',
 canCancel:true,planSnapshot:parseJson(a.plan_snapshot_json),conditionSnapshot:parseJson(a.condition_snapshot_json),primaryManualValues:parseJson(a.primary_manual_values_json),
 documents:[],identityDocuments:[],requiredCollateral:[],collateral:[],physicalChecks:[],physicalDocuments:[],funderDefects:[],
 history:queryRows('SELECT h.*,h.actor_id actorId,\\'مدیر آزمایشی\\' actorName FROM loan_application_stage_history h WHERE application_id=? ORDER BY h.id',[id]),
  guarantor:g?{...g,fullName:g.full_name,nationalCode:g.national_code,documents:queryRows('SELECT * FROM loan_application_guarantor_documents WHERE guarantor_id=?',[g.id]).map(d=>({...d,label:d.requirement_key,fileAvailable:fs.existsSync(d.storage_path??'')}))}:null,currentPrimaryGenerationId:a.current_primary_generation_id??null,
 generatedDocuments:docs.map(d=>({...d,contractGenerationId:d.contract_generation_id,current:d.contract_generation_id===a.current_primary_generation_id,superseded:!!d.generation_superseded_at,signed:d.generation_status==='signed',fileAvailable:false})),
 primaryManualVariables:[{variable:'details',label:'توضیح قرارداد'}],businessStatus:a.stage};
}
router.get('/loan-applications/:id',(req,res)=>{const d=dto(Number(req.params.id),res.locals.authUser);return d?res.json(d):res.sendStatus(404)});
router.get('/loan-plans/:id',(req,res)=>res.json(queryRow('SELECT * FROM loan_plans WHERE id=?',[Number(req.params.id)])));
router.get('/contract-templates/:id',(req,res)=>res.json({id:1,name:'قالب آزمایشی',mappings:[{variable:'details',sourceType:'manual',label:'توضیح قرارداد'}]}));
router.get('/customers/:id',(req,res)=>res.json({id:1,name:'مشتری آزمایشی اصلاح ادمین',phone:'09100000001'}));
${serve ? `
crmDb.exec("CREATE TABLE customer_chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,sender_type TEXT,sender_name TEXT,text TEXT,kind TEXT,created_at TEXT)");
app.use('/api',createSiteNotificationRouter());
router.get('/chat/threads',(req,res)=>res.json({items:[{customerId:1,name:'مشتری آزمایشی',mobile:'09100000001',online:false,lastMessage:null,lastMessageAt:null,unreadCount:0}],nextCursor:null}));
router.get('/chat/:customerId/messages',(req,res)=>res.json({items:queryRows('SELECT * FROM customer_chat_messages WHERE customer_id=? ORDER BY id DESC LIMIT 30',[Number(req.params.customerId)]).map(m=>({id:m.id,customerId:m.customer_id,senderType:m.sender_type,senderName:m.sender_name,text:m.text,kind:m.kind,createdAt:m.created_at,fileUrl:null,clientId:'test-'+m.id})),nextCursor:null}));
router.post('/chat/:customerId/read',(req,res)=>res.json({ok:true}));
router.get('/chat/unread',(req,res)=>res.json({count:0}));
router.post('/chat/presence',(req,res)=>res.json({ok:true}));
router.post('/fixture-notification-activity',(req,res)=>{
 if(req.body.kind==='message')execute("INSERT INTO customer_chat_messages(customer_id,sender_type,sender_name,text,kind,created_at) VALUES(1,'customer','مشتری آزمایشی',?,'text',?)",[req.body.text||'پیام جدید آزمایشی',new Date().toISOString()]);
 else execute("UPDATE loan_applications SET notes=? WHERE id=?",[req.body.text||'تغییر آزمایشی',Number(req.body.caseId)]);
 res.json({ok:true});
});
` : ""}
app.use('/api',router);app.use('/api',(req,res)=>res.status(404).json({error:'fixture_route_not_implemented'}));
app.use((error,req,res,next)=>{console.error(error.message);res.status(500).json({error:error.message})});
const server=app.listen(${serve ? 5601 : 0},'0.0.0.0');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const request=async(id,method,suffix,body,actor='admin')=>{
 const r=await fetch(base+'/api/loan-applications/'+id+'/'+suffix,{method,headers:{'content-type':'application/json','x-actor':actor},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json().catch(()=>null)};
};
const controls=async(id,actor='admin')=>request(id,'GET','admin-controls',undefined,actor);
const mutate=async(id,method,suffix,body={},actor='admin')=>request(id,method,suffix,{expectedRevision:(await controls(id)).data.revision,reason:'اصلاح آزمایشی با تأیید مدیر',confirmed:true,...body},actor);
try{
 for(const actor of ['staff','registrar','custom']){
  const id=seed();assert.equal((await controls(id,actor)).status,403);
  assert.equal((await mutate(id,'POST','admin-stage',{stage:'draft'},actor)).status,403);
  assert.equal((await mutate(id,'PATCH','admin-edit',{notes:'no'},actor)).status,403);
 }
 for(const body of [{confirmed:false},{confirmed:'true'},{reason:''},{reason:1},{reason:'x'.repeat(2001)},{expectedRevision:'bad'},{customerId:2},{stage:'invalid'}]){
  const id=seed();assert.equal((await mutate(id,'POST','admin-stage',{stage:'draft',...body})).status,400);
  assert.equal(queryRow('SELECT COUNT(*) n FROM loan_application_stage_history WHERE application_id=?',[id]).n,0);
 }
 for(const stage of stages.filter(s=>!['completed','final_invoice_pending_signature'].includes(s))){
  const id=seed(stage==='draft'?'admin_approval':'draft');const before=queryRow('SELECT approved_amount,current_primary_generation_id FROM loan_applications WHERE id=?',[id]);
  assert.equal((await mutate(id,'POST','admin-stage',{stage})).status,200);
  assert.deepEqual(queryRow('SELECT approved_amount,current_primary_generation_id FROM loan_applications WHERE id=?',[id]),before);
  assert.equal(queryRow('SELECT COUNT(*) n FROM wallet_ledger_v2 WHERE application_id=?',[id]).n,0);
 }
 for(const stage of ['completed','final_invoice_pending_signature']){
  const id=seed();assert.equal((await mutate(id,'POST','admin-stage',{stage})).data.error,'admin_stage_requires_financial_posting');
  const funded=seed('admin_approval',true);assert.equal((await mutate(funded,'POST','admin-stage',{stage})).status,200);
  assert.equal(queryRow('SELECT COUNT(*) n FROM wallet_ledger_v2 WHERE application_id=?',[funded]).n,1);
 }
 const rejected=seed();crmDb.prepare("UPDATE loan_applications SET status='rejected' WHERE id=?").run(rejected);
 assert.equal((await mutate(rejected,'POST','admin-stage',{stage:'customer_documents_review'})).status,200);
 assert.equal(queryRow('SELECT status FROM loan_applications WHERE id=?',[rejected]).status,'reviewing');
  const stalled=seed('guarantor_documents_review'),stalledBefore=queryRow('SELECT * FROM loan_applications WHERE id=?',[stalled]);
  crmDb.prepare('DELETE FROM loan_application_guarantor_documents WHERE guarantor_id IN (SELECT id FROM loan_application_guarantors WHERE application_id=?)').run(stalled);
  const stalledGuarantor=queryRow('SELECT * FROM loan_application_guarantors WHERE application_id=?',[stalled]);
  const existingIdentity={fullName:stalledGuarantor.full_name,nationalCode:stalledGuarantor.national_code,mobile:stalledGuarantor.mobile};
  assert.equal((await request(stalled,'POST','guarantor',existingIdentity,'registrar')).status,403);
  assert.equal((await request(stalled,'POST','guarantor',existingIdentity,'staff')).status,201);
  const resumed=queryRow('SELECT * FROM loan_applications WHERE id=?',[stalled]);
  assert.equal(resumed.stage,'guarantor_documents_upload');
  for(const key of ['requested_amount','approved_amount','duration_months','initial_approval_at','current_primary_generation_id'])
    assert.equal(resumed[key],stalledBefore[key]);
  assert.equal(queryRow('SELECT COUNT(*) n FROM loan_application_guarantors WHERE application_id=?',[stalled]).n,1);
  assert.equal(JSON.parse(queryRow('SELECT data_json FROM loan_application_guarantors WHERE application_id=?',[stalled]).data_json).creditRank,'A1');
  assert.equal(queryRow('SELECT status FROM contract_generations WHERE id=?',[resumed.current_primary_generation_id]).status,'signed');
  assert.equal(queryRow('SELECT COUNT(*) n FROM wallet_ledger_v2 WHERE application_id=?',[stalled]).n,0);
  const uploadReview=seed('guarantor_documents_review');
  crmDb.prepare('DELETE FROM loan_application_guarantor_documents WHERE guarantor_id IN (SELECT id FROM loan_application_guarantors WHERE application_id=?)').run(uploadReview);
const formData=new FormData();formData.append('label','تصویر آزمایشی ضامن');formData.append('file',new Blob(['synthetic document'],{type:'image/png'}),'synthetic.png');
  const uploaded=await fetch(base+'/api/loan-applications/'+uploadReview+'/guarantor/documents',{method:'POST',headers:{'x-actor':'staff'},body:formData});
  assert.equal(uploaded.status,201);assert.equal(queryRow('SELECT stage FROM loan_applications WHERE id=?',[uploadReview]).stage,'guarantor_documents_upload');
  const uploadView=await (await fetch(base+'/api/loan-applications/'+uploadReview)).json();
  assert.equal(uploadView.guarantor.documents[0].label,'تصویر آزمایشی ضامن');
  assert.equal(uploadView.guarantor.documents[0].fileAvailable,true);
  const changedIdentity=seed('guarantor_documents_review');
  assert.equal((await request(changedIdentity,'POST','guarantor',{...existingIdentity,fullName:'ضامن جدید آزمایشی'},'staff')).status,201);
  assert.equal(queryRow('SELECT status FROM loan_application_guarantor_documents WHERE guarantor_id IN (SELECT id FROM loan_application_guarantors WHERE application_id=?)',[changedIdentity]).status,'rejected');
  const paidReview=seed('guarantor_documents_review',true);
  assert.equal((await request(paidReview,'POST','guarantor',existingIdentity)).data.error,'admin_case_financial_terms_locked');
  const approvedRegistration=seed('guarantor_registration');
  assert.equal((await request(approvedRegistration,'POST','guarantor',existingIdentity)).status,201);
  assert.equal(queryRow('SELECT stage FROM loan_applications WHERE id=?',[approvedRegistration]).stage,'guarantor_documents_upload');
 const stale=seed(),old=(await controls(stale)).data.revision;
 assert.equal((await mutate(stale,'PATCH','admin-edit',{notes:'یادداشت دوم'})).status,200);
 assert.equal((await request(stale,'POST','admin-stage',{stage:'draft',expectedRevision:old,confirmed:true,reason:'نسخه قدیمی'})).status,409);
 const signed=seed(),oldGen=queryRow('SELECT current_primary_generation_id id FROM loan_applications WHERE id=?',[signed]).id;
 assert.equal((await mutate(signed,'PATCH','admin-edit',{requestedAmount:'700000'})).data.error,'admin_case_contract_revision_consent_required');
 assert.equal((await mutate(signed,'PATCH','admin-edit',{requestedAmount:'۷۰۰۰۰۰',durationMonths:24,manualValues:{details:'متن اصلاح‌شده'},needsGuarantor:false,notes:'اصلاح همه اطلاعات',acknowledgeContractRevision:true})).status,200);
 const changed=queryRow('SELECT * FROM loan_applications WHERE id=?',[signed]);
 assert.equal(changed.stage,'draft');assert.equal(changed.requested_amount,'700000');assert.equal(changed.approved_amount,null);assert.equal(changed.initial_approval_at,null);assert.equal(changed.current_primary_generation_id,null);
 const priorGen=queryRow('SELECT * FROM contract_generations WHERE id=?',[oldGen]);assert.ok(priorGen.superseded_at);assert.equal(priorGen.status,'signed');assert.ok(priorGen.provider_contract_id);
 assert.equal(queryRow('SELECT status FROM loan_physical_checks WHERE application_id=?',[signed]).status,'incomplete');
 const financial=seed('completed',true),finBefore=queryRow('SELECT * FROM wallet_ledger_v2 WHERE application_id=?',[financial]);
 assert.equal((await mutate(financial,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).data.error,'admin_case_financial_terms_locked');
 assert.equal((await mutate(financial,'PATCH','admin-edit',{notes:'فقط یادداشت پس از پرداخت'})).status,200);
 assert.equal((await mutate(financial,'POST','admin-stage',{stage:'funder_initial_approval'})).status,200);
 assert.ok(loanCaseFinancialTermsLocked(queryRow('SELECT * FROM loan_applications WHERE id=?',[financial])));
 assert.deepEqual(queryRow('SELECT * FROM wallet_ledger_v2 WHERE application_id=?',[financial]),finBefore);
  assert.equal(nativeFinalFinancialPreflight(queryRow('SELECT * FROM loan_applications WHERE id=?',[financial])),null);
 const historical=seed('completed',false);
 assert.equal((await mutate(historical,'POST','admin-stage',{stage:'draft'})).status,200);
 assert.ok((await controls(historical)).data.financialTermsLocked);
 assert.equal((await mutate(historical,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).data.error,'admin_case_financial_terms_locked');
 assert.equal(queryRow('SELECT COUNT(*) n FROM wallet_ledger_v2 WHERE application_id=?',[historical]).n,0);
  assert.equal(nativeFinalFinancialPreflight(queryRow('SELECT * FROM loan_applications WHERE id=?',[historical])).code,'financial_posting_history_unverified');
  assert.equal(nativeFinalFinancialPreflight(queryRow('SELECT * FROM loan_applications WHERE id=?',[seed('admin_approval',false)])),null);
 const planCase=seed();assert.equal((await mutate(planCase,'PATCH','admin-edit',{planId:2,conditionId:2,requestedAmount:'1200000',acknowledgeContractRevision:true})).status,200);
 assert.equal(queryRow('SELECT COUNT(*) n FROM loan_application_documents WHERE application_id=?',[planCase]).n,2);
 assert.equal(queryRow("SELECT COUNT(*) n FROM loan_application_documents WHERE application_id=? AND requirement_key IN ('national_card_front','guarantee_check')",[planCase]).n,0);
 const guarantorCase=seed();assert.equal((await mutate(guarantorCase,'PATCH','admin-edit',{guarantor:{fullName:'ضامن جدید',nationalCode:'1111111111',mobile:'09100000003'},acknowledgeContractRevision:true})).status,200);
 const newG=queryRow('SELECT * FROM loan_application_guarantors WHERE application_id=?',[guarantorCase]);assert.equal(newG.data_json,'{}');
 assert.equal(queryRow('SELECT status FROM loan_application_guarantor_documents WHERE guarantor_id=?',[newG.id]).status,'rejected');
 const sending=seed();crmDb.prepare("UPDATE contract_generations SET status='sending' WHERE loan_application_id=?").run(sending);
 assert.equal((await mutate(sending,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).data.error,'admin_case_contract_send_in_progress');
 const shared=seed(),other=seed(),sharedGen=queryRow('SELECT current_primary_generation_id id FROM loan_applications WHERE id=?',[shared]).id;
 put('loan_application_generated_documents',{application_id:other,kind:'primary',contract_generation_id:sharedGen,status:'approved',link:'signed:shared'});
 assert.equal((await mutate(shared,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).data.error,'admin_case_shared_contract');
 for(const body of [{requestedAmount:'2000000',acknowledgeContractRevision:true},{durationMonths:13,acknowledgeContractRevision:true},{manualValues:{unknown:'no'},acknowledgeContractRevision:true},{needsGuarantor:'true'},{creditRankIgnored:true}]){
  const id=seed();assert.ok([400,422].includes((await mutate(id,'PATCH','admin-edit',body)).status));
 }
 for(const requestedAmount of [700000,['700000'],{amount:'700000'}]){
  const id=seed();assert.equal((await mutate(id,'PATCH','admin-edit',{requestedAmount,acknowledgeContractRevision:true})).status,400);
 }
 const unitCorrected=seed();
 put('contract_templates',{id:2,name:'قالب تومانی اصلاح‌شده',mappings_json:queryRow('SELECT mappings_json FROM contract_templates WHERE id=1').mappings_json});
 crmDb.prepare("UPDATE contract_generations SET template_id=2,generation_purpose='legacy_toman_replacement' WHERE loan_application_id=?").run(unitCorrected);
 assert.equal((await mutate(unitCorrected,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).status,200);
 assert.equal(JSON.parse(queryRow('SELECT plan_snapshot_json FROM loan_applications WHERE id=?',[unitCorrected]).plan_snapshot_json).contract_template_id,2);
 const rollback=seed(),rollbackBefore=queryRow('SELECT * FROM loan_applications WHERE id=?',[rollback]);
 crmDb.exec("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON loan_application_stage_history BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 assert.equal((await mutate(rollback,'PATCH','admin-edit',{requestedAmount:'700000',acknowledgeContractRevision:true})).status,500);
 assert.deepEqual(queryRow('SELECT * FROM loan_applications WHERE id=?',[rollback]),rollbackBefore);
 assert.equal(queryRow('SELECT superseded_at FROM contract_generations WHERE loan_application_id=?',[rollback]).superseded_at,null);crmDb.exec('DROP TRIGGER reject_admin_audit');
 const audit=JSON.parse(queryRow("SELECT reason FROM loan_application_stage_history WHERE application_id=? AND action='admin-case-edited'",[signed]).reason);
 assert.equal(audit.before.requestedAmount,'600000');assert.equal(audit.after.requestedAmount,'700000');assert.equal(audit.financialPostingChanged,false);
 console.log('PASS: admin-only controls, every stage, confirmed reasons, cancelled reopening, stale revisions, all edit groups, signed document preservation, paid-term locks, no duplicate credit, new plan documents, guarantor identity reset, send/shared guards and atomic rollback.');
  const noteCase=seed('completed',true,true),otherNoteCase=seed(),noteBefore=queryRow('SELECT * FROM loan_applications WHERE id=?',[noteCase]);
  const submitNote=async(actor,clientId,text,file,extra)=>{
    const body=new FormData();body.append('clientId',clientId);if(text)body.append('text',text);
    if(file)body.append('file',new Blob([file.bytes],{type:file.mime}),file.name);
    if(extra)body.append('author_id','999');
    const r=await fetch(base+'/api/loan-applications/'+noteCase+'/notes',{method:'POST',headers:{'x-actor':actor},body});
    return {status:r.status,data:await r.json()};
  };
  const first=await submitNote('staff','synthetic-note-001','یادداشت کارشناس');
  assert.equal(first.status,201);assert.equal(first.data.author.id,2);assert.equal(first.data.author.name,'کارشناس آزمایشی');
  assert.equal((await submitNote('staff','synthetic-note-001','یادداشت کارشناس')).status,200);
  assert.equal((await submitNote('staff','synthetic-note-001','متن متفاوت')).status,409);
  assert.equal((await submitNote('staff','synthetic-forged-01','جعلی',null,true)).status,400);
  assert.equal((await submitNote('readonly','synthetic-denied-01','غیرمجاز')).status,403);
  assert.equal((await submitNote('outsider','synthetic-denied-02','پرونده دیگری')).status,404);
  const png={bytes:Buffer.from('89504e470d0a1a0a00000000','hex'),mime:'image/png',name:'note.png'};
  const attachment=await submitNote('admin','synthetic-note-file','توضیح پیوست',png);assert.equal(attachment.status,201);
  const fileResponse=await fetch(base+attachment.data.attachment.fileUrl,{headers:{'x-actor':'staff','range':'bytes=0-3'}});
  assert.equal(fileResponse.status,206);assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()),png.bytes.subarray(0,4));
  assert.equal((await fetch(base+attachment.data.attachment.fileUrl,{headers:{'x-actor':'outsider'}})).status,404);
  assert.equal((await fetch(base+attachment.data.attachment.fileUrl.replace('/'+noteCase+'/notes/','/'+otherNoteCase+'/notes/'))).status,404);
  assert.equal((await submitNote('admin','synthetic-bad-file','',{...png,bytes:Buffer.from('<script>bad</script>')})).status,400);
  const audio=await submitNote('staff','synthetic-audio-01','',{bytes:Buffer.from('1a45dfa301020304','hex'),mime:'audio/webm',name:'voice.webm'});assert.equal(audio.status,201);assert.equal(audio.data.attachment.kind,'audio');
  const noteCount=queryRow('SELECT COUNT(*) n FROM loan_application_notes WHERE application_id=?',[noteCase]).n,blobs=noteFiles.size;
  crmDb.exec("CREATE TRIGGER reject_note_audit BEFORE INSERT ON loan_application_stage_history BEGIN SELECT RAISE(ABORT,'synthetic note audit failure'); END");
  assert.equal((await submitNote('admin','synthetic-rollback','rollback',png)).status,502);
  assert.equal(queryRow('SELECT COUNT(*) n FROM loan_application_notes WHERE application_id=?',[noteCase]).n,noteCount);assert.equal(noteFiles.size,blobs);
  crmDb.exec('DROP TRIGGER reject_note_audit');
  for(let i=0;i<34;i++)assert.equal((await submitNote('admin','synthetic-page-'+i,'یادداشت آزمایشی '+i)).status,201);
  const notesPage=await request(noteCase,'GET','notes?limit=30');assert.equal(notesPage.data.items.length,30);assert.ok(notesPage.data.nextCursor);
  assert.ok(notesPage.data.items.every((n,i,a)=>i===0||a[i-1].id>n.id));
  const older=await request(noteCase,'GET','notes?beforeId='+notesPage.data.nextCursor);assert.equal(older.data.items.length,7);
  assert.ok(!older.data.items.some(n=>notesPage.data.items.some(x=>x.id===n.id)));
  const historyPage=await request(noteCase,'GET','history?limit=30');assert.equal(historyPage.status,200);assert.equal(historyPage.data.items[0].action,'case-note-added');
  assert.equal((await request(noteCase,'GET','notes?beforeId=no')).status,400);
  assert.equal((await request(noteCase,'GET','notes',undefined,'noaccess')).status,403);
  assert.equal((await request(noteCase,'GET','history',undefined,'outsider')).status,404);
  assert.deepEqual(queryRow('SELECT * FROM loan_applications WHERE id=?',[noteCase]),noteBefore);
  console.log('PASS: case notes persistence, author attribution, idempotency, scoped read/write/files, voice bytes, range reads, newest-first pagination, audit rollback and unchanged financial/signed case.');
 ${serve ? `
 const browserCase=seed('guarantor_documents_review',false,true),fundedBrowserCase=seed('completed',true,true);
  for(let i=0;i<45;i++){
    const id=execute('INSERT INTO loan_application_notes(application_id,author_id,author_name,text,client_id,content_hash,created_at) VALUES(?,?,?,?,?,?,?)',[browserCase,i%2?2:1,i%2?'کارشناس آزمایشی':'مدیر آزمایشی','یادداشت آزمایشی شماره '+i,'browser-note-'+i,'seed',new Date(Date.now()-60000*(45-i)).toISOString()]);
    execute('INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',[browserCase,'guarantor_documents_review','guarantor_documents_review','case-note-added','یادداشت آزمایشی شماره '+i,i%2?2:1,new Date().toISOString()]);
  }
 crmDb.prepare('DELETE FROM loan_application_guarantor_documents WHERE guarantor_id IN (SELECT id FROM loan_application_guarantors WHERE application_id=?)').run(browserCase);
 crmDb.prepare('UPDATE loan_applications SET duration_months=24,requested_duration_months=24 WHERE id=?').run(browserCase);
 crmDb.prepare("UPDATE contract_generations SET manual_values_json=? WHERE loan_application_id=?").run(JSON.stringify({principal:'600000',duration:'24'}),browserCase);
 const vite=await import(${JSON.stringify("file://" + path.resolve(root, "../crm-dashboard/node_modules/vite/dist/node/index.js"))});
 const resolveUI=createRequire(${JSON.stringify(path.resolve(root,"../crm-dashboard/package.json"))});
 const reactPlugin=await import(resolveUI.resolve('@vitejs/plugin-react'));
 const tailwindPlugin=await import(resolveUI.resolve('@tailwindcss/vite'));
 const ui=await vite.createServer({configFile:false,root:${JSON.stringify(path.resolve(root,"../crm-dashboard"))},base:'/',
   plugins:[reactPlugin.default(),tailwindPlugin.default({optimize:false})],
   resolve:{alias:{'@':${JSON.stringify(path.resolve(root,"../crm-dashboard/src"))},'@assets':${JSON.stringify(path.resolve(root,"../../attached_assets"))}},dedupe:['react','react-dom']},
   server:{middlewareMode:true,allowedHosts:true,hmr:{server},fs:{allow:[${JSON.stringify(path.resolve(root,"../.."))}]}},appType:'spa'});
  const releaseDirectory='/tmp/site-notifications-release';
  if(fs.existsSync(releaseDirectory+'/manifest.json')){
    const release=JSON.parse(fs.readFileSync(releaseDirectory+'/manifest.json','utf8'));
    let releaseHtml=fs.readFileSync(releaseDirectory+'/public/index.html','utf8').replace(release.baselineJSName,release.js);
    releaseHtml=release.baselineCSSName?releaseHtml.replace(release.baselineCSSName,release.css):releaseHtml.replace('</head>','<link rel="stylesheet" href="/assets/'+release.css+'"></head>');
    app.use('/assets',express.static(releaseDirectory+'/public/assets'));
    app.get(['/loan-applications/:id','/chat'],(req,res,next)=>{if(req.query.releaseTest==='1')res.type('html').send(releaseHtml);else next()});
  }
 app.use(ui.middlewares);console.log('BROWSER_FIXTURE_READY '+JSON.stringify({url:base,caseId:browserCase,fundedCaseId:fundedBrowserCase}));
 await new Promise(()=>{});` : ""}
}finally{await new Promise(r=>server.close(r))}
`;
const temp = await mkdtemp(path.join(tmpdir(), "loan-admin-fixture-"));
try {
  const output = path.join(temp, "fixture.mjs");
  await build({
    stdin: { contents: worker, resolveDir: root, sourcefile: "admin-fixture.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{ name: "synthetic-database", setup(ctx) {
      if (stagedFeature) {
        ctx.onResolve({filter:/\/loan-case-admin-controls$/},()=>({path:"staged-controls",namespace:"staged-controls"}));
        ctx.onLoad({filter:/.*/,namespace:"staged-controls"},()=>({
          resolveDir:root,loader:"js",contents:`
            import {createHash} from 'node:crypto';
            import {requirePermission} from './src/lib/access-control';
            import {execute,executeChanges,queryRow,queryRows,runImmediateTransaction} from './src/lib/crm-db';
            import {TOMAN_REPLACEMENT_PURPOSE} from './src/lib/legacy-toman-replacement';
            const __adminCaseRuntime={createHash,requirePermission,execute,executeChanges,queryRow,queryRows,runImmediateTransaction,TOMAN_REPLACEMENT_PURPOSE};
            ${stagedFeature}
            export const registerLoanCaseAdminControls=__loanCaseAdminFeature.registerLoanCaseAdminControls;
            export const loanCaseFinancialTermsLocked=__loanCaseAdminFeature.loanCaseFinancialTermsLocked;
          `,
        }));
      }
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: database, loader: "js" }));
      ctx.onResolve({filter:/\/auth$/},()=>({path:"auth",namespace:"fixture-auth"}));
      ctx.onLoad({filter:/.*/,namespace:"fixture-auth"},()=>({contents:"export const requireAdmin=(req,res,next)=>res.locals.authUser?.role==='admin'?next():res.sendStatus(403);export const requireAuth=(req,res,next)=>res.locals.authUser?next():res.sendStatus(401);",loader:"js"}));
    } }],
  });
  const result = spawnSync(process.execPath, [output], { encoding: "utf8", timeout: serve ? undefined : 60000, stdio: serve ? "inherit" : "pipe" });
  if (!serve) { process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); }
  if (result.status !== 0) throw new Error("Administrator loan-case fixture failed");
} finally { await rm(temp, { recursive: true, force: true }); }

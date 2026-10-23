import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/routes/loan-applications.ts"), "utf8");
const scopedSource = source.slice(source.indexOf("function scoped("), source.indexOf("function error("));
const stages = JSON.parse(source.match(/const stages = (\[[\s\S]*?\]) as const/)[1]);
const database = `
import {DatabaseSync} from 'node:sqlite';
export const crmDb=new DatabaseSync(':memory:');
export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
export const runImmediateTransaction=fn=>{crmDb.exec('BEGIN IMMEDIATE');try{const r=fn();crmDb.exec('COMMIT');return r}catch(e){crmDb.exec('ROLLBACK');throw e}};
crmDb.exec(\`
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,stage TEXT,status TEXT,deleted_at TEXT,updated_at TEXT,plan_id INTEGER,plan_ids TEXT);
CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,action TEXT,reason TEXT,actor_id INTEGER,created_at TEXT);
CREATE TABLE wallet_ledger(id INTEGER PRIMARY KEY,application_id INTEGER,amount TEXT);
INSERT INTO customers VALUES(1,'Synthetic one',11,NULL),(2,'Synthetic two',22,NULL);
INSERT INTO salespersons VALUES(11,'Synthetic owner'),(22,'Synthetic other');
INSERT INTO loan_plans VALUES(1,'Synthetic plan');
\`);`;
const worker = `
import assert from 'node:assert/strict';import express from 'express';
import {crmDb,queryRow,execute} from './src/lib/crm-db';
import {registerLoanCaseCancellation,canCancelLoanCase} from './src/lib/loan-case-cancellation';
${scopedSource}
const actors={
admin:{id:1,role:'admin',customerScope:'all'},
owner:{id:2,role:'salesperson',salespersonId:11,customerScope:'assigned'},
other:{id:3,role:'salesperson',salespersonId:22,customerScope:'assigned'},
wide:{id:4,role:'salesperson',salespersonId:22,customerScope:'all'},
registrar:{id:5,role:'registrar',customerScope:'all'},
unlinked:{id:6,role:'salesperson',salespersonId:null,customerScope:'all'}
};
const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.authUser=actors[req.headers['x-actor']];if(!res.locals.authUser)return res.sendStatus(401);next()});
registerLoanCaseCancellation(app,scoped,(r,a)=>({...r,canCancel:canCancelLoanCase(r,a),cancellationReason:queryRow("SELECT reason FROM loan_application_stage_history WHERE application_id=? ORDER BY id DESC LIMIT 1",[r.id])?.reason}),res=>res.locals.authUser);
app.use((err,req,res,next)=>res.status(500).json({error:'fixture_write_failure'}));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
let id=100;
function seed(stage='draft',customerId=1){id++;execute("INSERT INTO loan_applications VALUES(?,?,?,'reviewing',NULL,NULL,1,'[1]')",[id,customerId,stage]);execute("INSERT INTO wallet_ledger VALUES(?,?,?)",[id,id,'900000']);return id}
async function cancel(caseId,actor,body={reason:'  Synthetic cancellation reason  '}){
return fetch('http://127.0.0.1:'+server.address().port+'/loan-applications/'+caseId+'/cancel',{method:'POST',headers:{'Content-Type':'application/json','x-actor':actor},body:JSON.stringify(body)})}
try{
for(const stage of ${JSON.stringify(stages)})for(const actor of ['admin','owner']){
 const cid=seed(stage);const response=await cancel(cid,actor);assert.equal(response.status,200,stage+' '+actor);
 const result=await response.json();assert.equal(result.canCancel,false);assert.equal(result.cancellationReason,'Synthetic cancellation reason');
 const row=queryRow('SELECT * FROM loan_applications WHERE id=?',[cid]);assert.equal(row.stage,stage);assert.equal(row.status,'rejected');
 const h=queryRow('SELECT * FROM loan_application_stage_history WHERE application_id=?',[cid]);assert.equal(h.actor_id,actors[actor].id);assert.equal(h.from_stage,stage);assert.equal(h.to_stage,stage);assert.equal(h.action,'cancel-case');assert.ok(h.created_at);
 assert.equal(queryRow('SELECT amount FROM wallet_ledger WHERE application_id=?',[cid]).amount,'900000');
 assert.equal((await cancel(cid,actor,{reason:'Another reason'})).status,409);
 assert.equal(queryRow('SELECT COUNT(*) n FROM loan_application_stage_history WHERE application_id=?',[cid]).n,1);
}
for(const [actor,status] of [['other',404],['wide',403],['registrar',403],['unlinked',403],['anonymous',401]]){
 const cid=seed();assert.equal((await cancel(cid,actor)).status,status);assert.equal(queryRow('SELECT status FROM loan_applications WHERE id=?',[cid]).status,'reviewing');
}
for(const body of [{},{reason:''},{reason:'  '},{reason:12},{reason:'x'.repeat(1001)},{reason:'valid',customerId:2}]){
 const cid=seed();assert.equal((await cancel(cid,'owner',body)).status,400);assert.equal(queryRow('SELECT status FROM loan_applications WHERE id=?',[cid]).status,'reviewing');
}
const maxId=seed();assert.equal((await cancel(maxId,'owner',{reason:'x'.repeat(1000)})).status,200);
const rollbackId=seed();crmDb.exec("CREATE TRIGGER fail_cancel_history BEFORE INSERT ON loan_application_stage_history BEGIN SELECT RAISE(ABORT,'fixture');END");
assert.equal((await cancel(rollbackId,'owner')).status,500);assert.equal(queryRow('SELECT status FROM loan_applications WHERE id=?',[rollbackId]).status,'reviewing');crmDb.exec('DROP TRIGGER fail_cancel_history');
crmDb.exec('UPDATE customers SET merged_into_customer_id=2 WHERE id=1;INSERT INTO customer_merge_audit VALUES(1,2)');
const mergedId=seed();assert.equal((await cancel(mergedId,'owner')).status,404);assert.equal((await cancel(mergedId,'other')).status,200);
console.log('PASS: all stages including completed, administrator/current owner, merge ownership, forbidden roles, mandatory reason, duplicate protection, atomic rollback and unchanged financial postings.');
}finally{await new Promise(r=>server.close(r))}
`;
const temp = await mkdtemp(path.join(tmpdir(), "loan-cancel-fixture-"));
try {
  const output = path.join(temp, "fixture.mjs");
  await build({
    stdin: { contents: worker, resolveDir: root, sourcefile: "loan-cancel-fixture.ts", loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{ name: "synthetic-only", setup(ctx) {
      ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
      ctx.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: database, loader: "js" }));
    } }],
  });
  const result = spawnSync(process.execPath, [output], { encoding: "utf8", timeout: 60000 });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  if (result.status !== 0) throw new Error("Cancellation fixture failed");
} finally { await rm(temp, { recursive: true, force: true }); }

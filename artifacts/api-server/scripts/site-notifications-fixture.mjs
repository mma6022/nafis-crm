import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const directory=await mkdtemp(path.join(tmpdir(),"site-notifications-"));
// Schema only: no customer rows, runtime data, credentials or copied database.
const schemaFile=process.argv.find(a=>a.startsWith("--schema-file="))?.slice("--schema-file=".length);
const featureFile=process.argv.find(a=>a.startsWith("--feature-file="))?.slice("--feature-file=".length);
const stagedFeature=featureFile?await readFile(featureFile,"utf8"):null;
const schema=schemaFile?{status:0,stdout:await readFile(schemaFile,"utf8"),stderr:""}:spawnSync("python",["-c",`import sqlite3,json
c=sqlite3.connect('file:../../attached_assets/customers_1789823100050.db?mode=ro',uri=True)
print(json.dumps([r[0] for r in c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]))`],{encoding:"utf8"});
assert.equal(schema.status,0,schema.stderr);
const database=`import{DatabaseSync}from'node:sqlite';
export const crmDb=new DatabaseSync(':memory:');
crmDb.exec('PRAGMA foreign_keys=OFF');
crmDb.exec(${JSON.stringify(JSON.parse(schema.stdout).join(";\n"))});
export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);`;
const worker=`
import assert from 'node:assert/strict';import express from 'express';import{once}from'node:events';import{DatabaseSync}from'node:sqlite';
import{crmDb,queryRow,queryRows}from'./src/lib/crm-db';import{createSiteNotificationRouter}from'./src/lib/site-notifications';
import{installCustomerChatHistory}from'./src/lib/customer-chat-history';
import{withNotificationActor}from'./src/lib/notification-actor-context';
const actors={
 admin:{id:1,role:'admin',permissions:[],customerScope:'all'},
 staff:{id:2,role:'salesperson',permissions:['customers.view','loan_applications.view'],customerScope:'assigned',salespersonId:11},
 other:{id:3,role:'salesperson',permissions:['customers.view','loan_applications.view'],customerScope:'assigned',salespersonId:22},
 viewer:{id:4,role:'custom',permissions:['loan_applications.view'],customerScope:'all',salespersonId:11},
 broad:{id:8,role:'salesperson',permissions:['customers.view','loan_applications.view'],customerScope:'all',salespersonId:11},
 empty:{id:5,role:'viewer',permissions:[],customerScope:'all'},
 unlinked:{id:6,role:'salesperson',permissions:['customers.view','loan_applications.view'],customerScope:'assigned',salespersonId:null},
 registrar:{id:7,role:'registrar',permissions:[],customerScope:'all',salespersonId:22},
};
function put(t,v){for(const c of queryRows('PRAGMA table_info('+t+')'))if(c.notnull&&!c.dflt_value&&!c.pk&&!(c.name in v))
 v[c.name]=/INT|REAL/.test(c.type)?1:c.name.endsWith('_at')?new Date().toISOString():'synthetic';
const k=Object.keys(v);return Number(crmDb.prepare('INSERT INTO '+t+'('+k.join(',')+') VALUES('+k.map(()=>'?').join(',')+')').run(...k.map(x=>v[x])).lastInsertRowid);}
put('customers',{id:1,name:'مشتری آزمایشی یک',phone:'09100000001',salesperson_id:11});
put('customers',{id:2,name:'مشتری آزمایشی دو',phone:'09100000002',salesperson_id:22});
put('loan_applications',{id:10,customer_id:1,requested_amount:'600000',status:'reviewing',stage:'customer_documents_review'});
const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.authUser=actors[req.headers['x-actor']??'admin'];next()});
app.use('/api',createSiteNotificationRouter());const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port+'/api/site-notifications';
const request=async(actor='admin',suffix='',data)=>{const r=await fetch(base+suffix,{method:data?'POST':'GET',headers:{'x-actor':actor,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return{status:r.status,body:await r.json()}};
try{
 assert.equal((await request()).body.unreadCount,0,'no historical backfill');
 crmDb.prepare("UPDATE loan_applications SET requested_amount='650000' WHERE id=10").run();
 const change=(await request('staff')).body.items[0];assert.equal(change.target,'/loan-applications/10');
 assert.equal((await request('other')).body.unreadCount,0);assert.equal((await request('empty')).body.items.length,0);
 assert.equal((await request('unlinked')).body.items.length,0);
 assert.equal((await request('missing')).status,401);
 const checkpoint=(await request('staff')).body.latestId;
 crmDb.prepare("UPDATE loan_applications SET updated_at=? WHERE id=10").run(new Date().toISOString());
 assert.equal((await request('staff')).body.latestId,checkpoint,'timestamp polling does not generate duplicates');
 withNotificationActor('user:1',()=>put('loan_application_notes',{application_id:10,author_id:1,author_name:'کارشناس آزمایشی',text:'یادداشت آزمون',client_id:'synthetic-note',content_hash:'synthetic',created_at:new Date().toISOString()}));
 const note=(await request('staff')).body.items[0];assert.equal(note.kind,'case-note');assert.match(note.target,/focus=notes/);
 put('customer_chat_messages',{customer_id:1,sender_type:'customer',sender_id:1,sender_name:'مشتری آزمایشی',text:'پیام مشتری آزمون',kind:'text',client_id:'synthetic-customer',created_at:new Date().toISOString()});
 const message=(await request('staff')).body.items[0];assert.equal(message.target,'/chat?customerId=1');
 crmDb.prepare("UPDATE customers SET name='مشتری دوم ویرایش شد' WHERE id=2").run();
 assert.equal((await request('broad')).body.items.some(x=>x.customerId===2),false,'browse-all permission never broadcasts other experts customers');
 assert((await request('other')).body.items.some(x=>x.customerId===2),'other expert receives their own customer activity');
 const loanPage=(await request('staff','?page=loan-applications')).body;
 assert(loanPage.items.every(x=>x.page==='loan-applications'));
 assert(loanPage.pageCounts['/loan-applications']>0);
 assert.equal(loanPage.pageCounts['/chat'],1);
 await request('staff','/read-all',{throughId:loanPage.latestId,page:'loan-applications'});
 assert.equal((await request('staff')).body.pageCounts['/loan-applications'],undefined);
 assert.equal((await request('staff')).body.pageCounts['/chat'],1,'page read-all preserves other page counts');
 assert.equal((await request('staff','?page=unknown')).status,400);
 assert.equal((await request('staff','/read-all',{throughId:loanPage.latestId,page:'unknown'})).status,400);
 crmDb.prepare('DELETE FROM site_notification_reads WHERE user_id=2').run();
 assert.equal((await request('viewer')).body.items.some(x=>x.kind==='customer-message'),false,'permission isolation');
 const before=(await request()).body.latestId;
 put('customer_chat_messages',{customer_id:1,sender_type:'staff',sender_id:1,sender_name:'کارشناس',text:'پاسخ همکار',kind:'text',client_id:'synthetic-staff',created_at:new Date().toISOString()});
 assert.equal((await request()).body.latestId,before,'staff reply is not a customer-message event');
 crmDb.exec("BEGIN");put('loan_application_notes',{application_id:10,author_id:1,author_name:'کارشناس',text:'rollback',client_id:'rollback',content_hash:'test',created_at:new Date().toISOString()});crmDb.exec("ROLLBACK");
 assert.equal((await request()).body.latestId,before,'notification atomic with originating transaction');
 assert.equal((await request('other','/'+note.id+'/read',{})).status,404);
 assert.equal((await request('staff','/'+message.id+'/read',{})).body.target,'/chat?customerId=1');
 assert((await request('staff')).body.items.find(x=>x.id===message.id).readAt);
 assert.equal((await request('admin')).body.items.find(x=>x.id===message.id).readAt,null,'per-user read state');
 const cut=(await request('staff')).body.latestId;
 withNotificationActor('user:after-cut',()=>put('loan_application_notes',{application_id:10,author_id:1,author_name:'کارشناس',text:'پس از مرز خواندن',client_id:'after-cut',content_hash:'test',created_at:new Date().toISOString()}));
 await request('staff','/read-all',{throughId:cut});
 assert.equal((await request('staff')).body.unreadCount,1,'mark-all cannot acknowledge concurrent unseen activity');
 assert.equal((await request('staff','?limit=1')).body.items.length,1);
 const page=(await request('staff','?limit=1')).body;
 assert(page.nextCursor);
 assert((await request('staff','?limit=1&beforeId='+page.nextCursor)).body.items[0].id<page.items[0].id);
 assert.equal((await request('staff','?beforeId=oops')).status,400);
 assert.equal((await request('staff','/read-all',{throughId:999999})).status,400);
 const version=(await request('staff')).body.scopeVersion;
 crmDb.prepare('UPDATE customers SET salesperson_id=22 WHERE id=1').run();
 assert.equal((await request('staff')).body.items.length,0,'current assignment revokes historical feed access');
 assert.notEqual((await request('staff')).body.scopeVersion,version,'cached UI invalidation after assignment changes');
 assert.equal((await request('staff','/'+note.id+'/read',{})).status,404);
 assert((await request('other')).body.items.some(x=>x.id===note.id));
 crmDb.prepare('UPDATE customers SET salesperson_id=NULL WHERE id=1').run();
 assert.equal((await request('other')).body.items.some(x=>x.customerId===1),false,'unassignment never falls back to old owner');
 // Audited merge lineage: preserve source attribution and authorize through survivor.
 crmDb.prepare('UPDATE customers SET merged_into_customer_id=2 WHERE id=1').run();
 installCustomerChatHistory(crmDb);
 assert.equal((await request('other')).body.items.some(x=>x.id===message.id),false,'an unaudited archive pointer cannot transfer history access');
 put('customer_merge_audit',{source_customer_id:1,survivor_customer_id:2});
 assert.equal((await request('staff')).body.items.length,0);
 assert((await request('other')).body.items.some(x=>x.id===message.id&&x.target==='/chat?customerId=2'));
 crmDb.prepare('UPDATE loan_applications SET customer_id=2 WHERE id=10').run();
 assert((await request('other')).body.items.some(x=>x.id===note.id&&x.target==='/loan-applications/10?focus=notes'));
 assert.equal(queryRow('SELECT requested_amount FROM loan_applications WHERE id=10').requested_amount,'650000','notifications did not alter financial values');
 const thread=put('instagram_threads',{sender_id:'synthetic-page-sender',customer_id:2,status:'converted'});
 put('instagram_messages',{thread_id:thread,mid:'synthetic-inbound',direction:'inbound',content:'synthetic',sent_at:new Date().toISOString()});
 assert((await request('registrar')).body.items.some(x=>x.target==='/instagram-inbox?threadId='+thread));
 assert.equal((await request('other')).body.items.some(x=>x.target.startsWith('/instagram-inbox')),false,'Instagram access follows existing admin/registrar policy');
 crmDb.prepare('DELETE FROM customers WHERE id=2').run();
 assert((await request('other')).body.items.every(x=>x.kind==='customer-deleted'),'deleted customers do not restore historical access through old owners');
 // Independent synthetic case for durable per-actor rolling-minute grouping.
 put('customers',{id:3,name:'مشتری آزمایشی گروه‌بندی',phone:'09100000003',salesperson_id:22});
 put('loan_applications',{id:20,customer_id:3,requested_amount:'600000',status:'reviewing',stage:'customer_documents_review'});
 crmDb.prepare("DELETE FROM site_notification_events WHERE resource_type='loan' AND resource_id=20").run();
 const count=()=>queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE resource_type='loan' AND resource_id=20").n;
 const changeAmount=(amount)=>crmDb.prepare("UPDATE loan_applications SET requested_amount=? WHERE id=20").run(String(amount));
 withNotificationActor('user:1',()=>{
   changeAmount(610000);
   put('loan_application_stage_history',{application_id:20,from_stage:'customer_documents_review',to_stage:'collateral_upload',action:'test-change',actor_id:1});
   put('loan_application_notes',{application_id:20,author_id:1,author_name:'کارشناس',text:'grouped note',client_id:'grouped-note',content_hash:'test'});
   changeAmount(620000);
 });
 assert.equal(count(),1,'multiple table writes and requests by same actor create just one event');
 const grouped=queryRow("SELECT id FROM site_notification_events WHERE resource_type='loan' AND resource_id=20");
 assert.equal((await request('admin','/'+grouped.id+'/read',{})).status,200);
 withNotificationActor('user:1',()=>changeAmount(630000));
 assert.equal(count(),1,'acknowledging does not allow another event within the minute');
 assert(queryRow('SELECT 1 FROM site_notification_reads WHERE user_id=1 AND event_id=?',[grouped.id]),'grouping preserves read state');
 withNotificationActor('user:2',()=>changeAmount(640000));
 assert.equal(count(),2,'another actor receives a separate event');
 crmDb.prepare("UPDATE site_notification_events SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 seconds') WHERE id=?").run(grouped.id);
 withNotificationActor('user:1',()=>changeAmount(650000));
 assert.equal(count(),3,'a new minute permits a new event without waiting for a quiet period');
 const checkpointCount=count();
 crmDb.exec('BEGIN');
 withNotificationActor('user:3',()=>changeAmount(660000));
 crmDb.exec('ROLLBACK');
 assert.equal(count(),checkpointCount,'rollback also removes grouped notification capture');
 await Promise.all(['user:async-a','user:async-b'].map(actor=>withNotificationActor(actor,async()=>{
   await new Promise(resolve=>setTimeout(resolve,5));
   changeAmount(actor.endsWith('a')?670000:680000);
 })));
 assert.equal(count(),checkpointCount+2,'interleaved asynchronous actors remain isolated');
 withNotificationActor('user:1',()=>crmDb.prepare("UPDATE loan_applications SET requested_amount='690000' WHERE id=10").run());
 assert(queryRow("SELECT 1 FROM site_notification_events WHERE resource_type='loan' AND resource_id=10 AND actor_key='user:1'"),'another case is not suppressed');
 const previous=count();
 const {installSiteNotifications}=await import('./src/lib/site-notifications');
 installSiteNotifications();
 withNotificationActor('user:1',()=>changeAmount(700000));
 assert.equal(count(),previous,'reinstall/restart retains the deduplication window');
 assert(queryRow("SELECT 1 FROM loan_application_notes WHERE client_id='grouped-note'"),'grouping never deletes audit or note rows');
 const secondary=new DatabaseSync(':memory:');
 secondary.exec(queryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='site_notification_events'").sql);
 secondary.exec(queryRow("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='site_notification_group_loan_minute'").sql);
 const insertSecondary=secondary.prepare("INSERT INTO site_notification_events(customer_id,customer_name,resource_type,resource_id,kind,title,permission,created_at) VALUES(2,'synthetic','loan',20,'case-change','change','loan_applications.view',strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
 insertSecondary.run();insertSecondary.run();
 assert.equal(secondary.prepare('SELECT COUNT(*) n FROM site_notification_events').get().n,1,'bare secondary connections need no custom function and still group system changes');
 secondary.close();
 assert(queryRows("SELECT sql FROM sqlite_master WHERE type='trigger'").every(row=>!row.sql.includes('site_notification_actor()')),'no persistent business trigger depends on the request-local function');
 console.log('PASS site notifications: real-schema triggers, future-only capture, rollback, role/ownership/merge isolation, read state, targets and durable per-actor/case 60-second grouping including async isolation');
}finally{await new Promise(r=>server.close(r));crmDb.close()}
`;
const output=path.join(directory,"fixture.mjs");
try{
 await build({stdin:{contents:worker,resolveDir:process.cwd(),loader:"js"},bundle:true,platform:"node",format:"esm",packages:"external",outfile:output,
 plugins:[{name:"synthetic",setup(b){
 b.onResolve({filter:/^express$/},()=>({path:path.resolve("node_modules/express/index.js"),external:true}));
 if(stagedFeature){
 b.onResolve({filter:/\/(?:site-notifications|notification-actor-context)$/},()=>({path:"staged-feature",namespace:"staged-feature"}));
 b.onLoad({filter:/.*/,namespace:"staged-feature"},()=>({contents:
 "import{createRequire}from'node:module';import{Router}from'express';import{crmDb,queryRow,queryRows}from'./src/lib/crm-db';import{requireAuth}from'./src/lib/auth';const require=createRequire(import.meta.url);const __siteNotificationBindings={Router,crmDb,queryRow,queryRows,requireAuth};"+
 stagedFeature+";export const createSiteNotificationRouter=__siteNotificationAPI.createSiteNotificationRouter,installSiteNotifications=__siteNotificationAPI.installSiteNotifications,withNotificationActor=__siteNotificationAPI.withNotificationActor;",
 loader:"js",resolveDir:process.cwd()}));
 }
 b.onResolve({filter:/\/(?:crm-db|auth)$/},args=>({path:args.path.endsWith("crm-db")?"db":"auth",namespace:"synthetic"}));
 b.onLoad({filter:/.*/,namespace:"synthetic"},args=>({contents:args.path==="db"?database:"export const requireAuth=(req,res,next)=>res.locals.authUser?next():res.status(401).json({error:'unauthorized'});",loader:"js",resolveDir:process.cwd()}));
 }}],logLevel:"silent"});
 const r=spawnSync(process.execPath,[output],{encoding:"utf8",timeout:60000});process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");assert.equal(r.status,0);
}finally{await rm(directory,{recursive:true,force:true})}

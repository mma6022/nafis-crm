import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Entirely synthetic in-memory DB. No real CRM database or cloud objects.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(tmpdir(), "chat-merge-"));
const dbModule = `
  import { DatabaseSync } from 'node:sqlite';
  export const crmDb=new DatabaseSync(':memory:');
  export const queryRows=(sql,p=[])=>crmDb.prepare(sql).all(...p);
  export const queryRow=(sql,p=[])=>crmDb.prepare(sql).get(...p);
  export const execute=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).lastInsertRowid);
  export const executeChanges=(sql,p=[])=>Number(crmDb.prepare(sql).run(...p).changes);
  export const runImmediateTransaction=fn=>{crmDb.exec('BEGIN IMMEDIATE');try{const out=fn();crmDb.exec('COMMIT');return out}catch(e){crmDb.exec('ROLLBACK');throw e}};
  crmDb.exec(\`
    PRAGMA foreign_keys=ON;
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT,active INTEGER DEFAULT 1);
    CREATE TABLE users(id INTEGER PRIMARY KEY,salesperson_id INTEGER,active INTEGER DEFAULT 1);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,national_code TEXT,
      status TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER,
      shahkar_ok INTEGER DEFAULT 1,person_info_ok INTEGER DEFAULT 1,
      first_name TEXT DEFAULT 'Synthetic',last_name TEXT DEFAULT 'Customer',father_name TEXT DEFAULT 'Fixture',
      birth_date_jalali TEXT DEFAULT '1370/01/01',verification_checked_at TEXT DEFAULT '2026-01-01T00:00:00.000Z');
    CREATE TABLE customer_merge_audit(id INTEGER PRIMARY KEY,source_customer_id INTEGER UNIQUE,
      survivor_customer_id INTEGER,actor_user_id INTEGER,assigned_salesperson_id INTEGER,created_at TEXT,details_json TEXT);
    CREATE TABLE customer_portal_sessions(token_hash TEXT PRIMARY KEY,mobile TEXT,customer_id INTEGER,created_at TEXT,expires_at TEXT);
    CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY,customer_id INTEGER);
    CREATE TABLE consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id_snapshot INTEGER);
    CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id_snapshot INTEGER);
    INSERT INTO salespersons VALUES(11,'Source expert',1),(22,'Target expert',1),(33,'New expert',1);
    INSERT INTO users VALUES(101,11,1),(102,22,1),(103,33,1);
    INSERT INTO customers(id,name,phone,national_code,status,salesperson_id) VALUES
      (1,'Source','+989120000001','fixture-identity','in_progress',11),
      (2,'Survivor','09120000001','fixture-identity','in_progress',22),
      (3,'Unrelated','09120000003','other','in_progress',11),
      (4,'Next survivor','09120000001','fixture-identity','in_progress',22);
    INSERT INTO customers(id,name,phone,national_code,status,salesperson_id) VALUES
      (5,'Different phone source','09120000005','fixture-identity','in_progress',11);
    INSERT INTO goods_purchases VALUES(1,1,11);
    INSERT INTO loan_applications VALUES(1,1,11);
  \`);
`;
const worker = `
  import assert from 'node:assert/strict';
  import {createHmac,createHash,randomBytes} from 'node:crypto';
  import {crmDb as db} from './src/lib/crm-db';
  import {mergeCustomerRecords} from './src/lib/customer-merge';
  import {assertArchivedCustomerSurvivorAccess} from './src/lib/customer-merge-access';
  import {chatReadMarkerSql,findCustomerChatRetry,markCustomerChatRead} from './src/lib/customer-chat-history';
  import {customerChatRouter,staffChatRouter} from './src/routes/customer-chat';
  import express from 'express';
  import cookieParser from 'cookie-parser';
  const now=new Date().toISOString(),expires=new Date(Date.now()+86400000).toISOString();
  const actors={
    old:{id:101,role:'salesperson',customerScope:'assigned',salespersonId:11,permissions:['customers.view'],fullName:'Source expert'},
    new:{id:103,role:'salesperson',customerScope:'assigned',salespersonId:33,permissions:['customers.view'],fullName:'New expert'},
    admin:{id:999,role:'admin',customerScope:'all',salespersonId:null,permissions:['customers.view'],fullName:'Admin'}
  };
  const hash=t=>createHash('sha256').update(t).update('\\0').digest('hex');
  const put=db.prepare(\`INSERT INTO customer_chat_messages
    (id,customer_id,sender_type,sender_id,sender_name,text,kind,object_path,file_name,mime_type,client_id,content_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,'original.pdf','application/pdf',?,?,?)\`);
  const add=(id,c,type,sender,client,text,object=null)=>put.run(id,c,type,sender,type==='staff'?'Historical staff name':'Original customer name',
    text,object?'document':'text',object,client,hash(text),now);
  add(1,1,'customer',1,'shared-client','source customer');
  add(2,1,'staff',101,'shared-staff','source staff','private/unchanged-source');
  add(3,2,'customer',2,'shared-client','target customer');
  add(4,2,'staff',101,'shared-staff','target staff');
  add(5,1,'customer',1,'source-extra','source unread');
  add(6,2,'staff',102,'target-extra','target read');
  add(7,3,'staff',101,'outside-key','outside secret','private/outside');
  db.exec(\`INSERT INTO customer_chat_reads VALUES
    (1,'staff',103,1),(2,'staff',103,6),
    (1,'customer',1,0),(2,'customer',2,6),(1,'staff',101,5);
    INSERT INTO customer_chat_presence VALUES('customer',1,'\${now}');
  \`);
  const token=randomBytes(20).toString('hex'),badToken=randomBytes(20).toString('hex');
  const tokenHash=t=>createHmac('sha256',process.env.SESSION_SECRET).update('customer-portal-session:'+t).digest('hex');
  const session=db.prepare('INSERT INTO customer_portal_sessions VALUES(?,?,?,?,?)');
  session.run(tokenHash(token),'09120000001',1,now,expires);
  session.run(tokenHash(badToken),'09120000999',1,now,expires);
  const messagesBefore=db.prepare('SELECT * FROM customer_chat_messages ORDER BY id').all();
  const readsBefore=db.prepare('SELECT * FROM customer_chat_reads ORDER BY customer_id,reader_type,reader_id').all();
  const compare=()=>({isDuplicate:true,nationalCodeMatches:true,conflictingNationalCodes:false});
  const merge=(from,to)=>mergeCustomerRecords(db,from,to,999,33,now,compare);
  merge(1,2);
  assert.deepEqual(db.prepare('SELECT * FROM customer_chat_messages ORDER BY id').all(),messagesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM customer_chat_reads ORDER BY customer_id,reader_type,reader_id').all(),readsBefore);
  assert.equal(db.prepare('SELECT customer_id FROM goods_purchases').get().customer_id,1);
  assert.equal(db.prepare('SELECT salesperson_id_snapshot FROM loan_applications').get().salesperson_id_snapshot,11);
  assert.equal(db.prepare('SELECT customer_id FROM customer_portal_sessions WHERE token_hash=?').get(tokenHash(token)).customer_id,2);
  assert.equal(db.prepare('SELECT customer_id FROM customer_portal_sessions WHERE token_hash=?').get(tokenHash(badToken)).customer_id,1);
  assert.equal(db.prepare("SELECT last_seen FROM customer_chat_presence WHERE actor_id=1").get().last_seen,'1970-01-01T00:00:00.000Z');
  assert.equal(assertArchivedCustomerSurvivorAccess(db,1,actors.new),2);
  assert.throws(()=>assertArchivedCustomerSurvivorAccess(db,1,actors.old),/Forbidden/);
  const unread=(id,type,reader)=>db.prepare(\`SELECT COUNT(*) n FROM customer_chat_history m
    WHERE customer_id=? AND sender_type<>? AND id>\${chatReadMarkerSql}\`).get(id,type,type,reader).n;
  assert.equal(unread(2,'staff',103),1);
  assert.equal(unread(2,'staff',101),1,'old expert read state does not become new expert state');
  assert.equal(unread(2,'customer',2),1,'target watermark must not swallow older source unread');
  assert.equal(findCustomerChatRetry(db,2,'customer',2,'shared-client','source customer',hash('source customer')).id,1);
  assert.equal(findCustomerChatRetry(db,2,'customer',2,'shared-client','target customer',hash('target customer')).id,3);
  assert.equal(findCustomerChatRetry(db,2,'staff',101,'shared-staff','source staff',hash('source staff')).id,2);
  assert.equal(findCustomerChatRetry(db,2,'staff',101,'shared-staff','target staff',hash('target staff')).id,4);
  assert.throws(()=>findCustomerChatRetry(db,2,'customer',2,'shared-client','changed',hash('changed')),/idempotency_conflict/);
  assert.equal(findCustomerChatRetry(db,2,'staff',103,'shared-staff','new expert text',hash('new expert text')),undefined);

  const app=express();app.use(express.json());app.use(cookieParser());
  app.use((req,res,next)=>{req.log={error(){}};res.locals.authUser=actors[req.headers['x-fixture-actor']];next()});
  app.use('/portal',customerChatRouter);app.use('/staff',staffChatRouter);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  const base='http://127.0.0.1:'+server.address().port;
  const req=async(url,{actor='new',customer=false,tokenValue=token,body,method}={})=>{
    const response=await fetch(base+url,{method:method??(body?'POST':'GET'),headers:{
      'x-fixture-actor':actor,...(customer?{cookie:'customer_portal_session='+tokenValue}:{}),
      ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:response.status,data};
  };
  try {
    const threads=(await req('/staff/threads')).data.items;
    assert.equal(threads.find(t=>t.customerId===2).unreadCount,1);
    assert.equal(threads.find(t=>t.customerId===2).lastMessage,'target read');
    assert.equal(threads.some(t=>t.customerId===1),false);
    assert.equal((await req('/staff/unread-count')).data.count,1);
    let page=await req('/staff/2/messages');assert.equal(page.status,200);
    assert.deepEqual(page.data.items.map(m=>m.id),[1,2,3,4,5,6]);
    assert.equal(page.data.lastReadId,4);
    assert.equal(page.data.items[1].senderName,'Historical staff name');
    assert.equal(page.data.items[1].customerId,2);
    assert.equal((await req('/staff/2/messages?beforeId=4')).data.items.length,3);
    assert.equal((await req('/portal/chat/messages',{customer:true})).data.lastReadId,1);
    assert.equal((await req('/portal/chat/thread',{customer:true})).data.unreadCount,1);
    assert.equal((await req('/portal/chat/thread',{customer:true,tokenValue:badToken})).status,401);
    assert.equal((await req('/staff/2/messages',{actor:'old'})).status,404);
    assert.equal((await req('/staff/1/messages',{actor:'old'})).status,404);
    assert.equal((await req('/staff/messages/2/file',{actor:'old'})).status,404);
    assert.equal((await req('/staff/2/read',{actor:'old',body:{lastMessageId:6}})).status,404);
    assert.equal((await req('/staff/2/messages',{actor:'old',body:{clientId:'old-denied',text:'denied'}})).status,404);
    const oldThreads=(await req('/staff/threads',{actor:'old'})).data.items;
    assert.equal(oldThreads.some(t=>t.customerId===1||t.customerId===2),false);
    assert.equal((await req('/staff/unread-count',{actor:'old'})).data.count,0);
    assert.equal((await req('/staff/messages/2/file')).data,'private/unchanged-source');
    assert.equal((await req('/portal/chat/messages/2/file',{customer:true})).data,'private/unchanged-source');
    assert.equal((await req('/portal/chat/messages/7/file',{customer:true})).status,404);
    assert.equal((await req('/staff/2/read',{body:{lastMessageId:7}})).status,400);
    assert.equal((await req('/portal/chat/messages',{customer:true,body:{clientId:'shared-client',text:'source customer'}})).data.id,1);
    assert.equal((await req('/portal/chat/messages',{customer:true,body:{clientId:'shared-client',text:'target customer'}})).data.id,3);
    assert.equal((await req('/portal/chat/messages',{customer:true,body:{clientId:'shared-client',text:'different'}})).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_chat_messages').get().n,7);
    assert.equal((await req('/staff/2/read',{body:{lastMessageId:1}})).status,200);
    assert.equal((await req('/staff/unread-count')).data.count,1,'earlier read marker cannot erase unread');
    assert.equal((await req('/staff/2/read',{body:{lastMessageId:5}})).status,200);
    assert.equal((await req('/staff/unread-count')).data.count,0);
    assert.equal((await req('/portal/chat/read',{customer:true,body:{lastMessageId:2}})).status,200);
    assert.equal((await req('/portal/chat/thread',{customer:true})).data.unreadCount,0);
    assert.equal((await req('/portal/chat/presence',{customer:true,method:'POST'})).status,200);
    assert.equal((await req('/staff/threads')).data.items.find(t=>t.customerId===2).online,true);
    merge(2,4);
    assert.equal(assertArchivedCustomerSurvivorAccess(db,1,actors.new),4);
    assert.throws(()=>assertArchivedCustomerSurvivorAccess(db,1,actors.old),/Forbidden/);
    assert.equal((await req('/portal/chat/thread',{customer:true})).data.customerId,4);
    assert.equal((await req('/portal/chat/thread',{customer:true})).data.unreadCount,0,'read state survives a second merge');
    assert.equal((await req('/staff/4/messages')).data.items.length,6);
    assert.equal((await req('/staff/messages/2/file')).data,'private/unchanged-source');
    assert.equal((await req('/staff/unread-count')).data.count,0);
    const created=await req('/portal/chat/messages',{customer:true,body:{clientId:'fresh-after-merge',text:'new canonical message'}});
    assert.equal(created.status,201);
    const raw=db.prepare('SELECT * FROM customer_chat_messages WHERE id=?').get(created.data.id);
    assert.equal(raw.sender_id,4);assert.equal(raw.customer_id,4);
    const otherPhoneToken=randomBytes(20).toString('hex');
    session.run(tokenHash(otherPhoneToken),'09120000005',5,now,expires);
    merge(5,4);
    assert.equal(db.prepare('SELECT customer_id FROM customer_portal_sessions WHERE token_hash=?').get(tokenHash(otherPhoneToken)).customer_id,5);
    assert.equal((await req('/portal/chat/thread',{customer:true,tokenValue:otherPhoneToken})).status,401);
    // Pagination spans original and newly canonical history with no duplicates.
    for(let i=20;i<65;i++)add(i,4,'customer',4,'page-key-'+i,'page '+i);
    const firstPage=(await req('/staff/4/messages')).data;
    assert.equal(firstPage.items.length,40);assert.ok(firstPage.nextCursor);
    const secondPage=(await req('/staff/4/messages?beforeId='+firstPage.nextCursor)).data;
    const ids=[...firstPage.items,...secondPage.items].map(m=>m.id);
    assert.equal(ids.length,52);assert.equal(new Set(ids).size,52);
    assert.equal((await req('/staff/4/messages?beforeId=invalid')).status,400);
    assert.equal((await req('/staff/4/messages',{actor:'missing'})).status,401);
    // Rollback includes sessions/presence/audit if a late failure occurs.
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON customer_merge_audit BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    const prior=db.prepare('SELECT * FROM customer_chat_presence').all();
    assert.throws(()=>merge(4,3),/fixture rollback/);
    assert.equal(db.prepare('SELECT merged_into_customer_id FROM customers WHERE id=4').get().merged_into_customer_id,null);
    assert.equal(db.prepare('SELECT customer_id FROM customer_portal_sessions WHERE token_hash=?').get(tokenHash(token)).customer_id,4);
    assert.deepEqual(db.prepare('SELECT * FROM customer_chat_presence').all(),prior);
    assert.deepEqual(db.prepare('SELECT * FROM customer_chat_messages WHERE id<=7 ORDER BY id').all(),messagesBefore);
    db.exec('UPDATE customers SET merged_into_customer_id=4 WHERE id=3');
    assert.equal((await req('/staff/messages/7/file',{actor:'admin'})).status,404,'unaudited pointers expose no history');
    assert.throws(()=>assertArchivedCustomerSurvivorAccess(db,3,actors.admin),/customer_not_found/);
    console.log('PASS: synthetic chat merge, collisions, unread, attachments, ownership, sessions, chained merges and rollback');
  } finally {await new Promise(resolve=>server.close(resolve));db.close()}
`;

try {
  const bundle = path.join(temp, "fixture.mjs");
  await build({
    stdin: { contents: worker, resolveDir: root, sourcefile: "chat-merge-worker.ts" },
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(root, "package.json")).href)});` },
    plugins: [{
      name: "synthetic-infrastructure-only",
      setup(context) {
        context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
        context.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: dbModule, loader: "js" }));
        context.onResolve({ filter: /\/chat-storage$/ }, () => ({ path: "objects", namespace: "fixture" }));
        context.onLoad({ filter: /^objects$/, namespace: "fixture" }, () => ({
          contents: `import {Readable} from 'node:stream';
            export const readChatObject=p=>Readable.from([p]);
            export const saveChatObject=async()=>{throw Error('Unexpected real upload')};
            export const deleteChatObject=async()=>{};
            export const validateChatFile=()=>{throw Error('Unexpected real file')};`, loader: "js",
        }));
      },
    }],
  });
  const result = spawnSync(process.execPath, [bundle], {
    stdio: "inherit", env: { ...process.env, SESSION_SECRET: "synthetic-fixture-only-secret" }, timeout: 60000,
  });
  if (result.status !== 0) throw new Error(`Chat merge fixture failed (${result.status ?? result.error?.message})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

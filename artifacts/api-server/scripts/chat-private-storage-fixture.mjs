import { build } from "esbuild";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Bundle real chat routes, authentication/permission guards and storage, replacing
// ONLY the database with a synthetic in-memory schema. No production DB imports.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbModule = `
  import {DatabaseSync} from 'node:sqlite';
  export const crmDb=new DatabaseSync(':memory:');
  export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
  export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
  export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
  export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
  export const runImmediateTransaction=fn=>{crmDb.exec('BEGIN IMMEDIATE');try{const r=fn();crmDb.exec('COMMIT');return r}catch(e){crmDb.exec('ROLLBACK');throw e}};
  crmDb.exec(\`
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);
    CREATE TABLE users(id INTEGER PRIMARY KEY,salesperson_id INTEGER,active INTEGER);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,
      merged_into_customer_id INTEGER,shahkar_ok INTEGER,person_info_ok INTEGER,first_name TEXT,
      last_name TEXT,father_name TEXT,national_code TEXT,birth_date_jalali TEXT,verification_checked_at TEXT);
    CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
    CREATE TABLE customer_portal_sessions(token_hash TEXT PRIMARY KEY,mobile TEXT,customer_id INTEGER,created_at TEXT,expires_at TEXT);
    INSERT INTO salespersons VALUES(11,'Synthetic expert',1),(22,'Other expert',1);
    INSERT INTO users VALUES(101,11,1),(102,22,1);
    INSERT INTO customers VALUES
      (1,'Synthetic A','09120000001',11,NULL,1,1,'A','Fixture','Fixture','synthetic-a','1370/01/01','2026-01-01T00:00:00.000Z'),
      (2,'Synthetic B','09120000002',22,NULL,1,1,'B','Fixture','Fixture','synthetic-b','1370/01/01','2026-01-01T00:00:00.000Z');
  \`);
`;
const worker = `
  import assert from 'node:assert/strict';
  import {randomBytes,createHmac} from 'node:crypto';
  import {chmod,readdir,lstat,symlink,unlink} from 'node:fs/promises';
  import express from 'express';
  import cookieParser from 'cookie-parser';
  import {crmDb as db} from './src/lib/crm-db';
  import {customerChatRouter,staffChatRouter} from './src/routes/customer-chat';
  import {saveChatObject,readChatObject,deleteChatObject} from './src/lib/chat-storage';
  import {createCustomerPortalSession} from './src/lib/customer-portal-auth';
  process.env.SESSION_SECRET=randomBytes(32).toString('hex');
  const cookies={};
  for(const id of [1,2])createCustomerPortalSession('0912000000'+id,id,{
    cookie(name,value){cookies[id]=name+'='+value}
  });
  const actors={
    owner:{id:101,role:'salesperson',customerScope:'assigned',salespersonId:11,permissions:['customers.view'],fullName:'Synthetic expert'},
    other:{id:102,role:'salesperson',customerScope:'assigned',salespersonId:22,permissions:['customers.view'],fullName:'Other expert'},
    blocked:{id:103,role:'accounting',customerScope:'all',permissions:[],fullName:'No permission'}
  };
  const app=express();app.use(cookieParser());app.use(express.json());
  // Test-only actor injection, never shipped as a production route.
  app.use((req,res,next)=>{req.log={error(){}};res.locals.authUser=actors[req.headers['x-fixture-actor']];next()});
  app.use('/portal',customerChatRouter);app.use('/staff',staffChatRouter);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  const base='http://127.0.0.1:'+server.address().port;
  const headers=(who)=>who==='customer'?{cookie:cookies[1]}:who==='customer2'?{cookie:cookies[2]}:{'x-fixture-actor':who};
  const fetchAs=(url,who,options={})=>fetch(base+url,{...options,headers:headers(who)});
  const collected=async(stream)=>{const chunks=[];for await(const b of stream)chunks.push(b);return Buffer.concat(chunks)};
  const objects=[];
  try {
    assert.equal(process.env.CHAT_STORAGE_BACKEND,'vps-private');
    assert.equal((await readdir(process.env.CHAT_PRIVATE_STORAGE_DIR)).length,0,'use an empty synthetic directory only');
    const samples=[
      ['image.png','image/png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKz8AAAAASUVORK5CYII=','base64'),'image'],
      ['document.pdf','application/pdf',Buffer.from('%PDF-1.4\\n1 0 obj <</Type /Catalog>> endobj\\n%%EOF'),'file'],
      ['voice.wav','audio/wav',Buffer.concat([Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000','hex')]),'audio']
    ];
    for(const [name,mime,bytes,kind] of samples)for(const sender of ['customer','owner']){
      const form=new FormData();form.set('clientId','synthetic-'+randomBytes(10).toString('hex'));
      form.set('file',new Blob([bytes],{type:mime}),name);
      const url=sender==='customer'?'/portal/chat/messages':'/staff/1/messages';
      const sent=await fetchAs(url,sender,{method:'POST',body:form});
      assert.equal(sent.status,201);const message=await sent.json();
      assert.equal(message.kind,kind);
      const ref=db.prepare('SELECT object_path FROM customer_chat_messages WHERE id=?').get(message.id).object_path;
      assert.match(ref,/^vps-private:customer-chat\\//);objects.push(ref);
      assert.equal((await lstat(process.env.CHAT_PRIVATE_STORAGE_DIR+'/'+ref.split('/').at(-1))).mode&0o777,0o600);
      for(const reader of ['customer','owner']){
        const route=reader==='customer'?'/portal/chat':'/staff';
        const response=await fetchAs(route+'/messages/'+message.id+'/file',reader);
        assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('x-content-type-options'),'nosniff');
        assert.equal(response.headers.get('content-type'),mime);
        assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
      }
      for(const [reader,expected] of [['customer2',404],['other',404],['blocked',403],['anonymous',401]]){
        const route=reader==='customer2'?'/portal/chat':'/staff';
        assert.equal((await fetchAs(route+'/messages/'+message.id+'/file',reader)).status,expected);
        const denied=new FormData();denied.set('clientId','denied-upload-'+randomBytes(6).toString('hex'));
        denied.set('file',new Blob([bytes],{type:mime}),name);
        // Customer2 has their own thread; test staff upload denial against A.
        if(reader!=='customer2')assert.equal((await fetchAs('/staff/1/messages',reader,{method:'POST',body:denied})).status,expected);
      }
      // A retry must not write a second object.
      const count=(await readdir(process.env.CHAT_PRIVATE_STORAGE_DIR)).length;
      const retried=await fetchAs(url,sender,{method:'POST',body:form});
      assert.equal(retried.status,200);assert.equal((await retried.json()).id,message.id);
      assert.equal((await readdir(process.env.CHAT_PRIVATE_STORAGE_DIR)).length,count);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_chat_messages').get().n,6);
    await assert.rejects(()=>collected(readChatObject('vps-private:customer-chat/../../etc/passwd')));
    const linkRef='vps-private:customer-chat/00000000-0000-4000-8000-000000000000';
    const link=process.env.CHAT_PRIVATE_STORAGE_DIR+'/'+linkRef.split('/').at(-1);
    await symlink('/etc/passwd',link);
    try{await assert.rejects(()=>collected(readChatObject(linkRef)))}finally{await unlink(link)}
    const selected=process.env.CHAT_STORAGE_BACKEND;
    process.env.CHAT_STORAGE_BACKEND='invalid';
    await assert.rejects(()=>saveChatObject(Buffer.from('test'),'text/plain'),/chat_storage_not_configured/);
    process.env.CHAT_STORAGE_BACKEND=selected;
    await chmod(process.env.CHAT_PRIVATE_STORAGE_DIR,0o755);
    try{await assert.rejects(()=>saveChatObject(Buffer.from('test'),'text/plain'),/chat_private_storage_insecure/)}
    finally{await chmod(process.env.CHAT_PRIVATE_STORAGE_DIR,0o700)}
    // Old managed references must not be rewritten or fall back to local storage.
    delete process.env.REPL_ID;delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    await assert.rejects(()=>collected(readChatObject('/legacy-bucket/private/customer-chat/unchanged')),/chat_managed_credentials_not_configured/);
    console.log('PASS: image/PDF/voice customer+staff uploads, exact reads, private permissions, cross-customer/staff denials, retries, traversal/symlink/config failures, legacy reference dispatch.');
  } finally {
    for(const ref of objects)await deleteChatObject(ref);
    assert.equal((await readdir(process.env.CHAT_PRIVATE_STORAGE_DIR)).length,0);
    await new Promise(resolve=>server.close(resolve));db.close();
    console.log('PASS: synthetic attachments cleaned; only in-memory fixture data used.');
  }
`;
const temp = await mkdtemp(path.join(tmpdir(), "chat-private-fixture-"));
const releaseFeature = process.env.CHAT_RELEASE_FEATURE
  ? await readFile(process.env.CHAT_RELEASE_FEATURE, "utf8") : null;
try {
  const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(temp, "probe.mjs");
  await build({
    stdin: { contents: worker, resolveDir: root, sourcefile: "chat-private-worker.ts" },
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{
      name: "synthetic-db-only",
      setup(context) {
        if (releaseFeature) {
          context.onResolve({ filter: /\/routes\/customer-chat$/ }, () => ({ path: "release-chat", namespace: "fixture" }));
          context.onLoad({ filter: /^release-chat$/, namespace: "fixture" }, () => ({
            contents: `
              import {Router} from 'express'; import multer from 'multer';
              import {crmDb,execute,executeChanges,queryRow,queryRows,runImmediateTransaction} from './src/lib/crm-db';
              import {customerPortalSession,requireCustomerPortal} from './src/lib/customer-portal-auth';
              import {requirePermission} from './src/lib/access-control';
              const chatDeps={Router,multer,crmDb,execute,executeChanges,queryRow,queryRows,runImmediateTransaction,customerPortalSession,requireCustomerPortal,requirePermission};
              ${releaseFeature}
              export const customerChatRouter=ApprovedChatFeature.customerChatRouter;
              export const staffChatRouter=ApprovedChatFeature.staffChatRouter;
            `, resolveDir: root, loader: "js",
          }));
        }
        context.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fixture" }));
        context.onLoad({ filter: /^db$/, namespace: "fixture" }, () => ({ contents: dbModule, loader: "js" }));
      },
    }],
  });
  if (process.argv[2]) console.log("Standalone synthetic probe bundle prepared; no production code deployed.");
  else {
    const storage = path.join(temp, "private");
    await mkdir(storage, { mode: 0o700 });
    const result = spawnSync(process.execPath, [output], {
      stdio: "inherit", timeout: 60000,
      env: { ...process.env, CHAT_STORAGE_BACKEND: "vps-private", CHAT_PRIVATE_STORAGE_DIR: storage },
    });
    if (result.status !== 0) throw new Error(`Private chat fixture failed (${result.status ?? result.error?.message})`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

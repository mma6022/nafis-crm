// Actual upload/list/preview handlers against synthetic SQLite and symlinked
// private storage. Never reads production or attached customer records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require=createRequire(path.resolve('artifacts/api-server/package.json'));
const {transformSync}=require('esbuild'),express=require('express'),multer=require('multer');
const source=fs.readFileSync('artifacts/api-server/src/routes/customer-portal-loans.ts','utf8');
const declaration=name=>{const start=source.indexOf(`function ${name}(`);assert(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'portal-upload-'));
const identityRootReal=path.join(temp,'private'),identityRoot=path.join(temp,'release-link');
fs.mkdirSync(identityRootReal,{mode:0o700});fs.symlinkSync(identityRootReal,identityRoot);
const db=new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE customers(id INTEGER PRIMARY KEY,identity_changed_at TEXT);
 INSERT INTO customers VALUES(1,NULL),(2,NULL);
 CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),
 document_type TEXT,storage_path TEXT,original_name TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,
 created_by_user_id INTEGER,created_by_customer_id INTEGER,created_at TEXT,version INTEGER,is_latest INTEGER,
 approved_at TEXT,review_reason TEXT);`);
const queryRow=(sql,p=[])=>db.prepare(sql).get(...p),queryRows=(sql,p=[])=>db.prepare(sql).all(...p);
const support=source.slice(source.indexOf('const normalizedName'),source.indexOf('const parseJson'))+
 source.slice(source.indexOf('const identityTypeAliases'),source.indexOf('const safeUploadType'))+
 source.slice(source.indexOf('const filingFeeMessages'),source.indexOf('\ntype PortalCustomer'))+
 ['uploadPath','mapIdentityDocument','currentIdentityDocuments'].map(declaration).join('\n');
const uploadTypes=transformSync(fs.readFileSync('artifacts/api-server/src/lib/document-upload-type.ts','utf8').replace(/^export /m,''),{loader:'ts'}).code;
const safeUploadType=new Function(uploadTypes+';return supportedDocumentUpload;')();
const routes=source.slice(source.indexOf('router.get("/identity-documents"'),source.indexOf('router.get("/credit-checks"'));
const bindings={fs,path,crypto,identityRoot,identityRootReal,applicationRoot:'unused',applicationRootReal:'unused',
 safeUploadType,queryRow,queryRows,
 portalCustomer:res=>{const id=Number(res.locals.customerId);if(![1,2].includes(id)){res.status(401).json({error:'customer_authentication_required'});return;}return queryRow('SELECT * FROM customers WHERE id=?',[id]);},
 execute:(s,p=[])=>Number(db.prepare(s).run(...p).lastInsertRowid),
 executeChanges:(s,p=[])=>Number(db.prepare(s).run(...p).changes),
 runTransaction:fn=>{db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},
 upload:multer({limits:{fileSize:10*1024*1024},storage:multer.memoryStorage()}),
 now:()=>new Date().toISOString(),
};
const router=express.Router();
const js=transformSync(`const {${Object.keys(bindings)}}=deps;\n${support}\n${routes}`,{loader:'ts',target:'es2022'}).code;
new Function('deps','router',js)(bindings,router);
const app=express();app.use((req,res,next)=>{res.locals.customerId=req.header('x-customer');next();},router);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
const get=(url,customer='1')=>fetch(base+url,{headers:{'x-customer':customer}});
const send=async(name='image.png',type='image/png',buffer=png,documentType='national_card_front')=>{
 const f=new FormData();f.append('documentType',documentType);f.append('file',new Blob([buffer],{type}),name);
 const r=await fetch(base+'/identity-documents',{method:'POST',headers:{'x-customer':'1'},body:f});return {status:r.status,data:await r.json()};
};
try{
 assert(!path.resolve(identityRoot,'probe.png').startsWith(identityRootReal+path.sep),'Reproduce old symlink guard failure');
 const first=await send();assert.equal(first.status,201,JSON.stringify(first));
 const row=queryRow('SELECT * FROM customer_identity_documents WHERE id=?',[first.data.id]);
 assert(row.storage_path.startsWith(identityRootReal+path.sep));assert(fs.existsSync(row.storage_path));
 const preview=await get(`/identity-documents/${first.data.id}/preview`);
 assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/png');
 assert.equal(preview.headers.get('cache-control'),'private, no-store');
 assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
 assert.equal((await get(`/identity-documents/${first.data.id}/preview`,'2')).status,404,'Other customer blocked');
 assert.equal((await get(`/identity-documents/${first.data.id}/preview`,'')).status,401,'Anonymous blocked');
 assert.equal((await send('image.exe')).status,400);
 const large=await send('large.png','image/png',Buffer.alloc(10*1024*1024+1));assert.equal(large.status,413);assert.match(large.data.message,/۱۰ مگابایت/);
 db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON customer_identity_documents BEGIN SELECT RAISE(ABORT,'synthetic database failure'); END;");
 const failure=await send();assert.equal(failure.status,500);assert.match(failure.data.message,/ذخیره نشد/);
 assert.equal(queryRow('SELECT is_latest FROM customer_identity_documents WHERE id=?',[first.data.id]).is_latest,1,'Failed replacement retains old file');
 assert.equal(fs.readdirSync(identityRootReal).length,1,'Failed file removed');
 db.exec('DROP TRIGGER synthetic_failure');
 const next=await send();assert.equal(next.status,201);
 assert.equal((await get(`/identity-documents/${first.data.id}/preview`)).status,404,'Superseded image not previewable');
 const listed=await (await get('/identity-documents')).json();assert.equal(listed.documents.length,1);assert.equal(listed.documents[0].id,next.data.id);
 const outside=path.join(temp,'outside.png');fs.writeFileSync(outside,png);
 db.prepare('UPDATE customer_identity_documents SET storage_path=? WHERE id=?').run(outside,next.data.id);
 assert.equal((await get(`/identity-documents/${next.data.id}/preview`)).status,404,'Outside storage blocked');
 db.exec("UPDATE customers SET identity_changed_at='2999-01-01T00:00:00.000Z' WHERE id=1");
 assert.equal((await (await get('/identity-documents')).json()).documents.length,0,'Old identity files hidden');
 console.log('PASS actual portal identity handlers: symlink-safe upload, real image preview, private headers, ownership/auth, file limits, rollback/retry, superseded/old-identity/outside-root protection.');
}finally{await new Promise(r=>server.close(r));db.close();fs.rmSync(temp,{recursive:true,force:true});}

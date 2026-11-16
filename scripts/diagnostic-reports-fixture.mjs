import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const directory=await mkdtemp(path.join(tmpdir(),"diagnostic-reports-"));
const source=`
import assert from "node:assert/strict";
import express from "express";
import {once} from "node:events";
import {DatabaseSync} from "node:sqlite";
import {createHmac,randomUUID} from "node:crypto";
import {createDiagnosticRouter} from "./src/lib/diagnostic-reports";
import {captureDiagnosticRequests,redactDiagnosticText,diagnosticPath} from "./src/lib/diagnostic-safety";
import {createTelemetry,redact,stripUrl} from "../crm-dashboard/src/diagnostics/telemetry";
import {createCodexOAuthCallback} from "./src/routes/diagnostic-codex-oauth";
import {createCodexOAuthSetup} from "./src/routes/diagnostic-codex-setup";
import {VpsRepairConnection} from "./src/lib/diagnostic-vps-connection";
const db=new DatabaseSync(':memory:');
let key,build={release:'20261017000000-original',sha256:'a'.repeat(64)},healthy=true;
const auth=(req,res,next)=>{const id=Number(req.get('X-Test-Actor'));if(!id){res.status(401).json({error:'unauthorized'});return;}
res.locals.authUser={id,role:id===1?'admin':'staff'};next()};
const app=express();app.use(express.json());app.use('/api',captureDiagnosticRequests);
let callbackPort,forwarded=[];
 let setupEnabled=true,logins=0,setupPhase='idle',authorizationURL='https://replit.com/oidc/auth?synthetic=true';
app.use('/api',createCodexOAuthSetup({requireAuth:auth,enabled:()=>setupEnabled,origin:()=>'https://crm.test',
  persistentConnection:true,login:{status:async()=>setupPhase,start:async()=>{logins++;setupPhase='awaiting_authorization';return authorizationURL;}}}));
app.use('/api',createCodexOAuthCallback(()=>callbackPort,async(url,options)=>{
 forwarded.push({url,options});return new Response('<p>Authorized by Codex</p>',{status:200});
}));
app.get('/api/loan-applications/:id',auth,(_req,res)=>res.status(409).json({error:'invalid_deduction_percent',privateField:'must never be in diagnostics'}));
app.use('/api',createDiagnosticRouter({db,requireAuth:auth,workerSecret:()=>key,currentBuild:()=>build,healthy:async()=>healthy}));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const call=async(method,url,body,actor=2,headers={})=>{
 const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Test-Actor':String(actor),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return{status:response.status,body:await response.json(),headers:response.headers}
};
const signedHeaders=(url,body,nonce=randomUUID(),timestamp=String(Date.now()))=>{
 const signature=createHmac('sha256',key).update(['POST',url,timestamp,nonce,JSON.stringify(body??{})].join('\\n')).digest('hex');
 return{'X-Repair-Timestamp':timestamp,'X-Repair-Nonce':nonce,'X-Repair-Signature':signature}
};
const worker=async(url,body={})=>call('POST',url,body,0,signedHeaders(url,body));
const input={clientId:randomUUID(),description:'مشکل آزمایشی در نمایش پرونده',page:'/loan-applications/10?token=private',
 browserEvents:[{kind:'error',message:'Bearer super-secret password=short jane@example.org 09123456789',at:new Date().toISOString(),path:'/api/loan-applications/10?secret=hidden'}]};
try{
  let remoteCalls=[];
  const remote=new VpsRepairConnection(async(url,options)=>{
    remoteCalls.push({url,options});
    return new Response(JSON.stringify(options?.method==='POST'
      ? {authorization:'https://replit.com/oidc/auth?synthetic=true'}
      : {connected:true,phase:'authorized'}),{status:200});
  });
  assert.equal(await remote.status(),'authorized');
  assert.equal(await remote.start('https://crm.test'),'https://replit.com/oidc/auth?synthetic=true');
  assert(remoteCalls.every(call=>call.url.startsWith('http://127.0.0.1:7437/')));
  assert.equal(JSON.parse(remoteCalls[1].options.body).origin,'https://crm.test');
  assert.equal(await new VpsRepairConnection(async()=>{throw new Error('offline')}).status(),'unavailable');
  await assert.rejects(new VpsRepairConnection(async()=>new Response(JSON.stringify({
    authorization:'https://outside.test/oidc/auth'}))).start('https://crm.test'),/invalid_authorization_origin/);
 const setupPath='/api/diagnostics/setup/replit';
 const loginGet=await fetch(base+setupPath+'/login',{redirect:'manual',headers:{'X-Test-Actor':'1'}});
 assert.equal(loginGet.status,303);
 assert.equal(loginGet.headers.get('Location'),setupPath);
 assert.equal(logins,0,'GET login never starts authorization');
 assert.equal((await fetch(base+setupPath+'/login')).status,401);
 assert.equal((await fetch(base+setupPath+'/login',{headers:{'X-Test-Actor':'2'}})).status,403);
 assert.equal((await fetch(base+setupPath)).status,401);
 assert.equal((await fetch(base+setupPath,{headers:{'X-Test-Actor':'2'}})).status,403);
  assert.equal((await fetch(base+setupPath+'/status')).status,401);
  assert.equal((await fetch(base+setupPath+'/status',{headers:{'X-Test-Actor':'2'}})).status,403);
  const connectionState=()=>fetch(base+setupPath+'/status',{headers:{'X-Test-Actor':'1'}}).then(r=>r.json());
  assert.equal((await connectionState()).connected,false);
  setupPhase='authorization_received';assert.equal((await connectionState()).connected,false);
  setupPhase='verification_failed';assert.equal((await connectionState()).connected,false);
  setupPhase='authorized';assert.equal((await connectionState()).connected,true);
  assert.equal((await connectionState()).repairRunnerConnected,false,'OAuth success is not runner readiness');
  setupPhase='failed';
 const setup=await fetch(base+setupPath,{headers:{'X-Test-Actor':'1'}});assert.equal(setup.status,200);
 assert.equal(setup.headers.get('Cache-Control'),'no-store');
  const setupHtml=await setup.text();
  const cspNonce=setup.headers.get('Content-Security-Policy').match(/script-src 'nonce-([A-Za-z0-9_-]+)'/)[1];
  assert(setupHtml.includes('<script nonce="'+cspNonce+'">'));
  assert.equal(setup.headers.get('Referrer-Policy'),'same-origin',
    'Same-origin form navigation must preserve Origin for the global CSRF guard');
  assert(setupHtml.includes('target="_blank" rel="noopener"'));
  assert(!setupHtml.includes('noreferrer'),'Form must not override the policy and produce Origin: null');
  assert(setupHtml.includes('ورود قبلی تکمیل نشد'));
  assert(setupHtml.includes('/api'+setupPath.replace('/api','')+'/status'));
  const csrf=setupHtml.match(/name="nonce" value="([A-Za-z0-9_-]+)"/)[1];
 const begin=nonce=>fetch(base+setupPath+'/login',{method:'POST',redirect:'manual',
  headers:{'Content-Type':'application/json','X-Test-Actor':'1'},body:JSON.stringify({nonce})});
 assert.equal((await begin('incorrect')).status,403);assert.equal(logins,0);
 assert.equal((await begin(csrf)).status,303);assert.equal(logins,1);
 assert.equal((await begin(csrf)).status,403,'OAuth start nonce is single use');
 const jsonSetup=await fetch(base+setupPath,{headers:{'X-Test-Actor':'1'}});
 const jsonHtml=await jsonSetup.text();
 assert(jsonHtml.includes('event.preventDefault()'));
 assert(jsonHtml.includes('"Accept":"application/json"'));
 const jsonNonce=jsonHtml.match(/name="nonce" value="([A-Za-z0-9_-]+)"/)[1];
 const jsonLogin=()=>fetch(base+setupPath+'/login',{method:'POST',redirect:'error',
  headers:{'Content-Type':'application/json','Accept':'application/json','X-Test-Actor':'1'},
  body:JSON.stringify({nonce:jsonNonce})});
 const jsonStarted=await jsonLogin();
 assert.equal(jsonStarted.status,200);
 assert.equal((await jsonStarted.json()).authorization,authorizationURL);
 assert.equal(logins,2);
 assert.equal((await jsonLogin()).status,403,'JSON login also consumes its nonce');
 setupEnabled=false;assert.equal((await fetch(base+setupPath)).status,404);setupEnabled=true;
 const callbackPath='/api/diagnostics-worker/codex/callback/client-id';
 assert.equal((await fetch(base+callbackPath+'?code=synthetic&state=synthetic')).status,404);
 callbackPort=7436;
 assert.equal((await fetch(base+callbackPath)).status,400);
 assert.equal((await fetch(base+callbackPath+'?code=a&code=b&state=s')).status,400);
 assert.equal((await fetch(base+callbackPath+'?code=a&state=s&target=https://outside.test')).status,400);
 assert.equal((await fetch(base+callbackPath+'?code=a&state=s',{method:'HEAD'})).status,405);
 assert.equal(forwarded.length,0);
 const callbackResponse=await fetch(base+callbackPath+'?code=synthetic&state=synthetic',{headers:{Cookie:'not-forwarded',Authorization:'not-forwarded'}});
 assert.equal(callbackResponse.status,200);assert.equal(callbackResponse.headers.get('Cache-Control'),'no-store');
 assert.equal(forwarded[0].url,'http://127.0.0.1:7436'+callbackPath+'?code=synthetic&state=synthetic');
 assert.equal(forwarded[0].options.headers,undefined);assert.equal(forwarded[0].options.redirect,'manual');
 assert(!redact('password=short Basic c2VjcmV0').includes('short'));
 assert.equal(stripUrl('https://crm.test/api/cases?token=secret','https://crm.test'),'/api/cases');
 assert.equal(stripUrl('https://external.test/api/cases','https://crm.test'),null);
 const win=new EventTarget();win.location={origin:'https://crm.test'};
 const originalFetch=async()=>new Response('private response content',{status:409,headers:{'X-CRM-Request-ID':'synthetic-request'}});
 win.fetch=originalFetch;
 const browser=createTelemetry(),uninstall=browser.install(win);
 const response=await win.fetch('/api/loan-applications/10?token=secret',{method:'POST',body:'private form value'});
 assert.equal(await response.text(),'private response content','telemetry never consumes or changes fetch response');
 assert.equal(browser.snapshot().length,1);
 assert.equal(browser.snapshot()[0].requestId,'synthetic-request');
 assert.equal(browser.snapshot()[0].path,'/api/loan-applications/10');
 await win.fetch('/api/auth/login');await win.fetch('/api/wallet/share-links/private');await win.fetch('/api/diagnostics/reports');
 assert.equal(browser.snapshot().length,1,'auth, public-wallet and diagnostic requests excluded');
 const extension=Object.assign(new Event('error'),{filename:'chrome-extension://synthetic/inpage.js',message:'extension failure'});
 win.dispatchEvent(extension);assert.equal(browser.snapshot().length,1,'extension errors never trigger app repairs');
 for(let i=0;i<45;i++)browser.push({kind:'error',message:'synthetic '+i});
 assert.equal(browser.snapshot().length,30,'browser ring bounded');
 uninstall();assert.equal(win.fetch,originalFetch);browser.clear();assert.equal(browser.snapshot().length,0);
 assert.equal(redactDiagnosticText('token=short jane@example.org 09123456789').includes('short'),false);
 assert.equal(diagnosticPath('//evil.test/a'),'/');assert.equal(diagnosticPath('/api/wallet/share-links/secret'),'/api/wallet/share-links/[redacted]');
 assert.equal((await call('GET','/api/diagnostics/availability',undefined,0)).status,401);
 assert.equal((await call('GET','/api/diagnostics/availability')).body.connected,false);
 assert.equal((await call('GET','/api/diagnostics/reports/active')).body.report,null);
 assert.equal((await call('POST','/api/diagnostics-worker/claim',{})).status,503);
 await call('GET','/api/loan-applications/10?token=not-stored',undefined,3);
 const business=await call('GET','/api/loan-applications/10?token=not-stored');
 assert(business.headers.get('X-CRM-Request-ID'));
 assert.equal((await call('POST','/api/diagnostics/reports',{...input,description:'short'})).status,400);
 const created=await call('POST','/api/diagnostics/reports',input);assert.equal(created.status,201);
 const id=created.body.id;
 assert.equal(created.body.status,'awaiting_connection');assert.equal(created.body.progress,0);
 const stored=db.prepare('SELECT * FROM diagnostic_reports WHERE id=?').get(id);
 assert.equal(stored.page,'/loan-applications/10');
 assert(!stored.browser_events_json.includes('super-secret'));assert(!stored.browser_events_json.includes('short'));
 assert(!stored.browser_events_json.includes('jane@example.org'));assert(!stored.browser_events_json.includes('09123456789'));
 const serverEvents=JSON.parse(stored.server_events_json);
 assert.equal(serverEvents.length,1,'server logs are strictly actor scoped');
 assert.equal(serverEvents[0].errorCode,'invalid_deduction_percent');
 assert(!stored.server_events_json.includes('not-stored'));assert(!stored.server_events_json.includes('privateField'));
 assert.equal((await call('GET','/api/diagnostics/reports/'+id,undefined,3)).status,404);
 assert.equal((await call('GET','/api/diagnostics/reports/'+id,undefined,1)).status,200);
 assert.equal((await call('POST','/api/diagnostics/reports',input)).body.id,id,'network retry is idempotent');
 assert.equal(db.prepare('SELECT count(*) n FROM diagnostic_reports').get().n,1);
 assert.equal((await call('POST','/api/diagnostics/reports',{...input,clientId:randomUUID()})).status,409,'one open report per actor');
 key='synthetic-worker-auth-key-never-a-real-credential';
 assert.equal((await call('POST','/api/diagnostics-worker/claim',{})).status,401);
 const claimURL='/api/diagnostics-worker/claim',headers=signedHeaders(claimURL,{});
 const claimed=await call('POST',claimURL,{},0,headers);
 assert.equal((await call('POST',claimURL,{},0,headers)).status,409,'signed requests cannot be replayed');
 assert.equal((await call('POST',claimURL,{tampered:true},0,signedHeaders(claimURL,{}))).status,401);
 assert.equal((await call('POST',claimURL,{},0,signedHeaders(claimURL,{},randomUUID(),String(Date.now()-120000)))).status,401);
 const job=claimed.body.job;assert.equal(job.reportId,id);assert.equal(job.policy.reportIsUntrusted,true);
 assert.equal(job.policy.businessDataChangesAllowed,false);
 assert.equal((await call('GET','/api/diagnostics/availability')).body.connected,true);
 assert.equal((await worker(claimURL)).body.job,null,'only one repair/deployment at a time');
 const progressURL='/api/diagnostics-worker/reports/'+id+'/progress';
 let version=job.version;
 const progress=async(status,extra={})=>worker(progressURL,{lease:job.lease,version,status,...extra});
 assert.equal((await progress('resolved')).status,409,'no skipping tests/verification');
 assert.equal((await worker(progressURL,{lease:'incorrect',version,status:'fixing'})).status,404);
 let result=await progress('fixing');assert.equal(result.status,200);version=result.body.version;
 assert.equal((await worker(progressURL,{lease:job.lease,version:job.version,status:'testing'})).status,409);
 result=await progress('testing');assert.equal(result.status,200);version=result.body.version;
 assert.equal((await progress('deploying')).status,422);
 assert.equal((await progress('deploying',{tests:[{name:'typecheck',passed:false}],release:'20261017120000-repaired',sha256:'b'.repeat(64)})).status,422);
 result=await progress('deploying',{tests:[{name:'typecheck',passed:true},{name:'regression',passed:true}],release:'20261017120000-repaired',sha256:'b'.repeat(64)});
 assert.equal(result.status,200);version=result.body.version;
 result=await progress('verifying');assert.equal(result.status,200);version=result.body.version;
 assert.equal((await progress('resolved')).status,409,'old live build cannot satisfy success');
 build={release:'20261017120000-repaired',sha256:'b'.repeat(64)};healthy=false;
 assert.equal((await progress('resolved')).status,409,'unhealthy deployment cannot satisfy success');
 healthy=true;result=await progress('resolved');assert.equal(result.status,200);
 assert.equal(result.body.progress,100);assert.equal(result.body.message,'مشکل حل شد');
 assert.equal((await call('GET','/api/diagnostics/reports/'+id)).body.resolvedRelease,build.release);
 const second=(await call('POST','/api/diagnostics/reports',{...input,clientId:randomUUID()},3)).body;
 const nextJob=(await worker(claimURL)).body.job;assert.equal(nextJob.reportId,second.id);
 db.prepare('UPDATE diagnostic_reports SET lease_until=? WHERE id=?').run(Date.now()-1,second.id);
 assert.equal((await worker('/api/diagnostics-worker/reports/'+second.id+'/progress',{lease:nextJob.lease,version:nextJob.version,status:'fixing'})).status,409);
 const expired=(await call('GET','/api/diagnostics/reports/'+second.id,undefined,3)).body;
 assert.equal(expired.status,'failed');assert.notEqual(expired.progress,100);
 db.prepare('UPDATE diagnostic_worker_state SET last_seen=0').run();
 assert.equal((await call('GET','/api/diagnostics/availability')).body.connected,false);
 assert.equal((await call('GET','/api/diagnostics/reports/active')).body.report.id,id);
 console.log('PASS diagnostics HTTP: persistence/idempotence, actor authorization, scoped metadata/redaction, real disconnected status, HMAC/replay, serial leases, test/deployment/health gates and truthful terminal status');
}finally{await new Promise(resolve=>server.close(resolve));db.close()}
`;
try {
  const output=path.join(directory,"fixture.mjs");
  await build({stdin:{contents:source,resolveDir:process.cwd(),loader:"js"},bundle:true,platform:"node",format:"esm",packages:"external",outfile:output,
    banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},
    plugins:[{name:"fixture-deps",setup(b){
      b.onResolve({filter:/^express$/},()=>({path:path.resolve("node_modules/express/index.js"),external:true}));
      b.onResolve({filter:/^@workspace\/api-zod$/},()=>({path:path.resolve("../../lib/api-zod/src/index.ts")}));
      b.onResolve({filter:/^zod$/},()=>({path:createRequire(path.resolve("../../lib/api-zod/package.json")).resolve("zod"),external:true}));
    }}],logLevel:"silent"});
  const result=spawnSync(process.execPath,[output],{encoding:"utf8",timeout:60000});
  process.stdout.write(result.stdout);process.stderr.write(result.stderr);
  assert.equal(result.status,0);
} finally { await rm(directory,{recursive:true,force:true}); }

import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Exercise real handlers and business logic; never open a CRM customer database.
const temp = await mkdtemp(path.join(os.tmpdir(), "mobile-call-fixture-"));
let server;
try {
  await symlink(path.resolve("node_modules"), path.join(temp, "node_modules"), "dir");
  const dbStub = `
    import {DatabaseSync} from "node:sqlite";
    export const crmDb=new DatabaseSync(":memory:");
    crmDb.exec(\`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,active INTEGER);
      INSERT INTO users VALUES(1,'admin-fixture','Fixture Admin',1),(2,'expert-fixture','Fixture Expert',1),(3,'other-fixture','Other Expert',1);
      CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
      INSERT INTO salespersons VALUES(20,'Fixture Expert'),(30,'Other Expert');
      CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,status TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER,priority INTEGER);
      INSERT INTO customers VALUES(1,'Synthetic other-owner profile','00000000001','in_progress',30,NULL,1);
      CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,salesperson_name_snapshot TEXT,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
      CREATE TABLE voip_extensions(user_id INTEGER,extension TEXT);
      CREATE TABLE voip_call_display_exclusions(phone TEXT);
    \`);
    export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
    export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
    export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
    export const executeChanges=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).changes);
    export const runTransaction=fn=>{crmDb.exec("BEGIN");try{const value=fn();crmDb.exec("COMMIT");return value;}catch(e){crmDb.exec("ROLLBACK");throw e;}};
  `;
  const authStub = `
    export const users=new Map([1,2,3].map(id=>[id,{id,username:"fixture-"+id,fullName:"Fixture "+id,
      active:true,role:id===1?"admin":"salesperson",permissions:["calls.view","calls.create"],
      salespersonId:id===1?null:id*10,customerScope:id===1?"all":"assigned"}]));
    export const getAuthUserById=id=>users.get(id);
  `;
  await build({
    stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
      import express from "express";
      import router,{mobileCallIngress} from "./src/routes/mobile-calls";
      import reports from "./src/routes/call-reports";
      import pending from "./src/routes/voip-after-call";
      import {users} from "./src/lib/auth";
      import {crmDb,queryRow} from "./src/lib/crm-db";
      import {subscribeCallReports} from "./src/lib/voip-call-notifications";
      export {crmDb,queryRow,users};
      export const notifications=[];
      subscribeCallReports(id=>notifications.push(id));
      export const app=express();
      app.use(express.json(),(req,res,next)=>{req.log={error:()=>{}};next();});
      app.use("/api/mobile-calls",mobileCallIngress);
      app.use((req,res,next)=>{res.locals.authUser=users.get(Number(req.get("X-Actor")||1));next();});
      app.use("/api",router,reports,pending);
    ` },
    bundle: true, platform: "node", format: "esm", external: ["express"], outfile: path.join(temp, "fixture.mjs"),
    plugins: [{
      name: "synthetic-boundaries",
      setup(builder) {
        const stubs = {
          "crm-db": dbStub, "auth": authStub,
          "access-control": `export const requirePermission=p=>(req,res,next)=>{if(res.locals.authUser.role==="admin"||res.locals.authUser.permissions.includes(p))next();else res.status(403).json({error:"forbidden"});};`,
          "simotel": `export class SimotelError extends Error{};export const getSimotelCalls=()=>{throw Error("network forbidden");};export const callStartedAt=()=>null;export const callExtensions=()=>[];`,
          "call-display-exclusions": "",
          "recording-transcript-jobs": `export const ensureTranscriptSchema=()=>{};export const transcriptDTO=()=>null;`,
          "recording-summary-jobs": `export const storedCallSummary=()=>null;`,
          "automatic-call-reports": `export const queueAutomaticCallReports=()=>{};`,
        };
        builder.onResolve({filter:/\/(?:crm-db|auth|access-control|simotel|call-display-exclusions|recording-transcript-jobs|recording-summary-jobs|automatic-call-reports)$/}, args => {
          const name=args.path.split("/").pop(); return {path:name,namespace:"fixture"};
        });
        builder.onLoad({filter:/.*/,namespace:"fixture"}, args => ({contents:stubs[args.path],loader:"ts"}));
      },
    }],
  });
  const f = await import(pathToFileURL(path.join(temp, "fixture.mjs")).href);
  server = f.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, method="GET", body, actor=1, token) => {
    const response = await fetch(base+url,{method,headers:{"Content-Type":"application/json","X-Actor":String(actor),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  };
  assert.equal((await request("/mobile-call-devices","POST",{userId:2,deviceName:"Fixture"},2)).status,403);
  const key = (await request("/mobile-call-devices","POST",{userId:2,deviceName:"Fixture phone"})).data;
  assert.ok(key.token.startsWith("mcall_"));
  const listed = (await request("/mobile-call-devices")).data;
  assert.ok(listed.every(d=>!("token" in d)&&!("token_hash" in d)));
  const input = {callId:"fixture-one",direction:"incoming",callerNumber:"00000000001",calleeNumber:"00000000002",
    contactName:"Synthetic phone-book contact",startedAt:"2026-10-06T06:00:00Z"};
  assert.equal((await request("/mobile-calls/start","POST",input,1)).status,401);
  assert.equal((await request("/mobile-calls/start","POST",{...input,expertUserId:3},1,key.token)).status,400);
  assert.equal((await request("/mobile-calls/start","POST",{...input,startedAt:"2026-10-06T06:00:00"},1,key.token)).status,400);
  const started = await request("/mobile-calls/start","POST",input,1,key.token);
  assert.equal(started.status,200); assert.equal(started.data.isLive,true);
  assert.equal(started.data.expertUserId,2); assert.equal(started.data.customerId,null);
  const id = started.data.id;
  assert.equal((await request("/mobile-calls/start","POST",input,1,key.token)).data.id,id);
  assert.equal(f.queryRow("SELECT count(*) n FROM voip_after_call_events").n,1);
  assert.equal((await request("/voip/after-call/pending","GET",undefined,2)).data.items[0].id,id);
  assert.equal((await request("/voip/after-call/pending","GET",undefined,3)).data.items.length,0);
  assert.equal((await request(`/voip/after-call/${id}/report`,"GET",undefined,3)).status,404);
  const report = (await request(`/voip/after-call/${id}/report`,"GET",undefined,2)).data;
  assert.equal(report.call.customerId,null); assert.equal(report.mobile.contactName,input.contactName);
  assert.equal(report.isLive,true); assert.equal(report.subject,null);
  assert.equal((await request(`/voip/after-call/${id}/report`,"PATCH",{subject:"Synthetic subject",expertNotes:"Synthetic notes",expectedRevision:0},2)).status,200);
  const ending = {...input,answeredAt:"2026-10-06T06:00:30Z",endedAt:"2026-10-06T06:01:00Z",durationSeconds:30,status:"completed"};
  assert.equal((await request("/mobile-calls/end","POST",{...ending,durationSeconds:70},1,key.token)).status,400);
  const finished = await request("/mobile-calls/end","POST",ending,1,key.token);
  assert.equal(finished.status,200); assert.equal(finished.data.durationSeconds,30); assert.equal(finished.data.isLive,false);
  assert.equal(finished.data.subject,null); assert.equal(finished.data.expertNotes,""); // ingress cannot read CRM notes
  const saved = (await request(`/voip/after-call/${id}/report`,"GET",undefined,2)).data;
  assert.equal(saved.subject,"Synthetic subject"); assert.equal(saved.expertNotes,"Synthetic notes");
  assert.equal((await request("/mobile-calls/start","POST",input,1,key.token)).data.isLive,false);
  assert.equal((await request("/mobile-calls/end","POST",ending,1,key.token)).data.id,id);
  assert.equal((await request("/mobile-calls/end","POST",{...ending,durationSeconds:29},1,key.token)).status,409);
  const endFirst = {...ending,callId:"end-before-start",direction:"outgoing",contactName:""};
  assert.equal((await request("/mobile-calls/end","POST",endFirst,1,key.token)).status,200);
  assert.equal((await request("/mobile-calls/start","POST",{...input,callId:endFirst.callId,direction:"outgoing",contactName:""},1,key.token)).data.isLive,false);
  const all = (await request("/mobile-calls","GET",undefined,2)).data;
  assert.equal(all.total,2); assert.equal(all.totalDurationSeconds,60); assert.equal(all.incomingCount,1); assert.equal(all.outgoingCount,1);
  assert.ok(all.items.some(c=>!c.expertNotes&&c.reportSavedAt===null));
  assert.equal((await request("/mobile-calls","GET",undefined,3)).data.total,0);
  assert.equal((await request("/mobile-calls?expertUserId=2","GET",undefined,3)).status,403);
  assert.equal((await request("/mobile-calls?direction=outgoing","GET",undefined,2)).data.total,1);
  assert.equal((await request("/mobile-calls?fromDate=2026-10-07","GET",undefined,2)).data.total,0);
  assert.equal((await request("/mobile-calls?fromDate=2026-02-31","GET",undefined,2)).status,400);
  const progress = {...input,callId:"answer-progress",answeredAt:"2026-10-06T06:00:30Z"};
  assert.equal((await request("/mobile-calls/start","POST",progress,1,key.token)).status,200);
  const progressEnd = {...input,callId:progress.callId,endedAt:"2026-10-06T06:01:00Z",durationSeconds:40,status:"completed"};
  assert.equal((await request("/mobile-calls/end","POST",progressEnd,1,key.token)).status,400);
  assert.equal((await request("/mobile-calls/end","POST",{...progressEnd,durationSeconds:30},1,key.token)).status,200);
  const unknown = {...input,callId:"withheld",callerNumber:"unknown",contactName:"",endedAt:"2026-10-06T06:00:30Z",durationSeconds:0,status:"missed"};
  assert.equal((await request("/mobile-calls/end","POST",unknown,1,key.token)).status,200);
  f.users.get(2).active=false;
  assert.equal((await request("/mobile-calls/start","POST",input,1,key.token)).status,401);
  f.users.get(2).active=true;
  assert.equal((await request(`/mobile-call-devices/${key.device.id}`,"DELETE")).status,200);
  assert.equal((await request("/mobile-calls/start","POST",input,1,key.token)).status,401);
  assert.equal(f.queryRow("SELECT count(*) n FROM voip_after_call_events").n,4);
  assert.ok(f.notifications.every(expert=>expert===2));
  console.log("Mobile calls passed: real POST handlers, no-note storage, idempotency, end-before-start, live report edits, customer redaction, expert isolation, date filters, timing validation, withheld numbers and revocation.");
} finally {
  if (server) await new Promise(resolve=>server.close(resolve));
  await rm(temp,{recursive:true,force:true});
}

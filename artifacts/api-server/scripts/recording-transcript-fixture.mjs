import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {execFileSync} from "node:child_process";
import {build} from "esbuild";
import express from "express";

const temp=await fs.mkdtemp(path.join(os.tmpdir(),"transcript-fixture-"));
const db=new DatabaseSync(":memory:");
globalThis.transcriptFixtureDb=db;
const actor=(id,role="salesperson")=>({id,role,customerScope:role==="admin"?"all":"assigned",salespersonId:id===2?11:12,
  active:true,permissions:["calls.view","calls.create"]});
globalThis.transcriptFixtureActors=new Map([[1,actor(1,"admin")],[2,actor(2)],[3,actor(3)]]);
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER,created_at TEXT,salesperson_id INTEGER);
 CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
 CREATE TABLE voip_extensions(user_id INTEGER PRIMARY KEY,extension TEXT);
 INSERT INTO users VALUES(1,'admin','Admin','admin',1,'2026-10-04',NULL),(2,'first','First','salesperson',1,'2026-10-04',11),(3,'second','Second','salesperson',1,'2026-10-04',12);
 INSERT INTO customers VALUES(1,'Synthetic One','09120000001',11,NULL),(2,'Synthetic Two','09120000002',12,NULL);
 INSERT INTO voip_extensions VALUES(2,'201'),(3,'202');`);
const stereo=path.join(temp,"stereo.wav"),mono=path.join(temp,"mono.wav"),dual=path.join(temp,"dual.wav");
execFileSync("ffmpeg",["-v","error","-y","-f","lavfi","-i","sine=frequency=330:sample_rate=8000:duration=4",
 "-f","lavfi","-i","sine=frequency=800:sample_rate=8000:duration=4","-filter_complex","[0:a][1:a]amerge=inputs=2[a]","-map","[a]",stereo]);
execFileSync("ffmpeg",["-v","error","-y","-f","lavfi","-i","sine=frequency=330:sample_rate=8000:duration=4",mono]);
execFileSync("ffmpeg",["-v","error","-y","-i",mono,"-ac","2",dual]);
const rows=["stereo","mono","cross","other-internal","no-audio","retry","revoked"].map(id=>({
 _id:id,cuid:"duplicate",src:id==="other-internal"?"202":"201",dst:id==="cross"?"09120000002":"09120000001",type:"outgoing",
 start:"2026-10-04T10:00:00Z",duration:4,billsec:4,disposition:"ANSWERED",...(id==="no-audio"?{}:{record:id+".wav"}),
 endtime:{$date:{$numberLong:String(Date.parse("2026-10-04T10:00:04Z"))}},
}));
const originalFetch=globalThis.fetch;
let modelRequests=0,modelFailure=false,summaryRequests=0,summaryFailure=false,changeSummarySource=false,server;
Object.assign(process.env,{NODE_ENV:"test",SIMOTEL_API_KEY:"synthetic",OPENAI_API_KEY:"synthetic"});
globalThis.fetch=async(input,options={})=>{
 const url=new URL(String(input));
 if(url.hostname==="127.0.0.1")return originalFetch(input,options);
 if(url.origin==="https://panel.hostedpbx.ir"){
  if(url.pathname.endsWith("/cdr/search")){
   const req=JSON.parse(options.body);
   return Response.json({success:1,data:{pagination:{total:rows.length},data:rows.slice(req.pagination.start,req.pagination.start+req.pagination.count)}});
  }
  assert.ok(url.pathname.endsWith("/audio/download"));
  const name=JSON.parse(options.body).file;
  return new Response(await fs.readFile(name==="stereo.wav"?stereo:mono),{headers:{"Content-Type":"audio/wav"}});
 }
 if(url.href==="https://api.openai.com/v1/chat/completions"){
  summaryRequests++;
  const body=JSON.parse(options.body);
  assert.equal(body.model,"gpt-4.1-mini");
  assert.equal(body.response_format.json_schema.strict,true);
  assert.match(body.messages[0].content,/پیشنهاد کارشناس/);
  assert.ok(JSON.parse(body.messages[1].content).transcript.includes("گفتگوی آزمایشی"));
  if(summaryFailure)return Response.json({error:{message:"UPSTREAM_PRIVATE_DETAIL"}},{status:429});
  if(changeSummarySource){
   const row=db.prepare("SELECT result_json FROM voip_recording_transcripts WHERE external_id='mono'").get();
   const result=JSON.parse(row.result_json);result.text+=" تغییر متن.";
   db.prepare("UPDATE voip_recording_transcripts SET result_json=? WHERE external_id='mono'").run(JSON.stringify(result));
  }
  return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({
   subject:"گفت‌وگوی آزمایشی",customerRequestSummary:"از متن مکالمه مشخص نیست."
  })}}]});
 }
 assert.equal(url.href,"https://api.openai.com/v1/audio/transcriptions");
 const diarizing=options.body.get("model")==="gpt-4o-transcribe-diarize";
 if(diarizing){
  assert.equal(options.body.get("language"),"fa");
  assert.equal(options.body.get("chunking_strategy"),"auto");
 }else{
  assert.equal(options.body.get("model"),"gpt-transcribe");
  assert.equal(options.body.get("languages[]"),"fa");
  assert.equal(options.body.get("temperature"),"0");
  assert.match(options.body.get("prompt"),/فارسی/);
 }
 assert.ok(options.body.get("file").size>0);
 modelRequests++;
 if(modelFailure)return Response.json({error:{type:"insufficient_quota",code:"credit_balance_exhausted",message:"UPSTREAM_PRIVATE_DETAIL"}},{status:429});
 const text="سلام، این یک گفتگوی آزمایشی است.";
 return Response.json(diarizing?{text,segments:[{speaker:"A",start:0,end:3,text:"DIARIZER_WRONG_WORDS"}]}:{text});
};
try{
 const bundle=path.join(temp,"test.mjs");
 await build({
  stdin:{contents:`export{default as router}from'./src/routes/recording-transcripts.ts';export*from'./src/lib/recording-transcript-jobs.ts';export*from'./src/lib/recording-transcription.ts';export*from'./src/lib/recording-summary-jobs.ts';`,resolveDir:path.resolve(".")},
  outfile:bundle,bundle:true,format:"esm",platform:"node",logLevel:"silent",
  banner:{js:`import{createRequire}from'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.resolve("package.json")).href)});`},
  plugins:[{name:"isolated-data",setup(ctx){
   ctx.onResolve({filter:/\/crm-db$/},()=>({path:"db",namespace:"fixture"}));
   ctx.onResolve({filter:/\/auth$/},()=>({path:"auth",namespace:"fixture"}));
   ctx.onResolve({filter:/\/logger$/},()=>({path:"logger",namespace:"fixture"}));
   ctx.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:args.path==="logger"
    ?`export const logger={error(){},warn(){},info(){}};`:args.path==="auth"
    ?`export const getAuthUserById=id=>globalThis.transcriptFixtureActors.get(id);`
    :`export const crmDb=globalThis.transcriptFixtureDb;
      export const queryRow=(s,p=[])=>crmDb.prepare(s).get(...p);
      export const queryRows=(s,p=[])=>crmDb.prepare(s).all(...p);
      export const execute=(s,p=[])=>Number(crmDb.prepare(s).run(...p).lastInsertRowid);
      export const executeChanges=(s,p=[])=>Number(crmDb.prepare(s).run(...p).changes);
      export function runTransaction(fn){crmDb.exec('BEGIN');try{const v=fn();crmDb.exec('COMMIT');return v}catch(e){crmDb.exec('ROLLBACK');throw e}}`}));
  }}],
 });
 const mod=await import(pathToFileURL(bundle).href);
 assert.deepEqual(await mod.probeRecording(mono),{duration:4,channels:1});
 assert.equal(await mod.hasIndependentChannels(stereo,2),true);
 assert.equal(await mod.hasIndependentChannels(dual,2),false,"Dual mono is not falsely called separated speakers");
 assert.throws(()=>mod.validateDiarizedResponse({text:"wrong",segments:[]},4));
 assert.throws(()=>mod.validateDiarizedResponse({text:"wrong",segments:[{speaker:"A",start:0,end:999,text:"wrong"}]},4));
 assert.throws(()=>mod.validateSpeechText({text:"بله ".repeat(30)}),/تکراری/);
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{
  const header=req.headers["x-fixture-user"];
  if(header){const who=globalThis.transcriptFixtureActors.get(header==="other"?3:header==="admin"?1:2);
   res.locals.authUser=header==="viewer"?{...who,permissions:["calls.view"]}:who;}
  next();
 });app.use(mod.router);
 server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
 const base=`http://127.0.0.1:${server.address().port}/voip/recordings/`;
 const get=(id,user="agent")=>fetch(base+id+"/transcript?from=2026-10-04&to=2026-10-04",{headers:user?{"x-fixture-user":user}:{}});
 const post=(id,user="agent",regenerate=false)=>fetch(base+id+"/transcript",{method:"POST",headers:{"x-fixture-user":user,"Content-Type":"application/json"},
  body:JSON.stringify({from:"2026-10-04",to:"2026-10-04",regenerate})});
 assert.equal((await get("stereo",null)).status,401);
 assert.equal((await get("stereo","other")).status,404);
 assert.equal((await get("cross")).status,200,"Own internal audio is independent of customer ownership");
 assert.equal((await post("other-internal")).status,404,"Customer ownership does not grant another internal's audio");
 assert.equal((await get("no-audio")).status,404);
 assert.equal((await post("stereo","viewer")).status,403);
 assert.equal((await (await get("stereo","viewer")).json()).canGenerate,false);
 assert.equal((await (await get("stereo")).json()).state,"not_started");
 assert.deepEqual((await Promise.all([post("stereo"),post("stereo")])).map(x=>x.status),[200,200]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM voip_recording_transcripts").get().n,1);
 await mod.processTranscriptQueue();
 const result=await (await get("stereo")).json();
 assert.equal(result.state,"completed");assert.equal(result.audioSeparation,"stereo_channels");
 assert.equal(result.speakers.length,2);assert.equal(result.durationSeconds,4);
 assert.equal(modelRequests,6,"Each channel receives accurate recognition, speaker timing, and corrected turn text");
 assert.equal(result.model,"gpt-transcribe");
 assert.equal(result.text.includes("DIARIZER_WRONG_WORDS"),false,"Diarizer text is never exposed as the accurate transcript");
 assert.equal((await post("stereo")).status,200);
 await mod.processTranscriptQueue();assert.equal(modelRequests,6,"Completed result never re-bills without explicit regeneration");
 assert.equal((await post("mono")).status,200);await mod.processTranscriptQueue();
 assert.equal((await (await get("mono")).json()).audioSeparation,"diarization");
 const retrySummary=(id,actor="agent")=>originalFetch(`${base}${id}/transcript/summary`,{
  method:"POST",headers:{"Content-Type":"application/json","x-fixture-user":actor},body:JSON.stringify({from:"2026-10-04",to:"2026-10-04"})
 });
 assert.equal((await retrySummary("mono","viewer")).status,403,"View-only users cannot generate summaries");
 const speechCountBeforeSummary=modelRequests;
 await mod.processCallSummaryQueue();
 const summarized=await (await get("stereo","viewer")).json();
 assert.equal(summarized.summaryState,"completed");
 assert.equal(summarized.callSubject,"گفت‌وگوی آزمایشی");
 assert.equal(summarized.customerRequestSummary,"از متن مکالمه مشخص نیست.");
 await retrySummary("stereo");await mod.processCallSummaryQueue();
 assert.equal(modelRequests,speechCountBeforeSummary,"Summary generation never sends audio or reruns ASR");
 assert.equal(summaryRequests,2,"A cached successful summary is never billed again");
 const editedBase=await (await get("stereo")).json();
 const editPayload={from:"2026-10-04",to:"2026-10-04",sourceHash:editedBase.summarySourceHash,expectedRevision:0,callSubject:"موضوع اصلاح‌شده",customerRequestSummary:"درخواست اصلاح‌شده مشتری"};
 const edit=(body,actor="admin")=>fetch(`${base}stereo/transcript/summary`,{method:"PATCH",headers:{"content-type":"application/json","x-fixture-user":actor},body:JSON.stringify(body)});
 assert.equal((await edit(editPayload,"viewer")).status,403);
 assert.equal((await edit(editPayload,"other")).status,404);
 assert.equal((await edit(editPayload)).status,200);
 assert.equal((await edit(editPayload)).status,409,"Concurrent old editor cannot overwrite the correction");
 assert.equal((await (await get("stereo")).json()).callSubject,editPayload.callSubject,"Human correction persists across reads");
 await retrySummary("stereo");await mod.processCallSummaryQueue();
 assert.equal(summaryRequests,2,"Manual correction neither rebills nor gets overwritten by AI");
 assert.equal((await edit({...editPayload,expectedRevision:1,callSubject:"",customerRequestSummary:""})).status,200,"Explicit clears are saved");
 assert.equal((await (await get("stereo")).json()).customerRequestSummary,"");
 assert.equal((await edit({...editPayload,expectedRevision:2,sourceHash:"0".repeat(64)})).status,409,"Stale transcript prevents saving");
 db.prepare("DELETE FROM voip_recording_summaries WHERE external_id='mono'").run();
 const beforeSummaryFailure=mod.transcriptJob("mono").result_json;
 summaryFailure=true;
 await Promise.all([retrySummary("mono"),retrySummary("mono")]);await mod.processCallSummaryQueue();
 const summaryFailed=await (await get("mono")).json();
 assert.equal(summaryFailed.state,"completed","Summary failure leaves the transcript readable");
 assert.equal(summaryFailed.summaryState,"failed");
 assert.equal(summaryFailed.summaryError.includes("UPSTREAM_PRIVATE_DETAIL"),false);
 assert.equal(mod.transcriptJob("mono").result_json,beforeSummaryFailure);
 const failedSummaryCount=summaryRequests;
 await get("mono");await mod.processCallSummaryQueue();
 assert.equal(summaryRequests,failedSummaryCount,"Polling never rebills a failed summary");
 summaryFailure=false;await retrySummary("mono");await mod.processCallSummaryQueue();
 assert.equal((await (await get("mono")).json()).summaryState,"completed");
 db.prepare("DELETE FROM voip_recording_summaries WHERE external_id='mono'").run();
 changeSummarySource=true;await retrySummary("mono");await mod.processCallSummaryQueue();changeSummarySource=false;
 assert.equal((await (await get("mono")).json()).callSubject,null,"A summary for an outdated transcript is never exposed");
 assert.equal((await (await get("mono")).json()).summaryState,"not_started","Reading never initiates a billable model request");
 await retrySummary("mono");
 await mod.processCallSummaryQueue();
 assert.equal((await (await get("mono")).json()).summaryState,"completed");
 assert.match((await (await get("mono")).json()).notice,/هم‌زمان/);
 const previous=mod.transcriptJob("stereo").result_json;
 assert.equal((await post("stereo","viewer",true)).status,403);
 await Promise.all([post("stereo","agent",true),post("stereo","agent",true)]);
 assert.equal(mod.transcriptJob("stereo").state,"queued");
 assert.equal(mod.transcriptJob("stereo").result_json,previous,"Existing transcript survives until replacement succeeds");
 const before=modelRequests;
 await mod.processTranscriptQueue();
 assert.equal(modelRequests,before+6,"Double-click regeneration runs only one replacement");
 assert.equal(mod.transcriptJob("stereo").state,"completed");
 const lastGood=mod.transcriptJob("stereo").result_json;
 modelFailure=true;
 await post("stereo","agent",true);await mod.processTranscriptQueue();
 assert.equal(mod.transcriptJob("stereo").state,"failed");
 assert.equal(mod.transcriptJob("stereo").result_json,lastGood,"Failed paid regeneration preserves the previous successful transcript");
 modelFailure=false;
 modelFailure=true;await post("retry");await mod.processTranscriptQueue();
 assert.equal((await (await get("retry")).json()).state,"failed");
 assert.match((await (await get("retry")).json()).error,/اعتبار/);
 assert.equal((await (await get("retry")).json()).error.includes("UPSTREAM_PRIVATE_DETAIL"),false);
 modelFailure=false;await post("retry");await mod.processTranscriptQueue();
 assert.equal((await (await get("retry")).json()).state,"completed");
 await post("revoked");globalThis.transcriptFixtureActors.get(2).active=false;
 await mod.processTranscriptQueue();assert.equal(mod.transcriptJob("revoked").state,"failed");
 globalThis.transcriptFixtureActors.get(2).active=true;
 db.prepare("UPDATE voip_recording_transcripts SET source_file='old.wav' WHERE external_id='stereo'").run();
 const stale=await (await get("stereo")).json();
 assert.equal(stale.state,"failed");assert.equal(stale.text,null,"Old source text is not shown as current");
 assert.equal((await fs.readdir(os.tmpdir())).some(x=>x.startsWith("crm-transcript-")),false,"Temporary customer audio removed after success/failure");
 console.log("PASS: real FFmpeg 8kHz preprocessing, stereo separation, dual-mono detection, diarized validation, permissions/ownership, idempotent queue, persisted results, source freshness, API error/retry, revoked access, temporary-audio cleanup.");
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 globalThis.fetch=originalFetch;delete globalThis.transcriptFixtureDb;delete globalThis.transcriptFixtureActors;
 db.close();await fs.rm(temp,{recursive:true,force:true});
}
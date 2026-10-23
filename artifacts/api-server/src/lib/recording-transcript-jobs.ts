import fs from "node:fs/promises";
import {createWriteStream} from "node:fs";
import os from "node:os";
import path from "node:path";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import type {VoipRecordingTranscript} from "@workspace/api-zod";
import {crmDb,executeChanges,queryRow} from "./crm-db";
import {logger} from "./logger";
import {getAuthUserById} from "./auth";
import {getSimotelAudio,SimotelError} from "./simotel";
import {authorizedVoipRecording} from "../routes/simotel-recordings";
import {transcribeRecording,TranscriptionError,speechConfigured} from "./recording-transcription";
import {callSummaryDTO,queueCallSummary,processCallSummaryQueue} from "./recording-summary-jobs";

type Job={external_id:string;source_file:string;range_from:string;range_to:string;requested_by:number;state:string;
  phase:string|null;error:string|null;result_json:string|null;completed_at:string|null;lease_until:string|null};
export function ensureTranscriptSchema(){
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_recording_transcripts(
    external_id TEXT PRIMARY KEY,source_file TEXT NOT NULL,range_from TEXT NOT NULL,range_to TEXT NOT NULL,
    requested_by INTEGER NOT NULL,state TEXT NOT NULL,phase TEXT,error TEXT,result_json TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,lease_until TEXT);
    CREATE INDEX IF NOT EXISTS idx_recording_transcript_queue ON voip_recording_transcripts(state,created_at);`);
}
export function transcriptJob(id:string){return queryRow<Job>("SELECT * FROM voip_recording_transcripts WHERE external_id=?",[id]);}
export function transcriptDTO(id:string,canGenerate:boolean,sourceFile?:string):VoipRecordingTranscript{
  const job=transcriptJob(id),stale=!!job&&sourceFile!==undefined&&job.source_file!==sourceFile;
  const result=!stale&&job?.result_json?JSON.parse(job.result_json):{};
  return {state:(job?.state??"not_started") as VoipRecordingTranscript["state"],phase:(job?.phase??null) as VoipRecordingTranscript["phase"],
    error:job?.error??null,model:null,durationSeconds:null,audioSeparation:null,notice:null,speakers:[],segments:[],text:null,
    completedAt:stale?null:job?.completed_at??null,...result,canGenerate,
     ...callSummaryDTO(id,job?.source_file??"",stale?null:result.text??null),
    ...(stale?{state:"failed" as const,phase:null,error:"فایل ضبط این تماس تغییر کرده است؛ تبدیل تازه‌ای درخواست کنید."}:{})};
}
export function queueTranscript(id:string,file:string,from:string,to:string,userId:number,regenerate=false){
  const existing=transcriptJob(id);
  if(existing&&existing.source_file===file&&(["queued","processing"].includes(existing.state)||(existing.state==="completed"&&!regenerate)))return;
  if(existing&&existing.source_file!==file&&["queued","processing"].includes(existing.state))
    throw new TranscriptionError("پردازش نسخهٔ قبلی فایل هنوز پایان نیافته است؛ کمی بعد دوباره تلاش کنید.");
  if(!speechConfigured())throw new TranscriptionError("کلید سرویس تبدیل گفتار روی سرور تنظیم نشده است.");
  const pending=queryRow<{n:number}>("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE state IN ('queued','processing')")!.n;
  if(pending>=10)throw new TranscriptionError("صف تبدیل گفتار پر است؛ پس از پایان پردازش‌های جاری دوباره تلاش کنید.");
  const mine=queryRow<{n:number}>("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE requested_by=? AND state IN ('queued','processing')",[userId])!.n;
  if(mine>=2)throw new TranscriptionError("دو تبدیلِ شما در انتظار پردازش است؛ ابتدا منتظر پایان آن‌ها بمانید.");
  const now=new Date().toISOString();
  executeChanges(`INSERT INTO voip_recording_transcripts(external_id,source_file,range_from,range_to,requested_by,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'queued',?,?) ON CONFLICT(external_id) DO UPDATE SET source_file=excluded.source_file,
    range_from=excluded.range_from,range_to=excluded.range_to,requested_by=excluded.requested_by,state='queued',
    phase=NULL,error=NULL,
    result_json=CASE WHEN source_file=excluded.source_file THEN result_json ELSE NULL END,
    completed_at=CASE WHEN source_file=excluded.source_file THEN completed_at ELSE NULL END,
    lease_until=NULL,updated_at=excluded.updated_at`,
    [id,file,from,to,userId,now,now]);
}
let busy=false;
export async function processTranscriptQueue(){
  if(busy)return;
  executeChanges(`UPDATE voip_recording_transcripts SET state='failed',phase=NULL,error=?,lease_until=NULL,updated_at=?
    WHERE state='processing' AND lease_until<?`,["پردازش قبلی قطع شده است؛ برای تلاش دوباره دکمهٔ تبدیل را بزنید.",new Date().toISOString(),new Date().toISOString()]);
  const job=queryRow<Job>("SELECT * FROM voip_recording_transcripts WHERE state='queued' ORDER BY created_at LIMIT 1");
  if(!job)return;
  busy=true;
  let temporary:string|undefined,heartbeat:NodeJS.Timeout|undefined;
  const setPhase=(phase:string)=>executeChanges("UPDATE voip_recording_transcripts SET phase=?,updated_at=? WHERE external_id=? AND state='processing'",
    [phase,new Date().toISOString(),job.external_id]);
  try{
    if(!executeChanges("UPDATE voip_recording_transcripts SET state='processing',phase='downloading',lease_until=?,updated_at=? WHERE external_id=? AND state='queued'",
      [new Date(Date.now()+90000).toISOString(),new Date().toISOString(),job.external_id]))return;
    heartbeat=setInterval(()=>{executeChanges("UPDATE voip_recording_transcripts SET lease_until=? WHERE external_id=? AND state='processing'",
      [new Date(Date.now()+90000).toISOString(),job.external_id]);},15000);heartbeat.unref();
    const actor=getAuthUserById(job.requested_by);
    if(!actor?.active || (actor.role!=="admin"&&(!actor.permissions.includes("calls.view")||!actor.permissions.includes("calls.create"))))
      throw new TranscriptionError("دسترسی درخواست‌کنندهٔ تبدیل تغییر کرده است.");
    const {row}=await authorizedVoipRecording(job.external_id,{from:job.range_from,to:job.range_to},actor);
    if(row.record!==job.source_file)throw new TranscriptionError("فایل ضبط این تماس تغییر کرده است؛ درخواست تازه‌ای ثبت کنید.");
    const response=await getSimotelAudio(job.source_file);
    temporary=await fs.mkdtemp(path.join(os.tmpdir(),"crm-transcript-"));
    const source=path.join(temporary,"source"+path.extname(job.source_file).toLowerCase());
    let size=0;
    const bound=new Transform({transform(chunk,_encoding,callback){
      size+=chunk.length;callback(size>100*1024*1024?new TranscriptionError("فایل ضبط‌شده بیش از حد بزرگ است."):null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body as never),bound,createWriteStream(source,{mode:0o600}));
    const result=await transcribeRecording(source,temporary,setPhase);
    const now=new Date().toISOString();
    executeChanges("UPDATE voip_recording_transcripts SET state='completed',phase=NULL,error=NULL,result_json=?,completed_at=?,updated_at=?,lease_until=NULL WHERE external_id=?",
      [JSON.stringify(result),now,now,job.external_id]);
     // Summary failure must never turn a successful transcription into failure.
     try { queueCallSummary(job.external_id,job.requested_by,job.range_from,job.range_to); }
     catch { logger.warn("Unable to queue call summary; transcript remains available"); }
  }catch(error){
    const message=error instanceof TranscriptionError||error instanceof SimotelError?error.message:"تبدیل گفتار انجام نشد؛ دوباره تلاش کنید.";
    executeChanges("UPDATE voip_recording_transcripts SET state='failed',phase=NULL,error=?,updated_at=?,lease_until=NULL WHERE external_id=?",
      [message,new Date().toISOString(),job.external_id]);
  }finally{
    if(heartbeat)clearInterval(heartbeat);
    if(temporary)await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});
    busy=false;
  }
}
export function startTranscriptWorker(){
  ensureTranscriptSchema();
  const failed=(error:unknown)=>logger.error({errorType:error instanceof Error?error.name:"unknown"},"Recording transcription queue failed");
  void processTranscriptQueue().catch(failed);
   void processCallSummaryQueue().catch(failed);
  setInterval(()=>{void processTranscriptQueue().catch(failed);},2000).unref();
   setInterval(()=>{void processCallSummaryQueue().catch(failed);},2000).unref();
}
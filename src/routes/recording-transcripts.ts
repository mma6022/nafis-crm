import {Router,type IRouter} from "express";
import {CreateVoipRecordingTranscriptBody,CreateVoipRecordingSummaryBody,UpdateVoipRecordingSummaryBody,GetVoipRecordingTranscriptResponse} from "@workspace/api-zod";
import {requirePermission} from "../lib/access-control";
import type {AuthUser} from "../lib/auth";
import {authorizedVoipRecording} from "./simotel-recordings";
import {SimotelError} from "../lib/simotel";
import {TranscriptionError} from "../lib/recording-transcription";
import {ensureTranscriptSchema,queueTranscript,transcriptDTO} from "../lib/recording-transcript-jobs";
import {queueCallSummary} from "../lib/recording-summary-jobs";
import {appendSummaryEdit,SummaryEditConflict} from "../lib/recording-summary-edits";

const router:IRouter=Router();ensureTranscriptSchema();
const canGenerate=(user:AuthUser)=>user.role==="admin"||user.permissions.includes("calls.create");
function fail(res:import("express").Response,error:unknown){
  res.status(error instanceof SummaryEditConflict?409:error instanceof SimotelError?error.status:error instanceof TranscriptionError?422:503)
    .json({error:error instanceof SummaryEditConflict||error instanceof SimotelError||error instanceof TranscriptionError?error.message:"دریافت متن مکالمه ناموفق بود؛ دوباره تلاش کنید."});
}
router.patch("/voip/recordings/:id/transcript/summary",requirePermission("calls.view"),requirePermission("calls.create"),async(req,res)=>{
  res.setHeader("Cache-Control","private, no-store");
  const parsed=UpdateVoipRecordingSummaryBody.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:"موضوع یا خلاصهٔ تماس معتبر نیست."});return;}
  try{
    const actor=res.locals.authUser as AuthUser,id=String(req.params.id),body=parsed.data;
    const {row}=await authorizedVoipRecording(id,body,actor);
    const current=transcriptDTO(id,true,row.record);
    if(current.state!=="completed"||current.summarySourceHash!==body.sourceHash)throw new SummaryEditConflict("متن مکالمه تغییر کرده است؛ ویرایش ذخیره نشد. نسخهٔ تازه را بررسی کنید.");
    appendSummaryEdit(id,body.sourceHash,actor.id,body.expectedRevision,body.callSubject,body.customerRequestSummary);
    res.json(GetVoipRecordingTranscriptResponse.parse(transcriptDTO(id,true,row.record)));
  }catch(error){fail(res,error);}
});
router.get("/voip/recordings/:id/transcript",requirePermission("calls.view"),async(req,res)=>{
  res.setHeader("Cache-Control","private, no-store");
  try{
    const actor=res.locals.authUser as AuthUser;
    if(typeof req.query.from!=="string"||typeof req.query.to!=="string")throw new SimotelError("invalid_range",400,"بازهٔ گزارش تماس را مشخص کنید.");
    const id=String(req.params.id);
    const {row}=await authorizedVoipRecording(id,req.query,actor);
    res.json(GetVoipRecordingTranscriptResponse.parse(transcriptDTO(id,canGenerate(actor),row.record)));
  }catch(error){fail(res,error);}
});
router.post("/voip/recordings/:id/transcript",requirePermission("calls.view"),requirePermission("calls.create"),async(req,res)=>{
  res.setHeader("Cache-Control","private, no-store");
  const parsed=CreateVoipRecordingTranscriptBody.safeParse(req.body);
  if(!parsed.success||Object.keys(req.body).some(x=>!["from","to","regenerate"].includes(x))){res.status(400).json({error:"بازهٔ گزارش تماس معتبر نیست."});return;}
  try{
    const actor=res.locals.authUser as AuthUser,id=String(req.params.id);
    const {row,from,to}=await authorizedVoipRecording(id,parsed.data,actor);
    queueTranscript(id,row.record!,from,to,actor.id,parsed.data.regenerate);
    res.json(GetVoipRecordingTranscriptResponse.parse(transcriptDTO(id,canGenerate(actor),row.record)));
  }catch(error){fail(res,error);}
});
router.post("/voip/recordings/:id/transcript/summary",requirePermission("calls.view"),requirePermission("calls.create"),async(req,res)=>{
  res.setHeader("Cache-Control","private, no-store");
  const parsed=CreateVoipRecordingSummaryBody.safeParse(req.body);
  if(!parsed.success||Object.keys(req.body).some(x=>!["from","to"].includes(x))){res.status(400).json({error:"بازهٔ گزارش تماس معتبر نیست."});return;}
  try{
    const actor=res.locals.authUser as AuthUser,id=String(req.params.id);
    const {row,from,to}=await authorizedVoipRecording(id,parsed.data,actor);
    const current=transcriptDTO(id,true,row.record);
    if(current.state!=="completed"||!current.text){res.status(422).json({error:"ابتدا متن کامل مکالمه باید آماده شود."});return;}
    queueCallSummary(id,actor.id,from,to,true);
    res.json(GetVoipRecordingTranscriptResponse.parse(transcriptDTO(id,true,row.record)));
  }catch(error){fail(res,error);}
});
export default router;
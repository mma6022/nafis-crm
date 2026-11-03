import {getAuthUserById}from"./auth";
import {queryRows,executeChanges}from"./crm-db";
import {queueTranscript}from"./recording-transcript-jobs";
import {callReportDay}from"./call-reports";
import {TranscriptionError}from"./recording-transcription";
import {ctFlag,CT_START_DELAY_SECONDS,SYSTEM_REQUESTER}from"./call-transcripts";
export async function queueAutomaticCallReports(){
  // call-transcripts (auto flag): wait until the recording is likely published, queue as the system requester.
  const auto=ctFlag("auto");
  const delay=auto?` AND julianday(ended_at)<=julianday('now','-${CT_START_DELAY_SECONDS} seconds')`:"";
  for(const e of queryRows<{id:number;external_id:string;recording_file:string;started_at:string;ended_at:string;expert_user_id:number}>(
    `SELECT id,COALESCE(recording_provider_id,external_id) external_id,recording_file,started_at,ended_at,expert_user_id FROM voip_after_call_events
      WHERE auto_capture=1 AND auto_queued=0 AND is_live=0 AND has_recording=1 AND recording_file IS NOT NULL
      AND expert_user_id IS NOT NULL AND COALESCE(recording_provider_id,external_id) NOT LIKE 'live-%'${delay} ORDER BY id LIMIT 20`)){
    const actor=getAuthUserById(e.expert_user_id);
    if(auto){
      try{
        queueTranscript(e.external_id,e.recording_file,callReportDay(e.started_at),callReportDay(e.ended_at),SYSTEM_REQUESTER);
        executeChanges("UPDATE voip_after_call_events SET auto_queued=1,capture_error=NULL WHERE id=?",[e.id]);
      }catch(error){
        executeChanges("UPDATE voip_after_call_events SET capture_error=? WHERE id=?",[error instanceof TranscriptionError?error.message:"آماده‌سازی متن خودکار انجام نشد.",e.id]);
      }
      continue;
    }
    if(!actor?.active || (actor.role!=="admin"&&(!actor.permissions.includes("calls.view")||!actor.permissions.includes("calls.create"))))continue;
    try{
      queueTranscript(e.external_id,e.recording_file,callReportDay(e.started_at),callReportDay(e.ended_at),actor.id);
      executeChanges("UPDATE voip_after_call_events SET auto_queued=1,capture_error=NULL WHERE id=?",[e.id]);
    }catch(error){
      executeChanges("UPDATE voip_after_call_events SET capture_error=? WHERE id=?",
        [error instanceof TranscriptionError?error.message:"آماده‌سازی متن خودکار انجام نشد.",e.id]);
    }
  }
}

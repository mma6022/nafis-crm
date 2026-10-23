import type { AuthUser } from "./auth";
import { queryRow, execute, executeChanges, runTransaction } from "./crm-db";
import { callHistoryScope } from "./call-history-scope";
import { canAccessAfterCallCustomer, canSeeAfterCall, ensureAfterCallSchema, eventFor, finishSavedLiveReport, type AfterCallEvent } from "./voip-after-call";
import { ensureTranscriptSchema, transcriptDTO } from "./recording-transcript-jobs";
import { storedCallSummary } from "./recording-summary-jobs";
import { notifyCallReport } from "./voip-call-notifications";
import { mobileCallDTO } from "./mobile-calls";

export class CallReportError extends Error { constructor(public status:number,message:string){super(message);} }
type ManualCall={id:number;customer_id:number;salesperson_id:number|null;salesperson_name:string|null;
  subject:string|null;customer_request:string|null;expert_notes:string|null;created_at:string;
  customer_name:string;customer_phone:string;customer_salesperson_name:string|null};
const manualSelect=`SELECT cl.*,cl.salesperson_name_snapshot salesperson_name,c.name customer_name,c.phone customer_phone,
  s.name customer_salesperson_name FROM call_logs cl JOIN customers c ON c.id=cl.customer_id
  LEFT JOIN salespersons s ON s.id=c.salesperson_id`;
export function callReportDay(value:string) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
  return ["year","month","day"].map(k=>parts.find(p=>p.type===k)!.value).join("-");
}
export function systemSummaryForCall(id:number) {
  const e=queryRow<{external_id:string}>("SELECT COALESCE(recording_provider_id,external_id) external_id FROM voip_after_call_events WHERE "+(id<0?"id=?":"call_log_id=?"),[Math.abs(id)]);
  return (e?storedCallSummary(e.external_id)?.customerRequestSummary:null)??null;
}
function checkedEvent(id:number,actor:AuthUser) {
  const e=eventFor(id);
  let visible=!!e&&canSeeAfterCall(e,actor);
  if(e && !visible && e.call_log_id!=null){
    const scope=callHistoryScope(actor);
    visible=!!queryRow(`${manualSelect} WHERE cl.id=?${scope.sql?` AND ${scope.sql}`:""}`,[e.call_log_id,...scope.params]);
  }
  if(!e || !visible || (e.mobile_device_id == null && e.completed_payload && JSON.parse(e.completed_payload).discardHistory)) {
    throw new CallReportError(404,"گزارش تماس در دسترس شما نیست.");
  }
  return e;
}
function authorizedManual(id:number,actor:AuthUser) {
  const scope=callHistoryScope(actor);
  const row=queryRow<ManualCall>(`${manualSelect} WHERE cl.id=?${scope.sql?` AND ${scope.sql}`:""}`,[id,...scope.params]);
  if(!row)throw new CallReportError(404,"گزارش تماس در دسترس شما نیست.");
  return row;
}
function eventSubject(e:AfterCallEvent) {
  if(e.report_saved_at || e.auto_capture || e.live_cuid)return e.report_subject;
  return e.call_log_id?queryRow<{subject:string|null}>("SELECT subject FROM call_logs WHERE id=?",[e.call_log_id])?.subject??null:null;
}
export function eventCallReport(id:number,actor:AuthUser) {
  ensureAfterCallSchema();
  const e=checkedEvent(id,actor), accessible=canAccessAfterCallCustomer(e,actor);
  const subject=eventSubject(e);
  const legacyRequest=e.call_log_id?queryRow<{customer_request:string|null}>("SELECT customer_request FROM call_logs WHERE id=?",[e.call_log_id])?.customer_request??null:null;
  const summary=systemSummaryForCall(e.call_log_id??-e.id);
  ensureTranscriptSchema();
  // A provisional live identifier must never be sent to a recording API.
  const providerId=e.recording_provider_id??e.external_id;
  const finished=!e.is_live && !providerId.startsWith("live-");
  const sourceReady=finished && !!e.has_recording;
  const transcript=finished?transcriptDTO(providerId,actor.role==="admin"||actor.permissions.includes("calls.create"),e.recording_file??undefined):null;
  const call={
    id:e.call_log_id??-e.id,customerId:accessible?e.actual_customer_id:null,
    customerName:accessible && e.customer_name?e.customer_name:e.contact_name || "مخاطب تماس",customerPhone:e.phone,
    customerSalespersonName:accessible && e.customer_owner!=null?queryRow<{name:string}>("SELECT name FROM salespersons WHERE id=?",[e.customer_owner])?.name??null:null,
    salespersonId:e.salesperson_id,salespersonName:e.expert_name,extension:e.extension,
    subject,expertNotes:e.expert_notes,customerRequest:legacyRequest,systemSummary:summary,createdAt:e.started_at,
  };
  return {...(e.mobile_device_id != null ? { mobile: mobileCallDTO(e, actor) } : {}),id:call.id,eventId:e.id,call,revision:e.report_revision,isLive:!!e.is_live,status:e.status,
    subject,expertNotes:e.expert_notes,systemSummary:summary,transcript,
    externalId:sourceReady?providerId:null,recordingFrom:sourceReady?callReportDay(e.started_at):null,
    recordingTo:sourceReady?callReportDay(e.ended_at):null,
    canEdit:actor.role==="admin"||actor.permissions.includes("calls.create"),automaticError:e.capture_error};
}
export function callReport(id:number,actor:AuthUser) {
  if(id<0)return eventCallReport(-id,actor);
  ensureAfterCallSchema();
  const e=queryRow<{id:number}>("SELECT id FROM voip_after_call_events WHERE call_log_id=?",[id]);
  if(e)return eventCallReport(e.id,actor);
  const row=authorizedManual(id,actor);
  const revision=queryRow<{revision:number}>("SELECT MAX(revision) revision FROM call_report_edits WHERE call_log_id=?",[id])?.revision??0;
  const call={id:row.id,customerId:row.customer_id,salespersonId:row.salesperson_id,salespersonName:row.salesperson_name,
    subject:row.subject,customerRequest:row.customer_request,expertNotes:row.expert_notes,createdAt:row.created_at,
    customerName:row.customer_name,customerPhone:row.customer_phone,customerSalespersonName:row.customer_salesperson_name,
    extension:null,systemSummary:null};
  return {id,eventId:null,call,revision,isLive:false,status:"ثبت دستی",subject:row.subject,
    expertNotes:row.expert_notes??"",systemSummary:null,transcript:null,
    externalId:null,recordingFrom:null,recordingTo:null,
    canEdit:actor.role==="admin"||actor.permissions.includes("calls.create"),automaticError:null};
}
export function saveCallReport(id:number,byEvent:boolean,actor:AuthUser,body:{subject:string|null;expertNotes:string;expectedRevision:number}) {
  runTransaction(()=>{
    const report=byEvent?eventCallReport(id,actor):callReport(id,actor);
    if(!report.canEdit)throw new CallReportError(403,"اجازهٔ ویرایش گزارش تماس را ندارید.");
    if(report.revision!==body.expectedRevision)throw new CallReportError(409,"گزارش توسط شخص یا پنجرهٔ دیگری تغییر کرده است؛ نوشتهٔ شما حفظ شد. ابتدا نسخهٔ تازه را بررسی کنید.");
    const revision=report.revision+1,now=new Date().toISOString(),subject=body.subject?.trim()||null;
    // Preserve the original call time and expert attribution, including admin edits.
    if(report.id>0)executeChanges("UPDATE call_logs SET subject=?,expert_notes=? WHERE id=?",[subject,body.expertNotes,report.id]);
    if(report.eventId!=null){
      executeChanges(`UPDATE voip_after_call_events SET report_subject=?,expert_notes=?,report_revision=?,report_saved_at=?,report_edited_by=? WHERE id=?`,
        [subject,body.expertNotes,revision,now,actor.id,report.eventId]);
      finishSavedLiveReport(report.eventId);
    }
    execute("INSERT INTO call_report_edits(call_log_id,event_id,revision,subject,expert_notes,edited_by,edited_at) VALUES(?,?,?,?,?,?,?)",
      [report.id>0?report.id:null,report.eventId,revision,subject,body.expertNotes,actor.id,now]);
  });
  const result=byEvent?eventCallReport(id,actor):callReport(id,actor);
  notifyCallReport(result.call.salespersonId==null?null:eventFor(result.eventId??0)?.expert_user_id??null);
  return result;
}

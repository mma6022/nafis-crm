import { Router, type IRouter } from "express";
import { callNoteError } from "../lib/call-note-rule";
import { CompleteVoipAfterCallBody, CompleteVoipAfterCallParams, ListPendingVoipAfterCallsResponse } from "@workspace/api-zod";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { executeChanges, runTransaction, queryRow } from "../lib/crm-db";
import { subscribeCallReports, notifyCallReport } from "../lib/voip-call-notifications";
import { afterCallState, canSeeAfterCall, canAccessAfterCallCustomer, ensureAfterCallSchema, eventFor, pendingAfterCalls } from "../lib/voip-after-call";
import { storedCallSummary } from "../lib/recording-summary-jobs";

const router: IRouter = Router();
const reportDay = (value: string) => {
  const parts = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
  return ["year","month","day"].map(k=>parts.find(p=>p.type===k)!.value).join("-");
};
ensureAfterCallSchema();
router.get("/voip/after-call/stream",requirePermission("calls.view"),(req,res)=>{
  const actor=res.locals.authUser as AuthUser;
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();
  res.write("data: {\"changed\":true}\n\n");
  const unsubscribe=subscribeCallReports(expert=>{if(actor.role==="admin" || expert==null || expert===actor.id)res.write("data: {\"changed\":true}\n\n");});
  const heartbeat=setInterval(()=>res.write(": heartbeat\n\n"),15000);
  req.on("close",()=>{clearInterval(heartbeat);unsubscribe();});
});
router.get("/voip/after-call/pending", requirePermission("calls.view"), (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const actor = res.locals.authUser as AuthUser, state = afterCallState();
  const { rows, total } = pendingAfterCalls(actor);
  res.json(ListPendingVoipAfterCallsResponse.parse({
    items: rows.map(e => ({
      id: e.id, externalId: e.recording_provider_id??e.external_id, phone: e.phone, direction: e.direction, status: e.status,
      startedAt: e.started_at, endedAt: e.ended_at, extension: e.extension,
      expertUserId: e.expert_user_id, expertName: e.expert_name,
      customerId: canAccessAfterCallCustomer(e, actor) ? e.actual_customer_id : null,
      customerName: canAccessAfterCallCustomer(e, actor) ? e.customer_name : null,
      priority: canAccessAfterCallCustomer(e, actor) ? e.priority : null,
      callLogId: canAccessAfterCallCustomer(e, actor) ? e.call_log_id : null,
      expertNotes: e.expert_notes, hasRecording: !!e.has_recording,
      subject: e.report_saved_at || e.auto_capture || e.live_cuid ? e.report_subject : e.call_log_id?queryRow<{subject:string|null}>("SELECT subject FROM call_logs WHERE id=?",[e.call_log_id])?.subject??null:null,
      customerRequest: storedCallSummary(e.recording_provider_id??e.external_id)?.customerRequestSummary ?? null,
      isLive:!!e.is_live,
      systemSummary:storedCallSummary(e.recording_provider_id??e.external_id)?.customerRequestSummary??null,
      recordingFrom: reportDay(e.started_at), recordingTo: reportDay(e.ended_at),
    })),
    total, activatedAt: state.activated_at, lastCheckedAt: state.last_checked_at, syncError: state.sync_error,
    canComplete: actor.role === "admin" || actor.permissions.includes("calls.create"),
    canEditPriority: actor.role === "admin" || actor.permissions.includes("customers.update"),
    liveEventSeenAt:queryRow<{live_event_seen_at:string|null}>("SELECT live_event_seen_at FROM voip_call_reporting_state WHERE id=1")?.live_event_seen_at??null,
  }));
});
router.patch("/voip/after-call/:id", requirePermission("calls.view"), requirePermission("calls.create"), (req, res) => {
  const params = CompleteVoipAfterCallParams.safeParse(req.params), parsed = CompleteVoipAfterCallBody.safeParse(req.body);
  if (!params.success || !parsed.success || Object.keys(req.body).some(x => !["expertNotes", "priority", "subject", "customerRequest", "discardHistory"].includes(x))) {
    res.status(400).json({ error: "اطلاعات نتیجهٔ تماس معتبر نیست." }); return;
  }
  const actor = res.locals.authUser as AuthUser, body = parsed.data;
  if (body.discardHistory && (body.priority !== undefined || body.subject !== undefined || body.customerRequest !== undefined || body.expertNotes !== "")) {
    res.status(400).json({ error: "عدم ثبت در تاریخچه را نمی‌توان همراه با ویرایش نتیجه یا اولویت فرستاد." }); return;
  }
  // crm-call-note-min: completing «نتیجه تماس» needs a note (trimmed, >= 10); «عدم ثبت» stays note-less.
  const callNoteErr = body.discardHistory ? null : callNoteError(body.expertNotes);
  if (callNoteErr) { res.status(400).json({ error: callNoteErr }); return; }
  if (body.priority !== undefined && actor.role !== "admin" && !actor.permissions.includes("customers.update")) {
    res.status(403).json({ error: "اجازهٔ تغییر اولویت مشتری را ندارید." }); return;
  }
  const payload = body.discardHistory ? JSON.stringify({ discardHistory: true }) : JSON.stringify({ expertNotes: body.expertNotes, ...(body.priority !== undefined ? { priority: body.priority } : {}),
    ...(body.subject !== undefined ? {subject:body.subject} : {}), ...(body.customerRequest !== undefined ? {customerRequest:body.customerRequest} : {}) });
  let response: { ok: boolean; callLogId: number | null } | null = null;
  runTransaction(() => {
    const event = eventFor(params.data.id);
    if (!event || !canSeeAfterCall(event, actor)) { res.status(404).json({ error: "تماس در دسترس شما نیست." }); return; }
    if (event.completed_at) {
      if (event.completed_payload !== payload) { res.status(409).json({ error: "نتیجهٔ این تماس قبلاً ثبت شده است." }); return; }
      response = { ok: true, callLogId: event.call_log_id }; return;
    }
    if (body.discardHistory) {
      // Only a still-pending automatic entry can be removed. Keep the event as
      // an audited tombstone so polling cannot recreate the customer history.
      executeChanges("UPDATE voip_after_call_events SET call_log_id=NULL,completed_at=?,completed_by_user_id=?,completed_payload=? WHERE id=?",
        [new Date().toISOString(), actor.id, payload, event.id]);
      if (event.call_log_id != null) executeChanges("DELETE FROM call_logs WHERE id=?", [event.call_log_id]);
      response = { ok: true, callLogId: null }; return;
    }
    if (body.priority !== undefined && event.actual_customer_id == null) {
      res.status(422).json({ error: "برای این شماره مشتری شناسایی نشده است؛ اولویت قابل تغییر نیست." }); return;
    }
    if (body.priority !== undefined && !canAccessAfterCallCustomer(event, actor)) {
      res.status(403).json({ error: "اجازهٔ تغییر اولویت این مشتری را ندارید." }); return;
    }
    if (event.call_log_id != null) executeChanges("UPDATE call_logs SET expert_notes=?,subject=CASE WHEN ? THEN ? ELSE subject END,customer_request=CASE WHEN ? THEN ? ELSE customer_request END WHERE id=?",
      [body.expertNotes,body.subject!==undefined?1:0,body.subject??null,body.customerRequest!==undefined?1:0,body.customerRequest??null,event.call_log_id]);
    if (body.priority !== undefined) executeChanges("UPDATE customers SET priority=? WHERE id=?", [body.priority, event.actual_customer_id]);
    executeChanges(
      `UPDATE voip_after_call_events SET expert_notes=?,report_subject=CASE WHEN ? THEN ? ELSE report_subject END,
       report_saved_at=?,report_edited_by=?,report_revision=report_revision+1,completed_at=?,completed_by_user_id=?,completed_payload=? WHERE id=?`,
      [body.expertNotes,body.subject!==undefined?1:0,body.subject??null,new Date().toISOString(),actor.id,new Date().toISOString(),actor.id,payload,event.id],
    );
    response = { ok: true, callLogId: event.call_log_id };
  });
  if (response) {notifyCallReport(actor.id);res.json(response);}
});
export default router;
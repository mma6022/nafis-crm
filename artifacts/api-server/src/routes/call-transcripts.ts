/**
 * Call transcripts UI (Simotel part 3, design v1.1 scenes 18–26). Only while flag.call_transcripts.ui=1; else 404 call_transcripts_off.
 * Expert: own calls only (same rule as the after-call list). Manager = active admin except user 29 («احمد، مدیر فروش» report).
 * Review = mark + optional note; no score, no notification. On failure there is no manual summary.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRows } from "../lib/crm-db";
import { callView, ctAdminViewer, ctChatOn, ctFlag, ctSchemaReady, isCtManager, reportRows, rowView, saveReview, saveSpeakerRoles, tehranRange, visibleEvent, ctEvent } from "../lib/call-transcripts";
import { queueTranscript, transcriptDTO } from "../lib/recording-transcript-jobs";
import { queueSummaryAfterRoleSwap, storedCallSummary } from "../lib/recording-summary-jobs";
import { appendSummaryEdit, SummaryEditConflict } from "../lib/recording-summary-edits";
import { TranscriptionError } from "../lib/recording-transcription";
import { callReportDay } from "../lib/call-reports";
import { s132bReport, s132bReportOn } from "../lib/simotel132b";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const off = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (ctFlag("ui") && ctSchemaReady()) return false;
  res.status(404).json({ error: "call_transcripts_off", message: "صفحه‌ی متن و خلاصه‌ی تماس فعال نیست.", enabled: false }); return true;
};
const fail = (res: Response, status: number, error: string, message: string) => void res.status(status).json({ error, message });
const summary = (id: string) => storedCallSummary(id);
const eventOf = (req: Request, res: Response) => {
  const id = Number(req.params.eventId);
  const e = Number.isInteger(id) && id > 0 ? visibleEvent(id, me(res)) : null;
  if (!e) fail(res, 404, "not_found", "این تماس پیدا نشد یا در دسترس شما نیست.");
  return e;
};

router.get("/call-transcripts/config", (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const on = ctFlag("ui"); const u = me(res);
  // SIMOTEL-132 B: «گزارش کارشناسان» tab only for a viewer with flag.simotel132b (key absent otherwise → payload unchanged)
  res.json(on ? { enabled: true, manager: isCtManager(u), viewer: ctAdminViewer(u), ...(s132bReportOn(u, ctAdminViewer) ? { s132b: true } : {}), ...(ctChatOn(u) ? { chat: true } : {}) } : { enabled: false });
  // CT-CHAT: «chat» key only while flag.call_transcripts.chat(.user.<id>) is on → payload unchanged otherwise
});
router.get("/call-transcripts/b-report", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  const u = me(res);
  if (!s132bReportOn(u, ctAdminViewer)) return fail(res, 404, "simotel132b_off", "این گزارش برای شما فعال نیست.");
  const r = String(req.query.range ?? "today");
  res.json(s132bReport(r === "week" || r === "month" ? r : "today"));
});
/** CallHistory link map: call_log_id → event for one customer (only the actor's visible calls). */
router.get("/call-transcripts/customer/:customerId/calls", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  const cid = Number(req.params.customerId);
  if (!Number.isInteger(cid) || cid <= 0) return fail(res, 400, "bad_customer", "شناسه‌ی مشتری معتبر نیست.");
  const ids = queryRows<{ id: number }>(`SELECT e.id FROM voip_after_call_events e LEFT JOIN call_logs l ON l.id=e.call_log_id
    WHERE COALESCE(l.customer_id,e.customer_id)=? AND e.is_live=0 ORDER BY e.started_at DESC LIMIT 200`, [cid]);
  const out = ids.map(r => visibleEvent(r.id, me(res))).filter(Boolean).map(e => { const v = rowView(e!, summary);
    return { eventId: v.eventId, callLogId: v.callLogId, textState: v.textState, hasRecording: v.hasRecording }; });
  res.json({ calls: out });
});
router.get("/call-transcripts/calls/:eventId", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const e = eventOf(req, res); if (!e) return;
  res.json(callView(e, me(res), summary));
});
router.patch("/call-transcripts/calls/:eventId/summary", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const e = eventOf(req, res); if (!e) return;
  const u = me(res);
  if (e.expert_user_id !== u.id) return fail(res, 403, "expert_only", "فقط کارشناس همین تماس خلاصه را ویرایش می‌کند.");
  const b = req.body ?? {};
  const subject = typeof b.subject === "string" ? b.subject.trim() : "", request = typeof b.customerRequest === "string" ? b.customerRequest.trim() : "";
  if (!subject || subject.length > 160 || !request || request.length > 1200 || !Number.isInteger(b.revision) || typeof b.sourceHash !== "string")
    return fail(res, 400, "bad_summary", "موضوع (تا ۱۶۰ نویسه) و خلاصه‌ی درخواست (تا ۱۲۰۰ نویسه) لازم است.");
  const cur = transcriptDTO(e.provider_id, true, e.recording_file ?? undefined);
  if (cur.state !== "completed" || cur.summarySourceHash !== b.sourceHash) return fail(res, 409, "conflict", "متن مکالمه تغییر کرده است؛ ویرایش ذخیره نشد. نسخه‌ی تازه را ببینید.");
  try { appendSummaryEdit(e.provider_id, b.sourceHash, u.id, b.revision, subject, request); }
  catch (error) { if (error instanceof SummaryEditConflict) return fail(res, 409, "conflict", error.message); throw error; }
  res.json(callView(ctEvent(e.id)!, u, summary));
});
router.post("/call-transcripts/calls/:eventId/retranscribe", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const e = eventOf(req, res); if (!e) return;
  const u = me(res);
  if (!isCtManager(u)) return fail(res, 403, "manager_only", "تبدیل مجدد فقط برای مدیر فروش است.");
  if (!e.has_recording || !e.recording_file) return fail(res, 422, "no_recording", "این تماس فایل ضبط ندارد.");
  try { queueTranscript(e.provider_id, e.recording_file, callReportDay(e.started_at), callReportDay(e.ended_at), u.id, true); }
  catch (error) { if (error instanceof TranscriptionError) return fail(res, 422, "queue_refused", error.message); throw error; }
  res.json(callView(ctEvent(e.id)!, u, summary));
});
router.put("/call-transcripts/calls/:eventId/review", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const e = eventOf(req, res); if (!e) return;
  const u = me(res);
  if (!isCtManager(u)) return fail(res, 403, "manager_only", "بررسی تماس فقط برای مدیر فروش است.");
  const b = req.body ?? {};
  const note = b.note == null ? (e.r_note ?? "") : typeof b.note === "string" ? b.note.trim() : null;
  const flagged = b.flagged == null ? !!e.r_flagged : typeof b.flagged === "boolean" ? b.flagged : null;
  if (note == null || note.length > 1000 || flagged == null) return fail(res, 400, "bad_review", "علامت (بله/خیر) و یادداشت تا ۱۰۰۰ نویسه.");
  saveReview(e.id, u, flagged, note);
  res.json(callView(ctEvent(e.id)!, u, summary));
});
/** CT-CHAT (flag.call_transcripts.chat): «مدیر فروش» sets which of the two speakers is the expert; saved for everyone (roleSource=manual), audited. */
const ROLE_ERR: Record<string, [number, string]> = {
  not_completed: [422, "متن این تماس هنوز آماده نیست."],
  not_two_speakers: [422, "تعیین نقش فقط برای تماس دو گوینده‌ای است."],
  bad_speaker: [400, "گوینده‌ی انتخاب‌شده در این تماس نیست."],
  stale_transcript: [409, "متن تماس دوباره ساخته شده است؛ صفحه را تازه کنید."],
};
router.put("/call-transcripts/calls/:eventId/speaker-roles", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const u = me(res);
  if (!ctChatOn(u)) return fail(res, 404, "chat_off", "نمای گفت‌وگو برای شما فعال نیست.");
  const e = eventOf(req, res); if (!e) return;
  if (!isCtManager(u)) return fail(res, 403, "manager_only", "تعیین نقش گوینده‌ها فقط برای مدیر فروش است.");
  const b = req.body ?? {};
  if (typeof b.expertSpeakerId !== "string" || !b.expertSpeakerId || b.expertSpeakerId.length > 64 || (b.transcriptAt != null && typeof b.transcriptAt !== "string"))
    return fail(res, 400, "bad_roles", "گوینده‌ی کارشناس را انتخاب کنید.");
  const err = saveSpeakerRoles(e.id, u, b.expertSpeakerId, b.transcriptAt ?? null);
  if (err) return fail(res, ROLE_ERR[err][0], err, ROLE_ERR[err][1]);
  // Mohammad t851: regenerate the summary after a swap (existing queue, no notification); a failure here never undoes the save.
  if (!queueSummaryAfterRoleSwap(e.provider_id, u.id)) req.log?.warn?.({ eventId: e.id }, "ct-chat: summary regeneration not queued");
  res.json(callView(ctEvent(e.id)!, u, summary));
});
router.get("/call-transcripts/report", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const u = me(res);
  if (!ctAdminViewer(u)) return fail(res, 403, "manager_only", "گزارش مرکز تماس فقط برای مدیر فروش و مدیر سیستم است.");
  const mgr = isCtManager(u); // plain admin: read-only, no review flags (those belong to the sales manager's «بررسی»)
  const r = tehranRange(req.query.from, req.query.to, 93);
  if (!r) return fail(res, 400, "bad_range", "بازه‌ی تاریخ معتبر نیست (حداکثر ۹۳ روز).");
  const expert = req.query.expert == null || req.query.expert === "" ? null : Number(req.query.expert);
  if (expert != null && !Number.isInteger(expert)) return fail(res, 400, "bad_expert", "کارشناس معتبر نیست.");
  const cs = String(req.query.callStatus ?? "all"), ts = String(req.query.textStatus ?? "all");
  if (!["all", "answered", "missed"].includes(cs) || !["all", "completed", "pending", "failed", "no_recording", "pending_or_failed"].includes(ts)) return fail(res, 400, "bad_filter", "فیلتر معتبر نیست.");
  const out = reportRows({ ...r, expertUserIds: expert == null ? null : [expert], callStatus: cs, textStatus: ts, flagged: mgr && req.query.flagged === "1", page: Number(req.query.page ?? 1) || 1 });
  const experts = queryRows<{ id: number; name: string }>(`SELECT id,COALESCE(full_name,username) name FROM users WHERE active=1 AND id<>29
    AND id IN (SELECT DISTINCT expert_user_id FROM voip_after_call_events WHERE expert_user_id IS NOT NULL) ORDER BY id`);
  res.json({ from: r.from, to: r.to, total: out.total, page: out.page, pageSize: out.pageSize, experts, manager: mgr, rows: out.rows.map(e => mgr ? rowView(e, summary) : { ...rowView(e, summary), flagged: false }) });
});
export default router;

/**
 * Call transcripts UI (Simotel part 3, design v1.1 scenes 18–26). Only while flag.call_transcripts.ui=1; else 404 call_transcripts_off.
 * Expert: own calls only (same rule as the after-call list). Manager = active admin except user 29 («احمد، مدیر فروش» report).
 * Review = mark + optional note; no score, no notification. On failure there is no manual summary.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRows } from "../lib/crm-db";
import { callView, ctFlag, ctSchemaReady, isCtManager, reportRows, rowView, saveReview, tehranRange, visibleEvent, ctEvent } from "../lib/call-transcripts";
import { queueTranscript, transcriptDTO } from "../lib/recording-transcript-jobs";
import { storedCallSummary } from "../lib/recording-summary-jobs";
import { appendSummaryEdit, SummaryEditConflict } from "../lib/recording-summary-edits";
import { TranscriptionError } from "../lib/recording-transcription";
import { callReportDay } from "../lib/call-reports";

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
  res.json(on ? { enabled: true, manager: isCtManager(u) } : { enabled: false });
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
router.get("/call-transcripts/report", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const u = me(res);
  if (!isCtManager(u)) return fail(res, 403, "manager_only", "گزارش مرکز تماس فقط برای مدیر فروش است.");
  const r = tehranRange(req.query.from, req.query.to, 93);
  if (!r) return fail(res, 400, "bad_range", "بازه‌ی تاریخ معتبر نیست (حداکثر ۹۳ روز).");
  const expert = req.query.expert == null || req.query.expert === "" ? null : Number(req.query.expert);
  if (expert != null && !Number.isInteger(expert)) return fail(res, 400, "bad_expert", "کارشناس معتبر نیست.");
  const cs = String(req.query.callStatus ?? "all"), ts = String(req.query.textStatus ?? "all");
  if (!["all", "answered", "missed"].includes(cs) || !["all", "completed", "pending", "failed", "no_recording", "pending_or_failed"].includes(ts)) return fail(res, 400, "bad_filter", "فیلتر معتبر نیست.");
  const out = reportRows({ ...r, expertUserIds: expert == null ? null : [expert], callStatus: cs, textStatus: ts, flagged: req.query.flagged === "1", page: Number(req.query.page ?? 1) || 1 });
  const experts = queryRows<{ id: number; name: string }>(`SELECT id,COALESCE(full_name,username) name FROM users WHERE active=1 AND id<>29
    AND id IN (SELECT DISTINCT expert_user_id FROM voip_after_call_events WHERE expert_user_id IS NOT NULL) ORDER BY id`);
  res.json({ from: r.from, to: r.to, total: out.total, page: out.page, pageSize: out.pageSize, experts, rows: out.rows.map(e => rowView(e, summary)) });
});
export default router;

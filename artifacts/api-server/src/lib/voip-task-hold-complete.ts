/**
 * Existing-task completion for a successful vthSaveResult.
 *
 * Reuses the same server functions the current after-call UI already uses:
 *   entry=reminder → rvResult (POST /reminder-voip/:id/result)
 *   entry=carousel → fcExpertFollowup (POST /files-carousel/followup)
 *   entry=lead     → dpAfterFirstCallForm (the non-file s132 / first-call queue path)
 *
 * No duplicate completion rules live here. File / search entries return null so
 * vthSaveResult only saves the VoIP result and releases the hold. Cancel never
 * calls this module.
 */
import { queryRow } from "./crm-db";
import { rvResult } from "./reminder-voip";
import { fcExpertFollowup, fcIsErr } from "./files-carousel";
import { dpAfterFirstCallForm } from "./daily-plan";

type U = { id: number; role?: string | null; salespersonId?: number | null; customerScope?: string | null; name?: string | null };
type HoldLite = { entry: string | null; reminder_id: number | null } | null;
type CallLite = { id: number; customer_id: number; file_id: number | null; event_id?: number | null };

export function vthCallLogId(c: CallLite): number | null {
  try {
    const row = c.event_id != null
      ? queryRow<{ call_log_id: number | null }>("SELECT call_log_id FROM voip_after_call_events WHERE id=?", [c.event_id])
      : queryRow<{ call_log_id: number | null }>("SELECT call_log_id FROM voip_after_call_events e JOIN voip_click_calls k ON k.event_id=e.id WHERE k.id=?", [c.id]);
    return row?.call_log_id != null ? Number(row.call_log_id) : null;
  } catch { return null; }
}

/** Map a VTH result-form outcome onto the first-call form vocabulary dpAfterFirstCallForm already understands. */
function firstCallResult(outcome: string): string {
  return outcome === "follow_up" ? "callback" : outcome;
}

/**
 * Run the existing completion path for this hold, if any.
 * Returns an HTTP-shaped result when the existing function itself answers (reminder / carousel),
 * including errors — the caller must not mark the hold saved on status≥400.
 * Returns null when vthSaveResult should continue with its own result_saved_at + release
 * (lead after dpAfterFirstCallForm, or file/search, or a lead with no call log).
 */
export function vthCompleteExisting(
  u: U,
  hold: HoldLite,
  c: CallLite,
  outcome: string,
  note: string,
  now = new Date(),
): { status: number; body: any } | null {
  const entry = hold?.entry ?? null;
  if (entry === "reminder" || hold?.reminder_id != null) {
    const id = Number(hold?.reminder_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { status: 422, body: { error: "reminder_required", message: "این تماس به یک یادآور وصل نیست." } };
    }
    return rvResult(u, id, { outcome, note, callId: c.id }, now);
  }
  if (entry === "carousel") {
    const fileId = c.file_id != null ? Number(c.file_id) : NaN;
    if (!Number.isSafeInteger(fileId) || fileId <= 0) {
      return { status: 422, body: { error: "file_required", message: "این تماس به پرونده‌ای وصل نیست." } };
    }
    const r = fcExpertFollowup(u, { fileId, outcome, note, voipCallId: c.id }, now);
    if (fcIsErr(r)) return { status: r.status, body: { error: r.error, message: r.message, ...(r.details !== undefined ? { details: r.details } : {}) } };
    return { status: 200, body: { ok: true } };
  }
  if (entry === "lead") {
    const logId = vthCallLogId(c);
    // No call log → do not invent one; the VoIP result is still saved by the caller.
    if (logId != null && c.customer_id != null) {
      dpAfterFirstCallForm(u as any, Number(c.customer_id), logId, firstCallResult(outcome), now);
    }
    return null;
  }
  return null;
}

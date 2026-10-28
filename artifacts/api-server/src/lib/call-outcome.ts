import { crmDb } from "./crm-db";

/**
 * Release 81 «نتیجه‌ی تماس اجباری»: what the expert says happened on a manually logged call.
 * Stored on call_logs.call_result (Armita crm-call-result v1.0 field name; additive column; rows saved before release 81 stay NULL).
 * API body key: `call_result` (answered | no_answer | off_or_busy).
 * Automatic VoIP / mobile calls never need it: their answered state comes from the provider.
 */
export const MANUAL_OUTCOMES = ["answered", "no_answer", "off_or_busy"] as const;
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];
export const MANUAL_OUTCOME_LABELS: Record<ManualOutcome, string> = {
  answered: "جواب داد",
  no_answer: "جواب نداد",
  off_or_busy: "خاموش یا اشغال",
};
export const MANUAL_OUTCOME_REQUIRED_MESSAGE =
  "نتیجه‌ی تماس را انتخاب کن: «جواب داد»، «جواب نداد» یا «خاموش یا اشغال». اگر این گزینه را نمی‌بینی، صفحه را یک بار تازه کن.";

let ready = false;
export function ensureManualOutcomeSchema(): void {
  if (ready) return;
  const cols = crmDb.prepare("PRAGMA table_info(call_logs)").all() as unknown as { name: string }[];
  if (!cols.length) return; // call_logs not created yet; the next call adds the column
  if (!cols.some((c) => c.name === "call_result")) crmDb.exec("ALTER TABLE call_logs ADD COLUMN call_result TEXT");
  ready = true;
}
/** For read paths that must not migrate (reports on an older DB copy): true only when the column exists. */
let seen = false;
export function hasManualOutcomeColumn(): boolean {
  if (seen) return true;
  const cols = crmDb.prepare("PRAGMA table_info(call_logs)").all() as unknown as { name: string }[];
  seen = cols.some((c) => c.name === "call_result");
  return seen;
}
export function isManualOutcome(v: unknown): v is ManualOutcome {
  return typeof v === "string" && (MANUAL_OUTCOMES as readonly string[]).includes(v);
}
/** Reads `call_result` (or camelCase `callResult` when it is a top-level string) from a raw request body. missing = not sent / blank; invalid = an unknown value. */
export function readManualOutcome(body: unknown): { value: ManualOutcome } | { missing: true } | { invalid: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = b.call_result ?? (typeof b.callResult === "string" ? b.callResult : undefined);
  if (raw == null || (typeof raw === "string" && !raw.trim())) return { missing: true };
  const v = typeof raw === "string" ? raw.trim() : raw;
  return isManualOutcome(v) ? { value: v } : { invalid: String(raw).slice(0, 40) };
}
/** 422 payload shared by every manual call-log path. */
export function manualOutcomeError(kind: "missing" | "invalid") {
  return {
    error: kind === "missing" ? "call_result_required" : "call_result_invalid",
    field: "call_result",
    allowed: [...MANUAL_OUTCOMES],
    message: MANUAL_OUTCOME_REQUIRED_MESSAGE,
  };
}

/**
 * Release 81 (v1.0.1, PM): map the old «follow_up» call result to call_logs.follow_up_at — ADDITIVE ONLY.
 * Fills the new column from the follow-up reminder that call created (reminders.call_id, source 'followup'); never touches
 * call_logs.outcome, reminders, or any other column. Idempotent (only rows whose follow_up_at is still NULL). Returns rows filled.
 */
export function backfillFollowUpAt(): number {
  const cols = crmDb.prepare("PRAGMA table_info(call_logs)").all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === "follow_up_at") || !cols.some((c) => c.name === "outcome")) return 0;
  const rc = crmDb.prepare("PRAGMA table_info(reminders)").all() as unknown as { name: string }[];
  if (!rc.some((c) => c.name === "call_id") || !rc.some((c) => c.name === "source")) return 0;
  const sub = "SELECT r.remind_at FROM reminders r WHERE r.call_id=call_logs.id AND r.source='followup' ORDER BY r.id LIMIT 1";
  const r = crmDb.prepare(`UPDATE call_logs SET follow_up_at=(${sub}) WHERE outcome='follow_up' AND follow_up_at IS NULL AND EXISTS(${sub})`).run();
  return Number(r.changes ?? 0);
}

/**
 * Display label for multi-case surfaces only. The rest of the CRM keeps loan_plans.name.
 * A later override map, keyed by plan id, wins over bank_name. Never invent a bank.
 */
export const MULTI_CASE_PLAN_LABELS: Readonly<Record<number, string>> = {};

export const MULTI_CASE_PLAN_UNKNOWN = "لندتک / بانک نامشخص";

/**
 * A plan whose primary template cannot be submitted.
 * "show" (default) keeps the tile disabled with Armita's reason.
 * "hide" drops the tile. Switch this one constant; the server rule stays the same.
 */
export const MULTI_CASE_UNREADY_PLAN: "hide" | "show" = "show";
/** Default / plan 17 note (v1.2). Prefer `multiCaseUnreadyReason(planId)` for a tile or 422. */
export const MULTI_CASE_UNREADY_REASON = "فعلاً قابل انتخاب نیست؛ مبلغ وام در قرارداد این طرح مشخص نشده است.";
/** Per-plan one-line notes (spec v1.3). Used as the tile body and the `title` attribute. */
export const MULTI_CASE_UNREADY_REASONS: Readonly<Record<number, string>> = {
  1: "فعلاً قابل انتخاب نیست؛ قالب قرارداد این طرح هنوز آماده نشده است.",
  17: "فعلاً قابل انتخاب نیست؛ مبلغ وام در قرارداد این طرح مشخص نشده است.",
};
export function multiCaseUnreadyReason(planId?: number | null): string {
  const id = Number(planId);
  if (Number.isSafeInteger(id) && id > 0 && MULTI_CASE_UNREADY_REASONS[id]) return MULTI_CASE_UNREADY_REASONS[id];
  return MULTI_CASE_UNREADY_REASON;
}
export const MULTI_CASE_POPULAR_HEADING = "پراستفاده‌ترین طرح‌های ۳۰ روز گذشته";
export const MULTI_CASE_POPULAR_LINE = "پراستفاده در ۳۰ روز گذشته";

export function multiCasePlanLabel(plan: {
  id?: number | null;
  planId?: number | null;
  bankName?: string | null;
  bank_name?: string | null;
} | null | undefined): string {
  const id = Number(plan?.planId ?? plan?.id);
  if (Number.isSafeInteger(id) && id > 0 && MULTI_CASE_PLAN_LABELS[id]) return MULTI_CASE_PLAN_LABELS[id];
  const raw = String(plan?.bankName ?? plan?.bank_name ?? "").trim();
  if (!raw) return MULTI_CASE_PLAN_UNKNOWN;
  const banks = raw.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean).join("، ");
  return banks ? `لندتک / ${banks}` : MULTI_CASE_PLAN_UNKNOWN;
}

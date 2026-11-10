/**
 * Display label for multi-case surfaces only. The rest of the CRM keeps loan_plans.name.
 * A later override map, keyed by plan id, wins over bank_name. Never invent a bank.
 */
export const MULTI_CASE_PLAN_LABELS: Readonly<Record<number, string>> = {};

export const MULTI_CASE_PLAN_UNKNOWN = "لندتک / بانک نامشخص";

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

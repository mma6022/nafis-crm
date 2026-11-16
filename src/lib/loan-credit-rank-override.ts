import { normalizeOverrideReason } from "./credit-rank-override-reason";

/**
 * An explicit staff-only exception, never a customer-profile mutation.
 * crm-grade-followups: an enabled override must carry a reason (`creditRankOverrideReason`, ≥10 characters); the
 * caller logs the use (credit-rank-override-log). The override waives both the customer's and the guarantor's grade.
 */
export function loanCreditRankOverrideError(raw: unknown, role: string, query = false, reasonRaw?: unknown) {
  if (raw !== undefined && (query
    ? typeof raw !== "string" || !["true", "false"].includes(raw)
    : typeof raw !== "boolean")) return { status: 400, code: "invalid_ignore_credit_rank" };
  const enabled = query ? raw === "true" : raw === true;
  if (enabled && !["admin", "salesperson"].includes(role)) return { status: 403, code: "action_forbidden" };
  if (enabled) {
    const reason = normalizeOverrideReason(reasonRaw);
    if ("error" in reason) return { status: 400, code: reason.error };
  }
  return null;
}

/** The validated reason of an enabled override (call after loanCreditRankOverrideError returned null). */
export function loanCreditRankOverrideReason(reasonRaw: unknown): string {
  const reason = normalizeOverrideReason(reasonRaw);
  if ("error" in reason) throw new Error(reason.error);
  return reason.reason;
}

export function loanRankOverrideSnapshot(condition: any, actorId: number, at: string, maximumAmount: string, reason?: string | null) {
  return {
    ...condition,
    max_principal: maximumAmount, // The already validated immutable full plan ceiling.
    credit_rank_ignored: true,
    credit_rank_override: {
      actorId, at,
      ...(reason ? { reason } : {}),
      originalMaximumAmount: condition.max_principal ?? null,
      originalCustomerRanks: condition.customer_ranks ?? null,
      originalGuarantorRanks: condition.guarantor_ranks ?? null,
    },
  };
}

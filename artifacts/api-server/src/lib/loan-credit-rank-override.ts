/** An explicit staff-only exception, never a customer-profile mutation. */
export function loanCreditRankOverrideError(raw: unknown, role: string, query = false) {
  if (raw !== undefined && (query
    ? typeof raw !== "string" || !["true", "false"].includes(raw)
    : typeof raw !== "boolean")) return { status: 400, code: "invalid_ignore_credit_rank" };
  const enabled = query ? raw === "true" : raw === true;
  if (enabled && !["admin", "salesperson"].includes(role)) return { status: 403, code: "action_forbidden" };
  return null;
}

export function loanRankOverrideSnapshot(condition: any, actorId: number, at: string, maximumAmount: string) {
  return {
    ...condition,
    max_principal: maximumAmount, // The already validated immutable full plan ceiling.
    credit_rank_ignored: true,
    credit_rank_override: {
      actorId, at,
      originalMaximumAmount: condition.max_principal ?? null,
      originalCustomerRanks: condition.customer_ranks ?? null,
    },
  };
}

/**
 * Legacy acknowledgement templates calculate payout as principal × payout% / 100.
 * That expression denotes the customer's payable amount, not the unadjusted base.
 * Use the settled integer amount, avoiding percent reconstruction and rounding.
 */
export function settledAcknowledgementPayout(formula: any, payout: string): string | null {
  const tokens = formula?.tokens;
  if (!Array.isArray(tokens) || tokens.length !== 5) return null;
  const fields = [tokens[0]?.field, tokens[2]?.field];
  if (tokens[0]?.type !== "field" || tokens[2]?.type !== "field" ||
      !fields.includes("loanPlan.principalAmount") || !fields.includes("loanPlan.customerPayoutPercent") ||
      tokens[1]?.type !== "operator" || tokens[1]?.value !== "*" ||
      tokens[3]?.type !== "operator" || tokens[3]?.value !== "/" ||
      tokens[4]?.type !== "literal" || String(tokens[4]?.value) !== "100") return null;
  if (!/^\d{1,18}$/.test(payout)) throw new Error("template_payout_invalid");
  return payout;
}

/** GET /customers?search=… purposes allowed while a daily plan is active (t985). */
export const DP_SEARCH_PURPOSES = new Set(["incoming_call", "loan_request"]);

export function dpSearchPurposeAllowed(purpose: unknown): boolean {
  return DP_SEARCH_PURPOSES.has(String(purpose ?? ""));
}

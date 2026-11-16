import { gradeMatches } from "./credit-subgrades";

/**
 * Verified credit grade (e.g. "B2") against a plan condition's permitted grades. Matching is exact by sub-grade;
 * a bare letter in the rule (old plans, historical condition snapshots) still means all three of its sub-grades.
 */
export function conditionAcceptsCreditRank(value: unknown, storedRanks: unknown[]): boolean {
  if (!storedRanks.length) return true;
  return gradeMatches(value, storedRanks);
}

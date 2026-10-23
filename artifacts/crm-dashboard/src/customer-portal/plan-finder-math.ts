import type { PublicLoanPlanDetails } from '@workspace/api-client-react';
import { calculatorCeiling, calculatorDurations, customerPayout, monthlyPmt, parseCalculatorAmount, planAnnualInterest } from './plan-calculator-values.ts';

/** Plan-finder card math, built only on the existing calculator helpers (PlanCalculator). */
export type PlanFinderCalc = {
  durations: number[];
  principal: (months: number) => number | null;
  payout: (months: number) => number | null;
  installment: (months: number) => number | null;
  /** Default installment count: the duration with the highest received amount (customer payout). */
  best: number | null;
};

export function planFinderCalc(plan: PublicLoanPlanDetails, customerMaximumAmount?: unknown): PlanFinderCalc {
  const durations = calculatorDurations(plan);
  const customerMax = parseCalculatorAmount(customerMaximumAmount);
  // Principal for a duration: the plan's own ceiling for that duration, capped by the customer's maximum when the server sends one.
  const principal = (n: number) => { const c = calculatorCeiling(plan, n); return c != null && customerMax != null ? Math.min(c, customerMax) : c ?? customerMax; };
  const payout = (n: number) => { const p = principal(n); return p == null ? null : customerPayout(plan, p, n); };
  const installment = (n: number) => { const p = principal(n); const r = planAnnualInterest(plan, n); return p == null || r == null ? null : monthlyPmt(p, r, n); };
  return { durations, principal, payout, installment, best: bestPayoutDuration(durations, payout) };
}

/** Highest payout wins; on a tie the shorter duration wins (durations are sorted ascending).
 *  If no duration has a computable payout, fall back to the first duration. */
export function bestPayoutDuration(durations: number[], payout: (months: number) => number | null): number | null {
  let best: number | null = null; let top = -1;
  for (const n of durations) { const v = payout(n); if (v != null && v > top) { top = v; best = n; } }
  return best ?? durations[0] ?? null;
}

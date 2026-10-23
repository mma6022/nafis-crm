import type { PublicLoanPlanDetails } from '@workspace/api-client-react';
import type { LoanOption } from './api';
import { displayPlanTerms, durationPercent } from './plan-display-values.ts';

export function parseCalculatorAmount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٬\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/** Standard PMT: monthly payments at the end of each period, no residual balance. */
export function monthlyPmt(principal: number, annualPercent: number, months: number): number | null {
  if (!Number.isSafeInteger(principal) || principal <= 0 ||
      !Number.isFinite(annualPercent) || annualPercent < 0 ||
      !Number.isInteger(months) || months <= 0 || months > 600) return null;
  const monthlyRate = annualPercent / 1200;
  const payment = monthlyRate === 0 ? principal / months
    : principal * monthlyRate / -Math.expm1(-months * Math.log1p(monthlyRate));
  return Number.isFinite(payment) && payment > 0 ? payment : null;
}

export function principalCeiling(plan: PublicLoanPlanDetails, conditionId?: number | null): number | null {
  const fallback = () => parseCalculatorAmount(plan.principalAmount);
  if (conditionId != null) {
    const condition = plan.conditions?.find(c => c.id === conditionId);
    if (!condition) return null;
    return condition.maxPrincipal == null || condition.maxPrincipal === ''
      ? fallback() : parseCalculatorAmount(condition.maxPrincipal);
  }
  if (!plan.conditions?.length) return fallback();
  const ceilings = plan.conditions.map(c => principalCeiling(plan, c.id));
  if (ceilings.some(v => v == null)) return null;
  return Math.max(...ceilings as number[]);
}

export function calculatorDurations(plan: PublicLoanPlanDetails, conditionId?: number | null): number[] {
  const terms = displayPlanTerms(plan).map(t => t.installments);
  const conditions = conditionId == null ? plan.conditions : plan.conditions?.filter(c => c.id === conditionId);
  const configured = conditions?.flatMap(c => c.installmentOptions?.map(Number) ?? []) ?? [];
  const values = configured.length ? configured : terms;
  return [...new Set(values)].filter(n => Number.isInteger(n) && n > 0 && n <= 600).sort((a, b) => a - b);
}

/** A global plan ceiling must not be combined with another condition's duration. */
export function calculatorCeiling(plan: PublicLoanPlanDetails, months: number, conditionId?: number | null): number | null {
  if (conditionId != null || !plan.conditions?.length) return principalCeiling(plan, conditionId);
  const matching = plan.conditions.filter(c => calculatorDurations(plan, c.id).includes(months));
  if (!matching.length) return null;
  const ceilings = matching.map(c => principalCeiling(plan, c.id));
  if (ceilings.some(v => v == null)) return null;
  return Math.max(...ceilings as number[]);
}

/** The plan's depositPercent is the customer cash-payout percentage, not a deposit fee. */
export function customerPayout(plan: PublicLoanPlanDetails, principal: number, months: number): number | null {
  if (!Number.isSafeInteger(principal) || principal <= 0) return null;
  const term = displayPlanTerms(plan).find(t => t.installments === months);
  if (term?.depositPercent == null) return null;
  return Math.round(principal * term.depositPercent / 100);
}

export function maximumCustomerPayout(plan: PublicLoanPlanDetails, eligiblePlan?: LoanOption): number | null {
  if (eligiblePlan) {
    const durations = cashCalculatorBounds(plan, 0, eligiblePlan).durations;
    if (!durations.length) return null;
    const payouts = durations.map(months => {
      const ceiling = cashCalculatorBounds(plan, months, eligiblePlan).maximumPrincipal;
      return ceiling == null ? null : customerPayout(plan, ceiling, months);
    });
    return payouts.some(v => v == null) ? null : Math.max(...payouts as number[]);
  }
  const contexts = plan.conditions?.length ? plan.conditions.map(c => c.id) : [null];
  const payouts: number[] = [];
  for (const conditionId of contexts) {
    const ceiling = principalCeiling(plan, conditionId);
    const durations = calculatorDurations(plan, conditionId);
    if (ceiling == null || !durations.length) return null;
    for (const months of durations) {
      const payout = customerPayout(plan, ceiling, months);
      if (payout == null) return null;
      payouts.push(payout);
    }
  }
  return payouts.length ? Math.max(...payouts) : null;
}

export function planAnnualInterest(plan: PublicLoanPlanDetails, months: number): number | null {
  return durationPercent(plan.annualInterest, months);
}

export function planPayoutPercent(plan: PublicLoanPlanDetails, months: number): number | null {
  return displayPlanTerms(plan).find(t => t.installments === months)?.depositPercent ?? null;
}

export function millionCashSliderRange(minimum: number | null, maximum: number | null) {
  if (minimum == null || maximum == null || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))
    return { minimum: null, maximum: null };
  const low = Math.max(1_000_000, Math.ceil(minimum / 1_000_000) * 1_000_000);
  const high = Math.floor(maximum / 1_000_000) * 1_000_000;
  return high >= low ? { minimum: low, maximum: high } : { minimum: null, maximum: null };
}

/** Private loan options, when supplied, take precedence over public advertised caps. */
export function cashCalculatorBounds(plan: PublicLoanPlanDetails, months: number, eligiblePlan?: LoanOption) {
  const durations = eligiblePlan
    ? [...new Set(eligiblePlan.conditions?.length
      ? eligiblePlan.conditions.flatMap(c => c.allowedDurations ?? [])
      : eligiblePlan.allowedDurations ?? [])].filter(n => Number.isInteger(n) && n > 0 && n <= 600).sort((a, b) => a - b)
    : calculatorDurations(plan);
  const selectedMonth = months === 0 ? durations[0] : months;
  if (!durations.includes(selectedMonth)) return { durations, minimumPrincipal: 1, maximumPrincipal: null };
  if (!eligiblePlan) return { durations, minimumPrincipal: 1, maximumPrincipal: calculatorCeiling(plan, selectedMonth) };
  const matching = eligiblePlan.conditions?.length
    ? eligiblePlan.conditions.filter(c => c.allowedDurations?.includes(selectedMonth))
    : [eligiblePlan];
  if (!matching?.length) return { durations, minimumPrincipal: 1, maximumPrincipal: null };
  const caps = matching.map(c => parseCalculatorAmount(c.maximumAmount));
  const minima = matching.map(c => c.minimumAmount == null || String(c.minimumAmount) === '0'
    ? 1 : parseCalculatorAmount(c.minimumAmount));
  if (caps.some(v => v == null) || minima.some(v => v == null)) {
    return { durations, minimumPrincipal: 1, maximumPrincipal: null };
  }
  return { durations, minimumPrincipal: Math.min(...minima as number[]), maximumPrincipal: Math.max(...caps as number[]) };
}

/** Invert the cash percentage without changing the original-principal PMT basis. */
export function principalFromCustomerPayout(plan: PublicLoanPlanDetails, cashAmount: number, months: number,
  maximumPrincipal: number, minimumPrincipal = 1): number | null {
  const percent = planPayoutPercent(plan, months);
  if (percent == null || percent <= 0 || !Number.isSafeInteger(cashAmount) || cashAmount <= 0 ||
    !Number.isSafeInteger(maximumPrincipal) || !Number.isSafeInteger(minimumPrincipal) ||
    minimumPrincipal < 1 || maximumPrincipal < minimumPrincipal ||
    cashAmount > Math.round(maximumPrincipal * percent / 100) ||
    cashAmount < Math.round(minimumPrincipal * percent / 100)) return null;
  const principal = Math.max(minimumPrincipal, Math.min(maximumPrincipal, Math.round(cashAmount * 100 / percent)));
  return Number.isSafeInteger(principal) && customerPayout(plan, principal, months) === cashAmount ? principal : null;
}

/** Select the actual server-authorized option without exposing technical condition selectors. */
export function eligibleConditionId(plan: LoanOption | undefined, amount: string, months: number): number | null {
  const principal = parseCalculatorAmount(amount);
  if (!plan || principal == null || !Number.isInteger(months) || months <= 0) return null;
  const options = plan.conditions?.length ? plan.conditions : plan.conditionId ? [{ ...plan, id: plan.conditionId }] : [];
  return options.find(c => c.allowedDurations?.includes(months) &&
    (c.minimumAmount == null || principal >= Number(c.minimumAmount)) &&
    (c.maximumAmount == null || principal <= Number(c.maximumAmount)))?.id ?? null;
}

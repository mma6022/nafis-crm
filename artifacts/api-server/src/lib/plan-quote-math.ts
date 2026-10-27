/**
 * Server-side copy of the customer-portal plan calculator math (moved from crm-dashboard/src/customer-portal
 * plan-display-values.ts, plan-calculator-values.ts and plan-finder-math.ts, logic unchanged). Rates, principal
 * ceilings and payout percentages stay on the server; the portal only receives payout + installment (public quote).
 */
type Percent = string | number | null | undefined;
type PlanTerm = { installments: string | number; prepaymentPercent?: Percent; deductionPercent?: Percent; depositPercent?: Percent };
type PlanCondition = { id: number; maxPrincipal?: string | number | null; installmentOptions?: Array<string | number> | null };
type PublicLoanPlanDetails = {
  principalAmount?: string | number | null; annualInterest?: Percent; installments?: string | null;
  installmentTerms?: PlanTerm[] | null; depositPercents?: Percent; prepaymentPercents?: Percent; deductPercents?: Percent;
  conditions?: PlanCondition[] | null;
};
type OptionCondition = { id: number; allowedDurations?: number[] | null; minimumAmount?: string | null; maximumAmount?: string | null };
type LoanOption = Omit<OptionCondition, 'id'> & { conditionId?: number | null; conditions?: OptionCondition[] | null };


const digits = (value: string) => value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

export function planDurations(value: string | null | undefined): number[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(digits(value)); } catch { parsed = digits(value); }
  return [...new Set((Array.isArray(parsed) ? parsed : [parsed]).map(Number)
    .filter(n => Number.isInteger(n) && n > 0 && n <= 600))].sort((a, b) => a - b);
}

export function durationPercent(value: string | number | null | undefined, duration: number): number | null {
  if (value == null || String(value).trim() === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(digits(value)); } catch { parsed = digits(value).trim(); }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed = (parsed as Record<string, unknown>)[String(duration)];
  }
  if ((typeof parsed !== 'string' && typeof parsed !== 'number') || String(parsed).trim() === '') return null;
  const n = Number(parsed);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function displayPlanTerms(plan: PublicLoanPlanDetails) {
  if (plan.installmentTerms?.length) return plan.installmentTerms.map(term => ({
    installments: Number(term.installments),
    prepaymentPercent: durationPercent(term.prepaymentPercent, Number(term.installments)),
    deductionPercent: durationPercent(term.deductionPercent, Number(term.installments)),
    depositPercent: durationPercent(term.depositPercent, Number(term.installments)),
  }));
  return planDurations(plan.installments).map(installments => ({
    installments,
    prepaymentPercent: durationPercent(plan.prepaymentPercents, installments),
    deductionPercent: durationPercent(plan.deductPercents, installments),
    depositPercent: durationPercent(plan.depositPercents, installments),
  }));
}


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

/* ---------- server quote API (new): mirrors the PlanCalculator / PlanFinder / PlanCarousel / useInstallment state ---------- */
const wholeToman = (v: number | null): number | null => v == null || !Number.isFinite(v) ? null : Math.round(v);

/** Per-term public money facts: payout and installment at the plan's own ceiling (same as the plan finder without a customer cap). */
export function publicPlanTerms(plan: PublicLoanPlanDetails): Array<{ installments: number; payout: number | null; installment: number | null }> {
  const calc = planFinderCalc(plan);
  // Same term list the portal showed before (the plan's configured terms), money computed at the plan ceiling.
  const months = [...new Set(displayPlanTerms(plan).map(t => t.installments))].filter(n => Number.isInteger(n) && n > 0);
  return months.map(n => ({ installments: n, payout: wholeToman(calc.payout(n)), installment: wholeToman(calc.installment(n)) }));
}

/** Plan-finder card values for one match (customerMaximumAmount stays on the server). */
export function finderQuote(plan: PublicLoanPlanDetails, customerMaximumAmount?: unknown) {
  const calc = planFinderCalc(plan, customerMaximumAmount);
  return {
    best: calc.best,
    terms: calc.durations.map(n => ({ installments: n, payout: wholeToman(calc.payout(n)), installment: wholeToman(calc.installment(n)) })),
  };
}

export type CalculatorQuote = {
  months: number; durations: number[]; minPayout: number | null; maxPayout: number | null;
  payout: number | null; installment: number | null; principal: number | null; problem: string;
};

/** Exactly the PlanCalculator component state for (months, cash), optionally with the customer's eligible option and saved principal. */
export function calculatorQuote(p: PublicLoanPlanDetails, input: { months?: number | null; cash?: number | null; amount?: number | null }, eligiblePlan?: LoanOption): CalculatorQuote {
  const duration = input.months ?? 0;
  const first = cashCalculatorBounds(p, Number(duration) || 0, eligiblePlan);
  const durations = first.durations;
  const typed = Number(duration);
  const months = durations.includes(typed) ? typed : (durations[0] ?? 0);
  const bounds = months > 0 ? cashCalculatorBounds(p, months, eligiblePlan) : null;
  const percent = months > 0 ? planPayoutPercent(p, months) : null;
  const rate = months > 0 ? planAnnualInterest(p, months) : null;
  const minP = bounds?.minimumPrincipal ?? 1;
  const maxP = bounds?.maximumPrincipal ?? null;
  const zero = percent === 0;
  const cashCeiling = maxP != null && percent != null && !zero ? customerPayout(p, maxP, months) : null;
  const minCashRaw = percent != null && !zero ? customerPayout(p, minP, months) : null;
  const { minimum: minCash, maximum: maxCash } = millionCashSliderRange(minCashRaw, cashCeiling);
  const rangeOk = maxCash != null && minCash != null && maxCash >= minCash;
  const savedPrincipal = input.amount ?? null;
  const savedCash = savedPrincipal != null ? customerPayout(p, savedPrincipal, months) : null;
  const cashNow = rangeOk ? Math.min(maxCash!, Math.max(minCash!, input.cash ?? savedCash ?? maxCash!)) : null;
  const principal = cashNow != null && maxP != null ? principalFromCustomerPayout(p, cashNow, months, maxP, minP) : null;
  let problem = '';
  if (!durations.length) problem = 'durations';
  else if (percent == null) problem = 'payout-percent';
  else if (zero) problem = 'zero-payout';
  else if (maxP == null) problem = 'ceiling';
  else if (!rangeOk) problem = 'range';
  else if (rate == null) problem = 'rate';
  else if (principal == null) problem = 'principal';
  const pmt = !problem && principal != null && rate != null ? monthlyPmt(principal, rate, months) : null;
  if (!problem && pmt == null) problem = 'pmt';
  return { months, durations, minPayout: rangeOk ? minCash : null, maxPayout: rangeOk ? maxCash : null,
    payout: cashNow, installment: wholeToman(pmt), principal, problem };
}

/** Installment of an existing application on today's plan (was useInstallment in the browser). */
export function applicationInstallment(plan: PublicLoanPlanDetails | null | undefined, principal: number, months: number): number | null {
  if (!plan || !months || !Number.isSafeInteger(principal)) return null;
  const rate = planAnnualInterest(plan, months);
  return rate == null ? null : wholeToman(monthlyPmt(principal, rate, months));
}

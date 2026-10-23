/**
 * Loan plans published by the CRM at /data/loan-plans.json (refreshed by the CRM on the server).
 * Shape inspected from the live file (15 plans, Oct 2026). Unknown enum values are tolerated
 * (catch → 'other') so a new CRM value never blanks the site.
 */
// Hand-written validation (no zod) keeps the client islands small — this module ships to the browser.

export const LOAN_PLANS_URL = '/data/loan-plans.json';

export interface InstallmentTerm {
  installments: number; // months
  prepaymentPercent: number; // پیش‌پرداخت ٪ of principal
  deductionPercent: number; // کسر ٪
  depositPercent: number; // مبلغ واریزی به مشتری ٪ of principal
}

export interface LoanPlan {
  id: number;
  name: string;
  principalAmount: number; // تومان
  annualInterest: number; // ٪ per year
  installments: string; // CSV of month options, e.g. "12,18,24"
  loanType: 'goods' | 'score' | (string & {}); // کالایی | امتیازی
  processMode: 'both' | 'in_person' | 'online' | (string & {});
  grantDays: 'under_7' | '10_to_15' | (string & {});
  bankName: string;
  platformName: string;
  installmentTerms: InstallmentTerm[];
}

const isNum = (v: unknown, min = -Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min;
const isStr = (v: unknown): v is string => typeof v === 'string';

function parseTerm(t: unknown): InstallmentTerm | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  if (!isNum(o.installments, 1) || !Number.isInteger(o.installments)) return null;
  if (!isNum(o.prepaymentPercent, 0) || !isNum(o.deductionPercent, 0) || !isNum(o.depositPercent, 0)) return null;
  return {
    installments: o.installments,
    prepaymentPercent: o.prepaymentPercent,
    deductionPercent: o.deductionPercent,
    depositPercent: o.depositPercent,
  };
}

/** Returns a clean plan or null. Unknown enum strings are tolerated so a new CRM value never blanks the site. */
export function parseLoanPlan(p: unknown): LoanPlan | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (!isNum(o.id) || !Number.isInteger(o.id) || !isStr(o.name)) return null;
  if (!isNum(o.principalAmount, 0) || !isNum(o.annualInterest, 0)) return null;
  const strs = ['installments', 'loanType', 'processMode', 'grantDays', 'bankName', 'platformName'] as const;
  if (!strs.every((k) => isStr(o[k]))) return null;
  if (!Array.isArray(o.installmentTerms)) return null;
  const terms = o.installmentTerms.map(parseTerm);
  if (!terms.length || terms.some((t) => t === null)) return null;
  return {
    id: o.id,
    name: o.name,
    principalAmount: o.principalAmount,
    annualInterest: o.annualInterest,
    installments: o.installments as string,
    loanType: o.loanType as string,
    processMode: o.processMode as string,
    grantDays: o.grantDays as string,
    bankName: o.bankName as string,
    platformName: o.platformName as string,
    installmentTerms: terms as InstallmentTerm[],
  };
}

export const LOAN_TYPE_LABEL: Record<string, string> = { goods: 'وام کالایی', score: 'وام امتیازی' };
export const PROCESS_MODE_LABEL: Record<string, string> = {
  both: 'حضوری و غیرحضوری',
  in_person: 'حضوری',
  online: 'غیرحضوری',
};
export const GRANT_DAYS_LABEL: Record<string, string> = { under_7: 'کمتر از ۷ روز', '10_to_15': '۱۰ تا ۱۵ روز' };
export const label = (map: Record<string, string>, key: string) => map[key] ?? key;

/** Validate and drop individually-invalid plans instead of failing the whole list. */
export function parseLoanPlans(input: unknown): LoanPlan[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((p) => {
    const plan = parseLoanPlan(p);
    return plan ? [plan] : [];
  });
}

/** Runtime fetch (islands). Resolves to `fallback` on any network/parse failure. */
export async function fetchLoanPlans(fallback: LoanPlan[] = [], signal?: AbortSignal): Promise<LoanPlan[]> {
  try {
    const res = await fetch(LOAN_PLANS_URL, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(String(res.status));
    const plans = parseLoanPlans(await res.json());
    return plans.length ? plans : fallback;
  } catch {
    return fallback;
  }
}

/** Standard amortised monthly installment (same formula as the current live site). */
export function monthlyInstallment(principal: number, annualInterestPercent: number, months: number): number {
  const r = annualInterestPercent / 100 / 12;
  if (months <= 0) return 0;
  if (r === 0) return principal / months;
  const f = (1 + r) ** months;
  return (principal * r * f) / (f - 1);
}

export function planQuote(plan: LoanPlan, months: number) {
  const term = plan.installmentTerms.find((t) => t.installments === months) ?? plan.installmentTerms[0]!;
  return {
    term,
    months: term.installments,
    monthly: Math.round(monthlyInstallment(plan.principalAmount, plan.annualInterest, term.installments)),
    deposit: Math.round(plan.principalAmount * (term.depositPercent / 100)),
    prepayment: Math.round(plan.principalAmount * (term.prepaymentPercent / 100)),
  };
}

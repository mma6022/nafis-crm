import type { PublicLoanPlanDetails } from '@workspace/api-client-react';

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

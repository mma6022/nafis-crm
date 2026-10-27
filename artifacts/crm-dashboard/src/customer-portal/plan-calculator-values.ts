import type { LoanOption } from './api';

/* Browser-safe helpers only. Plan rates, principal ceilings and payout percentages stay on the server
   (api-server/src/lib/plan-quote-math.ts); the portal gets payout + installment from the quote endpoints. */

export function parseCalculatorAmount(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٬\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
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

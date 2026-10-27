/**
 * FAQ text from live data (PM 2026-10-28): fact tokens ({planCount} … {minAmount} {maxAmount} {amountRange}) are filled
 * from the SAME plan data the cards use. Mohammad 2026-10-28: FAQs never state a rate, percentage, principal or other
 * calculation, so there are no rate tokens any more; amounts are مبلغ واریزی (payout) only.
 */
import type { LoanPlan } from './loan-plans';
import { fillFacts, planFacts } from './plans';

export interface FaqIn {
  q: string;
  a: string;
}
export interface FaqOut {
  q: string;
  a: string;
}

export function fillFaq(items: FaqIn[], plans: LoanPlan[]): FaqOut[] {
  const facts = planFacts(plans);
  return items.map((i) => ({ q: fillFacts(i.q, facts), a: fillFacts(i.a, facts) }));
}

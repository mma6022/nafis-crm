/**
 * FAQ text from live data (PM 2026-10-28): fact tokens ({planCount} … {minAmount} {maxAmount}) and rate tokens
 * ({rateMain} {rateLow} {rateLowCount} {rateLowNames}) are filled from the SAME plan data the cards use
 * (rate = CRM annual_interest, lib/rates.ts). An answer with a rate token is fail-closed: when faqRates() is null
 * (any active rate unknown/stale, not exactly 2 values …) the item's `aNoRate` (default: the approved B2 no-number
 * answer) is used instead. Numeric answers carry `fb` + `exp` so the browser swaps to the fallback from the first
 * day a rate goes stale (scripts/rate-expiry.ts) — the visible FAQ and the FAQPage JSON-LD always say the same.
 */
import type { LoanPlan } from './loan-plans';
import { fillFacts, planFacts } from './plans';
import { RATE_FAQ_FALLBACK, countWord, earliestHideOn, faqRates, ratePct, tehranToday } from './rates';

export interface FaqIn {
  q: string;
  a: string;
  aNoRate?: string;
}
export interface FaqOut {
  q: string;
  a: string;
  /** fallback answer (no number) for the browser expiry check */
  fb?: string;
  /** Tehran day (YYYY-MM-DD) from which `fb` must be shown */
  exp?: string;
}
const RATE_TOKEN = /\{(?:rateMain|rateLow|rateLowCount|rateLowNames)\}/;
export const hasRateToken = (s: string) => RATE_TOKEN.test(s);

export function fillFaq(items: FaqIn[], plans: LoanPlan[], today = tehranToday()): FaqOut[] {
  const facts = planFacts(plans);
  const fr = faqRates(plans, today);
  const exp = earliestHideOn(plans) ?? undefined;
  return items.map((i) => {
    const q = fillFacts(i.q, facts);
    if (!hasRateToken(i.a)) return { q, a: fillFacts(i.a, facts) };
    const fb = fillFacts(i.aNoRate ?? RATE_FAQ_FALLBACK, facts);
    if (!fr) return { q, a: fb };
    const a = fillFacts(i.a, facts)
      .replace(/\{rateMain\}/g, ratePct(fr.main))
      .replace(/\{rateLowCount\}/g, countWord(fr.lowN))
      .replace(/\{rateLowNames\}/g, fr.lowNames)
      .replace(/\{rateLow\}/g, ratePct(fr.low));
    return { q, a, fb, ...(exp ? { exp } : {}) };
  });
}

/**
 * PLANS-49 (PM 2026-10-28): a condition (مسیر) may only narrow the plan's installment terms. An installment option the
 * plan has no term for has no payout or instalment, so it is ignored everywhere (calculator, quotes, portal selection,
 * eligibility) and the admin save rejects it. Existing rows that still hold such an option are kept as they are; the
 * plan editor flags them (Mohammad decides the data).
 */

const months = (value: unknown): number | null => {
  const n = typeof value === "object" && value !== null ? Number((value as { installments?: unknown }).installments) : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 600 ? n : null;
};

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
};

/** Installment counts of a plan's terms (array or JSON text; items are numbers or {installments}). */
export function planTermMonths(terms: unknown): number[] {
  return [...new Set(asArray(terms).map(months).filter((n): n is number => n != null))];
}

/** A condition's options (array or JSON text) as valid month counts, in the stored order, without duplicates. */
export function conditionOptionMonths(options: unknown): number[] {
  return [...new Set(asArray(options).map(months).filter((n): n is number => n != null))];
}

/**
 * Durations a condition really offers: no options = every plan term; otherwise only the options the plan has a term for.
 * All options invalid → [] (the condition offers nothing; it never falls back to the plan terms).
 */
export function conditionDurations(options: unknown, planTerms: unknown): number[] {
  const terms = planTermMonths(planTerms);
  const configured = conditionOptionMonths(options);
  return configured.length ? configured.filter(n => terms.includes(n)) : terms;
}

/** Options of a condition that the plan has no term for (empty = valid). */
export function invalidConditionOptions(options: unknown, planTerms: unknown): number[] {
  const terms = planTermMonths(planTerms);
  return conditionOptionMonths(options).filter(n => !terms.includes(n));
}

const faDigits = (n: number) => String(n).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

/** Persian admin error for a condition whose options are not all plan terms; null when every condition is valid. */
export function conditionOptionsError(conditions: { installmentOptions?: unknown }[], planTerms: unknown): string | null {
  const terms = planTermMonths(planTerms).sort((a, b) => a - b);
  for (const [index, condition] of conditions.entries()) {
    const bad = invalidConditionOptions(condition.installmentOptions, planTerms);
    if (!bad.length) continue;
    const allowed = terms.length ? terms.map(n => `${faDigits(n)} ماهه`).join("، ") : "هیچ قسطی (اول اقساط طرح را تعریف کنید)";
    return `مسیر ${faDigits(index + 1)}: اقساط ${bad.map(n => `${faDigits(n)} ماهه`).join("، ")} در اقساط این طرح تعریف نشده است. اقساط مجاز این مسیر فقط از اقساط طرح انتخاب می‌شود: ${allowed}.`;
  }
  return null;
}

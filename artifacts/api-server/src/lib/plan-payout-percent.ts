/**
 * «درصد واریز به مشتری» for a contract's installment count (template variable `loanPlan.depositPercents`).
 *
 * Two sources exist on a loan plan (or on an application's plan snapshot):
 * - newer: `installment_terms` — the plan editor's per-installment-option list
 *   (`[{ installments, depositPercent, ... }]`, LoanPlans.tsx installmentTerms);
 * - legacy: `deposit_percents` — a `{ "<months>": "<percent>" }` map (or, very old, one plain number for every count).
 * The newer editor data wins when both have a value for the month count; a mismatch is reported as a conflict.
 * When neither source has a valid value the result is EMPTY plus a Persian warning — never raw JSON or text.
 */
export const PAYOUT_PERCENT_MISSING_FA = "درصد واریز برای این تعداد اقساط در طرح ثبت نشده";
export const PAYOUT_PERCENT_NO_MONTHS_FA = "تعداد اقساط قرارداد مشخص نیست؛ درصد واریز به مشتری قابل تعیین نیست";

export type PayoutPercentConflict = { months: number; newer: string; legacy: string };
export type PayoutPercentResult = {
  value: string;
  source: "newer" | "legacy" | null;
  months: number | null;
  warning: string | null;
  conflict: PayoutPercentConflict | null;
  malformed: string[];
};

const faDigits = "۰۱۲۳۴۵۶۷۸۹", arDigits = "٠١٢٣٤٥٦٧٨٩";
const latin = (v: string) => v.replace(/[۰-۹]/g, (d) => String(faDigits.indexOf(d))).replace(/[٠-٩]/g, (d) => String(arDigits.indexOf(d))).replace(/٫/g, ".");
const faNum = (n: number) => n.toLocaleString("fa-IR", { useGrouping: false });

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = latin(value).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
/** A percent is a plain non-negative number ≤ 100 (Persian/Arabic digits accepted); anything else is malformed. */
export function normalizePercent(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = latin(String(value)).trim().replace(/[%٪]$/, "").trim();
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? String(n) : null;
}
const positiveInt = (value: unknown): number | null => {
  const n = Number(typeof value === "string" ? latin(value).trim() : value);
  return Number.isSafeInteger(n) && n > 0 && n <= 600 ? n : null;
};

type Source = { byMonths: Map<number, string>; all: string | null; offered: number[] };
function newerSource(plan: Record<string, unknown>, malformed: string[]): Source {
  const out: Source = { byMonths: new Map(), all: null, offered: [] };
  const raw = plan.installment_terms ?? plan.installmentTerms;
  if (raw == null || raw === "") return out;
  const terms = parsedJson(raw);
  if (!Array.isArray(terms)) { malformed.push("installment_terms"); return out; }
  for (const term of terms) {
    if (!term || typeof term !== "object") { malformed.push("installment_terms"); continue; }
    const t = term as Record<string, unknown>;
    const months = positiveInt(t.installments);
    if (months == null) { malformed.push("installment_terms"); continue; }
    out.offered.push(months);
    if (t.depositPercent == null || t.depositPercent === "") continue;
    const pct = normalizePercent(t.depositPercent);
    if (pct == null) { malformed.push(`installment_terms[${months}]`); continue; }
    out.byMonths.set(months, pct);
  }
  return out;
}
function legacySource(plan: Record<string, unknown>, malformed: string[]): Source {
  const out: Source = { byMonths: new Map(), all: null, offered: [] };
  const raw = plan.deposit_percents ?? plan.depositPercents;
  if (raw == null || raw === "") return out;
  const value = parsedJson(raw);
  if (value == null) return out;
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const months = positiveInt(key);
      if (months == null) { malformed.push("deposit_percents"); continue; }
      if (item == null || String(item).trim() === "") continue;
      const pct = normalizePercent(item);
      if (pct == null) { malformed.push(`deposit_percents[${months}]`); continue; }
      out.byMonths.set(months, pct); out.offered.push(months);
    }
    return out;
  }
  const scalar = normalizePercent(value); // very old plans: one number for every installment count
  if (scalar == null) malformed.push("deposit_percents"); else out.all = scalar;
  return out;
}
const at = (s: Source, months: number) => s.byMonths.get(months) ?? s.all;

export function resolvePlanPayoutPercent(plan: Record<string, unknown>, durationMonths?: number | null): PayoutPercentResult {
  const malformed: string[] = [];
  const newer = newerSource(plan, malformed);
  const legacy = legacySource(plan, malformed);
  let months = positiveInt(durationMonths ?? plan._approved_duration_months);
  if (months == null) {
    // No contract month count (e.g. a standalone contract): only unambiguous when the plan offers exactly one count.
    const offered = [...new Set(newer.offered.length ? newer.offered : legacy.offered)];
    if (offered.length === 1) months = offered[0];
    else if (!offered.length && legacy.all != null) return { value: legacy.all, source: "legacy", months: null, warning: null, conflict: null, malformed };
    else return { value: "", source: null, months: null, warning: PAYOUT_PERCENT_NO_MONTHS_FA, conflict: null, malformed };
  }
  const n = at(newer, months), l = at(legacy, months);
  const conflict = n != null && l != null && Number(n) !== Number(l) ? { months, newer: n, legacy: l } : null;
  if (n != null) return { value: n, source: "newer", months, warning: null, conflict, malformed };
  if (l != null) return { value: l, source: "legacy", months, warning: null, conflict: null, malformed };
  return { value: "", source: null, months, warning: `${PAYOUT_PERCENT_MISSING_FA} (${faNum(months)} قسط)`, conflict: null, malformed };
}

/** Thrown when a formula needs the percent but it is missing; carries the Persian warning for staff. */
export class PlanPayoutPercentMissingError extends Error {
  constructor(public readonly warning: string) { super("plan_payout_percent_missing"); }
}

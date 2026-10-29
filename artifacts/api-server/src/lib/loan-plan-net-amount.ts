const invalid = (): never => { throw new Error("invalid_deduction_percent"); };
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return invalid(); }
}

/**
 * T664 (Mohammad, t687s2662): files whose frozen snapshot has an empty
 * deduct_percents (new plan form, plans 19+) keep their old 46.5% deduction only
 * for these three plan-19 files; every other such file uses the plan's CURRENT
 * installment_terms row for its duration at the moment net is computed (before
 * the wallet is charged). Charged/completed files are never recomputed.
 */
export const T664_PINNED_DEDUCTION: Readonly<Record<string, string>> = Object.freeze({ "35": "46.5", "37": "46.5", "55": "46.5" });

function isEmptyDeduction(raw: unknown): boolean {
  if (raw == null) return true;
  if (typeof raw === "string") return raw.trim() === "" || raw.trim() === "{}";
  return typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0;
}

/** Exactly one row for the duration ⇒ its percent; none ⇒ 0; more than one ⇒ invalid. */
function termsPercent(termsValue: unknown, duration: string): unknown {
  if (termsValue == null || termsValue === "") return "0";
  const terms = parse(termsValue);
  if (!Array.isArray(terms)) return invalid();
  const matches = terms.filter(term => term && typeof term === "object" && String(term.installments) === duration);
  if (matches.length > 1) return invalid();
  return matches.length === 1 ? (matches[0].deductionPercent ?? "0") : "0";
}

/**
 * Legacy plans with a deduct_percents map/scalar resolve only the application's
 * frozen terms (unchanged). When the frozen deduct_percents is empty, the
 * caller passes the plan's current installment_terms (`currentPlanTerms`);
 * without it the frozen installment_terms row is used.
 */
export function loanPlanNetAmount(application: {
  id?: unknown; approved_amount?: unknown; requested_amount?: unknown;
  duration_months?: unknown; plan_snapshot_json?: unknown;
}, currentPlanTerms?: unknown): string {
  const amount = String(application.approved_amount ?? application.requested_amount ?? "");
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw new Error("invalid_financial_value");
  const snapshot = parse(application.plan_snapshot_json ?? "{}") as Record<string, unknown> | null;
  const duration = String(application.duration_months);
  const raw = snapshot?.deduct_percents;
  if (isEmptyDeduction(raw)) {
    const pinned = application.id == null ? undefined : T664_PINNED_DEDUCTION[String(application.id)];
    if (pinned != null) return applyPercent(amount, pinned);
    return applyPercent(amount, termsPercent(currentPlanTerms !== undefined ? currentPlanTerms : snapshot?.installment_terms, duration));
  }
  let percent: unknown = raw;
  const values = typeof raw === "string" && raw.trim().startsWith("{") ? parse(raw) : raw;
  const durationMap = values && typeof values === "object" && !Array.isArray(values)
    ? values as Record<string, unknown> : null;
  if (durationMap) percent = durationMap[duration];
  // Preserve scalar values and existing duration entries. Only a missing
  // duration in an otherwise configured map may use the frozen installment row.
  if (durationMap && !Object.prototype.hasOwnProperty.call(durationMap, duration)) {
    const termsValue = snapshot?.installment_terms;
    if (termsValue == null || termsValue === "") return invalid();
    const terms = parse(termsValue);
    if (!Array.isArray(terms)) return invalid();
    const matches = terms.filter(term => term && typeof term === "object" &&
      String(term.installments) === duration);
    if (matches.length !== 1) return invalid();
    percent = matches[0].deductionPercent;
  }
  return applyPercent(amount, percent);
}

function applyPercent(amount: string, percent: unknown): string {
  if (percent == null || !/^\d+(?:\.\d{1,2})?$/.test(String(percent))) return invalid();
  const [whole, fraction = ""] = String(percent).split(".");
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (hundredths > 10000n) return invalid();
  return (BigInt(amount) * (10000n - hundredths) / 10000n).toString();
}

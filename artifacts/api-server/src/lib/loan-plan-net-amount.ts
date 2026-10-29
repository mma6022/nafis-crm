const invalid = (): never => { throw new Error("invalid_deduction_percent"); };
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return invalid(); }
}

/** Resolve only the application's frozen terms, never today's editable plan. */
export function loanPlanNetAmount(application: {
  approved_amount?: unknown; requested_amount?: unknown;
  duration_months?: unknown; plan_snapshot_json?: unknown;
}): string {
  const amount = String(application.approved_amount ?? application.requested_amount ?? "");
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw new Error("invalid_financial_value");
  const snapshot = parse(application.plan_snapshot_json ?? "{}") as Record<string, unknown> | null;
  const duration = String(application.duration_months);
  const raw = snapshot?.deduct_percents;
  // T664: the new plan form (plans 19+) freezes deduct_percents = NULL and keeps the
  // deduction only in installment_terms[].deductionPercent. NULL / empty ⇒ take the
  // frozen terms row for this duration (exactly one ⇒ its percent; none ⇒ 0; >1 ⇒ invalid).
  const empty = raw == null || (typeof raw === "string" && (raw.trim() === "" || raw.trim() === "{}"))
    || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0);
  if (empty) {
    const termsValue = snapshot?.installment_terms;
    let percent0: unknown = "0";
    if (!(termsValue == null || termsValue === "")) {
      const terms = parse(termsValue);
      if (!Array.isArray(terms)) return invalid();
      const matches = terms.filter(term => term && typeof term === "object" && String(term.installments) === duration);
      if (matches.length > 1) return invalid();
      if (matches.length === 1) percent0 = matches[0].deductionPercent ?? "0";
    }
    return applyPercent(amount, percent0);
  }
  let percent: unknown = raw;
  const values = typeof raw === "string" && raw.trim().startsWith("{") ? parse(raw) : raw;
  const durationMap = values && typeof values === "object" && !Array.isArray(values)
    ? values as Record<string, unknown> : null;
  if (durationMap) percent = durationMap[duration];
  // Preserve omitted deductions, scalar values, and existing duration entries.
  // Only a missing duration in an otherwise configured map may use the frozen
  // installment row. Never import today's plan or invent a zero percentage.
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

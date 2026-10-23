/** Parse literal toman amounts only; never turn a formula or prose into a ceiling. */
export function consultationAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\s*تومان\s*$/, "").trim();
  if (!/^[\d,\s٬،]+(?:\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized.replace(/[,\s٬،]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function consultationMaximumAmount(conditionLimit: string | null | undefined, planLimit: string | null | undefined): number | null {
  const condition = consultationAmount(conditionLimit);
  const plan = consultationAmount(planLimit);
  // A configured but malformed condition limit cannot fall back to the global ceiling.
  if (conditionLimit?.trim() && condition == null) return null;
  if (condition != null && plan != null) return Math.min(condition, plan);
  return condition ?? plan;
}

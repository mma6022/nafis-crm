function normalizeCreditRank(value: unknown): string {
  return String(value ?? "")
    .trim().toUpperCase()
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[\s\d]+$/g, "");
}

export function conditionAcceptsCreditRank(value: unknown, storedRanks: unknown[]): boolean {
  if (!storedRanks.length) return true;
  const rank = normalizeCreditRank(value);
  return Boolean(rank) && storedRanks.some(stored => normalizeCreditRank(stored) === rank);
}
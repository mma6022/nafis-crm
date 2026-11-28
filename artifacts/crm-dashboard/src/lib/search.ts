export function normalizePersianSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200d\u0640]/g, "") // ZWNJ, ZWJ, tatweel
    .replace(/\s+/g, " ")
    .trim();
}

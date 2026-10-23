export function normalizePersianSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک");
}

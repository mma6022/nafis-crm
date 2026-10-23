import { normalizeDigits } from "./ics24";

export function normalizeJalali(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = normalizeDigits(value).trim().replace(/[-.]/g, "/");
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalized);
  if (!match) throw new Error("Birth date must use YYYY/MM/DD Jalali format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const today = new Date();
  const formatter = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  });
  const currentYear = Number(
    formatter.formatToParts(today).find((part) => part.type === "year")?.value,
  );
  if (year < 1200 || year > currentYear || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("Birth date is invalid.");
  }
  const target = `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  const start = Date.UTC(year + 621, 1, 15);
  let valid = false;
  for (let offset = 0; offset < 410; offset += 1) {
    const candidate = new Date(start + offset * 86_400_000);
    const parts = formatter.formatToParts(candidate);
    const actual = `${parts.find((part) => part.type === "year")?.value}/${parts.find((part) => part.type === "month")?.value}/${parts.find((part) => part.type === "day")?.value}`;
    if (actual === target) {
      valid = candidate <= today;
      break;
    }
  }
  if (!valid) throw new Error("Birth date is invalid.");
  return `${match[1]}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

export function normalizePostal(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const digits = normalizeDigits(value).replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(digits)) throw new Error("Postal code must contain exactly 10 digits.");
  return digits;
}
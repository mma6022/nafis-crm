import { createHash } from "node:crypto";
export function normalizedDigits(value: unknown): string {
  return String(value ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).trim();
}
export function normalizeIban(value: unknown): string | null {
  const iban = normalizedDigits(value).replace(/\s/g, "").toUpperCase();
  if (!/^IR\d{24}$/.test(iban)) return null;
  const rotated = iban.slice(4) + "1827" + iban.slice(2, 4);
  let remainder = 0;
  for (const digit of rotated) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? iban : null;
}

// Request/response contracts: https://s.api.ir/swagger/v1/swagger.json,
// CardToIbanReq/Res, IbanMatchReq -> BooleanResultData, IbanInfoReq/Res.
const paths = { cardToIban: "/api/sw1/CardToIban", ibanMatch: "/api/sw1/IbanMatch", ibanInfo: "/api/sw1/IbanInfo" };
export function normalizeBankBirthDate(value: unknown): string | null {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalizedDigits(value).replace(/[-.]/g, "/"));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1200 || year > 1600 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Same actual-calendar validation used by CRM profile normalization.
  const formatter = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC",
  });
  const start = Date.UTC(year + 621, 1, 15);
  for (let offset = 0; offset < 410; offset++) {
    const candidate = new Date(start + offset * 86400000);
    if (candidate.getTime() > Date.now()) break;
    const parts = formatter.formatToParts(candidate);
    const part = (name: string) => Number(parts.find(p => p.type === name)?.value);
    if (part("year") === year && part("month") === month && part("day") === day) return `${year}/${month}/${day}`;
  }
  return null;
}
async function call(operation: keyof typeof paths, input: Record<string, string>): Promise<any> {
  const body = JSON.stringify(input);
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  // Banking SAPI is reachable directly from Turkey, independently of other relayed services.
  const token = process.env.SAPI_API_TOKEN;
  if (!token) throw new Error("bank_verification_unavailable");
  const target = new URL(paths[operation], process.env.SAPI_API_BASE_URL || "https://s.api.ir");
  if (target.username || target.password || target.protocol !== "https:") throw new Error("bank_verification_unavailable");
  headers.Authorization = `Bearer ${token}`;
  const response = await fetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!response.ok) throw new Error("bank_verification_unavailable");
  const result = await response.json() as any;
  if (result?.success !== true) throw new Error("bank_verification_unavailable");
  return result;
}
export async function lookupBankAccount(ibanInput: unknown): Promise<{ iban: string; ownerName: string }> {
  const iban = normalizeIban(ibanInput);
  if (!iban) throw new Error("invalid_bank_account");
  const info = await call("ibanInfo", { iban });
  if (info.data?.active === false) throw new Error("bank_account_inactive");
  if (info.data?.active !== true || typeof info.data?.name !== "string" || !info.data.name.trim()
    || info.data.name.trim().length > 300) throw new Error("invalid_bank_verification_response");
  return { iban, ownerName: info.data.name.trim() };
}
export async function verifyCustomerBankAccount(input: {
  nationalCode: string; birthDate: string; iban?: string; cardNumber?: string;
}): Promise<{ iban: string; ownerName: string; bankName: string; providerReference: string }> {
  const birthDate = normalizeBankBirthDate(input.birthDate);
  if (!birthDate) throw new Error("customer_birth_date_required");
  let iban = input.iban;
  if (input.cardNumber) {
    const conversion = await call("cardToIban", { cardNumber: input.cardNumber });
    iban = normalizeIban(conversion?.data?.iban) ?? undefined;
  }
  if (!iban || !normalizeIban(iban)) throw new Error("invalid_bank_verification_response");
  const match = await call("ibanMatch", { nationalCode: input.nationalCode, birthDate, iban });
  if (match.data === false) throw new Error("bank_ownership_mismatch");
  if (match.data !== true) throw new Error("invalid_bank_verification_response");
  const info = await call("ibanInfo", { iban });
  if (info.data?.active !== true || typeof info.data?.name !== "string" || !info.data.name.trim()
    || typeof info.data?.bankName !== "string" || !info.data.bankName.trim()) throw new Error("invalid_bank_verification_response");
  // API has no provider receipt id. Store an explicitly-labelled digest of proof,
  // rather than fabricate a provider transaction reference.
  const proof = JSON.stringify({ iban, nationalCode: input.nationalCode, birthDate, match, info });
  return { iban, ownerName: info.data.name, bankName: info.data.bankName,
    providerReference: `sapi-proof-sha256:${createHash("sha256").update(proof).digest("hex")}` };
}
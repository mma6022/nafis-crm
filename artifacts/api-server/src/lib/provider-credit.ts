/**
 * SAPI-NOCREDIT (t497s1594): s.api.ir answers «no credit on account | شارژ حساب کاربری شما کافی نمی باشد» when the account
 * balance is used up. Bank verification and CRM identity checks share that account (SAPI_API_TOKEN), so both detect it here.
 * CRM staff get NO_CREDIT_FA; customers on the portal only ever get PORTAL_UNAVAILABLE_FA.
 * The warn log carries the provider's own reason code/message only (digits ≥5 masked) — never the request payload.
 */
import { logger } from "./logger";

export const NO_CREDIT_FA = "شارژ سرویس استعلام تمام شده، به مدیر سیستم بگویید";
export const PORTAL_UNAVAILABLE_FA = "موقتاً در دسترس نیست، کمی بعد تلاش کنید";
const NO_CREDIT_RE = /no\s*credit|insufficient\s*(credit|balance|charge)|out\s*of\s*credit|شارژ\s*حساب|شارژ\s*کافی|اعتبار\s*حساب[^.]*کافی/i;

const mask = (s: string) => s.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\d{5,}/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 160);

function reasonStrings(body: unknown, depth = 0): { codes: string[]; messages: string[] } {
  const out = { codes: [] as string[], messages: [] as string[] };
  if (!body || typeof body !== "object" || depth > 2) return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (["code", "status", "statuscode", "errorcode", "resultcode"].includes(key) && (typeof v === "string" || typeof v === "number")) out.codes.push(String(v));
    else if (["message", "messages", "error", "errors", "errormessage", "title", "detail", "description"].includes(key)) {
      if (typeof v === "string") out.messages.push(v);
      else if (Array.isArray(v)) for (const x of v.slice(0, 3)) if (typeof x === "string") out.messages.push(x);
    }
    if (["data", "result", "error", "errors"].includes(key) && v && typeof v === "object" && !Array.isArray(v)) {
      const n = reasonStrings(v, depth + 1); out.codes.push(...n.codes); out.messages.push(...n.messages);
    }
  }
  return out;
}
export function isNoCreditReply(body: unknown): boolean {
  if (typeof body === "string") return NO_CREDIT_RE.test(body);
  return reasonStrings(body).messages.some(m => NO_CREDIT_RE.test(m));
}
export function providerReason(body: unknown): { providerCode: string; providerMessage: string } {
  if (typeof body === "string") return { providerCode: "", providerMessage: mask(body) };
  const r = reasonStrings(body);
  return { providerCode: mask(r.codes.slice(0, 3).join(",")), providerMessage: mask(r.messages.slice(0, 2).join(" | ")) };
}
export function logProviderFailure(service: "bank" | "identity", operation: string, httpStatus: number | string, body: unknown): boolean {
  const noCredit = isNoCreditReply(body);
  logger.warn({ provider: "sapi", service, operation, httpStatus, noCredit, ...providerReason(body) }, "sapi provider error");
  return noCredit;
}
export class ProviderNoCreditError extends Error { constructor() { super("provider_no_credit"); } }

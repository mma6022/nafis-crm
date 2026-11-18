/** credit-panel v1 client (flag.credit_panel_v1). OFF → GET /credit-panel/me is 404 → useCpOn() false → nothing below is rendered or called. */
import { useQuery } from "@tanstack/react-query";

export class CpError extends Error {
  status: number; code: string; body: any;
  constructor(message: string, status: number, code: string, body: any) { super(message); this.status = status; this.code = code; this.body = body; }
}
const hasFa = (s: unknown): s is string => typeof s === "string" && /[\u0600-\u06FF]/.test(s);
async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, credentials: "include", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new CpError("استعلام الآن انجام نشد", 0, "network", null); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = hasFa(data?.error) ? data.error
      : res.status === 409 ? "این کد ملی در پرونده‌ی مشتری دیگری ثبت است؛ دوباره از مشتری بپرس یا به مدیر خبر بده."
      : res.status === 403 ? "این کار برای شما باز نیست." : "استعلام الآن انجام نشد";
    throw new CpError(msg, res.status, typeof data?.code === "string" ? data.code : "", data);
  }
  return data as T;
}

export const CP_PARTS = ["unpaidChequePro", "chequeColor", "activeLoans"] as const;
export type CpPart = typeof CP_PARTS[number];
export type Cheque = { accountNumber?: string; amount?: number | string; bouncedAmount?: number | string; bankCode?: string; branchCode?: string; branchDescription?: string;
  dishonoringBranchName?: string; dishonorReason?: string; chequeDate?: string | number; backDate?: string | number; chequeID?: string; chequeNumber?: string };
export type Unpaid = { name?: string; count?: number; chequeList?: Cheque[] };
export type Colour = { chequeColor?: string; chequeColorCode?: number | string };
export type Loans = { count?: number; info?: { name?: string; totalAmount?: number | string; debtTotalAmount?: number | string; pastExpiredTotalAmount?: number | string;
  deferredTotalAmount?: number | string; suspiciousTotalAmount?: number | string; dishonored?: number | string } };
export type CpPartView<T> = { data: T | null; at: string | null; error: boolean; errorDetail?: string | null };
export type CpCustomer = { name: string; nationalCodeMasked: string | null; hasNationalCode: boolean; hasBirthDate: boolean; isCompany: boolean; rank: { label: string; at: string | null } | null };
export type CpView = {
  enabled: true; customerId: number; lastAt: string | null; validHours: number | null; validUntil: string | null; valid: boolean;
  parts: { unpaidChequePro: CpPartView<Unpaid>; chequeColor: CpPartView<Colour>; activeLoans: CpPartView<Loans> };
  lastErrors: CpPart[]; customer: CpCustomer; failed?: CpPart[];
};

export function useCpMe() {
  return useQuery<{ enabled: boolean; icc: boolean }>({
    queryKey: ["credit-panel", "me"], retry: false, staleTime: 60_000,
    queryFn: async () => { try { return await req<{ enabled: boolean; icc: boolean }>("GET", "/credit-panel/me"); } catch { return { enabled: false, icc: false }; } },
  });
}
export const useCpOn = () => useCpMe().data?.enabled === true;
export function useCpView(customerId: number | null, enabled = true) {
  return useQuery<CpView>({ queryKey: ["credit-panel", "view", customerId], enabled: enabled && customerId != null, retry: false, staleTime: 15_000,
    queryFn: () => req<CpView>("GET", `/credit-panel/customers/${customerId}`) });
}
export const runInquiry = (customerId: number, opts: { confirmFresh?: boolean; only?: CpPart[] } = {}) =>
  req<CpView>("POST", `/credit-panel/customers/${customerId}/inquiry`, opts);
export const saveBirthDate = (customerId: number, birthDateJalali: string, confirmReplace = false) =>
  req<{ changed: boolean }>("POST", `/credit-panel/customers/${customerId}/birth-date`, { birthDateJalali, confirmReplace });

/* ---------- display helpers (spec §2.5): rial ÷ 10 = toman, Persian digits, Jalali + Asia/Tehran ---------- */
const FA = "۰۱۲۳۴۵۶۷۸۹";
export const fa = (v: string | number) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]);
const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export function toman(rial: unknown): string {
  const n = Number(toLatin(String(rial ?? "")).replace(/[^\d.-]/g, ""));
  const t = Number.isFinite(n) ? Math.round(n / 10) : 0;
  return `${fa(String(Math.abs(t)).replace(/\B(?=(\d{3})+(?!\d))/g, "٬"))} تومان`;
}
export const JMONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
/** «14030120» → «۲۰ فروردین ۱۴۰۳». */
export function compactJalali(v: unknown): string {
  const s = toLatin(String(v ?? "")).replace(/\D/g, "");
  if (s.length !== 8) return s ? fa(s) : "—";
  const y = s.slice(0, 4), m = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
  if (m < 1 || m > 12 || d < 1) return fa(s);
  return `${fa(d)} ${JMONTHS[m - 1]} ${fa(y)}`;
}
const tehranDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(d);
const clock = (d: Date) => fa(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d));
export function jalaliDateTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran" }).format(d);
  return `${parts}، ساعت ${clock(d)}`;
}
/** «امروز، ساعت ۱۰:۴۰» / «۳ روز پیش». */
export function agoFa(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (tehranDay(d) === tehranDay(new Date(now))) return `امروز، ساعت ${clock(d)}`;
  const days = Math.max(1, Math.round((Date.parse(tehranDay(new Date(now))) - Date.parse(tehranDay(d))) / 86_400_000));
  return `${fa(days)} روز پیش`;
}
export const maskAccount = (v: unknown) => { const s = toLatin(String(v ?? "")).replace(/\s/g, ""); return s.length > 4 ? `••••${fa(s.slice(-4))}` : s ? fa(s) : "—"; };

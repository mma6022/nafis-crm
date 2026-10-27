/**
 * Plan rate («نرخ», PM 2026-10-28; design site-seo-pages HANDOFF §0 v1.2, seo-data.js rateState/faqRates).
 * The ONLY public rate is the CRM's loan_plans.annual_interest, exported as
 *   rate = { value: number|null, type: 'سود سالانه', qualifier: null, updated_at: 'YYYY-MM-DD' (Tehran) }
 * plus rateStaleDays (admin setting rate_stale_days, default 30). Fail-closed: a missing, unknown, future-dated or
 * stale (age > N days → hidden from updated_at + N + 1) rate is never shown: cards say «از کارشناس بپرسید» and the FAQ
 * uses the approved no-number answer. The check runs at build time AND in the browser (scripts/rate-expiry.ts).
 * This module ships to the browser: no Node APIs.
 */
export type RateType = 'sud' | 'karmozd' | 'monthly';
export type RateQualifier = 'elami' | 'hodudi';
export interface PlanRate {
  value: number | null;
  type: RateType | null;
  /** raw qualifier: null, a known one, or anything else (→ unknown) */
  qualifier: string | null;
  updated_at: string | null;
}
export const RATE_TYPE_LABEL: Record<RateType, string> = { sud: 'سود', karmozd: 'کارمزد', monthly: 'ماهانه' };
export const RATE_Q_LABEL: Record<RateQualifier, string> = { elami: 'اعلامی', hodudi: 'حدودی' };
export const RATE_STALE_DAYS_DEFAULT = 30;
/** CRM export type strings → design keys (unknown → null → unknown state) */
const TYPE_MAP: Record<string, RateType> = { 'سود سالانه': 'sud', سود: 'sud', sud: 'sud', کارمزد: 'karmozd', karmozd: 'karmozd', ماهانه: 'monthly', monthly: 'monthly' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Parses the export's `rate` object; anything malformed becomes an unknown rate (never throws). */
export function parseRate(raw: unknown): PlanRate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const value = typeof o.value === 'number' && Number.isFinite(o.value) && o.value >= 0 ? o.value : null;
  const type = typeof o.type === 'string' ? (TYPE_MAP[o.type.trim()] ?? null) : null;
  const qualifier = o.qualifier == null ? null : String(o.qualifier);
  const updated_at = typeof o.updated_at === 'string' && ISO.test(o.updated_at) ? o.updated_at : null;
  return { value, type, qualifier, updated_at };
}
export const parseStaleDays = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 2 ? v : RATE_STALE_DAYS_DEFAULT);

/** Today in Asia/Tehran as YYYY-MM-DD (build machine or browser clock). */
export const tehranToday = (now: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const daysSince = (iso: string, today: string) => Math.round((Date.parse(today) - Date.parse(iso)) / 864e5);
export const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);

export type RateState =
  | { s: 'known' | 'qualified'; d: number }
  | { s: 'unknown'; why: 'null' | 'bad-qualifier' | 'no-date' | 'future' | 'stale'; d?: number };
export function rateState(r: PlanRate | undefined | null, N = RATE_STALE_DAYS_DEFAULT, today = tehranToday()): RateState {
  if (!r || r.value == null || !r.type || !(r.type in RATE_TYPE_LABEL)) return { s: 'unknown', why: 'null' };
  if (r.qualifier != null && !(r.qualifier in RATE_Q_LABEL)) return { s: 'unknown', why: 'bad-qualifier' };
  if (!r.updated_at || Number.isNaN(Date.parse(r.updated_at))) return { s: 'unknown', why: 'no-date' };
  const d = daysSince(r.updated_at, today);
  if (d < 0) return { s: 'unknown', why: 'future', d };
  if (d > N) return { s: 'unknown', why: 'stale', d };
  return { s: r.qualifier ? 'qualified' : 'known', d };
}
/** First day the rate is hidden (stale = age > N) — null when there is no valid date. */
export const rateHideOn = (r: PlanRate | undefined | null, N = RATE_STALE_DAYS_DEFAULT) =>
  r?.updated_at && !Number.isNaN(Date.parse(r.updated_at)) ? addDays(r.updated_at, N + 1) : null;

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (s: string) => s.replace(/\d/g, (d) => FA[+d]!);
/** 23 → «۲۳٪», 4.5 → «۴٫۵٪» */
export const ratePct = (v: number) => fa(String(v).replace('.', '٫')) + '٪';
/** Shamsi date, e.g. «۷ آبان ۱۴۰۵» */
export const rateShamsi = (iso: string) =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));

export interface RatedPlan {
  name: string;
  rate?: PlanRate;
  rateStaleDays?: number;
}
export interface FaqRates {
  main: number;
  low: number;
  lowN: number;
  /** names of the low-rate plans without the «طرح » prefix, «هرمز و نیلوفر» */
  lowNames: string;
}
const COUNT_WORDS = ['', 'یک', 'دو', 'سه', 'چهار'];
const bareName = (n: string) => n.replace(/\s*\([^)]*\)/g, '').replace(/^\s*طرح\s+/, '').replace(/\s+/g, ' ').trim();
/**
 * FAQ rate sentence data (design faqRates): null unless EVERY active plan has a known «سود» rate and the rates take
 * exactly 2 values with the main one more frequent. null → the approved no-number answer.
 */
export function faqRates(plans: RatedPlan[], today = tehranToday()): FaqRates | null {
  if (!plans.length) return null;
  for (const p of plans) {
    if (rateState(p.rate, p.rateStaleDays ?? RATE_STALE_DAYS_DEFAULT, today).s === 'unknown' || p.rate!.type !== 'sud') return null;
  }
  const cnt = new Map<number, number>();
  for (const p of plans) cnt.set(p.rate!.value!, (cnt.get(p.rate!.value!) ?? 0) + 1);
  const vals = [...cnt.keys()].sort((a, b) => cnt.get(b)! - cnt.get(a)!);
  if (vals.length !== 2 || cnt.get(vals[0]!)! <= cnt.get(vals[1]!)!) return null;
  const low = vals[1]!;
  const names = [...new Set(plans.filter((p) => p.rate!.value === low).map((p) => bareName(p.name)))];
  const lowNames = names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join('، ')} و ${names[names.length - 1]}`;
  return { main: vals[0]!, low, lowN: cnt.get(low)!, lowNames };
}
/** «دو» for 2 (design count words 1–4), digits beyond */
export const countWord = (n: number) => COUNT_WORDS[n] || fa(String(n));
/** Earliest hide day over the plans (the FAQ falls back from that Tehran day on) */
export function earliestHideOn(plans: RatedPlan[]): string | null {
  const days = plans.map((p) => rateHideOn(p.rate, p.rateStaleDays ?? RATE_STALE_DAYS_DEFAULT)).filter((d): d is string => !!d);
  return days.length ? days.sort()[0]! : null;
}
/** Approved no-number answer (B2-final): used whenever faqRates is null */
export const RATE_FAQ_FALLBACK = 'نرخ به طرح بستگی دارد، نه به نوع ضمانت. اطلاعات هر طرح را در صفحه‌ی «همه طرح‌ها» ببینید.';

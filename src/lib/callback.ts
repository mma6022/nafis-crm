/**
 * «درخواست مشاوره‌ی رایگان» callback form logic (pure; tests/callback.test.ts). Behaviour reference: designer
 * mockups/src/site.js `normMobile` / `mountCallback` (CALLBACK-HANDOFF.md). Payload contract (handoff §1 «Payload»):
 * { kind:'callback', name, phone:'09xxxxxxxxx', contactTime:'now'|'morning'|'evening', need?, planId?, src, consent,
 *   website (honeypot), startedAt, utm_* } → POST PUBLIC_LEAD_ENDPOINT. CRM side: nafis-crm feat/callback-requests.
 * Hours/days come from lib/site WORK_HOURS (Asia/Tehran via Intl, never the visitor's own zone).
 */
import { normalizeIranMobile, toFaDigits } from './format';
import { LeadError, UTM_KEYS, cleanSrc, postPublicLead, type LeadResult, type Need, type Utm } from './lead';
import { WORK_HOURS } from './site';

export type CallbackTime = 'now' | 'morning' | 'evening';

export interface CallbackInput {
  name: string;
  phone: string;
  contactTime: CallbackTime;
  need?: Need | null;
  planId?: number | null;
  src?: string | null;
  consent: boolean;
  /** honeypot value (must stay "") */
  website: string;
  startedAt: number;
  utm?: Utm;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Hour (0–23) and weekday (0 = Sunday) in Asia/Tehran, independent of the visitor's clock zone. */
export function tehranClock(at: Date = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: WORK_HOURS.tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(at);
  return {
    hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24,
    weekday: WD[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0,
  };
}
export const tehranHour = (at: Date = new Date()) => tehranClock(at).hour;

export const isWorkDay = (weekday: number) => WORK_HOURS.days.includes(weekday);

/** Working day (WORK_HOURS.days) and 09:00 ≤ Tehran time < 18:00. */
export function isWorkingHours(at: Date = new Date()): boolean {
  const { hour, weekday } = tehranClock(at);
  return isWorkDay(weekday) && hour >= WORK_HOURS.start && hour < WORK_HOURS.end;
}

const DAY_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
/** When the next working window opens, as words: «امروز» (before 9 on a work day), «فردا» or the weekday name. */
export function nextOpening(at: Date = new Date()): string {
  const { hour, weekday } = tehranClock(at);
  if (isWorkDay(weekday) && hour < WORK_HOURS.start) return 'امروز';
  for (let k = 1; k <= 7; k++) {
    const d = (weekday + k) % 7;
    if (isWorkDay(d)) return k === 1 ? 'فردا' : DAY_FA[d]!;
  }
  return 'فردا';
}

const range = (r: readonly [number, number]) => `${toFaDigits(r[0])} تا ${toFaDigits(r[1])}`;
export interface TimeOpt {
  v: CallbackTime;
  label: string;
  sub: string;
  icon: 'bolt' | 'sun' | 'moon';
}
export const TIME_OPTS: TimeOpt[] = [
  { v: 'now', label: 'همین الان', sub: 'ساعات کاری', icon: 'bolt' },
  { v: 'morning', label: 'صبح', sub: `قبل از ظهر (${range(WORK_HOURS.morning)})`, icon: 'sun' },
  { v: 'evening', label: 'عصر', sub: `بعد از ظهر (${range(WORK_HOURS.evening)})`, icon: 'moon' },
];
/** «همین الان» is offered only inside working hours (Mohammad, 4:58 PM). */
export const timeOptions = (inHours: boolean) => (inHours ? TIME_OPTS : TIME_OPTS.filter((o) => o.v !== 'now'));

export const TOPIC_OPTS: { v: Need; label: string }[] = [
  { v: 'cash', label: 'وام نقدی' },
  { v: 'goods', label: 'خرید کالا' },
  { v: 'help', label: 'نمی‌دانم' },
];

export const CB_TITLE = 'درخواست مشاوره‌ی رایگان';
export const CB_SUBMIT = 'ثبت درخواست مشاوره';
export const CB_DONE = 'درخواست مشاوره‌ی شما ثبت شد';

/**
 * Success line by chosen time. No minutes are ever promised. Outside working hours the next opening is named
 * («فردا از ساعت ۹ صبح…»), using WORK_HOURS.days.
 */
export function successLine(time: CallbackTime, at: Date = new Date()): string {
  const open = isWorkingHours(at);
  if (!open) {
    const when = nextOpening(at);
    if (time === 'evening') return `کارشناس ما ${when} عصر (${range(WORK_HOURS.evening)}) با شما تماس می‌گیرد.`;
    return `${when} از ساعت ${toFaDigits(WORK_HOURS.start)} صبح با شما تماس می‌گیریم.`;
  }
  if (time === 'now') return 'کارشناس ما در ساعت کاری، در اولین فرصت با شما تماس می‌گیرد.';
  return time === 'morning'
    ? `کارشناس ما صبح (${range(WORK_HOURS.morning)}) با شما تماس می‌گیرد.`
    : `کارشناس ما عصر (${range(WORK_HOURS.evening)}) با شما تماس می‌گیرد.`;
}

/** 09123456789 → «۰۹۱۲ ۳۴۵ ۶۷۸۹» */
export const faMobile = (d: string) => toFaDigits(`${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`);

export type FieldError = 'name' | 'phone' | 'time' | 'consent';
export function step1Errors(name: string, phone: string): FieldError[] {
  const out: FieldError[] = [];
  if (name.trim().replace(/\s+/g, ' ').length < 2) out.push('name');
  if (!normalizeIranMobile(phone)) out.push('phone');
  return out;
}
export function step2Errors(time: CallbackTime | null, consent: boolean): FieldError[] {
  const out: FieldError[] = [];
  if (!time) out.push('time');
  if (!consent) out.push('consent');
  return out;
}

/** Exact CRM payload: only contract keys. A stale «همین الان» (page left open past closing) goes as «صبح». */
export function buildCallbackPayload(i: CallbackInput, at: Date = new Date()): Record<string, unknown> {
  const phone = normalizeIranMobile(i.phone);
  if (!phone) throw new LeadError('invalid_phone');
  const out: Record<string, unknown> = {
    kind: 'callback',
    name: i.name.trim().replace(/\s+/g, ' ').slice(0, 80),
    phone,
    contactTime: i.contactTime === 'now' && !isWorkingHours(at) ? 'morning' : i.contactTime,
    consent: i.consent === true,
    website: i.website,
    startedAt: i.startedAt,
  };
  if (i.need) out.need = i.need;
  if (i.planId && Number.isInteger(i.planId) && i.planId > 0) out.planId = i.planId;
  const src = cleanSrc(i.src);
  if (src) out.src = src;
  for (const k of UTM_KEYS) {
    const v = i.utm?.[k]?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

export const submitCallback = (i: CallbackInput, endpoint?: string, fetchImpl?: typeof fetch): Promise<LeadResult> =>
  postPublicLead(buildCallbackPayload(i), endpoint, fetchImpl);

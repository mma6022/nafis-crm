// crm-consult-filters: client side of GET /consultations/report (+ /export, admin only).
// Filter state lives in the URL query (?f.period=week&f.grades=A1,B2 …) so a filtered view can be shared or reloaded.
import type { Consultation } from '@workspace/api-client-react';
import { jalaliValueToGregorian, persianParts, formatJalaliValue, tehranJalaliFileDay } from './jalali';

export type Period = 'all' | 'today' | 'week' | 'month' | 'range';
export type PlanResult = 'eligible' | 'review' | 'none';
export type ConsultFilterState = {
  search: string; period: Period; from: string; to: string; // from/to: Jalali «1405/08/02» (range only)
  salespersonIds: number[]; planResult: PlanResult | ''; planId: string; planType: 'score' | 'goods' | '';
  grades: string[]; guarantor: 'yes' | 'no' | ''; guarantorGrades: string[]; jobs: string[]; guarantorJobs: string[];
  cheque: 'has' | 'no' | 'bounced' | ''; military: 'has_card' | 'no_card' | 'female' | 'unrecorded' | ''; city: string;
  amountMin: string; amountMax: string; // million toman, as typed
  caseStatus: 'opened' | 'not' | '';
};
export const EMPTY_FILTERS: ConsultFilterState = {
  search: '', period: 'all', from: '', to: '', salespersonIds: [], planResult: '', planId: '', planType: '', grades: [], guarantor: '',
  guarantorGrades: [], jobs: [], guarantorJobs: [], cheque: '', military: '', city: '', amountMin: '', amountMax: '', caseStatus: '',
};
export const PERIOD_LABEL: Record<Period, string> = { all: 'همه', today: 'امروز', week: 'این هفته', month: 'این ماه', range: 'بازه‌ی دلخواه' };
export const PLAN_RESULT_LABEL: Record<PlanResult, string> = { eligible: 'حداقل یک طرح مناسب', review: 'فقط «باید بررسی شود»', none: 'بدون طرح مناسب' };
export const PLAN_TYPE_LABEL = { score: 'وام امتیازی (نقدی)', goods: 'وام خرید کالا' } as const;
export const CHEQUE_LABEL = { has: 'چک دارد', no: 'چک ندارد', bounced: 'چک برگشتی' } as const;
export const MILITARY_LABEL = { has_card: 'پایان خدمت دارد', no_card: 'پایان خدمت ندارد', female: 'خانم', unrecorded: 'ثبت نشده' } as const;
export const CASE_LABEL = { opened: 'پرونده تشکیل شد', not: 'پرونده تشکیل نشد' } as const;
export const JOB_ORDER = ['employee_with_insurance', 'employee_no_insurance', 'business', 'no_doc', 'retired', 'unemployed'] as const;
export const JOB_SHORT: Record<string, string> = {
  employee_with_insurance: 'کارمند (بیمه)', employee_no_insurance: 'کارمند (بدون بیمه)', business: 'آزاد (جواز)',
  no_doc: 'آزاد (بدون مدرک)', retired: 'بازنشسته', unemployed: 'بدون شغل',
};

const ARR = new Set(['salespersonIds', 'grades', 'guarantorGrades', 'jobs', 'guarantorJobs']);
const KEYS = Object.keys(EMPTY_FILTERS) as (keyof ConsultFilterState)[];
const pick = <T extends string>(v: string | null, ok: readonly T[]): T | '' => (v && (ok as readonly string[]).includes(v) ? v as T : '');

export function readFiltersFromUrl(search: string = window.location.search): ConsultFilterState {
  const p = new URLSearchParams(search); const g = (k: string) => p.get(`f.${k}`);
  const list = (k: string) => (g(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    search: g('search') ?? '', period: pick(g('period'), ['all', 'today', 'week', 'month', 'range'] as const) || 'all',
    from: g('from') ?? '', to: g('to') ?? '',
    salespersonIds: list('salespersonIds').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0),
    planResult: pick(g('planResult'), ['eligible', 'review', 'none'] as const), planId: /^\d+$/.test(g('planId') ?? '') ? g('planId')! : '',
    planType: pick(g('planType'), ['score', 'goods'] as const),
    grades: list('grades').filter((x) => /^[A-E][1-3]?$/.test(x)), guarantor: pick(g('guarantor'), ['yes', 'no'] as const),
    guarantorGrades: list('guarantorGrades').filter((x) => /^[A-E][1-3]?$/.test(x)),
    jobs: list('jobs').filter((x) => (JOB_ORDER as readonly string[]).includes(x)), guarantorJobs: list('guarantorJobs').filter((x) => (JOB_ORDER as readonly string[]).includes(x)),
    cheque: pick(g('cheque'), ['has', 'no', 'bounced'] as const), military: pick(g('military'), ['has_card', 'no_card', 'female', 'unrecorded'] as const),
    city: g('city') ?? '', amountMin: g('amountMin') ?? '', amountMax: g('amountMax') ?? '', caseStatus: pick(g('caseStatus'), ['opened', 'not'] as const),
  };
}
/** Writes the filters into the current URL (replaceState: filters are not history entries). Other params are kept. */
export function writeFiltersToUrl(f: ConsultFilterState, offset: number) {
  const p = new URLSearchParams(window.location.search);
  for (const k of [...KEYS, 'offset']) p.delete(`f.${k}`);
  for (const k of KEYS) {
    const v = f[k];
    if (ARR.has(k) ? (v as unknown[]).length : v !== EMPTY_FILTERS[k]) p.set(`f.${k}`, Array.isArray(v) ? v.join(',') : String(v));
  }
  if (offset) p.set('f.offset', String(offset));
  const qs = p.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
}
export const readOffsetFromUrl = () => Math.max(0, Number(new URLSearchParams(window.location.search).get('f.offset')) || 0);

/** Gregorian YYYY-MM-DD of a day in Tehran (the server reads from/to as Tehran days). */
export const tehranDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d);
export function periodBounds(f: Pick<ConsultFilterState, 'period' | 'from' | 'to'>, now = new Date()): { from?: string; to?: string; bad?: boolean } {
  const today = tehranDay(now);
  if (f.period === 'today') return { from: today, to: today };
  if (f.period === 'week') { // Persian week starts on Saturday
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Tehran' }).format(now);
    const back = Math.max(0, ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(wd));
    return { from: tehranDay(new Date(now.getTime() - back * 86_400_000)), to: today };
  }
  if (f.period === 'month') { // first day of the current Jalali month (Tehran calendar day)
    const p = persianParts(new Date(`${today}T12:00:00.000Z`));
    return { from: jalaliValueToGregorian(formatJalaliValue(p.year, p.month, 1)), to: today };
  }
  if (f.period === 'range') {
    const from = jalaliValueToGregorian(f.from); const to = jalaliValueToGregorian(f.to);
    if ((f.from && !from) || (f.to && !to) || (from && to && from > to)) return { bad: true };
    return { from, to };
  }
  return {};
}
const faDigitsToLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٬،\s]/g, '');
/** «۲۵۰» million toman → 250000000 toman; '' / bad → undefined. */
export const millionToToman = (s: string): number | undefined => { const n = Number(faDigitsToLatin(s)); return s.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : undefined; };
export const amountBad = (f: ConsultFilterState) => {
  const a = millionToToman(f.amountMin); const b = millionToToman(f.amountMax);
  return Boolean((f.amountMin.trim() && a === undefined) || (f.amountMax.trim() && b === undefined) || (a !== undefined && b !== undefined && a > b));
};

/** Query string for the API (only valid parts; a half-typed range/amount is left out and flagged in the UI). */
export function toApiQuery(f: ConsultFilterState, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  const b = periodBounds(f);
  if (f.search.trim()) p.set('search', f.search.trim());
  if (!b.bad) { if (b.from) p.set('from', b.from); if (b.to) p.set('to', b.to); }
  const set = (k: string, v: string | string[] | number[]) => { const s = Array.isArray(v) ? v.join(',') : v; if (s) p.set(k, s); };
  set('salespersonIds', f.salespersonIds); set('planResult', f.planResult); set('planId', f.planId); set('planType', f.planType);
  set('grades', f.grades); set('guarantor', f.guarantor); set('guarantorGrades', f.guarantorGrades); set('jobs', f.jobs); set('guarantorJobs', f.guarantorJobs);
  set('cheque', f.cheque); set('military', f.military); set('city', f.city.trim()); set('caseStatus', f.caseStatus);
  if (!amountBad(f)) { const a = millionToToman(f.amountMin); const c = millionToToman(f.amountMax); if (a !== undefined) p.set('amountMin', String(a)); if (c !== undefined) p.set('amountMax', String(c)); }
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

export type PlanRef = { id: number; name: string; loanType: 'score' | 'goods' | null };
export type ConsultFacts = {
  createdDay: string | null; salespersonId: number | null; creditRank: string | null; hasGuarantor: boolean | null; guarantorCreditRank: string | null;
  jobType: string | null; guarantorJobType: string | null; cheque: 'has' | 'no' | null; bouncedCheque: boolean | null;
  military: 'has_card' | 'no_card' | 'female' | null; city: string | null; amountToman: number | null; planSource: 'snapshot' | 'live';
  eligiblePlans: PlanRef[]; reviewPlans: PlanRef[]; planResult: PlanResult; caseId: number | null;
};
export type ReportItem = Consultation & { facts: ConsultFacts };
export type ReportSummary = { total: number; withPlan: number; reviewOnly: number; noPlan: number; cases: number };
export type ConsultReport = {
  items: ReportItem[]; total: number; limit: number; offset: number; summary: ReportSummary;
  plans: { id: number; name: string; active: boolean; loanType?: string | null }[];
  canExport: boolean; canFilterPlanType: boolean; salespersonScoped: boolean;
};
export class ReportError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function failure(res: Response) {
  let msg = 'دریافت گزارش مشاوره‌ها انجام نشد.';
  try { const j = await res.json(); if (typeof j?.error === 'string') msg = j.error; } catch { /* not json */ }
  return new ReportError(msg, res.status);
}
export async function fetchConsultReport(qs: string, signal?: AbortSignal): Promise<ConsultReport> {
  const res = await fetch(`/api/consultations/report?${qs}`, { credentials: 'include', signal });
  if (!res.ok) throw await failure(res);
  return res.json();
}
/** Admin only (the server answers 403 to everybody else). */
export async function downloadConsultCsv(qs: string) {
  const res = await fetch(`/api/consultations/report/export?${qs}`, { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `consultations-${tehranJalaliFileDay()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const fa = (n: number) => n.toLocaleString('fa-IR');
export const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100).toLocaleString('fa-IR')}٪` : '—');

/**
 * Release 82 — the 7-step «ثبت درخواست» wizard on /request (Armita, site-apply-wizard v1.0.1, HANDOFF §2–§3).
 * Pure rules + the exact CRM payload (POST /api/public/leads, type:'apply'; contract: nafis-crm
 * artifacts/api-server/src/lib/site-apply.ts validateSiteApply). Unknown keys are rejected by the CRM with 400.
 * No SMS code; the customer never sees a priority, an expert name, a rate, a percentage or an offered amount.
 * Honeypot: a filled `website` field shows the thank-you page WITHOUT any POST (shouldPost below).
 */
import { normalizeIranMobile, isValidMobile } from './format';
import { cleanSrc, postPublicLead, UTM_KEYS, type LeadResult, type Utm } from './lead';

export const APPLY_STEPS = 7;
/** v82: this form only — the CRM rejects a fill under 8 s as too_fast (other forms keep 3 s). */
export const APPLY_MIN_FILL_MS = 8_000;

export const AMOUNT_RANGES = [
  ['up_to_50m', 'تا ۵۰ میلیون تومان'],
  ['50m_100m', '۵۰ تا ۱۰۰ میلیون تومان'],
  ['100m_300m', '۱۰۰ تا ۳۰۰ میلیون تومان'],
  ['300m_500m', '۳۰۰ تا ۵۰۰ میلیون تومان'],
  ['over_500m', 'بیشتر از ۵۰۰ میلیون تومان'],
  ['not_sure', 'هنوز نمی‌دانم'],
] as const;
export const LOAN_PURPOSES = [
  ['goods', 'خرید کالا'],
  ['wedding', 'جهیزیه و ازدواج'],
  ['medical', 'درمان'],
  ['home', 'خانه و تعمیرات'],
  ['business', 'کسب‌وکار'],
  ['other', 'کار دیگر'],
] as const;
export const JOB_STATUSES = [
  ['employee', 'کارمند', 'doc', 'حقوق‌بگیر دولتی یا خصوصی'],
  ['retired', 'بازنشسته', 'sun', 'مستمری‌بگیر'],
  ['self_employed', 'آزاد', 'cart', 'کسب‌وکار یا کار شخصی'],
  ['no_fixed_income', 'بدون درآمد ثابت', 'clock', 'درآمد ماهانه‌ی ثابت ندارم'],
] as const;
export const DOCUMENTS = [
  ['payslip', 'فیش حقوقی'],
  ['salary_deduction_cert', 'گواهی کسر از حقوق'],
  ['sayadi_cheque', 'چک صیادی'],
  ['guarantor', 'ضامن'],
  ['none', 'هیچ‌کدام'],
] as const;
export const MILITARY = [
  ['yes', 'بله'],
  ['no', 'خیر'],
  ['not_applicable', 'مشمول نیستم'],
] as const;
export const YES_NO = [
  ['yes', 'بله'],
  ['no', 'خیر'],
] as const;
export const NEED_TIMINGS = [
  ['this_week', 'همین هفته', 'bolt'],
  ['this_month', 'این ماه', 'cal'],
  ['just_browsing', 'فقط دارم بررسی می‌کنم', 'search'],
] as const;

type V<T extends readonly (readonly [string, ...unknown[]])[]> = T[number][0];
export type AmountRange = V<typeof AMOUNT_RANGES>;
export type LoanPurpose = V<typeof LOAN_PURPOSES>;
export type JobStatus = V<typeof JOB_STATUSES>;
export type DocKey = V<typeof DOCUMENTS>;
export type Military = V<typeof MILITARY>;
export type YesNo = V<typeof YES_NO>;
export type NeedTiming = V<typeof NEED_TIMINGS>;

export interface ApplyAnswers {
  full_name: string;
  mobile: string;
  amount_range?: AmountRange;
  loan_purpose?: LoanPurpose;
  job_status?: JobStatus;
  documents: DocKey[];
  has_military_card?: Military;
  can_refer_retiree?: YesNo;
  has_bounced_or_overdue?: YesNo;
  need_timing?: NeedTiming;
}
export const emptyAnswers = (): ApplyAnswers => ({ full_name: '', mobile: '', documents: [] });

/** Fields per step (design STEP[].k). Step 5 = military + retiree referral, step 6 = bounced/overdue (design order). */
export const STEP_FIELDS: (keyof ApplyAnswers)[][] = [
  ['full_name', 'mobile'],
  ['amount_range', 'loan_purpose'],
  ['job_status'],
  ['documents'],
  ['has_military_card', 'can_refer_retiree'],
  ['has_bounced_or_overdue'],
  ['need_timing'],
];

export type StepErrors = Partial<Record<keyof ApplyAnswers, true>>;
/** Errors of one step (0-based). loan_purpose is optional. */
export function stepErrors(i: number, a: ApplyAnswers): StepErrors {
  const e: StepErrors = {};
  if (i === 0) {
    if (!a.full_name.trim()) e.full_name = true;
    if (!isValidMobile(a.mobile)) e.mobile = true;
    return e;
  }
  for (const k of STEP_FIELDS[i] ?? []) {
    if (k === 'loan_purpose') continue;
    if (k === 'documents' ? !a.documents.length : !a[k]) e[k] = true;
  }
  return e;
}
/** First step (0-based) that still has an error, or -1 when all 7 are complete. */
export const firstIncompleteStep = (a: ApplyAnswers): number => STEP_FIELDS.findIndex((_, i) => Object.keys(stepErrors(i, a)).length > 0);

/** Multi-select documents: «هیچ‌کدام» is exclusive (picking it clears the rest; picking another clears it). */
export function toggleDoc(list: DocKey[], d: DocKey): DocKey[] {
  if (list.includes(d)) return list.filter((x) => x !== d);
  if (d === 'none') return ['none'];
  return [...list.filter((x) => x !== 'none'), d];
}

/** Thank-you page mobile: 0912***0012 shape (first 4, last 4). Nothing else of the number is shown. */
export function maskMobile(v: string): string {
  const m = normalizeIranMobile(v);
  return m ? `${m.slice(0, 4)}***${m.slice(-4)}` : '';
}

/** The honeypot was filled → a bot: show the same thank-you page, never POST. */
export const shouldPost = (honeypot: string | null | undefined): boolean => !honeypot;

export interface ApplyMeta {
  planId?: number | null;
  term?: number | null;
  src?: string | null;
  utm?: Utm;
  startedAt: number;
  /** Measured on the page with a monotonic timer (performance.now) from step 1 to submit. */
  fillMs: number;
}

/** Exact CRM payload (only allowed keys). Throws on incomplete answers — the UI validates every step first. */
export function buildApplyPayload(a: ApplyAnswers, m: ApplyMeta): Record<string, unknown> {
  const phone = normalizeIranMobile(a.mobile);
  if (!phone || firstIncompleteStep(a) !== -1) throw new Error('incomplete');
  const out: Record<string, unknown> = {
    type: 'apply',
    name: a.full_name.trim().slice(0, 80),
    phone,
    amount_range: a.amount_range,
    job_status: a.job_status,
    documents: DOCUMENTS.map(([d]) => d).filter((d) => a.documents.includes(d)),
    has_military_card: a.has_military_card,
    can_refer_retiree: a.can_refer_retiree,
    has_bounced_or_overdue: a.has_bounced_or_overdue,
    need_timing: a.need_timing,
    consent: true, // the consent text sits under «ثبت درخواست» (no checkbox, PM v1.0.1 #5)
    website: '',
    startedAt: m.startedAt,
    fillMs: Math.max(0, Math.round(m.fillMs)),
  };
  if (a.loan_purpose) out.loan_purpose = a.loan_purpose;
  if (m.planId) out.planId = m.planId;
  if (m.planId && m.term) out.term = m.term;
  const src = cleanSrc(m.src);
  if (src) out.src = src;
  for (const k of UTM_KEYS) {
    const v = m.utm?.[k]?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

export const submitApply = (a: ApplyAnswers, m: ApplyMeta, endpoint?: string, fetchImpl?: typeof fetch): Promise<LeadResult> =>
  postPublicLead(buildApplyPayload(a, m), endpoint, fetchImpl);

export const APPLY_CONSENT_TEXT =
  'با ثبت درخواست، می‌پذیرم کارشناس نفیس وام برای بررسی درخواستم با من تماس بگیرد. اطلاعات من فقط برای همین کار استفاده می‌شود.';

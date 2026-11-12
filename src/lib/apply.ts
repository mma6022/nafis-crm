/**
 * The ONE «ثبت درخواست» wizard on /request — 8 steps (site-credit-noinst v1.0 + v1.1, Mohammad t337u/t338u; was the
 * 7-step release-82 wizard of site-apply-wizard v1.0.1). Every site entry (plan cards, calculator, «مشاوره‌ی رایگان»,
 * header, footer, landing pages) lands here; CallbackForm/CallbackDialog/RequestWizard are gone.
 * v1.1: only name + mobile are required; steps 2–8 have «رد کردن»; «فعلاً فقط تماس بگیرید» on step 1 submits name +
 * mobile only (quick). New step 4 «رتبه‌ی اعتباری» → credit_rank A|B|C|D|E|unknown (optional).
 * Pure rules + the exact CRM payload (POST /api/public/leads, type:'apply'; contract: nafis-crm
 * artifacts/api-server/src/lib/site-apply.ts validateSiteApply). Unknown keys are rejected by the CRM with 400.
 * No SMS code; the customer never sees a priority, an expert name, a rate, a percentage or an offered amount.
 * Honeypot: a filled `website` field shows the thank-you page WITHOUT any POST (shouldPost below).
 */
import { normalizeIranMobile, isValidMobile } from './format';
import { cleanSrc, postPublicLead, UTM_KEYS, type LeadResult, type Utm } from './lead';

export const APPLY_STEPS = 8;
/** A submission with at least one answer keeps the v82 8 s minimum (the CRM rejects faster ones as too_fast). */
export const APPLY_MIN_FILL_MS = 8_000;
/** §6 #12: a name + mobile only submission («فعلاً فقط تماس بگیرید», or every step skipped) only needs the CRM's
 *  general 3 s intake minimum — no 8 s wait. */
export const APPLY_QUICK_MIN_FILL_MS = 3_000;
/** Default `src` when /request/ is opened without one (e.g. the 404 page link), spec §5.2 v1.1. */
export const DEFAULT_SRC = 'request';

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
/** Step 4 (site-credit-noinst v1.0 §4): the live Nafis grade letters + «نمی‌دونم». The CRM file refines to A1…E3. */
export const CREDIT_RANKS = [
  ['A', 'A'],
  ['B', 'B'],
  ['C', 'C'],
  ['D', 'D'],
  ['E', 'E'],
  ['unknown', 'نمی‌دونم'],
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
export type CreditRank = V<typeof CREDIT_RANKS>;

export interface ApplyAnswers {
  full_name: string;
  mobile: string;
  amount_range?: AmountRange;
  loan_purpose?: LoanPurpose;
  job_status?: JobStatus;
  credit_rank?: CreditRank;
  documents: DocKey[];
  has_military_card?: Military;
  can_refer_retiree?: YesNo;
  has_bounced_or_overdue?: YesNo;
  need_timing?: NeedTiming;
}
export const emptyAnswers = (): ApplyAnswers => ({ full_name: '', mobile: '', documents: [] });

/** Fields per step. 4 = credit rank (new), 6 = military + retiree referral, 7 = bounced/overdue (design order). */
export const STEP_FIELDS: (keyof ApplyAnswers)[][] = [
  ['full_name', 'mobile'],
  ['amount_range', 'loan_purpose'],
  ['job_status'],
  ['credit_rank'],
  ['documents'],
  ['has_military_card', 'can_refer_retiree'],
  ['has_bounced_or_overdue'],
  ['need_timing'],
];

export type StepErrors = Partial<Record<keyof ApplyAnswers, true>>;
/**
 * Errors of one step (0-based) when the customer presses «ادامه» / «ثبت درخواست». Step 1 (name + mobile) is the only
 * required step; on steps 2–8 «ادامه» asks for a pick (loan_purpose stays optional) and «رد کردن» moves on without one
 * (v1.1) — so skipping never produces an error and the payload simply leaves the key out.
 */
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
/** Only name + mobile are required (v1.1): 0 when they are missing/invalid, else -1. */
export const firstIncompleteStep = (a: ApplyAnswers): number => (Object.keys(stepErrors(0, a)).length > 0 ? 0 : -1);
/** Steps whose answer keys are all empty (for the «رد کردن» state + the quick/full timing rule). */
export const hasAnyAnswer = (a: ApplyAnswers): boolean =>
  !!(a.amount_range || a.loan_purpose || a.job_status || a.credit_rank || a.documents.length || a.has_military_card || a.can_refer_retiree
    || a.has_bounced_or_overdue || a.need_timing);
/** Client-side wait before POST so the CRM's minimum fill time is met (8 s with answers, 3 s for name + mobile only). */
export const minFillFor = (a: ApplyAnswers, quick = false): number => (quick || !hasAnyAnswer(a) ? APPLY_QUICK_MIN_FILL_MS : APPLY_MIN_FILL_MS);

/** Calculator → /request/?amount=: the plan's مبلغ واریزی (toman) as the wizard's amount_range key. */
export function amountParam(payout: number): AmountRange {
  const m = payout / 1e6;
  return m <= 50 ? 'up_to_50m' : m <= 100 ? '50m_100m' : m <= 300 ? '100m_300m' : m <= 500 ? '300m_500m' : 'over_500m';
}
/**
 * v1.1 §8.4: entries that used to open the «درخواست مشاوره‌ی رایگان» form (or `?src=consult`) show the step-1 chip
 * «منبع: مشاوره‌ی رایگان». Their src values are unchanged so the CRM's «منبع صفحه» line stays comparable.
 */
export function isConsultSrc(src: string | null | undefined): boolean {
  const s = (src ?? '').toLowerCase();
  return s === 'consult' || s === 'footer' || /-(callback|menu|result|consult)$/.test(s);
}
/** `?amount=` → a known amount_range key (anything else is ignored). */
export const readAmountParam = (v: string | null | undefined): AmountRange | undefined =>
  AMOUNT_RANGES.find(([k]) => k === v)?.[0];

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

/**
 * Exact CRM payload (only allowed keys). Required: type, name, phone, consent, startedAt (v1.1 §5.2); every answer key is
 * sent only when the customer gave it. `quick` («فعلاً فقط تماس بگیرید») sends name + mobile only. Throws when name /
 * mobile are missing — the UI validates step 1 first.
 */
export function buildApplyPayload(a: ApplyAnswers, m: ApplyMeta, o: { quick?: boolean } = {}): Record<string, unknown> {
  const phone = normalizeIranMobile(a.mobile);
  if (!phone || firstIncompleteStep(a) !== -1) throw new Error('incomplete');
  const out: Record<string, unknown> = {
    type: 'apply',
    name: a.full_name.trim().slice(0, 80),
    phone,
    consent: true, // the consent text sits under the submit buttons (no checkbox, PM v1.0.1 #5)
    website: '',
    startedAt: m.startedAt,
    fillMs: Math.max(0, Math.round(m.fillMs)),
  };
  if (!o.quick) {
    if (a.amount_range) out.amount_range = a.amount_range;
    if (a.loan_purpose) out.loan_purpose = a.loan_purpose;
    if (a.job_status) out.job_status = a.job_status;
    if (a.credit_rank) out.credit_rank = a.credit_rank;
    const docs = DOCUMENTS.map(([d]) => d).filter((d) => a.documents.includes(d));
    if (docs.length) out.documents = docs;
    if (a.has_military_card) out.has_military_card = a.has_military_card;
    if (a.can_refer_retiree) out.can_refer_retiree = a.can_refer_retiree;
    if (a.has_bounced_or_overdue) out.has_bounced_or_overdue = a.has_bounced_or_overdue;
    if (a.need_timing) out.need_timing = a.need_timing;
  }
  if (m.planId) out.planId = m.planId;
  if (m.planId && m.term) out.term = m.term;
  out.src = cleanSrc(m.src) || DEFAULT_SRC;
  for (const k of UTM_KEYS) {
    const v = m.utm?.[k]?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  return out;
}

export const submitApply = (a: ApplyAnswers, m: ApplyMeta, endpoint?: string, fetchImpl?: typeof fetch, o: { quick?: boolean } = {}): Promise<LeadResult> =>
  postPublicLead(buildApplyPayload(a, m, o), endpoint, fetchImpl);

export const APPLY_CONSENT_TEXT =
  'با ثبت درخواست، می‌پذیرم کارشناس نفیس وام برای بررسی درخواستم با من تماس بگیرد. اطلاعات من فقط برای همین کار استفاده می‌شود.';

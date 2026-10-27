/**
 * Per-plan guarantee overrides (Mohammad's answers via the PM, 2026-10-23, plus /workspace/nafis-site-ux/plan-facts-db.md).
 * The CRM export (loan-plans.json) does not carry guarantees yet, so this layer is merged into every plan list
 * (build snapshot AND the live file in the browser) by `applyPlanOverrides` in lib/loan-plans.ts.
 *
 * - guaranteeOptions: alternative ways to qualify (same shape as the CRM's public export); each inner list is what
 *   the applicant must provide in that way. 'none' = no cheque, no promissory note and no guarantor.
 * - guaranteeTypes: union of the options (derived, never hand-typed).
 * - pages: when set, the plan may be listed ONLY on these guarantee pages (plan 17).
 * - A plan that is missing here has NO guarantee data: it is never listed on a guarantee page and the site states
 *   nothing about its guarantee (fail-closed for plans the CRM adds later).
 * - noGuarantorShare: share of the payout obtainable WITHOUT a guarantor when that way has a lower loan cap (plan 3:
 *   1/3, plan 9: 0.6). The public text states only مبلغ واریزی (Mohammad 2026-10-28: never the principal); the build
 *   checks the «بدون ضامن … حدود N میلیون» figure against the data. Absent = no lower cap. Used by «سریع‌ترین بدون ضامن».
 * - retireesOnly: the plan is offered ONLY to retirees (plan 21, DB condition #437 job = بازنشسته, note «فقط مخصوص
 *   بازنشسته ها»): the finder shows it only when «بازنشسته» is chosen and its card carries «ویژه‌ی بازنشستگان».
 * Every guarantee page is checked against these rules by scripts/check-guarantees.mjs (runs in the build).
 */
export type GuaranteeType = 'cheque' | 'promissory' | 'guarantor' | 'none';
export type GuaranteePage = 'no-guarantor' | 'no-cheque' | 'cheque' | 'promissory' | 'fast-no-guarantor' | 'fast-no-cheque';

export interface PlanGuarantee {
  guaranteeOptions: GuaranteeType[][];
  /** public one-line summary of the guarantee */
  summary: string;
  /** per-page «why it qualifies» line, when it differs from the summary */
  why?: Partial<Record<GuaranteePage, string>>;
  /** document notes that differ from the CRM's required_documents (shown with the plan on guarantee pages) */
  documents?: string;
  pages?: GuaranteePage[];
  retireesOnly?: boolean;
  /** share (0–1) of the payout obtainable without a guarantor, when lower than with one (plan 3: 1/3, plan 9: 0.6) */
  noGuarantorShare?: number;
}

const CHEQUE_3P = 'اگر خودتان چک ندارید، چک شخص دیگری هم پذیرفته می‌شود.';
export const THIRD_PARTY_CHEQUE = CHEQUE_3P;

export const PLAN_GUARANTEES: Record<number, PlanGuarantee> = {
  1: { guaranteeOptions: [['cheque', 'guarantor']], summary: 'یک ضامن و یک چک صیادی دیجیتال (چک را متقاضی یا ضامن می‌دهد)' },
  7: { guaranteeOptions: [['cheque']], summary: 'چک شخصی خود متقاضی؛ اگر چک ندارید، چک شخص دیگری هم پذیرفته می‌شود' },
  3: {
    guaranteeOptions: [['cheque', 'guarantor'], ['cheque']],
    summary: 'چک صیادی؛ با ضامن مبلغ واریزی حدود ۱۶۹٫۵ میلیون تومان، بدون ضامن حدود ۵۶٫۵ میلیون تومان',
    why: { 'no-guarantor': 'بدون ضامن، فقط با چک صیادی (مبلغ واریزی حدود ۵۶٫۵ میلیون تومان)' },
    noGuarantorShare: 1 / 3,
  },
  4: { guaranteeOptions: [['cheque', 'guarantor']], summary: 'چک صیادی به‌همراه ضامن' },
  5: { guaranteeOptions: [['cheque', 'guarantor']], summary: 'چک صیادی به‌همراه ضامن' },
  8: { guaranteeOptions: [['cheque']], summary: 'فقط چک صیادی؛ ضامن لازم نیست' },
  9: {
    guaranteeOptions: [['cheque'], ['cheque', 'guarantor']],
    summary: 'چک صیادی؛ بدون ضامن مبلغ واریزی حدود ۱۷۴ میلیون تومان، با ضامن حدود ۲۹۰ میلیون تومان',
    why: { 'no-guarantor': 'بدون ضامن، با چک صیادی (مبلغ واریزی حدود ۱۷۴ میلیون تومان)' },
    noGuarantorShare: 0.6,
  },
  10: { guaranteeOptions: [['cheque', 'guarantor']], summary: 'دو ضامن و یک چک صیادی دیجیتال (چک را متقاضی یا یکی از ضامن‌ها می‌دهد)' },
  11: { guaranteeOptions: [['cheque', 'guarantor']], summary: 'یک ضامن و یک چک صیادی دیجیتال (چک را متقاضی یا ضامن می‌دهد)' },
  12: { guaranteeOptions: [['cheque']], summary: 'فقط چک صیادی؛ ضامن لازم نیست' },
  14: { guaranteeOptions: [['cheque']], summary: 'فقط چک صیادی؛ ضامن لازم نیست' },
  15: {
    guaranteeOptions: [['none']],
    summary: 'نه چک لازم است، نه سفته و نه ضامن',
    documents: 'کارت ملی، شناسنامه و مدرک شغلی',
  },
  17: {
    guaranteeOptions: [['none'], ['guarantor']],
    summary: 'بسته به رتبه‌ی اعتباری: ممکن است ضامن لازم نباشد یا تا دو ضامن لازم شود',
    pages: ['no-guarantor'],
  },
  18: { guaranteeOptions: [['cheque']], summary: 'فقط چک صیادی؛ ضامن لازم نیست' },
  19: {
    guaranteeOptions: [['cheque'], ['cheque', 'guarantor']],
    summary: 'چک صیادی، با یا بدون ضامن (مبلغ به رتبه‌ی اعتباری بستگی دارد)',
    why: { 'no-guarantor': 'راه بدون ضامن هم دارد: فقط چک صیادی (مبلغ به رتبه‌ی اعتباری بستگی دارد)' },
  },
  20: { guaranteeOptions: [['promissory', 'guarantor']], summary: 'سفته و یک ضامن؛ چک لازم نیست' },
  21: {
    guaranteeOptions: [['none']],
    summary: 'ویژه‌ی بازنشستگان؛ نه چک لازم است، نه سفته و نه ضامن',
    retireesOnly: true,
  },
  22: {
    guaranteeOptions: [['cheque']],
    summary: 'چک صیادی، به‌همراه مدارک شغلی و اجاره‌نامه؛ ضامن لازم نیست',
    documents: 'مدارک شغلی و اجاره‌نامه',
  },
};

export const GUARANTEE_PAGES: Record<GuaranteePage, { label: string; slug: string; fast?: boolean }> = {
  'no-guarantor': { label: 'بدون ضامن', slug: 'vam-bedun-zamen' },
  'no-cheque': { label: 'بدون چک', slug: 'vam-bedun-chek' },
  cheque: { label: 'با چک', slug: 'vam-ba-chek' },
  promissory: { label: 'با سفته', slug: 'vam-ba-safte' },
  'fast-no-guarantor': { label: 'فوری بدون ضامن', slug: 'vam-fori-bedun-zamen', fast: true },
  'fast-no-cheque': { label: 'فوری بدون چک', slug: 'vam-fori-bedun-chek', fast: true },
};

const opt = (o: GuaranteeType[]) => ({
  cheque: o.includes('cheque'),
  promissory: o.includes('promissory'),
  guarantor: o.includes('guarantor'),
});
/** The page's condition on ONE guarantee option (a way to qualify). */
export const OPTION_OK: Record<'no-guarantor' | 'no-cheque' | 'cheque' | 'promissory', (o: GuaranteeType[]) => boolean> = {
  'no-guarantor': (o) => !opt(o).guarantor,
  'no-cheque': (o) => !opt(o).cheque,
  cheque: (o) => opt(o).cheque,
  promissory: (o) => opt(o).promissory,
};
const BASE: Record<GuaranteePage, keyof typeof OPTION_OK> = {
  'no-guarantor': 'no-guarantor',
  'no-cheque': 'no-cheque',
  cheque: 'cheque',
  promissory: 'promissory',
  'fast-no-guarantor': 'no-guarantor',
  'fast-no-cheque': 'no-cheque',
};

/**
 * Does a plan truly meet a guarantee page's condition? Unknown guarantee (no options) → false. A plan restricted
 * to some pages (17) only qualifies there. Fast pages (2026-10-28, copy A2/A3) use the SAME base condition as their
 * guarantee page: «فوری» is only the review-time ORDER (lib/plans fastestGuaranteePlans, DAYS_RANK), never a filter.
 */
export function qualifiesFor(
  p: { id: number; grantDays: string; guaranteeOptions?: GuaranteeType[][]; guaranteePages?: GuaranteePage[] },
  page: GuaranteePage,
): boolean {
  if (!p.guaranteeOptions?.length) return false;
  if (p.guaranteePages && !p.guaranteePages.includes(page)) return false;
  return p.guaranteeOptions.some(OPTION_OK[BASE[page]]);
}
export const whyFor = (id: number, page: GuaranteePage) => {
  const g = PLAN_GUARANTEES[id];
  if (!g) return '';
  const base = page.startsWith('fast-') ? (page.slice(5) as GuaranteePage) : page;
  return g.why?.[page] ?? g.why?.[base] ?? g.summary;
};

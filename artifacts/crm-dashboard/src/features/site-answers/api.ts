/** v82: answers the customer gave in the site's 7-step «ثبت درخواست» form (GET /api/customers/:id/site-answers). Read only. */
import { useQuery } from '@tanstack/react-query';

export type SiteAnswers = {
  amount_range: string; loan_purpose: string | null; job_status: string; documents: string[];
  has_military_card: string; can_refer_retiree: string; has_bounced_or_overdue: string; need_timing: string;
};
export type SiteSubmission = { id: number; submittedAt: string; src: string | null; outcome: string; planId: number | null; planName: string | null; term: number | null; answers: SiteAnswers };
export type SiteAnswersResponse = { count: number; latest: SiteSubmission | null; previous: SiteSubmission[] };

const base = () => (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const siteAnswersKey = (id: number) => ['site-answers', id] as const;
export function useSiteAnswers(customerId: number | null | undefined, enabled = true) {
  return useQuery<SiteAnswersResponse>({
    queryKey: siteAnswersKey(Number(customerId)), enabled: Boolean(customerId) && enabled, retry: false, staleTime: 30_000,
    queryFn: async () => {
      const r = await fetch(`${base()}/api/customers/${customerId}/site-answers`, { credentials: 'include' });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as SiteAnswersResponse;
    },
  });
}

/** Armita site-apply-wizard v1.0.1 HANDOFF §۴ labels (staff-facing). */
export const SA_LABELS: Record<keyof SiteAnswers, [string, Record<string, string>]> = {
  amount_range: ['مبلغ', { up_to_50m: 'تا ۵۰ میلیون تومان', '50m_100m': '۵۰ تا ۱۰۰ میلیون تومان', '100m_300m': '۱۰۰ تا ۳۰۰ میلیون تومان', '300m_500m': '۳۰۰ تا ۵۰۰ میلیون تومان', over_500m: 'بیشتر از ۵۰۰ میلیون تومان', not_sure: 'هنوز نمی‌داند' }],
  loan_purpose: ['برای', { goods: 'خرید کالا', wedding: 'جهیزیه و ازدواج', medical: 'درمان', home: 'خانه و تعمیرات', business: 'کسب‌وکار', other: 'کار دیگر' }],
  job_status: ['شغل', { employee: 'کارمند', retired: 'بازنشسته', self_employed: 'آزاد', no_fixed_income: 'بدون درآمد ثابت' }],
  documents: ['مدارک', { payslip: 'فیش حقوقی', salary_deduction_cert: 'گواهی کسر از حقوق', sayadi_cheque: 'چک صیادی', guarantor: 'ضامن', none: 'هیچ‌کدام' }],
  has_military_card: ['پایان خدمت', { yes: 'دارد', no: 'ندارد', not_applicable: 'مشمول نیست' }],
  can_refer_retiree: ['معرفی بازنشسته', { yes: 'بله، می‌تواند معرفی کند', no: 'خیر' }],
  has_bounced_or_overdue: ['چک برگشتی / معوق', { yes: 'بله، دارد', no: 'خیر' }],
  need_timing: ['زمان نیاز', { this_week: 'همین هفته', this_month: 'این ماه', just_browsing: 'فقط دارد بررسی می‌کند' }],
};
export const SA_KEYS = Object.keys(SA_LABELS) as (keyof SiteAnswers)[];
export function saText(k: keyof SiteAnswers, v: unknown): string {
  const m = SA_LABELS[k][1];
  if (Array.isArray(v)) return v.map((x) => m[String(x)] ?? String(x)).join('، ');
  return v == null ? '' : m[String(v)] ?? String(v);
}

const SRC_FA: Record<string, string> = {
  'home-header': 'صفحه‌ی اصلی', 'home-hero-2': 'صفحه‌ی اصلی', 'home-steps': 'صفحه‌ی اصلی', 'home-mid-1': 'صفحه‌ی اصلی', 'home-calc': 'صفحه‌ی اصلی', home: 'صفحه‌ی اصلی',
  'plans-table': 'صفحه‌ی طرح‌ها', 'how-it-works': 'صفحه‌ی «چطور کار می‌کند»', contact: 'صفحه‌ی تماس', about: 'صفحه‌ی درباره‌ی ما',
  'vam-bedun-zamen': 'صفحه‌ی وام بدون ضامن', 'vam-fori-bedun-zamen': 'صفحه‌ی وام فوری بدون ضامن', 'vam-bedun-chek': 'صفحه‌ی وام بدون چک',
  'vam-fori-bedun-chek': 'صفحه‌ی وام فوری بدون چک', 'vam-fori': 'صفحه‌ی وام فوری', 'vam-ani': 'صفحه‌ی وام آنی', 'vam-ba-chek': 'صفحه‌ی وام با چک',
  'vam-ba-safte': 'صفحه‌ی وام با سفته', 'kharid-aghsati': 'صفحه‌ی خرید اقساطی',
};
export const srcFa = (src: string | null) => (!src ? 'سایت' : SRC_FA[src] ?? `صفحه‌ی «${src}»`);

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const faN = (n: number | string) => String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
const tz = 'Asia/Tehran';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
/** «امروز ۶ آبان، ساعت ۰۹:۱۲» / «دیروز …» / «۳ مهر ۱۴۰۵، ساعت …» (Tehran, Jalali). */
export function saWhen(iso: string, now = new Date(), withTime = true): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arab', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  const day = faN(p('day').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)));
  const year = faN(p('year').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)));
  const yest = new Date(now.getTime() - 86_400_000);
  const k = dayKey(d);
  const lead = k === dayKey(now) ? 'امروز ' : k === dayKey(yest) ? 'دیروز ' : '';
  const sameYear = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: tz, year: 'numeric' }).format(d) === new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: tz, year: 'numeric' }).format(now);
  const date = `${lead}${day} ${p('month')}${sameYear ? '' : ` ${year}`}`;
  if (!withTime) return date;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${date}، ساعت ${faN(hm)}`;
}

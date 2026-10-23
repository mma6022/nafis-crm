/** Central site constants. Contact info copied from the current live nafisvam.com build. */
export const SITE = {
  name: 'نفیس وام',
  nameEn: 'Nafis Vam',
  url: 'https://nafisvam.com',
  tagline: 'مسیر شفاف دریافت تسهیلات و وام',
  description:
    'نفیس وام، همراه شما برای شناخت گزینه‌های تسهیلات، وام فوری، وام بدون ضامن و انتخاب اقساط متناسب با شرایط واقعی زندگی.',
  /**
   * NO company phone (Mohammad 2026-10-23): the landline is not in service and must not appear anywhere. Every call /
   * messenger entry point opens the expert picker (src/data/experts.ts). scripts/check-guarantees.mjs fails the build
   * if the old landline appears in dist/ or src/ in any format.
   */
  /** the .com MX is live (webmail.nafisvam.com) */
  email: 'info@nafisvam.com',
  /**
   * Mohammad 2026-10-23 21:14: legal entity name ONLY (footer, /about, /contact, /terms, Organization schema). No national
   * ID / registration number anywhere: scripts/check-guarantees.mjs fails the build if it appears (Latin or Persian digits).
   */
  legalName: 'بهینه فام نفیس',
  /** PM decision: office address (footer, /contact, /about, PostalAddress schema) */
  address: 'تهران، پونک، بلوار عدل جنوبی، پلاک ۲۴، واحد ۲',
  addressParts: { streetAddress: 'پونک، بلوار عدل جنوبی، پلاک ۲۴، واحد ۲', addressLocality: 'تهران', addressRegion: 'تهران', addressCountry: 'IR' },
  instagram: 'https://instagram.com/nafisvamm',
  instagramHandle: 'nafisvamm',
  portal: 'https://crm.nafisvam.com/portal',
  /** final logo files by Omid (/workspace/nafis-design/logo) */
  logo: '/logo/nafis-logo-full.svg',
  logoPng: '/logo/nafis-logo-full.png',
  /** 1200×630 */
  ogImage: '/og-image.png',
  locale: 'fa_IR',
} as const;

/** Public social profile (Mohammad 2026-10-23). Messengers exist only per sales expert (src/data/experts.ts). */
export const SOCIAL = {
  instagram: { label: 'اینستاگرام', href: 'https://instagram.com/nafisvamm', handle: 'nafisvamm' },
} as const;

/** Sales experts: single source is src/data/experts.ts (import it directly; not re-exported here so client islands that use site.ts do not bundle it). */

/**
 * Callback / contact hours (PM-confirmed 2026-10-23): 09:00–18:00 Asia/Tehran; «صبح» = 9–13, «عصر» = 13–18.
 * Working days (Mohammad 2026-10-23): Saturday–Thursday; Friday closed (0 = Sunday … 6 = Saturday, JS getDay order).
 * Change `days` here only. The site never promises a number of minutes; the 15-minute SLA lives in the CRM only.
 */
export const WORK_HOURS = {
  tz: 'Asia/Tehran',
  start: 9,
  end: 18,
  /** «صبح» and «عصر» call windows (end exclusive) */
  morning: [9, 13] as const,
  evening: [13, 18] as const,
  /** Sat, Sun, Mon, Tue, Wed, Thu */
  days: [6, 0, 1, 2, 3, 4] as readonly number[],
  fa: '۹ صبح تا ۶ عصر',
  daysFa: 'شنبه تا پنجشنبه',
  /** short form used on /contact next to the experts */
  shortFa: 'شنبه تا پنجشنبه، ۹ تا ۱۸',
  /** schema.org openingHoursSpecification dayOfWeek */
  schemaDays: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
  daysConfirmed: true,
} as const;

/**
 * «یا در واتساپ بپرسید» link under the home callback lead. Empty = hidden. Never a wa.me link: every messenger entry
 * point opens the expert picker, and scripts/check-messengers.mjs fails the build on any wa.me / api.whatsapp /
 * whatsapp: link outside the picker and the /contact «کارشناسان فروش» block. If this is ever enabled, use '/contact/#experts'.
 */
export const CALLBACK_WHATSAPP = '';

/** The 6 keyword landing pages (UX-SPEC §3/§8). Order = menu/footer order. */
export const KEYWORD_PAGES = [
  { slug: 'vam-fori', label: 'وام فوری', blurb: 'طرح‌هایی با بررسی کمتر از ۷ روز', icon: 'clock' },
  { slug: 'vam-bedun-zamen', label: 'وام بدون ضامن', blurb: 'بدون نیاز به معرفی ضامن', icon: 'user' },
  { slug: 'vam-bedun-chek', label: 'وام بدون چک', blurb: 'بدون نیاز به چک صیادی', icon: 'check' },
  { slug: 'vam-ba-chek', label: 'وام با چک', blurb: 'با ضمانت چک صیادی خودتان یا دیگری', icon: 'cash' },
  { slug: 'vam-ba-safte', label: 'وام با سفته', blurb: 'ضمانت با سفته به‌جای چک', icon: 'coins' },
  { slug: 'kharid-aghsati', label: 'خرید اقساطی', blurb: '{goodsCount} طرح خرید کالا به‌صورت قسطی', icon: 'cart' },
] as const;

export type NavItem = { href: string; label: string };

export const MAIN_NAV: NavItem[] = [
  { href: '/plans', label: 'طرح‌ها' },
  { href: '/calculator', label: 'محاسبه قسط' },
  { href: '/how-it-works', label: 'مراحل دریافت' },
  { href: '/blog', label: 'مجله' },
  { href: '/about', label: 'درباره ما' },
  { href: '/contact', label: 'تماس' },
];

export const GUIDE_NAV: NavItem[] = [
  { href: '/calculator', label: 'محاسبه قسط' },
  { href: '/how-it-works', label: 'مراحل دریافت' },
  { href: '/faq', label: 'سؤالات متداول' },
  { href: '/blog', label: 'مجله نفیس' },
  { href: SITE.portal, label: 'ورود مشتریان' },
];

/**
 * Absolute URL in the form nginx serves without a redirect. Pages are built as `<path>/index.html` and nginx 301s
 * `/contact` → `/contact/`, so page URLs (canonical, og:url, JSON-LD, sitemap) always end with `/`; files whose last
 * segment has an extension (`/og-image.png`, `/rss.xml`) are left as they are.
 */
export const absoluteUrl = (path: string) => {
  const u = new URL(path, SITE.url);
  const last = u.pathname.split('/').pop() ?? '';
  if (!u.pathname.endsWith('/') && !last.includes('.')) u.pathname += '/';
  return u.toString();
};

/** Current Jalali year in Persian digits, computed at build time (footer «©»). */
export const jalaliYear = (d = new Date()) =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric' }).format(d).replace(/[^۰-۹]/g, '');

/** Confirmed by Mohammad (2026-10-23). Order is fixed: years, requests, customers. `b` = the bold part. */
export const TRUST_STATS = [
  { pre: '', b: '۷ سال', post: 'سابقه' },
  { pre: 'بیش از', b: '۳۰ هزار', post: 'درخواست وام' },
  { pre: 'بیش از', b: '۳٬۰۰۰', post: 'نفر وام‌گرفته' },
] as const;

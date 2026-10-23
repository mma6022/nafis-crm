/** Central site constants. Contact info copied from the current live nafisvam.com build. */
export const SITE = {
  name: 'نفیس وام',
  nameEn: 'Nafis Vam',
  url: 'https://nafisvam.com',
  tagline: 'مسیر شفاف دریافت تسهیلات و وام',
  description:
    'نفیس وام، همراه شما برای شناخت گزینه‌های تسهیلات، وام فوری، وام بدون ضامن و انتخاب اقساط متناسب با شرایط واقعی زندگی.',
  phone: '021-91303819',
  phoneFa: '۰۲۱-۹۱۳۰۳۸۱۹',
  phoneE164: '+982191303819',
  tel: 'tel:+982191303819',
  /** the .com MX is live (webmail.nafisvam.com) */
  email: 'info@nafisvam.com',
  /** Mohammad 2026-10-23: legal entity + national ID (شناسه ملی) — footer, /about, Organization schema */
  legalName: 'بهینه فام نفیس',
  nationalId: '14013708689',
  nationalIdFa: '۱۴۰۱۳۷۰۸۶۸۹',
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

/**
 * Public social profile (Mohammad 2026-10-23). The landline has NO messenger accounts, so there are no generic
 * WhatsApp/Telegram/Bale buttons anywhere; messengers exist only per sales expert on /contact (SALES_EXPERTS).
 */
export const SOCIAL = {
  instagram: { label: 'اینستاگرام', href: 'https://instagram.com/nafisvamm', handle: 'nafisvamm' },
} as const;

/**
 * /contact «کارشناسان فروش» (Mohammad 2026-10-23). Mobiles appear ONLY on /contact — never in the header, footer or
 * schema telephone. Messenger links checked 2026-10-23 with a mobile UA: wa.me/98… and t.me/+98… return 200
 * (both services also answer 200 for unknown numbers, so this proves the link format, not the account);
 * ble.ir/98… (no «+») returns the Bale chat page for all three numbers and 404 for an unknown number;
 * ble.ir/+98… is 404 and must not be used.
 */
export const SALES_EXPERTS = [
  { name: 'خانم قاسمی', mobile: '09003400452' },
  { name: 'خانم حسنی', mobile: '09003400462' },
  { name: 'آقای کاظمی', mobile: '09003400472' },
] as const;
export const expertLinks = (mobile: string) => {
  const intl = '98' + mobile.replace(/^0/, '');
  return {
    tel: `tel:+${intl}`,
    whatsapp: `https://wa.me/${intl}`,
    telegram: `https://t.me/+${intl}`,
    bale: `https://ble.ir/${intl}`,
  };
};

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
 * «یا در واتساپ بپرسید» link under the home callback lead. Empty = hidden. Set when Mohammad gives the real link
 * (e.g. 'https://wa.me/98912…'); never ship the bare https://wa.me/ placeholder here.
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

/** No trailing slash (trailingSlash: 'never'), except the home page, which is always `https://nafisvam.com/` (matches the sitemap). */
export const absoluteUrl = (path: string) => {
  const u = new URL(path, SITE.url).toString();
  return u === `${SITE.url}/` ? u : u.replace(/\/$/, '');
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

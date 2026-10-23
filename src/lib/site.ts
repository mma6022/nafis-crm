/** Central site constants. Contact info copied from the current live nafisvam.com build. */
export const SITE = {
  name: 'نفیس وام',
  nameEn: 'Nafis Vam',
  url: 'https://nafisvam.com',
  tagline: 'مسیر شفاف دریافت تسهیلات و وام',
  description:
    'نفیس وام، همراه شما برای شناخت گزینه‌های تسهیلات، وام فوری، وام بدون ضامن و انتخاب اقساط متناسب با شرایط واقعی زندگی.',
  phone: '021-91090380',
  phoneFa: '۰۲۱-۹۱۰۹۰۳۸۰',
  phoneE164: '+982191090380',
  tel: 'tel:02191090380',
  /** [تأیید محمد: MX دامنه .com فعال است و به webmail.nafisvam.com اشاره دارد] */
  email: 'info@nafisvam.com',
  portal: 'https://crm.nafisvam.com/portal',
  logo: '/brand/nafis-logo@2x.webp',
  logoPng: '/brand/nafis-logo@2x.png',
  ogImage: '/brand-logo.png', // TODO(spec): replace with a 1200×630 OG image
  locale: 'fa_IR',
} as const;

/**
 * Messenger links. [جای‌خالی: لینک‌ها از محمد] Until Mohammad supplies them, the links point at the bare
 * service URL and carry data-todo so they are easy to find; nothing is invented.
 */
export const MESSENGERS = {
  whatsapp: { label: 'واتساپ', href: 'https://wa.me/', todo: true },
  telegram: { label: 'تلگرام', href: 'https://t.me/', todo: true },
  bale: { label: 'بله', href: 'https://ble.ir/', todo: true },
  instagram: { label: 'اینستاگرام', href: 'https://www.instagram.com/', todo: true },
} as const;
export const PLACEHOLDER_MESSENGERS = '[جای‌خالی: لینک‌ها از محمد]';

/** The 6 keyword landing pages (UX-SPEC §3/§8). Order = menu/footer order. */
export const KEYWORD_PAGES = [
  { slug: 'vam-fori', label: 'وام فوری', blurb: 'طرح‌هایی با بررسی کمتر از ۷ روز', icon: 'clock' },
  { slug: 'vam-bedun-zamen', label: 'وام بدون ضامن', blurb: 'بدون نیاز به معرفی ضامن', icon: 'user', marker: '[تأیید محمد]' },
  { slug: 'vam-bedun-chek', label: 'وام بدون چک', blurb: 'بدون نیاز به چک صیادی', icon: 'check', marker: '[تأیید محمد]' },
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

export const absoluteUrl = (path: string) => new URL(path, SITE.url).toString().replace(/\/$/, '') || SITE.url;

/** Current Jalali year in Persian digits, computed at build time (footer «©»). */
export const jalaliYear = (d = new Date()) =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric' }).format(d).replace(/[^۰-۹]/g, '');

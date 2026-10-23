/** Central site constants. Contact info copied from the current live nafisvam.com build. */
export const SITE = {
  name: 'نفیس وام',
  nameEn: 'Nafis Vam',
  url: 'https://nafisvam.com',
  tagline: 'مسیر شفاف دریافت تسهیلات و وام',
  description:
    'نفیس وام، همراه شما برای شناخت گزینه‌های تسهیلات، وام فوری، وام بدون ضامن و انتخاب اقساط متناسب با شرایط واقعی زندگی.',
  phone: '021-91090380',
  phoneE164: '+982191090380',
  email: 'hello@nafisvam.ir',
  logo: '/brand-logo.png',
  ogImage: '/brand-logo.png', // TODO(spec): replace with a 1200×630 OG image
  locale: 'fa_IR',
} as const;

export type NavItem = { href: string; label: string };

export const MAIN_NAV: NavItem[] = [
  { href: '/services', label: 'خدمات' },
  { href: '/loan-plans', label: 'طرح‌های وام' },
  { href: '/calculator', label: 'محاسبه قسط' },
  { href: '/blog', label: 'مجله' },
  { href: '/faq', label: 'سوالات متداول' },
  { href: '/about', label: 'درباره ما' },
  { href: '/contact', label: 'تماس' },
];

export const FOOTER_NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'دسترسی سریع',
    items: [
      { href: '/request', label: 'درخواست وام' },
      { href: '/loan-plans', label: 'طرح‌های فعال' },
      { href: '/calculator', label: 'محاسبه‌گر اقساط' },
      { href: '/services', label: 'خدمات' },
    ],
  },
  {
    title: 'نفیس وام',
    items: [
      { href: '/about', label: 'درباره ما' },
      { href: '/blog', label: 'مجله آموزشی' },
      { href: '/faq', label: 'سوالات متداول' },
      { href: '/contact', label: 'تماس با ما' },
    ],
  },
  {
    title: 'قوانین',
    items: [
      { href: '/privacy', label: 'حریم خصوصی' },
      { href: '/terms', label: 'شرایط استفاده' },
    ],
  },
];

export const absoluteUrl = (path: string) => new URL(path, SITE.url).toString().replace(/\/$/, '') || SITE.url;

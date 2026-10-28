/**
 * Home hero «صفر تا صد» — approved copy (Mohammad t627u/t628u via PM, ۸ آبان ۱۴۰۵). Use verbatim; tests/home-hero.test.ts
 * pins every string. The slogan is split around the emphasised phrase only for styling; its text content is unchanged.
 */
import type { SpriteIcon } from '../components/ui/I';

export const HERO_SEFR = {
  sloganBefore: 'نفیس وام؛ از ',
  sloganEm: 'صفر تا صدِ',
  sloganAfter: ' وامت، کنارتیم', // rendered as ' ' + nowrap span «وامت، کنارتیم» (Armita .nvh-nw)
  lead: 'بدون رفت‌وآمد، بدون سردرگمی. یه کارشناس اختصاصی از اولین تماس تا واریز وام همراهته و همه‌ی مراحل غیرحضوری و آنلاین انجام می‌شه.',
  badges: [
    { icon: 'user', text: 'کارشناس اختصاصی، فقط برای تو' },
    { icon: 'layers', text: 'صفر تا صد کار با ما' },
    { icon: 'online', text: 'کاملاً آنلاین و غیرحضوری' },
  ] as { icon: SpriteIcon; text: string }[],
  cta: 'ثبت درخواست',
  /** /request + `src=home-top` (PM 10-29, Armita HANDOFF §۷.۱); trailing slash like every other /request/ link (no 301) */
  href: '/request/?src=home-top',
} as const;

export const heroSlogan = (h = HERO_SEFR) => h.sloganBefore + h.sloganEm + h.sloganAfter;

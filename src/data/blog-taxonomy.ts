/**
 * Blog categories: fixed list with ASCII slugs (clean, stable URLs) and Persian labels.
 * Add a category here before using it in a post's frontmatter.
 */
export const CATEGORIES = {
  'vam-fori': { label: 'وام فوری', description: 'وام سریع در عمل چقدر طول می‌کشد و چطور سریع‌ترش کنیم.' },
  zemanat: { label: 'ضمانت وام', description: 'چک، سفته، ضامن و طرح‌های بدون ضامن یا بدون چک.' },
  'kharid-aghsati': { label: 'خرید اقساطی', description: 'خرید با پرداخت در چند ماه، پیش‌پرداخت و انتخاب طرح.' },
  aghsat: { label: 'بازپرداخت و برنامه‌ریزی مالی', description: 'مدت بازپرداخت، مدیریت بازپرداخت و برنامه‌ریزی مالی.' },
  etebarsanji: { label: 'اعتبارسنجی', description: 'رتبه اعتباری، اعتبارسنجی بانکی و راه‌های بهبود آن.' },
  rahnama: { label: 'راهنمای وام', description: 'آموزش قدم‌به‌قدم انواع وام و تسهیلات.' },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as [CategoryKey, ...CategoryKey[]];

/** Posts may use the slug or the Persian label in frontmatter (content team writes «ضمانت وام»). */
export function categoryKey(v: string): CategoryKey | undefined {
  const t = v.trim();
  if (t in CATEGORIES) return t as CategoryKey;
  return (Object.keys(CATEGORIES) as CategoryKey[]).find((k) => CATEGORIES[k].label === t);
}

/**
 * Tags are free Persian text in frontmatter. URL slug keeps Persian letters (Google indexes them fine;
 * the browser/sitemap percent-encode them), normalises Arabic ي/ك → ی/ک, and turns spaces/ZWNJ into "-".
 */
export function tagSlug(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u200c\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

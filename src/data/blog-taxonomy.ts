/**
 * Blog categories: fixed list with ASCII slugs (clean, stable URLs) and Persian labels.
 * Add a category here before using it in a post's frontmatter.
 */
export const CATEGORIES = {
  'loan-guide': { label: 'راهنمای وام', description: 'آموزش قدم‌به‌قدم انواع وام و تسهیلات.' },
  installments: { label: 'اقساط و بازپرداخت', description: 'محاسبه قسط، مدیریت بازپرداخت و برنامه‌ریزی مالی.' },
  'credit-score': { label: 'اعتبارسنجی', description: 'رتبه اعتباری، اعتبارسنجی بانکی و راه‌های بهبود آن.' },
  'financial-literacy': { label: 'سواد مالی', description: 'مفاهیم پایه مالی به زبان ساده.' },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as [CategoryKey, ...CategoryKey[]];

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

const FA = '۰۱۲۳۴۵۶۷۸۹';
/** U+066C ARABIC THOUSANDS SEPARATOR, not ASCII comma or U+060C. */
export const FA_THOUSANDS = '\u066C';
/** U+066B ARABIC DECIMAL SEPARATOR. */
export const FA_DECIMAL = '\u066B';

export function faDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA[Number(d)]!);
}

/** Persian digits with U+066C thousands separator (۱۲٬۴۰۰٬۰۰۰). */
export function faNum(n: number, frac = 0): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const fixed = frac > 0 ? abs.toFixed(frac) : String(Math.round(abs));
  const [a, b] = fixed.split('.');
  const g = a!.replace(/\B(?=(\d{3})+(?!\d))/g, FA_THOUSANDS);
  return faDigits(sign + g + (b != null ? FA_DECIMAL + b : ''));
}

export function faPct(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  const frac = Math.abs(rounded - Math.round(rounded)) < 1e-9 ? 0 : 1;
  return faNum(rounded, frac) + '٪';
}
export function faToman(n: number): string { return faNum(Math.round(n)) + ' تومان'; }

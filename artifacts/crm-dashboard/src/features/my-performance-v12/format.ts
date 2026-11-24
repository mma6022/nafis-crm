import { deltaText, faDuration, faNum as faNumV11 } from '../my-performance-v11/format';

const FA = '۰۱۲۳۴۵۶۷۸۹';

export function faDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA[Number(d)]!);
}

/** Persian digits with ٬ thousands separator (۱۲٬۴۰۰٬۰۰۰). */
export function faNum(n: number, frac = 0): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const fixed = frac > 0 ? abs.toFixed(frac) : String(Math.round(abs));
  const [a, b] = fixed.split('.');
  const g = a!.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return faDigits(sign + g + (b != null ? '٫' + b : ''));
}

export function faPct(n: number): string { return faNum(n, 1) + '٪'; }
export function faToman(n: number): string { return faNum(Math.round(n)) + ' تومان'; }
export { deltaText, faDuration, faNumV11 };

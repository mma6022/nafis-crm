import type { MpDelta } from './api';

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (s: string | number) => String(s).replace(/\d/g, (d) => FA[Number(d)] ?? d);

/** Thousands separator is «٬», never «,». */
export function faNum(n: number): string {
  const sign = n < 0 ? '−' : '';
  const body = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return sign + faDigits(body);
}

export function faDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${faNum(h)} ساعت و ${faNum(m)} دقیقه`;
  if (h) return `${faNum(h)} ساعت`;
  return `${faNum(m)} دقیقه`;
}

/** Mockup: ۱۲٪+ / ۲− / بدون تغییر. ٪ is the same size and color as the number. */
export function deltaText(d: MpDelta): { cls: string; text: string } | null {
  if (d.kind === 'none') return null;
  if (d.kind === 'flat') return { cls: 'flat', text: 'بدون تغییر' };
  const neg = d.kind === 'down' || (d.kind === 'unit' && d.pct < 0);
  const n = faNum(Math.abs(d.pct));
  const sign = neg ? '−' : '+';
  const text = d.kind === 'unit' ? `${n}${sign}` : `${n}٪${sign}`;
  return { cls: neg ? 'down' : 'up', text };
}

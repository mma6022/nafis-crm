/* links v1.0: the browser mirror of api-server/src/lib/link-page.ts buildUrl (instant feedback only; the server is the gate). */
export type Ask = 'user' | 'mob' | 'url' | 'phone' | 'email' | 'page' | 'lead';
export const TY: Record<string, { n: string; lg: string; ask: Ask; base?: string; f?: string }> = {
  ig: { n: 'اینستاگرام', lg: 'ig', ask: 'user', base: 'https://instagram.com/', f: 'نام کاربری اینستاگرام' },
  wa: { n: 'واتساپ', lg: 'wa', ask: 'mob', base: 'https://wa.me/98', f: 'شماره‌ی واتساپ' },
  bale: { n: 'بله', lg: 'bale', ask: 'user', base: 'https://ble.ir/', f: 'نام کاربری یا نام کانال در بله' },
  tg: { n: 'تلگرام', lg: 'tg', ask: 'user', base: 'https://t.me/', f: 'نام کاربری یا نام کانال در تلگرام' },
  eitaa: { n: 'ایتا', lg: 'eitaa', ask: 'user', base: 'https://eitaa.com/', f: 'نام کاربری یا نام کانال در ایتا' },
  rubika: { n: 'روبیکا', lg: 'rubika', ask: 'user', base: 'https://rubika.ir/', f: 'نام کاربری یا نام کانال در روبیکا' },
  li: { n: 'لینکدین', lg: 'li', ask: 'url', f: 'آدرس صفحه در لینکدین' },
  aparat: { n: 'آپارات', lg: 'aparat', ask: 'user', base: 'https://aparat.com/', f: 'نام کانال در آپارات' },
  tel: { n: 'تماس تلفنی', lg: 'tel', ask: 'phone', base: 'tel:', f: 'شماره‌ی تلفن' },
  sms: { n: 'پیامک', lg: 'sms', ask: 'phone', base: 'sms:', f: 'شماره‌ی پیامک' },
  mail: { n: 'ایمیل', lg: 'mail', ask: 'email', base: 'mailto:', f: 'آدرس ایمیل' },
  map: { n: 'آدرس روی نقشه', lg: 'map', ask: 'url', f: 'لینک مکان از نشان، بلد یا گوگل‌مپ' },
  site: { n: 'صفحه‌ی سایت', lg: 'nafis', ask: 'page' },
  lead: { n: 'فرم درخواست وام', lg: 'nafis', ask: 'lead' },
  web: { n: 'لینک دلخواه', lg: 'web', ask: 'url', f: 'آدرس کامل' },
};
export const TGRP: [string, string[]][] = [['پیام‌رسان و شبکه‌ی اجتماعی', ['ig', 'wa', 'bale', 'tg', 'eitaa', 'rubika', 'li', 'aparat']], ['تماس', ['tel', 'sms', 'mail', 'map']], ['سایت نفیس وام', ['lead', 'site']], ['دیگر', ['web']]];
export const LOGOS: [string, string][] = [['nafis', 'نفیس وام'], ['ig', 'اینستاگرام'], ['wa', 'واتساپ'], ['bale', 'بله'], ['tg', 'تلگرام'], ['eitaa', 'ایتا'], ['rubika', 'روبیکا'], ['li', 'لینکدین'], ['aparat', 'آپارات'], ['tel', 'تلفن'], ['sms', 'پیامک'], ['mail', 'ایمیل'], ['map', 'نقشه'], ['web', 'وب‌سایت']];
export const LN: Record<string, string> = Object.fromEntries(LOGOS);
export const MSG = {
  user: 'نام کاربری فقط حرف انگلیسی، عدد، نقطه و زیرخط دارد؛ فاصله ندارد.',
  mob: 'شماره‌ی موبایل ۱۱ رقم است و با ۰۹ شروع می‌شود.',
  phone: 'شماره‌ی تلفن را با کد شهر یا به شکل موبایل بنویس؛ فقط رقم.',
  email: 'نشانی ایمیل درست نیست؛ مثل name@example.com.',
  url: 'آدرس کامل با https:// بنویس؛ لینک‌های دیگر پذیرفته نمی‌شوند.',
  page: 'یکی از صفحه‌های سایت را انتخاب کن.',
};
const USER_HOSTS: Record<string, RegExp> = { ig: /^(?:www\.)?instagram\.com$/i, bale: /^(?:www\.)?ble\.ir$/i, tg: /^(?:www\.)?(?:t\.me|telegram\.me)$/i, eitaa: /^(?:www\.)?eitaa\.com$/i, rubika: /^(?:www\.)?rubika\.ir$/i, aparat: /^(?:www\.)?aparat\.com$/i };
const FD = '۰۱۲۳۴۵۶۷۸۹', AD = '٠١٢٣٤٥٦٧٨٩';
const lat = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FD.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AD.indexOf(d)));
export const fa = (n: number | string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '٬').replace(/[0-9]/g, (d) => FD[+d]);
export const charLen = (s: string) => [...s].filter((c) => c !== '\u200c').length;
export function parseUsername(raw: string, type: string) {
  let v = lat(raw.trim()); const m = /^(?:https?:\/\/)?([^/?#\s]+)\/+([^?#\s]*)/i.exec(v);
  if (m && USER_HOSTS[type]?.test(m[1])) v = m[2].split('/').filter(Boolean)[0] ?? '';
  v = v.replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9._]{0,30}[A-Za-z0-9_])?$/.test(v) && !v.includes('..') ? v : null;
}
export function parseMobile(raw: string) {
  let v = lat(raw).replace(/[\s\-()]/g, '');
  if (v.startsWith('+98')) v = '0' + v.slice(3); else if (/^0098/.test(v)) v = '0' + v.slice(4); else if (/^98\d{10}$/.test(v)) v = '0' + v.slice(2); else if (/^9\d{9}$/.test(v)) v = '0' + v;
  return /^09\d{9}$/.test(v) ? v : null;
}
export function parsePhone(raw: string) {
  const m = parseMobile(raw); if (m) return m;
  let v = lat(raw).replace(/[\s\-()]/g, ''); if (v.startsWith('+98')) v = '0' + v.slice(3);
  return /^0[1-8]\d{9}$/.test(v) || /^[1-9]\d{3,7}$/.test(v) ? v : null;
}
export function parseHttps(raw: string) {
  const v = raw.trim(); if (v.length > 500 || /\s/.test(v)) return null;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) ? u.href : null; } catch { return null; }
}
export const parseEmail = (raw: string) => { const v = raw.trim(); return v.length <= 120 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v) ? v : null; };
export function buildUrl(type: string, raw: string, sitePages: [string, string][], leadUrl: string): { ok: true; value: string; url: string } | { ok: false; error: string } {
  const t = TY[type]; if (!t) return { ok: false, error: '' };
  switch (t.ask) {
    case 'user': { const u = parseUsername(raw, type); return u ? { ok: true, value: u, url: t.base + u } : { ok: false, error: MSG.user }; }
    case 'mob': { const m = parseMobile(raw); return m ? { ok: true, value: m, url: t.base! + m.slice(1) } : { ok: false, error: MSG.mob }; }
    case 'phone': { const p = parsePhone(raw); return p ? { ok: true, value: p, url: t.base + p } : { ok: false, error: MSG.phone }; }
    case 'email': { const e = parseEmail(raw); return e ? { ok: true, value: e, url: t.base + e } : { ok: false, error: MSG.email }; }
    case 'url': { const u = parseHttps(raw); return u ? { ok: true, value: u, url: u } : { ok: false, error: MSG.url }; }
    case 'page': { const p = sitePages.find(([, path]) => path === raw); return p ? { ok: true, value: p[1], url: 'https://nafisvam.com' + (p[1] === '/' ? '/' : p[1] + '/') } : { ok: false, error: MSG.page }; }
    case 'lead': return { ok: true, value: '', url: leadUrl };
  }
}
/** what the list shows under the title: the address without https:// */
export const shown = (url: string) => url.replace(/^https:\/\//, '').replace(/^mailto:/, 'mailto:');

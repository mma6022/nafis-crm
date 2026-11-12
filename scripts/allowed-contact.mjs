/** Exact company contact values allowed by site-credit-noinst v1.2 (Mohammad t340u / t342u).
 *  Anything else (mobiles, other tel:, WhatsApp, Telegram, other ble.ir) stays banned. */
export const COMPANY_TEL = '02191303819';
export const COMPANY_TEL_E164 = '+982191303819';
export const COMPANY_TEL_FA = '۰۲۱-۹۱۳۰۳۸۱۹';
export const BALE_URL = 'https://ble.ir/nafisvambot';
export const BALE_EXTS = ['210', '211', '212'];

export const ALLOWED_TEL_HREFS = new Set([
  `tel:${COMPANY_TEL}`,
  ...BALE_EXTS.map((e) => `tel:${COMPANY_TEL},${e}`),
]);

const trimSlash = (u) => String(u).replace(/\/+$/, '');

export function isAllowedTelHref(href) {
  return ALLOWED_TEL_HREFS.has(String(href).trim());
}

export function isAllowedBaleUrl(url) {
  const s = trimSlash(String(url).trim());
  return s === BALE_URL || s === BALE_URL.replace('https://', 'http://');
}

/** Longest-first literals to strip before a landline / messenger scan. */
export const ALLOWED_LITERALS = [
  ...[...ALLOWED_TEL_HREFS].sort((a, b) => b.length - a.length),
  BALE_URL,
  COMPANY_TEL_E164,
  COMPANY_TEL_FA,
  COMPANY_TEL,
].sort((a, b) => b.length - a.length);

export function stripAllowedContact(t) {
  let s = String(t);
  for (const lit of ALLOWED_LITERALS) s = s.split(lit).join(' ');
  return s;
}

export function isAllowedMessengerUrl(url) {
  const raw = String(url).trim();
  const s = trimSlash(raw.replace(/[)'"\s]+$/, ''));
  if (isAllowedBaleUrl(s)) return true;
  if (s.startsWith('tel:') && isAllowedTelHref(s)) return true;
  return false;
}

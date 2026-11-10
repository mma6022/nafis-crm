/** Jalali ↔ Gregorian day helpers for the sales-performance custom range.
 *  The API keeps Gregorian/Tehran-day params; the picker stores Jalali values.
 */
import { gregorianToJalaliValue, jalaliValueToGregorian } from '../../lib/jalali';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const ARAB = '٠١٢٣٤٥٦٧٨٩';

function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARAB.indexOf(d)));
}

/** Gregorian YYYY-MM-DD or Jalali YYYY/MM/DD (Persian or Latin digits) → API Gregorian day. */
export function toApiDay(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const latin = toLatinDigits(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(latin)) return latin;
  return jalaliValueToGregorian(latin);
}

/** Gregorian YYYY-MM-DD (or Jalali) → Jalali YYYY/MM/DD for PersianDatePicker. */
export function toJalaliValue(value: string | null | undefined): string {
  const api = toApiDay(value);
  return api ? gregorianToJalaliValue(api) : '';
}

/** Visible field text, same style as the range caption: «۱۹ آبان ۱۴۰۵». */
export function formatSpJalaliField(value: string | null | undefined): string {
  const api = toApiDay(value);
  if (!api) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${api}T12:00:00.000Z`));
}

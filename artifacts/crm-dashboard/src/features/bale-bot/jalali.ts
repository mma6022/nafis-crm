/** Jalali calendar dates for bale-bot / KB admin, matching Armita's order
 *  «پنجشنبه ۷ آبان ۱۴۰۵» (weekday, day, month name, year).
 *  Uses formatToParts so we do not depend on fa-IR's default field order. */
const TZ = 'Asia/Tehran';

export function jalaliWeekdayDate(iso: string | null | undefined, timeZone = TZ): string {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const day = get('day');
  const month = get('month');
  const year = get('year');
  if (!weekday || !day || !month || !year) return '';
  return `${weekday} ${day} ${month} ${year}`;
}

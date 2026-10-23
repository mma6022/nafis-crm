// «زمان» row on the payment receipt: «امروز ۱۰:۲۴», «دیروز ۲۳:۰۵», otherwise «۲۹ مهر ۱۴۰۵، ۱۰:۲۴».
// Always Tehran time (the receipt is about an Iranian gateway), Persian digits, Persian calendar.
const TZ = 'Asia/Tehran';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const clock = new Intl.DateTimeFormat('fa-IR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });

export function receiptTime(value: string | null | undefined, now: Date = new Date()): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const t = clock.format(d);
  const k = dayKey(d);
  if (k === dayKey(now)) return `امروز ${t}`;
  if (k === dayKey(new Date(now.getTime() - 86_400_000))) return `دیروز ${t}`;
  return `${date.format(d)}، ${t}`;
}

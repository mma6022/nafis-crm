const persianDateFormatter = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});

export function persianParts(date: Date) {
  const values = Object.fromEntries(
    persianDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: values.year, month: values.month, day: values.day };
}

function findGregorianDate(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const searchStart = Date.UTC(year + 621, 1, 15);
  for (let offset = 0; offset < 410; offset += 1) {
    const candidate = new Date(searchStart + offset * 86_400_000);
    const parts = persianParts(candidate);
    if (parts.year === year && parts.month === month && parts.day === day) return candidate;
  }
  return null;
}

export function formatJalaliValue(year: number, month: number, day: number) {
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

export function parseJalaliValue(value: string) {
  const latin = value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const match = latin.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return findGregorianDate(year, month, day) ? { year, month, day } : null;
}

export function jalaliValueToGregorian(value: string) {
  const parts = parseJalaliValue(value);
  if (!parts) return undefined;
  const date = findGregorianDate(parts.year, parts.month, parts.day);
  return date ? date.toISOString().slice(0, 10) : undefined;
}

export function jalaliValueToDate(value: string) {
  const gregorian = jalaliValueToGregorian(value);
  return gregorian ? new Date(`${gregorian}T12:00:00.000Z`) : undefined;
}

export function dateToJalaliValue(date: Date) {
  const parts = persianParts(date);
  return formatJalaliValue(parts.year, parts.month, parts.day);
}

export function todayJalali() {
  return persianParts(new Date());
}

export function defaultReminderJalali() {
  const future = new Date(Date.now() + 30 * 60_000);
  const date = persianParts(future);
  const timeFormatter = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Tehran',
  });
  const values = Object.fromEntries(
    timeFormatter
      .formatToParts(future)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return { ...date, hour: values.hour, minute: values.minute };
}

export function jalaliToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const candidate = findGregorianDate(year, month, day);
  if (!candidate) return null;
  const tehranOffsetMinutes = 3 * 60 + 30;
  return new Date(
    Date.UTC(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      hour,
      minute,
    ) - tehranOffsetMinutes * 60_000,
  ).toISOString();
}
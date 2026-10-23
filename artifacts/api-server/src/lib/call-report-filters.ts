/** Date-only report bounds represent full calendar days in Iran, including the end day. */
export function callReportDateBounds(input: { from?: string; to?: string }) {
  const midnight = (day: string) => {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day + "T00:00:00Z")) ||
        new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day) {
      throw new Error("تاریخ گزارش معتبر نیست.");
    }
    return Date.parse(day + "T00:00:00+03:30");
  };
  const start = input.from === undefined ? undefined : midnight(input.from);
  const end = input.to === undefined ? undefined : midnight(input.to);
  if (start !== undefined && end !== undefined && start > end)
    throw new Error("تاریخ شروع نباید بعد از تاریخ پایان باشد.");
  return {
    start: start === undefined ? undefined : new Date(start).toISOString(),
    endExclusive: end === undefined ? undefined : new Date(end + 86_400_000).toISOString(),
  };
}

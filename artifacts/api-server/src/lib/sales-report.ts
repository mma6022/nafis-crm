/** Read-only sales analytics. Calendar days are Tehran days, not UTC days. */
const DAY = 86_400_000;
const OFFSET = 210 * 60_000;
const persian = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
export type ReportPeriod = "day" | "week" | "month" | "quarter" | "custom";
export type ReportInput = { period?: string; anchor?: string; from?: string; to?: string; granularity?: string };
export type CustomerRow = { id: number; phone: string; created_at: string; salesperson_id: number | null };
export type CallRow = { customer_id: number; created_at: string; status: string | null; mobile_answered_at?: string | null };
export type ApplicationRow = { id: number; customer_id: number; created_at: string; requested_amount: string | number | null; is_pre_registration: number | null };
export function dayNumber(value: string): number {
  // SQLite's legacy timestamps without a zone represent UTC.
  const text = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? Math.floor((ms + OFFSET) / DAY) : NaN;
}
const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
function parseDay(day: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw new Error("تاریخ گزارش معتبر نیست.");
  const n = Date.parse(day + "T00:00:00Z") / DAY;
  if (!Number.isInteger(n) || isoDay(n) !== day) throw new Error("تاریخ گزارش معتبر نیست.");
  return n;
}
function parts(day: number) {
  const p = Object.fromEntries(persian.formatToParts(new Date(day * DAY)).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day };
}
const calendarCache = new Map<string, number>();
function monthStart(year: number, month: number) {
  if (month < 1) { year--; month += 12; }
  if (month > 12) { year++; month -= 12; }
  const key = `${year}-${month}`;
  const cached = calendarCache.get(key);
  if (cached !== undefined) return cached;
  const base = Date.UTC(year + 621, 1, 15) / DAY;
  for (let i = 0; i < 410; i++) {
    const p = parts(base + i);
    if (p.year === year && p.month === month && p.day === 1) {
      calendarCache.set(key, base + i); return base + i;
    }
  }
  throw new Error("تاریخ خارج از محدودهٔ تقویم است.");
}
const weekStart = (n: number) => n - ((new Date(n * DAY).getUTCDay() + 1) % 7);
export function reportRange(input: ReportInput, now = new Date()) {
  const period = input.period ?? "day";
  if (!["day", "week", "month", "quarter", "custom"].includes(period)) throw new Error("نوع بازه گزارش معتبر نیست.");
  const anchor = input.anchor ? parseDay(input.anchor) : dayNumber(now.toISOString());
  const p = parts(anchor);
  let start = anchor, end = anchor;
  if (period === "week") { start = weekStart(anchor); end = start + 6; }
  if (period === "month") { start = monthStart(p.year, p.month); end = monthStart(p.year, p.month + 1) - 1; }
  if (period === "quarter") {
    const month = Math.floor((p.month - 1) / 3) * 3 + 1;
    start = monthStart(p.year, month); end = monthStart(p.year, month + 3) - 1;
  }
  if (period === "custom") {
    if (!input.from || !input.to) throw new Error("شروع و پایان بازه را انتخاب کنید.");
    start = parseDay(input.from); end = parseDay(input.to);
  }
  if (start > end || end - start > 365) throw new Error("بازه باید حداکثر ۳۶۶ روز و پایان پس از شروع باشد.");
  const granularity = input.granularity ?? (end - start > 95 ? "week" : "day");
  if (!["day", "week", "month"].includes(granularity)) throw new Error("گام نمودار معتبر نیست.");
  return { period: period as ReportPeriod, start, end, anchor: period === "custom" ? end : anchor, granularity, from: isoDay(start), to: isoDay(end), timezone: "Asia/Tehran" };
}
/** Only load activity needed for the selected window and its reference month. */
export function reportQueryWindow(input: ReportInput, now = new Date()) {
  const range = reportRange(input, now), p = parts(range.anchor);
  const start = Math.min(range.start, monthStart(p.year, p.month));
  const end = Math.max(range.end, monthStart(p.year, p.month + 1) - 1);
  return { from: new Date(start * DAY - OFFSET).toISOString(), until: new Date((end + 1) * DAY - OFFSET).toISOString() };
}
export type SalesMetric = {
  leads: number; contacted: number; answered: number; unanswered: number; unknownOutcome: number;
  requesters: number; caseCustomers: number; requests: number; cases: number; requestedAmount: string;
  contactedRequesters: number; contactedCaseCustomers: number; contactedRequestRate: number | null;
  contactRate: number | null; noAnswerRate: number | null; requestRate: number | null; caseRate: number | null; requestShare: number | null;
};
const rate = (n: number, d: number) => d ? Math.round(n * 10000 / d) / 100 : null;
function phoneKey(phone: string, id: number) {
  let value = String(phone ?? "").replace(/[۰-۹]/g, x => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x))).replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).replace(/\D/g, "");
  if (value.startsWith("0098")) value = "0" + value.slice(4);
  else if (value.startsWith("98") && value.length === 12) value = "0" + value.slice(2);
  else if (value.length === 10 && value.startsWith("9")) value = "0" + value;
  return value || `customer:${id}`;
}
export function buildSalesReport(customers: CustomerRow[], calls: CallRow[], applications: ApplicationRow[], input: ReportInput, now = new Date()) {
  const range = reportRange(input, now);
  type Lead = { key: string; created: number; calls: Array<{ day: number; outcome: "yes" | "no" | "unknown" }>; apps: Array<ApplicationRow & { day: number }> };
  const leads = new Map<string, Lead>(), byId = new Map<number, Lead>();
  for (const c of customers) {
    const key = phoneKey(c.phone, c.id), created = dayNumber(c.created_at);
    let lead = leads.get(key);
    if (!lead) { lead = { key, created, calls: [], apps: [] }; leads.set(key, lead); }
    else if (Number.isFinite(created) && (!Number.isFinite(lead.created) || created < lead.created)) lead.created = created;
    byId.set(c.id, lead);
  }
  for (const call of calls) {
    const lead = byId.get(call.customer_id);
    if (!lead) continue;
    const status = (call.status ?? "").toUpperCase().replace(/[\s-]/g, "_");
    const outcome = call.mobile_answered_at || ["ANSWERED", "CONNECTED"].includes(status) ? "yes"
      : ["NO_ANSWER", "NOANSWER", "MISSED", "BUSY", "REJECTED", "FAILED", "CANCEL", "CANCELLED", "CANCELED"].includes(status) ? "no" : "unknown";
    lead.calls.push({ day: dayNumber(call.created_at), outcome });
  }
  for (const app of applications) byId.get(app.customer_id)?.apps.push({ ...app, day: dayNumber(app.created_at) });
  const all = [...leads.values()];
  function metrics(selected: Lead[], from: number, to: number, allRequesters?: number): SalesMetric {
    let contacted = 0, answered = 0, unanswered = 0, unknownOutcome = 0, requesters = 0, caseCustomers = 0, requests = 0, cases = 0, amount = 0n, contactedRequesters = 0, contactedCaseCustomers = 0;
    for (const lead of selected) {
      const currentCalls = lead.calls.filter(c => c.day >= from && c.day <= to);
      if (currentCalls.length) {
        contacted++;
        if (currentCalls.some(c => c.outcome === "yes")) answered++;
        else if (currentCalls.some(c => c.outcome === "unknown")) unknownOutcome++;
        else unanswered++;
      }
      const currentApps = lead.apps.filter(a => a.day >= from && a.day <= to);
      if (currentApps.length) requesters++;
      if (currentApps.some(a => !a.is_pre_registration)) caseCustomers++;
      if (currentCalls.length && currentApps.length) contactedRequesters++;
      if (currentCalls.length && currentApps.some(a => !a.is_pre_registration)) contactedCaseCustomers++;
      requests += currentApps.length; cases += currentApps.filter(a => !a.is_pre_registration).length;
      for (const app of currentApps) {
        const value = String(app.requested_amount ?? "");
        if (/^\d+$/.test(value)) amount += BigInt(value);
      }
    }
    return { leads: selected.length, contacted, answered, unanswered, unknownOutcome, requesters, caseCustomers, requests, cases, requestedAmount: amount.toString(),
      contactedRequesters, contactedCaseCustomers, contactedRequestRate: rate(contactedRequesters, contacted),
      contactRate: rate(contacted, selected.length), noAnswerRate: rate(unanswered, contacted), requestRate: rate(requesters, selected.length), caseRate: rate(caseCustomers, selected.length), requestShare: rate(requesters, allRequesters ?? requesters) };
  }
  const eligible = all.filter(l => Number.isFinite(l.created) && l.created <= range.end);
  const summary = metrics(eligible, range.start, range.end);
  const anchor = range.anchor, ap = parts(anchor), month = monthStart(ap.year, ap.month), previousMonth = monthStart(ap.year, ap.month - 1), week = weekStart(anchor);
  const groups: Array<[string, string, (l: Lead) => boolean]> = [
    ["current", "شماره‌های جدیدِ بازه انتخابی", l => l.created >= range.start],
    ["previous", "همه شماره‌های قبل از بازه", l => l.created < range.start],
    ["previousDays", "روزهای قبل از تاریخ مرجع", l => l.created < anchor],
    ["previousWeek", "هفته تقویمی گذشته", l => l.created >= week - 7 && l.created < week],
    ["previousMonth", "ماه شمسی گذشته", l => l.created >= previousMonth && l.created < month],
    ["older", "قبل از ماه گذشته", l => l.created < previousMonth],
  ];
  const cohorts = groups.map(([key, label, predicate]) => ({ key, label, ...metrics(eligible.filter(predicate), range.start, range.end, summary.requesters) }));
  const monthEnd = monthStart(ap.year, ap.month + 1) - 1;
  const monthlyEligible = all.filter(l => Number.isFinite(l.created) && l.created <= monthEnd);
  const monthlyTotal = metrics(monthlyEligible, month, monthEnd);
  const monthly = { from: isoDay(month), to: isoDay(monthEnd),
    current: metrics(monthlyEligible.filter(l => l.created >= month), month, monthEnd, monthlyTotal.requesters),
    previous: metrics(monthlyEligible.filter(l => l.created < month), month, monthEnd, monthlyTotal.requesters) };
  const buckets = new Map<number, { start: number; end: number }>();
  for (let d = range.start; d <= range.end; d++) {
    const p = parts(d);
    const start = range.granularity === "week" ? weekStart(d) : range.granularity === "month" ? monthStart(p.year, p.month) : d;
    const bucket = buckets.get(start) ?? { start: d, end: d }; bucket.end = d; buckets.set(start, bucket);
  }
  const trend = [...buckets.values()].map(b => {
    const m = metrics(eligible.filter(l => l.created <= b.end), b.start, b.end);
    const fresh = eligible.filter(l => l.created >= b.start && l.created <= b.end);
    return { date: isoDay(b.start), to: isoDay(b.end), ...m, leads: fresh.length,
      newRequesters: metrics(fresh, b.start, b.end).requesters,
      previousRequesters: metrics(eligible.filter(l => l.created < b.start), b.start, b.end).requesters };
  });
  return { range: { period: range.period, from: range.from, to: range.to, granularity: range.granularity, timezone: range.timezone }, summary, cohorts, monthly, trend,
    definitions: [
      "تعداد شماره‌ها یکتا و بر اساس موبایل نرمال‌شده است؛ چند تماس با یک شماره، یک شماره محسوب می‌شود.",
      "جدید و قدیمی بر اساس تاریخ اولین ثبت شماره در CRM تعیین می‌شوند. مالک فعلی مشتری مبنای محدوده فروشنده است، نه انتساب تاریخی عملکرد.",
      "تماس و درخواست در بازه انتخابی شمارش می‌شوند؛ گروه‌های روزها، هفته و ماه گذشته مستقل‌اند و ممکن است هم‌پوشانی داشته باشند؛ جمع آن‌ها معتبر نیست.",
      "درخواست تسهیلات یعنی درخواست ثبت‌شده در سامانه، نه برداشت از متن آزاد تماس؛ لغو یا رد شدن، سابقه ثبت درخواست را حذف نمی‌کند.",
      "پرونده یعنی درخواست ثبت‌شده در همین بازه که اکنون از پیش‌ثبت‌نام عبور کرده است؛ این شاخص تاریخ عبور از پیش‌ثبت‌نام را بازسازی نمی‌کند.",
      "بی‌پاسخ یعنی هیچ پاسخ تأییدشده یا نتیجه نامشخصی در تماس‌های آن شماره در بازه وجود ندارد و همه نتایج بی‌پاسخ، مشغول، رد یا ناموفق‌اند؛ تماس دستی بدون نتیجه، نامشخص است.",
      "درصد تماس، درخواست و پرونده بر تعداد شماره‌های همان گروه؛ درصد بی‌پاسخ بر شماره‌های تماس‌گرفته‌شده؛ سهم درخواست بر کل درخواست‌کنندگان یکتای بازه است. مخرج صفر با خط تیره نمایش داده می‌شود.",
      "تبدیل پیگیری یعنی شماره‌هایی که هم تماس و هم درخواست ثبت‌شده در بازه دارند؛ درصد آن بر شماره‌های تماس‌گرفته‌شده همان گروه است و ادعای رابطه علت و معلولی یا ترتیب رخدادها نیست.",
      "مقایسه ماهانه مربوط به ماه شمسیِ تاریخ مرجع انتخابی است. مبلغ درخواست‌ها به تومان است؛ مبلغ واریزی یا فروش قطعی نیست.",
      "نمودار تعدادها در هر گام یکتا است؛ جمع گام‌ها ممکن است یک شماره تکراری داشته باشد. درصد درخواست نمودار بر کل شماره‌های موجود تا پایان همان گام است.",
    ] };
}

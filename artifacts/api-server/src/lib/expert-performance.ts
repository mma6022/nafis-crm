/**
 * Task D (2026-10-26) «تحلیل عملکرد من»: per-expert numbers for one period (روز گذشته / هفته / ماه شمسی), each next to the
 * previous period, plus the manager assistant's («احمد») written analyses.
 *
 * Periods (Tehran days, fixed UTC+03:30; week starts Saturday; month = Jalali month):
 *   day   = the whole previous Tehran day; previous = the day before it.
 *   week  = this week from Saturday up to now; previous = last week over the same elapsed time.
 *   month = this Jalali month up to now; previous = the previous Jalali month over the same elapsed time (capped at its end).
 *   A past periodStart gives the whole period and the whole previous period.
 * Numbers (counts and money only — no customer names, phones or ids):
 *   calls             lib/expert-calls.ts (by the logging expert; REPORT_CALL_ALIASES: «محدثه ابوالقاسمی» → Ms. Ghasemi).
 *                     Answered / result / duration are deliberately NOT returned.
 *   overdueReminders  reminders due inside the period (and already due) that are still not done.
 *   p1NoCall          current P1 customers of the expert with no real call for more than 3 days at the period end.
 *   siteLeadsNoCall   site requests (site_lead_requests) of the expert's customers in the period not answered by a call by the period end.
 *   sentToRegistration loan applications of the expert first moved into «بررسی مدارک مشتری» (customer_documents_review) in the period.
 *   deposited         goods purchases of the expert completed («واریز شد») in the period: count + SUM(payout_amount_toman);
 *                     commission = net goods_finance_ledger commission rows of the expert created in the period.
 * Test customers are left out when the admin switch is ON (lib/test-customers.ts), like every other report.
 * Analyses: table expert_analyses (additive). Written only by the manager assistant token; read by the expert (own), admin (all).
 */
import type { DatabaseSync } from "node:sqlite";
import { expertCalls } from "./expert-calls";
import { jalaliMonthStart, tehranWeekStart } from "./assistant-manager";
import { realCallSql } from "./real-call";
import { testCustomerSql } from "./test-customers";

export const PERFORMANCE_PERIODS = ["day", "week", "month"] as const;
export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];
export const ANALYSIS_MAX_CHARS = 6000;
export const P1_NO_CALL_DAYS = 3;
const OFFSET = 210 * 60_000; const DAY = 86_400_000;
const dayStart = (t: number) => Math.floor((t + OFFSET) / DAY) * DAY - OFFSET;
const isoDay = (t: number) => new Date(t + OFFSET).toISOString().slice(0, 10); // Tehran calendar date (Gregorian YYYY-MM-DD)
const fromIsoDay = (s: string) => Date.parse(`${s}T00:00:00Z`) - OFFSET;
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const cols = (db: DatabaseSync, t: string) => new Set((db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map(r => String(r.name)));
const faJ = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", ...o }).format(new Date(t));

export type Window = { from: string; to: string };
export type PeriodBounds = { period: PerformancePeriod; periodStart: string; label: string; current: Window; previous: Window; complete: boolean };

/** Start (UTC ms) of the period containing t. */
function startOf(period: PerformancePeriod, t: number) { return period === "day" ? dayStart(t) : period === "week" ? tehranWeekStart(t) : jalaliMonthStart(t); }
/** Start of the period before the one starting at s. */
const prevStart = (period: PerformancePeriod, s: number) => period === "day" ? s - DAY : period === "week" ? s - 7 * DAY : jalaliMonthStart(s - DAY);
/** Start of the period after the one starting at s. */
const nextStart = (period: PerformancePeriod, s: number) => period === "day" ? s + DAY : period === "week" ? s + 7 * DAY : jalaliMonthStart(s + 32 * DAY);

/** The default period for each tab: day = yesterday; week / month = the current one. */
export function defaultPeriodStart(period: PerformancePeriod, now: Date): string {
  const t = now.getTime();
  return isoDay(period === "day" ? dayStart(t) - DAY : startOf(period, t));
}
/** Validates a periodStart (Tehran date YYYY-MM-DD aligned to the period start, not in the future). */
export function validPeriodStart(period: PerformancePeriod, s: unknown, now: Date): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\d$/.test(s)) return null;
  const ms = fromIsoDay(s); if (!Number.isFinite(ms) || isoDay(ms) !== s) return null;
  if (startOf(period, ms + DAY / 2) !== ms) return null;
  if (ms > now.getTime()) return null;
  if (period === "day" && ms >= dayStart(now.getTime())) return null; // «روز گذشته»: today is not finished
  return s;
}
export function periodBounds(period: PerformancePeriod, now: Date, periodStart?: string | null): PeriodBounds {
  const t = now.getTime();
  const ps = periodStart ?? defaultPeriodStart(period, now);
  const s = fromIsoDay(ps); const e = nextStart(period, s); const complete = e <= t;
  const curTo = complete ? e : t;
  const p = prevStart(period, s);
  const prevTo = complete ? s : Math.min(p + (curTo - s), s);
  const label = period === "day" ? faJ(s + DAY / 2, { weekday: "long", day: "numeric", month: "long" })
    : period === "week" ? `هفته‌ی ${faJ(s + DAY / 2, { day: "numeric", month: "long" })}${complete ? "" : " (تا الان)"}`
    : `${faJ(s + DAY / 2, { month: "long", year: "numeric" })}${complete ? "" : " (تا الان)"}`;
  return { period, periodStart: ps, label, complete, current: { from: new Date(s).toISOString(), to: new Date(curTo).toISOString() },
    previous: { from: new Date(p).toISOString(), to: new Date(prevTo).toISOString() } };
}

export type PerformanceNumbers = {
  calls: number; overdueReminders: number; p1NoCall: number; siteLeadsNoCall: number; sentToRegistration: number;
  deposited: { count: number; payoutToman: string; commissionToman: string };
};
const big = (v: unknown) => { const s = String(v ?? "").trim(); return /^-?\d+$/.test(s) ? BigInt(s) : 0n; };

export function performanceNumbers(db: DatabaseSync, sp: number, w: Window, now: Date, excludeTest: boolean): PerformanceNumbers {
  const notTest = excludeTest ? `AND NOT ${testCustomerSql("c")}` : "";
  const to = w.to; const nowIso = now.toISOString(); const dueBy = to < nowIso ? to : nowIso;
  const calls = expertCalls(db, sp, w.from, to, { excludeTest, reportAliases: true }).length;
  const uids = (db.prepare("SELECT id FROM users WHERE salesperson_id=? AND role='salesperson'").all(sp) as any[]).map(r => Number(r.id));
  const ph = uids.length ? uids.map(() => "?").join(",") : "NULL";
  const overdueReminders = has(db, "reminders") ? Number((db.prepare(`SELECT COUNT(*) n FROM reminders r LEFT JOIN customers c ON c.id=r.customer_id
      WHERE r.done=0 AND julianday(r.remind_at)>=julianday(?) AND julianday(r.remind_at)<julianday(?) AND (r.salesperson_id=? OR r.user_id IN (${ph}))
        AND (r.customer_id IS NULL OR (c.merged_into_customer_id IS NULL ${notTest}))`).get(w.from, dueBy, sp, ...uids) as any)?.n ?? 0) : 0;
  // P1 with no real call for more than 3 days at the period end (current P1 / ownership; reference = last call before the end, else creation)
  const end = Date.parse(to);
  const p1Rows = db.prepare(`SELECT c.created_at, (SELECT MAX(julianday(l.created_at)) FROM call_logs l WHERE l.customer_id=c.id AND ${realCallSql("l.subject")}
        AND julianday(l.created_at)<julianday(?)) lj
      FROM customers c WHERE c.salesperson_id=? AND c.priority=1 AND c.merged_into_customer_id IS NULL AND COALESCE(c.status,'') NOT IN ('cancelled','completed') ${notTest}
        AND julianday(c.created_at)<julianday(?)`).all(to, sp, to) as any[];
  const p1NoCall = p1Rows.filter(c => {
    const ref = c.lj != null ? (Number(c.lj) - 2440587.5) * DAY : Date.parse(String(c.created_at).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(c.created_at)) ? "" : "Z"));
    return Number.isFinite(ref) && end - ref > P1_NO_CALL_DAYS * DAY;
  }).length;
  const siteLeadsNoCall = has(db, "site_lead_requests") ? Number((db.prepare(`SELECT COUNT(*) n FROM site_lead_requests r JOIN customers c ON c.id=r.customer_id
      WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL ${notTest} AND julianday(r.requested_at)>=julianday(?) AND julianday(r.requested_at)<julianday(?)
        AND (r.answered_at IS NULL OR julianday(r.answered_at)>=julianday(?))`).get(sp, w.from, to, to) as any)?.n ?? 0) : 0;
  let sentToRegistration = 0;
  if (has(db, "loan_applications") && has(db, "loan_application_stage_history")) {
    const snap = cols(db, "loan_applications").has("salesperson_id_snapshot") ? "COALESCE(a.salesperson_id_snapshot,c.salesperson_id)" : "c.salesperson_id";
    sentToRegistration = Number((db.prepare(`SELECT COUNT(*) n FROM (SELECT a.id, MIN(julianday(h.created_at)) first FROM loan_applications a
        JOIN customers c ON c.id=a.customer_id JOIN loan_application_stage_history h ON h.application_id=a.id
        WHERE a.deleted_at IS NULL AND ${snap}=? AND h.to_stage='customer_documents_review' AND COALESCE(h.from_stage,'')<>'customer_documents_review' ${notTest}
        GROUP BY a.id) x WHERE x.first>=julianday(?) AND x.first<julianday(?)`).get(sp, w.from, to) as any)?.n ?? 0);
  }
  let dCount = 0, payout = 0n, commission = 0n;
  if (has(db, "goods_purchases")) {
    const rows = db.prepare(`SELECT g.payout_amount_toman amt FROM goods_purchases g LEFT JOIN customers c ON c.id=g.customer_id
      WHERE g.salesperson_id=? AND g.stage='completed' AND g.completed_at IS NOT NULL AND julianday(g.completed_at)>=julianday(?) AND julianday(g.completed_at)<julianday(?)
        ${excludeTest ? `AND (c.id IS NULL OR NOT ${testCustomerSql("c")})` : ""}`).all(sp, w.from, to) as any[];
    dCount = rows.length; payout = rows.reduce((s, r) => s + big(r.amt), 0n);
  }
  if (has(db, "goods_finance_ledger")) {
    const rows = db.prepare(`SELECT l.amount_toman amt FROM goods_finance_ledger l LEFT JOIN customers c ON c.id=l.customer_id
      WHERE l.salesperson_id=? AND l.kind IN ('salesperson_commission','p1_referral_share','returned_case_deduction','paid_mark_reversal','data_accuracy_bonus','team_bonus')
        AND julianday(l.created_at)>=julianday(?) AND julianday(l.created_at)<julianday(?) ${excludeTest ? `AND (c.id IS NULL OR NOT ${testCustomerSql("c")})` : ""}`).all(sp, w.from, to) as any[];
    commission = rows.reduce((s, r) => s + big(r.amt), 0n);
  }
  return { calls, overdueReminders, p1NoCall, siteLeadsNoCall, sentToRegistration, deposited: { count: dCount, payoutToman: payout.toString(), commissionToman: commission.toString() } };
}

export const PERFORMANCE_DEFINITIONS = {
  calls: "تماس‌های ثبت‌شده توسط خود کارشناس (به‌اضافه‌ی تماس‌های تلفن سازمانی)؛ تماس‌های «محدثه ابوالقاسمی» برای خانم قاسمی و تماس‌های بدون کارشناس یا حساب «مهمون» برای مالک سرنخ حساب می‌شود.",
  overdueReminders: "یادآورهایی که موعدشان در این بازه بوده و هنوز انجام نشده‌اند.",
  p1NoCall: "مشتری‌های اولویت ۱ که در پایان بازه بیش از ۳ روز بی‌تماس بوده‌اند.",
  siteLeadsNoCall: "درخواست‌های سایتِ این بازه که تا پایان بازه با آن‌ها تماس گرفته نشده.",
  sentToRegistration: "پرونده‌هایی که برای اولین بار در این بازه به «بررسی مدارک مشتری» (کارشناس ثبت) رفته‌اند.",
  deposited: "خریدهایی که در این بازه «واریز شد» شده‌اند: تعداد، جمع مبلغ واریزی (payout) و پورسانت خالص ثبت‌شده در کیف پول.",
};

export function performanceReport(db: DatabaseSync, sp: number, period: PerformancePeriod, now: Date, excludeTest: boolean, periodStart?: string | null) {
  const b = periodBounds(period, now, periodStart);
  return { salespersonId: sp, ...b, timezone: "Asia/Tehran", weekStarts: "saturday", month: "jalali", generatedAt: now.toISOString(), testCustomersExcluded: excludeTest,
    numbers: performanceNumbers(db, sp, b.current, now, excludeTest), previousNumbers: performanceNumbers(db, sp, b.previous, now, excludeTest),
    definitions: PERFORMANCE_DEFINITIONS };
}

/* ---------------- analyses ---------------- */
export function ensureExpertAnalysisSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS expert_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, salesperson_id INTEGER NOT NULL, period TEXT NOT NULL CHECK(period IN ('day','week','month')),
    period_start TEXT NOT NULL, body TEXT NOT NULL, assistant_id INTEGER, token_id INTEGER, author_label TEXT,
    notified_user_ids TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_expert_analyses_sp ON expert_analyses(salesperson_id, period, period_start, id DESC);`);
}
/** Markdown body: plain text only — HTML tags, control characters and zero-width/bidi overrides removed, length capped. */
export function sanitizeAnalysisBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.replace(/\r\n?/g, "\n").replace(/<[^>]{0,500}>/g, "").replace(/[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "");
  s = s.replace(/\]\(\s*(javascript|data|vbscript):[^)]*\)/gi, "]()").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!s || s.length > ANALYSIS_MAX_CHARS) return null;
  return s;
}
export type AnalysisView = { id: number; salespersonId: number; salespersonName: string | null; period: PerformancePeriod; periodStart: string; body: string; authorLabel: string | null; createdAt: string };
export function listAnalyses(db: DatabaseSync, f: { salespersonIds: number[] | null; period?: PerformancePeriod | null; periodStart?: string | null; id?: number | null; limit?: number }): AnalysisView[] {
  ensureExpertAnalysisSchema(db);
  const w: string[] = []; const p: any[] = [];
  if (f.salespersonIds) { if (!f.salespersonIds.length) return []; w.push(`x.salesperson_id IN (${f.salespersonIds.map(() => "?").join(",")})`); p.push(...f.salespersonIds); }
  if (f.period) { w.push("x.period=?"); p.push(f.period); }
  if (f.periodStart) { w.push("x.period_start=?"); p.push(f.periodStart); }
  if (f.id) { w.push("x.id=?"); p.push(f.id); }
  const lim = Math.max(1, Math.min(100, Math.floor(f.limit ?? 30)));
  return (db.prepare(`SELECT x.*, s.name sp_name FROM expert_analyses x LEFT JOIN salespersons s ON s.id=x.salesperson_id ${w.length ? "WHERE " + w.join(" AND ") : ""}
    ORDER BY x.id DESC LIMIT ?`).all(...p, lim) as any[]).map(r => ({ id: Number(r.id), salespersonId: Number(r.salesperson_id), salespersonName: r.sp_name ?? null,
      period: r.period, periodStart: r.period_start, body: r.body, authorLabel: r.author_label ?? null, createdAt: r.created_at }));
}

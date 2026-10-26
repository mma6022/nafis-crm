/**
 * «دستیار مدیر فروش» (احمد) — piece A: read-only per-expert reports, a rule-based underperformance score and the ready-made
 * 09:00 / 18:00 / Thursday summary. Pure reads over the CRM tables (no writes here; the runner posts its own chat lines).
 *
 * Experts in scope: active salespeople with a non-trainee salesperson id (trainees 5/19/20 and user 29 are never included).
 * Days and weeks are Tehran days (fixed UTC+03:30); the week starts on Saturday like the CRM sales report.
 * Answered / not answered uses the CRM's own rule (lib/sales-report.ts callOutcome) plus the first-call form result.
 *
 * Piece B (not built yet; the shapes leave room for it): conversions, paid amount + commission, first/last activity and
 * active hours, more ranges (yesterday, month), «الان نه» reasons and the assistant-to-assistant thread.
 */
import type { DatabaseSync } from "node:sqlite";
import { callOutcome } from "./sales-report";

export const MANAGER_TRAINEE_SALESPERSON_IDS = [5, 19, 20];
export const MANAGER_EXCLUDED_USER_IDS = [29];
/** Piece A ranges only. Piece B adds "yesterday" and "month" here. */
export const MANAGER_RANGES = ["today", "week"] as const;
export type ManagerRange = (typeof MANAGER_RANGES)[number];
export const MANAGER_SLOTS = ["morning", "evening", "thursday"] as const;
export type ManagerSlot = (typeof MANAGER_SLOTS)[number];

/** assistant_settings keys (new keys only; notification_settings / team_sales_config are never touched). */
export const MANAGER_SETTING_KEYS = {
  callsRatio: "manager_calls_ratio",
  callsCompare: "manager_calls_compare",
  overdueRemindersMax: "manager_overdue_reminders_max",
  siteLeadsMax: "manager_site_leads_max",
  p1NoCallDays: "manager_p1_no_call_days",
} as const;
export type ManagerSettings = { callsRatio: number; callsCompare: "same_time" | "full_day"; overdueRemindersMax: number; siteLeadsMax: number; p1NoCallDays: number };
export const MANAGER_DEFAULTS: ManagerSettings = { callsRatio: 0.7, callsCompare: "same_time", overdueRemindersMax: 5, siteLeadsMax: 0, p1NoCallDays: 3 };
const LIMITS = { callsRatio: [0.1, 1], overdueRemindersMax: [0, 200], siteLeadsMax: [0, 50], p1NoCallDays: [1, 60] } as const;

export function readManagerSettings(get: (key: string) => string | undefined): ManagerSettings {
  const num = (k: keyof typeof LIMITS, int: boolean) => {
    const v = Number(get(MANAGER_SETTING_KEYS[k])); const [lo, hi] = LIMITS[k];
    return Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v)) ? v : MANAGER_DEFAULTS[k];
  };
  const cmp = get(MANAGER_SETTING_KEYS.callsCompare);
  return { callsRatio: num("callsRatio", false), callsCompare: cmp === "full_day" ? "full_day" : "same_time",
    overdueRemindersMax: num("overdueRemindersMax", true), siteLeadsMax: num("siteLeadsMax", true), p1NoCallDays: num("p1NoCallDays", true) };
}
/** Validates a partial update; returns the key/value pairs to store or an error code. */
export function validateManagerSettings(body: any): { ok: true; values: Array<[string, string]> } | { ok: false; error: string; field?: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "bad_body" };
  const out: Array<[string, string]> = [];
  for (const k of Object.keys(body)) {
    if (!(k in MANAGER_SETTING_KEYS)) return { ok: false, error: "unknown_field", field: k };
    const key = k as keyof typeof MANAGER_SETTING_KEYS; const v = body[k];
    if (key === "callsCompare") { if (v !== "same_time" && v !== "full_day") return { ok: false, error: "bad_value", field: k }; out.push([MANAGER_SETTING_KEYS[key], v]); continue; }
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    const [lo, hi] = LIMITS[key]; const int = key !== "callsRatio";
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) return { ok: false, error: "bad_value", field: k };
    out.push([MANAGER_SETTING_KEYS[key], String(int ? n : Math.round(n * 100) / 100)]);
  }
  if (!out.length) return { ok: false, error: "bad_body" };
  return { ok: true, values: out };
}

/* ---------------- Tehran time ---------------- */
const OFFSET = 210 * 60_000; const DAY = 86_400_000;
const tehranDayStart = (t: number) => Math.floor((t + OFFSET) / DAY) * DAY - OFFSET;
/** JS getDay() of the Tehran calendar day containing t (6 = Saturday, 5 = Friday). */
const tehranWeekday = (t: number) => new Date(t + OFFSET).getUTCDay();
export function rangeBounds(range: ManagerRange, now: Date): { range: ManagerRange; from: string; to: string; label: string } {
  const t = now.getTime(); const today = tehranDayStart(t);
  const start = range === "today" ? today : today - ((tehranWeekday(t) + 1) % 7) * DAY;
  return { range, from: new Date(start).toISOString(), to: now.toISOString(), label: range === "today" ? "امروز" : "این هفته (از شنبه)" };
}
const faDigits = (s: string | number) => String(s).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
const faDate = (d: Date) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", weekday: "long", day: "numeric", month: "long" }).format(d);
const pct = (n: number | null) => (n == null ? "—" : `${faDigits(Math.round(n * 100))}٪`);

/* ---------------- data ---------------- */
export type SiteLeadLite = { dueAt: string; requestedAt: string; openRequests: number; isRepeat: boolean };
export type ManagerDeps = { db: DatabaseSync; now: Date; settings: ManagerSettings; siteLeads?: () => Map<number, SiteLeadLite> };
export type Expert = { salespersonId: number; name: string; userIds: number[]; userName: string | null };

export function managerExperts(db: DatabaseSync): Expert[] {
  const rows = db.prepare(`SELECT u.id, u.salesperson_id sp, u.full_name, u.username, s.name sp_name FROM users u JOIN salespersons s ON s.id=u.salesperson_id
    WHERE u.role='salesperson' AND u.active=1 AND u.salesperson_id IS NOT NULL ORDER BY u.salesperson_id, u.id`).all() as any[];
  const by = new Map<number, Expert>();
  for (const r of rows) {
    const sp = Number(r.sp);
    if (MANAGER_TRAINEE_SALESPERSON_IDS.includes(sp) || MANAGER_EXCLUDED_USER_IDS.includes(Number(r.id))) continue;
    const e: Expert = by.get(sp) ?? { salespersonId: sp, name: r.sp_name, userIds: [] as number[], userName: r.full_name || r.username || null };
    e.userIds.push(Number(r.id)); by.set(sp, e);
  }
  return [...by.values()];
}
export const managerExpertIds = (db: DatabaseSync) => managerExperts(db).map(e => e.salespersonId);

const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const custName = (c: any) => (c?.first_name && c?.last_name ? `${c.first_name} ${c.last_name}` : c?.name ?? "مشتری");

type CallRec = { at: number; outcome: "yes" | "no" | "unknown" };
/** Calls made by an expert (call_logs.salesperson_id, plus phone-system calls not linked to a call log), live calls excluded. */
function callsOf(db: DatabaseSync, sp: number, fromIso: string, toIso: string): CallRec[] {
  const voip = has(db, "voip_after_call_events"); const q = has(db, "team_sales_qualifications");
  const at = voip ? "COALESCE(e.started_at,l.created_at)" : "l.created_at";
  const sql = `SELECT ${at} at, ${voip ? "e.status, e.mobile_answered_at" : "NULL status, NULL mobile_answered_at"},
      ${q ? "(SELECT call_result FROM team_sales_qualifications tq WHERE tq.call_log_id=l.id ORDER BY tq.id DESC LIMIT 1)" : "NULL"} qres
    FROM call_logs l ${voip ? "LEFT JOIN voip_after_call_events e ON e.call_log_id=l.id" : ""}
    WHERE l.salesperson_id=? ${voip ? "AND COALESCE(e.is_live,0)=0" : ""} AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)
    ${voip ? `UNION ALL SELECT e.started_at at, e.status, e.mobile_answered_at, NULL qres FROM voip_after_call_events e
      WHERE e.call_log_id IS NULL AND e.is_live=0 AND e.salesperson_id=? AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)` : ""}`;
  const p: any[] = [sp, fromIso, toIso]; if (voip) p.push(sp, fromIso, toIso);
  return (db.prepare(sql).all(...p) as any[]).map(r => {
    let o = callOutcome(r.status, r.mobile_answered_at);
    if (o === "unknown" && r.qres) o = r.qres === "answered" ? "yes" : r.qres === "no_answer" ? "no" : "unknown";
    const s = String(r.at ?? ""); const at = Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "Z" : s);
    return { at, outcome: o };
  });
}
function callStats(list: CallRec[]) {
  const answered = list.filter(c => c.outcome === "yes").length, notAnswered = list.filter(c => c.outcome === "no").length;
  const known = answered + notAnswered;
  return { count: list.length, answered, notAnswered, unknown: list.length - known, answeredShare: known ? Math.round((answered / known) * 1000) / 1000 : null };
}

export type Alert = { rule: "calls_below_average" | "overdue_reminders" | "site_leads_unanswered"; points: number; reason: string; numbers: Record<string, number | string | null> };
export type ExpertReport = {
  salespersonId: number; name: string;
  calls: ReturnType<typeof callStats>;
  overdueReminders: { count: number; maxDaysLate: number; items: { reminderId: number; customerId: number | null; customerName: string | null; subject: string; remindAt: string; daysLate: number }[] };
  siteLeadsOverdue: { count: number; items: { customerId: number; customerName: string; requestedAt: string; dueAt: string; hoursLate: number; openRequests: number; isRepeat: boolean }[] };
  p1NoCall: { days: number; count: number; items: { customerId: number; customerName: string; lastCallAt: string | null; daysSince: number }[] };
  baseline: { todayCalls: number; average: number | null; activeDays: number; compare: "same_time" | "full_day"; workday: boolean };
  score: { points: number; level: "ok" | "watch" | "alert"; basis: "today"; alerts: Alert[] };
};
const RULE_POINTS = { calls_below_average: 40, overdue_reminders: 30, site_leads_unanswered: 30 } as const;

function expertReport(d: ManagerDeps, e: Expert, range: ManagerRange, leads: Map<number, SiteLeadLite>, leadOwners: Map<number, any>): ExpertReport {
  const { db, now, settings } = d; const t = now.getTime(); const nowIso = now.toISOString();
  const b = rangeBounds(range, now);
  const calls = callStats(callsOf(db, e.salespersonId, b.from, new Date(t + 1).toISOString()));
  // baseline: the 7 days before today (days with at least one call), up to the same Tehran clock time or the full day.
  const today = tehranDayStart(t); const hist = callsOf(db, e.salespersonId, new Date(today - 7 * DAY).toISOString(), new Date(today).toISOString());
  const todayCalls = range === "today" ? calls.count : callsOf(db, e.salespersonId, new Date(today).toISOString(), new Date(t + 1).toISOString()).length;
  const elapsed = t - today; let active = 0, sum = 0;
  for (let i = 1; i <= 7; i++) {
    const ds = today - i * DAY; const day = hist.filter(c => c.at >= ds && c.at < ds + DAY);
    if (!day.length) continue; active++;
    sum += settings.callsCompare === "full_day" ? day.length : day.filter(c => c.at < ds + elapsed).length;
  }
  const average = active ? Math.round((sum / active) * 10) / 10 : null;
  const workday = tehranWeekday(t) !== 5;
  // overdue undone reminders (owner = the expert's user or salesperson id)
  const ph = e.userIds.map(() => "?").join(",");
  const rem = has(db, "reminders") ? (db.prepare(`SELECT r.id, r.customer_id, r.subject, r.message, r.remind_at, c.name, c.first_name, c.last_name FROM reminders r
      LEFT JOIN customers c ON c.id=r.customer_id
      WHERE r.done=0 AND julianday(r.remind_at)<julianday(?) AND (r.salesperson_id=? OR r.user_id IN (${ph}))
        AND (r.customer_id IS NULL OR c.merged_into_customer_id IS NULL) ORDER BY julianday(r.remind_at)`).all(nowIso, e.salespersonId, ...e.userIds) as any[]) : [];
  const remItems = rem.map(r => ({ reminderId: Number(r.id), customerId: r.customer_id == null ? null : Number(r.customer_id), customerName: r.customer_id == null ? null : custName(r),
    subject: String(r.subject || r.message || "").slice(0, 120), remindAt: r.remind_at, daysLate: Math.max(0, Math.floor((t - Date.parse(r.remind_at)) / DAY)) }));
  // site leads still unanswered after their call deadline (lib/site-leads.ts activeSiteLeads → dueAt)
  const slItems: ExpertReport["siteLeadsOverdue"]["items"] = [];
  for (const [cid, s] of leads) {
    const c = leadOwners.get(cid); if (!c || Number(c.salesperson_id) !== e.salespersonId) continue;
    const due = Date.parse(s.dueAt); if (!(due <= t)) continue;
    slItems.push({ customerId: cid, customerName: custName(c), requestedAt: s.requestedAt, dueAt: s.dueAt, hoursLate: Math.round(((t - due) / 3600_000) * 10) / 10, openRequests: s.openRequests, isRepeat: s.isRepeat });
  }
  slItems.sort((x, y) => y.hoursLate - x.hoursLate);
  // P1 with no call for more than X days (reference: last call on the customer, else when it was created)
  const X = settings.p1NoCallDays;
  const p1 = (db.prepare(`SELECT c.id, c.name, c.first_name, c.last_name, c.created_at, (SELECT MAX(julianday(l.created_at)) FROM call_logs l WHERE l.customer_id=c.id) lj,
      (SELECT l.created_at FROM call_logs l WHERE l.customer_id=c.id ORDER BY julianday(l.created_at) DESC LIMIT 1) last_at
    FROM customers c WHERE c.salesperson_id=? AND c.priority=1 AND c.merged_into_customer_id IS NULL AND COALESCE(c.status,'') NOT IN ('cancelled','completed')`).all(e.salespersonId) as any[])
    .map(c => { const ref = c.lj != null ? (Number(c.lj) - 2440587.5) * DAY : Date.parse(String(c.created_at).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(c.created_at)) ? "" : "Z"));
      return { customerId: Number(c.id), customerName: custName(c), lastCallAt: c.last_at ?? null, ms: t - ref }; })
    .filter(c => Number.isFinite(c.ms) && c.ms > X * DAY).sort((x, y) => y.ms - x.ms)
    .map(c => ({ customerId: c.customerId, customerName: c.customerName, lastCallAt: c.lastCallAt, daysSince: Math.floor(c.ms / DAY) }));
  // score (today's rules)
  const alerts: Alert[] = [];
  if (workday && average != null && average >= 1 && todayCalls < settings.callsRatio * average)
    alerts.push({ rule: "calls_below_average", points: RULE_POINTS.calls_below_average,
      reason: `تماس امروز ${faDigits(todayCalls)} است؛ کمتر از ${pct(settings.callsRatio)} میانگین ۷ روز اخیر خودش (${faDigits(average)}${settings.callsCompare === "same_time" ? " تا همین ساعت" : ""}).`,
      numbers: { todayCalls, average, ratio: settings.callsRatio, threshold: Math.round(settings.callsRatio * average * 10) / 10, activeDays: active, compare: settings.callsCompare } });
  if (remItems.length > settings.overdueRemindersMax)
    alerts.push({ rule: "overdue_reminders", points: RULE_POINTS.overdue_reminders,
      reason: `${faDigits(remItems.length)} یادآور انجام‌نشده از موعدش گذشته (بیشتر از ${faDigits(settings.overdueRemindersMax)})؛ قدیمی‌ترین ${faDigits(remItems[0]?.daysLate ?? 0)} روز.`,
      numbers: { overdue: remItems.length, max: settings.overdueRemindersMax, maxDaysLate: remItems[0]?.daysLate ?? 0 } });
  if (slItems.length > settings.siteLeadsMax)
    alerts.push({ rule: "site_leads_unanswered", points: RULE_POINTS.site_leads_unanswered,
      reason: `${faDigits(slItems.length)} سرنخ سایت بعد از مهلت تماس هنوز بی‌تماس مانده؛ بیشترین تأخیر ${faDigits(slItems[0]?.hoursLate ?? 0)} ساعت.`,
      numbers: { unanswered: slItems.length, max: settings.siteLeadsMax, maxHoursLate: slItems[0]?.hoursLate ?? 0 } });
  const points = alerts.reduce((s, a) => s + a.points, 0);
  return { salespersonId: e.salespersonId, name: e.name, calls,
    overdueReminders: { count: remItems.length, maxDaysLate: remItems[0]?.daysLate ?? 0, items: remItems.slice(0, 15) },
    siteLeadsOverdue: { count: slItems.length, items: slItems.slice(0, 15) },
    p1NoCall: { days: X, count: p1.length, items: p1.slice(0, 15) },
    baseline: { todayCalls, average, activeDays: active, compare: settings.callsCompare, workday },
    score: { points, level: points >= 50 ? "alert" : points > 0 ? "watch" : "ok", basis: "today", alerts } };
}

export function managerReport(d: ManagerDeps, range: ManagerRange, salespersonId?: number | null) {
  const experts = managerExperts(d.db).filter(e => salespersonId == null || e.salespersonId === salespersonId);
  let leads = new Map<number, SiteLeadLite>(); let siteLeadsUnavailable = false;
  try { leads = d.siteLeads ? d.siteLeads() : new Map(); } catch { siteLeadsUnavailable = true; }
  const owners = new Map<number, any>();
  const ids = [...leads.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const c of d.db.prepare(`SELECT id,name,first_name,last_name,salesperson_id FROM customers WHERE merged_into_customer_id IS NULL AND COALESCE(status,'') NOT IN ('cancelled','completed') AND id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as any[]) owners.set(Number(c.id), c);
  }
  const list = experts.map(e => expertReport(d, e, range, leads, owners));
  const sum = (f: (x: ExpertReport) => number) => list.reduce((s, x) => s + f(x), 0);
  const ans = sum(x => x.calls.answered), no = sum(x => x.calls.notAnswered);
  return { ...rangeBounds(range, d.now), generatedAt: d.now.toISOString(), timezone: "Asia/Tehran", thresholds: d.settings,
    team: { calls: sum(x => x.calls.count), answered: ans, notAnswered: no, unknown: sum(x => x.calls.unknown), answeredShare: ans + no ? Math.round((ans / (ans + no)) * 1000) / 1000 : null,
      overdueReminders: sum(x => x.overdueReminders.count), siteLeadsOverdue: sum(x => x.siteLeadsOverdue.count), p1NoCall: sum(x => x.p1NoCall.count),
      alerts: sum(x => x.score.alerts.length) },
    experts: list, ...(siteLeadsUnavailable ? { siteLeadsUnavailable: true } : {}),
    pieceB: { notYet: ["conversions", "paid_amount", "commission", "active_hours", "ranges:yesterday,month", "not_now_reasons", "assistant_threads"] } };
}

export function managerAlerts(d: ManagerDeps) {
  const r = managerReport(d, "today");
  return { generatedAt: r.generatedAt, thresholds: r.thresholds,
    items: r.experts.flatMap(e => e.score.alerts.map(a => ({ salespersonId: e.salespersonId, expert: e.name, level: e.score.level, scorePoints: e.score.points, ...a }))) };
}

const SLOT_FA: Record<ManagerSlot, string> = { morning: "گزارش ۹ صبح", evening: "گزارش ۶ عصر", thursday: "گزارش هفتگی (پنجشنبه)" };
/** Ready-made text + data for the 09:00, 18:00 and Thursday reports. The runner sends it itself (POST /messages to an admin). */
export function managerSummary(d: ManagerDeps, slot: ManagerSlot) {
  const range: ManagerRange = slot === "thursday" ? "week" : "today";
  const r = managerReport(d, range); const today = slot === "thursday" ? managerReport(d, "today") : r;
  const lines: string[] = [`${SLOT_FA[slot]} — ${faDate(d.now)}`];
  lines.push(`تیم (${r.label}): ${faDigits(r.team.calls)} تماس · پاسخ‌داده ${pct(r.team.answeredShare)}${r.team.unknown ? ` (نتیجه‌ی ${faDigits(r.team.unknown)} تماس معلوم نیست)` : ""}`);
  for (const e of r.experts) {
    const s = today.experts.find(x => x.salespersonId === e.salespersonId)?.score ?? e.score;
    const parts = [`${faDigits(e.calls.count)} تماس`, `پاسخ‌داده ${pct(e.calls.answeredShare)}`, `یادآور عقب‌افتاده ${faDigits(e.overdueReminders.count)}${e.overdueReminders.count ? ` (تا ${faDigits(e.overdueReminders.maxDaysLate)} روز)` : ""}`,
      `سرنخ سایت بی‌تماس ${faDigits(e.siteLeadsOverdue.count)}`, `اولویت ۱ بی‌تماس بیش از ${faDigits(e.p1NoCall.days)} روز: ${faDigits(e.p1NoCall.count)}`];
    lines.push(`${s.level === "alert" ? "🔴" : s.level === "watch" ? "🟠" : "🟢"} ${e.name}: ${parts.join(" · ")}`);
    for (const a of s.alerts) lines.push(`   – ${a.reason}`);
  }
  if (slot === "morning") lines.push("تماس‌های امروز تازه شروع شده؛ مقایسه با میانگین تا همین ساعت است.");
  return { slot, title: SLOT_FA[slot], generatedAt: r.generatedAt, range: r.range, text: lines.join("\n"), report: r, todayScores: slot === "thursday" ? today.experts.map(e => ({ salespersonId: e.salespersonId, score: e.score })) : undefined };
}

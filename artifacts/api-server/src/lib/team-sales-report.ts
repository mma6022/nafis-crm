/**
 * «گزارش فروش تیم» (/sales-reports, 2026-10-26) — one aggregate, read-only report for the admin / sales manager.
 * Design: nafis-design/screens/crm-sales-report (spec.md), proposal nafis-deploy/SALES-REPORT-PROPOSAL.md.
 *
 * Access: admin only (route). Experts / trainees / registrars get 403 (+ «رفتن به عملکرد من»).
 * Team = managerExperts(db): active salesperson users; user 29 never; trainees (5, 19, 20) are read from the DB, read-only.
 * KPI cards count the WHOLE team (experts + trainees). The «جمع کارشناس‌ها» table row leaves trainees out.
 * Filters: range (today / yesterday / week / month / prev_month / custom), expert (one salesperson), plan (one loan plan).
 * The plan filter is applied everywhere:
 *   loan applications  plan_id = P or P in plan_ids;   goods purchases / payment orders  purchase plan_id = P;
 *   commission ledger  plan_id = P;  customer-level numbers (calls, leads, site requests, reminders, P1)  customers that have a
 *   loan application or a goods purchase with plan P.
 * Comparison: the previous period of the same length up to the same elapsed time (like /my-performance).
 * Numbers (counts and money only — no answered / result / duration, no phones):
 *   calls            lib/expert-calls.ts teamCallRows (by the expert who made the call; «محدثه ابوالقاسمی» → Ms. Ghasemi;
 *                    calls with no expert / the shared «مهمون» account → the lead's current owner). Reports only.
 *   sentToRegistration  first entry of a loan application into customer_documents_review in the period.
 *   registrationDone «تکمیل ثبت» = first entry of a loan application into stage 'completed' («تکمیل شده»); after it the case
 *                    waits for the payout (goods purchase → «واریز شد»).
 *   deposited        goods purchases completed («واریز شد») in the period: count + SUM(payout_amount_toman).
 *   commission       net goods_finance_ledger commission rows created in the period (same kinds as /my-performance).
 *   openPaymentOrders customer_payment_orders not yet 'paid' (now).
 *   leads            customers created in the period (current owner); siteLeadsNoCall = site requests in the period not answered by its end.
 *   overdue          now: open reminders already due + current P1 customers with no real call for more than 3 days;
 *                    «۷ روز پیش» comes from the daily snapshot table sales_report_overdue_snapshots — null («—») until a 7-day-old row exists.
 * Test customers are left out when the admin switch is ON (lib/test-customers.ts).
 */
import type { DatabaseSync } from "node:sqlite";
import { managerExperts, jalaliMonthStart, tehranWeekStart } from "./assistant-manager";
import { teamCallRows, type TeamCallRow } from "./expert-calls";
import { realCallSql } from "./real-call";
import { testCustomerSql } from "./test-customers";
import { openInvoices, registrationReport } from "./manager-work";
import { P1_NO_CALL_DAYS } from "./expert-performance";

const OFFSET = 210 * 60_000; const DAY = 86_400_000; const HOUR = 3_600_000;
const dayStart = (t: number) => Math.floor((t + OFFSET) / DAY) * DAY - OFFSET;
export const tehranIsoDay = (t: number) => new Date(t + OFFSET).toISOString().slice(0, 10);
const fromIsoDay = (s: string) => Date.parse(`${s}T00:00:00Z`) - OFFSET;
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const big = (v: unknown) => { const s = String(v ?? "").trim(); return /^-?\d+$/.test(s) ? BigInt(s) : 0n; };
const ms = (v: unknown) => { const s = String(v ?? ""); return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "Z" : s); };
const ph = (a: unknown[]) => (a.length ? a.map(() => "?").join(",") : "NULL");
const faJ = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", ...o }).format(new Date(t));
const jParts = (t: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "numeric", day: "numeric" })
  .formatToParts(new Date(t)).map(x => [x.type, x.value])); return { y: Number(p.year), m: Number(p.month), d: Number(p.day) }; };

/* ---------------- settings flags (assistant_settings, INSERT OR IGNORE; admin only) ---------------- */
export const SR_FLAG_KEYS = {
  traineeMoney: "sales_report_trainee_money",     // ۱ کارآموزها مبلغ/پورسانت ببینند — default OFF
  overdueCard: "sales_report_overdue_card",       // ۲ کارت «یادآورهای عقب‌افتاده» بالای صفحه — default ON
  noCommissionAlert: "sales_report_no_commission_alert", // ۳ اعلان ادمین برای «واریز بدون پورسانت» — default OFF
} as const;
export type SrFlags = { traineeMoney: boolean; overdueCard: boolean; noCommissionAlert: boolean };
export const SR_FLAG_DEFAULTS: SrFlags = { traineeMoney: false, overdueCard: true, noCommissionAlert: false };
export const SNAPSHOT_TABLE = "sales_report_overdue_snapshots";

export function ensureSalesReportSchema(db: DatabaseSync, nowIso: string) {
  for (const [k, key] of Object.entries(SR_FLAG_KEYS))
    db.prepare("INSERT OR IGNORE INTO assistant_settings(key,value,updated_at) VALUES(?,?,?)").run(key, (SR_FLAG_DEFAULTS as any)[k] ? "1" : "0", nowIso);
  db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
    day TEXT NOT NULL, salesperson_id INTEGER NOT NULL, plan_id INTEGER NOT NULL DEFAULT 0,
    overdue_reminders INTEGER NOT NULL, p1_no_call INTEGER NOT NULL, test_excluded INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(day, salesperson_id, plan_id));`);
}
export function readSrFlags(db: DatabaseSync): SrFlags {
  const get = (k: string) => (db.prepare("SELECT value FROM assistant_settings WHERE key=?").get(k) as { value?: string } | undefined)?.value;
  const b = (k: keyof SrFlags) => { const v = get(SR_FLAG_KEYS[k]); return v == null ? SR_FLAG_DEFAULTS[k] : v === "1"; };
  return { traineeMoney: b("traineeMoney"), overdueCard: b("overdueCard"), noCommissionAlert: b("noCommissionAlert") };
}
export function validateSrFlags(body: any): { ok: true; values: Array<[string, string]> } | { ok: false; error: string; field?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const out: Array<[string, string]> = [];
  for (const k of Object.keys(body)) {
    if (!(k in SR_FLAG_KEYS)) return { ok: false, error: "unknown_field", field: k };
    if (typeof body[k] !== "boolean") return { ok: false, error: "bad_value", field: k };
    out.push([SR_FLAG_KEYS[k as keyof SrFlags], body[k] ? "1" : "0"]);
  }
  if (!out.length) return { ok: false, error: "empty" };
  return { ok: true, values: out };
}

/* ---------------- ranges ---------------- */
export const SR_RANGES = ["today", "yesterday", "week", "month", "prev_month", "custom"] as const;
export type SrRange = (typeof SR_RANGES)[number];
export type SrWindow = { from: string; to: string };
export type SrBounds = { range: SrRange; current: SrWindow; previous: SrWindow; label: string; previousLabel: string; compareNote: string; complete: boolean; days: number };
const RANGE_FA: Record<SrRange, string> = { today: "امروز", yesterday: "دیروز", week: "این هفته", month: "این ماه", prev_month: "ماه قبل", custom: "بازه‌ی دلخواه" };
const COMPARE_FA: Record<SrRange, string> = { today: "دیروز تا همین ساعت", yesterday: "روز قبلش", week: "هفته‌ی قبل، همان چند روز", month: "همان چند روز ماه قبل",
  prev_month: "ماه پیش از آن", custom: "بازه‌ی هم‌طولِ قبل" };
/** «۱ تا ۴ آبان ۱۴۰۵» — the Tehran days covered by [s, e). */
export function spanLabel(s: number, e: number, withYear = true): string {
  const last = Math.max(s, e - 1); const a = jParts(s), b = jParts(last);
  const y = withYear ? ` ${faJ(last, { year: "numeric" })}` : "";
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${faJ(s, { day: "numeric", month: "long" })}${y}`;
  if (a.y === b.y && a.m === b.m) return `${faJ(s, { day: "numeric" })} تا ${faJ(last, { day: "numeric", month: "long" })}${y}`;
  if (a.y === b.y) return `${faJ(s, { day: "numeric", month: "long" })} تا ${faJ(last, { day: "numeric", month: "long" })}${y}`;
  return `${faJ(s, { day: "numeric", month: "long", year: "numeric" })} تا ${faJ(last, { day: "numeric", month: "long", year: "numeric" })}`;
}
export function srBounds(range: SrRange, now: Date, from?: string | null, to?: string | null): SrBounds | { error: string } {
  const t = now.getTime(); const today = dayStart(t);
  let s: number, e: number, ps: number, pe: number;
  switch (range) {
    case "today": s = today; e = t; ps = s - DAY; pe = ps + (e - s); break;
    case "yesterday": s = today - DAY; e = today; ps = s - DAY; pe = s; break;
    case "week": s = tehranWeekStart(t); e = t; ps = s - 7 * DAY; pe = ps + (e - s); break;
    case "month": s = jalaliMonthStart(t); e = t; ps = jalaliMonthStart(s - DAY); pe = Math.min(ps + (e - s), s); break;
    case "prev_month": e = jalaliMonthStart(t); s = jalaliMonthStart(e - DAY); ps = jalaliMonthStart(s - DAY); pe = s; break;
    case "custom": {
      const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(fromIsoDay(v)) && tehranIsoDay(fromIsoDay(v)) === v;
      if (!ok(from) || !ok(to)) return { error: "bad_dates" };
      s = fromIsoDay(from!); const end = fromIsoDay(to!) + DAY;
      if (end <= s) return { error: "bad_order" };
      if (s > t) return { error: "future" };
      if (end - s > 400 * DAY) return { error: "too_long" };
      const len = end - s; e = Math.min(end, t); ps = s - len; pe = ps + (e - s); break;
    }
    default: return { error: "bad_range" };
  }
  const label = spanLabel(s, e);
  const previousLabel = spanLabel(ps, pe, jParts(ps).y !== jParts(Math.max(s, e - 1)).y);
  return { range, current: { from: new Date(s).toISOString(), to: new Date(e).toISOString() }, previous: { from: new Date(ps).toISOString(), to: new Date(pe).toISOString() },
    label, previousLabel, compareNote: `${RANGE_FA[range]}: ${label} در مقایسه با ${previousLabel} (${COMPARE_FA[range]})`, complete: e <= t && range !== "today" && range !== "week" && range !== "month",
    days: Math.max(1, Math.round((e - s) / DAY)) };
}

/* ---------------- context ---------------- */
type Ctx = { db: DatabaseSync; now: Date; excludeTest: boolean; team: number[]; scope: number[]; plan: number | null };
const notTestC = (x: Ctx, a = "c") => (x.excludeTest ? `AND (${a}.id IS NULL OR NOT ${testCustomerSql(a)})` : "");
/** SQL: customers (alias a) that have a loan application or goods purchase in the plan; "1" when no plan filter. */
function planCustomerSql(x: Ctx, a = "c"): { sql: string; params: number[] } {
  if (x.plan == null) return { sql: "1", params: [] };
  const parts: string[] = []; const p: number[] = [];
  if (has(x.db, "loan_applications")) { parts.push(`SELECT pa.customer_id FROM loan_applications pa WHERE pa.deleted_at IS NULL AND (pa.plan_id=? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(pa.plan_ids) THEN pa.plan_ids ELSE '[]' END) j WHERE CAST(j.value AS INTEGER)=?))`); p.push(x.plan, x.plan); }
  if (has(x.db, "goods_purchases")) { parts.push("SELECT pg.customer_id FROM goods_purchases pg WHERE pg.plan_id=?"); p.push(x.plan); }
  if (!parts.length) return { sql: "0", params: [] };
  return { sql: `${a}.id IN (${parts.join(" UNION ")})`, params: p };
}
const appPlanSql = (x: Ctx, a = "a") => x.plan == null ? { sql: "1", params: [] as number[] }
  : { sql: `(${a}.plan_id=? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${a}.plan_ids) THEN ${a}.plan_ids ELSE '[]' END) j WHERE CAST(j.value AS INTEGER)=?))`, params: [x.plan, x.plan] };
const goodsPlanSql = (x: Ctx, g = "g") => x.plan == null ? { sql: "1", params: [] as number[] } : { sql: `${g}.plan_id=?`, params: [x.plan] };

type Row = { sp: number; customerId: number | null; at: number };
type Money = Row & { amount: bigint };
export type SrNumbers = {
  calls: number; sentToRegistration: number; registrationDone: number; applicationsCreated: number; leads: number; contacted: number;
  siteLeadsNoCall: number; deposited: { count: number; payoutToman: string }; commissionToman: string; noCommissionDeposits: number;
};
type WindowData = {
  calls: TeamCallRow[]; sent: Row[]; done: Row[]; created: Row[]; leads: Row[]; contacted: Row[]; siteNoCall: Row[];
  deposits: (Money & { purchaseId: number; commissioned: boolean })[]; commission: Money[];
};
const inW = (w: SrWindow) => [w.from, w.to];

function windowData(x: Ctx, w: SrWindow, firstCall: Map<number, number>): WindowData {
  const db = x.db; const S = x.scope; const sIn = `(${ph(S)})`;
  const pc = planCustomerSql(x, "c");
  const calls = teamCallRows(db, w.from, w.to, { excludeTest: x.excludeTest }).filter(r => S.includes(r.sp));
  const callsP = x.plan == null ? calls : (() => { const ok = new Set((db.prepare(`SELECT c.id FROM customers c WHERE ${pc.sql}`).all(...pc.params) as any[]).map(r => Number(r.id)));
    return calls.filter(r => r.customerId != null && ok.has(r.customerId)); })();
  const contactedSeen = new Set<number>(); const contacted: Row[] = [];
  for (const r of [...callsP].sort((a, b) => a.at - b.at)) {
    if (r.customerId == null || contactedSeen.has(r.customerId)) continue;
    const f = firstCall.get(r.customerId); if (f == null || f < Date.parse(w.from)) continue;
    contactedSeen.add(r.customerId); contacted.push({ sp: r.sp, customerId: r.customerId, at: r.at });
  }
  const out: WindowData = { calls: callsP, sent: [], done: [], created: [], leads: [], contacted, siteNoCall: [], deposits: [], commission: [] };
  if (has(db, "loan_applications") && has(db, "loan_application_stage_history")) {
    const ap = appPlanSql(x, "a");
    const snap = "COALESCE(a.salesperson_id_snapshot,c.salesperson_id)";
    const first = (stage: string) => (db.prepare(`SELECT x.sp, x.cid, x.first FROM (SELECT a.id, a.customer_id cid, ${snap} sp, MIN(julianday(h.created_at)) first FROM loan_applications a
        JOIN customers c ON c.id=a.customer_id JOIN loan_application_stage_history h ON h.application_id=a.id
        WHERE a.deleted_at IS NULL AND ${snap} IN ${sIn} AND h.to_stage=? AND COALESCE(h.from_stage,'')<>? ${notTestC(x)} AND ${ap.sql}
        GROUP BY a.id) x WHERE x.first>=julianday(?) AND x.first<julianday(?)`).all(...S, stage, stage, ...ap.params, ...inW(w)) as any[])
      .map(r => ({ sp: Number(r.sp), customerId: Number(r.cid), at: (Number(r.first) - 2440587.5) * DAY }));
    out.sent = first("customer_documents_review"); out.done = first("completed");
    out.created = (db.prepare(`SELECT ${snap} sp, a.customer_id cid, a.created_at at FROM loan_applications a JOIN customers c ON c.id=a.customer_id
        WHERE a.deleted_at IS NULL AND ${snap} IN ${sIn} ${notTestC(x)} AND ${ap.sql} AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?)`)
      .all(...S, ...ap.params, ...inW(w)) as any[]).map(r => ({ sp: Number(r.sp), customerId: Number(r.cid), at: ms(r.at) }));
  }
  out.leads = (db.prepare(`SELECT c.salesperson_id sp, c.id cid, c.created_at at FROM customers c WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id IN ${sIn} ${notTestC(x)}
      AND ${pc.sql} AND julianday(c.created_at)>=julianday(?) AND julianday(c.created_at)<julianday(?)`).all(...S, ...pc.params, ...inW(w)) as any[])
    .map(r => ({ sp: Number(r.sp), customerId: Number(r.cid), at: ms(r.at) }));
  if (has(db, "site_lead_requests"))
    out.siteNoCall = (db.prepare(`SELECT c.salesperson_id sp, c.id cid, r.requested_at at FROM site_lead_requests r JOIN customers c ON c.id=r.customer_id
        WHERE c.salesperson_id IN ${sIn} AND c.merged_into_customer_id IS NULL ${notTestC(x)} AND ${pc.sql}
          AND julianday(r.requested_at)>=julianday(?) AND julianday(r.requested_at)<julianday(?) AND (r.answered_at IS NULL OR julianday(r.answered_at)>=julianday(?))`)
      .all(...S, ...pc.params, ...inW(w), w.to) as any[]).map(r => ({ sp: Number(r.sp), customerId: Number(r.cid), at: ms(r.at) }));
  const KINDS = "('salesperson_commission','p1_referral_share','returned_case_deduction','paid_mark_reversal','data_accuracy_bonus','team_bonus')";
  const ledger = has(db, "goods_finance_ledger");
  if (has(db, "goods_purchases")) {
    const gp = goodsPlanSql(x, "g");
    out.deposits = (db.prepare(`SELECT g.id, g.salesperson_id sp, g.customer_id cid, g.completed_at at, g.payout_amount_toman amt,
          ${ledger ? `EXISTS (SELECT 1 FROM goods_finance_ledger l WHERE l.purchase_id=g.id AND l.kind IN ${KINDS})` : "0"} com
        FROM goods_purchases g LEFT JOIN customers c ON c.id=g.customer_id
        WHERE g.salesperson_id IN ${sIn} AND g.stage='completed' AND g.completed_at IS NOT NULL AND ${gp.sql}
          AND julianday(g.completed_at)>=julianday(?) AND julianday(g.completed_at)<julianday(?) ${notTestC(x)}`).all(...S, ...gp.params, ...inW(w)) as any[])
      .map(r => ({ purchaseId: Number(r.id), sp: Number(r.sp), customerId: r.cid == null ? null : Number(r.cid), at: ms(r.at), amount: big(r.amt), commissioned: Boolean(r.com) }));
  }
  if (ledger) {
    const lp = x.plan == null ? { sql: "1", params: [] as number[] } : { sql: "l.plan_id=?", params: [x.plan] };
    out.commission = (db.prepare(`SELECT l.salesperson_id sp, l.customer_id cid, l.created_at at, l.amount_toman amt FROM goods_finance_ledger l LEFT JOIN customers c ON c.id=l.customer_id
        WHERE l.salesperson_id IN ${sIn} AND l.kind IN ${KINDS} AND ${lp.sql} AND julianday(l.created_at)>=julianday(?) AND julianday(l.created_at)<julianday(?) ${notTestC(x)}`)
      .all(...S, ...lp.params, ...inW(w)) as any[]).map(r => ({ sp: Number(r.sp), customerId: r.cid == null ? null : Number(r.cid), at: ms(r.at), amount: big(r.amt) }));
  }
  return out;
}
function numbersOf(d: WindowData, sps: number[] | null): SrNumbers {
  const f = <T extends { sp: number }>(a: T[]) => (sps ? a.filter(r => sps.includes(r.sp)) : a);
  const dep = f(d.deposits);
  return { calls: f(d.calls).length, sentToRegistration: f(d.sent).length, registrationDone: f(d.done).length, applicationsCreated: f(d.created).length,
    leads: f(d.leads).length, contacted: f(d.contacted).length, siteLeadsNoCall: f(d.siteNoCall).length,
    deposited: { count: dep.length, payoutToman: dep.reduce((s, r) => s + r.amount, 0n).toString() },
    commissionToman: f(d.commission).reduce((s, r) => s + r.amount, 0n).toString(), noCommissionDeposits: dep.filter(r => !r.commissioned).length };
}

/* ---------------- "now" numbers ---------------- */
export type OverdueNow = { overdueReminders: number; p1NoCall: number };
/** Open reminders already due + current P1 customers with no real call for more than 3 days, per salesperson (now). */
export function overdueNow(x: Ctx, sps: number[]): Map<number, OverdueNow> {
  const db = x.db; const out = new Map<number, OverdueNow>(sps.map(s => [s, { overdueReminders: 0, p1NoCall: 0 }]));
  if (!sps.length) return out;
  const nowIso = x.now.getTime(); const nowS = x.now.toISOString(); const pc = planCustomerSql(x, "c");
  if (has(db, "reminders")) {
    const rows = db.prepare(`SELECT COALESCE(r.salesperson_id, (SELECT u.salesperson_id FROM users u WHERE u.id=r.user_id AND u.role='salesperson')) sp, COUNT(*) n
        FROM reminders r LEFT JOIN customers c ON c.id=r.customer_id
        WHERE r.done=0 AND julianday(r.remind_at)<julianday(?) AND (r.customer_id IS NULL OR (c.merged_into_customer_id IS NULL ${notTestC(x)}))
          AND ${x.plan == null ? "1" : `c.id IS NOT NULL AND ${pc.sql}`} GROUP BY 1`).all(nowS, ...pc.params) as any[];
    for (const r of rows) { const o = out.get(Number(r.sp)); if (o) o.overdueReminders += Number(r.n); }
  }
  const p1 = db.prepare(`SELECT c.salesperson_id sp, c.created_at, (SELECT MAX(julianday(l.created_at)) FROM call_logs l WHERE l.customer_id=c.id AND ${realCallSql("l.subject")}
        AND julianday(l.created_at)<julianday(?)) lj
      FROM customers c WHERE c.salesperson_id IN (${ph(sps)}) AND c.priority=1 AND c.merged_into_customer_id IS NULL AND COALESCE(c.status,'') NOT IN ('cancelled','completed') ${x.excludeTest ? `AND NOT ${testCustomerSql("c")}` : ""}
        AND ${pc.sql} AND julianday(c.created_at)<julianday(?)`).all(nowS, ...sps, ...pc.params, nowS) as any[];
  for (const c of p1) {
    const ref = c.lj != null ? (Number(c.lj) - 2440587.5) * DAY : ms(c.created_at);
    if (Number.isFinite(ref) && nowIso - ref > P1_NO_CALL_DAYS * DAY) { const o = out.get(Number(c.sp)); if (o) o.p1NoCall++; }
  }
  return out;
}
function openPaymentOrders(x: Ctx): Map<number, number> {
  const m = new Map<number, number>(); if (!has(x.db, "customer_payment_orders")) return m;
  const gp = x.plan == null ? "1" : "o.purchase_id IN (SELECT id FROM goods_purchases WHERE plan_id=?)";
  for (const r of x.db.prepare(`SELECT o.salesperson_id sp, COUNT(*) n FROM customer_payment_orders o LEFT JOIN customers c ON c.id=o.customer_id
      WHERE COALESCE(o.stage,'')<>'paid' AND o.salesperson_id IN (${ph(x.scope)}) AND ${gp} ${notTestC(x)} GROUP BY 1`).all(...x.scope, ...(x.plan == null ? [] : [x.plan])) as any[])
    m.set(Number(r.sp), Number(r.n));
  return m;
}

/* ---------------- daily overdue snapshot (additive table) ---------------- */
/** Writes today's (Tehran) rows once: per salesperson of the team, for all plans (plan_id 0) and per plan. Returns rows written. */
export function takeOverdueSnapshot(db: DatabaseSync, now: Date, excludeTest: boolean): number {
  ensureSalesReportSchema(db, now.toISOString());
  const day = tehranIsoDay(now.getTime());
  if (db.prepare(`SELECT 1 FROM ${SNAPSHOT_TABLE} WHERE day=? LIMIT 1`).get(day)) return 0;
  const team = managerExperts(db).map(e => e.salespersonId); if (!team.length) return 0;
  const plans = has(db, "loan_plans") ? (db.prepare("SELECT id FROM loan_plans ORDER BY id").all() as any[]).map(r => Number(r.id)) : [];
  const ins = db.prepare(`INSERT OR IGNORE INTO ${SNAPSHOT_TABLE}(day,salesperson_id,plan_id,overdue_reminders,p1_no_call,test_excluded,created_at) VALUES(?,?,?,?,?,?,?)`);
  let n = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const plan of [null, ...plans]) {
      const m = overdueNow({ db, now, excludeTest, team, scope: team, plan }, team);
      for (const [sp, v] of m) { if (plan != null && !v.overdueReminders && !v.p1NoCall) continue; // zero rows per plan are implied by the plan-0 row of the day
        n += Number(ins.run(day, sp, plan ?? 0, v.overdueReminders, v.p1NoCall, excludeTest ? 1 : 0, now.toISOString()).changes); }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}
/** Overdue numbers 7 days ago from the snapshot, or null when no row exists for that day («—»). */
export function overdueWeekAgo(db: DatabaseSync, now: Date, sps: number[], plan: number | null): OverdueNow | null {
  if (!has(db, SNAPSHOT_TABLE) || !sps.length) return null;
  const day = tehranIsoDay(now.getTime() - 7 * DAY);
  if (!db.prepare(`SELECT 1 FROM ${SNAPSHOT_TABLE} WHERE day=? AND plan_id=0 LIMIT 1`).get(day)) return null;
  const r = db.prepare(`SELECT COALESCE(SUM(overdue_reminders),0) o, COALESCE(SUM(p1_no_call),0) p FROM ${SNAPSHOT_TABLE} WHERE day=? AND plan_id=? AND salesperson_id IN (${ph(sps)})`)
    .get(day, plan ?? 0, ...sps) as any;
  return { overdueReminders: Number(r?.o ?? 0), p1NoCall: Number(r?.p ?? 0) };
}

/* ---------------- flag ۳: admin bell for «واریز بدون پورسانت» ---------------- */
/** Only while the flag is ON: purchases completed after the flag was switched on, at least 1 hour ago, with no commission row,
 *  get ONE bell row per admin (user 29 never). Nothing is sent outside the CRM (no SMS / Bale). Returns rows written. */
export function noCommissionAlerts(db: DatabaseSync, now: Date, excludeTest: boolean): number {
  if (!readSrFlags(db).noCommissionAlert) return 0;
  if (!has(db, "site_notification_events") || !has(db, "goods_purchases") || !has(db, "goods_finance_ledger")) return 0;
  const on = (db.prepare("SELECT updated_at FROM assistant_settings WHERE key=?").get(SR_FLAG_KEYS.noCommissionAlert) as any)?.updated_at;
  if (!on) return 0;
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('site_notification_events')").all() as any[]).map(r => String(r.name)));
  if (!cols.has("recipient_user_id") || !cols.has("actor_key")) return 0;
  const team = managerExperts(db).map(e => e.salespersonId); if (!team.length) return 0;
  const admins = (db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND id<>29 ORDER BY id").all() as any[]).map(r => Number(r.id));
  if (!admins.length) return 0;
  const rows = db.prepare(`SELECT g.id, g.customer_id, c.name, c.salesperson_id FROM goods_purchases g JOIN customers c ON c.id=g.customer_id
      WHERE g.stage='completed' AND g.completed_at IS NOT NULL AND julianday(g.completed_at)>=julianday(?) AND julianday(g.completed_at)<julianday(?)
        AND g.salesperson_id IN (${ph(team)}) AND c.merged_into_customer_id IS NULL ${excludeTest ? `AND NOT ${testCustomerSql("c")}` : ""}
        AND NOT EXISTS (SELECT 1 FROM goods_finance_ledger l WHERE l.purchase_id=g.id AND l.kind IN ('salesperson_commission','p1_referral_share','team_bonus'))`)
    .all(on, new Date(now.getTime() - HOUR).toISOString(), ...team) as any[];
  const seen = db.prepare("SELECT 1 FROM site_notification_events WHERE resource_type='goods' AND resource_id=? AND kind='deposit-no-commission' AND recipient_user_id=? LIMIT 1");
  const ins = db.prepare(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(?,?,?,'goods',?,'deposit-no-commission','واریز بدون پورسانت',?,'goods_purchases.view',?,'system:sales-report',?)`);
  let n = 0;
  for (const r of rows) for (const uid of admins) {
    if (seen.get(r.id, uid)) continue;
    n += Number(ins.run(r.customer_id, r.name ?? "مشتری", r.salesperson_id ?? null, r.id, "برای این خرید «واریز شد» ثبت شده ولی پورسانتی ثبت نشده است. پرونده را باز کنید.", now.toISOString(), uid).changes);
  }
  return n;
}

/* ---------------- lead sources ---------------- */
export const SOURCE_LABELS = { site: "سایت", instagram: "اینستاگرام", kazemi: "معرفی (از کاظمی)", manual: "دستی / لیست" } as const;
type SourceKey = keyof typeof SOURCE_LABELS;
function sourceOf(db: DatabaseSync): (cid: number | null) => SourceKey {
  const ids = (sql: string, t: string) => (has(db, t) ? new Set((db.prepare(sql).all() as any[]).map(r => Number(r.cid))) : new Set<number>());
  const site = new Set([...ids("SELECT customer_id cid FROM public_leads WHERE customer_id IS NOT NULL", "public_leads"),
    ...ids("SELECT customer_id cid FROM site_lead_requests WHERE customer_id IS NOT NULL", "site_lead_requests"),
    ...ids("SELECT customer_id cid FROM callback_requests WHERE customer_id IS NOT NULL", "callback_requests")]);
  const insta = new Set([...ids("SELECT customer_id cid FROM instagram_threads WHERE customer_id IS NOT NULL", "instagram_threads"),
    ...ids("SELECT customer_id cid FROM instagram_crm_automation_sessions WHERE customer_id IS NOT NULL", "instagram_crm_automation_sessions")]);
  const kaz = ids("SELECT customer_id cid FROM team_sales_qualifications WHERE outcome='handoff'", "team_sales_qualifications");
  return (cid) => (cid == null ? "manual" : site.has(cid) ? "site" : insta.has(cid) ? "instagram" : kaz.has(cid) ? "kazemi" : "manual");
}

/* ---------------- trend ---------------- */
type Step = "day" | "week" | "month";
function buckets(fromMs: number, toMs: number, step: Step): number[] {
  const out: number[] = []; let b = fromMs;
  while (b < toMs && out.length < 400) { out.push(b); b = step === "day" ? b + DAY : step === "week" ? b + 7 * DAY : jalaliMonthStart(b + 32 * DAY); }
  return out.length ? out : [fromMs];
}
function series(starts: number[], end: number, rows: { at: number }[], val: (r: any) => bigint) {
  const v = starts.map(() => 0n);
  for (const r of rows) { if (!(r.at < end)) continue; let i = -1; for (let k = starts.length - 1; k >= 0; k--) if (r.at >= starts[k]) { i = k; break; } if (i >= 0) v[i] += val(r); }
  return v;
}

/* ---------------- the report ---------------- */
export type SalesReportQuery = { range: SrRange; from?: string | null; to?: string | null; expert?: number | null; plan?: number | null };
export function teamSalesReport(db: DatabaseSync, q: SalesReportQuery, now: Date, excludeTest: boolean) {
  const b = srBounds(q.range, now, q.from, q.to); if ("error" in b) return { error: b.error };
  const experts = managerExperts(db);
  const team = experts.map(e => e.salespersonId);
  if (q.expert != null && !team.includes(q.expert)) return { error: "unknown_expert" };
  const plans = has(db, "loan_plans") ? (db.prepare("SELECT id, name, active FROM loan_plans ORDER BY id").all() as any[]).map(r => ({ id: Number(r.id), name: String(r.name), active: Number(r.active ?? 1) === 1 })) : [];
  if (q.plan != null && !plans.some(p => p.id === q.plan)) return { error: "unknown_plan" };
  const flags = readSrFlags(db);
  const scope = q.expert != null ? [q.expert] : team;
  const x: Ctx = { db, now, excludeTest, team, scope, plan: q.plan ?? null };
  // first real call ever per customer (for «تماس گرفته‌شده»: the first call falls inside the period)
  const firstCall = new Map<number, number>();
  for (const r of teamCallRows(db, "1970-01-01T00:00:00.000Z", b.current.to, { excludeTest })) if (r.customerId != null) { const f = firstCall.get(r.customerId); if (f == null || r.at < f) firstCall.set(r.customerId, r.at); }
  const cur = windowData(x, b.current, firstCall); const prev = windowData(x, b.previous, firstCall);
  const ovNow = overdueNow(x, scope); const po = openPaymentOrders(x);
  const trainees = new Set(experts.filter(e => e.trainee).map(e => e.salespersonId));
  const sum = (m: Map<number, OverdueNow>, sps: number[]) => sps.reduce((a, s) => ({ overdueReminders: a.overdueReminders + (m.get(s)?.overdueReminders ?? 0), p1NoCall: a.p1NoCall + (m.get(s)?.p1NoCall ?? 0) }), { overdueReminders: 0, p1NoCall: 0 });
  const poSum = (sps: number[]) => sps.reduce((a, s) => a + (po.get(s) ?? 0), 0);
  const kc = numbersOf(cur, null), kp = numbersOf(prev, null);
  const kpis = {
    deposited: { current: kc.deposited, previous: kp.deposited },
    commission: { current: kc.commissionToman, previous: kp.commissionToman, openPaymentOrders: poSum(scope), noCommissionDeposits: kc.noCommissionDeposits },
    calls: { current: kc.calls, previous: kp.calls },
    sentToRegistration: { current: kc.sentToRegistration, previous: kp.sentToRegistration },
    leads: { current: kc.leads, previous: kp.leads, siteLeadsNoCall: kc.siteLeadsNoCall },
    overdue: flags.overdueCard ? { now: sum(ovNow, scope), weekAgo: overdueWeekAgo(db, now, scope, x.plan) } : null,
  };
  const row = (sps: number[], money: boolean) => {
    const n = numbersOf(cur, sps); const p = numbersOf(prev, sps);
    return { calls: n.calls, previousCalls: p.calls, sentToRegistration: n.sentToRegistration, deposits: n.deposited.count,
      payoutToman: money ? n.deposited.payoutToman : null, commissionToman: money ? n.commissionToman : null,
      openPaymentOrders: money ? poSum(sps) : null, overdue: sum(ovNow, sps) };
  };
  const shown = experts.filter(e => scope.includes(e.salespersonId));
  const expertRows = shown.filter(e => !e.trainee).map(e => ({ salespersonId: e.salespersonId, name: e.name, trainee: false, ...row([e.salespersonId], true) }))
    .sort((a, c) => Number(big(c.payoutToman) - big(a.payoutToman)) || c.calls - a.calls);
  const traineeRows = shown.filter(e => e.trainee).map(e => ({ salespersonId: e.salespersonId, name: e.name, trainee: true, ...row([e.salespersonId], flags.traineeMoney) }))
    .sort((a, c) => c.calls - a.calls);
  const expSps = shown.filter(e => !e.trainee).map(e => e.salespersonId); const trSps = shown.filter(e => e.trainee).map(e => e.salespersonId);
  const funnelKeys: [keyof SrNumbers | "deposits", string][] = [["leads", "سرنخ"], ["contacted", "تماس گرفته‌شده"], ["applicationsCreated", "درخواست ساخته‌شده"],
    ["sentToRegistration", "ارسال به ثبت"], ["registrationDone", "تکمیل ثبت"], ["deposits", "واریز به مشتری"]];
  const fv = (n: SrNumbers, k: string) => (k === "deposits" ? n.deposited.count : Number((n as any)[k]));
  const funnel = funnelKeys.map(([k, label], i) => ({ key: k, label, current: fv(kc, k), previous: fv(kp, k),
    ofPrevious: i === 0 ? null : (fv(kc, funnelKeys[i - 1][0]) ? Math.round((fv(kc, k) / fv(kc, funnelKeys[i - 1][0])) * 1000) / 10 : null) }));
  // trend
  const cs = Date.parse(b.current.from), ce = Date.parse(b.current.to), psm = Date.parse(b.previous.from), pe = Date.parse(b.previous.to);
  const spanDays = (ce - cs) / DAY; const step: Step = spanDays <= 31 ? "day" : spanDays <= 90 ? "week" : "month";
  const cb = buckets(cs, ce, step); const pb = buckets(psm, Math.max(pe, psm + 1), step).slice(0, cb.length);
  const one = () => 1n;
  const cCalls = series(cb, ce, cur.calls, one), pCalls = series(pb, pe, prev.calls, one);
  const cMoney = series(cb, ce, cur.deposits, (r) => r.amount), pMoney = series(pb, pe, prev.deposits, (r) => r.amount);
  const trend = { step, points: cb.map((s, i) => ({ start: new Date(s).toISOString(), label: step === "month" ? faJ(s + DAY / 2, { month: "long" }) : faJ(s + DAY / 2, { day: "numeric", month: "short" }),
    calls: Number(cCalls[i]), previousCalls: i < pb.length ? Number(pCalls[i]) : null,
    payoutToman: cMoney[i].toString(), previousPayoutToman: i < pb.length ? pMoney[i].toString() : null })) };
  // sources
  const src = sourceOf(db);
  const srcAgg = new Map<SourceKey, { leads: number; sentToRegistration: number; deposits: number; payoutToman: bigint }>((Object.keys(SOURCE_LABELS) as SourceKey[]).map(k => [k, { leads: 0, sentToRegistration: 0, deposits: 0, payoutToman: 0n }]));
  for (const r of cur.leads) srcAgg.get(src(r.customerId))!.leads++;
  for (const r of cur.sent) srcAgg.get(src(r.customerId))!.sentToRegistration++;
  for (const r of cur.deposits) { const a = srcAgg.get(src(r.customerId))!; a.deposits++; a.payoutToman += r.amount; }
  const sources = [...srcAgg].map(([k, v]) => ({ key: k, label: SOURCE_LABELS[k], ...v, payoutToman: v.payoutToman.toString() }));
  // open invoices + stuck registration cases (now), filtered by scope and plan
  const deps = { db, now, excludeTest };
  const goodsPlan = new Map<number, number | null>(has(db, "goods_purchases") ? (db.prepare("SELECT id, plan_id FROM goods_purchases").all() as any[]).map(r => [Number(r.id), r.plan_id == null ? null : Number(r.plan_id)]) : []);
  const appPlans = new Map<number, number[]>(has(db, "loan_applications") ? (db.prepare("SELECT id, plan_id, plan_ids FROM loan_applications").all() as any[]).map(r => {
    let ids: number[] = []; try { const j = JSON.parse(r.plan_ids ?? "[]"); if (Array.isArray(j)) ids = j.map(Number); } catch { /* none */ }
    return [Number(r.id), [...new Set([...(r.plan_id == null ? [] : [Number(r.plan_id)]), ...ids])]];
  }) : []);
  const inv = openInvoices(deps).items.filter(i => i.salesperson && scope.includes(i.salesperson.salespersonId) && (x.plan == null || goodsPlan.get(i.purchaseId) === x.plan));
  const byStage = <T extends { stage: string; stageLabel: string }>(items: T[], amt?: (i: T) => number) => {
    const m = new Map<string, { stage: string; label: string; count: number; amount: number }>();
    for (const i of items) { const v = m.get(i.stage) ?? { stage: i.stage, label: i.stageLabel, count: 0, amount: 0 }; v.count++; v.amount += amt ? amt(i) : 0; m.set(i.stage, v); }
    return [...m.values()].sort((a, c) => c.count - a.count);
  };
  const openInv = { count: inv.length, amountToman: inv.reduce((s, i) => s + (i.amount ?? 0), 0), byStage: byStage(inv, i => i.amount ?? 0),
    oldest: inv.slice(0, 3).map(i => ({ purchaseId: i.purchaseId, customerId: i.customerId, customerName: i.customerName, stageLabel: i.stageLabel, daysInStage: i.daysInStage, link: `/goods-purchases/${i.purchaseId}` })) };
  const reg = registrationReport(deps, "day", 7 * 24, "default");
  const stuckItems = reg.stuck.items.filter(i => i.salesperson && scope.includes(i.salesperson.salespersonId) && (x.plan == null || (appPlans.get(i.applicationId) ?? []).includes(x.plan)));
  const stuck = { count: stuckItems.length, thresholdDays: 7, byStage: byStage(stuckItems),
    oldest: stuckItems.slice(0, 3).map(i => ({ applicationId: i.applicationId, customerId: i.customerId, customerName: i.customerName, stageLabel: i.stageLabel, daysInStage: i.daysInStage, link: `/loan-applications/${i.applicationId}` })) };
  return {
    ...b, timezone: "Asia/Tehran", weekStarts: "saturday", month: "jalali", generatedAt: now.toISOString(), testCustomersExcluded: excludeTest,
    filters: { expert: q.expert ?? null, plan: q.plan ?? null },
    flags,
    experts: experts.map(e => ({ salespersonId: e.salespersonId, name: e.name, trainee: e.trainee })),
    plans: plans.map(p => ({ id: p.id, name: p.name, active: p.active })),
    kpis,
    table: { experts: expertRows, expertsTotal: { label: "جمع کارشناس‌ها (بدون کارآموزها)", ...row(expSps, true) },
      trainees: traineeRows, traineesTotal: trSps.length ? { label: "جمع کارآموزها", ...row(trSps, flags.traineeMoney) } : null },
    funnel, trend, sources, openInvoices: openInv, stuck,
    empty: kc.calls + kc.leads + kc.sentToRegistration + kc.deposited.count + kc.applicationsCreated + kc.registrationDone === 0,
    definitions: {
      scope: "کارت‌ها کل تیم را می‌شمارند (کارشناس‌ها و کارآموزها). ردیف «جمع کارشناس‌ها» کارآموزها را ندارد.",
      calls: "تعداد تماس‌ها به نام کسی که تماس گرفته است. تماس‌های «محدثه ابوالقاسمی» برای خانم قاسمی و تماس‌های بدون کارشناس یا حساب «مهمون» برای مالک سرنخ حساب می‌شود.",
      sentToRegistration: "پرونده‌هایی که برای اولین بار در این بازه به «بررسی مدارک مشتری» رفته‌اند.",
      registrationDone: "«تکمیل ثبت»: پرونده‌هایی که برای اولین بار در این بازه به مرحله‌ی «تکمیل شده» رسیده‌اند (بعد از آن منتظر واریز است).",
      deposited: "خریدهایی که در این بازه «واریز شد» شده‌اند: تعداد و جمع مبلغ واریزی به مشتری.",
      commission: "جمع پورسانت ثبت‌شده در این بازه. «دستور پرداخت باز» = دستورهای پرداختی که هنوز «پرداخت شد» نشده‌اند (الان).",
      leads: "مشتری‌های تازه‌ی این بازه، به نام مالک فعلی. سرنخ سایت بی‌تماس = درخواست سایت این بازه که تا پایان بازه تماسی نگرفته.",
      overdue: "الان: یادآورهای باز با موعد گذشته + اولویت ۱های بیش از ۳ روز بی‌تماس. «۷ روز پیش» از عکس روزانه خوانده می‌شود و تا وقتی عکسِ ۷ روز پیش نباشد «—» است.",
      funnel: "همه‌ی مرحله‌ها رویدادهای داخل همین بازه‌اند، نه یک گروه ثابت از مشتری‌ها.",
      plan: "فیلتر طرح روی همه‌چیز اعمال می‌شود: پرونده‌ها و خریدهای همان طرح، و برای تماس، سرنخ و یادآور، مشتری‌هایی که پرونده یا خریدی در آن طرح دارند.",
      stuck: "پرونده‌های باز ثبت که بیش از ۷ روز در همان مرحله مانده‌اند.",
    },
    footnote: "بازه‌ی جاری تا همین الان حساب شده و با همان مدت از بازه‌ی قبل مقایسه شده است.",
  };
}

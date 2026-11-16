/**
 * گزارش عملکرد فروش (flag.sales_performance_v1, absent = OFF).
 * Additive only: wallet_charge_salesperson + sales_team_membership_history.
 * Nothing in team_sales_config, notification_settings, contracts, or loan_plans is touched.
 *
 * Decisions (Mohammad t988s4162 / t991s4180, Armita v1.0 §6 defaults):
 *  - Successful sale = first entry to loan stage `completed` (not goods payout).
 *  - Best in the same role & period = 100; trainees excluded from rankings and the "best" set.
 *  - First-call weights: calls 30, unique 25, duration 20, answered % 10, filed-or-advanced 15.
 *  - P1 weights: successful sales 30, filed 20, advanced 20, calls 10, duration 10, wallet 10.
 *  - Data before 2026-11-03 (Tehran) is marked «داده‌ی ناقص» for duration / answered / inbound-outbound.
 *  - Team totals use current membership (plus history recorded from now, when the flag is ON).
 *  - Access is enforced in the API: admin + sales_manager see everyone; an expert gets only their
 *    own report and rank (no names or numbers of others); a trainee gets their own numbers, no rank.
 */
import type { DatabaseSync } from "node:sqlite";
import { callOutcome, dayNumber, reportRange, type ReportInput } from "./sales-report";
import { REPORT_CALL_ALIASES, REPORT_GUEST_NAMES, companyNoAnswerLogSql } from "./expert-calls";
import { realCallSql } from "./real-call";
import { excludeTestOn, notTestCustomerIdSql, testCustomerSql } from "./test-customers";
import { isTraineeSalespersonOn, type TraineeQueryDb } from "./multi-team";
import { effectiveRole } from "./sales-manager";
import type { AuthUser } from "./auth";

export const SP_FLAG = "flag.sales_performance_v1";
export const INCOMPLETE_FROM = "2026-11-03"; // Tehran calendar day; duration / answered / direction reliable from this day.
export const EXCLUDED_USER_IDS = [29];
export const WEIGHTS_FIRST = { calls: 30, unique: 25, duration: 20, ansPct: 10, filedOrAdvanced: 15 } as const;
export const WEIGHTS_P1 = { done: 30, filed: 20, advanced: 20, calls: 10, duration: 10, wallet: 10 } as const;
export const ROLE_FIRST = "first_call";
export const ROLE_P1 = "p1";
export type ScoreRole = typeof ROLE_FIRST | typeof ROLE_P1;
export const ROLE_LABEL: Record<ScoreRole, string> = { first_call: "تماس اول", p1: "اولویت ۱" };

/** Canonical loan-application stage order (routes/loan-applications.ts). Forward = a higher index. */
export const LOAN_STAGES = [
  "funder_initial_approval", "draft", "primary_contract_pending_signature", "approved_contract_pending_signature",
  "customer_documents_upload", "customer_documents_review", "guarantor_registration", "guarantor_documents_upload",
  "guarantor_documents_review", "collateral_upload", "collateral_review", "expert_approval",
  "funder_amendment_pending_signature", "funder_amendment_review", "funder_result_review", "funder_documents_correction",
  "physical_documents_submission", "physical_documents_review", "physical_documents_correction",
  "wallet_charge_pending", "admin_approval", "final_invoice_pending_signature", "completed",
] as const;
const STAGE_IX = Object.fromEntries(LOAN_STAGES.map((s, i) => [s, i])) as Record<string, number>;
const BACK_ACTIONS = /return|reject|cancel|note-added|case-note/i;

const DAY = 86_400_000;
const OFFSET = 210 * 60_000;
const has = (db: DatabaseSync, t: string) => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)); }
  catch { return false; }
};
const cols = (db: DatabaseSync, t: string) => {
  try { return new Set((db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name)); }
  catch { return new Set<string>(); }
};
const setting = (db: TraineeQueryDb, key: string): string | null => {
  try {
    if (!has(db as DatabaseSync, "call_queue_settings")) return null;
    return ((db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(key) as { value?: string } | undefined)?.value) ?? null;
  } catch { return null; }
};
export function spFlagOn(db: TraineeQueryDb): boolean {
  return setting(db, SP_FLAG) === "1";
}
export function spFlagOnUser(db: TraineeQueryDb, userId?: number | null): boolean {
  if (spFlagOn(db)) return true;
  if (!userId) return false;
  return setting(db, `${SP_FLAG}.user.${Number(userId)}`) === "1";
}

/* ---------------- schema (additive) ---------------- */

const schemaReady = new WeakSet<object>();
export function resetSalesPerformanceSchemaCache(): void { /* WeakSet is per-db; kept for tests. */ }
export function ensureSalesPerformanceSchema(db: DatabaseSync): void {
  if (schemaReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_charge_salesperson (
      ledger_id INTEGER PRIMARY KEY,
      salesperson_id INTEGER,
      customer_id INTEGER NOT NULL,
      amount TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wcs_sp_at ON wallet_charge_salesperson(salesperson_id, created_at);
    CREATE TABLE IF NOT EXISTS sales_team_membership_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salesperson_id INTEGER NOT NULL,
      team_id INTEGER,
      is_lead INTEGER NOT NULL DEFAULT 0,
      owns_none INTEGER NOT NULL DEFAULT 0,
      owns_p1 INTEGER NOT NULL DEFAULT 0,
      owns_p2 INTEGER NOT NULL DEFAULT 0,
      owns_p3 INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stmh_sp ON sales_team_membership_history(salesperson_id, started_at);
  `);
  schemaReady.add(db);
}

/** Record the customer's then-current owner on a cash-wallet credit. No-op when the flag is OFF. */
export function recordWalletChargeSalesperson(
  db: DatabaseSync,
  row: { ledgerId: number; customerId: number; amount?: string | null; at?: string },
): void {
  if (!spFlagOn(db)) return;
  ensureSalesPerformanceSchema(db);
  const at = row.at || new Date().toISOString();
  const sp = (db.prepare("SELECT salesperson_id FROM customers WHERE id=?").get(row.customerId) as { salesperson_id: number | null } | undefined)?.salesperson_id ?? null;
  db.prepare(`INSERT OR IGNORE INTO wallet_charge_salesperson(ledger_id,salesperson_id,customer_id,amount,created_at)
    VALUES(?,?,?,?,?)`).run(row.ledgerId, sp, row.customerId, row.amount ?? null, at);
}

type MemberSnap = { salespersonId: number; teamId: number; isLead: number; ownsNone: number; ownsP1: number; ownsP2: number; ownsP3: number };
function currentMembers(db: DatabaseSync): MemberSnap[] {
  if (!has(db, "sales_team_members") || !has(db, "sales_teams")) return [];
  return (db.prepare(`SELECT m.salesperson_id sp, m.team_id teamId, m.is_lead isLead, m.owns_none ownsNone,
      m.owns_p1 ownsP1, m.owns_p2 ownsP2, m.owns_p3 ownsP3
    FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1`).all() as any[])
    .map((r) => ({
      salespersonId: Number(r.sp), teamId: Number(r.teamId),
      isLead: Number(r.isLead) ? 1 : 0, ownsNone: Number(r.ownsNone) ? 1 : 0,
      ownsP1: Number(r.ownsP1) ? 1 : 0, ownsP2: Number(r.ownsP2) ? 1 : 0, ownsP3: Number(r.ownsP3) ? 1 : 0,
    }));
}
function sameSnap(a: MemberSnap, b: { team_id: number | null; is_lead: number; owns_none: number; owns_p1: number; owns_p2: number; owns_p3: number }): boolean {
  return a.teamId === Number(b.team_id) && a.isLead === Number(b.is_lead) && a.ownsNone === Number(b.owns_none)
    && a.ownsP1 === Number(b.owns_p1) && a.ownsP2 === Number(b.owns_p2) && a.ownsP3 === Number(b.owns_p3);
}

/**
 * Diff current membership against open history rows and close / open rows as needed.
 * Called after team-builder writes when the flag is ON. Never deletes history.
 */
export function syncTeamMembershipHistory(db: DatabaseSync, now = new Date(), reason = "sync"): void {
  if (!spFlagOn(db)) return;
  ensureSalesPerformanceSchema(db);
  const at = now.toISOString();
  const cur = currentMembers(db);
  const open = db.prepare(`SELECT id, salesperson_id, team_id, is_lead, owns_none, owns_p1, owns_p2, owns_p3
    FROM sales_team_membership_history WHERE ended_at IS NULL`).all() as any[];
  const bySp = new Map<number, any>();
  for (const r of open) bySp.set(Number(r.salesperson_id), r);
  const seen = new Set<number>();
  const ins = db.prepare(`INSERT INTO sales_team_membership_history
    (salesperson_id,team_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,started_at,ended_at,reason)
    VALUES(?,?,?,?,?,?,?,?,NULL,?)`);
  const close = db.prepare("UPDATE sales_team_membership_history SET ended_at=? WHERE id=? AND ended_at IS NULL");
  for (const m of cur) {
    seen.add(m.salespersonId);
    const prev = bySp.get(m.salespersonId);
    if (prev && sameSnap(m, prev)) continue;
    if (prev) close.run(at, prev.id);
    ins.run(m.salespersonId, m.teamId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, at, reason);
  }
  for (const r of open) {
    if (seen.has(Number(r.salesperson_id))) continue;
    close.run(at, r.id);
  }
}

/** If history is empty when the flag first turns on, snapshot current membership (starting now). */
export function seedMembershipHistoryIfEmpty(db: DatabaseSync, now = new Date()): void {
  if (!spFlagOn(db)) return;
  ensureSalesPerformanceSchema(db);
  const n = Number((db.prepare("SELECT COUNT(*) n FROM sales_team_membership_history").get() as any)?.n ?? 0);
  if (n > 0) return;
  const at = now.toISOString();
  const ins = db.prepare(`INSERT INTO sales_team_membership_history
    (salesperson_id,team_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,started_at,ended_at,reason)
    VALUES(?,?,?,?,?,?,?,?,NULL,'seed')`);
  for (const m of currentMembers(db)) ins.run(m.salespersonId, m.teamId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, at);
}

/* ---------------- time / periods ---------------- */

export type PeriodKind = "day" | "week" | "month" | "custom";
const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const faRange = (fromDay: number, toDay: number) => {
  const fmt = (d: number, withYear = true) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "UTC", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(d * DAY));
  if (fromDay === toDay) return fmt(fromDay);
  return `${fmt(fromDay, false)} تا ${fmt(toDay)}`;
};
export type Window = { fromIso: string; toIso: string; startDay: number; endDay: number };
function windowFor(startDay: number, endDay: number, nowMs: number, clipOpen: boolean): Window {
  const fromMs = startDay * DAY - OFFSET;
  const endMs = (endDay + 1) * DAY - OFFSET;
  const toMs = clipOpen && endMs > nowMs ? nowMs : endMs;
  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), startDay, endDay };
}
export function performanceWindow(input: { period?: string; from?: string; to?: string; anchor?: string }, now = new Date()): {
  period: PeriodKind; current: Window; previous: Window; label: string; previousLabel: string; complete: boolean;
} {
  const period = (input.period ?? "day") as PeriodKind;
  if (!["day", "week", "month", "custom"].includes(period)) throw new Error("نوع بازه گزارش معتبر نیست.");
  const range = reportRange({
    period: period === "custom" ? "custom" : period,
    from: input.from, to: input.to, anchor: input.anchor,
  }, now);
  const nowMs = now.getTime();
  const complete = (range.end + 1) * DAY - OFFSET <= nowMs;
  const cur = windowFor(range.start, range.end, nowMs, period !== "custom");
  const len = range.end - range.start + 1;
  const prevEnd = range.start - 1;
  const prevStart = prevEnd - len + 1;
  // Open current period (today / this week / this month): compare the same elapsed length of the previous period.
  const elapsedDays = complete || period === "custom" ? len
    : Math.max(1, dayNumber(new Date(Math.min(nowMs, (range.end + 1) * DAY - OFFSET) - 1).toISOString()) - range.start + 1);
  const prev = windowFor(prevStart, prevStart + elapsedDays - 1, nowMs, false);
  return {
    period, current: cur, previous: prev, complete,
    label: faRange(range.start, range.end),
    previousLabel: faRange(prev.startDay, prev.endDay),
  };
}
export function periodOverlapsIncomplete(w: Window): boolean {
  const cut = dayNumber(INCOMPLETE_FROM + "T00:00:00Z");
  return w.startDay < cut;
}

/* ---------------- access ---------------- */

export type AccessKind = "manager" | "expert" | "trainee" | "none";
export function accessOf(u: AuthUser | null | undefined, db: TraineeQueryDb): AccessKind {
  if (!u) return "none";
  if (EXCLUDED_USER_IDS.includes(Number(u.id))) return "none";
  const role = effectiveRole(u.role);
  if (role === "admin") return "manager";
  if (u.role === "salesperson" && u.salespersonId) {
    return isTraineeSalespersonOn(db, u.salespersonId) ? "trainee" : "expert";
  }
  return "none";
}

export function scoreRoleOf(m: { isLead?: boolean; ownsNone?: boolean; ownsP1?: boolean } | null | undefined): ScoreRole | null {
  if (!m) return null;
  if (m.ownsNone && !m.ownsP1) return ROLE_FIRST;
  if (m.ownsP1) return ROLE_P1;
  if (m.isLead) return ROLE_FIRST;
  return null;
}

/* ---------------- metric types ---------------- */

export type MetricKey =
  | "calls" | "unique" | "duration" | "avgDuration" | "inbound" | "outbound"
  | "answered" | "noAnswer" | "answeredInbound" | "noAnswerInbound"
  | "filed" | "advanced" | "done" | "wallet" | "ansPct" | "filedOrAdvanced";
export const INCOMPLETE_KEYS: MetricKey[] = [
  "duration", "avgDuration", "inbound", "outbound", "answered", "noAnswer",
  "answeredInbound", "noAnswerInbound", "ansPct",
];
export type Counts = {
  calls: number; unique: number; duration: number; inbound: number; outbound: number;
  answered: number; noAnswer: number; answeredInbound: number; noAnswerInbound: number;
  filed: number; advanced: number; done: number; wallet: number; walletRial: number;
};
const emptyCounts = (): Counts => ({
  calls: 0, unique: 0, duration: 0, inbound: 0, outbound: 0,
  answered: 0, noAnswer: 0, answeredInbound: 0, noAnswerInbound: 0,
  filed: 0, advanced: 0, done: 0, wallet: 0, walletRial: 0,
});
export function ansPctOf(c: Counts): number | null {
  return c.calls ? Math.round((c.answered / c.calls) * 100) : null;
}
export function avgDurationOf(c: Counts): number | null {
  return c.calls && c.duration ? Math.round(c.duration / c.calls / 60) : (c.calls ? 0 : null);
}
export function metricValue(c: Counts, key: MetricKey): number {
  if (key === "ansPct") return ansPctOf(c) ?? 0;
  if (key === "avgDuration") return avgDurationOf(c) ?? 0;
  if (key === "filedOrAdvanced") return c.filed + c.advanced;
  if (key === "wallet") return c.wallet;
  return Number((c as any)[key] ?? 0);
}

/* ---------------- phone + call rows ---------------- */

export function phoneKey(phone: string | null | undefined, fallback?: string): string {
  let value = String(phone ?? "").replace(/[۰-۹]/g, (x) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x)))
    .replace(/[٠-٩]/g, (x) => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).replace(/\D/g, "");
  if (value.startsWith("0098")) value = "0" + value.slice(4);
  else if (value.startsWith("98") && value.length === 12) value = "0" + value.slice(2);
  else if (value.length === 10 && value.startsWith("9")) value = "0" + value;
  return value || fallback || "";
}
const parseAt = (v: unknown) => {
  const s = String(v ?? "");
  return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "Z" : s);
};
function durSec(billsec: unknown, durationSeconds: unknown, started: unknown, ended: unknown): number | null {
  const b = Number(billsec);
  if (Number.isFinite(b) && b > 0) return Math.round(b);
  const d = Number(durationSeconds);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  const a = parseAt(started), e = parseAt(ended);
  if (Number.isFinite(a) && Number.isFinite(e)) {
    const s = Math.round((e - a) / 1000);
    if (s > 0 && s <= 3600) return s;
  }
  return null;
}

export type CallFact = {
  sp: number; at: number; outcome: "yes" | "no" | "unknown";
  direction: "incoming" | "outgoing" | null; phone: string; duration: number | null; companyNoAnswer: boolean;
};

function reportSpSql(db: DatabaseSync): { log: string; logParams: (string | number)[]; voip: string } {
  const snap = cols(db, "call_logs").has("salesperson_name_snapshot");
  const nm = snap ? "trim(COALESCE(l.salesperson_name_snapshot,''))" : "''";
  const al = Object.entries(REPORT_CALL_ALIASES).flatMap(([sp, names]) => names.map((n) => [n, Number(sp)] as [string, number]));
  const g = REPORT_GUEST_NAMES.map((n) => `'${n}'`).join(",");
  const voipName = cols(db, "voip_after_call_events").has("expert_name");
  return {
    log: `(CASE ${snap ? al.map(() => `WHEN ${nm}=? THEN ?`).join(" ") : ""} WHEN l.salesperson_id IS NULL OR ${nm} IN (${g}) THEN gc.salesperson_id ELSE l.salesperson_id END)`,
    logParams: snap ? al.flat() : [],
    voip: `(CASE WHEN e.salesperson_id IS NULL${voipName ? ` OR trim(COALESCE(e.expert_name,'')) IN (${g})` : ""} THEN gc.salesperson_id ELSE e.salesperson_id END)`,
  };
}

export function performanceCallRows(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): CallFact[] {
  if (!has(db, "call_logs")) return [];
  const voip = has(db, "voip_after_call_events");
  const click = voip && has(db, "voip_click_calls") && cols(db, "voip_click_calls").has("billsec");
  const vcid = voip && cols(db, "voip_after_call_events").has("customer_id");
  const mo = cols(db, "call_logs").has("call_result");
  const q = has(db, "team_sales_qualifications");
  const evPhone = voip && cols(db, "voip_after_call_events").has("phone");
  const evDur = voip && cols(db, "voip_after_call_events").has("duration_seconds");
  const evEnd = voip && cols(db, "voip_after_call_events").has("ended_at");
  const evDir = voip && cols(db, "voip_after_call_events").has("direction");
  const tl = excludeTest ? `AND ${notTestCustomerIdSql("l.customer_id")}` : "";
  const tv = excludeTest && vcid ? `AND ${notTestCustomerIdSql("e.customer_id")}` : "";
  const at = voip ? "COALESCE(e.started_at,l.created_at)" : "l.created_at";
  const rep = reportSpSql(db);
  const snap = cols(db, "call_logs").has("salesperson_name_snapshot");
  const coLog = voip && snap ? companyNoAnswerLogSql("l", "e") : "0";
  const clickJoin = click ? "LEFT JOIN voip_click_calls cc ON cc.event_id=e.id" : "";
  const bill = click ? "cc.billsec" : "NULL";
  const durCol = evDur ? "e.duration_seconds" : "NULL";
  const endCol = evEnd ? "e.ended_at" : "NULL";
  const dirCol = evDir ? "e.direction" : "NULL";
  const phoneLog = "c.phone";
  const phoneEv = evPhone ? "COALESCE(c2.phone, e.phone)" : "c2.phone";
  const qres = q ? "(SELECT call_result FROM team_sales_qualifications tq WHERE tq.call_log_id=l.id ORDER BY tq.id DESC LIMIT 1)" : "NULL";
  const sql = `SELECT ${rep.log} sp, ${at} at, ${voip ? "e.status" : "NULL"} status, ${voip ? "e.mobile_answered_at" : "NULL"} mobile_answered_at,
      ${mo ? "l.call_result" : "NULL"} mo, ${qres} qres, ${dirCol} direction, ${phoneLog} phone, ${bill} billsec, ${durCol} duration_seconds,
      ${voip ? "e.started_at" : "NULL"} started_at, ${endCol} ended_at, ${coLog} co
    FROM call_logs l ${voip ? "LEFT JOIN voip_after_call_events e ON e.call_log_id=l.id" : ""} ${clickJoin}
      LEFT JOIN customers gc ON gc.id=l.customer_id LEFT JOIN customers c ON c.id=l.customer_id
    WHERE ${realCallSql("l.subject")} ${voip ? "AND COALESCE(e.is_live,0)=0" : ""} ${tl}
      AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)
    ${voip ? `UNION ALL SELECT ${vcid ? rep.voip : "e.salesperson_id"} sp, e.started_at at, e.status, e.mobile_answered_at, NULL mo, NULL qres,
      ${dirCol} direction, ${phoneEv} phone, ${bill} billsec, ${durCol} duration_seconds, e.started_at started_at, ${endCol} ended_at,
      ${`(${`e.id IS NOT NULL AND e.direction='incoming' AND e.status='NO ANSWER' AND e.salesperson_id IS NULL
        AND e.expert_user_id IS NULL AND trim(COALESCE(e.expert_name,''))='' AND e.extension IS NULL`})`} co
      FROM voip_after_call_events e ${clickJoin} ${vcid ? "LEFT JOIN customers gc ON gc.id=e.customer_id LEFT JOIN customers c2 ON c2.id=e.customer_id" : "LEFT JOIN customers c2 ON 0"}
      WHERE e.call_log_id IS NULL AND e.is_live=0 ${tv} AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)` : ""}`;
  const p: any[] = [...rep.logParams, fromIso, toIso];
  if (voip) p.push(fromIso, toIso);
  const out: CallFact[] = [];
  for (const r of db.prepare(sql).all(...p) as any[]) {
    if (r.sp == null) continue;
    let o = callOutcome(r.status, r.mobile_answered_at, r.mo);
    if (o === "unknown" && r.qres) o = r.qres === "answered" ? "yes" : r.qres === "no_answer" || r.qres === "off_or_busy" ? "no" : "unknown";
    const dir = r.direction === "incoming" || r.direction === "outgoing" ? r.direction : null;
    out.push({
      sp: Number(r.sp), at: parseAt(r.at), outcome: o, direction: dir,
      phone: phoneKey(r.phone, r.sp + ":" + String(r.at)),
      duration: durSec(r.billsec, r.duration_seconds, r.started_at, r.ended_at),
      companyNoAnswer: Number(r.co) === 1,
    });
  }
  return out;
}

function addCalls(c: Counts, rows: CallFact[], uniqueSet?: Set<string>): void {
  for (const r of rows) {
    if (r.companyNoAnswer) continue;
    c.calls++;
    if (r.outcome === "yes") c.answered++;
    else if (r.outcome === "no") c.noAnswer++;
    if (r.direction === "incoming") {
      c.inbound++;
      if (r.outcome === "yes") c.answeredInbound++;
      else if (r.outcome === "no") c.noAnswerInbound++;
    } else if (r.direction === "outgoing") c.outbound++;
    if (r.duration) c.duration += r.duration;
    if (r.phone) {
      if (uniqueSet) uniqueSet.add(r.phone);
      else { /* per-expert set filled by caller */ }
    }
  }
}

/* ---------------- cases / wallet ---------------- */

function appSpSql(db: DatabaseSync): string {
  return cols(db, "loan_applications").has("salesperson_id_snapshot")
    ? "COALESCE(a.salesperson_id_snapshot,c.salesperson_id)" : "c.salesperson_id";
}
function notTestJoin(excludeTest: boolean, alias = "c"): string {
  return excludeTest ? `AND (${alias}.id IS NULL OR NOT ${testCustomerSql(alias)})` : "";
}

export function filedByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, number> {
  const out = new Map<number, number>();
  if (!has(db, "loan_applications")) return out;
  const snap = appSpSql(db);
  const rows = db.prepare(`SELECT ${snap} sp, COUNT(*) n FROM loan_applications a
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?)
      AND ${snap} IS NOT NULL
    GROUP BY ${snap}`).all(fromIso, toIso) as any[];
  for (const r of rows) out.set(Number(r.sp), Number(r.n));
  return out;
}

function isForwardMove(fromStage: string | null, toStage: string | null, action: string | null): boolean {
  if (!toStage || !fromStage || fromStage === toStage) return false;
  if (action && BACK_ACTIONS.test(action)) return false;
  const a = STAGE_IX[fromStage], b = STAGE_IX[toStage];
  if (a == null || b == null) return false;
  return b > a;
}

export function advancedByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, number> {
  const out = new Map<number, number>();
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return out;
  const snap = appSpSql(db);
  const rows = db.prepare(`SELECT ${snap} sp, a.id app, h.from_stage fs, h.to_stage ts, h.action act
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND julianday(h.created_at)>=julianday(?) AND julianday(h.created_at)<julianday(?)
      AND ${snap} IS NOT NULL`).all(fromIso, toIso) as any[];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isForwardMove(r.fs, r.ts, r.act)) continue;
    const k = `${Number(r.sp)}:${Number(r.app)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.set(Number(r.sp), (out.get(Number(r.sp)) ?? 0) + 1);
  }
  return out;
}

/** Successful sale = first entry to stage `completed` in the window (Mohammad t991s4180). */
export function completedByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, number> {
  const out = new Map<number, number>();
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return out;
  const snap = appSpSql(db);
  const rows = db.prepare(`SELECT ${snap} sp, a.id app, MIN(julianday(h.created_at)) first
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND h.to_stage='completed' ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL
    GROUP BY a.id
    HAVING first>=julianday(?) AND first<julianday(?)`).all(fromIso, toIso) as any[];
  for (const r of rows) out.set(Number(r.sp), (out.get(Number(r.sp)) ?? 0) + 1);
  return out;
}

export function walletByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, { count: number; toman: number }> {
  const out = new Map<number, { count: number; toman: number }>();
  const add = (sp: number, amt: number) => {
    const cur = out.get(sp) ?? { count: 0, toman: 0 };
    cur.count++; cur.toman += amt;
    out.set(sp, cur);
  };
  const toman = (v: unknown) => {
    const s = String(v ?? "").trim();
    return /^\d+$/.test(s) ? Number(s) : 0;
  };
  if (has(db, "wallet_charge_salesperson")) {
    const rows = db.prepare(`SELECT w.salesperson_id sp, w.amount amt FROM wallet_charge_salesperson w
      LEFT JOIN customers c ON c.id=w.customer_id
      WHERE w.salesperson_id IS NOT NULL AND julianday(w.created_at)>=julianday(?) AND julianday(w.created_at)<julianday(?)
        ${excludeTest ? `AND (c.id IS NULL OR NOT ${testCustomerSql("c")})` : ""}`).all(fromIso, toIso) as any[];
    for (const r of rows) add(Number(r.sp), toman(r.amt));
  }
  // Historical charges without a snapshot: attribute to the customer's current owner, skipping rows already snapshotted.
  if (has(db, "wallet_ledger_v2") && has(db, "wallet_accounts_v2")) {
    const snapJoin = has(db, "wallet_charge_salesperson")
      ? "AND l.id NOT IN (SELECT ledger_id FROM wallet_charge_salesperson)" : "";
    const rows = db.prepare(`SELECT c.salesperson_id sp, l.amount amt FROM wallet_ledger_v2 l
      JOIN wallet_accounts_v2 a ON a.id=l.wallet_id AND a.wallet_type='cash'
      JOIN customers c ON c.id=a.customer_id
      WHERE l.kind='cash_payment' AND c.salesperson_id IS NOT NULL
        AND julianday(l.created_at)>=julianday(?) AND julianday(l.created_at)<julianday(?)
        ${notTestJoin(excludeTest, "c")} ${snapJoin}`).all(fromIso, toIso) as any[];
    for (const r of rows) add(Number(r.sp), toman(r.amt));
  }
  return out;
}

/* ---------------- experts / roles / teams ---------------- */

export type ExpertMeta = {
  salespersonId: number; name: string; userId: number | null; trainee: boolean;
  teamId: number | null; teamName: string | null; role: ScoreRole | null;
};
export function listExperts(db: DatabaseSync): ExpertMeta[] {
  if (!has(db, "salespersons") || !has(db, "users")) return [];
  const members = new Map<number, { teamId: number; teamName: string; isLead: boolean; ownsNone: boolean; ownsP1: boolean }>();
  if (has(db, "sales_team_members") && has(db, "sales_teams")) {
    for (const r of db.prepare(`SELECT m.salesperson_id sp, m.team_id teamId, t.name teamName, m.is_lead isLead,
        m.owns_none ownsNone, m.owns_p1 ownsP1
      FROM sales_team_members m JOIN sales_teams t ON t.id=m.team_id AND t.enabled=1`).all() as any[]) {
      members.set(Number(r.sp), {
        teamId: Number(r.teamId), teamName: String(r.teamName),
        isLead: Number(r.isLead) === 1, ownsNone: Number(r.ownsNone) === 1, ownsP1: Number(r.ownsP1) === 1,
      });
    }
  }
  const rows = db.prepare(`SELECT s.id sp, s.name name, u.id uid
    FROM salespersons s
    JOIN users u ON u.salesperson_id=s.id AND u.active=1
    ORDER BY CASE u.role WHEN 'salesperson' THEN 0 ELSE 1 END, u.id`).all() as any[];
  const seen = new Set<number>();
  const out: ExpertMeta[] = [];
  for (const r of rows) {
    const sp = Number(r.sp);
    if (seen.has(sp)) continue;
    const uid = r.uid == null ? null : Number(r.uid);
    if (uid != null && EXCLUDED_USER_IDS.includes(uid)) continue;
    seen.add(sp);
    const m = members.get(sp);
    out.push({
      salespersonId: sp, name: String(r.name ?? ""), userId: uid,
      trainee: isTraineeSalespersonOn(db, sp),
      teamId: m?.teamId ?? null, teamName: m?.teamName ?? null,
      role: scoreRoleOf(m ?? null),
    });
  }
  return out;
}

export function listTeams(db: DatabaseSync): { teamId: number; name: string; members: ExpertMeta[] }[] {
  const experts = listExperts(db);
  const byTeam = new Map<number, { teamId: number; name: string; members: ExpertMeta[] }>();
  for (const e of experts) {
    if (e.teamId == null || !e.teamName) continue;
    const t = byTeam.get(e.teamId) ?? { teamId: e.teamId, name: e.teamName, members: [] };
    t.members.push(e);
    byTeam.set(e.teamId, t);
  }
  return [...byTeam.values()].sort((a, b) => a.teamId - b.teamId);
}

/* ---------------- assemble counts + scoring ---------------- */

function countsForWindow(db: DatabaseSync, w: Window, excludeTest: boolean): { bySp: Map<number, Counts>; calls: CallFact[] } {
  const calls = performanceCallRows(db, w.fromIso, w.toIso, excludeTest);
  const filed = filedByExpert(db, w.fromIso, w.toIso, excludeTest);
  const adv = advancedByExpert(db, w.fromIso, w.toIso, excludeTest);
  const done = completedByExpert(db, w.fromIso, w.toIso, excludeTest);
  const wallet = walletByExpert(db, w.fromIso, w.toIso, excludeTest);
  const bySp = new Map<number, Counts>();
  const phones = new Map<number, Set<string>>();
  const bump = (sp: number) => {
    if (!bySp.has(sp)) { bySp.set(sp, emptyCounts()); phones.set(sp, new Set()); }
    return bySp.get(sp)!;
  };
  for (const r of calls) {
    if (r.companyNoAnswer) continue;
    const c = bump(r.sp);
    const set = phones.get(r.sp)!;
    // add one call
    const tmp = emptyCounts();
    addCalls(tmp, [r]);
    c.calls += tmp.calls; c.answered += tmp.answered; c.noAnswer += tmp.noAnswer;
    c.inbound += tmp.inbound; c.outbound += tmp.outbound;
    c.answeredInbound += tmp.answeredInbound; c.noAnswerInbound += tmp.noAnswerInbound;
    c.duration += tmp.duration;
    if (r.phone) set.add(r.phone);
  }
  const union = new Set([...filed.keys(), ...adv.keys(), ...done.keys(), ...wallet.keys()]);
  for (const sp of union) bump(sp);
  for (const [sp, c] of bySp) {
    c.unique = phones.get(sp)?.size ?? 0;
    c.filed = filed.get(sp) ?? 0;
    c.advanced = adv.get(sp) ?? 0;
    c.done = done.get(sp) ?? 0;
    const wlt = wallet.get(sp);
    c.wallet = wlt?.count ?? 0;
    c.walletRial = (wlt?.toman ?? 0) * 10;
  }
  return { bySp, calls };
}

export type ScoreBreakdown = { key: MetricKey; label: string; weight: number; value: number; points: number };
export type ScoredExpert = ExpertMeta & {
  counts: Counts; prev: Counts; score: number | null; rank: number | null; roleN: number | null;
  points: Record<string, number>; rawSum: number;
};

const FIRST_BREAK: Array<[MetricKey, string, number]> = [
  ["calls", "تماس‌ها", 30], ["unique", "شماره‌های یکتا", 25], ["duration", "مدت کل", 20],
  ["ansPct", "درصد جواب‌داده", 10], ["filedOrAdvanced", "پروندهٔ ثبت‌شده و جلوبرده", 15],
];
const P1_BREAK: Array<[MetricKey, string, number]> = [
  ["done", "فروش موفق", 30], ["filed", "پروندهٔ ثبت‌شده", 20], ["advanced", "پروندهٔ جلوبرده", 20],
  ["calls", "تماس‌ها", 10], ["duration", "مدت کل", 10], ["wallet", "شارژ کیف پول", 10],
];
export function breakdownRows(role: ScoreRole): Array<[MetricKey, string, number]> {
  return role === ROLE_FIRST ? FIRST_BREAK : P1_BREAK;
}

/**
 * Per metric, value / best-in-role * weight. If best is 0, that metric scores 0.
 * Then the raw sums are scaled so the best person in the role = 100.
 * Ties in the final score share a rank and the next rank jumps (1, 2, 2, 4).
 */
export function scoreRoleGroup(people: ScoredExpert[]): void {
  const ranked = people.filter((p) => !p.trainee && p.role);
  const byRole = new Map<ScoreRole, ScoredExpert[]>();
  for (const p of ranked) {
    const list = byRole.get(p.role!) ?? [];
    list.push(p);
    byRole.set(p.role!, list);
  }
  for (const [role, group] of byRole) {
    const rows = breakdownRows(role);
    const best: Record<string, number> = {};
    for (const [key] of rows) {
      best[key] = Math.max(0, ...group.map((p) => metricValue(p.counts, key)));
    }
    for (const p of group) {
      let sum = 0;
      p.points = {};
      for (const [key, , w] of rows) {
        const v = metricValue(p.counts, key);
        const b = best[key] ?? 0;
        const pts = b > 0 ? (v / b) * w : 0;
        p.points[key] = pts;
        sum += pts;
      }
      p.rawSum = sum;
    }
    const maxRaw = Math.max(0, ...group.map((p) => p.rawSum));
    for (const p of group) {
      p.score = maxRaw > 0 ? Math.round((p.rawSum / maxRaw) * 100) : 0;
    }
    const ordered = [...group].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.salespersonId - b.salespersonId);
    let lastScore: number | null = null, lastRank = 0;
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i]!.score ?? 0;
      if (lastScore == null || s !== lastScore) { lastRank = i + 1; lastScore = s; }
      ordered[i]!.rank = lastRank;
      ordered[i]!.roleN = ordered.length;
    }
  }
  for (const p of people) {
    if (p.trainee || !p.role) { p.score = null; p.rank = null; p.roleN = null; p.points = {}; p.rawSum = 0; }
  }
}

export function competitionRank(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  const ranks = Array(values.length).fill(0);
  let last: number | null = null, lastRank = 0;
  for (let i = 0; i < idx.length; i++) {
    const [v, orig] = idx[i]!;
    if (last == null || v !== last) { lastRank = i + 1; last = v; }
    ranks[orig] = lastRank;
  }
  return ranks;
}

/* ---------------- deltas ---------------- */

export type Delta = { kind: "up" | "down" | "flat" | "none" | "unit"; pct: number };
export function deltaOf(current: number, previous: number | null | undefined, unit = false): Delta {
  if (previous == null || previous === 0) return { kind: "none", pct: 0 };
  if (unit) {
    const d = Math.round(current - previous);
    if (d > 0) return { kind: "unit", pct: d };
    if (d < 0) return { kind: "unit", pct: d };
    return { kind: "flat", pct: 0 };
  }
  if (current === previous) return { kind: "flat", pct: 0 };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct > 0) return { kind: "up", pct };
  if (pct < 0) return { kind: "down", pct: Math.abs(pct) };
  return { kind: "flat", pct: 0 };
}

/* ---------------- public report ---------------- */

export type ReportQuery = {
  period?: string; from?: string; to?: string; anchor?: string;
  view?: string; metric?: string; expertId?: number | null;
};
export type Cell = { value: number; display?: string; delta: Delta; incomplete: boolean };

function buildCells(c: Counts, p: Counts, incomplete: boolean): Record<MetricKey, Cell> {
  const cell = (key: MetricKey, unit = false): Cell => ({
    value: metricValue(c, key),
    delta: deltaOf(metricValue(c, key), metricValue(p, key), unit),
    incomplete: incomplete && INCOMPLETE_KEYS.includes(key),
  });
  return {
    calls: cell("calls"), unique: cell("unique"), duration: cell("duration"),
    avgDuration: cell("avgDuration"), inbound: cell("inbound"), outbound: cell("outbound"),
    answered: cell("answered"), noAnswer: cell("noAnswer"),
    answeredInbound: cell("answeredInbound"), noAnswerInbound: cell("noAnswerInbound"),
    filed: cell("filed"), advanced: cell("advanced"), done: cell("done"),
    wallet: cell("wallet"), ansPct: cell("ansPct", true), filedOrAdvanced: cell("filedOrAdvanced"),
  };
}

function presentExpert(p: ScoredExpert, prev: Counts, incomplete: boolean, hideOthers: boolean) {
  const cells = buildCells(p.counts, prev, incomplete);
  const role = p.role;
  const br = role ? breakdownRows(role).map(([key, label, weight]) => ({
    key, label, weight,
    value: metricValue(p.counts, key),
    points: hideOthers ? Math.round(p.points[key] ?? 0) : Math.round(p.points[key] ?? 0),
  })) : [];
  return {
    salespersonId: p.salespersonId,
    name: p.name,
    teamId: p.teamId, teamName: p.teamName,
    role: p.role, roleLabel: p.role ? ROLE_LABEL[p.role] : null,
    trainee: p.trainee,
    score: p.score, rank: p.rank, roleN: p.roleN,
    metrics: cells,
    walletRial: p.counts.walletRial,
    breakdown: br,
  };
}

function teamCounts(members: ScoredExpert[], calls: CallFact[], teamIds: Set<number>, windowCalls: CallFact[]): Counts {
  const c = emptyCounts();
  const phones = new Set<string>();
  const sps = new Set(members.map((m) => m.salespersonId));
  for (const m of members) {
    const x = m.counts;
    c.calls += x.calls; c.duration += x.duration; c.inbound += x.inbound; c.outbound += x.outbound;
    c.answered += x.answered; c.noAnswer += x.noAnswer;
    c.answeredInbound += x.answeredInbound; c.noAnswerInbound += x.noAnswerInbound;
    c.filed += x.filed; c.advanced += x.advanced; c.done += x.done;
    c.wallet += x.wallet; c.walletRial += x.walletRial;
  }
  for (const r of windowCalls) {
    if (r.companyNoAnswer) continue;
    if (!sps.has(r.sp)) continue;
    if (r.phone) phones.add(r.phone);
  }
  c.unique = phones.size;
  return c;
}

export function salesPerformanceReport(db: DatabaseSync, actor: AuthUser, query: ReportQuery, now = new Date()) {
  const access = accessOf(actor, db);
  if (access === "none") {
    const err = new Error("forbidden") as Error & { status: number };
    err.status = 403;
    throw err;
  }
  seedMembershipHistoryIfEmpty(db, now);
  const bounds = performanceWindow(query, now);
  const excludeTest = excludeTestOn(db);
  const incomplete = periodOverlapsIncomplete(bounds.current);
  const cur = countsForWindow(db, bounds.current, excludeTest);
  const prev = countsForWindow(db, bounds.previous, excludeTest);
  const experts = listExperts(db);
  const people: ScoredExpert[] = experts.map((e) => ({
    ...e,
    counts: cur.bySp.get(e.salespersonId) ?? emptyCounts(),
    prev: prev.bySp.get(e.salespersonId) ?? emptyCounts(),
    score: null, rank: null, roleN: null, points: {}, rawSum: 0,
  }));
  scoreRoleGroup(people);

  if (access !== "manager") {
    const selfId = Number(actor.salespersonId);
    const self = people.find((p) => p.salespersonId === selfId);
    if (!self) {
      const err = new Error("forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    }
    if (query.expertId != null && Number(query.expertId) !== selfId) {
      const err = new Error("forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    }
    return {
      access, timezone: "Asia/Tehran", weekStarts: "saturday",
      period: bounds.period, range: {
        from: isoDay(bounds.current.startDay), to: isoDay(bounds.current.endDay),
        fromIso: bounds.current.fromIso, toIso: bounds.current.toIso,
        label: bounds.label, previousLabel: bounds.previousLabel,
        previousFrom: isoDay(bounds.previous.startDay), previousTo: isoDay(bounds.previous.endDay),
        complete: bounds.complete,
      },
      incomplete,
      incompleteFrom: INCOMPLETE_FROM,
      testCustomersExcluded: excludeTest,
      generatedAt: now.toISOString(),
      self: presentExpert(self, self.prev, incomplete, true),
      experts: undefined, teams: undefined, ranks: undefined, scores: undefined,
    };
  }

  if (query.expertId != null) {
    const one = people.find((p) => p.salespersonId === Number(query.expertId));
    if (!one) {
      const err = new Error("not_found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
  }
  const teams = listTeams(db).map((t) => {
    const mem = people.filter((p) => p.teamId === t.teamId);
    const prevMem = mem.map((p) => ({ ...p, counts: p.prev }));
    const tc = teamCounts(mem, cur.calls, new Set([t.teamId]), cur.calls);
    const tp = teamCounts(prevMem as ScoredExpert[], prev.calls, new Set([t.teamId]), prev.calls);
    return {
      teamId: t.teamId, name: t.name,
      members: mem.map((m) => ({ salespersonId: m.salespersonId, name: m.name, role: m.role, roleLabel: m.role ? ROLE_LABEL[m.role] : null })),
      metrics: buildCells(tc, tp, incomplete),
      walletRial: tc.walletRial,
    };
  });

  return {
    access, timezone: "Asia/Tehran", weekStarts: "saturday",
    period: bounds.period, range: {
      from: isoDay(bounds.current.startDay), to: isoDay(bounds.current.endDay),
      fromIso: bounds.current.fromIso, toIso: bounds.current.toIso,
      label: bounds.label, previousLabel: bounds.previousLabel,
      previousFrom: isoDay(bounds.previous.startDay), previousTo: isoDay(bounds.previous.endDay),
      complete: bounds.complete,
    },
    incomplete,
    incompleteFrom: INCOMPLETE_FROM,
    testCustomersExcluded: excludeTest,
    generatedAt: now.toISOString(),
    experts: people.map((p) => presentExpert(p, p.prev, incomplete, false)),
    teams,
    self: null as null,
  };
}

export function mePayload(db: DatabaseSync, actor: AuthUser) {
  const enabled = spFlagOn(db);
  const access = accessOf(actor, db);
  const experts = enabled ? listExperts(db) : [];
  const self = actor.salespersonId ? experts.find((e) => e.salespersonId === actor.salespersonId) ?? null : null;
  return {
    enabled,
    access,
    canView: enabled && access !== "none",
    canViewAll: enabled && access === "manager",
    self: self ? { salespersonId: self.salespersonId, name: self.name, trainee: self.trainee, role: self.role, roleLabel: self.role ? ROLE_LABEL[self.role] : null, teamName: self.teamName } : null,
  };
}

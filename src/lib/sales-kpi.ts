/**
 * شاخص‌های KPI فروش (flag.sales_kpi_v1, absent = OFF).
 * Local-only, additive settings table sales_kpi_targets. Nothing in
 * team_sales_config, notification_settings, or loan_plans is touched.
 *
 * Successful sale = first entry to loan stage `completed` (Mohammad t991s4180),
 * not a goods payout. Expert visibility: own KPIs + team totals + own rank;
 * no teammate names (same rule as sales-performance: each expert sees their own report and rank).
 * Data before 2026-11-03 is marked داده‌ی ناقص only where this page reuses
 * call figures from the sales-performance report.
 */
import type { DatabaseSync } from "node:sqlite";
import { dayNumber } from "./sales-report";
import { excludeTestOn, testCustomerSql } from "./test-customers";
import type { AuthUser } from "./auth";
import { type TraineeQueryDb } from "./multi-team";
import {
  EXCLUDED_USER_IDS,
  INCOMPLETE_FROM,
  accessOf,
  completedByExpert,
  filedByExpert,
  listExperts,
  listTeams,
  performanceCallRows,
  performanceWindow,
  periodOverlapsIncomplete,
  type Window,
} from "./sales-performance";

export const SK_FLAG = "flag.sales_kpi_v1";
export const SK_STALE_DAYS = "sales_kpi.stale_days";
export const SK_OLD_DAYS = "sales_kpi.old_customer_days";
export const SK_PREV_BUYER_DAYS = "sales_kpi.prev_buyer_followup_days";
export const SK_INVOICE_SLA = "sales_kpi.invoice_review_sla_hours";
export const SK_REGISTRAR_SLA = "sales_kpi.registrar_delivery_sla_hours";
export const SK_ZERO_BASELINE = "sales_kpi.zero_prev_baseline";

export type KpiGroup = "sales" | "discipline" | "growth" | "team";
export type KpiStatus = "ok" | "missing" | "empty_denom" | "no_baseline";
export type KpiUnit = "count" | "percent" | "amount" | "pp" | "hours";
export type KpiCell = {
  key: string;
  group: KpiGroup;
  label: string;
  formula: string;
  status: KpiStatus;
  value: number | null;
  display: string;
  numerator: number | null;
  denominator: number | null;
  unit: KpiUnit;
  assumption: string | null;
  missingReason: string | null;
  incomplete: boolean;
  missingKind: "setting" | "source" | null;
  direction: "higher_better" | "lower_better" | null;
  fractionLabel: string | null;
  previousValue: number | null;
  deltaDisplay: string | null;
};

const DAY = 86_400_000;
const OFFSET = 210 * 60_000;
const FA = "۰۱۲۳۴۵۶۷۸۹";
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

export function skFlagOn(db: TraineeQueryDb): boolean {
  return setting(db, SK_FLAG) === "1";
}

export function ensureSalesKpiSchema(db: DatabaseSync): void {
  if (!has(db, "sales_kpi_targets")) {
    db.exec(`CREATE TABLE IF NOT EXISTS sales_kpi_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_key TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('expert','team')),
      scope_id INTEGER NOT NULL,
      target_count REAL,
      target_amount TEXT,
      min_target_count REAL,
      updated_by INTEGER,
      updated_at TEXT NOT NULL,
      UNIQUE(period_key, scope_kind, scope_id)
    )`);
  }
}


const NAME_TITLE_RE = /^(آقای|خانم|آقا|بانو|مهندس|دکتر)\s+/u;
/** Sort key for expert names: titles stripped so «خانم حسنی» sorts as حسنی. */
export function kpiNameKey(name: string | null | undefined): string {
  return String(name || "").replace(NAME_TITLE_RE, "").trim();
}
export function compareKpiNames(a: string | null | undefined, b: string | null | undefined): number {
  return kpiNameKey(a).localeCompare(kpiNameKey(b), "fa") || String(a || "").localeCompare(String(b || ""), "fa");
}

export function faDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA[Number(d)]);
}
export function faNum(n: number, frac = 0): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const fixed = frac > 0 ? abs.toFixed(frac) : String(Math.round(abs));
  const [a, b] = fixed.split(".");
  const g = a.replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return faDigits(sign + g + (b != null ? "٫" + b : ""));
}
export function faPct(n: number): string { return faNum(n, 1) + "٪"; }
export function faToman(n: number): string { return faNum(Math.round(n)) + " تومان"; }


const NEED_SETTING = "نیاز به تنظیم";
const NO_SOURCE = "منبع داده ندارد";
const NO_BASE = "مبنا تعریف نشده";
const EMPTY = "بدون مورد در این دوره";
const LOWER_KEYS = new Set(["cancellation_rate", "stale_file_rate", "team_error_rate"]);

function fractionOf(key: string, n: number, d: number): string {
  if (key === "avg_daily_sales") return `${faNum(n)} فروش در ${faNum(d)} روز کاری`;
  if (key === "target_achievement") return `${faNum(n)} فروش از هدف ${faNum(d)}`;
  if (key === "avg_sales_per_person") return `${faNum(n)} فروش برای ${faNum(d)} کارشناس`;
  return `${faNum(n)} از ${faNum(d)}`;
}

function cell(partial: Omit<KpiCell, "display" | "assumption" | "missingReason" | "incomplete" | "numerator" | "denominator" | "missingKind" | "direction" | "fractionLabel" | "previousValue" | "deltaDisplay"> & Partial<KpiCell>): KpiCell {
  const status = partial.status;
  let display = partial.display ?? "";
  if (!display) {
    if (status === "missing") display = partial.missingKind === "source" ? NO_SOURCE : NEED_SETTING;
    else if (status === "no_baseline") display = NO_BASE;
    else if (status === "empty_denom") display = EMPTY;
    else if (partial.value == null) display = "—";
    else if (partial.unit === "percent") display = faPct(partial.value);
    else if (partial.unit === "pp") display = (partial.value > 0 ? "+" : partial.value < 0 ? "−" : "") + faNum(Math.abs(partial.value), 1) + " واحد درصد";
    else if (partial.unit === "amount") display = faToman(partial.value);
    else if (partial.unit === "count") display = faNum(partial.value, Number.isInteger(partial.value) ? 0 : 1) + " فروش";
    else display = faNum(partial.value, Number.isInteger(partial.value) ? 0 : 1);
  }
  let fractionLabel = partial.fractionLabel ?? null;
  if (fractionLabel == null && partial.numerator != null && partial.denominator != null && status === "ok") {
    fractionLabel = fractionOf(partial.key, partial.numerator, partial.denominator);
  }
  return {
    numerator: null, denominator: null, assumption: null, missingReason: null, incomplete: false,
    missingKind: null, direction: LOWER_KEYS.has(partial.key) ? "lower_better" : (status === "ok" ? "higher_better" : null),
    previousValue: null, deltaDisplay: null,
    ...partial, status, display, fractionLabel,
  };
}

function ratioCell(base: { key: string; group: KpiGroup; label: string; formula: string; assumption?: string | null; incomplete?: boolean }, n: number, d: number, unit: KpiUnit = "percent"): KpiCell {
  if (d === 0) return cell({ ...base, unit, status: "empty_denom", value: null, numerator: n, denominator: d, assumption: base.assumption ?? null });
  const value = unit === "percent" ? (n / d) * 100 : n / d;
  return cell({ ...base, unit, status: "ok", value, numerator: n, denominator: d, assumption: base.assumption ?? null, incomplete: base.incomplete ?? false });
}

function missingCell(base: { key: string; group: KpiGroup; label: string; formula: string }, reason: string, unit: KpiUnit = "percent", kind: "setting" | "source" = "setting"): KpiCell {
  return cell({ ...base, unit, status: "missing", value: null, missingReason: reason, missingKind: kind });
}

function attachDeltas(current: KpiCell[], previous: KpiCell[]): KpiCell[] {
  const map = new Map(previous.map((k) => [k.key, k]));
  return current.map((k) => {
    if (k.status !== "ok") return k;
    const p = map.get(k.key);
    if (!p || p.status !== "ok" || k.value == null || p.value == null) {
      return { ...k, deltaDisplay: "نسبت به دورهٔ قبل: داده ندارد" };
    }
    const d = k.value - p.value;
    const abs = Math.abs(d);
    let body: string;
    if (k.unit === "percent" || k.unit === "pp") body = faNum(abs, 1) + " واحد درصد";
    else if (k.unit === "amount") body = faToman(abs);
    else body = faNum(abs, Number.isInteger(abs) ? 0 : 1) + " فروش";
    const deltaDisplay = d === 0 ? "نسبت به دورهٔ قبل: بدون تغییر" : `نسبت به دورهٔ قبل: ${d < 0 ? "−" : "+"}${body}`;
    return { ...k, previousValue: p.value, deltaDisplay };
  });
}

export function faRangeLabel(fromDay: number, toDay: number): string {
  const fmt = (d: number, withYear = true) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "UTC", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(d * DAY));
  if (fromDay === toDay) return fmt(fromDay);
  return `${fmt(fromDay, false)} تا ${fmt(toDay)}`;
}

export function jalaliMonthTitle(day: number): string {
  const d = new Date(day * DAY);
  const month = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "UTC", month: "long" }).format(d);
  const year = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "UTC", year: "numeric" }).format(d);
  return `${month} ${year}`;
}

function numSetting(db: TraineeQueryDb, key: string): number | null {
  const v = setting(db, key);
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function appSpSql(db: DatabaseSync): string {
  return cols(db, "loan_applications").has("salesperson_id_snapshot")
    ? "COALESCE(a.salesperson_id_snapshot,c.salesperson_id)" : "c.salesperson_id";
}
function notTestJoin(excludeTest: boolean, alias = "c"): string {
  return excludeTest ? `AND (${alias}.id IS NULL OR NOT ${testCustomerSql(alias)})` : "";
}
function notTestId(excludeTest: boolean, cid: string): string {
  return excludeTest ? `AND (${cid} IS NULL OR NOT EXISTS (SELECT 1 FROM customers tc WHERE tc.id=${cid} AND ${testCustomerSql("tc")}))` : "";
}
function toman(v: unknown): number {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : 0;
}
function ymdOfDay(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}
export function jalaliMonthKey(day: number): string {
  const persian = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(persian.formatToParts(new Date(day * DAY)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}
function parseTs(v: unknown): number {
  const s = String(v ?? "");
  const z = /Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const n = Date.parse(z);
  return Number.isFinite(n) ? n : NaN;
}

export function workingDaysIn(db: DatabaseSync, startDay: number, endDay: number): number {
  const holidays = new Set<string>();
  if (has(db, "official_holidays")) {
    for (const r of db.prepare("SELECT date FROM official_holidays").all() as { date: string }[]) {
      if (r.date) holidays.add(String(r.date).slice(0, 10));
    }
  }
  let n = 0;
  for (let d = startDay; d <= endDay; d++) {
    if (new Date(d * DAY).getUTCDay() === 5) continue;
    if (holidays.has(ymdOfDay(d))) continue;
    n++;
  }
  return n;
}


export type SaleRow = { sp: number; app: number; amount: number };
export function completedSalesRows(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): SaleRow[] {
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return [];
  const snap = appSpSql(db);
  return (db.prepare(`SELECT ${snap} sp, a.id app, a.approved_amount amt, MIN(julianday(h.created_at)) first
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND h.to_stage='completed' ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL
    GROUP BY a.id
    HAVING first>=julianday(?) AND first<julianday(?)`).all(fromIso, toIso) as any[]).map((r) => ({
    sp: Number(r.sp), app: Number(r.app), amount: toman(r.amt),
  }));
}

/**
 * Same cohort as filedByExpert: non-pre-registration loan applications created in the window.
 * Cancelled among them = first cancel-case or funder-initial-reject on that application
 * occurs before the exclusive window end (so the rate cannot exceed 100%).
 */
export function cancelledByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, number> {
  const out = new Map<number, number>();
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return out;
  const snap = appSpSql(db);
  const rows = db.prepare(`SELECT ${snap} sp, a.id app, MIN(julianday(h.created_at)) first
    FROM loan_applications a
    JOIN customers c ON c.id=a.customer_id
    JOIN loan_application_stage_history h ON h.application_id=a.id
      AND h.action IN ('cancel-case','funder-initial-reject')
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL
      AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?)
    GROUP BY a.id
    HAVING first<julianday(?)`).all(fromIso, toIso, toIso) as any[];
  for (const r of rows) out.set(Number(r.sp), (out.get(Number(r.sp)) ?? 0) + 1);
  return out;
}

/** Unique customers assigned to an expert during the window (flow, not stock). */
export function assignedByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const add = (sp: number, cid: number) => {
    if (!Number.isFinite(sp) || !Number.isFinite(cid)) return;
    let s = out.get(sp);
    if (!s) { s = new Set(); out.set(sp, s); }
    s.add(cid);
  };
  if (!has(db, "customers")) return out;
  const nt = notTestJoin(excludeTest, "c");
  const createdCol = cols(db, "customers").has("registered_at") ? "COALESCE(c.registered_at,c.created_at)" : "c.created_at";
  for (const r of db.prepare(`SELECT c.salesperson_id sp, c.id cid FROM customers c
    WHERE c.salesperson_id IS NOT NULL AND julianday(${createdCol})>=julianday(?) AND julianday(${createdCol})<julianday(?) ${nt}`).all(fromIso, toIso) as any[]) {
    add(Number(r.sp), Number(r.cid));
  }
  if (has(db, "customer_priority_history")) {
    for (const r of db.prepare(`SELECT h.new_salesperson_id sp, h.customer_id cid FROM customer_priority_history h
      JOIN customers c ON c.id=h.customer_id
      WHERE h.new_salesperson_id IS NOT NULL
        AND h.new_salesperson_id IS NOT h.old_salesperson_id
        AND julianday(h.created_at)>=julianday(?) AND julianday(h.created_at)<julianday(?) ${nt}`).all(fromIso, toIso) as any[]) {
      add(Number(r.sp), Number(r.cid));
    }
  }
  return out;
}

export function uniqueCalledByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const r of performanceCallRows(db, fromIso, toIso, excludeTest)) {
    if (r.companyNoAnswer || !r.phone) continue;
    let s = out.get(r.sp);
    if (!s) { s = new Set(); out.set(r.sp, s); }
    s.add(r.phone);
  }
  return out;
}

const DOC_UPLOAD = "customer_documents_upload";
const DOC_REVIEW = "customer_documents_review";
const LOAN_STAGES = [
  "funder_initial_approval", "draft", "primary_contract_pending_signature", "approved_contract_pending_signature",
  "customer_documents_upload", "customer_documents_review", "guarantor_registration", "guarantor_documents_upload",
  "guarantor_documents_review", "collateral_upload", "collateral_review", "expert_approval",
  "funder_amendment_pending_signature", "funder_amendment_review", "funder_result_review", "funder_documents_correction",
  "physical_documents_submission", "physical_documents_review", "physical_documents_correction",
  "wallet_charge_pending", "admin_approval", "final_invoice_pending_signature", "completed",
];
const STAGE_IX = Object.fromEntries(LOAN_STAGES.map((s, i) => [s, i])) as Record<string, number>;

/** Eligible = first reached documents-upload in the window; completed = later passed documents-review. */
export function documentsByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, { eligible: Set<number>; done: Set<number> }> {
  const out = new Map<number, { eligible: Set<number>; done: Set<number> }>();
  const bag = (sp: number) => {
    let b = out.get(sp);
    if (!b) { b = { eligible: new Set(), done: new Set() }; out.set(sp, b); }
    return b;
  };
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return out;
  const snap = appSpSql(db);
  const rows = db.prepare(`SELECT ${snap} sp, a.customer_id cid, a.id app, h.to_stage ts, h.created_at at
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL AND h.to_stage IS NOT NULL`).all() as any[];
  const firstUpload = new Map<number, { sp: number; cid: number; at: number }>();
  const firstPastReview = new Map<number, number>();
  const cutUpload = STAGE_IX[DOC_UPLOAD] ?? 4;
  const cutReview = STAGE_IX[DOC_REVIEW] ?? 5;
  for (const r of rows) {
    const ix = STAGE_IX[String(r.ts)];
    if (ix == null) continue;
    const at = parseTs(r.at);
    if (!Number.isFinite(at)) continue;
    const app = Number(r.app);
    if (ix >= cutUpload && !firstUpload.has(app)) firstUpload.set(app, { sp: Number(r.sp), cid: Number(r.cid), at });
    if (ix > cutReview && !firstPastReview.has(app)) firstPastReview.set(app, at);
  }
  const fromMs = Date.parse(fromIso), toMs = Date.parse(toIso);
  for (const [app, u] of firstUpload) {
    if (u.at < fromMs || u.at >= toMs) continue;
    const b = bag(u.sp);
    b.eligible.add(u.cid);
    const past = firstPastReview.get(app);
    if (past != null && past >= u.at) b.done.add(u.cid);
  }
  return out;
}


type FollowCount = { due: number; onTime: number };
export function followupsByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, FollowCount> {
  const out = new Map<number, FollowCount>();
  const add = (sp: number, due: number, onTime: number) => {
    if (!Number.isFinite(sp)) return;
    const cur = out.get(sp) ?? { due: 0, onTime: 0 };
    cur.due += due; cur.onTime += onTime;
    out.set(sp, cur);
  };
  const endOfTehranDay = (iso: string) => {
    const d = dayNumber(iso);
    if (!Number.isFinite(d)) return parseTs(iso);
    return (d + 1) * DAY - OFFSET - 1;
  };
  if (has(db, "reminders")) {
    const nt2 = notTestId(excludeTest, "r.customer_id");
    const rows = db.prepare(`SELECT r.salesperson_id sp, r.done done, r.remind_at due, r.closed_at closed, r.voided_at voided, r.replaced_by replaced
      FROM reminders r
      WHERE r.salesperson_id IS NOT NULL AND r.remind_at IS NOT NULL
        AND julianday(r.remind_at)>=julianday(?) AND julianday(r.remind_at)<julianday(?)
        AND r.voided_at IS NULL AND r.replaced_by IS NULL ${nt2}`).all(fromIso, toIso) as any[];
    for (const r of rows) {
      const deadline = endOfTehranDay(String(r.due));
      const closed = r.closed ? parseTs(r.closed) : NaN;
      const onTime = Number(r.done) === 1 && (!r.closed || (Number.isFinite(closed) && closed <= deadline));
      add(Number(r.sp), 1, onTime ? 1 : 0);
    }
  }
  if (has(db, "dp_items") && has(db, "dp_plans")) {
    const nt2 = notTestId(excludeTest, "i.customer_id");
    const rows = db.prepare(`SELECT p.salesperson_id sp, i.status st, i.done_at done, p.day day
      FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id
      WHERE p.salesperson_id IS NOT NULL AND i.type IN ('followup','loan_followup','due')
        AND i.status NOT IN ('transferred','skipped')
        AND p.day >= date(?) AND p.day < date(?) ${nt2}`).all(fromIso, toIso) as any[];
    for (const r of rows) {
      const day = String(r.day).slice(0, 10);
      const doneDay = r.done ? String(r.done).slice(0, 10) : null;
      const done = r.st === "done" || r.st === "covered";
      const onTime = done && (!doneDay || doneDay <= day);
      add(Number(r.sp), 1, onTime ? 1 : 0);
    }
  }
  return out;
}

type FollowedSet = Map<number, { need: Set<number>; done: Set<number> }>;
function followedBag(): FollowedSet { return new Map(); }
function bagNeed(m: FollowedSet, sp: number, cid: number) {
  let b = m.get(sp);
  if (!b) { b = { need: new Set(), done: new Set() }; m.set(sp, b); }
  b.need.add(cid);
}
function bagDone(m: FollowedSet, sp: number, cid: number) {
  let b = m.get(sp);
  if (!b) { b = { need: new Set(), done: new Set() }; m.set(sp, b); }
  b.done.add(cid);
}

function followedCustomersInPeriod(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const add = (sp: number, cid: number) => {
    if (!Number.isFinite(sp) || !Number.isFinite(cid)) return;
    let s = out.get(sp); if (!s) { s = new Set(); out.set(sp, s); }
    s.add(cid);
  };
  if (has(db, "call_logs")) {
    for (const r of db.prepare(`SELECT salesperson_id sp, customer_id cid FROM call_logs
      WHERE salesperson_id IS NOT NULL AND customer_id IS NOT NULL
        AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?) ${notTestId(excludeTest, "customer_id")}`).all(fromIso, toIso) as any[]) {
      add(Number(r.sp), Number(r.cid));
    }
  }
  if (has(db, "reminders")) {
    for (const r of db.prepare(`SELECT salesperson_id sp, customer_id cid FROM reminders
      WHERE salesperson_id IS NOT NULL AND customer_id IS NOT NULL AND done=1 AND voided_at IS NULL
        AND julianday(COALESCE(closed_at,remind_at,created_at))>=julianday(?) AND julianday(COALESCE(closed_at,remind_at,created_at))<julianday(?) ${notTestId(excludeTest, "customer_id")}`).all(fromIso, toIso) as any[]) {
      add(Number(r.sp), Number(r.cid));
    }
  }
  if (has(db, "dp_items") && has(db, "dp_plans")) {
    for (const r of db.prepare(`SELECT p.salesperson_id sp, i.customer_id cid FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id
      WHERE p.salesperson_id IS NOT NULL AND i.customer_id IS NOT NULL AND i.status IN ('done','covered')
        AND i.type IN ('followup','loan_followup','due')
        AND p.day >= date(?) AND p.day < date(?) ${notTestId(excludeTest, "i.customer_id")}`).all(fromIso, toIso) as any[]) {
      add(Number(r.sp), Number(r.cid));
    }
  }
  return out;
}


export function oldCustomerFollowup(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean, oldDays: number): FollowedSet {
  const out = followedBag();
  if (!has(db, "customers")) return out;
  const cutoff = new Date(Date.parse(fromIso) - oldDays * DAY).toISOString();
  const nt = notTestJoin(excludeTest, "c");
  const owners = db.prepare(`SELECT c.id cid, c.salesperson_id sp, c.created_at created, c.status status
    FROM customers c WHERE c.salesperson_id IS NOT NULL ${nt}`).all() as any[];
  const lastSale = new Map<number, string>();
  if (has(db, "loan_applications") && has(db, "loan_application_stage_history")) {
    for (const r of db.prepare(`SELECT a.customer_id cid, MIN(h.created_at) at
      FROM loan_application_stage_history h JOIN loan_applications a ON a.id=h.application_id
      WHERE a.deleted_at IS NULL AND h.to_stage='completed' GROUP BY a.customer_id`).all() as any[]) {
      lastSale.set(Number(r.cid), String(r.at));
    }
  }
  const lastAct = new Map<number, string>();
  if (has(db, "call_logs")) {
    for (const r of db.prepare(`SELECT customer_id cid, MAX(created_at) at FROM call_logs WHERE customer_id IS NOT NULL AND julianday(created_at)<julianday(?) GROUP BY customer_id`).all(fromIso) as any[]) {
      lastAct.set(Number(r.cid), String(r.at));
    }
  }
  for (const r of owners) {
    if (String(r.status) === "cancelled") continue;
    const sale = lastSale.get(Number(r.cid));
    const act = lastAct.get(Number(r.cid)) ?? r.created;
    const last = sale && parseTs(sale) > parseTs(act) ? sale : act;
    if (!last || parseTs(last) > Date.parse(cutoff)) continue;
    bagNeed(out, Number(r.sp), Number(r.cid));
  }
  const followed = followedCustomersInPeriod(db, fromIso, toIso, excludeTest);
  for (const [sp, set] of followed) {
    for (const cid of set) if (out.get(sp)?.need.has(cid)) bagDone(out, sp, cid);
  }
  return out;
}

export function prevBuyerFollowup(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean, gapDays: number | null): FollowedSet {
  const out = followedBag();
  if (!has(db, "customers") || !has(db, "loan_applications") || !has(db, "loan_application_stage_history")) return out;
  const snap = appSpSql(db);
  const nt = notTestJoin(excludeTest, "c");
  const rows = db.prepare(`SELECT ${snap} sp, a.customer_id cid, MIN(h.created_at) first
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND h.to_stage='completed' ${nt} AND ${snap} IS NOT NULL
    GROUP BY a.id
    HAVING julianday(first)<julianday(?)`).all(fromIso) as any[];
  const lastByCust = new Map<number, { sp: number; at: number }>();
  for (const r of rows) {
    const at = parseTs(r.first);
    const cid = Number(r.cid);
    const prev = lastByCust.get(cid);
    if (!prev || at > prev.at) lastByCust.set(cid, { sp: Number(r.sp), at });
  }
  const gapMs = gapDays != null ? gapDays * DAY : 0;
  const fromMs = Date.parse(fromIso);
  const currentOwner = new Map<number, number>();
  for (const r of db.prepare(`SELECT id cid, salesperson_id sp, status FROM customers WHERE salesperson_id IS NOT NULL`).all() as any[]) {
    if (String(r.status) === "cancelled") continue;
    currentOwner.set(Number(r.cid), Number(r.sp));
  }
  for (const [cid, info] of lastByCust) {
    if (gapDays != null && info.at > fromMs - gapMs) continue;
    const sp = currentOwner.get(cid) ?? info.sp;
    bagNeed(out, sp, cid);
  }
  const followed = followedCustomersInPeriod(db, fromIso, toIso, excludeTest);
  for (const [sp, set] of followed) {
    for (const cid of set) if (out.get(sp)?.need.has(cid)) bagDone(out, sp, cid);
  }
  return out;
}

export function accuracyByExpert(db: DatabaseSync, fromIso: string, toIso: string): Map<number, { reviewed: number; correct: number }> {
  const out = new Map<number, { reviewed: number; correct: number }>();
  if (!has(db, "team_data_accuracy_reviews")) return out;
  const rows = db.prepare(`SELECT qualifier_salesperson_id q, closer_salesperson_id cl, p1_kind kind, correct, reviewed_at
    FROM team_data_accuracy_reviews
    WHERE julianday(reviewed_at)>=julianday(?) AND julianday(reviewed_at)<julianday(?)`).all(fromIso, toIso) as any[];
  for (const r of rows) {
    const sp = r.kind === "first_call" || r.cl == null ? Number(r.q) : Number(r.cl);
    if (!Number.isFinite(sp)) continue;
    const cur = out.get(sp) ?? { reviewed: 0, correct: 0 };
    cur.reviewed++;
    if (Number(r.correct) === 1) cur.correct++;
    out.set(sp, cur);
  }
  return out;
}

export function tasksByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, { due: number; done: number }> {
  const out = new Map<number, { due: number; done: number }>();
  const add = (sp: number, due: number, done: number) => {
    if (!Number.isFinite(sp)) return;
    const cur = out.get(sp) ?? { due: 0, done: 0 };
    cur.due += due; cur.done += done; out.set(sp, cur);
  };
  if (has(db, "dp_items") && has(db, "dp_plans")) {
    const rows = db.prepare(`SELECT p.salesperson_id sp, i.status st
      FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id
      WHERE p.salesperson_id IS NOT NULL AND i.status NOT IN ('transferred','skipped','reserve')
        AND p.day >= date(?) AND p.day < date(?) ${notTestId(excludeTest, "i.customer_id")}`).all(fromIso, toIso) as any[];
    for (const r of rows) add(Number(r.sp), 1, (r.st === "done" || r.st === "covered") ? 1 : 0);
  }
  if (has(db, "customer_bale_tasks")) {
    const rows = db.prepare(`SELECT owner_id sp, status st FROM customer_bale_tasks
      WHERE owner_id IS NOT NULL AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)`).all(fromIso, toIso) as any[];
    for (const r of rows) add(Number(r.sp), 1, (r.st === "done" || r.st === "closed") ? 1 : 0);
  }
  return out;
}


export function staleByExpert(db: DatabaseSync, endIso: string, staleDays: number, excludeTest: boolean): Map<number, { open: number; stale: number }> {
  const out = new Map<number, { open: number; stale: number }>();
  if (!has(db, "loan_applications")) return out;
  const snap = appSpSql(db);
  const cutoff = new Date(Date.parse(endIso) - staleDays * DAY).toISOString();
  const loanCall = cols(db, "call_logs").has("loan_application_id") ? "OR l.loan_application_id=a.id" : "";
  const rows = db.prepare(`SELECT ${snap} sp, a.id app, a.stage stage, a.status status,
      (SELECT MAX(h.created_at) FROM loan_application_stage_history h WHERE h.application_id=a.id) last_stage,
      (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=a.customer_id ${loanCall}) last_call,
      a.updated_at, a.created_at
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL
      AND julianday(a.created_at)<julianday(?)
      AND a.stage != 'completed' AND COALESCE(a.status,'') != 'rejected'`).all(endIso) as any[];
  for (const r of rows) {
    const sp = Number(r.sp);
    const cur = out.get(sp) ?? { open: 0, stale: 0 };
    cur.open++;
    const last = [r.last_stage, r.last_call, r.updated_at, r.created_at].map(parseTs).filter((n) => Number.isFinite(n));
    const max = last.length ? Math.max(...last) : 0;
    if (max < Date.parse(cutoff)) cur.stale++;
    out.set(sp, cur);
  }
  return out;
}

export function invoiceReviewByExpert(db: DatabaseSync, fromIso: string, toIso: string, slaHours: number, excludeTest: boolean, nowMs: number): Map<number, { due: number; onTime: number }> {
  const out = new Map<number, { due: number; onTime: number }>();
  if (!has(db, "goods_purchase_documents") || !has(db, "goods_purchases")) return out;
  const slaMs = slaHours * 3600 * 1000;
  const rows = db.prepare(`SELECT p.salesperson_id sp, d.status st, d.created_at created, d.updated_at updated
    FROM goods_purchase_documents d JOIN goods_purchases p ON p.id=d.purchase_id
    WHERE d.kind='invoice' AND p.salesperson_id IS NOT NULL
      AND julianday(d.created_at)>=julianday(?) AND julianday(d.created_at)<julianday(?)
      AND d.status != 'superseded' ${notTestId(excludeTest, "p.customer_id")}`).all(fromIso, toIso) as any[];
  for (const r of rows) {
    const created = parseTs(r.created);
    const dueAt = created + slaMs;
    if (dueAt > nowMs && String(r.st) !== "signed") continue;
    const cur = out.get(Number(r.sp)) ?? { due: 0, onTime: 0 };
    cur.due++;
    if (String(r.st) === "signed") {
      const upd = r.updated ? parseTs(r.updated) : created;
      if (Number.isFinite(upd) && upd <= dueAt) cur.onTime++;
    }
    out.set(Number(r.sp), cur);
  }
  return out;
}

export function registrarDeliveryByExpert(db: DatabaseSync, fromIso: string, toIso: string, slaHours: number, excludeTest: boolean, nowMs: number): Map<number, { due: number; onTime: number }> {
  const out = new Map<number, { due: number; onTime: number }>();
  if (!has(db, "loan_applications") || !has(db, "loan_application_stage_history") || !has(db, "users")) return out;
  const snap = appSpSql(db);
  const registrarIds = new Set((db.prepare("SELECT id FROM users WHERE role='registrar' AND COALESCE(active,1)=1").all() as { id: number }[]).map((r) => Number(r.id)));
  const slaMs = slaHours * 3600 * 1000;
  const rows = db.prepare(`SELECT ${snap} sp, a.id app, h.to_stage ts, h.created_at at, h.actor_id actor
    FROM loan_application_stage_history h
    JOIN loan_applications a ON a.id=h.application_id
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL AND COALESCE(a.is_pre_registration,0)=0 ${notTestJoin(excludeTest)}
      AND ${snap} IS NOT NULL`).all() as any[];
  const ready = new Map<number, { sp: number; at: number }>();
  const delivered = new Map<number, number>();
  for (const r of rows) {
    const app = Number(r.app);
    const at = parseTs(r.at);
    if (!Number.isFinite(at)) continue;
    if (String(r.ts) === "physical_documents_submission" && !ready.has(app)) ready.set(app, { sp: Number(r.sp), at });
    const rec = ready.get(app);
    if (rec && !delivered.has(app) && at >= rec.at && registrarIds.has(Number(r.actor))) delivered.set(app, at);
  }
  const fromMs = Date.parse(fromIso), toMs = Date.parse(toIso);
  for (const [app, rec] of ready) {
    if (rec.at < fromMs || rec.at >= toMs) continue;
    const dueAt = rec.at + slaMs;
    if (dueAt > nowMs && !delivered.has(app)) continue;
    const cur = out.get(rec.sp) ?? { due: 0, onTime: 0 };
    cur.due++;
    const del = delivered.get(app);
    if (del != null && del <= dueAt) cur.onTime++;
    out.set(rec.sp, cur);
  }
  return out;
}

export function retentionByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, { start: Set<number>; kept: Set<number> }> {
  const out = new Map<number, { start: Set<number>; kept: Set<number> }>();
  if (!has(db, "customers")) return out;
  const bag = (sp: number) => {
    let b = out.get(sp);
    if (!b) { b = { start: new Set(), kept: new Set() }; out.set(sp, b); }
    return b;
  };
  const rows = db.prepare(`SELECT c.id cid, c.salesperson_id sp, c.status status, c.created_at created FROM customers c
    WHERE c.salesperson_id IS NOT NULL AND julianday(c.created_at)<julianday(?) ${notTestJoin(excludeTest, "c")}`).all(fromIso) as any[];
  const activity = new Set<number>();
  if (has(db, "call_logs")) {
    for (const r of db.prepare(`SELECT DISTINCT customer_id cid FROM call_logs WHERE customer_id IS NOT NULL AND julianday(created_at)>=julianday(?)`).all(fromIso) as any[]) {
      activity.add(Number(r.cid));
    }
  }
  void toIso;
  for (const r of rows) {
    const cancelled = String(r.status) === "cancelled";
    if (cancelled && !activity.has(Number(r.cid))) continue;
    const b = bag(Number(r.sp));
    b.start.add(Number(r.cid));
    if (!cancelled) b.kept.add(Number(r.cid));
  }
  return out;
}


export type TargetRow = { periodKey: string; scopeKind: "expert" | "team"; scopeId: number; targetCount: number | null; minTargetCount: number | null };
export function listTargets(db: DatabaseSync, periodKey: string): TargetRow[] {
  if (!has(db, "sales_kpi_targets")) return [];
  return (db.prepare(`SELECT period_key periodKey, scope_kind scopeKind, scope_id scopeId, target_count targetCount, min_target_count minTargetCount
    FROM sales_kpi_targets WHERE period_key=?`).all(periodKey) as any[]).map((r) => ({
    periodKey: String(r.periodKey), scopeKind: r.scopeKind, scopeId: Number(r.scopeId),
    targetCount: r.targetCount == null ? null : Number(r.targetCount),
    minTargetCount: r.minTargetCount == null ? null : Number(r.minTargetCount),
  }));
}

export type KpiSettings = {
  staleDays: number | null;
  oldCustomerDays: number | null;
  prevBuyerFollowupDays: number | null;
  invoiceReviewSlaHours: number | null;
  registrarDeliverySlaHours: number | null;
  zeroPrevBaseline: number | null;
  targets: TargetRow[];
};
export function readSettings(db: DatabaseSync, periodKey: string): KpiSettings {
  return {
    staleDays: numSetting(db, SK_STALE_DAYS),
    oldCustomerDays: numSetting(db, SK_OLD_DAYS),
    prevBuyerFollowupDays: numSetting(db, SK_PREV_BUYER_DAYS),
    invoiceReviewSlaHours: numSetting(db, SK_INVOICE_SLA),
    registrarDeliverySlaHours: numSetting(db, SK_REGISTRAR_SLA),
    zeroPrevBaseline: numSetting(db, SK_ZERO_BASELINE),
    targets: listTargets(db, periodKey),
  };
}

function setOrClear(db: DatabaseSync, key: string, value: number | null | undefined, uid: number, at: string) {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) {
    db.prepare("DELETE FROM call_queue_settings WHERE key=?").run(key);
    return;
  }
  const exists = db.prepare("SELECT key FROM call_queue_settings WHERE key=?").get(key);
  if (exists) db.prepare("UPDATE call_queue_settings SET value=?, updated_by=?, updated_at=? WHERE key=?").run(String(value), uid, at, key);
  else db.prepare("INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)").run(key, String(value), uid, at);
}

export type SettingsPatch = {
  staleDays?: number | null;
  oldCustomerDays?: number | null;
  prevBuyerFollowupDays?: number | null;
  invoiceReviewSlaHours?: number | null;
  registrarDeliverySlaHours?: number | null;
  zeroPrevBaseline?: number | null;
  targets?: Array<{ periodKey: string; scopeKind: "expert" | "team"; scopeId: number; targetCount?: number | null; minTargetCount?: number | null }>;
};

export function writeSettings(db: DatabaseSync, patch: SettingsPatch, actor: AuthUser, now = new Date()): KpiSettings {
  ensureSalesKpiSchema(db);
  const at = now.toISOString();
  const uid = actor.id;
  if ("staleDays" in patch) setOrClear(db, SK_STALE_DAYS, patch.staleDays, uid, at);
  if ("oldCustomerDays" in patch) setOrClear(db, SK_OLD_DAYS, patch.oldCustomerDays, uid, at);
  if ("prevBuyerFollowupDays" in patch) setOrClear(db, SK_PREV_BUYER_DAYS, patch.prevBuyerFollowupDays, uid, at);
  if ("invoiceReviewSlaHours" in patch) setOrClear(db, SK_INVOICE_SLA, patch.invoiceReviewSlaHours, uid, at);
  if ("registrarDeliverySlaHours" in patch) setOrClear(db, SK_REGISTRAR_SLA, patch.registrarDeliverySlaHours, uid, at);
  if ("zeroPrevBaseline" in patch) setOrClear(db, SK_ZERO_BASELINE, patch.zeroPrevBaseline, uid, at);
  if (patch.targets) {
    for (const t of patch.targets) {
      if (!t.periodKey || !["expert", "team"].includes(t.scopeKind) || !Number.isInteger(t.scopeId) || t.scopeId <= 0) {
        const err = new Error("هدف فروش معتبر نیست.") as Error & { status?: number };
        err.status = 400; throw err;
      }
      const clear = (t.targetCount == null || t.targetCount === undefined) && (t.minTargetCount == null || t.minTargetCount === undefined);
      if (clear) {
        db.prepare("DELETE FROM sales_kpi_targets WHERE period_key=? AND scope_kind=? AND scope_id=?").run(t.periodKey, t.scopeKind, t.scopeId);
        continue;
      }
      const exists = db.prepare("SELECT id FROM sales_kpi_targets WHERE period_key=? AND scope_kind=? AND scope_id=?").get(t.periodKey, t.scopeKind, t.scopeId);
      if (exists) {
        db.prepare(`UPDATE sales_kpi_targets SET target_count=?, min_target_count=?, updated_by=?, updated_at=?
          WHERE period_key=? AND scope_kind=? AND scope_id=?`).run(t.targetCount ?? null, t.minTargetCount ?? null, uid, at, t.periodKey, t.scopeKind, t.scopeId);
      } else {
        db.prepare(`INSERT INTO sales_kpi_targets(period_key,scope_kind,scope_id,target_count,min_target_count,updated_by,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(t.periodKey, t.scopeKind, t.scopeId, t.targetCount ?? null, t.minTargetCount ?? null, uid, at);
      }
    }
  }
  const periodKey = patch.targets?.[0]?.periodKey ?? jalaliMonthKey(dayNumber(at));
  return readSettings(db, periodKey);
}

type Counts = {
  sales: number; amount: number; assigned: number; called: number;
  docsElig: number; docsDone: number; cancelled: number; registered: number;
  fuDue: number; fuOnTime: number;
  oldNeed: number; oldDone: number;
  prevNeed: number; prevDone: number;
  reviewed: number; correct: number;
  taskDue: number; taskDone: number;
  openFiles: number; staleFiles: number;
  invDue: number; invOnTime: number;
  retStart: number; retKept: number;
  regDue: number; regOnTime: number;
};
const emptyCounts = (): Counts => ({
  sales: 0, amount: 0, assigned: 0, called: 0,
  docsElig: 0, docsDone: 0, cancelled: 0, registered: 0,
  fuDue: 0, fuOnTime: 0, oldNeed: 0, oldDone: 0, prevNeed: 0, prevDone: 0,
  reviewed: 0, correct: 0, taskDue: 0, taskDone: 0, openFiles: 0, staleFiles: 0,
  invDue: 0, invOnTime: 0, retStart: 0, retKept: 0, regDue: 0, regOnTime: 0,
});

function gatherWindow(
  db: DatabaseSync, w: Window, excludeTest: boolean, settings: KpiSettings, nowMs: number,
): { bySp: Map<number, Counts>; calledPhones: Map<number, Set<string>> } {
  const bySp = new Map<number, Counts>();
  const get = (sp: number) => {
    let c = bySp.get(sp);
    if (!c) { c = emptyCounts(); bySp.set(sp, c); }
    return c;
  };
  for (const s of completedSalesRows(db, w.fromIso, w.toIso, excludeTest)) { const c = get(s.sp); c.sales++; c.amount += s.amount; }
  for (const [sp, set] of assignedByExpert(db, w.fromIso, w.toIso, excludeTest)) get(sp).assigned = set.size;
  const called = uniqueCalledByExpert(db, w.fromIso, w.toIso, excludeTest);
  for (const [sp, set] of called) get(sp).called = set.size;
  for (const [sp, b] of documentsByExpert(db, w.fromIso, w.toIso, excludeTest)) {
    const c = get(sp); c.docsElig = b.eligible.size; c.docsDone = [...b.done].filter((id) => b.eligible.has(id)).length;
  }
  for (const [sp, n] of cancelledByExpert(db, w.fromIso, w.toIso, excludeTest)) get(sp).cancelled = n;
  for (const [sp, n] of filedByExpert(db, w.fromIso, w.toIso, excludeTest)) get(sp).registered = n;
  for (const [sp, b] of followupsByExpert(db, w.fromIso, w.toIso, excludeTest)) { const c = get(sp); c.fuDue = b.due; c.fuOnTime = b.onTime; }
  if (settings.oldCustomerDays != null) {
    for (const [sp, b] of oldCustomerFollowup(db, w.fromIso, w.toIso, excludeTest, settings.oldCustomerDays)) {
      const c = get(sp); c.oldNeed = b.need.size; c.oldDone = [...b.done].filter((id) => b.need.has(id)).length;
    }
  }
  for (const [sp, b] of prevBuyerFollowup(db, w.fromIso, w.toIso, excludeTest, settings.prevBuyerFollowupDays)) {
    const c = get(sp); c.prevNeed = b.need.size; c.prevDone = [...b.done].filter((id) => b.need.has(id)).length;
  }
  for (const [sp, b] of accuracyByExpert(db, w.fromIso, w.toIso)) { const c = get(sp); c.reviewed = b.reviewed; c.correct = b.correct; }
  for (const [sp, b] of tasksByExpert(db, w.fromIso, w.toIso, excludeTest)) { const c = get(sp); c.taskDue = b.due; c.taskDone = b.done; }
  if (settings.staleDays != null) {
    for (const [sp, b] of staleByExpert(db, w.toIso, settings.staleDays, excludeTest)) { const c = get(sp); c.openFiles = b.open; c.staleFiles = b.stale; }
  }
  if (settings.invoiceReviewSlaHours != null) {
    for (const [sp, b] of invoiceReviewByExpert(db, w.fromIso, w.toIso, settings.invoiceReviewSlaHours, excludeTest, nowMs)) { const c = get(sp); c.invDue = b.due; c.invOnTime = b.onTime; }
  }
  for (const [sp, b] of retentionByExpert(db, w.fromIso, w.toIso, excludeTest)) { const c = get(sp); c.retStart = b.start.size; c.retKept = b.kept.size; }
  if (settings.registrarDeliverySlaHours != null) {
    for (const [sp, b] of registrarDeliveryByExpert(db, w.fromIso, w.toIso, settings.registrarDeliverySlaHours, excludeTest, nowMs)) { const c = get(sp); c.regDue = b.due; c.regOnTime = b.onTime; }
  }
  return { bySp, calledPhones: called };
}

function sumCounts(rows: Counts[]): Counts {
  const o = emptyCounts();
  for (const c of rows) {
    o.sales += c.sales; o.amount += c.amount; o.assigned += c.assigned; o.called += c.called;
    o.docsElig += c.docsElig; o.docsDone += c.docsDone; o.cancelled += c.cancelled; o.registered += c.registered;
    o.fuDue += c.fuDue; o.fuOnTime += c.fuOnTime; o.oldNeed += c.oldNeed; o.oldDone += c.oldDone;
    o.prevNeed += c.prevNeed; o.prevDone += c.prevDone; o.reviewed += c.reviewed; o.correct += c.correct;
    o.taskDue += c.taskDue; o.taskDone += c.taskDone; o.openFiles += c.openFiles; o.staleFiles += c.staleFiles;
    o.invDue += c.invDue; o.invOnTime += c.invOnTime; o.retStart += c.retStart; o.retKept += c.retKept;
    o.regDue += c.regDue; o.regOnTime += c.regOnTime;
  }
  return o;
}


const ACC_ASSUMPTION = "از روی جدول بررسی صحت اولویت‌بندی تماس اول (team_data_accuracy_reviews) محاسبه می‌شود، نه یک بازبینی عمومی ثبت در سی‌آر‌ام.";
const FU_ASSUMPTION = "پیگیری = یادآورها به‌اضافه‌ی کارهای پیگیری و موعد در برنامهٔ روز. به‌موقع یعنی انجام تا پایان همان روز تهران.";
const ASSIGN_ASSUMPTION = "مشتری تخصیص‌یافته = مشتریانی که در همین دوره به کارشناس منسوب شده‌اند (ایجاد یا تغییر مالک در تاریخچه)، نه موجودی کل پرونده‌ها.";
const AMOUNT_ASSUMPTION = "مبلغ فروش = مبلغ مصوب پروندهٔ وام در زمان تکمیل. خرید کالا در این عدد نیست.";
const WORKDAY_ASSUMPTION = "روز کاری = روزهای تقویم تهران به‌جز جمعه و تعطیلات رسمی (official_holidays). ساعات حضور دستگاه حضور و غیاب در این نسخه نیست.";
const DOC_ASSUMPTION = "واجد شرایط = اولین ورود پرونده به مرحلهٔ بارگذاری مدارک در دوره؛ تکمیل = عبور از مرحلهٔ بررسی مدارک.";
const CANCEL_ASSUMPTION = "گروه: پرونده‌های وام غیرپیش‌ثبت که در همین دوره ایجاد شده‌اند (همان مخرج). لغو = اولین اقدام cancel-case یا funder-initial-reject روی همان پرونده تا پایان دوره. رد کارشناس یا رد مدیر در این نرخ نیست.";
const RETAIN_ASSUMPTION = "فعال در شروع دوره = مشتری منسوب که قبل از دوره ساخته شده و الان لغو نیست، مگر اینکه در دوره فعالیت داشته باشد. تاریخ لغو جداگانه ثبت نمی‌شود.";
const PREV_ASSUMPTION = "خریدار قبلی = مشتری با دست‌کم یک پروندهٔ تکمیل‌شده پیش از شروع دوره. در صورت تعیین فاصلهٔ روز، فقط کسانی که از خریدشان آن فاصله گذشته باشد.";
const REG_ASSUMPTION = "آمادهٔ تحویل به واحد ثبت = اولین ورود به مرحلهٔ تحویل مدارک فیزیکی؛ تحویل = اولین اقدام بعدی یک کاربر با نقش ثبت‌کننده.";
const INV_ASSUMPTION = "فاکتور = اسناد invoice در خرید کالا (نسخهٔ جایگزین‌شده شمرده نمی‌شود). بررسی به‌موقع = امضا تا پایان مهلت.";

function fuPct(c: Counts): number | null {
  return c.fuDue > 0 ? (c.fuOnTime / c.fuDue) * 100 : null;
}

function growthCell(base: { key: string; group: KpiGroup; label: string; formula: string }, current: number | null, previous: number | null, baseline: number | null, kind: "diff" | "ratio"): KpiCell {
  if (current == null) return cell({ ...base, unit: kind === "diff" ? "pp" : "percent", status: "empty_denom", value: null });
  const prevMissing = previous == null || (kind === "ratio" && previous === 0);
  if (prevMissing) {
    if (baseline == null) return cell({ ...base, unit: kind === "diff" ? "pp" : "percent", status: "no_baseline", value: null, missingReason: "مقدار دورهٔ قبل صفر یا خالی است و مبنای مقایسه تعیین نشده." });
    previous = baseline;
  }
  if (kind === "diff") return cell({ ...base, unit: "pp", status: "ok", value: current - (previous ?? 0) });
  return cell({ ...base, unit: "percent", status: "ok", value: ((current / (previous as number)) - 1) * 100 });
}

type TeamExtras = { activeSellers: number; salesList: number[]; minTarget: number | null; teamCalledUnique: number; prevAvg: number | null };

function kpisFor(
  c: Counts, prev: Counts | null, settings: KpiSettings, workingDays: number,
  targetCount: number | null, callIncomplete: boolean, scope: "expert" | "team",
  extras?: TeamExtras,
): KpiCell[] {
  const items: KpiCell[] = [];
  items.push(cell({ key: "successful_sales", group: "sales", label: "تعداد فروش موفق", formula: "تعداد پرونده‌های وام که برای اولین‌بار در این دوره به مرحلهٔ تکمیل رسیده‌اند.", unit: "count", status: "ok", value: c.sales }));
  items.push(ratioCell({ key: "customer_conversion", group: "sales", label: "نرخ تبدیل مشتری به فروش", formula: "(تعداد فروش موفق ÷ تعداد مشتریان تخصیص‌یافته در دوره) × ۱۰۰", assumption: ASSIGN_ASSUMPTION }, c.sales, c.assigned));
  if (targetCount == null) {
    items.push(missingCell({ key: "target_achievement", group: "sales", label: "درصد تحقق هدف فروش", formula: "(فروش واقعی ÷ هدف فروش) × ۱۰۰" }, "هدف فروش این دوره هنوز تعیین نشده. مدیر یا مدیر فروش می‌تواند آن را در تنظیمات همین صفحه بگذارد."));
  } else if (targetCount === 0) {
    items.push(cell({ key: "target_achievement", group: "sales", label: "درصد تحقق هدف فروش", formula: "(فروش واقعی ÷ هدف فروش) × ۱۰۰", unit: "percent", status: "empty_denom", value: null, numerator: c.sales, denominator: 0 }));
  } else {
    items.push(ratioCell({ key: "target_achievement", group: "sales", label: "درصد تحقق هدف فروش", formula: "(فروش واقعی ÷ هدف فروش) × ۱۰۰" }, c.sales, targetCount));
  }
  items.push(workingDays === 0
    ? cell({ key: "avg_daily_sales", group: "sales", label: "میانگین فروش روزانه", formula: "تعداد فروش موفق ÷ روزهای کاری دوره", unit: "count", status: "empty_denom", value: null, assumption: WORKDAY_ASSUMPTION, numerator: c.sales, denominator: 0 })
    : cell({ key: "avg_daily_sales", group: "sales", label: "میانگین فروش روزانه", formula: "تعداد فروش موفق ÷ روزهای کاری دوره", unit: "count", status: "ok", value: c.sales / workingDays, numerator: c.sales, denominator: workingDays, assumption: WORKDAY_ASSUMPTION }));
  items.push(c.sales === 0
    ? cell({ key: "avg_sale_amount", group: "sales", label: "میانگین مبلغ هر فروش", formula: "مجموع مبلغ فروش ÷ تعداد فروش موفق", unit: "amount", status: "empty_denom", value: null, assumption: AMOUNT_ASSUMPTION, numerator: c.amount, denominator: 0 })
    : cell({ key: "avg_sale_amount", group: "sales", label: "میانگین مبلغ هر فروش", formula: "مجموع مبلغ فروش ÷ تعداد فروش موفق", unit: "amount", status: "ok", value: c.amount / c.sales, numerator: c.amount, denominator: c.sales, assumption: AMOUNT_ASSUMPTION }));
  const called = extras?.teamCalledUnique ?? c.called;
  items.push(ratioCell({ key: "call_conversion", group: "sales", label: "نرخ تبدیل تماس به فروش", formula: "(تعداد فروش موفق ÷ تعداد مشتریان تماس‌گرفته‌شده یکتا) × ۱۰۰", assumption: "مشتری تماس‌گرفته‌شده یکتا = شماره تلفن یکتا در تماس‌های واقعی دوره، با همان انتساب گزارش عملکرد فروش.", incomplete: callIncomplete }, c.sales, called));
  items.push(ratioCell({ key: "document_completion", group: "sales", label: "نرخ تکمیل مدارک", formula: "(تعداد مشتریان تکمیل‌کننده مدارک ÷ تعداد مشتریان واجد شرایط) × ۱۰۰", assumption: DOC_ASSUMPTION }, c.docsDone, c.docsElig));
  items.push(ratioCell({ key: "cancellation_rate", group: "sales", label: "نرخ لغو فروش", formula: "(پرونده‌های ثبت‌شدهٔ همین دوره که لغو یا رد تأمین‌کننده شده‌اند ÷ پرونده‌های ثبت‌شده در دوره) × ۱۰۰", assumption: CANCEL_ASSUMPTION }, c.cancelled, c.registered));

  items.push(ratioCell({ key: "ontime_followup", group: "discipline", label: "نرخ پیگیری به‌موقع", formula: "(پیگیری‌های انجام‌شده در موعد ÷ کل پیگیری‌های سررسیدشده) × ۱۰۰", assumption: FU_ASSUMPTION }, c.fuOnTime, c.fuDue));
  if (settings.oldCustomerDays == null) {
    items.push(missingCell({ key: "old_customer_followup", group: "discipline", label: "نرخ پیگیری مشتریان قدیمی", formula: "(مشتریان قدیمی پیگیری‌شده ÷ مشتریان قدیمی نیازمند پیگیری) × ۱۰۰" }, "تعریف مشتری قدیمی (تعداد روز) هنوز تعیین نشده."));
  } else {
    items.push(ratioCell({ key: "old_customer_followup", group: "discipline", label: "نرخ پیگیری مشتریان قدیمی", formula: "(مشتریان قدیمی پیگیری‌شده ÷ مشتریان قدیمی نیازمند پیگیری) × ۱۰۰", assumption: `مشتری قدیمی = منسوب، لغونشده، که آخرین فروش یا فعالیتش بیش از ${settings.oldCustomerDays} روز قبل از شروع دوره بوده است.` }, c.oldDone, c.oldNeed));
  }
  items.push(ratioCell({ key: "prev_buyer_followup", group: "discipline", label: "نرخ پیگیری مشتریان قبلی", formula: "(مشتریان دارای خرید قبلی که پیگیری شده‌اند ÷ مشتریان قبلی واجد شرایط پیگیری) × ۱۰۰", assumption: PREV_ASSUMPTION }, c.prevDone, c.prevNeed));
  items.push(ratioCell({ key: "crm_accuracy", group: "discipline", label: "نرخ ثبت صحیح سی‌آر‌ام", formula: "(پرونده‌های ثبت‌شده بدون خطا ÷ کل پرونده‌های بررسی‌شده) × ۱۰۰", assumption: ACC_ASSUMPTION }, c.correct, c.reviewed));
  items.push(ratioCell({ key: "task_completion", group: "discipline", label: "نرخ انجام وظایف", formula: "(وظایف تکمیل‌شده ÷ کل وظایف موعددار) × ۱۰۰", assumption: "وظیفهٔ موعددار = ردیف برنامهٔ روز در این دوره (به‌جز منتقل‌شده و رزرو) به‌اضافه‌ی کارهای پیام‌رسان بله." }, c.taskDone, c.taskDue));
  if (settings.staleDays == null) {
    items.push(missingCell({ key: "stale_file_rate", group: "discipline", label: "نرخ پرونده‌های راکد", formula: "(پرونده‌های بدون اقدام در بازهٔ استاندارد ÷ پرونده‌های باز) × ۱۰۰" }, "بازهٔ استاندارد رکود (تعداد روز) هنوز تعیین نشده."));
  } else {
    items.push(ratioCell({ key: "stale_file_rate", group: "discipline", label: "نرخ پرونده‌های راکد", formula: "(پرونده‌های بدون اقدام در بازهٔ استاندارد ÷ پرونده‌های باز) × ۱۰۰", assumption: `پروندهٔ باز = وام ناتمام و ردنشده. راکد = بدون تغییر مرحله یا تماس در ${settings.staleDays} روز منتهی به پایان دوره.` }, c.staleFiles, c.openFiles));
  }
  if (settings.invoiceReviewSlaHours == null) {
    items.push(missingCell({ key: "ontime_invoice_review", group: "discipline", label: "نرخ بررسی به‌موقع فاکتور", formula: "(فاکتورهای بررسی‌شده در موعد ÷ کل فاکتورهای موعددار) × ۱۰۰" }, "مهلت بررسی فاکتور (ساعت) هنوز تعیین نشده."));
  } else {
    items.push(ratioCell({ key: "ontime_invoice_review", group: "discipline", label: "نرخ بررسی به‌موقع فاکتور", formula: "(فاکتورهای بررسی‌شده در موعد ÷ کل فاکتورهای موعددار) × ۱۰۰", assumption: INV_ASSUMPTION }, c.invOnTime, c.invDue));
  }

  items.push(growthCell({ key: "followup_quality_growth", group: "growth", label: "رشد کیفیت پیگیری", formula: "نرخ پیگیری به‌موقع این دوره − نرخ پیگیری به‌موقع دورهٔ قبل" }, fuPct(c), prev ? fuPct(prev) : null, settings.zeroPrevBaseline, "diff"));
  items.push(missingCell({ key: "error_improvement", group: "growth", label: "نرخ بهبود خطاها", formula: "(تعداد خطاهای اصلاح‌شده ÷ خطاهای شناسایی‌شده و قابل اصلاح) × ۱۰۰" }, "گردش کار جداگانه‌ای برای شناسایی و اصلاح خطاهای ثبت در سی‌آر‌ام وجود ندارد. بررسی صحت اولویت‌بندی فقط درست یا نادرست بودن را نگه می‌دارد، نه اصلاح را.", "percent", "source"));
  items.push(missingCell({ key: "training_application", group: "growth", label: "نرخ اجرای آموزش", formula: "(مهارت‌های آموزش‌دیده که در عمل با موفقیت اجرا شده‌اند ÷ مهارت‌های ارزیابی‌شده) × ۱۰۰" }, "جدول یا گردش کار آموزش و ارزیابی مهارت در سی‌آر‌ام نیست.", "percent", "source"));
  items.push(ratioCell({ key: "retention", group: "growth", label: "نرخ حفظ مشتری", formula: "(مشتریان فعال ابتدای دوره که در پایان دوره همچنان فعال‌اند ÷ مشتریان فعال ابتدای دوره) × ۱۰۰", assumption: RETAIN_ASSUMPTION }, c.retKept, c.retStart));

  if (scope === "team") {
    const active = extras?.activeSellers ?? 0;
    items.push(active === 0
      ? cell({ key: "avg_sales_per_person", group: "team", label: "میانگین فروش هر کارشناس", formula: "مجموع فروش تیم ÷ تعداد کارشناسان فعال", unit: "count", status: "empty_denom", value: null, numerator: c.sales, denominator: 0 })
      : cell({ key: "avg_sales_per_person", group: "team", label: "میانگین فروش هر کارشناس", formula: "مجموع فروش تیم ÷ تعداد کارشناسان فعال", unit: "count", status: "ok", value: c.sales / active, numerator: c.sales, denominator: active, assumption: "کارشناس فعال = عضو فعلی تیم با کاربر فعال، به‌جز کارآموز." }));
    items.push(missingCell({ key: "productivity", group: "team", label: "بهره‌وری تیم", formula: "مجموع فروش موفق ÷ مجموع ساعات کاری کارشناسان" }, "ساعات کاری دستگاه حضور و غیاب در این نسخه از برنامه (پایهٔ t878) وجود ندارد. پس از استقرار حضور و غیاب، قاعدهٔ جمع ساعت باید جداگانه تأیید شود.", "count", "source"));
    items.push(ratioCell({ key: "team_task_completion", group: "team", label: "نرخ انجام وظایف تیم", formula: "(وظایف انجام‌شده در موعد ÷ کل وظایف سررسیدشده تیم) × ۱۰۰" }, c.taskDone, c.taskDue));
    const minT = extras?.minTarget ?? null;
    const salesList = extras?.salesList ?? [];
    if (minT == null) {
      items.push(missingCell({ key: "participation", group: "team", label: "نرخ مشارکت کارشناسان", formula: "(کارشناسان محقق‌کننده حداقل هدف تعیین‌شده ÷ کل کارشناسان فعال) × ۱۰۰" }, "حداقل هدف فروش برای مشارکت هنوز تعیین نشده."));
    } else {
      const met = salesList.filter((n) => n >= minT).length;
      items.push(ratioCell({ key: "participation", group: "team", label: "نرخ مشارکت کارشناسان", formula: "(کارشناسان محقق‌کننده حداقل هدف تعیین‌شده ÷ کل کارشناسان فعال) × ۱۰۰" }, met, active));
    }
    items.push(ratioCell({ key: "team_error_rate", group: "team", label: "نرخ خطای تیم", formula: "(پرونده‌های دارای خطای تأییدشده ÷ کل پرونده‌های بررسی‌شده) × ۱۰۰", assumption: ACC_ASSUMPTION }, Math.max(0, c.reviewed - c.correct), c.reviewed));
    if (settings.registrarDeliverySlaHours == null) {
      items.push(missingCell({ key: "ontime_registrar_delivery", group: "team", label: "نرخ تحویل به‌موقع پرونده به واحد ثبت", formula: "(پرونده‌های تحویل‌شده در موعد به واحد ثبت ÷ کل پرونده‌های آمادهٔ تحویل) × ۱۰۰" }, "مهلت تحویل به واحد ثبت (ساعت) هنوز تعیین نشده."));
    } else {
      items.push(ratioCell({ key: "ontime_registrar_delivery", group: "team", label: "نرخ تحویل به‌موقع پرونده به واحد ثبت", formula: "(پرونده‌های تحویل‌شده در موعد به واحد ثبت ÷ کل پرونده‌های آمادهٔ تحویل) × ۱۰۰", assumption: REG_ASSUMPTION }, c.regOnTime, c.regDue));
    }
    const curAvg = active ? c.sales / active : null;
    items.push(growthCell({ key: "team_avg_growth", group: "team", label: "رشد میانگین عملکرد تیم", formula: "((میانگین فروش هر کارشناس در دورهٔ جاری ÷ میانگین دورهٔ قبل) − ۱) × ۱۰۰" }, curAvg, extras?.prevAvg ?? null, settings.zeroPrevBaseline, "ratio"));
  }
  if (prev) {
    const prevItems = kpisFor(prev, null, settings, workingDays, targetCount, false, scope, extras);
    return attachDeltas(items, prevItems);
  }
  return items;
}


export type KpiQuery = { period?: string; from?: string; to?: string; anchor?: string; teamId?: number | null; expertId?: number | null };
export type ExpertKpi = {
  salespersonId: number;
  name: string | null;
  userId: number | null;
  trainee: boolean;
  teamId: number | null;
  teamName: string | null;
  rankInTeam: number | null;
  rankOverall: number | null;
  kpis: KpiCell[];
};
export type TeamKpi = {
  teamId: number;
  name: string;
  memberCount: number;
  kpis: KpiCell[];
};

function targetFor(targets: TargetRow[], kind: "expert" | "team", id: number): { targetCount: number | null; minTargetCount: number | null } {
  const row = targets.find((t) => t.scopeKind === kind && t.scopeId === id);
  return { targetCount: row?.targetCount ?? null, minTargetCount: row?.minTargetCount ?? null };
}

/** Rank descending. A value of 0 is always unranked («بدون رتبه»), even when others have sales. */
function rankDesc(values: number[]): Array<number | null> {
  if (values.length === 0 || values.every((v) => v === 0)) return values.map(() => null);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const ranks = Array(values.length).fill(null) as Array<number | null>;
  let r = 1;
  for (let k = 0; k < order.length; k++) {
    if (order[k].v === 0) { ranks[order[k].i] = null; continue; }
    if (k > 0 && order[k].v !== order[k - 1].v) r = k + 1;
    ranks[order[k].i] = r;
  }
  return ranks;
}

export function mePayload(db: TraineeQueryDb, actor: AuthUser) {
  const enabled = skFlagOn(db);
  const access = accessOf(actor, db);
  const canView = enabled && access !== "none";
  const self = actor.salespersonId ? listExperts(db as DatabaseSync).find((e) => e.salespersonId === actor.salespersonId) : null;
  return {
    enabled,
    flag: SK_FLAG,
    canView,
    canEditSettings: canView && access === "manager",
    access: canView ? access : null,
    salespersonId: actor.salespersonId ?? null,
    teamId: self?.teamId ?? null,
    teamName: self?.teamName ?? null,
    name: self?.name ?? actor.fullName ?? null,
    visibility: access === "manager" ? "all" : access === "none" ? null : "self_and_team_totals",
  };
}

export function salesKpiReport(db: DatabaseSync, actor: AuthUser, query: KpiQuery, now = new Date()) {
  const access = accessOf(actor, db);
  if (access === "none") {
    const err = new Error("این گزارش برای این نقش نیست.") as Error & { status?: number };
    err.status = 403; throw err;
  }
  ensureSalesKpiSchema(db);
  const win = performanceWindow({ period: query.period ?? "month", from: query.from, to: query.to, anchor: query.anchor }, now);
  const periodKey = query.period === "custom" ? `custom:${win.current.startDay}:${win.current.endDay}` : jalaliMonthKey(win.current.startDay);
  const periodTitle = jalaliMonthTitle(win.current.startDay);
  const prevLen = win.current.endDay - win.current.startDay + 1;
  const prevStart = win.current.startDay - prevLen;
  const prevEnd = win.current.startDay - 1;
  const prevWindow: Window = {
    startDay: prevStart, endDay: prevEnd,
    fromIso: new Date(prevStart * DAY - OFFSET).toISOString(),
    toIso: new Date((prevEnd + 1) * DAY - OFFSET).toISOString(),
  };
  const previousLabel = faRangeLabel(prevStart, prevEnd);
  const settings = readSettings(db, periodKey);
  const excludeTest = excludeTestOn(db);
  const nowMs = now.getTime();
  const cur = gatherWindow(db, win.current, excludeTest, settings, nowMs);
  const prev = gatherWindow(db, prevWindow, excludeTest, settings, nowMs);
  const workingDays = workingDaysIn(db, win.current.startDay, win.current.endDay);
  const callIncomplete = periodOverlapsIncomplete(win.current);
  const experts = listExperts(db).filter((e) => !EXCLUDED_USER_IDS.includes(Number(e.userId)));
  const teams = listTeams(db);

  let filterTeam = query.teamId != null ? Number(query.teamId) : null;
  let filterExpert = query.expertId != null ? Number(query.expertId) : null;
  if (filterTeam != null && (!Number.isInteger(filterTeam) || filterTeam <= 0)) {
    const err = new Error("تیم انتخاب‌شده معتبر نیست.") as Error & { status?: number };
    err.status = 400; throw err;
  }
  if (filterExpert != null && (!Number.isInteger(filterExpert) || filterExpert <= 0)) {
    const err = new Error("کارشناس انتخاب‌شده معتبر نیست.") as Error & { status?: number };
    err.status = 400; throw err;
  }

  if (access === "expert" || access === "trainee") {
    const selfId = actor.salespersonId;
    if (!selfId) {
      const err = new Error("این گزارش برای این نقش نیست.") as Error & { status?: number };
      err.status = 403; throw err;
    }
    const self = experts.find((e) => e.salespersonId === selfId);
    if (filterExpert != null && filterExpert !== selfId) {
      const err = new Error("مشاهدهٔ شاخص کارشناس دیگر مجاز نیست.") as Error & { status?: number };
      err.status = 403; throw err;
    }
    if (filterTeam != null && self?.teamId != null && filterTeam !== self.teamId) {
      const err = new Error("مشاهدهٔ تیم دیگر مجاز نیست.") as Error & { status?: number };
      err.status = 403; throw err;
    }
    filterExpert = selfId;
    filterTeam = self?.teamId ?? filterTeam;
  }

  const visibleExperts = experts.filter((e) => {
    if (filterTeam != null && e.teamId !== filterTeam) return false;
    if (access === "manager" && filterExpert != null && e.salespersonId !== filterExpert) return false;
    return true;
  });

  const overallRanks = rankDesc(experts.filter((e) => !e.trainee).map((e) => cur.bySp.get(e.salespersonId)?.sales ?? 0));
  const overallIndex = new Map(experts.filter((e) => !e.trainee).map((e, i) => [e.salespersonId, overallRanks[i]]));
  const teamRank = new Map<number, number | null>();
  for (const t of teams) {
    const members = t.members.filter((m) => !m.trainee && !EXCLUDED_USER_IDS.includes(Number(m.userId)));
    const ranks = rankDesc(members.map((m) => cur.bySp.get(m.salespersonId)?.sales ?? 0));
    members.forEach((m, i) => teamRank.set(m.salespersonId, ranks[i]));
  }

  const hideOthers = access !== "manager";
  const expertRows: ExpertKpi[] = visibleExperts
    .filter((e) => !hideOthers || e.salespersonId === actor.salespersonId)
    .map((e) => {
      const c = cur.bySp.get(e.salespersonId) ?? emptyCounts();
      const p = prev.bySp.get(e.salespersonId) ?? emptyCounts();
      const tgt = targetFor(settings.targets, "expert", e.salespersonId);
      return {
        salespersonId: e.salespersonId,
        name: hideOthers ? (e.salespersonId === actor.salespersonId ? e.name : null) : e.name,
        userId: hideOthers ? null : e.userId,
        trainee: e.trainee,
        teamId: e.teamId,
        teamName: e.teamName,
        rankInTeam: e.trainee ? null : (teamRank.get(e.salespersonId) ?? null),
        rankOverall: (hideOthers || e.trainee) ? (e.trainee ? null : (teamRank.get(e.salespersonId) ?? null)) : (overallIndex.get(e.salespersonId) ?? null),
        kpis: kpisFor(c, p, settings, workingDays, tgt.targetCount, callIncomplete, "expert"),
      };
    });

  expertRows.sort((a, b) => {
    const ta = a.teamId == null ? 1e9 : a.teamId;
    const tb = b.teamId == null ? 1e9 : b.teamId;
    const ra = a.rankInTeam == null ? 1e9 : a.rankInTeam;
    const rb = b.rankInTeam == null ? 1e9 : b.rankInTeam;
    return ta - tb || ra - rb || compareKpiNames(a.name, b.name) || a.salespersonId - b.salespersonId;
  });

  const teamRows: TeamKpi[] = teams
    .filter((t) => {
      if (filterTeam != null && t.teamId !== filterTeam) return false;
      if (hideOthers) {
        const self = experts.find((e) => e.salespersonId === actor.salespersonId);
        return self?.teamId === t.teamId;
      }
      return true;
    })
    .map((t) => {
      const members = t.members.filter((m) => !EXCLUDED_USER_IDS.includes(Number(m.userId)));
      const active = members.filter((m) => !m.trainee);
      const counts = sumCounts(active.map((m) => cur.bySp.get(m.salespersonId) ?? emptyCounts()));
      const prevCounts = sumCounts(active.map((m) => prev.bySp.get(m.salespersonId) ?? emptyCounts()));
      const phones = new Set<string>();
      const prevPhones = new Set<string>();
      for (const m of active) {
        for (const p of cur.calledPhones.get(m.salespersonId) ?? []) phones.add(p);
        for (const p of prev.calledPhones.get(m.salespersonId) ?? []) prevPhones.add(p);
      }
      counts.called = phones.size;
      prevCounts.called = prevPhones.size;
      const tgt = targetFor(settings.targets, "team", t.teamId);
      const expertTargets = active.map((m) => targetFor(settings.targets, "expert", m.salespersonId).targetCount);
      const teamTarget = tgt.targetCount ?? (expertTargets.every((x) => x != null) ? expertTargets.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) : null);
      const minTarget = tgt.minTargetCount ?? tgt.targetCount ?? null;
      const prevAvg = active.length ? prevCounts.sales / active.length : null;
      return {
        teamId: t.teamId,
        name: t.name,
        memberCount: active.length,
        kpis: kpisFor(counts, prevCounts, settings, workingDays, teamTarget, callIncomplete, "team", {
          activeSellers: active.length,
          salesList: active.map((m) => cur.bySp.get(m.salespersonId)?.sales ?? 0),
          minTarget,
          teamCalledUnique: phones.size,
          prevAvg,
        }),
      };
    });

  return {
    period: win.period,
    periodKey,
    periodTitle,
    label: win.label,
    previousLabel,
    from: ymdOfDay(win.current.startDay),
    to: ymdOfDay(win.current.endDay),
    workingDays,
    incompleteFrom: INCOMPLETE_FROM,
    callDataIncomplete: callIncomplete,
    access,
    visibility: access === "manager" ? "all" : "self_and_team_totals",
    settings: {
      staleDays: settings.staleDays,
      oldCustomerDays: settings.oldCustomerDays,
      prevBuyerFollowupDays: settings.prevBuyerFollowupDays,
      invoiceReviewSlaHours: settings.invoiceReviewSlaHours,
      registrarDeliverySlaHours: settings.registrarDeliverySlaHours,
      zeroPrevBaseline: settings.zeroPrevBaseline,
      hasTargets: settings.targets.length > 0,
    },
    teams: teamRows,
    experts: expertRows,
    filters: {
      teams: access === "manager" ? teams.map((t) => ({ teamId: t.teamId, name: t.name })) : teamRows.map((t) => ({ teamId: t.teamId, name: t.name })),
      experts: (access === "manager"
        ? experts.filter((e) => filterTeam == null || e.teamId === filterTeam).map((e) => ({ salespersonId: e.salespersonId, name: e.name, teamId: e.teamId }))
        : expertRows.map((e) => ({ salespersonId: e.salespersonId, name: e.name, teamId: e.teamId }))
      ).slice().sort((a, b) => compareKpiNames(a.name, b.name) || a.salespersonId - b.salespersonId),
    },
  };
}

export function isKpiViewer(u: AuthUser, db: TraineeQueryDb): boolean {
  return accessOf(u, db) !== "none";
}
export function isKpiEditor(u: AuthUser, db: TraineeQueryDb): boolean {
  return accessOf(u, db) === "manager";
}

export { completedByExpert, accessOf };

/**
 * عملکرد من v1.1 (flag.my_performance_v1, absent = OFF; only '1' is ON).
 * Expert's own work report. Reuses sales-performance windows, call facts, filed counts,
 * and role weights for team rank. Never returns colleagues' names.
 *
 * flag.my_performance_inquiry stays as an unused OFF row (additive migrate only).
 * It is not read by /my-work and is not a credit-inquiry metric.
 *
 * Does not write or toggle flag.sales_performance_v1, flag.expert_lockdown, or flag.multi_team_v1.
 */
import type { DatabaseSync } from "node:sqlite";
import { queryRow } from "./crm-db";
import { excludeTestOn, notTestCustomerIdSql } from "./test-customers";
import { assignedByExpert, followupsByExpert } from "./sales-kpi";
import type { AuthUser } from "./auth";
import {
  accessOf,
  competitionRank,
  countsForWindow,
  deltaOf,
  emptyCounts,
  ensureSalesPerformanceSchema,
  filedByExpert,
  listExperts,
  performanceCallRows,
  performanceWindow,
  periodOverlapsIncomplete,
  scoreRoleGroup,
  seedMembershipHistoryIfEmpty,
  type AccessKind,
  type Delta,
  type PeriodKind,
  type ScoredExpert,
} from "./sales-performance";

export const MP_FLAG = "flag.my_performance_v1";
export const MP_INQUIRY_FLAG = "flag.my_performance_inquiry";

const DAY = 86_400_000;
const OFFSET = 210 * 60_000;
const has = (db: DatabaseSync, t: string) => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)); }
  catch { return false; }
};
const cols = (db: DatabaseSync, t: string) => {
  try { return new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)); }
  catch { return new Set<string>(); }
};

export function mpFlagOn(db?: { prepare?: unknown } | null): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [MP_FLAG])?.value === "1"; }
  catch { return false; }
}
export function mpInquiryOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [MP_INQUIRY_FLAG])?.value === "1"; }
  catch { return false; }
}

/** Same read against an explicit DatabaseSync (fixtures). */
export function mpFlagOnDb(db: DatabaseSync): boolean {
  try { return (db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(MP_FLAG) as { value?: string } | undefined)?.value === "1"; }
  catch { return false; }
}
export function mpInquiryOnDb(db: DatabaseSync): boolean {
  try { return (db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(MP_INQUIRY_FLAG) as { value?: string } | undefined)?.value === "1"; }
  catch { return false; }
}

/** Local read of flag.my_performance_v12 so v1.1 does not import the v1.2 module (cycle). */
function mpV12FlagOnDb(db: DatabaseSync): boolean {
  try { return (db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get("flag.my_performance_v12") as { value?: string } | undefined)?.value === "1"; }
  catch { return false; }
}

function appSpSql(db: DatabaseSync): string {
  return cols(db, "loan_applications").has("salesperson_id_snapshot")
    ? "COALESCE(a.salesperson_id_snapshot, c.salesperson_id)"
    : "c.salesperson_id";
}
function notTestJoin(excludeTest: boolean, alias = "c"): string {
  return excludeTest ? `AND ${notTestCustomerIdSql(`${alias}.id`)}` : "";
}

/** Contracts that reached a signed state in the window (unique loan application, else generation). */
export function signedContractsByExpert(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): Map<number, number> {
  const out = new Map<number, number>();
  const bump = (sp: number) => { if (Number.isFinite(sp)) out.set(sp, (out.get(sp) ?? 0) + 1); };
  if (has(db, "contract_generations") && has(db, "loan_applications")) {
    const snap = appSpSql(db);
    const stCols = cols(db, "contract_generations");
    const when = stCols.has("updated_at") ? "COALESCE(g.updated_at,g.sent_at,g.created_at)" : "g.created_at";
    const del = stCols.has("deleted_at") ? "AND g.deleted_at IS NULL" : "";
    const sup = stCols.has("superseded_at") ? "AND g.superseded_at IS NULL" : "";
    const nt = notTestJoin(excludeTest);
    const rows = db.prepare(`SELECT ${snap} sp, COALESCE(g.loan_application_id, g.id) app, MIN(julianday(${when})) first
      FROM contract_generations g
      JOIN loan_applications a ON a.id=g.loan_application_id
      JOIN customers c ON c.id=a.customer_id
      WHERE a.deleted_at IS NULL ${del} ${sup} ${nt}
        AND (g.status='signed' OR g.provider_status IN ('accept','signed'))
        AND ${snap} IS NOT NULL
      GROUP BY COALESCE(g.loan_application_id, g.id)
      HAVING first>=julianday(?) AND first<julianday(?)`).all(fromIso, toIso) as { sp: number }[];
    for (const r of rows) bump(Number(r.sp));
    return out;
  }
  // Fallback: first forward exit from a pending-signature stage in the window.
  if (has(db, "loan_application_stage_history") && has(db, "loan_applications")) {
    const snap = appSpSql(db);
    const rows = db.prepare(`SELECT ${snap} sp, a.id app, MIN(julianday(h.created_at)) first
      FROM loan_application_stage_history h
      JOIN loan_applications a ON a.id=h.application_id
      JOIN customers c ON c.id=a.customer_id
      WHERE a.deleted_at IS NULL ${notTestJoin(excludeTest)}
        AND h.from_stage IN ('primary_contract_pending_signature','approved_contract_pending_signature','final_invoice_pending_signature')
        AND h.to_stage IS NOT NULL AND h.to_stage != h.from_stage
        AND ${snap} IS NOT NULL
        AND COALESCE(h.action,'') NOT LIKE '%return%' AND COALESCE(h.action,'') NOT LIKE '%reject%' AND COALESCE(h.action,'') NOT LIKE '%cancel%'
      GROUP BY a.id
      HAVING first>=julianday(?) AND first<julianday(?)`).all(fromIso, toIso) as { sp: number }[];
    for (const r of rows) bump(Number(r.sp));
  }
  return out;
}

export type BaleCounts = { chats: number; messages: number };
export function baleByExpert(db: DatabaseSync, fromIso: string, toIso: string): Map<number, BaleCounts> {
  const out = new Map<number, BaleCounts>();
  const bump = (sp: number, chats: number, messages: number) => {
    if (!Number.isFinite(sp)) return;
    const cur = out.get(sp) ?? { chats: 0, messages: 0 };
    cur.chats += chats; cur.messages += messages;
    out.set(sp, cur);
  };
  const userToSp = new Map<number, number>();
  if (has(db, "users")) {
    for (const r of db.prepare("SELECT id uid, salesperson_id sp FROM users WHERE salesperson_id IS NOT NULL").all() as { uid: number; sp: number }[]) {
      userToSp.set(Number(r.uid), Number(r.sp));
    }
  }
  if (has(db, "bale_bot_messages") && has(db, "bale_bot_chats") && has(db, "bale_bots")) {
    const del = cols(db, "bale_bot_messages").has("deleted_at") ? "AND m.deleted_at IS NULL" : "";
    const at = cols(db, "bale_bot_messages").has("sent_at") ? "COALESCE(m.sent_at,m.created_at)" : "m.created_at";
    const rows = db.prepare(`SELECT b.user_id uid, m.chat_row chat, m.dir dir
      FROM bale_bot_messages m
      JOIN bale_bot_chats c ON c.id=m.chat_row
      JOIN bale_bots b ON b.id=c.bot_id
      WHERE julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?) ${del}`).all(fromIso, toIso) as { uid: number; chat: number; dir: string }[];
    const chats = new Map<number, Set<number>>();
    const msgs = new Map<number, number>();
    for (const r of rows) {
      const sp = userToSp.get(Number(r.uid));
      if (sp == null) continue;
      if (!chats.has(sp)) chats.set(sp, new Set());
      chats.get(sp)!.add(Number(r.chat));
      if (String(r.dir) === "out") msgs.set(sp, (msgs.get(sp) ?? 0) + 1);
    }
    for (const [sp, set] of chats) bump(sp, set.size, msgs.get(sp) ?? 0);
  }
  return out;
}

export type MpMetric = { value: number; delta: Delta };
export type MpFollow = { done: number; due: number };
export type MpTrendCol = { key: string; label: string; value: number; current: boolean };

export type MpReport = {
  access: AccessKind;
  period: PeriodKind;
  range: {
    from: string; to: string; fromIso: string; toIso: string;
    label: string; previousLabel: string; complete: boolean;
  };
  incomplete: boolean;
  self: {
    salespersonId: number;
    name: string;
    teamName: string | null;
    trainee: boolean;
    calls: MpMetric;
    outbound: MpMetric;
    inbound: MpMetric;
    answered: MpMetric;
    noAnswer: MpMetric;
    durationSec: MpMetric;
    newCustomers: MpMetric;
    filed: MpMetric;
    signed: MpMetric;
    baleChats: MpMetric;
    baleMessages: MpMetric;
    followups: MpFollow;
  };
  team: {
    name: string | null;
    rank: number | null;
    of: number;
    averages: {
      calls: number;
      newCustomers: number;
      filed: number;
      signed: number;
      baleMessages: number;
    };
  } | null;
  trend: { kind: "hour" | "day"; columns: MpTrendCol[] };
};

function isoDay(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function faDayLabel(day: number): string {
  const d = new Date(day * DAY + 12 * 3600_000);
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "UTC", day: "numeric" }).format(d);
}

function extraForWindow(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean) {
  const assigned = assignedByExpert(db, fromIso, toIso, excludeTest);
  const filed = filedByExpert(db, fromIso, toIso, excludeTest);
  const signed = signedContractsByExpert(db, fromIso, toIso, excludeTest);
  const bale = baleByExpert(db, fromIso, toIso);
  const follow = followupsByExpert(db, fromIso, toIso, excludeTest);
  return { assigned, filed, signed, bale, follow };
}

function metric(cur: number, prev: number, unit: boolean): MpMetric {
  return { value: cur, delta: deltaOf(cur, prev, unit) };
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

export function myWorkMePayload(db: DatabaseSync, actor: AuthUser) {
  const enabled = mpFlagOnDb(db) || mpV12FlagOnDb(db);
  const access = accessOf(actor, db);
  const experts = enabled ? listExperts(db) : [];
  const self = actor.salespersonId ? experts.find((e) => e.salespersonId === actor.salespersonId) ?? null : null;
  return {
    enabled,
    access,
    v12: mpV12FlagOnDb(db),
    canView: enabled && access !== "none" && Boolean(self),
    self: self ? { salespersonId: self.salespersonId, name: self.name, trainee: self.trainee, teamName: self.teamName } : null,
  };
}

export function myWorkReport(db: DatabaseSync, actor: AuthUser, query: { period?: string; from?: string; to?: string; anchor?: string }, now = new Date()): MpReport {
  if (!mpFlagOnDb(db) && !mpV12FlagOnDb(db)) {
    const err = new Error("not_found") as Error & { status: number };
    err.status = 404;
    throw err;
  }
  const access = accessOf(actor, db);
  if (access === "none" || !actor.salespersonId) {
    const err = new Error("forbidden") as Error & { status: number };
    err.status = 403;
    throw err;
  }
  ensureSalesPerformanceSchema(db);
  seedMembershipHistoryIfEmpty(db, now);
  const bounds = performanceWindow(query, now);
  const excludeTest = excludeTestOn(db);
  const incomplete = periodOverlapsIncomplete(bounds.current);
  const curCounts = countsForWindow(db, bounds.current, excludeTest);
  const prevCounts = countsForWindow(db, bounds.previous, excludeTest);
  const curX = extraForWindow(db, bounds.current.fromIso, bounds.current.toIso, excludeTest);
  const prevX = extraForWindow(db, bounds.previous.fromIso, bounds.previous.toIso, excludeTest);
  const experts = listExperts(db);
  const people: ScoredExpert[] = experts.map((e) => ({
    ...e,
    counts: curCounts.bySp.get(e.salespersonId) ?? emptyCounts(),
    prev: prevCounts.bySp.get(e.salespersonId) ?? emptyCounts(),
    score: null, rank: null, roleN: null, points: {}, rawSum: 0,
  }));
  scoreRoleGroup(people);

  const selfId = Number(actor.salespersonId);
  const self = people.find((p) => p.salespersonId === selfId);
  if (!self) {
    const err = new Error("forbidden") as Error & { status: number };
    err.status = 403;
    throw err;
  }

  const teammates = people.filter((p) => p.teamId != null && p.teamId === self.teamId && !p.trainee);
  const scores = teammates.map((p) => p.score ?? -1);
  const ranks = competitionRank(scores);
  const selfTeamIx = teammates.findIndex((p) => p.salespersonId === selfId);
  const teamRank = self.trainee || selfTeamIx < 0 ? null : ranks[selfTeamIx] ?? null;

  const extrasOf = (id: number, x: ReturnType<typeof extraForWindow>) => ({
    newCustomers: x.assigned.get(id)?.size ?? 0,
    filed: x.filed.get(id) ?? 0,
    signed: x.signed.get(id) ?? 0,
    baleChats: x.bale.get(id)?.chats ?? 0,
    baleMessages: x.bale.get(id)?.messages ?? 0,
    follow: x.follow.get(id) ?? { due: 0, onTime: 0 },
  });
  const sc = extrasOf(selfId, curX);
  const spv = extrasOf(selfId, prevX);
  const cc = self.counts;
  const pc = self.prev;

  const team = self.teamName || teammates.length ? {
    name: self.teamName,
    rank: teamRank,
    of: teammates.length,
    averages: {
      calls: mean(teammates.map((p) => p.counts.calls)),
      newCustomers: mean(teammates.map((p) => curX.assigned.get(p.salespersonId)?.size ?? 0)),
      filed: mean(teammates.map((p) => curX.filed.get(p.salespersonId) ?? 0)),
      signed: mean(teammates.map((p) => curX.signed.get(p.salespersonId) ?? 0)),
      baleMessages: mean(teammates.map((p) => curX.bale.get(p.salespersonId)?.messages ?? 0)),
    },
  } : null;

  const trend = buildTrend(db, bounds.period, bounds.current, selfId, excludeTest, now);

  return {
    access,
    period: bounds.period,
    range: {
      from: isoDay(bounds.current.startDay), to: isoDay(bounds.current.endDay),
      fromIso: bounds.current.fromIso, toIso: bounds.current.toIso,
      label: bounds.label, previousLabel: bounds.previousLabel, complete: bounds.complete,
    },
    incomplete,
    self: {
      salespersonId: self.salespersonId,
      name: self.name,
      teamName: self.teamName,
      trainee: self.trainee,
      calls: metric(cc.calls, pc.calls, false),
      outbound: metric(cc.outbound, pc.outbound, true),
      inbound: metric(cc.inbound, pc.inbound, true),
      answered: metric(cc.answered, pc.answered, true),
      noAnswer: metric(cc.noAnswer, pc.noAnswer, true),
      durationSec: metric(cc.duration, pc.duration, false),
      newCustomers: metric(sc.newCustomers, spv.newCustomers, true),
      filed: metric(sc.filed, spv.filed, true),
      signed: metric(sc.signed, spv.signed, true),
      baleChats: metric(sc.baleChats, spv.baleChats, true),
      baleMessages: metric(sc.baleMessages, spv.baleMessages, true),
      followups: { done: sc.follow.onTime, due: sc.follow.due },
    },
    team,
    trend,
  };
}

function buildTrend(db: DatabaseSync, period: PeriodKind, w: { fromIso: string; toIso: string; startDay: number; endDay: number }, sp: number, excludeTest: boolean, now: Date): MpReport["trend"] {
  const rows = performanceCallRows(db, w.fromIso, w.toIso, excludeTest).filter((r) => r.sp === sp && !r.companyNoAnswer);
  if (period === "day") {
    const buckets = new Array(10).fill(0) as number[];
    for (const r of rows) {
      const hour = new Date(r.at + OFFSET).getUTCHours();
      if (hour < 9 || hour > 18) continue;
      buckets[hour - 9]! += 1;
    }
    const nowHour = new Date(now.getTime() + OFFSET).getUTCHours();
    const columns: MpTrendCol[] = buckets.map((value, i) => {
      const hour = i + 9;
      return { key: String(hour), label: pe(hour), value, current: hour === nowHour || (i === buckets.length - 1 && (nowHour < 9 || nowHour > 18)) };
    });
    if (!columns.some((c) => c.current) && columns.length) columns[columns.length - 1]!.current = true;
    return { kind: "hour", columns };
  }
  const byDay = new Map<number, number>();
  for (const r of rows) {
    const day = Math.floor((r.at + OFFSET) / DAY);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const today = Math.floor((now.getTime() + OFFSET) / DAY);
  const columns: MpTrendCol[] = [];
  for (let d = w.startDay; d <= w.endDay; d++) {
    columns.push({
      key: isoDay(d),
      label: faDayLabel(d),
      value: byDay.get(d) ?? 0,
      current: d === today || (d === w.endDay && today > w.endDay),
    });
  }
  if (columns.length && !columns.some((c) => c.current)) columns[columns.length - 1]!.current = true;
  return { kind: "day", columns };
}

function pe(n: number): string {
  return String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
}

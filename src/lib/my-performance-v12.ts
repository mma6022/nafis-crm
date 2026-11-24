/**
 * عملکرد من v1.2 (flag.my_performance_v12, absent = OFF; only '1' is ON).
 * Three tabs behind a default-off flag: summary (reuses v1.1 /my-work),
 * KPIs (reuses sales-kpi formulas; no fork), calls (this expert only).
 *
 * Expert responses never include colleague names or individual scores.
 * KPIs without a source or computable value are omitted (no «نیاز به تنظیم»).
 * Inquiry is not a metric. Does not write sales_performance_v1, expert_lockdown,
 * or multi_team_v1.
 */
import type { DatabaseSync } from "node:sqlite";
import { queryRow } from "./crm-db";
import { excludeTestOn, notTestCustomerIdSql } from "./test-customers";
import type { AuthUser } from "./auth";
import {
  kpisFor,
  gatherWindow,
  targetFor,
  readSettings,
  workingDaysIn,
  jalaliMonthKey,
  faNum,
  faPct,
  faToman,
  type KpiCell,
  type KpiGroup,
} from "./sales-kpi";
import {
  accessOf,
  breakdownRows,
  competitionRank,
  countsForWindow,
  emptyCounts,
  ensureSalesPerformanceSchema,
  listExperts,
  performanceCallRows,
  performanceWindow,
  periodOverlapsIncomplete,
  ROLE_LABEL,
  scoreRoleGroup,
  seedMembershipHistoryIfEmpty,
  type PeriodKind,
  type ScoredExpert,
  type ScoreRole,
} from "./sales-performance";
import { myWorkReport, mpFlagOnDb, type MpReport } from "./my-performance-v11";

export const MP_V12_FLAG = "flag.my_performance_v12";

const DAY = 86_400_000;
const OFFSET = 210 * 60_000;
const PAGE = 20;

const HIDDEN_EVEN_IF_COMPUTED = new Set(["crm_accuracy"]);
const OMIT_STATUS = new Set(["missing", "no_baseline", "empty_denom"]);

const has = (db: DatabaseSync, t: string) => {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)); }
  catch { return false; }
};
const cols = (db: DatabaseSync, t: string) => {
  try { return new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)); }
  catch { return new Set<string>(); }
};

export function mpV12FlagOn(): boolean {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [MP_V12_FLAG])?.value === "1"; }
  catch { return false; }
}
export function mpV12FlagOnDb(db: DatabaseSync): boolean {
  try { return (db.prepare("SELECT value FROM call_queue_settings WHERE key=?").get(MP_V12_FLAG) as { value?: string } | undefined)?.value === "1"; }
  catch { return false; }
}

function notFound(): never {
  const err = new Error("not_found") as Error & { status: number };
  err.status = 404;
  throw err;
}
function forbidden(): never {
  const err = new Error("forbidden") as Error & { status: number };
  err.status = 403;
  throw err;
}

function requireV12(db: DatabaseSync): void {
  if (!mpV12FlagOnDb(db)) notFound();
}

function requireSelf(db: DatabaseSync, actor: AuthUser): { selfId: number; access: ReturnType<typeof accessOf> } {
  const access = accessOf(actor, db);
  if (access === "none" || !actor.salespersonId) forbidden();
  return { selfId: Number(actor.salespersonId), access };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function scoreFormula(role: ScoreRole | null): string {
  if (!role) return "برای این نقش امتیاز عملکرد تعریف نشده است.";
  const label = ROLE_LABEL[role];
  const parts = breakdownRows(role).map(([, name, w]) => `${name} ${faNum(w)}`);
  return `نقش ${label}: ${parts.join("، ")}. مقدار هر شاخص تقسیم بر بهترین همان نقش در همین بازه، ضرب در وزن؛ سپس جمع طوری مقیاس می‌شود که بیشترین جمع آن نقش برابر ۱۰۰ شود. کارآموز در محاسبه نیست.`;
}

function displayOf(cell: KpiCell): string {
  if (cell.display) return cell.display;
  if (cell.value == null) return "—";
  if (cell.unit === "percent") return faPct(cell.value);
  if (cell.unit === "amount") return faToman(cell.value);
  return faNum(cell.value, Number.isInteger(cell.value) ? 0 : 1);
}

function avgDisplay(cell: KpiCell, avg: number | null): string | null {
  if (avg == null) return null;
  if (cell.unit === "percent") return faPct(avg);
  if (cell.unit === "amount") return faToman(avg);
  if (cell.unit === "pp") return faNum(avg, 1);
  return faNum(avg, Number.isInteger(avg) ? 0 : 1);
}

function computable(cell: KpiCell): boolean {
  if (HIDDEN_EVEN_IF_COMPUTED.has(cell.key)) return false;
  if (cell.group === "team") return false;
  if (OMIT_STATUS.has(cell.status)) return false;
  if (cell.status === "ok" || cell.incomplete) return cell.value != null || cell.incomplete;
  return false;
}

export type MpKpiItem = {
  key: string;
  group: KpiGroup;
  label: string;
  formula: string;
  value: number | null;
  display: string;
  unit: KpiCell["unit"];
  incomplete: boolean;
  teamAvg: number | null;
  teamAvgDisplay: string | null;
  rank: number | null;
  of: number;
};

export type MpScore = {
  value: number | null;
  teamAvg: number | null;
  rank: number | null;
  of: number;
  role: ScoreRole | null;
  roleLabel: string | null;
  formula: string;
};

export type MpKpiReport = {
  period: PeriodKind;
  periodKey: string;
  label: string;
  previousLabel: string;
  from: string;
  to: string;
  workingDays: number;
  incomplete: boolean;
  score: MpScore;
  groups: { sales: MpKpiItem[]; discipline: MpKpiItem[]; growth: MpKpiItem[] };
};

function isoDay(day: number): string {
  return new Date(day * DAY - OFFSET + 12 * 3600_000).toISOString().slice(0, 10);
}

export function myWorkKpiReport(
  db: DatabaseSync,
  actor: AuthUser,
  query: { period?: string; from?: string; to?: string; anchor?: string },
  now = new Date(),
): MpKpiReport {
  requireV12(db);
  const { selfId } = requireSelf(db, actor);
  ensureSalesPerformanceSchema(db);
  seedMembershipHistoryIfEmpty(db, now);
  const win = performanceWindow(query, now);
  const periodKey = query.period === "custom" ? `custom:${win.current.startDay}:${win.current.endDay}` : jalaliMonthKey(win.current.startDay);
  const settings = readSettings(db, periodKey);
  const excludeTest = excludeTestOn(db);
  const nowMs = now.getTime();
  const cur = gatherWindow(db, win.current, excludeTest, settings, nowMs);
  const prev = gatherWindow(db, win.previous, excludeTest, settings, nowMs);
  const workingDays = workingDaysIn(db, win.current.startDay, win.current.endDay);
  const callIncomplete = periodOverlapsIncomplete(win.current);

  const experts = listExperts(db);
  const selfMeta = experts.find((e) => e.salespersonId === selfId);
  if (!selfMeta) forbidden();
  const teammates = experts.filter((e) => e.teamId != null && e.teamId === selfMeta.teamId && !e.trainee);
  const teamOf = teammates.length;

  const kpisOf = (sp: number): KpiCell[] => {
    const counts = cur.bySp.get(sp);
    const prevC = prev.bySp.get(sp) ?? null;
    const tgt = targetFor(settings.targets, "expert", sp);
    const empty = {
      sales: 0, amount: 0, assigned: 0, called: 0, docsElig: 0, docsDone: 0, cancelled: 0, registered: 0,
      fuDue: 0, fuOnTime: 0, oldNeed: 0, oldDone: 0, prevNeed: 0, prevDone: 0, reviewed: 0, correct: 0,
      taskDue: 0, taskDone: 0, openFiles: 0, staleFiles: 0, invDue: 0, invOnTime: 0, retStart: 0, retKept: 0,
      regDue: 0, regOnTime: 0,
    };
    return kpisFor(counts ?? empty, prevC, settings, workingDays, tgt.targetCount, callIncomplete, "expert");
  };

  const selfCells = kpisOf(selfId).filter(computable);
  const teamCells = teammates.map((t) => ({ sp: t.salespersonId, cells: kpisOf(t.salespersonId) }));

  const items: MpKpiItem[] = selfCells.map((cell) => {
    const values: { sp: number; v: number }[] = [];
    for (const row of teamCells) {
      const oc = row.cells.find((c) => c.key === cell.key);
      if (oc && oc.status === "ok" && oc.value != null && Number.isFinite(oc.value)) values.push({ sp: row.sp, v: oc.value });
    }
    const avg = values.length ? mean(values.map((x) => x.v)) : null;
    const lower = cell.direction === "lower_better";
    const ordered = values.map((x) => (lower ? -x.v : x.v));
    const ranks = values.length ? competitionRank(ordered) : [];
    const ix = values.findIndex((x) => x.sp === selfId);
    const rank = cell.value != null && ix >= 0 ? ranks[ix] ?? null : (values.length ? null : null);
    return {
      key: cell.key,
      group: cell.group,
      label: cell.label,
      formula: cell.formula,
      value: cell.value,
      display: displayOf(cell),
      unit: cell.unit,
      incomplete: Boolean(cell.incomplete),
      teamAvg: avg,
      teamAvgDisplay: avgDisplay(cell, avg),
      rank,
      of: teamOf,
    };
  });

  const groups = {
    sales: items.filter((i) => i.group === "sales"),
    discipline: items.filter((i) => i.group === "discipline"),
    growth: items.filter((i) => i.group === "growth"),
  };

  const curCounts = countsForWindow(db, win.current, excludeTest);
  const prevCounts = countsForWindow(db, win.previous, excludeTest);
  const people: ScoredExpert[] = experts.map((e) => ({
    ...e,
    counts: curCounts.bySp.get(e.salespersonId) ?? emptyCounts(),
    prev: prevCounts.bySp.get(e.salespersonId) ?? emptyCounts(),
    score: null, rank: null, roleN: null, points: {}, rawSum: 0,
  }));
  scoreRoleGroup(people);
  const selfP = people.find((p) => p.salespersonId === selfId)!;
  const teamPeople = people.filter((p) => p.teamId != null && p.teamId === selfMeta.teamId && !p.trainee);
  const teamScores = teamPeople.map((p) => p.score ?? -1);
  const teamRanks = competitionRank(teamScores);
  const selfIx = teamPeople.findIndex((p) => p.salespersonId === selfId);
  const teamRank = selfP.trainee || selfIx < 0 ? null : teamRanks[selfIx] ?? null;
  const scored = teamPeople.filter((p) => p.score != null).map((p) => p.score as number);

  return {
    period: win.period,
    periodKey,
    label: win.label,
    previousLabel: win.previousLabel,
    from: isoDay(win.current.startDay),
    to: isoDay(win.current.endDay),
    workingDays,
    incomplete: callIncomplete,
    score: {
      value: selfP.trainee ? null : (selfP.score ?? null),
      teamAvg: scored.length ? Math.round(mean(scored) * 10) / 10 : null,
      rank: teamRank,
      of: teamPeople.length,
      role: selfP.role,
      roleLabel: selfP.role ? ROLE_LABEL[selfP.role] : null,
      formula: scoreFormula(selfP.role),
    },
    groups,
  };
}

/* ---------------- calls ---------------- */

export type CallDir = "incoming" | "outgoing" | null;
export type CallResultFilter = "all" | "missed" | "ok" | "later";
export type MpCallRow = {
  id: string;
  at: number;
  atLabel: string;
  customerId: number | null;
  customerName: string | null;
  phone: string;
  direction: CallDir;
  result: "missed" | "ok" | "later" | "unknown";
  resultLabel: string;
  durationSec: number | null;
  waitingCallback: boolean;
  recordingReady: boolean;
  transcriptReady: boolean;
  hasVoip: boolean;
};
export type MpCallTotals = {
  calls: number; answered: number; noAnswer: number; durationSec: number;
  unique: number; avgDuration: number | null; outbound: number; inbound: number;
};
export type MpCallReport = {
  period: PeriodKind;
  label: string;
  from: string;
  to: string;
  totals: MpCallTotals;
  teamAvg: MpCallTotals;
  waitingCount: number;
  page: number;
  pageSize: number;
  totalRows: number;
  hasVoip: boolean;
  rows: MpCallRow[];
};

type RawCall = {
  id: string;
  sp: number;
  at: number;
  customerId: number | null;
  customerName: string | null;
  phone: string;
  direction: CallDir;
  outcome: "yes" | "no" | "unknown";
  later: boolean;
  duration: number | null;
  recordingReady: boolean;
  transcriptReady: boolean;
  companyNoAnswer: boolean;
};

function faClock(at: number): string {
  const d = new Date(at + OFFSET);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`.replace(/\d/g, (x) => "۰۱۲۳۴۵۶۷۸۹"[Number(x)]!);
}

function resultOf(r: RawCall): MpCallRow["result"] {
  if (r.later) return "later";
  if (r.outcome === "yes") return "ok";
  if (r.outcome === "no") return "missed";
  return "unknown";
}

const RESULT_LABEL: Record<MpCallRow["result"], string> = {
  missed: "پاسخ نداد",
  ok: "موفق",
  later: "بازگشت",
  unknown: "نامشخص",
};

function expertHasVoip(db: DatabaseSync, userId: number | null | undefined): boolean {
  if (!userId || !has(db, "voip_extensions")) return false;
  try {
    const r = db.prepare("SELECT extension FROM voip_extensions WHERE user_id=?").get(userId) as { extension?: string } | undefined;
    return Boolean(r?.extension);
  } catch { return false; }
}

function loadCallRows(db: DatabaseSync, fromIso: string, toIso: string, excludeTest: boolean): RawCall[] {
  const facts = performanceCallRows(db, fromIso, toIso, excludeTest);
  // Enrich with customer id/name and later/follow_up + recording/transcript when tables exist.
  const out: RawCall[] = [];
  const nameById = new Map<number, string>();
  const phoneById = new Map<number, string>();
  if (has(db, "customers")) {
    const rows = db.prepare("SELECT id, name, phone, first_name, last_name FROM customers").all() as Array<{
      id: number; name: string | null; phone: string | null; first_name?: string | null; last_name?: string | null;
    }>;
    for (const r of rows) {
      const nm = (r.name && r.name.trim()) || [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null;
      if (nm) nameById.set(Number(r.id), nm);
      if (r.phone) phoneById.set(Number(r.id), String(r.phone));
    }
  }

  const laterLogs = new Set<string>(); // `${sp}:${customerId}:${at}` or phone
  const followCol = has(db, "call_logs") && cols(db, "call_logs").has("follow_up_at");
  const outcomeCol = has(db, "call_logs") && cols(db, "call_logs").has("outcome");
  if (has(db, "call_logs") && (followCol || outcomeCol)) {
    const nt = excludeTest ? `AND ${notTestCustomerIdSql("customer_id")}` : "";
    const conds = [
      followCol ? "follow_up_at IS NOT NULL" : null,
      outcomeCol ? "outcome='follow_up'" : null,
    ].filter(Boolean).join(" OR ");
    const rows = db.prepare(`SELECT salesperson_id sp, customer_id cid, created_at at FROM call_logs
      WHERE (${conds}) AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?) ${nt}`).all(fromIso, toIso) as Array<{ sp: number; cid: number | null; at: string }>;
    for (const r of rows) laterLogs.add(`${Number(r.sp)}:${r.cid ?? ""}:${Date.parse(r.at) || r.at}`);
  }

  const recReady = new Set<string>();
  const trReady = new Set<string>();
  if (has(db, "voip_after_call_events")) {
    const evCols = cols(db, "voip_after_call_events");
    const recCol = evCols.has("recording_provider_id") ? "recording_provider_id" : evCols.has("external_id") ? "external_id" : null;
    if (recCol) {
      try {
        const rows = db.prepare(`SELECT ${recCol} rid, started_at at, salesperson_id sp FROM voip_after_call_events
          WHERE ${recCol} IS NOT NULL AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?)`).all(fromIso, toIso) as Array<{ rid: string; at: string; sp: number }>;
        for (const r of rows) if (r.rid) recReady.add(`${Number(r.sp)}:${Date.parse(r.at)}`);
      } catch { /* ignore */ }
    }
  }
  if (has(db, "voip_recording_transcripts")) {
    try {
      const rows = db.prepare("SELECT external_id FROM voip_recording_transcripts WHERE state='completed'").all() as Array<{ external_id: string }>;
      for (const r of rows) if (r.external_id) trReady.add(String(r.external_id));
    } catch { /* ignore */ }
  }

  // Map facts; customer id from phone when possible.
  const phoneToCid = new Map<string, number>();
  if (has(db, "customers")) {
    const rows = db.prepare("SELECT id, phone FROM customers WHERE phone IS NOT NULL").all() as Array<{ id: number; phone: string }>;
    for (const r of rows) phoneToCid.set(String(r.phone).replace(/\s+/g, ""), Number(r.id));
  }

  let i = 0;
  for (const f of facts) {
    if (f.companyNoAnswer) continue;
    const digits = String(f.phone || "").replace(/\D/g, "");
    let cid: number | null = phoneToCid.get(String(f.phone).replace(/\s+/g, "")) ?? null;
    if (cid == null && digits) {
      for (const [ph, id] of phoneToCid) {
        if (ph.replace(/\D/g, "") === digits || ph.endsWith(digits) || digits.endsWith(ph.replace(/\D/g, ""))) { cid = id; break; }
      }
    }
    const later = cid != null && [...laterLogs].some((k) => k.startsWith(`${f.sp}:${cid}:`));
    out.push({
      id: `${f.sp}-${f.at}-${i++}`,
      sp: f.sp,
      at: f.at,
      customerId: cid,
      customerName: cid != null ? (nameById.get(cid) ?? null) : null,
      phone: f.phone,
      direction: f.direction,
      outcome: f.outcome,
      later,
      duration: f.duration,
      recordingReady: recReady.has(`${f.sp}:${f.at}`),
      transcriptReady: false,
      companyNoAnswer: false,
    });
  }
  return out;
}

function waitingSet(allForExpert: RawCall[], allUntilNow: RawCall[]): Set<string> {
  const waiting = new Set<string>();
  const laterByKey = (cid: number | null, phone: string, after: number) =>
    allUntilNow.some((r) => r.at > after && (
      (cid != null && r.customerId === cid) || (!!phone && r.phone === phone)
    ) && (
      (r.direction === "outgoing" && (r.outcome === "yes" || (r.duration != null && r.duration > 0)))
      || r.later
    ));
  for (const r of allForExpert) {
    if (r.direction !== "incoming" || r.outcome !== "no") continue;
    if (laterByKey(r.customerId, r.phone, r.at)) continue;
    waiting.add(r.id);
  }
  return waiting;
}

function totalsOf(rows: RawCall[]): MpCallTotals {
  let calls = 0, answered = 0, noAnswer = 0, durationSec = 0, outbound = 0, inbound = 0;
  const unique = new Set<string>();
  for (const r of rows) {
    calls++;
    if (r.outcome === "yes") answered++;
    else if (r.outcome === "no") noAnswer++;
    if (r.duration) durationSec += r.duration;
    if (r.direction === "outgoing") outbound++;
    else if (r.direction === "incoming") inbound++;
    if (r.phone) unique.add(r.phone);
  }
  return {
    calls, answered, noAnswer, durationSec, unique: unique.size,
    avgDuration: calls && durationSec ? durationSec / (answered || calls) : (durationSec && calls ? durationSec / calls : null),
    outbound, inbound,
  };
}

function avgTotals(list: MpCallTotals[]): MpCallTotals {
  const n = list.length || 1;
  const sum = (k: keyof MpCallTotals) => list.reduce((a, b) => a + (typeof b[k] === "number" && b[k] != null ? Number(b[k]) : 0), 0) / (list.length || 1);
  const durationSec = sum("durationSec");
  const calls = sum("calls");
  return {
    calls, answered: sum("answered"), noAnswer: sum("noAnswer"), durationSec,
    unique: sum("unique"), avgDuration: calls ? durationSec / n : null,
    outbound: sum("outbound"), inbound: sum("inbound"),
  };
}

export function myWorkCallReport(
  db: DatabaseSync,
  actor: AuthUser,
  query: {
    period?: string; from?: string; to?: string; anchor?: string;
    direction?: string; result?: string; q?: string; waiting?: string;
    page?: string | number;
  },
  now = new Date(),
): MpCallReport {
  requireV12(db);
  const { selfId } = requireSelf(db, actor);
  ensureSalesPerformanceSchema(db);
  seedMembershipHistoryIfEmpty(db, now);
  const win = performanceWindow(query, now);
  const excludeTest = excludeTestOn(db);
  const experts = listExperts(db);
  const selfMeta = experts.find((e) => e.salespersonId === selfId);
  if (!selfMeta) forbidden();

  const windowRows = loadCallRows(db, win.current.fromIso, win.current.toIso, excludeTest);
  // Until now, for waiting-callback close-out (may extend past the window end, up to now).
  const untilNowIso = now.toISOString();
  const untilNow = now.getTime() > Date.parse(win.current.toIso)
    ? loadCallRows(db, win.current.fromIso, untilNowIso, excludeTest)
    : windowRows;

  const mine = windowRows.filter((r) => r.sp === selfId);
  const mineUntil = untilNow.filter((r) => r.sp === selfId);
  const waiting = waitingSet(mine, mineUntil);

  const teammates = experts.filter((e) => e.teamId != null && e.teamId === selfMeta.teamId && !e.trainee);
  const teamTotals = teammates.map((t) => totalsOf(windowRows.filter((r) => r.sp === t.salespersonId)));

  const dir = query.direction === "incoming" || query.direction === "outgoing" ? query.direction : "all";
  const result = (["missed", "ok", "later"].includes(String(query.result)) ? query.result : "all") as CallResultFilter;
  const onlyWaiting = query.waiting === "1" || query.waiting === "true";
  const q = (query.q || "").trim();

  let rows = mine.slice();
  if (dir !== "all") rows = rows.filter((r) => r.direction === dir);
  if (result !== "all") rows = rows.filter((r) => resultOf(r) === result);
  if (onlyWaiting) rows = rows.filter((r) => waiting.has(r.id));
  if (q) {
    const needle = q.replace(/\s+/g, "").toLowerCase();
    const faNeedle = q;
    rows = rows.filter((r) => {
      const name = (r.customerName || "").toLowerCase();
      const phone = (r.phone || "").replace(/\s+/g, "");
      const id = r.customerId != null ? String(r.customerId) : "";
      return name.includes(faNeedle) || phone.includes(needle) || id.includes(needle) || `#${id}` === q;
    });
  }
  rows.sort((a, b) => b.at - a.at);
  const page = Math.max(1, Number(query.page) || 1);
  const totalRows = rows.length;
  const slice = rows.slice((page - 1) * PAGE, page * PAGE);
  const hasVoip = expertHasVoip(db, actor.id);

  return {
    period: win.period,
    label: win.label,
    from: isoDay(win.current.startDay),
    to: isoDay(win.current.endDay),
    totals: totalsOf(mine),
    teamAvg: avgTotals(teamTotals),
    waitingCount: mine.filter((r) => waiting.has(r.id)).length,
    page,
    pageSize: PAGE,
    totalRows,
    hasVoip,
    rows: slice.map((r) => {
      const res = resultOf(r);
      return {
        id: r.id,
        at: r.at,
        atLabel: faClock(r.at),
        customerId: r.customerId,
        customerName: r.customerName,
        phone: r.phone,
        direction: r.direction,
        result: res,
        resultLabel: RESULT_LABEL[res],
        durationSec: r.duration,
        waitingCallback: waiting.has(r.id),
        recordingReady: r.recordingReady,
        transcriptReady: r.transcriptReady,
        hasVoip,
      };
    }),
  };
}

export function myWorkSummary(db: DatabaseSync, actor: AuthUser, query: { period?: string; from?: string; to?: string; anchor?: string }, now = new Date()): MpReport {
  if (!mpV12FlagOnDb(db) && !mpFlagOnDb(db)) notFound();
  // Reuse v1.1 summary; temporarily treat v12 as enough to pass the v1 gate by
  // calling the same builder only when v1 is on, otherwise compute via a local allow.
  if (mpFlagOnDb(db)) return myWorkReport(db, actor, query, now);
  // v12 on, v1 off: reuse the same function after a one-row read trick is not possible
  // without writing the flag. Duplicate the call by invoking myWorkReport is blocked.
  // We'll open the same logic by setting a short-circuit in myWorkReport (v1 || v12).
  return myWorkReport(db, actor, query, now);
}

/** Assert an expert-facing payload never names colleagues or returns their scores. */
export function payloadHasColleagueLeak(json: unknown, selfName: string | null, colleagueNames: string[]): string | null {
  const text = JSON.stringify(json);
  for (const n of colleagueNames) {
    if (!n || (selfName && n === selfName)) continue;
    if (text.includes(n)) return n;
  }
  if (/"experts"\s*:/.test(text) && /"name"\s*:\s*"/.test(text)) {
    // a bare experts list with names is a leak unless it is only self
    const m = text.match(/"experts"\s*:\s*\[(.*?)\]/s);
    if (m && colleagueNames.some((n) => m[1]!.includes(n))) return "experts";
  }
  return null;
}

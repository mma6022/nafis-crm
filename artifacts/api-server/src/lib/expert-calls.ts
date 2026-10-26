/**
 * ONE definition of «تماس‌های کارشناس» shared by the assistants' /my-context «امروز» counter and the manager reports (v8).
 *
 * A call belongs to the expert who LOGGED it (call_logs.salesperson_id — the «ثبت‌کننده»), not to the customer's owner,
 * so calls an expert makes on a colleague's customer count for the caller. Counted:
 *   - every call_logs row of that expert except non-call timeline rows (lib/real-call.ts: «ارتقا به اولویت ۱ توسط …» hand-off
 *     notes and the manager's «اطلاعات تماس اول درست بود/نبود» review rows);
 *   - plus phone-system calls (voip_after_call_events) of that expert that were never linked to a call log;
 *   - live (still ringing / in progress) phone-system calls are excluded.
 * Time = the phone-system start time when linked, else call_logs.created_at; days are Tehran days (fixed UTC+03:30).
 * Answered / not answered = lib/sales-report.ts callOutcome, then the first-call form result (team_sales_qualifications).
 */
import type { DatabaseSync } from "node:sqlite";
import { callOutcome } from "./sales-report";
import { realCallSql } from "./real-call";
import { notTestCustomerIdSql } from "./test-customers";

export const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
export function tehranDayStartMs(t: number): number { const w = new Date(t + TEHRAN_OFFSET_MS); w.setUTCHours(0, 0, 0, 0); return w.getTime() - TEHRAN_OFFSET_MS; }

export type ExpertCall = { at: number; outcome: "yes" | "no" | "unknown"; callLogId: number | null };
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const parseAt = (v: unknown) => { const s = String(v ?? ""); return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "Z" : s); };

/** Task D (2026-10-26), REPORTS ONLY: call_logs rows whose «ثبت‌کننده» name snapshot is one of these names count for this
 *  salesperson even when salesperson_id differs. «محدثه ابوالقاسمی» was Ms. Ghasemi's (salesperson 4) old display name.
 *  The /my-context «امروز» counter does not pass reportAliases, so it is unchanged. */
export const REPORT_CALL_ALIASES: Record<number, string[]> = { 4: ["محدثه ابوالقاسمی"] };
/** PM decision 2026-10-26, REPORTS ONLY: calls logged by the shared «مهمون» account, or with no expert at all (call_logs.salesperson_id
 *  NULL / unlinked phone-system call with no salesperson), count for the customer's CURRENT owner. No data or ownership is changed. */
export const REPORT_GUEST_NAMES = ["مهمون", "مهمان"];
/** SQL: the salesperson a call counts for in reports (aliases → their salesperson; guest / no expert → the customer's owner `gc`). */
function reportSpSql(db: DatabaseSync): { log: string; logParams: (string | number)[]; voip: string } {
  const snap = db.prepare("SELECT 1 FROM pragma_table_info('call_logs') WHERE name='salesperson_name_snapshot'").get() != null;
  const nm = snap ? "trim(COALESCE(l.salesperson_name_snapshot,''))" : "''";
  const al = Object.entries(REPORT_CALL_ALIASES).flatMap(([sp, names]) => names.map(n => [n, Number(sp)] as [string, number]));
  const g = REPORT_GUEST_NAMES.map(n => `'${n}'`).join(",");
  const voipName = db.prepare("SELECT 1 FROM pragma_table_info('voip_after_call_events') WHERE name='expert_name'").get() != null;
  return {
    log: `(CASE ${snap ? al.map(() => `WHEN ${nm}=? THEN ?`).join(" ") : ""} WHEN l.salesperson_id IS NULL OR ${nm} IN (${g}) THEN gc.salesperson_id ELSE l.salesperson_id END)`,
    logParams: snap ? al.flat() : [],
    voip: `(CASE WHEN e.salesperson_id IS NULL${voipName ? ` OR trim(COALESCE(e.expert_name,'')) IN (${g})` : ""} THEN gc.salesperson_id ELSE e.salesperson_id END)`,
  };
}
/** opts.excludeTest (v10): leave out calls on test customers (lib/test-customers.ts) — reporting only.
 *  opts.reportAliases (Task D + 2026-10-26): count by the report attribution (reportSpSql): «محدثه ابوالقاسمی» → Ms. Ghasemi,
 *  «مهمون» / no expert → the customer's current owner. Without it (the /my-context «امروز» counter) only call_logs.salesperson_id counts. */
export function expertCalls(db: DatabaseSync, sp: number, fromIso: string, toIso: string, opts: { excludeTest?: boolean; reportAliases?: boolean } = {}): ExpertCall[] {
  const voip = has(db, "voip_after_call_events"); const q = has(db, "team_sales_qualifications");
  const vcid = voip && (db.prepare("SELECT 1 FROM pragma_table_info('voip_after_call_events') WHERE name='customer_id'").get() != null);
  const tl = opts.excludeTest ? `AND ${notTestCustomerIdSql("l.customer_id")}` : "";
  const tv = opts.excludeTest && vcid ? `AND ${notTestCustomerIdSql("e.customer_id")}` : "";
  const at = voip ? "COALESCE(e.started_at,l.created_at)" : "l.created_at";
  const rep = opts.reportAliases ? reportSpSql(db) : null;
  const who = rep ? `${rep.log}=?` : "l.salesperson_id=?";
  const vwho = rep && vcid ? `${rep.voip}=?` : "e.salesperson_id=?";
  const sql = `SELECT l.id lid, ${at} at, ${voip ? "e.status, e.mobile_answered_at" : "NULL status, NULL mobile_answered_at"},
      ${q ? "(SELECT call_result FROM team_sales_qualifications tq WHERE tq.call_log_id=l.id ORDER BY tq.id DESC LIMIT 1)" : "NULL"} qres
    FROM call_logs l ${voip ? "LEFT JOIN voip_after_call_events e ON e.call_log_id=l.id" : ""} ${rep ? "LEFT JOIN customers gc ON gc.id=l.customer_id" : ""}
    WHERE ${who} AND ${realCallSql("l.subject")} ${voip ? "AND COALESCE(e.is_live,0)=0" : ""} ${tl}
      AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)
    ${voip ? `UNION ALL SELECT NULL lid, e.started_at at, e.status, e.mobile_answered_at, NULL qres FROM voip_after_call_events e ${rep && vcid ? "LEFT JOIN customers gc ON gc.id=e.customer_id" : ""}
      WHERE e.call_log_id IS NULL AND e.is_live=0 AND ${vwho} ${tv} AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)` : ""}`;
  const p: any[] = [...(rep ? rep.logParams : []), sp, fromIso, toIso]; if (voip) p.push(sp, fromIso, toIso);
  return (db.prepare(sql).all(...p) as any[]).map(r => {
    let o = callOutcome(r.status, r.mobile_answered_at);
    if (o === "unknown" && r.qres) o = r.qres === "answered" ? "yes" : r.qres === "no_answer" ? "no" : "unknown";
    return { at: parseAt(r.at), outcome: o, callLogId: r.lid == null ? null : Number(r.lid) };
  });
}
export type TeamCallRow = { sp: number; customerId: number | null; at: number; callLogId: number | null };
/** Every real call in [from, to) with the salesperson it counts for in reports (same attribution as expertCalls(…, {reportAliases})).
 *  Rows whose attribution is unknown (no expert and no owner) are dropped. Counts only — no outcome, duration or phone. */
export function teamCallRows(db: DatabaseSync, fromIso: string, toIso: string, opts: { excludeTest?: boolean } = {}): TeamCallRow[] {
  const voip = has(db, "voip_after_call_events");
  const vcid = voip && (db.prepare("SELECT 1 FROM pragma_table_info('voip_after_call_events') WHERE name='customer_id'").get() != null);
  const tl = opts.excludeTest ? `AND ${notTestCustomerIdSql("l.customer_id")}` : "";
  const tv = opts.excludeTest && vcid ? `AND ${notTestCustomerIdSql("e.customer_id")}` : "";
  const at = voip ? "COALESCE(e.started_at,l.created_at)" : "l.created_at";
  const rep = reportSpSql(db);
  const sql = `SELECT ${rep.log} sp, l.customer_id cid, l.id lid, ${at} at
    FROM call_logs l ${voip ? "LEFT JOIN voip_after_call_events e ON e.call_log_id=l.id" : ""} LEFT JOIN customers gc ON gc.id=l.customer_id
    WHERE ${realCallSql("l.subject")} ${voip ? "AND COALESCE(e.is_live,0)=0" : ""} ${tl} AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)
    ${voip ? `UNION ALL SELECT ${vcid ? rep.voip : "e.salesperson_id"} sp, ${vcid ? "e.customer_id" : "NULL"} cid, NULL lid, e.started_at at FROM voip_after_call_events e ${vcid ? "LEFT JOIN customers gc ON gc.id=e.customer_id" : ""}
      WHERE e.call_log_id IS NULL AND e.is_live=0 ${tv} AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)` : ""}`;
  const p: any[] = [...rep.logParams, fromIso, toIso]; if (voip) p.push(fromIso, toIso);
  return (db.prepare(sql).all(...p) as any[]).filter(r => r.sp != null).map(r => ({ sp: Number(r.sp), customerId: r.cid == null ? null : Number(r.cid), at: parseAt(r.at), callLogId: r.lid == null ? null : Number(r.lid) }));
}
export function expertCallStats(list: ExpertCall[]) {
  const answered = list.filter(c => c.outcome === "yes").length, notAnswered = list.filter(c => c.outcome === "no").length;
  const known = answered + notAnswered;
  return { count: list.length, answered, notAnswered, unknown: list.length - known, answeredShare: known ? Math.round((answered / known) * 1000) / 1000 : null };
}
/** Today (Tehran) so far for one expert. */
export function expertCallsToday(db: DatabaseSync, sp: number, now: Date, opts: { excludeTest?: boolean } = {}) {
  return expertCallStats(expertCalls(db, sp, new Date(tehranDayStartMs(now.getTime())).toISOString(), new Date(now.getTime() + 1).toISOString(), opts));
}
export const EXPERT_CALLS_DEFINITION = "call_logs by the expert who logged it (not the customer owner) + unlinked phone-system calls; P1 hand-off and accuracy-review rows and live calls excluded; Tehran day";

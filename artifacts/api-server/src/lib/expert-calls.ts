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

export const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
export function tehranDayStartMs(t: number): number { const w = new Date(t + TEHRAN_OFFSET_MS); w.setUTCHours(0, 0, 0, 0); return w.getTime() - TEHRAN_OFFSET_MS; }

export type ExpertCall = { at: number; outcome: "yes" | "no" | "unknown"; callLogId: number | null };
const has = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
const parseAt = (v: unknown) => { const s = String(v ?? ""); return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s) ? s.replace(" ", "T") + "Z" : s); };

export function expertCalls(db: DatabaseSync, sp: number, fromIso: string, toIso: string): ExpertCall[] {
  const voip = has(db, "voip_after_call_events"); const q = has(db, "team_sales_qualifications");
  const at = voip ? "COALESCE(e.started_at,l.created_at)" : "l.created_at";
  const sql = `SELECT l.id lid, ${at} at, ${voip ? "e.status, e.mobile_answered_at" : "NULL status, NULL mobile_answered_at"},
      ${q ? "(SELECT call_result FROM team_sales_qualifications tq WHERE tq.call_log_id=l.id ORDER BY tq.id DESC LIMIT 1)" : "NULL"} qres
    FROM call_logs l ${voip ? "LEFT JOIN voip_after_call_events e ON e.call_log_id=l.id" : ""}
    WHERE l.salesperson_id=? AND ${realCallSql("l.subject")} ${voip ? "AND COALESCE(e.is_live,0)=0" : ""}
      AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)
    ${voip ? `UNION ALL SELECT NULL lid, e.started_at at, e.status, e.mobile_answered_at, NULL qres FROM voip_after_call_events e
      WHERE e.call_log_id IS NULL AND e.is_live=0 AND e.salesperson_id=? AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)` : ""}`;
  const p: any[] = [sp, fromIso, toIso]; if (voip) p.push(sp, fromIso, toIso);
  return (db.prepare(sql).all(...p) as any[]).map(r => {
    let o = callOutcome(r.status, r.mobile_answered_at);
    if (o === "unknown" && r.qres) o = r.qres === "answered" ? "yes" : r.qres === "no_answer" ? "no" : "unknown";
    return { at: parseAt(r.at), outcome: o, callLogId: r.lid == null ? null : Number(r.lid) };
  });
}
export function expertCallStats(list: ExpertCall[]) {
  const answered = list.filter(c => c.outcome === "yes").length, notAnswered = list.filter(c => c.outcome === "no").length;
  const known = answered + notAnswered;
  return { count: list.length, answered, notAnswered, unknown: list.length - known, answeredShare: known ? Math.round((answered / known) * 1000) / 1000 : null };
}
/** Today (Tehran) so far for one expert. */
export function expertCallsToday(db: DatabaseSync, sp: number, now: Date) {
  return expertCallStats(expertCalls(db, sp, new Date(tehranDayStartMs(now.getTime())).toISOString(), new Date(now.getTime() + 1).toISOString()));
}
export const EXPERT_CALLS_DEFINITION = "call_logs by the expert who logged it (not the customer owner) + unlinked phone-system calls; P1 hand-off and accuracy-review rows and live calls excluded; Tehran day";

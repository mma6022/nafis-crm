/**
 * SIMOTEL-132 — Armita simotel v1.3.2 (Mohammad t770s3064). Behind flag.simotel132 (global) or flag.simotel132.user.<id> = '1',
 * on top of flag.voip_call + own extension (vcOn). OFF by default.
 *  - Flag off → nothing here runs: no table is created (s132_calls only appears when a flagged expert starts a VoIP click call),
 *    every hook returns at once, /voip-call payloads carry no new key, the new endpoints answer 404.
 *  - Only the first call with a customer (qualifier's own in-progress customer, no priority, no answered call yet) opens the first-call
 *    form; step 1 comes from Simotel. Every other VoIP click call is saved by itself from the Simotel CDR (customer leg, R2):
 *      «بالفعل» file task → fcExpertFollowup (note optional, auto); «بالقوه» daily-plan task → dpAfterFirstCallForm-style close.
 *    The note is filled from the call's own summary (voip_recording_summaries) and stays editable; the R3 no-answer SMS is only shown.
 *  - No CDR within S132_WAIT_S after hang-up → the expert picks one of four statuses (status only). A later CDR keeps the expert's pick and
 *    only updates that same call (event status, call-log title, sim_status): no second event or call log (c2).
 *  - «اشتباهه؟»: status-only fix of an own auto-saved call (same Tehran day); both statuses are kept (s132_calls + s132_fixes).
 *  - Any failure in the automatic save → that call falls back to the existing manual result flow (auto_kind 'manual').
 */
import { crmDb, executeChanges, queryRow, queryRows, runImmediateTransaction, type SqlValue } from "./crm-db";
import { vcOn, vcTableExists, vcView, vcFastOn, type VcRow } from "./voip-call";
import { getTeamSalesConfig } from "./team-sales";
import { getAuthUserById } from "./auth";
import { fcExpertFollowup } from "./files-carousel";
import { dpAfterFirstCallForm } from "./daily-plan";
import { storedCallSummary } from "./recording-summary-jobs";
import { vnaSent } from "./voip-noanswer-sms";
import { resolveEvent, experts, customerMatcher, normalizePhone } from "./voip-after-call";

export const S132_WAIT_S = 120; // R2 decides 60 s after the last leg ends (+ the 20 s poll); then the design's 60 s
/** SIMOTEL-FAST (flag.simotel_fast[.user.<id>]): the result normally lands 5–8 s after hang-up, so the no-CDR wait is 30 s (Armita 1.3.4); OFF → 120 s. */
export const S132_FAST_WAIT_S = 30;
export function s132WaitS(userId: number | null | undefined): number { return vcFastOn(userId) ? S132_FAST_WAIT_S : S132_WAIT_S; }
export const S132_STATUSES = ["answered", "no_answer", "busy", "failed"] as const;
export type S132Status = typeof S132_STATUSES[number];
const NOTE_MAX = 500, NOTE_GIVE_UP_MIN = 45, NO_LOG_GIVE_UP_MIN = 10, BAR_KEEP_MIN = 30;
type U = { id: number; role?: string; salespersonId?: number | null };
export type S132Row = { call_id: number; user_id: number; customer_id: number; file_id: number | null; first_call: number; sim_status: string | null;
  expert_status: string | null; status_source: string | null; auto_at: string | null; auto_kind: string | null; auto_error: string | null; fu_id: number | null;
  call_log_id: number | null; note_state: string | null; note: string | null; note_edited_at: string | null; fixed_status: string | null; fixed_at: string | null;
  bar_closed_at: string | null; created_at: string };

const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
const iso = (d: Date) => d.toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const tehranDay = (d: Date) => new Date(d.getTime() + 3.5 * 3600000).toISOString().slice(0, 10);

export function s132FlagOn(userId: number | null | undefined): boolean {
  if (userId == null) return false;
  return setting("flag.simotel132") === "1" || setting(`flag.simotel132.user.${Number(userId)}`) === "1";
}
export function s132On(u: { id: number } | null | undefined): boolean { return !!u && s132FlagOn(u.id) && vcOn(u); }
export function s132TableExists(): boolean {
  return !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='s132_calls'");
}
export function ensureS132Schema() {
  crmDb.exec(`CREATE TABLE IF NOT EXISTS s132_calls(call_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, file_id INTEGER,
    first_call INTEGER NOT NULL DEFAULT 0, sim_status TEXT, expert_status TEXT, status_source TEXT, auto_at TEXT, auto_kind TEXT, auto_error TEXT,
    fu_id INTEGER, call_log_id INTEGER, note_state TEXT, note TEXT, note_edited_at TEXT, fixed_status TEXT, fixed_at TEXT, bar_closed_at TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_s132_user ON s132_calls(user_id, call_id);
  CREATE TABLE IF NOT EXISTS s132_fixes(id INTEGER PRIMARY KEY, call_id INTEGER NOT NULL, user_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TEXT NOT NULL);`);
}

/** Simotel customer-leg status (R2 cust_status) → the four design statuses. */
export function s132SimStatus(custStatus: string | null | undefined, outcome: string | null | undefined): S132Status {
  const s = String(custStatus ?? "").toUpperCase();
  if (s === "ANSWERED") return "answered";
  if (s === "BUSY") return "busy";
  if (s === "NO ANSWER" || s === "CANCEL") return "no_answer";
  if (s === "FAILED" || s === "CONGESTION" || s === "CHANUNAVAIL" || s === "NOT_DIALED") return "failed";
  return outcome === "answered" ? "answered" : outcome === "busy" ? "busy" : outcome === "no_answer" ? "no_answer" : "failed";
}
const EV_STATUS: Record<S132Status, string> = { answered: "ANSWERED", no_answer: "NO ANSWER", busy: "BUSY", failed: "FAILED" };
/** SIMOTEL-132 c (Armita on-03b): the expert picked a status but the call has no call log yet (no live NewState row, or its customer was not
 *  matched) → link the call's own live row, or add one the same way a NewState row is added (live-…, live_cuid = the call's cuid, so a later
 *  CDR is merged into it, never a second history row). Returns the call log id, or null. Only reached for a flagged expert's own pick. */
function ensureExpertLog(c: VcRow, status: S132Status, now: Date): number | null {
  let eventId = c.event_id;
  if (eventId == null && (c.cuid || c.leg_cuid)) {
    eventId = queryRow<{ id: number }>(`SELECT id FROM voip_after_call_events WHERE extension=? AND direction='outgoing' AND live_cuid IN (?,?)
      AND id NOT IN (SELECT event_id FROM voip_click_calls WHERE event_id IS NOT NULL) ORDER BY id LIMIT 1`, [c.extension, c.cuid ?? "", c.leg_cuid ?? ""])?.id ?? null;
  }
  if (eventId == null) {
    const started = c.me_answered_at ?? c.created_at; const ended = c.ended_at ?? iso(now);
    executeChanges(`INSERT OR IGNORE INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,has_recording,is_live,live_cuid,auto_capture,customer_id)
      VALUES(?,?,'outgoing',?,?,?,?,?,0,0,?,1,?)`, [`live-s132-${c.id}`, normalizePhone(c.phone) ?? c.phone, EV_STATUS[status], started, ended, c.extension, JSON.stringify([c.extension]), c.cuid ?? c.leg_cuid ?? null, c.customer_id]);
    eventId = queryRow<{ id: number }>("SELECT id FROM voip_after_call_events WHERE external_id=?", [`live-s132-${c.id}`])?.id ?? null;
  }
  if (eventId == null) return null;
  executeChanges("UPDATE voip_click_calls SET event_id=? WHERE id=? AND event_id IS NULL", [eventId, c.id]);
  executeChanges("UPDATE voip_after_call_events SET customer_id=? WHERE id=? AND customer_id IS NULL", [c.customer_id, eventId]);
  resolveEvent(eventId, experts(), customerMatcher());
  const e = queryRow<{ call_log_id: number | null; customer_id: number | null }>("SELECT call_log_id, customer_id FROM voip_after_call_events WHERE id=?", [eventId]);
  return e && Number(e.customer_id) === Number(c.customer_id) ? e.call_log_id : null;
}
const callResultOf = (s: S132Status) => s === "answered" ? "answered" : s === "busy" ? "off_or_busy" : "no_answer";

/** First call = the qualifier's own in-progress customer with no priority (the first-call form rule) and no answered call yet. */
export function s132IsFirstCall(u: U, customerId: number): boolean {
  let q: number | null = null;
  try { const cfg = getTeamSalesConfig() as any; q = cfg?.enabled ? Number(cfg.qualifierSalespersonId) : null; } catch { q = null; }
  if (q == null || Number(u.salespersonId) !== q) return false;
  const c = queryRow<{ salesperson_id: number | null; status: string | null; priority: number | null }>(
    "SELECT salesperson_id,status,priority FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c || Number(c.salesperson_id) !== q || (c.status ?? "in_progress") !== "in_progress" || c.priority != null) return false;
  return !queryRow(`SELECT 1 x FROM call_logs l WHERE l.customer_id=? AND (l.call_result='answered' OR (l.call_result IS NULL AND NOT EXISTS
      (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=l.id AND UPPER(COALESCE(e.status,''))<>'ANSWERED'))) LIMIT 1`, [customerId]);
}

/** vcStart hook (after the click call row exists). */
export function s132OnStart(u: U, callId: number, customerId: number, fileId: number | null, now = new Date()) {
  if (!s132On(u)) return;
  ensureS132Schema();
  executeChanges("INSERT OR IGNORE INTO s132_calls(call_id,user_id,customer_id,file_id,first_call,created_at) VALUES(?,?,?,?,?,?)",
    [callId, u.id, customerId, fileId, s132IsFirstCall(u, customerId) ? 1 : 0, iso(now)]);
}

function savepoint<T>(f: () => T): T {
  crmDb.exec("SAVEPOINT s132");
  try { const r = f(); crmDb.exec("RELEASE s132"); return r; }
  catch (e) { crmDb.exec("ROLLBACK TO s132"); crmDb.exec("RELEASE s132"); throw e; }
}
function completeEvent(eventId: number, userId: number, outcome: string, now: Date) {
  executeChanges(`UPDATE voip_after_call_events SET completed_at=?, completed_by_user_id=?, completed_payload=? WHERE id=? AND completed_at IS NULL`,
    [iso(now), userId, JSON.stringify({ expertNotes: "", source: "simotel132", outcome }), eventId]);
}
const markManual = (callId: number, code: string, now: Date) =>
  executeChanges("UPDATE s132_calls SET auto_at=?, auto_kind='manual', auto_error=? WHERE call_id=? AND auto_at IS NULL", [iso(now), code.slice(0, 60), callId]);

/** Save one ended call by itself once its status is known (CDR, else the expert's pick). Idempotent; never throws. */
function processOne(r: S132Row, c: VcRow, now: Date): void {
  if (r.auto_at || c.active) return;
  if (c.state !== "ended") { markManual(r.call_id, `state_${c.state}`, now); return; } // own phone not picked up / originate error → old notice
  if (c.result_saved_at) { executeChanges("UPDATE s132_calls SET auto_at=?, auto_kind='manual', auto_error='saved_by_hand' WHERE call_id=? AND auto_at IS NULL", [iso(now), r.call_id]); return; }
  const sim = c.cust_status != null ? s132SimStatus(c.cust_status, c.outcome) : null;
  if (sim && !r.sim_status) executeChanges("UPDATE s132_calls SET sim_status=? WHERE call_id=?", [sim, r.call_id]);
  const status = (r.expert_status as S132Status | null) ?? sim;
  if (!status) return;
  const source = r.expert_status ? "expert" : "simotel";
  if (r.first_call && status === "answered") {
    executeChanges("UPDATE s132_calls SET auto_at=?, auto_kind='first_form', status_source=? WHERE call_id=? AND auto_at IS NULL", [iso(now), source, r.call_id]);
    return;
  }
  const user = getAuthUserById(r.user_id) as any;
  if (!user || user.active === false) { markManual(r.call_id, "no_user", now); return; }
  const taskOutcome = status === "answered" ? "answered" : "no_answer";
  let logId = c.event_id != null ? queryRow<{ call_log_id: number | null }>("SELECT call_log_id FROM voip_after_call_events WHERE id=?", [c.event_id])?.call_log_id ?? null : null;
  let eventId = c.event_id;
  try {
    savepoint(() => {
      if (logId == null && c.file_id == null && r.expert_status) { // the expert's pick saves now (on-03b); never left «در انتظار نتیجه»
        logId = ensureExpertLog(c, status, now);
        eventId = queryRow<{ event_id: number | null }>("SELECT event_id FROM voip_click_calls WHERE id=?", [c.id])?.event_id ?? null;
      }
      let fu: number | null = null; let kind: string;
      if (c.file_id != null) {
        const res: any = fcExpertFollowup(user, { fileId: c.file_id, outcome: taskOutcome, note: "", voipCallId: c.id }, now, { auto: true });
        if (!res || res.ok !== true) throw Object.assign(new Error("fc"), { code: String(res?.body?.error ?? res?.error ?? "fc_failed") });
        fu = queryRow<{ id: number }>("SELECT id FROM fc_followups WHERE user_id=? AND file_id=? ORDER BY id DESC LIMIT 1", [r.user_id, c.file_id])?.id ?? null;
        kind = "fc";
      } else {
        if (logId == null) {
          if (now.getTime() - ms(c.cdr_at ?? c.ended_at) > NO_LOG_GIVE_UP_MIN * 60000 || (r.expert_status && now.getTime() - ms(c.ended_at) > NO_LOG_GIVE_UP_MIN * 60000))
            throw Object.assign(new Error("log"), { code: "no_call_log" });
          throw Object.assign(new Error("wait"), { code: "__wait" });
        }
        dpAfterFirstCallForm(user, c.customer_id, logId, taskOutcome, now);
        executeChanges("UPDATE voip_click_calls SET result_saved_at=COALESCE(result_saved_at,?), result_outcome=? WHERE id=?", [iso(now), taskOutcome, c.id]);
        if (eventId != null) completeEvent(eventId, r.user_id, taskOutcome, now);
        kind = "dp";
      }
      if (logId != null) executeChanges("UPDATE call_logs SET call_result=? WHERE id=? AND call_result IS NULL", [callResultOf(status), logId]);
      executeChanges(`UPDATE s132_calls SET auto_at=?, auto_kind=?, status_source=?, fu_id=?, call_log_id=?, note_state=? WHERE call_id=? AND auto_at IS NULL`,
        [iso(now), kind, source, fu, logId, status === "answered" ? "pending" : "none", r.call_id]);
    });
  } catch (e: any) {
    if (e?.code === "__wait") return;
    try { markManual(r.call_id, String(e?.code ?? "error"), now); } catch { /* keep the manual flow */ }
  }
}
function pendingRows(where: string, params: SqlValue[]) {
  return queryRows<S132Row>(`SELECT s.* FROM s132_calls s WHERE s.auto_at IS NULL AND ${where} ORDER BY s.call_id LIMIT 50`, params);
}
/** The first-call form was saved (its call log has a call result, made after the call) → the call leaves the panel and its after-call
 *  event is closed, even if the browser never sent «dismiss» (reload / closed tab): the next task's call button never stays locked. */
function firstFormDone(now: Date, userId: number | null) {
  const rows = queryRows<S132Row & { event_id: number | null }>(`SELECT s.*, k.event_id FROM s132_calls s JOIN voip_click_calls k ON k.id=s.call_id
     WHERE s.auto_kind='first_form' AND julianday(s.created_at)>=julianday(?)-1 ${userId == null ? "" : "AND s.user_id=?"}
       AND EXISTS (SELECT 1 FROM call_logs l WHERE l.customer_id=s.customer_id AND l.call_result IS NOT NULL AND julianday(l.created_at)>=julianday(s.auto_at))`,
    userId == null ? [iso(now)] : [iso(now), userId]);
  for (const r of rows) {
    try {
      savepoint(() => {
        executeChanges("UPDATE s132_calls SET auto_kind='first_done' WHERE call_id=? AND auto_kind='first_form'", [r.call_id]);
        executeChanges("UPDATE voip_click_calls SET result_saved_at=COALESCE(result_saved_at,?), result_outcome=COALESCE(result_outcome,'answered'), dismissed_at=COALESCE(dismissed_at,?) WHERE id=?",
          [iso(now), iso(now), r.call_id]);
        if (r.event_id != null) completeEvent(r.event_id, r.user_id, "answered", now);
      });
    } catch { /* retried on the next tick */ }
  }
}
/** Auto-save pass + summary notes. userId given → only that expert (GET /voip-call/me); else everyone (the CDR poller). */
export function s132Tick(now = new Date(), userId: number | null = null) {
  if (!vcTableExists() || !s132TableExists()) return;
  const rows = userId == null ? pendingRows("julianday(s.created_at)>=julianday(?)-1", [iso(now)]) : pendingRows("s.user_id=? AND julianday(s.created_at)>=julianday(?)-1", [userId, iso(now)]);
  for (const r of rows) {
    if (userId == null && !s132FlagOn(r.user_id)) continue; // flag turned off later → that expert's calls keep the manual flow
    const c = queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=?", [r.call_id]);
    if (c) processOne(r, c, now);
  }
  firstFormDone(now, userId);
  simAfterSave(now, userId);
  noteTick(now, userId);
}
/** CDR poller hook (voip-after-call.ts, right after vcIngestOriginate). Own savepoints; never throws. */
/** SIMOTEL-132 c2: a Simotel report that arrives AFTER the expert's pick updates that same call (the live-s132 event and its call log), never a
 *  second history row. Called by the CDR ingest for an incoming/outgoing CDR row and by the NewState webhook; null/false unless the row belongs to a
 *  flagged expert's click call whose event was added by the expert's pick (ensureExpertLog). Never throws. */
export function s132CdrTarget(cuid: string | null | undefined, direction: string, phone: string): number | null {
  try {
    const cu = String(cuid ?? "").replace(/\s+/g, "");
    if (!cu || !s132TableExists() || !vcTableExists()) return null;
    const e = queryRow<{ id: number; phone: string }>(`SELECT e.id, e.phone FROM voip_click_calls k JOIN s132_calls s ON s.call_id=k.id JOIN voip_after_call_events e ON e.id=k.event_id
      WHERE (k.cuid=? OR k.leg_cuid=?) AND e.direction=? ORDER BY k.id DESC LIMIT 1`, [cu, cu, direction]);
    return e && normalizePhone(e.phone) != null && normalizePhone(e.phone) === normalizePhone(phone) ? e.id : null;
  } catch { return null; }
}
/** SIMOTEL-132 d (c, report first): a CDR-only event just added for a flagged expert's click call that has no event yet gets the call's
 *  conversation id (live_cuid), so the originate settle step (vcIngestOriginate) adopts that same row instead of adding a second one. Never throws. */
export function s132TagCdr(cuid: string | null | undefined, direction: string, phone: string, externalId: string): void {
  try {
    const cu = String(cuid ?? "").replace(/\s+/g, "");
    if (!cu || direction !== "outgoing" || !s132TableExists() || !vcTableExists()) return;
    const k = queryRow<{ phone: string }>(`SELECT k.phone FROM voip_click_calls k JOIN s132_calls s ON s.call_id=k.id
      WHERE (k.cuid=? OR k.leg_cuid=?) AND k.event_id IS NULL ORDER BY k.id DESC LIMIT 1`, [cu, cu]);
    if (!k || normalizePhone(k.phone) == null || normalizePhone(k.phone) !== normalizePhone(phone)) return;
    executeChanges("UPDATE voip_after_call_events SET live_cuid=? WHERE external_id=? AND live_cuid IS NULL AND direction='outgoing'", [cu, externalId]);
  } catch { /* never blocks the ingest */ }
}
export function s132LiveEnded(cuid: string, extension: string): boolean {
  try {
    if (!cuid || !s132TableExists() || !vcTableExists()) return false;
    return !!queryRow(`SELECT 1 x FROM voip_click_calls k JOIN s132_calls s ON s.call_id=k.id JOIN voip_after_call_events e ON e.id=k.event_id
      WHERE (k.cuid=? OR k.leg_cuid=?) AND k.extension=? AND e.external_id LIKE 'live-s132-%' AND e.is_live=0`, [cuid, cuid, extension]);
  } catch { return false; }
}
/** A CDR that arrives after the save: keep Simotel's own status next to the expert's pick (the pick stays the call's result). */
function simAfterSave(now: Date, userId: number | null) {
  const rows = queryRows<{ call_id: number; cust_status: string; outcome: string | null }>(`SELECT s.call_id, k.cust_status, k.outcome FROM s132_calls s JOIN voip_click_calls k ON k.id=s.call_id
    WHERE s.sim_status IS NULL AND s.auto_at IS NOT NULL AND k.cust_status IS NOT NULL AND julianday(s.created_at)>=julianday(?)-1${userId == null ? "" : " AND s.user_id=?"}`,
    userId == null ? [iso(now)] : [iso(now), userId]);
  for (const x of rows) executeChanges("UPDATE s132_calls SET sim_status=? WHERE call_id=? AND sim_status IS NULL", [s132SimStatus(x.cust_status, x.outcome), x.call_id]);
}
export function s132AfterIngest(now = new Date()) {
  try { if (!s132TableExists()) return; runImmediateTransaction(() => s132Tick(now, null)); }
  catch { /* the manual flow stays */ }
}

const noteText = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
function applyNote(r: S132Row, note: string, overwrite: boolean) {
  const cond = overwrite ? "" : " AND COALESCE(note,'')=''";
  if (r.fu_id != null) executeChanges(`UPDATE fc_followups SET note=? WHERE id=?${cond}`, [note, r.fu_id]);
  if (r.call_log_id != null) executeChanges(`UPDATE call_logs SET expert_notes=? WHERE id=?${overwrite ? "" : " AND COALESCE(expert_notes,'')=''"}`, [note, r.call_log_id]);
  const ev = queryRow<{ event_id: number | null }>("SELECT event_id FROM voip_click_calls WHERE id=?", [r.call_id])?.event_id;
  if (ev != null) executeChanges(`UPDATE voip_after_call_events SET expert_notes=? WHERE id=?${overwrite ? "" : " AND COALESCE(expert_notes,'')=''"}`, [note, ev]);
}
function noteTick(now: Date, userId: number | null) {
  const rows = queryRows<S132Row & { ev: number | null }>(`SELECT s.*, k.event_id ev FROM s132_calls s JOIN voip_click_calls k ON k.id=s.call_id
    WHERE s.note_state='pending'${userId == null ? "" : " AND s.user_id=?"} ORDER BY s.call_id LIMIT 50`, userId == null ? [] : [userId]);
  for (const r of rows) {
    try {
      const e = r.ev != null ? queryRow<{ pid: string | null; has_recording: number }>("SELECT COALESCE(recording_provider_id,external_id) pid, has_recording FROM voip_after_call_events WHERE id=?", [r.ev]) : null;
      const sum = e?.pid ? storedCallSummary(e.pid) : null;
      const old = now.getTime() - ms(r.auto_at) > NOTE_GIVE_UP_MIN * 60000;
      if (sum && sum.summaryState === "completed" && typeof sum.customerRequestSummary === "string" && sum.customerRequestSummary.trim()) {
        const subj = typeof sum.callSubject === "string" ? sum.callSubject.trim() : "";
        const note = noteText(subj ? `${subj}: ${sum.customerRequestSummary}` : sum.customerRequestSummary);
        savepoint(() => {
          if (!r.note_edited_at) applyNote(r, note, false);
          executeChanges("UPDATE s132_calls SET note_state='ready', note=COALESCE(?,note) WHERE call_id=?", [r.note_edited_at ? null : note, r.call_id]);
        });
      } else if (sum?.summaryState === "failed" || (e && !e.has_recording && old) || old || r.note_edited_at) {
        executeChanges("UPDATE s132_calls SET note_state=? WHERE call_id=?", [r.note_edited_at ? "ready" : "none", r.call_id]);
      }
    } catch { /* retried on the next tick */ }
  }
}

/** Extra fields for the expert's own click call (only added to the payload while the flag is on). */
export type S132CallView = { firstCall: boolean; phase: "live" | "waiting" | "late" | "first_form" | "auto" | "manual"; waitSeconds: number | null; waitTotalSeconds: number;
  simStatus: string | null; expertStatus: string | null; fast?: true };
export function s132CallView(c: VcRow, now = new Date()): S132CallView | null {
  if (!s132TableExists()) return null;
  const r = queryRow<S132Row>("SELECT * FROM s132_calls WHERE call_id=?", [c.id]);
  if (!r) return null;
  const endedMs = ms(c.ended_at), WAIT = s132WaitS(c.user_id);
  const phase: S132CallView["phase"] = c.active ? "live" : c.state !== "ended" ? "manual"
    : r.auto_kind === "first_form" ? "first_form" : r.auto_kind === "manual" ? "manual" : r.auto_at ? "auto"
    : r.expert_status ? "waiting" : Number.isFinite(endedMs) && now.getTime() - endedMs >= WAIT * 1000 ? "late" : "waiting";
  return { firstCall: !!r.first_call, phase, simStatus: r.sim_status, expertStatus: r.expert_status,
    waitSeconds: phase === "waiting" && Number.isFinite(endedMs) ? Math.max(0, WAIT - Math.floor((now.getTime() - endedMs) / 1000)) : null, waitTotalSeconds: WAIT,
    ...(vcFastOn(c.user_id) ? { fast: true as const } : {}) }; // SIMOTEL-FAST: the 1.3.4 waiting copy; off → payload unchanged
}
/** «ثبت خودکار» bar: the expert's latest auto-saved call (until the next call starts, the bar is closed, or 30 min pass). */
export function s132LastBar(userId: number, now = new Date()) {
  if (!s132TableExists() || !vcTableExists()) return null;
  const r = queryRow<S132Row & { name: string | null; outcome: string | null; cust_status: string | null; billsec: number | null; ended_at: string | null; event_id: number | null }>(
    `SELECT s.*, cu.name, k.outcome, k.cust_status, k.billsec, k.ended_at, k.event_id FROM s132_calls s JOIN voip_click_calls k ON k.id=s.call_id
       LEFT JOIN customers cu ON cu.id=s.customer_id
     WHERE s.user_id=? AND s.auto_kind IN ('fc','dp') AND s.bar_closed_at IS NULL AND julianday(s.auto_at)>=julianday(?)-?/1440.0
       AND NOT EXISTS (SELECT 1 FROM voip_click_calls n WHERE n.user_id=s.user_id AND n.id>s.call_id)
     ORDER BY s.call_id DESC LIMIT 1`, [userId, iso(now), BAR_KEEP_MIN]);
  if (!r) return null;
  const status = r.fixed_status ?? r.expert_status ?? r.sim_status;
  return { callId: r.call_id, customerId: r.customer_id, customerName: r.name, fileId: r.file_id, status, simStatus: r.sim_status,
    expertStatus: r.status_source === "expert" ? r.expert_status : null, fixedStatus: r.fixed_status, source: r.status_source,
    at: r.ended_at ?? r.auto_at, durationSeconds: status === "answered" && r.billsec != null ? r.billsec : null,
    smsSent: r.sim_status !== "answered" && vnaSent(r.call_id), smsAt: r.sim_status !== "answered" ? smsSentAt(r.call_id) : null,
    nextStep: status === "answered" ? summaryNextStep(r.event_id) : null,
    boardNext: status === "answered" ? boardNext(r.customer_id, r.file_id, now) : null, noteState: r.note_state, note: r.note ?? "", noteEdited: !!r.note_edited_at,
    canFix: !!r.auto_at && tehranDay(new Date(r.auto_at)) === tehranDay(now) };
}

/** SIMOTEL-132 c (on-04): time of the «عدم پاسخ» SMS that actually went for this call (the R3 table appears with the first decision). */
function smsSentAt(callId: number): string | null {
  try {
    if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='voip_noanswer_sms'")) return null;
    return queryRow<{ t: string | null }>("SELECT COALESCE(updated_at,created_at) t FROM voip_noanswer_sms WHERE call_id=? AND status='sent'", [callId])?.t ?? null;
  } catch { return null; }
}
/** SIMOTEL-132 d (item 5): the board rule's actual result when the summary has no next step — the customer's next open reminder
 * (its time), else for a file «فردا، سر نوبت خودش» (today-split v1.0.4 «پیگیری شد، فردا»), else nothing scheduled. Read-only. */
function boardNext(customerId: number | null, fileId: number | null, now: Date): { kind: "reminder" | "file" | "none"; at: string | null } | null {
  try {
    if (customerId == null) return null;
    const r = queryRow<{ t: string }>("SELECT remind_at t FROM reminders WHERE customer_id=? AND done=0 AND julianday(remind_at)>julianday(?) ORDER BY julianday(remind_at) LIMIT 1", [customerId, iso(now)]);
    if (r?.t) return { kind: "reminder", at: r.t };
    return { kind: fileId != null ? "file" : "none", at: null };
  } catch { return null; }
}
/** SIMOTEL-132 c (on-06/07): the next step from the call's own summary when it carries one (nextStep); else null → the board's rule. */
function summaryNextStep(eventId: number | null): string | null {
  try {
    if (eventId == null) return null;
    const e = queryRow<{ pid: string | null }>("SELECT COALESCE(recording_provider_id,external_id) pid FROM voip_after_call_events WHERE id=?", [eventId]);
    const sum: any = e?.pid ? storedCallSummary(e.pid) : null;
    const n = sum && sum.summaryState === "completed" && typeof sum.nextStep === "string" ? sum.nextStep.replace(/\s+/g, " ").trim() : "";
    return n ? n.slice(0, 200) : null;
  } catch { return null; }
}
type Res = { status: number; body: any };
const fail = (status: number, error: string, message: string): Res => ({ status, body: { error, message } });
function ownRow(u: U, id: number): { r: S132Row; c: VcRow } | Res {
  if (!s132TableExists() || !vcTableExists()) return fail(404, "not_found", "این تماس پیدا نشد.");
  const r = queryRow<S132Row>("SELECT * FROM s132_calls WHERE call_id=? AND user_id=?", [id, u.id]);
  const c = r ? queryRow<VcRow>("SELECT * FROM voip_click_calls WHERE id=?", [id]) : null;
  return r && c ? { r, c } : fail(404, "not_found", "این تماس پیدا نشد.");
}
const parseStatus = (v: unknown): S132Status | null => (S132_STATUSES as readonly string[]).includes(String(v)) ? (String(v) as S132Status) : null;

/** No CDR yet (or late): the expert's own status pick → the same automatic save (status only, no questions). */
export function s132SetStatus(u: U, id: number, body: any, now = new Date()): Res {
  const o = ownRow(u, id); if ("status" in o) return o;
  const st = parseStatus(body?.status); if (!st) return fail(422, "bad_status", "وضعیت را انتخاب کن.");
  if (o.c.active || o.c.state !== "ended") return fail(409, "not_ended", "تماس هنوز تمام نشده است.");
  if (o.r.auto_at) return fail(409, "already_saved", "نتیجه‌ی این تماس ثبت شده است.");
  executeChanges("UPDATE s132_calls SET expert_status=?, status_source='expert' WHERE call_id=? AND auto_at IS NULL", [st, id]);
  const r = queryRow<S132Row>("SELECT * FROM s132_calls WHERE call_id=?", [id])!;
  // the expert's pick wins over a CDR that arrives later; a CDR that is already here was shown, so it is not overwritten either
  processOne({ ...r, expert_status: st }, o.c, now);
  const r2 = queryRow<S132Row>("SELECT * FROM s132_calls WHERE call_id=?", [id])!;
  return { status: 200, body: { ok: true, phase: r2.auto_kind === "first_form" ? "first_form" : r2.auto_kind === "manual" ? "manual" : r2.auto_at ? "auto" : "waiting",
    bar: s132LastBar(u.id, now), call: vcView(o.c, now) } };
}
/** «اشتباهه؟»: status only, own auto-saved call, same Tehran day. The Simotel status stays; the fix is logged. */
export function s132Fix(u: U, id: number, body: any, now = new Date()): Res {
  const o = ownRow(u, id); if ("status" in o) return o;
  const st = parseStatus(body?.status); if (!st) return fail(422, "bad_status", "وضعیت را انتخاب کن.");
  if (o.r.auto_kind !== "fc" && o.r.auto_kind !== "dp") return fail(409, "not_auto", "این تماس خودکار ثبت نشده است.");
  if (!o.r.auto_at || tehranDay(new Date(o.r.auto_at)) !== tehranDay(now)) return fail(409, "too_late", "فقط تماس‌های امروز اصلاح می‌شوند.");
  const from = o.r.fixed_status ?? o.r.expert_status ?? o.r.sim_status;
  executeChanges("UPDATE s132_calls SET fixed_status=?, fixed_at=? WHERE call_id=?", [st, iso(now), id]);
  executeChanges("INSERT INTO s132_fixes(call_id,user_id,from_status,to_status,created_at) VALUES(?,?,?,?,?)", [id, u.id, from, st, iso(now)]);
  return { status: 200, body: { ok: true, bar: s132LastBar(u.id, now) } };
}
/** «افزودن یادداشت» / «ویرایش»: the expert's own text replaces the auto note (same targets). */
export function s132Note(u: U, id: number, body: any, now = new Date()): Res {
  const o = ownRow(u, id); if ("status" in o) return o;
  if (o.r.auto_kind !== "fc" && o.r.auto_kind !== "dp") return fail(409, "not_auto", "این تماس خودکار ثبت نشده است.");
  const note = noteText(body?.note); if (!note) return fail(422, "note_required", "یادداشت را بنویس.");
  applyNote(o.r, note, true);
  executeChanges("UPDATE s132_calls SET note=?, note_edited_at=?, note_state='ready' WHERE call_id=?", [note, iso(now), id]);
  return { status: 200, body: { ok: true, bar: s132LastBar(u.id, now) } };
}
/** Bar «بستن» / the first-call form saved → the bar or the ended call leaves the panel. */
export function s132CloseBar(u: U, id: number, now = new Date()): Res {
  const o = ownRow(u, id); if ("status" in o) return o;
  executeChanges("UPDATE s132_calls SET bar_closed_at=COALESCE(bar_closed_at,?) WHERE call_id=?", [iso(now), id]);
  return { status: 200, body: { ok: true } };
}
/** History rows: «سیموتل: X» / «کارشناس: Y» and the fix line (own calls of the flagged expert only add data; never removes anything). */
export function s132HistoryInfo(callIds: number[]): Map<number, { sim: string | null; expert: string | null; fixed: string | null; fixedAt: string | null; auto: boolean; note: string | null }> {
  const m = new Map<number, { sim: string | null; expert: string | null; fixed: string | null; fixedAt: string | null; auto: boolean; note: string | null }>();
  if (!callIds.length || !s132TableExists()) return m;
  for (const r of queryRows<S132Row>(`SELECT * FROM s132_calls WHERE call_id IN (${callIds.map(() => "?").join(",")})`, callIds))
    m.set(r.call_id, { sim: r.sim_status, expert: r.status_source === "expert" ? r.expert_status : null, fixed: r.fixed_status, fixedAt: r.fixed_at,
      auto: r.auto_kind === "fc" || r.auto_kind === "dp", note: r.note });
  return m;
}

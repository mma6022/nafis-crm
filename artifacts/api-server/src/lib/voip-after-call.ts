import { callNoteError } from "./call-note-rule";
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { callExtensions, callStartedAt, getSimotelCalls, SimotelError, type SimotelCall } from "./simotel";
import type { AuthUser } from "./auth";
import "./call-display-exclusions";
import { CALL_LIST_START, callIsInDisplayPeriod } from "./call-list-cutoff";
import { notifyCallReport } from "./voip-call-notifications";

export function ensureAfterCallSchema() {
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS voip_after_call_state(
      id INTEGER PRIMARY KEY CHECK(id=1),activated_at TEXT NOT NULL,last_checked_at TEXT,sync_error TEXT);
    CREATE TABLE IF NOT EXISTS voip_after_call_events(
      id INTEGER PRIMARY KEY,external_id TEXT NOT NULL UNIQUE,phone TEXT NOT NULL,
      direction TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT NOT NULL,
      extension TEXT,extensions_json TEXT NOT NULL,expert_user_id INTEGER,expert_name TEXT,
      salesperson_id INTEGER,customer_id INTEGER,call_log_id INTEGER UNIQUE,has_recording INTEGER NOT NULL,
      expert_notes TEXT NOT NULL DEFAULT '',completed_at TEXT,completed_by_user_id INTEGER,completed_payload TEXT);
    CREATE INDEX IF NOT EXISTS idx_after_call_pending ON voip_after_call_events(completed_at,expert_user_id,id);
  `);
  const existing = new Set(queryRows<{name:string}>("PRAGMA table_info(voip_after_call_events)").map(x=>x.name));
  const additions: Record<string,string> = {
    is_live:"INTEGER NOT NULL DEFAULT 0", live_cuid:"TEXT", report_subject:"TEXT",
    report_revision:"INTEGER NOT NULL DEFAULT 0", report_saved_at:"TEXT", report_edited_by:"INTEGER",
    recording_file:"TEXT", recording_provider_id:"TEXT", auto_capture:"INTEGER NOT NULL DEFAULT 0",
    auto_queued:"INTEGER NOT NULL DEFAULT 0", capture_error:"TEXT",
    mobile_device_id:"INTEGER", mobile_call_id:"TEXT", caller_number:"TEXT", callee_number:"TEXT",
    contact_name:"TEXT", duration_seconds:"INTEGER", mobile_answered_at:"TEXT",
  };
  for(const [name,definition] of Object.entries(additions)) if(!existing.has(name)) crmDb.exec(`ALTER TABLE voip_after_call_events ADD COLUMN ${name} ${definition}`);
  crmDb.exec(`CREATE INDEX IF NOT EXISTS idx_after_call_live ON voip_after_call_events(live_cuid,extension);
    CREATE TABLE IF NOT EXISTS voip_call_reporting_state(id INTEGER PRIMARY KEY CHECK(id=1),activated_at TEXT NOT NULL,live_event_seen_at TEXT);
    CREATE TABLE IF NOT EXISTS call_report_edits(id INTEGER PRIMARY KEY,call_log_id INTEGER,event_id INTEGER,revision INTEGER NOT NULL,
      subject TEXT,expert_notes TEXT NOT NULL,edited_by INTEGER NOT NULL,edited_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_call_report_edits ON call_report_edits(call_log_id,revision);`);
  executeChanges("INSERT OR IGNORE INTO voip_call_reporting_state(id,activated_at) VALUES(1,?)",[new Date().toISOString()]);
  executeChanges("INSERT OR IGNORE INTO voip_after_call_state(id,activated_at) VALUES(1,?)", [new Date().toISOString()]);
}
export type AfterCallEvent = {
  id: number; external_id: string; phone: string; direction: string; status: string;
  started_at: string; ended_at: string; extension: string | null; extensions_json: string;
  expert_user_id: number | null; expert_name: string | null; salesperson_id: number | null;
  customer_id: number | null; call_log_id: number | null; has_recording: number;
  expert_notes: string; completed_at: string | null; completed_payload: string | null;
  is_live:number; live_cuid:string|null; report_subject:string|null; report_revision:number;
  report_saved_at:string|null; report_edited_by:number|null; recording_file:string|null; recording_provider_id:string|null;
  auto_capture:number; auto_queued:number; capture_error:string|null;
  mobile_device_id:number|null; mobile_call_id:string|null; caller_number:string|null; callee_number:string|null;
  contact_name:string|null; duration_seconds:number|null; mobile_answered_at:string|null;
  actual_customer_id: number | null; customer_name: string | null; customer_owner: number | null; priority: number | null;
};
const select = `SELECT e.*,c.id actual_customer_id,c.name customer_name,c.salesperson_id customer_owner,c.priority
  FROM voip_after_call_events e LEFT JOIN call_logs l ON l.id=e.call_log_id
  LEFT JOIN customers c ON c.id=COALESCE(l.customer_id,e.customer_id) AND c.merged_into_customer_id IS NULL`;
export function eventFor(id: number) { return queryRow<AfterCallEvent>(`${select} WHERE e.id=?`, [id]); }
export function canSeeAfterCall(event: AfterCallEvent, actor: AuthUser) {
  if (!callIsInDisplayPeriod(event.started_at)) return false;
  if (actor.role === "admin") return true;
  if (event.expert_user_id !== actor.id) return false;
  if (event.mobile_device_id != null) return true;
  if (queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [actor.id])?.extension !== event.extension) return false;
  return true;
}
export function canAccessAfterCallCustomer(event: AfterCallEvent, actor: AuthUser) {
  return actor.role === "admin" || actor.customerScope === "all"
    || (actor.salespersonId != null && event.customer_owner === actor.salespersonId);
}
export function pendingAfterCalls(actor: AuthUser) {
  const params: Array<string | number> = [CALL_LIST_START];
  let scope = " AND julianday(e.started_at)>=julianday(?)";
  if (actor.role !== "admin") {
    scope += " AND e.expert_user_id=? AND (e.mobile_device_id IS NOT NULL OR EXISTS (SELECT 1 FROM voip_extensions own WHERE own.user_id=? AND own.extension=e.extension))"; params.push(actor.id,actor.id);
  }
  scope += " AND NOT EXISTS (SELECT 1 FROM voip_call_display_exclusions hidden WHERE hidden.phone=e.phone)";
  const rows = queryRows<AfterCallEvent>(`${select} WHERE e.completed_at IS NULL${scope} ORDER BY e.is_live DESC,e.id LIMIT 100`, params);
  const total = queryRow<{ count: number }>(`SELECT COUNT(*) count FROM (${select} WHERE e.completed_at IS NULL${scope})`, params)?.count ?? 0;
  return { rows, total };
}
// Called inside the history/profile/reminder transaction. A manual history
// completes one corresponding queue entry, not other experts' or later calls.
/** Release 81: the call_logs id a manual save would complete (an automatic VoIP / mobile call), or null for a plain manual log. Read-only. */
export function pendingAfterCallLogId(customerId: number, actor: AuthUser): number | null {
  const event = queryRows<AfterCallEvent>(
    `${select} WHERE e.completed_at IS NULL AND c.id=? AND l.id IS NOT NULL ORDER BY e.id`,
    [customerId],
  ).find(e => canSeeAfterCall(e, actor) && canAccessAfterCallCustomer(e, actor));
  return event?.call_log_id ?? null;
}
export function savePendingAfterCallHistory(customerId: number, actor: AuthUser, fields: {
  subject: string | null; customerRequest: string | null; expertNotes: string | null;
}): number | null {
  const event = queryRows<AfterCallEvent>(
    `${select} WHERE e.completed_at IS NULL AND c.id=? AND l.id IS NOT NULL ORDER BY e.id`,
    [customerId],
  ).find(e => canSeeAfterCall(e, actor) && canAccessAfterCallCustomer(e, actor));
  if (!event || event.call_log_id == null) return null;
  const notes = fields.expertNotes ?? "";
  executeChanges("UPDATE call_logs SET subject=?,customer_request=?,expert_notes=? WHERE id=?",
    [fields.subject, fields.customerRequest, notes, event.call_log_id]);
  executeChanges(
    "UPDATE voip_after_call_events SET expert_notes=?,report_subject=?,report_saved_at=?,report_edited_by=?,report_revision=report_revision+1,completed_at=?,completed_by_user_id=?,completed_payload=? WHERE id=? AND completed_at IS NULL",
    [notes,fields.subject,new Date().toISOString(),actor.id,new Date().toISOString(),actor.id,JSON.stringify({expertNotes:notes}),event.id],
  );
  return event.call_log_id;
}
export function afterCallState() {
  return queryRow<{ activated_at: string; last_checked_at: string | null; sync_error: string | null }>("SELECT * FROM voip_after_call_state WHERE id=1")!;
}
export function normalizePhone(value: string) {
  let digits = value.replace(/[۰-۹]/g, x => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x)))
    .replace(/[٠-٩]/g, x => String("٠١٢٣٤٥٦٧٨٩".indexOf(x))).replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("98")) digits = "0" + digits.slice(2);
  else if (digits.length === 10 && digits.startsWith("9")) digits = "0" + digits;
  return /^0\d{9,10}$/.test(digits) ? digits : null;
}
type Expert = { id: number; name: string; salesperson_id: number | null; extension: string };
export function customerMatcher() {
  type Customer = { id: number; phone: string; status: string | null };
  const exact = queryRows<Customer>("SELECT id,phone,status FROM customers WHERE merged_into_customer_id IS NULL");
  const aliases = queryRows<Customer>(`SELECT survivor.id,source.phone,survivor.status FROM customers source
    JOIN customers survivor ON survivor.id=source.merged_into_customer_id
    WHERE source.merged_into_customer_id IS NOT NULL AND survivor.merged_into_customer_id IS NULL`);
  const groups = [exact.filter(c => c.status !== "cancelled"), aliases.filter(c => c.status !== "cancelled"),
    exact.filter(c => c.status === "cancelled"), aliases.filter(c => c.status === "cancelled")]
    .map(rows => {
      const index = new Map<string, Set<number>>();
      for (const row of rows) {
        const phone = normalizePhone(row.phone);
        if (phone) index.set(phone, (index.get(phone) ?? new Set()).add(row.id));
      }
      return index;
    });
  return (phone: string) => {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    for (const group of groups) {
      const matches = group.get(normalized);
      if (matches?.size) return matches.size === 1 ? { id: [...matches][0] } : null;
    }
    return null;
  };
}
export function experts() {
  return queryRows<Expert>(`SELECT u.id,COALESCE(NULLIF(TRIM(u.full_name),''),u.username) name,u.salesperson_id,e.extension
    FROM voip_extensions e JOIN users u ON u.id=e.user_id WHERE e.extension IS NOT NULL`);
}
export function resolveEvent(id: number, available: Expert[], lookupCustomer: (phone: string) => { id: number } | null) {
  const event = eventFor(id);
  if (!event || event.completed_at) return;
  if (event.expert_user_id == null) {
    const extensions = JSON.parse(event.extensions_json) as string[];
    const matches = available.filter(x => extensions.includes(x.extension));
    // Do not guess a single expert for an ambiguous transfer involving several users.
    if (matches.length === 1) executeChanges(
      "UPDATE voip_after_call_events SET expert_user_id=?,expert_name=?,salesperson_id=?,extension=? WHERE id=?",
      [matches[0].id, matches[0].name, matches[0].salesperson_id, matches[0].extension, id],
    );
  }
  if (event.customer_id == null) {
    const customer = lookupCustomer(event.phone);
    if (customer) executeChanges("UPDATE voip_after_call_events SET customer_id=? WHERE id=?", [customer.id, id]);
  }
  const resolved = eventFor(id)!;
  if (resolved.customer_id != null && resolved.call_log_id == null) {
    const callId = execute(
      `INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at)
       VALUES(?,?,?,?,NULL,?,?)`,
      [resolved.customer_id, resolved.salesperson_id, resolved.expert_name,
        `${resolved.direction === "incoming" ? "تماس ورودی" : "تماس خروجی"} مرکز تماس (${resolved.status})`,
        resolved.expert_notes, resolved.started_at],
    );
    executeChanges("UPDATE voip_after_call_events SET call_log_id=? WHERE id=?", [callId, id]);
  } else if (resolved.call_log_id != null && event.expert_user_id == null && resolved.expert_user_id != null) {
    executeChanges("UPDATE call_logs SET salesperson_id=?,salesperson_name_snapshot=? WHERE id=?",
      [resolved.salesperson_id, resolved.expert_name, resolved.call_log_id]);
  }
}
export function ingestAfterCalls(rows: SimotelCall[], now = new Date()) {
  const state = afterCallState(), available = experts(), known = available.map(x => x.extension), lookupCustomer = customerMatcher();
  let inserted = 0;
  runTransaction(() => {
    for (const row of rows) {
      if (!["incoming", "outgoing"].includes(row.type)) continue;
      const ended = Number(row.endtime?.$date?.$numberLong);
      if (!Number.isFinite(ended) || ended > now.getTime() || ended <= 0) continue;
      const startedAt = callStartedAt(row);
      if (startedAt < state.activated_at || !callIsInDisplayPeriod(startedAt)) continue; // Never backfill old calls.
      const extensions = callExtensions(row, known);
      const endpoint = row.type === "incoming" ? row.dst : row.src;
      const extension = extensions.length === 1 ? extensions[0] : /^[A-Za-z0-9*#_.-]{1,6}$/.test(endpoint) ? endpoint : null;
      const phone = (row.type === "incoming" ? row.src : row.dst).slice(0,128);
      // A PBX conversation identifier alone is not sufficient: it can be shared
      // by transfer legs. Require the actual expert leg, peer and time interval.
      const matches = queryRows<AfterCallEvent>(`${select} WHERE e.live_cuid=? AND e.direction=?
        AND (e.recording_provider_id IS NULL OR e.recording_provider_id=?)
        AND e.extension IN (SELECT value FROM json_each(?))
        AND julianday(e.started_at)>=julianday(?)-5.0/86400
        AND julianday(e.started_at)<=julianday(?)+10.0/86400`,
        [row.cuid?.replace(/\s+/g,"")??"",row.type,row._id,JSON.stringify(extensions),startedAt,new Date(ended).toISOString()])
        .filter(e=>normalizePhone(e.phone)===normalizePhone(phone) && normalizePhone(phone)!=null);
      const real = queryRow<{id:number}>("SELECT id FROM voip_after_call_events WHERE external_id=?",[row._id]);
      if (!real && matches.length>0 && new Set(matches.map(e=>e.extension)).size===matches.length) {
        for(const [index,live] of matches.entries()){
          // Transfer participants retain separate expert reports, but share the
          // verified provider recording. Never insert a third CDR-only history.
          executeChanges(`UPDATE voip_after_call_events SET external_id=?,recording_provider_id=?,started_at=?,ended_at=?,status=?,is_live=0,
            has_recording=?,recording_file=? WHERE id=?`,
            [index===0?row._id:live.external_id,row._id,startedAt,new Date(ended).toISOString(),row.disposition,row.record?1:0,row.record??null,live.id]);
          if(live.call_log_id!=null) executeChanges("UPDATE call_logs SET created_at=? WHERE id=?",[startedAt,live.call_log_id]);
          if(live.report_saved_at && !live.completed_at) finishSavedLiveReport(live.id);
        }
        continue;
      }
      const reportingStart=queryRow<{activated_at:string}>("SELECT activated_at FROM voip_call_reporting_state WHERE id=1")!.activated_at;
      const change = executeChanges(
        `INSERT OR IGNORE INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,has_recording,recording_file,auto_capture)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [row._id, phone, row.type, row.disposition,
          startedAt, new Date(ended).toISOString(), extension, JSON.stringify(extensions), row.record ? 1 : 0,row.record??null,startedAt>=reportingStart?1:0],
      );
      if (change) inserted++;
      else executeChanges(`UPDATE voip_after_call_events SET has_recording=?,recording_file=COALESCE(?,recording_file),
        status=?,is_live=0,ended_at=? WHERE external_id=? OR recording_provider_id=?`,
        [row.record?1:0,row.record??null,row.disposition,new Date(ended).toISOString(),row._id,row._id]);
    }
    for (const pending of queryRows<{ id: number }>("SELECT id FROM voip_after_call_events WHERE completed_at IS NULL")) {
      resolveEvent(pending.id, available, lookupCustomer);
    }
  });
  notifyCallReport(null);
  return inserted;
}
export function finishSavedLiveReport(id:number) {
  const e=eventFor(id);
  if(!e || !e.report_saved_at || e.is_live || e.completed_at)return;
  // crm-call-note-min: a live draft shorter than the minimum stays in the queue for the expert to finish.
  if(callNoteError(e.expert_notes))return;
  executeChanges("UPDATE voip_after_call_events SET completed_at=?,completed_by_user_id=?,completed_payload=? WHERE id=? AND completed_at IS NULL",
    [new Date().toISOString(),e.report_edited_by,JSON.stringify({expertNotes:e.expert_notes,subject:e.report_subject}),id]);
}
let running: Promise<void> | null = null;
function tehranDay(date: Date) {
  return new Date(date.getTime() + 3.5 * 3600000).toISOString().slice(0,10);
}
export function syncAfterCalls() {
  if (running) return running;
  running = (async () => {
    try {
      const state = afterCallState(), now = new Date();
      const baseline = state.last_checked_at ?? state.activated_at;
      // One-day overlap catches delayed CDR delivery and midnight-spanning calls.
      let day = tehranDay(new Date(Date.parse(baseline) - 86400000));
      const today = tehranDay(now);
      while (day <= today) {
        const result = await getSimotelCalls(day, day, true);
        ingestAfterCalls(result.rows, now);
        executeChanges("UPDATE voip_after_call_state SET last_checked_at=?,sync_error=NULL WHERE id=1",
          [day === today ? now.toISOString() : new Date(`${day}T23:59:59+03:30`).toISOString()]);
        day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
      }
      const {queueAutomaticCallReports}=await import("./automatic-call-reports");
      await queueAutomaticCallReports();
    } catch (error) {
      executeChanges("UPDATE voip_after_call_state SET sync_error=? WHERE id=1", [
        error instanceof SimotelError ? error.message : "بررسی تماس‌های جدید ناموفق بود؛ دوباره تلاش می‌شود.",
      ]);
    }
  })().finally(() => { running = null; });
  return running;
}
export function startAfterCallMonitor() {
  ensureAfterCallSchema();
  void syncAfterCalls();
  setInterval(() => { void syncAfterCalls(); }, 20000).unref();
}
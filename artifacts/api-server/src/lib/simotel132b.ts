/**
 * SIMOTEL-132 Phase B — Armita simotel v1.3.2 §7 (incoming window, missed calls, manager report) + §10 (outgoing calls not started
 * from the CRM button). Mohammad t770s3064. Behind flag.simotel132b (global) or flag.simotel132b.user.<id> = '1', on top of
 * flag.voip_call + own extension (vcOn); admins never get a window or badge (§10). OFF by default.
 *  - Flag off → nothing here writes: no table is created, every hook returns after one settings read, payloads carry no new key,
 *    the new endpoints answer 404, and the old after-call popup queue is unchanged (pending filter = "").
 *  - Flag on for an expert → that expert's non-click Simotel calls leave the old after-call popup; they are saved by themselves
 *    (event completed with source 's132b', call log from the existing resolveEvent), the note is filled from the call summary and
 *    stays editable; small corner cards / toasts show the live call (no phone for another expert's customer).
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { vcOn, vcTableExists } from "./voip-call";
import { customerMatcher, experts, normalizePhone, resolveEvent } from "./voip-after-call";
import { getAuthUserById, type AuthUser } from "./auth";
import { dpAfterFirstCallForm } from "./daily-plan";
import { storedCallSummary } from "./recording-summary-jobs";
import { insertCustomerRecord } from "./customer-create";
import { getTeamSalesConfig } from "./team-sales";
import { jalaliMonthStart, tehranWeekStart } from "./assistant-manager";

type U = { id: number; role?: string; salespersonId?: number | null; fullName?: string | null };
const NOTE_MAX = 500, NOTE_GIVE_UP_MIN = 45, LOG_WAIT_MIN = 10, CARD_KEEP_MIN = 10;
export const S132B_NONAME = "بدون نام";
const setting = (key: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
const iso = (d: Date) => d.toISOString();
const OFF = 210 * 60000, DAYMS = 86400000;
const tehranDayStartIso = (d: Date) => new Date(Math.floor((d.getTime() + OFF) / DAYMS) * DAYMS - OFF).toISOString();
const tehranDay = (d: Date) => new Date(d.getTime() + OFF).toISOString().slice(0, 10);
const tableExists = (name: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [name]);

/* ---------------- flags ---------------- */
export function s132bFlagOn(userId: number | null | undefined): boolean {
  if (userId == null) return false;
  return setting("flag.simotel132b") === "1" || setting(`flag.simotel132b.user.${Number(userId)}`) === "1";
}
/** Any B key on at all (global or one user). Off → every hook stops here. */
export function s132bAnyOn(): boolean {
  try { return !!queryRow("SELECT 1 x FROM call_queue_settings WHERE (key='flag.simotel132b' OR key LIKE 'flag.simotel132b.user.%') AND value='1' LIMIT 1"); }
  catch { return false; }
}
/** Expert UI (cards, toasts, missed list): flag + VoIP button flag + own extension, never an admin. */
export function s132bOn(u: U | null | undefined): boolean { return !!u && u.role !== "admin" && s132bFlagOn(u.id) && vcOn(u); }
/** Manager report tab: an admin viewer (same rule as «گزارش مرکز تماس») with the B flag (global or own key). */
export function s132bReportOn(u: AuthUser | null | undefined, viewer: (u: AuthUser) => boolean): boolean { return !!u && viewer(u) && s132bFlagOn(u.id); }
/** User ids the B flow currently covers (role + extension + flags). */
export function s132bUserIds(): number[] {
  if (!s132bAnyOn()) return [];
  const rows = queryRows<{ id: number; role: string }>(`SELECT u.id, u.role FROM users u JOIN voip_extensions x ON x.user_id=u.id
    WHERE x.extension IS NOT NULL AND u.active=1 AND u.role<>'admin'`);
  return rows.filter((r) => s132bOn({ id: r.id, role: r.role })).map((r) => Number(r.id));
}
/** pendingAfterCalls: a B expert's calls never open the old popup. No B key → "" (query unchanged). */
export function s132bPendingFilterSql(): string {
  try {
    const ids = s132bUserIds();
    return ids.length ? ` AND COALESCE(e.expert_user_id,0) NOT IN (${ids.map((x) => Number(x)).join(",")})` : "";
  } catch { return ""; }
}

/* ---------------- schema (lazy, flag on only) ---------------- */
export function ensureS132bSchema() {
  crmDb.exec(`CREATE TABLE IF NOT EXISTS s132b_events(event_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, cls TEXT,
    customer_id INTEGER, created_customer INTEGER, first_form INTEGER NOT NULL DEFAULT 0, form_opened_at TEXT, note_state TEXT, note TEXT,
    note_edited_at TEXT, closed_at TEXT, auto_at TEXT, auto_kind TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_s132b_user ON s132b_events(user_id, event_id);
  CREATE TABLE IF NOT EXISTS s132b_ext_state(extension TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL);`);
}
const ready = () => tableExists("s132b_events");
function savepoint<T>(f: () => T): T {
  crmDb.exec("SAVEPOINT s132b");
  try { const r = f(); crmDb.exec("RELEASE s132b"); return r; }
  catch (e) { crmDb.exec("ROLLBACK TO s132b"); crmDb.exec("RELEASE s132b"); throw e; }
}

/* ---------------- Simotel NewState hook (live status for the manager report) ---------------- */
const STATE_OF: Record<string, string> = { ringing: "ring", inuse: "talk", busy: "talk", idle: "free", notinuse: "free", pause: "pause", paused: "pause", unavailable: "off" };
export function s132bOnNewState(extension: string, rawState: string, now = new Date()): void {
  try {
    if (!s132bAnyOn()) return;
    const st = STATE_OF[String(rawState ?? "").toLowerCase().replace(/[\s_]/g, "")]; if (!st || !extension) return;
    savepoint(() => {
      ensureS132bSchema();
      executeChanges(`INSERT INTO s132b_ext_state(extension,state,since) VALUES(?,?,?)
        ON CONFLICT(extension) DO UPDATE SET since=CASE WHEN state=excluded.state THEN since ELSE excluded.since END, state=excluded.state`, [extension, st, iso(now)]);
    });
  } catch { /* status only */ }
}

/* ---------------- classification (number access is decided here, on the server) ---------------- */
type Ev = { id: number; phone: string; direction: string; status: string; started_at: string; ended_at: string; extension: string | null;
  extensions_json: string; expert_user_id: number | null; customer_id: number | null; call_log_id: number | null; is_live: number;
  completed_at: string | null; live_cuid: string | null; has_recording: number; duration_seconds: number | null; recording_provider_id: string | null; external_id: string;
  mobile_device_id: number | null };
type Cust = { id: number; name: string; phone: string; salesperson_id: number | null; registered_by: number | null; priority: number | null; owner_name: string | null };
const custOf = (id: number | null) => id == null ? null : queryRow<Cust>(`SELECT c.id,c.name,c.phone,c.salesperson_id,c.registered_by,c.priority,s.name owner_name
  FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=? AND c.merged_into_customer_id IS NULL`, [id]) ?? null;
const hiddenPhone = (p: string) => !normalizePhone(p ?? "");
export type Cls = "own" | "other" | "support" | "new" | "unknown" | "hidden";
export function s132bClassify(u: U, e: { phone: string; direction: string }, c: Cust | null): Cls {
  if (hiddenPhone(e.phone)) return "hidden";
  if (!c) return e.direction === "incoming" ? "unknown" : "new";
  if (u.role === "registrar") return "support";
  if (u.salespersonId != null && Number(c.salesperson_id) === Number(u.salespersonId)) return "own";
  return "other";
}
const phoneShown = (u: U, cls: Cls, c: Cust | null) => cls === "own" || cls === "new" || cls === "unknown" || (cls === "support" && !!c && Number(c.registered_by) === Number(u.id));

/* ---------------- click calls stay with the VoIP button (Phase A / R2) ---------------- */
function isClickEvent(e: Ev): boolean {
  if (!vcTableExists()) return false;
  if (queryRow(`SELECT 1 x FROM voip_click_calls kk WHERE kk.event_id=? OR (kk.cuid IS NOT NULL AND (kk.cuid=? OR kk.leg_cuid=?)) LIMIT 1`,
    [e.id, e.live_cuid ?? "\u0000", e.live_cuid ?? "\u0000"])) return true;
  if (e.direction !== "outgoing" || e.expert_user_id == null) return false;
  const p = normalizePhone(e.phone); if (!p) return false;
  // a just-started click call whose cuid is not linked yet: same expert, same number, same minute
  return queryRows<{ phone: string | null }>(`SELECT phone FROM voip_click_calls WHERE user_id=? AND julianday(created_at)>=julianday(?)-90.0/86400
      AND julianday(created_at)<=julianday(?)+5.0/86400`, [e.expert_user_id, e.started_at, e.started_at]).some((k) => normalizePhone(k.phone ?? "") === p);
}

/* ---------------- after-ingest / poll tick ---------------- */
const qualifierSp = () => { try { const c = getTeamSalesConfig() as any; return c?.enabled ? Number(c.qualifierSalespersonId) : null; } catch { return null; } };
const noteText = (v: unknown) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";
function ownCalls(e: Ev) { return e.mobile_device_id == null; }

/** Create the «بدون نام» / named customer for an outgoing call to a new mobile number (one customer per number). */
function createForNumber(u: AuthUser, phone: string, name: string, leadSource: string): number | null {
  const m = customerMatcher()(phone); if (m) return Number(m.id);
  const p = normalizePhone(phone); if (!p || !/^09\d{9}$/.test(p) || u.salespersonId == null) return null;
  return insertCustomerRecord({ name, phone: p, registeredByUserId: Number(u.id), registrationSource: "staff_form",
    assignedSalespersonId: Number(u.salespersonId), priority: 1, intake: { leadSource, leadSourceOther: leadSource === "other" ? "تماس خروجی بیرون از صف (سیموتل)" : undefined }, skipDefaultOwnerRule: true } as any);
}
function linkCustomer(eventId: number, customerId: number) {
  executeChanges("UPDATE voip_after_call_events SET customer_id=? WHERE id=? AND customer_id IS NULL", [customerId, eventId]);
  const e = queryRow<Ev>("SELECT * FROM voip_after_call_events WHERE id=?", [eventId]);
  if (!e) return;
  if (!e.completed_at) resolveEvent(eventId, experts(), customerMatcher());
  else if (e.call_log_id == null && e.customer_id != null) { // already saved by itself → same call log resolveEvent would write
    const ex = queryRow<{ name: string; salesperson_id: number | null }>(`SELECT COALESCE(NULLIF(TRIM(full_name),''),username) name, salesperson_id FROM users WHERE id=?`, [e.expert_user_id ?? 0]);
    const id = execute(`INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at) VALUES(?,?,?,?,NULL,?,?)`,
      [e.customer_id, ex?.salesperson_id ?? null, ex?.name ?? null, `${e.direction === "incoming" ? "تماس ورودی" : "تماس خروجی"} مرکز تماس (${e.status})`, "", e.started_at]);
    executeChanges("UPDATE voip_after_call_events SET call_log_id=? WHERE id=?", [id, eventId]);
  }
  executeChanges("UPDATE s132b_events SET customer_id=? WHERE event_id=?", [customerId, eventId]);
}
function completeEvent(e: Ev, userId: number, outcome: string, now: Date) {
  executeChanges(`UPDATE voip_after_call_events SET completed_at=?, completed_by_user_id=?, completed_payload=? WHERE id=? AND completed_at IS NULL`,
    [iso(now), userId, JSON.stringify({ expertNotes: "", source: "s132b", outcome }), e.id]);
}
function processEvent(u: AuthUser, e: Ev, now: Date) {
  let row = queryRow<any>("SELECT * FROM s132b_events WHERE event_id=?", [e.id]);
  if (!row) {
    if (isClickEvent(e)) { executeChanges("INSERT OR IGNORE INTO s132b_events(event_id,user_id,kind,created_at,auto_at,auto_kind,closed_at) VALUES(?,?,?,?,?,'click',?)", [e.id, u.id, e.direction, iso(now), iso(now), iso(now)]); return; }
    const c = custOf(e.customer_id);
    executeChanges("INSERT OR IGNORE INTO s132b_events(event_id,user_id,kind,cls,customer_id,created_at) VALUES(?,?,?,?,?,?)",
      [e.id, u.id, e.direction, s132bClassify(u, e, c), e.customer_id, iso(now)]);
    row = queryRow<any>("SELECT * FROM s132b_events WHERE event_id=?", [e.id]);
  }
  if (!row || row.auto_at || e.is_live) return;
  const answered = String(e.status).toUpperCase() === "ANSWERED";
  // §10 new number, answered, no name typed during the call → «بدون نام» with priority 1 (one customer per number)
  if (e.direction === "outgoing" && e.customer_id == null && answered && row.cls === "new" && u.role !== "registrar") {
    const id = createForNumber(u, e.phone, S132B_NONAME, "other");
    if (id != null) { linkCustomer(e.id, id); executeChanges("UPDATE s132b_events SET created_customer=?, cls='new' WHERE event_id=?", [id, e.id]); e = queryRow<Ev>("SELECT * FROM voip_after_call_events WHERE id=?", [e.id])!; row.created_customer = id; }
  }
  const old = now.getTime() - Date.parse(e.ended_at || e.started_at) > LOG_WAIT_MIN * 60000;
  if (e.customer_id != null && e.call_log_id == null && !old) return; // resolveEvent writes the call log on the next ingest
  const outcome = answered ? "answered" : "no_answer";
  completeEvent(e, u.id, outcome, now);
  // Q14: answered new number of the qualifier → the first-call form opens once (priority 1 stays until the form decides)
  const q = qualifierSp();
  const firstForm = answered && row.created_customer != null && q != null && Number(u.salespersonId) === q ? 1 : 0;
  // Q13: outgoing call to an own customer with a task today → the task leaves «کارهای امروز من»
  if (e.direction === "outgoing" && e.customer_id != null && e.call_log_id != null && row.cls === "own" && !firstForm) {
    try { savepoint(() => dpAfterFirstCallForm(u as any, Number(e.customer_id), Number(e.call_log_id), outcome, now)); } catch { /* plan stays as it is */ }
  }
  if (e.call_log_id != null) { // the live row wrote its call log at ring time; give it the final status
    const d = e.direction === "incoming" ? "تماس ورودی" : "تماس خروجی";
    executeChanges("UPDATE call_logs SET subject=? WHERE id=? AND subject IN (?,?)", [`${d} مرکز تماس (${e.status})`, e.call_log_id, `${d} مرکز تماس (RINGING)`, `${d} مرکز تماس (ACTIVE)`]);
  }
  if (u.role === "registrar" && e.call_log_id != null)
    executeChanges("UPDATE call_logs SET subject='پشتیبانی، ' || subject WHERE id=? AND subject LIKE '%مرکز تماس (%' AND subject NOT LIKE 'پشتیبانی، %'", [e.call_log_id]);
  else if (e.direction === "outgoing" && e.call_log_id != null)
    executeChanges("UPDATE call_logs SET subject='بیرون از صف، ' || subject WHERE id=? AND subject LIKE 'تماس خروجی مرکز تماس (%'", [e.call_log_id]);
  executeChanges("UPDATE s132b_events SET auto_at=?, auto_kind=?, first_form=?, note_state=? WHERE event_id=?",
    [iso(now), e.call_log_id != null ? "saved" : "no_log", firstForm, e.call_log_id != null && answered ? "pending" : "none", e.id]);
}
function noteTick(now: Date, userId: number | null) {
  const rows = queryRows<any>(`SELECT s.*, e.call_log_id log, COALESCE(e.recording_provider_id,e.external_id) pid, e.has_recording FROM s132b_events s
    JOIN voip_after_call_events e ON e.id=s.event_id WHERE s.note_state='pending'${userId == null ? "" : " AND s.user_id=?"} ORDER BY s.event_id LIMIT 50`, userId == null ? [] : [userId]);
  for (const r of rows) {
    try {
      const sum = r.pid ? storedCallSummary(r.pid) : null;
      const old = now.getTime() - Date.parse(r.auto_at) > NOTE_GIVE_UP_MIN * 60000;
      if (sum && sum.summaryState === "completed" && typeof sum.customerRequestSummary === "string" && sum.customerRequestSummary.trim()) {
        const subj = typeof sum.callSubject === "string" ? sum.callSubject.trim() : "";
        const note = noteText(subj ? `${subj}: ${sum.customerRequestSummary}` : sum.customerRequestSummary);
        savepoint(() => {
          if (!r.note_edited_at) {
            if (r.log != null) executeChanges("UPDATE call_logs SET expert_notes=? WHERE id=? AND COALESCE(expert_notes,'')=''", [note, r.log]);
            executeChanges("UPDATE voip_after_call_events SET expert_notes=? WHERE id=? AND COALESCE(expert_notes,'')=''", [note, r.event_id]);
          }
          executeChanges("UPDATE s132b_events SET note_state='ready', note=COALESCE(?,note) WHERE event_id=?", [r.note_edited_at ? null : note, r.event_id]);
        });
      } else if (sum?.summaryState === "failed" || (!r.has_recording && old) || old || r.note_edited_at) {
        executeChanges("UPDATE s132b_events SET note_state=? WHERE event_id=?", [r.note_edited_at ? "ready" : "failed", r.event_id]);
      }
    } catch { /* next tick */ }
  }
}
/** One pass over the covered experts' recent non-click calls. Never throws. */
export function s132bTick(now = new Date(), onlyUser: number | null = null) {
  if (!s132bAnyOn()) return;
  const ids = (onlyUser != null ? [onlyUser] : s132bUserIds()).filter((id) => onlyUser == null || s132bOn(getAuthUserById(id) as any));
  if (!ids.length) return;
  ensureS132bSchema();
  const since = new Date(Math.max(now.getTime() - DAYMS, Date.parse(tehranDayStartIso(now)) - 3600000)).toISOString();
  for (const id of ids) {
    const u = getAuthUserById(id); if (!u || !u.active) continue;
    const evs = queryRows<Ev>(`SELECT e.* FROM voip_after_call_events e LEFT JOIN s132b_events s ON s.event_id=e.id
      WHERE e.expert_user_id=? AND e.mobile_device_id IS NULL AND julianday(e.started_at)>=julianday(?) AND (s.event_id IS NULL OR s.auto_at IS NULL)
      AND (e.completed_at IS NULL OR s.event_id IS NOT NULL) ORDER BY e.id LIMIT 200`, [id, since]);
    for (const e of evs) { try { savepoint(() => processEvent(u, e, now)); } catch { /* the old popup flow is gone for B; retried next tick */ } }
  }
  noteTick(now, onlyUser);
}
export function s132bAfterIngest(now = new Date()) {
  try { if (!s132bAnyOn()) return; runImmediateTransaction(() => s132bTick(now, null)); } catch { /* next ingest */ }
}

/* ---------------- views ---------------- */
const durOf = (e: Ev) => String(e.status).toUpperCase() !== "ANSWERED" ? null : e.duration_seconds ?? Math.max(0, Math.round((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000));
function ownExt(u: U) { return queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [u.id])?.extension ?? null; }
function lastCallAt(customerId: number, notEvent: number) {
  return queryRow<{ at: string }>(`SELECT created_at at FROM call_logs WHERE customer_id=? AND id NOT IN (SELECT COALESCE(call_log_id,0) FROM voip_after_call_events WHERE id=?) ORDER BY created_at DESC LIMIT 1`, [customerId, notEvent])?.at ?? null;
}
function cardOf(u: U, e: Ev, s: any | null) {
  const c = custOf(e.customer_id);
  const cls = s132bClassify(u, e, c);
  const show = phoneShown(u, cls, c);
  return {
    id: e.id, direction: e.direction, live: !!e.is_live, status: e.status, startedAt: e.started_at, endedAt: e.is_live ? null : e.ended_at,
    durationSeconds: e.is_live ? null : durOf(e), extension: e.extension, cls,
    customer: c ? { id: c.id, name: c.name, priority: c.priority, ownerName: cls === "own" ? null : c.owner_name ?? "بدون کارشناس", lastCallAt: cls === "own" || cls === "support" ? lastCallAt(c.id, e.id) : null } : null,
    phone: show ? (normalizePhone(e.phone) ?? e.phone) : null,
    createdCustomer: s?.created_customer ?? null, saved: !!s?.auto_at && s?.auto_kind !== "click",
    note: s ? { state: s.note_state ?? null, text: s.note ?? null, edited: !!s.note_edited_at } : null,
    firstForm: !!s?.first_form && !s?.form_opened_at,
  };
}
/** GET /voip-call/b/live — the expert's own live / just-ended non-click calls (cards + toasts). */
export function s132bLive(u: AuthUser, now = new Date()) {
  ensureS132bSchema();
  s132bTick(now, u.id);
  const ext = ownExt(u);
  const rows = queryRows<Ev>(`SELECT e.* FROM voip_after_call_events e WHERE e.expert_user_id=? AND e.mobile_device_id IS NULL
    AND (e.extension IS NULL OR e.extension=?) AND julianday(e.started_at)>=julianday(?)
    AND (e.is_live=1 OR julianday(e.ended_at)>=julianday(?)-?/1440.0)
    AND NOT EXISTS (SELECT 1 FROM voip_call_display_exclusions h WHERE h.phone=e.phone)
    ORDER BY e.is_live DESC, e.id DESC LIMIT 6`, [u.id, ext ?? "", tehranDayStartIso(now), iso(now), CARD_KEEP_MIN]);
  const cards = [];
  for (const e of rows) {
    const s = queryRow<any>("SELECT * FROM s132b_events WHERE event_id=?", [e.id]);
    if (s?.auto_kind === "click" || s?.closed_at) continue;
    if (!s && isClickEvent(e)) continue;
    cards.push(cardOf(u, e, s));
  }
  return { cards: cards.slice(0, 3), busy: cards.some((c) => c.live) };
}
function ownEvent(u: U, id: number) {
  return queryRow<Ev>("SELECT * FROM voip_after_call_events WHERE id=? AND expert_user_id=? AND mobile_device_id IS NULL", [id, u.id]) ?? null;
}
const NOT_FOUND = { status: 404, body: { error: "not_found", message: "این تماس پیدا نشد." } };
export function s132bClose(u: AuthUser, id: number, now = new Date()) {
  ensureS132bSchema();
  const e = ownEvent(u, id); if (!e) return NOT_FOUND;
  if (!queryRow("SELECT 1 x FROM s132b_events WHERE event_id=?", [id]))
    executeChanges("INSERT OR IGNORE INTO s132b_events(event_id,user_id,kind,customer_id,created_at) VALUES(?,?,?,?,?)", [id, u.id, e.direction, e.customer_id, iso(now)]);
  executeChanges("UPDATE s132b_events SET closed_at=COALESCE(closed_at,?) WHERE event_id=?", [iso(now), id]);
  return { status: 200, body: { ok: true } };
}
export function s132bFormOpened(u: AuthUser, id: number, now = new Date()) {
  ensureS132bSchema();
  if (!ownEvent(u, id)) return NOT_FOUND;
  executeChanges("UPDATE s132b_events SET form_opened_at=COALESCE(form_opened_at,?) WHERE event_id=?", [iso(now), id]);
  return { status: 200, body: { ok: true } };
}
const nameError = (name: string) => [...name].length < 3 || [...name].length > 80 || /[\d۰-۹٠-٩]/.test(name) || !name.includes(" ");
const NAME_BAD = { status: 422, body: { error: "invalid_name", message: "نام و نام خانوادگی مشتری را کامل بنویس (بدون عدد)." } };
/** POST /voip-call/b/:id/name — «نام مشتری» + «ذخیره» on the new-number toast (outgoing, own call). */
export function s132bSaveName(u: AuthUser, id: number, body: any, now = new Date()) {
  ensureS132bSchema();
  const e = ownEvent(u, id); if (!e || e.direction !== "outgoing") return NOT_FOUND;
  if (u.role === "registrar" || u.salespersonId == null) return { status: 403, body: { error: "not_allowed", message: "ساختن مشتری از این تماس برای شما نیست." } };
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();
  if (nameError(name)) return NAME_BAD;
  const s = queryRow<any>("SELECT * FROM s132b_events WHERE event_id=?", [id]);
  const existing = e.customer_id ?? (customerMatcher()(e.phone)?.id ?? null);
  if (existing != null && Number(existing) !== Number(s?.created_customer ?? -1)) {
    const c = custOf(Number(existing));
    if (!c || Number(c.salesperson_id) !== Number(u.salespersonId)) return { status: 409, body: { error: "other_owner", message: "این شماره مشتری کارشناس دیگری است؛ برای تو مشتری ساخته نمی‌شود.", ownerName: c?.owner_name ?? null } };
    return { status: 409, body: { error: "exists", message: "این شماره در CRM هست.", customer: { id: c.id, name: c.name } } };
  }
  let cid = s?.created_customer != null ? Number(s.created_customer) : null;
  if (cid != null) executeChanges("UPDATE customers SET name=? WHERE id=? AND name=?", [name, cid, S132B_NONAME]);
  else {
    try { cid = createForNumber(u, e.phone, name, "other"); }
    catch (err) { if (err instanceof Error && /CONFLICT/.test(err.message)) return { status: 409, body: { error: "exists", message: "این شماره در CRM هست." } }; throw err; }
    if (cid == null) return { status: 422, body: { error: "invalid_phone", message: "این شماره موبایل نیست؛ مشتری ساخته نشد." } };
  }
  if (!s) executeChanges("INSERT OR IGNORE INTO s132b_events(event_id,user_id,kind,cls,created_at) VALUES(?,?,?,'new',?)", [id, u.id, e.direction, iso(now)]);
  executeChanges("UPDATE s132b_events SET created_customer=? WHERE event_id=?", [cid, id]);
  linkCustomer(id, cid);
  return { status: 200, body: { ok: true, customer: { id: cid, name, priority: 1 } } };
}
/** POST /voip-call/b/customers/:id/name — «کامل کردن نام» of a B-created «بدون نام» customer of mine. */
export function s132bCompleteName(u: AuthUser, customerId: number, body: any) {
  ensureS132bSchema();
  const c = queryRow<{ id: number }>(`SELECT c.id FROM customers c WHERE c.id=? AND c.name=? AND c.salesperson_id=? AND c.merged_into_customer_id IS NULL
    AND EXISTS (SELECT 1 FROM s132b_events s WHERE s.created_customer=c.id AND s.user_id=?)`, [customerId, S132B_NONAME, u.salespersonId ?? -1, u.id]);
  if (!c) return { status: 404, body: { error: "not_found", message: "این مشتری پیدا نشد." } };
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();
  if (nameError(name)) return NAME_BAD;
  executeChanges("UPDATE customers SET name=? WHERE id=? AND name=?", [name, customerId, S132B_NONAME]);
  return { status: 200, body: { ok: true, customer: { id: customerId, name } } };
}
export function s132bNoName(u: U) {
  if (!ready()) return [];
  return queryRows<{ id: number; createdAt: string }>(`SELECT DISTINCT c.id, c.created_at createdAt FROM customers c JOIN s132b_events s ON s.created_customer=c.id
    WHERE s.user_id=? AND c.name=? AND c.salesperson_id=? AND c.merged_into_customer_id IS NULL ORDER BY c.id LIMIT 20`, [u.id, S132B_NONAME, u.salespersonId ?? -1]);
}
/** POST /voip-call/b/:id/note — edit the auto note («یادداشت از خلاصه‌ی تماس»). */
export function s132bNote(u: AuthUser, id: number, body: any, now = new Date()) {
  ensureS132bSchema();
  const e = ownEvent(u, id); if (!e) return NOT_FOUND;
  const note = noteText(body?.note);
  if (!note) return { status: 422, body: { error: "empty_note", message: "یادداشت خالی است." } };
  if (!queryRow("SELECT 1 x FROM s132b_events WHERE event_id=?", [id]))
    executeChanges("INSERT OR IGNORE INTO s132b_events(event_id,user_id,kind,customer_id,created_at) VALUES(?,?,?,?,?)", [id, u.id, e.direction, e.customer_id, iso(now)]);
  executeChanges("UPDATE s132b_events SET note=?, note_edited_at=?, note_state='ready' WHERE event_id=?", [note, iso(now), id]);
  if (e.call_log_id != null) executeChanges("UPDATE call_logs SET expert_notes=? WHERE id=?", [note, e.call_log_id]);
  executeChanges("UPDATE voip_after_call_events SET expert_notes=? WHERE id=?", [note, id]);
  return { status: 200, body: { ok: true, note } };
}

/* ---------------- missed calls today (§7.2) ---------------- */
export function s132bMissed(u: AuthUser, now = new Date()) {
  const ext = ownExt(u); const sp = u.salespersonId == null ? null : Number(u.salespersonId);
  const from = tehranDayStartIso(now);
  const evs = queryRows<Ev>(`SELECT e.* FROM voip_after_call_events e WHERE e.direction='incoming' AND e.mobile_device_id IS NULL AND julianday(e.started_at)>=julianday(?)
    AND NOT EXISTS (SELECT 1 FROM voip_call_display_exclusions h WHERE h.phone=e.phone) ORDER BY e.started_at`, [from]);
  const answeredAt = new Map<string, number>();
  for (const e of queryRows<{ phone: string; started_at: string }>(`SELECT phone, started_at FROM voip_after_call_events WHERE UPPER(status)='ANSWERED' AND julianday(started_at)>=julianday(?)`, [from])) {
    const p = normalizePhone(e.phone); if (p) answeredAt.set(p, Math.max(answeredAt.get(p) ?? 0, Date.parse(e.started_at)));
  }
  const match = customerMatcher();
  const firstRang = (p: string, e: Ev) => evs.filter((x) => x.extension && normalizePhone(x.phone) === p && Math.abs(Date.parse(x.started_at) - Date.parse(e.started_at)) < 180000)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0]?.extension ?? null;
  const by = new Map<string, { kind: "mine" | "queue"; times: number; last: string; customerId: number | null }>();
  for (const e of evs) {
    if (e.is_live || String(e.status).toUpperCase() === "ANSWERED") continue;
    const p = normalizePhone(e.phone); if (!p) continue;
    const xs = (() => { try { return JSON.parse(e.extensions_json || "[]") as string[]; } catch { return []; } })();
    const cid = e.customer_id ?? (match(e.phone)?.id ?? null);
    let kind: "mine" | "queue" | null = null;
    if (ext && (e.extension === ext || xs.includes(ext))) kind = "mine";
    else if (!e.extension && !xs.length) {
      const c = cid != null ? custOf(Number(cid)) : null;
      if (c && sp != null && Number(c.salesperson_id) === sp) kind = "queue";
      else if (!c && ext && firstRang(p, e) === ext) kind = "queue";
    }
    if (!kind) continue;
    const g = by.get(p);
    if (g) { g.times++; g.last = e.started_at; g.kind = kind; g.customerId = g.customerId ?? cid; } else by.set(p, { kind, times: 1, last: e.started_at, customerId: cid });
  }
  const today = tehranDay(now);
  const out = [];
  for (const [p, g] of by) {
    if ((answeredAt.get(p) ?? 0) >= Date.parse(g.last) - 60000) continue; // a later answered call removes the row
    const c = g.customerId != null ? custOf(Number(g.customerId)) : null;
    const cls = s132bClassify(u, { phone: p, direction: "incoming" }, c);
    let task: number | null = null;
    if (c && cls === "own" && sp != null && tableExists("dp_items")) {
      task = queryRow<{ pos: number }>(`SELECT i.position pos FROM dp_plans pl JOIN dp_items i ON i.plan_id=pl.id WHERE pl.salesperson_id=? AND pl.day=?
        AND i.customer_id=? AND i.status IN ('current','pending') ORDER BY i.id LIMIT 1`, [sp, today, c.id])?.pos ?? null;
      if (task != null) task = Number(task) + 1;
    }
    out.push({ key: p.slice(-4) + "-" + g.last, kind: g.kind, times: g.times, lastAt: g.last, cls,
      customer: c ? { id: c.id, name: c.name, ownerName: cls === "own" ? null : c.owner_name ?? "بدون کارشناس" } : null,
      phone: phoneShown(u, cls, c) ? p : null, task, redial: !!c && cls === "own" });
  }
  out.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return { rows: out.slice(0, 50), count: out.length };
}
export function s132bMissedCount(u: AuthUser, now = new Date()) { try { return s132bMissed(u, now).count; } catch { return 0; } }

/* ---------------- manager report (§7.3) ---------------- */
export function s132bReport(range: string, now = new Date()) {
  const t = now.getTime();
  const fromMs = range === "month" ? jalaliMonthStart(t) : range === "week" ? tehranWeekStart(t) : Date.parse(tehranDayStartIso(now));
  const from = new Date(fromMs).toISOString();
  const people = queryRows<{ id: number; name: string; role: string; extension: string }>(`SELECT u.id, COALESCE(NULLIF(TRIM(u.full_name),''),u.username) name, u.role, x.extension
    FROM users u JOIN voip_extensions x ON x.user_id=u.id WHERE x.extension IS NOT NULL AND u.active=1 AND u.role<>'admin' ORDER BY name`);
  const states = new Map<string, { state: string; since: string }>();
  if (tableExists("s132b_ext_state")) for (const r of queryRows<{ extension: string; state: string; since: string }>("SELECT * FROM s132b_ext_state")) states.set(r.extension, r);
  const liveOf = (p: { id: number; extension: string }) => {
    const l = queryRow<{ status: string; started_at: string }>(`SELECT status, started_at FROM voip_after_call_events WHERE is_live=1 AND extension=? ORDER BY id DESC LIMIT 1`, [p.extension]);
    if (l) return { state: String(l.status).toUpperCase() === "RINGING" ? "ring" : "talk", since: l.started_at };
    const s = states.get(p.extension);
    if (s && (s.state === "pause" || s.state === "off")) return s;
    return { state: s?.state === "ring" || s?.state === "talk" ? "free" : s?.state ?? "free", since: s?.since ?? null };
  };
  const live = people.map((p) => ({ userId: p.id, name: p.name, extension: p.extension, support: p.role === "registrar", ...liveOf(p) }));
  const experts = people.filter((p) => p.role !== "registrar").map((p) => {
    const evs0 = queryRows<Ev>(`SELECT * FROM voip_after_call_events WHERE expert_user_id=? AND is_live=0 AND mobile_device_id IS NULL AND julianday(started_at)>=julianday(?)
      AND julianday(started_at)<julianday(?)`, [p.id, from, iso(now)]);
    // a queue call that rang this extension but a colleague answered is not this expert's miss (same number answered within 3 min)
    const takenBy = (e: Ev) => !!queryRow(`SELECT 1 x FROM voip_after_call_events WHERE UPPER(status)='ANSWERED' AND id<>? AND phone=?
      AND ABS(julianday(started_at)-julianday(?))*86400<180 LIMIT 1`, [e.id, e.phone, e.started_at]);
    const evs = evs0.filter((e) => e.direction !== "incoming" || String(e.status).toUpperCase() === "ANSWERED" || !takenBy(e));
    const ans = evs.filter((e) => String(e.status).toUpperCase() === "ANSWERED");
    const talk = ans.reduce((s, e) => s + (durOf(e) ?? 0), 0);
    const missedIn = evs.filter((e) => e.direction === "incoming" && String(e.status).toUpperCase() !== "ANSWERED").length;
    return { userId: p.id, name: p.name, calls: evs.length, answered: ans.length, answerRate: evs.length ? Math.round((ans.length / evs.length) * 100) : null,
      talkSeconds: talk, avgSeconds: ans.length ? Math.round(talk / ans.length) : null, missedIncoming: missedIn };
  });
  return { range: range === "month" || range === "week" ? range : "today", from, to: iso(now), live, experts };
}

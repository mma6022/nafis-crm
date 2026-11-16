/**
 * REMINDER-VOIP (Armita «تماس ویپ روی یادآورها» v1.1, nafis-design/screens/reminder-voip; Mohammad t884s3627 / t885u).
 *
 * flag.reminder_voip = '1' (global) or flag.reminder_voip.user.<id> = '1' (call_queue_settings). Absent / anything else = OFF →
 * every endpoint answers 404 reminder_voip_off and the Reminders pages render exactly as before.
 *
 * What it adds (nothing else changes):
 *  - GET  /reminder-voip/meta?ids=…   per reminder of the CALLER (reminders.user_id = caller): kind (internal / own / no_phone / other /
 *    support_own / support_other), the number only for the caller's own customer (or, for a scoped registrar, a customer she registered),
 *    the owner's name + extension for another expert's customer (no notification of any kind), first-call hint, linked click call, saved result.
 *  - POST /reminder-voip/:id/start    the existing VoIP click call (vcStart: vcCustomerAllowed, one_call, no_extension unchanged) for that
 *    reminder's customer, linked to the reminder. SIMOTEL-132 still saves the call by itself (status from the CDR, first call → first-call form).
 *  - POST /reminder-voip/:id/result   result (پاسخ داد / پاسخ نداد / پیگیری بعدی) + one-line note (1–80 chars) → reminder «انجام شد».
 *    With a VoIP call no extra call log is created (SIMOTEL-132 already saves one): the note is put on that log once it exists.
 *    Without VoIP the client saves the normal call (POST /calls) first and passes its callLogId.
 *  - A first call (SIMOTEL-132 first_call): the existing required first-call form; when it is saved, the reminder is marked done (meta sweep).
 *
 * Additive table reminder_voip only. No SMS, Bale, bell or staff notification; never touches stage, owner, priority, contracts or templates.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { vcCustomerAllowed, vcOn, vcStart } from "./voip-call";
import { s132IsFirstCall, s132On } from "./simotel132";
import { vcIsScopedRegistrar } from "./voip-registrar-scope";
import { vthRelease } from "./voip-task-hold";

type U = { id: number; role?: string | null; salespersonId?: number | null; customerScope?: string | null };
type Err = { status: number; body: { error: string; message: string; details?: unknown } };
const err = (status: number, error: string, message: string, details?: unknown): Err => ({ status, body: { error, message, ...(details !== undefined ? { details } : {}) } });
const iso = (d: Date) => d.toISOString();
const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; }
};
export const RV_FLAG = "flag.reminder_voip";
export function rvFlagOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting(RV_FLAG) === "1" || setting(`${RV_FLAG}.user.${Number(userId)}`) === "1";
}
export const rvOn = (u: U | null | undefined): boolean => !!u && rvFlagOn(u.id);
export const RV_OUTCOMES = ["answered", "no_answer", "follow_up"] as const;
export type RvOutcome = (typeof RV_OUTCOMES)[number];
export const RV_NOTE_MAX = 80;
export const RV_MAX_IDS = 300;

let ready = false;
export function ensureRvSchema() {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS reminder_voip(id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      customer_id INTEGER, call_id INTEGER, call_log_id INTEGER, first_call INTEGER NOT NULL DEFAULT 0, started_at TEXT,
      outcome TEXT, note TEXT, note_applied INTEGER NOT NULL DEFAULT 0, saved_at TEXT, source TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_reminder_voip_rem ON reminder_voip(reminder_id, id);
    CREATE INDEX IF NOT EXISTS idx_reminder_voip_call ON reminder_voip(call_id);`);
  ready = true;
}

const spOf = (u: U): number | null => (u.salespersonId != null && Number(u.salespersonId) > 0 ? Number(u.salespersonId) : null);
const tableExists = (n: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [n]);
const cleanPhone = (raw: string | null | undefined): string => {
  const d = String(raw ?? "").replace(/[۰-۹]/g, (x) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(x))).replace(/[٠-٩]/g, (x) => String("٠١٢٣٤٥٦٧٨٩".indexOf(x)))
    .replace(/^\+98/, "0").replace(/[^\d]/g, "");
  return d.length >= 7 ? d : "";
};
export function rvNoteText(v: unknown): string { return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(); }

/** The caller may use VoIP «تماس» here: VoIP on (flag + extension) + SIMOTEL-132 (auto save, first-call form) + a salesperson or a scoped registrar. */
export const rvVoip = (u: U): boolean => (spOf(u) != null || vcIsScopedRegistrar(u)) && vcOn(u) && s132On(u);

type RemRow = { id: number; user_id: number; customer_id: number | null; done: number; voided_at: string | null; subject: string | null; remind_at: string };
type CustRow = { id: number; name: string | null; phone: string | null; salesperson_id: number | null; registered_by: number | null; owner_name: string | null };
export type RvKind = "internal" | "own" | "other" | "support_own" | "support_other";
function custOf(id: number): CustRow | undefined {
  return queryRow<CustRow>(`SELECT c.id, c.name, c.phone, c.salesperson_id, c.registered_by, s.name owner_name FROM customers c
    LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=? AND c.merged_into_customer_id IS NULL`, [id]);
}
/** Whose customer this is for the caller. Registrar (scoped): «پشتیبانی»; own = customers she registered herself (design §tajik). */
function kindOf(u: U, c: CustRow | undefined): RvKind {
  if (!c) return "internal";
  if (vcIsScopedRegistrar(u)) return c.registered_by != null && Number(c.registered_by) === Number(u.id) ? "support_own" : "support_other";
  const sp = spOf(u);
  return sp != null && Number(c.salesperson_id) === sp ? "own" : "other";
}
function ownerExt(salespersonId: number | null): string | null {
  if (salespersonId == null) return null;
  try {
    return queryRow<{ extension: string | null }>(`SELECT v.extension FROM users us JOIN voip_extensions v ON v.user_id=us.id
      WHERE us.salesperson_id=? AND us.active=1 AND COALESCE(v.extension,'')<>'' ORDER BY us.id LIMIT 1`, [salespersonId])?.extension ?? null;
  } catch { return null; }
}
function firstCallHint(u: U, customerId: number): boolean {
  try { return s132IsFirstCall(u as any, customerId); } catch { return false; }
}

type RvRow = { id: number; reminder_id: number; user_id: number; customer_id: number | null; call_id: number | null; call_log_id: number | null;
  first_call: number; started_at: string | null; outcome: string | null; note: string | null; note_applied: number; saved_at: string | null; source: string | null; created_at: string };

/** call_logs row a click call ended up in (SIMOTEL-132 auto save or the first-call form), if any. */
function callLogOf(callId: number): number | null {
  try {
    if (tableExists("s132_calls")) {
      const s = queryRow<{ call_log_id: number | null }>("SELECT call_log_id FROM s132_calls WHERE call_id=?", [callId]);
      if (s?.call_log_id) return Number(s.call_log_id);
    }
    const e = queryRow<{ call_log_id: number | null }>(`SELECT e.call_log_id FROM voip_click_calls c JOIN voip_after_call_events e ON e.id=c.event_id WHERE c.id=?`, [callId]);
    return e?.call_log_id ? Number(e.call_log_id) : null;
  } catch { return null; }
}
/** The expert's one-line note goes on top of that call log (never twice; a later call summary is appended below by CT-FASTNOTE as before). */
function applyNote(logId: number, note: string) {
  executeChanges(`UPDATE call_logs SET expert_notes=CASE WHEN COALESCE(expert_notes,'')='' THEN ?
      WHEN instr(expert_notes, ?)>0 THEN expert_notes ELSE ? || char(10) || expert_notes END,
      one_line_note=CASE WHEN COALESCE(one_line_note,'')='' THEN ? ELSE one_line_note END WHERE id=?`, [note, note, note, note, logId]);
}
/** Pending notes (VoIP result saved before SIMOTEL-132 wrote the log) + first calls whose required form was saved → reminder done. */
function sweep(u: U, now: Date) {
  ensureRvSchema();
  for (const r of queryRows<RvRow>(`SELECT * FROM reminder_voip WHERE user_id=? AND saved_at IS NOT NULL AND note_applied=0 AND call_id IS NOT NULL
      AND julianday(saved_at)>=julianday(?)-2 ORDER BY id DESC LIMIT 20`, [u.id, iso(now)])) {
    const log = callLogOf(Number(r.call_id));
    if (log && r.note) { applyNote(log, r.note); executeChanges("UPDATE reminder_voip SET note_applied=1, call_log_id=? WHERE id=?", [log, r.id]); }
  }
  for (const r of queryRows<RvRow>(`SELECT v.* FROM reminder_voip v JOIN reminders m ON m.id=v.reminder_id WHERE v.user_id=? AND v.first_call=1
      AND v.saved_at IS NULL AND v.call_id IS NOT NULL AND m.done=0 AND m.voided_at IS NULL AND julianday(v.created_at)>=julianday(?)-2 ORDER BY v.id DESC LIMIT 20`, [u.id, iso(now)])) {
    let doneForm = false;
    try { doneForm = tableExists("s132_calls") && !!queryRow("SELECT 1 x FROM s132_calls WHERE call_id=? AND auto_kind='first_done'", [r.call_id]); } catch { doneForm = false; }
    const log = queryRow<{ id: number; call_result: string | null; one_line_note: string | null; expert_notes: string | null }>(
      `SELECT id, call_result, one_line_note, expert_notes FROM call_logs WHERE customer_id=? AND COALESCE(call_result,'')<>'' AND created_at>=? ORDER BY id DESC LIMIT 1`,
      [r.customer_id, r.started_at ?? r.created_at]);
    if (!doneForm && !log) continue;
    const res = String(log?.call_result ?? "");
    const outcome: RvOutcome = /no_answer|unanswered|busy|off|unreach/i.test(res) ? "no_answer" : /follow/i.test(res) ? "follow_up" : "answered";
    const note = rvNoteText(log?.one_line_note || log?.expert_notes || "").slice(0, RV_NOTE_MAX) || "فرم تماس اول ثبت شد";
    runTransaction(() => {
      executeChanges("UPDATE reminder_voip SET outcome=?, note=?, note_applied=1, saved_at=?, source='first_form', call_log_id=? WHERE id=? AND saved_at IS NULL",
        [outcome, note, iso(now), log?.id ?? null, r.id]);
      executeChanges("UPDATE reminders SET done=1, closed_at=COALESCE(closed_at,?), closed_by_call_id=COALESCE(closed_by_call_id,?) WHERE id=? AND user_id=? AND done=0",
        [iso(now), log?.id ?? null, r.reminder_id, u.id]);
    });
  }
}

export function rvMeta(u: U, rawIds: unknown, now = new Date()) {
  ensureRvSchema();
  try { sweep(u, now); } catch { /* best effort */ }
  const ids = [...new Set(String(rawIds ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, RV_MAX_IDS);
  const voip = rvVoip(u);
  const items: Record<string, unknown> = {};
  if (ids.length) {
    const rows = queryRows<RemRow>(`SELECT id, user_id, customer_id, done, voided_at, subject, remind_at FROM reminders WHERE user_id=? AND id IN (${ids.map(() => "?").join(",")})`, [u.id, ...ids]);
    for (const r of rows) {
      const c = r.customer_id ? custOf(Number(r.customer_id)) : undefined;
      const kind = kindOf(u, c);
      const phone = c && (kind === "own" || kind === "support_own") ? cleanPhone(c.phone) : "";
      const link = queryRow<RvRow>("SELECT * FROM reminder_voip WHERE reminder_id=? AND user_id=? ORDER BY id DESC LIMIT 1", [r.id, u.id]);
      const saved = queryRow<RvRow>("SELECT * FROM reminder_voip WHERE reminder_id=? AND user_id=? AND saved_at IS NOT NULL ORDER BY id DESC LIMIT 1", [r.id, u.id]);
      items[String(r.id)] = {
        id: r.id, kind, customerId: c?.id ?? null,
        hasPhone: kind === "own" || kind === "support_own" ? Boolean(phone) : Boolean(c && cleanPhone(c.phone)),
        phone: phone || null,
        ownerName: c && kind !== "own" ? (c.owner_name ?? null) : null,
        ownerExt: c && kind === "other" ? ownerExt(c.salesperson_id) : null,
        firstCall: Boolean(voip && c && kind === "own" && !r.done && firstCallHint(u, c.id)),
        callId: link && !link.saved_at && link.call_id ? Number(link.call_id) : null,
        callFirst: Boolean(link && !link.saved_at && link.first_call),
        result: saved ? { outcome: saved.outcome, note: saved.note, savedAt: saved.saved_at, source: saved.source } : null,
      };
    }
  }
  return { status: 200, body: { on: true, voip, registrar: vcIsScopedRegistrar(u), items } };
}

function ownOpen(u: U, id: number): RemRow | Err {
  const r = queryRow<RemRow>("SELECT id, user_id, customer_id, done, voided_at, subject, remind_at FROM reminders WHERE id=?", [id]);
  if (!r || Number(r.user_id) !== Number(u.id) || r.voided_at) return err(404, "not_found", "این یادآور پیدا نشد.");
  if (!r.customer_id) return err(422, "no_customer", "این یادآور مشتری ندارد (کار داخلی).");
  return r;
}
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "status" in (x as any) && "body" in (x as any);

export async function rvStart(u: U, id: number, now = new Date()) {
  ensureRvSchema();
  const r = ownOpen(u, id); if (isErr(r)) return r;
  if (r.done) return err(409, "already_done", "این یادآور انجام شده است.");
  if (!rvVoip(u)) return err(422, "no_voip", "برای تو تماس ویپ فعال نیست.");
  const c = custOf(Number(r.customer_id));
  const kind = kindOf(u, c);
  if (kind !== "own" && kind !== "support_own") return err(403, "not_own_customer", kind === "support_other" ? "این مشتری را خودت ثبت‌نام نکرده‌ای." : "فقط با مشتری خودت می‌توانی تماس بگیری.");
  if (!vcCustomerAllowed(u as any, Number(r.customer_id))) return err(403, "not_own_customer", "فقط با مشتری خودت می‌توانی تماس بگیری.");
  if (!cleanPhone(c?.phone)) return err(422, "no_phone", "شماره‌ی این مشتری ثبت نشده است.");
  const res: any = await vcStart(u as any, { customerId: Number(r.customer_id), fileId: null, entry: "reminder", reminderId: r.id }, now);
  if (res?.status === 200 && res.body?.call?.id) {
    const callId = Number(res.body.call.id);
    let first = 0;
    try { first = tableExists("s132_calls") ? Number(queryRow<{ f: number }>("SELECT first_call f FROM s132_calls WHERE call_id=?", [callId])?.f ?? 0) : 0; } catch { first = 0; }
    execute("INSERT INTO reminder_voip(reminder_id,user_id,customer_id,call_id,first_call,started_at,created_at) VALUES(?,?,?,?,?,?,?)",
      [r.id, u.id, r.customer_id, callId, first ? 1 : 0, String(res.body.call.createdAt ?? iso(now)), iso(now)]);
    res.body.firstCall = Boolean(first);
  }
  return res as { status: number; body: any };
}

export function rvResult(u: U, id: number, b: any, now = new Date()) {
  ensureRvSchema();
  const r = ownOpen(u, id); if (isErr(r)) return r;
  const outcome = String(b?.outcome ?? "");
  if (!(RV_OUTCOMES as readonly string[]).includes(outcome)) return err(422, "outcome_required", "نتیجه‌ی تماس را انتخاب کن.", { allowed: RV_OUTCOMES });
  const note = rvNoteText(b?.note);
  if (!note) return err(422, "note_required", "یادداشت یک‌خطی را بنویس.");
  if ([...note].length > RV_NOTE_MAX) return err(422, "note_too_long", `یادداشت حداکثر ${RV_NOTE_MAX.toLocaleString("fa-IR")} نویسه باشد.`);
  const callId = b?.callId == null ? null : Number(b.callId);
  const callLogId = b?.callLogId == null ? null : Number(b.callLogId);
  if (r.done) {
    const prev = queryRow<RvRow>("SELECT * FROM reminder_voip WHERE reminder_id=? AND user_id=? AND saved_at IS NOT NULL ORDER BY id DESC LIMIT 1", [r.id, u.id]);
    if (prev) return { status: 200, body: { ok: true, replayed: true, result: { outcome: prev.outcome, note: prev.note, savedAt: prev.saved_at, source: prev.source } } };
    return err(409, "already_done", "این یادآور انجام شده است.");
  }
  let link: RvRow | undefined; let logId: number | null = null; let source: "voip" | "manual";
  if (callId != null) {
    if (!Number.isSafeInteger(callId) || callId <= 0) return err(400, "bad_call", "تماس معتبر نیست.");
    link = queryRow<RvRow>("SELECT * FROM reminder_voip WHERE reminder_id=? AND user_id=? AND call_id=? ORDER BY id DESC LIMIT 1", [r.id, u.id, callId]);
    const c = queryRow<{ user_id: number; customer_id: number; active: number }>("SELECT user_id, customer_id, active FROM voip_click_calls WHERE id=?", [callId]);
    if (!link || !c || Number(c.user_id) !== Number(u.id) || Number(c.customer_id) !== Number(r.customer_id)) return err(404, "call_not_found", "این تماس پیدا نشد.");
    if (c.active) return err(409, "still_active", "تماس هنوز در جریان است.");
    logId = callLogOf(callId); source = "voip";
  } else if (callLogId != null) {
    if (!Number.isSafeInteger(callLogId) || callLogId <= 0) return err(400, "bad_call", "تماس معتبر نیست.");
    const l = queryRow<{ customer_id: number; created_by_user_id: number | null; created_at: string }>("SELECT customer_id, created_by_user_id, created_at FROM call_logs WHERE id=?", [callLogId]);
    if (!l || Number(l.customer_id) !== Number(r.customer_id) || (l.created_by_user_id != null && Number(l.created_by_user_id) !== Number(u.id))) return err(404, "call_not_found", "این تماس پیدا نشد.");
    logId = callLogId; source = "manual";
  } else return err(422, "call_required", "اول تماس را ثبت کن.");
  const at = iso(now);
  runTransaction(() => {
    if (logId != null && source === "voip") applyNote(logId, note);
    if (link) executeChanges("UPDATE reminder_voip SET outcome=?, note=?, note_applied=?, saved_at=?, source=?, call_log_id=? WHERE id=?",
      [outcome, note, logId != null || source === "manual" ? 1 : 0, at, source, logId, link.id]);
    else execute("INSERT INTO reminder_voip(reminder_id,user_id,customer_id,call_log_id,outcome,note,note_applied,saved_at,source,created_at) VALUES(?,?,?,?,?,?,1,?,?,?)",
      [r.id, u.id, r.customer_id, logId, outcome, note, at, source, at]);
    executeChanges("UPDATE reminders SET done=1, closed_at=COALESCE(closed_at,?), closed_by_call_id=COALESCE(closed_by_call_id,?) WHERE id=? AND user_id=? AND done=0",
      [at, logId, r.id, u.id]);
    if (callId != null) {
      executeChanges("UPDATE voip_click_calls SET result_saved_at=COALESCE(result_saved_at,?), result_outcome=? WHERE id=? AND user_id=?", [at, outcome, callId, u.id]);
      try { vthRelease(callId, now); } catch { /* additive */ }
    }
  });
  return { status: 200, body: { ok: true, result: { outcome, note, savedAt: at, source } } };
}
/** Expert lockdown: the reminder's customer (own reminder only), or [] for the own-only meta read. null = not ours. */
export function rvLockdownIds(method: string, path: string, userId: number): number[] | null {
  if (!path.startsWith("/reminder-voip/") || !rvFlagOn(userId)) return null;
  if (method === "GET" && path === "/reminder-voip/meta") return [];
  const m = /^\/reminder-voip\/(\d+)\/(start|result)$/.exec(path);
  if (!m || method !== "POST") return null;
  const r = queryRow<{ customer_id: number | null }>("SELECT customer_id FROM reminders WHERE id=? AND user_id=?", [Number(m[1]), userId]);
  return r?.customer_id ? [Number(r.customer_id)] : [];
}

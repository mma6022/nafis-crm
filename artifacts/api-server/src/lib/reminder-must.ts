/**
 * REMINDER-B (assistants75, Armita crm-reminder-incoming v1.1 scenes 08–15) — the mandatory due-reminder popup.
 * Behind flag.reminder_must (call_queue_settings, '1' = on; absent/anything else = off) AND only for the expert-lockdown
 * users (EL_USERS: 8, 2, 3 with their own salesperson id). Everyone else, and everybody while the flag is off: 404 reminder_must_off.
 *  - Queue = the expert's OWN (not merged) customers' open reminders that are due now, ordered by time (remind_at, id).
 *    Only reminders due at/after the moment the flag was switched ON (call_queue_settings.updated_at) — the older backlog
 *    stays in «یادآورها» exactly as before (no flood on activation).
 *  - Delivered only during working time (toWorkingTime: Sat–Thu 09:00–18:00 Tehran, no official holiday). A reminder that fell
 *    due outside working time opens at the first login / first poll inside working time (flag outsideHours → scene 15 label).
 *  - Exactly ONE 10-minute snooze per queue episode (server-enforced, survives reload/device change): the episode is every
 *    reminder already due when the snooze was taken; a second snooze while any of them is still open → 409 snooze_used.
 *  - Completing = the expert's call (POST /calls «خارج از لیست», same path as the incoming-call form → daily-plan logic stays
 *    identical) + POST /reminder-must/:id/complete which, in ONE transaction, closes the reminder with that call and creates the
 *    next reminder (in-app only: reminder_sms_deliveries rejected/in_app_only). No SMS, Bale, customer message or staff bell.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { cqRaw, fromTehran, nextWorkDayAt, toWorkingTime, tParts, isWorkDay } from "./call-queue";
import { EL_USERS, elCustomerAccess, elLocked } from "./expert-lockdown";
import { maskPhonesInText } from "./lead-annotator";

export const RM_FLAG_KEY = "flag.reminder_must";
export const RM_SNOOZE_MIN = 10;
export const RM_NOTE_MIN = 10, RM_NOTE_MAX = 80, RM_REASON_MIN = 3, RM_REASON_MAX = 80;
export const RM_OUTCOMES = ["answered", "no_answer", "follow_up"] as const;
export const RM_NEXT = ["tomorrow_am", "today_pm", "in_3_days", "none"] as const;
type U = { id: number; role: string; salespersonId: number | null; fullName?: string | null } | null | undefined;
type Err = { status: number; error: string; message: string; details?: unknown };
const err = (status: number, error: string, message: string, details?: unknown): Err => ({ status, error, message, details });
export const rmIsErr = (x: unknown): x is Err => Boolean(x && typeof x === "object" && "error" in (x as any) && "status" in (x as any));

export const rmTarget = (u: U): boolean =>
  Boolean(u && u.role === "salesperson" && EL_USERS[Number(u.id)] != null && Number(u.salespersonId) === EL_USERS[Number(u.id)]);
function flagRow(): { value: string; updated_at: string } | null {
  try { return queryRow<{ value: string; updated_at: string }>("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [RM_FLAG_KEY]) ?? null; } catch { return null; }
}
export const rmFlagOn = (): boolean => { try { return cqRaw(RM_FLAG_KEY) === "1"; } catch { return false; } };
export const rmOn = (u: U): boolean => rmTarget(u) && rmFlagOn();

let ready = false;
function ensure(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS rm_must_state(user_id INTEGER PRIMARY KEY, snooze_until TEXT, snooze_through TEXT, snoozed_at TEXT);
    CREATE TABLE IF NOT EXISTS rm_must_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, reminder_id INTEGER, action TEXT NOT NULL,
      call_id INTEGER, next_reminder_id INTEGER, data TEXT, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_rm_must_log_user ON rm_must_log(user_id, at);
    CREATE INDEX IF NOT EXISTS idx_rm_must_log_rem ON rm_must_log(reminder_id, action);`);
  ready = true;
}
const log = (u: NonNullable<U>, reminderId: number | null, action: string, at: string, extra: { callId?: number | null; nextId?: number | null; data?: unknown } = {}) =>
  execute("INSERT INTO rm_must_log(user_id,reminder_id,action,call_id,next_reminder_id,data,at) VALUES(?,?,?,?,?,?,?)",
    [Number(u.id), reminderId, action, extra.callId ?? null, extra.nextId ?? null, extra.data == null ? null : JSON.stringify(extra.data), at]);

const maskPhone = (p: string | null | undefined): string => {
  const s = String(p ?? "").replace(/\D/g, "");
  return s.length >= 8 ? `${s.slice(0, 4)}***${s.slice(-4)}` : s ? "***" : "";
};
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t; };

type Row = { id: number; customer_id: number; subject: string | null; message: string | null; remind_at: string; created_at: string; source: string | null;
  created_by: number | null; user_id: number; name: string; phone: string | null; by_name: string | null };
/** The expert's due queue (own customers, flag-on onwards), time order. */
function dueRows(u: NonNullable<U>, now: Date): Row[] {
  const f = flagRow(); if (!f || f.value !== "1") return [];
  return queryRows<Row>(`SELECT r.id, r.customer_id, r.subject, r.message, r.remind_at, r.created_at, r.source, r.created_by, r.user_id,
      c.name, c.phone, cb.full_name AS by_name
    FROM reminders r JOIN customers c ON c.id=r.customer_id AND c.merged_into_customer_id IS NULL AND c.salesperson_id=?
    LEFT JOIN users cb ON cb.id=r.created_by
    WHERE r.user_id=? AND r.done=0 AND r.voided_at IS NULL AND r.closed_at IS NULL AND r.customer_id IS NOT NULL
      AND julianday(r.remind_at) <= julianday(?) AND julianday(r.remind_at) >= julianday(?)
    ORDER BY julianday(r.remind_at), r.id LIMIT 200`, [Number(u.salespersonId), Number(u.id), now.toISOString(), f.updated_at]);
}
function lastCalls(customerId: number) {
  return queryRows<{ id: number; created_at: string; outcome: string | null; one_line_note: string | null; expert_notes: string | null }>(
    "SELECT id, created_at, outcome, one_line_note, expert_notes FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 2", [customerId])
    .map((c) => ({ id: c.id, at: c.created_at, outcome: c.outcome, note: maskPhonesInText(clip(c.one_line_note || c.expert_notes, 120)) }));
}
function stateOf(u: NonNullable<U>) {
  ensure();
  return queryRow<{ snooze_until: string | null; snooze_through: string | null; snoozed_at: string | null }>(
    "SELECT snooze_until, snooze_through, snoozed_at FROM rm_must_state WHERE user_id=?", [Number(u.id)]) ?? null;
}
function snoozeInfo(u: NonNullable<U>, rows: Row[], now: Date) {
  const st = stateOf(u);
  const through = st?.snooze_through ? Date.parse(st.snooze_through) : NaN;
  const episodeUsed = Number.isFinite(through) && rows.some((r) => Date.parse(r.remind_at) <= through);
  const until = st?.snooze_until && Date.parse(st.snooze_until) > now.getTime() && episodeUsed ? st.snooze_until : null;
  return { active: Boolean(until), until, used: episodeUsed, available: rows.length > 0 && !episodeUsed, minutes: RM_SNOOZE_MIN };
}

/** GET /reminder-must/feed */
export function rmFeed(u: NonNullable<U>, now = new Date()) {
  ensure();
  const work = !toWorkingTime(now).shifted;
  const rows = dueRows(u, now);
  const snooze = snoozeInfo(u, rows, now);
  const items = work ? rows.map((r) => ({
    reminderId: r.id, customerId: r.customer_id, customerName: r.name, phoneMasked: maskPhone(r.phone), tel: String(r.phone ?? "").replace(/[^\d+]/g, ""),
    subject: maskPhonesInText(clip(r.subject, 120)), reason: maskPhonesInText(clip(r.message, 300)),
    createdBy: r.source === "assistant" ? "دستیار فروش" : r.created_by && r.created_by !== r.user_id ? (r.by_name || "همکار") : "خودت",
    createdAt: r.created_at, remindAt: r.remind_at, outsideHours: toWorkingTime(new Date(r.remind_at)).shifted,
  })) : [];
  // REMINDER-3COL: «تکمیل/ویرایش پرونده» in the popup's file column only where the today card could save it too
  // (expert_lockdown unchanged: POST /customers/:id/file-card stays limited to today's plan / incoming / case customers).
  const head = items[0] ? { ...items[0], lastCalls: lastCalls(items[0].customerId),
    fileEdit: !elLocked(u) || elCustomerAccess(u, items[0].customerId, now) != null } : null;
  return { enabled: true, workTime: work, pendingCount: rows.length, items: head ? [head, ...items.slice(1)] : [], snooze, serverNow: now.toISOString(),
    rules: { noteMin: RM_NOTE_MIN, noteMax: RM_NOTE_MAX, reasonMin: RM_REASON_MIN, reasonMax: RM_REASON_MAX, outcomes: RM_OUTCOMES, next: RM_NEXT,
      todayPmOpen: todayPm(now) != null } };
}

/** POST /reminder-must/:id/shown — first delivery stamp (idempotent per reminder). */
export function rmShown(u: NonNullable<U>, id: number, now = new Date()): Err | { ok: true; first: boolean } {
  ensure();
  if (!dueRows(u, now).some((r) => r.id === id)) return err(404, "not_due", "این یادآور در صف تو نیست.");
  const seen = queryRow<{ id: number }>("SELECT id FROM rm_must_log WHERE reminder_id=? AND action='shown' LIMIT 1", [id]);
  if (!seen) log(u, id, "shown", now.toISOString());
  if (!queryRow("SELECT 1 x FROM reminders WHERE id=? AND notified_at IS NOT NULL", [id])) executeChanges("UPDATE reminders SET notified_at=? WHERE id=? AND notified_at IS NULL", [now.toISOString(), id]);
  return { ok: true, first: !seen };
}

/** POST /reminder-must/snooze — one 10-minute snooze for the whole current queue. */
export function rmSnooze(u: NonNullable<U>, now = new Date()): Err | { ok: true; until: string; count: number } {
  ensure();
  if (toWorkingTime(now).shifted) return err(409, "outside_hours", "بیرون از ساعت کاری صفی باز نیست.");
  return runTransaction(() => {
    const rows = dueRows(u, now);
    if (!rows.length) return err(409, "queue_empty", "یادآور سررسیدی نداری.");
    const s = snoozeInfo(u, rows, now);
    if (s.used) return err(409, "snooze_used", "مهلت ۱۰ دقیقه‌ای فقط یک بار است؛ این بار بدون مهلت.", { until: s.until });
    const until = new Date(now.getTime() + RM_SNOOZE_MIN * 60_000).toISOString();
    const through = rows[rows.length - 1].remind_at;
    execute(`INSERT INTO rm_must_state(user_id,snooze_until,snooze_through,snoozed_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET snooze_until=excluded.snooze_until, snooze_through=excluded.snooze_through, snoozed_at=excluded.snoozed_at`,
      [Number(u.id), until, new Date(through).toISOString(), now.toISOString()]);
    log(u, rows[0].id, "snooze", now.toISOString(), { data: { count: rows.length, until } });
    return { ok: true as const, until, count: rows.length };
  });
}

function todayPm(now: Date): Date | null {
  const p = tParts(now); if (!isWorkDay(p)) return null;
  const at = fromTehran(p.y, p.m, p.d, 17, 0);
  return at.getTime() > now.getTime() + 15 * 60_000 ? at : null;
}
export function rmNextAt(preset: string, now = new Date()): Date | null | "invalid" {
  const p = tParts(now);
  if (preset === "none") return null;
  if (preset === "tomorrow_am") return nextWorkDayAt(p, 10, 0);
  if (preset === "today_pm") return todayPm(now) ?? "invalid";
  if (preset === "in_3_days") return toWorkingTime(fromTehran(p.y, p.m, p.d + 3, 10, 0)).at;
  return "invalid";
}

/** POST /reminder-must/:id/complete {callId, outcome, note, next, reason} */
export function rmComplete(u: NonNullable<U>, id: number, b: any, now = new Date()): Err | Record<string, unknown> {
  ensure();
  const iso = now.toISOString();
  const outcome = String(b?.outcome ?? ""); const note = String(b?.note ?? "").replace(/\s+/g, " ").trim();
  const next = String(b?.next ?? ""); const reason = String(b?.reason ?? "").replace(/\s+/g, " ").trim();
  const callId = Number(b?.callId);
  if (!(RM_OUTCOMES as readonly string[]).includes(outcome)) return err(422, "outcome_required", "نتیجه‌ی تماس را انتخاب کن.", { allowed: RM_OUTCOMES });
  if ([...note].length < RM_NOTE_MIN) return err(422, "note_required", `یادداشت یک‌خطی حداقل ${RM_NOTE_MIN.toLocaleString("fa-IR")} نویسه باشد.`);
  if ([...note].length > RM_NOTE_MAX) return err(422, "field_too_long", "یادداشت یک‌خطی حداکثر ۸۰ نویسه است.", { field: "note", max: RM_NOTE_MAX });
  if (!(RM_NEXT as readonly string[]).includes(next)) return err(422, "next_required", "قدم بعد را انتخاب کن.", { allowed: RM_NEXT });
  if (next !== "none" && [...reason].length < RM_REASON_MIN) return err(422, "reason_required", "دلیل یادآور بعدی را بنویس.");
  if ([...reason].length > RM_REASON_MAX) return err(422, "field_too_long", "دلیل یادآور بعدی حداکثر ۸۰ نویسه است.", { field: "reason", max: RM_REASON_MAX });
  if (!Number.isSafeInteger(callId) || callId <= 0) return err(422, "call_required", "اول تماس را ثبت کن.");
  const at = rmNextAt(next, now);
  if (at === "invalid") return err(422, "next_invalid", "«امروز عصر» دیگر ممکن نیست؛ گزینه‌ی دیگری بزن.");
  return runTransaction(() => {
    const done = queryRow<{ id: number; closed_by_call_id: number | null; customer_id: number; user_id: number }>(
      "SELECT id, closed_by_call_id, customer_id, user_id FROM reminders WHERE id=?", [id]);
    // Idempotent replay (network retry after a 200 that never arrived): same reminder already closed by the same call.
    if (done && done.user_id === Number(u.id) && done.closed_by_call_id === callId) {
      const prev = queryRow<{ next_reminder_id: number | null }>("SELECT next_reminder_id FROM rm_must_log WHERE reminder_id=? AND action='complete' ORDER BY id DESC LIMIT 1", [id]);
      return { ok: true, replayed: true, reminderId: id, callId, nextReminderId: prev?.next_reminder_id ?? null, remaining: dueRows(u, now).length };
    }
    const r = dueRows(u, now).find((x) => x.id === id);
    if (!r) return err(404, "not_due", "این یادآور در صف تو نیست یا قبلاً بسته شده.");
    const call = queryRow<{ id: number; customer_id: number; salesperson_id: number | null; created_at: string }>(
      "SELECT id, customer_id, salesperson_id, created_at FROM call_logs WHERE id=?", [callId]);
    if (!call || call.customer_id !== r.customer_id || Number(call.salesperson_id) !== Number(u.salespersonId)
      || Math.abs(now.getTime() - Date.parse(call.created_at)) > 60 * 60_000)
      return err(409, "call_mismatch", "تماس ثبت‌شده مال همین مشتری و همین الان نیست.");
    if (queryRow("SELECT 1 x FROM reminders WHERE closed_by_call_id=? AND id<>?", [callId, id])) return err(409, "call_used", "این تماس قبلاً یک یادآور دیگر را بسته است.");
    executeChanges("UPDATE call_logs SET outcome=COALESCE(outcome,?), one_line_note=COALESCE(one_line_note,?), created_by_user_id=COALESCE(created_by_user_id,?), report_saved_at=COALESCE(report_saved_at,?) WHERE id=?",
      [outcome, note, Number(u.id), iso, callId]);
    executeChanges("UPDATE reminders SET done=1, closed_by_call_id=?, closed_at=? WHERE id=? AND done=0", [callId, iso, id]);
    let nextId: number | null = null;
    if (at) {
      nextId = Number(execute(`INSERT INTO reminders(user_id,salesperson_id,customer_id,subject,message,remind_at,sent_sms,done,created_at,call_id,source,created_by)
        VALUES(?,?,?,?,?,?,0,0,?,?,'reminder_must',?)`, [Number(u.id), Number(u.salespersonId), r.customer_id, clip(reason, 60), reason, at.toISOString(), iso, callId, Number(u.id)]));
      crmDb.exec(`CREATE TABLE IF NOT EXISTS reminder_sms_deliveries (reminder_id INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
        status TEXT NOT NULL, claim_token TEXT, attempted_at TEXT, next_attempt_at TEXT, sent_at TEXT, provider_id TEXT, error_code TEXT)`);
      execute(`INSERT INTO reminder_sms_deliveries(reminder_id,status,error_code) VALUES(?,'rejected','in_app_only')
        ON CONFLICT(reminder_id) DO UPDATE SET status='rejected', error_code='in_app_only'`, [nextId]);
    }
    log(u, id, "complete", iso, { callId, nextId, data: { outcome, next } });
    const remaining = dueRows(u, now).length;
    return { ok: true, reminderId: id, callId, nextReminderId: nextId, nextAt: at ? at.toISOString() : null, remaining };
  });
}

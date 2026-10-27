/**
 * «نتیجه‌ی تماس» + «صف تماس من» + یادآور اجباری (crm-call-queue v1.5, release 1). Everything is behind call_queue_settings
 * flags that are seeded '0' (OFF). While a flag is OFF the code paths below are no-ops and existing behaviour is unchanged.
 * Nothing here sends SMS, Bale or any customer message; the only notification is a CRM bell row for managers
 * (P1 · 3× no answer) behind its own OFF flag. Never touches owner, priority, status, money or fees.
 * Ids: experts are users 2 (Hasani, sp 3), 3 (Ghasemi, sp 4), 8 (Kazemi, sp 6). Trainees users 6/27/28 (sp 5/19/20) and
 * user 29 are never eligible. Managers = active admins except 29 (users 1 and 5).
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, type SqlValue } from "./crm-db";
import { ensureOfficialHolidaysSchema, isOfficialHoliday } from "./official-holidays";
import { openUrgentFlags } from "./lead-intake";

export const CQ_TRAINEE_SALESPERSON_IDS: readonly number[] = [5, 19, 20];
export const CQ_TRAINEE_USER_IDS: readonly number[] = [6, 27, 28];
export const CQ_EXCLUDED_USER_IDS: readonly number[] = [29];

export const CQ_FLAGS = ["result", "autoclose", "assistant_reminders", "queue", "modal", "hide_not_now", "p1_notify",
  // R2 (crm-call-queue v1.6 §7ج/§8-16…36), all seeded OFF:
  "call_lock", "discipline", "restrict_panel", "alerts", "signals",
  // R3: transfer check
  "transfer_check"] as const;
export type CqFlag = typeof CQ_FLAGS[number];
export const CQ_FLAG_LABELS: Record<CqFlag, string> = {
  result: "نتیجه‌ی تماس و یادداشت یک‌خطی در فرم ثبت تماس",
  autoclose: "بستن خودکار یادآور سررسیده با ثبت تماس + یادآور پیگیری بعدی / تلاش بعدی",
  assistant_reminders: "پیشنهاد یادآور دستیار از روی یادداشت (اول پیشنهاد، بعد ساخت با تأیید کارشناس)",
  queue: "صفحه‌ی «صف تماس من»",
  modal: "مودال اجباری یادآور سررسیده",
  hide_not_now: "برداشتن «الان نه» از دستیار فروش",
  p1_notify: "اعلان CRM برای مدیر: اولویت ۱ · ۳ بار بی‌پاسخ",
  call_lock: "قفل تماس: تماس از دکمه‌ی CRM + گزارش اجباری قبل از تماس بعدی",
  discipline: "امتیاز نظم پیگیری (فقط نمایش؛ بی‌اثر روی حقوق و پورسانت)",
  restrict_panel: "پنل محدود با بیش از ۱۰ پیگیری عقب‌افتاده",
  alerts: "هشدار ۳ روز کاری پیاپی زیر حد (مدیر + خود کارشناس، فقط CRM)",
  signals: "سیگنال‌های نظم در گزارش روزانه‌ی مدیر",
  transfer_check: "بررسی گیرنده هنگام انتقال مشتری (درصد به‌موقع و عقب‌افتاده‌ها)",
};
export type QueueGroup = "due" | "new" | "p1" | "assist";
export const CQ_GROUPS: QueueGroup[] = ["due", "new", "p1", "assist"];
/** «مشتری فوری» (customers.is_urgent=1) is above every group, even overdue reminders (PM 2026-10-27). Not part of the editable order. */
export type QueueCardGroup = QueueGroup | "urgent";
export const CQ_DEFAULT_TEMPLATE = "سلام، تماس گرفتم در دسترس نبودید. هر وقت فرصت داشتید خبرم کنید.";
export const CQ_DEFAULTS = { order: CQ_GROUPS, newRedHours: 24, p1StaleDays: 7, naTemplate: CQ_DEFAULT_TEMPLATE };
export const CQ_LIMITS = { newRedHours: [1, 168], p1StaleDays: [1, 60], naTemplateMax: 200, oneLineMax: 80, voidNoteMax: 60 } as const;
export const CQ_OUTCOMES = ["answered", "no_answer", "follow_up"] as const;
export type CqOutcome = typeof CQ_OUTCOMES[number];
export const CQ_VOID_REASONS: Record<string, string> = {
  only_talk: "فقط حرف زد، قول نبود", wrong_date: "تاریخ را اشتباه برداشت", already_done: "قبلاً پیگیری شده",
  customer_calls: "مشتری خودش زنگ می‌زند", other: "سایر",
};
export const CQ_SNOOZE_MIN = 10;
export const CQ_NA_MAX = 3;

/* ---------------- schema ---------------- */
let ready = false;
function ensureCol(table: string, column: string, def: string) {
  const cols = crmDb.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some(c => c.name === column)) crmDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
export function ensureCallQueueSchema(): void {
  if (ready) return;
  const now = new Date().toISOString();
  ensureOfficialHolidaysSchema(crmDb, now);
  crmDb.exec(`CREATE TABLE IF NOT EXISTS call_queue_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS call_queue_settings_log(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_value TEXT, new_value TEXT, user_id INTEGER, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS call_queue_events(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id INTEGER, salesperson_id INTEGER,
      customer_id INTEGER, reminder_id INTEGER, call_id INTEGER, reason TEXT, note TEXT, data_json TEXT, created_at TEXT NOT NULL, seen_at TEXT, seen_by INTEGER);
    CREATE INDEX IF NOT EXISTS idx_cq_events_kind_at ON call_queue_events(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_cq_events_reminder ON call_queue_events(reminder_id);`);
  for (const [c, d] of [["outcome", "TEXT"], ["one_line_note", "TEXT"], ["na_attempt", "INTEGER"], ["source", "TEXT"], ["manual_type", "TEXT"],
    ["created_by_user_id", "INTEGER"], ["started_at", "TEXT"], ["returned_at", "TEXT"], ["report_saved_at", "TEXT"]] as const) ensureCol("call_logs", c, d);
  for (const [c, d] of [["source", "TEXT"], ["source_note_id", "INTEGER"], ["source_span", "TEXT"], ["closed_by_call_id", "INTEGER"], ["closed_at", "TEXT"],
    ["voided_at", "TEXT"], ["void_reason", "TEXT"], ["void_note", "TEXT"], ["voided_by", "INTEGER"], ["snooze_until", "TEXT"], ["snooze_used", "INTEGER NOT NULL DEFAULT 0"],
    ["created_by", "INTEGER"]] as const) ensureCol("reminders", c, d);
  crmDb.exec("CREATE INDEX IF NOT EXISTS idx_reminders_cq_due ON reminders(user_id, done, remind_at)");
  // R2 «قفل تماس»: a CRM-button call lives here from the moment its tel: link is issued until its report is saved (then it is linked to
  // the call_logs row, which gets source='crm_button', started_at, returned_at, report_saved_at). Kept apart so an unreported dial never
  // shows up as an empty call in the existing call lists and reports.
  crmDb.exec(`CREATE TABLE IF NOT EXISTS call_queue_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, salesperson_id INTEGER,
      customer_id INTEGER NOT NULL, via TEXT, link_issued_at TEXT NOT NULL, returned_at TEXT, report_saved_at TEXT, call_log_id INTEGER, on_time INTEGER)
    ;CREATE INDEX IF NOT EXISTS idx_cq_calls_user ON call_queue_calls(user_id, report_saved_at, id)
    ;CREATE INDEX IF NOT EXISTS idx_cq_calls_at ON call_queue_calls(link_issued_at)
    ;CREATE TABLE IF NOT EXISTS call_queue_daily(day TEXT NOT NULL, user_id INTEGER NOT NULL, salesperson_id INTEGER, crm_calls INTEGER NOT NULL, on_time INTEGER NOT NULL,
      on_time_pct INTEGER, overdue INTEGER NOT NULL, nocall INTEGER NOT NULL, score INTEGER NOT NULL, ok INTEGER NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY(day,user_id))`);
  // R3 «بررسی سپردن»: one row per checked hand-off (flag.transfer_check only). outcome ok | override | blocked; numbers are the receiver's at that moment.
  crmDb.exec(`CREATE TABLE IF NOT EXISTS call_queue_transfers(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, customer_name TEXT,
      from_salesperson_id INTEGER, to_salesperson_id INTEGER NOT NULL, to_user_id INTEGER, actor_user_id INTEGER NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL,
      outcome TEXT NOT NULL, override INTEGER NOT NULL DEFAULT 0, override_reason TEXT, on_time_pct INTEGER, overdue INTEGER, reasons_json TEXT, created_at TEXT NOT NULL)
    ;CREATE INDEX IF NOT EXISTS idx_cq_transfers_at ON call_queue_transfers(created_at)`);
  const seed = crmDb.prepare("INSERT OR IGNORE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,NULL,?)");
  for (const f of CQ_FLAGS) seed.run(`flag.${f}`, "0", now);
  ready = true;
}

/* ---------------- settings ---------------- */
const raw = (k: string): string | null => { ensureCallQueueSchema(); return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; };
export function cqFlags(): Record<CqFlag, boolean> {
  ensureCallQueueSchema();
  const m = new Map(queryRows<{ key: string; value: string }>("SELECT key,value FROM call_queue_settings WHERE key LIKE 'flag.%'").map(r => [r.key, r.value]));
  return Object.fromEntries(CQ_FLAGS.map(f => [f, m.get(`flag.${f}`) === "1"])) as Record<CqFlag, boolean>;
}
export const cqFlag = (f: CqFlag) => raw(`flag.${f}`) === "1";
export const cqRaw = raw;
export type CqSettings = { order: QueueGroup[]; newRedHours: number; p1StaleDays: number; naTemplate: string };
export function cqSettings(): CqSettings {
  let order: QueueGroup[] = CQ_DEFAULTS.order;
  try { const o = JSON.parse(raw("order") ?? "null"); if (validOrder(o)) order = o; } catch { /* default */ }
  const n = (k: string, d: number, [lo, hi]: readonly [number, number] | readonly number[]) => { const v = Number(raw(k)); return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
  return { order, newRedHours: n("new_red_hours", 24, CQ_LIMITS.newRedHours), p1StaleDays: n("p1_stale_days", 7, CQ_LIMITS.p1StaleDays),
    naTemplate: raw("na_template") ?? CQ_DEFAULT_TEMPLATE };
}
const validOrder = (o: unknown): o is QueueGroup[] => Array.isArray(o) && o.length === 4 && CQ_GROUPS.every(g => o.includes(g));
export function validateCqSettings(b: any): { ok: true; value: Partial<CqSettings> } | { ok: false; error: string } {
  const out: Partial<CqSettings> = {};
  if (b?.order !== undefined) { if (!validOrder(b.order)) return { ok: false, error: "ترتیب گروه‌ها معتبر نیست." }; out.order = b.order; }
  if (b?.newRedHours !== undefined) { const v = Number(b.newRedHours); if (!Number.isInteger(v) || v < 1 || v > 168) return { ok: false, error: "«جدید» باید بین ۱ تا ۱۶۸ ساعت باشد." }; out.newRedHours = v; }
  if (b?.p1StaleDays !== undefined) { const v = Number(b.p1StaleDays); if (!Number.isInteger(v) || v < 1 || v > 60) return { ok: false, error: "اولویت ۱ بی‌تماس باید بین ۱ تا ۶۰ روز باشد." }; out.p1StaleDays = v; }
  if (b?.naTemplate !== undefined) { const t = String(b.naTemplate ?? "").trim(); if (!t || [...t].length > 200) return { ok: false, error: "متن آماده باید ۱ تا ۲۰۰ نویسه باشد." }; out.naTemplate = t; }
  return { ok: true, value: out };
}
function setRaw(key: string, value: string, userId: number, at: string) {
  const old = raw(key);
  if (old === value) return false;
  execute(`INSERT INTO call_queue_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, [key, value, userId, at]);
  execute("INSERT INTO call_queue_settings_log(key,old_value,new_value,user_id,at) VALUES(?,?,?,?,?)", [key, old, value, userId, at]);
  return true;
}
export function saveCqSettings(v: Partial<CqSettings>, userId: number, at = new Date().toISOString()): number {
  let n = 0;
  if (v.order) n += +setRaw("order", JSON.stringify(v.order), userId, at);
  if (v.newRedHours !== undefined) n += +setRaw("new_red_hours", String(v.newRedHours), userId, at);
  if (v.p1StaleDays !== undefined) n += +setRaw("p1_stale_days", String(v.p1StaleDays), userId, at);
  if (v.naTemplate !== undefined) n += +setRaw("na_template", v.naTemplate, userId, at);
  return n;
}
export function saveCqFlag(f: CqFlag, on: boolean, userId: number, at = new Date().toISOString()) { return setRaw(`flag.${f}`, on ? "1" : "0", userId, at); }
export const cqSettingsLog = (limit = 50) => queryRows<any>("SELECT id,key,old_value oldValue,new_value newValue,user_id userId,at FROM call_queue_settings_log ORDER BY id DESC LIMIT ?", [limit]);

/* ---------------- who ---------------- */
export type CqUser = { id: number; role: string; salespersonId: number | null; active?: boolean };
export function cqEligible(u: CqUser | null | undefined): boolean {
  if (!u || CQ_EXCLUDED_USER_IDS.includes(Number(u.id)) || CQ_TRAINEE_USER_IDS.includes(Number(u.id))) return false;
  if (u.active === false || u.role !== "salesperson") return false;
  const sp = Number(u.salespersonId);
  return Number.isInteger(sp) && sp > 0 && !CQ_TRAINEE_SALESPERSON_IDS.includes(sp);
}
export const cqManager = (u: CqUser | null | undefined) => Boolean(u && u.role === "admin" && !CQ_EXCLUDED_USER_IDS.includes(Number(u.id)));
export function cqManagerIds(): number[] {
  return queryRows<{ id: number }>("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id").map(r => Number(r.id)).filter(id => !CQ_EXCLUDED_USER_IDS.includes(id));
}

/* ---------------- Tehran working time (fixed +03:30; Iran has no DST) ---------------- */
export const TEHRAN_OFF_MIN = 210;
export type TParts = { y: number; m: number; d: number; h: number; mi: number; wd: number };
export function tParts(at: Date): TParts {
  const w = new Date(at.getTime() + TEHRAN_OFF_MIN * 60_000);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), wd: w.getUTCDay() };
}
export const fromTehran = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi) - TEHRAN_OFF_MIN * 60_000);
export const tYmd = (p: Pick<TParts, "y" | "m" | "d">) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
export const WORK_START_MIN = 9 * 60, WORK_END_MIN = 18 * 60, SHIFT_TO = { h: 10, mi: 0 };
export function isWorkDay(p: Pick<TParts, "y" | "m" | "d" | "wd">): boolean { return p.wd !== 5 && !isOfficialHoliday(crmDb, tYmd(p)); }
function addDays(p: TParts, n: number): TParts { return tParts(new Date(fromTehran(p.y, p.m, p.d, 12, 0).getTime() + n * 86_400_000)); }
export function nextWorkDayAt(p: TParts, h = SHIFT_TO.h, mi = SHIFT_TO.mi, includeSame = false): Date {
  let q = includeSame ? p : addDays(p, 1);
  for (let i = 0; i < 40 && !isWorkDay(q); i++) q = addDays(q, 1);
  return fromTehran(q.y, q.m, q.d, h, mi);
}
/** Server-side shift (spec §2/§8-3): Friday / official holiday / outside 09:00–18:00 → the next working moment at 10:00. */
export function toWorkingTime(at: Date): { at: Date; shifted: boolean; why: "holiday" | "friday" | "after_hours" | "before_hours" | null } {
  const p = tParts(at); const min = p.h * 60 + p.mi;
  if (p.wd === 5) return { at: nextWorkDayAt(p, SHIFT_TO.h, SHIFT_TO.mi, true), shifted: true, why: "friday" };
  if (!isWorkDay(p)) return { at: nextWorkDayAt(p, SHIFT_TO.h, SHIFT_TO.mi, true), shifted: true, why: "holiday" };
  if (min < WORK_START_MIN) return { at: fromTehran(p.y, p.m, p.d, SHIFT_TO.h, SHIFT_TO.mi), shifted: true, why: "before_hours" };
  if (min > WORK_END_MIN) return { at: nextWorkDayAt(p), shifted: true, why: "after_hours" };
  return { at, shifted: false, why: null };
}

/* ---------------- phrase detector (suggest-first; never creates anything by itself) ---------------- */
const FA = "۰۱۲۳۴۵۶۷۸۹", AR = "٠١٢٣٤٥٦٧٨٩";
const enDigits = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d))).replace(/[٠-٩]/g, d => String(AR.indexOf(d)));
const WEEKDAYS: [RegExp, number][] = [[/(?:^|[\s،,.])(یک[\s‌]?شنبه)/, 0], [/(?:^|[\s،,.])(دو[\s‌]?شنبه)/, 1], [/(?:^|[\s،,.])(سه[\s‌]?شنبه)/, 2],
  [/(?:^|[\s،,.])(چهار[\s‌]?شنبه)/, 3], [/(?:^|[\s،,.])(پنج[\s‌]?شنبه)/, 4], [/(?:^|[\s،,.])(شنبه)/, 6]];
const WORD_N: Record<string, number> = { "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7, "ده": 10 };
export type PhraseHit = { phrase: string; start: number; end: number; remindAt: string; shifted: boolean };
/** Deterministic Persian date-phrase detector on an expert's note. Returns the first hit, or null. Offsets are on the given text. */
export function detectFollowUpPhrase(textIn: string, now = new Date()): PhraseHit | null {
  const text = String(textIn ?? ""); if (!text.trim()) return null;
  const t = enDigits(text).replace(/ي/g, "ی").replace(/ك/g, "ک");
  const p = tParts(now);
  let day: TParts | null = null; let m: RegExpExecArray | null = null; let idx = -1; let len = 0;
  const pick = (re: RegExp, f: (mm: RegExpExecArray) => TParts | null) => {
    if (day) return; const mm = re.exec(t); if (!mm) return; const r = f(mm); if (!r) return;
    const g = mm[1] ?? mm[0]; day = r; m = mm; idx = mm.index + mm[0].indexOf(g); len = g.length;
  };
  pick(/(پس[\s‌]?فردا)/, () => addDays(p, 2));
  pick(/(فردا)/, () => addDays(p, 1));
  pick(/((\d{1,2}|یک|دو|سه|چهار|پنج|شش|هفت|ده)\s*روز\s*(?:دیگه|دیگر|بعد))/, mm => { const n = Number(mm[2]) || WORD_N[mm[2]] || 0; return n >= 1 && n <= 30 ? addDays(p, n) : null; });
  pick(/(هفته[\s‌]?(?:ی|‌ی)?\s*(?:بعد|دیگه|دیگر|آینده))/, () => addDays(p, 7));
  for (const [re, wd] of WEEKDAYS) pick(re, () => { let n = (wd - p.wd + 7) % 7; if (n === 0) n = 7; return addDays(p, n); });
  pick(/((?:امروز\s*)?(?:عصر|بعد[\s‌]?از[\s‌]?ظهر))/, () => p);
  if (!day) return null;
  const d0 = day as TParts;
  let h = SHIFT_TO.h, mi = 0;
  const hm = /ساعت\s*(\d{1,2})(?::(\d{2}))?/.exec(t);
  if (hm) { h = Number(hm[1]); mi = Number(hm[2] ?? 0); if (h >= 1 && h <= 7) h += 12; if (h > 23 || mi > 59) { h = SHIFT_TO.h; mi = 0; } }
  else if (/عصر|بعد[\s‌]?از[\s‌]?ظهر/.test(t)) h = 16;
  else if (/صبح/.test(t)) h = 10;
  let at = fromTehran(d0.y, d0.m, d0.d, h, mi);
  if (at.getTime() <= now.getTime()) return null;
  const w = toWorkingTime(at); at = w.at;
  void m;
  return { phrase: text.slice(idx, idx + len), start: idx, end: idx + len, remindAt: at.toISOString(), shifted: w.shifted };
}

/* ---------------- events ---------------- */
export function cqEvent(kind: string, e: { userId?: number | null; salespersonId?: number | null; customerId?: number | null; reminderId?: number | null; callId?: number | null; reason?: string | null; note?: string | null; data?: unknown; at?: string }): number {
  ensureCallQueueSchema();
  return execute(`INSERT INTO call_queue_events(kind,user_id,salesperson_id,customer_id,reminder_id,call_id,reason,note,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [kind, e.userId ?? null, e.salespersonId ?? null, e.customerId ?? null, e.reminderId ?? null, e.callId ?? null, e.reason ?? null, e.note ?? null,
      e.data === undefined ? null : JSON.stringify(e.data), e.at ?? new Date().toISOString()]);
}

/* ---------------- POST /calls hook ---------------- */
export type CqCallInput = { active: boolean; resultOn: boolean; outcome: CqOutcome | null; oneLine: string | null; followUpAt: Date | null; hasLegacyReminder: boolean;
  /** R2: the pending CRM-button call this report closes (same expert + same customer), or null. */
  startedCallId: number | null; manualType: "in_person" | "bale" | null; lockOn: boolean };
export const CQ_MANUAL_TYPES = { in_person: "حضوری", bale: "بله" } as const;
/** R2 lock is active only with «نتیجه‌ی تماس» on too: the report that unlocks needs a result + one-line note. */
export const cqLockOn = (user: CqUser, f = cqFlags()) => cqEligible(user) && f.call_lock && f.result;
export function cqPendingCall(userId: number): { id: number; customer_id: number; link_issued_at: string; returned_at: string | null } | null {
  ensureCallQueueSchema();
  return queryRow<any>("SELECT id,customer_id,link_issued_at,returned_at FROM call_queue_calls WHERE user_id=? AND report_saved_at IS NULL ORDER BY id DESC LIMIT 1", [userId]) ?? null;
}
/** Reads the raw request body (zod strips unknown keys). Returns an error message (400) or the parsed input. */
export function cqParseCall(body: any, user: CqUser): { error: string } | CqCallInput {
  ensureCallQueueSchema();
  const f = cqFlags(); const eligible = cqEligible(user);
  const resultOn = eligible && f.result; const active = eligible && (f.result || f.autoclose);
  const base: CqCallInput = { active, resultOn, outcome: null, oneLine: null, followUpAt: null, hasLegacyReminder: Boolean(body?.reminder), startedCallId: null, manualType: null, lockOn: false };
  if (!resultOn) return base;
  if (cqLockOn(user, f)) {
    base.lockOn = true;
    const pend = cqPendingCall(user.id); const cust = Number(body?.customerId);
    const mt = String(body?.manualType ?? "");
    if (mt && mt !== "in_person" && mt !== "bale") return { error: "نوع گفت‌وگو معتبر نیست." };
    if (pend && Number(pend.customer_id) === cust && !mt) base.startedCallId = Number(pend.id);
    else if (mt) base.manualType = mt as "in_person" | "bale";
    else return { error: "این گفت‌وگو از دکمه‌ی تماس CRM نبود؛ نوعش را انتخاب کن (حضوری یا بله)." };
  }
  const outcome = String(body?.outcome ?? "");
  const oneLine = String(body?.oneLineNote ?? "").replace(/\s+/g, " ").trim();
  const missing = [!CQ_OUTCOMES.includes(outcome as CqOutcome) ? "نتیجه‌ی تماس" : null, !oneLine ? "یادداشت یک‌خطی" : null].filter(Boolean);
  if (missing.length) return { error: `${missing.join("، ")} هنوز خالی است.` };
  if ([...oneLine].length > CQ_LIMITS.oneLineMax) return { error: "یادداشت یک‌خطی حداکثر ۸۰ نویسه است؛ بقیه را در «یادداشت کارشناس» بنویس." };
  let followUpAt: Date | null = null;
  if (outcome === "follow_up" && !base.hasLegacyReminder) {
    const d = new Date(String(body?.followUpAt ?? ""));
    if (Number.isNaN(d.getTime())) return { error: "زمان یادآور پیگیری بعدی را انتخاب کن." };
    if (d.getTime() <= Date.now() - 60_000) return { error: "زمان یادآور باید در آینده باشد." };
    if (d.getTime() > Date.now() + 90 * 86_400_000) return { error: "زمان یادآور حداکثر ۹۰ روز بعد است." };
    followUpAt = d;
  }
  return { ...base, outcome: outcome as CqOutcome, oneLine, followUpAt };
}

const faDate = (iso: string) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", day: "numeric", month: "long" }).format(new Date(iso));
const faTime = (iso: string) => new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** Consecutive no-answer calls for the customer before this one (most recent first), stopping at any other outcome or a legacy call. */
function trailingNoAnswer(customerId: number, beforeCallId: number): number {
  const rows = queryRows<{ outcome: string | null }>("SELECT outcome FROM call_logs WHERE customer_id=? AND id<? ORDER BY id DESC LIMIT 10", [customerId, beforeCallId]);
  let n = 0; for (const r of rows) { if (r.outcome === "no_answer") n++; else break; } return n;
}
export type CqCallResult = {
  callId: number; resultOn: boolean; outcome: CqOutcome | null;
  closed: { id: number; remindAt: string; label: string }[];
  created: { id: number; remindAt: string; label: string; kind: "followup" | "no_answer"; shifted: boolean }[];
  naAttempt: number | null; coldSuggest: boolean; p1NoAnswer3: boolean; managerNotified: boolean;
};
/** Inside the POST /calls transaction, right after the call_logs row exists. */
export function cqAfterCall(callId: number, input: CqCallInput, user: CqUser & { fullName?: string | null; username?: string }, customerId: number, nowIso = new Date().toISOString()): CqCallResult | null {
  if (!input.active) return null;
  const f = cqFlags();
  const res: CqCallResult = { callId, resultOn: input.resultOn, outcome: input.outcome, closed: [], created: [], naAttempt: null, coldSuggest: false, p1NoAnswer3: false, managerNotified: false };
  const sp = user.salespersonId ?? null;
  executeChanges("UPDATE call_logs SET created_by_user_id=?, source=COALESCE(source,'manual') WHERE id=?", [user.id, callId]);
  if (input.resultOn && input.outcome && !input.lockOn)
    executeChanges("UPDATE call_logs SET outcome=?, one_line_note=?, report_saved_at=? WHERE id=?", [input.outcome, input.oneLine, nowIso, callId]);
  if (input.lockOn) cqLinkReport(callId, input, user, customerId, nowIso);
  if (f.autoclose) {
    const due = queryRows<{ id: number; remind_at: string }>(`SELECT id,remind_at FROM reminders WHERE user_id=? AND customer_id=? AND done=0
      AND voided_at IS NULL AND remind_at<=? ORDER BY remind_at`, [user.id, customerId, nowIso]);
    for (const r of due) {
      if (executeChanges("UPDATE reminders SET done=1, closed_by_call_id=?, closed_at=? WHERE id=? AND done=0", [callId, nowIso, r.id]))
        res.closed.push({ id: Number(r.id), remindAt: r.remind_at, label: faDate(r.remind_at) });
    }
    if (res.closed.length) cqEvent("auto_close", { userId: user.id, salespersonId: sp, customerId, callId, data: { reminderIds: res.closed.map(c => c.id) }, at: nowIso });
  }
  if (input.resultOn && input.outcome) {
    const mk = (at: Date, kind: "followup" | "no_answer", subject: string, shifted: boolean) => {
      const iso = at.toISOString();
      const id = execute(`INSERT INTO reminders(user_id,salesperson_id,customer_id,subject,message,remind_at,sent_sms,done,created_at,call_id,source,created_by)
        VALUES(?,?,?,?,?,?,0,0,?,?,?,?)`, [user.id, sp, customerId, subject, input.oneLine ?? subject, iso, nowIso, callId, kind, user.id]);
      res.created.push({ id, remindAt: iso, label: `${faDate(iso)} ساعت ${faTime(iso)}`, kind, shifted });
    };
    if (input.outcome === "follow_up" && input.followUpAt) {
      const w = toWorkingTime(input.followUpAt); mk(w.at, "followup", "پیگیری بعدی", w.shifted);
    } else if (input.outcome === "no_answer" && f.autoclose) {
      const n = trailingNoAnswer(customerId, callId) + 1;
      res.naAttempt = Math.min(n, CQ_NA_MAX);
      executeChanges("UPDATE call_logs SET na_attempt=? WHERE id=?", [n, callId]);
      if (n < CQ_NA_MAX) {
        const w = toWorkingTime(new Date(Date.parse(nowIso) + (n === 1 ? 4 : 24) * 3_600_000));
        mk(w.at, "no_answer", `تلاش ${n + 1} از ۳ · پاسخ نداد`, w.shifted);
      } else {
        const c = queryRow<{ priority: number | null; name: string | null }>("SELECT priority,name FROM customers WHERE id=?", [customerId]);
        if (Number(c?.priority) === 1) {
          res.p1NoAnswer3 = true;
          cqEvent("p1_no_answer_3", { userId: user.id, salespersonId: sp, customerId, callId, note: input.oneLine, at: nowIso });
          if (f.p1_notify) res.managerNotified = notifyManagersP1(customerId, c?.name ?? "", user, nowIso) > 0;
        } else {
          // Spec says «بایگانی سرد»; R1 never changes status/priority by itself — it only suggests (like CALLBACK_CONFIG).
          res.coldSuggest = true;
          cqEvent("na3_cold_suggest", { userId: user.id, salespersonId: sp, customerId, callId, at: nowIso });
        }
      }
    }
  }
  return res;
}
function notifyManagersP1(customerId: number, name: string, user: CqUser & { fullName?: string | null; username?: string }, at: string): number {
  const has = (crmDb.prepare("PRAGMA table_info(site_notification_events)").all() as { name: string }[]).some(c => c.name === "recipient_user_id");
  if (!has) return 0;
  const c = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=?", [customerId]);
  const who = user.fullName || user.username || "کارشناس";
  let n = 0;
  for (const uid of cqManagerIds()) {
    execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(?,?,?,'customer',?,'cq-p1-no-answer-3',?,?,'customers.view',?,'call-queue:system',?)`,
      [customerId, name, c?.salesperson_id ?? null, customerId, "۳ تلاش بی‌پاسخ · اولویت ۱", `${who}: سومین تلاش بی‌پاسخ. تلاش بعدی ساخته نشد؛ پرونده را ببین.`, at, uid]);
    n++;
  }
  return n;
}
/** R2: a CRM-button report fills call_logs.source/started_at/returned_at/report_saved_at and unlocks; a manual one never unlocks. */
function cqLinkReport(callId: number, input: CqCallInput, user: CqUser, customerId: number, nowIso: string) {
  if (input.startedCallId) {
    const p = queryRow<any>("SELECT * FROM call_queue_calls WHERE id=? AND user_id=? AND report_saved_at IS NULL", [input.startedCallId, user.id]);
    if (p) {
      const ot = cqOnTime(p.link_issued_at, p.returned_at, nowIso);
      executeChanges("UPDATE call_queue_calls SET report_saved_at=?, call_log_id=?, on_time=? WHERE id=?", [nowIso, callId, ot ? 1 : 0, p.id]);
      executeChanges(`UPDATE call_logs SET outcome=?, one_line_note=?, source='crm_button', manual_type=NULL, started_at=?, returned_at=?, report_saved_at=? WHERE id=?`,
        [input.outcome, input.oneLine, p.link_issued_at, p.returned_at ?? null, nowIso, callId]);
      return;
    }
  }
  // manual entry: report_saved_at stays NULL (it never counts and never unlocks)
  executeChanges("UPDATE call_logs SET outcome=?, one_line_note=?, source='manual', manual_type=? WHERE id=?", [input.outcome, input.oneLine, input.manualType ?? null, callId]);
  cqManualSignal(user, customerId, callId, input.manualType, nowIso);
}
/** §8-33 signal_manual_no_crm: a manual save with no CRM-button call the same Tehran day for the same customer by the same expert. */
export function cqManualSignal(user: CqUser, customerId: number, callId: number, manualType: string | null, nowIso: string) {
  const p = tParts(new Date(nowIso)); const from = fromTehran(p.y, p.m, p.d).toISOString(); const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const had = queryRow("SELECT 1 FROM call_queue_calls WHERE user_id=? AND customer_id=? AND link_issued_at>=? AND link_issued_at<?", [user.id, customerId, from, to]);
  if (!had) cqEvent("signal_manual_no_crm", { userId: user.id, salespersonId: user.salespersonId, customerId, callId, reason: manualType, at: nowIso });
}
/** «به‌موقع» (§8-21/22): returned → report ≤ on_time_min; no return → report − link ≤ on_time_cap_min. */
export function cqOnTime(linkIso: string, returnedIso: string | null, reportIso: string): boolean {
  const { onTimeMin, onTimeCapMin } = cqDisciplineSettings();
  const rep = Date.parse(reportIso);
  if (returnedIso) return rep - Date.parse(returnedIso) <= onTimeMin * 60_000;
  return rep - Date.parse(linkIso) <= onTimeCapMin * 60_000;
}
export type CqDisciplineSettings = { onTimeMin: number; onTimeCapMin: number; newPct: number; newMaxOverdue: number; restrictOverdue: number; alertDays: number;
  wReport: number; wOverdue: number; wNocall: number; dropPct: number; transferMode: "warn" | "block"; excludedReceivers: number[] };
export const CQ_DS_DEFAULTS: CqDisciplineSettings = { onTimeMin: 10, onTimeCapMin: 30, newPct: 90, newMaxOverdue: 5, restrictOverdue: 10, alertDays: 3,
  wReport: 70, wOverdue: 30, wNocall: 5, dropPct: 50, transferMode: "warn", excludedReceivers: [31] };
const DS_KEYS: Record<keyof CqDisciplineSettings, string> = { onTimeMin: "on_time_min", onTimeCapMin: "on_time_cap_min", newPct: "new_customer_pct", newMaxOverdue: "new_customer_max_overdue",
  restrictOverdue: "restrict_overdue", alertDays: "alert_days", wReport: "w_report", wOverdue: "w_overdue", wNocall: "w_nocall", dropPct: "drop_pct", transferMode: "transfer_mode", excludedReceivers: "excluded_receivers" };
export const CQ_DS_RANGES: Partial<Record<keyof CqDisciplineSettings, [number, number]>> = { onTimeMin: [1, 120], onTimeCapMin: [1, 120], newPct: [1, 100], newMaxOverdue: [0, 100],
  restrictOverdue: [1, 200], alertDays: [1, 10], wReport: [0, 100], wOverdue: [0, 100], wNocall: [0, 50], dropPct: [1, 100] };
export function cqDisciplineSettings(): CqDisciplineSettings {
  const out: any = { ...CQ_DS_DEFAULTS };
  for (const [k, key] of Object.entries(DS_KEYS) as [keyof CqDisciplineSettings, string][]) {
    const v = raw(`ds.${key}`); if (v == null) continue;
    if (k === "transferMode") { if (v === "warn" || v === "block") out.transferMode = v; continue; }
    if (k === "excludedReceivers") { try { const a = JSON.parse(v); if (Array.isArray(a) && a.every(x => Number.isInteger(x) && x > 0)) out.excludedReceivers = a; } catch { /* default */ } continue; }
    const n = Number(v); const r = CQ_DS_RANGES[k]!; if (Number.isInteger(n) && n >= r[0] && n <= r[1]) out[k] = n;
  }
  return out;
}
export function validateDiscipline(b: any): { ok: true; value: Partial<CqDisciplineSettings> } | { ok: false; error: string } {
  const cur = cqDisciplineSettings(); const out: any = {};
  for (const k of Object.keys(CQ_DS_RANGES) as (keyof CqDisciplineSettings)[]) {
    if (b?.[k] === undefined) continue; const v = Number(b[k]); const r = CQ_DS_RANGES[k]!;
    if (!Number.isInteger(v) || v < r[0] || v > r[1]) return { ok: false, error: `مقدار «${k}» باید عدد صحیح بین ${r[0]} تا ${r[1]} باشد.` };
    out[k] = v;
  }
  if (b?.transferMode !== undefined) { if (b.transferMode !== "warn" && b.transferMode !== "block") return { ok: false, error: "حالت بررسی انتقال: هشدار یا جلوگیری." }; out.transferMode = b.transferMode; }
  if (b?.excludedReceivers !== undefined) {
    const a = b.excludedReceivers; if (!Array.isArray(a) || a.length > 50 || !a.every((x: unknown) => Number.isInteger(x) && Number(x) > 0)) return { ok: false, error: "فهرست کاربران مستثنا معتبر نیست." };
    out.excludedReceivers = [...new Set(a.map(Number))].sort((x, y) => x - y);
  }
  const m = { ...cur, ...out };
  if (m.onTimeCapMin < m.onTimeMin) return { ok: false, error: "سقف بدون بازگشت باید دست‌کم برابر پنجره‌ی به‌موقع باشد." };
  if (m.wReport + m.wOverdue !== 100) return { ok: false, error: "وزن «به‌موقع» و «عقب‌افتاده» باید روی هم ۱۰۰ شود." };
  if (m.restrictOverdue <= m.newMaxOverdue) return { ok: false, error: "حد پنل محدود باید از حد دریافت مشتری جدید بیشتر باشد." };
  return { ok: true, value: out };
}
export function saveDiscipline(v: Partial<CqDisciplineSettings>, userId: number, at = new Date().toISOString()): number {
  let n = 0;
  for (const [k, val] of Object.entries(v) as [keyof CqDisciplineSettings, unknown][])
    n += +setRaw(`ds.${DS_KEYS[k]}`, Array.isArray(val) ? JSON.stringify(val) : String(val), userId, at);
  return n;
}

/** team-sales first-call form path: only the auto-close part (that form has its own attempt counter). */
export function cqAutoCloseOnly(callId: number, user: CqUser, customerId: number, outcome: string | null, nowIso: string): void {
  if (!cqEligible(user)) return;
  const f = cqFlags();
  if (cqLockOn(user, f)) {
    // The first-call form is the report of a CRM-button call only when one is pending for this customer; otherwise it is a plain save.
    const pend = cqPendingCall(user.id);
    if (pend && Number(pend.customer_id) === customerId) {
      const ot = cqOnTime(pend.link_issued_at, pend.returned_at, nowIso);
      executeChanges("UPDATE call_queue_calls SET report_saved_at=?, call_log_id=?, on_time=? WHERE id=?", [nowIso, callId, ot ? 1 : 0, pend.id]);
      executeChanges("UPDATE call_logs SET source='crm_button', started_at=?, returned_at=?, report_saved_at=? WHERE id=?", [pend.link_issued_at, pend.returned_at ?? null, nowIso, callId]);
    }
  }
  if (f.result && outcome) executeChanges("UPDATE call_logs SET outcome=COALESCE(outcome,?), created_by_user_id=? WHERE id=?",
    [outcome === "answered" ? "answered" : outcome === "no_answer" ? "no_answer" : "follow_up", user.id, callId]);
  if (!f.autoclose) return;
  const n = executeChanges(`UPDATE reminders SET done=1, closed_by_call_id=?, closed_at=? WHERE user_id=? AND customer_id=? AND done=0 AND voided_at IS NULL AND remind_at<=?`,
    [callId, nowIso, user.id, customerId, nowIso]);
  if (n) cqEvent("auto_close", { userId: user.id, salespersonId: user.salespersonId, customerId, callId, data: { count: n, via: "first_call" }, at: nowIso });
}

/** One-line note + notes, without repeating the same text twice (the modal stores it in both). */
function cqNoteText(one: unknown, notes: unknown): string {
  const a = String(one ?? "").trim(), b = String(notes ?? "").trim();
  return a && b && a !== b ? `${a}\n${b}` : (a || b);
}

/* ---------------- after-save summary (for the toast + suggestion card) ---------------- */
export function cqAfterSave(user: CqUser, callId: number, now = new Date()) {
  ensureCallQueueSchema();
  const f = cqFlags();
  const call = queryRow<any>(`SELECT id,customer_id,outcome,one_line_note,expert_notes,na_attempt,created_at FROM call_logs WHERE id=? AND created_by_user_id=?
    AND created_at>=?`, [callId, user.id, new Date(now.getTime() - 30 * 60_000).toISOString()]);
  if (!call) return { found: false as const };
  const closed = queryRows<{ id: number; remind_at: string }>("SELECT id,remind_at FROM reminders WHERE closed_by_call_id=? ORDER BY remind_at", [call.id])
    .map(r => ({ id: Number(r.id), remindAt: r.remind_at, label: faDate(r.remind_at) }));
  const created = queryRows<{ id: number; remind_at: string; source: string | null }>("SELECT id,remind_at,source FROM reminders WHERE call_id=? AND user_id=? ORDER BY id", [call.id, user.id])
    .map(r => ({ id: Number(r.id), remindAt: r.remind_at, label: `${faDate(r.remind_at)} ساعت ${faTime(r.remind_at)}`, kind: r.source ?? "manual" }));
  const p1 = Boolean(queryRow("SELECT 1 FROM call_queue_events WHERE kind='p1_no_answer_3' AND call_id=?", [call.id]));
  const cold = Boolean(queryRow("SELECT 1 FROM call_queue_events WHERE kind='na3_cold_suggest' AND call_id=?", [call.id]));
  let suggestion: (PhraseHit & { text: string }) | null = null;
  const decided = queryRow("SELECT 1 FROM call_queue_events WHERE kind IN ('assistant_reminder_created','assistant_suggestion_rejected') AND call_id=?", [call.id])
    || queryRow("SELECT 1 FROM reminders WHERE source='assistant' AND source_note_id=?", [call.id]);
  const futureMade = created.some(c => Date.parse(c.remindAt) > now.getTime());
  if (f.assistant_reminders && cqEligible(user) && !decided && !futureMade && call.outcome !== "follow_up") {
    const text = cqNoteText(call.one_line_note, call.expert_notes);
    const hit = detectFollowUpPhrase(text, now);
    if (hit) suggestion = { ...hit, text };
  }
  const customerId = Number(call.customer_id);
  const cust = queryRow<{ name: string | null }>("SELECT name FROM customers WHERE id=?", [customerId]);
  return { found: true as const, callId: Number(call.id), customerId, customerName: cust?.name ?? "", outcome: call.outcome ?? null, naAttempt: call.na_attempt ?? null,
    closed, created, p1NoAnswer3: p1, coldSuggest: cold, suggestion, naTemplate: call.outcome === "no_answer" ? cqSettings().naTemplate : null };
}

/* ---------------- reminders: due / snooze / void / date ---------------- */
const nowIsoOf = (d: Date) => d.toISOString();
export function cqOwnedCustomerSql(alias = "c") { return `${alias}.merged_into_customer_id IS NULL AND ${alias}.salesperson_id=?`; }
export function cqDue(user: CqUser, now = new Date()) {
  const n = nowIsoOf(now);
  const rows = queryRows<any>(`SELECT r.id,r.customer_id,r.subject,r.message,r.remind_at,r.source,r.source_note_id,r.source_span,r.snooze_until,r.snooze_used,
      c.name customer_name, c.phone, c.priority, COALESCE(c.is_urgent,0) is_urgent
    FROM reminders r JOIN customers c ON c.id=r.customer_id
    WHERE r.user_id=? AND r.done=0 AND r.voided_at IS NULL AND r.remind_at<=? AND ${cqOwnedCustomerSql()} ORDER BY COALESCE(c.is_urgent,0) DESC, r.remind_at, r.id LIMIT 200`, [user.id, n, user.salespersonId ?? -1]);
  const view = rows.map(reminderView);
  const active = view.filter(r => !r.snoozeUntil || Date.parse(r.snoozeUntil) <= now.getTime());
  const snoozed = view.filter(r => r.snoozeUntil && Date.parse(r.snoozeUntil) > now.getTime());
  return { now: n, items: active, snoozed, total: view.length };
}
function reminderView(r: any) {
  let span: { start: number; end: number; phrase: string } | null = null; try { span = r.source_span ? JSON.parse(r.source_span) : null; } catch { span = null; }
  const note = r.source === "assistant" && r.source_note_id ? queryRow<any>(`SELECT cl.id, COALESCE(cl.one_line_note,'') one, COALESCE(cl.expert_notes,'') notes, cl.created_at,
    COALESCE(u.full_name,u.username,cl.salesperson_name_snapshot) author FROM call_logs cl LEFT JOIN users u ON u.id=cl.created_by_user_id WHERE cl.id=?`, [r.source_note_id]) : null;
  return { id: Number(r.id), customerId: Number(r.customer_id), customerName: r.customer_name ?? "", phone: r.phone ?? null, priority: r.priority ?? null, urgent: Number(r.is_urgent) === 1,
    subject: r.subject ?? "", message: r.message ?? "", remindAt: r.remind_at, source: r.source ?? "manual", snoozeUntil: r.snooze_until ?? null, snoozeUsed: Boolean(r.snooze_used),
    sourceNote: note ? { callId: Number(note.id), text: [note.one, note.notes].filter(Boolean).join("\n"), at: note.created_at, author: note.author ?? null, span } : null };
}
const ownReminder = (user: CqUser, id: number) => queryRow<any>(`SELECT r.*, c.name customer_name FROM reminders r JOIN customers c ON c.id=r.customer_id
  WHERE r.id=? AND r.user_id=? AND ${cqOwnedCustomerSql()}`, [id, user.id, user.salespersonId ?? -1]);
export function cqSnooze(user: CqUser, id: number, now = new Date()): { status: number; error?: string; until?: string } {
  const r = ownReminder(user, id); if (!r) return { status: 404, error: "یادآور پیدا نشد." };
  if (r.done || r.voided_at) return { status: 409, error: "این یادآور بسته شده است." };
  if (Date.parse(r.remind_at) > now.getTime()) return { status: 409, error: "این یادآور هنوز سررسید نشده است." };
  if (r.snooze_used) return { status: 409, error: "برای این یادآور یک بار ۱۰ دقیقه عقب انداختی؛ دوباره نمی‌شود." };
  const until = new Date(now.getTime() + CQ_SNOOZE_MIN * 60_000).toISOString();
  if (!executeChanges("UPDATE reminders SET snooze_until=?, snooze_used=1 WHERE id=? AND snooze_used=0", [until, id])) return { status: 409, error: "قبلاً عقب افتاده است." };
  cqEvent("snooze", { userId: user.id, salespersonId: user.salespersonId, customerId: r.customer_id, reminderId: id, data: { from: now.toISOString(), until }, at: now.toISOString() });
  return { status: 200, until };
}
export function cqVoid(user: CqUser, id: number, reason: unknown, note: unknown, now = new Date()): { status: number; error?: string } {
  const r = ownReminder(user, id); if (!r) return { status: 404, error: "یادآور پیدا نشد." };
  if (r.source !== "assistant") return { status: 403, error: "فقط یادآورهای ساخته‌شده توسط دستیار باطل می‌شوند." };
  if (r.voided_at || r.done) return { status: 409, error: "این یادآور بسته شده است." };
  const why = String(reason ?? ""); const txt = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!CQ_VOID_REASONS[why] || !txt) return { status: 400, error: "دلیل و توضیح کوتاه را بنویس." };
  if ([...txt].length > CQ_LIMITS.voidNoteMax) return { status: 400, error: "توضیح حداکثر ۶۰ نویسه است." };
  const at = now.toISOString();
  executeChanges("UPDATE reminders SET voided_at=?, void_reason=?, void_note=?, voided_by=?, done=1 WHERE id=? AND voided_at IS NULL", [at, why, txt, user.id, id]);
  const src = r.source_note_id ? queryRow<any>("SELECT COALESCE(one_line_note,'') one, COALESCE(expert_notes,'') notes FROM call_logs WHERE id=?", [r.source_note_id]) : null;
  cqEvent("void", { userId: user.id, salespersonId: user.salespersonId, customerId: r.customer_id, reminderId: id, callId: r.source_note_id ?? null, reason: why, note: txt,
    data: { sourceText: src ? [src.one, src.notes].filter(Boolean).join("\n").slice(0, 400) : null, span: r.source_span ?? null }, at });
  return { status: 200 };
}
export function cqEditDate(user: CqUser, id: number, remindAt: unknown, now = new Date()): { status: number; error?: string; remindAt?: string; shifted?: boolean } {
  const r = ownReminder(user, id); if (!r) return { status: 404, error: "یادآور پیدا نشد." };
  if (r.done || r.voided_at) return { status: 409, error: "این یادآور بسته شده است." };
  const d = new Date(String(remindAt ?? "")); if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) return { status: 400, error: "زمان یادآور باید در آینده باشد." };
  const w = toWorkingTime(d);
  executeChanges("UPDATE reminders SET remind_at=?, snooze_until=NULL, notified_at=NULL WHERE id=?", [w.at.toISOString(), id]);
  cqEvent("date_edit", { userId: user.id, salespersonId: user.salespersonId, customerId: r.customer_id, reminderId: id, data: { from: r.remind_at, to: w.at.toISOString() }, at: now.toISOString() });
  return { status: 200, remindAt: w.at.toISOString(), shifted: w.shifted };
}
/** Suggest-first: the expert confirmed the assistant's suggestion on their own call. The server re-detects from the stored note. */
export function cqAcceptSuggestion(user: CqUser, callId: number, remindAtOverride: unknown, now = new Date()): { status: number; error?: string; reminderId?: number; remindAt?: string } {
  const call = queryRow<any>(`SELECT cl.* FROM call_logs cl JOIN customers c ON c.id=cl.customer_id WHERE cl.id=? AND cl.created_by_user_id=? AND ${cqOwnedCustomerSql()}`, [callId, user.id, user.salespersonId ?? -1]);
  if (!call) return { status: 404, error: "تماس پیدا نشد." };
  if (queryRow("SELECT 1 FROM reminders WHERE source='assistant' AND source_note_id=?", [callId])) return { status: 409, error: "یادآور این یادداشت قبلاً ساخته شده." };
  const text = cqNoteText(call.one_line_note, call.expert_notes);
  const hit = detectFollowUpPhrase(text, now); if (!hit) return { status: 422, error: "در یادداشت زمان پیگیری پیدا نشد." };
  let at = new Date(hit.remindAt);
  if (remindAtOverride != null && remindAtOverride !== "") {
    const d = new Date(String(remindAtOverride)); if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) return { status: 400, error: "زمان یادآور باید در آینده باشد." };
    at = toWorkingTime(d).at;
  }
  const iso = at.toISOString(); const nowIso = now.toISOString();
  const id = execute(`INSERT INTO reminders(user_id,salesperson_id,customer_id,subject,message,remind_at,sent_sms,done,created_at,call_id,source,source_note_id,source_span,created_by)
    VALUES(?,?,?,?,?,?,0,0,?,?, 'assistant', ?, ?, ?)`, [user.id, user.salespersonId ?? null, call.customer_id, "پیگیری (پیشنهاد دستیار)", `«${hit.phrase}» — ${String(call.one_line_note || call.expert_notes || "").slice(0, 160)}`,
    iso, nowIso, callId, callId, JSON.stringify({ start: hit.start, end: hit.end, phrase: hit.phrase }), user.id]);
  cqEvent("assistant_reminder_created", { userId: user.id, salespersonId: user.salespersonId, customerId: call.customer_id, reminderId: id, callId, data: { phrase: hit.phrase, remindAt: iso }, at: nowIso });
  return { status: 200, reminderId: id, remindAt: iso };
}
export function cqRejectSuggestion(user: CqUser, callId: number, now = new Date()): { status: number; error?: string } {
  const call = queryRow<any>("SELECT id,customer_id FROM call_logs WHERE id=? AND created_by_user_id=?", [callId, user.id]);
  if (!call) return { status: 404, error: "تماس پیدا نشد." };
  if (!queryRow("SELECT 1 FROM call_queue_events WHERE kind='assistant_suggestion_rejected' AND call_id=?", [callId]))
    cqEvent("assistant_suggestion_rejected", { userId: user.id, salespersonId: user.salespersonId, customerId: call.customer_id, callId, at: now.toISOString() });
  return { status: 200 };
}

/* ---------------- the single queue ---------------- */
export type QueueCard = { customerId: number; name: string; phone: string | null; priority: number | null; urgent: boolean; group: QueueCardGroup; also: QueueGroup[];
  reason: string; at: string | null; late: boolean; reminder: ReturnType<typeof reminderView> | null; lastCall: { at: string; text: string } | null; assistRank?: number; isUrgent?: boolean };
export function cqQueue(user: CqUser, suggestions: { customerId: number; rank: number; reason?: string }[], now = new Date()) {
  const s = cqSettings(); const sp = user.salespersonId ?? -1; const n = now.toISOString();
  const groups = new Map<number, Set<QueueGroup>>(); const add = (id: number, g: QueueGroup) => { const x = groups.get(id) ?? new Set(); x.add(g); groups.set(id, x); };
  const due = cqDue(user, now); const dueBy = new Map<number, ReturnType<typeof reminderView>>();
  for (const r of [...due.items, ...due.snoozed]) { if (!dueBy.has(r.customerId)) dueBy.set(r.customerId, r); add(r.customerId, "due"); }
  const fresh = queryRows<{ id: number; created_at: string }>(`SELECT c.id, c.created_at FROM customers c WHERE ${cqOwnedCustomerSql()} AND c.status='in_progress'
    AND NOT EXISTS(SELECT 1 FROM call_logs l WHERE l.customer_id=c.id) ORDER BY c.created_at LIMIT 300`, [sp]);
  const freshAt = new Map(fresh.map(r => [Number(r.id), r.created_at])); for (const r of fresh) add(Number(r.id), "new");
  const staleBefore = new Date(now.getTime() - s.p1StaleDays * 86_400_000).toISOString();
  const p1 = queryRows<{ id: number; last: string | null }>(`SELECT c.id, (SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id) last FROM customers c
    WHERE ${cqOwnedCustomerSql()} AND c.status='in_progress' AND c.priority=1 ORDER BY c.id`, [sp]).filter(r => !r.last || r.last < staleBefore);
  const p1At = new Map(p1.map(r => [Number(r.id), r.last])); for (const r of p1) add(Number(r.id), "p1");
  const sugBy = new Map(suggestions.map(x => [x.customerId, x])); for (const x of suggestions) add(x.customerId, "assist");
  // «مشتری فوری»: every owned in-progress urgent customer is in the queue, on top.
  const urgentRows = queryRows<{ id: number }>(`SELECT c.id FROM customers c WHERE ${cqOwnedCustomerSql()} AND c.status='in_progress' AND c.is_urgent=1 ORDER BY c.id LIMIT 200`, [sp]);
  const urgentIds = new Set(urgentRows.map(r => Number(r.id))); for (const r of urgentRows) if (!groups.has(Number(r.id))) groups.set(Number(r.id), new Set());
  const ids = [...groups.keys()];
  const info = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 400) {
    const ch = ids.slice(i, i + 400);
    for (const r of queryRows<any>(`SELECT c.id,c.name,c.phone,c.priority,COALESCE(c.is_urgent,0) is_urgent,(SELECT l.created_at||char(31)||COALESCE(NULLIF(l.one_line_note,''),l.expert_notes,'') FROM call_logs l WHERE l.customer_id=c.id ORDER BY l.id DESC LIMIT 1) lastcall
      FROM customers c WHERE c.id IN (${ch.map(() => "?").join(",")}) AND ${cqOwnedCustomerSql()}`, [...ch as SqlValue[], sp])) info.set(Number(r.id), r);
  }
  const rank = (g: QueueCardGroup) => g === "urgent" ? -1 : s.order.indexOf(g);
  // urgent v1.1 §0-18: urgent cards by the open flag's time, oldest first (fallback: reminder / new time).
  const flagAt = openUrgentFlags(crmDb, [...info.keys()].filter((k) => urgentIds.has(k) || Number(info.get(k)?.is_urgent) === 1));
  const cards: QueueCard[] = [];
  for (const [id, set] of groups) {
    const c = info.get(id); if (!c) continue;
    const gs = [...set].sort((a, b) => rank(a) - rank(b));
    const urgent = urgentIds.has(id) || Number(c.is_urgent) === 1;
    const g: QueueCardGroup = urgent ? "urgent" : gs[0];
    const [lcAt, lcText] = c.lastcall ? String(c.lastcall).split("\u001f") : [null, null];
    let reason = "", at: string | null = null, late = false;
    if (g === "urgent") {
      const r = dueBy.get(id); at = flagAt.get(id)?.at ?? r?.remindAt ?? freshAt.get(id) ?? null; late = Boolean(r);
      reason = ["مشتری فوری", r ? (r.subject || "یادآور سررسیده") : freshAt.has(id) ? "جدید" : sugBy.get(id)?.reason || ""].filter(Boolean).join(" · ");
    } else if (g === "due") { const r = dueBy.get(id)!; at = r.remindAt; late = true; reason = r.subject || "یادآور سررسیده"; }
    else if (g === "new") { at = freshAt.get(id) ?? null; late = !!at && now.getTime() - Date.parse(at) > s.newRedHours * 3_600_000; reason = late ? `جدید · بیش از ${s.newRedHours} ساعت` : "جدید"; }
    else if (g === "p1") { at = p1At.get(id) ?? null; late = true; reason = at ? `اولویت ۱ · بیش از ${s.p1StaleDays} روز بی‌تماس` : "اولویت ۱ · هنوز تماسی ثبت نشده"; }
    else { reason = sugBy.get(id)?.reason || "پیشنهاد امروز دستیار فروش"; }
    cards.push({ customerId: id, name: c.name ?? "", phone: c.phone ?? null, priority: c.priority ?? null, urgent, group: g, also: g === "urgent" ? gs : gs.slice(1), reason, at, late,
      reminder: dueBy.get(id) ?? null, lastCall: lcAt ? { at: lcAt, text: String(lcText ?? "").slice(0, 140) } : null, assistRank: sugBy.get(id)?.rank, isUrgent: urgent });
  }
  const within = (a: QueueCard, b: QueueCard) => {
    if (a.group === "urgent") return String(a.at ?? "~").localeCompare(String(b.at ?? "~")) || a.customerId - b.customerId;
    if (a.group === "assist") return (a.assistRank ?? 9) - (b.assistRank ?? 9);
    return String(a.at ?? "").localeCompare(String(b.at ?? ""));
  };
  // «مشتری فوری» (PM 22:28 / Kazemi 07107f3): the "urgent" pseudo-group ranks above every group (rank -1), so urgent cards come first.
  cards.sort((a, b) => rank(a.group) - rank(b.group) || within(a, b));
  const counts = Object.fromEntries([...CQ_GROUPS, "urgent" as const].map(g => [g, cards.filter(c => c.group === g).length])) as Record<QueueCardGroup, number>;
  return { now: n, order: s.order, settings: { newRedHours: s.newRedHours, p1StaleDays: s.p1StaleDays }, counts, total: cards.length, cards, snoozed: due.snoozed };
}

/* ---------------- manager report ---------------- */
export const CQ_REPORT_KINDS = ["snooze", "void", "p1_no_answer_3"] as const;
export function cqEvents(q: { kind?: string; salespersonId?: number | null; day?: string | null }) {
  ensureCallQueueSchema();
  const where: string[] = [`e.kind IN (${CQ_REPORT_KINDS.map(() => "?").join(",")})`]; const p: SqlValue[] = [...CQ_REPORT_KINDS];
  if (q.kind && (CQ_REPORT_KINDS as readonly string[]).includes(q.kind)) { where.push("e.kind=?"); p.push(q.kind); }
  if (q.salespersonId) { where.push("e.salesperson_id=?"); p.push(q.salespersonId); }
  const day = q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : tYmd(tParts(new Date()));
  const [y, m, d] = day.split("-").map(Number); const from = fromTehran(y, m, d).toISOString(); const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  where.push("e.created_at>=? AND e.created_at<?"); p.push(from, to);
  where.push(`COALESCE(e.user_id,0) NOT IN (${[...CQ_EXCLUDED_USER_IDS].join(",")})`);
  const rows = queryRows<any>(`SELECT e.*, c.name customer_name, s.name salesperson_name, r.subject reminder_subject, r.remind_at reminder_at, r.snooze_until,
      (SELECT MIN(l.created_at) FROM call_logs l WHERE l.customer_id=e.customer_id AND l.created_at>e.created_at) next_call_at
    FROM call_queue_events e LEFT JOIN customers c ON c.id=e.customer_id LEFT JOIN salespersons s ON s.id=e.salesperson_id LEFT JOIN reminders r ON r.id=e.reminder_id
    WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT 300`, p);
  const items = rows.map(r => {
    let data: any = null; try { data = r.data_json ? JSON.parse(r.data_json) : null; } catch { data = null; }
    return { id: Number(r.id), kind: r.kind, at: r.created_at, userId: r.user_id, salespersonId: r.salesperson_id, salespersonName: r.salesperson_name ?? null,
      customerId: r.customer_id, customerName: r.customer_name ?? "", reminderId: r.reminder_id, reminderSubject: r.reminder_subject ?? null, reminderAt: r.reminder_at ?? null,
      reason: r.reason ? (CQ_VOID_REASONS[r.reason] ?? r.reason) : null, note: r.note ?? null, sourceText: data?.sourceText ?? null,
      reopenAt: r.kind === "snooze" ? (data?.until ?? null) : null, nextCallAt: r.next_call_at ?? null, seenAt: r.seen_at ?? null };
  });
  const counts = Object.fromEntries(CQ_REPORT_KINDS.map(k => [k, items.filter(i => i.kind === k).length]));
  return { day, items, counts };
}
export function cqMarkSeen(id: number, userId: number) {
  return executeChanges("UPDATE call_queue_events SET seen_at=COALESCE(seen_at,?), seen_by=COALESCE(seen_by,?) WHERE id=?", [new Date().toISOString(), userId, id]) > 0;
}

/** Shown inside the call form before saving: due reminders that this call will close, and the no-answer attempt number it would be. */
export function cqPreCall(user: CqUser, customerId: number, now = new Date()) {
  ensureCallQueueSchema();
  const f = cqFlags();
  const due = f.autoclose ? queryRows<{ id: number; remind_at: string; subject: string | null }>(`SELECT id,remind_at,subject FROM reminders WHERE user_id=? AND customer_id=? AND done=0
    AND voided_at IS NULL AND remind_at<=? ORDER BY remind_at`, [user.id, customerId, now.toISOString()]).map(r => ({ id: Number(r.id), remindAt: r.remind_at, label: faDate(r.remind_at), subject: r.subject ?? "" })) : [];
  const last = queryRow<{ id: number }>("SELECT MAX(id) id FROM call_logs WHERE customer_id=?", [customerId]);
  const naBefore = last?.id ? trailingNoAnswer(customerId, Number(last.id) + 1) : 0;
  const c = queryRow<{ priority: number | null }>("SELECT priority FROM customers WHERE id=?", [customerId]);
  return { due, naAttemptIfNoAnswer: Math.min(naBefore + 1, CQ_NA_MAX), p1: Number(c?.priority) === 1 };
}

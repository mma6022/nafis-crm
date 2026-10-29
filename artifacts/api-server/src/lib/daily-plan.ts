import { noteText } from "./note-text";
/**
 * crm-daily-plan «کارهای امروز» (Armita v1.2, PM decisions 1–14). Everything is behind flag.daily_plan (seeded OFF);
 * flag.assistant_full_scope and flag.daily_plan_discipline are separate and OFF too. While flag.daily_plan is OFF every
 * read answers {enabled:false}, every write is refused and the jobs return immediately.
 * Nothing here ever sends an SMS, a Bale message or anything else to a customer. Manager notices are CRM bells only
 * (admins 1 and 5) plus assistant events (Ahmad's inbox and the expert's own assistant).
 * Defaults are listed in nafis-deploy/DAILY-PLAN-DECISIONS.md.
 */
import { createHash } from "node:crypto";
import { execute, executeChanges, queryRow, queryRows, runImmediateTransaction, type SqlValue } from "./crm-db";
import {
  CQ_EXCLUDED_USER_IDS, CQ_LIMITS, CQ_OUTCOMES, cqDisciplineSettings, cqFlags, cqOnTime, cqPendingCall, cqQueue, cqRaw, cqSetRaw, ensureCallQueueSchema,
  fromTehran, isWorkDay, tParts, tYmd, type CqUser,
} from "./call-queue";
import { cqEligibleUsers } from "./call-queue-r2";
import { realCallSql } from "./real-call";
import { getTeamSalesConfig } from "./team-sales";
import { salesAssistScope, suggestionsFor } from "./sales-assist";

/* ---------------- constants & names (final names for Armita: see DECISIONS) ---------------- */
export const DP_TYPES = ["urgent", "due", "first", "followup", "loan_followup"] as const;
export type DpType = typeof DP_TYPES[number];
export const DP_TYPE_LABELS: Record<DpType, string> = { urgent: "فوری", due: "یادآور سررسیده", first: "تماس اول", followup: "پیگیری", loan_followup: "پیگیری وام" };
const RANK: Record<DpType, number> = { urgent: 0, due: 1, first: 2, followup: 3, loan_followup: 3 };
export const DP_EVENTS = { finished: "daily_plan_finished", rejected: "daily_plan_rejected", capacityOverride: "daily_plan_capacity_override", backlog: "daily_plan_backlog", boost: "daily_plan_boost" } as const;
export const DP_LABELS = { auto: "لیست خودکار", added: "تازه اضافه شد", urgent: "فوری", due: "سررسید", carried: "مانده از دیروز", supplementary: "تکمیلی",
  transferred: "منتقل شد", outOfList: "خارج از لیست", outOfGuard: "خارج از حد", autoDay: "خودکار", boost: "اولویت دستیار", referral: "تماس با مشتری ارجاعی" } as const;
export const DP_BOOST_MAX = 20;
export const DP_MOVE_MAX = 2;
export const DP_MOVE_LAST_MIN = 17 * 60 + 45;
export const DP_START_MIN = 8 * 60, DP_CLOSE_MIN = 18 * 60;
export const DP_REASON_MAX = 80, DP_KEYNOTE_MAX = 120, DP_MOVE_TEXT_MAX = null, DP_CAP_REASON_MAX = 120, DP_ROWS_MAX = 200, DP_CAP_MAX = 200;
export const DP_AUTO_BATCH = 5;
export const DP_IDEM_HOURS = 48;
export const DP_OUT_OF_LIST_SUBJECT = "خارج از لیست · تماس ورودی";
export const DP_TIMELINE_PREFIX = "کارهای امروز ·";
export const DP_MANAGER_USER_IDS: readonly number[] = [1, 5];
export const DP_MOVE_REASONS: Record<string, string> = { customer_asked_later: "مشتری خواست بعداً تماس بگیرم", other: "دلیل دیگر" };
export const DP_DEFAULTS = { guardPct: 20, waitMin: 10, firstDayCapacity: 20 as number | null };
export const DP_SCOPE_FIELDS = ["customerId", "name", "priority", "urgent", "openWork", "nextReminderAt", "lastOutcome", "shortNote"] as const;

/* ---------------- time helpers (Tehran, fixed +03:30) ---------------- */
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const noonOf = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return fromTehran(y, m, d, 12); };
export const dpToday = (now = new Date()) => tYmd(tParts(now));
export const dpIsWork = (ymd: string) => isWorkDay(tParts(noonOf(ymd)));
const minOf = (now: Date) => { const p = tParts(now); return p.h * 60 + p.mi; };
export function dpNextWork(ymd: string): string { let t = noonOf(ymd).getTime(); for (let i = 0; i < 60; i++) { t += 86_400_000; const p = tParts(new Date(t)); if (isWorkDay(p)) return tYmd(p); } return ymd; }
export function dpPrevWork(ymd: string): string { let t = noonOf(ymd).getTime(); for (let i = 0; i < 60; i++) { t -= 86_400_000; const p = tParts(new Date(t)); if (isWorkDay(p)) return tYmd(p); } return ymd; }
export function dpWorkDays(from: string, to: string, max = 62): string[] {
  const out: string[] = []; let t = noonOf(from).getTime(); const end = noonOf(to).getTime();
  while (t <= end && out.length < max) { const p = tParts(new Date(t)); if (isWorkDay(p)) out.push(tYmd(p)); t += 86_400_000; } return out;
}
const atTehran = (ymd: string, min: number) => { const [y, m, d] = ymd.split("-").map(Number); return fromTehran(y, m, d, Math.floor(min / 60), min % 60); };
const hhmm = (iso: string) => { const p = tParts(new Date(iso)); return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`; };
const faDigits = (s: string) => s.replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
function dpPrevWorkN(ymd: string, n: number) { let d = ymd; for (let i = 0; i < n; i++) d = dpPrevWork(d); return d; }
const dpNextOpenDay = (now: Date) => { const t = dpToday(now); return dpIsWork(t) && minOf(now) < DP_START_MIN ? t : dpNextWork(t); };

/* ---------------- schema & settings ---------------- */
let schemaDone = false;
export function ensureDailyPlanSchema(): void {
  if (schemaDone) return; ensureCallQueueSchema();
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS dp_plans(id INTEGER PRIMARY KEY AUTOINCREMENT, salesperson_id INTEGER NOT NULL, user_id INTEGER NOT NULL, day TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'assistant', version INTEGER NOT NULL DEFAULT 0, written_at TEXT, assistant_id INTEGER, assistant_note TEXT, capacity INTEGER,
      backlog INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, auto_at TEXT, closed_at TEXT, created_at TEXT NOT NULL, UNIQUE(salesperson_id, day))`,
    `CREATE TABLE IF NOT EXISTS dp_items(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, type TEXT NOT NULL,
      reason TEXT, key_note TEXT, source TEXT NOT NULL, bucket TEXT NOT NULL, position REAL NOT NULL, boost_rank INTEGER, boost_at TEXT, label TEXT,
      status TEXT NOT NULL DEFAULT 'pending', move_count INTEGER NOT NULL DEFAULT 0, moved_to TEXT, outcome TEXT, call_log_id INTEGER, call_id INTEGER,
      became_current_at TEXT, done_at TEXT, created_at TEXT NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS idx_dp_items_plan ON dp_items(plan_id, status)",
    `CREATE TABLE IF NOT EXISTS dp_capacity_log(id INTEGER PRIMARY KEY AUTOINCREMENT, salesperson_id INTEGER NOT NULL, day TEXT NOT NULL, previous INTEGER,
      requested INTEGER NOT NULL, accepted INTEGER, outcome TEXT NOT NULL, out_of_guard INTEGER NOT NULL DEFAULT 0, reason TEXT, actor_kind TEXT NOT NULL,
      actor_id INTEGER, created_at TEXT NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS idx_dp_cap_sp ON dp_capacity_log(salesperson_id, day)",
    `CREATE TABLE IF NOT EXISTS dp_idempotency(assistant_id INTEGER NOT NULL, key TEXT NOT NULL, route TEXT NOT NULL, body_hash TEXT NOT NULL, status INTEGER NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(assistant_id, key))`,
    "CREATE TABLE IF NOT EXISTS dp_seen(plan_id INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(plan_id, ref))",
  ]) execute(sql);
  // DP-FIRSTCAP-51: additive column recording which one-time exemption (if any) a capacity row used.
  if (!queryRows<{ name: string }>("PRAGMA table_info(dp_capacity_log)").some(c => c.name === "exemption")) execute("ALTER TABLE dp_capacity_log ADD COLUMN exemption TEXT");
  schemaDone = true;
}
export type DpSettings = { guardPct: number; waitMin: number; firstDayCapacity: number | null };
export const DP_RANGES = { guardPct: [1, 100], waitMin: [0, 120], firstDayCapacity: [1, DP_CAP_MAX] } as const;
export function dpSettings(): DpSettings {
  const num = (k: string, d: number, [lo, hi]: readonly [number, number]) => { const raw = cqRaw(k); if (raw == null || String(raw).trim() === "") return d; const v = Number(raw); return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : d; };
  const fd = cqRaw("dp.firstDayCapacity");
  const first = fd == null ? DP_DEFAULTS.firstDayCapacity : fd === "" ? null : num("dp.firstDayCapacity", DP_DEFAULTS.firstDayCapacity ?? 20, DP_RANGES.firstDayCapacity);
  return { guardPct: num("dp.guardPct", DP_DEFAULTS.guardPct, DP_RANGES.guardPct), waitMin: num("dp.waitMin", DP_DEFAULTS.waitMin, DP_RANGES.waitMin), firstDayCapacity: first };
}
export function dpValidateSettings(b: any): { ok: true; value: Partial<DpSettings> } | { ok: false; error: string; field: string } {
  const v: Partial<DpSettings> = {};
  // spec §4-5 names (capacityGuardPct / supplementaryWaitMinutes) are accepted as aliases
  if (b && typeof b === "object") { b = { ...b }; if (b.capacityGuardPct !== undefined && b.guardPct === undefined) b.guardPct = b.capacityGuardPct; if (b.supplementaryWaitMinutes !== undefined && b.waitMin === undefined) b.waitMin = b.supplementaryWaitMinutes; }
  for (const k of ["guardPct", "waitMin"] as const) if (b?.[k] !== undefined) {
    const n = Number(b[k]); const [lo, hi] = DP_RANGES[k]; if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, field: k, error: `${k} باید عدد صحیح بین ${lo} و ${hi} باشد.` }; v[k] = n;
  }
  if (b?.firstDayCapacity !== undefined) {
    if (b.firstDayCapacity === null || b.firstDayCapacity === "") v.firstDayCapacity = null;
    else { const n = Number(b.firstDayCapacity); if (!Number.isInteger(n) || n < 1 || n > DP_CAP_MAX) return { ok: false, field: "firstDayCapacity", error: `ظرفیت روز اول باید بین ۱ و ${faDigits(String(DP_CAP_MAX))} یا خالی باشد.` }; v.firstDayCapacity = n; }
  }
  return { ok: true, value: v };
}
export function dpSaveSettings(v: Partial<DpSettings>, userId: number, at = new Date().toISOString()): number {
  let n = 0;
  if (v.guardPct !== undefined) n += cqSetRaw("dp.guardPct", String(v.guardPct), userId, at);
  if (v.waitMin !== undefined) n += cqSetRaw("dp.waitMin", String(v.waitMin), userId, at);
  if (v.firstDayCapacity !== undefined) n += cqSetRaw("dp.firstDayCapacity", v.firstDayCapacity == null ? "" : String(v.firstDayCapacity), userId, at);
  return n;
}

/* ---------------- flags / who ---------------- */
export const dpOn = () => cqFlags().daily_plan;
export const dpFullScope = () => cqFlags().assistant_full_scope;
export const dpDisciplineOn = () => cqFlags().daily_plan_discipline;
export type Asst = { id: number; slug: string; display_name: string; bound_user_id: number | null; bound_salesperson_id: number | null; scope_rule: string; enabled: number };
const hasTable = (t: string) => Boolean(queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [t]));
const ASST_COLS = "id,slug,display_name,bound_user_id,bound_salesperson_id,scope_rule,enabled";
/** The expert's own sales assistant (kind sales, not the manager scope). */
export function dpAssistantFor(sp: number): Asst | null {
  if (!hasTable("assistants")) return null;
  return queryRow<Asst>(`SELECT ${ASST_COLS} FROM assistants WHERE kind='sales' AND COALESCE(scope_rule,'')<>'manager' AND bound_salesperson_id=? ORDER BY id LIMIT 1`, [sp]) ?? null;
}
const managerAssistants = (): Asst[] => hasTable("assistants") ? queryRows<Asst>(`SELECT ${ASST_COLS} FROM assistants WHERE scope_rule='manager' ORDER BY id`) : [];
export type DpExpert = CqUser & { name: string; assistant: Asst };
/** Experts with a list: eligible call-queue experts (never 29 / trainees / admins) whose salesperson has a bound sales assistant. */
export function dpExperts(): DpExpert[] {
  const out: DpExpert[] = [];
  for (const u of cqEligibleUsers()) { const a = u.salespersonId == null ? null : dpAssistantFor(u.salespersonId); if (a) out.push({ ...u, assistant: a }); }
  return out;
}
export const dpIsExpert = (u: CqUser | null | undefined) => Boolean(u && u.role === "salesperson" && u.salespersonId != null && !CQ_EXCLUDED_USER_IDS.includes(Number(u.id))
  && dpExperts().some(e => e.id === Number(u.id)));
const expertBySp = (sp: number) => dpExperts().find(e => e.salespersonId === sp) ?? null;
/** The assistant's scope is restricted to P1 while assistant_full_scope is OFF (PM item 10); masoud (scope all) is unaffected. */
export const dpScopeRestricted = (a: Asst) => a.scope_rule === "p1" && !dpFullScope();

export type DpErr = { status: number; error: string; message: string; details?: any };
const err = (status: number, error: string, message: string, details?: any): DpErr => ({ status, error, message, ...(details !== undefined ? { details } : {}) });
export const dpIsErr = (x: any): x is DpErr => Boolean(x && typeof x === "object" && typeof x.status === "number" && typeof x.error === "string");
const isErr = dpIsErr;

/* ---------------- notifications (CRM only) ---------------- */
function bell(kind: string, resourceId: number, ownerSp: number | null, title: string, body: string, recipient: number, at: string) {
  if (CQ_EXCLUDED_USER_IDS.includes(recipient)) return;
  // test kit (masked copy): DP_TEST_NO_BELLS=1 records the would-be bell in dp_test_bells instead of ringing anyone
  if (process.env.DP_TEST_NO_BELLS === "1") {
    execute("CREATE TABLE IF NOT EXISTS dp_test_bells(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, resource_id INTEGER, recipient_user_id INTEGER, title TEXT, created_at TEXT)");
    execute("INSERT INTO dp_test_bells(kind,resource_id,recipient_user_id,title,created_at) VALUES(?,?,?,?,?)", [kind, resourceId, recipient, title, at]); return;
  }
  execute(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
    VALUES(0,'',?,'daily_plan',?,?,?,?,'customers.view',?,'daily-plan:system',?)`, [ownerSp, resourceId, kind, title, body, at, recipient]);
}
function event(assistantId: number, type: string, userId: number | null, data: any, at: string) {
  if (!hasTable("assistant_events")) return;
  execute("INSERT INTO assistant_events(assistant_id,type,thread_id,user_id,customer_id,message_id,data_json,created_at) VALUES(?,?,NULL,?,NULL,NULL,?,?)",
    [assistantId, type, userId, JSON.stringify(data), at]);
}
/** Generic triggers write a bell for every call_logs/customers write; our own timeline rows must not ring anyone (R3 pattern). */
const maxBellId = () => Number(queryRow<{ m: number }>("SELECT COALESCE(MAX(id),0) m FROM site_notification_events")?.m ?? 0);
const dropBells = (after: number, customerId: number) => executeChanges("DELETE FROM site_notification_events WHERE id>? AND customer_id=? AND COALESCE(actor_key,'')<>'daily-plan:system'", [after, customerId]);

/* ---------------- capacity ---------------- */
export function dpCapacity(sp: number, day: string): { capacity: number | null; source: "set" | "first_day" | null; outOfGuard: boolean } {
  ensureDailyPlanSchema();
  const r = queryRow<{ accepted: number; out_of_guard: number }>("SELECT accepted,out_of_guard FROM dp_capacity_log WHERE salesperson_id=? AND day<=? AND outcome='ok' ORDER BY day DESC, id DESC LIMIT 1", [sp, day]);
  if (r) return { capacity: Number(r.accepted), source: "set", outOfGuard: Boolean(r.out_of_guard) };
  const f = dpSettings().firstDayCapacity; return f == null ? { capacity: null, source: null, outOfGuard: false } : { capacity: f, source: "first_day", outOfGuard: false };
}
const hasAssistantCapacity = (sp: number) => Boolean(queryRow("SELECT 1 FROM dp_capacity_log WHERE salesperson_id=? AND outcome='ok' AND actor_kind='assistant' LIMIT 1", [sp]));
/**
 * DP-FIRSTCAP-51 (Mohammad 2026-10-28 «ظرفیت روز اول رو از کارشناس بپرس»): the expert's own first capacity declaration
 * (reason starting with «اعلام خود کارشناس») is exempt ONCE per expert from the ±guardPct guard and from the 08:00 cut-off
 * for today (never for a past day / holiday / >14 days). Used once = any earlier accepted declaration row (exemption
 * recorded in dp_capacity_log.exemption='expert_first_declaration'). From the next change on the guard applies again,
 * including a second «اعلام خود کارشناس».
 */
export const DP_EXPERT_DECLARATION = "اعلام خود کارشناس";
export const DP_EXEMPT_FIRST_DECLARATION = "expert_first_declaration";
const normFa = (t: string) => t.replace(/\u200c/g, " ").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();
export const dpIsExpertDeclaration = (reason: unknown) => normFa(String(reason ?? "")).startsWith(DP_EXPERT_DECLARATION);
export function dpDeclarationUsed(sp: number): boolean {
  ensureDailyPlanSchema();
  if (queryRow("SELECT 1 FROM dp_capacity_log WHERE salesperson_id=? AND outcome='ok' AND exemption=? LIMIT 1", [sp, DP_EXEMPT_FIRST_DECLARATION])) return true;
  return queryRows<{ reason: string | null }>("SELECT reason FROM dp_capacity_log WHERE salesperson_id=? AND outcome='ok'", [sp]).some(r => dpIsExpertDeclaration(r.reason));
}
function guard(sp: number, day: string, requested: number) {
  // DP-FIRSTCAP-51: the base is the previous working day's SET capacity; when that day only has the default
  // (firstDayCapacity, never a real number), the latest set capacity up to the target day is the base.
  const s = dpSettings(); const pw = dpCapacity(sp, dpPrevWork(day)); const base = pw.source === "set" ? pw.capacity : dpCapacity(sp, day).capacity;
  if (base == null) return { ok: true, previous: null as number | null, maxAllowed: null as number | null, minAllowed: null as number | null, guardPct: s.guardPct };
  const maxAllowed = Math.floor(base * (1 + s.guardPct / 100)), minAllowed = Math.max(1, Math.ceil(base * (1 - s.guardPct / 100)));
  return { ok: requested <= maxAllowed && requested >= minAllowed, previous: base as number | null, maxAllowed: maxAllowed as number | null, minAllowed: minAllowed as number | null, guardPct: s.guardPct };
}
function capInput(b: any): DpErr | { capacity: number; reason: string } {
  if (b?.capacity === undefined || b?.capacity === null || b?.capacity === "") return err(422, "capacity_required", "ظرفیت را بنویس.");
  if (typeof b.capacity !== "number" && !(typeof b.capacity === "string" && /^\d+$/.test(b.capacity))) return err(422, "bad_type", "ظرفیت باید عدد باشد.", { field: "capacity" });
  const n = Number(b.capacity);
  if (!Number.isInteger(n) || n < 1 || n > DP_CAP_MAX) return err(422, "capacity_out_of_range", `ظرفیت باید بین ۱ و ${faDigits(String(DP_CAP_MAX))} باشد.`, { min: 1, max: DP_CAP_MAX });
  const reason = String(b?.reason ?? "").replace(/\s+/g, " ").trim();
  if (!reason) return err(422, "reason_required", "دلیل تغییر ظرفیت را بنویس.");
  if ([...reason].length > DP_CAP_REASON_MAX) return err(422, "field_too_long", `دلیل حداکثر ${faDigits(String(DP_CAP_REASON_MAX))} نویسه است.`, { field: "reason", max: DP_CAP_REASON_MAX });
  return { capacity: n, reason };
}
function capDayAllowed(day: unknown, now: Date, allowTodayAfterStart = false): DpErr | string {
  if (!isYmd(day)) return err(422, "date_not_allowed", "تاریخ معتبر نیست.");
  const today = dpToday(now);
  if (day < today) return err(422, "date_not_allowed", "ظرفیت روز گذشته عوض نمی‌شود.");
  if (!dpIsWork(day)) return err(409, "holiday", "این روز تعطیل است.");
  if (day === today && minOf(now) >= DP_START_MIN && !allowTodayAfterStart) return err(409, "after_cutoff", "لیست امروز از ساعت ۸ شروع شده؛ ظرفیت تازه از روز کاری بعد اثر دارد.");
  if (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) > 14 * 86_400_000) return err(422, "date_not_allowed", "ظرفیت فقط تا ۱۴ روز جلوتر.");
  return day;
}
const capLog = (sp: number, day: string, prev: number | null, req: number, acc: number | null, outcome: string, oog: boolean, reason: string, kind: string, actor: number, at: string, exemption: string | null = null) =>
  Number(execute("INSERT INTO dp_capacity_log(salesperson_id,day,previous,requested,accepted,outcome,out_of_guard,reason,actor_kind,actor_id,created_at,exemption) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    [sp, day, prev, req, acc, outcome, oog ? 1 : 0, reason, kind, actor, at, exemption]));
/**
 * DP-FIRSTCAP-51: a capacity change for TODAY after today's list exists. Raised → top up the main list to the new N from
 * the normal queue (same fillFromQueue rules as the 08:00 list: carried extras first, never a customer already on the
 * plan); lowered → nothing already assigned is removed (done/pending items stay; N on the plan = the new capacity).
 */
function applyTodayCapacity(sp: number, day: string, cap: number, now: Date): { planId: number; before: number; after: number; added: number; lowered: boolean } | null {
  const p = planRow(sp, day); if (!p || !p.started_at || p.closed_at || day !== dpToday(now)) return null;
  const mainCount = () => items(p.id, "bucket='main' AND status<>'transferred'").length;
  const before = mainCount(); let added = 0;
  if (cap > before && !p.backlog) {
    const ex = expertBySp(sp);
    if (ex) { const ce = fitCarriedExtras(p, cap); added = fillFromQueue(p, ex, Math.max(0, cap - before - ce), "main", now, 1000 + items(p.id).length); }
  }
  executeChanges("UPDATE dp_plans SET capacity=? WHERE id=?", [cap, p.id]);
  if (added) executeChanges("UPDATE dp_plans SET finished_at=NULL WHERE id=? AND auto_at IS NULL", [p.id]); // the next tick picks the current item
  return { planId: p.id, before, after: mainCount(), added, lowered: cap < before };
}
/** Assistant PUT /capacity/{date}: the first accepted write per expert skips the guard (PM item 11); from the second on ±guardPct of the previous working day. */
export function dpAssistantCapacity(a: Asst, dayIn: unknown, body: any, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  const sp = Number(ex.salespersonId);
  const inp0 = capInput(body);
  const declaration = !isErr(inp0) && dpIsExpertDeclaration(inp0.reason) && !dpDeclarationUsed(sp);
  const day = capDayAllowed(dayIn, now, declaration); if (isErr(day)) return day;
  const inp = inp0; if (isErr(inp)) return inp;
  const at = now.toISOString(); const first = !hasAssistantCapacity(sp); const prev = dpCapacity(sp, day).capacity;
  if (!first && !declaration) {
    const g = guard(sp, day, inp.capacity);
    if (!g.ok) {
      capLog(sp, day, prev, inp.capacity, null, "rejected", false, inp.reason, "assistant", a.id, at);
      return err(422, "capacity_guard_exceeded", `تغییر ظرفیت بیشتر از ${faDigits(String(g.guardPct))}٪ است.`,
        { previous: g.previous, requested: inp.capacity, maxAllowed: g.maxAllowed, minAllowed: g.minAllowed, guardPct: g.guardPct });
    }
  }
  capLog(sp, day, prev, inp.capacity, inp.capacity, "ok", false, inp.reason, "assistant", a.id, at, declaration ? DP_EXEMPT_FIRST_DECLARATION : null);
  const today = applyTodayCapacity(sp, day, inp.capacity, now);
  return { ok: true, date: day, capacity: inp.capacity, previous: prev, firstWrite: first, firstDeclaration: declaration,
    ...(today ? { todayList: { main: today.after, previousMain: today.before, added: today.added, lowered: today.lowered, keptAssigned: today.lowered } } : {}) };
}
/** Admin override (3-step modal): preview without confirm; reason required; outside the guard → «خارج از حد» + CRM bells (1, 5) + events. */
export function dpAdminCapacity(admin: CqUser, sp: number, dayIn: unknown, body: any, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertBySp(sp); if (!ex) return err(404, "expert_not_eligible", "این کارشناس «کارهای امروز» ندارد.");
  const day = capDayAllowed(dayIn, now); if (isErr(day)) return day;
  const inp = capInput(body); if (isErr(inp)) return inp;
  const at = now.toISOString(); const prev = dpCapacity(sp, day).capacity; const g = guard(sp, day, inp.capacity); const out = !g.ok;
  const gv = { maxAllowed: g.maxAllowed, minAllowed: g.minAllowed, guardPct: g.guardPct };
  if (body?.confirm !== true) return { ok: true, preview: true, date: day, previous: prev, capacity: inp.capacity, outOfGuard: out, label: out ? DP_LABELS.outOfGuard : null, guard: gv };
  const id = capLog(sp, day, prev, inp.capacity, inp.capacity, "ok", out, inp.reason, "admin", admin.id, at);
  const data = { salespersonId: sp, expertName: ex.name, date: day, previous: prev, capacity: inp.capacity, outOfGuard: out, reason: inp.reason, label: out ? DP_LABELS.outOfGuard : null };
  event(ex.assistant.id, DP_EVENTS.capacityOverride, ex.id, data, at);
  if (out) {
    for (const m of managerAssistants()) event(m.id, DP_EVENTS.capacityOverride, null, data, at);
    for (const uid of DP_MANAGER_USER_IDS) if (uid !== Number(admin.id)) bell("daily_plan_capacity_override", id, sp, `ظرفیت ${ex.name} خارج از حد عوض شد`,
      `${faDigits(String(prev ?? "—"))} ← ${faDigits(String(inp.capacity))} برای ${faDigits(day)} · دلیل: ${inp.reason}`, uid, at);
  }
  return { ok: true, preview: false, id, ...data, guard: gv };
}
export function dpCapacityView(sp: number, now = new Date()) {
  ensureDailyPlanSchema();
  const today = dpToday(now); const days = dpWorkDays(dpPrevWorkN(today, 13), today);
  const history = queryRows<any>(`SELECT l.id,l.day,l.previous,l.requested,l.accepted,l.outcome,l.out_of_guard outOfGuard,l.reason,l.actor_kind actorKind,l.created_at createdAt,
      CASE WHEN l.actor_kind='admin' THEN (SELECT COALESCE(full_name,username) FROM users WHERE id=l.actor_id) ELSE (SELECT display_name FROM assistants WHERE id=l.actor_id) END actorName
    FROM dp_capacity_log l WHERE l.salesperson_id=? ORDER BY l.id DESC LIMIT 60`, [sp]).map(r => ({ ...r, outOfGuard: Boolean(r.outOfGuard), label: r.outOfGuard ? DP_LABELS.outOfGuard : null }));
  const chart = days.map(d => { const p = planRow(sp, d); const st = p ? dpStats(p) : null;
    return { day: d, capacity: dpCapacity(sp, d).capacity, main: st?.main ?? null, mainDone: st?.mainDone ?? null, completionPct: st?.completionPct ?? null, mode: p?.mode ?? null, label: p?.mode === "auto" ? DP_LABELS.autoDay : null }; });
  const nextDay = dpNextOpenDay(now);
  return { salespersonId: sp, nextDay, current: dpCapacity(sp, nextDay), settings: dpSettings(), chart, history, firstWrite: !hasAssistantCapacity(sp), firstDeclarationAvailable: !dpDeclarationUsed(sp) };
}

/* ---------------- plans & items ---------------- */
export type Plan = { id: number; salesperson_id: number; user_id: number; day: string; mode: string; version: number; written_at: string | null; assistant_id: number | null;
  assistant_note: string | null; capacity: number | null; backlog: number; started_at: string | null; finished_at: string | null; auto_at: string | null; closed_at: string | null; created_at: string };
type Item = { id: number; plan_id: number; customer_id: number; type: DpType; reason: string | null; key_note: string | null; source: string; bucket: string; position: number;
  boost_rank: number | null; boost_at: string | null; label: string | null; status: string; move_count: number; moved_to: string | null; outcome: string | null;
  call_log_id: number | null; call_id: number | null; became_current_at: string | null; done_at: string | null; created_at: string };
const planRow = (sp: number, day: string) => queryRow<Plan>("SELECT * FROM dp_plans WHERE salesperson_id=? AND day=?", [sp, day]) ?? null;
function planFor(u: { id: number; salespersonId: number | null }, day: string, at: string): Plan {
  const sp = Number(u.salespersonId); const p = planRow(sp, day); if (p) return p;
  execute("INSERT OR IGNORE INTO dp_plans(salesperson_id,user_id,day,created_at) VALUES(?,?,?,?)", [sp, u.id, day, at]);
  return planRow(sp, day)!;
}
const items = (planId: number, where = "1=1", params: SqlValue[] = []) => queryRows<Item>(`SELECT * FROM dp_items WHERE plan_id=? AND (${where})`, [planId, ...params]);
const ACTIVE = "status IN ('pending','current','moved')";
/** Order: current, then boosted (0 urgent · 1 due/new/transferred-in · 2 moved back · 3 supplementary; by time), then position. */
function ordered(planId: number): Item[] {
  const cur = (i: Item) => (i.status === "current" ? 0 : 1); const b = (i: Item) => (i.boost_rank == null ? 1 : 0);
  return items(planId, "status IN ('pending','current')").sort((a, c) => cur(a) - cur(c) || b(a) - b(c)
    || (a.boost_rank ?? 0) - (c.boost_rank ?? 0) || String(a.boost_at ?? "").localeCompare(String(c.boost_at ?? "")) || a.position - c.position || a.id - c.id);
}
function addItem(planId: number, x: { customerId: number; type: DpType; reason?: string | null; keyNote?: string | null; source: string; bucket: string; position: number;
  boostRank?: number | null; boostAt?: string | null; label?: string | null; status?: string }, at: string) {
  return Number(execute(`INSERT INTO dp_items(plan_id,customer_id,type,reason,key_note,source,bucket,position,boost_rank,boost_at,label,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [planId, x.customerId, x.type, x.reason ?? null, x.keyNote ?? null, x.source, x.bucket, x.position, x.boostRank ?? null, x.boostAt ?? null, x.label ?? null, x.status ?? "pending", at]));
}
const seenOnce = (planId: number, ref: string) => executeChanges("INSERT OR IGNORE INTO dp_seen(plan_id,ref) VALUES(?,?)", [planId, ref]) > 0;
const owned = (sp: number, cid: number) => Boolean(queryRow("SELECT 1 FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL", [cid, sp]));
const custName = (cid: number) => queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [cid])?.name ?? "";

/** Stats: completion % = done main ÷ main (PM item 2). Transferred items leave the denominator (item 12); extra / out-of-list never count. */
export function dpStats(p: Plan) {
  const all = items(p.id);
  const main = all.filter(i => i.bucket === "main" && i.status !== "transferred");
  const mainDone = main.filter(i => i.status === "done").length;
  const extra = all.filter(i => i.bucket === "extra" && i.status !== "transferred" && i.status !== "reserve");
  const cnt = (f: (i: Item) => boolean) => all.filter(f).length;
  return { main: main.length, mainDone, completionPct: main.length ? Math.round((mainDone / main.length) * 1000) / 10 : null,
    extra: extra.length, extraDone: extra.filter(i => i.status === "done").length,
    inserted: cnt(i => i.bucket === "extra" && (i.source === "inserted" || i.source === "transferred_in")), supplementary: cnt(i => i.source === "supplementary"),
    autoExtra: cnt(i => i.bucket === "extra" && i.source === "auto"), outOfList: cnt(i => i.bucket === "outside"),
    carried: cnt(i => i.source === "carried"), carriedExtra: cnt(i => i.source === "carried_extra" && i.status !== "reserve"), reserve: cnt(i => i.status === "reserve"), autoFilled: cnt(i => i.bucket === "main" && i.source === "auto"),
    moved: all.reduce((s, i) => s + Number(i.move_count || 0), 0), undone: cnt(i => i.bucket === "main" && i.status === "undone"), extraUndone: cnt(i => i.bucket === "extra" && i.status === "undone"), transferred: cnt(i => i.status === "transferred"),
    mode: p.mode, auto: p.mode === "auto", final: Boolean(p.closed_at), backlog: Boolean(p.backlog), capacity: p.capacity };
}

/* ---------------- auto queue («لیست خودکار») ---------------- */
function queueCards(u: CqUser, now: Date) {
  let sug: { customerId: number; rank: number; reason?: string }[] = [];
  try {
    const sp = Number(u.salespersonId);
    if (salesAssistScope(sp)) sug = suggestionsFor(sp, now, 3).items.map((x: any) => ({ customerId: Number(x.customerId), rank: Number(x.rank), reason: x.reason?.text || undefined }));
  } catch { sug = []; }
  return cqQueue(u, sug, now).cards;
}
const typeOfGroup = (g: string): DpType => g === "urgent" ? "urgent" : g === "due" ? "due" : g === "new" ? "first" : "followup";
/** Fills up to n items from the call queue (skipping customers already on the plan). */
function fillFromQueue(p: Plan, u: CqUser, n: number, bucket: "main" | "extra", now: Date, startPos: number): number {
  if (n <= 0) return 0;
  const taken = new Set(items(p.id, "status<>'transferred'").map(i => Number(i.customer_id)));
  let k = 0; const at = now.toISOString();
  for (const c of queueCards(u, now)) {
    if (k >= n) break; if (taken.has(c.customerId)) continue;
    addItem(p.id, { customerId: c.customerId, type: typeOfGroup(c.group), reason: c.reason.slice(0, DP_REASON_MAX), source: "auto", bucket, position: startPos + k, label: DP_LABELS.auto }, at);
    taken.add(c.customerId); k++;
  }
  return k;
}

/** «تماس اول» (PM 2026-10-28): any owned customer with no call logged yet, for every expert. */
const noCalls = (cid: number) => !queryRow("SELECT 1 FROM call_logs WHERE customer_id=? LIMIT 1", [cid]);
const firstIfNoCalls = (cid: number, t: DpType): DpType => (t === "urgent" || t === "due" || !noCalls(cid) ? t : "first");
/**
 * Carried extras (PM 2026-10-28): yesterday's undone extras sit inside today's capacity after the main list,
 * never make a backlog and never count in completion % / discipline (bucket stays 'extra', source 'carried_extra').
 * Whatever does not fit waits as status 'reserve' and is handed out first in today's «لیست خودکار» batches.
 */
function fitCarriedExtras(p: Plan, cap: number | null): number {
  const mainCount = items(p.id, "bucket='main' AND status<>'transferred'").length;
  const ce = items(p.id, "source='carried_extra' AND status IN ('pending','reserve')").sort((a, b) => a.position - b.position || a.id - b.id);
  const room = cap == null ? 0 : Math.max(0, cap - mainCount); let k = 0;
  for (const i of ce) {
    if (!owned(p.salesperson_id, i.customer_id)) { executeChanges("UPDATE dp_items SET status='transferred', label=? WHERE id=?", [DP_LABELS.transferred, i.id]); continue; }
    if (k < room) { executeChanges("UPDATE dp_items SET status='pending', label=? WHERE id=?", [DP_LABELS.carried, i.id]); k++; }
    else executeChanges("UPDATE dp_items SET status='reserve', label=? WHERE id=?", [DP_LABELS.auto, i.id]);
  }
  return k;
}
/** Hands out up to n reserved carried extras as «لیست خودکار» extras; returns how many. */
function releaseReserve(p: Plan, n: number, now: Date): number {
  let k = 0; const start = 9000 + items(p.id).length;
  for (const i of items(p.id, "status='reserve'").sort((a, b) => a.position - b.position || a.id - b.id)) {
    if (k >= n) break;
    if (!owned(p.salesperson_id, i.customer_id)) { executeChanges("UPDATE dp_items SET status='transferred', label=? WHERE id=?", [DP_LABELS.transferred, i.id]); continue; }
    executeChanges("UPDATE dp_items SET status='pending', label=?, position=? WHERE id=?", [DP_LABELS.auto, start + k, i.id]); k++;
  }
  void now; return k;
}

/* ---------------- assistant writes ---------------- */
type Row = { customerId: number; type: DpType; reason: string | null; keyNote: string | null };
const DIGITS = /[0-9\u06F0-\u06F9\u0660-\u0669]/;
function parseRows(raw: any, sp: number, restricted: boolean, taken: Set<number>, checkOrder: boolean): { rows: Row[] } | DpErr {
  if (!Array.isArray(raw)) return err(422, "bad_type", "items باید آرایه باشد.", { field: "items" });
  if (raw.length > DP_ROWS_MAX) return err(422, "too_many_rows", `حداکثر ${faDigits(String(DP_ROWS_MAX))} ردیف.`, { max: DP_ROWS_MAX });
  const rows: Row[] = []; const errors: any[] = []; const ids = new Set<number>(); let lastRank = -1;
  raw.forEach((r: any, i: number) => {
    const e = (code: string, extra: any = {}) => { errors.push({ row: i, code, ...extra }); };
    const cid = Number(r?.customerId); const type = String(r?.type ?? "") as DpType;
    if (!r || typeof r !== "object" || !Number.isSafeInteger(cid) || cid <= 0) return e("bad_type", { field: "customerId" });
    if (!DP_TYPES.includes(type)) return e("bad_type", { field: "type", allowed: DP_TYPES });
    for (const [f, max] of [["reason", DP_REASON_MAX], ["keyNote", DP_KEYNOTE_MAX]] as const) {
      const v = r[f]; if (v != null && typeof v !== "string") return e("bad_type", { field: f });
      if (typeof v === "string" && [...v].length > max) return e("field_too_long", { field: f, max });
      if (typeof v === "string" && DIGITS.test(v)) return e("note_has_digits", { field: f });
    }
    const c = queryRow<{ salesperson_id: number | null; merged: number | null; priority: number | null }>("SELECT salesperson_id,merged_into_customer_id merged,priority FROM customers WHERE id=?", [cid]);
    if (!c) return e("unknown_customer", { customerId: cid });
    if (Number(c.salesperson_id) !== sp || c.merged != null) return e("customer_not_owned", { customerId: cid });
    if (restricted && Number(c.priority) !== 1) return e("out_of_scope", { customerId: cid });
    if (ids.has(cid) || taken.has(cid)) return e("duplicate_customer", { customerId: cid });
    if (checkOrder) { if (RANK[type] < lastRank) return e("order_violation", { type }); lastRank = RANK[type]; }
    ids.add(cid); rows.push({ customerId: cid, type, reason: r.reason?.trim() || null, keyNote: r.keyNote?.trim() || null });
  });
  if (errors.length) return err(422, "invalid_rows", "بعضی ردیف‌ها پذیرفته نشد؛ هیچ ردیفی ذخیره نشد.", { rows: errors });
  return { rows };
}
function planDayCheck(dayIn: unknown, now: Date): DpErr | string {
  if (!isYmd(dayIn)) return err(422, "date_not_allowed", "تاریخ معتبر نیست.");
  const day = dayIn; const today = dpToday(now); const m = minOf(now); const todayWork = dpIsWork(today);
  if (day === today) { if (!todayWork) return err(409, "holiday", "امروز تعطیل است."); if (m >= DP_START_MIN) return err(409, "after_cutoff", "از ساعت ۸ لیست امروز بسته است؛ برای امروز «تکمیلی» بفرست."); return day; }
  if (day === dpNextWork(today)) { if (todayWork && m < DP_CLOSE_MIN) return err(409, "not_open_yet", "لیست روز کاری بعد از ساعت ۱۸ باز می‌شود.", { opensAt: atTehran(today, DP_CLOSE_MIN).toISOString() }); return day; }
  if (!dpIsWork(day)) return err(409, "holiday", "این روز تعطیل است.");
  return err(422, "date_not_allowed", "فقط امروز (تا ۸) یا روز کاری بعد.");
}
function expertOf(a: Asst): DpExpert | DpErr {
  const ex = a.bound_salesperson_id == null ? null : expertBySp(Number(a.bound_salesperson_id));
  if (!ex || ex.assistant.id !== a.id) return err(422, "expert_not_eligible", "این دستیار به کارشناسی با «کارهای امروز» بسته نیست.");
  return ex;
}
/** Runner: the token binds the expert; an expertId in body/query that differs → 403 (v1.2 §0). */
export function dpCheckExpertId(a: Asst, v: unknown): DpErr | null {
  if (v === undefined || v === null || v === "") return null;
  return Number(v) === Number(a.bound_salesperson_id) ? null : err(403, "forbidden", "این توکن فقط به کارشناس خودش بسته است.");
}
/** PUT /daily-plans/{date}: the whole main list, all-or-nothing; version++. */
export function dpWritePlan(a: Asst, dayIn: unknown, body: any, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  const day = planDayCheck(dayIn, now); if (isErr(day)) return day;
  const sp = Number(ex.salespersonId); const cap = dpCapacity(sp, day).capacity;
  if (cap == null) return err(422, "capacity_not_set", "ظرفیت این کارشناس هنوز تعیین نشده؛ اول PUT /capacity/{date}.");
  const at = now.toISOString(); const p0 = planRow(sp, day);
  const carried = p0 ? items(p0.id, "source='carried' AND status<>'transferred'") : [];
  const restricted = dpScopeRestricted(a);
  const parsed = parseRows(body?.items, sp, restricted, new Set(carried.map(i => Number(i.customer_id))), true); if (isErr(parsed)) return parsed;
  const rows = parsed.rows; const backlog = carried.length >= cap;
  if (backlog && rows.some(r => r.type !== "urgent")) return err(422, "backlog_urgent_only", "کارهای مانده به اندازه‌ی ظرفیت است؛ فقط «فوری» پذیرفته می‌شود.", { capacity: cap, carried: carried.length });
  if (!backlog && carried.length + rows.length > cap) return err(422, "capacity_exceeded", "لیست از ظرفیت بیشتر است.", { capacity: cap, carried: carried.length, requested: rows.length, maxRows: cap - carried.length });
  const noteIn = body?.assistantNote ?? body?.note;
  if (noteIn != null && typeof noteIn !== "string") return err(422, "bad_type", "assistantNote باید متن باشد.", { field: "assistantNote" });
  const note = noteIn ? String(noteIn).trim() || null : null;
  if (note && [...note].length > DP_KEYNOTE_MAX) return err(422, "field_too_long", "یادداشت لیست بلند است.", { field: "note", max: DP_KEYNOTE_MAX });
  if (note && DIGITS.test(note)) return err(422, "invalid_rows", "یادداشت عدد دارد.", { rows: [{ row: -1, code: "note_has_digits", field: "note" }] });
  const p = p0 ?? planFor(ex, day, at);
  executeChanges("DELETE FROM dp_items WHERE plan_id=? AND source IN ('plan','auto') AND bucket='main' AND status='pending'", [p.id]);
  // a customer the assistant writes in replaces its carried-extra copy.
  for (const r of rows) executeChanges("DELETE FROM dp_items WHERE plan_id=? AND source='carried_extra' AND customer_id=? AND status IN ('pending','reserve')", [p.id, r.customerId]);
  let pos = 1; const urg = rows.filter(r => r.type === "urgent"), rest = rows.filter(r => r.type !== "urgent");
  for (const r of urg) addItem(p.id, { ...r, source: "plan", bucket: "main", position: pos++ }, at);
  for (const c of [...carried].sort((x, y) => x.position - y.position)) executeChanges("UPDATE dp_items SET position=? WHERE id=?", [pos++, c.id]);
  for (const r of rest) addItem(p.id, { ...r, source: "plan", bucket: "main", position: pos++ }, at);
  const carriedExtra = fitCarriedExtras(p, cap);
  let autoFilled = 0;
  if (restricted && !backlog) autoFilled = fillFromQueue(p, ex, cap - carried.length - rows.length - carriedExtra, "main", now, 1000);
  executeChanges("UPDATE dp_plans SET mode='assistant', version=version+1, written_at=?, assistant_id=?, assistant_note=?, capacity=?, backlog=? WHERE id=?",
    [at, a.id, note, cap, backlog ? 1 : 0, p.id]);
  const np = planRow(sp, day)!;
  return { ok: true, date: day, version: np.version, capacity: cap, carried: carried.length, carriedExtra, reserve: items(p.id, "status='reserve'").length, written: rows.length, autoFilled, backlog, scope: restricted ? "p1" : "all", plan: dpAssistantView(np) };
}
/** POST /daily-plans/{date}/supplementary: today only, until 18:00; exempt from capacity; extra after the current item. */
export function dpSupplementary(a: Asst, dayIn: unknown, body: any, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  if (!isYmd(dayIn) || dayIn !== dpToday(now)) return err(422, "date_not_allowed", "تکمیلی فقط برای امروز.");
  if (minOf(now) >= DP_CLOSE_MIN) return err(409, "after_cutoff", "بعد از ساعت ۱۸ تکمیلی پذیرفته نمی‌شود.");
  const p = planRow(Number(ex.salespersonId), dayIn); if (!p || p.closed_at) return err(404, "no_plan", "امروز لیستی برای این کارشناس نیست.");
  const taken = new Set(items(p.id, ACTIVE).map(i => Number(i.customer_id)));
  const parsed = parseRows(body?.items, Number(ex.salespersonId), dpScopeRestricted(a), taken, false); if (isErr(parsed)) return parsed;
  const at = now.toISOString(); const ids: number[] = [];
  for (const r of parsed.rows) ids.push(addItem(p.id, { ...r, source: "supplementary", bucket: "extra", position: 5000, boostRank: 3, boostAt: at, label: DP_LABELS.supplementary }, at));
  if (ids.length) executeChanges("UPDATE dp_plans SET finished_at=NULL WHERE id=? AND auto_at IS NULL", [p.id]);
  return { ok: true, date: dayIn, added: ids.length, itemIds: ids, plan: dpAssistantView(planRow(p.salesperson_id, p.day)!) };
}
/**
 * BOOST-57 (Mohammad 2026-10-28 09:55/10:10): POST /daily-plans/{today}/boost — the assistant puts customers at the top of
 * today's list in the given order, mid-day. Today only, until 18:00, plan must exist and not be closed; all-or-nothing validation.
 * - already active on the plan: 'current' → skipped "current_untouched" (never moved or relabelled); 'moved' → skipped "moved";
 *   'pending' → boost_rank set to a fraction in (0,1) (after rank-0 urgent auto-inserts, before every rank-1/2/3 item and the
 *   unboosted list), label «اولویت دستیار · …»; bucket, type, counters and the completion % are unchanged.
 *   A carried extra waiting as 'reserve' is released to 'pending' (same as a «لیست خودکار» hand-out) and boosted.
 * - not on the plan: inserted as bucket 'extra' / source 'assistant_boost' (exempt from capacity, like «تکمیلی»);
 *   with assistant_full_scope OFF only priority-1 customers can be inserted (out_of_scope); boosting is always allowed.
 * Each call places its customers ABOVE earlier assistant boosts (ranks are spread inside (0, lowest current assistant rank)).
 * No SMS, no Bale, no bell; one assistant event (daily_plan_boost) + one assistant_audit row.
 */
type BoostRow = { customerId: number; reason: string; type: DpType | null };
function parseBoost(raw: any, sp: number): { rows: BoostRow[]; cust: Map<number, { priority: number | null; urgent: number }> } | DpErr {
  if (!Array.isArray(raw)) return err(422, "bad_type", "items باید آرایه باشد.", { field: "items" });
  if (!raw.length) return err(422, "items_required", "حداقل یک مشتری بفرست.", { field: "items" });
  if (raw.length > DP_BOOST_MAX) return err(422, "too_many_rows", `حداکثر ${faDigits(String(DP_BOOST_MAX))} ردیف.`, { max: DP_BOOST_MAX });
  const rows: BoostRow[] = []; const errors: any[] = []; const ids = new Set<number>(); const cust = new Map<number, { priority: number | null; urgent: number }>();
  raw.forEach((r: any, i: number) => {
    const e = (code: string, extra: any = {}) => { errors.push({ row: i, code, ...extra }); };
    const cid = Number(r?.customerId);
    if (!r || typeof r !== "object" || !Number.isSafeInteger(cid) || cid <= 0) return e("bad_type", { field: "customerId" });
    const v = r.reason;
    if (v == null || (typeof v === "string" && !v.trim())) return e("reason_required", { field: "reason" });
    if (typeof v !== "string") return e("bad_type", { field: "reason" });
    const reason = v.replace(/\s+/g, " ").trim();
    if ([...reason].length > DP_REASON_MAX) return e("field_too_long", { field: "reason", max: DP_REASON_MAX });
    if (DIGITS.test(reason)) return e("note_has_digits", { field: "reason" });
    const t = r.type == null || r.type === "" ? null : String(r.type) as DpType;
    if (t != null && !DP_TYPES.includes(t)) return e("bad_type", { field: "type", allowed: DP_TYPES });
    const c = queryRow<{ salesperson_id: number | null; merged: number | null; priority: number | null; urgent: number }>(
      "SELECT salesperson_id,merged_into_customer_id merged,priority,COALESCE(is_urgent,0) urgent FROM customers WHERE id=?", [cid]);
    if (!c) return e("unknown_customer", { customerId: cid });
    if (Number(c.salesperson_id) !== sp || c.merged != null) return e("customer_not_owned", { customerId: cid });
    if (ids.has(cid)) return e("duplicate_customer", { customerId: cid });
    ids.add(cid); cust.set(cid, { priority: c.priority == null ? null : Number(c.priority), urgent: Number(c.urgent) });
    rows.push({ customerId: cid, reason, type: t });
  });
  if (errors.length) return err(422, "invalid_rows", "بعضی ردیف‌ها پذیرفته نشد؛ هیچ ردیفی ذخیره نشد.", { rows: errors });
  return { rows, cust };
}
const boostLabel = (reason: string) => `${DP_LABELS.boost} · ${reason}`;
const auditBoost = (a: Asst, outcome: string, detail: unknown, at: string) => {
  if (!hasTable("assistant_audit")) return;
  try { execute("INSERT INTO assistant_audit(at,assistant_id,token_id,user_id,ip,actor_label,action,customer_id,outcome,detail_json) VALUES(?,?,NULL,?,NULL,?,?,NULL,?,?)",
    [at, a.id, a.bound_user_id, `دستیار ${a.display_name}`, "POST /daily-plans/boost", outcome, JSON.stringify(detail)]); } catch { /* audit must never break the write */ }
};
export function dpBoost(a: Asst, dayIn: unknown, body: any, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  if (!isYmd(dayIn) || dayIn !== dpToday(now)) return err(422, "date_not_allowed", "اولویت‌دهی فقط برای امروز.");
  if (minOf(now) >= DP_CLOSE_MIN) return err(409, "after_cutoff", "بعد از ساعت ۱۸ اولویت‌دهی پذیرفته نمی‌شود.");
  const sp = Number(ex.salespersonId);
  const p = planRow(sp, dayIn); if (!p || p.closed_at) return err(404, "no_plan", "امروز لیستی برای این کارشناس نیست.");
  const parsed = parseBoost(body?.items, sp); if (isErr(parsed)) return parsed;
  const restricted = dpScopeRestricted(a);
  // the customer's live row on the plan (active or a waiting carried extra)
  const live = (cid: number) => items(p.id, "customer_id=? AND status IN ('pending','current','moved','reserve')", [cid])
    .sort((x, y) => (x.status === "current" ? -1 : 0) - (y.status === "current" ? -1 : 0) || x.id - y.id)[0] ?? null;
  const scopeErr = parsed.rows.map((r, i) => ({ r, i })).filter(({ r }) => !live(r.customerId) && restricted && parsed.cust.get(r.customerId)?.priority !== 1)
    .map(({ r, i }) => ({ row: i, code: "out_of_scope", customerId: r.customerId }));
  if (scopeErr.length) return err(422, "invalid_rows", "بعضی ردیف‌ها پذیرفته نشد؛ هیچ ردیفی ذخیره نشد.", { rows: scopeErr });
  const at = now.toISOString();
  // place this call above earlier assistant boosts: ranks spread evenly inside (0, lowest pending assistant rank or 1)
  const toPlace = parsed.rows.filter(r => { const it = live(r.customerId); return !it || (it.status !== "current" && it.status !== "moved"); });
  const prevRanks = items(p.id, "status='pending' AND boost_rank>0 AND boost_rank<1").filter(i => !toPlace.some(r => r.customerId === i.customer_id)).map(i => Number(i.boost_rank));
  const top = prevRanks.length ? Math.min(...prevRanks) : 1;
  const results: { customerId: number; result: string; itemId: number | null; bucket: string | null }[] = [];
  let k = 0; let inserted = 0;
  for (const r of parsed.rows) {
    const it = live(r.customerId);
    if (it && it.status === "current") { results.push({ customerId: r.customerId, result: "current_untouched", itemId: it.id, bucket: it.bucket }); continue; }
    if (it && it.status === "moved") { results.push({ customerId: r.customerId, result: "moved", itemId: it.id, bucket: it.bucket }); continue; }
    const rank = top * (k + 1) / (toPlace.length + 1); k++;
    if (it) {
      const fromReserve = it.status === "reserve";
      executeChanges("UPDATE dp_items SET status='pending', boost_rank=?, boost_at=?, label=? WHERE id=?", [rank, at, boostLabel(r.reason), it.id]);
      results.push({ customerId: r.customerId, result: fromReserve ? "boosted_from_reserve" : "boosted", itemId: it.id, bucket: it.bucket });
    } else {
      const c = parsed.cust.get(r.customerId)!;
      const type: DpType = r.type ?? (c.urgent === 1 ? "urgent" : noCalls(r.customerId) ? "first" : "followup");
      const id = addItem(p.id, { customerId: r.customerId, type, reason: r.reason, source: "assistant_boost", bucket: "extra", position: 5000, boostRank: rank, boostAt: at, label: boostLabel(r.reason) }, at);
      inserted++; results.push({ customerId: r.customerId, result: "inserted", itemId: id, bucket: "extra" });
    }
  }
  if (inserted) executeChanges("UPDATE dp_plans SET finished_at=NULL WHERE id=? AND auto_at IS NULL", [p.id]);
  const np = planRow(sp, dayIn)!;
  const order = ordered(p.id).map(i => ({ itemId: i.id, customerId: i.customer_id, status: i.status, label: i.label }));
  const summary = { salespersonId: sp, date: dayIn, results: results.map(x => ({ customerId: x.customerId, result: x.result })) };
  event(a.id, DP_EVENTS.boost, a.bound_user_id, summary, at);
  auditBoost(a, "ok", summary, at);
  return { ok: true, date: dayIn, boosted: results.filter(x => x.result.startsWith("boosted")).length, inserted, skipped: results.filter(x => x.result === "current_untouched" || x.result === "moved").length,
    results, order, plan: dpAssistantView(np) };
}
function dayRows(sp: number, days: string[]) {
  return days.map(d => { const p = planRow(sp, d); const s = p ? dpStats(p) : null;
    return { date: d, mode: p?.mode ?? null, label: p?.mode === "auto" ? DP_LABELS.autoDay : null, final: s?.final ?? false, capacity: s?.capacity ?? dpCapacity(sp, d).capacity,
      main: s?.main ?? 0, mainDone: s?.mainDone ?? 0, completionPct: s?.completionPct ?? null, extra: s?.extra ?? 0, extraDone: s?.extraDone ?? 0, outOfList: s?.outOfList ?? 0,
      moved: s?.moved ?? 0, undone: s?.undone ?? 0, carried: s?.carried ?? 0, autoFilled: s?.autoFilled ?? 0, transferred: s?.transferred ?? 0, backlog: s?.backlog ?? false,
      outcomes: p ? Object.fromEntries(CQ_OUTCOMES.map(o => [o, items(p.id, "status='done' AND outcome=?", [o]).length])) : null }; });
}
/** Average over final assistant-written days only; «خودکار» days are shown but never averaged (v1.2 §4-10). */
const average = (rows: ReturnType<typeof dayRows>) => { const r = rows.filter(d => d.final && d.mode === "assistant" && d.completionPct != null);
  return { average: r.length ? Math.round(r.reduce((s, d) => s + (d.completionPct ?? 0), 0) / r.length * 10) / 10 : null, averageDays: r.length, autoDays: rows.filter(d => d.mode === "auto").length }; };
/** GET /decision-data?from&to: per working day, the facts the assistant needs (no phones). */
export function dpDecisionData(a: Asst, fromIn: unknown, toIn: unknown, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  const today = dpToday(now); const to = isYmd(toIn) ? toIn : today; const from = isYmd(fromIn) ? fromIn : dpPrevWorkN(to, 13);
  if (from > to) return err(422, "date_not_allowed", "from بعد از to است.");
  const sp = Number(ex.salespersonId); const rows = dayRows(sp, dpWorkDays(from, to));
  const nextDay = dpNextOpenDay(now);
  return { expert: { salespersonId: sp, name: ex.name }, from, to, days: rows, ...average(rows), averageExcludes: DP_LABELS.autoDay,
    nextDay, capacity: dpCapacity(sp, nextDay), firstCapacityWrite: !hasAssistantCapacity(sp), firstDeclarationAvailable: !dpDeclarationUsed(sp),
    todayCapacity: dpCapacity(sp, today), declarationReason: DP_EXPERT_DECLARATION, settings: dpSettings(), scope: dpScopeRestricted(a) ? "p1" : "all" };
}
/** Full-scope read (PM item 10, flag assistant_full_scope): every in-progress customer of the expert, minimal fields, no phone. */
export function dpScopeCustomers(a: Asst, q: any) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  if (dpScopeRestricted(a)) return err(403, "full_scope_off", "دسترسی به همه‌ی مشتری‌ها خاموش است؛ فقط اولویت ۱.");
  const limit = Math.max(1, Math.min(200, Number(q?.limit) || 100)); const offset = Math.max(0, Number(q?.offset) || 0);
  const sp = Number(ex.salespersonId); const now = new Date().toISOString();
  const rows = queryRows<any>(`SELECT c.id,c.name,c.priority,COALESCE(c.is_urgent,0) urgent,
      (SELECT MIN(remind_at) FROM reminders r WHERE r.customer_id=c.id AND r.done=0 AND r.voided_at IS NULL AND r.user_id=?) next_rem,
      (SELECT COUNT(*) FROM call_logs l WHERE l.customer_id=c.id) calls,
      (SELECT COALESCE(l.outcome,'')||char(31)||COALESCE(l.one_line_note,'') FROM call_logs l WHERE l.customer_id=c.id ORDER BY l.id DESC LIMIT 1) last
    FROM customers c WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL AND c.status='in_progress' ORDER BY c.id LIMIT ? OFFSET ?`, [ex.id, sp, limit, offset]);
  const total = Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND status='in_progress'", [sp])?.n ?? 0);
  return { total, limit, offset, fields: DP_SCOPE_FIELDS, items: rows.map(r => { const [o, n] = r.last ? String(r.last).split("\u001f") : [null, null];
    return { customerId: Number(r.id), name: r.name ?? "", priority: r.priority == null ? null : Number(r.priority), urgent: Boolean(r.urgent),
      openWork: r.next_rem && r.next_rem <= now ? "due" : Number(r.calls) === 0 ? "first" : r.next_rem ? "followup" : null, nextReminderAt: r.next_rem ?? null,
      lastOutcome: o || null, shortNote: n ? String(n).replace(/[0-9\u06F0-\u06F9\u0660-\u0669]/g, "•").slice(0, DP_REASON_MAX) : null }; }) };
}

/* ---------------- idempotency (assistant writes, 48 h) ---------------- */
export function dpIdem(a: Asst, key: string | undefined, route: string, body: any, run: () => { status: number; body: any }) {
  ensureDailyPlanSchema();
  if (!key || key.length > 120) return { status: 400, body: { error: "idempotency_key_required", message: "سرآیند Idempotency-Key لازم است (حداکثر ۱۲۰ نویسه).", details: null } };
  executeChanges("DELETE FROM dp_idempotency WHERE created_at<?", [new Date(Date.now() - DP_IDEM_HOURS * 3_600_000).toISOString()]);
  const h = createHash("sha256").update(route).update("\n").update(JSON.stringify(body ?? null)).digest("hex");
  const prev = queryRow<{ route: string; body_hash: string; status: number; response_json: string }>("SELECT route,body_hash,status,response_json FROM dp_idempotency WHERE assistant_id=? AND key=?", [a.id, key]);
  if (prev) {
    if (prev.route !== route || prev.body_hash !== h) return { status: 409, body: { error: "idempotency_conflict", message: "این Idempotency-Key قبلاً با بدنه‌ی دیگری به کار رفته.", details: null } };
    return { status: Number(prev.status), body: { ...JSON.parse(prev.response_json), replayed: true } };
  }
  const out = run();
  if (out.status < 500) execute("INSERT OR IGNORE INTO dp_idempotency(assistant_id,key,route,body_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?)",
    [a.id, key, route, h, out.status, JSON.stringify(out.body), new Date().toISOString()]);
  return out;
}
/** Rejected assistant writes also land in the assistant's own events feed (daily_plan_rejected). */
export function dpRejectedEvent(a: Asst, route: string, e: DpErr) {
  try { event(a.id, DP_EVENTS.rejected, a.bound_user_id, { route, error: e.error, message: e.message, details: e.details ?? null }, new Date().toISOString()); } catch { /* ignore */ }
}

/* ---------------- refresh (lazy on reads + per-minute job) ---------------- */
const t0Of = (p: Plan) => [p.written_at, p.started_at].filter(Boolean).sort().pop() ?? p.created_at;
function pushExtra(p: Plan, cid: number, type: DpType, rank: number, label: string, source: string, at: string, reason: string | null = null): "boosted" | "inserted" | "skip" {
  const act = items(p.id, `customer_id=? AND ${ACTIVE}`, [cid])[0];
  if (act) {
    if (act.status === "current") { executeChanges("UPDATE dp_items SET label=? WHERE id=?", [label, act.id]); return "skip"; }
    if (act.status === "moved") return "skip";
    // Q4: already on the list → no duplicate; it moves up, keeps its bucket, takes the label; counters unchanged.
    executeChanges("UPDATE dp_items SET boost_rank=MIN(COALESCE(boost_rank,9),?), boost_at=COALESCE(boost_at,?), label=? WHERE id=?", [rank, at, label, act.id]);
    return "boosted";
  }
  addItem(p.id, { customerId: cid, type, reason, source, bucket: "extra", position: 5000, boostRank: rank, boostAt: at, label }, at);
  return "inserted";
}
const openPlanOf = (sp: number, day: string) => { const p = planRow(sp, day); return p && p.started_at && !p.closed_at ? p : null; };

/* ---------------- LOGGED-CALL-63: a call the expert already saved counts, whatever form saved it ---------------- */
// A REAL call (lib/real-call.ts: not the «ارتقا…» hand-off note, not the first-call review, not a «کارهای امروز ·» move row).
const DP_REAL_CALL = `${realCallSql("l.subject")} AND COALESCE(l.source,'')<>'daily_plan'`;
/** The plan owner's latest real call on this customer at/after `since`. POST /calls and the first-call form leave created_by_user_id
 *  NULL (they stamp salesperson_id), so: written by the owner user, or stamped with the owner's salesperson and no other author. */
export function dpOwnCallSince(p: Plan, customerId: number, since: string) {
  return queryRow<{ id: number; outcome: string | null; created_at: string }>(`SELECT l.id,l.outcome,l.created_at FROM call_logs l WHERE l.customer_id=? AND l.created_at>=?
      AND (l.created_by_user_id=? OR (l.salesperson_id=? AND l.created_by_user_id IS NULL)) AND ${DP_REAL_CALL} ORDER BY l.created_at DESC, l.id DESC LIMIT 1`,
    [customerId, since, p.user_id, p.salesperson_id]) ?? null;
}
/**
 * FIRSTCALL-62 rule 3 HOOK (owner: folder 59) — `true` = this item must NOT be closed by a generic call / self-heal:
 * a «تماس اول» item of the qualifier (Kazemi) whose first-call form is still incomplete (customer his, in_progress, no priority, and no
 * team_sales_qualifications row since the plan started). Only the first-call form (dpAfterFirstCallForm) closes it.
 * Turn off with DP_FIRST_CALL_HOLD=false; 59 may refine the "incomplete" test here — every generic path calls only this function.
 */
export const DP_FIRST_CALL_HOLD = true;
export function dpFirstCallIncomplete(p: Plan, it: { type: string; customer_id: number }): boolean {
  if (!DP_FIRST_CALL_HOLD || it.type !== "first" || !hasTable("team_sales_qualifications")) return false;
  let q: number | null = null; try { const cfg = getTeamSalesConfig(); q = cfg.enabled ? Number(cfg.qualifierSalespersonId) : null; } catch { q = null; }
  if (q == null || q !== p.salesperson_id) return false;
  const c = queryRow<{ salesperson_id: number | null; status: string | null; priority: number | null; merged: number | null }>(
    "SELECT salesperson_id,status,priority,merged_into_customer_id merged FROM customers WHERE id=?", [it.customer_id]);
  if (!c || c.merged != null || Number(c.salesperson_id) !== p.salesperson_id || c.status !== "in_progress" || c.priority != null) return false;
  return !queryRow("SELECT 1 FROM team_sales_qualifications WHERE customer_id=? AND created_at>=? LIMIT 1", [it.customer_id, p.started_at ?? p.created_at]);
}
/** Close the owner's unreported «کارهای امروز» dial(s) on this customer with a saved call (dialled at/before the call) — never leaves a stale 423. */
function dpCloseDialWith(p: Plan, customerId: number, log: { id: number; created_at: string }): number {
  let n = 0;
  for (const q of queryRows<{ id: number; link_issued_at: string; returned_at: string | null }>(
    "SELECT id,link_issued_at,returned_at FROM call_queue_calls WHERE user_id=? AND customer_id=? AND via='daily_plan' AND report_saved_at IS NULL AND link_issued_at<=?", [p.user_id, customerId, log.created_at]))
    n += executeChanges("UPDATE call_queue_calls SET report_saved_at=?, call_log_id=?, on_time=? WHERE id=? AND report_saved_at IS NULL",
      [log.created_at, log.id, cqOnTime(q.link_issued_at, q.returned_at, log.created_at) ? 1 : 0, q.id]);
  // the item left the plan by a P1 hand-off («منتقل شد»): keep the status, just link the call that ended it.
  if (n) executeChanges("UPDATE dp_items SET call_log_id=? WHERE plan_id=? AND customer_id=? AND status='transferred' AND call_log_id IS NULL", [log.id, p.id, customerId]);
  return n;
}
/** Self-heal (every refresh): an open item whose customer got a real call by the owner after the item existed is done (no mirror, no reorder);
 *  an unreported dial whose customer got such a call after the dial is closed. */
function dpSelfHeal(p: Plan) {
  const start = p.started_at!;
  for (const it of items(p.id, "status IN ('current','pending') AND bucket<>'outside'")) {
    const l = dpOwnCallSince(p, it.customer_id, it.created_at > start ? it.created_at : start);
    if (!l || dpFirstCallIncomplete(p, it)) continue;
    executeChanges("UPDATE dp_items SET status='done', outcome=?, call_log_id=?, done_at=? WHERE id=? AND status IN ('current','pending')", [l.outcome ?? null, l.id, l.created_at, it.id]);
  }
  for (const q of queryRows<{ customer_id: number; link_issued_at: string }>("SELECT customer_id,link_issued_at FROM call_queue_calls WHERE user_id=? AND via='daily_plan' AND report_saved_at IS NULL", [p.user_id])) {
    const l = dpOwnCallSince(p, Number(q.customer_id), q.link_issued_at); if (l) dpCloseDialWith(p, Number(q.customer_id), l);
  }
}
export function dpRefresh(p0: Plan, now = new Date()): Plan {
  if (!dpOn()) return p0;
  const today = dpToday(now); if (p0.day !== today || !p0.started_at || p0.closed_at) return p0;
  const at = now.toISOString(); const sp = p0.salesperson_id; const p = p0; const t0 = t0Of(p);
  // 1. owner change (Q5): «منتقل شد», out of the denominator; the new owner gets an extra «تازه اضافه شد».
  for (const it of items(p.id, ACTIVE)) {
    const c = queryRow<{ salesperson_id: number | null; merged: number | null }>("SELECT salesperson_id, merged_into_customer_id merged FROM customers WHERE id=?", [it.customer_id]);
    if (c && Number(c.salesperson_id) === sp && c.merged == null) continue;
    executeChanges("UPDATE dp_items SET status='transferred', label=?, done_at=? WHERE id=?", [DP_LABELS.transferred, at, it.id]);
    const np = c && c.merged == null && c.salesperson_id != null ? openPlanOf(Number(c.salesperson_id), today) : null;
    if (np && seenOnce(np.id, `t:${it.id}`)) { seenOnce(np.id, `n:${it.customer_id}`); pushExtra(np, it.customer_id, firstIfNoCalls(it.customer_id, it.type), 1, DP_LABELS.added, "transferred_in", at, it.reason); }
  }
  // 2. moved items whose time has come.
  for (const it of items(p.id, "status='moved' AND moved_to<=?", [at]))
    executeChanges("UPDATE dp_items SET status='pending', boost_rank=2, boost_at=?, label=? WHERE id=?", [at, `جابه‌جاشده · ${faDigits(hhmm(it.moved_to!))}`, it.id]);
  // 3. «فوری تازه», reminders that fell due, brand-new customers (after the list was written/started).
  if (hasTable("customer_urgent_history"))
    for (const h of queryRows<{ id: number; customer_id: number }>(`SELECT h.id,h.customer_id FROM customer_urgent_history h JOIN customers c ON c.id=h.customer_id
        WHERE h.new_value=1 AND h.created_at>? AND c.salesperson_id=? AND c.merged_into_customer_id IS NULL AND COALESCE(c.is_urgent,0)=1 ORDER BY h.id`, [t0, sp]))
      if (seenOnce(p.id, `u:${h.id}`)) pushExtra(p, Number(h.customer_id), "urgent", 0, DP_LABELS.urgent, "inserted", at);
  for (const r of queryRows<{ id: number; customer_id: number }>(`SELECT r.id,r.customer_id FROM reminders r JOIN customers c ON c.id=r.customer_id
      WHERE r.user_id=? AND r.done=0 AND r.voided_at IS NULL AND r.remind_at>? AND r.remind_at<=? AND c.salesperson_id=? AND c.merged_into_customer_id IS NULL ORDER BY r.remind_at`, [p.user_id, t0, at, sp]))
    if (seenOnce(p.id, `r:${r.id}`)) pushExtra(p, Number(r.customer_id), "due", 1, DP_LABELS.due, "inserted", at);
  // SEARCH-C: «ارجاع» by a colleague (el_referrals, today) → «تماس با مشتری ارجاعی» on top (rank 0), once per referral; only while still this expert's customer.
  if (hasTable("el_referrals"))
    for (const x of queryRows<{ id: number; customer_id: number; from_name: string | null; created_at: string }>(`SELECT x.id,x.customer_id,x.created_at,COALESCE(NULLIF(trim(u.full_name),''),u.username) from_name
        FROM el_referrals x JOIN customers c ON c.id=x.customer_id LEFT JOIN users u ON u.id=x.from_user_id
        WHERE x.owner_salesperson_id=? AND x.day=? AND c.salesperson_id=? AND c.merged_into_customer_id IS NULL ORDER BY x.id`, [sp, p.day, sp]))
      if (seenOnce(p.id, `x:${x.id}`)) pushExtra(p, Number(x.customer_id), firstIfNoCalls(Number(x.customer_id), "followup"), 0, DP_LABELS.referral, "referral", at,
        `ارجاع از ${String(x.from_name ?? "همکار")} · امروز ${faDigits(hhmm(x.created_at))} · مشتری تماس ورودی داشت`.slice(0, DP_REASON_MAX));
  // «تماس اول» for any customer that became this expert's with no call yet (new or transferred, every expert).
  // The first pass only notes who was already there (created before t0), so nothing old floods in.
  const fresh = queryRows<{ id: number; created_at: string }>(`SELECT c.id,c.created_at FROM customers c WHERE c.salesperson_id=? AND c.merged_into_customer_id IS NULL AND c.status='in_progress'
      AND NOT EXISTS(SELECT 1 FROM call_logs l WHERE l.customer_id=c.id) ORDER BY c.created_at, c.id`, [sp]);
  const seenN = new Set(queryRows<{ ref: string }>("SELECT ref FROM dp_seen WHERE plan_id=? AND ref LIKE 'n:%'", [p.id]).map(r => r.ref));
  const seeding = seenOnce(p.id, "n0");
  for (const c of fresh) {
    const ref = `n:${c.id}`; if (seenN.has(ref)) continue;
    if (seeding && !(String(c.created_at) > t0)) { seenOnce(p.id, ref); continue; }
    if (seenOnce(p.id, ref)) pushExtra(p, Number(c.id), "first", 1, DP_LABELS.added, "inserted", at);
  }
  // 3b. LOGGED-CALL-63 self-heal: a call already saved by the owner (any form) closes its item / dial.
  dpSelfHeal(p);
  // 4. finished → event once; after waitMin, «لیست خودکار» extra batches of 5.
  let pr = planRow(sp, p.day)!;
  const open = () => items(p.id, "status IN ('pending','current')").length;
  const parked = () => items(p.id, "status='moved'").length;
  if (!open() && !parked()) {
    if (!pr.finished_at) {
      executeChanges("UPDATE dp_plans SET finished_at=? WHERE id=?", [at, p.id]);
      const a = dpAssistantFor(sp); const st = dpStats(pr);
      if (a) event(a.id, DP_EVENTS.finished, pr.user_id, { salespersonId: sp, date: p.day, finishedAt: at, main: st.main, mainDone: st.mainDone, completionPct: st.completionPct, extra: st.extra }, at);
      pr = planRow(sp, p.day)!;
    }
    const waitUntil = Date.parse(pr.finished_at!) + dpSettings().waitMin * 60_000;
    if (now.getTime() < atTehran(p.day, DP_CLOSE_MIN).getTime() && (pr.auto_at || now.getTime() >= waitUntil)) {
      const u: CqUser = { id: pr.user_id, role: "salesperson", salespersonId: sp, active: true };
      const fromReserve = releaseReserve(pr, DP_AUTO_BATCH, now);
      fillFromQueue(pr, u, DP_AUTO_BATCH - fromReserve, "extra", now, 9000 + items(p.id).length);
      if (!pr.auto_at) executeChanges("UPDATE dp_plans SET auto_at=? WHERE id=?", [at, p.id]);
    }
  }
  // 5. one current item.
  if (!items(p.id, "status='current'").length) {
    const next = ordered(p.id)[0];
    if (next) executeChanges("UPDATE dp_items SET status='current', became_current_at=? WHERE id=? AND status='pending'", [at, next.id]);
  }
  return planRow(sp, p.day)!;
}

/* ---------------- morning start / evening close / carry ---------------- */
function startPlan(e: DpExpert, day: string, now: Date) {
  const at = now.toISOString(); const sp = Number(e.salespersonId);
  let p = planRow(sp, day);
  if (p?.started_at) return p;
  const cap = dpCapacity(sp, day).capacity;
  if (!p && cap == null) return null; // capacity_not_set and no carried work → no plan
  p = p ?? planFor(e, day, at);
  if (!p.written_at) {
    // «لیست خودکار» (PM item 2): the 08:00 auto list IS that day's main list, capped at capacity; the day is «خودکار» and not averaged.
    const carried = items(p.id, "source='carried' AND status<>'transferred'").length;
    const carriedExtra = fitCarriedExtras(p, cap);
    fillFromQueue(p, e, Math.max(0, (cap ?? 0) - carried - carriedExtra), "main", now, 1000);
    executeChanges("UPDATE dp_plans SET mode='auto', capacity=? WHERE id=?", [cap, p.id]);
  } else fitCarriedExtras(p, cap);
  executeChanges("UPDATE dp_plans SET started_at=? WHERE id=? AND started_at IS NULL", [at, p.id]);
  return planRow(sp, day);
}
function closePlan(p: Plan, now: Date, waitForCall: boolean): boolean {
  const at = now.toISOString(); const cap = cqDisciplineSettings().onTimeCapMin;
  if (waitForCall) {
    const cur = items(p.id, "status='current'")[0];
    const call = cur ? queryRow<{ link_issued_at: string }>("SELECT link_issued_at FROM call_queue_calls WHERE user_id=? AND customer_id=? AND report_saved_at IS NULL ORDER BY id DESC LIMIT 1", [p.user_id, cur.customer_id]) : null;
    // Q6: an in-progress call waits up to the on-time cap (30 min) from the link, then the item is undone.
    if (call && Date.parse(call.link_issued_at) + cap * 60_000 > now.getTime()) return false;
  }
  executeChanges(`UPDATE dp_items SET status='undone' WHERE plan_id=? AND (${ACTIVE} OR status='reserve')`, [p.id]);
  executeChanges("UPDATE dp_plans SET closed_at=? WHERE id=? AND closed_at IS NULL", [at, p.id]);
  carry(planRow(p.salesperson_id, p.day)!, now);
  return true;
}
function carry(p: Plan, now: Date) {
  const at = now.toISOString(); const next = dpNextWork(p.day); const sp = p.salesperson_id;
  const und = items(p.id, "status='undone' AND bucket IN ('main','extra')").filter(i => owned(sp, i.customer_id)).sort((a, b) => a.position - b.position);
  if (!und.length) return;
  const np = planFor({ id: p.user_id, salespersonId: sp }, next, at);
  const taken = new Set(items(np.id, "status<>'transferred'").map(i => Number(i.customer_id)));
  // main undone → main «مانده از دیروز» (these alone decide a backlog); extra undone → carried extras, inside capacity, overflow to «لیست خودکار».
  let pos = 500, xpos = 900;
  for (const i of [...und.filter(x => x.bucket === "main"), ...und.filter(x => x.bucket === "extra")]) if (!taken.has(i.customer_id) && seenOnce(np.id, `c:${i.id}`)) {
    const main = i.bucket === "main";
    addItem(np.id, { customerId: i.customer_id, type: i.type, reason: i.reason, keyNote: i.key_note, source: main ? "carried" : "carried_extra", bucket: main ? "main" : "extra",
      position: main ? pos++ : xpos++, label: main ? DP_LABELS.carried : DP_LABELS.auto, status: main ? "pending" : "reserve" }, at);
    taken.add(i.customer_id);
  }
  const carried = items(np.id, "source='carried' AND status<>'transferred'").length; const cap = dpCapacity(sp, next).capacity;
  if (!np.started_at) fitCarriedExtras(np, cap);
  if (cap != null && carried >= cap && !np.backlog) {
    executeChanges("UPDATE dp_plans SET backlog=1 WHERE id=?", [np.id]);
    const e = expertBySp(sp); const data = { salespersonId: sp, expertName: e?.name ?? "", date: next, carried, capacity: cap };
    const a = dpAssistantFor(sp); if (a) event(a.id, DP_EVENTS.backlog, p.user_id, data, at);
    for (const m of managerAssistants()) event(m.id, DP_EVENTS.backlog, null, data, at);
    for (const uid of DP_MANAGER_USER_IDS) bell("daily_plan_backlog", np.id, sp, `کارهای مانده‌ی ${e?.name ?? "کارشناس"} از ظرفیت گذشت`,
      `${faDigits(String(carried))} کار مانده برای ${faDigits(next)} · ظرفیت ${faDigits(String(cap))}. فقط «فوری» به لیست اضافه می‌شود.`, uid, at);
  }
}
let ticking = false;
/** Per-minute job. With flag.daily_plan OFF it does nothing at all (no rows, no bells, no events). */
export function dpTick(now = new Date()) {
  if (ticking) return; ticking = true;
  try {
    if (!dpOn()) return;
    ensureDailyPlanSchema();
    const today = dpToday(now); const m = minOf(now);
    for (const p of queryRows<Plan>("SELECT * FROM dp_plans WHERE day<? AND started_at IS NOT NULL AND closed_at IS NULL", [today])) closePlan(p, now, false);
    if (!dpIsWork(today) || m < DP_START_MIN) return;
    for (const e of dpExperts()) {
      const sp = Number(e.salespersonId);
      if (m < DP_CLOSE_MIN) { const p = startPlan(e, today, now); if (p) dpRefresh(p, now); }
      else { const p = planRow(sp, today); if (p?.started_at && !p.closed_at) closePlan(p, now, true); }
    }
  } finally { ticking = false; }
}
export function startDailyPlanJobs() {
  const ms = Number(process.env.CQ_JOB_TICK_MS) > 0 ? Number(process.env.CQ_JOB_TICK_MS) : 60_000;
  const t = setInterval(() => { try { dpTick(); } catch (e) { console.error("[daily-plan] tick failed", e instanceof Error ? e.message : "error"); } }, ms);
  t.unref?.();
  return t;
}

/* ---------------- expert side ---------------- */
function todayPlanFor(user: CqUser, now: Date): Plan | null {
  if (!dpOn() || !dpIsExpert(user)) return null;
  ensureDailyPlanSchema();
  const today = dpToday(now); const m = minOf(now); const sp = Number(user.salespersonId);
  let p = planRow(sp, today);
  if (dpIsWork(today) && m >= DP_START_MIN && m < DP_CLOSE_MIN) { const e = expertBySp(sp); if (e) p = startPlan(e, today, now) ?? p; }
  return p ? dpRefresh(p, now) : null;
}
/** The plan is "active" for the expert: started today, not closed (POST /calls and GET /customers?search rules apply). */
export function dpActiveFor(user: CqUser, now = new Date()): Plan | null {
  const p = todayPlanFor(user, now); return p && p.started_at && !p.closed_at ? p : null;
}
const itemView = (i: Item, withPhone = false) => {
  const c = queryRow<any>("SELECT id,name,phone,priority,COALESCE(is_urgent,0) is_urgent FROM customers WHERE id=?", [i.customer_id]);
  return { id: i.id, customerId: i.customer_id, name: c?.name ?? "", ...(withPhone ? { phone: c?.phone ?? null } : {}), priority: c?.priority ?? null, urgent: Number(c?.is_urgent) === 1,
    type: i.type, typeLabel: DP_TYPE_LABELS[i.type] ?? i.type, reason: i.reason, keyNote: i.key_note, bucket: i.bucket, source: i.source, label: i.label, status: i.status,
    moveCount: i.move_count, movesLeft: Math.max(0, DP_MOVE_MAX - i.move_count), movedTo: i.moved_to, outcome: i.outcome, doneAt: i.done_at };
};
export function dpState(p: Plan | null, now: Date) {
  const today = dpToday(now);
  if (!dpIsWork(today)) return "holiday";
  if (!p) return minOf(now) < DP_START_MIN ? "not_started" : "empty";
  if (p.closed_at) return "closed";
  if (!p.started_at) return "not_started";
  if (items(p.id, "status='current'").length) return "working";
  if (items(p.id, "status='moved'").length) return "parked";
  if (p.auto_at) return "finished_auto";
  if (p.finished_at) return "finished";
  return "empty";
}
export function dpExpertView(user: CqUser, now = new Date()) {
  if (!dpOn()) return { enabled: false as const };
  if (!dpIsExpert(user)) return { enabled: true as const, eligible: false as const };
  const p = todayPlanFor(user, now); const state = dpState(p, now);
  const base = { enabled: true as const, eligible: true as const, date: dpToday(now), state, startsAt: "08:00", closesAt: "18:00", moveMax: DP_MOVE_MAX, lastMoveAt: "17:45",
    moveReasons: Object.entries(DP_MOVE_REASONS).map(([code, label]) => ({ code, label })), outcomes: CQ_OUTCOMES };
  if (!p) return { ...base, current: null, upcoming: [], moved: [], done: [], progress: { done: 0, total: 0, position: 0, pct: null }, waitUntil: null };
  const st = dpStats(p); const ord = ordered(p.id); const cur = ord.find(i => i.status === "current") ?? null;
  const all = items(p.id);
  const curMain = cur && cur.bucket === "main" ? 1 : 0;
  const pending = cqPendingCall(user.id);
  return { ...base, mode: p.mode, modeLabel: p.mode === "auto" ? DP_LABELS.autoDay : null, assistantNote: p.assistant_note,
    current: cur ? { ...itemView(cur, true), callOpen: Boolean(pending && Number(pending.customer_id) === cur.customer_id), callId: pending && Number(pending.customer_id) === cur.customer_id ? Number(pending.id) : null } : null,
    upcoming: ord.filter(i => i.status === "pending").map(i => itemView(i)),
    moved: all.filter(i => i.status === "moved").map(i => itemView(i)),
    done: all.filter(i => i.status === "done").sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))).map(i => itemView(i)),
    undone: all.filter(i => i.status === "undone").map(i => itemView(i)),
    transferred: all.filter(i => i.status === "transferred").map(i => itemView(i)),
    progress: { done: st.mainDone, total: st.main, position: Math.min(st.main, st.mainDone + curMain), pct: st.completionPct, extraDone: st.extraDone, outOfList: st.outOfList },
    waitUntil: p.finished_at && !p.auto_at ? new Date(Date.parse(p.finished_at) + dpSettings().waitMin * 60_000).toISOString() : null,
    pendingCall: pending && (!cur || Number(pending.customer_id) !== cur.customer_id) ? { callId: Number(pending.id), customerId: Number(pending.customer_id), customerName: custName(Number(pending.customer_id)) } : null };
}
const currentItem = (p: Plan, id: number) => { const i = items(p.id, "id=?", [id])[0]; return i && i.status === "current" ? i : null; };
export function dpStartCall(user: CqUser, itemId: number, now = new Date()) {
  const p = dpActiveFor(user, now); if (!p) return err(409, "no_active_plan", "«کارهای امروز» الان فعال نیست.");
  const it = currentItem(p, itemId); if (!it) return err(409, "not_current_item", "فقط کار فعلی را می‌شود شروع کرد.");
  const c = queryRow<{ phone: string | null }>("SELECT phone FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL", [it.customer_id, user.salespersonId ?? -1]);
  if (!c) return err(404, "customer_not_owned", "این مشتری در پرونده‌های شما نیست.");
  const digits = String(c.phone ?? "").replace(/[^\d+]/g, ""); if (!digits) return err(422, "no_phone", "شماره‌ی این مشتری ثبت نشده است.");
  const pend = cqPendingCall(user.id);
  if (pend && Number(pend.customer_id) !== it.customer_id)
    return err(423, "call_pending", `اول گزارش تماس با ${custName(Number(pend.customer_id)) || "مشتری قبلی"} را ثبت کن.`, { callId: Number(pend.id), customerId: Number(pend.customer_id) });
  const id = pend ? Number(pend.id) : Number(execute("INSERT INTO call_queue_calls(user_id,salesperson_id,customer_id,via,link_issued_at) VALUES(?,?,?,?,?)",
    [user.id, user.salespersonId ?? null, it.customer_id, "daily_plan", now.toISOString()]));
  executeChanges("UPDATE dp_items SET call_id=? WHERE id=?", [id, it.id]);
  return { ok: true, callId: id, tel: `tel:${digits}`, reused: Boolean(pend) };
}
export function dpMarkReturned(user: CqUser, callId: number, now = new Date()) {
  if (!dpActiveFor(user, now)) return false;
  return executeChanges("UPDATE call_queue_calls SET returned_at=? WHERE id=? AND user_id=? AND via='daily_plan' AND returned_at IS NULL AND report_saved_at IS NULL AND link_issued_at<=?",
    [now.toISOString(), callId, user.id, new Date(now.getTime() - 3000).toISOString()]) > 0;
}
/** «جابه‌جایی»: current item only, ≤2 per item, target later today and ≤17:45; logged on the customer timeline. */
export function dpMove(user: CqUser & { fullName?: string | null; username?: string }, itemId: number, body: any, now = new Date()) {
  const p = dpActiveFor(user, now); if (!p) return err(409, "no_active_plan", "«کارهای امروز» الان فعال نیست.");
  const it = currentItem(p, itemId); if (!it) return err(409, "not_current_item", "فقط کار فعلی جابه‌جا می‌شود.");
  if (it.move_count >= DP_MOVE_MAX) return err(409, "move_limit_reached", "این کار دو بار جابه‌جا شده؛ دیگر نمی‌شود.", { moveCount: it.move_count, max: DP_MOVE_MAX });
  const reason = String(body?.reason ?? ""); if (!DP_MOVE_REASONS[reason]) return err(422, "reason_required", "دلیل جابه‌جایی را انتخاب کن.", { allowed: Object.keys(DP_MOVE_REASONS) });
  const text = String(body?.text ?? "").replace(/\s+/g, " ").trim();
  if (reason === "other" && !text) return err(422, "reason_text_required", "دلیل را کوتاه بنویس.");
  const today = dpToday(now); const last = atTehran(today, DP_MOVE_LAST_MIN);
  let to: Date | null = null; const raw = String(body?.to ?? body?.at ?? "");
  if (/^\d{1,2}:\d{2}$/.test(raw)) { const [h, mi] = raw.split(":").map(Number); to = atTehran(today, h * 60 + mi); } else if (raw) to = new Date(raw);
  if (now.getTime() >= last.getTime() || !to || Number.isNaN(to.getTime()) || to.getTime() <= now.getTime() || to.getTime() > last.getTime() || dpToday(to) !== today)
    return err(422, "move_out_of_day", "جابه‌جایی فقط به ساعتی دیرتر از الان و تا ۱۷:۴۵ امروز.", { lastMoveAt: last.toISOString() });
  const at = now.toISOString(); const label = DP_MOVE_REASONS[reason]; const note = `${label}${text ? ` · ${text}` : ""} · ساعت ${faDigits(hhmm(to.toISOString()))}`;
  const b = maxBellId();
  const sp = queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [user.salespersonId ?? -1]);
  execute(`INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,expert_notes,created_at,created_by_user_id,source) VALUES(?,?,?,?,?,?,?,'daily_plan')`,
    [it.customer_id, user.salespersonId ?? null, sp?.name ?? null, `${DP_TIMELINE_PREFIX} جابه‌جایی`, note, at, user.id]);
  dropBells(b, it.customer_id);
  // an unreported CRM-button call on this item is closed without a report (counts as not on time, R2 rule unchanged)
  executeChanges("UPDATE call_queue_calls SET report_saved_at=?, on_time=0 WHERE user_id=? AND customer_id=? AND via='daily_plan' AND report_saved_at IS NULL", [at, user.id, it.customer_id]);
  executeChanges("UPDATE dp_items SET status='moved', move_count=move_count+1, moved_to=?, boost_rank=NULL, boost_at=NULL WHERE id=?", [to.toISOString(), it.id]);
  dpRefresh(planRow(p.salesperson_id, p.day)!, now);
  return { ok: true, itemId: it.id, movedTo: to.toISOString(), movesLeft: DP_MOVE_MAX - it.move_count - 1 };
}

/* ---------------- POST /calls & GET /customers hooks ---------------- */
/** Before cqParseCall. null = not a daily-plan call (normal flow). Sets body.__dp ('plan'|'outside') and body.__dpItem. */
export function dpPreCall(body: any, user: CqUser, now = new Date()): DpErr | null {
  if (!body || typeof body !== "object") return null;
  delete body.__dp; delete body.__dpItem;
  const p = dpActiveFor(user, now); if (!p) return null;
  const outcome = String(body.outcome ?? ""); const note = noteText(body.oneLineNote);
  const need = () => !CQ_OUTCOMES.includes(outcome as any) ? err(422, "outcome_required", "نتیجه‌ی تماس را انتخاب کن.", { allowed: CQ_OUTCOMES })
    : !note ? err(422, "note_required", "یادداشت یک‌خطی را بنویس.") : null;
  // LOGGED-CALL-63: the customer's open item of today's plan (current first), if any.
  const ownOpen = () => items(p.id, "customer_id=? AND status IN ('current','pending')", [Number(body.customerId)])
    .sort((a, b) => (a.status === "current" ? 0 : 1) - (b.status === "current" ? 0 : 1) || a.id - b.id)[0];
  if (body.outOfList === true || body.context === "out_of_list") {
    const e = need(); if (e) return e;
    body.__dp = "outside"; if (!String(body.subject ?? "").trim()) body.subject = DP_OUT_OF_LIST_SUBJECT;
    // LOGGED-CALL-63: an inbound call from a customer who IS on today's list closes that item (no «خارج از لیست» mirror).
    const own = ownOpen(); if (own && !dpFirstCallIncomplete(p, own)) body.__dpItem = own.id;
    return null;
  }
  if (body.planItemId === undefined || body.planItemId === null || body.planItemId === "") {
    // HOTFIX-CALLLOG-56: the regular «ثبت تماس جدید» dialog (customer page / customers list / assistant box) sends no planItemId.
    // Never refuse it (409 plan_item_required lost real calls): save it exactly like before daily_plan (no outcome/note required),
    // and only mirror it on today's plan as a done «خارج از لیست» item (bucket outside — not part of the completion %).
    // NEXTITEM-60: if this customer is an open item of today's plan (current or pending), the regular-dialog call closes THAT item
    // (done, no «خارج از لیست» mirror) and the next item becomes current. Otherwise the 4cd873b mirror stays as it was.
    const own = ownOpen();
    // LOGGED-CALL-63 / FIRSTCALL-62 rule 3: a qualifier first-call item with the first-call form still incomplete stays open ('held':
    // no mirror, the dial is reported); only the first-call form closes it.
    if (own && dpFirstCallIncomplete(p, own)) { body.__dp = "held"; body.__dpItem = own.id; return null; }
    if (own) { body.__dp = "legacy_item"; body.__dpItem = own.id; return null; }
    body.__dp = "legacy"; return null;
  }
  const id = Number(body.planItemId);
  if (!Number.isSafeInteger(id) || id <= 0) return err(409, "plan_item_required", "این گزارش باید برای کار فعلی «کارهای امروز» باشد (یا «خارج از لیست»).");
  const it = currentItem(p, id); if (!it || it.customer_id !== Number(body.customerId)) return err(409, "not_current_item", "این کار، کار فعلی نیست.");
  const e = need(); if (e) return e;
  body.__dp = "plan"; body.__dpItem = id; return null;
}
/** Inside the POST /calls transaction (no nested transaction). */
export function dpAfterCall(body: any, callLogId: number, user: CqUser, customerId: number, nowIso = new Date().toISOString()) {
  const kind = body?.__dp; if (kind !== "plan" && kind !== "outside" && kind !== "legacy" && kind !== "legacy_item" && kind !== "held") return null;
  const p = planRow(Number(user.salespersonId), dpToday(new Date(nowIso))); if (!p) return null;
  const log = { id: callLogId, created_at: nowIso };
  if (kind === "held") { dpCloseDialWith(p, customerId, log); return null; }
  const outcome = kind === "legacy" || kind === "legacy_item" ? (CQ_OUTCOMES.includes(String(body.outcome ?? "") as any) ? String(body.outcome) : null) : String(body.outcome ?? "");
  if (kind === "legacy_item" || (kind === "outside" && body.__dpItem)) {
    const itemId = Number(body.__dpItem);
    const n = executeChanges("UPDATE dp_items SET status='done', outcome=?, call_log_id=?, done_at=? WHERE id=? AND plan_id=? AND customer_id=? AND status IN ('current','pending')",
      [outcome, callLogId, nowIso, itemId, p.id, customerId]);
    if (n > 0) {
      // an unreported CRM-button dial for this customer is closed by this report, so it never blocks the next item (423 call_pending).
      const pend = queryRow<{ id: number; link_issued_at: string; returned_at: string | null }>(
        "SELECT id,link_issued_at,returned_at FROM call_queue_calls WHERE user_id=? AND customer_id=? AND via='daily_plan' AND report_saved_at IS NULL ORDER BY id DESC LIMIT 1", [user.id, customerId]);
      if (pend) executeChanges("UPDATE call_queue_calls SET report_saved_at=?, call_log_id=?, on_time=? WHERE id=?", [nowIso, callLogId, cqOnTime(pend.link_issued_at, pend.returned_at, nowIso) ? 1 : 0, pend.id]);
      if (!items(p.id, "status='current'").length) {
        const next = ordered(p.id)[0];
        if (next) executeChanges("UPDATE dp_items SET status='current', became_current_at=? WHERE id=? AND status='pending'", [nowIso, next.id]);
      }
      return { kind: "legacy_item", itemId };
    }
  }
  if (kind === "plan") {
    executeChanges("UPDATE dp_items SET status='done', outcome=?, call_log_id=?, done_at=? WHERE id=? AND plan_id=? AND status='current'", [outcome, callLogId, nowIso, Number(body.__dpItem), p.id]);
    return { kind, itemId: Number(body.__dpItem) };
  }
  dpCloseDialWith(p, customerId, log);
  const id = addItem(p.id, { customerId, type: "followup", source: "out_of_list", bucket: "outside", position: 99999, label: DP_LABELS.outOfList, status: "done" }, nowIso);
  executeChanges("UPDATE dp_items SET outcome=?, call_log_id=?, done_at=? WHERE id=?", [outcome, callLogId, nowIso, id]);
  return { kind, itemId: id };
}
export function dpAfterCommit(user: CqUser, now = new Date()) {
  const p = dpActiveFor(user, now); if (!p) return null;
  const cur = ordered(p.id).find(i => i.status === "current");
  return { next: cur ? itemView(cur) : null, state: dpState(planRow(p.salesperson_id, p.day), now) };
}
/**
 * FIRSTCALL-62: the first-call form (POST /customers/:id/team-sales/qualify) writes its own call_logs row, not POST /calls,
 * so it never reached dpAfterCall. Saving it on a customer that is an open item of the expert's plan today (current or pending)
 * closes THAT item exactly like NEXTITEM-60 «legacy_item» (done, outcome mapped, call_log linked, open daily_plan dial closed,
 * next item promoted). Not on today's plan → nothing (the first-call form never mirrored «خارج از لیست»). Own transaction, after the form committed.
 */
export const DP_FIRST_CALL_OUTCOME: Record<string, string | null> = { answered: "answered", no_answer: "no_answer", callback: "follow_up", wrong_number: null };
export function dpAfterFirstCallForm(user: CqUser, customerId: number, callLogId: number, callResult: string, now = new Date()) {
  if (!dpOn() || !dpIsExpert(user)) return null;
  const cid = Number(customerId);
  const ownOf = (p: Plan) => items(p.id, "customer_id=? AND status IN ('current','pending')", [cid])
    .sort((a, b) => (a.status === "current" ? 0 : 1) - (b.status === "current" ? 0 : 1) || a.id - b.id)[0];
  const close = (it: Item) => dpAfterCall({ __dp: "legacy_item", __dpItem: it.id, outcome: DP_FIRST_CALL_OUTCOME[callResult] ?? null }, callLogId, user, cid, now.toISOString());
  // LOGGED-CALL-63: customer still the expert's → close the item BEFORE any refresh (the self-heal would close it too, but without the mapped outcome).
  const p0 = openPlanOf(Number(user.salespersonId), dpToday(now));
  if (p0 && owned(p0.salesperson_id, cid)) { const own = ownOf(p0); if (own) return close(own); }
  const p = dpActiveFor(user, now); if (!p) return null;
  const own = ownOf(p); if (own) return close(own);
  // P1 hand-off: the refresh moved the customer («منتقل شد», the new owner got «تازه اضافه شد») — no open item, but the dial on it
  // must still be reported, or it blocks every next «تماس» (423 «اول گزارش تماس با … را ثبت کن»). (The refresh self-heal normally did it already.)
  dpCloseDialWith(p, cid, { id: callLogId, created_at: now.toISOString() });
  return null;
}
/** GET /customers?search=… while the plan is active: only for incoming calls (purpose=incoming_call), else 422 purpose_required. */
export function dpSearchCheck(user: CqUser, q: any, now = new Date()): DpErr | null {
  const s = String(q?.search ?? "").trim(); if (!s) return null;
  if (!dpActiveFor(user, now)) return null;
  return String(q?.purpose ?? "") === "incoming_call" ? null : err(422, "purpose_required", "جستجو فقط برای «تماس ورودی» است؛ کارهای امروز را از لیست برو.");
}
/** R2 discipline on the plan (flag daily_plan_discipline): carried items still open today count as overdue. */
export function dpOverdueExtra(user: CqUser, now = new Date()): number[] {
  if (!dpOn() || !dpDisciplineOn() || user.salespersonId == null) return [];
  ensureDailyPlanSchema();
  const p = planRow(Number(user.salespersonId), dpToday(now)); if (!p || !p.started_at) return [];
  return items(p.id, `source='carried' AND ${ACTIVE}`).map(i => Number(i.customer_id));
}

/* ---------------- admin board / report / config ---------------- */
export function dpBoard(dayIn: unknown, now = new Date()) {
  if (!dpOn()) return { enabled: false as const };
  ensureDailyPlanSchema();
  const day = isYmd(dayIn) ? dayIn : dpToday(now);
  const experts = dpExperts().map(e => {
    const sp = Number(e.salespersonId); let p = planRow(sp, day); if (p && day === dpToday(now)) p = dpRefresh(p, now);
    const st = p ? dpStats(p) : null; const cur = p ? items(p.id, "status='current'")[0] : null;
    return { userId: e.id, salespersonId: sp, name: e.name, assistant: { id: e.assistant.id, name: e.assistant.display_name, scope: dpScopeRestricted(e.assistant) ? "p1" : e.assistant.scope_rule },
      state: day === dpToday(now) ? dpState(p, now) : p?.closed_at ? "closed" : p ? "not_started" : "empty", mode: p?.mode ?? null, modeLabel: p?.mode === "auto" ? DP_LABELS.autoDay : null,
      capacity: dpCapacity(sp, day), stats: st, current: cur ? { name: custName(cur.customer_id), typeLabel: DP_TYPE_LABELS[cur.type], label: cur.label } : null,
      items: p ? items(p.id).sort((a, b) => a.position - b.position).map(i => itemView(i)) : [] };
  });
  return { enabled: true as const, day, experts };
}
export function dpReport(fromIn: unknown, toIn: unknown, now = new Date()) {
  if (!dpOn()) return { enabled: false as const };
  ensureDailyPlanSchema();
  const to = isYmd(toIn) ? toIn : dpToday(now); const from = isYmd(fromIn) ? fromIn : dpPrevWorkN(to, 13);
  const days = dpWorkDays(from, to);
  return { enabled: true as const, from, to, experts: dpExperts().map(e => { const rows = dayRows(Number(e.salespersonId), days); return { userId: e.id, salespersonId: e.salespersonId, name: e.name, days: rows, ...average(rows) }; }),
    note: "میانگین فقط روزهایی را می‌شمارد که دستیار لیست نوشته؛ روزهای «خودکار» نشان داده می‌شوند ولی در میانگین نیستند." };
}
export function dpConfig() {
  const f = cqFlags();
  return { flags: { daily_plan: f.daily_plan, assistant_full_scope: f.assistant_full_scope, daily_plan_discipline: f.daily_plan_discipline }, settings: dpSettings(), ranges: DP_RANGES,
    labels: DP_LABELS, typeLabels: DP_TYPE_LABELS, events: DP_EVENTS, moveReasons: DP_MOVE_REASONS,
    limits: { moveMax: DP_MOVE_MAX, lastMove: "17:45", start: "08:00", close: "18:00", reasonMax: DP_REASON_MAX, keyNoteMax: DP_KEYNOTE_MAX, moveTextMax: DP_MOVE_TEXT_MAX, capReasonMax: DP_CAP_REASON_MAX, rowsMax: DP_ROWS_MAX, capMax: DP_CAP_MAX, autoBatch: DP_AUTO_BATCH },
    experts: f.daily_plan ? dpExperts().map(e => ({ userId: e.id, salespersonId: e.salespersonId, name: e.name, assistantId: e.assistant.id, scope: dpScopeRestricted(e.assistant) ? "p1" : e.assistant.scope_rule })) : [] };
}
/** Assistant GET /daily-plans/{date}. */
export function dpAssistantView(p: Plan) {
  const st = dpStats(p);
  return { date: p.day, version: p.version, mode: p.mode, modeLabel: p.mode === "auto" ? DP_LABELS.autoDay : null, capacity: p.capacity, backlog: Boolean(p.backlog), writtenAt: p.written_at,
    startedAt: p.started_at, finishedAt: p.finished_at, closedAt: p.closed_at, stats: st,
    items: items(p.id).sort((a, b) => a.position - b.position).map(i => ({ id: i.id, customerId: i.customer_id, name: custName(i.customer_id), type: i.type, reason: i.reason, keyNote: i.key_note,
      bucket: i.bucket, source: i.source, label: i.label, status: i.status, moveCount: i.move_count, outcome: i.outcome })) };
}
export function dpAssistantGet(a: Asst, dayIn: unknown, now = new Date()) {
  ensureDailyPlanSchema();
  const ex = expertOf(a); if (isErr(ex)) return ex;
  if (!isYmd(dayIn)) return err(422, "date_not_allowed", "تاریخ معتبر نیست.");
  let p = planRow(Number(ex.salespersonId), dayIn); if (!p) return err(404, "no_plan", "برای این روز لیستی نیست.", { capacity: dpCapacity(Number(ex.salespersonId), dayIn) });
  if (dayIn === dpToday(now)) p = dpRefresh(p, now);
  return dpAssistantView(p);
}

/**
 * NEWCUST-65 (= incoming2-59 PM 10:51 (a)): a call recorded through the first-call form right after «تماس ورودی داشتم › ثبت مشتری جدید»
 * is «خارج از لیست». The first-call form (POST /customers/:id/team-sales/qualify) writes its own call_logs row and never reaches dpAfterCall,
 * so the dialog confirms it here: mirror it on today's plan as a done «خارج از لیست» item (bucket outside, not in the %), exactly like the
 * 4cd873b mirror of a regular call. Only this expert's own form call on his own customer, saved in the last 30 minutes, once.
 * An open item of that customer is left to FIRSTCALL-62 (it closes that item). Never a plan item, never a notification.
 */
const DP_FC_OUTCOME: Record<string, string | null> = { answered: "answered", no_answer: "no_answer", callback: "follow_up", wrong_number: null };
export function dpIncomingFirstCallMirror(user: CqUser, body: any, now = new Date()): { ok: true; mirrored: boolean; itemId?: number } | DpErr {
  const customerId = Number(body?.customerId), callLogId = Number(body?.callLogId);
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || !Number.isSafeInteger(callLogId) || callLogId <= 0) return err(400, "invalid", "شناسه‌ها معتبر نیست.");
  const cl = queryRow<{ customer_id: number; salesperson_id: number | null; created_at: string }>("SELECT customer_id,salesperson_id,created_at FROM call_logs WHERE id=?", [callLogId]);
  const q = queryRow<{ call_result: string | null }>("SELECT call_result FROM team_sales_qualifications WHERE call_log_id=? AND customer_id=? AND actor_user_id=? ORDER BY id DESC LIMIT 1", [callLogId, customerId, user.id]);
  const owner = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=?", [customerId]);
  // NEWCUST-65 (11:36): a closer's own new customer whose first-call form gave P2/P3 moved to Kazemi in the SAME save
  // (crm-nonp1-to-kazemi history row by this actor from this expert) → the creator's entry is «منتقل شد», not «خارج از لیست».
  const movedAway = !!owner && owner.salesperson_id != null && Number(owner.salesperson_id) !== Number(user.salespersonId) && !!cl &&
    !!queryRow("SELECT 1 x FROM customer_priority_history WHERE customer_id=? AND source='nonp1_auto_transfer' AND actor_user_id=? AND old_salesperson_id=? AND created_at>=? LIMIT 1",
      [customerId, user.id, Number(user.salespersonId), cl.created_at]);
  if (!cl || !q || cl.customer_id !== customerId || owner?.salesperson_id == null || (Number(owner.salesperson_id) !== Number(user.salespersonId) && !movedAway)) return err(404, "not_found", "تماس پیدا نشد.");
  if (now.getTime() - Date.parse(cl.created_at) > 30 * 60_000) return err(409, "too_old", "این تماس قدیمی است.");
  const p = dpActiveFor(user, now); if (!p) return { ok: true, mirrored: false };
  return runImmediateTransaction(() => {
    if (queryRow("SELECT id FROM dp_items WHERE plan_id=? AND call_log_id=?", [p.id, callLogId])) return { ok: true as const, mirrored: false };
    // LOGGED-CALL-63 rule: one «خارج از لیست» entry only for a customer NOT on today's plan (any list item, any status → no copy).
    if (items(p.id, "customer_id=? AND bucket<>'outside'", [customerId]).length) return { ok: true as const, mirrored: false };
    const r = dpAfterCall({ __dp: "legacy", outcome: DP_FC_OUTCOME[String(q.call_result ?? "")] ?? null }, callLogId, user, customerId, now.toISOString());
    if (r && movedAway) executeChanges("UPDATE dp_items SET status='transferred', label=? WHERE id=? AND bucket='outside'", [DP_LABELS.transferred, r.itemId]);
    return { ok: true as const, mirrored: !!r, itemId: r?.itemId, ...(movedAway ? { transferred: true } : {}) };
  });
}

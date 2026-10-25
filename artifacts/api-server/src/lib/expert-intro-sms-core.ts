/**
 * crm-expert-intro-sms core: one SMS to the customer introducing their sales expert after Kazemi (the qualifier)
 * hands the customer off to a non-Kazemi expert. Text (an IPPanel pattern that must be approved in the panel):
 *   approved IPPanel pattern wuk6lgtho227bxc with params name (customer, empty → «مشتری»), sale_name, sale_mobile:
 *   «سلام %name%  عزیز از تماس شما با مجموعه نفیس سپاسگزاریم. به دلیل حجم بالای پیام‌های دریافتی، ممکن است پاسخگویی کمی زمان‌بر باشد. ممنون از صبوریتون. کارشناس شما: %sale_name% شماره تماس: %sale_mobile% با احترام، مجموعه نفیس»
 * - Admin switch notification_settings.expert_intro_sms_enabled (absent = OFF). OFF → nothing is queued or sent and
 *   nothing is written; items already queued are dropped with a «غیرفعال» skip log on the next worker tick.
 * - Expert phone = users.customer_contact_phone («شماره تماس برای مشتری»); empty → skip «شماره‌ی کارشناس تعریف نشده».
 * - At most one send per (customer, expert); skips do not block a later send; failed (rejected before delivery) may be re-queued.
 * - Sends only 08:00–21:00 Tehran time (fixed UTC+03:30); outside that window it waits for the next 08:00.
 * - Never to trainees (salesperson 5, 19, 20), the qualifier, test/staff numbers or old customers («مشتری قبلی»).
 * This module never imports crm-db: the DB handle, clock and sender are injected so the fixture runs it on a copy.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const EXPERT_INTRO_ENABLED_KEY = "expert_intro_sms_enabled";
export const EXPERT_INTRO_PATTERN_KEY = "expert_intro_sms_pattern_code";
export const EXPERT_INTRO_BLOCKED_KEY = "expert_intro_sms_blocked_phones";
export const EXPERT_INTRO_TRAINEE_SALESPERSON_IDS = [5, 19, 20] as const;
export const EXPERT_INTRO_PARAM_CUSTOMER = "name";
export const EXPERT_INTRO_PARAM_NAME = "sale_name";
export const EXPERT_INTRO_PARAM_PHONE = "sale_mobile";
export const EXPERT_INTRO_TEMPLATE = "سلام %name%  عزیز از تماس شما با مجموعه نفیس سپاسگزاریم. به دلیل حجم بالای پیام‌های دریافتی، ممکن است پاسخگویی کمی زمان‌بر باشد. ممنون از صبوریتون. کارشناس شما: %sale_name% شماره تماس: %sale_mobile% با احترام، مجموعه نفیس";
export const EXPERT_INTRO_CUSTOMER_FALLBACK = "مشتری";
export const customerParam = (name: unknown): string => (typeof name === "string" ? name.trim().slice(0, 40) : "") || EXPERT_INTRO_CUSTOMER_FALLBACK;
export const EXPERT_INTRO_MAX_AGE_MS = 3 * 24 * 3600_000;
const TEHRAN_OFFSET_MIN = 210;
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 21 * 60;

export const REASONS = {
  disabled: "غیرفعال",
  noExpertPhone: "شماره‌ی کارشناس تعریف نشده",
  noPattern: "کد الگوی پیامک تعریف نشده",
  trainee: "کارشناس کارآموز",
  qualifier: "کارشناس ارزیاب (کاظمی)",
  oldCustomer: "مشتری قبلی",
  testNumber: "شماره‌ی آزمایشی یا داخلی",
  badCustomerPhone: "شماره‌ی موبایل مشتری معتبر نیست",
  duplicate: "قبلاً برای همین کارشناس ارسال یا در صف شده",
  merged: "پرونده ادغام شده",
  reassigned: "کارشناس مشتری تغییر کرده",
  expired: "بیش از ۳ روز در صف ماند",
  ippanelOff: "پیامک IPPanel در تنظیمات اعلان‌ها خاموش است",
  noCustomer: "مشتری پیدا نشد",
  deferred: "خارج از ساعت ۸ تا ۲۱؛ ساعت ۸ صبح ارسال می‌شود",
} as const;

export type IntroStatus = "queued" | "sending" | "sent" | "failed" | "uncertain";
export type LogStatus = "queued" | "sent" | "skipped" | "failed" | "uncertain" | "test_sent" | "test_failed";
export type IntroSettings = { enabled: boolean; patternCode: string; blockedPhones: string[] };
export type SendArgs = { recipient: string; patternCode: string; params: Record<string, string> };
export type Sender = (args: SendArgs) => Promise<string>;

type Db = DatabaseSync;
const row = <T>(db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as never[])) as T | undefined;
const rows = <T>(db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as never[])) as T[];
const run = (db: Db, sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as never[]));

const ready = new WeakSet<object>();
export function ensureExpertIntroSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS expert_intro_sms (
      customer_id INTEGER NOT NULL,
      salesperson_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','failed','uncertain')),
      source TEXT,
      next_attempt_at TEXT,
      claim_token TEXT,
      attempted_at TEXT,
      provider_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (customer_id, salesperson_id)
    );
    CREATE INDEX IF NOT EXISTS idx_expert_intro_sms_due ON expert_intro_sms(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS expert_intro_sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      salesperson_id INTEGER,
      expert_name TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      actor_user_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expert_intro_sms_log_customer ON expert_intro_sms_log(customer_id, id DESC);
  `);
  const cols = rows<{ name: string }>(db, "PRAGMA table_info(users)").map((c) => c.name);
  if (cols.length && !cols.includes("customer_contact_phone")) db.exec("ALTER TABLE users ADD COLUMN customer_contact_phone TEXT");
  ready.add(db);
}

// ------------------------------------------------------------------ settings
function setting(db: Db, key: string): string | null {
  return row<{ value: string }>(db, "SELECT value FROM notification_settings WHERE key=?", key)?.value ?? null;
}
function putSetting(db: Db, key: string, value: string, now: Date): void {
  run(db, `INSERT INTO notification_settings (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, value, now.toISOString());
}
export function getExpertIntroSettings(db: Db): IntroSettings {
  let blocked: string[] = [];
  try { const v = JSON.parse(setting(db, EXPERT_INTRO_BLOCKED_KEY) ?? "[]"); if (Array.isArray(v)) blocked = v.map(String); } catch { blocked = []; }
  return { enabled: setting(db, EXPERT_INTRO_ENABLED_KEY) === "true", patternCode: (setting(db, EXPERT_INTRO_PATTERN_KEY) ?? "").trim(), blockedPhones: blocked };
}
export class ExpertIntroError extends Error { constructor(public status: number, message: string) { super(message); } }
export function saveExpertIntroSettings(db: Db, patch: { enabled?: unknown; patternCode?: unknown; blockedPhones?: unknown }, now = new Date()): IntroSettings {
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new ExpertIntroError(400, "مقدار سوییچ نامعتبر است.");
  let code: string | undefined;
  if (patch.patternCode !== undefined) {
    if (typeof patch.patternCode !== "string") throw new ExpertIntroError(400, "کد الگو نامعتبر است.");
    code = patch.patternCode.trim();
    if (code && !/^[A-Za-z0-9_-]{3,64}$/.test(code)) throw new ExpertIntroError(400, "کد الگو فقط حروف و ارقام لاتین است.");
  }
  let blocked: string[] | undefined;
  if (patch.blockedPhones !== undefined) {
    const list = Array.isArray(patch.blockedPhones) ? patch.blockedPhones : typeof patch.blockedPhones === "string" ? patch.blockedPhones.split(/[\s,،]+/) : null;
    if (!list) throw new ExpertIntroError(400, "فهرست شماره‌های آزمایشی نامعتبر است.");
    const out = new Set<string>();
    for (const raw of list) {
      const s = String(raw ?? "").trim(); if (!s) continue;
      const m = mobileKey(s); if (!m) throw new ExpertIntroError(400, `شماره‌ی «${s}» موبایل معتبر نیست.`);
      out.add(m);
    }
    if (out.size > 200) throw new ExpertIntroError(400, "حداکثر ۲۰۰ شماره.");
    blocked = [...out];
  }
  if (patch.enabled !== undefined) putSetting(db, EXPERT_INTRO_ENABLED_KEY, patch.enabled ? "true" : "false", now);
  if (code !== undefined) putSetting(db, EXPERT_INTRO_PATTERN_KEY, code, now);
  if (blocked !== undefined) putSetting(db, EXPERT_INTRO_BLOCKED_KEY, JSON.stringify(blocked), now);
  return getExpertIntroSettings(db);
}

// ------------------------------------------------------------------ phones
function latinDigits(v: string): string {
  return v.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
/** 09xxxxxxxxx or null. */
export function mobileKey(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let d = latinDigits(String(value)).replace(/[^\d]/g, "");
  if (d.startsWith("0098")) d = "0" + d.slice(4); else if (d.startsWith("98") && d.length === 12) d = "0" + d.slice(2);
  else if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}
/** Expert phone shown to the customer: a mobile (09…) or a landline with area code (0xx…, 11 digits). */
export function normalizeContactPhone(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const t = value.trim(); if (!t) return null;
  const m = mobileKey(t); if (m) return m;
  const d = latinDigits(t).replace(/[\s\-()]/g, "");
  return /^0[1-8]\d{9}$/.test(d) ? d : undefined;
}
export function renderIntroText(customer: string, name: string, phone: string): string {
  return EXPERT_INTRO_TEMPLATE.replace("%name%", customerParam(customer)).replace("%sale_name%", name).replace("%sale_mobile%", phone);
}

// ------------------------------------------------------------------ Tehran window
export function tehranMinuteOfDay(now: Date): number {
  return (((now.getUTCHours() * 60 + now.getUTCMinutes() + TEHRAN_OFFSET_MIN) % 1440) + 1440) % 1440;
}
export function inSendWindow(now: Date): boolean {
  const m = tehranMinuteOfDay(now);
  return m >= WINDOW_START_MIN && m < WINDOW_END_MIN;
}
/** now when inside 08:00–21:00 Tehran, else the next 08:00 Tehran. */
export function nextSendTime(now: Date): Date {
  if (inSendWindow(now)) return now;
  const local = new Date(now.getTime() + TEHRAN_OFFSET_MIN * 60_000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const addDay = tehranMinuteOfDay(now) >= WINDOW_END_MIN ? 1 : 0;
  return new Date(day + addDay * 86_400_000 + (WINDOW_START_MIN - TEHRAN_OFFSET_MIN) * 60_000);
}

// ------------------------------------------------------------------ expert lookups
export type ExpertInfo = { salespersonId: number; name: string; userId: number | null; phone: string | null };
export function expertInfo(db: Db, salespersonId: number): ExpertInfo | null {
  const sp = row<{ id: number; name: string }>(db, "SELECT id, name FROM salespersons WHERE id=?", salespersonId);
  if (!sp) return null;
  const u = row<{ id: number; customer_contact_phone: string | null }>(db,
    `SELECT id, customer_contact_phone FROM users WHERE salesperson_id=? AND active=1 ORDER BY (role='salesperson') DESC, id LIMIT 1`, salespersonId);
  const phone = u?.customer_contact_phone ? normalizeContactPhone(u.customer_contact_phone) ?? null : null;
  return { salespersonId: Number(sp.id), name: String(sp.name ?? "").trim(), userId: u ? Number(u.id) : null, phone };
}
function tableExists(db: Db, name: string): boolean {
  return !!row(db, "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", name);
}
/** Test/staff numbers: admin list, VoIP display exclusions, and every staff user/salesperson phone. */
export function isTestOrStaffPhone(db: Db, phone: string, settings: IntroSettings): boolean {
  const key = mobileKey(phone); if (!key) return false;
  if (settings.blockedPhones.includes(key)) return true;
  if (tableExists(db, "voip_call_display_exclusions") && row(db, "SELECT 1 AS x FROM voip_call_display_exclusions WHERE phone=?", key)) return true;
  const staff = [
    ...rows<{ p: string | null }>(db, "SELECT mobile AS p FROM users UNION ALL SELECT customer_contact_phone FROM users"),
    ...rows<{ p: string | null }>(db, "SELECT mobile AS p FROM salespersons"),
  ];
  return staff.some((s) => s.p && mobileKey(s.p) === key);
}
/**
 * «مشتری قبلی»: the customer was owned by a salesperson other than the qualifier before the qualifier had them
 * (earliest ownership record), or came to the qualifier in the bulk transfer snapshot.
 */
export function isOldCustomer(db: Db, customerId: number, qualifierId: number): boolean {
  if (tableExists(db, "customer_priority_history")) {
    const first = row<{ old_salesperson_id: number | null }>(db,
      "SELECT old_salesperson_id FROM customer_priority_history WHERE customer_id=? ORDER BY id LIMIT 1", customerId);
    if (first && first.old_salesperson_id != null && Number(first.old_salesperson_id) !== qualifierId) return true;
  }
  if (tableExists(db, "team_sales_transfer_snapshot") &&
    row(db, "SELECT 1 AS x FROM team_sales_transfer_snapshot WHERE customer_id=? AND previous_salesperson_id IS NOT NULL AND previous_salesperson_id<>?", customerId, qualifierId)) return true;
  return false;
}

export function logIntro(db: Db, e: { customerId: number | null; salespersonId: number | null; expertName: string | null; status: LogStatus; reason?: string | null; actorUserId?: number | null }, now: Date): void {
  run(db, `INSERT INTO expert_intro_sms_log (customer_id, salesperson_id, expert_name, status, reason, actor_user_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    e.customerId, e.salespersonId, e.expertName, e.status, e.reason ?? null, e.actorUserId ?? null, now.toISOString());
}

type CustomerRow = { id: number; name?: string | null; phone: string | null; salesperson_id: number | null; merged_into_customer_id: number | null };
function checkEligibility(db: Db, c: CustomerRow, expert: ExpertInfo, s: IntroSettings, qualifierId: number, ippanelEnabled: boolean): string | null {
  if (c.merged_into_customer_id != null) return REASONS.merged;
  if (expert.salespersonId === qualifierId) return REASONS.qualifier;
  if ((EXPERT_INTRO_TRAINEE_SALESPERSON_IDS as readonly number[]).includes(expert.salespersonId)) return REASONS.trainee;
  if (isOldCustomer(db, c.id, qualifierId)) return REASONS.oldCustomer;
  if (!c.phone || !mobileKey(c.phone)) return REASONS.badCustomerPhone;
  if (isTestOrStaffPhone(db, c.phone, s)) return REASONS.testNumber;
  if (!expert.phone) return REASONS.noExpertPhone;
  if (!s.patternCode) return REASONS.noPattern;
  if (!ippanelEnabled) return REASONS.ippanelOff;
  return null;
}

export type ChangeInput = { customerId: number; oldSalespersonId: number | null; newSalespersonId: number | null; source: string; qualifierId: number | null };
export type ChangeResult = { action: "none" | "queued" | "skipped"; reason?: string };
/**
 * Called right after an ownership change is recorded (inside the caller's transaction when there is one).
 * Trigger = qualifier → another salesperson. Switch OFF → returns without any read beyond the setting, and writes nothing.
 */
export function onSalespersonChange(db: Db, ch: ChangeInput, opts: { ippanelEnabled: boolean; now?: Date }): ChangeResult {
  const now = opts.now ?? new Date();
  const enabled = setting(db, EXPERT_INTRO_ENABLED_KEY) === "true";
  if (!enabled) return { action: "none" };
  const k = ch.qualifierId;
  if (k == null || ch.oldSalespersonId == null || Number(ch.oldSalespersonId) !== k) return { action: "none" };
  if (ch.newSalespersonId == null || Number(ch.newSalespersonId) === k) return { action: "none" };
  ensureExpertIntroSchema(db);
  const s = getExpertIntroSettings(db);
  const spId = Number(ch.newSalespersonId);
  const expert = expertInfo(db, spId) ?? { salespersonId: spId, name: "", userId: null, phone: null };
  const c = row<CustomerRow>(db, "SELECT id, phone, salesperson_id, merged_into_customer_id FROM customers WHERE id=?", ch.customerId);
  const skip = (reason: string): ChangeResult => {
    logIntro(db, { customerId: ch.customerId, salespersonId: spId, expertName: expert.name || null, status: "skipped", reason }, now);
    return { action: "skipped", reason };
  };
  if (!c) return skip(REASONS.noCustomer);
  const existing = row<{ status: IntroStatus }>(db, "SELECT status FROM expert_intro_sms WHERE customer_id=? AND salesperson_id=?", ch.customerId, spId);
  if (existing && existing.status !== "failed") return skip(REASONS.duplicate);
  const why = checkEligibility(db, c, expert, s, k, opts.ippanelEnabled);
  if (why) return skip(why);
  const due = nextSendTime(now);
  const iso = now.toISOString();
  run(db, `INSERT INTO expert_intro_sms (customer_id, salesperson_id, status, source, next_attempt_at, claim_token, attempted_at, provider_id, error_code, created_at, updated_at)
    VALUES (?,?,'queued',?,?,NULL,NULL,NULL,NULL,?,?)
    ON CONFLICT(customer_id, salesperson_id) DO UPDATE SET status='queued', source=excluded.source, next_attempt_at=excluded.next_attempt_at,
      claim_token=NULL, attempted_at=NULL, provider_id=NULL, error_code=NULL, created_at=excluded.created_at, updated_at=excluded.updated_at
    WHERE expert_intro_sms.status='failed'`, ch.customerId, spId, ch.source, due.toISOString(), iso, iso);
  logIntro(db, { customerId: ch.customerId, salespersonId: spId, expertName: expert.name || null, status: "queued",
    reason: due.getTime() > now.getTime() ? REASONS.deferred : null }, now);
  return { action: "queued" };
}

export type TickResult = { sent: number; failed: number; uncertain: number; skipped: number; waiting: number };
/** One worker pass. `send` is only called inside the Tehran window, with the switch ON, for eligible rows. */
export async function expertIntroTick(db: Db, deps: { send: Sender; now?: () => Date; qualifierId: number | null; ippanelEnabled: () => boolean; batch?: number }): Promise<TickResult> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const out: TickResult = { sent: 0, failed: 0, uncertain: 0, skipped: 0, waiting: 0 };
  if (!tableExists(db, "expert_intro_sms")) return out;
  ensureExpertIntroSchema(db);
  // A claim older than 2 minutes may have reached the provider: never retry it.
  const stale = new Date(now.getTime() - 120_000).toISOString();
  for (const r of rows<{ customer_id: number; salesperson_id: number }>(db, "SELECT customer_id, salesperson_id FROM expert_intro_sms WHERE status='sending' AND attempted_at<?", stale)) {
    run(db, "UPDATE expert_intro_sms SET status='uncertain', error_code='stale_claim', updated_at=? WHERE customer_id=? AND salesperson_id=? AND status='sending'", now.toISOString(), r.customer_id, r.salesperson_id);
    logIntro(db, { customerId: r.customer_id, salespersonId: r.salesperson_id, expertName: expertInfo(db, r.salesperson_id)?.name ?? null, status: "uncertain", reason: "نتیجه‌ی ارسال نامشخص" }, now);
    out.uncertain++;
  }
  const s = getExpertIntroSettings(db);
  const queued = rows<{ customer_id: number; salesperson_id: number; created_at: string; next_attempt_at: string | null }>(db,
    "SELECT customer_id, salesperson_id, created_at, next_attempt_at FROM expert_intro_sms WHERE status='queued' ORDER BY next_attempt_at, created_at LIMIT 200");
  const drop = (r: { customer_id: number; salesperson_id: number }, reason: string, name: string | null) => {
    run(db, "DELETE FROM expert_intro_sms WHERE customer_id=? AND salesperson_id=? AND status='queued'", r.customer_id, r.salesperson_id);
    logIntro(db, { customerId: r.customer_id, salespersonId: r.salesperson_id, expertName: name, status: "skipped", reason }, now);
    out.skipped++;
  };
  if (!s.enabled) { for (const r of queued) drop(r, REASONS.disabled, expertInfo(db, r.salesperson_id)?.name ?? null); return out; }
  if (!inSendWindow(now)) { out.waiting = queued.length; return out; }
  let budget = deps.batch ?? 5;
  for (const r of queued) {
    if (r.next_attempt_at && r.next_attempt_at > now.toISOString()) { out.waiting++; continue; }
    if (budget-- <= 0) { out.waiting++; continue; }
    const expert = expertInfo(db, r.salesperson_id) ?? { salespersonId: r.salesperson_id, name: "", userId: null, phone: null };
    if (now.getTime() - Date.parse(r.created_at) > EXPERT_INTRO_MAX_AGE_MS) { drop(r, REASONS.expired, expert.name || null); continue; }
    const c = row<CustomerRow>(db, "SELECT id, name, phone, salesperson_id, merged_into_customer_id FROM customers WHERE id=?", r.customer_id);
    if (!c) { drop(r, REASONS.noCustomer, expert.name || null); continue; }
    if (c.salesperson_id == null || Number(c.salesperson_id) !== r.salesperson_id) { drop(r, REASONS.reassigned, expert.name || null); continue; }
    const why = deps.qualifierId == null ? REASONS.qualifier : checkEligibility(db, c, expert, s, deps.qualifierId, deps.ippanelEnabled());
    if (why) { drop(r, why, expert.name || null); continue; }
    const token = randomUUID();
    const claimed = run(db, "UPDATE expert_intro_sms SET status='sending', claim_token=?, attempted_at=?, updated_at=? WHERE customer_id=? AND salesperson_id=? AND status='queued'",
      token, now.toISOString(), now.toISOString(), r.customer_id, r.salesperson_id).changes;
    if (!claimed) continue;
    const recipient = mobileKey(c.phone!)!;
    try {
      const id = await deps.send({ recipient, patternCode: s.patternCode, params: { [EXPERT_INTRO_PARAM_CUSTOMER]: customerParam(c.name), [EXPERT_INTRO_PARAM_NAME]: expert.name.slice(0, 40), [EXPERT_INTRO_PARAM_PHONE]: expert.phone! } });
      const t = nowFn().toISOString();
      run(db, "UPDATE expert_intro_sms SET status='sent', provider_id=?, error_code=NULL, updated_at=? WHERE customer_id=? AND salesperson_id=? AND claim_token=?", id, t, r.customer_id, r.salesperson_id, token);
      logIntro(db, { customerId: r.customer_id, salespersonId: r.salesperson_id, expertName: expert.name || null, status: "sent", reason: null }, nowFn());
      out.sent++;
    } catch (error) {
      const code = error instanceof Error ? error.message : "sms_failed";
      const unknown = code === "sms_delivery_unknown";
      const t = nowFn().toISOString();
      run(db, "UPDATE expert_intro_sms SET status=?, error_code=?, updated_at=? WHERE customer_id=? AND salesperson_id=? AND claim_token=?",
        unknown ? "uncertain" : "failed", code.slice(0, 80), t, r.customer_id, r.salesperson_id, token);
      logIntro(db, { customerId: r.customer_id, salespersonId: r.salesperson_id, expertName: expert.name || null, status: unknown ? "uncertain" : "failed", reason: failureText(code) }, nowFn());
      if (unknown) out.uncertain++; else out.failed++;
    }
  }
  return out;
}
export function failureText(code: string): string {
  return ({
    sms_delivery_unknown: "نتیجه‌ی ارسال نامشخص (دوباره ارسال نمی‌شود)",
    sms_provider_rejected: "سامانه‌ی پیامک رد کرد",
    sms_relay_not_configured: "رله‌ی پیامک تنظیم نشده",
    sms_disabled: "پیامک IPPanel خاموش است",
  } as Record<string, string>)[code] ?? "ارسال ناموفق";
}

/** Pattern send through the local HMAC relay (same contract as the other IPPanel patterns). Localhost relay only. */
export async function sendPatternViaRelay(args: SendArgs, o: { relayUrl: string; fromNumber: string; secret?: string; fetcher?: typeof fetch }): Promise<string> {
  if (!o.secret) throw new Error("sms_relay_not_configured");
  let relay: URL;
  try {
    relay = new URL(o.relayUrl);
    if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(relay.hostname)) throw new Error();
  } catch { throw new Error("sms_relay_not_configured"); }
  const recipient = mobileKey(args.recipient);
  if (!recipient) throw new Error("invalid_recipient");
  const body = JSON.stringify({ sending_type: "pattern", from_number: o.fromNumber, code: args.patternCode, recipients: [`+98${recipient.slice(1)}`], params: args.params });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", o.secret).update(`${timestamp}.${body}`).digest("hex");
  let response: Response;
  try {
    response = await (o.fetcher ?? fetch)(relay, { method: "POST", body, signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", "X-Relay-Timestamp": timestamp, "X-Relay-Signature": signature } });
  } catch { throw new Error("sms_delivery_unknown"); }
  let result: { ok?: boolean; error?: string; data?: { meta?: { status?: boolean }; data?: { message_outbox_ids?: unknown[] } } };
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") throw new Error();
    result = parsed as typeof result;
  } catch { throw new Error("sms_delivery_unknown"); }
  if (result.data?.meta?.status === false || ["provider_rejected", "invalid_payload", "invalid_signature", "expired_signature"].includes(result.error ?? "")) throw new Error("sms_provider_rejected");
  const id = result.data?.data?.message_outbox_ids?.[0];
  if (!response.ok || result.ok !== true || result.data?.meta?.status !== true || !/^[1-9]\d*$/.test(String(id))) throw new Error("sms_delivery_unknown");
  return String(id);
}

// ------------------------------------------------------------------ admin views
export type ExpertRow = { salespersonId: number; name: string; active: boolean; userId: number | null; username: string | null; phone: string | null; kind: "closer" | "qualifier" | "trainee" | "other" };
export function expertOverview(db: Db, qualifierId: number | null, closerIds: number[]): ExpertRow[] {
  ensureExpertIntroSchema(db);
  const sps = rows<{ id: number; name: string; active: number }>(db, "SELECT id, name, active FROM salespersons ORDER BY id");
  return sps.map((sp) => {
    const u = row<{ id: number; username: string; customer_contact_phone: string | null }>(db,
      "SELECT id, username, customer_contact_phone FROM users WHERE salesperson_id=? AND active=1 ORDER BY (role='salesperson') DESC, id LIMIT 1", sp.id);
    const id = Number(sp.id);
    const kind: ExpertRow["kind"] = id === qualifierId ? "qualifier" : (EXPERT_INTRO_TRAINEE_SALESPERSON_IDS as readonly number[]).includes(id) ? "trainee" : closerIds.includes(id) ? "closer" : "other";
    return { salespersonId: id, name: String(sp.name ?? ""), active: Number(sp.active) === 1, userId: u ? Number(u.id) : null, username: u?.username ?? null,
      phone: u?.customer_contact_phone ? normalizeContactPhone(u.customer_contact_phone) ?? null : null, kind };
  });
}
export function userContactPhones(db: Db): { userId: number; phone: string | null }[] {
  ensureExpertIntroSchema(db);
  return rows<{ id: number; customer_contact_phone: string | null }>(db, "SELECT id, customer_contact_phone FROM users ORDER BY id")
    .map((u) => ({ userId: Number(u.id), phone: u.customer_contact_phone ?? null }));
}
export function setUserContactPhone(db: Db, userId: number, raw: unknown): string | null {
  ensureExpertIntroSchema(db);
  const phone = normalizeContactPhone(raw);
  if (phone === undefined) throw new ExpertIntroError(400, "شماره تماس برای مشتری باید موبایل (۰۹…) یا تلفن ثابت با کد شهر (۱۱ رقم) باشد.");
  const changed = run(db, "UPDATE users SET customer_contact_phone=? WHERE id=?", phone, userId).changes;
  if (!changed) throw new ExpertIntroError(404, "کاربر پیدا نشد.");
  return phone;
}
export function customerIntroLog(db: Db, customerId: number) {
  if (!tableExists(db, "expert_intro_sms_log")) return [];
  return rows<{ id: number; salespersonId: number | null; expertName: string | null; status: string; reason: string | null; createdAt: string }>(db,
    `SELECT id, salesperson_id AS salespersonId, expert_name AS expertName, status, reason, created_at AS createdAt
     FROM expert_intro_sms_log WHERE customer_id=? ORDER BY id DESC LIMIT 50`, customerId);
}
export function introStats(db: Db): Record<string, number> {
  if (!tableExists(db, "expert_intro_sms")) return {};
  return Object.fromEntries(rows<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM expert_intro_sms GROUP BY status").map((r) => [r.status, Number(r.n)]));
}
export function deleteCustomerIntro(db: Db, customerId: number): void {
  if (tableExists(db, "expert_intro_sms")) run(db, "DELETE FROM expert_intro_sms WHERE customer_id=?", customerId);
  if (tableExists(db, "expert_intro_sms_log")) run(db, "DELETE FROM expert_intro_sms_log WHERE customer_id=?", customerId);
}

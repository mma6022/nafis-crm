/**
 * crm-sales-assist: «پیشنهاد دستیار فروش» box of 3 per expert. Rule-based, server-side only (no external service, no LLM;
 * call-note text is read only by local regexes and never returned). Display + logging only: never changes owner,
 * priority, stage, money, team_sales_config or notification_settings; no SMS, no customer message, no notification.
 *
 * Order (consistent with the customers list «اول لیست», lib/site-leads.ts topOfList):
 *   first (Task B3, 2026-10-26, Mohammad's item (c)): every customer with an OVERDUE reminder (no call since it fell due), by points —
 *     ahead of new suggestions, site leads included (a site lead with an overdue reminder sits here too),
 *   tier 3 = active site lead (unanswered website request, repeats included) in the list order,
 *   then (Task B2, 2026-10-26, Mohammad: «اولویت۱‌های قرمز جلوتر بیان») today's RED P1 quota customers (> sales_assist_p1_red_days
 *     without a call), oldest first — ahead of the «از کاظمی» tier (a red P1 that is also «از کاظمی» counts here),
 *   tier 2 = «از کاظمی» hand-off not called yet (overdue included) in the list order,
 *   tier 1 = everyone else: today's P1 quota (not red, oldest first)  >  the rest by points.
 *   The `tier` field itself is unchanged (1/2/3); only the order moved.
 *   «P1 بی‌تماس» reuses the manager definition (lib/assistant-manager.ts): priority 1 and the last real call (realCallSql), else
 *   created_at, older than manager_p1_no_call_days (3). Today's quota = the sales_assist_p1_quota (10) oldest such customers as of
 *   the start of the Tehran day (stable all day); a customer leaves it once called today. Trainees 5/19/20 have no list at all.
 * So a site lead inside its deadline ALWAYS ranks above any reminder, whatever the levels.
 * scoreForSalesperson() is the reusable base the per-expert assistant agents read; they may add explanation only.
 */
import type { DatabaseSync } from "node:sqlite";
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { getTeamSalesConfig } from "./team-sales";
import { topOfList, realCallSql, type TopEntry } from "./site-leads";

/** Base points at level 5 (×1). */
export const SALES_ASSIST_BASE = {
  overdue_reminder_base: 40, overdue_reminder_max: 100, overdue_reminder_cap_hours: 72,
  call_promise: 40, urgent: 35, repeat_request: 30, request_count_each: 5, request_count_max: 20,
  p1: 20, recent_upgrade: 30, recent_upgrade_days: 7, docs_complete: 25,
  grade_A: 15, grade_B: 10, grade_C: 5, grade_D: 0, grade_E: -5,
  new_lead: 30, new_lead_days: 3, days_since_call_each: 2, days_since_call_max: 20,
  attempts_free: 3, attempts_penalty_each: -3, attempts_penalty_min: -15,
  called_recently: -30, called_recently_hours: 2,
} as const;
export type SalesAssistWeights = { -readonly [K in keyof typeof SALES_ASSIST_BASE]: number };
/** Admin form: 8 signals, 0–10 (0 = ignored, 5 = default, 10 = double). Site lead / «از کاظمی» are fixed tiers, not levels. */
export const SALES_ASSIST_SIGNALS = {
  rem: { label: "یادآور گذشته", help: "زمان یادآور رسیده یا گذشته (تا ۳ روز بیشتر می‌شود)", keys: ["overdue_reminder_base", "overdue_reminder_max"] },
  note: { label: "قرار در یادداشت آخر", help: "مثل «فردا زنگ بزنید» یا «مدارک را می‌فرستم»", keys: ["call_promise"] },
  urg: { label: "فوری", help: "علامت «فوری» روی مشتری", keys: ["urgent"] },
  upg: { label: "تازه ارتقا به اولویت ۱", help: "در ۷ روز اخیر P1 شده", keys: ["recent_upgrade"] },
  docs: { label: "مدارک کامل", help: "همه‌ی مدارک لازم طرح، یا ۵ مدرک هویتی", keys: ["docs_complete"] },
  pri: { label: "اولویت ۱", help: "مشتری اولویت ۱", keys: ["p1"] },
  rep: { label: "درخواست چندباره", help: "بیش از یک درخواست ثبت کرده", keys: ["repeat_request", "request_count_each", "request_count_max"] },
  days: { label: "روزهای بی‌تماس", help: "هر روز بی‌تماس بالاتر (تا ۱۰ روز)", keys: ["days_since_call_each", "days_since_call_max"] },
} as const;
export type SignalKey = keyof typeof SALES_ASSIST_SIGNALS;
export type SalesAssistSettings = { levels: Record<SignalKey, number>; snoozeHours: number };
/** «الان نه» durations in hours; 0 = «تا فردا صبح» (the next 09:00 Tehran). Armita/PM 01:17: 1 h, 3 h (default), tomorrow morning. */
export const SNOOZE_OPTIONS = [1, 3, 0];
export const SNOOZE_MORNING_HOUR = 9;
const TEHRAN_OFFSET_MIN = 210; // Iran has no DST since 2022.
export function snoozeUntil(now: Date, hours: number): Date {
  if (hours > 0) return new Date(now.getTime() + hours * 3600_000);
  const t = new Date(now.getTime() + TEHRAN_OFFSET_MIN * 60_000); // Tehran wall clock in UTC fields
  const m = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), SNOOZE_MORNING_HOUR) - TEHRAN_OFFSET_MIN * 60_000;
  return new Date(m > now.getTime() ? m : m + 86_400_000);
}
export const snoozeLabel = (hours: number) => (hours > 0 ? `${hours.toLocaleString("fa-IR")} ساعت` : "فردا صبح");
export const SALES_ASSIST_DEFAULTS: SalesAssistSettings = {
  levels: Object.fromEntries(Object.keys(SALES_ASSIST_SIGNALS).map((k) => [k, 5])) as Record<SignalKey, number>, snoozeHours: 3,
};
export const SALES_ASSIST_EXCLUDED_SALESPERSONS = [5, 19, 20];
export const SALES_ASSIST_EXCLUDED_USERS = [29];
export const NOT_NOW_REASONS = {
  busy: "مشغول تماس دیگه‌ام",
  customer_later: "مشتری خواسته بعداً تماس بگیرم",
  bad_time: "الان ساعت مناسب نیست",
  other: "سایر",
} as const;
export type NotNowReason = keyof typeof NOT_NOW_REASONS;

/* ---------------- schema (no schema_version bump on restart) ---------------- */
const SETTINGS_SQL = `CREATE TABLE IF NOT EXISTS sales_assist_settings(
  id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER)`;
const EVENTS_SQL = `CREATE TABLE IF NOT EXISTS sales_assist_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('impression','call','not_now','restore')),
  user_id INTEGER NOT NULL, salesperson_id INTEGER, customer_id INTEGER NOT NULL,
  rank INTEGER, tier INTEGER, score REAL, reason_key TEXT, reason_text TEXT, snooze_until TEXT,
  created_at TEXT NOT NULL)`;
const INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_sales_assist_events_sp ON sales_assist_events(salesperson_id, kind, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_sales_assist_events_user ON sales_assist_events(user_id, customer_id, kind, created_at)",
];
const tableExists = (db: DatabaseSync, n: string) => !!db.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(n);
let ready = false;
export function ensureSalesAssistSchema(db: DatabaseSync = crmDb): { created: string[] } {
  if (ready && db === crmDb) return { created: [] };
  const created: string[] = [];
  const want: [string, string][] = [["sales_assist_settings", SETTINGS_SQL], ["sales_assist_events", EVENTS_SQL]];
  if (want.some(([n]) => !tableExists(db, n))) {
    db.exec("BEGIN IMMEDIATE");
    try { for (const [n, sql] of want) if (!tableExists(db, n)) { db.exec(sql); created.push(n); } db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  for (const sql of INDEX_SQL) db.exec(sql); // IF NOT EXISTS on an existing index does not bump schema_version
  if (db === crmDb) ready = true;
  return { created };
}

/* ---------------- settings ---------------- */
export function getSalesAssistSettings(): SalesAssistSettings {
  ensureSalesAssistSchema();
  const s: SalesAssistSettings = { levels: { ...SALES_ASSIST_DEFAULTS.levels }, snoozeHours: SALES_ASSIST_DEFAULTS.snoozeHours };
  const row = queryRow<{ settings_json: string }>("SELECT settings_json FROM sales_assist_settings WHERE id=1");
  if (row) {
    try {
      const v = JSON.parse(row.settings_json);
      for (const k of Object.keys(s.levels) as SignalKey[]) if (Number.isInteger(v?.levels?.[k]) && v.levels[k] >= 0 && v.levels[k] <= 10) s.levels[k] = v.levels[k];
      if (SNOOZE_OPTIONS.includes(v?.snoozeHours)) s.snoozeHours = v.snoozeHours;
    } catch { /* defaults */ }
  }
  return s;
}
export function weightsFrom(s: SalesAssistSettings): SalesAssistWeights {
  const w: SalesAssistWeights = { ...SALES_ASSIST_BASE };
  for (const [k, sig] of Object.entries(SALES_ASSIST_SIGNALS) as [SignalKey, (typeof SALES_ASSIST_SIGNALS)[SignalKey]][]) {
    const f = s.levels[k] / 5;
    for (const key of sig.keys) w[key as keyof SalesAssistWeights] = Math.round(SALES_ASSIST_BASE[key as keyof SalesAssistWeights] * f * 10) / 10;
  }
  return w;
}
export function getSalesAssistWeights(): SalesAssistWeights { return weightsFrom(getSalesAssistSettings()); }
export function validateSettings(input: unknown): { ok: true; settings: SalesAssistSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "تنظیمات نامعتبر است." };
  const b = input as { levels?: Record<string, unknown>; snoozeHours?: unknown };
  const s = getSalesAssistSettings();
  if (b.levels != null) {
    if (typeof b.levels !== "object" || Array.isArray(b.levels)) return { ok: false, error: "وزن‌ها نامعتبر است." };
    for (const [k, v] of Object.entries(b.levels)) {
      if (!(k in SALES_ASSIST_SIGNALS)) return { ok: false, error: `نشانه‌ی ناشناخته: ${k}` };
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10) return { ok: false, error: "هر وزن باید عدد صحیح ۰ تا ۱۰ باشد." };
      s.levels[k as SignalKey] = v as number;
    }
  }
  if (b.snoozeHours != null) {
    if (!SNOOZE_OPTIONS.includes(b.snoozeHours as number)) return { ok: false, error: "مدت پنهان ماندن نامعتبر است." };
    s.snoozeHours = b.snoozeHours as number;
  }
  return { ok: true, settings: s };
}
export function saveSalesAssistSettings(s: SalesAssistSettings, userId: number): void {
  ensureSalesAssistSchema();
  execute(`INSERT INTO sales_assist_settings(id,settings_json,updated_at,updated_by_user_id) VALUES(1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id`,
    [JSON.stringify(s), new Date().toISOString(), userId]);
}
export function salesAssistSettingsMeta(): { updatedAt: string | null } {
  ensureSalesAssistSchema();
  return { updatedAt: queryRow<{ updated_at: string }>("SELECT updated_at FROM sales_assist_settings WHERE id=1")?.updated_at ?? null };
}

/* ---------------- Task B: P1 quota settings (assistant_settings, INSERT OR IGNORE seed in lib/assistants.ts) ---------------- */
export const P1_SETTING_KEYS = { quota: "sales_assist_p1_quota", redDays: "sales_assist_p1_red_days" } as const;
export const P1_DEFAULTS = { quota: 10, redDays: 7 } as const;
export const P1_LIMITS = { quota: [0, 50], redDays: [1, 60] } as const;
export type P1Settings = { quota: number; redDays: number; noCallDays: number };
const settingValue = (key: string): string | undefined =>
  has("assistant_settings") ? queryRow<{ value: string }>("SELECT value FROM assistant_settings WHERE key=?", [key])?.value : undefined;
/** noCallDays = manager_p1_no_call_days (same limits/default as readManagerSettings) — the one «P1 بی‌تماس» definition. */
export function getP1Settings(): P1Settings {
  const n = (key: string, [lo, hi]: readonly [number, number], d: number) => { const v = Number(settingValue(key)); return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
  return { quota: n(P1_SETTING_KEYS.quota, P1_LIMITS.quota, P1_DEFAULTS.quota), redDays: n(P1_SETTING_KEYS.redDays, P1_LIMITS.redDays, P1_DEFAULTS.redDays),
    noCallDays: n("manager_p1_no_call_days", [1, 60], 3) };
}
export function validateP1Settings(b: unknown): { ok: true; values: [string, string][] } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "تنظیمات اولویت ۱ نامعتبر است." };
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (!(k in P1_SETTING_KEYS)) return { ok: false, error: `فیلد ناشناخته: ${k}` };
    const [lo, hi] = P1_LIMITS[k as keyof typeof P1_LIMITS];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) return { ok: false, error: k === "quota" ? "سهمیه‌ی روزانه باید عدد صحیح ۰ تا ۵۰ باشد." : "آستانه‌ی قرمز باید عدد صحیح ۱ تا ۶۰ روز باشد." };
    out.push([P1_SETTING_KEYS[k as keyof typeof P1_SETTING_KEYS], String(v)]);
  }
  return { ok: true, values: out };
}
/** Admin save: only the two new keys (upsert on assistant_settings; nothing else is written). */
export function saveP1Settings(values: [string, string][], userId: number): void {
  const at = new Date().toISOString();
  for (const [k, v] of values) execute("INSERT INTO assistant_settings(key,value,updated_at,updated_by_user_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id", [k, v, at, userId]);
}
/** Start of the Tehran day (UTC ms). */
export function tehranDayStart(now: Date): number {
  const w = new Date(now.getTime() + TEHRAN_OFFSET_MIN * 60_000); w.setUTCHours(0, 0, 0, 0);
  return w.getTime() - TEHRAN_OFFSET_MIN * 60_000;
}

/* ---------------- scope ---------------- */
export type ScopeMode = "own_all" | "own_p1";
/** Kazemi (qualifier): all own customers; closers (Hasani/Ghasemi): own P1 only; trainees / anyone else: nothing. */
export function salesAssistScope(salespersonId: number | null | undefined): ScopeMode | null {
  const sp = Number(salespersonId);
  if (!Number.isInteger(sp) || sp <= 0 || SALES_ASSIST_EXCLUDED_SALESPERSONS.includes(sp)) return null;
  const cfg = getTeamSalesConfig();
  if (sp === Number(cfg.qualifierSalespersonId)) return "own_all";
  if ((cfg.closerSalespersonIds ?? []).map(Number).includes(sp)) return "own_p1";
  return null;
}
export function eligibleUser(u: { id: number; salespersonId: number | null }): boolean {
  return !SALES_ASSIST_EXCLUDED_USERS.includes(Number(u.id)) && salesAssistScope(u.salespersonId) != null;
}

/* ---------------- scoring ---------------- */
const norm = (s: string | null | undefined) => (s ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ");
const PROMISE_RE = [/پس ?فردا/, /فردا/, /بعد از حقوق/, /سر ?ماه/, /اول ماه/, /مدارک.{0,15}(می ?فرست|ارسال می ?کن|میاره|می ?آره)/,
  /(شنبه|یکشنبه|دوشنبه|سه ?شنبه|چهارشنبه|پنجشنبه|پنج شنبه|جمعه)/, /ساعت ?[0-9۰-۹]{1,2}/, /هفته (بعد|آینده|دیگه)/,
  /(تماس|زنگ) (بگیرم|میگیره|می گیره|بزنم|میزنه|می زنه)/, /خبر (میده|می ده|بده)/, /بعد از ظهر|عصر|صبح/];
const IDENTITY = ["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"];
const FA_DIG = "۰۱۲۳۴۵۶۷۸۹";
export const faNum = (n: number) => String(n).replace(/\d/g, (d) => FA_DIG[Number(d)]);
const ago = (h: number) => (h >= 24 ? `${faNum(Math.floor(h / 24))} روز` : h >= 1 ? `${faNum(Math.floor(h))} ساعت` : `${faNum(Math.max(1, Math.floor(h * 60)))} دقیقه`);
const tms = (s: string | null | undefined) => (s ? Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : NaN);

export type ReasonKind = "site_lead" | "from_kazemi" | "p1_stale" | "reminder" | "note" | "urgent" | "repeat" | "upgrade" | "docs" | "grade" | "new_lead" | "no_call" | "next";
export type Chip = { key: "site_lead" | "urgent" | "from_kazemi" | "repeat" | "p1_stale"; label: string; tone?: "red" };
export type ScoredCustomer = {
  /** displayName = the short (first-name-only / «مشتری #id») label handed to the assistants; keep it masked.
   *  fullName = what the logged-in expert sees in the box: customers.name → first+last → official first+last → phone → «بدون نام». UI only. */
  customerId: number; displayName: string; fullName: string; priority: number | null; chips: Chip[];
  tier: 1 | 2 | 3; points: number; reason: { kind: ReasonKind; text: string }; signals: string[];
  topOfList: { kind: TopEntry["kind"]; dueAt: string; overdue: boolean; windowNow: boolean } | null;
  callForm: "simple" | "legacy"; lastCallAt: string | null;
  /** Task B: today's P1 quota membership (null = not in the quota). */
  p1Stale: { daysSince: number; red: boolean; quotaRank: number } | null;
};
export type Suggestion = ScoredCustomer & { rank: number };
type CRow = { id: number; name: string | null; first_name: string | null; last_name: string | null; official_first_name: string | null; official_last_name: string | null; phone: string | null; priority: number | null; is_urgent: number | null;
  credit_rank: string | null; created_at: string; status: string | null };

function byIds<R>(sqlFn: (ph: string) => string, ids: number[]): R[] {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += 400) { const ch = ids.slice(i, i + 400); out.push(...queryRows<R>(sqlFn(ch.map(() => "?").join(",")), ch)); }
  return out;
}
const has = (t: string) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k) ?? []; l.push(v); m.set(k, l); };

const clean = (v: string | null | undefined) => String(v ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();
/** Every scorable customer of one salesperson, best first (snoozes not applied). Pure read. */
export function scoreForSalesperson(salespersonId: number, now = new Date(), w: SalesAssistWeights = getSalesAssistWeights()): ScoredCustomer[] {
  const mode = salesAssistScope(salespersonId);
  if (!mode) return [];
  const cfg = getTeamSalesConfig();
  const qualifier = Number(cfg.qualifierSalespersonId);
  const nowMs = now.getTime();
  const rows = queryRows<CRow>(`SELECT id, name, first_name, last_name, official_first_name, official_last_name, phone, priority, is_urgent, credit_rank, created_at, status FROM customers c
    WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND COALESCE(status,'') NOT IN ('cancelled','completed')
      ${mode === "own_p1" ? "AND priority=1" : ""}
      AND NOT EXISTS (SELECT 1 FROM loan_applications la WHERE la.customer_id=c.id AND la.deleted_at IS NULL AND la.stage='completed')
      ${has("customer_payment_orders") ? "AND NOT EXISTS (SELECT 1 FROM customer_payment_orders po WHERE po.customer_id=c.id AND po.paid_at IS NOT NULL)" : ""}`, [salespersonId]);
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const idSet = new Set(ids);
  const topPos = new Map<number, { e: TopEntry; i: number }>();
  topOfList(now, cfg).forEach((e, i) => { if (idSet.has(e.customerId) && !topPos.has(e.customerId)) topPos.set(e.customerId, { e, i }); });

  const tagKeys = new Map<number, string[]>();
  for (const r of byIds<{ customer_id: number; tag: string }>((p) => `SELECT customer_id, tag FROM customer_tags WHERE customer_id IN (${p})`, ids)) push(tagKeys, Number(r.customer_id), r.tag);
  const calls = new Map<number, { n: number; last: string | null; txt: string }>();
  for (const r of byIds<{ customer_id: number; n: number; last: string | null; txt: string | null }>((p) => `SELECT customer_id, COUNT(*) n, MAX(created_at) last,
      (SELECT COALESCE(l2.expert_notes,'')||' '||COALESCE(l2.customer_request,'') FROM call_logs l2 WHERE l2.customer_id=l.customer_id AND ${realCallSql("l2.subject")}
        ORDER BY l2.created_at DESC, l2.id DESC LIMIT 1) txt
      FROM call_logs l WHERE customer_id IN (${p}) AND ${realCallSql("subject")} GROUP BY customer_id`, ids))
    calls.set(Number(r.customer_id), { n: Number(r.n), last: r.last, txt: r.txt ?? "" });
  // Task B: last real call BEFORE today's Tehran start → today's P1 quota (stable all day).
  const p1s = getP1Settings(); const dayStart = tehranDayStart(now); const DAY = 86400_000;
  const p1Ids = rows.filter((r) => r.priority === 1).map((r) => Number(r.id));
  const before = new Map<number, string>();
  if (p1Ids.length) for (const r of byIds<{ customer_id: number; last: string | null }>((p) => `SELECT customer_id, MAX(created_at) last FROM call_logs
      WHERE customer_id IN (${p}) AND ${realCallSql("subject")} AND julianday(created_at) < julianday(?) GROUP BY customer_id`.replace("julianday(?)", `julianday('${new Date(dayStart).toISOString()}')`), p1Ids))
    if (r.last) before.set(Number(r.customer_id), r.last);
  const pms = (v: string | null | undefined) => (v ? tms(String(v).replace(" ", "T")) : NaN);
  const quota = new Map<number, number>();
  if (p1s.quota > 0) rows.filter((r) => r.priority === 1)
    .map((r) => { const ref = before.has(Number(r.id)) ? pms(before.get(Number(r.id))) : pms(r.created_at); return { id: Number(r.id), ms: dayStart - ref }; })
    .filter((x) => Number.isFinite(x.ms) && x.ms > p1s.noCallDays * DAY).sort((a, b) => b.ms - a.ms || a.id - b.id).slice(0, p1s.quota)
    .forEach((x, i) => quota.set(x.id, i + 1));
  const rems = new Map<number, string[]>();
  for (const r of byIds<{ customer_id: number; remind_at: string }>((p) => `SELECT customer_id, remind_at FROM reminders WHERE done=0 AND customer_id IN (${p})`, ids)) push(rems, Number(r.customer_id), r.remind_at);
  const reqCount = new Map<number, number>();
  const openRepeat = new Set<number>();
  if (has("site_lead_requests")) {
    for (const r of byIds<{ customer_id: number; n: number }>((p) => `SELECT customer_id, COUNT(*) n FROM site_lead_requests WHERE customer_id IN (${p}) GROUP BY 1`, ids)) reqCount.set(Number(r.customer_id), Number(r.n));
    for (const r of byIds<{ customer_id: number }>((p) => `SELECT DISTINCT customer_id FROM site_lead_requests WHERE answered_at IS NULL AND is_repeat=1 AND customer_id IN (${p})`, ids)) openRepeat.add(Number(r.customer_id));
  }
  if (has("customer_repeat_requests")) for (const r of byIds<{ customer_id: number; n: number }>((p) => `SELECT customer_id, COUNT(*) n FROM customer_repeat_requests WHERE customer_id IN (${p}) GROUP BY 1`, ids))
    reqCount.set(Number(r.customer_id), (reqCount.get(Number(r.customer_id)) ?? 0) + Number(r.n));
  const upg = new Map<number, string>();
  if (has("customer_priority_history")) for (const r of byIds<{ customer_id: number; at: string }>((p) => `SELECT customer_id, MAX(created_at) at FROM customer_priority_history
      WHERE new_priority=1 AND COALESCE(old_priority,0)<>1 AND customer_id IN (${p}) GROUP BY 1`, ids)) upg.set(Number(r.customer_id), r.at);
  const cf = new Map<number, string>();
  if (has("consultation_forms")) for (const r of byIds<{ customer_id: number; credit_rank: string }>((p) => `SELECT customer_id, credit_rank FROM consultation_forms
      WHERE credit_rank IS NOT NULL AND customer_id IN (${p}) ORDER BY updated_at`, ids)) cf.set(Number(r.customer_id), r.credit_rank);
  // «مدارک کامل» = every document the open case's plan requires; no open case / no plan list -> the 5 identity documents.
  const ident = new Map<number, string[]>();
  for (const r of byIds<{ customer_id: number; document_type: string }>((p) => `SELECT customer_id, document_type FROM customer_identity_documents
      WHERE is_latest=1 AND storage_path IS NOT NULL AND customer_id IN (${p})`, ids)) push(ident, Number(r.customer_id), r.document_type);
  const plans = new Map<number, string[]>();
  for (const r of queryRows<{ id: number; required_documents: string | null }>("SELECT id, required_documents FROM loan_plans")) {
    try { const v = JSON.parse(r.required_documents || "[]"); plans.set(Number(r.id), Array.isArray(v) ? v.map(String) : []); } catch { plans.set(Number(r.id), []); }
  }
  const app = new Map<number, { id: number; plan: number | null }>();
  for (const r of byIds<{ id: number; customer_id: number; plan_id: number | null }>((p) => `SELECT id, customer_id, plan_id FROM loan_applications
      WHERE deleted_at IS NULL AND COALESCE(stage,'')<>'completed' AND customer_id IN (${p}) ORDER BY id`, ids)) app.set(Number(r.customer_id), { id: Number(r.id), plan: r.plan_id == null ? null : Number(r.plan_id) });
  const appIds = [...app.values()].map((a) => a.id);
  const appDocs = new Map<number, string[]>();
  const coll = new Set<number>();
  if (appIds.length) {
    for (const r of byIds<{ application_id: number; requirement_key: string }>((p) => `SELECT application_id, requirement_key FROM loan_application_documents
        WHERE storage_path IS NOT NULL AND status IN ('uploaded','approved','pending') AND application_id IN (${p})`, appIds)) push(appDocs, Number(r.application_id), r.requirement_key);
    if (has("loan_application_collateral")) for (const r of byIds<{ application_id: number }>((p) => `SELECT DISTINCT application_id FROM loan_application_collateral WHERE storage_path IS NOT NULL AND application_id IN (${p})`, appIds)) coll.add(Number(r.application_id));
  }
  const docsState = (cid: number): { complete: boolean; basis: "plan" | "identity" } => {
    const have = new Set(ident.get(cid) ?? []); const a = app.get(cid);
    const req = a && a.plan != null ? plans.get(a.plan) ?? [] : [];
    if (!a || !req.length) return { complete: IDENTITY.every((d) => have.has(d)), basis: "identity" };
    const docs = new Set(appDocs.get(a.id) ?? []);
    const ok = req.every((k) => k === "national_card" ? have.has("national_card_front") && have.has("national_card_back")
      : k === "birth_certificate_all_pages" ? ["birth_cert_p1", "birth_cert_p2", "birth_cert_p3"].every((d) => have.has(d))
      : IDENTITY.includes(k) ? have.has(k)
      : k === "guarantee_check" || k === "guarantee_promissory" ? coll.has(a.id)
      : docs.has(k));
    return { complete: ok, basis: "plan" };
  };

  const out = rows.map((r) => {
    const cid = Number(r.id); let pts = 0; const why: [number, ReasonKind, string][] = []; const sig: string[] = []; const chips: Chip[] = [];
    const cl = calls.get(cid); const lastMs = tms(cl?.last);
    const t = topPos.get(cid);
    const tier: 1 | 2 | 3 = t ? (t.e.kind === "site_lead" ? 3 : 2) : 1;
    const tg = new Set(tagKeys.get(cid) ?? []);
    const noCallDays = Number.isFinite(lastMs) ? Math.floor((nowMs - lastMs) / 86400_000) : null;
    if (t) {
      const overdue = Date.parse(t.e.dueAt) <= nowMs;
      const since = ago((nowMs - Date.parse(t.e.startedAt)) / 3600_000);
      if (t.e.kind === "site_lead") {
        chips.push({ key: "site_lead", label: "سرنخ سایت" }); sig.push("سرنخ سایت باز");
        why.push([1e6, "site_lead", noCallDays != null && noCallDays >= 1 && !overdue ? `سرنخ سایت؛ ${faNum(noCallDays)} روز است تماسی نگرفته`
          : overdue ? `سرنخ سایت؛ ${since} پیش فرم را پر کرده و مهلت ۳ ساعته گذشته` : `سرنخ تازه‌ی سایت؛ ${since} پیش فرم را پر کرده`]);
      } else {
        chips.push({ key: "from_kazemi", label: "از کاظمی" }); sig.push("از کاظمی");
        why.push([1e6, "from_kazemi", overdue ? `${since} پیش از کاظمی رسیده و مهلت تماس اولش گذشته` : `${since} پیش از کاظمی رسیده و هنوز تماس اول نگرفته`]);
      }
      if (t.e.windowNow) sig.push("الان بازه‌ی دلخواهش است");
    }
    if (Number(r.is_urgent) === 1) { pts += w.urgent; why.push([w.urgent, "urgent", "فوری علامت خورده"]); chips.push({ key: "urgent", label: "فوری" }); sig.push("فوری"); }
    const n = reqCount.get(cid) ?? 0;
    if (tg.has("repeat_request") || openRepeat.has(cid)) {
      pts += w.repeat_request; why.push([w.repeat_request, "repeat", n > 1 ? `${faNum(n)} بار درخواست داده` : "چند بار درخواست داده"]);
      chips.push({ key: "repeat", label: n > 1 ? `چندباره ${faNum(n)}` : "چندباره" }); sig.push("چندباره");
    }
    if (n > 1) pts += Math.min(w.request_count_max, w.request_count_each * (n - 1));
    const od = (rems.get(cid) ?? []).map(tms).filter((x) => Number.isFinite(x) && x <= nowMs && (!Number.isFinite(lastMs) || lastMs < x));
    if (od.length) {
      const first = Math.min(...od); const hrs = (nowMs - first) / 3600_000; const cap = Math.max(1, w.overdue_reminder_cap_hours);
      const v = Math.round(w.overdue_reminder_base + (w.overdue_reminder_max - w.overdue_reminder_base) * Math.min(hrs, cap) / cap);
      const at = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(first));
      pts += v; why.push([v, "reminder", hrs < 24 ? `یادآور ساعت ${at} گذشته` : `یادآورش ${ago(hrs)} پیش گذشته و هنوز تماسی بعدش نیست`]); sig.push("یادآور گذشته");
    }
    if (cl && PROMISE_RE.some((re) => re.test(norm(cl.txt)))) { pts += w.call_promise; why.push([w.call_promise, "note", "در یادداشت آخر قرار تماس یا ارسال مدارک گذاشته شده"]); sig.push("قرار در یادداشت"); }
    if (r.priority === 1) { pts += w.p1; sig.push("P1"); }
    const u = tms(upg.get(cid));
    if (r.priority === 1 && Number.isFinite(u) && nowMs - u <= w.recent_upgrade_days * 86400_000) {
      const d = Math.floor((nowMs - u) / 86400_000);
      pts += w.recent_upgrade; why.push([w.recent_upgrade, "upgrade", d ? `${faNum(d)} روز پیش به اولویت ۱ رسیده` : "امروز به اولویت ۱ رسیده"]); sig.push("تازه‌ارتقا");
    }
    const ds = docsState(cid);
    if (ds.complete) { pts += w.docs_complete; why.push([w.docs_complete, "docs", ds.basis === "plan" ? "همه‌ی مدارک لازم طرحش کامل است" : "مدارک هویتی‌اش کامل است"]); sig.push("مدارک کامل"); }
    const g = r.credit_rank || cf.get(cid);
    if (g) { const v = Number((w as Record<string, number>)[`grade_${g[0]}`] ?? 0); pts += v; if (v >= 10) why.push([v, "grade", `رتبه‌ی اعتباری خوب (${g}) دارد`]); sig.push(`رتبه ${g}`); }
    if (!cl) {
      if (salespersonId === qualifier && nowMs - tms(r.created_at) <= w.new_lead_days * 86400_000) { pts += w.new_lead; why.push([w.new_lead, "new_lead", "لید تازه است و هنوز هیچ تماسی نگرفته"]); sig.push("لید تازه"); }
    } else {
      const hours = (nowMs - lastMs) / 3600_000;
      if (hours < w.called_recently_hours) { pts += w.called_recently; sig.push("تماس اخیر"); }
      else { const v = Math.min(w.days_since_call_max, Math.floor(hours / 24) * w.days_since_call_each); pts += v; if (v >= 10) why.push([v, "no_call", `${faNum(Math.floor(hours / 24))} روز است تماسی نگرفته`]); }
      if (cl.n > w.attempts_free) { pts += Math.max(w.attempts_penalty_min, w.attempts_penalty_each * (cl.n - w.attempts_free)); sig.push(`${faNum(cl.n)} تماس`); }
    }
    // Task B: today's P1 quota (left once called today). Days use the same reference as the manager report: now − last call (else created).
    let p1Stale: ScoredCustomer["p1Stale"] = null; let band = od.length ? 3 : 0; let staleMs = 0;
    const qr = quota.get(cid);
    if (qr && !(Number.isFinite(lastMs) && lastMs >= dayStart)) {
      const ref = Number.isFinite(lastMs) ? lastMs : pms(r.created_at); staleMs = nowMs - ref;
      const daysSince = Math.floor(staleMs / DAY); const red = staleMs > p1s.redDays * DAY;
      p1Stale = { daysSince, red, quotaRank: qr };
      if (!band) band = red ? 2 : 1;
      chips.unshift({ key: "p1_stale", label: `${faNum(daysSince)} روز بی‌تماس`, ...(red ? { tone: "red" as const } : {}) }); sig.push(red ? "P1 قرمز" : "سهمیه‌ی P1");
      if (!t && !od.length) why.unshift([1e5, "p1_stale", `اولویت ۱؛ ${faNum(daysSince)} روز است تماسی نگرفته${red ? " — بیش از " + faNum(p1s.redDays) + " روز" : ""} (سهمیه‌ی امروز)`]);
    }
    why.sort((a, b) => b[0] - a[0]);
    const fn = clean(r.first_name || r.official_first_name);
    const full = clean(r.name) || clean(`${r.first_name ?? ""} ${r.last_name ?? ""}`) || clean(`${r.official_first_name ?? ""} ${r.official_last_name ?? ""}`) || clean(r.phone) || "بدون نام";
    return {
      customerId: cid, displayName: fn || `مشتری #${faNum(cid)}`, fullName: full, priority: r.priority == null ? null : Number(r.priority), chips: chips.slice(0, 3),
      tier, points: Math.round(pts * 10) / 10,
      reason: why.length ? { kind: why[0][1], text: why[0][2] } : { kind: "next" as ReasonKind, text: "در نوبت بعدی لیست شماست" }, signals: sig,
      topOfList: t ? { kind: t.e.kind, dueAt: t.e.dueAt, overdue: Date.parse(t.e.dueAt) <= nowMs, windowNow: t.e.windowNow } : null,
      // Same rule as the customers page (usesSimpleForm): the qualifier's own in-progress customers with NO priority -> simple 3-step form; P1/P2/P3 -> legacy.
      callForm: (cfg.enabled && salespersonId === qualifier && r.priority == null && (r.status ?? "in_progress") === "in_progress" ? "simple" : "legacy") as "simple" | "legacy",
      lastCallAt: cl?.last ?? null, p1Stale,
      pos: t ? t.i : Number.MAX_SAFE_INTEGER, lastMs: Number.isFinite(lastMs) ? lastMs : 0, band, staleMs,
    };
  });
  // Ties: the older last call first (design), then id.
  // Groups (Task B3): overdue reminder (5) > site lead (4) > red P1 quota, oldest first (3) > «از کاظمی» (2) > tier 1 (1).
  // Tier 1 bands (Task B): quota (oldest first) > rest by points.
  const grp = (x: { tier: number; band: number; p1Stale: ScoredCustomer["p1Stale"] }) => x.band === 3 ? 5 : x.tier === 3 ? 4 : x.p1Stale?.red ? 3 : x.tier === 2 ? 2 : 1;
  out.sort((a, b) => { const ga = grp(a), gb = grp(b);
    return gb - ga || (ga === 4 || ga === 2 ? a.pos - b.pos : 0) || (ga === 3 ? b.staleMs - a.staleMs : 0) || (ga === 1 ? b.band - a.band : 0)
      || (ga === 1 && (a.band === 1 || a.band === 2) ? b.staleMs - a.staleMs : 0) || b.points - a.points || a.lastMs - b.lastMs || a.customerId - b.customerId; });
  return out.map(({ pos: _p, lastMs: _l, band: _b, staleMs: _s, ...x }) => x);
}

/* ---------------- box of 3 + events ---------------- */
/** Active «الان نه»: the latest not_now with snooze_until > now, unless a later «restore» exists. */
export function activeSnoozes(salespersonId: number, now = new Date()): Map<number, { until: string; reason: string }> {
  ensureSalesAssistSchema();
  const m = new Map<number, { until: string; reason: string }>();
  for (const r of queryRows<{ customer_id: number; until: string; reason_key: string; created_at: string }>(`SELECT e.customer_id, e.snooze_until until, e.reason_key, e.created_at
      FROM sales_assist_events e WHERE e.salesperson_id=? AND e.kind='not_now' AND e.snooze_until>?
        AND NOT EXISTS (SELECT 1 FROM sales_assist_events r WHERE r.salesperson_id=e.salesperson_id AND r.customer_id=e.customer_id AND r.kind='restore' AND r.created_at>=e.created_at)
      ORDER BY e.created_at`, [salespersonId, now.toISOString()]))
    m.set(Number(r.customer_id), { until: r.until, reason: NOT_NOW_REASONS[r.reason_key as NotNowReason] ?? r.reason_key });
  return m;
}
export function todayCounts(salespersonId: number, now = new Date()): { calls: number; notNow: number } {
  ensureSalesAssistSchema();
  const w = new Date(now.getTime() + 3.5 * 3600_000); w.setUTCHours(0, 0, 0, 0);
  const start = new Date(w.getTime() - 3.5 * 3600_000).toISOString();
  const r = queryRow<{ calls: number; nn: number }>(`SELECT SUM(kind='call') calls, SUM(kind='not_now') nn FROM sales_assist_events WHERE salesperson_id=? AND created_at>=?`, [salespersonId, start]);
  return { calls: Number(r?.calls ?? 0), notNow: Number(r?.nn ?? 0) };
}
/** Up to 3 (exactly 3 whenever 3 un-snoozed customers exist). Snoozed customers are never shown inside their 3 hours. */
export function suggestionsFor(salespersonId: number, now = new Date(), size = 3): { items: Suggestion[]; pool: number; snoozed: { customerId: number; displayName: string; fullName: string; until: string; reason: string }[]; p1Quota: ReturnType<typeof p1QuotaSummary> } {
  const all = scoreForSalesperson(salespersonId, now);
  const sn = activeSnoozes(salespersonId, now);
  // A logged call (any outcome) takes the customer out of the box for called_recently_hours (2 h); the list keeps its own rules.
  const recentMs = getSalesAssistWeights().called_recently_hours * 3600_000;
  const items = all.filter((x) => !sn.has(x.customerId) && !(x.lastCallAt && now.getTime() - tms(x.lastCallAt) < recentMs)).slice(0, size).map((x, i) => ({ ...x, rank: i + 1 }));
  const names = new Map(all.map((x) => [x.customerId, x]));
  const snoozed = [...sn].filter(([id]) => names.has(id)).map(([customerId, s]) => ({ customerId, displayName: names.get(customerId)!.displayName, fullName: names.get(customerId)!.fullName, until: s.until, reason: s.reason }));
  return { items, pool: all.length, snoozed, p1Quota: p1QuotaSummary(all) };
}
/** Task B summary for the box header: today's P1 quota of one expert. */
export function p1QuotaSummary(all: ScoredCustomer[]): { quota: number; redDays: number; noCallDays: number; remaining: number; red: number } {
  const p = getP1Settings(); const q = all.filter((x) => x.p1Stale);
  return { quota: p.quota, redDays: p.redDays, noCallDays: p.noCallDays, remaining: q.length, red: q.filter((x) => x.p1Stale!.red).length };
}
export function customerInScope(salespersonId: number, customerId: number): boolean {
  const mode = salesAssistScope(salespersonId);
  if (!mode) return false;
  return !!queryRow(`SELECT 1 x FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL ${mode === "own_p1" ? "AND priority=1" : ""}`, [customerId, salespersonId]);
}
export function recordEvent(e: { kind: "impression" | "call" | "not_now" | "restore"; userId: number; salespersonId: number; customerId: number; rank?: number | null;
  tier?: number | null; score?: number | null; reasonKey?: string | null; reasonText?: string | null; snoozeUntil?: string | null }, now = new Date()): number {
  ensureSalesAssistSchema();
  return execute(`INSERT INTO sales_assist_events(kind,user_id,salesperson_id,customer_id,rank,tier,score,reason_key,reason_text,snooze_until,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [e.kind, e.userId, e.salespersonId, e.customerId, e.rank ?? null, e.tier ?? null, e.score ?? null,
    e.reasonKey ?? null, e.reasonText ?? null, e.snoozeUntil ?? null, now.toISOString()]);
}
/** One impression row per (user, customer) per 30 minutes so refetches do not flood the log. */
export function recordImpressions(userId: number, salespersonId: number, items: Suggestion[], now = new Date()): number {
  ensureSalesAssistSchema();
  const since = new Date(now.getTime() - 30 * 60_000).toISOString(); let n = 0;
  for (const it of items) {
    if (queryRow("SELECT 1 x FROM sales_assist_events WHERE user_id=? AND customer_id=? AND kind='impression' AND created_at>? LIMIT 1", [userId, it.customerId, since])) continue;
    recordEvent({ kind: "impression", userId, salespersonId, customerId: it.customerId, rank: it.rank, tier: it.tier, score: it.points }, now); n++;
  }
  return n;
}

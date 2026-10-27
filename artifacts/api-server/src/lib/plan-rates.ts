/**
 * Plan rate freshness (PM 2026-10-28, design site-seo-pages v1.2 §0 scene 36).
 *
 * - The ONLY public rate is loan_plans.annual_interest («سود سالانه», no qualifier). This module adds:
 *   loan_plans.rate_updated_at (ISO instant of the last annual_interest change) and loan_plan_rate_history
 *   (plan_id, old_value, new_value, changed_by, changed_by_name, changed_at, source).
 * - One-time stamp (idempotent): every plan without rate_updated_at gets 2026-10-28 00:00 Tehran
 *   (= 2026-10-27T20:30:00.000Z) and one history row with source 'initial_confirmed' (old_value NULL, new_value = current).
 * - Panel edits (PATCH /loan-plans/:id, POST /loan-plans) call recordRateChange inside their transaction: one history
 *   row + new rate_updated_at, and every open alert of that plan is closed.
 * - Settings plan_rate_settings: rate_stale_days (default 30), rate_warn_days (default 5); 1 ≤ warn < stale.
 * - Daily job (09:00 Asia/Tehran, checked every 10 min): per ACTIVE plan, age = Tehran days since rate_updated_at.
 *   days left (stale + 1 − age) ≤ warn → 'soon'; age > stale → 'stale'. One row per (plan_id, kind, rate_updated_at).
 *   Alerts are CRM-internal rows shown to admins on «طرح‌های تسهیلاتی»; nothing is sent to anyone (no SMS/Bale/bell).
 *   Disabled when PLAN_RATE_ALERTS_DISABLED=1 (test kit) — tests never create alerts.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";

export const RATE_TYPE = "سود سالانه";
export const INITIAL_STAMP = "2026-10-27T20:30:00.000Z"; // 2026-10-28 00:00 Asia/Tehran (6 Aban 1405)
export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_WARN_DAYS = 5;

let installed = false;
export function installPlanRates(): void {
  if (installed) return;
  installed = true;
  const cols = crmDb.prepare("PRAGMA table_info(loan_plans)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "rate_updated_at")) crmDb.exec("ALTER TABLE loan_plans ADD COLUMN rate_updated_at TEXT");
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS loan_plan_rate_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by INTEGER,
      changed_by_name TEXT,
      changed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'panel');
    CREATE INDEX IF NOT EXISTS idx_loan_plan_rate_history_plan ON loan_plan_rate_history(plan_id, id DESC);
    CREATE TABLE IF NOT EXISTS plan_rate_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER);
    CREATE TABLE IF NOT EXISTS loan_plan_rate_alerts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('soon','stale')),
      rate_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(plan_id, kind, rate_updated_at));
  `);
  const now = new Date().toISOString();
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    const todo = queryRows<{ id: number; annual_interest: string | null }>(
      "SELECT id, annual_interest FROM loan_plans WHERE rate_updated_at IS NULL ORDER BY id");
    for (const p of todo) {
      execute(
        "INSERT INTO loan_plan_rate_history(plan_id, old_value, new_value, changed_by, changed_by_name, changed_at, source) VALUES(?,?,?,?,?,?,?)",
        [p.id, null, p.annual_interest, null, "تأیید اولیه (PM، ۶ آبان ۱۴۰۵)", INITIAL_STAMP, "initial_confirmed"]);
      executeChanges("UPDATE loan_plans SET rate_updated_at = ? WHERE id = ? AND rate_updated_at IS NULL", [INITIAL_STAMP, p.id]);
    }
    for (const [k, v] of [["rate_stale_days", String(DEFAULT_STALE_DAYS)], ["rate_warn_days", String(DEFAULT_WARN_DAYS)]])
      execute("INSERT INTO plan_rate_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING", [k, v, now]);
    crmDb.exec("COMMIT");
  } catch (err) {
    crmDb.exec("ROLLBACK");
    throw err;
  }
}

const norm = (v: unknown) => (v == null ? null : String(v).trim() || null);
/** Call INSIDE the caller's transaction, after the UPDATE/INSERT of loan_plans. No-op when the rate did not change. */
export function recordRateChange(planId: number, oldValue: unknown, newValue: unknown,
  actor: { id?: number; fullName?: string | null; username?: string } | undefined, source: "panel" | "create" = "panel"): boolean {
  // installPlanRates() already ran at route-module load (never inside a transaction).
  const o = norm(oldValue), n = norm(newValue);
  if (source === "panel" && o === n) return false;
  const at = new Date().toISOString();
  execute(
    "INSERT INTO loan_plan_rate_history(plan_id, old_value, new_value, changed_by, changed_by_name, changed_at, source) VALUES(?,?,?,?,?,?,?)",
    [planId, o, n, actor?.id ?? null, actor?.fullName || actor?.username || null, at, source]);
  executeChanges("UPDATE loan_plans SET rate_updated_at = ? WHERE id = ?", [at, planId]);
  executeChanges("UPDATE loan_plan_rate_alerts SET closed_at = ? WHERE plan_id = ? AND closed_at IS NULL", [at, planId]);
  return true;
}

export type RateSettings = { staleDays: number; warnDays: number };
export function getRateSettings(): RateSettings {
  installPlanRates();
  const rows = queryRows<{ key: string; value: string }>("SELECT key, value FROM plan_rate_settings");
  const m = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  const staleDays = Number.isInteger(m.rate_stale_days) && m.rate_stale_days >= 2 ? m.rate_stale_days : DEFAULT_STALE_DAYS;
  const warnDays = Number.isInteger(m.rate_warn_days) && m.rate_warn_days >= 1 && m.rate_warn_days < staleDays ? m.rate_warn_days : Math.min(DEFAULT_WARN_DAYS, staleDays - 1);
  return { staleDays, warnDays };
}
export function validateRateSettings(input: unknown): RateSettings | string {
  const b = (input ?? {}) as Record<string, unknown>;
  const staleDays = Number(b.staleDays), warnDays = Number(b.warnDays);
  if (!Number.isInteger(staleDays) || staleDays < 2 || staleDays > 365) return "rate_stale_days باید عدد صحیح بین ۲ و ۳۶۵ باشد.";
  if (!Number.isInteger(warnDays) || warnDays < 1 || warnDays >= staleDays) return "rate_warn_days باید عدد صحیح، دست‌کم ۱ و کمتر از rate_stale_days باشد.";
  return { staleDays, warnDays };
}
export function saveRateSettings(s: RateSettings, userId: number | null): void {
  installPlanRates();
  const at = new Date().toISOString();
  for (const [k, v] of [["rate_stale_days", s.staleDays], ["rate_warn_days", s.warnDays]] as const)
    execute("INSERT INTO plan_rate_settings(key, value, updated_at, updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
      [k, String(v), at, userId]);
}

/** Tehran calendar date «YYYY-MM-DD» of an instant. */
export const tehranDate = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNo = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 864e5);
/** Whole Tehran days between the rate change and `now`. */
export const rateAgeDays = (rateUpdatedAt: string, now = new Date()) => dayNo(tehranDate(now)) - dayNo(tehranDate(new Date(rateUpdatedAt)));

export function classifyRate(rateUpdatedAt: string | null, s: RateSettings, now = new Date()): "soon" | "stale" | null {
  if (!rateUpdatedAt || Number.isNaN(Date.parse(rateUpdatedAt))) return null;
  const age = rateAgeDays(rateUpdatedAt, now);
  if (age > s.staleDays) return "stale";
  if (s.staleDays + 1 - age <= s.warnDays) return "soon"; // days left until hidden (updated_at + N + 1) ≤ W — design rateWarn
  return null;
}

/** One pass of the daily job. Returns the number of NEW alert rows. */
export function runRateAlerts(now = new Date()): number {
  installPlanRates();
  const s = getRateSettings();
  const at = now.toISOString();
  let created = 0;
  // a plan whose rate changed since an alert was raised: close it (recordRateChange does this too)
  executeChanges(`UPDATE loan_plan_rate_alerts SET closed_at = ? WHERE closed_at IS NULL AND (
      rate_updated_at <> COALESCE((SELECT rate_updated_at FROM loan_plans p WHERE p.id = loan_plan_rate_alerts.plan_id), '')
      OR NOT EXISTS (SELECT 1 FROM loan_plans p WHERE p.id = loan_plan_rate_alerts.plan_id AND p.active = 1))`, [at]);
  for (const p of queryRows<{ id: number; rate_updated_at: string | null }>("SELECT id, rate_updated_at FROM loan_plans WHERE active = 1 ORDER BY id")) {
    const kind = classifyRate(p.rate_updated_at, s, now);
    if (!kind) continue;
    if (kind === "stale") executeChanges("UPDATE loan_plan_rate_alerts SET closed_at = ? WHERE plan_id = ? AND kind = 'soon' AND closed_at IS NULL", [at, p.id]);
    created += executeChanges("INSERT INTO loan_plan_rate_alerts(plan_id, kind, rate_updated_at, created_at) VALUES(?,?,?,?) ON CONFLICT(plan_id, kind, rate_updated_at) DO NOTHING",
      [p.id, kind, p.rate_updated_at, at]);
  }
  execute("INSERT INTO plan_rate_settings(key, value, updated_at) VALUES('alerts_last_run', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [tehranDate(now), at]);
  return created;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startPlanRateAlerts(log?: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }): void {
  if (process.env.PLAN_RATE_ALERTS_DISABLED === "1" || timer) return;
  const tick = () => {
    try {
      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", hour12: false }).format(now)) % 24;
      if (hour < 9) return;
      const last = queryRow<{ value: string }>("SELECT value FROM plan_rate_settings WHERE key = 'alerts_last_run'")?.value;
      if (last === tehranDate(now)) return;
      const n = runRateAlerts(now);
      log?.info({ created: n }, "plan rate alerts: daily pass");
    } catch (err) {
      log?.error({ err }, "plan rate alerts failed");
    }
  };
  timer = setInterval(tick, 10 * 60_000);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}

export type RateAlert = { id: number; planId: number; planName: string; kind: "soon" | "stale"; rateUpdatedAt: string;
  daysLeft: number | null; hideOn: string; createdAt: string };
export function openRateAlerts(now = new Date()): RateAlert[] {
  installPlanRates();
  const s = getRateSettings();
  return queryRows<{ id: number; plan_id: number; name: string; kind: "soon" | "stale"; rate_updated_at: string; created_at: string }>(
    `SELECT a.id, a.plan_id, p.name, a.kind, a.rate_updated_at, a.created_at FROM loan_plan_rate_alerts a
       JOIN loan_plans p ON p.id = a.plan_id WHERE a.closed_at IS NULL AND p.active = 1 ORDER BY a.kind DESC, a.id DESC`)
    .map((r) => {
      const age = rateAgeDays(r.rate_updated_at, now);
      const hideDay = dayNo(tehranDate(new Date(r.rate_updated_at))) + s.staleDays + 1;
      const hideOn = new Date(hideDay * 864e5).toISOString().slice(0, 10);
      return { id: Number(r.id), planId: Number(r.plan_id), planName: r.name, kind: r.kind, rateUpdatedAt: r.rate_updated_at,
        daysLeft: r.kind === "soon" ? Math.max(0, s.staleDays + 1 - age) : null, hideOn, createdAt: r.created_at };
    });
}

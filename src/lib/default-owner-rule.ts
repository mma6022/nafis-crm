/**
 * crm-default-owner (Mohammad 2026-10-27 22:12, in Ahmad's chat):
 *  «بله، همه‌ی مشتری‌های جدید از هر کاربری بره برای کاظمی»
 *  «بله، همه‌ی سرنخ‌ها فقط بره برای کاظمی و به کارآموزها چیزی نرسه»
 *
 * «قانون ثبت»: every NEW customer, from every registrar and every intake source, is owned by the default owner
 * (salesperson 6, Kazemi). customers.registered_by keeps the REAL registrar (users.id; NULL for system intakes: site
 * form, Instagram automation, customer portal) and customers.registration_source the intake channel.
 *
 * Settings (admin page «قانون ثبت مشتری», table default_owner_rule_settings, key 'config'):
 *   enabled (master switch), ownerSalespersonId, registrarMode all|selected + registrarUserIds, sourceMode all|selected + sources.
 * Code default = OFF; the PM-approved live config is ON / owner 6 / all registrars / all sources.
 * Every change is appended to default_owner_rule_settings_log (old → new JSON, actor).
 *
 * When the rule applies on create: the allocation program is NOT consumed (its cursor does not move), the owner is the
 * default owner, and ONE customer_priority_history row is written (source 'default_owner_rule', old_salesperson_id NULL
 * because the customer never had another owner, new = default owner, actor = registrar, reason «قانون ثبت: …»).
 * It never touches existing customers, contracts, team_sales_config or notification_settings, and never sends anything.
 * If the default owner is missing / inactive the rule does not apply (the old intake path decides) — a lead is never lost.
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";

export const DEFAULT_OWNER_RULE_SOURCE = "default_owner_rule" as const;
export const DEFAULT_OWNER_TRANSFER_SOURCE = "default_owner_transfer" as const;
export const DEFAULT_OWNER_TRANSFER_REASON = "قانون ثبت: همه‌ی مشتری‌های جدید به کاظمی" as const;
export { DEFAULT_OWNER_EXCLUDED_USER_IDS, REGISTRATION_SOURCES, isRegistrationSource, type RegistrationSource } from "./registration-sources";
import { DEFAULT_OWNER_EXCLUDED_USER_IDS, REGISTRATION_SOURCES, isRegistrationSource, type RegistrationSource } from "./registration-sources";

export type DefaultOwnerConfig = {
  enabled: boolean;
  ownerSalespersonId: number;
  registrarMode: "all" | "selected";
  registrarUserIds: number[];
  sourceMode: "all" | "selected";
  sources: RegistrationSource[];
};
export const DEFAULT_OWNER_DEFAULTS: DefaultOwnerConfig = {
  enabled: false, ownerSalespersonId: 6, registrarMode: "all", registrarUserIds: [], sourceMode: "all", sources: [],
};

let ready = false;
export function ensureDefaultOwnerSchema(): void {
  if (ready) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS default_owner_rule_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);
    CREATE TABLE IF NOT EXISTS default_owner_rule_settings_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, old_value TEXT, new_value TEXT NOT NULL, actor_user_id INTEGER, via TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS customer_priority_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, old_priority INTEGER, new_priority INTEGER,
      old_salesperson_id INTEGER, new_salesperson_id INTEGER, actor_user_id INTEGER, source TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_customer_priority_history_customer ON customer_priority_history(customer_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_customers_registered_by ON customers(registered_by, created_at);
  `);
  ready = true;
}

const ints = (v: unknown): number[] => Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b) : [];

export function normalizeConfig(raw: unknown): DefaultOwnerConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const owner = Number(r.ownerSalespersonId);
  return {
    enabled: r.enabled === true,
    ownerSalespersonId: Number.isInteger(owner) && owner > 0 ? owner : DEFAULT_OWNER_DEFAULTS.ownerSalespersonId,
    registrarMode: r.registrarMode === "selected" ? "selected" : "all",
    registrarUserIds: ints(r.registrarUserIds).filter((id) => !DEFAULT_OWNER_EXCLUDED_USER_IDS.includes(id)),
    sourceMode: r.sourceMode === "selected" ? "selected" : "all",
    sources: Array.isArray(r.sources) ? [...new Set(r.sources.filter(isRegistrationSource))].sort() : [],
  };
}

export function getDefaultOwnerConfig(): DefaultOwnerConfig & { updatedAt: string | null; updatedByUserId: number | null } {
  ensureDefaultOwnerSchema();
  const row = queryRow<{ value: string; updated_at: string; updated_by_user_id: number | null }>(
    "SELECT value, updated_at, updated_by_user_id FROM default_owner_rule_settings WHERE key='config'");
  let parsed: unknown = null;
  try { parsed = row ? JSON.parse(row.value) : null; } catch { parsed = null; }
  return { ...(parsed ? normalizeConfig(parsed) : { ...DEFAULT_OWNER_DEFAULTS }), updatedAt: row?.updated_at ?? null, updatedByUserId: row?.updated_by_user_id ?? null };
}

export type ValidateResult = { ok: true; config: DefaultOwnerConfig } | { ok: false; error: string };
export function validateDefaultOwnerConfig(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "تنظیمات نامعتبر است." };
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return { ok: false, error: "کلید اصلی باید روشن یا خاموش باشد." };
  const c = normalizeConfig(r);
  const sp = queryRow<{ id: number; active: number }>("SELECT id, active FROM salespersons WHERE id=?", [Number(r.ownerSalespersonId)]);
  if (!sp) return { ok: false, error: "مالک پیش‌فرض باید یکی از کارشناس‌ها باشد." };
  if (Number(sp.active) !== 1) return { ok: false, error: "مالک پیش‌فرض غیرفعال است." };
  if (c.registrarMode === "selected" && c.registrarUserIds.length === 0) return { ok: false, error: "حداقل یک ثبت‌کننده انتخاب کنید یا «همه» را بزنید." };
  if (c.sourceMode === "selected" && c.sources.length === 0) return { ok: false, error: "حداقل یک منبع انتخاب کنید یا «همه» را بزنید." };
  if (c.registrarUserIds.length) {
    const known = new Set(queryRows<{ id: number }>(`SELECT id FROM users WHERE id IN (${c.registrarUserIds.map(() => "?").join(",")})`, c.registrarUserIds).map((x) => Number(x.id)));
    if (c.registrarUserIds.some((id) => !known.has(id))) return { ok: false, error: "یکی از ثبت‌کننده‌ها پیدا نشد." };
  }
  return { ok: true, config: c };
}

export function saveDefaultOwnerConfig(config: DefaultOwnerConfig, actorUserId: number | null, via = "admin_page"): void {
  ensureDefaultOwnerSchema();
  const old = queryRow<{ value: string }>("SELECT value FROM default_owner_rule_settings WHERE key='config'")?.value ?? null;
  const value = JSON.stringify(normalizeConfig(config));
  const at = new Date().toISOString();
  execute(`INSERT INTO default_owner_rule_settings(key,value,updated_at,updated_by_user_id) VALUES('config',?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id`, [value, at, actorUserId]);
  execute("INSERT INTO default_owner_rule_settings_log(old_value,new_value,actor_user_id,via,created_at) VALUES (?,?,?,?,?)", [old, value, actorUserId, via, at]);
}

export type OwnerDecision = { apply: true; ownerSalespersonId: number } | { apply: false; skip: string };
/** Pure read: does the rule own this new customer? */
export function defaultOwnerDecision(source: RegistrationSource, registrarUserId: number | null | undefined, cfg = getDefaultOwnerConfig()): OwnerDecision {
  if (!cfg.enabled) return { apply: false, skip: "disabled" };
  if (cfg.sourceMode === "selected" && !cfg.sources.includes(source)) return { apply: false, skip: "source_not_selected" };
  if (cfg.registrarMode === "selected" && (registrarUserId == null || !cfg.registrarUserIds.includes(Number(registrarUserId)))) return { apply: false, skip: "registrar_not_selected" };
  const sp = queryRow<{ active: number }>("SELECT active FROM salespersons WHERE id=?", [cfg.ownerSalespersonId]);
  if (!sp || Number(sp.active) !== 1) return { apply: false, skip: "owner_inactive" };
  return { apply: true, ownerSalespersonId: cfg.ownerSalespersonId };
}

/**
 * MUST run in the creator's transaction right after the INSERT (which itself stores registered_by / registration_source,
 * so no extra UPDATE fires the customers bell trigger). Writes the one history row when the rule owned the customer.
 */
export function logRuleAssignment(input: { customerId: number; registrarUserId: number | null | undefined; source: RegistrationSource;
  ownerSalespersonId: number; priority?: number | null; now?: Date }): void {
  ensureDefaultOwnerSchema();
  execute(`INSERT INTO customer_priority_history
    (customer_id, old_priority, new_priority, old_salesperson_id, new_salesperson_id, actor_user_id, source, reason, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [input.customerId, input.priority ?? null, input.priority ?? null, null, input.ownerSalespersonId, input.registrarUserId ?? null,
      DEFAULT_OWNER_RULE_SOURCE, `قانون ثبت: مالک پیش‌فرض — ${REGISTRATION_SOURCES[input.source]}`, (input.now ?? new Date()).toISOString()]);
}

/** Owner for a new customer: the rule owner when it applies, else whatever the caller's old path picks (called lazily). */
export function resolveNewCustomerOwner(source: RegistrationSource, registrarUserId: number | null | undefined, fallback: () => number | null | undefined):
  { salespersonId: number | null; ruleApplied: boolean } {
  const d = defaultOwnerDecision(source, registrarUserId);
  if (d.apply) return { salespersonId: d.ownerSalespersonId, ruleApplied: true };
  const v = fallback();
  return { salespersonId: v == null ? null : Number(v), ruleApplied: false };
}

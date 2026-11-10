/**
 * Master AI switch (ai-master-switch v1.0, Armita).
 * AND-gate on top of existing feature flags. Never logs, returns, or stores a provider key.
 *
 * Setting: `ai_enabled` in call_queue_settings ("1" | "0").
 * This module NEVER inserts a default row on boot — a missing row would otherwise
 * silently cut live AI if we wrote "0", or leave the design default unclear.
 * Release must seed the chosen value (see seedAiEnabledIfAbsent / NAFISVAM_AI_ENABLED_SEED).
 *
 * If the row is absent, resolve in this order:
 *   1. process.env.NAFISVAM_AI_ENABLED_SEED when it is "0" or "1"
 *   2. AI_ENABLED_UNSET_DEFAULT (easy to change).
 *      "1" = unseeded installs keep today's live AI (existing flags still apply).
 *      "0" = unseeded installs match the design default (all AI work stops).
 *      Release MUST seed an explicit "0" or "1"; the seed script refuses to guess.
 *
 * Report both release options; do not decide them here.
 */
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";

export const AI_ENABLED_SETTING = "ai_enabled";
export const AI_ENABLED_SEED_ENV = "NAFISVAM_AI_ENABLED_SEED";
/**
 * Last-resort only when the row is missing AND the env seed is unset.
 * "1" avoids cutting currently-live features if a deploy forgets to seed.
 * This is NOT the product default — the design default is OFF, applied by seeding "0" at release.
 * Flip this constant in one place if the unseeded fallback should change.
 */
export const AI_ENABLED_UNSET_DEFAULT: "0" | "1" = "1";

export const AI_NO_KEY_CODE = "no_key";
export const AI_NO_KEY_MSG = "حداقل یک کلید باید ثبت شده باشد";
export const AI_MASTER_OFF_MSG = "هوش مصنوعی خاموش است.";
export const AI_OFF_WORK_LINE =
  "تا وقتی خاموش است، پاسخ ربات بله، تبدیل گفتار به متن، خلاصهٔ تماس، و پر کردن خودکار فیلدهای لازم خلاصه اجرا نمی‌شود.";

/**
 * §6 provisional defaults (await Mohammad). Flip these in one place.
 * 1 provider selection: server (existing OpenAI-then-DeepSeek in cbAnswerAi).
 * 2 grey off-hint on call summary / Bale pages: out of scope.
 * 3 confirm before turning off: yes (UI).
 * 4 non-admin: no-access page, not a read-only switch.
 * 5 last Keys-tab key deleted while on: auto-off.
 * 6 DeepSeek-only is enough to turn on.
 */
export const AI_MASTER_DEFAULTS = {
  providerSelection: "server" as const,
  showOffHintElsewhere: false,
  confirmOff: true,
  nonAdminSeesSwitch: false,
  autoOffWhenLastKeyDeleted: true,
  anyRegisteredKeySuffices: true,
};

export class AiMasterError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function nowIso() { return new Date().toISOString(); }

function setting(key: string): string | null {
  try {
    const r = queryRow("SELECT value FROM call_queue_settings WHERE key=?", [key]) as { value: string } | undefined;
    return r ? String(r.value) : null;
  } catch {
    return null;
  }
}

function upsertSetting(key: string, value: string, at = nowIso()): void {
  const exists = queryRow("SELECT key FROM call_queue_settings WHERE key=?", [key]);
  if (exists) executeChanges("UPDATE call_queue_settings SET value=?, updated_at=? WHERE key=?", [value, at, key]);
  else execute("INSERT INTO call_queue_settings(key, value, updated_at) VALUES(?,?,?)", [key, value, at]);
}

let schemaReady = false;
export function ensureAiMasterSchema(): void {
  if (schemaReady) return;
  execute(`CREATE TABLE IF NOT EXISTS ai_master_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  schemaReady = true;
}
export function _resetAiMasterSchemaFlag() { schemaReady = false; }

/** Unset-row fallback used by aiEnabled(). Exposed so tests and release notes can quote it. */
export function aiEnabledUnsetFallback(): "0" | "1" {
  const seed = (process.env[AI_ENABLED_SEED_ENV] ?? "").trim();
  if (seed === "0" || seed === "1") return seed;
  return AI_ENABLED_UNSET_DEFAULT;
}

/** True only when the stored (or seeded-unset) value is "1". Existing feature flags are AND-ed by each caller. */
export function aiEnabled(): boolean {
  const row = setting(AI_ENABLED_SETTING);
  if (row === "1") return true;
  if (row === "0") return false;
  return aiEnabledUnsetFallback() === "1";
}

/** At least one Keys-tab secret (OpenAI or DeepSeek) is stored. Never returns the key. */
export function aiHasRegisteredKey(): boolean {
  try {
    const has = queryRow<{ n: number }>("SELECT 1 n FROM sqlite_master WHERE type='table' AND name='customer_bale_secrets'");
    if (!has) return false;
    const rows = queryRows<{ kind: string }>("SELECT kind FROM customer_bale_secrets");
    return rows.some((r) => r.kind === "openai" || r.kind === "deepseek");
  } catch {
    return false;
  }
}

/** Status for GET. Never includes a key, last4, or remnant. */
export function aiMasterStatus(): { ai_enabled: boolean; has_key: boolean } {
  return { ai_enabled: aiEnabled(), has_key: aiHasRegisteredKey() };
}

export function aiAudit(action: "on" | "off" | "auto_off_no_key", userId: number | null, at = nowIso()): void {
  ensureAiMasterSchema();
  execute("INSERT INTO ai_master_audit(user_id, action, at) VALUES(?,?,?)", [userId, action, at]);
}

/**
 * Insert the release-time default only if the row is missing.
 * Returns true when a row was written. Never overwrites an existing value.
 */
export function seedAiEnabledIfAbsent(value: "0" | "1", at = nowIso()): boolean {
  if (setting(AI_ENABLED_SETTING) != null) return false;
  upsertSetting(AI_ENABLED_SETTING, value, at);
  return true;
}

export function aiSetEnabled(on: boolean, actorId: number | null, at = nowIso()): { ai_enabled: boolean; has_key: boolean } {
  ensureAiMasterSchema();
  if (on && !aiHasRegisteredKey()) {
    throw new AiMasterError(409, AI_NO_KEY_CODE, AI_NO_KEY_MSG);
  }
  upsertSetting(AI_ENABLED_SETTING, on ? "1" : "0", at);
  aiAudit(on ? "on" : "off", actorId, at);
  return aiMasterStatus();
}

/** §6.5 default: if the last Keys-tab key is gone while the switch is on, turn it off and audit. */
export function aiAutoOffIfNoKey(actorId: number | null = null, at = nowIso()): boolean {
  if (!AI_MASTER_DEFAULTS.autoOffWhenLastKeyDeleted) return false;
  if (!aiEnabled()) return false;
  if (aiHasRegisteredKey()) return false;
  ensureAiMasterSchema();
  upsertSetting(AI_ENABLED_SETTING, "0", at);
  aiAudit("auto_off_no_key", actorId, at);
  return true;
}

export function assertAiWorkAllowed(): void {
  if (!aiEnabled()) throw new AiMasterError(403, "ai_off", AI_MASTER_OFF_MSG);
}

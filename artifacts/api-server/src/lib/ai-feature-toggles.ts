/**
 * Admin AI feature toggles: Bale bot AI reply (cbAnswerAi) and STT v2.
 * Saved in call_queue_settings (absent = OFF). Never logs, returns, or stores a provider key.
 *
 * effective = master ON × OpenAI Keys-tab key present × saved ON.
 * Turning ON without a tab OpenAI key is rejected. If the key is later removed,
 * saved stays, effective becomes false (no auto-off of the saved row).
 * Seeded OFF (absent). Release must not turn these on.
 */
import { execute, executeChanges, queryRow } from "./crm-db";
import { aiEnabled, aiOpenAiTabKeyPresent } from "./ai-master";

export const AI_TOGGLE_SETTINGS = {
  cbAnswerAi: "flag.ai_cb_answer",
  sttV2: "flag.stt_v2",
} as const;

export const AI_TOGGLE_LAST_ENABLED = {
  cbAnswerAi: "flag.ai_cb_answer.last_enabled_at",
  sttV2: "flag.stt_v2.last_enabled_at",
} as const;

export type AiToggleId = keyof typeof AI_TOGGLE_SETTINGS;
export const AI_TOGGLE_IDS: AiToggleId[] = ["cbAnswerAi", "sttV2"];

export const AI_TOGGLE_NO_KEY_CODE = "openai_key_missing";
export const AI_TOGGLE_NO_KEY_MSG = "کلید OpenAI وارد نشده";
export const AI_TOGGLE_MASTER_OFF_CODE = "master_off";
export const AI_TOGGLE_MASTER_OFF_MSG = "هوش مصنوعی خاموش است؛ این قابلیت‌ها کار نمی‌کنند.";

export class AiToggleError extends Error {
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
export function ensureAiTogglesSchema(): void {
  if (schemaReady) return;
  execute(`CREATE TABLE IF NOT EXISTS ai_feature_toggle_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    toggle TEXT NOT NULL,
    action TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
  schemaReady = true;
}
export function _resetAiTogglesSchemaFlag() { schemaReady = false; }

export function aiToggleSaved(id: AiToggleId): boolean {
  return setting(AI_TOGGLE_SETTINGS[id]) === "1";
}

export function aiToggleLastEnabledAt(id: AiToggleId): string | null {
  const v = setting(AI_TOGGLE_LAST_ENABLED[id]);
  return v && v.trim() ? v : null;
}

/** OpenAI Keys-tab key only. Never the env key, never the value. */
export function aiToggleKeyPresent(): boolean {
  return aiOpenAiTabKeyPresent();
}

/** master × tab OpenAI key × saved. */
export function aiToggleEffective(id: AiToggleId): boolean {
  return aiEnabled() && aiToggleKeyPresent() && aiToggleSaved(id);
}

export type AiToggleState = {
  saved: boolean;
  effective: boolean;
  keyPresent: boolean;
  lastEnabledAt: string | null;
};

export type AiTogglesStatus = {
  masterEnabled: boolean;
  cbAnswerAi: AiToggleState;
  sttV2: AiToggleState;
};

function oneState(id: AiToggleId, keyPresent: boolean): AiToggleState {
  const saved = aiToggleSaved(id);
  return {
    saved,
    effective: aiEnabled() && keyPresent && saved,
    keyPresent,
    lastEnabledAt: aiToggleLastEnabledAt(id),
  };
}

export function aiTogglesStatus(): AiTogglesStatus {
  const keyPresent = aiToggleKeyPresent();
  return {
    masterEnabled: aiEnabled(),
    cbAnswerAi: oneState("cbAnswerAi", keyPresent),
    sttV2: oneState("sttV2", keyPresent),
  };
}

export function aiToggleAudit(id: AiToggleId, action: "on" | "off" | "auto_off_no_key", userId: number | null, at = nowIso()): void {
  ensureAiTogglesSchema();
  execute("INSERT INTO ai_feature_toggle_audit(user_id, toggle, action, at) VALUES(?,?,?,?)", [userId, id, action, at]);
}

/**
 * Set saved state. ON requires a Keys-tab OpenAI key (even if the master switch is off —
 * effective stays false until the master is also on). lastEnabledAt is set only on a
 * successful ON and is kept when turning off.
 */
export function aiSetToggle(id: AiToggleId, on: boolean, actorId: number | null, at = nowIso()): AiTogglesStatus {
  if (!AI_TOGGLE_SETTINGS[id]) throw new AiToggleError(400, "invalid", "unknown_toggle");
  ensureAiTogglesSchema();
  if (on && !aiToggleKeyPresent()) {
    throw new AiToggleError(409, AI_TOGGLE_NO_KEY_CODE, AI_TOGGLE_NO_KEY_MSG);
  }
  if (on && !aiEnabled()) {
    throw new AiToggleError(409, AI_TOGGLE_MASTER_OFF_CODE, AI_TOGGLE_MASTER_OFF_MSG);
  }
  upsertSetting(AI_TOGGLE_SETTINGS[id], on ? "1" : "0", at);
  if (on) upsertSetting(AI_TOGGLE_LAST_ENABLED[id], at, at);
  aiToggleAudit(id, on ? "on" : "off", actorId, at);
  return aiTogglesStatus();
}


/** If the Keys-tab OpenAI key is gone, turn saved toggles off and audit. DeepSeek alone is not enough. */
export function aiAutoOffTogglesIfNoOpenAiKey(actorId: number | null = null, at = nowIso()): boolean {
  if (aiToggleKeyPresent()) return false;
  ensureAiTogglesSchema();
  let any = false;
  for (const id of AI_TOGGLE_IDS) {
    if (!aiToggleSaved(id)) continue;
    upsertSetting(AI_TOGGLE_SETTINGS[id], "0", at);
    aiToggleAudit(id, "auto_off_no_key", actorId, at);
    any = true;
  }
  return any;
}

export function parseToggleId(raw: unknown): AiToggleId | null {
  if (raw === "cbAnswerAi" || raw === "sttV2") return raw;
  return null;
}

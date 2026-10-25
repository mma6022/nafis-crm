/**
 * crm-voice-notes: voice-to-text for sales notes (call-form note, customer «توضیح»).
 *
 * - Behind STT_ENABLED (default OFF). Only roles salesperson + admin, enforced here (server side).
 * - Provider switch STT_PROVIDER=openai|xai. Keys stay on the server; never logged or returned.
 * - Audio lives only in memory for the duration of the request: it is never written to disk, logged or stored.
 * - Every attempt is logged in voice_note_transcriptions (user, seconds, model, time, ok/error code) — no audio, no text.
 * - Per-user daily cap (Asia/Tehran day) in audio minutes, STT_DAILY_LIMIT_MINUTES (default 60).
 *
 * This module never imports crm-db: the DB handle, env, fetch and clock are injected so the fixture can run it
 * on an in-memory database with a mocked provider.
 */
import express, { Router, type IRouter, type Request, type Response } from "express";

export type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: any[]): unknown; all(...p: any[]): unknown[]; get(...p: any[]): unknown };
};
export type Env = Record<string, string | undefined>;
export type Provider = "openai" | "xai";
export type SttConfig = {
  enabled: boolean; provider: Provider; model: string; baseUrl: string; hasKey: boolean;
  dailyLimitSeconds: number; maxSeconds: number; maxBytes: number; timeoutMs: number;
  /** Retry once with the OTHER provider on any primary error/timeout (OpenAI primary → xAI keyterms; xAI primary → OpenAI prompt). STT_FALLBACK=off disables; needs the other key. */
  fallback: boolean;
};

export const VOICE_NOTES_TABLE = "voice_note_transcriptions";
export const ALLOWED_ROLES = ["salesperson", "admin"] as const;
export const HARD_MAX_SECONDS = 120;
/** Provider-reported length may exceed the recorder timer slightly (container padding). */
export const OVER_LIMIT_TOLERANCE_SECONDS = 5;
const MAX_BILLED_SECONDS = 600;
export const VOICE_FIELDS = ["call_note", "first_call_note", "customer_description"] as const;
export type VoiceField = (typeof VOICE_FIELDS)[number];
/** Rough list prices (USD per audio minute) for the admin cost estimate only. */
export const PRICE_PER_MINUTE_USD: Record<string, number> = {
  "gpt-4o-mini-transcribe": 0.003,
  "gpt-4o-transcribe": 0.006,
  "whisper-1": 0.006,
  "grok-voice-transcribe-2.0": 0.10 / 60,
};
export const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
  "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "video/webm": "webm",
};

const on = (v: string | undefined) => /^(1|true|on|yes)$/i.test((v ?? "").trim());
const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const cleanBase = (v: string | undefined, d: string) => {
  const s = (v ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(s) ? s : d;
};

export function readSttConfig(env: Env): SttConfig {
  // Default provider: xAI (grok-voice-transcribe-2.0 + keyterms). STT_PROVIDER=openai makes OpenAI (gpt-4o-transcribe) primary.
  // Either way the OTHER provider is the one-shot fallback (STT_FALLBACK=off disables it).
  const provider: Provider = (env.STT_PROVIDER ?? "").trim().toLowerCase() === "openai" ? "openai" : "xai";
  const xai = provider === "xai";
  return {
    enabled: on(env.STT_ENABLED),
    provider,
    model: (xai ? env.XAI_STT_MODEL : env.STT_MODEL)?.trim() || (xai ? "grok-voice-transcribe-2.0" : "gpt-4o-transcribe"),
    baseUrl: xai ? cleanBase(env.XAI_API_BASE_URL, "https://api.x.ai/v1") : cleanBase(env.STT_API_BASE_URL, "https://api.openai.com/v1"),
    hasKey: Boolean(apiKey(env, provider)),
    dailyLimitSeconds: Math.round(num(env.STT_DAILY_LIMIT_MINUTES, 60, 0, 24 * 60) * 60),
    maxSeconds: num(env.STT_MAX_SECONDS, HARD_MAX_SECONDS, 5, HARD_MAX_SECONDS),
    maxBytes: Math.round(num(env.STT_MAX_BYTES, 5 * 1024 * 1024, 64 * 1024, 10 * 1024 * 1024)),
    timeoutMs: Math.round(num(env.STT_TIMEOUT_SECONDS, 50, 5, 180) * 1000), // nginx proxy_read_timeout is the 60 s default
    fallback: !/^(0|false|off|no)$/i.test((env.STT_FALLBACK ?? "").trim()),
  };
}
/** Fallback config = the provider that is NOT primary: xAI primary → OpenAI; OpenAI primary (STT_PROVIDER=openai) → xAI.
 *  Provider-specific model / base-URL env vars still apply. */
export function fallbackSttConfig(env: Env, primary: Provider = "xai"): SttConfig {
  return { ...readSttConfig({ ...env, STT_PROVIDER: primary === "xai" ? "openai" : "xai" }), fallback: false };
}
/** With a fallback, the primary gets ≤20 s and the fallback ≤30 s so primary + retry stay under nginx's 60 s proxy_read_timeout. */
export const PRIMARY_TIMEOUT_WITH_FALLBACK_MS = 20_000;
export const FALLBACK_TIMEOUT_MS = 30_000;
function apiKey(env: Env, provider: Provider): string {
  return ((provider === "xai" ? env.XAI_API_KEY : env.STT_API_KEY || env.OPENAI_API_KEY) ?? "").trim();
}

export class VoiceNoteError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/* ---------------- vocabulary ---------------- */
export const LOAN_TERMS = [
  "چک برگشتی", "چک صیادی", "ضامن", "اقساط", "قسط", "پیش‌پرداخت", "لندتک", "اعتبارسنجی", "رتبه اعتباری", "سفته",
  "کد ملی", "وجه تضمین", "کسر از حقوق", "رفع سوء اثر", "تسهیلات", "وام", "تومان", "نفیس وام",
];
export const BANKS = ["بانک ملی", "بانک ملت", "اقتصاد نوین", "صادرات", "گردشگری", "تجارت", "بلوبانک", "های بانک", "مهر", "مسکن", "رفاه"];
export const PLATFORMS = ["بام", "مانیسا", "از کی وام", "تکنوپی", "دیجی‌پی", "قسطیو", "فرابانک"];

const planWord = (s: string) => s.replace(/^طرح\s+/, "").replace(/\s+/g, " ").trim();
export type PlanVocab = { active: string[]; inactive: string[] };
/** All plan names from loan_plans (active first), read at request time; «طرح » prefix stripped, each ≤50 chars (xAI keyterm limit). */
export function readPlanVocab(db: Db): PlanVocab {
  try {
    const rows = db.prepare("SELECT name, active FROM loan_plans ORDER BY active DESC, id").all() as { name: unknown; active: unknown }[];
    const active: string[] = []; const inactive: string[] = []; const seen = new Set<string>();
    for (const r of rows) {
      const n = typeof r.name === "string" ? planWord(r.name) : "";
      if (!n || n.length > 50 || seen.has(n)) continue;
      seen.add(n); (Number(r.active) === 1 ? active : inactive).push(n);
    }
    return { active, inactive };
  } catch { return { active: [], inactive: [] }; }
}
export const PLAN_VOCAB_TTL_MS = 60_000;
const planVocabCache = new WeakMap<object, { at: number; v: PlanVocab }>();
/** readPlanVocab cached briefly per database (60 s) so plan edits show up within a minute. */
export function cachedPlanVocab(db: Db, nowMs = Date.now()): PlanVocab {
  const hit = planVocabCache.get(db as object);
  if (hit && nowMs - hit.at < PLAN_VOCAB_TTL_MS && nowMs >= hit.at) return hit.v;
  const v = readPlanVocab(db); planVocabCache.set(db as object, { at: nowMs, v }); return v;
}
export function activePlanNames(db: Db): string[] { return readPlanVocab(db).active; }
/** Generic words xAI mishears without a hint (e.g. «طرح» → «تر», «ضامن» → «زامن», «صیادی» → «زیادی»); always sent first. */
export const XAI_CORE_TERMS = ["طرح", "ضامن", "صیادی"];
/** xAI documented keyterm limits: max 100 terms, each ≤50 characters (docs.x.ai speech-to-text, checked 2026-10-24). */
export const XAI_MAX_KEYTERMS = 100;
export const XAI_MAX_KEYTERM_CHARS = 50;
/** xAI keyterms, priority order: core words → active plans (bare + «طرح …» phrase) → static loan/bank/platform terms →
 *  inactive plans; capped at 100. The phrase form stops «طرح ستاره آبی» being heard as «تر ستاره آبی». */
export function keyterms(plans: string[], inactivePlans: string[] = []): string[] {
  const withPhrase = (names: string[]) => names.flatMap((n) => [n, `طرح ${n}`]);
  return [...new Set([...XAI_CORE_TERMS, ...withPhrase(plans), ...LOAN_TERMS, ...BANKS, ...PLATFORMS, ...withPhrase(inactivePlans)].map((t) => t.trim()).filter((t) => t && t.length <= XAI_MAX_KEYTERM_CHARS))].slice(0, XAI_MAX_KEYTERMS);
}
/** OpenAI helper prompt (vocabulary hint, not an instruction to rewrite). */
export function helperPrompt(plans: string[]): string {
  return [
    "یادداشت صوتی کارشناس فروش «نفیس وام» به فارسی؛ عیناً پیاده شود.",
    plans.length ? `نام طرح‌ها: ${plans.slice(0, 40).join("، ")}.` : "",
    `اصطلاحات: ${LOAN_TERMS.join("، ")}.`,
    `بانک‌ها و پلتفرم‌ها: ${[...BANKS, ...PLATFORMS].join("، ")}.`,
  ].filter(Boolean).join(" ");
}

/* ---------------- schema + usage log ---------------- */
export function ensureVoiceNotesSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${VOICE_NOTES_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    role TEXT NOT NULL,
    field TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    audio_seconds REAL NOT NULL DEFAULT 0,
    audio_bytes INTEGER NOT NULL DEFAULT 0,
    mime TEXT,
    ok INTEGER NOT NULL,
    error_code TEXT,
    day_tehran TEXT NOT NULL,
    month_jalali TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${VOICE_NOTES_TABLE}_user_day ON ${VOICE_NOTES_TABLE}(user_id, day_tehran)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${VOICE_NOTES_TABLE}_month ON ${VOICE_NOTES_TABLE}(month_jalali)`);
}

const partsOf = (d: Date, calendar: string) => {
  const p = new Intl.DateTimeFormat(`en-US-u-ca-${calendar}-nu-latn`, { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: g("year").replace(/\D/g, ""), m: g("month").padStart(2, "0"), d: g("day").padStart(2, "0") };
};
export function tehranDay(d: Date): string { const p = partsOf(d, "gregory"); return `${p.y}-${p.m}-${p.d}`; }
export function jalaliMonth(d: Date): string { const p = partsOf(d, "persian"); return `${p.y}-${p.m}`; }

export type LogEntry = {
  userId: number; userName: string | null; role: string; field: string | null; provider: Provider; model: string;
  seconds: number; bytes: number; mime: string | null; ok: boolean; errorCode: string | null; at: Date;
};
export function logTranscription(db: Db, e: LogEntry): void {
  db.prepare(`INSERT INTO ${VOICE_NOTES_TABLE}
    (user_id,user_name,role,field,provider,model,audio_seconds,audio_bytes,mime,ok,error_code,day_tehran,month_jalali,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.userId, e.userName, e.role, e.field, e.provider, e.model, Math.round(e.seconds * 10) / 10, e.bytes, e.mime,
    e.ok ? 1 : 0, e.errorCode, tehranDay(e.at), jalaliMonth(e.at), e.at.toISOString(),
  );
}
/** Seconds counted against the daily cap: successful transcriptions of the user's Tehran day. */
export function usedSecondsToday(db: Db, userId: number, now: Date): number {
  const r = db.prepare(`SELECT COALESCE(SUM(audio_seconds),0) AS s FROM ${VOICE_NOTES_TABLE} WHERE user_id=? AND day_tehran=? AND (ok=1 OR error_code='too_long')`)
    .get(userId, tehranDay(now)) as { s: number };
  return Number(r?.s ?? 0);
}

export type UsageRow = {
  userId: number; name: string | null; role: string; count: number; okCount: number; errorCount: number;
  seconds: number; minutes: number; estCostUsd: number;
};
export function monthlyUsage(db: Db, month: string) {
  const rows = db.prepare(`SELECT user_id AS userId, MAX(user_name) AS name, MAX(role) AS role, model,
      COUNT(*) AS count, SUM(ok) AS okCount, SUM(CASE WHEN ok=1 THEN audio_seconds ELSE 0 END) AS seconds
    FROM ${VOICE_NOTES_TABLE} WHERE month_jalali=? GROUP BY user_id, model`).all(month) as any[];
  const byUser = new Map<number, UsageRow>();
  for (const r of rows) {
    const u = byUser.get(r.userId) ?? { userId: r.userId, name: r.name, role: r.role, count: 0, okCount: 0, errorCount: 0, seconds: 0, minutes: 0, estCostUsd: 0 };
    u.count += r.count; u.okCount += r.okCount; u.errorCount = u.count - u.okCount; u.seconds += r.seconds;
    u.estCostUsd += (r.seconds / 60) * (PRICE_PER_MINUTE_USD[r.model] ?? 0.006);
    byUser.set(r.userId, u);
  }
  const users = [...byUser.values()].map((u) => ({ ...u, seconds: Math.round(u.seconds), minutes: Math.round((u.seconds / 60) * 10) / 10, estCostUsd: Math.round(u.estCostUsd * 1000) / 1000 }))
    .sort((a, b) => b.seconds - a.seconds);
  const totals = users.reduce((t, u) => ({ count: t.count + u.count, errorCount: t.errorCount + u.errorCount, seconds: t.seconds + u.seconds, estCostUsd: t.estCostUsd + u.estCostUsd }),
    { count: 0, errorCount: 0, seconds: 0, estCostUsd: 0 });
  const months = (db.prepare(`SELECT DISTINCT month_jalali AS m FROM ${VOICE_NOTES_TABLE} ORDER BY m DESC LIMIT 24`).all() as { m: string }[]).map((r) => r.m);
  // Which provider served each successful request (fallbacks = served by the non-primary provider after the primary failed).
  const providers = (db.prepare(`SELECT provider, model, SUM(ok) AS served,
      SUM(CASE WHEN ok=1 AND error_code LIKE 'fallback_from_%' THEN 1 ELSE 0 END) AS fallbacks,
      SUM(CASE WHEN ok=1 THEN audio_seconds ELSE 0 END) AS seconds
    FROM ${VOICE_NOTES_TABLE} WHERE month_jalali=? GROUP BY provider, model ORDER BY served DESC`).all(month) as any[])
    .map((r) => ({ provider: String(r.provider), model: String(r.model), served: Number(r.served) || 0, fallbacks: Number(r.fallbacks) || 0, minutes: Math.round(((Number(r.seconds) || 0) / 60) * 10) / 10 }))
    .filter((r) => r.served > 0);
  return {
    month, months, users, providers,
    totals: { ...totals, minutes: Math.round((totals.seconds / 60) * 10) / 10, estCostUsd: Math.round(totals.estCostUsd * 1000) / 1000 },
  };
}

/* ---------------- providers ---------------- */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; redirect: "error"; signal: AbortSignal }) => Promise<globalThis.Response>;
export type TranscribeInput = { audio: Uint8Array; mime: string; plans: string[]; inactivePlans?: string[] };

async function readBounded(response: globalThis.Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new VoiceNoteError(502, "empty_response", "پاسخ سرویس تبدیل صدا خالی بود؛ دوباره تلاش کنید.");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > (response.ok ? 1024 * 1024 : 65536)) { await reader.cancel(); throw new VoiceNoteError(502, "response_too_large", "پاسخ سرویس تبدیل صدا معتبر نبود؛ دوباره تلاش کنید."); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new VoiceNoteError(502, "bad_response", "پاسخ سرویس تبدیل صدا معتبر نبود؛ دوباره تلاش کنید."); }
}

export function validateTranscript(text: unknown): string {
  if (typeof text !== "string" || text.length > 20000) throw new VoiceNoteError(502, "bad_text", "متن برگشتی معتبر نبود؛ دوباره تلاش کنید.");
  const words = text.trim().split(/\s+/);
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 15) throw new VoiceNoteError(502, "repetitive_text", "سرویس متن تکراری و نامعتبر برگرداند؛ دوباره ضبط کنید.");
  }
  return text.trim();
}

export async function transcribe(cfg: SttConfig, env: Env, input: TranscribeInput, fetchImpl: FetchLike): Promise<{ text: string; durationSec: number | null }> {
  const key = apiKey(env, cfg.provider);
  if (!key) throw new VoiceNoteError(503, "no_key", "سرویس تبدیل صدا به متن روی سرور تنظیم نشده است؛ به مدیر اطلاع دهید.");
  const ext = AUDIO_TYPES[input.mime] ?? "webm";
  const form = new FormData();
  let url: string;
  if (cfg.provider === "xai") {
    url = `${cfg.baseUrl}/stt`;
    form.append("model", cfg.model);
    form.append("language", "fa");
    for (const t of keyterms(input.plans, input.inactivePlans ?? [])) form.append("keyterm", t);
  } else {
    url = `${cfg.baseUrl}/audio/transcriptions`;
    form.append("model", cfg.model);
    form.append("language", "fa");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("prompt", helperPrompt(input.plans));
  }
  // xAI requires the file to be the last multipart field; keep it last for both providers.
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.mime }), `voice-note.${ext}`);
  let response: globalThis.Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, redirect: "error", signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (e) {
    const timeout = (e as { name?: string })?.name === "TimeoutError";
    throw new VoiceNoteError(502, timeout ? "timeout" : "network", timeout ? "پاسخ سرویس تبدیل صدا طول کشید؛ دوباره تلاش کنید." : "ارتباط با سرویس تبدیل صدا برقرار نشد؛ دوباره تلاش کنید.");
  }
  const data = await readBounded(response);
  if (!response.ok) {
    const quota = response.status === 429 && (data?.error?.type === "insufficient_quota" || data?.error?.code === "credit_balance_exhausted" || /credit|quota/i.test(String(data?.error ?? data?.code ?? "")));
    if (quota) throw new VoiceNoteError(502, "provider_quota", "اعتبار سرویس تبدیل صدا تمام شده است؛ به مدیر اطلاع دهید.");
    if (response.status === 429) throw new VoiceNoteError(502, "provider_rate_limit", "سرویس تبدیل صدا الان شلوغ است؛ چند لحظه بعد دوباره تلاش کنید.");
    if ([401, 403].includes(response.status)) throw new VoiceNoteError(502, "provider_auth", "سرویس تبدیل صدا کلید سرور را نپذیرفت؛ به مدیر اطلاع دهید.");
    if ([400, 413, 415, 422].includes(response.status)) throw new VoiceNoteError(502, "provider_rejected", "فایل صدا قابل تبدیل نبود؛ دوباره ضبط کنید.");
    throw new VoiceNoteError(502, `provider_${response.status}`, "سرویس تبدیل صدا پاسخ نداد؛ دوباره تلاش کنید.");
  }
  const text = validateTranscript(data?.text);
  const duration = Number(data?.duration);
  return { text, durationSec: Number.isFinite(duration) && duration > 0 ? duration : null };
}

/* ---------------- HTTP ---------------- */
export type Actor = { id: number; role: string; fullName: string | null };
export type VoiceNotesDeps = {
  db: Db; env: () => Env; fetch: FetchLike; now?: () => Date;
  actor: (res: Response) => Actor | null;
};
const allowedRole = (role: string) => (ALLOWED_ROLES as readonly string[]).includes(role);
const baseMime = (ct: string | undefined) => (ct ?? "").split(";")[0].trim().toLowerCase();

export function createVoiceNotesRouter(deps: VoiceNotesDeps): IRouter {
  const router: IRouter = Router();
  const now = deps.now ?? (() => new Date());
  const inflight = new Set<number>();
  let schemaReady = false;
  const ready = () => { if (!schemaReady) { ensureVoiceNotesSchema(deps.db); schemaReady = true; } };

  router.get("/voice-notes/config", (_req: Request, res: Response) => {
    const actor = deps.actor(res);
    const cfg = readSttConfig(deps.env());
    if (!actor || !cfg.enabled || !allowedRole(actor.role)) { res.json({ enabled: false }); return; }
    ready();
    const used = usedSecondsToday(deps.db, actor.id, now());
    res.json({ enabled: true, maxSeconds: cfg.maxSeconds, dailyLimitSeconds: cfg.dailyLimitSeconds, remainingSeconds: Math.max(0, Math.floor(cfg.dailyLimitSeconds - used)) });
  });

  router.post("/voice-notes/transcribe", async (req: Request, res: Response) => {
    const cfg = readSttConfig(deps.env());
    const actor = deps.actor(res);
    if (!cfg.enabled) { res.status(404).json({ error: "Not found" }); return; }
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!allowedRole(actor.role)) { res.status(403).json({ error: "تبدیل صدا به متن فقط برای کارشناس فروش و مدیر فعال است." }); return; }
    const mime = baseMime(req.headers["content-type"]);
    if (!AUDIO_TYPES[mime]) { res.status(415).json({ error: "قالب فایل صدا پشتیبانی نمی‌شود." }); return; }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cfg.maxBytes) { res.status(413).json({ error: "فایل صدا بیش از حد بزرگ است؛ حداکثر ۲ دقیقه ضبط کنید." }); return; }
    const field = VOICE_FIELDS.includes(String(req.query.field) as VoiceField) ? String(req.query.field) : null;
    const clientSeconds = Number(req.query.duration);
    if (!Number.isFinite(clientSeconds) || clientSeconds <= 0) { res.status(400).json({ error: "مدت ضبط نامعتبر است؛ دوباره ضبط کنید." }); return; }
    if (clientSeconds > cfg.maxSeconds + 2) { res.status(413).json({ error: "ضبط بیش از ۲ دقیقه است؛ کوتاه‌تر ضبط کنید." }); return; }
    ready();
    const at = now();
    const used = usedSecondsToday(deps.db, actor.id, at);
    if (used + Math.min(clientSeconds, cfg.maxSeconds) > cfg.dailyLimitSeconds) {
      logTranscription(deps.db, { userId: actor.id, userName: actor.fullName, role: actor.role, field, provider: cfg.provider, model: cfg.model, seconds: 0, bytes: 0, mime, ok: false, errorCode: "daily_limit", at });
      res.status(429).json({ error: `سقف روزانهٔ تبدیل صدا (${Math.round(cfg.dailyLimitSeconds / 60)} دقیقه) پر شده است؛ متن را تایپ کنید یا فردا دوباره امتحان کنید.` });
      return;
    }
    if (inflight.has(actor.id)) { res.status(409).json({ error: "یک تبدیل دیگر در حال انجام است؛ چند لحظه صبر کنید." }); return; }
    inflight.add(actor.id);
    let audio: Buffer | null = null;
    try {
      // Audio is parsed into memory only for this request (route-level parser; global json parser ignores audio/*).
      audio = await new Promise<Buffer | null>((resolve, reject) => {
        express.raw({ type: () => true, limit: cfg.maxBytes })(req, res, (err?: unknown) => (err ? reject(err) : resolve(Buffer.isBuffer(req.body) ? req.body : null)));
      }).catch((err: { type?: string; status?: number }) => {
        throw err?.type === "entity.too.large" || err?.status === 413
          ? new VoiceNoteError(413, "too_large", "فایل صدا بیش از حد بزرگ است؛ حداکثر ۲ دقیقه ضبط کنید.")
          : new VoiceNoteError(400, "bad_upload", "ارسال صدا ناقص ماند؛ دوباره تلاش کنید.");
      });
      if (!audio || audio.length < 200) throw new VoiceNoteError(400, "empty_audio", "صدایی ضبط نشد؛ دوباره تلاش کنید.");
      const bytes = audio.length;
      const env = deps.env();
      const vocab = cachedPlanVocab(deps.db, now().getTime());
      const input = { audio, mime, plans: vocab.active, inactivePlans: vocab.inactive };
      const fb = cfg.fallback ? fallbackSttConfig(env, cfg.provider) : null;
      const useFallback = Boolean(fb?.hasKey);
      let served = cfg; let note: string | null = null; let result: { text: string; durationSec: number | null };
      try {
        result = await transcribe(useFallback ? { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, PRIMARY_TIMEOUT_WITH_FALLBACK_MS) } : cfg, env, input, deps.fetch);
      } catch (primaryErr) {
        if (!useFallback || !fb) throw primaryErr;
        // Primary failed or timed out → one retry with the other provider (xAI→OpenAI or OpenAI→xAI). Logged as served by it.
        const code = primaryErr instanceof VoiceNoteError ? primaryErr.code : "internal";
        served = fb; note = `fallback_from_${cfg.provider}:${code}`.slice(0, 60);
        try { result = await transcribe({ ...fb, timeoutMs: Math.min(fb.timeoutMs, FALLBACK_TIMEOUT_MS) }, env, input, deps.fetch); }
        catch (e2) { if (e2 instanceof VoiceNoteError) e2.code = `fallback_failed:${code}>${e2.code}`.slice(0, 60); throw e2; }
      }
      // Server-side 2-minute rule: when the provider reports the real audio length and it is clearly over the limit
      // (client under-declared it), the text is withheld and the REAL length counts toward the daily cap.
      const providerSec = result.durationSec ?? 0;
      if (providerSec > cfg.maxSeconds + OVER_LIMIT_TOLERANCE_SECONDS) {
        logTranscription(deps.db, { userId: actor.id, userName: actor.fullName, role: actor.role, field, provider: served.provider, model: served.model, seconds: Math.min(providerSec, MAX_BILLED_SECONDS), bytes, mime, ok: false, errorCode: "too_long", at });
        res.status(413).json({ error: "ضبط بیش از ۲ دقیقه است؛ کوتاه‌تر ضبط کنید.", code: "too_long" });
        return;
      }
      const seconds = Math.min(cfg.maxSeconds, Math.max(providerSec, Math.min(clientSeconds, cfg.maxSeconds)));
      logTranscription(deps.db, { userId: actor.id, userName: actor.fullName, role: actor.role, field, provider: served.provider, model: served.model, seconds, bytes, mime, ok: true, errorCode: note, at });
      if (!result.text) { res.status(422).json({ error: "صدای واضحی شنیده نشد؛ دوباره و نزدیک‌تر به گوشی صحبت کنید." }); return; }
      res.json({ text: result.text, seconds: Math.round(seconds) });
    } catch (e) {
      const err = e instanceof VoiceNoteError ? e : new VoiceNoteError(500, "internal", "تبدیل صدا انجام نشد؛ دوباره تلاش کنید.");
      const viaFallback = err.code.startsWith("fallback_failed:");
      const fbCfg = viaFallback ? fallbackSttConfig(deps.env(), cfg.provider) : null;
      logTranscription(deps.db, { userId: actor.id, userName: actor.fullName, role: actor.role, field, provider: fbCfg ? fbCfg.provider : cfg.provider, model: fbCfg ? fbCfg.model : cfg.model, seconds: 0, bytes: audio?.length ?? 0, mime, ok: false, errorCode: err.code, at });
      res.status(err.status).json({ error: err.message, code: err.code });
    } finally {
      if (audio) audio.fill(0);
      audio = null; (req as { body?: unknown }).body = undefined;
      inflight.delete(actor.id);
    }
  });

  router.get("/voice-notes/usage", (req: Request, res: Response) => {
    const actor = deps.actor(res);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (actor.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
    ready();
    const cfg = readSttConfig(deps.env());
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? String(req.query.month) : jalaliMonth(now());
    res.json({
      ...monthlyUsage(deps.db, month),
      config: { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, hasKey: cfg.hasKey, dailyLimitMinutes: cfg.dailyLimitSeconds / 60, pricePerMinuteUsd: PRICE_PER_MINUTE_USD[cfg.model] ?? null },
    });
  });
  return router;
}

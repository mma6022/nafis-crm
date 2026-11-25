/**
 * social-hub send + bot-connect + bulk redirect (flags default OFF).
 *
 * flag.social_hub_send_v1         deliver expert-initiated Today sends and auto-sends through the
 *                                 existing Bale outbox (bale_bot_messages + attemptSend). OFF → rows stay queued.
 * flag.social_hub_bot_connect_v1  «آزمایش اتصال» / save of the unified «نفیس وام» token into the existing
 *                                 bale_bots row (user_id = 0). Token only via the masked field; never returned or logged.
 * flag.social_hub_redirect_v1     one-time bulk redirect to «نفیس وام». Stays disabled until the unified bot
 *                                 has a token and getMe succeeds. Super-admin only. Confirm wizard is on the client;
 *                                 this module refuses to start without a matching recipient count.
 *
 * File size: server-side setting sh_settings.bale_file_max_bytes, default 50 × 1024 × 1024.
 * Source: docs.bale.ai sendDocument, multipart upload — «بازوها می‌توانند هر نوع فایلی را با حداکثر اندازه ۵۰ مگابایت ارسال کنند.»
 *
 * Ghasemi (default readonly bot user id 3, setting social_hub_readonly_bot_user_ids): no Today or auto send
 * from her bot. Mohammad t931s3334: the one-time redirect IS sent from her bot for her customers.
 *
 * Tests must stub getMe / delivery; this module never calls the network unless those hooks are unset
 * and the flags are ON (production). Fixture always stubs them and sets BALE_BOT_WORKER=0.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "./auth";
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";
import {
  baleCall, BB_LIMITS, BB_SHARED_BOT_USER_ID, botById, botLive, botToken, filesDir, isSharedCustomerBot,
  nameOf, setShSendHooks, tokenShapeOk, type BotRow,
} from "./bale-bot";
import { baleBotAad, baleBotHasKey, sealBotToken } from "./bale-bot-crypto";
import { planChoiceLabel } from "./plan-label";
import {
  SH_BOT_NAME, ShError, ensureSocialHubSchema, setShSendModule, shConnectOn, shIsManager, shOn, shRender, shRedirectOn, shSendOn,
  shLog, shPlans, SH_TEXT_MAX,
} from "./social-hub";

export const SH_FAIL = {
  bot_off: "ربات خاموش است",
  forbidden: "مشتری ربات را بسته یا مسدود کرده",
  rate_limited: "بله موقتاً اجازهٔ ارسال نداد، کمی بعد دوباره امتحان کنید",
  file_too_big: "حجم فایل برای بله زیاد است",
  file_disabled: "حجم فایل برای ارسال در بله زیاد است",
  send_closed: "ارسال از این ربات بسته است",
  other_expert: (name: string) => `مشتری فقط با ربات ${name} گفتگو دارد`,
  recent: "همین الان فرستاده شد؛ ارسال دوباره بعد از ۱۰ دقیقه",
  unreachable: "این مشتری هنوز ربات را شروع نکرده؛ پیام نمی‌رود.",
  generic: "ارسال انجام نشد؛ دوباره امتحان کنید.",
} as const;

export const SH_REDIRECT_TEXT =
  "سلام ‹نام مشتری›،\nاز این پس پیگیری پرونده و پیام‌های نفیس وام در ربات رسمی «نفیس وام» در بله انجام می‌شود.\nبرای ادامه، روی دکمه‌ی زیر بزنید و ربات را شروع کنید.\nکارشناس شما، ‹نام کارشناس›، همچنان همراه شماست.";
export const SH_REDIRECT_BUTTON = "شروع ربات نفیس وام";
export const SH_DEDUPE_MS = 10 * 60 * 1000;
export const SH_DEFAULT_FILE_MAX = BB_LIMITS.fileBytes; // 50 MiB, docs.bale.ai sendDocument
export const SH_DEFAULT_REDIRECT_PER_MIN = 20;
export const SH_DEFAULT_READONLY_BOT_USERS = "3"; // Ghasemi users.id
const FILE_MAX_KEY = "bale_file_max_bytes";
const RATE_KEY = "redirect_per_minute";
const READONLY_KEY = "readonly_bot_user_ids";

const iso = () => new Date().toISOString();
const digitsLatin = (s: string) => String(s ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export const shParseCount = (raw: unknown): number | null => {
  const n = Number(digitsLatin(String(raw ?? "")).replace(/[^\d]/g, ""));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function shSetting(key: string): string | undefined {
  try { return queryRow<{ value: string }>("SELECT value FROM sh_settings WHERE key=?", [key])?.value; } catch { return undefined; }
}
function shSetSetting(key: string, value: string, userId: number | null = null) {
  execute("INSERT INTO sh_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
    [key, value, userId, iso()]);
}
export function shBaleFileMaxBytes(): number {
  const n = Number(shSetting(FILE_MAX_KEY));
  return Number.isSafeInteger(n) && n > 0 ? n : SH_DEFAULT_FILE_MAX;
}
export function shRedirectPerMinute(): number {
  const n = Number(shSetting(RATE_KEY));
  return Number.isSafeInteger(n) && n > 0 && n <= 600 ? n : SH_DEFAULT_REDIRECT_PER_MIN;
}
/** User ids whose expert bot is read-only for Today/auto sends. Redirect is exempt (t931s3334). */
export function shReadonlyBotUserIds(): number[] {
  const raw = shSetting(READONLY_KEY) ?? SH_DEFAULT_READONLY_BOT_USERS;
  return raw.split(/[,\s]+/).map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0);
}
export function shIsReadonlyBotUser(userId: number | null | undefined): boolean {
  return userId != null && shReadonlyBotUserIds().includes(Number(userId));
}

export function shIsSuperAdmin(u: AuthUser | null | undefined): boolean {
  if (!u || !u.active) return false;
  return u.baseRole === "admin" || (u.role === "admin" && !u.baseRole && !u.salesManager);
}

export type ShChat = {
  chatRow: number; chatId: string; botId: number; botUserId: number; botName: string;
  expertName: string; lastAt: string | null; blocked: boolean;
};
export function shLatestChat(customerId: number): ShChat | null {
  const r = queryRow<any>(
    `SELECT c.id chat_row, c.chat_id, c.last_at, b.id bot_id, b.user_id bot_user_id, b.bot_name, b.bot_username
       FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id
      WHERE c.customer_id=?
      ORDER BY COALESCE(c.last_at,'') DESC, c.id DESC LIMIT 1`, [customerId]);
  if (!r) return null;
  const owner = Number(r.bot_user_id) === BB_SHARED_BOT_USER_ID ? null
    : queryRow<{ full_name: string | null; username: string }>("SELECT full_name, username FROM users WHERE id=?", [r.bot_user_id]);
  return {
    chatRow: Number(r.chat_row), chatId: String(r.chat_id), botId: Number(r.bot_id), botUserId: Number(r.bot_user_id),
    botName: Number(r.bot_user_id) === BB_SHARED_BOT_USER_ID ? SH_BOT_NAME : (r.bot_name || owner?.full_name || owner?.username || "ربات بله"),
    expertName: Number(r.bot_user_id) === BB_SHARED_BOT_USER_ID ? "" : nameOf(owner ?? { full_name: r.bot_name, username: r.bot_username }),
    lastAt: r.last_at ?? null, blocked: shChatBlocked(Number(r.chat_row)),
  };
}
function shChatBlocked(chatRow: number): boolean {
  const last = queryRow<{ error_code: string | null; status: string }>(
    "SELECT status, error_code FROM bale_bot_messages WHERE chat_row=? AND dir='out' ORDER BY id DESC LIMIT 1", [chatRow]);
  if (!last || last.status !== "failed") return false;
  const c = String(last.error_code ?? "");
  return c === "forbidden" || c === "blocked" || c === "bot_blocked" || c === "user_deactivated";
}

export type ShSendGate =
  | { ok: true; chat: ShChat }
  | { ok: false; error: "unreachable" | "send_closed" | "other_expert" | "blocked"; message: string; expertName?: string };

export function shSendGate(u: AuthUser, customerId: number, opts: { allowReadonly?: boolean } = {}): ShSendGate {
  const chat = shLatestChat(customerId);
  if (!chat) return { ok: false, error: "unreachable", message: SH_FAIL.unreachable };
  if (chat.blocked) return { ok: false, error: "blocked", message: SH_FAIL.forbidden };
  if (!opts.allowReadonly && shIsReadonlyBotUser(chat.botUserId)) {
    return { ok: false, error: "send_closed", message: SH_FAIL.send_closed };
  }
  if (chat.botUserId !== BB_SHARED_BOT_USER_ID && Number(chat.botUserId) !== Number(u.id)) {
    const name = chat.expertName || chat.botName;
    return { ok: false, error: "other_expert", message: SH_FAIL.other_expert(name), expertName: name };
  }
  return { ok: true, chat };
}

export function shFailReasonFa(code: string | null | undefined): string {
  const c = String(code ?? "");
  if (c === "bot_off" || c === "no_send" || c === "token_missing" || c === "token_rejected") return SH_FAIL.bot_off;
  if (c === "forbidden" || c === "blocked" || c === "bot_blocked" || c === "user_deactivated") return SH_FAIL.forbidden;
  if (c === "rate_limited") return SH_FAIL.rate_limited;
  if (c === "file_too_big" || c === "file_missing" || c === "too_big") return SH_FAIL.file_too_big;
  return SH_FAIL.generic;
}
export function shRetryable(code: string | null | undefined): boolean {
  const c = String(code ?? "");
  return c === "rate_limited" || c === "bot_off" || c === "no_send" || c === "token_missing" || c === "network";
}

export function shRecentSend(customerId: number, messageId: number, now = new Date()): boolean {
  const since = new Date(now.getTime() - SH_DEDUPE_MS).toISOString();
  return Boolean(queryRow(
    "SELECT 1 x FROM sh_sends WHERE customer_id=? AND message_id=? AND status IN ('queued','sent','sending') AND created_at>=? LIMIT 1",
    [customerId, messageId, since]));
}

export function shChoiceLabel(planId: number | null | undefined): string {
  if (planId == null) return "";
  const p = queryRow<{ name: string | null; bank_name: string | null }>("SELECT name, bank_name FROM loan_plans WHERE id=?", [planId]);
  return p ? planChoiceLabel(p.name, p.bank_name) : "";
}

/* ---------------- outbox ---------------- */
let kick: () => void = () => {};
export const setShSendKick = (f: () => void) => { kick = f; };

export const shAutoKeyboard = (keyboard: string | null | undefined) => keyboard === "sh_auto";
export function shReplyMarkup(keyboard: string | null | undefined): Record<string, unknown> | null {
  if (!keyboard || !keyboard.startsWith("sh_start:")) return null;
  const url = keyboard.slice("sh_start:".length);
  if (!/^https:\/\/ble\.ir\/[A-Za-z0-9_]{3,64}\?start=[A-Za-z0-9_-]{16,128}$/.test(url)) return null;
  return { inline_keyboard: [[{ text: SH_REDIRECT_BUTTON, url }]] };
}

export function shQueueOut(o: {
  chatRow: number; botId: number; text: string; actorId: number | null;
  keyboard?: string | null; file?: { name: string; mime: string; size: number; rel: string; sendAs: string };
  auto?: boolean;
}): number {
  const kind = o.file ? (o.file.sendAs === "video" ? "video" : o.file.sendAs === "photo" ? "photo" : "document") : "text";
  const t = iso();
  const id = execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,file_name,mime,size,file_path,file_state,send_as,keyboard,status,author_user_id,created_at)
     VALUES(?,'out',?,?,?,?,?,?,?,?,?,'sending',?,?)`,
    [o.chatRow, kind, o.text, o.file?.name ?? null, o.file?.mime ?? null, o.file?.size ?? null, o.file?.rel ?? null,
      o.file ? "stored" : null, o.file?.sendAs ?? null, o.keyboard ?? null, o.actorId, t]);
  if (o.auto && !o.keyboard) o.keyboard = "sh_auto";
  const preview = o.auto ? "خودکار" : (o.text ? o.text.replace(/\s+/g, " ").slice(0, 80) : "فایل");
  executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [t, preview, o.chatRow]);
  kick();
  return Number(id);
}

export function shOnOutboxSettled(outMsgId: number, status: "sent" | "failed", errorCode: string | null, at = iso()) {
  const fa = status === "failed" ? shFailReasonFa(errorCode) : null;
  const retry = status === "failed" && shRetryable(errorCode) ? 1 : 0;
  executeChanges("UPDATE sh_sends SET status=?, fail_reason=?, retryable=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END WHERE out_msg_id=?",
    [status === "sent" ? "sent" : "failed", fa, retry, status, at, outMsgId]);
  executeChanges("UPDATE sh_redirect_items SET status=?, fail_reason=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END WHERE out_msg_id=?",
    [status === "sent" ? "sent" : "failed", fa, status, at, outMsgId]);
  maybeFinishCampaign();
}

function stageDoc(botId: number, srcAbs: string, name: string): string {
  const rel = path.join(String(botId), `sh-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80)}`);
  fs.mkdirSync(path.dirname(path.join(filesDir(), rel)), { recursive: true, mode: 0o700 });
  fs.copyFileSync(srcAbs, path.join(filesDir(), rel));
  fs.chmodSync(path.join(filesDir(), rel), 0o600);
  return rel;
}

export function shDeliverSend(sendId: number): void {
  if (!shSendOn()) return;
  const s = queryRow<any>("SELECT * FROM sh_sends WHERE id=?", [sendId]);
  if (!s || s.status !== "queued" || !s.chat_row) return;
  const docs: number[] = JSON.parse(s.doc_ids || "[]");
  const max = shBaleFileMaxBytes();
  const files: { name: string; mime: string; size: number; rel: string; sendAs: string }[] = [];
  for (const d of docs) {
    const row = queryRow<any>("SELECT original_name,mime,size_bytes,storage_path,file_type FROM sh_docs WHERE id=? AND archived=0", [d]);
    if (!row) continue;
    if (Number(row.size_bytes) > max) {
      executeChanges("UPDATE sh_sends SET status='failed', fail_reason=?, retryable=0 WHERE id=?", [SH_FAIL.file_too_big, sendId]);
      return;
    }
    files.push({
      name: row.original_name, mime: row.mime, size: Number(row.size_bytes),
      rel: stageDoc(Number(s.bot_id), row.storage_path, row.original_name),
      sendAs: row.file_type === "video" ? "video" : row.file_type === "image" ? "photo" : "document",
    });
  }
  const first = files[0];
  const outId = shQueueOut({
    chatRow: Number(s.chat_row), botId: Number(s.bot_id), text: s.body, actorId: s.user_id == null ? null : Number(s.user_id),
    file: first, auto: s.source === "auto",
  });
  executeChanges("UPDATE sh_sends SET out_msg_id=?, status='queued' WHERE id=?", [outId, sendId]);
  for (const f of files.slice(1)) {
    shQueueOut({ chatRow: Number(s.chat_row), botId: Number(s.bot_id), text: "", actorId: s.user_id == null ? null : Number(s.user_id), file: f, auto: s.source === "auto" });
  }
}

/* ---------------- today send (called from shSend after validation) ---------------- */
export function shApplySendRow(id: number, chat: ShChat) {
  executeChanges("UPDATE sh_sends SET chat_row=?, bot_id=? WHERE id=?", [chat.chatRow, chat.botId, id]);
  if (shSendOn()) shDeliverSend(id);
}

/* ---------------- connect (unified نفیس وام = bale_bots.user_id 0) ---------------- */
type GetMe = (token: string) => Promise<{ ok: true; bot: { id: string; name: string | null; username: string | null } } | { ok: false; error: "network" | "bad_token" | "bale_error" }>;
let getMeHook: GetMe | null = null;
export const setShGetMeForTests = (fn: GetMe | null) => { getMeHook = fn; };

async function defaultGetMe(token: string): ReturnType<GetMe> {
  const r = await baleCall<{ id: number; first_name?: string; username?: string; is_bot?: boolean }>(token, "getMe", {}, 15_000);
  if (r.ok) return { ok: true, bot: { id: String(r.result.id), name: r.result.first_name ?? null, username: r.result.username ?? null } };
  return { ok: false, error: r.network ? "network" : r.code === 401 || r.code === 404 ? "bad_token" : "bale_error" };
}
const runGetMe: GetMe = (token) => (getMeHook ?? defaultGetMe)(token);

export function shUnifiedBot(): BotRow | undefined {
  return queryRow<BotRow>("SELECT * FROM bale_bots WHERE user_id=?", [BB_SHARED_BOT_USER_ID]);
}
export function shTokenSaved(): boolean {
  const b = shUnifiedBot();
  return Boolean(b?.token_ct);
}
export function shConnectView() {
  const b = shUnifiedBot();
  const handle = (b?.bot_username || queryRow<{ handle: string | null }>("SELECT handle FROM sh_bots WHERE unified=1 AND network='bale'")?.handle || "").replace(/^@/, "");
  const tokenSaved = Boolean(b?.token_ct);
  const tested = Boolean(tokenSaved && b?.last_ok_at && b.status === "on");
  return {
    tokenSaved,
    tested,
    hasKey: baleBotHasKey(process.env),
    status: !tokenSaved ? "draft" : tested ? "connected" : "pending_test",
    username: tokenSaved ? (handle || null) : null,
    name: b?.bot_name || SH_BOT_NAME,
    connectedAt: b?.connected_at ?? null,
    lastOkAt: b?.last_ok_at ?? null,
  };
}

export async function shTestConnectToken(u: AuthUser, raw: unknown): Promise<{ ok: true; bot: { name: string | null; username: string | null } }> {
  if (!shConnectOn()) throw new ShError(409, "connect_disabled", "آزمایش اتصال در این نسخه خاموش است؛ هیچ کلیدی فرستاده یا ذخیره نشد.");
  if (!shIsManager(u)) throw new ShError(403, "forbidden", "این کار فقط برای مدیر فروش و مدیر سیستم است.");
  const token = String(raw ?? "").trim();
  if (!tokenShapeOk(token)) throw new ShError(400, "bad_token", "بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید و همین‌جا بچسبانید.", { field: "token" });
  const g = await runGetMe(token);
  if (!g.ok) throw new ShError(g.error === "network" ? 502 : 400, g.error, g.error === "network" ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید و همین‌جا بچسبانید.");
  return { ok: true, bot: { name: g.bot.name, username: g.bot.username } };
}

export async function shSaveConnectToken(u: AuthUser, raw: unknown): Promise<{ saved: true; username: string | null; name: string | null }> {
  if (!shConnectOn()) throw new ShError(409, "connect_disabled", "اتصال ربات در این نسخه خاموش است؛ کلید ذخیره نشد.", { field: "token" });
  if (!shIsManager(u)) throw new ShError(403, "forbidden", "این کار فقط برای مدیر فروش و مدیر سیستم است.");
  const token = String(raw ?? "").trim();
  if (!tokenShapeOk(token)) throw new ShError(400, "bad_token", "بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید و همین‌جا بچسبانید.", { field: "token" });
  if (!baleBotHasKey(process.env)) throw new ShError(503, "key_missing", "کلید رمزنگاری توکن روی سرور نیست؛ توکن ذخیره نشد.");
  const g = await runGetMe(token);
  if (!g.ok) throw new ShError(g.error === "network" ? 502 : 400, g.error, g.error === "network" ? "به بله وصل نشد. کمی بعد دوباره تست کنید." : "بله این توکن را نشناخت. توکن را دوباره از @botfather کپی کنید و همین‌جا بچسبانید.");
  const at = iso();
  let b = shUnifiedBot();
  if (!b) {
    const id = execute("INSERT INTO bale_bots(user_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?)", [BB_SHARED_BOT_USER_ID, "off", u.id, at, at]);
    b = botById(Number(id))!;
  }
  const sealed = sealBotToken(process.env, token, baleBotAad(b.id, BB_SHARED_BOT_USER_ID));
  executeChanges(
    `UPDATE bale_bots SET token_ct=?, token_key_id=?, bot_user_id=?, bot_username=?, bot_name=?, status='on', last_error=NULL, last_ok_at=?, updated_at=?,
      connected_at=COALESCE(connected_at,?) WHERE id=?`,
    [sealed.value, sealed.keyId, g.bot.id, g.bot.username, g.bot.name || SH_BOT_NAME, at, at, at, b.id]);
  executeChanges("UPDATE sh_bots SET handle=?, status='connected', connected_at=COALESCE(connected_at,?), updated_at=? WHERE unified=1 AND network='bale'",
    [g.bot.username, at, at]);
  shLog(u.id, "bot_connect", b.id, { saved: true });
  kick();
  return { saved: true, username: g.bot.username, name: g.bot.name || SH_BOT_NAME };
}

export async function shTestSavedToken(): Promise<{ ok: true; bot: { name: string | null; username: string | null } }> {
  const b = shUnifiedBot();
  if (!b?.token_ct) throw new ShError(409, "not_connected", "ربات نفیس وام هنوز وصل نشده است.");
  const tok = botToken(b);
  if (!tok) throw new ShError(503, "key_missing", "کلید رمزنگاری توکن روی سرور نیست؛ توکن ذخیره نشد.");
  const g = await runGetMe(tok);
  if (!g.ok) throw new ShError(g.error === "network" ? 502 : 400, g.error, "آزمایش اتصال ربات نفیس وام ناموفق بود.");
  executeChanges("UPDATE bale_bots SET last_ok_at=?, last_error=NULL, status='on' WHERE id=?", [iso(), b.id]);
  return { ok: true, bot: { name: g.bot.name, username: g.bot.username } };
}

/* ---------------- start-param auto-link ---------------- */
export function shNewStartToken(): string { return crypto.randomBytes(24).toString("base64url"); }
export function shBotStartUrl(token: string): string | null {
  const user = (shUnifiedBot()?.bot_username || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,64}$/.test(user)) return null;
  return `https://ble.ir/${user}?start=${token}`;
}
/** Honor /start <token> on the unified bot: link the chat to the customer and mark the token used. Never logs the token. */
export function shClaimStartParam(bot: { id: number; user_id: number }, chatRow: number, text: string | null | undefined): boolean {
  if (!isSharedCustomerBot(bot)) return false;
  const m = String(text ?? "").trim().match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+|_)([A-Za-z0-9_-]{16,128})$/);
  if (!m) return false;
  const item = queryRow<{ id: number; customer_id: number; used_at: string | null }>("SELECT id, customer_id, used_at FROM sh_redirect_items WHERE token=?", [m[1]]);
  if (!item) return false;
  const at = iso();
  const chat = queryRow<{ customer_id: number | null }>("SELECT customer_id FROM bale_bot_chats WHERE id=?", [chatRow]);
  if (chat && chat.customer_id == null) {
    executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method='sh_start', linked_at=?, match_note=NULL WHERE id=?", [item.customer_id, at, chatRow]);
  }
  if (!item.used_at) executeChanges("UPDATE sh_redirect_items SET used_at=?, used_chat_row=? WHERE id=?", [at, chatRow, item.id]);
  return true;
}

/* ---------------- bulk redirect ---------------- */
export type ShRedirectSkip = { reason: "already_on_nafis" | "blocked"; label: string; count: number };
const SKIP_LABEL: Record<ShRedirectSkip["reason"], string> = {
  already_on_nafis: "قبلاً ربات نفیس وام را شروع کرده",
  blocked: "ربات را بسته یا مسدود کرده",
};

function alreadyOnNafis(): Set<number> {
  const ids = queryRows<{ customer_id: number }>(
    `SELECT DISTINCT c.customer_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id
      WHERE c.customer_id IS NOT NULL AND b.user_id=?`, [BB_SHARED_BOT_USER_ID]);
  return new Set(ids.map((r) => Number(r.customer_id)));
}
function alreadyRedirected(): Set<number> {
  const ids = queryRows<{ customer_id: number }>("SELECT DISTINCT customer_id FROM sh_redirect_items WHERE status IN ('sent','queued')");
  return new Set(ids.map((r) => Number(r.customer_id)));
}

export type ShRedirectRecipient = { customerId: number; customerName: string; expertUserId: number; expertName: string; botId: number; chatRow: number };
export type ShRedirectPreview = {
  ready: boolean; disabledReason: string | null; tokenSaved: boolean; flagOn: boolean; alreadyDone: boolean; doneAt: string | null;
  recipientCount: number; recipients: ShRedirectRecipient[]; perBot: { expertUserId: number; expertName: string; botId: number; count: number }[];
  skipped: ShRedirectSkip[]; etaMinutes: number; perMinute: number; text: string; button: string;
};

export function shConnectTested(): boolean {
  const b = shUnifiedBot();
  return Boolean(b?.token_ct && b.last_ok_at && b.status === "on");
}
function shUnifiedUsernameOk(): boolean {
  return /^[A-Za-z0-9_]{3,64}$/.test((shUnifiedBot()?.bot_username || "").replace(/^@/, ""));
}
/** Honest disabled copy: no token → after connect; token not tested / no username → waiting on test; tested but flag off → waiting to prepare. */
export function shRedirectDisabledReason(): string | null {
  if (shRedirectCampaignDone().done) return null;
  if (!shTokenSaved()) return "پس از اتصال ربات نفیس وام";
  if (!shConnectTested() || !shUnifiedUsernameOk()) return "منتظر آزمایش اتصال";
  if (!shRedirectOn()) return "منتظر آماده‌سازی ارسال انتقال";
  return null;
}

export function shRedirectCampaignDone(): { done: boolean; finishedAt: string | null } {
  const row = queryRow<{ finished_at: string | null }>("SELECT finished_at FROM sh_redirect_campaigns WHERE status='done' ORDER BY id DESC LIMIT 1");
  return { done: Boolean(row), finishedAt: row?.finished_at ?? null };
}

export function shBuildRedirectPreview(): ShRedirectPreview {
  ensureSocialHubSchema();
  const flagOn = shRedirectOn();
  const tokenSaved = shTokenSaved();
  const done = shRedirectCampaignDone();
  const onNafis = alreadyOnNafis();
  const sent = alreadyRedirected();
  const latest = queryRows<any>(
    `SELECT c.customer_id, c.id chat_row, c.last_at, b.id bot_id, b.user_id expert_user_id,
            cu.name customer_name, u.full_name, u.username
       FROM bale_bot_chats c
       JOIN bale_bots b ON b.id=c.bot_id
       JOIN customers cu ON cu.id=c.customer_id
       LEFT JOIN users u ON u.id=b.user_id
      WHERE c.customer_id IS NOT NULL AND b.user_id<>?
        AND c.id = (
          SELECT c2.id FROM bale_bot_chats c2 JOIN bale_bots b2 ON b2.id=c2.bot_id
           WHERE c2.customer_id=c.customer_id
           ORDER BY COALESCE(c2.last_at,'') DESC, c2.id DESC LIMIT 1
        )`, [BB_SHARED_BOT_USER_ID]);
  const skippedMap: Record<ShRedirectSkip["reason"], number> = { already_on_nafis: 0, blocked: 0 };
  const recipients: ShRedirectRecipient[] = [];
  for (const r of latest) {
    const cid = Number(r.customer_id);
    if (onNafis.has(cid) || sent.has(cid)) { skippedMap.already_on_nafis++; continue; }
    if (shChatBlocked(Number(r.chat_row))) { skippedMap.blocked++; continue; }
    const expertName = Number(r.expert_user_id) === BB_SHARED_BOT_USER_ID ? SH_BOT_NAME : nameOf({ full_name: r.full_name, username: r.username });
    recipients.push({
      customerId: cid, customerName: r.customer_name || "مشتری",
      expertUserId: Number(r.expert_user_id), expertName, botId: Number(r.bot_id), chatRow: Number(r.chat_row),
    });
  }
  const byBot = new Map<string, ShRedirectPreview["perBot"][number]>();
  for (const r of recipients) {
    const k = `${r.botId}`;
    const cur = byBot.get(k) ?? { expertUserId: r.expertUserId, expertName: r.expertName, botId: r.botId, count: 0 };
    cur.count++;
    byBot.set(k, cur);
  }
  const perMinute = shRedirectPerMinute();
  const etaMinutes = Math.max(1, Math.ceil(recipients.length / perMinute));
  const skipped: ShRedirectSkip[] = (Object.keys(skippedMap) as ShRedirectSkip["reason"][])
    .filter((k) => skippedMap[k] > 0)
    .map((k) => ({ reason: k, label: SKIP_LABEL[k], count: skippedMap[k] }));
  const urlOk = Boolean((shUnifiedBot()?.bot_username || "").replace(/^@/, ""));
  return {
    ready: flagOn && tokenSaved && shConnectTested() && urlOk && !done.done,
    disabledReason: shRedirectDisabledReason(),
    tokenSaved, flagOn, alreadyDone: done.done, doneAt: done.finishedAt,
    recipientCount: recipients.length, recipients, perBot: [...byBot.values()].sort((a, b) => a.expertUserId - b.expertUserId),
    skipped, etaMinutes, perMinute, text: SH_REDIRECT_TEXT, button: SH_REDIRECT_BUTTON,
  };
}

export async function shRedirectReadyForStart(u: AuthUser): Promise<ShRedirectPreview> {
  if (!shIsSuperAdmin(u)) throw new ShError(403, "forbidden", "ارسال پیام انتقال فقط برای مدیر سیستم است.");
  if (!shRedirectOn()) throw new ShError(404, "not_found", "این کار خاموش است.");
  const p = shBuildRedirectPreview();
  if (!p.tokenSaved) throw new ShError(409, "not_connected", "پس از اتصال ربات نفیس وام");
  await shTestSavedToken();
  return shBuildRedirectPreview();
}

export function shStartRedirect(u: AuthUser, body: { seen?: boolean; count?: unknown }, preview = shBuildRedirectPreview()): { campaignId: number; queued: number } {
  if (!shIsSuperAdmin(u)) throw new ShError(403, "forbidden", "ارسال پیام انتقال فقط برای مدیر سیستم است.");
  if (!shRedirectOn()) throw new ShError(404, "not_found", "این کار خاموش است.");
  if (!preview.tokenSaved || !preview.ready) throw new ShError(409, "not_connected", "پس از اتصال ربات نفیس وام");
  if (preview.alreadyDone) throw new ShError(409, "already_done", "پیام انتقال قبلاً ارسال شده است.");
  if (queryRow("SELECT 1 x FROM sh_redirect_campaigns WHERE status='running'")) throw new ShError(409, "running", "ارسال پیام انتقال همین حالا در جریان است.");
  if (body?.seen !== true) throw new ShError(400, "confirm_required", "متن و تعداد گیرنده‌ها را تأیید کنید.");
  const typed = shParseCount(body?.count);
  if (typed == null || typed !== preview.recipientCount) throw new ShError(400, "count_mismatch", "تعداد واردشده با تعداد گیرنده‌ها یکی نیست.");
  const fresh = shBuildRedirectPreview();
  if (fresh.recipientCount !== preview.recipientCount) throw new ShError(409, "count_changed", "تعداد گیرنده‌ها عوض شده است؛ از مرحلهٔ اول دوباره شروع کنید.", { recipientCount: fresh.recipientCount });
  if (!fresh.recipients.length) throw new ShError(409, "empty", "گیرنده‌ای برای ارسال نیست.");
  const at = iso();
  const campaignId = Number(execute(
    "INSERT INTO sh_redirect_campaigns(started_by,started_at,status,recipient_count,snapshot) VALUES(?,?,?,?,?)",
    [u.id, at, "running", fresh.recipientCount, JSON.stringify(fresh.recipients.map((r) => r.customerId))]));
  let queued = 0;
  for (const r of fresh.recipients) {
    const token = shNewStartToken();
    const n = executeChanges(
      "INSERT OR IGNORE INTO sh_redirect_items(campaign_id,customer_id,from_chat_row,from_bot_id,expert_user_id,token,status,created_at) VALUES(?,?,?,?,?,?,'queued',?)",
      [campaignId, r.customerId, r.chatRow, r.botId, r.expertUserId, token, at]);
    queued += n;
  }
  shLog(u.id, "redirect_start", campaignId, { queued });
  return { campaignId, queued };
}

/** Drain up to `limit` queued redirect items into the outbox. Stub-friendly: no network. Ghasemi's bot is allowed here only. */
export function shRedirectTick(limit = 20): { queued: number; started: number } {
  if (!shRedirectOn() || !shTokenSaved()) return { queued: 0, started: 0 };
  const items = queryRows<any>(
    `SELECT i.*, c.name customer_name, u.full_name, u.username
       FROM sh_redirect_items i
       JOIN sh_redirect_campaigns g ON g.id=i.campaign_id AND g.status='running'
       JOIN customers c ON c.id=i.customer_id
       LEFT JOIN users u ON u.id=i.expert_user_id
      WHERE i.status='queued' ORDER BY i.id LIMIT ?`, [limit]);
  let started = 0;
  for (const i of items) {
    const url = shBotStartUrl(i.token);
    if (!url) {
      executeChanges("UPDATE sh_redirect_items SET status='failed', fail_reason=? WHERE id=?", [SH_FAIL.bot_off, i.id]);
      continue;
    }
    const expert = nameOf({ full_name: i.full_name, username: i.username });
    const text = shRender(SH_REDIRECT_TEXT, { customer: i.customer_name, expert, plan: "" }).slice(0, SH_TEXT_MAX);
    const outId = shQueueOut({
      chatRow: Number(i.from_chat_row), botId: Number(i.from_bot_id), text, actorId: null,
      keyboard: `sh_start:${url}`,
    });
    executeChanges("UPDATE sh_redirect_items SET out_msg_id=?, status='queued' WHERE id=?", [outId, i.id]);
    started++;
  }
  maybeFinishCampaign();
  return { queued: items.length, started };
}

export function shStopRedirect(u: AuthUser): { stopped: number } {
  if (!shIsSuperAdmin(u)) throw new ShError(403, "forbidden", "ارسال پیام انتقال فقط برای مدیر سیستم است.");
  const run = queryRow<{ id: number }>("SELECT id FROM sh_redirect_campaigns WHERE status='running' ORDER BY id DESC LIMIT 1");
  if (!run) throw new ShError(409, "not_running", "ارسالی در جریان نیست.");
  const at = iso();
  const n = executeChanges("UPDATE sh_redirect_items SET status='cancelled' WHERE campaign_id=? AND status='queued' AND out_msg_id IS NULL", [run.id]);
  executeChanges("UPDATE sh_redirect_campaigns SET status='stopped', finished_at=? WHERE id=?", [at, run.id]);
  shLog(u.id, "redirect_stop", run.id, { stopped: n });
  return { stopped: n };
}

function maybeFinishCampaign() {
  for (const g of queryRows<{ id: number }>("SELECT id FROM sh_redirect_campaigns WHERE status='running'")) {
    const left = queryRow<{ n: number }>("SELECT COUNT(*) n FROM sh_redirect_items WHERE campaign_id=? AND status='queued'", [g.id])?.n ?? 0;
    if (left === 0) executeChanges("UPDATE sh_redirect_campaigns SET status='done', finished_at=COALESCE(finished_at,?) WHERE id=?", [iso(), g.id]);
  }
}

export function shRedirectStatus() {
  const g = queryRow<any>("SELECT * FROM sh_redirect_campaigns ORDER BY id DESC LIMIT 1");
  if (!g) return { campaign: null, counts: { sent: 0, queued: 0, failed: 0, cancelled: 0 }, failures: [] as { customerName: string; reason: string }[] };
  const counts = { sent: 0, queued: 0, failed: 0, cancelled: 0 };
  for (const r of queryRows<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM sh_redirect_items WHERE campaign_id=? GROUP BY status", [g.id])) {
    if (r.status in counts) (counts as any)[r.status] = Number(r.n);
  }
  const failures = queryRows<{ id: number; name: string; fail_reason: string | null }>(
    `SELECT c.id, c.name, i.fail_reason FROM sh_redirect_items i JOIN customers c ON c.id=i.customer_id
      WHERE i.campaign_id=? AND i.status='failed' ORDER BY i.id`, [g.id])
    .map((r) => ({ customerId: Number(r.id), customerName: r.name, reason: r.fail_reason || SH_FAIL.generic }));
  return {
    campaign: { id: Number(g.id), status: g.status, startedAt: g.started_at, finishedAt: g.finished_at, recipientCount: Number(g.recipient_count) },
    counts, failures,
  };
}

export function shRetrySend(u: AuthUser, sendId: number) {
  const s = queryRow<any>("SELECT * FROM sh_sends WHERE id=?", [sendId]);
  if (!s) throw new ShError(404, "not_found", "این پیام پیدا نشد.");
  if (!shRetryable(s.status === "failed" ? reasonToCode(s.fail_reason) : null) && Number(s.retryable) !== 1) {
    throw new ShError(409, "not_retryable", "این پیام برای تلاش دوباره نیست.");
  }
  if (!shSendOn()) throw new ShError(409, "send_disabled", "ارسال واقعی خاموش است.");
  const gate = shSendGate(u, Number(s.customer_id));
  if (!gate.ok) throw new ShError(409, gate.error, gate.message);
  executeChanges("UPDATE sh_sends SET status='queued', fail_reason=NULL, retryable=0, out_msg_id=NULL, chat_row=?, bot_id=? WHERE id=?",
    [gate.chat.chatRow, gate.chat.botId, sendId]);
  shDeliverSend(sendId);
  shLog(u.id, "send_retry", sendId, { customerId: Number(s.customer_id) });
  return { id: sendId, status: "queued" as const };
}
function reasonToCode(fa: string | null): string | null {
  if (!fa) return null;
  if (fa === SH_FAIL.bot_off) return "bot_off";
  if (fa === SH_FAIL.rate_limited) return "rate_limited";
  if (fa === SH_FAIL.forbidden) return "forbidden";
  if (fa === SH_FAIL.file_too_big) return "file_too_big";
  return "other";
}

setShSendHooks({
  shReplyMarkup, shOnOutboxSettled, shClaimStartParam, shAutoKeyboard, shFailReasonFa, shRetryable,
  shRedirectTick: () => shRedirectTick(Math.max(1, Math.ceil(shRedirectPerMinute() / 6))),
});
void shOn;
void botLive;
setShSendModule({
  SH_DEDUPE_MS, shBaleFileMaxBytes, shDeliverSend, shIsReadonlyBotUser, shLatestChat, shRecentSend, shSendGate,
} as unknown as Parameters<typeof setShSendModule>[0]);
// The object is a subset; setShSendModule only needs the functions social-hub.ts calls.

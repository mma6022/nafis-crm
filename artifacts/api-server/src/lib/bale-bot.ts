/**
 * «گفتگوی بله داخل پنل کارشناس» (Bale Bot API inbox) — v1.0, design: nafis-design/screens/bale (Armita v1.0) + Mohammad's decisions.
 *
 * One Bale bot per sales expert. Customers message the expert's bot; the expert (and admins / sales managers, author shown
 * internally only — the customer always sees the bot) answers from the CRM. NOTHING is ever sent automatically: no greeting,
 * no auto-reply, no keyboard removal. Every outbound message is one explicit click by a CRM user.
 *
 * Flags (call_queue_settings, absent/≠'1' = OFF):
 *   flag.bale_bot                 master. OFF → every /api/bale-bot route falls through (404 as before), no schema is created,
 *                                 the supervisor does ONE settings SELECT per tick and nothing else: no poller, no network.
 *   flag.bale_bot.user.<users.id> per user: that user sees the inbox / admin page; that expert's bot is polled only while ON.
 * Settings (same table): bale_bot.no_send_sp = comma list of salesperson ids whose bot never sends (default "4": Ghasemi,
 *   «فعلاً هیچی نفرست»).
 *
 * Bale (docs.bale.ai): https://tapi.bale.ai/bot<token>/<method>; getUpdates long-poll (offset / limit ≤100 / timeout);
 * getFile links last 1 h → every inbound file ≤20 MB is copied into BALE_BOT_FILES_DIR; send: text ≤4096, photo ≤10 MB,
 * file ≤50 MB, voice = ogg ≤1 MB (else sent as a file); delete own message ≤48 h; 429 carries parameters.retry_after.
 * No delivered/read receipts exist → statuses are sending / sent / failed only.
 *
 * Tokens: only via the admin wizard (masked field) → sealed with bale-bot-crypto.ts (own key file, AAD = row + expert).
 * A token is never returned, never logged, never in argv, never in an error: every error text passes redact().
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { isSalesManagerUser, roleSql } from "./sales-manager";
import { baleBotAad, openBotToken, type BotKeyEnv } from "./bale-bot-crypto";
import * as baleContact from "./bale-contact";
import * as customerBale from "./customer-bale";
import { isTraineeSalesperson } from "./multi-team";

export const BB_FLAG = "flag.bale_bot";
export const bbUserFlag = (userId: number) => `${BB_FLAG}.user.${userId}`;
export const BB_EXCLUDED_USER_IDS = [29];
export const BB_TRAINEE_SALESPERSON_IDS = [5, 19, 20];
/** Non-salesperson logins that get their own Bale bot inbox exactly like an expert (Bale inbox only; role/permissions untouched).
 * 7 = Sarina Tajik (registrar) — Mohammad, PM card t826s3343, 2026-11-04. */
export const BB_EXTRA_EXPERT_USER_IDS = [7];
export const BB_LIMITS = { textMax: 4096, inMaxBytes: 20 * 1024 * 1024, photoBytes: 10 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, voiceBytes: 1024 * 1024, deleteHours: 48 } as const;
export const BB_API = "https://tapi.bale.ai";
export const ASK_CONTACT_TEXT = "بی‌زحمت شماره‌تون رو با دکمه‌ی زیر بفرستید تا پرونده‌تون رو پیدا کنم.";
export const ASK_CONTACT_BUTTON = "اشتراک شماره";

/* ---------------- redaction ---------------- */
const TOKEN_RE = /\d{3,15}:[A-Za-z0-9_-]{16,}/g;
/** Removes bot<token> from URLs and anything token-shaped; also every exact token passed in. */
export function redact(s: unknown, ...tokens: (string | null | undefined)[]): string {
  let t = String(s ?? "");
  for (const k of tokens) if (k && k.length >= 8) t = t.split(k).join("<redacted>");
  return t.replace(/bot[^/\s"']+/gi, m => (/\d+:/.test(m) ? "bot<redacted>" : m)).replace(TOKEN_RE, "<redacted>").slice(0, 300);
}
export const tokenShapeOk = (t: string) => /^\d{3,15}:[A-Za-z0-9_-]{16,128}$/.test(t);

/* ---------------- flags ---------------- */
const setting = (k: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value; } catch { return undefined; } };
export const bbMasterOn = () => setting(BB_FLAG) === "1";
export const bbUserOn = (userId: number) => setting(bbUserFlag(userId)) === "1";
export const bbNoSendSp = (): number[] => (setting("bale_bot.no_send_sp") ?? "4").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);

/* ---------------- schema (lazy, only while ON) ---------------- */
let schemaReady = false;
export function ensureBaleBotSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS bale_bots(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, token_ct TEXT, token_key_id TEXT,
      bot_user_id TEXT, bot_username TEXT, bot_name TEXT, status TEXT NOT NULL DEFAULT 'off', next_offset INTEGER NOT NULL DEFAULT 0,
      backlog_skipped INTEGER NOT NULL DEFAULT 0, connected_at TEXT, last_poll_at TEXT, last_ok_at TEXT, last_error TEXT,
      created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bale_bot_updates(bot_id INTEGER NOT NULL, update_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(bot_id, update_id));
    CREATE TABLE IF NOT EXISTS bale_bot_chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, chat_id TEXT NOT NULL, bale_user_id TEXT, first_name TEXT, last_name TEXT,
      username TEXT, bio TEXT, profile_checked INTEGER NOT NULL DEFAULT 0, customer_id INTEGER, link_method TEXT, linked_at TEXT, linked_by INTEGER,
      verified_phone TEXT, lead_phone_verified INTEGER, contact_asked_at TEXT, match_note TEXT, unread INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_preview TEXT, last_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE(bot_id, chat_id));
    CREATE INDEX IF NOT EXISTS ix_bbc_customer ON bale_bot_chats(customer_id);
    CREATE INDEX IF NOT EXISTS ix_bbc_last ON bale_bot_chats(bot_id, last_at);
    CREATE TABLE IF NOT EXISTS bale_bot_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_row INTEGER NOT NULL, dir TEXT NOT NULL, bale_message_id INTEGER, kind TEXT NOT NULL,
      text TEXT, file_id TEXT, file_name TEXT, mime TEXT, size INTEGER, duration INTEGER, file_path TEXT, file_state TEXT,
      contact_phone TEXT, contact_name TEXT, contact_own INTEGER, lat REAL, lng REAL, reply_to INTEGER, send_as TEXT, keyboard TEXT,
      status TEXT, error_code TEXT, retry_at TEXT, tries INTEGER NOT NULL DEFAULT 0, edited_at TEXT, deleted_at TEXT, author_user_id INTEGER,
      sent_at TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_bbm_chat ON bale_bot_messages(chat_row, id);
    CREATE INDEX IF NOT EXISTS ix_bbm_status ON bale_bot_messages(status, retry_at);
    CREATE TABLE IF NOT EXISTS bale_bot_notices(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, chat_row INTEGER, customer_id INTEGER, actor_user_id INTEGER,
      at TEXT NOT NULL, seen_at TEXT);
    CREATE INDEX IF NOT EXISTS ix_bbn_user ON bale_bot_notices(user_id, seen_at);
    CREATE TABLE IF NOT EXISTS bale_bot_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, bot_id INTEGER, chat_row INTEGER, customer_id INTEGER,
      action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT);
  `);
  try { crmDb.exec("ALTER TABLE bale_bot_chats ADD COLUMN lead_phone_verified INTEGER"); } catch { /* already there */ }
  schemaReady = true;
}
export const _resetSchemaFlagForTests = () => { schemaReady = false; };

/** Audit: ids, codes and counts only — never a token, phone or message text. */
export function bbLog(o: { userId?: number | null; botId?: number | null; chatRow?: number | null; customerId?: number | null; action: string; outcome: string; detail?: Record<string, string | number | boolean | null> }) {
  try {
    execute("INSERT INTO bale_bot_log(at,user_id,bot_id,chat_row,customer_id,action,outcome,detail) VALUES(?,?,?,?,?,?,?,?)",
      [new Date().toISOString(), o.userId ?? null, o.botId ?? null, o.chatRow ?? null, o.customerId ?? null, o.action, o.outcome, o.detail ? redact(JSON.stringify(o.detail)) : null]);
  } catch { /* never breaks the caller */ }
}

/* ---------------- in-app notices (v1.1: mgr_sent / chat_mgr, link_other / file_other). No push in v1.0. ---------------- */
export type NoticeKind = "mgr_wrote" | "linked_other" | "file_other";
export function bbNotice(userId: number | null | undefined, kind: NoticeKind, o: { chatRow?: number; customerId?: number | null; actor?: number | null } = {}) {
  if (!userId || BB_EXCLUDED_USER_IDS.includes(userId)) return;
  // one open notice per (user, kind, chat): repeated manager messages refresh it instead of piling up
  const open = queryRow<{ id: number }>("SELECT id FROM bale_bot_notices WHERE user_id=? AND kind=? AND chat_row IS ? AND seen_at IS NULL", [userId, kind, o.chatRow ?? null]);
  if (open) executeChanges("UPDATE bale_bot_notices SET at=?, actor_user_id=? WHERE id=?", [new Date().toISOString(), o.actor ?? null, open.id]);
  else execute("INSERT INTO bale_bot_notices(user_id,kind,chat_row,customer_id,actor_user_id,at) VALUES(?,?,?,?,?,?)", [userId, kind, o.chatRow ?? null, o.customerId ?? null, o.actor ?? null, new Date().toISOString()]);
}
/** Users who own a customer's file (salesperson login(s) of customers.salesperson_id). */
export const fileOwnerUsers = (customerId: number) => queryRows<{ id: number }>(
  "SELECT u.id FROM users u JOIN customers c ON c.salesperson_id=u.salesperson_id WHERE c.id=? AND u.role='salesperson' AND u.active=1", [customerId]).map(r => r.id);

/* ---------------- users / access ---------------- */
export type BbUser = { id: number; role: string; base_role: string; salesperson_id: number | null; active: number; full_name: string | null; username: string };
export const bbUser = (id: number) => queryRow<BbUser>(`SELECT id,${roleSql()} AS role,role AS base_role,salesperson_id,active,full_name,username FROM users WHERE id=?`, [id]);
export const nameOf = (u: { full_name?: string | null; username?: string; id: number } | undefined | null) => u ? (u.full_name || u.username || `کاربر ${u.id}`) : null;
export function isBotExpert(u: BbUser | undefined | null): boolean {
  if (!u || u.active === 0 || BB_EXCLUDED_USER_IDS.includes(u.id)) return false;
  if (BB_EXTRA_EXPERT_USER_IDS.includes(u.id)) return true;
  return u.role === "salesperson" && !!u.salesperson_id && !isTraineeSalesperson(Number(u.salesperson_id));
}
/** "all" = admin + sales manager (read + write every chat); "own" = an expert's own bot; null = no access. Needs both flags. */
export function bbView(u: BbUser | undefined | null): "all" | "own" | null {
  if (!u || u.active === 0 || BB_EXCLUDED_USER_IDS.includes(u.id) || !bbMasterOn() || !bbUserOn(u.id)) return null;
  if (u.role === "admin") return "all";
  return isBotExpert(u) ? "own" : null;
}
export const bbCanManage = (u: BbUser | undefined | null) => bbView(u) === "all";

/* ---------------- Bale HTTP (fetch is replaceable for tests; the URL never leaves this function) ---------------- */
type FetchLike = (url: string, init?: any) => Promise<Response>;
let fetchImpl: FetchLike = (u, i) => fetch(u, i);
export const setBaleBotFetch = (f: FetchLike | null) => { fetchImpl = f ?? ((u, i) => fetch(u, i)); };
export type ApiResult<T = any> = { ok: true; result: T } | { ok: false; code: number; description: string; retryAfter: number | null; network?: boolean };
export async function baleCall<T = any>(token: string, method: string, body?: Record<string, unknown> | FormData, timeoutMs = 20_000): Promise<ApiResult<T>> {
  const url = `${BB_API}/bot${token}/${method}`;
  try {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const r = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: isForm ? undefined : { "content-type": "application/json" }, body: isForm ? body : JSON.stringify(body ?? {}) });
    const j: any = await r.json().catch(() => null);
    if (j && j.ok === true) return { ok: true, result: j.result as T };
    return { ok: false, code: Number(j?.error_code ?? r.status) || r.status, description: redact(j?.description ?? `http_${r.status}`, token),
      retryAfter: Number(j?.parameters?.retry_after) > 0 ? Number(j.parameters.retry_after) : null };
  } catch (e: any) {
    return { ok: false, code: 0, description: redact(e?.name === "TimeoutError" ? "timeout" : e?.message ?? "network", token), retryAfter: null, network: true };
  }
}
/** Streams https://tapi.bale.ai/file/bot<token>/<file_path> into dest, capped at maxBytes. */
async function baleDownload(token: string, filePath: string, dest: string, maxBytes: number): Promise<"ok" | "too_big" | "error"> {
  const url = `${BB_API}/file/bot${token}/${filePath.replace(/^\/+/, "")}`;
  try {
    const r = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(120_000) });
    if (!r.ok || !r.body) return "error";
    const len = Number(r.headers.get("content-length") ?? 0); if (len > maxBytes) return "too_big";
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = dest + ".part"; const fd = fs.openSync(tmp, "w", 0o600); let total = 0;
    try {
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength; if (total > maxBytes) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); return "too_big"; }
        fs.writeSync(fd, chunk);
      }
    } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
    fs.renameSync(tmp, dest); return "ok";
  } catch { return "error"; }
}

/* ---------------- environment ---------------- */
export type BbEnv = BotKeyEnv & { BALE_BOT_FILES_DIR?: string };
let envImpl: () => BbEnv = () => process.env as BbEnv;
export const setBaleBotEnv = (f: () => BbEnv) => { envImpl = f; };
export const filesDir = () => envImpl().BALE_BOT_FILES_DIR || path.join(path.dirname(path.resolve(process.env.CRM_DATABASE_PATH || "crm.db")), "bale-bot-files");

type BotRow = { id: number; user_id: number; token_ct: string | null; token_key_id: string | null; bot_user_id: string | null; bot_username: string | null; bot_name: string | null;
  status: string; next_offset: number; backlog_skipped: number; connected_at: string | null; last_poll_at: string | null; last_ok_at: string | null; last_error: string | null };
export const botById = (id: number) => queryRow<BotRow>("SELECT * FROM bale_bots WHERE id=?", [id]);
export const botOfUser = (userId: number) => queryRow<BotRow>("SELECT * FROM bale_bots WHERE user_id=?", [userId]);
export function botToken(b: BotRow): string | null {
  if (!b.token_ct) return null;
  try {
    const o = openBotToken(envImpl(), b.token_ct, baleBotAad(b.id, b.user_id));
    if (o.rotated) executeChanges("UPDATE bale_bots SET token_ct=?, token_key_id=? WHERE id=?", [o.rotated.value, o.rotated.keyId, b.id]);
    return o.plaintext;
  } catch { return null; }
}
/** Sentinel users.id for the shared «نفیس وام» customer bot (no owner expert). */
export const BB_SHARED_BOT_USER_ID = 0;
export const isSharedCustomerBot = (b: { user_id: number } | null | undefined) => !!b && Number(b.user_id) === BB_SHARED_BOT_USER_ID;
export const botSends = (b: BotRow) => {
  if (isSharedCustomerBot(b)) return true;
  const u = bbUser(b.user_id); return !!u && !bbNoSendSp().includes(Number(u.salesperson_id));
};
export const botLive = (b: BotRow) => {
  if (isSharedCustomerBot(b)) return b.status === "on" && !!b.token_ct && bbMasterOn();
  return b.status === "on" && !!b.token_ct && bbMasterOn() && bbUserOn(b.user_id) && isBotExpert(bbUser(b.user_id));
};

/* ---------------- inbound ---------------- */
const now = () => new Date().toISOString();
const safeName = (s: string) => String(s || "file").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80) || "file";
export const normPhone = (raw: unknown): string | null => {
  let s = String(raw ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^\d+]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3); else if (s.startsWith("0098")) s = "0" + s.slice(4); else if (/^98\d{10}$/.test(s)) s = "0" + s.slice(2); else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
};
const PREVIEW: Record<string, string> = { photo: "عکس", video: "ویدیو", animation: "GIF", voice: "پیام صوتی", audio: "فایل صوتی", document: "فایل", sticker: "استیکر", contact: "شماره", location: "موقعیت مکانی" };
const preview = (kind: string, text: string | null) => (text ? text.replace(/\s+/g, " ").slice(0, 80) : PREVIEW[kind] ?? "پیام");

type Parsed = { kind: string; text: string | null; fileId?: string; fileName?: string | null; mime?: string | null; size?: number | null; duration?: number | null;
  contact?: { phone: string | null; name: string; userId: string | null }; lat?: number; lng?: number };
function parseMessage(m: any): Parsed {
  const cap = m.caption ?? null;
  if (typeof m.text === "string") return { kind: "text", text: m.text };
  if (Array.isArray(m.photo) && m.photo.length) {
    const best = [...m.photo].sort((a, b) => (b.file_size ?? (b.width * b.height || 0)) - (a.file_size ?? (a.width * a.height || 0)))[0];
    return { kind: "photo", text: cap, fileId: best.file_id, size: best.file_size ?? null, mime: "image/jpeg", fileName: "photo.jpg" };
  }
  for (const k of ["voice", "audio", "video", "animation", "document", "sticker"] as const) if (m[k]) {
    const f = m[k];
    return { kind: k, text: cap, fileId: f.file_id, size: f.file_size ?? null, mime: f.mime_type ?? (k === "voice" ? "audio/ogg" : k === "sticker" ? "image/webp" : null),
      fileName: f.file_name ?? (k === "voice" ? "voice.ogg" : k === "sticker" ? "sticker.webp" : k === "video" ? "video.mp4" : null), duration: f.duration ?? null };
  }
  if (m.contact) return { kind: "contact", text: null, contact: { phone: normPhone(m.contact.phone_number), name: [m.contact.first_name, m.contact.last_name].filter(Boolean).join(" "), userId: m.contact.user_id != null ? String(m.contact.user_id) : null } };
  if (m.location) return { kind: "location", text: null, lat: Number(m.location.latitude), lng: Number(m.location.longitude) };
  return { kind: "other", text: cap };
}

/** Matching rule (Mohammad): the phone must be the sender's own (contact.user_id == from.id). Then: own customer of the bot's
 * expert first; otherwise the one customer with that mobile even if another expert owns it (attached to that file). */
export function matchPhone(phone: string, ownerSp: number | null): { customerId: number; own: boolean } | { many: true } | null {
  const rows = queryRows<{ id: number; salesperson_id: number | null }>("SELECT id,salesperson_id FROM customers WHERE phone=? AND merged_into_customer_id IS NULL ORDER BY id", [phone]);
  if (!rows.length) return null;
  const own = rows.filter(r => ownerSp != null && r.salesperson_id === ownerSp);
  if (own.length === 1) return { customerId: own[0].id, own: true };
  if (own.length > 1 || rows.length > 1) return { many: true };
  return { customerId: rows[0].id, own: false };
}

/** Stores one update (inside a transaction). Returns ids of messages that still need their file copied. */
export function storeUpdate(bot: BotRow, u: any): number[] {
  const t = now();
  if (!Number.isSafeInteger(u?.update_id)) return [];
  if (!executeChanges("INSERT OR IGNORE INTO bale_bot_updates(bot_id,update_id,at) VALUES(?,?,?)", [bot.id, u.update_id, t])) return [];
  const edited = !u.message && u.edited_message; const m = u.message ?? u.edited_message;
  if (!m || m.chat?.type !== "private" || !m.from || m.from.is_bot) return [];
  const chatId = String(m.chat.id), fromId = String(m.from.id);
  let c = queryRow<{ id: number; customer_id: number | null }>("SELECT id,customer_id FROM bale_bot_chats WHERE bot_id=? AND chat_id=?", [bot.id, chatId]);
  if (!c) {
    const id = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,bale_user_id,first_name,last_name,username,created_at) VALUES(?,?,?,?,?,?,?)",
      [bot.id, chatId, fromId, m.from.first_name ?? null, m.from.last_name ?? null, m.from.username ?? null, t]);
    c = { id, customer_id: null }; bbLog({ botId: bot.id, chatRow: id, action: "chat.new", outcome: "ok" });
  } else executeChanges("UPDATE bale_bot_chats SET first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name), username=COALESCE(?,username) WHERE id=?",
    [m.from.first_name ?? null, m.from.last_name ?? null, m.from.username ?? null, c.id]);
  const p = parseMessage(m);
  if (edited) {
    executeChanges("UPDATE bale_bot_messages SET text=?, edited_at=? WHERE chat_row=? AND dir='in' AND bale_message_id=?", [p.text, t, c.id, m.message_id]);
    return [];
  }
  const replyTo = m.reply_to_message?.message_id != null
    ? queryRow<{ id: number }>("SELECT id FROM bale_bot_messages WHERE chat_row=? AND bale_message_id=?", [c.id, m.reply_to_message.message_id])?.id ?? null : null;
  const own = p.contact ? (p.contact.userId != null && p.contact.userId === fromId ? 1 : 0) : null;
  const fileState = p.fileId ? (p.size != null && p.size > BB_LIMITS.inMaxBytes ? "too_big" : "pending") : null;
  const mid = execute(`INSERT INTO bale_bot_messages(chat_row,dir,bale_message_id,kind,text,file_id,file_name,mime,size,duration,file_state,contact_phone,contact_name,contact_own,lat,lng,reply_to,created_at)
    VALUES(?,'in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [c.id, m.message_id ?? null, p.kind, p.text, p.fileId ?? null, p.fileName ?? null, p.mime ?? null, p.size ?? null, p.duration ?? null, fileState,
    p.contact?.phone ?? null, p.contact?.name ?? null, own, p.lat ?? null, p.lng ?? null, replyTo, t]);
  executeChanges("UPDATE bale_bot_chats SET unread=unread+1, last_at=?, last_preview=?, last_out=0 WHERE id=?", [t, preview(p.kind, p.text), c.id]);
  // bale-contact v1.1 (flag.bale_contact_v1): when ON, first-ask / typed-pending / auto-lead replace this block.
  // When the flag is OFF this block is unchanged (parity with today's inbox).
  if (baleContact.bcFlagOn()) {
    baleContact.ensureBaleContactSchema();
    baleContact.bcAfterInbound(bot, c.id, { kind: p.kind, text: p.text, contact: p.contact, fromId, contactOwn: own, isNewChat: false });
    const after = queryRow<any>("SELECT * FROM bale_bot_chats WHERE id=?", [c.id]);
    if (after && customerBale.cbAnyFlagOn()) {
      customerBale.ensureCustomerBaleSchema();
      const linkedNow = after.customer_id && !c.customer_id;
      if (linkedNow) {
        const cust = queryRow<{ first_name: string; last_name: string; name: string }>("SELECT first_name, last_name, name FROM customers WHERE id=?", [after.customer_id]);
        const nm = cust ? (cust.first_name || cust.name || "") : "";
        customerBale.cbWelcomeAfterLink(after, bot, nm);
      } else if (after.customer_id) {
        const cust = queryRow<{ first_name: string; last_name: string; name: string }>("SELECT first_name, last_name, name FROM customers WHERE id=?", [after.customer_id]);
        const nm = cust ? (cust.first_name || cust.name || "") : "";
        customerBale.cbEnqueueInbound({
          chat: after, bot, customerId: after.customer_id, customerName: nm,
          text: p.kind === "text" ? (p.text ?? "") : (p.kind === "photo" ? "ارسال عکس" : ""),
          hasPhoto: p.kind === "photo",
        });
      }
    }
  } else if (p.contact && own === 1 && p.contact.phone) {
    executeChanges("UPDATE bale_bot_chats SET verified_phone=? WHERE id=?", [p.contact.phone, c.id]);
    if (c.customer_id == null) {
      const owner = bbUser(bot.user_id);
      const hit = matchPhone(p.contact.phone, owner?.salesperson_id ?? null);
      if (hit && "customerId" in hit) {
        executeChanges("UPDATE bale_bot_chats SET customer_id=?, link_method=?, linked_at=?, match_note=NULL WHERE id=?", [hit.customerId, hit.own ? "contact" : "contact_other", t, c.id]);
        bbLog({ botId: bot.id, chatRow: c.id, customerId: hit.customerId, action: "link.contact", outcome: hit.own ? "own" : "other_expert" });
        if (!hit.own) { // owner of the file does not change; both experts are told (link_other / file_other)
          bbNotice(bot.user_id, "linked_other", { chatRow: c.id, customerId: hit.customerId });
          for (const uid of fileOwnerUsers(hit.customerId)) if (uid !== bot.user_id) bbNotice(uid, "file_other", { chatRow: c.id, customerId: hit.customerId });
        }
      } else {
        executeChanges("UPDATE bale_bot_chats SET match_note=? WHERE id=?", [hit ? "many" : "none", c.id]);
        bbLog({ botId: bot.id, chatRow: c.id, action: "link.contact", outcome: hit ? "many" : "no_match" });
      }
    }
  } else if (p.contact) bbLog({ botId: bot.id, chatRow: c.id, action: "link.contact", outcome: "not_own" });
  return fileState === "pending" ? [mid] : [];
}

async function copyFile(bot: BotRow, token: string, msgId: number): Promise<void> {
  const m = queryRow<{ id: number; chat_row: number; file_id: string; file_name: string | null }>("SELECT id,chat_row,file_id,file_name FROM bale_bot_messages WHERE id=?", [msgId]);
  if (!m) return;
  const g = await baleCall<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: m.file_id });
  if (!g.ok || !g.result?.file_path) { executeChanges("UPDATE bale_bot_messages SET file_state='error', error_code=? WHERE id=?", [g.ok ? "no_path" : `getFile_${g.code}`, m.id]); return; }
  if ((g.result.file_size ?? 0) > BB_LIMITS.inMaxBytes) { executeChanges("UPDATE bale_bot_messages SET file_state='too_big' WHERE id=?", [m.id]); return; }
  const rel = path.join(String(bot.id), `${m.id}-${crypto.randomBytes(6).toString("hex")}-${safeName(m.file_name ?? path.basename(g.result.file_path))}`);
  const r = await baleDownload(token, g.result.file_path, path.join(filesDir(), rel), BB_LIMITS.inMaxBytes);
  executeChanges("UPDATE bale_bot_messages SET file_state=?, file_path=?, size=COALESCE(size,?) WHERE id=?", [r === "ok" ? "stored" : r, r === "ok" ? rel : null, g.result.file_size ?? null, m.id]);
}
async function fetchProfile(bot: BotRow, token: string, chatRow: number) {
  const c = queryRow<{ chat_id: string }>("SELECT chat_id FROM bale_bot_chats WHERE id=? AND profile_checked=0", [chatRow]); if (!c) return;
  const r = await baleCall<{ bio?: string }>(token, "getChat", { chat_id: c.chat_id });
  executeChanges("UPDATE bale_bot_chats SET profile_checked=1, bio=? WHERE id=?", [r.ok ? (r.result?.bio ?? null) : null, chatRow]);
}

/* ---------------- outbound ---------------- */
export type SendKind = "text" | "photo" | "document" | "voice" | "video" | "ask_contact";
const METHOD: Record<string, [string, string]> = { photo: ["sendPhoto", "photo"], document: ["sendDocument", "document"], voice: ["sendVoice", "voice"], video: ["sendVideo", "video"], audio: ["sendAudio", "audio"] };
const ERR_CODE = (r: Extract<ApiResult, { ok: false }>) => r.network ? "network" : r.code === 401 || r.code === 404 ? "token_rejected" : r.code === 403 ? "forbidden" : r.code === 400 ? "bad_request" : `http_${r.code}`;

/** One attempt for one queued message. 429 → stays «sending» with retry_at; other errors → failed. */
export async function attemptSend(msgId: number): Promise<void> {
  const m = queryRow<any>("SELECT m.*, c.chat_id, c.bot_id FROM bale_bot_messages m JOIN bale_bot_chats c ON c.id=m.chat_row WHERE m.id=? AND m.dir='out' AND m.status='sending'", [msgId]);
  if (!m) return;
  const bot = botById(m.bot_id);
  const fail = (code: string) => { executeChanges("UPDATE bale_bot_messages SET status='failed', error_code=?, retry_at=NULL WHERE id=?", [code, m.id]); bbLog({ botId: m.bot_id, chatRow: m.chat_row, action: "send", outcome: "failed", detail: { code } }); };
  if (!bot || !botLive(bot)) return fail("bot_off");
  if (!botSends(bot)) return fail("no_send");
  const token = botToken(bot); if (!token) return fail("token_missing");
  executeChanges("UPDATE bale_bot_messages SET tries=tries+1 WHERE id=?", [m.id]);
  const replyId = m.reply_to ? queryRow<{ bale_message_id: number }>("SELECT bale_message_id FROM bale_bot_messages WHERE id=?", [m.reply_to])?.bale_message_id : null;
  let r: ApiResult<{ message_id: number }>;
  if (m.kind === "text") {
    const body: Record<string, unknown> = { chat_id: m.chat_id, text: m.text };
    if (replyId) body.reply_to_message_id = replyId;
    if (m.keyboard === "contact") body.reply_markup = { keyboard: [[{ text: ASK_CONTACT_BUTTON, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
    else {
      const mk = customerBale.cbReplyMarkup(m.keyboard);
      if (mk) body.reply_markup = mk;
    }
    r = await baleCall(token, "sendMessage", body);
  } else {
    const [method, field] = METHOD[m.send_as ?? m.kind] ?? METHOD.document;
    let buf: Buffer;
    try { buf = fs.readFileSync(path.join(filesDir(), m.file_path)); } catch { return fail("file_missing"); }
    const fd = new FormData(); fd.set("chat_id", m.chat_id); if (m.text) fd.set("caption", m.text); if (replyId) fd.set("reply_to_message_id", String(replyId));
    fd.set(field, new Blob([new Uint8Array(buf)], { type: m.mime || "application/octet-stream" }), m.file_name || "file");
    r = await baleCall(token, method, fd, 180_000);
  }
  if (r.ok) {
    executeChanges("UPDATE bale_bot_messages SET status='sent', bale_message_id=?, sent_at=?, error_code=NULL, retry_at=NULL WHERE id=?", [r.result?.message_id ?? null, now(), m.id]);
    bbLog({ userId: m.author_user_id, botId: m.bot_id, chatRow: m.chat_row, action: "send", outcome: "sent", detail: { kind: m.kind } });
    return;
  }
  if (r.code === 429 || r.retryAfter) {
    const wait = Math.min(Math.max(r.retryAfter ?? 5, 1), 3600);
    executeChanges("UPDATE bale_bot_messages SET error_code='rate_limited', retry_at=? WHERE id=?", [new Date(Date.now() + wait * 1000).toISOString(), m.id]);
    bbLog({ botId: m.bot_id, chatRow: m.chat_row, action: "send", outcome: "rate_limited", detail: { wait } });
    return;
  }
  if (r.code === 401 || r.code === 404) markTokenRejected(bot);
  fail(ERR_CODE(r));
}
export function markTokenRejected(bot: BotRow) {
  executeChanges("UPDATE bale_bots SET status='err', last_error='token_rejected', updated_at=? WHERE id=?", [now(), bot.id]);
  bbLog({ botId: bot.id, action: "bot.token", outcome: "rejected" });
}

/* ---------------- poller / supervisor ---------------- */
type Poller = { stop: () => void; running: boolean };
export class BaleBotWorker {
  pollers = new Map<number, Poller>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  constructor(private opts: { tickMs?: number; pollTimeoutSec?: number; idleMs?: number } = {}) {}
  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(() => { /* next tick */ }); }, this.opts.tickMs ?? 10_000); this.timer.unref?.(); this.tick().catch(() => { /* next tick */ }); }
  stopAll() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const p of this.pollers.values()) p.stop(); this.pollers.clear(); }
  /** OFF → one settings SELECT, every poller stopped, nothing else. */
  async tick(): Promise<void> {
    if (!bbMasterOn()) { for (const p of this.pollers.values()) p.stop(); this.pollers.clear(); return; }
    ensureBaleBotSchema();
    const live = queryRows<BotRow>("SELECT * FROM bale_bots WHERE status='on' AND token_ct IS NOT NULL").filter(botLive);
    const ids = new Set(live.map(b => b.id));
    for (const [id, p] of this.pollers) if (!ids.has(id) || !p.running) { p.stop(); this.pollers.delete(id); }
    for (const b of live) if (!this.pollers.has(b.id)) this.pollers.set(b.id, this.poll(b.id));
    await this.flushOutbox();
    if (baleContact.bcFlagOn()) {
      baleContact.ensureBaleContactSchema();
      baleContact.bcTickReminders();
      await this.flushOutbox();
    }
  }
  async flushOutbox(): Promise<void> {
    await customerBale.cbDrainInbound();
    if (this.sending || !bbMasterOn()) return; this.sending = true;
    try {
      for (;;) {
        const m = queryRow<{ id: number }>("SELECT id FROM bale_bot_messages WHERE dir='out' AND status='sending' AND (retry_at IS NULL OR retry_at<=?) ORDER BY id LIMIT 1", [now()]);
        if (!m) break;
        try { await attemptSend(m.id); } catch { break; } // retried on the next tick
        const still = queryRow<{ status: string; retry_at: string | null }>("SELECT status,retry_at FROM bale_bot_messages WHERE id=?", [m.id]);
        if (still?.status === "sending" && still.retry_at) continue; // rate limited: others may still go
      }
    } finally { this.sending = false; }
  }
  private poll(botId: number): Poller {
    const ctl = { stop: () => { st.running = false; }, running: true }; const st = ctl;
    const idle = this.opts.idleMs ?? 1000, timeout = this.opts.pollTimeoutSec ?? 25;
    void (async () => {
      let backoff = idle;
      while (st.running) {
       try {
        const bot = botById(botId);
        if (!bot || !botLive(bot)) break;
        const token = botToken(bot);
        if (!token) { executeChanges("UPDATE bale_bots SET last_error='token_unreadable' WHERE id=?", [botId]); break; }
        // «پیام‌های قبل از وصل شدن نمی‌آید»: the first poll after connecting only moves the offset past the backlog.
        const skip = !bot.backlog_skipped;
        const r = await baleCall<any[]>(token, "getUpdates", skip ? { offset: -1, limit: 1, timeout: 0 } : { offset: bot.next_offset, limit: 100, timeout }, (timeout + 10) * 1000);
        if (!st.running) break;
        executeChanges("UPDATE bale_bots SET last_poll_at=? WHERE id=?", [now(), botId]);
        if (r.ok) {
          backoff = idle;
          const ups = Array.isArray(r.result) ? r.result : [];
          if (skip) {
            const last = ups.reduce((a, u) => Math.max(a, Number(u.update_id) || 0), 0);
            executeChanges("UPDATE bale_bots SET backlog_skipped=1, next_offset=?, last_ok_at=?, last_error=NULL WHERE id=?", [last ? last + 1 : 0, now(), botId]);
            bbLog({ botId, action: "poll.backlog_skip", outcome: "ok", detail: { skipped: ups.length } });
            continue;
          }
          let files: number[] = []; const newChats = new Set<number>();
          if (ups.length) runImmediateTransaction(() => {
            for (const u of ups) {
              const before = queryRow<{ n: number }>("SELECT COUNT(*) n FROM bale_bot_chats WHERE bot_id=?", [botId])!.n;
              files = files.concat(storeUpdate(bot, u));
              if (queryRow<{ n: number }>("SELECT COUNT(*) n FROM bale_bot_chats WHERE bot_id=?", [botId])!.n > before) newChats.add(queryRow<{ id: number }>("SELECT MAX(id) id FROM bale_bot_chats WHERE bot_id=?", [botId])!.id);
            }
            const max = ups.reduce((a, u) => Math.max(a, Number(u.update_id) || 0), bot.next_offset - 1);
            executeChanges("UPDATE bale_bots SET next_offset=?, last_ok_at=?, last_error=NULL WHERE id=?", [max + 1, now(), botId]);
          });
          else executeChanges("UPDATE bale_bots SET last_ok_at=?, last_error=NULL WHERE id=?", [now(), botId]);
          for (const id of files) await copyFile(bot, token, id);
          for (const id of newChats) await fetchProfile(bot, token, id);
          continue;
        }
        if (r.code === 401 || r.code === 404) { markTokenRejected(bot); break; }
        const wait = r.retryAfter ? r.retryAfter * 1000 : backoff;
        executeChanges("UPDATE bale_bots SET last_error=? WHERE id=?", [r.code === 409 ? "conflict_elsewhere" : ERR_CODE(r), botId]);
        await new Promise(res => setTimeout(res, Math.min(wait, 60_000)));
        backoff = Math.min(backoff * 2, 60_000);
       } catch (e) { // e.g. SQLITE_BUSY: never crash the process, never lose the offset (updates are re-read and deduped)
        bbLog({ botId, action: "poll.error", outcome: redact((e as any)?.code ?? "error").slice(0, 40) });
        await new Promise(res => setTimeout(res, backoff)); backoff = Math.min(backoff * 2, 60_000);
       }
      }
      st.running = false;
    })();
    return ctl;
  }
}

/* ---------------- views ---------------- */
export const chatName = (c: { first_name: string | null; last_name: string | null; username: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : "بدون نام");
/** Author label, CRM only (Bale gets the bare text): «مدیر فروش: …» / «مدیر سیستم: …»; the bot owner's own messages carry none. */
export function authorLabel(authorId: number | null, ownerId: number | null): string | null {
  if (!authorId || authorId === ownerId) return null;
  const u = bbUser(authorId); if (!u) return null;
  return `${isSalesManagerUser(u) ? "مدیر فروش" : u.role === "admin" ? "مدیر سیستم" : "همکار"}: ${nameOf(u)}`;
}
/** Mask phone-like runs in a message preview when the viewer must not see the number (other expert / restricted). */
export function redactPhonesInText(text: string | null | undefined): string | null {
  if (text == null || text === "") return text ?? null;
  const toEn = text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const out = toEn.replace(/(?:\+98|0098|98|0)?9\d{9}/g, "••••");
  return out === toEn ? text : out;
}
export function messageView(m: any, ownerId: number | null = null, opts?: { hidePhone?: boolean }) {
  if (ownerId == null && m.dir === "out") ownerId = queryRow<{ u: number }>("SELECT b.user_id u FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.id=?", [m.chat_row])?.u ?? null;
  const author = m.dir === "out" ? authorLabel(m.author_user_id, ownerId) : null;
  const ageH = (Date.now() - Date.parse(m.sent_at ?? m.created_at)) / 3_600_000;
  let text = m.deleted_at ? null : m.text as string | null;
  let contact = m.kind === "contact" ? { phone: m.contact_phone as string | null, name: m.contact_name as string | null, own: m.contact_own === 1, hidden: false } : null;
  if (opts?.hidePhone) {
    if (text) text = redactPhonesInText(text);
    if (contact) contact = { ...contact, phone: null, hidden: true };
  }
  return { id: m.id, dir: m.dir, kind: m.kind, text, at: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted_at,
    file: m.file_state ? { name: m.file_name, mime: m.mime, size: m.size, duration: m.duration, state: m.file_state, url: m.file_state === "stored" ? `/api/bale-bot/files/${m.id}` : null } : null,
    contact,
    location: m.kind === "location" ? { lat: m.lat, lng: m.lng } : null, replyTo: m.reply_to, askContact: m.keyboard === "contact",
    status: m.dir === "out" ? (m.status === "sending" && m.error_code === "rate_limited" ? "wait" : m.status) : null, errorCode: m.dir === "out" && m.status === "failed" ? m.error_code : null,
    author, canEdit: m.dir === "out" && m.status === "sent" && m.kind === "text" && !m.deleted_at && !m.keyboard,
    canDelete: m.dir === "out" && m.status === "sent" && !m.deleted_at && ageH < BB_LIMITS.deleteHours, deleteExpired: m.dir === "out" && m.status === "sent" && !m.deleted_at && ageH >= BB_LIMITS.deleteHours };
}

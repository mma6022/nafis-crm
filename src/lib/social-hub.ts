/**
 * «مدیریت فروش شبکه‌های اجتماعی + تماس ناشناس» v1.1 (Armita design /workspace/designs/social-hub, Mohammad cards t418s1654 + t418s1663).
 *
 * Flags (call_queue_settings, only '1' is ON; absent = OFF):
 *   flag.social_hub_v1               page «مدیریت فروش شبکه‌های اجتماعی» (bots / ready messages / docs), the «ارسال پیام» wizard and
 *                                    full national id + birth date on the today card. OFF → /social-hub/me {enabled:false}, other routes 404,
 *                                    no schema is created.
 *   flag.social_hub_phone_attach_v1  «افزودن این شماره به مشتری ثبت‌شده» on the incoming card; any expert may add extra numbers to any
 *                                    customer; extra-number cap raised (SH_EXTRA_PHONES_MAX). OFF → customer-phones behaves exactly as before.
 *   flag.social_hub_send_v1          deliverer (social-hub-send.ts). OFF → every expert «ارسال» only writes a sh_sends row
 *                                    with status 'queued' (no Bale call). ON → enqueue expert-initiated Today sends through
 *                                    the existing Bale outbox of the latest chat's bot (never Ghasemi's bot, except the
 *                                    redirect campaign). Turning this on does not itself send or flush a queue, and does
 *                                    not deliver auto-sends.
 *   flag.social_hub_auto_send_v1     when a customer is linked to a plan, queue and (if send_v1 is also ON) deliver that
 *                                    plan's auto_send messages. Default OFF (absent). send_v1 alone never sends automatically.
 *                                    Turning this flag on does not backfill: only plan picks in the bot after it is ON are sent.
 *   flag.social_hub_bot_connect_v1   «آزمایش اتصال» / save of the unified «نفیس وام» token into bale_bots.user_id=0.
 *                                    OFF → test answers connect_disabled; no token is accepted, stored or used.
 *   flag.social_hub_redirect_v1      one-time bulk redirect + «ارسال یک‌باره». Default OFF. Super-admin only. No send
 *                                    unless the unified bot has a token and getMe succeeds. Ghasemi's customers ARE included
 *                                    (Mohammad t931s3334); other sends from her bot stay blocked.
 *
 * Schema: additive CREATE TABLE IF NOT EXISTS only (sh_*). Never writes loan_plans, team_sales_config, notification_settings,
 * contract templates, bale_bots or bale_bot_chats. Reads them only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "./auth";
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { isAdminRole, normalizeCustomerMobile } from "./customer-integrity";
import { isSalesManagerUser } from "./sales-manager";
import { internalPlanLabel, planChoiceLabel, planLabelForCustomer, withPlanPrefix } from "./plan-label";

export const SH_FLAG = "flag.social_hub_v1";
export const SH_PHONE_FLAG = "flag.social_hub_phone_attach_v1";
export const SH_SEND_FLAG = "flag.social_hub_send_v1";
export const SH_AUTO_SEND_FLAG = "flag.social_hub_auto_send_v1";
export const SH_CONNECT_FLAG = "flag.social_hub_bot_connect_v1";
export const SH_REDIRECT_FLAG = "flag.social_hub_redirect_v1";
/** «پایان انتقال» (Armita build-r1 §8): Mohammad did not ask for a manual trigger; OFF → the button is hidden and the routes answer 404. */
export const SH_LEGACY_FINISH_FLAG = "flag.social_hub_legacy_finish_v1";
/** Mohammad t418s1654: bot name. */
export const SH_BOT_NAME = "نفیس وام";
/** Mohammad t418s1663: training / docs upload max 200 MB. */
export const SH_DOC_MAX_BYTES = 200 * 1024 * 1024;
/** Mohammad t418s1663: old bots are read-only after migration and turned off 30 days after it. */
export const SH_LEGACY_OFF_DAYS = 30;
/** Mohammad t418s1663: order after Bale. Only Bale can be connected in this build. */
export const SH_NETWORKS = [
  { key: "bale", label: "بله" }, { key: "eitaa", label: "ایتا" }, { key: "telegram", label: "تلگرام" },
  { key: "whatsapp", label: "واتساپ" }, { key: "instagram", label: "اینستاگرام" }, { key: "rubika", label: "روبیکا" },
] as const;
export type ShNetwork = typeof SH_NETWORKS[number]["key"];
/** Mohammad t418s1654: «چند شمارهٔ اضافه». The design gives no number; extras capped at 9 (10 with the primary) as an abuse guard. */
export const SH_EXTRA_PHONES_MAX = 9;
export const SH_EXCLUDED_USER_IDS = [29];
export const SH_TEXT_MAX = 4096;
export const SH_TITLE_MAX = 80;
export const SH_DESC_MAX = 400;
export const SH_VARS = ["نام مشتری", "نام کارشناس", "نام طرح"] as const;
export const SH_DEFAULT_REDIRECT_TEXT = "سلام ‹نام مشتری›، ربات ما عوض شده است. برای ادامهٔ گفتگو با کارشناس، روی دکمهٔ زیر بزنید و ربات «نفیس وام» را شروع کنید.";

const setting = (k: string) => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value; } catch { return undefined; } };
export const shOn = () => setting(SH_FLAG) === "1";
export const shPhoneOn = () => setting(SH_PHONE_FLAG) === "1";
export const shSendOn = () => setting(SH_SEND_FLAG) === "1";
export const shAutoSendOn = () => setting(SH_AUTO_SEND_FLAG) === "1";
/** Timestamp the auto-send flag last became ON. Used so turning it on never delivers rows queued from past plan picks. */
export function shAutoSendOnAt(): string | null {
  try {
    const row = queryRow<{ value: string; updated_at: string | null }>("SELECT value, updated_at FROM call_queue_settings WHERE key=?", [SH_AUTO_SEND_FLAG]);
    if (!row || row.value !== "1") return null;
    return row.updated_at ?? null;
  } catch { return null; }
}
function shAtMs(v: string | null | undefined): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const t = Date.parse(/T/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : 0;
}
/** Auto rows are delivered only if the auto flag is ON and the row was created at or after it was turned on. No backfill. */
export function shAutoSendEligible(createdAt: string): boolean {
  if (!shAutoSendOn()) return false;
  const onAt = shAutoSendOnAt();
  if (!onAt) return false;
  return shAtMs(createdAt) >= shAtMs(onAt);
}
export const shConnectOn = () => setting(SH_CONNECT_FLAG) === "1";
export const shRedirectOn = () => setting(SH_REDIRECT_FLAG) === "1";
export const shLegacyFinishOn = () => setting(SH_LEGACY_FINISH_FLAG) === "1";
type ShSendMod = typeof import("./social-hub-send");
let sendMod: ShSendMod | null = null;
export const setShSendModule = (m: ShSendMod) => { sendMod = m; };
const requireSend = (): ShSendMod => {
  if (!sendMod) throw new ShError(500, "unwired", "ماژول ارسال هنوز وصل نشده است.");
  return sendMod;
};


export class ShError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
const iso = (d = new Date()) => d.toISOString();
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max);
const faDigits = (s: string) => s.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

/* ---------------- schema (lazy, only while flag.social_hub_v1 is ON) ---------------- */
let ready = false;
export function ensureSocialHubSchema(): void {
  if (ready) { try { if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='sh_messages'")) return; } catch { /* retry */ } ready = false; }
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS sh_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_bots(
      id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT NOT NULL, name TEXT NOT NULL, handle TEXT, unified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','connected','off')), connected_at TEXT,
      created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_bot_access(
      bot_id INTEGER NOT NULL, user_id INTEGER NOT NULL, manage INTEGER NOT NULL DEFAULT 0, customers_message INTEGER NOT NULL DEFAULT 1,
      view_scope TEXT NOT NULL DEFAULT 'own' CHECK(view_scope IN ('own','all','none')), updated_by INTEGER, updated_at TEXT NOT NULL,
      PRIMARY KEY(bot_id, user_id));
    CREATE TABLE IF NOT EXISTS sh_legacy_bots(
      legacy_bot_id INTEGER PRIMARY KEY, redirect_auto INTEGER NOT NULL DEFAULT 0, migrated_at TEXT, off_at TEXT,
      updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_legacy_moves(
      id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_bot_id INTEGER NOT NULL, chat_row INTEGER NOT NULL, bale_user_id TEXT, customer_id INTEGER,
      moved_at TEXT NOT NULL, UNIQUE(legacy_bot_id, chat_row));
    CREATE TABLE IF NOT EXISTS sh_redirect_sends(
      id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_bot_id INTEGER NOT NULL, chat_row INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('auto','once')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')), requested_by INTEGER, created_at TEXT NOT NULL,
      UNIQUE(legacy_bot_id, chat_row, mode));
    CREATE TABLE IF NOT EXISTS sh_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('free','plan')), plan_id INTEGER, title TEXT NOT NULL, body TEXT NOT NULL,
      show_today INTEGER NOT NULL DEFAULT 1, auto_send INTEGER NOT NULL DEFAULT 0, is_initial INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL,
      CHECK((kind='free' AND plan_id IS NULL AND auto_send=0) OR (kind='plan' AND plan_id IS NOT NULL)));
    CREATE INDEX IF NOT EXISTS ix_sh_messages_plan ON sh_messages(kind, plan_id, archived, sort, id);
    CREATE TABLE IF NOT EXISTS sh_docs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, file_type TEXT NOT NULL CHECK(file_type IN ('pdf','video','image')),
      original_name TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, plan_id INTEGER,
      archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_sends(
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, user_id INTEGER, plan_id INTEGER, message_id INTEGER, doc_ids TEXT NOT NULL DEFAULT '[]',
      body TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('today','auto')), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')),
      created_at TEXT NOT NULL, sent_at TEXT, chat_row INTEGER, bot_id INTEGER, out_msg_id INTEGER, fail_reason TEXT, retryable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sh_redirect_campaigns(
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_by INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','stopped','done')), recipient_count INTEGER NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_redirect_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
      from_chat_row INTEGER NOT NULL, from_bot_id INTEGER NOT NULL, expert_user_id INTEGER, token TEXT NOT NULL UNIQUE,
      out_msg_id INTEGER, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','cancelled')),
      fail_reason TEXT, created_at TEXT NOT NULL, sent_at TEXT, used_at TEXT, used_chat_row INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sh_redirect_items_sent ON sh_redirect_items(customer_id) WHERE status='sent';
    CREATE INDEX IF NOT EXISTS ix_sh_sends_customer ON sh_sends(customer_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sh_sends_auto ON sh_sends(customer_id, message_id) WHERE source='auto';
    CREATE TABLE IF NOT EXISTS sh_identity_source(customer_id INTEGER PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('bale','staff')), at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sh_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, ref_id INTEGER, detail TEXT);
  `);
  shBotsArchiveMigration();
  const now = iso();
  // the one unified bot row; status stays 'draft' until a real connection exists (none in this build)
  execute("INSERT OR IGNORE INTO sh_bots(network,name,handle,unified,status,created_at,updated_at) VALUES('bale',?,NULL,1,'draft',?,?)", [SH_BOT_NAME, now, now]);
  if (!queryRow("SELECT 1 x FROM sh_settings WHERE key='redirect_text'")) execute("INSERT INTO sh_settings(key,value,updated_at) VALUES('redirect_text',?,?)", [SH_DEFAULT_REDIRECT_TEXT, now]);
  const cols = new Set(queryRows<{ name: string }>("PRAGMA table_info(sh_sends)").map((c) => c.name));
  const add = (col: string, def: string) => { if (!cols.has(col)) crmDb.exec(`ALTER TABLE sh_sends ADD COLUMN ${col} ${def}`); };
  add("chat_row", "INTEGER"); add("bot_id", "INTEGER"); add("out_msg_id", "INTEGER"); add("fail_reason", "TEXT"); add("retryable", "INTEGER NOT NULL DEFAULT 0");
  if (!queryRow("SELECT 1 x FROM sh_settings WHERE key='bale_file_max_bytes'")) execute("INSERT INTO sh_settings(key,value,updated_at) VALUES('bale_file_max_bytes',?,?)", ["52428800", now]); // 50 MiB, docs.bale.ai sendDocument
  if (!queryRow("SELECT 1 x FROM sh_settings WHERE key='redirect_per_minute'")) execute("INSERT INTO sh_settings(key,value,updated_at) VALUES('redirect_per_minute',?,?)", ["20", now]);
  if (!queryRow("SELECT 1 x FROM sh_settings WHERE key='readonly_bot_user_ids'")) execute("INSERT INTO sh_settings(key,value,updated_at) VALUES('readonly_bot_user_ids',?,?)", ["3", now]);
  ready = true;
}

/** t945u: «حذف ربات» archives a draft bot row (archived_at) instead of deleting it. Additive: one nullable column, and the per-network
 *  unique index becomes partial (active rows only) so a network can be added again after its bot was removed. Idempotent. */
function shBotsArchiveMigration(): void {
  const cols = new Set(queryRows<{ name: string }>("PRAGMA table_info(sh_bots)").map((c) => c.name));
  if (!cols.has("archived_at")) crmDb.exec("ALTER TABLE sh_bots ADD COLUMN archived_at TEXT");
  const ix = queryRow<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_sh_bots_network'");
  if (!ix || !/archived_at/i.test(String(ix.sql ?? ""))) {
    crmDb.exec("BEGIN IMMEDIATE");
    try {
      crmDb.exec("DROP INDEX IF EXISTS ux_sh_bots_network; CREATE UNIQUE INDEX ux_sh_bots_network ON sh_bots(network) WHERE archived_at IS NULL;");
      crmDb.exec("COMMIT");
    } catch (e) { try { crmDb.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
  }
}
export const _resetShSchemaForTests = () => { ready = false; };
/** Audit: ids and codes only, never a phone, national id or message text. */
export function shLog(userId: number | null, action: string, refId: number | null, detail?: Record<string, string | number | boolean | null>) {
  try { execute("INSERT INTO sh_log(at,user_id,action,ref_id,detail) VALUES(?,?,?,?,?)", [iso(), userId, action, refId, detail ? JSON.stringify(detail) : null]); } catch { /* never breaks caller */ }
}

/* ---------------- access ---------------- */
/** Page access: sales manager + system admin (design §ب). Plain experts never. */
export function shIsManager(u: AuthUser | null | undefined): boolean {
  if (!u || !u.active || SH_EXCLUDED_USER_IDS.includes(Number(u.id))) return false;
  return isSalesManagerUser(u) || u.baseRole === "admin" || (u.role === "admin" && !u.baseRole);
}
export function shIsStaff(u: AuthUser | null | undefined): boolean {
  return !!u && !!u.active && !SH_EXCLUDED_USER_IDS.includes(Number(u.id)) && u.permissions.includes("customers.view");
}
/** Today-card access to one customer: admin / all-scope, own customer, or an explicit lockdown grant passed by the caller. */
export function shCanSeeCustomer(u: AuthUser, customerId: number, lockdownAccess = false): boolean {
  const row = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!row) return false;
  if (isAdminRole(u.role) || u.customerScope === "all") return true;
  if (u.salespersonId != null && Number(row.salesperson_id) === Number(u.salespersonId)) return true;
  return lockdownAccess;
}

export function shMe(u: AuthUser | null | undefined) {
  if (!shOn() && !shPhoneOn()) return { enabled: false };
  return {
    enabled: shOn(), phoneAttach: shPhoneOn(), manager: shOn() && shIsManager(u), botName: SH_BOT_NAME,
    networks: SH_NETWORKS, docMaxBytes: SH_DOC_MAX_BYTES, legacyOffDays: SH_LEGACY_OFF_DAYS, extraPhonesMax: SH_EXTRA_PHONES_MAX,
    sendDelivery: shSendOn() ? "on" : "queued_only", autoSendEnabled: shAutoSendOn(), connectEnabled: shConnectOn(), redirectEnabled: shOn() && shRedirectOn(),
    legacyFinish: shOn() && shLegacyFinishOn(), baleFileMaxBytes: 52428800,
  };
}

/* ---------------- plans (read only) ---------------- */
export type ShPlan = { id: number; name: string; publicLabel: string; choiceLabel: string };
export function shPlans(): ShPlan[] {
  return queryRows<{ id: number; name: string | null; bank_name: string | null }>("SELECT id,name,bank_name FROM loan_plans WHERE active=1 ORDER BY id")
    .map((p) => ({ id: Number(p.id), name: withPlanPrefix(internalPlanLabel(p.name, p.bank_name)), publicLabel: planLabelForCustomer(p.bank_name), choiceLabel: planChoiceLabel(p.name, p.bank_name) }));
}
function planById(id: number | null | undefined): ShPlan | null {
  if (id == null) return null;
  const p = queryRow<{ id: number; name: string | null; bank_name: string | null }>("SELECT id,name,bank_name FROM loan_plans WHERE id=?", [id]);
  return p ? { id: Number(p.id), name: withPlanPrefix(internalPlanLabel(p.name, p.bank_name)), publicLabel: planLabelForCustomer(p.bank_name), choiceLabel: planChoiceLabel(p.name, p.bank_name) } : null;
}
export function shCurrentPlanId(customerId: number): number | null {
  const r = queryRow<{ plan_id: number | null }>(
    "SELECT plan_id FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL AND plan_id IS NOT NULL ORDER BY COALESCE(updated_at,created_at) DESC, id DESC LIMIT 1", [customerId]);
  return r?.plan_id == null ? null : Number(r.plan_id);
}

/* ---------------- ready messages ---------------- */
export type ShMessage = { id: number; kind: "free" | "plan"; planId: number | null; title: string; body: string; showToday: boolean; autoSend: boolean; isInitial: boolean; sort: number };
const msgView = (r: any): ShMessage => ({ id: Number(r.id), kind: r.kind, planId: r.plan_id == null ? null : Number(r.plan_id), title: r.title, body: r.body,
  showToday: Number(r.show_today) === 1, autoSend: Number(r.auto_send) === 1, isInitial: Number(r.is_initial) === 1, sort: Number(r.sort) });
export function shMessages() {
  const rows = queryRows<any>("SELECT * FROM sh_messages WHERE archived=0 ORDER BY sort, id").map(msgView);
  const plans = shPlans();
  return {
    free: rows.filter((m) => m.kind === "free"),
    plans: plans.map((p) => ({ plan: p, messages: rows.filter((m) => m.kind === "plan" && m.planId === p.id) })),
    vars: SH_VARS,
  };
}
function parseMessage(body: any, existing?: ShMessage) {
  const title = clean(body?.title ?? existing?.title, SH_TITLE_MAX);
  const text = String(body?.body ?? existing?.body ?? "").replace(/\r\n?/g, "\n").trim().slice(0, SH_TEXT_MAX + 1);
  const kind = (body?.kind ?? existing?.kind) === "plan" ? "plan" : "free";
  const planId = kind === "plan" ? Number(body?.planId ?? existing?.planId) : null;
  if (!title) throw new ShError(400, "title_required", "نام پیام را بنویسید.", { field: "title" });
  if (!text) throw new ShError(400, "body_required", "متن پیام را بنویسید.", { field: "body" });
  if ([...text].length > SH_TEXT_MAX) throw new ShError(400, "body_too_long", `متن پیام حداکثر ${faDigits(String(SH_TEXT_MAX))} نویسه باشد.`, { field: "body" });
  if (kind === "plan" && (!Number.isSafeInteger(planId) || !planById(planId))) throw new ShError(400, "plan_required", "طرح را انتخاب کنید.", { field: "planId" });
  const showToday = body?.showToday === undefined ? (existing?.showToday ?? true) : Boolean(body.showToday);
  const autoSend = kind === "plan" && (body?.autoSend === undefined ? (existing?.autoSend ?? false) : Boolean(body.autoSend));
  return { title, text, kind, planId, showToday, autoSend };
}
export function shCreateMessage(u: AuthUser, body: any): ShMessage {
  const m = parseMessage(body); const now = iso();
  const sort = Number(queryRow<{ s: number }>("SELECT COALESCE(MAX(sort),0)+1 s FROM sh_messages")?.s ?? 1);
  const id = execute("INSERT INTO sh_messages(kind,plan_id,title,body,show_today,auto_send,sort,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [m.kind, m.planId, m.title, m.text, m.showToday ? 1 : 0, m.autoSend ? 1 : 0, sort, u.id, now, u.id, now]);
  shLog(u.id, "message_create", Number(id), { kind: m.kind, planId: m.planId });
  return msgView(queryRow("SELECT * FROM sh_messages WHERE id=?", [id]));
}
export function shUpdateMessage(u: AuthUser, id: number, body: any): ShMessage {
  const row = queryRow<any>("SELECT * FROM sh_messages WHERE id=? AND archived=0", [id]);
  if (!row) throw new ShError(404, "not_found", "این پیام پیدا نشد.");
  const m = parseMessage(body, msgView(row));
  executeChanges("UPDATE sh_messages SET kind=?,plan_id=?,title=?,body=?,show_today=?,auto_send=?,updated_by=?,updated_at=? WHERE id=?",
    [m.kind, m.planId, m.title, m.text, m.showToday ? 1 : 0, m.autoSend ? 1 : 0, u.id, iso(), id]);
  shLog(u.id, "message_update", id, { showToday: m.showToday, autoSend: m.autoSend });
  return msgView(queryRow("SELECT * FROM sh_messages WHERE id=?", [id]));
}
export function shArchiveMessage(u: AuthUser, id: number) {
  if (!executeChanges("UPDATE sh_messages SET archived=1,updated_by=?,updated_at=? WHERE id=? AND archived=0", [u.id, iso(), id])) throw new ShError(404, "not_found", "این پیام پیدا نشد.");
  shLog(u.id, "message_archive", id);
}
/** «‹نام مشتری›» style variables → values. Unknown text is left as written. */
export function shRender(text: string, vars: { customer?: string | null; expert?: string | null; plan?: string | null }): string {
  const map: Record<string, string> = { "نام مشتری": vars.customer ?? "", "نام کارشناس": vars.expert ?? "", "نام طرح": vars.plan ?? "" };
  return text.replace(/[‹«{]\s*(نام مشتری|نام کارشناس|نام طرح)\s*[›»}]/g, (_m, k: string) => map[k] || "");
}

/* ---------------- docs ---------------- */
export function shDocsDir(): string {
  return process.env.SOCIAL_HUB_FILES_DIR || path.join(path.dirname(process.env.CRM_DATABASE_PATH || "/var/lib/nafisvam/customers.db"), "social-hub-docs");
}
export function shSniffType(buf: Buffer, mime: string, name: string): { type: "pdf" | "video" | "image"; mime: string } | null {
  const h = buf.subarray(0, 16);
  if (h.subarray(0, 5).toString("latin1") === "%PDF-") return { type: "pdf", mime: "application/pdf" };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { type: "image", mime: "image/jpeg" };
  if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image", mime: "image/png" };
  if (h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image", mime: "image/webp" };
  if (h.subarray(4, 8).toString("latin1") === "ftyp") return { type: "video", mime: /\.mov$/i.test(name) || mime === "video/quicktime" ? "video/quicktime" : "video/mp4" };
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return { type: "video", mime: "video/webm" };
  return null;
}
export type ShDoc = { id: number; title: string; description: string | null; fileType: "pdf" | "video" | "image"; originalName: string; sizeBytes: number; planId: number | null; planName: string | null; createdAt: string };
const docView = (r: any): ShDoc => ({ id: Number(r.id), title: r.title, description: r.description ?? null, fileType: r.file_type, originalName: r.original_name,
  sizeBytes: Number(r.size_bytes), planId: r.plan_id == null ? null : Number(r.plan_id), planName: planById(r.plan_id)?.name ?? null, createdAt: r.created_at });
export function shDocs(filter: { type?: string; planId?: number | null } = {}): ShDoc[] {
  const w: string[] = ["archived=0"]; const a: (string | number)[] = [];
  if (filter.type && ["pdf", "video", "image"].includes(filter.type)) { w.push("file_type=?"); a.push(filter.type); }
  if (filter.planId === 0) w.push("plan_id IS NULL"); else if (filter.planId != null) { w.push("plan_id=?"); a.push(filter.planId); }
  return queryRows<any>(`SELECT * FROM sh_docs WHERE ${w.join(" AND ")} ORDER BY id DESC`, a).map(docView);
}
export function shAddDoc(u: AuthUser, buf: Buffer | null, meta: any): ShDoc {
  if (!buf || !buf.length) throw new ShError(400, "file_required", "فایل را انتخاب کنید.", { field: "file" });
  if (buf.length > SH_DOC_MAX_BYTES) throw new ShError(413, "file_too_big", "حجم فایل حداکثر ۲۰۰ مگابایت است.", { field: "file" });
  const name = clean(meta?.fileName, 160) || "file";
  const kind = shSniffType(buf, String(meta?.mime ?? ""), name);
  if (!kind) throw new ShError(400, "bad_type", "فقط پی‌دی‌اف، ویدیو یا تصویر.", { field: "file" });
  const title = clean(meta?.title, SH_TITLE_MAX); if (!title) throw new ShError(400, "title_required", "نام فایل را بنویسید.", { field: "title" });
  const description = clean(meta?.description, SH_DESC_MAX) || null;
  const planId = meta?.planId == null || meta?.planId === "" ? null : Number(meta.planId);
  if (planId != null && !planById(planId)) throw new ShError(400, "plan_required", "طرح انتخاب‌شده پیدا نشد.", { field: "planId" });
  const dir = shDocsDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const rel = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(path.join(dir, rel), buf, { mode: 0o600 });
  const now = iso();
  const id = execute("INSERT INTO sh_docs(title,description,file_type,original_name,mime,size_bytes,sha256,storage_path,plan_id,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [title, description, kind.type, name, kind.mime, buf.length, sha, rel, planId, u.id, now, u.id, now]);
  shLog(u.id, "doc_add", Number(id), { type: kind.type, size: buf.length, planId });
  return docView(queryRow("SELECT * FROM sh_docs WHERE id=?", [id]));
}
export function shUpdateDoc(u: AuthUser, id: number, body: any): ShDoc {
  const r = queryRow<any>("SELECT * FROM sh_docs WHERE id=? AND archived=0", [id]); if (!r) throw new ShError(404, "not_found", "این فایل پیدا نشد.");
  const title = body?.title === undefined ? r.title : clean(body.title, SH_TITLE_MAX); if (!title) throw new ShError(400, "title_required", "نام فایل را بنویسید.", { field: "title" });
  const description = body?.description === undefined ? r.description : (clean(body.description, SH_DESC_MAX) || null);
  const planId = body?.planId === undefined ? r.plan_id : (body.planId == null || body.planId === "" ? null : Number(body.planId));
  if (planId != null && !planById(planId)) throw new ShError(400, "plan_required", "طرح انتخاب‌شده پیدا نشد.", { field: "planId" });
  executeChanges("UPDATE sh_docs SET title=?,description=?,plan_id=?,updated_by=?,updated_at=? WHERE id=?", [title, description, planId, u.id, iso(), id]);
  return docView(queryRow("SELECT * FROM sh_docs WHERE id=?", [id]));
}
export function shArchiveDoc(u: AuthUser, id: number) {
  if (!executeChanges("UPDATE sh_docs SET archived=1,updated_by=?,updated_at=? WHERE id=? AND archived=0", [u.id, iso(), id])) throw new ShError(404, "not_found", "این فایل پیدا نشد.");
  shLog(u.id, "doc_archive", id);
}
export function shDocFile(id: number): { path: string; mime: string; name: string } | null {
  const r = queryRow<any>("SELECT * FROM sh_docs WHERE id=? AND archived=0", [id]); if (!r) return null;
  const p = path.join(shDocsDir(), path.basename(String(r.storage_path)));
  return fs.existsSync(p) ? { path: p, mime: r.mime, name: r.original_name } : null;
}

/* ---------------- bots, access, legacy migration ---------------- */
const userName = (r: { full_name?: string | null; username?: string | null; id: number }) => r.full_name || r.username || `کاربر ${r.id}`;
function staffUsers() {
  return queryRows<{ id: number; role: string; salesperson_id: number | null; full_name: string | null; username: string }>(
    `SELECT id, role, salesperson_id, full_name, username FROM users WHERE active=1 AND id NOT IN (${SH_EXCLUDED_USER_IDS.join(",")})
       AND (role IN ('admin','sales_manager') OR (role='salesperson' AND salesperson_id IS NOT NULL)) ORDER BY id`);
}
export function shBots() {
  const bots = queryRows<any>("SELECT * FROM sh_bots WHERE archived_at IS NULL ORDER BY unified DESC, id").map((b) => ({
    id: Number(b.id), network: b.network as ShNetwork, networkLabel: SH_NETWORKS.find((n) => n.key === b.network)?.label ?? b.network,
    name: b.name, handle: b.handle ?? null, unified: Number(b.unified) === 1, status: b.status as "draft" | "connected" | "off", connectedAt: b.connected_at ?? null,
    managers: queryRows<{ id: number; full_name: string | null; username: string }>("SELECT u.id,u.full_name,u.username FROM sh_bot_access a JOIN users u ON u.id=a.user_id WHERE a.bot_id=? AND a.manage=1 ORDER BY u.id", [b.id]).map(userName),
    lastMessageAt: null as string | null,
  }));
  return { bots, legacy: shLegacy(), networks: SH_NETWORKS, redirectText: shRedirectText(), connectEnabled: shConnectOn(), redirectEnabled: shRedirectOn(), legacyFinish: shLegacyFinishOn() };
}
/** Old per-expert Bale bots (bale_bots, read only) with migration progress from sh_legacy_moves. */
export function shLegacy() {
  let rows: any[] = [];
  try { rows = queryRows<any>("SELECT b.id, b.user_id, b.status, u.full_name, u.username FROM bale_bots b LEFT JOIN users u ON u.id=b.user_id WHERE b.user_id > 0 ORDER BY b.id"); } catch { return []; }
  return rows.filter((r) => !SH_EXCLUDED_USER_IDS.includes(Number(r.user_id))).map((r) => {
    const chats = Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM bale_bot_chats WHERE bot_id=? AND customer_id IS NOT NULL", [r.id])?.n ?? 0);
    const moved = Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM sh_legacy_moves WHERE legacy_bot_id=?", [r.id])?.n ?? 0);
    const st = queryRow<any>("SELECT * FROM sh_legacy_bots WHERE legacy_bot_id=?", [r.id]);
    const pct = chats ? Math.min(100, Math.round((moved / chats) * 100)) : 0;
    const out = shLegacyState(st?.migrated_at ?? null, st?.off_at ?? null);
    return { id: Number(r.id), name: `ربات ${userName({ id: Number(r.user_id), full_name: r.full_name, username: r.username })}`, liveStatus: r.status,
      customers: chats, moved, percent: pct, redirectAuto: Number(st?.redirect_auto ?? 0) === 1, migratedAt: st?.migrated_at ?? null, offAt: st?.off_at ?? null, state: out };
  });
}
/** 'redirecting' until migration is marked; then 'readonly' for 30 days; then 'off'. Pure. */
export function shLegacyState(migratedAt: string | null, offAt: string | null, now = new Date()): "redirecting" | "readonly" | "off" {
  if (!migratedAt) return "redirecting";
  if (offAt && new Date(offAt).getTime() <= now.getTime()) return "off";
  return "readonly";
}
export function shLegacyOffAt(migratedAt: Date): string { return new Date(migratedAt.getTime() + SH_LEGACY_OFF_DAYS * 86400_000).toISOString(); }
function legacyRow(id: number) {
  try { if (!queryRow("SELECT 1 x FROM bale_bots WHERE id=? AND user_id > 0", [id])) throw new ShError(404, "not_found", "این ربات پیدا نشد."); }
  catch (e) { if (e instanceof ShError) throw e; throw new ShError(404, "not_found", "این ربات پیدا نشد."); }
  const now = iso(); execute("INSERT OR IGNORE INTO sh_legacy_bots(legacy_bot_id,updated_at) VALUES(?,?)", [id, now]);
}
export function shSetRedirectAuto(u: AuthUser, id: number, on: boolean) {
  legacyRow(id); executeChanges("UPDATE sh_legacy_bots SET redirect_auto=?,updated_by=?,updated_at=? WHERE legacy_bot_id=?", [on ? 1 : 0, u.id, iso(), id]);
  shLog(u.id, "legacy_redirect_auto", id, { on }); return shLegacy();
}
/** «ارسال یک‌باره»: queues one redirect per chat that STARTED the old bot and has not moved yet. Never a chat that did not start it.
 *  Delivery is not built: rows stay 'queued' (no Bale call here). */
export function shSendRedirectOnce(u: AuthUser, id: number): { queued: number; skipped: number } {
  legacyRow(id);
  const chats = queryRows<{ id: number }>("SELECT id FROM bale_bot_chats WHERE bot_id=? AND id NOT IN (SELECT chat_row FROM sh_legacy_moves WHERE legacy_bot_id=?)", [id, id]);
  let queued = 0; const now = iso();
  for (const c of chats) queued += executeChanges("INSERT OR IGNORE INTO sh_redirect_sends(legacy_bot_id,chat_row,mode,requested_by,created_at) VALUES(?,?,'once',?,?)", [id, c.id, u.id, now]);
  shLog(u.id, "legacy_redirect_once", id, { queued, skipped: chats.length - queued });
  return { queued, skipped: chats.length - queued };
}
/** Marks an old bot migrated: read-only now, off 30 days later (Mohammad t418s1663). */
export function shMarkMigrated(u: AuthUser, id: number, now = new Date()) {
  if (!shLegacyFinishOn()) throw new ShError(404, "not_found", "این امکان فعال نیست.");
  legacyRow(id);
  executeChanges("UPDATE sh_legacy_bots SET migrated_at=COALESCE(migrated_at,?), off_at=COALESCE(off_at,?), updated_by=?, updated_at=? WHERE legacy_bot_id=?",
    [now.toISOString(), shLegacyOffAt(now), u.id, iso(), id]);
  shLog(u.id, "legacy_migrated", id); return shLegacy();
}
/** «بازگرداندن»: undoes «پایان انتقال» while the bot is not off yet (same flag). */
export function shUndoMigrated(u: AuthUser, id: number, now = new Date()) {
  if (!shLegacyFinishOn()) throw new ShError(404, "not_found", "این امکان فعال نیست.");
  legacyRow(id);
  const st = queryRow<{ migrated_at: string | null; off_at: string | null }>("SELECT migrated_at, off_at FROM sh_legacy_bots WHERE legacy_bot_id=?", [id]);
  if (!st?.migrated_at) throw new ShError(409, "not_migrated", "انتقال این ربات هنوز پایان نیافته است.");
  if (st.off_at && new Date(st.off_at).getTime() <= now.getTime()) throw new ShError(409, "already_off", "این ربات خاموش شده و بازگرداندن ممکن نیست.");
  executeChanges("UPDATE sh_legacy_bots SET migrated_at=NULL, off_at=NULL, updated_by=?, updated_at=? WHERE legacy_bot_id=?", [u.id, iso(), id]);
  shLog(u.id, "legacy_migrated_undo", id); return shLegacy();
}
/** Records that a customer of an old bot started the unified bot (server-side match by Bale user id; no re-auth, no phone). */
export function shRecordMove(legacyBotId: number, chatRow: number, baleUserId: string | null, customerId: number | null, now = new Date()): boolean {
  return executeChanges("INSERT OR IGNORE INTO sh_legacy_moves(legacy_bot_id,chat_row,bale_user_id,customer_id,moved_at) VALUES(?,?,?,?,?)",
    [legacyBotId, chatRow, baleUserId, customerId, now.toISOString()]) > 0;
}
export function shRedirectText(): string { return queryRow<{ value: string }>("SELECT value FROM sh_settings WHERE key='redirect_text'")?.value ?? SH_DEFAULT_REDIRECT_TEXT; }
export function shSetRedirectText(u: AuthUser, raw: unknown): string {
  const t = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) throw new ShError(400, "body_required", "متن پیام هدایت را بنویسید.", { field: "body" });
  if ([...t].length > 1000) throw new ShError(400, "body_too_long", "متن پیام هدایت حداکثر ۱۰۰۰ نویسه باشد.", { field: "body" });
  execute("INSERT INTO sh_settings(key,value,updated_by,updated_at) VALUES('redirect_text',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at", [t, u.id, iso()]);
  shLog(u.id, "redirect_text", null); return t;
}
export function shAddBot(u: AuthUser, body: any) {
  const network = String(body?.network ?? "");
  if (!SH_NETWORKS.some((n) => n.key === network)) throw new ShError(400, "bad_network", "شبکه را انتخاب کنید.", { field: "network" });
  if (queryRow("SELECT 1 x FROM sh_bots WHERE network=? AND archived_at IS NULL", [network])) throw new ShError(409, "exists", "برای این شبکه ربات ثبت شده است.", { field: "network" });
  if (body?.token) throw new ShError(409, "connect_disabled", "اتصال ربات در این نسخه خاموش است؛ کلید ذخیره نشد.", { field: "token" });
  const now = iso(); const label = SH_NETWORKS.find((n) => n.key === network)!.label;
  const id = execute("INSERT INTO sh_bots(network,name,handle,unified,status,created_by,created_at,updated_at) VALUES(?,?,?,0,'draft',?,?,?)",
    [network, `${SH_BOT_NAME}، ${label}`, clean(body?.handle, 64) || null, u.id, now, now]);
  if (body?.access === "like_bale") {
    const src = queryRow<{ id: number }>("SELECT id FROM sh_bots WHERE unified=1 AND network='bale'");
    if (src) execute("INSERT OR IGNORE INTO sh_bot_access(bot_id,user_id,manage,customers_message,view_scope,updated_by,updated_at) SELECT ?,user_id,manage,customers_message,view_scope,?,? FROM sh_bot_access WHERE bot_id=?", [id, u.id, now, src.id]);
  }
  shLog(u.id, "bot_add", Number(id), { network });
  return shBots();
}
/** t945u «ویرایش»: a draft bot of another network (not the unified Bale bot, whose key is replaced through «اتصال ربات»). Handle only. */
export function shUpdateBot(u: AuthUser, botId: number, body: any) {
  const bot = queryRow<any>("SELECT * FROM sh_bots WHERE id=? AND archived_at IS NULL", [botId]);
  if (!bot) throw new ShError(404, "not_found", "این ربات پیدا نشد.");
  if (Number(bot.unified) === 1) throw new ShError(409, "unified_bot", "ربات نفیس وام را با «اتصال ربات» عوض کنید.");
  const raw = clean(body?.handle, 80).replace(/^@/, "");
  if (raw && !/^[A-Za-z0-9_]{3,64}$/.test(raw)) throw new ShError(400, "bad_handle", "نشانی ربات را فقط با حرف انگلیسی، عدد و _ بنویسید (حداقل ۳ نویسه).", { field: "handle" });
  const handle = raw ? `@${raw}` : null;
  executeChanges("UPDATE sh_bots SET handle=?, updated_at=? WHERE id=?", [handle, iso(), botId]);
  shLog(u.id, "bot_edit", botId, { network: String(bot.network), handleBefore: bot.handle ?? null, handleAfter: handle });
  return shBots();
}
/** t945u «حذف ربات» for a draft bot row: archived, never deleted; its access rows stay for the audit trail. Re-adding the network works afterwards. */
export function shArchiveBot(u: AuthUser, botId: number) {
  const bot = queryRow<any>("SELECT * FROM sh_bots WHERE id=? AND archived_at IS NULL", [botId]);
  if (!bot) throw new ShError(404, "not_found", "این ربات پیدا نشد.");
  if (Number(bot.unified) === 1) throw new ShError(409, "unified_bot", "ربات نفیس وام حذف نمی‌شود؛ «قطع اتصال و حذف» اتصال آن را برمی‌دارد.");
  const now = iso();
  executeChanges("UPDATE sh_bots SET archived_at=?, status='off', updated_at=? WHERE id=?", [now, now, botId]);
  shLog(u.id, "bot_remove", botId, { network: String(bot.network), handle: bot.handle ?? null, status: String(bot.status) });
  return shBots();
}
export function shTestConnect(): never { throw new ShError(409, "connect_disabled", "آزمایش اتصال در این نسخه خاموش است؛ هیچ کلیدی فرستاده یا ذخیره نشد."); }

export function shAccess(botId: number) {
  const bot = queryRow<any>("SELECT * FROM sh_bots WHERE id=? AND archived_at IS NULL", [botId]); if (!bot) throw new ShError(404, "not_found", "این ربات پیدا نشد.");
  const users = staffUsers();
  const teams = queryRows<{ id: number; name: string }>("SELECT id,name FROM sales_teams WHERE enabled=1 ORDER BY id");
  const mem = queryRows<{ team_id: number; salesperson_id: number; sort_order: number }>("SELECT team_id,salesperson_id,sort_order FROM sales_team_members ORDER BY team_id, sort_order");
  const acc = new Map(queryRows<any>("SELECT * FROM sh_bot_access WHERE bot_id=?", [botId]).map((a) => [Number(a.user_id), a]));
  const row = (x: typeof users[number]) => {
    const a = acc.get(Number(x.id)); const mgr = x.role !== "salesperson";
    return { userId: Number(x.id), name: userName(x), manage: a ? Number(a.manage) === 1 : mgr, customersMessage: a ? Number(a.customers_message) === 1 : true,
      viewScope: (a?.view_scope ?? (mgr ? "all" : "own")) as "own" | "all" | "none" };
  };
  const used = new Set<number>();
  const groups = teams.map((t) => {
    const sps = mem.filter((m) => Number(m.team_id) === Number(t.id)).map((m) => Number(m.salesperson_id));
    const list = users.filter((x) => x.role === "salesperson" && sps.includes(Number(x.salesperson_id)));
    list.forEach((x) => used.add(Number(x.id)));
    return { key: `team-${t.id}`, name: t.name, rows: list.sort((a, b) => sps.indexOf(Number(a.salesperson_id)) - sps.indexOf(Number(b.salesperson_id))).map(row) };
  }).filter((g) => g.rows.length);
  const rest = users.filter((x) => x.role === "salesperson" && !used.has(Number(x.id)));
  if (rest.length) groups.push({ key: "no-team", name: "بدون تیم", rows: rest.map(row) });
  const mgrs = users.filter((x) => x.role !== "salesperson");
  if (mgrs.length) groups.push({ key: "managers", name: "مدیریت", rows: mgrs.map(row) });
  const nl = SH_NETWORKS.find((n) => n.key === bot.network)?.label ?? bot.network;
  return { bot: { id: Number(bot.id), name: String(bot.name).includes(nl) ? bot.name : `${bot.name}، ${nl}`, network: bot.network, networkLabel: nl, handle: bot.handle ?? null, status: bot.status }, groups };
}
export function shSaveAccess(u: AuthUser, botId: number, rows: unknown) {
  if (!queryRow("SELECT 1 x FROM sh_bots WHERE id=? AND archived_at IS NULL", [botId])) throw new ShError(404, "not_found", "این ربات پیدا نشد.");
  if (!Array.isArray(rows) || rows.length > 500) throw new ShError(400, "bad_rows", "فهرست دسترسی معتبر نیست.");
  const valid = new Set(staffUsers().map((x) => Number(x.id))); const now = iso(); let n = 0;
  for (const r of rows as any[]) {
    const uid = Number(r?.userId); if (!valid.has(uid)) continue;
    const scope = ["own", "all", "none"].includes(r?.viewScope) ? r.viewScope : "own";
    execute(`INSERT INTO sh_bot_access(bot_id,user_id,manage,customers_message,view_scope,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,user_id) DO UPDATE SET manage=excluded.manage, customers_message=excluded.customers_message, view_scope=excluded.view_scope, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [botId, uid, r?.manage ? 1 : 0, r?.customersMessage === false ? 0 : 1, scope, u.id, now]); n++;
  }
  shLog(u.id, "access_save", botId, { rows: n });
  return shAccess(botId);
}

/* ---------------- today card: identity + «ارسال پیام» ---------------- */
export function shReachable(customerId: number): boolean {
  try { return Boolean(queryRow("SELECT 1 x FROM bale_bot_chats WHERE customer_id=? LIMIT 1", [customerId])); } catch { return false; }
}
/** Public link of the unified bot from its saved handle; null until a handle exists (no handle is invented). */
export function shBotLink(): string | null {
  const h = queryRow<{ handle: string | null }>("SELECT handle FROM sh_bots WHERE unified=1 AND network='bale'")?.handle;
  const v = String(h ?? "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{3,64}$/.test(v) ? `https://ble.ir/${v}` : null;
}
const ID_DOC_LABEL: Record<string, string> = { national_card_front: "روی کارت ملی", national_card_back: "پشت کارت ملی", birth_cert_p1: "صفحهٔ اول شناسنامه", birth_cert_p2: "صفحهٔ دوم شناسنامه", birth_cert_p3: "صفحهٔ سوم شناسنامه" };
export function shIdentity(customerId: number) {
  const c = queryRow<{ national_code: string | null; birth_date_jalali: string | null }>("SELECT national_code, birth_date_jalali FROM customers WHERE id=?", [customerId]);
  let docs: { id: number; type: string; label: string; createdAt: string }[] = [];
  try { docs = queryRows<any>("SELECT id, document_type, created_at FROM customer_identity_documents WHERE customer_id=? AND is_latest=1 ORDER BY id", [customerId])
    .map((d) => ({ id: Number(d.id), type: d.document_type, label: ID_DOC_LABEL[d.document_type] ?? d.document_type, createdAt: d.created_at })); } catch { docs = []; }
  const src = queryRow<{ source: string }>("SELECT source FROM sh_identity_source WHERE customer_id=?", [customerId])?.source ?? null;
  const nid = String(c?.national_code ?? "").trim(); const born = String(c?.birth_date_jalali ?? "").trim();
  return { nationalCode: nid || null, birthDate: born || null, registered: Boolean(nid && born), source: src, docs };
}
export function shTodayBox(u: AuthUser, customerId: number) {
  const cur = shCurrentPlanId(customerId);
  const send = requireSend();
  const maxFile = send.shBaleFileMaxBytes();
  const msgs = queryRows<any>("SELECT * FROM sh_messages WHERE archived=0 AND show_today=1 ORDER BY sort, id").map(msgView);
  const plans = shPlans().map((p) => ({ ...p, current: p.id === cur, messages: msgs.filter((m) => m.kind === "plan" && m.planId === p.id),
    docs: shDocs({ planId: p.id }).map((d) => ({ ...d, tooBig: d.sizeBytes > maxFile })) }))
    .filter((p) => p.current || p.messages.length);
  const sends = queryRows<any>("SELECT s.id, s.status, s.created_at, s.plan_id, s.fail_reason, s.retryable, s.source, s.message_id, m.title, s.user_id FROM sh_sends s LEFT JOIN sh_messages m ON m.id=s.message_id WHERE s.customer_id=? ORDER BY s.id DESC LIMIT 8", [customerId])
    .map((s) => ({ id: Number(s.id), status: s.status, at: s.created_at, title: s.title ?? "پیام", planName: planById(s.plan_id)?.name ?? null,
      mine: Number(s.user_id) === Number(u.id), failReason: s.fail_reason ?? null, retryable: Number(s.retryable) === 1, source: s.source, messageId: s.message_id == null ? null : Number(s.message_id) }));
  const gate = send.shSendGate(u, customerId);
  const recentIds = queryRows<{ message_id: number }>("SELECT message_id FROM sh_sends WHERE customer_id=? AND status IN ('queued','sent','sending') AND created_at>=? AND message_id IS NOT NULL",
    [customerId, new Date(Date.now() - send.SH_DEDUPE_MS).toISOString()]).map((r) => Number(r.message_id));
  return { customerId, customerName: queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [customerId])?.name ?? "", expertName: u.fullName || u.username,
    identity: shIdentity(customerId), reachable: gate.ok || gate.error !== "unreachable", botName: SH_BOT_NAME, botLink: shBotLink(),
    sendBlock: gate.ok ? null : { error: gate.error, message: gate.message, expertName: gate.expertName ?? null },
    recentMessageIds: recentIds, baleFileMaxBytes: maxFile, currentPlanId: cur, plans, free: msgs.filter((m) => m.kind === "free"), sends };
}
export function shSend(u: AuthUser, customerId: number, body: any, now = new Date()) {
  const msg = queryRow<any>("SELECT * FROM sh_messages WHERE id=? AND archived=0", [Number(body?.messageId)]);
  if (!msg) throw new ShError(400, "message_required", "پیام را انتخاب کنید.", { field: "messageId" });
  if (Number(msg.show_today) !== 1) throw new ShError(403, "not_for_today", "این پیام برای کارهای امروز روشن نیست.");
  const planId = msg.kind === "plan" ? Number(msg.plan_id) : null;
  const docIds = Array.isArray(body?.docIds) ? [...new Set((body.docIds as unknown[]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 5) : [];
  let maxFile = 52428800;
  try { const { shBaleFileMaxBytes } = requireSend(); maxFile = shBaleFileMaxBytes(); } catch { /* default */ }
  for (const d of docIds) {
    const r = queryRow<any>("SELECT plan_id, size_bytes FROM sh_docs WHERE id=? AND archived=0", [d]);
    if (!r || (planId != null && r.plan_id != null && Number(r.plan_id) !== planId)) throw new ShError(400, "bad_doc", "فایل انتخاب‌شده معتبر نیست.", { field: "docIds" });
    if (Number(r.size_bytes) > maxFile) throw new ShError(409, "file_too_big", "حجم فایل برای ارسال در بله زیاد است.", { field: "docIds" });
  }
  const gate = requireSend().shSendGate(u, customerId);
  if (!gate.ok) throw new ShError(409, gate.error, gate.message, { botLink: shBotLink(), expertName: gate.expertName ?? null });
  if (requireSend().shRecentSend(customerId, Number(msg.id), now)) throw new ShError(409, "recent", "همین الان فرستاده شد؛ ارسال دوباره بعد از ۱۰ دقیقه.");
  const c = queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [customerId]);
  const text = shRender(msg.body, { customer: c?.name ?? "", expert: u.fullName || u.username, plan: planById(planId)?.choiceLabel ?? "" });
  const id = execute("INSERT INTO sh_sends(customer_id,user_id,plan_id,message_id,doc_ids,body,source,status,created_at,chat_row,bot_id) VALUES(?,?,?,?,?,?,'today','queued',?,?,?)",
    [customerId, u.id, planId, msg.id, JSON.stringify(docIds), text, now.toISOString(), gate.chat.chatRow, gate.chat.botId]);
  shLog(u.id, "send_today", Number(id), { customerId, messageId: Number(msg.id), docs: docIds.length });
  if (shSendOn()) requireSend().shDeliverSend(Number(id));
  return { id: Number(id), status: "queued" as const, delivery: shSendOn() ? "on" : "queued_only" };
}
/** Hook for Ms. Hasani's Bale flow and any plan link: queues every auto_send message of that plan once per customer (Mohammad t418s1654:
 *  same per-plan «ارسال خودکار» checkbox). No-op while flag.social_hub_v1 or flag.social_hub_auto_send_v1 is OFF.
 *  Delivery also requires flag.social_hub_send_v1; send_v1 alone never auto-sends. */
export function shOnPlanLinked(customerId: number, planId: number, now = new Date(), chat?: { chatRow: number; botId: number }): number {
  if (!shOn() || !shAutoSendOn()) return 0;
  ensureSocialHubSchema();
  const send = requireSend();
  const latest = chat ? { chatRow: chat.chatRow, botId: chat.botId, botUserId: queryRow<{ u: number }>("SELECT user_id u FROM bale_bots WHERE id=?", [chat.botId])?.u ?? -1 }
    : (() => { const c = send.shLatestChat(customerId); return c ? { chatRow: c.chatRow, botId: c.botId, botUserId: c.botUserId } : null; })();
  if (!latest) return 0;
  // Auto-send is not the redirect: Ghasemi's bot stays read-only here.
  if (send.shIsReadonlyBotUser(latest.botUserId)) return 0;
  const c = queryRow<{ name: string; salesperson_id: number | null }>("SELECT name, salesperson_id FROM customers WHERE id=?", [customerId]); if (!c) return 0;
  const expert = queryRow<{ n: string }>("SELECT COALESCE(NULLIF(TRIM(full_name),''),username) n FROM users WHERE salesperson_id=? AND active=1 ORDER BY id LIMIT 1", [c.salesperson_id ?? -1])?.n ?? "";
  let n = 0;
  const ids: number[] = [];
  for (const m of queryRows<any>("SELECT * FROM sh_messages WHERE archived=0 AND kind='plan' AND plan_id=? AND auto_send=1 ORDER BY sort, id", [planId])) {
    const added = executeChanges("INSERT OR IGNORE INTO sh_sends(customer_id,user_id,plan_id,message_id,doc_ids,body,source,status,created_at,chat_row,bot_id) VALUES(?,NULL,?,?,'[]',?,'auto','queued',?,?,?)",
      [customerId, planId, m.id, shRender(m.body, { customer: c.name, expert, plan: planById(planId)?.choiceLabel ?? "" }), now.toISOString(), latest.chatRow, latest.botId]);
    if (added) {
      n += added;
      const row = queryRow<{ id: number }>("SELECT id FROM sh_sends WHERE customer_id=? AND message_id=? AND source='auto'", [customerId, m.id]);
      if (row) ids.push(Number(row.id));
    }
  }
  if (shSendOn()) for (const id of ids) send.shDeliverSend(id);
  return n;
}

/* ---------------- unknown number → existing customer (flag.social_hub_phone_attach_v1) ---------------- */
const digitsLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export type ShPickRow = { id: number; name: string; phone: string; ownerName: string | null; mine: boolean; extras: string[] };
/** Search by name, phone or id across ALL owners (Mohammad t418s1654: any expert, full number visible). Max 20 rows. */
export function shPhoneSearch(u: AuthUser, raw: unknown): ShPickRow[] {
  const q = clean(raw, 60); if (!q) return [];
  const lat = digitsLatin(q).replace(/^#/, "").trim();
  const where: string[] = []; const args: (string | number)[] = [];
  if (/^\d{1,7}$/.test(lat)) { where.push("c.id=?"); args.push(Number(lat)); }
  const ph = lat.replace(/[\s-]/g, "");
  if (/^\d{4,11}$/.test(ph)) { where.push("c.phone LIKE ?"); args.push(`%${ph}%`); where.push("EXISTS (SELECT 1 FROM customer_phones xp WHERE xp.customer_id=c.id AND xp.phone LIKE ?)"); args.push(`%${ph}%`); }
  if (!/^\d+$/.test(ph)) { where.push("c.name LIKE ?"); args.push(`%${q}%`); }
  if (!where.length) return [];
  const rows = queryRows<any>(`SELECT c.id, c.name, c.phone, c.salesperson_id, s.name owner FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
    WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status,'in_progress')<>'cancelled' AND (${where.join(" OR ")}) ORDER BY c.id DESC LIMIT 20`, args);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, phone: normalizeCustomerMobile(r.phone ?? "") || String(r.phone ?? ""), ownerName: r.owner ?? null,
    mine: u.salespersonId != null && Number(r.salesperson_id) === Number(u.salespersonId),
    extras: queryRows<{ phone: string }>("SELECT phone FROM customer_phones WHERE customer_id=? ORDER BY id", [r.id]).map((x) => x.phone) }));
}

export type ShAttachResult =
  | { ok: true; customerId: number; phones: { primary: string; extras: string[] }; callLinked: boolean }
  | { ok: false; status: number; error: string; message: string; customer?: { id: number; name: string; ownerName: string | null } };
/** Adds an unknown caller's number to an existing customer. Never creates a customer. Duplicate on another customer → not saved,
 *  that customer is returned so the card can open it. callEventId + logCall → links that call card (only the caller's own card). */
export function shAttachPhone(u: AuthUser, customerId: number, phone: unknown, opts: { callEventId?: number | null; logCall?: boolean },
  deps: { add: (u: AuthUser, id: number, phone: unknown) => any; link: (u: AuthUser, eventId: number, customerId: number) => boolean }): ShAttachResult {
  if (!shPhoneOn()) return { ok: false, status: 404, error: "not_found", message: "این امکان فعال نیست." };
  const r = deps.add(u, customerId, phone);
  if (!r.ok) {
    const c = r.customer ? { id: Number(r.customer.id), name: String(r.customer.name), ownerName: r.customer.salespersonName ?? null } : undefined;
    const msg = r.error === "duplicate_mobile" ? "این شماره همین حالا برای مشتری دیگری ثبت شده است." : r.message;
    return { ok: false, status: r.status, error: r.error, message: msg, ...(c ? { customer: c } : {}) };
  }
  let callLinked = false;
  if (opts.logCall && opts.callEventId && Number.isSafeInteger(Number(opts.callEventId))) {
    try { callLinked = deps.link(u, Number(opts.callEventId), customerId); } catch { callLinked = false; }
  }
  shLog(u.id, "phone_attach", customerId, { callLinked });
  return { ok: true, customerId, phones: { primary: r.view.primary.phone, extras: r.view.extras.map((x: any) => x.phone) }, callLinked };
}

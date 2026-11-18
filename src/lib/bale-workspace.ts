/**
 * «فضای کار بله» v1.0 — Armita's design nafis-design/mockups/bale-workspace (spec.md, sections الف–ز), built behind ONE flag that stays OFF.
 * Mohammad approved building it (only building it) on t382s1481; his answers on t381s1476:
 *   - all parts (الف … ز) together;
 *   - no Bale account → the invite SMS still goes AND the expert sees «این شماره بله ندارد» (Armita 2026-11-18: ONLY the invite error says this; the login «sign_up_needed» text and the outbox no-account text stay as live);
 *   - bulk + scenarios: sales manager + admin only; an expert sends single messages, ready-made messages and invites only;
 *   - bulk: no daily cap;
 *   - a customer writing «لغو» / «توقف» changes nothing (no opt-out list, nobody is removed from any list);
 *   - no-reply and hand-off together: message Y first; still no reply → the chat is handed to the expert (in-app notice);
 *   - «داشته‌های من» = ready-made messages + plan terms + expert-facing training files (no wallet).
 *
 * Flag: flag.bale_workspace_v1 (call_queue_settings; absent / ≠ '1' = OFF). OFF → every /api/bale-workspace route falls through (404 as before),
 *   no schema is created, the tick returns after ONE settings read, the inbox / today / console render exactly as before.
 *   The inbox itself still needs flag.bale_bot + flag.bale_bot.user.<id> (unchanged); view level own/all/none is unchanged (bbView).
 * Never: user 29; Ghasemi's bot (BC_GHASEMI_USER_ID = 3, read-only; her sign reminder stays as it is); loan_plans / contracts /
 *   team_sales_config / notification_settings writes (plan terms live in their own table); Bale session reconnects; paid Bale / commercial
 *   messaging. All sends go through the existing bot outbox (bale_bot_messages → BaleBotWorker) or, for the invite, the injectable transport.
 * Schema: additive only (new bws_* tables, created lazily while ON).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { isSalesManagerUser } from "./sales-manager";
import { BB_EXCLUDED_USER_IDS, BB_LIMITS, bbLog, bbUser, bbView, botById, botLive, botSends, chatName, filesDir, nameOf, normPhone, type BbUser } from "./bale-bot";

export const BWS_FLAG = "flag.bale_workspace_v1";
export const BWS_GHASEMI_USER_ID = 3;
export const BWS_NEVER_USER_IDS = [...BB_EXCLUDED_USER_IDS]; // 29
export const BWS_NO_BALE_TEXT = "این شماره بله ندارد";
/** Mohammad t383s1491 — the invite SMS pattern as it must be registered in IPPanel BY HAND (this code never registers it and never calls IPPanel
 *  for it). Until a pattern code is saved in «مدیریت فروش» the SMS leg is «تنظیم نشده» (not_configured) and nothing is sent.
 *  Variable mapping: {نام} in the text = IPPanel variable «name» (sent as params.name) ← the customer's name. */
export const BWS_INVITE_SMS_PATTERN_TEXT = "سلام {نام}، برای ادامه‌ی گفتگو با کارشناس نفیس وام، ربات @nafisvambot را در بله باز کنید.";
export const BWS_INVITE_SMS_PATTERN_VARS = [{ token: "{نام}", ippanel: "name", source: "customer.name" }] as const;
export const BWS_DEFAULT_INVITE = "سلام {name}، برای ادامه از ربات بلهٔ نفیس وام پیام بدهید.";
export const BWS_TRAINING_MAX_BYTES = 50 * 1024 * 1024;
/** Automatic / bulk / no-reply sends only between these Tehran hours (the expert's own single sends are not held). */
/** Mohammad t383s1491: scenario messages have NO time window (the earlier 8:00–21:00 limit is removed). */
export const BWS_BULK_PER_TICK = 20;

const setting = (k: string): string | null => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; } catch { return null; } };
export const bwsOn = () => setting(BWS_FLAG) === "1";
export const K = { inviteText: "bws.invite_text", smsPattern: "bws.invite_sms_pattern", autoOn: "bws.auto_on" } as const;
const iso = () => new Date().toISOString();
const setSetting = (k: string, v: string, by: number) => {
  execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [k, v]);
  bwsLog(by, "setting", "ok", { key: k });
};

/* ---------------- schema (lazy, only while ON; additive) ---------------- */
let schemaReady = false;
export function ensureBwsSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS bws_stars(customer_id INTEGER PRIMARY KEY, stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 3), set_by INTEGER, set_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bws_plan_terms(plan_id INTEGER PRIMARY KEY, body TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bws_plans_explained(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, plan_name TEXT,
      chat_row INTEGER, user_id INTEGER, message_id INTEGER, sent_at TEXT NOT NULL, UNIQUE(customer_id, plan_id));
    CREATE TABLE IF NOT EXISTS bws_training_files(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','video','link')),
      url TEXT, stored_name TEXT, file_name TEXT, mime TEXT, size INTEGER, sha256 TEXT, plan_scope TEXT NOT NULL DEFAULT 'all' CHECK(plan_scope IN ('all','selected')),
      plan_ids TEXT, audience TEXT NOT NULL CHECK(audience IN ('customer','expert')), active INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bws_invites(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, user_id INTEGER NOT NULL, sender_user_id INTEGER,
      bale_state TEXT NOT NULL, bale_ref TEXT, sms_state TEXT NOT NULL, sms_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_bws_inv_customer ON bws_invites(customer_id, id);
    CREATE TABLE IF NOT EXISTS bws_scenarios(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('auto','noreply','bulk')),
      audience TEXT NOT NULL, cond TEXT, body TEXT NOT NULL, training_file_id INTEGER, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','done')),
      recipients INTEGER, created_by INTEGER, confirmed_by INTEGER, confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bws_scenario_sends(id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_id INTEGER NOT NULL, chat_row INTEGER NOT NULL, stage TEXT NOT NULL,
      ref_msg INTEGER NOT NULL DEFAULT 0, message_id INTEGER, at TEXT NOT NULL, UNIQUE(scenario_id, chat_row, stage, ref_msg));
    CREATE TABLE IF NOT EXISTS bws_handoffs(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL, owner_salesperson_id INTEGER NOT NULL,
      chat_row INTEGER, scenario_id INTEGER, day TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(customer_id, owner_salesperson_id, day));
    CREATE TABLE IF NOT EXISTS bws_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT);
  `);
  schemaReady = true;
}
export const _resetBwsSchemaForTests = () => { schemaReady = false; };
/** ids / codes / counts only: never a phone, token or message text. */
export function bwsLog(userId: number | null, action: string, outcome: string, detail?: Record<string, string | number | boolean | null>) {
  try { execute("INSERT INTO bws_log(at,user_id,action,outcome,detail) VALUES(?,?,?,?,?)", [iso(), userId, action, outcome, detail ? JSON.stringify(detail).slice(0, 400) : null]); } catch { /* never breaks the caller */ }
}

/* ---------------- people ---------------- */
export type BwsMe = { on: true; userId: number; canManage: boolean; inbox: "all" | "own" | null; isExpert: boolean };
export function bwsCanManage(u: BbUser | null | undefined): boolean {
  if (!u || u.active === 0 || BWS_NEVER_USER_IDS.includes(u.id)) return false;
  return u.role === "admin" || isSalesManagerUser(u); // effective role: admin + sales manager (= cqManager)
}
export function bwsMe(u: BbUser): BwsMe {
  return { on: true, userId: u.id, canManage: bwsCanManage(u), inbox: bbView(u), isExpert: u.salesperson_id != null && !bwsCanManage(u) };
}
/** Own customer (expert) or any customer (sales manager / admin). Merged customers are never a target. */
export function bwsCustomerAccess(u: BbUser, customerId: number): { id: number; name: string; phone: string | null; national_code: string | null; salesperson_id: number | null } | null {
  const c = queryRow<any>("SELECT id,name,phone,national_code,salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c) return null;
  if (bwsCanManage(u)) return c;
  return u.salesperson_id != null && Number(c.salesperson_id) === Number(u.salesperson_id) ? c : null;
}

/* ---------------- chats (same visibility as routes/bale-bot.ts chatFor) ---------------- */
export type BwsChat = { id: number; bot_id: number; chat_id: string; customer_id: number | null; first_name: string | null; last_name: string | null; username: string | null; owner_id: number; last_at: string | null };
function sharedAssigned(u: BbUser, c: { owner_id: number; customer_id: number | null }) {
  if (Number(c.owner_id) !== 0 || !c.customer_id || u.salesperson_id == null) return false;
  const cu = queryRow<{ s: number | null }>("SELECT salesperson_id s FROM customers WHERE id=?", [c.customer_id]);
  return !!cu && Number(cu.s) === Number(u.salesperson_id);
}
export function bwsChatFor(u: BbUser, id: number): BwsChat | null {
  const v = bbView(u); if (!v) return null;
  const c = queryRow<BwsChat>("SELECT c.id,c.bot_id,c.chat_id,c.customer_id,c.first_name,c.last_name,c.username,c.last_at,b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.id=?", [id]);
  if (!c) return null;
  return v === "all" || c.owner_id === u.id || sharedAssigned(u, c) ? c : null;
}
/** The chat's customer may be shown in full (phone + national id) only when the viewer may see that customer. */
export function bwsSeesCustomer(u: BbUser, customerId: number | null): boolean {
  if (!customerId) return false;
  if (bwsCanManage(u)) return true;
  const c = queryRow<{ s: number | null }>("SELECT salesperson_id s FROM customers WHERE id=?", [customerId]);
  return !!c && u.salesperson_id != null && Number(c.s) === Number(u.salesperson_id);
}
/** Send gate: Ghasemi's bot is read-only here, bots on bale_bot.no_send_sp and dead bots never send. */
export function bwsBotSendable(botId: number): boolean {
  const b = botById(botId); if (!b) return false;
  if (Number(b.user_id) === BWS_GHASEMI_USER_ID || BWS_NEVER_USER_IDS.includes(Number(b.user_id))) return false;
  return botLive(b) && botSends(b);
}

/* ---------------- outbound through the existing bot outbox ---------------- */
let kick: () => void = () => {};
export const setBwsKick = (f: () => void) => { kick = f; };
export function bwsQueue(chat: { id: number; bot_id: number; customer_id: number | null; owner_id: number }, actorId: number | null, o: { text: string | null; file?: { name: string; mime: string; size: number; rel: string; sendAs: string } }): number {
  const kind = o.file ? (o.file.sendAs === "video" ? "video" : "document") : "text";
  const t = iso();
  const id = execute(`INSERT INTO bale_bot_messages(chat_row,dir,kind,text,file_name,mime,size,file_path,file_state,send_as,status,author_user_id,created_at)
    VALUES(?,'out',?,?,?,?,?,?,?,?,'sending',?,?)`, [chat.id, kind, o.text, o.file?.name ?? null, o.file?.mime ?? null, o.file?.size ?? null, o.file?.rel ?? null, o.file ? "stored" : null, o.file?.sendAs ?? null, actorId, t]);
  executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [t, o.text ? o.text.replace(/\s+/g, " ").slice(0, 80) : "فایل", chat.id]);
  bbLog({ userId: actorId, botId: chat.bot_id, chatRow: chat.id, customerId: chat.customer_id, action: "bws.queue", outcome: "ok", detail: { kind } });
  kick();
  return id;
}
/** Copies a stored file into the bot files dir (the bot worker only reads from there). */
export function bwsStageFile(botId: number, srcAbs: string, name: string): string {
  const rel = path.join(String(botId), `bws-${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80)}`);
  fs.mkdirSync(path.dirname(path.join(filesDir(), rel)), { recursive: true, mode: 0o700 });
  fs.copyFileSync(srcAbs, path.join(filesDir(), rel));
  fs.chmodSync(path.join(filesDir(), rel), 0o600);
  return rel;
}
export const fill = (text: string, name: string) => text.replace(/\{name\}|\{نام\}/g, name).slice(0, BB_LIMITS.textMax);

/* ---------------- ج. stars (customer, not chat) ---------------- */
export function starsOf(customerId: number | null | undefined): number {
  if (!customerId) return 0;
  try { return queryRow<{ s: number }>("SELECT stars s FROM bws_stars WHERE customer_id=?", [customerId])?.s ?? 0; } catch { return 0; }
}
export function setStars(u: BbUser, customerId: number, stars: number) {
  if (stars === 0) executeChanges("DELETE FROM bws_stars WHERE customer_id=?", [customerId]);
  else execute("INSERT INTO bws_stars(customer_id,stars,set_by,set_at) VALUES(?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET stars=excluded.stars,set_by=excluded.set_by,set_at=excluded.set_at", [customerId, stars, u.id, iso()]);
  bwsLog(u.id, "stars", "ok", { customerId, stars });
}
/** ج: three above two above one above none; inside a level, newest message first. */
export function sortByStars<T extends { customer_id: number | null; last_at: string | null; created_at?: string }>(rows: T[]): (T & { stars: number })[] {
  const s = rows.map(r => ({ ...r, stars: starsOf(r.customer_id) }));
  return s.sort((a, b) => (b.stars - a.stars) || String(b.last_at ?? b.created_at ?? "").localeCompare(String(a.last_at ?? a.created_at ?? "")));
}

/* ---------------- و. plan terms ---------------- */
export type PlanRow = { id: number; name: string; active: number };
export function plans(): PlanRow[] {
  return queryRows<any>("SELECT id, name, bank_name, active FROM loan_plans ORDER BY active DESC, id").map(p => ({ id: p.id, name: String(p.name || p.bank_name || `طرح ${p.id}`).trim(), active: Number(p.active ?? 1) }));
}
export const termsOf = (planId: number) => queryRow<{ body: string }>("SELECT body FROM bws_plan_terms WHERE plan_id=?", [planId])?.body ?? null;
export function setTerms(u: BbUser, planId: number, body: string) {
  const b = body.trim().slice(0, 1500);
  if (!b) executeChanges("DELETE FROM bws_plan_terms WHERE plan_id=?", [planId]);
  else execute("INSERT INTO bws_plan_terms(plan_id,body,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET body=excluded.body,updated_by=excluded.updated_by,updated_at=excluded.updated_at", [planId, b, u.id, iso()]);
  bwsLog(u.id, "plan_terms", "ok", { planId, empty: !b });
}
export function planTermsMessage(name: string, items: { name: string; body: string }[]): string {
  return fill(`سلام {name}، طرح‌هایی که با هم بررسی کردیم:\n\n${items.map(i => `${i.name}\n${i.body}`).join("\n\n")}`, name);
}
export function recordExplained(u: BbUser, customerId: number, chatRow: number, items: { id: number; name: string }[], messageId: number) {
  const t = iso();
  for (const p of items) execute(`INSERT INTO bws_plans_explained(customer_id,plan_id,plan_name,chat_row,user_id,message_id,sent_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(customer_id,plan_id) DO UPDATE SET plan_name=excluded.plan_name,chat_row=excluded.chat_row,user_id=excluded.user_id,message_id=excluded.message_id,sent_at=excluded.sent_at`,
    [customerId, p.id, p.name, chatRow, u.id, messageId, t]);
}
export const explainedOf = (customerId: number) => queryRows<any>("SELECT plan_id,plan_name,user_id,sent_at,message_id FROM bws_plans_explained WHERE customer_id=? ORDER BY sent_at DESC", [customerId])
  .map(r => ({ planId: r.plan_id, name: r.plan_name, at: r.sent_at, by: nameOf(bbUser(r.user_id)), messageId: r.message_id }));

/* ---------------- ه. invite (Bale + SMS together) ---------------- */
export type BaleLeg = "queued" | "sent" | "no_bale" | "not_connected" | "blocked" | "failed";
export type SmsLeg = "sent" | "failed" | "not_configured" | "disabled";
export type InviteTransport = {
  /** Queue the invite from the customer's expert's own Bale account (existing outbox: caps, scope, quiet hours, banned words). */
  bale(o: { ownerUserId: number; actorUserId: number; customerId: number; text: string }): Promise<{ state: BaleLeg; ref?: string | null; reason?: string | null }>;
  /** Poll a queued Bale leg: «sent», «no_bale» (peer not found), «failed», or still «queued». */
  baleState(ref: string): { state: BaleLeg };
  /** Pattern SMS (IPPanel pattern code from bws.invite_sms_pattern; param name). */
  sms(o: { phone: string; name: string; pattern: string | null }): Promise<{ state: SmsLeg; ref?: string | null }>;
};
const NOT_WIRED: InviteTransport = {
  async bale() { return { state: "not_connected" }; }, baleState() { return { state: "failed" }; }, async sms() { return { state: "not_configured" }; },
};
let transport: InviteTransport = NOT_WIRED;
export const setBwsInviteTransport = (t: InviteTransport | null) => { transport = t ?? NOT_WIRED; };
export const inviteText = () => setting(K.inviteText) || BWS_DEFAULT_INVITE;
export function ownerUserOf(customerId: number): number | null {
  return queryRow<{ id: number }>("SELECT u.id FROM users u JOIN customers c ON c.salesperson_id=u.salesperson_id WHERE c.id=? AND u.role='salesperson' AND u.active=1 ORDER BY u.id LIMIT 1", [customerId])?.id ?? null;
}
export function inviteView(r: any) {
  if (!r) return null;
  const noBale = r.bale_state === "no_bale";
  return { id: r.id, at: r.created_at, bale: r.bale_state as BaleLeg, sms: r.sms_state as SmsLeg, by: nameOf(bbUser(r.user_id)),
    error: noBale ? BWS_NO_BALE_TEXT : null,
    line: r.bale_state === "sent" && r.sms_state === "sent" ? "دعوت به بله در بله و پیامک فرستاده شد." : null };
}
export async function bwsInvite(u: BbUser, customerId: number): Promise<{ ok: true; invite: ReturnType<typeof inviteView> } | { ok: false; error: string }> {
  const c = bwsCustomerAccess(u, customerId); if (!c) return { ok: false, error: "forbidden" };
  const phone = normPhone(c.phone); if (!phone) return { ok: false, error: "no_phone" };
  const recent = queryRow<{ n: number }>("SELECT COUNT(*) n FROM bws_invites WHERE customer_id=? AND created_at>?", [customerId, new Date(Date.now() - 60_000).toISOString()])?.n ?? 0;
  if (recent > 0) return { ok: false, error: "rate_limited" };
  const owner = ownerUserOf(customerId);
  const text = fill(inviteText(), c.name);
  let bale: { state: BaleLeg; ref?: string | null };
  if (!owner || BWS_NEVER_USER_IDS.includes(owner) || owner === BWS_GHASEMI_USER_ID) bale = { state: "not_connected" };
  else { try { bale = await transport.bale({ ownerUserId: owner, actorUserId: u.id, customerId, text }); } catch { bale = { state: "failed" }; } }
  let sms: { state: SmsLeg; ref?: string | null };
  try { sms = await transport.sms({ phone, name: c.name, pattern: setting(K.smsPattern) }); } catch { sms = { state: "failed" }; }
  const t = iso();
  const id = execute("INSERT INTO bws_invites(customer_id,user_id,sender_user_id,bale_state,bale_ref,sms_state,sms_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [customerId, u.id, owner, bale.state, bale.ref ?? null, sms.state, sms.ref ?? null, t, t]);
  bwsLog(u.id, "invite", `${bale.state}/${sms.state}`, { customerId, invite: id });
  return { ok: true, invite: inviteView(queryRow("SELECT * FROM bws_invites WHERE id=?", [id])) };
}
export function bwsInviteRefresh(id: number) {
  const r = queryRow<any>("SELECT * FROM bws_invites WHERE id=?", [id]); if (!r) return null;
  if (r.bale_state === "queued" && r.bale_ref) {
    const s = transport.baleState(String(r.bale_ref)).state;
    if (s !== "queued") { executeChanges("UPDATE bws_invites SET bale_state=?, updated_at=? WHERE id=?", [s, iso(), id]); r.bale_state = s; }
  }
  return r;
}
export const invitesOf = (customerId: number) => queryRows<any>("SELECT * FROM bws_invites WHERE customer_id=? ORDER BY id DESC LIMIT 5", [customerId]).map(inviteView);

/* ---------------- ز. training files ---------------- */
export const trainingDir = () => process.env.BWS_FILES_DIR || path.join(path.dirname(path.resolve(process.env.CRM_DATABASE_PATH || "crm.db")), "bale-workspace-files");
export function trainingView(r: any, plansById?: Map<number, string>) {
  const ids: number[] = (() => { try { const v = JSON.parse(r.plan_ids ?? "[]"); return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []; } catch { return []; } })();
  const pm = plansById ?? new Map(plans().map(p => [p.id, p.name]));
  return { id: r.id, title: r.title, kind: r.kind as "file" | "video" | "link", url: r.kind === "link" ? r.url : `/api/bale-workspace/training/${r.id}/file`,
    fileName: r.file_name, size: r.size, audience: r.audience as "customer" | "expert", planScope: r.plan_scope as "all" | "selected", planIds: ids,
    plansLabel: r.plan_scope === "all" ? "همهٔ طرح‌ها" : ids.map(i => pm.get(i) ?? `طرح ${i}`).join("، ") || "—", active: !!r.active, at: r.updated_at };
}
export function trainingList(opts: { audience?: "customer" | "expert"; includeInactive?: boolean } = {}) {
  const w: string[] = []; const p: any[] = [];
  if (!opts.includeInactive) w.push("active=1");
  if (opts.audience) { w.push("audience=?"); p.push(opts.audience); }
  const pm = new Map(plans().map(x => [x.id, x.name]));
  return queryRows<any>(`SELECT * FROM bws_training_files ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY id`, p).map(r => trainingView(r, pm));
}
export function trainingSniff(buf: Buffer): { mime: string; kind: "file" | "video"; ext: string } | null {
  const at = (o: number, hex: string) => buf.subarray(o, o + hex.length / 2).toString("hex") === hex;
  if (at(0, "255044462d")) return { mime: "application/pdf", kind: "file", ext: "pdf" };
  if (at(0, "ffd8ff")) return { mime: "image/jpeg", kind: "file", ext: "jpg" };
  if (at(0, "89504e470d0a1a0a")) return { mime: "image/png", kind: "file", ext: "png" };
  if (at(4, "66747970")) return { mime: "video/mp4", kind: "video", ext: "mp4" };
  return null;
}
export function trainingAdd(u: BbUser, m: { title: string; audience: string; planScope: string; planIds: number[]; url?: string | null; buf?: Buffer | null; fileName?: string | null }):
  { ok: true; id: number } | { ok: false; error: string } {
  const title = String(m.title ?? "").trim().slice(0, 120); if (!title) return { ok: false, error: "bad_title" };
  if (m.audience !== "customer" && m.audience !== "expert") return { ok: false, error: "bad_audience" };
  const scope = m.planScope === "selected" ? "selected" : "all";
  const valid = new Set(plans().map(p => p.id)); const ids = scope === "selected" ? [...new Set(m.planIds.map(Number))].filter(i => valid.has(i)) : [];
  if (scope === "selected" && !ids.length) return { ok: false, error: "bad_plans" };
  const t = iso();
  if (m.buf && m.buf.length) {
    if (m.buf.length > BWS_TRAINING_MAX_BYTES) return { ok: false, error: "file_too_big" };
    const s = trainingSniff(m.buf); if (!s) return { ok: false, error: "bad_type" };
    const stored = `${crypto.randomBytes(12).toString("hex")}.${s.ext}`;
    fs.mkdirSync(trainingDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(trainingDir(), stored), m.buf, { mode: 0o600 });
    const fname = `${String(m.fileName ?? title).replace(/[\\/<>:"|?*\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 100) || "file"}.${s.ext}`;
    const id = execute(`INSERT INTO bws_training_files(title,kind,stored_name,file_name,mime,size,sha256,plan_scope,plan_ids,audience,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, s.kind, stored, fname, s.mime, m.buf.length, crypto.createHash("sha256").update(m.buf).digest("hex"), scope, JSON.stringify(ids), m.audience, u.id, t, t]);
    bwsLog(u.id, "training.add", "ok", { id, kind: s.kind, audience: m.audience });
    return { ok: true, id };
  }
  const url = String(m.url ?? "").trim();
  let ok = false; try { const x = new URL(url); ok = x.protocol === "https:" && !x.username && !x.password; } catch { ok = false; }
  if (!ok) return { ok: false, error: "bad_url" };
  const id = execute(`INSERT INTO bws_training_files(title,kind,url,plan_scope,plan_ids,audience,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    [title, "link", url.slice(0, 500), scope, JSON.stringify(ids), m.audience, u.id, t, t]);
  bwsLog(u.id, "training.add", "ok", { id, kind: "link", audience: m.audience });
  return { ok: true, id };
}

/* ---------------- د. audience, scenarios, bulk, no-reply ---------------- */
export type Audience = { who: "messaged" | "linked" | "all"; stars: number[] | null; experts: number[] | null };
export type Scenario = { id: number; name: string; kind: "auto" | "noreply" | "bulk"; audience: Audience; cond: { hours?: number } | null; body: string; trainingFileId: number | null;
  status: "draft" | "active" | "paused" | "done"; recipients: number | null; confirmedAt: string | null; sent: number; createdBy: string | null };
export function parseAudience(raw: unknown): Audience {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const who = a.who === "linked" || a.who === "all" ? a.who : "messaged";
  const stars = Array.isArray(a.stars) ? [...new Set(a.stars.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 3))] : null;
  const experts = Array.isArray(a.experts) ? [...new Set(a.experts.map(Number).filter(n => Number.isInteger(n) && n > 0 && !BWS_NEVER_USER_IDS.includes(n)))] : null;
  return { who, stars: stars && stars.length ? stars : null, experts: experts && experts.length ? experts : null };
}
/** Chat rows a scenario may reach: live sending bots only (never Ghasemi's, never 29's), filtered by who / stars / expert. «لغو»/«توقف» change nothing (t381s1476). */
export function audienceChats(a: Audience): BwsChat[] {
  const rows = queryRows<BwsChat & { has_in: number }>(`SELECT c.id,c.bot_id,c.chat_id,c.customer_id,c.first_name,c.last_name,c.username,c.last_at,b.user_id owner_id,
      EXISTS(SELECT 1 FROM bale_bot_messages m WHERE m.chat_row=c.id AND m.dir='in') has_in
    FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE b.user_id NOT IN (${[BWS_GHASEMI_USER_ID, ...BWS_NEVER_USER_IDS].join(",")}) ORDER BY c.id`);
  const sendable = new Map<number, boolean>();
  return rows.filter(c => {
    if (!sendable.has(c.bot_id)) sendable.set(c.bot_id, bwsBotSendable(c.bot_id));
    if (!sendable.get(c.bot_id)) return false;
    if (a.who === "messaged" && !c.has_in) return false;
    if (a.who === "linked" && !c.customer_id) return false;
    if (a.experts && !a.experts.includes(Number(c.owner_id))) return false;
    if (a.stars && !a.stars.includes(starsOf(c.customer_id))) return false;
    return true;
  });
}
const scenarioView = (r: any): Scenario => ({ id: r.id, name: r.name, kind: r.kind, audience: parseAudience(JSON.parse(r.audience || "{}")), cond: r.cond ? JSON.parse(r.cond) : null, body: r.body,
  trainingFileId: r.training_file_id ?? null, status: r.status, recipients: r.recipients ?? null, confirmedAt: r.confirmed_at ?? null,
  sent: queryRow<{ n: number }>("SELECT COUNT(*) n FROM bws_scenario_sends WHERE scenario_id=? AND message_id IS NOT NULL", [r.id])?.n ?? 0, createdBy: nameOf(bbUser(r.created_by)) });
export const scenarioList = () => queryRows<any>("SELECT * FROM bws_scenarios ORDER BY id DESC LIMIT 100").map(scenarioView);
export const scenarioById = (id: number) => { const r = queryRow<any>("SELECT * FROM bws_scenarios WHERE id=?", [id]); return r ? scenarioView(r) : null; };
export function scenarioSave(u: BbUser, raw: Record<string, unknown>): { ok: true; scenario: Scenario } | { ok: false; error: string } {
  const name = String(raw.name ?? "").trim().slice(0, 80); if (!name) return { ok: false, error: "bad_name" };
  const kind = raw.kind === "auto" || raw.kind === "noreply" || raw.kind === "bulk" ? raw.kind : null; if (!kind) return { ok: false, error: "bad_kind" };
  const body = String(raw.body ?? "").trim(); if (!body || [...body].length > BB_LIMITS.textMax) return { ok: false, error: "bad_text" };
  const hours = Number((raw.cond as any)?.hours);
  if (kind === "noreply" && !(Number.isInteger(hours) && hours >= 1 && hours <= 720)) return { ok: false, error: "bad_hours" };
  const tf = Number(raw.trainingFileId) || null;
  if (tf && !queryRow("SELECT 1 FROM bws_training_files WHERE id=? AND active=1 AND audience='customer'", [tf])) return { ok: false, error: "bad_file" };
  const aud = JSON.stringify(parseAudience(raw.audience)); const cond = kind === "noreply" ? JSON.stringify({ hours }) : null; const t = iso();
  const id = Number(raw.id) || 0;
  if (id) {
    const cur = queryRow<any>("SELECT status FROM bws_scenarios WHERE id=?", [id]); if (!cur) return { ok: false, error: "not_found" };
    if (cur.status !== "draft") return { ok: false, error: "not_draft" };
    executeChanges("UPDATE bws_scenarios SET name=?,kind=?,audience=?,cond=?,body=?,training_file_id=?,updated_at=? WHERE id=?", [name, kind, aud, cond, body, tf, t, id]);
    bwsLog(u.id, "scenario.save", "ok", { id }); return { ok: true, scenario: scenarioById(id)! };
  }
  const nid = execute("INSERT INTO bws_scenarios(name,kind,audience,cond,body,training_file_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'draft',?,?,?)", [name, kind, aud, cond, body, tf, u.id, t, t]);
  bwsLog(u.id, "scenario.save", "ok", { id: nid }); return { ok: true, scenario: scenarioById(nid)! };
}
/** Step 5: nothing is ever sent before this. Bulk snapshots its recipients here (the count shown = the count sent; no daily cap, t381s1476). */
export function scenarioConfirm(u: BbUser, id: number, expectCount: number): { ok: true; scenario: Scenario } | { ok: false; error: string; count?: number } {
  const s = scenarioById(id); if (!s) return { ok: false, error: "not_found" };
  if (s.status !== "draft") return { ok: false, error: "not_draft" };
  const chats = audienceChats(s.audience);
  if (chats.length !== expectCount) return { ok: false, error: "count_changed", count: chats.length };
  const t = iso();
  if (s.kind === "bulk") for (const c of chats) execute("INSERT OR IGNORE INTO bws_scenario_sends(scenario_id,chat_row,stage,ref_msg,at) VALUES(?,?,'pending',0,?)", [id, c.id, t]);
  executeChanges("UPDATE bws_scenarios SET status='active', recipients=?, confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?", [chats.length, u.id, t, t, id]);
  bwsLog(u.id, "scenario.confirm", "ok", { id, kind: s.kind, recipients: chats.length });
  return { ok: true, scenario: scenarioById(id)! };
}
export function scenarioSetStatus(u: BbUser, id: number, to: "paused" | "active"): boolean {
  const n = executeChanges(`UPDATE bws_scenarios SET status=?, updated_at=? WHERE id=? AND status=?`, [to, iso(), id, to === "paused" ? "active" : "paused"]);
  if (n) bwsLog(u.id, `scenario.${to}`, "ok", { id });
  return n > 0;
}
/** Kept for the preview payload: always true (no time window, t383s1491). */
export const inSendHours = (_d = new Date()) => true;
const tehranDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
function scenarioMessage(s: Scenario, chat: BwsChat): { text: string; file?: { name: string; mime: string; size: number; rel: string; sendAs: string } } {
  const cust = chat.customer_id ? queryRow<{ name: string }>("SELECT name FROM customers WHERE id=?", [chat.customer_id])?.name : null;
  let text = fill(s.body, cust || chatName(chat));
  if (s.trainingFileId) {
    const f = queryRow<any>("SELECT * FROM bws_training_files WHERE id=? AND active=1 AND audience='customer'", [s.trainingFileId]);
    if (f?.kind === "link") text = `${text}\n${f.url}`.slice(0, BB_LIMITS.textMax);
    else if (f?.stored_name) return { text, file: { name: f.file_name, mime: f.mime, size: f.size, rel: bwsStageFile(chat.bot_id, path.join(trainingDir(), f.stored_name), f.file_name), sendAs: f.kind === "video" ? "video" : "document" } };
  }
  return { text };
}
const lastMsg = (chatRow: number) => queryRow<{ id: number; dir: string; status: string | null; at: string }>(
  "SELECT id, dir, status, COALESCE(sent_at, created_at) at FROM bale_bot_messages WHERE chat_row=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [chatRow]);
/** One pass: bulk (≤ BWS_BULK_PER_TICK), no-reply Y then hand-off, auto (first inbound after confirm). Never sends while OFF. No time window (t383s1491). */
export function bwsTick(now = new Date()): { bulk: number; noreply: number; handoff: number; auto: number } {
  const out = { bulk: 0, noreply: 0, handoff: 0, auto: 0 };
  if (!bwsOn()) return out;
  ensureBwsSchema();
  const t = now.toISOString();
  for (const s of scenarioList().filter(x => x.status === "active")) {
    if (s.kind === "bulk") {
      const pend = queryRows<{ id: number; chat_row: number }>("SELECT id, chat_row FROM bws_scenario_sends WHERE scenario_id=? AND stage='pending' AND message_id IS NULL ORDER BY id LIMIT ?", [s.id, BWS_BULK_PER_TICK]);
      for (const p of pend) {
        const c = queryRow<BwsChat>("SELECT c.id,c.bot_id,c.chat_id,c.customer_id,c.first_name,c.last_name,c.username,c.last_at,b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE c.id=?", [p.chat_row]);
        if (!c || !bwsBotSendable(c.bot_id)) { executeChanges("UPDATE bws_scenario_sends SET stage='skipped', at=? WHERE id=?", [t, p.id]); continue; }
        const mid = bwsQueue(c, null, scenarioMessage(s, c)); executeChanges("UPDATE bws_scenario_sends SET message_id=?, stage='sent', at=? WHERE id=?", [mid, t, p.id]); out.bulk++;
      }
      if (!queryRow("SELECT 1 FROM bws_scenario_sends WHERE scenario_id=? AND stage='pending' LIMIT 1", [s.id])) executeChanges("UPDATE bws_scenarios SET status='done', updated_at=? WHERE id=?", [t, s.id]);
      continue;
    }
    const chats = audienceChats(s.audience);
    if (s.kind === "noreply") {
      const ms = (s.cond?.hours ?? 24) * 3_600_000;
      for (const c of chats) {
        const last = lastMsg(c.id); if (!last || last.dir !== "out" || last.status !== "sent") continue;
        if (now.getTime() - Date.parse(last.at) < ms) continue;
        const ourY = queryRow<{ id: number }>("SELECT id FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='y' AND message_id=?", [s.id, c.id, last.id]);
        if (ourY) {
          // still no reply after Y → hand the chat to its expert (in-app notice), once per Y
          if (!queryRow("SELECT 1 FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='handoff' AND ref_msg=?", [s.id, c.id, last.id])) {
            const owner = Number(c.owner_id) || null;
            if (owner && !BWS_NEVER_USER_IDS.includes(owner)) {
              execute("INSERT INTO bale_bot_notices(user_id,kind,chat_row,customer_id,actor_user_id,at) VALUES(?,?,?,?,?,?)", [owner, "bws_noreply", c.id, c.customer_id, null, t]);
              bwsHandoffToToday(owner, c, s.id, now);
            }
            execute("INSERT OR IGNORE INTO bws_scenario_sends(scenario_id,chat_row,stage,ref_msg,at) VALUES(?,?,'handoff',?,?)", [s.id, c.id, last.id, t]); out.handoff++;
          }
          continue;
        }
        if (queryRow("SELECT 1 FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='y' AND ref_msg=?", [s.id, c.id, last.id])) continue;
        const mid = bwsQueue(c, null, scenarioMessage(s, c));
        execute("INSERT OR IGNORE INTO bws_scenario_sends(scenario_id,chat_row,stage,ref_msg,message_id,at) VALUES(?,?,'y',?,?,?)", [s.id, c.id, last.id, mid, t]); out.noreply++;
      }
    } else if (s.kind === "auto" && setting(K.autoOn) === "1") {
      for (const c of chats) {
        if (queryRow("SELECT 1 FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='auto'", [s.id, c.id])) continue;
        if (!queryRow("SELECT 1 FROM bale_bot_messages WHERE chat_row=? AND dir='in' AND created_at>=? LIMIT 1", [c.id, s.confirmedAt ?? t])) continue;
        const mid = bwsQueue(c, null, scenarioMessage(s, c));
        execute("INSERT OR IGNORE INTO bws_scenario_sends(scenario_id,chat_row,stage,ref_msg,message_id,at) VALUES(?,?,'auto',0,?,?)", [s.id, c.id, mid, t]); out.auto++;
      }
    }
  }
  return out;
}

/** t383s1491: the hand-off also puts the customer on that expert's «کارهای امروز» (daily plan picks bws_handoffs up like a referral, rank 1).
 *  expert_lockdown: only the expert's OWN customer (customers.salesperson_id = the expert's salesperson id, not merged); otherwise the in-app notice only. */
export function bwsHandoffToToday(ownerUserId: number, c: BwsChat, scenarioId: number, now = new Date()): boolean {
  if (!c.customer_id || BWS_NEVER_USER_IDS.includes(ownerUserId)) return false;
  const sp = queryRow<{ salesperson_id: number | null; active: number | null }>("SELECT salesperson_id, active FROM users WHERE id=?", [ownerUserId]);
  if (!sp?.salesperson_id || sp.active === 0) return false;
  if (!queryRow("SELECT 1 FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL", [c.customer_id, sp.salesperson_id])) { bwsLog(null, "handoff.today", "not_own", { chat: c.id }); return false; }
  const n = executeChanges("INSERT OR IGNORE INTO bws_handoffs(customer_id,owner_user_id,owner_salesperson_id,chat_row,scenario_id,day,created_at) VALUES(?,?,?,?,?,?,?)",
    [c.customer_id, ownerUserId, sp.salesperson_id, c.id, scenarioId, tehranDay(now), now.toISOString()]);
  if (n) bwsLog(null, "handoff.today", "ok", { chat: c.id, customer: c.customer_id });
  return n > 0;
}

/* ---------------- admin state ---------------- */
export function adminState() {
  return { inviteText: inviteText(), inviteDefault: BWS_DEFAULT_INVITE, smsPattern: setting(K.smsPattern) ?? "", autoOn: setting(K.autoOn) === "1",
    plans: plans().filter(p => p.active).map(p => ({ id: p.id, name: p.name, terms: termsOf(p.id) ?? "" })),
    scenarios: scenarioList(), training: trainingList({ includeInactive: false }),
    experts: queryRows<any>(`SELECT b.user_id id, u.full_name, u.username FROM bale_bots b JOIN users u ON u.id=b.user_id WHERE b.user_id NOT IN (${[BWS_GHASEMI_USER_ID, ...BWS_NEVER_USER_IDS].join(",")}) ORDER BY b.user_id`).map(e => ({ id: e.id, name: nameOf(e) })),
    sendHours: null, smsPatternText: BWS_INVITE_SMS_PATTERN_TEXT, smsPatternVars: BWS_INVITE_SMS_PATTERN_VARS };
}
export { setSetting };

/**
 * bale-contact v1.1 — capture the customer's phone in the experts' Bale bots and link the
 * chat to the CRM customer. Design: /workspace/nafis-design/screens/bale-contact (Armita v1.1).
 *
 * Behind flag.bale_contact_v1 in call_queue_settings (absent / ≠ '1' = OFF). When the flag is
 * OFF every hook is a no-op: behaviour is identical to today's bale-bot inbox
 * (no auto-ask, no auto-lead, no typed-pending, no 24h reminder, no batch).
 *
 * Sends only from the experts' bots: users 2 (Hasani), 8 (Kazemi), 7 (Tajik).
 * Ghasemi's bot (user 3) is read-only: this module never queues a send from it.
 * The one-time batch to existing customers stays disabled unless
 * bale_contact.batch_enabled = '1' (needs Mohammad's approval after release).
 */
import { execute, executeChanges, queryRow, queryRows, crmDb } from "./crm-db";
import { insertCustomerRecord, lastCustomerCreateOutcome } from "./customer-create";
import {
  ASK_CONTACT_BUTTON,
  bbCanManage,
  bbLog,
  bbNoSendSp,
  bbUser,
  botById,
  botLive,
  botSends,
  chatName,
  matchPhone,
  nameOf,
  normPhone,
  type BbUser,
} from "./bale-bot";

export const BC_FLAG = "flag.bale_contact_v1";
export const BC_BATCH_ENABLED = "bale_contact.batch_enabled";
export const BC_GHASEMI_USER_ID = 3;
/** Hasani, Kazemi, Tajik — the only bots that may send contact-capture messages. */
export const BC_SEND_USER_IDS = [2, 8, 7] as const;
export const BC_RESEND_MS = 5 * 60_000;
export const BC_REMINDER_MS = 24 * 60 * 60_000;

export const BC_PRIV = "شماره فقط برای پیگیری خودتان استفاده می‌شود.";
export const BC_ASK_FIRST =
  "سلام، به ربات نفیس وام خوش آمدید. برای اینکه گفتگو به پرونده یا کارشناس خودتان وصل شود، لطفاً شماره‌تان را با دکمه‌ی زیر بفرستید.\n" + BC_PRIV;
export const BC_ASK_EXIST =
  "سلام، برای وصل شدن این گفتگو به پرونده‌تان، لطفاً شماره‌تان را با دکمه‌ی زیر بفرستید.\n" + BC_PRIV;
export const BC_OK_KNOWN = "ممنون، شماره‌تان ثبت شد. کارشناس شما به‌زودی پاسخ می‌دهد.";
export const BC_OK_NEW = "ممنون، شماره‌تان ثبت شد. درخواست‌تان ثبت شد و به‌زودی کارشناس مربوط پاسخ می‌دهد.";
export const BC_TYPED_OK =
  "شماره‌تان دریافت شد. پس از تأیید کارشناس، گفتگو وصل می‌شود. اگر می‌خواهید همین حالا وصل شود، از دکمه‌ی «اشتراک شماره» استفاده کنید.";
export const BC_TYPED_BAD =
  "این پیام شماره‌ی موبایل کامل نیست. لطفاً یک شماره‌ی ۱۱ رقمی با ۰۹ بنویسید، یا از دکمه‌ی «اشتراک شماره» استفاده کنید تا گفتگو همین حالا وصل شود.";
export const BC_OTHER_REPLY =
  "فقط شماره‌ی همین حساب بله پذیرفته می‌شود. لطفاً با دکمه‌ی «اشتراک شماره»، شماره‌ی خودتان را بفرستید.";
export const BC_REJECT_TEXT =
  "شماره‌ای که نوشتید تأیید نشد. برای وصل شدن گفتگو، لطفاً از دکمه‌ی «اشتراک شماره» استفاده کنید.";
export const BC_BUTTON = ASK_CONTACT_BUTTON; // «اشتراک شماره»

export const BC_SRC = { share: "share", typed: "typed", manual: "manual" } as const;
export type BcSource = (typeof BC_SRC)[keyof typeof BC_SRC];
export const BC_SRC_LABEL: Record<BcSource, string> = {
  share: "اشتراک بله",
  typed: "تایپ مشتری + تأیید کارشناس",
  manual: "ورود دستی کارشناس",
};

const setting = (k: string) => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value; }
  catch { return undefined; }
};
export const bcFlagOn = () => setting(BC_FLAG) === "1";
export const bcBatchEnabled = () => setting(BC_BATCH_ENABLED) === "1";

let schemaReady = false;
export function ensureBaleContactSchema(): void {
  if (schemaReady) return;
  const add = (sql: string) => { try { crmDb.exec(sql); } catch { /* already there */ } };
  add("ALTER TABLE bale_bot_chats ADD COLUMN pending_typed_phone TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN pending_typed_at TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN link_source TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN first_ask_at TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN reminder_sent_at TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN welcome_sent_at TEXT");
  add("ALTER TABLE bale_bot_chats ADD COLUMN lead_from_bale INTEGER");
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS bale_contact_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, chat_row INTEGER, customer_id INTEGER,
      bot_id INTEGER, user_id INTEGER, bale_user_id TEXT, source TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS ix_bca_chat ON bale_contact_audit(chat_row, id);
    CREATE TABLE IF NOT EXISTS bale_contact_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, chat_row INTEGER NOT NULL UNIQUE,
      bot_id INTEGER, sent_at TEXT NOT NULL, status TEXT NOT NULL);
  `);
  schemaReady = true;
}
export const _resetBcSchemaFlagForTests = () => { schemaReady = false; };

const nowIso = (d = new Date()) => d.toISOString();

export function bcAudit(o: {
  chatRow?: number | null; customerId?: number | null; botId?: number | null; userId?: number | null;
  baleUserId?: string | null; source: string; outcome: string; detail?: Record<string, string | number | boolean | null>;
}) {
  try {
    execute(
      "INSERT INTO bale_contact_audit(at,chat_row,customer_id,bot_id,user_id,bale_user_id,source,outcome,detail) VALUES(?,?,?,?,?,?,?,?,?)",
      [nowIso(), o.chatRow ?? null, o.customerId ?? null, o.botId ?? null, o.userId ?? null, o.baleUserId ?? null, o.source, o.outcome,
        o.detail ? JSON.stringify(o.detail) : null],
    );
  } catch { /* never breaks the caller */ }
}

type BotRow = { id: number; user_id: number; status: string; token_ct: string | null };
type ChatRow = {
  id: number; bot_id: number; chat_id: string; bale_user_id: string | null; first_name: string | null; last_name: string | null;
  username: string | null; customer_id: number | null; link_method: string | null; linked_at: string | null; linked_by: number | null;
  verified_phone: string | null; contact_asked_at: string | null; match_note: string | null;
  pending_typed_phone?: string | null; pending_typed_at?: string | null; link_source?: string | null;
  first_ask_at?: string | null; reminder_sent_at?: string | null; welcome_sent_at?: string | null; lead_from_bale?: number | null;
};

export function bcMaySendFromBot(bot: { user_id: number }): boolean {
  if (bot.user_id === BC_GHASEMI_USER_ID) return false;
  if (!(BC_SEND_USER_IDS as readonly number[]).includes(bot.user_id)) return false;
  if (!botSends(bot as any)) return false;
  return true;
}

/** Queue an outbound text (+ optional request_contact keyboard). Never sends from Ghasemi's bot. */
export function bcQueueText(chat: ChatRow, bot: BotRow, text: string, keyboard: "contact" | null, at = nowIso()): number | null {
  if (!bcMaySendFromBot(bot)) {
    bcAudit({ chatRow: chat.id, botId: bot.id, source: "queue", outcome: "blocked_no_send" });
    return null;
  }
  const id = execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,keyboard,status,created_at)
     VALUES(?,'out','text',?,?, 'sending', ?)`,
    [chat.id, text, keyboard, at],
  );
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [at, preview, chat.id]);
  return id;
}

function markAsked(chatId: number, at: string, first: boolean) {
  if (first) executeChanges("UPDATE bale_bot_chats SET contact_asked_at=?, first_ask_at=COALESCE(first_ask_at,?), welcome_sent_at=COALESCE(welcome_sent_at,?) WHERE id=?", [at, at, at, chatId]);
  else executeChanges("UPDATE bale_bot_chats SET contact_asked_at=? WHERE id=?", [at, chatId]);
}

const latinDigits = (s: string) => String(s ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
export function looksLikePhoneAttempt(raw: string): boolean {
  const latin = latinDigits(raw);
  const compact = latin.replace(/[\s-]/g, "");
  const digits = compact.replace(/\D/g, "");
  if (digits.length >= 7) return true;
  if (/^(?:\+98|0098|98|0?9)\d{3,}$/.test(compact)) return true;
  return false;
}

const displayName = (c: ChatRow) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "مشتری بله";

type LinkResult =
  | { ok: true; kind: "known"; customerId: number; own: boolean }
  | { ok: true; kind: "new"; customerId: number }
  | { ok: false; reason: "many" | "no_phone" };

/** Known phone → link that customer (dedupe). Unknown → new lead via the current default-owner rule. */
export function bcLinkOrCreateLead(chat: ChatRow, bot: BotRow, phone: string, source: BcSource, actorUserId: number | null, at = nowIso()): LinkResult {
  const owner = bbUser(bot.user_id);
  const hit = matchPhone(phone, owner?.salesperson_id ?? null);
  if (hit && "many" in hit) {
    executeChanges("UPDATE bale_bot_chats SET match_note='many', verified_phone=COALESCE(verified_phone,?) WHERE id=?", [source === "share" ? phone : null, chat.id]);
    bcAudit({ chatRow: chat.id, botId: bot.id, userId: actorUserId, baleUserId: chat.bale_user_id, source, outcome: "many", detail: { phoneLen: phone.length } });
    return { ok: false, reason: "many" };
  }
  if (hit && "customerId" in hit) {
    executeChanges(
      `UPDATE bale_bot_chats SET customer_id=?, link_method=?, link_source=?, linked_at=?, linked_by=?, match_note=NULL,
        pending_typed_phone=NULL, pending_typed_at=NULL, verified_phone=CASE WHEN ? THEN ? ELSE verified_phone END, lead_from_bale=0
       WHERE id=? AND customer_id IS NULL`,
      [hit.customerId, source === "share" ? (hit.own ? "contact" : "contact_other") : source, source, at, actorUserId, source === "share" ? 1 : 0, phone, chat.id],
    );
    bcAudit({ chatRow: chat.id, customerId: hit.customerId, botId: bot.id, userId: actorUserId, baleUserId: chat.bale_user_id, source, outcome: hit.own ? "known_own" : "known_other" });
    bbLog({ botId: bot.id, chatRow: chat.id, customerId: hit.customerId, userId: actorUserId, action: `contact.${source}`, outcome: hit.own ? "own" : "other_expert" });
    return { ok: true, kind: "known", customerId: hit.customerId, own: hit.own };
  }
  const name = displayName(chat);
  let id: number;
  try {
  id = insertCustomerRecord({
    name,
    phone,
    description: [`منبع: بله${(bot as any).bot_username ? ` (ربات @${(bot as any).bot_username})` : ""}`, `اتصال: ${BC_SRC_LABEL[source]}`].join("\n"),
    salespersonId: owner?.salesperson_id ?? null,
    assignedSalespersonId: owner?.salesperson_id ?? null,
    registeredByUserId: actorUserId ?? bot.user_id,
    registrationSource: "staff_form",
    // Current lead distribution rule applies (do not skip it; do not change team_sales_config).
    skipDefaultOwnerRule: false,
    intake: { leadSource: "other", leadSourceOther: "بله", registrarNote: `اشتراک شماره بله (${BC_SRC_LABEL[source]})` },
  });
  } catch {
    bcAudit({ chatRow: chat.id, botId: bot.id, userId: actorUserId, baleUserId: chat.bale_user_id, source, outcome: "lead_failed" });
    return { ok: false, reason: "no_phone" };
  }
  executeChanges(
    `UPDATE bale_bot_chats SET customer_id=?, link_method='lead', link_source=?, linked_at=?, linked_by=?, match_note=NULL,
      pending_typed_phone=NULL, pending_typed_at=NULL, verified_phone=CASE WHEN ? THEN ? ELSE verified_phone END, lead_from_bale=1
     WHERE id=? AND customer_id IS NULL`,
    [id, source, at, actorUserId, source === "share" ? 1 : 0, phone, chat.id],
  );
  const outcome = lastCustomerCreateOutcome();
  bcAudit({
    chatRow: chat.id, customerId: id, botId: bot.id, userId: actorUserId, baleUserId: chat.bale_user_id, source, outcome: "new_lead",
    detail: { ruleApplied: outcome?.ruleApplied ?? false, salespersonId: outcome?.salespersonId ?? null },
  });
  bbLog({ botId: bot.id, chatRow: chat.id, customerId: id, userId: actorUserId, action: `contact.${source}`, outcome: "new_lead" });
  return { ok: true, kind: "new", customerId: id };
}

export function bcAfterInbound(bot: BotRow, chatId: number, p: {
  kind: string; text: string | null;
  contact?: { phone: string | null; name: string; userId: string | null };
  fromId: string; contactOwn: number | null; isNewChat: boolean;
}): void {
  if (!bcFlagOn()) return;
  ensureBaleContactSchema();
  const chat = queryRow<ChatRow>("SELECT * FROM bale_bot_chats WHERE id=?", [chatId]);
  if (!chat) return;
  const at = nowIso();

  if (p.kind === "contact") {
    if (p.contactOwn !== 1 || !p.contact?.phone) {
      bcAudit({ chatRow: chat.id, botId: bot.id, baleUserId: chat.bale_user_id, source: "share", outcome: "not_own" });
      bbLog({ botId: bot.id, chatRow: chat.id, action: "link.contact", outcome: "not_own" });
      if (!chat.customer_id) bcQueueText(chat, bot, BC_OTHER_REPLY, "contact", at);
      return;
    }
    if (chat.customer_id) {
      executeChanges("UPDATE bale_bot_chats SET verified_phone=? WHERE id=?", [p.contact.phone, chat.id]);
      return;
    }
    const r = bcLinkOrCreateLead(chat, bot, p.contact.phone, "share", null, at);
    if (r.ok) bcQueueText(chat, bot, r.kind === "new" ? BC_OK_NEW : BC_OK_KNOWN, null, at);
    return;
  }

  if (p.kind === "text" && p.text && !chat.customer_id && !chat.pending_typed_phone) {
    const phone = normPhone(p.text);
    if (phone) {
      executeChanges("UPDATE bale_bot_chats SET pending_typed_phone=?, pending_typed_at=? WHERE id=?", [phone, at, chat.id]);
      bcAudit({ chatRow: chat.id, botId: bot.id, baleUserId: chat.bale_user_id, source: "typed", outcome: "pending", detail: { phoneLen: phone.length } });
      bcQueueText(chat, bot, BC_TYPED_OK, "contact", at);
      return;
    }
    if (looksLikePhoneAttempt(p.text)) {
      bcAudit({ chatRow: chat.id, botId: bot.id, baleUserId: chat.bale_user_id, source: "typed", outcome: "invalid" });
      bcQueueText(chat, bot, BC_TYPED_BAD, "contact", at);
      return;
    }
  }

  // First contact: one automatic «اشتراک شماره» request. Not on Ghasemi. Not if already asked / linked / typed-pending.
  const fresh = queryRow<ChatRow>("SELECT * FROM bale_bot_chats WHERE id=?", [chatId])!;
  if (!fresh.customer_id && !fresh.pending_typed_phone && !fresh.welcome_sent_at && !fresh.contact_asked_at) {
    if (bcQueueText(fresh, bot, BC_ASK_FIRST, "contact", at)) {
      markAsked(fresh.id, at, true);
      bcAudit({ chatRow: fresh.id, botId: bot.id, baleUserId: fresh.bale_user_id, source: "first_ask", outcome: "queued" });
    }
  }
}

export function bcCanAct(u: BbUser, ownerId: number): boolean {
  if (!u || u.active === 0) return false;
  if (bbCanManage(u)) return true;
  return u.id === ownerId;
}

export function bcResendAsk(chat: ChatRow, bot: BotRow, u: BbUser, at = nowIso()): { ok: true; messageId: number } | { ok: false; error: string } {
  if (!bcFlagOn()) return { ok: false, error: "flag_off" };
  if (!bcCanAct(u, (chat as any).owner_id ?? bot.user_id)) return { ok: false, error: "forbidden" };
  if (chat.customer_id) return { ok: false, error: "already_linked" };
  if (chat.contact_asked_at && Date.parse(chat.contact_asked_at) > Date.now() - BC_RESEND_MS) return { ok: false, error: "rate_limited" };
  const text = chat.first_ask_at || chat.welcome_sent_at ? BC_ASK_EXIST : BC_ASK_FIRST;
  const id = bcQueueText(chat, bot, text, "contact", at);
  if (!id) return { ok: false, error: "no_send" };
  markAsked(chat.id, at, !chat.first_ask_at);
  bcAudit({ chatRow: chat.id, botId: bot.id, userId: u.id, source: "resend", outcome: "queued" });
  return { ok: true, messageId: id };
}

export function bcTypedMatch(phone: string, ownerSp: number | null) {
  const hit = matchPhone(phone, ownerSp);
  if (!hit) return { state: "free" as const };
  if ("many" in hit) return { state: "many" as const };
  const c = queryRow<{ id: number; name: string; phone: string | null; status: string | null; salesperson_id: number | null }>(
    "SELECT id,name,phone,status,salesperson_id FROM customers WHERE id=?", [hit.customerId]);
  const owner = c?.salesperson_id != null
    ? queryRow<{ id: number; full_name: string | null; username: string }>("SELECT id,full_name,username FROM users WHERE salesperson_id=? AND role='salesperson' ORDER BY active DESC, id LIMIT 1", [c.salesperson_id])
    : null;
  return {
    state: "known" as const, own: hit.own, customer: c ? {
      id: c.id, name: c.name, status: c.status, expert: owner ? nameOf(owner) : null, salespersonId: c.salesperson_id, own: hit.own,
    } : null,
  };
}

export function bcApproveTyped(chat: ChatRow, bot: BotRow, u: BbUser, at = nowIso()): { ok: true; result: LinkResult } | { ok: false; error: string } {
  if (!bcFlagOn()) return { ok: false, error: "flag_off" };
  if (!bcCanAct(u, (chat as any).owner_id ?? bot.user_id)) return { ok: false, error: "forbidden" };
  if (chat.customer_id) return { ok: false, error: "already_linked" };
  const phone = chat.pending_typed_phone ? normPhone(chat.pending_typed_phone) : null;
  if (!phone) return { ok: false, error: "no_pending" };
  const r = bcLinkOrCreateLead(chat, bot, phone, "typed", u.id, at);
  if (r.ok) bcQueueText(chat, bot, r.kind === "new" ? BC_OK_NEW : BC_OK_KNOWN, null, at);
  return { ok: true, result: r };
}

export function bcRejectTyped(chat: ChatRow, bot: BotRow, u: BbUser, at = nowIso()): { ok: true } | { ok: false; error: string } {
  if (!bcFlagOn()) return { ok: false, error: "flag_off" };
  if (!bcCanAct(u, (chat as any).owner_id ?? bot.user_id)) return { ok: false, error: "forbidden" };
  if (chat.customer_id) return { ok: false, error: "already_linked" };
  if (!chat.pending_typed_phone) return { ok: false, error: "no_pending" };
  executeChanges("UPDATE bale_bot_chats SET pending_typed_phone=NULL, pending_typed_at=NULL WHERE id=?", [chat.id]);
  bcQueueText(chat, bot, BC_REJECT_TEXT, "contact", at);
  bcAudit({ chatRow: chat.id, botId: bot.id, userId: u.id, source: "reject", outcome: "rejected" });
  return { ok: true };
}

export function bcPreviewManual(phoneRaw: string, ownerSp: number | null): { ok: true; phone: string; match: ReturnType<typeof bcTypedMatch> } | { ok: false; error: "bad_phone" | "no_phone" } {
  const raw = String(phoneRaw ?? "").trim();
  if (!raw) return { ok: false, error: "no_phone" };
  const phone = normPhone(raw);
  if (!phone) return { ok: false, error: "bad_phone" };
  return { ok: true, phone, match: bcTypedMatch(phone, ownerSp) };
}

export function bcCommitManual(chat: ChatRow, bot: BotRow, u: BbUser, phoneRaw: string, at = nowIso()): { ok: true; result: LinkResult; phone: string } | { ok: false; error: string } {
  if (!bcFlagOn()) return { ok: false, error: "flag_off" };
  if (!bcCanAct(u, (chat as any).owner_id ?? bot.user_id)) return { ok: false, error: "forbidden" };
  if (chat.customer_id) return { ok: false, error: "already_linked" };
  const phone = normPhone(phoneRaw);
  if (!phone) return { ok: false, error: "bad_phone" };
  const r = bcLinkOrCreateLead(chat, bot, phone, "manual", u.id, at);
  return r.ok ? { ok: true, result: r, phone } : { ok: true, result: r, phone };
}

/** Exactly one reminder, 24h after the first request, if no number has come in — then silence. */
export function bcTickReminders(now = new Date()): number {
  if (!bcFlagOn()) return 0;
  ensureBaleContactSchema();
  const cutoff = new Date(now.getTime() - BC_REMINDER_MS).toISOString();
  const rows = queryRows<ChatRow & { owner_id: number }>(
    `SELECT c.*, b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id
     WHERE c.customer_id IS NULL AND c.pending_typed_phone IS NULL AND c.verified_phone IS NULL
       AND c.reminder_sent_at IS NULL AND c.first_ask_at IS NOT NULL AND c.first_ask_at<=?`,
    [cutoff],
  );
  let n = 0;
  for (const c of rows) {
    const bot = botById(c.bot_id) as BotRow | undefined;
    if (!bot || !bcMaySendFromBot(bot) || !botLive(bot)) continue;
    const at = nowIso(now);
    if (!bcQueueText(c, bot, BC_ASK_EXIST, "contact", at)) continue;
    executeChanges("UPDATE bale_bot_chats SET reminder_sent_at=?, contact_asked_at=? WHERE id=?", [at, at, c.id]);
    bcAudit({ chatRow: c.id, botId: bot.id, baleUserId: c.bale_user_id, source: "reminder", outcome: "queued" });
    n++;
  }
  return n;
}

/**
 * One-time batch to people who already started the bot and still have no number.
 * Disabled unless bale_contact.batch_enabled = '1'. Tests may pass { allow: true } to
 * exercise idempotency without flipping the live setting.
 */
export function runBaleContactBatch(opts: { allow?: boolean; now?: Date } = {}): { ok: boolean; error?: string; sent: number; skipped: number } {
  if (!bcFlagOn()) return { ok: false, error: "flag_off", sent: 0, skipped: 0 };
  if (!bcBatchEnabled() && !opts.allow) return { ok: false, error: "batch_disabled", sent: 0, skipped: 0 };
  ensureBaleContactSchema();
  const at = nowIso(opts.now);
  const rows = queryRows<ChatRow & { owner_id: number }>(
    `SELECT c.*, b.user_id owner_id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id
     WHERE c.customer_id IS NULL AND c.verified_phone IS NULL AND c.pending_typed_phone IS NULL`,
  );
  let sent = 0, skipped = 0;
  for (const c of rows) {
    if (queryRow("SELECT 1 FROM bale_contact_batch WHERE chat_row=?", [c.id])) { skipped++; continue; }
    const bot = botById(c.bot_id) as BotRow | undefined;
    if (!bot || !bcMaySendFromBot(bot) || !botLive(bot)) { skipped++; continue; }
    const id = bcQueueText(c, bot, BC_ASK_EXIST, "contact", at);
    if (!id) { skipped++; continue; }
    markAsked(c.id, at, !c.first_ask_at);
    execute("INSERT INTO bale_contact_batch(customer_id,chat_row,bot_id,sent_at,status) VALUES(?,?,?,?, 'sent')", [c.customer_id, c.id, bot.id, at]);
    bcAudit({ chatRow: c.id, botId: bot.id, baleUserId: c.bale_user_id, source: "batch", outcome: "queued" });
    sent++;
  }
  return { ok: true, sent, skipped };
}

export function tehranClock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("fa-IR", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Tehran" });
}

export function bcSourceLine(c: { link_source?: string | null; linked_at?: string | null; linked_by?: number | null; link_method?: string | null }): string | null {
  const src = (c.link_source === "typed" || c.link_source === "manual" || c.link_source === "share")
    ? c.link_source
    : c.link_method === "contact" || c.link_method === "contact_other" ? "share"
    : c.link_method === "manual" ? "manual"
    : c.link_method === "lead" ? "share"
    : null;
  if (!src) return null;
  const who = src === "share" ? "خود مشتری" : (c.linked_by ? nameOf(bbUser(c.linked_by)) : "کارشناس");
  const tm = tehranClock(c.linked_at);
  return `منبع: ${BC_SRC_LABEL[src]}، ${who}${tm ? `، امروز ${tm}` : ""}`;
}

export function bcInboxTitle(c: ChatRow, customerName: string | null): string {
  if (customerName && c.customer_id && !c.pending_typed_phone) return customerName;
  if (!c.customer_id && c.username) return `@${c.username}`;
  return chatName(c);
}

export { normPhone };

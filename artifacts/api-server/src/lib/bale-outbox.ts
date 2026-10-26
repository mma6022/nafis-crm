/**
 * «حساب شخصی بله» — piece 1b: outbox + sender worker + inbound listener (the API decides everything; the sidecar is a pipe).
 *
 *  Who may cause a send (nothing else ever sends):
 *    - the expert, from the customer's «گفتگوی بله» tab («بفرست», optionally «همین الان» during quiet hours);
 *    - the expert's own reminder of type «پیام به مشتری» when it falls due;
 *    - the expert's own sales assistant (runner POST /bale/send) — only for the bound expert's in-scope customers.
 *  Checks on every enqueue AND again right before sending: master switch ON, account connected and mode ≠ off, customer is the
 *  expert's own (salesperson_id, not merged; for the runner also the assistant's scope), text ≤ 1000 chars without a banned word
 *  and without a «نقد/کالا/امتیاز» question, valid mobile, prior chat (or an explicit expert command), one active message per
 *  customer, per-hour / per-day / new-chats-per-day caps, quiet hours (held until quiet_end; only the expert's «همین الان» bypasses).
 *  Mode «اول تأیید من»: assistant/reminder messages become a draft (pending_approval) the expert sends / edits / cancels.
 *  Mode «خودکار»: they are queued directly. The expert's own command is always queued (it IS the approval).
 *  Worker (tick ≈ 5 s): due reminders → outbox; re-attach sessions after a sidecar restart; at most one send per account per tick,
 *  random gap gap_min_s…gap_max_s between sends; rate-limit / ban / dead-session errors stop the account automatically
 *  (mode off, pending rows blocked, bell to the expert + admins).
 *  Inbound (sidecar → POST /internal/bale/inbound, loopback + internal token): stored only when the peer is one of the account
 *  owner's own customers; otherwise only counted. Feeds the tab, the bell and the expert's sales assistant (event bale_inbound).
 *  Piece 2 (NOT here): document intake, auto-reply.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeFa } from "./assistants";
import { maskText } from "./smart-filing";
import { baleSessionAad, openBaleSession, BaleKeyMissing, type KeyEnv } from "./bale-crypto";
import { BaleSidecarError, type BaleSidecar } from "./bale-sidecar-client";

export const BALE_MAX_TEXT = 1000;
export const BALE_SENDING_STALE_MS = 2 * 60_000;
export const BALE_MAX_ATTEMPTS = 3;
/** Plan line 36: appended to any customer message that names a plan or an amount. */
export const BALE_AMOUNT_DISCLAIMER = "مبلغ قطعی را بانک یا تأمین‌کننده‌ی مالی پس از اعتبارسنجی تعیین می‌کند.";

export type BaleBlockReason =
  | "bale_disabled" | "not_connected" | "mode_off" | "out_of_scope" | "empty" | "too_long" | "banned_word" | "loan_type_question"
  | "no_phone" | "no_prior_chat" | "already_pending" | "cap_hour" | "cap_day" | "cap_new_chats" | "auto_stopped" | "not_eligible"
  | "conversation_paused" | "session_not_live";
export const BLOCK_FA: Record<BaleBlockReason | "quiet_hours" | "no_bale_account" | "uncertain" | "send_failed" | "peer_blocked", string> = {
  bale_disabled: "بله فعلاً از طرف مدیر خاموش است؛ پیامی فرستاده نشد.",
  not_connected: "حساب بله‌ی کارشناس وصل نیست؛ پیامی فرستاده نشد.",
  mode_off: "حالت ارسال بله «خاموش» است. از صفحه‌ی «اتصال بله» حالت را عوض کنید.",
  out_of_scope: "این مشتری در محدوده‌ی شما نیست؛ پیامی فرستاده نشد.",
  empty: "متن پیام خالی است.",
  too_long: "پیام بیشتر از ۱۰۰۰ حرف است؛ کوتاه‌ترش کنید.",
  banned_word: "متن پیام کلمه‌ی ممنوع دارد؛ متن را اصلاح کنید.",
  loan_type_question: "از مشتری نپرسید نقد، کالا یا امتیاز می‌خواهد؛ این پیام فرستاده نشد.",
  no_phone: "شماره‌ی موبایل معتبری برای این مشتری ثبت نیست.",
  no_prior_chat: "با این مشتری هنوز در بله گفتگویی نداشته‌اید؛ اولین پیام فقط با دستور صریح خودتان فرستاده می‌شود.",
  already_pending: "برای این مشتری یک پیام دیگر در صف یا منتظر تأیید است.",
  cap_hour: "سقف پیام‌های این ساعت پر شده است؛ کمی بعد دوباره بفرستید.",
  cap_day: "سقف پیام‌های امروز پر شده است؛ فردا دوباره بفرستید.",
  cap_new_chats: "سقف شروع گفتگوی تازه برای امروز پر شده است.",
  auto_stopped: "ارسال از حساب بله به‌خاطر خطای بله خودکار متوقف شد.",
  not_eligible: "ارسال از حساب بله فقط برای کارشناس فروش است.",
  quiet_hours: "ساعت آرام است؛ پیام بعد از پایان ساعت آرام فرستاده می‌شود.",
  no_bale_account: "این مشتری در بله حساب ندارد یا پیدا نشد.",
  uncertain: "معلوم نشد پیام رسید یا نه؛ در بله نگاه کنید و اگر لازم بود دوباره بفرستید.",
  send_failed: "ارسال ناموفق بود.",
  conversation_paused: "گفتگوی بله با این مشتری متوقف است (احتمالاً مشتری شما را در بله مسدود کرده). از برگه‌ی «گفتگوی بله» می‌توانید دوباره فعالش کنید.",
  peer_blocked: "به نظر می‌رسد این مشتری شما را در بله مسدود کرده است؛ پیام نرسید.",
  session_not_live: "اتصال بله‌ی کارشناس ناقص است و در حال رفع است؛ تا وقتی اتصال کامل نشود هیچ پیامی فرستاده نمی‌شود.",
};

/* ------------------------------ pure helpers (unit-tested in scripts/bale-fixture.mjs) ------------------------------ */
const TEHRAN_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function tehranMinutes(d: Date): number { const [h, m] = TEHRAN_HM.format(d).split(":").map(Number); return h * 60 + m; }
export function parseHm(s: string, d: number): number { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "")); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : d; }
/** Quiet window [start, end) in Tehran time; works across midnight (21:30–08:30). */
export function inBaleQuiet(d: Date, start: string, end: string): boolean {
  const s = parseHm(start, 21 * 60 + 30), e = parseHm(end, 8 * 60 + 30), m = tehranMinutes(d);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}
/** The next instant (Tehran) at which the quiet window ends. */
export function quietEndAfter(d: Date, end: string): Date {
  const e = parseHm(end, 8 * 60 + 30); const m = tehranMinutes(d);
  const mins = ((e - m) % 1440 + 1440) % 1440 || 1440;
  const t = new Date(d.getTime() + mins * 60_000); t.setUTCSeconds(0, 0); return t;
}
const LOAN_TYPES = ["نقد", "کالا", "امتیاز"];
const ASKING = /[؟?]|میخوا|ترجیح|کدوم|کدام|چه نوع|چه مدل|یا اینکه/;
/** Product rule: never ask the customer whether they want cash, goods or points. */
export function isLoanTypeQuestion(text: string): boolean {
  const n = normalizeFa(text);
  const hits = LOAN_TYPES.filter(w => n.includes(w)).length;
  return hits >= 2 || (hits === 1 && ASKING.test(n));
}
export function baleTextProblem(text: unknown, banned: string[]): "empty" | "too_long" | "banned_word" | "loan_type_question" | null {
  const t = String(text ?? "").trim();
  if (!t) return "empty";
  if (t.length > BALE_MAX_TEXT) return "too_long";
  const n = normalizeFa(t).replace(/\s+/g, "");
  if (banned.some(w => w && n.includes(normalizeFa(w).replace(/\s+/g, "")))) return "banned_word";
  if (isLoanTypeQuestion(t)) return "loan_type_question";
  return null;
}
const AMOUNTISH = /[0-9۰-۹٠-٩][0-9۰-۹٠-٩,٬.\s]*(میلیون|میلیارد|هزار|تومان|تومن|ریال|درصد|٪|%)|طرح\s/;
/** Plan line 36: a message naming a plan or an amount gets the disclaimer (once). */
export function withAmountDisclaimer(text: string): string {
  const t = text.trim();
  if (!AMOUNTISH.test(t + " ") || t.includes(BALE_AMOUNT_DISCLAIMER)) return t;
  return `${t}\n${BALE_AMOUNT_DISCLAIMER}`;
}

/* ------------------------------------------------ schema additions ------------------------------------------------ */
export function ensureBaleOutboxSchema(db: DatabaseSync): void {
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name));
  const add = (t: string, c: string, ddl: string) => { if (!cols(t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
  add("bale_accounts", "next_send_at", "TEXT");
  add("bale_accounts", "inbound_ignored", "INTEGER NOT NULL DEFAULT 0");
  add("bale_accounts", "stopped_reason", "TEXT");
  add("bale_outbox", "is_new_chat", "INTEGER NOT NULL DEFAULT 0");
  add("bale_outbox", "send_now", "INTEGER NOT NULL DEFAULT 0");
  add("bale_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
  add("bale_outbox", "reason", "TEXT");
  add("bale_outbox", "approved_at", "TEXT");
  add("bale_outbox", "reminder_id", "INTEGER");
  add("bale_outbox", "assistant_id", "INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS bale_reminder_messages (
    reminder_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), customer_id INTEGER NOT NULL, text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','enqueued','cancelled')), outbox_id INTEGER,
    created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // Decision (b): a paused conversation (UNVERIFIED peer_blocked path, only when peer_block_mode = conversation_pause).
  add("bale_conversation_state", "paused_reason", "TEXT");
  add("bale_conversation_state", "paused_at", "TEXT");
  // Decision (c): a Bale chat from someone who is not one of the expert's customers. Only the opaque peer id + counters are
  // kept — never the text, never the phone. «وصل به مشتری» turns it into a bale_contacts row; nothing from before is stored.
  db.exec(`CREATE TABLE IF NOT EXISTS bale_unknown_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), peer_id TEXT NOT NULL,
    first_at TEXT NOT NULL, last_at TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','linked','dismissed')), customer_id INTEGER, decided_by INTEGER, decided_at TEXT,
    UNIQUE(account_id, peer_id))`);
}
export const BALE_UNKNOWN_OPEN_MAX = 200;

/* ------------------------------------------------------ core ------------------------------------------------------ */
export type OutboxCtx = {
  db: DatabaseSync; now: () => Date; env: () => KeyEnv; sidecar: BaleSidecar; random?: () => number;
  setting: (k: string) => string; masterOn: () => boolean;
  audit: (o: { u?: any; accountId?: number | null; customerId?: number | null; action: string; outcome: string; detail?: Record<string, string | number | boolean | null> }) => void;
  userRow: (id: number) => any; nameOf: (u: any) => string | null; eligible: (u: any) => boolean;
  /** «حساب تستی» (lib/bale-test.ts): its own switch, independent of the experts' master switch. */
  testOn?: () => boolean;
  testInbound?: (a: any, evs: any[]) => { stored: number; ignored: number };
};
export type EnqueueIn = {
  accountId: number; customerId: number; text: string; source: "expert_command" | "reminder" | "assistant";
  explicit: boolean; createdBy: number | null; assistant?: { id: number; inScope: boolean } | null; reason?: string | null;
  reminderId?: number | null; sendNow?: boolean;
};
export type EnqueueOut =
  | { status: "blocked"; reason: BaleBlockReason; message: string; outboxId: number | null }
  | { status: "pending_approval" | "queued"; outboxId: number; heldUntil: string | null; message: string | null; text: string };

const ACTIVE = "('pending_approval','queued','sending')";
const AUTO_STOP = new Set(["rate_limited", "account_banned", "session_invalid"]);

export function createBaleOutbox(ctx: OutboxCtx) {
  const { db, now } = ctx;
  const rnd = ctx.random ?? Math.random;
  const iso = (d = now()) => d.toISOString();
  const row = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const num = (k: string, d: number) => { const v = Number(ctx.setting(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
  const banned = () => { try { const l = JSON.parse(ctx.setting("banned_words")); return Array.isArray(l) ? l.map(String) : []; } catch { return []; } };
  const quietNow = (d = now()) => inBaleQuiet(d, ctx.setting("quiet_start"), ctx.setting("quiet_end"));
  const quietEnd = (d = now()) => quietEndAfter(d, ctx.setting("quiet_end"));
  const acc = (id: number) => row<any>("SELECT * FROM bale_accounts WHERE id=?", id);
  const ref = (a: any) => `acc-${a.id}`;
  const since = (ms: number) => new Date(now().getTime() - ms).toISOString();
  let bellCols: boolean | null = null;
  const hasTable = (n: string) => Boolean(row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", n));

  /** Bell row (site_notification_events) addressed to one user; actor_key set so the request-local trigger leaves it alone. */
  const bellReady = () => {
    if (bellCols === null) bellCols = hasTable("site_notification_events") && rows<{ name: string }>("PRAGMA table_info(site_notification_events)").some(c => c.name === "recipient_user_id");
    return bellCols;
  };
  function bell(userId: number, customerId: number, kind: string, title: string, body: string) {
    if (!bellReady()) return;
    const c = row<any>("SELECT * FROM customers WHERE id=?", customerId); if (!c) return;
    const name = c.name;
    run(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(?,?,?,'bale',?,?,?,?,'bale.recipient',?,'bale:system',?)`, customerId, name ?? null, c.salesperson_id ?? null, customerId, kind, title, body.slice(0, 300), iso(), userId);
  }
  /** Decision (c): bell with no customer (customer_id 0). site-notifications shows resource_type 'bale-unknown' to its addressee only. */
  function bellUnknown(userId: number, unknownId: number) {
    if (!bellReady()) return;
    run(`INSERT INTO site_notification_events(customer_id,customer_name,owner_id,resource_type,resource_id,kind,title,body,permission,created_at,actor_key,recipient_user_id)
      VALUES(0,'',NULL,'bale-unknown',?,'bale-unknown',?,?,'bale.recipient',?,'bale:system',?)`, unknownId, "پیام از شماره‌ی ناشناس",
      "کسی که در فهرست مشتری‌های شما نیست در بله پیام داد. متنش ذخیره نشد؛ اگر مشتری خودتان است، گفتگو را به پرونده‌اش وصل کنید.", iso(), userId);
  }
  function ownCustomer(a: any, customerId: number) {
    const u = ctx.userRow(a.user_id);
    if (!u || !ctx.eligible(u) || !u.salesperson_id) return null;
    const c = Number.isSafeInteger(customerId) && customerId > 0 ? row<any>("SELECT id,phone,salesperson_id,merged_into_customer_id FROM customers WHERE id=?", customerId) : undefined;
    if (!c || c.salesperson_id !== u.salesperson_id || c.merged_into_customer_id != null) return null;
    return { u, c };
  }
  const hasPriorChat = (accountId: number, customerId: number) => Boolean(
    row("SELECT 1 FROM bale_contacts WHERE account_id=? AND customer_id=? AND has_prior_chat=1", accountId, customerId)
    || row("SELECT 1 FROM bale_messages WHERE account_id=? AND customer_id=? AND direction='in' LIMIT 1", accountId, customerId));
  const pausedOf = (accountId: number, customerId: number) => row<any>("SELECT paused_reason, paused_at FROM bale_conversation_state WHERE account_id=? AND customer_id=? AND paused_reason IS NOT NULL", accountId, customerId);
  const sentSince = (accountId: number, ms: number) => Number(row<any>("SELECT count(*) n FROM bale_outbox WHERE account_id=? AND status IN ('sent','sending') AND COALESCE(sent_at,updated_at)>?", accountId, since(ms))?.n ?? 0);
  const queuedCount = (accountId: number, excludeId = 0) => Number(row<any>("SELECT count(*) n FROM bale_outbox WHERE account_id=? AND status='queued' AND id<>?", accountId, excludeId)?.n ?? 0);
  const newChatsToday = (accountId: number, excludeId = 0) => Number(row<any>(`SELECT count(*) n FROM bale_outbox WHERE account_id=? AND is_new_chat=1 AND id<>?
    AND (status IN ('queued','sending') OR (status='sent' AND sent_at>?))`, accountId, excludeId, since(86_400_000))?.n ?? 0);

  /** All checks. `stage` = enqueue (queued rows count toward caps) | send (only real sends count). */
  function check(a: any | undefined, customerId: number, text: string, o: { explicit: boolean; assistantInScope?: boolean; stage: "enqueue" | "send"; selfId?: number }):
    { ok: true; phone: string; newChat: boolean } | { ok: false; reason: BaleBlockReason } {
    if (!ctx.masterOn()) return { ok: false, reason: "bale_disabled" };
    if (!a || a.status !== "connected" || !a.session_ct) return { ok: false, reason: "not_connected" };
    if (a.mode === "off") return { ok: false, reason: "mode_off" };
    if (liveState(a) === "down") return { ok: false, reason: "session_not_live" };
    const own = ownCustomer(a, customerId);
    if (!own || o.assistantInScope === false) return { ok: false, reason: "out_of_scope" };
    if (pausedOf(a.id, customerId)) return { ok: false, reason: "conversation_paused" };
    const tp = baleTextProblem(text, banned()); if (tp) return { ok: false, reason: tp };
    const phone = normalizeMobile(own.c.phone); if (!phone) return { ok: false, reason: "no_phone" };
    const prior = hasPriorChat(a.id, customerId);
    if (!prior && !o.explicit) return { ok: false, reason: "no_prior_chat" };
    if (o.stage === "enqueue" && row(`SELECT 1 FROM bale_outbox WHERE account_id=? AND customer_id=? AND status IN ${ACTIVE} AND id<>?`, a.id, customerId, o.selfId ?? 0))
      return { ok: false, reason: "already_pending" };
    const extra = o.stage === "enqueue" ? queuedCount(a.id, o.selfId) : 0;
    if (sentSince(a.id, 86_400_000) + extra >= num("per_day", 80)) return { ok: false, reason: "cap_day" };
    if (o.stage === "enqueue" && sentSince(a.id, 3_600_000) + extra >= num("per_hour", 20)) return { ok: false, reason: "cap_hour" };
    if (!prior && newChatsToday(a.id, o.selfId) >= num("new_chats_per_day", 15)) return { ok: false, reason: "cap_new_chats" };
    return { ok: true, phone, newChat: !prior };
  }

  function enqueue(p: EnqueueIn): EnqueueOut {
    const a = acc(p.accountId); const t = iso();
    const text = withAmountDisclaimer(String(p.text ?? ""));
    const r = check(a, p.customerId, text, { explicit: p.explicit, assistantInScope: p.assistant ? p.assistant.inScope : undefined, stage: "enqueue" });
    const actor = p.createdBy ? ctx.userRow(p.createdBy) : undefined;
    if (!r.ok) {
      let outboxId: number | null = null;
      // Assistant / reminder attempts are kept (blocked) so the expert sees what was stopped; the expert's own typing is not stored.
      if (a && p.source !== "expert_command" && r.reason !== "already_pending") {
        outboxId = Number(run(`INSERT INTO bale_outbox(account_id,customer_id,text,source,explicit_expert_command,status,block_reason,created_by,created_at,updated_at,reason,reminder_id,assistant_id)
          VALUES(?,?,?,?,?,'blocked',?,?,?,?,?,?,?)`, a.id, p.customerId, text.slice(0, BALE_MAX_TEXT * 2), p.source, p.explicit ? 1 : 0, r.reason, p.createdBy, t, t,
          p.reason ?? null, p.reminderId ?? null, p.assistant?.id ?? null).lastInsertRowid);
      }
      ctx.audit({ u: actor, accountId: a?.id ?? null, customerId: p.customerId, action: `outbox.${p.source}`, outcome: `blocked:${r.reason}`, detail: { outboxId } });
      return { status: "blocked", reason: r.reason, message: BLOCK_FA[r.reason], outboxId };
    }
    const draft = p.source !== "expert_command" && a.mode === "approve_first";
    const sendNow = p.source === "expert_command" && Boolean(p.sendNow);
    const held = !draft && !sendNow && quietNow() ? iso(quietEnd()) : null;
    const id = Number(run(`INSERT INTO bale_outbox(account_id,customer_id,text,source,explicit_expert_command,status,created_by,scheduled_at,created_at,updated_at,
        is_new_chat,send_now,reason,reminder_id,assistant_id,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, p.customerId, text, p.source, p.explicit ? 1 : 0, draft ? "pending_approval" : "queued", p.createdBy, held, t, t, r.newChat ? 1 : 0, sendNow ? 1 : 0,
      p.reason ?? null, p.reminderId ?? null, p.assistant?.id ?? null, p.source === "expert_command" ? p.createdBy : null, p.source === "expert_command" ? t : null).lastInsertRowid);
    if (draft) bell(a.user_id, p.customerId, "bale-draft", "پیش‌نویس پیام بله منتظر تأیید شما", p.source === "reminder" ? "یادآور رسید؛ پیام را ببینید و بفرستید." : "دستیار یک پیام پیشنهاد داده؛ ببینید و بفرستید.");
    ctx.audit({ u: actor, accountId: a.id, customerId: p.customerId, action: `outbox.${p.source}`, outcome: draft ? "pending_approval" : "queued", detail: { outboxId: id, held: Boolean(held), newChat: r.newChat, sendNow } });
    return { status: draft ? "pending_approval" : "queued", outboxId: id, heldUntil: held, message: held ? BLOCK_FA.quiet_hours : null, text };
  }

  /* ---------------- expert actions on one row (owner only; checked by the caller) ---------------- */
  function approve(id: number, u: any, newText?: string): EnqueueOut {
    const o = row<any>("SELECT * FROM bale_outbox WHERE id=?", id); const a = o ? acc(o.account_id) : undefined;
    if (!o || !a || o.status !== "pending_approval") return { status: "blocked", reason: "already_pending", message: "این پیش‌نویس دیگر منتظر تأیید نیست.", outboxId: o?.id ?? null };
    const text = withAmountDisclaimer(newText ?? o.text);
    // The expert's approval IS an explicit command for this customer.
    const r = check(a, o.customer_id, text, { explicit: true, stage: "enqueue", selfId: o.id });
    if (!r.ok) {
      if (r.reason === "out_of_scope" || r.reason === "bale_disabled" || r.reason === "not_connected" || r.reason === "mode_off")
        run("UPDATE bale_outbox SET status='blocked', block_reason=?, updated_at=? WHERE id=?", r.reason, iso(), o.id);
      ctx.audit({ u, accountId: a.id, customerId: o.customer_id, action: "outbox.approve", outcome: `blocked:${r.reason}`, detail: { outboxId: o.id } });
      return { status: "blocked", reason: r.reason, message: BLOCK_FA[r.reason], outboxId: o.id };
    }
    const held = quietNow() ? iso(quietEnd()) : null;
    run(`UPDATE bale_outbox SET text=?, status='queued', explicit_expert_command=1, is_new_chat=?, approved_by=?, approved_at=?, scheduled_at=?, updated_at=? WHERE id=?`,
      text, r.newChat ? 1 : 0, u.id, iso(), held, iso(), o.id);
    ctx.audit({ u, accountId: a.id, customerId: o.customer_id, action: "outbox.approve", outcome: "queued", detail: { outboxId: o.id, edited: newText !== undefined, held: Boolean(held) } });
    return { status: "queued", outboxId: o.id, heldUntil: held, message: held ? BLOCK_FA.quiet_hours : null, text };
  }
  function editDraft(id: number, u: any, text: string): { ok: true; text: string } | { ok: false; reason: BaleBlockReason | "not_editable"; message: string } {
    const o = row<any>("SELECT * FROM bale_outbox WHERE id=?", id);
    if (!o || o.status !== "pending_approval") return { ok: false, reason: "not_editable", message: "این پیش‌نویس دیگر قابل ویرایش نیست." };
    const t = withAmountDisclaimer(String(text ?? ""));
    const tp = baleTextProblem(t, banned()); if (tp) return { ok: false, reason: tp, message: BLOCK_FA[tp] };
    run("UPDATE bale_outbox SET text=?, updated_at=? WHERE id=?", t, iso(), o.id);
    ctx.audit({ u, accountId: o.account_id, customerId: o.customer_id, action: "outbox.edit", outcome: "ok", detail: { outboxId: o.id } });
    return { ok: true, text: t };
  }
  function cancel(id: number, u: any): boolean {
    const o = row<any>("SELECT * FROM bale_outbox WHERE id=?", id);
    if (!o || !["pending_approval", "queued"].includes(o.status)) return false;
    run("UPDATE bale_outbox SET status='cancelled', updated_at=? WHERE id=? AND status IN ('pending_approval','queued')", iso(), o.id);
    ctx.audit({ u, accountId: o.account_id, customerId: o.customer_id, action: "outbox.cancel", outcome: "ok", detail: { outboxId: o.id } });
    return true;
  }
  /** «همین الان»: the expert's explicit command to skip quiet hours for one queued row (caps and gaps still apply). */
  function sendNow(id: number, u: any): boolean {
    const o = row<any>("SELECT * FROM bale_outbox WHERE id=?", id);
    if (!o || o.status !== "queued") return false;
    run("UPDATE bale_outbox SET send_now=1, explicit_expert_command=1, scheduled_at=NULL, updated_at=? WHERE id=?", iso(), o.id);
    ctx.audit({ u, accountId: o.account_id, customerId: o.customer_id, action: "outbox.send_now", outcome: "ok", detail: { outboxId: o.id } });
    return true;
  }

  /* ---------------- auto-stop ---------------- */
  function autoStop(a: any, code: string, customerId: number, from?: string) {
    const t = iso();
    // The session is gone (banned / dead): close the live client too, so nothing keeps listening on it.
    if (code === "account_banned" || code === "session_invalid") void ctx.sidecar.detach({ accountRef: ref(a) }).catch(() => undefined);
    const status = code === "account_banned" ? "banned" : code === "session_invalid" ? "error" : a.status;
    run(`UPDATE bale_accounts SET mode='off', status=?, last_error=?, stopped_reason=?, updated_at=?${code === "session_invalid" || code === "account_banned" ? ", session_ct=NULL, session_key_id=NULL" : ""} WHERE id=?`,
      status, code, code, t, a.id);
    const n = run(`UPDATE bale_outbox SET status='blocked', block_reason='auto_stopped', updated_at=? WHERE account_id=? AND status IN ('pending_approval','queued')`, t, a.id).changes;
    ctx.audit({ accountId: a.id, customerId, action: "account.auto_stop", outcome: code, detail: { blockedRows: Number(n), ...(from ? { from, unverified: true } : {}) } });
    const why = code === "rate_limited" ? "بله محدودیت ارسال گذاشت" : code === "account_banned" ? "بله حساب را مسدود کرد" : "نشست بله از کار افتاد";
    const owner = ctx.userRow(a.user_id);
    bell(a.user_id, customerId, "bale-stopped", "ارسال بله متوقف شد", `${why}؛ حالت ارسال خاموش شد. از صفحه‌ی «اتصال بله» وضعیت را ببینید.`);
    for (const ad of rows<any>("SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 AND id<>29"))
      bell(ad.id, customerId, "bale-stopped", `ارسال بله‌ی ${ctx.nameOf(owner) ?? "کارشناس"} متوقف شد`, `${why}؛ حالت ارسال خودکار خاموش شد.`);
  }

  /* ---------------- decision (b): pause ONE conversation (UNVERIFIED peer_blocked; only when peer_block_mode = conversation_pause) ---------------- */
  function pauseConversation(a: any, customerId: number, reason: string) {
    const t = iso();
    run(`INSERT INTO bale_conversation_state(customer_id,account_id,mode,updated_at,paused_reason,paused_at) VALUES(?,?,'assistant',?,?,?)
      ON CONFLICT(customer_id,account_id) DO UPDATE SET paused_reason=excluded.paused_reason, paused_at=excluded.paused_at, updated_at=excluded.updated_at`, customerId, a.id, t, reason, t);
    const n = run(`UPDATE bale_outbox SET status='blocked', block_reason='conversation_paused', updated_at=? WHERE account_id=? AND customer_id=? AND status IN ('pending_approval','queued')`, t, a.id, customerId).changes;
    ctx.audit({ accountId: a.id, customerId, action: "conversation.pause", outcome: reason, detail: { blockedRows: Number(n), unverified: true } });
    bell(a.user_id, customerId, "bale-paused", "گفتگوی بله با این مشتری متوقف شد", "به نظر می‌رسد مشتری شما را در بله مسدود کرده؛ فقط همین گفتگو متوقف شد و بقیه‌ی پیام‌ها عادی می‌روند.");
  }
  function resumeConversation(u: any, a: any, customerId: number): boolean {
    const n = run("UPDATE bale_conversation_state SET paused_reason=NULL, paused_at=NULL, updated_at=? WHERE account_id=? AND customer_id=? AND paused_reason IS NOT NULL", iso(), a.id, customerId).changes;
    if (n) ctx.audit({ u, accountId: a.id, customerId, action: "conversation.resume", outcome: "ok" });
    return n === 1;
  }

  /* ---------------- sessions (re-attach after a sidecar restart) ---------------- */
  let lastBoot: string | null = null; let lastSync = 0;
  /** General rule (2026-10-26): "connected" in the DB only means a sealed session exists. Whether the sidecar really holds a
   *  working client comes from the sidecar itself (health.attached + attach results): true = live, false = down (attach failed,
   *  not attached, or sidecar unreachable). While down, nothing is sent and the UI says «اتصال ناقص، در حال رفع». Never changes
   *  mode or status; the worker keeps re-attaching once a minute. Unknown (no sync yet since the API started) is not "down". */
  const liveRefs = new Map<string, boolean>();
  const liveState = (a: any): "live" | "down" | "unknown" => { const v = liveRefs.get(ref(a)); return v === undefined ? "unknown" : v ? "live" : "down"; };
  async function attachOne(a: any): Promise<boolean> {
    try {
      const aad = baleSessionAad(a.id, a.user_id);
      const { plaintext, rotated } = openBaleSession(ctx.env(), a.session_ct, aad);
      if (rotated) run("UPDATE bale_accounts SET session_ct=?, session_key_id=? WHERE id=?", rotated.value, rotated.keyId, a.id); // lazy re-seal under the current key
      await ctx.sidecar.attach({ accountRef: ref(a), token: plaintext, deviceHash: a.device_hash });
      run("UPDATE bale_accounts SET last_seen_at=?, last_error=NULL WHERE id=?", iso(), a.id);
      liveRefs.set(ref(a), true);
      ctx.audit({ accountId: a.id, action: "session.attach", outcome: "ok", detail: { rotated: Boolean(rotated) } });
      return true;
    } catch (e) {
      const code = e instanceof BaleSidecarError ? e.code : e instanceof BaleKeyMissing ? "key_missing" : "error";
      liveRefs.set(ref(a), false);
      ctx.audit({ accountId: a.id, action: "session.attach", outcome: code });
      if (code === "session_invalid" || code === "account_banned") autoStop(a, code, Number(row<any>("SELECT customer_id FROM bale_outbox WHERE account_id=? ORDER BY id DESC LIMIT 1", a.id)?.customer_id ?? 0));
      return false;
    }
  }
  async function syncSessions(force = false): Promise<{ attached: number }> {
    if (!ctx.sidecar.configured()) return { attached: 0 };
    if (!force && now().getTime() - lastSync < 60_000) return { attached: 0 };
    lastSync = now().getTime();
    const h = await ctx.sidecar.health();
    const connected = rows<any>("SELECT * FROM bale_accounts WHERE status='connected' AND session_ct IS NOT NULL ORDER BY id");
    const seen = new Set(h.ok ? h.attached ?? [] : []);
    liveRefs.clear(); for (const a of connected) liveRefs.set(ref(a), seen.has(ref(a))); // sidecar down → every session is down
    if (!h.ok) return { attached: 0 };
    const masterOn = ctx.masterOn(), testOn = ctx.testOn?.() ?? false;
    const testRefs = new Set(rows<any>("SELECT id FROM bale_accounts WHERE kind='system_test'").map(x => `acc-${x.id}`));
    // Experts' master switch off: close every expert client. The system test account follows ONLY its own test switch.
    for (const r of h.attached ?? []) {
      const isTest = testRefs.has(r);
      if (isTest ? !testOn : !masterOn) { await ctx.sidecar.detach({ accountRef: r }); liveRefs.set(r, false); }
    }
    if (!masterOn && !testOn) return { attached: 0 };
    const live = new Set(h.attached ?? []);
    const restarted = h.bootId != null && lastBoot != null && h.bootId !== lastBoot;
    lastBoot = h.bootId ?? lastBoot;
    let n = 0;
    for (const a of connected) {
      if (a.kind === "system_test" ? !testOn : !masterOn) continue;
      if (!restarted && live.has(ref(a))) continue;
      if (await attachOne(a)) n++;
    }
    return { attached: n };
  }

  /* ---------------- worker ---------------- */
  function dueReminders(): number {
    if (!hasTable("reminders")) return 0;
    let n = 0;
    for (const m of rows<any>(`SELECT m.*, r.done, r.remind_at FROM bale_reminder_messages m JOIN reminders r ON r.id=m.reminder_id
        WHERE m.status='scheduled' AND r.remind_at<=? ORDER BY r.remind_at LIMIT 50`, iso())) {
      if (m.done) { run("UPDATE bale_reminder_messages SET status='cancelled', updated_at=? WHERE reminder_id=?", iso(), m.reminder_id); continue; }
      const r = enqueue({ accountId: m.account_id, customerId: m.customer_id, text: m.text, source: "reminder", explicit: true, createdBy: m.created_by, reminderId: m.reminder_id });
      run("UPDATE bale_reminder_messages SET status='enqueued', outbox_id=?, updated_at=? WHERE reminder_id=?", r.outboxId, iso(), m.reminder_id);
      if (r.status === "blocked") { const a = acc(m.account_id); if (a) bell(a.user_id, m.customer_id, "bale-blocked", "پیام یادآور بله فرستاده نشد", r.message); }
      n++;
    }
    return n;
  }
  function stale() {
    run(`UPDATE bale_outbox SET status='failed', error='uncertain', updated_at=? WHERE status='sending' AND updated_at<?`, iso(), since(BALE_SENDING_STALE_MS));
  }
  const gapMs = () => { const lo = num("gap_min_s", 45), hi = Math.max(lo, num("gap_max_s", 120)); return Math.round((lo + rnd() * (hi - lo)) * 1000); };

  async function sendOne(a: any): Promise<string> {
    const nowIso = iso();
    if (a.next_send_at && a.next_send_at > nowIso) return "gap";
    const o = row<any>(`SELECT * FROM bale_outbox WHERE account_id=? AND status='queued' AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY COALESCE(scheduled_at,created_at), id LIMIT 1`, a.id, nowIso);
    if (!o) return "idle";
    const block = (reason: BaleBlockReason) => { run("UPDATE bale_outbox SET status='blocked', block_reason=?, updated_at=? WHERE id=?", reason, iso(), o.id);
      ctx.audit({ accountId: a.id, customerId: o.customer_id, action: "outbox.send", outcome: `blocked:${reason}`, detail: { outboxId: o.id } }); return `blocked:${reason}`; };
    const hold = (until: Date, why: string) => { run("UPDATE bale_outbox SET scheduled_at=?, updated_at=? WHERE id=?", iso(until), iso(), o.id); return `held:${why}`; };
    const r = check(a, o.customer_id, o.text, { explicit: Boolean(o.explicit_expert_command), stage: "send" });
    if (!r.ok) {
      if (r.reason === "cap_day") { const first = row<any>("SELECT min(COALESCE(sent_at,updated_at)) t FROM bale_outbox WHERE account_id=? AND status IN ('sent','sending') AND COALESCE(sent_at,updated_at)>?", a.id, since(86_400_000))?.t; return hold(new Date(Date.parse(first ?? nowIso) + 86_400_000 + 1000), "cap_day"); }
      if (r.reason === "cap_new_chats") return hold(new Date(now().getTime() + 3_600_000), "cap_new_chats");
      if (r.reason === "session_not_live") {
        // Locked: never call the sidecar. Approved rows wait up to 15 min for the re-attach (once a minute), then stop with a bell.
        if (Date.parse(o.approved_at ?? o.created_at) > now().getTime() - 15 * 60_000) return hold(new Date(now().getTime() + 60_000), "session_not_live");
        bell(a.user_id, o.customer_id, "bale-failed", "پیام بله فرستاده نشد", BLOCK_FA.session_not_live);
      }
      return block(r.reason);
    }
    if (sentSince(a.id, 3_600_000) >= num("per_hour", 20)) {
      const first = row<any>("SELECT min(COALESCE(sent_at,updated_at)) t FROM bale_outbox WHERE account_id=? AND status IN ('sent','sending') AND COALESCE(sent_at,updated_at)>?", a.id, since(3_600_000))?.t;
      return hold(new Date(Date.parse(first ?? nowIso) + 3_600_000 + 1000), "cap_hour");
    }
    if (!o.send_now && quietNow()) return hold(quietEnd(), "quiet");
    if (run("UPDATE bale_outbox SET status='sending', attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'", iso(), o.id).changes !== 1) return "raced";
    const contact = row<any>("SELECT peer_id FROM bale_contacts WHERE account_id=? AND customer_id=?", a.id, o.customer_id);
    const payload = { accountRef: ref(a), phone: r.phone, peerId: contact?.peer_id ?? null, text: o.text, typingMs: Math.min(8000, 1200 + o.text.length * 50) };
    try {
      let out;
      try { out = await ctx.sidecar.send(payload); }
      catch (e) {
        if (!(e instanceof BaleSidecarError && e.code === "not_attached")) throw e;
        if (!(await attachOne(a))) throw e;
        out = await ctx.sidecar.send(payload);
      }
      const t = iso();
      run("UPDATE bale_outbox SET status='sent', sent_at=?, bale_msg_id=?, error=NULL, updated_at=? WHERE id=?", t, out.messageId, t, o.id);
      run(`INSERT INTO bale_messages(account_id,customer_id,direction,text,bale_msg_id,outbox_id,status,created_at) VALUES(?,?,'out',?,?,?,'sent',?)
        ON CONFLICT(account_id,bale_msg_id) DO NOTHING`, a.id, o.customer_id, o.text, out.messageId, o.id, t);
      run(`INSERT INTO bale_contacts(account_id,customer_id,peer_id,first_contact_at,has_prior_chat,created_at) VALUES(?,?,?,?,0,?)
        ON CONFLICT(account_id,customer_id) DO UPDATE SET peer_id=excluded.peer_id, first_contact_at=COALESCE(bale_contacts.first_contact_at,excluded.first_contact_at)`,
        a.id, o.customer_id, out.peerId, t, t);
      run("UPDATE bale_accounts SET next_send_at=?, last_seen_at=? WHERE id=?", new Date(now().getTime() + gapMs()).toISOString(), t, a.id);
      if (o.reminder_id) run("UPDATE reminders SET done=1 WHERE id=? AND done=0", o.reminder_id);
      ctx.audit({ accountId: a.id, customerId: o.customer_id, action: "outbox.send", outcome: "sent", detail: { outboxId: o.id, source: o.source } });
      return "sent";
    } catch (e) {
      const code = e instanceof BaleSidecarError ? e.code : "error";
      const t = iso();
      if (code === "peer_blocked") {
        run("UPDATE bale_outbox SET status='failed', error='peer_blocked', updated_at=? WHERE id=?", t, o.id);
        // UNVERIFIED path. Safe default (account_stop): exactly like a ban — the whole account stops.
        if (ctx.setting("peer_block_mode") === "conversation_pause") pauseConversation(a, o.customer_id, "peer_blocked");
        else autoStop(a, "account_banned", o.customer_id, "peer_blocked");
      } else if (AUTO_STOP.has(code)) {
        run("UPDATE bale_outbox SET status='failed', error=?, updated_at=? WHERE id=?", code, t, o.id);
        autoStop(a, code, o.customer_id);
      } else if (code === "peer_not_found") {
        run("UPDATE bale_outbox SET status='failed', error='no_bale_account', updated_at=? WHERE id=?", t, o.id);
        bell(a.user_id, o.customer_id, "bale-failed", "پیام بله فرستاده نشد", BLOCK_FA.no_bale_account);
      } else if (["sidecar_unavailable", "sidecar_not_configured", "not_attached"].includes(code) && o.attempts + 1 < BALE_MAX_ATTEMPTS) {
        run("UPDATE bale_outbox SET status='queued', scheduled_at=?, error=?, updated_at=? WHERE id=?", new Date(now().getTime() + 60_000 * (o.attempts + 1)).toISOString(), code, t, o.id);
      } else {
        run("UPDATE bale_outbox SET status='failed', error=?, updated_at=? WHERE id=?", code, t, o.id);
        bell(a.user_id, o.customer_id, "bale-failed", "پیام بله فرستاده نشد", BLOCK_FA.send_failed);
      }
      ctx.audit({ accountId: a.id, customerId: o.customer_id, action: "outbox.send", outcome: code, detail: { outboxId: o.id, attempt: o.attempts + 1 } });
      return `error:${code}`;
    }
  }
  let busy = false;
  async function tick(): Promise<{ reminders: number; results: Record<number, string> }> {
    if (busy) return { reminders: 0, results: {} };
    busy = true;
    try {
      stale();
      const reminders = dueReminders();
      await syncSessions();
      const results: Record<number, string> = {};
      for (const a of rows<any>(`SELECT * FROM bale_accounts WHERE kind<>'system_test' AND id IN (SELECT DISTINCT account_id FROM bale_outbox WHERE status='queued')`)) {
        if (!ctx.masterOn() || a.status !== "connected" || a.mode === "off") {
          // Switched off / disconnected while rows were queued: nothing is sent; rows become blocked with the reason.
          const reason: BaleBlockReason = !ctx.masterOn() ? "bale_disabled" : a.status !== "connected" ? "not_connected" : "mode_off";
          run("UPDATE bale_outbox SET status='blocked', block_reason=?, updated_at=? WHERE account_id=? AND status='queued'", reason, iso(), a.id);
          results[a.id] = `blocked:${reason}`; continue;
        }
        results[a.id] = await sendOne(a);
      }
      return { reminders, results };
    } finally { busy = false; }
  }

  /* ---------------- inbound ---------------- */
  type InEv = { messageId?: unknown; peerId?: unknown; peerPhone?: unknown; text?: unknown; hasFile?: unknown; date?: unknown; fromSelf?: unknown };
  function matchCustomer(a: any, spId: number, ev: InEv): number | null {
    const peer = ev.peerId == null ? "" : String(ev.peerId).slice(0, 40);
    if (peer) {
      const c = row<any>("SELECT customer_id FROM bale_contacts WHERE account_id=? AND peer_id=?", a.id, peer);
      if (c) return c.customer_id;
    }
    const phone = normalizeMobile(ev.peerPhone);
    if (!phone) return null;
    // Stored phones may carry spaces / +98 / Persian digits, so normalise in JS over the expert's own customers only.
    const hits = rows<any>("SELECT id,phone FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND phone<>''", spId)
      .filter(c => normalizeMobile(c.phone) === phone);
    return hits.length === 1 ? hits[0].id : null;
  }
  function inbound(body: any): { stored: number; ignored: number } {
    const m = /^acc-(\d+)$/.exec(String(body?.accountRef ?? ""));
    const a = m ? acc(Number(m[1])) : undefined;
    const evs: InEv[] = Array.isArray(body?.events) ? body.events.slice(0, 50) : [];
    if (a?.kind === "system_test") return ctx.testInbound ? ctx.testInbound(a, evs) : { stored: 0, ignored: evs.length };
    if (!a || a.status !== "connected" || !ctx.masterOn()) return { stored: 0, ignored: evs.length };
    const u = ctx.userRow(a.user_id);
    if (!u || !ctx.eligible(u)) return { stored: 0, ignored: evs.length };
    let stored = 0, ignored = 0;
    const sa = hasTable("assistants") ? row<any>("SELECT * FROM assistants WHERE kind='sales' AND bound_user_id=? AND enabled=1", u.id) : undefined;
    for (const ev of evs) {
      const cid = matchCustomer(a, u.salesperson_id, ev);
      const own = cid ? ownCustomer(a, cid) : null;
      const mid = ev.messageId == null ? "" : String(ev.messageId).slice(0, 64);
      if (!cid && mid && ev.fromSelf !== true && ev.peerId != null && String(ev.peerId).trim()) unknownSeen(a, String(ev.peerId).slice(0, 40));
      if (!cid || !own || !mid) { ignored++; continue; }
      const text = typeof ev.text === "string" ? ev.text.slice(0, 4000) : null;
      const dir = ev.fromSelf === true ? "out" : "in";
      const at = Number.isFinite(Number(ev.date)) && Number(ev.date) > 1e12 ? new Date(Number(ev.date)).toISOString() : iso();
      const ins = run(`INSERT INTO bale_messages(account_id,customer_id,direction,text,file_ref,bale_msg_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,bale_msg_id) DO NOTHING`, a.id, cid, dir, text, ev.hasFile === true ? "bale:pending" : null, mid, dir === "in" ? "received" : "external", at);
      if (ins.changes !== 1) continue; // duplicate (sidecar retry) or our own sent message echoed back
      stored++;
      const peer = ev.peerId == null ? null : String(ev.peerId).slice(0, 40);
      run(`INSERT INTO bale_contacts(account_id,customer_id,peer_id,first_contact_at,has_prior_chat,created_at) VALUES(?,?,?,?,1,?)
        ON CONFLICT(account_id,customer_id) DO UPDATE SET has_prior_chat=1, peer_id=COALESCE(excluded.peer_id,bale_contacts.peer_id),
        first_contact_at=COALESCE(bale_contacts.first_contact_at,excluded.first_contact_at)`, a.id, cid, peer, at, iso());
      if (dir !== "in") continue;
      const preview = text ? text.replace(/\s+/g, " ").slice(0, 120) : ev.hasFile === true ? "یک فایل فرستاد." : "";
      bell(a.user_id, cid, "bale-inbound", "مشتری در بله جواب داد", preview);
      if (sa && hasTable("assistant_events")) {
        run("INSERT INTO assistant_events(assistant_id,type,thread_id,user_id,customer_id,message_id,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          sa.id, "bale_inbound", null, u.id, cid, null, JSON.stringify({ baleMessageId: Number(ins.lastInsertRowid), preview: maskText(text ?? "").slice(0, 500), hasFile: ev.hasFile === true }), iso());
      }
      ctx.audit({ accountId: a.id, customerId: cid, action: "inbound.message", outcome: "stored", detail: { hasFile: ev.hasFile === true } });
    }
    if (ignored) run("UPDATE bale_accounts SET inbound_ignored=inbound_ignored+? WHERE id=?", ignored, a.id);
    return { stored, ignored };
  }

  /* ---------------- decision (c): chats from people who are not the expert's customers ---------------- */
  function unknownSeen(a: any, peer: string) {
    const t = iso();
    const ex = row<any>("SELECT id,status FROM bale_unknown_chats WHERE account_id=? AND peer_id=?", a.id, peer);
    if (ex) { run("UPDATE bale_unknown_chats SET last_at=?, messages=messages+1 WHERE id=?", t, ex.id); return; }
    if (Number(row<any>("SELECT count(*) n FROM bale_unknown_chats WHERE account_id=? AND status='open'", a.id)?.n ?? 0) >= BALE_UNKNOWN_OPEN_MAX) return;
    const id = Number(run("INSERT INTO bale_unknown_chats(account_id,peer_id,first_at,last_at) VALUES(?,?,?,?)", a.id, peer, t, t).lastInsertRowid);
    bellUnknown(a.user_id, id); // one bell per unknown chat, never per message
    ctx.audit({ accountId: a.id, action: "unknown.seen", outcome: "new", detail: { unknownId: id } });
  }
  const unknownView = (x: any) => ({ id: x.id, firstAt: x.first_at, lastAt: x.last_at, messages: Number(x.messages), status: x.status });
  const unknownList = (a: any) => rows<any>("SELECT * FROM bale_unknown_chats WHERE account_id=? AND status='open' ORDER BY last_at DESC LIMIT 50", a.id).map(unknownView);
  type LinkOut = { ok: true } | { ok: false; status: number; error: string; message: string };
  function linkUnknown(u: any, a: any, unknownId: number, customerId: number): LinkOut {
    const x = row<any>("SELECT * FROM bale_unknown_chats WHERE id=? AND account_id=?", unknownId, a.id);
    if (!x || x.status === "linked") return { ok: false, status: 404, error: "not_found", message: "این گفتگو پیدا نشد یا قبلاً وصل شده است." };
    if (!ownCustomer(a, customerId)) { ctx.audit({ u, accountId: a.id, customerId: Number.isSafeInteger(customerId) ? customerId : null, action: "unknown.link", outcome: "out_of_scope", detail: { unknownId } });
      return { ok: false, status: 404, error: "out_of_scope", message: BLOCK_FA.out_of_scope }; }
    const taken = row<any>("SELECT customer_id FROM bale_contacts WHERE account_id=? AND peer_id=? AND customer_id<>?", a.id, x.peer_id, customerId);
    if (taken) return { ok: false, status: 409, error: "peer_linked", message: "این گفتگوی بله قبلاً به مشتری دیگری وصل شده است." };
    const c = row<any>("SELECT peer_id FROM bale_contacts WHERE account_id=? AND customer_id=?", a.id, customerId);
    if (c?.peer_id && c.peer_id !== x.peer_id) return { ok: false, status: 409, error: "customer_has_chat", message: "این مشتری قبلاً به یک گفتگوی دیگر در بله وصل است." };
    const t = iso();
    run(`INSERT INTO bale_contacts(account_id,customer_id,peer_id,first_contact_at,has_prior_chat,created_at) VALUES(?,?,?,?,1,?)
      ON CONFLICT(account_id,customer_id) DO UPDATE SET peer_id=excluded.peer_id, has_prior_chat=1, first_contact_at=COALESCE(bale_contacts.first_contact_at,excluded.first_contact_at)`,
      a.id, customerId, x.peer_id, x.first_at, t);
    run("UPDATE bale_unknown_chats SET status='linked', customer_id=?, decided_by=?, decided_at=? WHERE id=?", customerId, u.id, t, x.id);
    ctx.audit({ u, accountId: a.id, customerId, action: "unknown.link", outcome: "ok", detail: { unknownId: x.id } });
    return { ok: true };
  }
  function dismissUnknown(u: any, a: any, unknownId: number): boolean {
    const n = run("UPDATE bale_unknown_chats SET status='dismissed', decided_by=?, decided_at=? WHERE id=? AND account_id=? AND status='open'", u.id, iso(), unknownId, a.id).changes;
    if (n) ctx.audit({ u, accountId: a.id, action: "unknown.dismiss", outcome: "ok", detail: { unknownId } });
    return n === 1;
  }
  /** Picker for «وصل به مشتری»: the expert's OWN active customers only; phone shown masked. */
  function ownCustomerSearch(u: any, q: string) {
    if (!u?.salesperson_id) return [];
    const s = String(q ?? "").trim().slice(0, 40);
    const digits = s.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");
    const list = digits.length >= 4
      ? rows<any>("SELECT id,name,phone FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND phone<>'' ORDER BY id DESC LIMIT 5000", u.salesperson_id)
          .filter(c => (normalizeMobile(c.phone) ?? "").includes(digits)).slice(0, 15)
      : s.length >= 2 ? rows<any>("SELECT id,name,phone FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND name LIKE ? ORDER BY id DESC LIMIT 15", u.salesperson_id, `%${s}%`) : [];
    return list.map(c => { const p = normalizeMobile(c.phone); return { id: c.id, name: c.name, phoneMasked: p ? `${p.slice(0, 4)}•••${p.slice(-2)}` : null }; });
  }

  /* ---------------- views ---------------- */
  const SOURCE_FA: Record<string, string> = { expert_command: "دستور شما", reminder: "یادآور", assistant: "دستیار فروش", auto_reply: "پاسخ خودکار" };
  function itemView(o: any, viewerIsOwner: boolean) {
    return { id: o.id, customerId: o.customer_id, status: o.status, source: o.source, sourceLabel: SOURCE_FA[o.source] ?? o.source, text: o.text,
      reason: o.reason ?? null, blockReason: o.block_reason ?? null, blockMessage: o.block_reason ? BLOCK_FA[o.block_reason as BaleBlockReason] ?? null : null,
      error: o.error ?? null, errorMessage: o.error ? BLOCK_FA[o.error as keyof typeof BLOCK_FA] ?? BLOCK_FA.send_failed : null,
      scheduledAt: o.scheduled_at ?? null, sendNow: Boolean(o.send_now), sentAt: o.sent_at ?? null, createdAt: o.created_at, newChat: Boolean(o.is_new_chat),
      canAct: viewerIsOwner && ["pending_approval", "queued"].includes(o.status) };
  }
  /** Rows shown in the tab: active ones + blocked/failed in the last 3 days (sent rows are already bubbles). */
  const tabItems = (accountId: number, customerId: number) => rows<any>(`SELECT * FROM bale_outbox WHERE account_id=? AND customer_id=?
      AND (status IN ${ACTIVE} OR (status IN ('blocked','failed') AND updated_at>?)) ORDER BY id DESC LIMIT 20`, accountId, customerId, since(3 * 86_400_000)).reverse();
  function sendState(a: any | undefined, customerId: number) {
    const prior = a ? hasPriorChat(a.id, customerId) : false;
    const t = now();
    return { quietNow: quietNow(t), quietEnd: quietNow(t) ? iso(quietEnd(t)) : null, hasPriorChat: prior,
      sentLastHour: a ? sentSince(a.id, 3_600_000) : 0, perHour: num("per_hour", 20), sentToday: a ? sentSince(a.id, 86_400_000) : 0, perDay: num("per_day", 80),
      reminders: a ? rows<any>(`SELECT m.reminder_id,m.text,m.status,r.remind_at FROM bale_reminder_messages m JOIN reminders r ON r.id=m.reminder_id
        WHERE m.account_id=? AND m.customer_id=? AND m.status='scheduled' ORDER BY r.remind_at`, a.id, customerId).map(x => ({ reminderId: x.reminder_id, text: x.text, remindAt: x.remind_at })) : [] };
  }
  function linkReminder(u: any, a: any, reminderId: number, text: string): { ok: true } | { ok: false; status: number; error: string; message: string } {
    const r = hasTable("reminders") ? row<any>("SELECT * FROM reminders WHERE id=?", reminderId) : undefined;
    if (!r || r.user_id !== u.id || !r.customer_id || r.done) return { ok: false, status: 404, error: "reminder_not_found", message: "یادآور پیدا نشد." };
    if (!ownCustomer(a, r.customer_id)) return { ok: false, status: 404, error: "out_of_scope", message: BLOCK_FA.out_of_scope };
    if (row("SELECT 1 FROM bale_reminder_messages WHERE reminder_id=?", reminderId)) return { ok: false, status: 409, error: "already_linked", message: "این یادآور پیام بله دارد." };
    const t = withAmountDisclaimer(String(text ?? ""));
    const tp = baleTextProblem(t, banned()); if (tp) return { ok: false, status: 422, error: tp, message: BLOCK_FA[tp] };
    run("INSERT INTO bale_reminder_messages(reminder_id,account_id,customer_id,text,status,created_by,created_at,updated_at) VALUES(?,?,?,?,'scheduled',?,?,?)",
      reminderId, a.id, r.customer_id, t, u.id, iso(), iso());
    ctx.audit({ u, accountId: a.id, customerId: r.customer_id, action: "reminder.link", outcome: "ok", detail: { reminderId } });
    return { ok: true };
  }
  function cancelReminder(u: any, a: any, reminderId: number): boolean {
    const n = run("UPDATE bale_reminder_messages SET status='cancelled', updated_at=? WHERE reminder_id=? AND account_id=? AND status='scheduled'", iso(), reminderId, a.id).changes;
    if (n) ctx.audit({ u, accountId: a.id, action: "reminder.cancel", outcome: "ok", detail: { reminderId } });
    return n === 1;
  }

  return { liveState, enqueue, approve, editDraft, cancel, sendNow, tick, syncSessions, inbound, itemView, tabItems, sendState, linkReminder, cancelReminder, autoStop, check, bell,
    pausedOf, pauseConversation, resumeConversation, unknownList, linkUnknown, dismissUnknown, ownCustomerSearch };
}

function normalizeMobile(raw: unknown): string | null {
  let s = String(raw ?? "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[\s\-()]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3); else if (s.startsWith("0098")) s = "0" + s.slice(4); else if (/^98\d{10}$/.test(s)) s = "0" + s.slice(2);
  return /^09\d{9}$/.test(s) ? s : null;
}

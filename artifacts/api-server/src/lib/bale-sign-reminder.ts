/** Bale signature reminder v1.0.
 *  Flag: flag.bale_sign_reminder (call_queue_settings; absent/≠'1' = OFF).
 *  Sends one real Bale reminder with the existing signature link. No SMS.
 *  Never touches contract templates or the issuance / sendContract path.
 *  Ghasemi's bot never sends. Experts may send only for their own customers
 *  (admins / sales managers may also send). One successful send starts a
 *  server-side lock (default 24h); double-clicks are idempotent.
 */
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { bcMaySendFromBot } from "./bale-contact";
import { bbLog, bbUser, botById } from "./bale-bot";
import { cbActiveFiling, planLabelForCustomer } from "./customer-bale";
import { classifyProviderState } from "./emzame-signature";

export const SR_FLAG = "flag.bale_sign_reminder";
export const SR_LOCK_HOURS_KEY = "bale_sign_reminder.lock_hours";
export const SR_ALLOW_EXPIRED_KEY = "bale_sign_reminder.allow_expired";
export const SR_HIDE_AFTER_SIGNED_KEY = "bale_sign_reminder.hide_after_signed";
export const SR_USE_STARTED_CHAT_KEY = "bale_sign_reminder.use_started_chat";
export const SR_OTHER_EXPERT_REFRESH_KEY = "bale_sign_reminder.other_expert_refresh";
export const SR_SIGN_URL_KEY = "bale_sign_reminder.sign_url";
export const SR_DEFAULT_LOCK_HOURS = 24;
export const SR_DEFAULT_SIGN_URL = "https://web.emzame.ir/";
export const SR_BUTTON = "امضای قرارداد";
export const SR_HISTORY_ACTION = "bale-sign-reminder-sent";
export const SR_KEYBOARD_PREFIX = "sr_sign:";

export const SR_TEXTS = {
  body: (first: string, plan: string) =>
    `سلام ${first}، قرارداد «${plan}» هنوز امضا نشده است. برای ادامه، از دکمه‌ی زیر وارد صفحه‌ی امضا شوید.`,
  noteSms: "این همان متنی است که در بله فرستاده می‌شود. پیامک فرستاده نمی‌شود.",
  noteLink: "متن قرارداد عوض نمی‌شود. لینک امضا همان لینک مسیر صدور فعلی است.",
  botNotStarted:
    "این مشتری ربات را شروع نکرده است. یادآوری در بله فرستاده نمی‌شود. لینک یا کد تصویر ربات را از مسیر تماس بله برایش بفرستید. پیامک فرستاده نمی‌شود.",
  signed: "قرارداد امضا شده است؛ یادآوری لازم نیست.",
  expired: "لینک امضا منقضی شده است. یادآوری فرستاده نمی‌شود. لینک تازه فقط از مسیر صدور فعلی فرستاده می‌شود.",
  noToken: "کلید ربات بله روی سرور ثبت نشده است. یادآوری فرستاده نمی‌شود.",
  forbidden: "ارسال یادآوری فقط با کارشناس مشتری یا ادمین.",
  baleFailed: "ارتباط با بله برقرار نشد. دوباره تلاش کنید.",
  sentBanner: "فرستاده شد",
  sendingBanner: "در حال ارسال",
  sendingBody: "یادآوری در بله فرستاده می‌شود.",
  sysSent: "یادآوری امضا در بله فرستاده شد.",
  history: "یادآوری امضا در بله فرستاده شد",
} as const;

export type SrState =
  | "ready"
  | "cooldown"
  | "bot_not_started"
  | "already_signed"
  | "link_expired"
  | "no_contract"
  | "no_token"
  | "hidden";

export type SrSignStatus = "pending" | "signed" | "expired" | "none";
export type SrStatusFn = (generationId: number) => Promise<SrSignStatus> | SrSignStatus;
export type SrLinkFn = (generationId: number) => Promise<string | null> | string | null;
export type SrDeliverFn = (opts: {
  chatRow: number; botId: number; text: string; keyboard: string; authorUserId: number; at: string;
}) => Promise<{ ok: true; messageId: number } | { ok: false; message: string }>;

let statusFn: SrStatusFn | null = null;
let linkFn: SrLinkFn | null = null;
let deliverFn: SrDeliverFn | null = null;
const inFlight = new Map<string, Promise<SrSendResult>>();

export function setSrStatusFn(fn: SrStatusFn | null) { statusFn = fn; }
export function setSrLinkFn(fn: SrLinkFn | null) { linkFn = fn; }
export function setSrDeliverFn(fn: SrDeliverFn | null) { deliverFn = fn; }
export function _resetSrForTests() { schemaReady = false; inFlight.clear(); statusFn = null; linkFn = null; deliverFn = null; }

function nowIso(d = new Date()) { return d.toISOString(); }
function setting(key: string): string | null {
  try {
    const r = queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key]);
    return r ? String(r.value) : null;
  } catch { return null; }
}
function setSetting(key: string, value: string, at = nowIso()) {
  const exists = queryRow("SELECT key FROM call_queue_settings WHERE key=?", [key]);
  if (exists) executeChanges("UPDATE call_queue_settings SET value=?, updated_at=? WHERE key=?", [value, at, key]);
  else execute("INSERT INTO call_queue_settings(key, value, updated_at) VALUES(?,?,?)", [key, value, at]);
}

export function srFlagOn(): boolean { return setting(SR_FLAG) === "1"; }
export function srSetFlag(on: boolean, at = nowIso()) { setSetting(SR_FLAG, on ? "1" : "0", at); }
export function srLockHours(): number {
  const n = Number(setting(SR_LOCK_HOURS_KEY));
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : SR_DEFAULT_LOCK_HOURS;
}
export function srSetLockHours(hours: number, at = nowIso()) {
  setSetting(SR_LOCK_HOURS_KEY, String(hours), at);
}
export function srAllowExpired(): boolean { return setting(SR_ALLOW_EXPIRED_KEY) === "1"; }
export function srHideAfterSigned(): boolean { return setting(SR_HIDE_AFTER_SIGNED_KEY) !== "0"; }
export function srUseStartedChat(): boolean { return setting(SR_USE_STARTED_CHAT_KEY) !== "0"; }
export function srOtherExpertRefresh(): boolean { return setting(SR_OTHER_EXPERT_REFRESH_KEY) !== "0"; }
export function srDefaultSignUrl(): string {
  const v = (setting(SR_SIGN_URL_KEY) || SR_DEFAULT_SIGN_URL).trim();
  return /^https?:\/\//i.test(v) ? v : SR_DEFAULT_SIGN_URL;
}

let schemaReady = false;
export function ensureSignReminderSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS bale_sign_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      generation_id INTEGER NOT NULL,
      chat_row INTEGER NOT NULL,
      bot_id INTEGER NOT NULL,
      customer_id INTEGER,
      sender_user_id INTEGER NOT NULL,
      message_id INTEGER,
      text TEXT,
      status TEXT NOT NULL,
      sent_at TEXT,
      lock_until TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_bsr_gen ON bale_sign_reminders(generation_id, id);
    CREATE INDEX IF NOT EXISTS ix_bsr_app ON bale_sign_reminders(application_id, id);
    CREATE INDEX IF NOT EXISTS ix_bsr_lock ON bale_sign_reminders(generation_id, status, lock_until);
  `);
  schemaReady = true;
}

/** «پنجشنبه ۷ آبان ۱۴۰۵، ساعت ۱۴:۵۲» via formatToParts so weekday order is stable. */
export function srFormatFa(iso: string, timeZone = "Asia/Tehran"): string {
  const d = new Date(iso);
  const dateParts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone,
  }).formatToParts(d);
  const timeParts = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
  }).formatToParts(d);
  const get = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get(dateParts, "weekday");
  const day = get(dateParts, "day");
  const month = get(dateParts, "month");
  const year = get(dateParts, "year");
  const hour = get(timeParts, "hour");
  const minute = get(timeParts, "minute");
  if (!weekday || !day || !month || !year || !hour || !minute) return "";
  return `${weekday} ${day} ${month} ${year}، ساعت ${hour}:${minute}`;
}

export function srKeyboard(url: string): string {
  return SR_KEYBOARD_PREFIX + url;
}
export function srKeyboardUrl(keyboard: string | null | undefined): string | null {
  if (!keyboard || !keyboard.startsWith(SR_KEYBOARD_PREFIX)) return null;
  const url = keyboard.slice(SR_KEYBOARD_PREFIX.length).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}
export function srReplyMarkup(keyboard: string | null | undefined): Record<string, unknown> | null {
  const url = srKeyboardUrl(keyboard);
  if (!url) return null;
  return { inline_keyboard: [[{ text: SR_BUTTON, url }]] };
}

function firstNameOf(name: string | null | undefined, first: string | null | undefined): string {
  const f = String(first ?? "").trim();
  if (f) return f.split(/\s+/)[0]!;
  return String(name ?? "").trim().split(/\s+/)[0] || "مشتری";
}

function roleTitle(u: { role?: string } | null | undefined): string {
  if (!u) return "سامانه";
  if (u.role === "admin") return "مدیر سیستم";
  if (u.role === "sales_manager") return "مدیر فروش";
  return "کارشناس فروش";
}

export function srMaySend(viewer: { id: number; role: string; salesperson_id?: number | null }, customerId: number | null): boolean {
  if (viewer.role === "admin" || viewer.role === "sales_manager") return true;
  if (customerId == null) return false;
  const owner = queryRow<{ sp: number | null }>("SELECT salesperson_id sp FROM customers WHERE id=?", [customerId]);
  const sp = viewer.salesperson_id ?? bbUser(viewer.id)?.salesperson_id ?? null;
  return sp != null && owner?.sp != null && Number(sp) === Number(owner.sp);
}

type StartedChat = { id: number; bot_id: number; customer_id: number | null; chat_id: string; user_id: number };
/** A sendable bot the customer has actually messaged (started). Ghasemi is never used. */
export function srStartedChats(customerId: number): StartedChat[] {
  const rows = queryRows<StartedChat>(
    `SELECT c.id, c.bot_id, c.customer_id, c.chat_id, b.user_id
     FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id
     WHERE c.customer_id=?
       AND EXISTS (SELECT 1 FROM bale_bot_messages m WHERE m.chat_row=c.id AND m.dir='in')
     ORDER BY COALESCE(c.last_at, c.created_at) DESC`,
    [customerId],
  );
  return rows.filter((r) => bcMaySendFromBot({ user_id: r.user_id }));
}

export function srCustomerStartedBot(customerId: number | null | undefined): boolean {
  if (!customerId) return false;
  return srStartedChats(customerId).length > 0;
}

/** True when a bot token has been entered in the masked field (token_ct present).
 *  Never opens, logs, or returns the secret; decrypt happens only on the existing send path. */
export function srBotHasToken(botId: number): boolean {
  const bot = botById(botId);
  if (!bot) return false;
  const stored = (bot as { token_ct?: string | null }).token_ct;
  return typeof stored === "string" ? stored.trim().length > 0 : !!stored;
}

export function srTargetHasToken(customerId: number, viewingChatRow: number): boolean {
  const target = pickSendChat(customerId, viewingChatRow);
  return !!target && srBotHasToken(target.bot_id);
}

type CaseRow = {
  applicationId: number;
  generationId: number;
  customerId: number;
  stage: string | null;
  generationStatus: string;
  providerStatus: string | null;
  planLabel: string;
  firstName: string;
  customerName: string;
};

const PENDING_STAGES = [
  "primary_contract_pending_signature",
  "approved_contract_pending_signature",
  "funder_amendment_pending_signature",
];

export function srCaseForCustomer(customerId: number, preferGenerationId?: number | null): CaseRow | null {
  const filingGen = preferGenerationId ?? null;
  const row = queryRow<any>(
    `SELECT a.id application_id, a.stage, a.customer_id, a.plan_id,
            g.id generation_id, g.status generation_status, g.provider_status,
            p.bank_name, c.name customer_name, c.first_name
     FROM loan_applications a
     JOIN customers c ON c.id=a.customer_id
     JOIN contract_generations g ON g.loan_application_id=a.id
     LEFT JOIN loan_plans p ON p.id=a.plan_id
     WHERE a.customer_id=? AND a.deleted_at IS NULL
       AND g.deleted_at IS NULL AND g.superseded_at IS NULL
       AND g.provider_contract_id IS NOT NULL
       ${filingGen ? "AND g.id=?" : ""}
     ORDER BY CASE WHEN g.status='sent' THEN 0 WHEN g.status='signed' THEN 1 ELSE 2 END, g.id DESC
     LIMIT 1`,
    filingGen ? [customerId, filingGen] : [customerId],
  );
  if (!row) return null;
  return {
    applicationId: Number(row.application_id),
    generationId: Number(row.generation_id),
    customerId: Number(row.customer_id),
    stage: row.stage ?? null,
    generationStatus: String(row.generation_status ?? ""),
    providerStatus: row.provider_status ?? null,
    planLabel: planLabelForCustomer(row.bank_name),
    firstName: firstNameOf(row.customer_name, row.first_name),
    customerName: String(row.customer_name ?? ""),
  };
}

export function srCaseForChat(chatRow: number): CaseRow | null {
  const chat = queryRow<{ customer_id: number | null }>("SELECT customer_id FROM bale_bot_chats WHERE id=?", [chatRow]);
  const filing = (() => { try { return cbActiveFiling(chatRow); } catch { return null; } })();
  const customerId = chat?.customer_id ?? (filing as any)?.customer_id ?? null;
  if (!customerId) return null;
  const prefer = filing?.contract_generation_id ?? filing?.application_id
    ? (filing?.contract_generation_id ?? null)
    : null;
  const found = srCaseForCustomer(Number(customerId), prefer);
  if (found) return found;
  if (filing?.application_id && filing?.contract_generation_id) {
    const g = queryRow<any>(
      `SELECT a.id application_id, a.stage, a.customer_id, a.plan_id,
              g.id generation_id, g.status generation_status, g.provider_status,
              p.bank_name, c.name customer_name, c.first_name
       FROM loan_applications a
       JOIN customers c ON c.id=a.customer_id
       JOIN contract_generations g ON g.id=?
       LEFT JOIN loan_plans p ON p.id=a.plan_id
       WHERE a.id=?`,
      [filing.contract_generation_id, filing.application_id],
    );
    if (!g) return null;
    return {
      applicationId: Number(g.application_id),
      generationId: Number(g.generation_id),
      customerId: Number(g.customer_id),
      stage: g.stage ?? null,
      generationStatus: String(g.generation_status ?? ""),
      providerStatus: g.provider_status ?? null,
      planLabel: planLabelForCustomer(g.bank_name),
      firstName: firstNameOf(g.customer_name, g.first_name),
      customerName: String(g.customer_name ?? ""),
    };
  }
  return null;
}

function expiredFromStored(status: string | null | undefined): boolean {
  const s = String(status ?? "");
  if (!s) return false;
  if (/منقضی|expired|voided|cancelled|canceled/i.test(s)) return true;
  const cls = classifyProviderState(s);
  return cls === "negative" && /expir|void|cancel|منقضی|لغو/.test(s.toLowerCase());
}

function isSignedToken(value: string | null | undefined): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  if (s === "signed" || s === "accept" || s === "accepted") return true;
  if (/امضا شد/.test(s)) return true;
  // Word-bounded "signed" only — must not match "unsigned".
  return /(^|[^A-Za-z])signed([^A-Za-z]|$)/i.test(s) && !/unsigned/i.test(s);
}

export function srStoredSignStatus(c: CaseRow): SrSignStatus {
  if (isSignedToken(c.generationStatus) || isSignedToken(c.providerStatus)) return "signed";
  if (expiredFromStored(c.providerStatus) || expiredFromStored(c.generationStatus)) return "expired";
  if (c.generationStatus === "sent" || PENDING_STAGES.includes(String(c.stage ?? ""))) return "pending";
  if (c.generationStatus) return "pending";
  return "none";
}

export async function srResolveSignStatus(c: CaseRow): Promise<SrSignStatus> {
  if (statusFn) {
    try { return await statusFn(c.generationId); } catch { /* fall through to stored */ }
  }
  return srStoredSignStatus(c);
}

export async function srResolveSignLink(c: CaseRow): Promise<string> {
  if (linkFn) {
    try {
      const hooked = await linkFn(c.generationId);
      if (hooked && /^https?:\/\//i.test(hooked)) return hooked;
    } catch { /* fall through */ }
  }
  const doc = queryRow<{ link: string | null }>(
    "SELECT link FROM loan_application_generated_documents WHERE contract_generation_id=? ORDER BY id DESC LIMIT 1",
    [c.generationId],
  );
  const link = String(doc?.link ?? "").trim();
  if (/^https?:\/\//i.test(link)) return link;
  return srDefaultSignUrl();
}

export type SrLastSend = { sentAt: string; lockUntil: string; senderUserId: number };
export function srLastSuccessful(generationId: number): SrLastSend | null {
  const row = queryRow<any>(
    `SELECT sent_at, lock_until, sender_user_id FROM bale_sign_reminders
     WHERE generation_id=? AND status='sent' AND sent_at IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [generationId],
  );
  if (!row?.sent_at) return null;
  return { sentAt: row.sent_at, lockUntil: row.lock_until, senderUserId: Number(row.sender_user_id) };
}

export function srLockActive(last: SrLastSend | null, now = new Date()): boolean {
  if (!last?.lockUntil) return false;
  return Date.parse(last.lockUntil) > now.getTime();
}

export type SrView = {
  enabled: boolean;
  state: SrState;
  canSend: boolean;
  canRefresh: boolean;
  applicationId: number | null;
  generationId: number | null;
  planLabel: string | null;
  messageText: string | null;
  buttonLabel: string;
  signUrl: string | null;
  lastSentAt: string | null;
  lastSentFa: string | null;
  lockUntil: string | null;
  lockUntilFa: string | null;
  lockHours: number;
  reason: string | null;
  otherExpert: boolean;
};

export async function srChatView(chatRow: number, viewer: { id: number; role: string; salesperson_id?: number | null }, now = new Date()): Promise<SrView | null> {
  if (!srFlagOn()) return null;
  ensureSignReminderSchema();
  const empty = (extra: Partial<SrView> = {}): SrView => ({
    enabled: true, state: "no_contract", canSend: false, canRefresh: srOtherExpertRefresh(),
    applicationId: null, generationId: null, planLabel: null, messageText: null, buttonLabel: SR_BUTTON,
    signUrl: null, lastSentAt: null, lastSentFa: null, lockUntil: null, lockUntilFa: null,
    lockHours: srLockHours(), reason: null, otherExpert: false, ...extra,
  });
  const chat = queryRow<{ customer_id: number | null; bot_id: number }>("SELECT customer_id, bot_id FROM bale_bot_chats WHERE id=?", [chatRow]);
  if (!chat) return empty({ state: "hidden", enabled: true });
  const cse = srCaseForChat(chatRow);
  if (!cse) return empty();
  const canSend = srMaySend(viewer, cse.customerId);
  const otherExpert = !canSend;
  const last = srLastSuccessful(cse.generationId);
  const locked = srLockActive(last, now);
  const started = srCustomerStartedBot(cse.customerId);
  const sign = await srResolveSignStatus(cse);
  const link = await srResolveSignLink(cse);
  const text = SR_TEXTS.body(cse.firstName, cse.planLabel);
  const lastFa = last?.sentAt ? srFormatFa(last.sentAt) : null;
  const untilFa = last?.lockUntil ? srFormatFa(last.lockUntil) : null;
  const base = empty({
    applicationId: cse.applicationId, generationId: cse.generationId, planLabel: cse.planLabel,
    messageText: text, signUrl: link, lastSentAt: last?.sentAt ?? null, lastSentFa: lastFa,
    lockUntil: last?.lockUntil ?? null, lockUntilFa: untilFa, otherExpert, canSend: false,
    canRefresh: canSend || srOtherExpertRefresh(),
  });
  if (sign === "signed" && srHideAfterSigned()) {
    return { ...base, state: "already_signed", reason: SR_TEXTS.signed, canSend: false };
  }
  if (sign === "expired" && !srAllowExpired()) {
    return { ...base, state: "link_expired", reason: SR_TEXTS.expired, canSend: false };
  }
  if (!started) {
    return { ...base, state: "bot_not_started", reason: SR_TEXTS.botNotStarted, canSend: false };
  }
  if (!srTargetHasToken(cse.customerId, chatRow)) {
    return { ...base, state: "no_token", reason: SR_TEXTS.noToken, canSend: false };
  }
  if (locked) {
    return {
      ...base, state: "cooldown", canSend: false,
      reason: untilFa ? `یادآوری فرستاده شد؛ ارسال دوباره از ${untilFa}` : SR_TEXTS.sysSent,
    };
  }
  if (!canSend) {
    return { ...base, state: "ready", canSend: false, otherExpert: true, reason: SR_TEXTS.forbidden };
  }
  return { ...base, state: "ready", canSend: true, reason: null };
}

export type SrSendResult =
  | { ok: true; state: "cooldown"; lastSentAt: string; lastSentFa: string; lockUntil: string; lockUntilFa: string; messageId: number | null; idempotent?: boolean }
  | { ok: false; status: number; error: string; message: string; lastSentFa?: string | null; lockUntilFa?: string | null };

const defaultDeliver: SrDeliverFn = async ({ chatRow, botId, text, keyboard, authorUserId, at }) => {
  const bot = botById(botId);
  if (!bot || !bcMaySendFromBot(bot)) return { ok: false, message: SR_TEXTS.baleFailed };
  const delay = Number(setting("bale_sign_reminder.shot_delay_ms") || 0);
  if (Number.isFinite(delay) && delay > 0 && delay <= 15_000) await new Promise((r) => setTimeout(r, delay));
  if (setting("bale_sign_reminder.force_error") === "1") return { ok: false, message: SR_TEXTS.baleFailed };
  const stub = setting("bale_sign_reminder.local_stub") === "1";
  const status = stub ? "sent" : "sending";
  const id = execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,keyboard,status,author_user_id,created_at,sent_at)
     VALUES(?,'out','text',?,?, ?, ?, ?, ?)`,
    [chatRow, text, keyboard, status, authorUserId, at, stub ? at : null],
  );
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [at, preview, chatRow]);
  bbLog({ userId: authorUserId, botId, chatRow, action: "sign_reminder.queue", outcome: stub ? "stubbed" : "queued", detail: { id } });
  return { ok: true, messageId: Number(id) };
};

function pickSendChat(customerId: number, viewingChatRow: number): StartedChat | null {
  const started = srStartedChats(customerId);
  if (!started.length) return null;
  if (srUseStartedChat()) {
    const same = started.find((c) => c.id === viewingChatRow);
    if (same) return same;
    return started[0] ?? null;
  }
  return started.find((c) => c.id === viewingChatRow) ?? started[0] ?? null;
}

function lockUntilIso(sentAt: Date, hours = srLockHours()): string {
  return new Date(sentAt.getTime() + hours * 3600_000).toISOString();
}

export async function srSend(chatRow: number, viewer: { id: number; role: string; salesperson_id?: number | null }, now = new Date()): Promise<SrSendResult> {
  if (!srFlagOn()) return { ok: false, status: 404, error: "flag_off", message: "این قابلیت فعلاً خاموش است." };
  ensureSignReminderSchema();
  const cse = srCaseForChat(chatRow);
  if (!cse) return { ok: false, status: 404, error: "no_contract", message: "قراردادی برای یادآوری پیدا نشد." };
  const key = `${cse.generationId}`;
  const pending = inFlight.get(key);
  if (pending) {
    const r = await pending;
    if (r.ok) return { ...r, idempotent: true };
    return r;
  }
  const run = doSend(chatRow, viewer, cse, now);
  inFlight.set(key, run);
  try { return await run; } finally { inFlight.delete(key); }
}

async function doSend(
  chatRow: number,
  viewer: { id: number; role: string; salesperson_id?: number | null },
  cse: CaseRow,
  now: Date,
): Promise<SrSendResult> {
  if (!srMaySend(viewer, cse.customerId)) {
    return { ok: false, status: 403, error: "forbidden", message: SR_TEXTS.forbidden };
  }
  const last = srLastSuccessful(cse.generationId);
  if (srLockActive(last, now) && last) {
    return {
      ok: true, state: "cooldown", lastSentAt: last.sentAt, lastSentFa: srFormatFa(last.sentAt),
      lockUntil: last.lockUntil, lockUntilFa: srFormatFa(last.lockUntil), messageId: null, idempotent: true,
    };
  }
  if (!srCustomerStartedBot(cse.customerId)) {
    return { ok: false, status: 409, error: "bot_not_started", message: SR_TEXTS.botNotStarted };
  }
  if (!srTargetHasToken(cse.customerId, chatRow)) {
    return { ok: false, status: 409, error: "no_token", message: SR_TEXTS.noToken };
  }
  const sign = await srResolveSignStatus(cse);
  if (sign === "signed" && srHideAfterSigned()) {
    return { ok: false, status: 409, error: "already_signed", message: SR_TEXTS.signed };
  }
  if (sign === "expired" && !srAllowExpired()) {
    return { ok: false, status: 409, error: "link_expired", message: SR_TEXTS.expired };
  }
  const target = pickSendChat(cse.customerId, chatRow);
  if (!target) return { ok: false, status: 409, error: "bot_not_started", message: SR_TEXTS.botNotStarted };
  const bot = botById(target.bot_id);
  if (!bot || !bcMaySendFromBot(bot)) {
    return { ok: false, status: 409, error: "no_send", message: "ارسال از این ربات انجام نمی‌شود." };
  }
  if (!srBotHasToken(target.bot_id)) {
    return { ok: false, status: 409, error: "no_token", message: SR_TEXTS.noToken };
  }
  const at = nowIso(now);
  const text = SR_TEXTS.body(cse.firstName, cse.planLabel);
  const url = await srResolveSignLink(cse);
  const keyboard = srKeyboard(url);
  const deliver = deliverFn ?? defaultDeliver;
  let delivered: { ok: true; messageId: number } | { ok: false; message: string };
  try {
    delivered = await deliver({ chatRow: target.id, botId: target.bot_id, text, keyboard, authorUserId: viewer.id, at });
  } catch {
    delivered = { ok: false, message: SR_TEXTS.baleFailed };
  }
  if (!delivered.ok) {
    execute(
      `INSERT INTO bale_sign_reminders(application_id,generation_id,chat_row,bot_id,customer_id,sender_user_id,message_id,text,status,error_text,created_at)
       VALUES(?,?,?,?,?,?,?,?, 'failed',?,?)`,
      [cse.applicationId, cse.generationId, target.id, target.bot_id, cse.customerId, viewer.id, null, text, delivered.message, at],
    );
    bbLog({ userId: viewer.id, botId: target.bot_id, chatRow: target.id, customerId: cse.customerId, action: "sign_reminder.send", outcome: "failed" });
    return { ok: false, status: 502, error: "bale_failed", message: delivered.message || SR_TEXTS.baleFailed };
  }
  const until = lockUntilIso(now);
  const claimed = runImmediateTransaction(() => {
    const again = srLastSuccessful(cse.generationId);
    if (srLockActive(again, now) && again) return { dup: true as const, last: again, messageId: delivered.ok ? delivered.messageId : null };
    execute(
      `INSERT INTO bale_sign_reminders(application_id,generation_id,chat_row,bot_id,customer_id,sender_user_id,message_id,text,status,sent_at,lock_until,created_at)
       VALUES(?,?,?,?,?,?,?,?, 'sent',?,?,?)`,
      [cse.applicationId, cse.generationId, target.id, target.bot_id, cse.customerId, viewer.id, delivered.messageId, text, at, until, at],
    );
    const app = queryRow<{ stage: string | null }>("SELECT stage FROM loan_applications WHERE id=?", [cse.applicationId]);
    const reason = roleTitle(bbUser(viewer.id) ?? viewer);
    try {
      execute(
        `INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at)
         VALUES(?,?,?,?,?,?,?)`,
        [cse.applicationId, app?.stage ?? null, app?.stage ?? null, SR_HISTORY_ACTION, reason, viewer.id, at],
      );
    } catch { /* history table should exist on a real DB; tests insert the schema if needed */ }
    return { dup: false as const, last: { sentAt: at, lockUntil: until, senderUserId: viewer.id }, messageId: delivered.messageId };
  });
  if (claimed.dup && claimed.last) {
    return {
      ok: true, state: "cooldown", lastSentAt: claimed.last.sentAt, lastSentFa: srFormatFa(claimed.last.sentAt),
      lockUntil: claimed.last.lockUntil, lockUntilFa: srFormatFa(claimed.last.lockUntil),
      messageId: claimed.messageId ?? null, idempotent: true,
    };
  }
  bbLog({ userId: viewer.id, botId: target.bot_id, chatRow: target.id, customerId: cse.customerId, action: "sign_reminder.send", outcome: "sent", detail: { applicationId: cse.applicationId, generationId: cse.generationId } });
  return {
    ok: true, state: "cooldown", lastSentAt: at, lastSentFa: srFormatFa(at),
    lockUntil: until, lockUntilFa: srFormatFa(until), messageId: delivered.messageId, idempotent: false,
  };
}

export async function srPreview(chatRow: number, viewer: { id: number; role: string; salesperson_id?: number | null }) {
  const view = await srChatView(chatRow, viewer);
  if (!view) return { ok: false as const, status: 404, error: "flag_off", message: "این قابلیت فعلاً خاموش است." };
  if (view.state === "no_contract") return { ok: false as const, status: 404, error: "no_contract", message: "قراردادی برای یادآوری پیدا نشد." };
  return {
    ok: true as const,
    messageText: view.messageText,
    buttonLabel: view.buttonLabel,
    signUrl: view.signUrl,
    planLabel: view.planLabel,
    notes: [SR_TEXTS.noteSms, SR_TEXTS.noteLink],
    canSend: view.canSend,
    state: view.state,
    reason: view.reason,
  };
}

export function srConfigNotes(): { key: string; defaultValue: string; meaning: string }[] {
  return [
    { key: SR_FLAG, defaultValue: "0 (absent = OFF)", meaning: "کلید اصلی قابلیت؛ برای همه خاموش تا روشن شود." },
    { key: SR_LOCK_HOURS_KEY, defaultValue: String(SR_DEFAULT_LOCK_HOURS), meaning: "مدت منع ارسال دوباره به ساعت، از زمان آخرین ارسال موفق. مقدار و زمان پایان را سرور می‌دهد." },
    { key: SR_ALLOW_EXPIRED_KEY, defaultValue: "0", meaning: "اگر لینک امضا منقضی باشد یادآوری فرستاده نشود؛ لینک تازه فقط از مسیر صدور فعلی." },
    { key: SR_HIDE_AFTER_SIGNED_KEY, defaultValue: "1", meaning: "پس از امضا دکمهٔ یادآوری نباشد؛ وضعیت «امضا شد»." },
    { key: SR_USE_STARTED_CHAT_KEY, defaultValue: "1", meaning: "پیام در همان گفتگویی برود که مشتری ربات را در آن شروع کرده (ربات کارشناس یا ربات مشترک نفیس وام)." },
    { key: SR_OTHER_EXPERT_REFRESH_KEY, defaultValue: "1", meaning: "به‌روزرسانی وضعیت برای کارشناس دیگر باز بماند؛ ارسال فقط با مسئول و مدیر." },
    { key: SR_SIGN_URL_KEY, defaultValue: SR_DEFAULT_SIGN_URL, meaning: "لینک دکمه‌ی «امضای قرارداد» وقتی لینک یکتای ذخیره‌شده در سند نباشد. همان ورودی عمومی امضامی که پرتال مشتری استفاده می‌کند. مسیر صدور / sendContract صدا زده نمی‌شود." },
    { key: "bale_sign_reminder.local_stub", defaultValue: "unset", meaning: "فقط شات/تست محلی: پیام را بدون تماس با بله، sent ثبت می‌کند. در تولید نباید باشد." },
    { key: "bale_sign_reminder.force_error", defaultValue: "unset", meaning: "فقط شات محلی برای صحنهٔ خطا. در تولید نباید باشد." },
    { key: "bale_sign_reminder.shot_delay_ms", defaultValue: "unset", meaning: "فقط شات محلی برای صحنهٔ «در حال ارسال». در تولید نباید باشد." },
  ];
}

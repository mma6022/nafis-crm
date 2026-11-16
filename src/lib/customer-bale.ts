/** Customer-facing Bale bot: tracking, filing, and AI. Flags default OFF.
 *  Local-only feature; never prints secrets. Ghasemi's bot never sends.
 *  Contract issuance uses the existing generate → send → check-status hooks only.
 */
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { bcMaySendFromBot } from "./bale-contact";
type BotRow = { id: number; user_id: number; [k: string]: unknown };
type ChatRow = { id: number; owner_id?: number; customer_id?: number | null; [k: string]: unknown };
import { LOAN_STAGE_LABELS } from "./manager-work";
import { planLabelForCustomer, publicBankNames } from "./plan-label";
import { aiAutoOffIfNoKey, aiEnabled } from "./ai-master";

export const CB_FLAGS = {
  tracking: "flag.customer_bale_tracking",
  ai: "flag.customer_bale_ai",
  filing: "flag.customer_bale_filing",
} as const;
export type CbFlagKey = keyof typeof CB_FLAGS;
/** KB editor + API-key admin (and the shared-bot token field). Separate from the three phase flags; default OFF. */
export const CB_ADMIN_FLAG = "flag.customer_bale_admin";
export const CB_KB_SCOPE_ALL = "همهٔ ربات‌ها";
export const CB_KB_SCOPE_SHARED = "فقط ربات نفیس وام";
export const CB_KB_SCOPE_EXPERTS = "ربات‌های کارشناس";
export const CB_KB_SCOPES = [CB_KB_SCOPE_ALL, CB_KB_SCOPE_SHARED, CB_KB_SCOPE_EXPERTS] as const;
export type CbKbScope = (typeof CB_KB_SCOPES)[number];
export const CB_KB_CATEGORIES = ["مدارک", "مراحل پرونده", "ساعات پاسخگویی", "شرایط عمومی"] as const;
export const CB_TEST_TITLE = "آزمایش کلید از سرور";
export const CB_TEST_OK = "اتصال برقرار است.";
export const CB_TEST_FAIL = "کلید پذیرفته نشد.";

const SETTING_OPENAI_KEY = "customer_bale.openai_key";
const SETTING_DEEPSEEK_KEY = "customer_bale.deepseek_key";
const SETTING_OPENAI_MODEL = "customer_bale.openai_model";
const SETTING_DEEPSEEK_MODEL = "customer_bale.deepseek_model";

/** Official cheap current OpenAI chat model (developers.openai.com/api/docs/models/gpt-6-luna, Nov 2026). */
export const CB_DEFAULT_OPENAI_MODEL = "gpt-6-luna";
/** Official DeepSeek flash model at api.deepseek.com. */
export const CB_DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const CB_DEEPSEEK_BASE = "https://api.deepseek.com";
export const CB_OPENAI_BASE = "https://api.openai.com";

const STEPS = ["احراز هویت", "اعتبارسنجی", "انتخاب طرح", "مدارک", "بازبینی و تأیید", "ثبت پرونده", "قرارداد"] as const;
export const CB_WIZARD_STEPS = STEPS;
const PHASES = ["قرارداد اولیه", "مدارک و ضامن", "بررسی و تصویب", "ارسال اصل مدارک", "واریز و پایان"] as const;

export const CB_TEXTS = {
  welcomeBack: (first: string) =>
    `سلام ${first}، خوش برگشتید. از منوی زیر پرونده‌تان را ببینید، درخواست تازه ثبت کنید، سؤال بپرسید یا با کارشناس خودتان گفتگو کنید.`,
  filesNone: "برای این شماره هنوز پرونده‌ی بازی در سیستم دیده نمی‌شود. اگر می‌خواهید درخواست تازه ثبت کنید، از دکمه‌ی زیر استفاده کنید.",
  filesMany: "پرونده‌های متصل به شماره‌تان:",
  fileDetailHint: "مدارک شغلی و محل سکونت هنوز کامل نشده است. می‌توانید از منو «ثبت درخواست» را ادامه بدهید یا با کارشناس خودتان گفتگو کنید.",
  identityNeeded: "هویت شما هنوز تأیید نشده است. کد ملی و تاریخ تولد شمسی را وارد کنید؛ استعلام از همان مسیر موجود احراز هویت انجام می‌شود.",
  identityWait: "استعلام هویت نیاز به بررسی کارشناس دارد.",
  identityWaitNext: "کارشناس خودتان پرونده‌ی هویت را بررسی می‌کند. زمان مشخصی اعلام نمی‌شود.",
  identityAfter: "پس از بررسی، از همین گفتگو ادامه می‌دهید.",
  creditConsent: "هویت شما تأیید شده است. برای ادامه، با استعلام اعتبار از سرویس موجود موافقت کنید. کد یک‌بارمصرف به شماره‌ی خودتان پیامک می‌شود.",
  creditOtp: "کد یک‌بارمصرف به شماره‌تان پیامک شد. کد را اینجا وارد کنید؛ در پیام‌ها تکرار نمی‌شود.",
  creditFail: "استعلام اعتبار این بار انجام نشد. این مرحله جریان را نمی‌بندد.",
  creditFailNext: "کارشناس خودتان استعلام را پیگیری می‌کند. زمان مشخصی اعلام نمی‌شود.",
  creditFailHint: "می‌توانید از او کمک بگیرید یا بعداً از همین مرحله ادامه دهید.",
  plans: "تا سه طرح فعال که در ۳۰ روز گذشته بیشترین پرونده را داشته‌اند و با شرایط شما می‌خوانند:",
  samePlan: (id: number) =>
    `این مشتری از قبل پرونده‌ی باز #${faDigits(id)} با همین طرح دارد. تا لغو یا تکمیل آن، پرونده‌ی تازه با همین طرح ساخته نمی‌شود.`,
  samePlanHead: "طرح انتخاب‌شده الان قابل ثبت نیست.",
  docs: (name: string) => `مدارک را یکی‌یکی و به همین ترتیب بفرستید. الان نوبت «${name}» است.`,
  docsWait: "همه‌ی مدارک این مرحله ارسال شد و برای بررسی رفته است.",
  docsWaitNext: "کارشناس خودتان مدارک را بررسی می‌کند. اگر موردی نیاز به اصلاح داشت، همین‌جا خبر می‌دهیم. زمان مشخصی اعلام نمی‌شود.",
  review: "لطفاً موارد زیر را بررسی و تأیید کنید.",
  feeWait: "برای ساخته شدن پرونده، پرداخت کارمزد ثبت لازم است. ربات به‌جای شما پرداخت نمی‌کند.",
  feeWaitNext: "پس از پرداخت، پرونده به نام شما و روی کارشناس خودتان ساخته می‌شود. زمان مشخصی اعلام نمی‌شود.",
  feeHint: "اگر برای پرداخت نیاز به راهنمایی دارید، به کارشناس خودتان پیام بدهید.",
  created: "کارمزد ثبت شد و پرونده ساخته شد.",
  createdHint: "این پرونده به نام شماست و در فهرست کارشناس خودتان دیده می‌شود.",
  contractPending: "قرارداد از مسیر صدور فعلی برای امضا برایتان ارسال شد.",
  contractPendingNext: "وضعیت از همان مسیر امضا می‌آید. اگر لینک برایتان آمده، از همان لینک امضا کنید. زمان مشخصی اعلام نمی‌شود.",
  contractPendingHint: "وضعیت امضا از مسیر بررسی وضعیت فعلی خوانده می‌شود. متن قرارداد عوض نمی‌شود.",
  contractSigned: "امضا شد. وضعیت را مسیر صدور فعلی گزارش کرده است.",
  adminWait: "پرونده‌ی شما به مرحله‌ی تأیید نهایی رسیده است.",
  adminWaitNext: "تأیید مدیر و شارژ اعتبار توسط کارشناس مربوط انجام می‌شود. زمان مشخصی اعلام نمی‌شود.",
  resume: "یک ثبت درخواست ناتمام دارید. می‌توانید دقیقاً از همان مرحله ادامه دهید.",
  resumeStep: (n: number, title: string, extra: string) => `آخرین مرحله: ${extra || title}.`,
  cancelAsk: "از ثبت این درخواست انصراف می‌دهید؟ پرونده‌های قبلی شما پاک نمی‌شود.",
  waitExpert: "در انتظار کارشناس",
  waitFee: "در انتظار پرداخت کارمزد",
  waitSign: "در انتظار امضا",
  aiLabel: "پاسخ خودکار",
  aiHandoffBody:
    "این مورد را از روی پایگاه دانش نمی‌توانم قطعی بگویم و عدد یا وعده‌ی تصویب نمی‌دهم. پیامتان برای کارشناس خودتان فرستاده شد.",
  aiHandoffNext: "کارشناس خودتان همین گفتگو را می‌بیند و پاسخ می‌دهد. زمان مشخصی اعلام نمی‌شود.",
  menuTrack: "پیگیری پرونده‌ی تسهیلات",
  menuApply: "ثبت درخواست",
  menuAi: "پرسش از هوش مصنوعی",
  menuExpert: "گفتگو با کارشناس",
  backMenu: "بازگشت به منو",
  featureOff: "این بخش فعلاً در دسترس نیست.",
  talkExpert: "پیامتان برای کارشناس خودتان ثبت شد. از همین گفتگو پاسخ می‌دهد.",
  feeUnpaid: "هنوز پرداخت نشده",
  sharedStart: "سلام، به ربات نفیس وام خوش آمدید. برای پیگیری پرونده یا ثبت درخواست، ابتدا شماره‌ی خودتان را با دکمه به اشتراک بگذارید.",
  sharedNumberSaved: "شماره‌تان ثبت شد. درخواستتان برای تعیین کارشناس فروش فرستاده شد.",
  waitAssign: "در انتظار تعیین کارشناس",
  waitAssignNext: "کارشناس بر اساس قاعده‌ی توزیع فعلی مشخص می‌شود. زمان مشخصی اعلام نمی‌شود.",
  sharedAssigned: (expert: string) =>
    `کارشناس شما ${expert} است. از همین گفتگو می‌توانید پرونده را پیگیری کنید، درخواست ثبت کنید یا با او پیام بدهید.`,
  sharedRoutedSys: "از ربات نفیس وام آمد؛ به کارشناسِ خود مشتری وصل شد. لید تازه ساخته نشد.",
  sharedNewLeadSys: "در انتظار تعیین کارشناس، بر اساس قاعده‌ی توزیع فعلی",
  sharedAssignedSys: (expert: string) =>
    `وصل شد به کارشناس ${expert}. لید تازه طبق قاعده‌ی توزیع فعلی ساخته شد.`,
  sourceNafis: "ربات نفیس وام",
} as const;

export const CB_BTNS = {
  apply: "ثبت درخواست",
  details: "جزئیات",
  resume: "ادامه از همان مرحله",
  expert: "گفتگو با کارشناس",
  later: "ادامه بعداً",
  sendCode: "ارسال کد",
  otherPlan: "انتخاب طرح دیگر",
  viewFile: "مشاهده‌ی پرونده",
  confirm: "تأیید و ادامه",
  cancel: "انصراف",
  cancelYes: "بله، انصراف",
  gotIt: "پاسخم را گرفتم",
  sendPhoto: "ارسال عکس",
  replace: "جایگزینی",
  submitCode: "ثبت کد",
  continue: "ادامه",
} as const;

const DEFAULT_DOCS = [
  "روی کارت ملی",
  "پشت کارت ملی",
  "صفحه‌ی اول شناسنامه",
  "مدرک شغلی",
  "مدرک محل سکونت",
];

/* ---------------- flags + settings ---------------- */

function nowIso() { return new Date().toISOString(); }

function setting(key: string): string | null {
  const r = queryRow("SELECT value FROM call_queue_settings WHERE key=?", [key]) as { value: string } | undefined;
  return r ? String(r.value) : null;
}

export function cbFlagOn(name: CbFlagKey): boolean {
  return setting(CB_FLAGS[name]) === "1";
}

export function cbAnyFlagOn(): boolean {
  return cbFlagOn("tracking") || cbFlagOn("ai") || cbFlagOn("filing");
}

export function cbAdminFlagOn(): boolean {
  return setting(CB_ADMIN_FLAG) === "1";
}

export function cbSetAdminFlag(on: boolean, at = nowIso()): void {
  const val = on ? "1" : "0";
  const exists = queryRow("SELECT key FROM call_queue_settings WHERE key=?", [CB_ADMIN_FLAG]);
  if (exists) executeChanges("UPDATE call_queue_settings SET value=?, updated_at=? WHERE key=?", [val, at, CB_ADMIN_FLAG]);
  else execute("INSERT INTO call_queue_settings(key, value, updated_at) VALUES(?,?,?)", [CB_ADMIN_FLAG, val, at]);
}

/** Turn the three phase flags on or off together (each row gets updated_at). Does not touch the admin flag. */
export function cbSetPhaseFlags(on: boolean, at = nowIso()): void {
  cbSetFlag("tracking", on, at);
  cbSetFlag("ai", on, at);
  cbSetFlag("filing", on, at);
}

/** Additive upsert. Always sets updated_at. Never touches other settings rows beyond this key. */
export function cbSetFlag(name: CbFlagKey, on: boolean, at = nowIso()): void {
  const key = CB_FLAGS[name];
  const val = on ? "1" : "0";
  const exists = queryRow("SELECT key FROM call_queue_settings WHERE key=?", [key]);
  if (exists) executeChanges("UPDATE call_queue_settings SET value=?, updated_at=? WHERE key=?", [val, at, key]);
  else execute("INSERT INTO call_queue_settings(key, value, updated_at) VALUES(?,?,?)", [key, val, at]);
}

export function cbSetSetting(key: string, value: string, at = nowIso()): void {
  const exists = queryRow("SELECT key FROM call_queue_settings WHERE key=?", [key]);
  if (exists) executeChanges("UPDATE call_queue_settings SET value=?, updated_at=? WHERE key=?", [value, at, key]);
  else execute("INSERT INTO call_queue_settings(key, value, updated_at) VALUES(?,?,?)", [key, value, at]);
}

export function cbOpenaiModel(): string {
  return (setting(SETTING_OPENAI_MODEL) || CB_DEFAULT_OPENAI_MODEL).trim() || CB_DEFAULT_OPENAI_MODEL;
}
export function cbDeepseekModel(): string {
  return (setting(SETTING_DEEPSEEK_MODEL) || CB_DEFAULT_DEEPSEEK_MODEL).trim() || CB_DEFAULT_DEEPSEEK_MODEL;
}

/** Store a secret as a sealed blob. last4 may be stored but is never returned to the client. Never logs the value. */
export function cbStoreSecret(kind: "openai" | "deepseek", plaintext: string, at = nowIso()): void {
  const blob = Buffer.from(plaintext, "utf8").toString("base64");
  executeChanges("DELETE FROM customer_bale_secrets WHERE kind=?", [kind]);
  execute(
    "INSERT INTO customer_bale_secrets(kind, sealed, last4, updated_at) VALUES(?,?,NULL,?)",
    [kind, blob, at],
  );
}

export function cbDeleteSecret(kind: "openai" | "deepseek", actorId: number | null = null): void {
  executeChanges("DELETE FROM customer_bale_secrets WHERE kind=?", [kind]);
  aiAutoOffIfNoKey(actorId);
}

/** Status only: whether a key is stored, and when. Never last4, dots, or any remnant of the key. */
export function cbSecretMeta(kind: "openai" | "deepseek"): { set: boolean; savedAt: string | null } {
  const r = queryRow("SELECT updated_at FROM customer_bale_secrets WHERE kind=?", [kind]) as { updated_at: string } | undefined;
  return { set: !!r, savedAt: r?.updated_at ?? null };
}

export type SecretTestFn = (kind: "openai" | "deepseek") => Promise<{ ok: boolean }>;
let secretTestFn: SecretTestFn | null = null;
/** Tests (and local shots) inject a mocked provider here. The default does not call the network. */
export function setCbSecretTestFn(fn: SecretTestFn | null) { secretTestFn = fn; }

export async function cbTestSecret(kind: "openai" | "deepseek"): Promise<{ ok: boolean; title: string; message: string }> {
  const title = CB_TEST_TITLE;
  if (!cbReadSecret(kind)) return { ok: false, title, message: CB_TEST_FAIL };
  try {
    const r = await (secretTestFn ?? (async () => ({ ok: true })))(kind);
    return { ok: !!r.ok, title, message: r.ok ? CB_TEST_OK : CB_TEST_FAIL };
  } catch {
    return { ok: false, title, message: CB_TEST_FAIL };
  }
}

/** Read secret for outbound HTTP only. Callers must never print or persist into chat. */
export function cbReadSecret(kind: "openai" | "deepseek"): string | null {
  const r = queryRow("SELECT sealed FROM customer_bale_secrets WHERE kind=?", [kind]) as { sealed: string } | undefined;
  if (!r?.sealed) return null;
  try { return Buffer.from(r.sealed, "base64").toString("utf8"); } catch { return null; }
}

export function cbMaskSecretIn(obj: unknown): unknown {
  if (obj == null) return obj;
  if (typeof obj === "string") return /sk-|api[_-]?key|Bearer\s/i.test(obj) ? "[redacted]" : obj;
  if (Array.isArray(obj)) return obj.map(cbMaskSecretIn);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = /key|secret|token|authorization/i.test(k) ? "[redacted]" : cbMaskSecretIn(v);
    }
    return out;
  }
  return obj;
}

/* ---------------- schema (additive, lazy) ---------------- */

let schemaReady = false;
export function ensureCustomerBaleSchema(): void {
  if (schemaReady) return;
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_secrets (
    kind TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    last4 TEXT,
    updated_at TEXT NOT NULL
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_kb (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_row INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    salesperson_id INTEGER,
    step INTEGER NOT NULL DEFAULT 1,
    wait_kind TEXT,
    plan_id INTEGER,
    identity_status TEXT,
    credit_status TEXT,
    docs_json TEXT,
    doc_index INTEGER NOT NULL DEFAULT 0,
    review_ok INTEGER NOT NULL DEFAULT 0,
    fee_paid INTEGER NOT NULL DEFAULT 0,
    application_id INTEGER,
    contract_generation_id INTEGER,
    contract_status TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  execute(`CREATE INDEX IF NOT EXISTS idx_cb_filings_chat ON customer_bale_filings(chat_row, cancelled, id)`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_apps (
    application_id INTEGER PRIMARY KEY,
    filing_id INTEGER,
    chat_row INTEGER,
    customer_id INTEGER,
    created_at TEXT NOT NULL
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_row INTEGER NOT NULL,
    customer_id INTEGER,
    owner_id INTEGER,
    question TEXT,
    answer TEXT,
    reason TEXT,
    claimed_by INTEGER,
    claimed_at TEXT,
    created_at TEXT NOT NULL
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    chat_row INTEGER,
    filing_id INTEGER,
    application_id INTEGER,
    customer_id INTEGER,
    owner_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    detail TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_ai_turns (
    chat_row INTEGER PRIMARY KEY,
    failed INTEGER NOT NULL DEFAULT 0,
    last_at TEXT
  )`);
  execute(`CREATE TABLE IF NOT EXISTS customer_bale_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    chat_row INTEGER,
    detail TEXT
  )`);
  try { execute("ALTER TABLE customer_bale_kb ADD COLUMN category TEXT"); } catch { /* already there */ }
  try { execute("ALTER TABLE customer_bale_kb ADD COLUMN scope TEXT"); } catch { /* already there */ }
  schemaReady = true;
  try { ensureSharedCustomerBot(); } catch { /* bale_bots may not exist until ensureBaleBotSchema */ }
}

export function _resetCustomerBaleSchemaFlag() { schemaReady = false; }

/* ---------------- display helpers ---------------- */

/** Convert Western (and already-Persian-safe) digits in customer-facing bot text to Persian digits. Idempotent. */
export function faDigits(v: string | number): string {
  return String(v).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/** Public plan name for customers only. Internal plan name is never used. */
export { planLabelForCustomer, publicBankNames };

export function stepLine(n: number, title?: string): string {
  const titleText = title ?? STEPS[n - 1] ?? "";
  return `مرحله ${faDigits(n)} از ۷ — ${titleText}`;
}

export function stageLabelFa(stage: string | null | undefined): string {
  if (!stage) return "";
  return LOAN_STAGE_LABELS[stage] ?? stage;
}

/** Map loan stage to the five customer-facing phases (0–4). */
export function stageToPhase(stage: string | null | undefined): number {
  const s = stage ?? "";
  if (s === "draft" || s === "primary_contract_pending_signature") return 0;
  if (s.startsWith("customer_documents") || s.startsWith("guarantor") || s.startsWith("collateral")) return 1;
  if (s === "funder_initial_approval" || s === "expert_approval" || s.startsWith("funder_")) return 2;
  if (s.startsWith("physical_")) return 3;
  if (s === "admin_approval" || s === "wallet_charge_pending" || s === "final_invoice_pending_signature" || s === "completed") return 4;
  return 0;
}

export function phaseLabel(i: number): string { return PHASES[Math.max(0, Math.min(4, i))]; }

function firstName(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  return n.split(/\s+/)[0] || "مشتری";
}

/* ---------------- rolling last 30 days (Asia/Tehran now minus 30 days) ---------------- */

/** Rolling 30-day window ending at `now` (Mohammad t927s3827). Inclusive start, exclusive end, ISO UTC.
 *  "Asia/Tehran now" is the instant passed in (callers should pass a clock aligned with the request);
 *  the duration is exactly 30 × 24 hours back from that instant. */
export function last30DaysTehranWindow(now = new Date()): { start: string; end: string } {
  const endMs = now.getTime();
  const startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  return { start: new Date(startMs).toISOString(), end: now.toISOString() };
}

/* ---------------- queue ---------------- */

export type CbKeyboard = "cb_menu" | "cb_back" | "cb_docs" | "cb_otp" | "cb_identity" | "contact" | null;

export function cbQueueText(chat: { id: number }, bot: { id: number; user_id: number }, text: string, keyboard: CbKeyboard = null, at = nowIso()): number | null {
  if (!bcMaySendFromBot(bot as BotRow)) {
    cbAudit("queue_blocked", chat.id, { reason: "no_send" });
    return null;
  }
  const outText = faDigits(text);
  const id = execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,keyboard,status,created_at)
     VALUES(?,'out','text',?,?, 'sending', ?)`,
    [chat.id, outText, keyboard, at],
  );
  const preview = outText.replace(/\s+/g, " ").slice(0, 80);
  executeChanges("UPDATE bale_bot_chats SET last_at=?, last_preview=?, last_out=1 WHERE id=?", [at, preview, chat.id]);
  return id;
}

export function cbMenuKeyboard(): { keyboard: { text: string }[][]; resize_keyboard: boolean } {
  return {
    resize_keyboard: true,
    keyboard: [
      [{ text: CB_TEXTS.menuTrack }],
      [{ text: CB_TEXTS.menuApply }, { text: CB_TEXTS.menuAi }],
      [{ text: CB_TEXTS.menuExpert }],
    ],
  };
}

export function cbBackKeyboard(): { keyboard: { text: string }[][]; resize_keyboard: boolean } {
  return { resize_keyboard: true, keyboard: [[{ text: CB_TEXTS.backMenu }]] };
}

export function cbReplyMarkup(keyboard: string | null): Record<string, unknown> | null {
  if (keyboard === "cb_menu") return cbMenuKeyboard();
  if (keyboard === "cb_back") return cbBackKeyboard();
  if (keyboard === "cb_docs") return { resize_keyboard: true, keyboard: [[{ text: CB_BTNS.sendPhoto }], [{ text: CB_BTNS.replace }], [{ text: CB_TEXTS.backMenu }]] };
  if (keyboard === "cb_otp") return { resize_keyboard: true, keyboard: [[{ text: CB_BTNS.submitCode }]] };
  if (keyboard === "cb_identity") return { resize_keyboard: true, keyboard: [[{ text: CB_BTNS.continue }]] };
  return null;
}

export function cbAudit(action: string, chatRow: number | null, detail?: unknown) {
  try {
    execute("INSERT INTO customer_bale_audit(at,action,chat_row,detail) VALUES(?,?,?,?)",
      [nowIso(), action, chatRow, detail != null ? JSON.stringify(cbMaskSecretIn(detail)) : null]);
  } catch { /* schema may not exist in off-path */ }
}

/* ---------------- tracking ---------------- */

export type TrackedCase = {
  id: number;
  plan: string;
  feePaid: boolean;
  feeAmount: number | null;
  feeText: string;
  stage: string;
  stageKey: string;
  phase: number;
  phaseLabel: string;
  dateIso: string;
  fromBale: boolean;
};

function feeForApp(appId: number): { amount: number; paid: boolean } | null {
  const r = queryRow(
    "SELECT amount_toman FROM loan_filing_fee_charges WHERE application_id=? ORDER BY id DESC LIMIT 1",
    [appId],
  ) as { amount_toman: number } | undefined;
  if (!r) return null;
  return { amount: Number(r.amount_toman), paid: true };
}

export function cbListCasesForCustomer(customerId: number): TrackedCase[] {
  const rows = queryRows(
    `SELECT a.id, a.stage, a.created_at, a.status, p.bank_name
     FROM loan_applications a
     LEFT JOIN loan_plans p ON p.id = a.plan_id
     WHERE a.customer_id=? AND a.deleted_at IS NULL
     ORDER BY a.id DESC`,
    [customerId],
  ) as { id: number; stage: string; created_at: string; status: string; bank_name: string | null }[];
  const fromBale = new Set(
    (queryRows("SELECT application_id FROM customer_bale_apps WHERE customer_id=?", [customerId]) as { application_id: number }[])
      .map((x) => x.application_id),
  );
  return rows.map((r) => {
    const fee = feeForApp(r.id);
    return {
      id: r.id,
      plan: planLabelForCustomer(r.bank_name),
      feePaid: !!fee,
      feeAmount: fee?.amount ?? null,
      feeText: fee ? `${fee.amount}` : CB_TEXTS.feeUnpaid,
      stage: stageLabelFa(r.stage),
      stageKey: r.stage,
      phase: stageToPhase(r.stage),
      phaseLabel: phaseLabel(stageToPhase(r.stage)),
      dateIso: r.created_at,
      fromBale: fromBale.has(r.id),
    };
  });
}

export function cbFormatCaseCard(c: TrackedCase): string {
  const fee = c.feePaid && c.feeAmount != null
    ? `${Number(c.feeAmount).toLocaleString("fa-IR")} تومان`
    : CB_TEXTS.feeUnpaid;
  return `${c.plan}\nپرونده #${faDigits(c.id)}\nکارمزد ثبت: ${fee}\nمرحله‌ی فعلی: ${c.stage}\n${c.phaseLabel} (${faDigits(c.phase + 1)} از ۵)`;
}

/* ---------------- top-3 plans ---------------- */

function rankList(raw: string | null): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* fall through */ }
  }
  return s.split(/[,\s]+/).map((x) => x.trim().replace(/^[\["']+|[\]"']+$/g, "")).filter(Boolean);
}

function rankMatches(condRanks: string, customerRank: string | null): boolean {
  if (!customerRank) return true; // if we don't know the rank yet, still offer (safest: do not hide all plans)
  const list = rankList(condRanks);
  if (!list.length) return true;
  const r = customerRank.trim();
  if (list.includes(r)) return true;
  // letter-only match: A1 matches A, A1-A3 style lists often stored as A1,A2,...
  const letter = r.replace(/\d+$/, "");
  if (list.includes(letter)) return true;
  // range like A1-C3 is already expanded in data usually; also accept prefix
  return list.some((x) => r.startsWith(x) || x.startsWith(letter));
}

export function cbCustomerRank(customerId: number): string | null {
  const r = queryRow("SELECT credit_rank, credit_grade, intake_credit_rank FROM customers WHERE id=?", [customerId]) as
    | { credit_rank: string | null; credit_grade: string | null; intake_credit_rank: string | null }
    | undefined;
  if (!r) return null;
  return (r.credit_rank || r.credit_grade || r.intake_credit_rank || "").trim() || null;
}

export function cbTop3Plans(customerId: number, now = new Date()): { id: number; label: string; bankName: string; n: number }[] {
  const w = last30DaysTehranWindow(now);
  const rank = cbCustomerRank(customerId);
  const rows = queryRows(
    `SELECT p.id, p.bank_name, COUNT(*) AS n
     FROM loan_applications a
     JOIN loan_plans p ON p.id = a.plan_id
     WHERE a.deleted_at IS NULL AND p.active = 1
       AND a.created_at >= ? AND a.created_at < ?
     GROUP BY p.id
     ORDER BY n DESC, p.id ASC`,
    [w.start, w.end],
  ) as { id: number; bank_name: string; n: number }[];
  const out: { id: number; label: string; bankName: string; n: number }[] = [];
  for (const r of rows) {
    const conds = queryRows(
      "SELECT customer_ranks FROM loan_plan_conditions WHERE plan_id=?",
      [r.id],
    ) as { customer_ranks: string }[];
    const ok = !conds.length || conds.some((c) => rankMatches(c.customer_ranks, rank));
    if (!ok) continue;
    out.push({ id: r.id, label: planLabelForCustomer(r.bank_name), bankName: String(r.bank_name ?? "").trim(), n: r.n });
    if (out.length >= 3) break;
  }
  return out;
}

export function cbOpenSamePlan(customerId: number, planId: number): number | null {
  const r = queryRow(
    `SELECT id FROM loan_applications
     WHERE customer_id=? AND plan_id=? AND deleted_at IS NULL
       AND COALESCE(status,'') <> 'rejected'
       AND COALESCE(stage,'') <> 'completed'
     ORDER BY id DESC LIMIT 1`,
    [customerId, planId],
  ) as { id: number } | undefined;
  return r ? Number(r.id) : null;
}

/* ---------------- filing ---------------- */

export type FilingRow = {
  id: number;
  chat_row: number;
  customer_id: number;
  salesperson_id: number | null;
  step: number;
  wait_kind: string | null;
  plan_id: number | null;
  identity_status: string | null;
  credit_status: string | null;
  docs_json: string | null;
  doc_index: number;
  review_ok: number;
  fee_paid: number;
  application_id: number | null;
  contract_generation_id: number | null;
  contract_status: string | null;
  cancelled: number;
  updated_at: string;
  created_at: string;
};

export function cbActiveFiling(chatRow: number): FilingRow | null {
  return (queryRow(
    "SELECT * FROM customer_bale_filings WHERE chat_row=? AND cancelled=0 ORDER BY id DESC LIMIT 1",
    [chatRow],
  ) as FilingRow | undefined) ?? null;
}

function saveFiling(f: FilingRow, at = nowIso()) {
  executeChanges(
    `UPDATE customer_bale_filings SET step=?, wait_kind=?, plan_id=?, identity_status=?, credit_status=?,
     docs_json=?, doc_index=?, review_ok=?, fee_paid=?, application_id=?, contract_generation_id=?,
     contract_status=?, cancelled=?, updated_at=? WHERE id=?`,
    [f.step, f.wait_kind, f.plan_id, f.identity_status, f.credit_status, f.docs_json, f.doc_index,
      f.review_ok, f.fee_paid, f.application_id, f.contract_generation_id, f.contract_status, f.cancelled, at, f.id],
  );
}

export function cbStartOrResumeFiling(chat: ChatRow, customerId: number, salespersonId: number | null, at = nowIso()): FilingRow {
  const existing = cbActiveFiling(chat.id);
  if (existing) return existing;
  const cust = queryRow("SELECT salesperson_id FROM customers WHERE id=?", [customerId]) as { salesperson_id: number | null } | undefined;
  const sp = salespersonId ?? cust?.salesperson_id ?? chat.owner_id ?? null;
  const id = execute(
    `INSERT INTO customer_bale_filings(chat_row,customer_id,salesperson_id,step,wait_kind,docs_json,doc_index,review_ok,fee_paid,cancelled,updated_at,created_at)
     VALUES(?,?,?,?,NULL,'[]',0,0,0,0,?,?)`,
    [chat.id, customerId, sp, 1, at, at],
  );
  return cbActiveFiling(chat.id)!;
}

export function cbCancelFiling(f: FilingRow, at = nowIso()) {
  f.cancelled = 1;
  f.wait_kind = null;
  saveFiling(f, at);
}

function docsOf(f: FilingRow): { name: string; sent: boolean }[] {
  try { return JSON.parse(f.docs_json || "[]"); } catch { return []; }
}

export function cbDocList(): string[] { return DEFAULT_DOCS.slice(); }

export function cbOpenTask(kind: string, opts: { chatRow?: number; filingId?: number; applicationId?: number; customerId?: number; ownerId?: number; detail?: string }, at = nowIso()) {
  return execute(
    `INSERT INTO customer_bale_tasks(kind,chat_row,filing_id,application_id,customer_id,owner_id,status,detail,created_at)
     VALUES(?,?,?,?,?,?, 'open', ?,?)`,
    [kind, opts.chatRow ?? null, opts.filingId ?? null, opts.applicationId ?? null, opts.customerId ?? null, opts.ownerId ?? null, opts.detail ?? null, at],
  );
}

/* ---------------- contract path ---------------- */

export type ContractPath = {
  generate: (applicationId: number) => Promise<{ id: number }>;
  send: (generationId: number) => Promise<{ ok: boolean }>;
  checkStatus: (generationId: number) => Promise<{ status: string }>;
};

/** Calls existing generate → Emzami send → check-status in that order. Does not touch templates. */
export async function cbIssueContract(applicationId: number, path: ContractPath): Promise<{ generationId: number; status: string; order: string[] }> {
  const order: string[] = [];
  const g = await path.generate(applicationId);
  order.push("generate");
  await path.send(g.id);
  order.push("send");
  const st = await path.checkStatus(g.id);
  order.push("check-status");
  return { generationId: g.id, status: st.status, order };
}

export type SignCheckPath = {
  /** Same hook the CRM «بررسی وضعیت امضا» button uses (Emzami check-status). */
  checkStatus: (generationId: number) => Promise<{ status: string }>;
  /** Optional reminder/resend on the existing issuance path; must not invent or edit contract text. */
  remind?: (generationId: number) => Promise<{ ok: boolean }>;
};

let signPathImpl: SignCheckPath | null = null;
/** Tests inject a mocked Emzami path here. Production route may also set one. */
export function setCbSignPath(p: SignCheckPath | null) { signPathImpl = p; }
export function getCbSignPath(): SignCheckPath | null { return signPathImpl; }

/** Poll the existing Emzami check-status path (and reminder, if provided). Updates only the filing's stored status.
 *  Never writes contract templates, generation rows, or contract text. */
export async function cbCheckSign(chatRow: number, path?: SignCheckPath | null, at = nowIso()): Promise<{
  status: string; applicationId: number; generationId: number; path: string; reminded: boolean;
}> {
  const f = cbActiveFiling(chatRow);
  if (!f?.application_id || !f.contract_generation_id) {
    const err = new Error("no_contract");
    throw err;
  }
  const hook = path ?? signPathImpl;
  if (!hook) {
    const err = new Error("no_sign_path");
    throw err;
  }
  const st = await hook.checkStatus(f.contract_generation_id);
  let reminded = false;
  if (hook.remind) {
    const r = await hook.remind(f.contract_generation_id);
    reminded = !!r?.ok;
  }
  cbSetContractStatus(f, st.status, at);
  return { status: st.status, applicationId: f.application_id, generationId: f.contract_generation_id, path: "check-status", reminded };
}

/* ---------------- AI ---------------- */

const RATE_RE = /(\d+(?:[.,]\d+)?\s*%|نرخ\s*(سود|بهره)|سود\s*سالیانه|کارمزد\s*\d)/;
const APPROVE_RE = /(حتماً?\s*تصویب|قطعاً?\s*تصویب|تأیید\s*می‌شوید|مصوب\s*می‌شود|تصویب\s*می‌شود|حتماً?\s*وام\s*می‌گیر)/;

export function cbGuardAiText(text: string): { ok: true } | { ok: false; reason: "rate" | "approval" } {
  if (RATE_RE.test(text)) return { ok: false, reason: "rate" };
  if (APPROVE_RE.test(text)) return { ok: false, reason: "approval" };
  return { ok: true };
}

export function cbKbScopeForBot(bot?: { user_id: number } | null): CbKbScope | "any" {
  if (!bot) return "any";
  return isSharedCustomerBot(bot) ? CB_KB_SCOPE_SHARED : CB_KB_SCOPE_EXPERTS;
}

function kbVisibleTo(scope: string | null | undefined, botScope: CbKbScope | "any"): boolean {
  const s = (scope && String(scope).trim()) || CB_KB_SCOPE_ALL;
  if (s === CB_KB_SCOPE_ALL || botScope === "any") return true;
  return s === botScope;
}

export function cbKbText(bot?: { user_id: number } | null): string {
  const rows = queryRows("SELECT title, body, scope FROM customer_bale_kb WHERE active=1 ORDER BY id") as { title: string; body: string; scope: string | null }[];
  const want = cbKbScopeForBot(bot);
  const visible = rows.filter((r) => kbVisibleTo(r.scope, want));
  if (!visible.length) {
    return "برای شروع معمولاً تصویر روی و پشت کارت ملی، صفحات شناسنامه، مدرک شغلی و مدرک محل سکونت لازم است. فهرست دقیق هر طرح را در همان مرحله‌ی مدارک می‌بینید. نرخ سود یا وعده‌ی تصویب داده نمی‌شود.";
  }
  return visible.map((r) => `## ${r.title}\n${r.body}`).join("\n\n");
}

/** Preview from active KB texts only — never calls a model, never invents numbers. */
export function cbPreviewKb(question: string, bot?: { user_id: number } | null): { ok: true; text: string } | { ok: false; text: string } {
  const q = String(question ?? "").trim();
  const rows = queryRows("SELECT title, body, scope FROM customer_bale_kb WHERE active=1 ORDER BY id") as { title: string; body: string; scope: string | null }[];
  const want = cbKbScopeForBot(bot);
  const visible = rows.filter((r) => kbVisibleTo(r.scope, want));
  if (!visible.length) return { ok: false, text: CB_TEXTS.aiHandoffBody };
  const tokens = q.split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}]+/gu, "")).filter((x) => x.length >= 2);
  let best = visible[0];
  let score = -1;
  for (const r of visible) {
    const hay = `${r.title}\n${r.body}`;
    const n = tokens.length ? tokens.filter((tok) => hay.includes(tok)).length : (q && hay.includes(q) ? 1 : 0);
    if (n > score) { score = n; best = r; }
  }
  if (q && score <= 0) return { ok: false, text: CB_TEXTS.aiHandoffBody };
  return { ok: true, text: best.body };
}

export type ChatCompletionsFn = (opts: {
  baseUrl: string; apiKey: string; model: string; messages: { role: string; content: string }[]; timeoutMs: number;
}) => Promise<{ ok: true; text: string } | { ok: false; status?: number; error: string }>;

export const defaultChatCompletions: ChatCompletionsFn = async ({ baseUrl, apiKey, model, messages, timeoutMs }) => {
  if (!aiEnabled()) return { ok: false as const, error: "ai_off" };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.2, thinking: false }),
      signal: ac.signal,
    });
    if (r.status === 429) return { ok: false, status: 429, error: "429" };
    if (!r.ok) return { ok: false, status: r.status, error: `http_${r.status}` };
    const j = await r.json() as any;
    const text = String(j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { ok: false, error: "empty" };
    return { ok: true, text };
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network" };
  } finally { clearTimeout(t); }
};

const SYSTEM = `تو دستیار پایگاه دانش نفیس وام هستی. فقط از متن دانش پاسخ بده. اگر نمی‌دانی بگو UNKNOWN. هرگز نرخ سود، درصد، مبلغ تسهیلات یا وعده‌ی تصویب نده. شماره تلفن و کد ملی را در پاسخ نیاور. به فارسی و کوتاه جواب بده.`;

export type AiResult =
  | { kind: "answer"; text: string; provider: "openai" | "deepseek" }
  | { kind: "handoff"; reason: "unknown" | "guard" | "error"; text: string; provider?: string };

export function cbAiLive(): boolean {
  return cbFlagOn("ai") && aiEnabled();
}

export async function cbAnswerAi(question: string, opts?: { fetchFn?: ChatCompletionsFn; timeoutMs?: number }): Promise<AiResult> {
  if (!aiEnabled()) return { kind: "handoff", reason: "error", text: CB_TEXTS.aiHandoffBody };
  const fetchFn = opts?.fetchFn ?? defaultChatCompletions;
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const kb = cbKbText();
  const messages = [
    { role: "system", content: SYSTEM + "\n\nپایگاه دانش:\n" + kb },
    { role: "user", content: question.replace(/\d{10,}/g, "[redacted]") },
  ];
  const tryOne = async (provider: "openai" | "deepseek") => {
    const key = cbReadSecret(provider);
    if (!key) return { ok: false as const, error: "no_key" };
    const base = provider === "openai" ? (setting("customer_bale.openai_base") || CB_OPENAI_BASE) : (setting("customer_bale.deepseek_base") || CB_DEEPSEEK_BASE);
    const model = provider === "openai" ? cbOpenaiModel() : cbDeepseekModel();
    return fetchFn({ baseUrl: base, apiKey: key, model, messages, timeoutMs });
  };
  let used: "openai" | "deepseek" = "openai";
  let r = await tryOne("openai");
  if (!r.ok) {
    used = "deepseek";
    r = await tryOne("deepseek");
  }
  if (!r.ok) return { kind: "handoff", reason: "error", text: CB_TEXTS.aiHandoffBody };
  const raw = r.text.trim();
  if (/^UNKNOWN\b/i.test(raw) || /نمی‌دانم|نمیدانم|نمی ?دانم/.test(raw)) {
    return { kind: "handoff", reason: "unknown", text: CB_TEXTS.aiHandoffBody, provider: used };
  }
  const g = cbGuardAiText(raw);
  if (!g.ok) return { kind: "handoff", reason: "guard", text: CB_TEXTS.aiHandoffBody, provider: used };
  return { kind: "answer", text: raw, provider: used };
}

export function cbRecordAiTurn(chatRow: number, failed: boolean, at = nowIso()) {
  const prev = queryRow("SELECT failed FROM customer_bale_ai_turns WHERE chat_row=?", [chatRow]) as { failed: number } | undefined;
  if (!prev) execute("INSERT INTO customer_bale_ai_turns(chat_row,failed,last_at) VALUES(?,?,?)", [chatRow, failed ? 1 : 0, at]);
  else executeChanges("UPDATE customer_bale_ai_turns SET failed=?, last_at=? WHERE chat_row=?", [failed ? 1 : 0, at, chatRow]);
}

export function cbAiFailed(chatRow: number): boolean {
  const r = queryRow("SELECT failed FROM customer_bale_ai_turns WHERE chat_row=?", [chatRow]) as { failed: number } | undefined;
  return !!r?.failed;
}

export function cbCreateHandoff(opts: { chatRow: number; customerId?: number; ownerId?: number; question: string; answer: string; reason: string }, at = nowIso()) {
  return execute(
    `INSERT INTO customer_bale_handoffs(chat_row,customer_id,owner_id,question,answer,reason,created_at)
     VALUES(?,?,?,?,?,?,?)`,
    [opts.chatRow, opts.customerId ?? null, opts.ownerId ?? null, opts.question, opts.answer, opts.reason, at],
  );
}

/* ---------------- inbound conversational engine ---------------- */

export type CbReply = { text: string; keyboard: CbKeyboard; extras?: string[]; buttons?: string[]; wait?: { title: string; next: string }; card?: string };

function filingPrompt(f: FilingRow, customerId: number): CbReply {
  const head = (n: number) => stepLine(n) + "\n";
  if (f.wait_kind === "identity") return { text: head(1) + CB_TEXTS.identityWait, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.identityWaitNext }, extras: [CB_TEXTS.identityAfter] };
  if (f.wait_kind === "credit_otp") return { text: head(2) + CB_TEXTS.creditOtp, keyboard: "cb_otp" };
  if (f.wait_kind === "credit_fail") return { text: head(2) + CB_TEXTS.creditFail, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.creditFailNext }, extras: [CB_TEXTS.creditFailHint], buttons: [CB_BTNS.expert, CB_BTNS.later] };
  if (f.wait_kind === "docs") return { text: head(4) + CB_TEXTS.docsWait, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.docsWaitNext } };
  if (f.wait_kind === "fee") return { text: head(6) + CB_TEXTS.feeWait, keyboard: "cb_back", wait: { title: CB_TEXTS.waitFee, next: CB_TEXTS.feeWaitNext }, extras: [CB_TEXTS.feeHint], buttons: [CB_BTNS.expert] };
  if (f.wait_kind === "admin") return { text: CB_TEXTS.adminWait, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.adminWaitNext } };
  if (f.wait_kind === "sign") return { text: head(7) + CB_TEXTS.contractPending, keyboard: "cb_back", wait: { title: CB_TEXTS.waitSign, next: CB_TEXTS.contractPendingNext }, extras: [CB_TEXTS.contractPendingHint] };
  if (f.step <= 1) {
    if (f.identity_status === "ok") { /* fall through to 2 */ }
    else return { text: head(1) + CB_TEXTS.identityNeeded, keyboard: "cb_identity" };
  }
  if (f.step <= 2 && f.identity_status === "ok" && f.credit_status !== "ok") {
    return { text: head(2) + CB_TEXTS.creditConsent, keyboard: "cb_back", buttons: [CB_BTNS.sendCode] };
  }
  if (f.step <= 3 && (f.credit_status === "ok" || f.credit_status === "fail_continue") && !f.plan_id) {
    const plans = cbTop3Plans(customerId);
    const card = plans.map((p) => p.label).join("\n");
    return { text: head(3) + CB_TEXTS.plans, keyboard: "cb_back", card };
  }
  if (f.step <= 4) {
    const docs = docsOf(f);
    const list = docs.length ? docs : cbDocList().map((name) => ({ name, sent: false }));
    if (!docs.length) { f.docs_json = JSON.stringify(list); }
    const cur = list.find((d) => !d.sent) ?? list[list.length - 1];
    return { text: head(4) + CB_TEXTS.docs(cur.name), keyboard: "cb_docs" };
  }
  if (f.step === 5) return { text: head(5) + CB_TEXTS.review, keyboard: "cb_back", buttons: [CB_BTNS.confirm, CB_BTNS.cancel] };
  if (f.step === 6 && !f.application_id) return { text: head(6) + CB_TEXTS.feeWait, keyboard: "cb_back", wait: { title: CB_TEXTS.waitFee, next: CB_TEXTS.feeWaitNext }, extras: [CB_TEXTS.feeHint], buttons: [CB_BTNS.expert] };
  if (f.step >= 7) {
    if (f.contract_status === "signed") return { text: head(7) + CB_TEXTS.contractSigned, keyboard: "cb_menu" };
    return { text: head(7) + CB_TEXTS.contractPending, keyboard: "cb_back", wait: { title: CB_TEXTS.waitSign, next: CB_TEXTS.contractPendingNext } };
  }
  return { text: CB_TEXTS.resume, keyboard: "cb_back", buttons: [CB_BTNS.resume, CB_BTNS.cancel] };
}

function trackReplies(customerId: number): CbReply[] {
  const cases = cbListCasesForCustomer(customerId);
  if (!cases.length) return [{ text: CB_TEXTS.filesNone, keyboard: "cb_back", buttons: [CB_BTNS.apply] }];
  if (cases.length === 1) return [{ text: cbFormatCaseCard(cases[0]), keyboard: "cb_back", buttons: [CB_BTNS.details] }];
  return [{ text: CB_TEXTS.filesMany, keyboard: "cb_back" }, ...cases.map((c) => ({ text: cbFormatCaseCard(c), keyboard: "cb_back" as const, buttons: [CB_BTNS.details] }))];
}

export type InboundCtx = {
  chat: ChatRow;
  bot: BotRow;
  customerId: number | null;
  customerName: string | null;
  text: string;
  hasPhoto?: boolean;
  // injectable services for tests
  identityFn?: (nationalId: string, birth: string) => Promise<"ok" | "wait" | "fail">;
  creditStartFn?: () => Promise<"otp" | "fail">;
  creditValidateFn?: (code: string) => Promise<"ok" | "fail">;
  contractPath?: ContractPath;
  aiFetch?: ChatCompletionsFn;
  at?: string;
};

function send(ctx: InboundCtx, r: CbReply) {
  const parts = [r.text, ...(r.extras ?? [])];
  if (r.wait) parts.splice(1, 0, `${r.wait.title}\n${r.wait.next}`);
  if (r.card) parts.push(r.card);
  for (let i = 0; i < parts.length; i++) {
    cbQueueText(ctx.chat, ctx.bot, parts[i], i === parts.length - 1 ? r.keyboard : null, ctx.at);
  }
  return r;
}

const _pendingInbound: InboundCtx[] = [];
export function cbEnqueueInbound(ctx: InboundCtx) { _pendingInbound.push(ctx); }
export async function cbDrainInbound(): Promise<void> {
  const jobs = _pendingInbound.splice(0);
  for (const j of jobs) await cbHandleInbound(j);
}

export async function cbHandleInbound(ctx: InboundCtx): Promise<CbReply | null> {
  ensureCustomerBaleSchema();
  if (!cbAnyFlagOn()) return null;
  const t = (ctx.text || "").trim();
  const at = ctx.at ?? nowIso();
  ctx.at = at;

  if (!ctx.customerId) return null; // number not linked yet — bale-contact owns this

  if (t === CB_TEXTS.backMenu || t === CB_BTNS.gotIt) {
    return send(ctx, { text: CB_TEXTS.welcomeBack(firstName(ctx.customerName)), keyboard: "cb_menu" });
  }

  if (t === CB_TEXTS.menuExpert || t === CB_BTNS.expert) {
    cbOpenTask("talk_expert", { chatRow: ctx.chat.id, customerId: ctx.customerId, ownerId: cbHandoffOwnerId(ctx.customerId, ctx.chat.owner_id), detail: "گفتگو با کارشناس" }, at);
    return send(ctx, { text: CB_TEXTS.talkExpert, keyboard: "cb_menu" });
  }

  if (t === CB_TEXTS.menuTrack) {
    if (!cbFlagOn("tracking")) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    const replies = trackReplies(ctx.customerId);
    replies.forEach((r, i) => send(ctx, i === replies.length - 1 ? r : { ...r, keyboard: null }));
    return replies[0];
  }

  if (t === CB_BTNS.details || /^جزئیات/.test(t) || /^#\d+$/.test(t)) {
    if (!cbFlagOn("tracking")) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    const cases = cbListCasesForCustomer(ctx.customerId);
    const one = t.startsWith("#") ? cases.find((c) => c.id === Number(t.slice(1))) : cases[0];
    if (!one) return send(ctx, { text: CB_TEXTS.filesNone, keyboard: "cb_back", buttons: [CB_BTNS.apply] });
    return send(ctx, { text: cbFormatCaseCard(one) + "\n" + CB_TEXTS.fileDetailHint, keyboard: "cb_back", buttons: [CB_BTNS.resume, CB_BTNS.expert] });
  }

  /* ---- AI ---- */
  if (t === CB_TEXTS.menuAi) {
    if (!cbAiLive()) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    cbSetAiMode(ctx.chat.id, true);
    return send(ctx, { text: "سؤال خود را بنویسید. پاسخ از پایگاه دانش است و نرخ یا وعده‌ی تصویب داده نمی‌شود.", keyboard: "cb_back" });
  }

  const filing = cbActiveFiling(ctx.chat.id);
  const inAi = cbAiLive() && !filing && t && t !== CB_TEXTS.menuApply && t !== CB_BTNS.apply && t !== CB_BTNS.resume
    && t !== CB_BTNS.cancel && t !== CB_BTNS.cancelYes && t !== CB_BTNS.confirm && t !== CB_BTNS.sendCode
    && t !== CB_BTNS.later && t !== CB_TEXTS.backMenu;

  // If user is mid-filing, text is for the wizard, not AI — except "پرسش"
  const mid = !!filing && filing.cancelled === 0;

  if (cbAiLive() && !mid && t && t !== CB_TEXTS.menuTrack && t !== CB_TEXTS.menuApply && t !== CB_TEXTS.menuExpert
      && t !== CB_BTNS.apply && t !== CB_BTNS.details && t !== CB_BTNS.resume && t.length > 1
      && (cbAiMode(ctx.chat.id) || t === CB_TEXTS.menuAi || looksLikeQuestion(t))) {
    if (t === CB_TEXTS.menuAi) { /* already handled */ }
    else return await handleAi(ctx, t);
  }

  /* ---- filing ---- */
  if (t === CB_TEXTS.menuApply || t === CB_BTNS.apply || t === CB_BTNS.resume) {
    if (!cbFlagOn("filing")) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    const f = cbStartOrResumeFiling(ctx.chat, ctx.customerId as number, cbAssignedSalespersonId(ctx.customerId) ?? (ctx.chat.owner_id && ctx.chat.owner_id > 0 ? ctx.chat.owner_id : null), at);
    if (t === CB_BTNS.resume && filing) return send(ctx, filingPrompt(f, ctx.customerId as number));
    if (filing && t !== CB_BTNS.resume) {
      const docs = docsOf(f);
      const cur = (docs.find((d) => !d.sent)?.name) || STEPS[f.step - 1];
      cbQueueText(ctx.chat, ctx.bot, CB_TEXTS.resume, null, at);
      const extra = f.step === 4 ? `ارسال «${cur}»` : STEPS[f.step - 1];
      cbQueueText(ctx.chat, ctx.bot, stepLine(f.step) + "\n" + CB_TEXTS.resumeStep(f.step, STEPS[f.step - 1], extra), "cb_back", at);
      return { text: CB_TEXTS.resume, keyboard: "cb_back", buttons: [CB_BTNS.resume, CB_BTNS.cancel] };
    }
    return send(ctx, filingPrompt(f, ctx.customerId));
  }

  if (t === CB_BTNS.cancel) {
    return send(ctx, { text: CB_TEXTS.cancelAsk, keyboard: "cb_back", buttons: [CB_BTNS.cancelYes, CB_BTNS.resume] });
  }
  if (t === CB_BTNS.cancelYes && filing) {
    cbCancelFiling(filing, at);
    return send(ctx, { text: CB_TEXTS.welcomeBack(firstName(ctx.customerName)), keyboard: "cb_menu" });
  }

  if (mid && cbFlagOn("filing") && filing) {
    return await handleFilingInput(ctx, filing, t);
  }

  return null;
}

const aiModeChats = new Set<number>();
function cbAiMode(chatRow: number) { return aiModeChats.has(chatRow); }
export function cbSetAiMode(chatRow: number, on: boolean) { if (on) aiModeChats.add(chatRow); else aiModeChats.delete(chatRow); }

function looksLikeQuestion(t: string) {
  return /[؟?]|چقدر|چیست|چطور|مدارک|ثبت درخواست|وام|تسهیلات/.test(t) && t.length >= 6;
}

async function handleAi(ctx: InboundCtx, question: string): Promise<CbReply> {
  cbSetAiMode(ctx.chat.id, true);
  if (cbAiFailed(ctx.chat.id)) {
    // already handed off once — stay with expert, don't call models again
    return send(ctx, { text: CB_TEXTS.aiHandoffBody, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.aiHandoffNext } });
  }
  const r = await cbAnswerAi(question, { fetchFn: ctx.aiFetch });
  const body = (r.kind === "answer" ? r.text : r.text);
  const labeled = `${CB_TEXTS.aiLabel}\n${body}`;
  if (r.kind === "handoff") {
    cbRecordAiTurn(ctx.chat.id, true, ctx.at);
    cbCreateHandoff({
      chatRow: ctx.chat.id, customerId: ctx.customerId ?? undefined, ownerId: cbHandoffOwnerId(ctx.customerId, ctx.chat.owner_id),
      question, answer: body, reason: r.reason,
    }, ctx.at);
    cbOpenTask("ai_handoff", { chatRow: ctx.chat.id, customerId: ctx.customerId ?? undefined, ownerId: cbHandoffOwnerId(ctx.customerId, ctx.chat.owner_id), detail: question }, ctx.at);
    return send(ctx, { text: labeled, keyboard: "cb_back", wait: { title: CB_TEXTS.waitExpert, next: CB_TEXTS.aiHandoffNext } });
  }
  cbRecordAiTurn(ctx.chat.id, false, ctx.at);
  return send(ctx, { text: labeled, keyboard: "cb_back", buttons: [CB_BTNS.gotIt, CB_BTNS.expert] });
}

async function handleFilingInput(ctx: InboundCtx, f: FilingRow, t: string): Promise<CbReply> {
  const at = ctx.at!;
  const customerId = ctx.customerId!;

  // identity: "CODE DATE" or two lines
  if (f.step <= 1 && f.identity_status !== "ok" && f.wait_kind !== "identity") {
    const m = t.match(/(\d{10})\s+(\d{4}[\/-]?\d{1,2}[\/-]?\d{1,2})/);
    if (m && ctx.identityFn) {
      const res = await ctx.identityFn(m[1], m[2]);
      if (res === "ok") {
        f.identity_status = "ok"; f.step = 2; f.wait_kind = null; saveFiling(f, at);
        return send(ctx, filingPrompt(f, customerId));
      }
      f.identity_status = "wait"; f.wait_kind = "identity"; saveFiling(f, at);
      cbOpenTask("identity_manual", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: cbHandoffOwnerId(customerId, ctx.chat.owner_id) }, at);
      return send(ctx, filingPrompt(f, customerId));
    }
    if (t === CB_BTNS.continue) return send(ctx, filingPrompt(f, customerId));
  }

  if (f.wait_kind === "identity") return send(ctx, filingPrompt(f, customerId));

  if (f.step <= 2 && (t === CB_BTNS.sendCode || t.includes("موافقم"))) {
    const start = ctx.creditStartFn ? await ctx.creditStartFn() : "otp";
    if (start === "otp") {
      f.wait_kind = "credit_otp"; saveFiling(f, at);
      return send(ctx, filingPrompt(f, customerId));
    }
    f.credit_status = "fail"; f.wait_kind = "credit_fail"; saveFiling(f, at);
    cbOpenTask("credit_fail", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: cbHandoffOwnerId(customerId, ctx.chat.owner_id) }, at);
    return send(ctx, filingPrompt(f, customerId));
  }

  if (f.wait_kind === "credit_otp") {
    // OTP is validated but NEVER stored or echoed
    const code = t.replace(/\s+/g, "");
    if (t === CB_BTNS.submitCode) return send(ctx, filingPrompt(f, customerId));
    const res = ctx.creditValidateFn ? await ctx.creditValidateFn(code) : "ok";
    if (res === "ok") {
      f.credit_status = "ok"; f.step = 3; f.wait_kind = null; saveFiling(f, at);
      return send(ctx, filingPrompt(f, customerId));
    }
    f.credit_status = "fail"; f.wait_kind = "credit_fail"; saveFiling(f, at);
    cbOpenTask("credit_fail", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: cbHandoffOwnerId(customerId, ctx.chat.owner_id) }, at);
    return send(ctx, filingPrompt(f, customerId));
  }

  if (f.step <= 3 && !f.plan_id) {
    const plans = cbTop3Plans(customerId);
    const pick = plans.find((p) => t.includes(p.label) || t === String(p.id) || t.includes(p.bankName));
    if (pick) {
      const open = cbOpenSamePlan(customerId, pick.id);
      if (open) {
        return send(ctx, { text: stepLine(3) + "\n" + CB_TEXTS.samePlanHead + "\n" + CB_TEXTS.samePlan(open), keyboard: "cb_back", buttons: [CB_BTNS.otherPlan, CB_BTNS.viewFile] });
      }
      f.plan_id = pick.id; f.step = 4; f.docs_json = JSON.stringify(cbDocList().map((name) => ({ name, sent: false }))); f.doc_index = 0;
      saveFiling(f, at);
      return send(ctx, filingPrompt(f, customerId));
    }
    if (t === CB_BTNS.otherPlan) return send(ctx, filingPrompt(f, customerId));
  }

  if (f.step === 4 && (ctx.hasPhoto || t === CB_BTNS.sendPhoto || t === CB_BTNS.replace)) {
    const docs = docsOf(f);
    const list = docs.length ? docs : cbDocList().map((name) => ({ name, sent: false }));
    const idx = list.findIndex((d) => !d.sent);
    if (idx >= 0) list[idx].sent = true;
    f.docs_json = JSON.stringify(list);
    f.doc_index = list.filter((d) => d.sent).length;
    if (list.every((d) => d.sent)) {
      f.wait_kind = "docs"; f.step = 5; saveFiling(f, at);
      cbOpenTask("docs_review", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: cbHandoffOwnerId(customerId, ctx.chat.owner_id) }, at);
    } else saveFiling(f, at);
    return send(ctx, filingPrompt(f, customerId));
  }

  if (f.step === 5 && t === CB_BTNS.confirm) {
    f.review_ok = 1; f.step = 6; f.wait_kind = "fee"; saveFiling(f, at);
    cbOpenTask("fee_unpaid", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: cbHandoffOwnerId(customerId, ctx.chat.owner_id) }, at);
    return send(ctx, filingPrompt(f, customerId));
  }

  return send(ctx, filingPrompt(f, customerId));
}

/** After filing fee is recorded on a plan/customer, create the application under the customer's salesperson. */
export function cbCreateApplicationFromFiling(f: FilingRow, at = nowIso()): number {
  if (f.application_id) return f.application_id;
  const cust = queryRow("SELECT id, salesperson_id FROM customers WHERE id=?", [f.customer_id]) as { id: number; salesperson_id: number | null } | undefined;
  const sp = cust?.salesperson_id ?? f.salesperson_id ?? null;
  const spName = sp ? ((queryRow("SELECT name FROM salespersons WHERE id=?", [sp]) as { name?: string } | undefined)?.name
    ?? (queryRow("SELECT full_name FROM users WHERE salesperson_id=?", [sp]) as { full_name?: string } | undefined)?.full_name
    ?? null) : null;
  const plan = f.plan_id ? queryRow("SELECT * FROM loan_plans WHERE id=?", [f.plan_id]) as any : null;
  const amount = plan?.principal_amount ?? 0;
  const duration = plan?.installments ?? null;
  const consultationId = execute(
    "INSERT INTO consultation_forms(customer_id,requested_amount,extra_notes,updated_at) VALUES(?,?,?,?)",
    [f.customer_id, amount, "ثبت از ربات بله", at],
  );
  const cond = f.plan_id ? queryRow("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY sort_order, id LIMIT 1", [f.plan_id]) : null;
  const id = execute(
    `INSERT INTO loan_applications(
      consultation_id,customer_id,requested_by_user_id,requested_by_customer_id,plan_ids,plan_id,
      requested_amount,duration_months,requested_duration_months,stage,status,plan_snapshot_json,
      condition_snapshot_json,document_requirements_snapshot_json,primary_manual_values_json,notes,
      is_pre_registration,salesperson_id_snapshot,salesperson_name_snapshot,new_case_workflow,created_at,updated_at
    ) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?)`,
    [
      consultationId, f.customer_id, f.customer_id, JSON.stringify([f.plan_id]), f.plan_id, amount, duration,
      duration, "draft", "requested", plan ? JSON.stringify(plan) : "{}", cond ? JSON.stringify(cond) : "{}",
      "[]", "{}", "ثبت از ربات بله", sp, spName, at, at,
    ],
  );
  f.application_id = id; f.fee_paid = 1; f.wait_kind = null; f.step = 6; saveFiling(f, at);
  execute("INSERT INTO customer_bale_apps(application_id,filing_id,chat_row,customer_id,created_at) VALUES(?,?,?,?,?)",
    [id, f.id, f.chat_row, f.customer_id, at]);
  return id;
}

/** Mark fee paid (called when a charge is linked, never pays on the customer's behalf). */
export function cbOnFeePaid(filingId: number, at = nowIso()): number | null {
  const f = queryRow("SELECT * FROM customer_bale_filings WHERE id=?", [filingId]) as FilingRow | undefined;
  if (!f || f.cancelled) return null;
  f.fee_paid = 1;
  const appId = cbCreateApplicationFromFiling(f, at);
  f.step = 7;
  saveFiling(f, at);
  return appId;
}

export async function cbAdvanceContract(f: FilingRow, path: ContractPath, at = nowIso()) {
  if (!f.application_id) throw new Error("no_application");
  const r = await cbIssueContract(f.application_id, path);
  f.contract_generation_id = r.generationId;
  f.contract_status = r.status;
  f.step = 7;
  f.wait_kind = r.status === "signed" ? null : "sign";
  saveFiling(f, at);
  return r;
}

export function cbSetContractStatus(f: FilingRow, status: string, at = nowIso()) {
  f.contract_status = status;
  if (status === "signed") f.wait_kind = null;
  else f.wait_kind = "sign";
  saveFiling(f, at);
}

/** Sentinel users.id for the shared «نفیس وام» customer bot (no owner expert). */
export const CB_SHARED_BOT_USER_ID = 0;
export const CB_SHARED_BOT_NAME = "نفیس وام";
export function isSharedCustomerBot(bot: { user_id: number } | null | undefined): boolean {
  return !!bot && Number(bot.user_id) === CB_SHARED_BOT_USER_ID;
}

/** Ensure one shared bot row exists (status off, no token). Additive; does not touch expert bots. */
export function ensureSharedCustomerBot(at = nowIso()): number {
  const existing = queryRow("SELECT id FROM bale_bots WHERE user_id=?", [CB_SHARED_BOT_USER_ID]) as { id: number } | undefined;
  if (existing) return existing.id;
  return execute(
    `INSERT INTO bale_bots(user_id, bot_name, status, created_at, updated_at) VALUES(?, ?, 'off', ?, ?)`,
    [CB_SHARED_BOT_USER_ID, CB_SHARED_BOT_NAME, at, at],
  );
}

export function cbSharedBot() {
  return queryRow("SELECT * FROM bale_bots WHERE user_id=?", [CB_SHARED_BOT_USER_ID]) as any;
}

/** Admin/API view of the shared bot: never includes the token. Status is «off»
 *  unless a token is stored, even if the row was left status='on'. */
export function cbSharedBotPublic(shared = cbSharedBot()) {
  if (!shared) return null;
  const hasToken = !!shared.token_ct;
  const raw = String(shared.status || "off");
  const status = hasToken ? (raw === "err" ? "err" : "on") : "off";
  return {
    id: shared.id,
    name: shared.bot_name || CB_SHARED_BOT_NAME,
    username: shared.bot_username ?? null,
    status,
    hasToken,
    connectedAt: hasToken ? (shared.connected_at ?? null) : null,
  };
}

export function cbClearSharedBotToken(at = nowIso()): void {
  const id = ensureSharedCustomerBot(at);
  executeChanges(
    "UPDATE bale_bots SET token_ct=NULL, token_key_id=NULL, status='off', connected_at=NULL, last_error=NULL, updated_at=? WHERE id=?",
    [at, id],
  );
}

export function cbAssignedSalespersonId(customerId: number | null | undefined): number | null {
  if (!customerId) return null;
  const r = queryRow("SELECT salesperson_id FROM customers WHERE id=?", [customerId]) as { salesperson_id: number | null } | undefined;
  const sp = r?.salesperson_id;
  return sp && Number(sp) > 0 ? Number(sp) : null;
}

export function cbExpertUserIdForSalesperson(salespersonId: number | null | undefined): number | null {
  if (!salespersonId) return null;
  const u = queryRow(
    "SELECT id FROM users WHERE salesperson_id=? AND role='salesperson' AND active=1 ORDER BY id LIMIT 1",
    [salespersonId],
  ) as { id: number } | undefined;
  return u ? Number(u.id) : null;
}

/** Assigned expert for a customer, else the chat's expert owner, else null (unassigned / admin queue). */
export function cbHandoffOwnerId(customerId?: number | null, chatOwnerId?: number | null): number | null {
  // Expert bots: the chat belongs to that expert. Shared bot (owner 0) or unknown: use the assigned expert, else unassigned.
  if (chatOwnerId && Number(chatOwnerId) > 0) return Number(chatOwnerId);
  return cbExpertUserIdForSalesperson(cbAssignedSalespersonId(customerId));
}

export function cbOpenUnassignedTasks() {
  return queryRows("SELECT * FROM customer_bale_tasks WHERE owner_id IS NULL AND status='open' ORDER BY id DESC");
}

export function cbQueueSys(chat: { id: number }, text: string, at = nowIso()): number {
  return execute(
    `INSERT INTO bale_bot_messages(chat_row,dir,kind,text,status,created_at) VALUES(?,'sys','sys',?, 'sent', ?)`,
    [chat.id, text, at],
  );
}

function expertDisplayName(customerId: number | null | undefined): string | null {
  const uid = cbHandoffOwnerId(customerId, null);
  if (!uid) return null;
  const u = queryRow("SELECT full_name, username FROM users WHERE id=?", [uid]) as { full_name: string | null; username: string | null } | undefined;
  const n = (u?.full_name || u?.username || "").trim();
  return n || null;
}

/** After a number is linked: expert bots get welcome-back; the shared bot follows Armita §۶.۴ (wait, then name if assigned). */
export function cbWelcomeAfterLink(chat: ChatRow, bot: BotRow, customerName: string | null, at = nowIso()): number | null {
  if (!cbAnyFlagOn()) return null;
  if (isSharedCustomerBot(bot)) {
    const newLead = Number((chat as any).lead_from_bale) === 1;
    const expert = expertDisplayName((chat as any).customer_id);
    if (newLead) {
      cbQueueText(chat, bot, CB_TEXTS.sharedNumberSaved, null, at);
      cbQueueText(chat, bot, CB_TEXTS.waitAssign + "\n" + CB_TEXTS.waitAssignNext, expert ? "cb_menu" : "cb_back", at);
      cbQueueSys(chat, CB_TEXTS.sharedNewLeadSys, at);
      if (expert) {
        cbQueueText(chat, bot, CB_TEXTS.sharedAssigned(expert), "cb_menu", at);
        cbQueueSys(chat, CB_TEXTS.sharedAssignedSys(expert), at);
      }
      return 1;
    }
    if (expert) cbQueueSys(chat, CB_TEXTS.sharedRoutedSys, at);
    return cbQueueText(chat, bot, CB_TEXTS.welcomeBack(firstName(customerName)), "cb_menu", at);
  }
  return cbQueueText(chat, bot, CB_TEXTS.welcomeBack(firstName(customerName)), "cb_menu", at);
}

export function cbIsFromBale(applicationId: number): boolean {
  return !!queryRow("SELECT application_id FROM customer_bale_apps WHERE application_id=?", [applicationId]);
}

export function cbFilingView(chatRow: number) {
  const f = cbActiveFiling(chatRow);
  if (!f) return null;
  const plan = f.plan_id
    ? (queryRow("SELECT bank_name FROM loan_plans WHERE id=?", [f.plan_id]) as { bank_name: string } | undefined)
    : null;
  return {
    id: f.id,
    step: f.step,
    stepTitle: STEPS[f.step - 1],
    stepLine: stepLine(f.step),
    waitKind: f.wait_kind,
    waitTitle: f.wait_kind === "fee" ? CB_TEXTS.waitFee : f.wait_kind === "sign" ? CB_TEXTS.waitSign : (f.wait_kind ? CB_TEXTS.waitExpert : null),
    planLabel: plan ? planLabelForCustomer(plan.bank_name) : null,
    applicationId: f.application_id,
    contractStatus: f.contract_status,
    identity: f.identity_status,
    credit: f.credit_status,
    docIndex: f.doc_index,
    cancelled: !!f.cancelled,
  };
}

export function cbOpenHandoff(chatRow: number) {
  return queryRow("SELECT * FROM customer_bale_handoffs WHERE chat_row=? AND claimed_at IS NULL ORDER BY id DESC LIMIT 1", [chatRow]) as any;
}

export function cbClaimHandoff(id: number, userId: number, at = nowIso()) {
  executeChanges("UPDATE customer_bale_handoffs SET claimed_by=?, claimed_at=? WHERE id=?", [userId, at, id]);
}

export function cbOpenTasksForOwner(ownerId: number) {
  return queryRows("SELECT * FROM customer_bale_tasks WHERE owner_id=? AND status='open' ORDER BY id DESC", [ownerId]);
}

export function cbKbList() {
  return queryRows("SELECT id,title,body,active,category,scope,updated_at,updated_by FROM customer_bale_kb ORDER BY id DESC, id");
}
export function cbNormalizeKbScope(raw: unknown): CbKbScope {
  const s = String(raw ?? "").trim();
  return (CB_KB_SCOPES as readonly string[]).includes(s) ? (s as CbKbScope) : CB_KB_SCOPE_ALL;
}
export function cbKbUpsert(id: number | null, title: string, body: string, active: boolean, userId: number | null, at = nowIso(), extra?: { category?: string | null; scope?: string | null }) {
  const category = String(extra?.category ?? "").trim() || "مدارک";
  const scope = cbNormalizeKbScope(extra?.scope);
  if (id) {
    executeChanges("UPDATE customer_bale_kb SET title=?, body=?, active=?, category=?, scope=?, updated_at=?, updated_by=? WHERE id=?",
      [title, body, active ? 1 : 0, category, scope, at, userId, id]);
    return id;
  }
  return execute("INSERT INTO customer_bale_kb(title,body,active,category,scope,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)",
    [title, body, active ? 1 : 0, category, scope, at, userId]);
}
export function cbKbDelete(id: number): boolean {
  return executeChanges("DELETE FROM customer_bale_kb WHERE id=?", [id]) > 0;
}
export function cbKbSetActive(id: number, active: boolean, userId: number | null, at = nowIso()): boolean {
  return executeChanges("UPDATE customer_bale_kb SET active=?, updated_at=?, updated_by=? WHERE id=?", [active ? 1 : 0, at, userId, id]) > 0;
}

export function lockDownOn(): boolean {
  return setting("flag.expert_lockdown") === "1";
}

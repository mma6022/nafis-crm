/** Customer-facing Bale bot: tracking, filing, and AI. Flags default OFF.
 *  Local-only feature; never prints secrets. Ghasemi's bot never sends.
 *  Contract issuance uses the existing generate → send → check-status hooks only.
 */
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { bcMaySendFromBot } from "./bale-contact";
type BotRow = { id: number; user_id: number; [k: string]: unknown };
type ChatRow = { id: number; owner_id?: number; customer_id?: number | null; [k: string]: unknown };
import { LOAN_STAGE_LABELS } from "./manager-work";

export const CB_FLAGS = {
  tracking: "flag.customer_bale_tracking",
  ai: "flag.customer_bale_ai",
  filing: "flag.customer_bale_filing",
} as const;
export type CbFlagKey = keyof typeof CB_FLAGS;

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
  plans: "تا سه طرح فعال که در ماه گذشته بیشترین پرونده را داشته‌اند و با شرایط شما می‌خوانند:",
  samePlan: (id: number) =>
    `این مشتری از قبل پرونده‌ی باز #${id} با همین طرح دارد. تا لغو یا تکمیل آن، پرونده‌ی تازه با همین طرح ساخته نمی‌شود.`,
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
  contractPendingHint: "یادآوری امضا هم از همین مسیر موجود فرستاده می‌شود.",
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

/** Store a secret as a sealed blob + last4. Never logs the value. */
export function cbStoreSecret(kind: "openai" | "deepseek", plaintext: string, at = nowIso()): void {
  const last4 = plaintext.slice(-4);
  const blob = Buffer.from(plaintext, "utf8").toString("base64");
  executeChanges("DELETE FROM customer_bale_secrets WHERE kind=?", [kind]);
  execute(
    "INSERT INTO customer_bale_secrets(kind, sealed, last4, updated_at) VALUES(?,?,?,?)",
    [kind, blob, last4, at],
  );
}

export function cbSecretMeta(kind: "openai" | "deepseek"): { set: boolean; last4: string | null } {
  const r = queryRow("SELECT last4 FROM customer_bale_secrets WHERE kind=?", [kind]) as { last4: string } | undefined;
  return { set: !!r, last4: r?.last4 ?? null };
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
  schemaReady = true;
}

export function _resetCustomerBaleSchemaFlag() { schemaReady = false; }

/* ---------------- display helpers ---------------- */

/** Public plan name for customers only. Internal plan name is never used. */
export function planLabelForCustomer(bankName: string | null | undefined): string {
  const bank = String(bankName ?? "").trim().replace(/ - /g, "، ");
  return bank ? `لندتک / ${bank}` : "لندتک";
}

export function stepLine(n: number, title?: string): string {
  const t = title ?? STEPS[n - 1] ?? "";
  return `مرحله ${n} از ۷ — ${t}`;
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

/* ---------------- Tehran previous calendar month ---------------- */

/** Previous complete Gregorian month in Asia/Tehran (report primary definition). Inclusive start, exclusive end, ISO UTC. */
export function prevTehranMonthWindow(now = new Date()): { start: string; end: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const startY = m === 1 ? y - 1 : y;
  const startM = m === 1 ? 12 : m - 1;
  const endY = y;
  const endM = m;
  const tehranOffsetMs = (3 * 60 + 30) * 60 * 1000;
  const startLocal = Date.UTC(startY, startM - 1, 1, 0, 0, 0) - tehranOffsetMs;
  const endLocal = Date.UTC(endY, endM - 1, 1, 0, 0, 0) - tehranOffsetMs;
  return { start: new Date(startLocal).toISOString(), end: new Date(endLocal).toISOString() };
}

/* ---------------- queue ---------------- */

export type CbKeyboard = "cb_menu" | "cb_back" | "cb_docs" | "cb_otp" | "cb_identity" | "contact" | null;

export function cbQueueText(chat: { id: number }, bot: { id: number; user_id: number }, text: string, keyboard: CbKeyboard = null, at = nowIso()): number | null {
  if (!bcMaySendFromBot(bot as BotRow)) {
    cbAudit("queue_blocked", chat.id, { reason: "no_send" });
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
  return `${c.plan}\nپرونده #${c.id}\nکارمزد ثبت: ${fee}\nمرحله‌ی فعلی: ${c.stage}\n${c.phaseLabel} (${c.phase + 1} از ۵)`;
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
  const w = prevTehranMonthWindow(now);
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

/* ---------------- AI ---------------- */

const RATE_RE = /(\d+(?:[.,]\d+)?\s*%|نرخ\s*(سود|بهره)|سود\s*سالیانه|کارمزد\s*\d)/;
const APPROVE_RE = /(حتماً?\s*تصویب|قطعاً?\s*تصویب|تأیید\s*می‌شوید|مصوب\s*می‌شود|تصویب\s*می‌شود|حتماً?\s*وام\s*می‌گیر)/;

export function cbGuardAiText(text: string): { ok: true } | { ok: false; reason: "rate" | "approval" } {
  if (RATE_RE.test(text)) return { ok: false, reason: "rate" };
  if (APPROVE_RE.test(text)) return { ok: false, reason: "approval" };
  return { ok: true };
}

export function cbKbText(): string {
  const rows = queryRows("SELECT title, body FROM customer_bale_kb WHERE active=1 ORDER BY id") as { title: string; body: string }[];
  if (!rows.length) {
    return "برای شروع معمولاً تصویر روی و پشت کارت ملی، صفحات شناسنامه، مدرک شغلی و مدرک محل سکونت لازم است. فهرست دقیق هر طرح را در همان مرحله‌ی مدارک می‌بینید. نرخ سود یا وعده‌ی تصویب داده نمی‌شود.";
  }
  return rows.map((r) => `## ${r.title}\n${r.body}`).join("\n\n");
}

export type ChatCompletionsFn = (opts: {
  baseUrl: string; apiKey: string; model: string; messages: { role: string; content: string }[]; timeoutMs: number;
}) => Promise<{ ok: true; text: string } | { ok: false; status?: number; error: string }>;

export const defaultChatCompletions: ChatCompletionsFn = async ({ baseUrl, apiKey, model, messages, timeoutMs }) => {
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

export async function cbAnswerAi(question: string, opts?: { fetchFn?: ChatCompletionsFn; timeoutMs?: number }): Promise<AiResult> {
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
    cbOpenTask("talk_expert", { chatRow: ctx.chat.id, customerId: ctx.customerId, ownerId: ctx.chat.owner_id, detail: "گفتگو با کارشناس" }, at);
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
    if (!cbFlagOn("ai")) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    cbSetAiMode(ctx.chat.id, true);
    return send(ctx, { text: "سؤال خود را بنویسید. پاسخ از پایگاه دانش است و نرخ یا وعده‌ی تصویب داده نمی‌شود.", keyboard: "cb_back" });
  }

  const filing = cbActiveFiling(ctx.chat.id);
  const inAi = cbFlagOn("ai") && !filing && t && t !== CB_TEXTS.menuApply && t !== CB_BTNS.apply && t !== CB_BTNS.resume
    && t !== CB_BTNS.cancel && t !== CB_BTNS.cancelYes && t !== CB_BTNS.confirm && t !== CB_BTNS.sendCode
    && t !== CB_BTNS.later && t !== CB_TEXTS.backMenu;

  // If user is mid-filing, text is for the wizard, not AI — except "پرسش"
  const mid = !!filing && filing.cancelled === 0;

  if (cbFlagOn("ai") && !mid && t && t !== CB_TEXTS.menuTrack && t !== CB_TEXTS.menuApply && t !== CB_TEXTS.menuExpert
      && t !== CB_BTNS.apply && t !== CB_BTNS.details && t !== CB_BTNS.resume && t.length > 1
      && (cbAiMode(ctx.chat.id) || t === CB_TEXTS.menuAi || looksLikeQuestion(t))) {
    if (t === CB_TEXTS.menuAi) { /* already handled */ }
    else return await handleAi(ctx, t);
  }

  /* ---- filing ---- */
  if (t === CB_TEXTS.menuApply || t === CB_BTNS.apply || t === CB_BTNS.resume) {
    if (!cbFlagOn("filing")) return send(ctx, { text: CB_TEXTS.featureOff, keyboard: "cb_menu" });
    const f = cbStartOrResumeFiling(ctx.chat, ctx.customerId as number, ctx.chat.owner_id ?? null, at);
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
      chatRow: ctx.chat.id, customerId: ctx.customerId ?? undefined, ownerId: ctx.chat.owner_id,
      question, answer: body, reason: r.reason,
    }, ctx.at);
    cbOpenTask("ai_handoff", { chatRow: ctx.chat.id, customerId: ctx.customerId ?? undefined, ownerId: ctx.chat.owner_id, detail: question }, ctx.at);
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
      cbOpenTask("identity_manual", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: f.salesperson_id ?? ctx.chat.owner_id }, at);
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
    cbOpenTask("credit_fail", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: f.salesperson_id ?? ctx.chat.owner_id }, at);
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
    cbOpenTask("credit_fail", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: f.salesperson_id ?? ctx.chat.owner_id }, at);
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
      cbOpenTask("docs_review", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: f.salesperson_id ?? ctx.chat.owner_id }, at);
    } else saveFiling(f, at);
    return send(ctx, filingPrompt(f, customerId));
  }

  if (f.step === 5 && t === CB_BTNS.confirm) {
    f.review_ok = 1; f.step = 6; f.wait_kind = "fee"; saveFiling(f, at);
    cbOpenTask("fee_unpaid", { chatRow: ctx.chat.id, filingId: f.id, customerId, ownerId: f.salesperson_id ?? ctx.chat.owner_id }, at);
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

export function cbWelcomeAfterLink(chat: ChatRow, bot: BotRow, customerName: string | null, at = nowIso()): number | null {
  if (!cbAnyFlagOn()) return null;
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
  return queryRows("SELECT id,title,body,active,updated_at,updated_by FROM customer_bale_kb ORDER BY id");
}
export function cbKbUpsert(id: number | null, title: string, body: string, active: boolean, userId: number | null, at = nowIso()) {
  if (id) {
    executeChanges("UPDATE customer_bale_kb SET title=?, body=?, active=?, updated_at=?, updated_by=? WHERE id=?",
      [title, body, active ? 1 : 0, at, userId, id]);
    return id;
  }
  return execute("INSERT INTO customer_bale_kb(title,body,active,updated_at,updated_by) VALUES(?,?,?,?,?)",
    [title, body, active ? 1 : 0, at, userId]);
}

export function lockDownOn(): boolean {
  return setting("flag.expert_lockdown") === "1";
}

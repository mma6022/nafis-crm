/**
 * «پاسخ خودکار دستیارها در بله» — pilot core (Mohammad, 2026-10-27; Kazemi ↔ Masoud first). EVERYTHING SHIPS OFF.
 *
 *  Gate (all must hold, checked on enqueue AND again right before the send):
 *    bale_settings.master_enabled = 1  AND  bale_settings.autoreply_enabled = 1  AND  bale_autoreply_pairs.enabled = 1 for this assistant
 *    AND the assistant row is enabled and still bound to the same expert AND the expert's Bale account is connected with a live session.
 *  The expert's account mode (off / approve_first / auto) is NOT read on this path: with the pair ON nothing waits for per-message
 *  approval, and turning the pair ON never touches the account mode. Auto-stop (rate limit / ban / dead session) still sets the
 *  account mode to off AND switches every pair of that expert OFF (stopped_reason) — only an admin turns it back on.
 *
 *  Reply-only: a send needs the conversation's LATEST message to be the customer's, unanswered (no human reply after it), younger
 *  than reply_window_min (default 24 h, PM backlog rule) and not already answered automatically (one text + at most one plan file).
 *  Never a first message, never a bulk send. Older unanswered conversations are handed to the expert by the sweep.
 *  Takeover: «خودم جواب می‌دم» (or the expert writing from the Bale app / CRM) → owner = expert; pending auto rows are cancelled and
 *  every send re-checks the owner. Only «برگردون به مسعود» gives it back (no automatic return).
 *  Escalation (server side, inbound AND drafts): promise / guarantee / amount / date / anger-complaint words → owner = expert,
 *  one holding message (admin-editable), bell to the expert.
 *  Hours: Sat–Thu 08:30–20:00 Tehran, Friday closed (admin-editable). Outside them only the after-hours text goes out, once per
 *  conversation per closed window; runner replies are refused (after_hours).
 *  Unknown senders (pair.allow_unknown, seeded 1 only for masoud): text + opaque Bale peer id only — never a phone — in
 *  bale_ar_chats / bale_ar_messages; label «ناشناس»; generic replies only (their context read returns nothing from customers/cases).
 *  Wake webhook: optional POST {eventId, pair} to BALE_AUTOREPLY_WAKE_URL with header x-autoreply-wake-key = BALE_AUTOREPLY_WAKE_KEY
 *  (both unset by default → nothing is called). The runner's own GET /events?wait=25 long-poll is the better instant path.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeFa } from "./assistants";
import { maskText } from "./smart-filing";

export const AR_PAIR_SEED = [
  { slug: "masoud", allowUnknown: 0, allowPlanFile: 0 },
  { slug: "somayeh", allowUnknown: 0, allowPlanFile: 0 },
  { slug: "mohaddeseh", allowUnknown: 0, allowPlanFile: 0 },
] as const;
/** bale_settings keys (INSERT OR IGNORE at boot). Everything OFF; texts and hours are the PM's admin-editable defaults. */
export const AR_DEFAULT_SETTINGS: Record<string, string> = {
  autoreply_enabled: "0",
  autoreply_day_start: "08:30", autoreply_day_end: "20:00",
  /** Tehran weekdays the pair answers during the day: 0 = Saturday … 6 = Friday (Friday closed). */
  autoreply_days: "0,1,2,3,4,5",
  autoreply_hold_text: "سلام، پیامتون رسید. دارم بررسی می‌کنم و به‌زودی خبرتون می‌کنم.",
  autoreply_night_text: "سلام، پیامتون رسید. فردا صبح پیگیری می‌کنم.",
  autoreply_escalate_extra: "[]",
  /** Official holidays (design v1.4): JSON [{date:"YYYY-MM-DD" (Tehran calendar day, Gregorian), label}] — closed like Friday. */
  autoreply_holidays: "[]",
};
export const AR_REPLY_WINDOW_MIN = 1440;
export const AR_TEXT_MAX = 600;
export const AR_WAKE_DELAYS_MS = [0, 2000, 8000, 30000];

export type ArBlock = "autoreply_off" | "not_a_reply" | "reply_window" | "human_replied" | "already_replied" | "human_mode" | "after_hours"
  | "escalated" | "cap_pair_hour" | "cap_pair_day" | "plan_file_off" | "signature" | "unknown_off";
export const AR_BLOCK_FA: Record<ArBlock, string> = {
  autoreply_off: "پاسخ خودکار برای این دستیار خاموش است؛ چیزی فرستاده نشد.",
  not_a_reply: "پاسخ خودکار فقط جواب آخرین پیام مشتری است؛ پیام اول یا پیام بی‌جواب‌نمانده فرستاده نمی‌شود.",
  reply_window: "آخرین پیام مشتری قدیمی است؛ گفتگو به کارشناس سپرده شد.",
  human_replied: "کارشناس خودش جواب داده است؛ پاسخ خودکار فرستاده نشد.",
  already_replied: "به این پیام مشتری قبلاً پاسخ خودکار داده شده است.",
  human_mode: "کارشناس این گفتگو را دست گرفته است؛ مسعود در این گفتگو ساکت است.",
  after_hours: "بیرون از ساعت کاری فقط پیام «فردا صبح پیگیری می‌کنم» می‌رود.",
  escalated: "این متن قول، مبلغ، تاریخ یا موضوع حساس دارد؛ فرستاده نشد و گفتگو به کارشناس سپرده شد.",
  cap_pair_hour: "سقف پاسخ خودکار در این ساعت پر شده است.",
  cap_pair_day: "سقف پاسخ خودکار امروز پر شده است.",
  plan_file_off: "ارسال خودکار فایل طرح برای این دستیار خاموش است.",
  signature: "پاسخ باید با صدای خود کارشناس باشد؛ اسم دستیار، «ربات» یا «پاسخ خودکار» در متن نیاید.",
  unknown_off: "این گفتگوی ناشناس در دسترس دستیار نیست.",
};

/* ------------------------------------------------ pure helpers ------------------------------------------------ */
const HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WD = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", weekday: "short" });
const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" });
/** Tehran calendar day of an instant, "YYYY-MM-DD". */
export const arTehranYmd = (d: Date) => YMD.format(d);
export type ArHoliday = { date: string; label: string | null };
export function arParseHolidays(json: string | null | undefined): ArHoliday[] {
  try {
    const l = JSON.parse(String(json ?? "[]"));
    return Array.isArray(l) ? l.filter((h: any) => h && /^\d{4}-\d{2}-\d{2}$/.test(String(h.date))).map((h: any) => ({ date: String(h.date), label: h.label ? String(h.label).slice(0, 40) : null })) : [];
  } catch { return []; }
}
const WD_IDX: Record<string, number> = { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 };
export const arTehranMin = (d: Date) => { const [h, m] = HM.format(d).split(":").map(Number); return h * 60 + m; };
export const arTehranDay = (d: Date) => WD_IDX[WD.format(d)] ?? 0;
export function arParseHm(s: string, dflt: number): number { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : dflt; }
export const arParseDays = (s: string) => { const l = String(s ?? "").split(",").map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6); return new Set(l); };
/** Day window: weekday in `days` and Tehran time in [start, end). */
export function arInDay(d: Date, start: string, end: string, days: string, holidays?: string): boolean {
  if (!arParseDays(days).has(arTehranDay(d))) return false;
  if (holidays && holidays !== "[]" && arParseHolidays(holidays).some(h => h.date === arTehranYmd(d))) return false;
  const s = arParseHm(start, 510), e = arParseHm(end, 1200), m = arTehranMin(d);
  return s < e ? m >= s && m < e : s === e;
}
/** Start of the current closed window (the last instant the day window was open). Used for «once per conversation per night». */
export function arClosedSince(d: Date, start: string, end: string, days: string, holidays?: string): Date {
  let t = new Date(Math.floor(d.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 1440 && !arInDay(new Date(t.getTime() - 60_000), start, end, days, holidays); i++) t = new Date(t.getTime() - 60_000);
  return t;
}

type EscKind = "promise" | "amount" | "date" | "anger" | "custom";
// "=x" whole word, "^x" word start, otherwise substring (after normalizeFa: ی/ک unified, ZWNJ removed, آ→ا; digits → ASCII).
const ESC_WORDS: Record<Exclude<EscKind, "amount" | "date" | "custom">, string[]> = {
  promise: ["تضمین", "^قول", "تعهد", "قطعا", "قطعی", "صد در صد", "صددرصد", "100 درصد", "100%", "حتما تایید", "حتما میشه", "حتما جور", "حتما وام", "مطمئن باشید", "بدون شک", "ضمانت میکن", "ضمانت می کن"],
  anger: ["شکایت", "کلاهبردار", "کلاه بردار", "^دزد", "اعتراض", "ناراضی", "پلیس", "وکیل", "دادگاه", "دادسرا", "مسخره", "افتضاح", "بیشرف", "بی شرف", "لعنت", "عوضی", "اشغال", "پولمو", "پول منو", "پس بدید", "پس بدین", "برگردونید", "عصبانی", "بدترین", "سرکار گذاشت", "سر کار گذاشت", "^دروغ", "ابروریزی", "مزخرف", "بی ادب", "بیادب"],
};
const AMOUNT_RE = /(میلیون|میلیارد|تومان|تومن|ریال)|\d[\d,٬.\s]*(هزار|درصد|٪|%)|(سود|قسط|اقساط|کارمزد|مبلغ)\s*\d/;
const DATE_RE = /\d{1,4}\s*[\/\-.]\s*\d{1,2}(\s*[\/\-.]\s*\d{1,4})?|شنبه|جمعه|فروردین|اردیبهشت|خرداد|تیر ماه|تیرماه|مرداد|شهریور|مهر ماه|مهرماه|ابان|اذر|دی ماه|دیماه|بهمن|اسفند|(^|[^\p{L}])(فردا|پسفردا|پس فردا)([^\p{L}]|$)|هفته (بعد|اینده|دیگه|دیگر)|ماه (بعد|اینده|دیگه|دیگر)|\d+\s*(روز|هفته|ماه|ساعت)|ساعت\s*\d|(^|[^\p{L}])ظرف([^\p{L}]|$)/u;
const asciiDigits = (s: string) => s.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const normEsc = (s: string) => asciiDigits(normalizeFa(String(s ?? ""))).replace(/\s+/g, " ").toLowerCase();
function wordHit(n: string, w: string): boolean {
  const L = "[^\\p{L}\\p{N}]";
  if (w.startsWith("=")) return new RegExp(`(^|${L})${esc(normEsc(w.slice(1)))}(${L}|$)`, "u").test(n);
  if (w.startsWith("^")) return new RegExp(`(^|${L})${esc(normEsc(w.slice(1)))}`, "u").test(n);
  return n.includes(normEsc(w));
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Escalation check. `draft` = a reply Masoud wants to send (promise/amount/date/anger); inbound = customer text (same lists). */
export function arEscalation(text: string, extra: string[] = []): EscKind | null {
  const n = normEsc(text); if (!n.trim()) return null;
  if (ESC_WORDS.anger.some(w => wordHit(n, w))) return "anger";
  if (ESC_WORDS.promise.some(w => wordHit(n, w))) return "promise";
  if (AMOUNT_RE.test(n)) return "amount";
  if (DATE_RE.test(n)) return "date";
  if (extra.some(w => w && wordHit(n, String(w)))) return "custom";
  return null;
}
export const AR_ESC_FA: Record<EscKind, string> = { promise: "قول یا تضمین", amount: "مبلغ", date: "تاریخ یا زمان", anger: "ناراحتی یا شکایت", custom: "واژه‌ی حساس" };
/** Voice of the expert: trailing signature lines (مسعود / دستیار / ربات / کاظمی) are stripped; any remaining bot mention is refused. */
export function arVoice(text: string): { text: string; problem: "signature" | null } {
  const lines = String(text ?? "").replace(/\r/g, "").trim().split("\n");
  const SIG = /^[\s\-—–_~.•*]*(مسعود|دستیار[\s\S]*|ربات[\s\S]*|کاظمی|کارشناس شما)(\s*\([^)]*\))?[\s.!،]*$/;
  while (lines.length > 1 && SIG.test(normalizeFa(lines[lines.length - 1]).trim())) lines.pop();
  let t = lines.join("\n").trim().replace(/\s*[—–-]+\s*(مسعود|دستیار[^\n]*|کاظمی)\s*$/u, "").trim();
  const n = normalizeFa(t);
  if (/دستیار|ربات|هوش مصنوعی|پاسخ خودکار|پیام خودکار|مسعود/.test(n)) return { text: t, problem: "signature" };
  return { text: t, problem: null };
}

/* ------------------------------------------------ schema ------------------------------------------------ */
export function ensureBaleAutoreplySchema(db: DatabaseSync, nowIso = new Date().toISOString()): void {
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name));
  const add = (t: string, c: string, ddl: string) => { if (!cols(t).has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
  db.exec(`CREATE TABLE IF NOT EXISTS bale_autoreply_pairs (
    assistant_id INTEGER PRIMARY KEY, slug TEXT NOT NULL, expert_user_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), reads_enabled INTEGER NOT NULL DEFAULT 0 CHECK(reads_enabled IN (0,1)),
    allow_unknown INTEGER NOT NULL DEFAULT 0 CHECK(allow_unknown IN (0,1)), allow_plan_file INTEGER NOT NULL DEFAULT 0 CHECK(allow_plan_file IN (0,1)),
    per_hour INTEGER NOT NULL DEFAULT 10, per_day INTEGER NOT NULL DEFAULT 40, reply_window_min INTEGER NOT NULL DEFAULT ${AR_REPLY_WINDOW_MIN},
    stopped_reason TEXT, updated_by INTEGER, updated_at TEXT NOT NULL)`);
  add("bale_outbox", "reply_to_msg_id", "INTEGER");
  add("bale_outbox", "ar_kind", "TEXT"); // reply | plan | hold | night (auto_reply rows only)
  add("bale_conversation_state", "ar_owner", "TEXT"); // NULL/'assistant' = the pair may answer; 'expert' = Masoud silent
  add("bale_conversation_state", "ar_reason", "TEXT");
  add("bale_conversation_state", "ar_by", "INTEGER");
  add("bale_conversation_state", "ar_at", "TEXT");
  add("bale_conversation_state", "ar_night_at", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS bale_ar_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES bale_accounts(id), peer_id TEXT NOT NULL,
    first_at TEXT NOT NULL, last_at TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'assistant' CHECK(owner IN ('assistant','expert')),
    owner_reason TEXT, owner_by INTEGER, owner_at TEXT, night_at TEXT, UNIQUE(account_id, peer_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS bale_ar_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES bale_ar_chats(id), account_id INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')), source TEXT NOT NULL CHECK(source IN ('customer','auto_reply','expert')),
    ar_kind TEXT, text TEXT, has_file INTEGER NOT NULL DEFAULT 0, attachment_id INTEGER, reply_to INTEGER, assistant_id INTEGER,
    status TEXT NOT NULL CHECK(status IN ('received','external','queued','sending','sent','failed','blocked','cancelled')),
    block_reason TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, bale_msg_id TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(account_id, bale_msg_id))`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_bale_ar_messages_chat ON bale_ar_messages(chat_id, id)");
  const ins = db.prepare("INSERT OR IGNORE INTO bale_settings(key,value,updated_at) VALUES(?,?,?)");
  for (const [k, v] of Object.entries(AR_DEFAULT_SETTINGS)) ins.run(k, v, nowIso);
  seedArPairs(db, nowIso);
}
/** Idempotent: one OFF pair per seeded sales assistant that is bound to an expert. Never changes an existing row. */
export function seedArPairs(db: DatabaseSync, nowIso = new Date().toISOString()): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistants'").get()) return;
  const st = db.prepare(`INSERT OR IGNORE INTO bale_autoreply_pairs(assistant_id,slug,expert_user_id,enabled,reads_enabled,allow_unknown,allow_plan_file,updated_at)
    SELECT id, slug, bound_user_id, 0, 0, ?, ?, ? FROM assistants WHERE slug=? AND kind='sales' AND bound_user_id IS NOT NULL`);
  for (const p of AR_PAIR_SEED) st.run(p.allowUnknown, p.allowPlanFile, nowIso, p.slug);
}

/* ------------------------------------------------ core ------------------------------------------------ */
export type ArTarget = { customerId: number; chatId?: undefined } | { chatId: number; customerId?: undefined };
export type ArCore = {
  db: DatabaseSync; now: () => Date; setting: (k: string) => string; masterOn: () => boolean; env: () => Record<string, string | undefined>;
  audit: (o: { u?: any; accountId?: number | null; customerId?: number | null; action: string; outcome: string; detail?: Record<string, string | number | boolean | null> }) => void;
  userRow: (id: number) => any; nameOf: (u: any) => string | null;
  bell: (userId: number, customerId: number, kind: string, title: string, body: string) => void;
  bellNoCustomer: (userId: number, title: string, body: string) => void;
  liveState: (a: any) => "live" | "down" | "unknown";
  textProblem: (text: string) => string | null;
  sidecar: { send: (p: any) => Promise<{ messageId: string; peerId: string }>; sendFile: (p: any) => Promise<{ messageId: string; peerId: string }> };
  planFiles?: { byId: (id: number) => any; read: (f: any) => Buffer | null };
  attachmentsOn: () => boolean; attachOne: (a: any) => Promise<boolean>; gapMs: () => number; ref: (a: any) => string;
  autoStop: (a: any, code: string, customerId: number | null, from?: string) => void;
  fetchImpl?: (url: string, init: any) => Promise<{ ok: boolean; status: number }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, d: Record<string, unknown>) => void;
};

export function createBaleAutoreply(core: ArCore) {
  const { db, now } = core;
  const iso = (d = now()) => d.toISOString();
  const row = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).get(...p) as T | undefined;
  const rows = <T = any>(sql: string, ...p: any[]) => db.prepare(sql).all(...p) as T[];
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const since = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const S = (k: string) => core.setting(k) ?? AR_DEFAULT_SETTINGS[k];
  /** «آخرین تغییر» of the admin settings (hours, texts, holidays). */
  const settingMeta = () => row<any>(`SELECT s.updated_at, COALESCE(u.full_name, u.username) AS by FROM bale_settings s LEFT JOIN users u ON u.id=s.updated_by_user_id
    WHERE s.key IN ('autoreply_day_start','autoreply_day_end','autoreply_days','autoreply_hold_text','autoreply_night_text','autoreply_holidays') AND s.updated_by_user_id IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1`);
  const globalOn = () => S("autoreply_enabled") === "1";
  const extraWords = () => { try { const l = JSON.parse(S("autoreply_escalate_extra")); return Array.isArray(l) ? l.map(String).slice(0, 100) : []; } catch { return []; } };
  const escalation = (t: string) => arEscalation(t, extraWords());
  const inDay = (d = now()) => arInDay(d, S("autoreply_day_start"), S("autoreply_day_end"), S("autoreply_days"), S("autoreply_holidays"));
  const closedSince = (d = now()) => arClosedSince(d, S("autoreply_day_start"), S("autoreply_day_end"), S("autoreply_days"), S("autoreply_holidays"));
  let seeded = false;
  const seed = () => { if (!seeded) { seedArPairs(db, iso()); seeded = Boolean(row("SELECT 1 FROM bale_autoreply_pairs LIMIT 1")); } };

  /* ---------------- pairs ---------------- */
  const PAIR_SQL = `SELECT p.*, s.display_name, s.enabled AS asst_enabled, s.bound_user_id, s.bound_salesperson_id, s.kind AS asst_kind
    FROM bale_autoreply_pairs p JOIN assistants s ON s.id=p.assistant_id`;
  const asstReady = () => Boolean(row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistants'"));
  function pairs(): any[] { if (!asstReady()) return []; seed(); return rows<any>(`${PAIR_SQL} ORDER BY CASE p.slug WHEN 'masoud' THEN 0 WHEN 'somayeh' THEN 1 ELSE 2 END, p.assistant_id`); }
  /** The pair for an expert account; locked: the assistant must still be bound to that same expert. */
  function pairOfAccount(a: any): any | undefined {
    if (!a || !asstReady()) return undefined; seed();
    return row<any>(`${PAIR_SQL} WHERE p.expert_user_id=? AND s.bound_user_id=p.expert_user_id AND s.kind='sales' ORDER BY p.assistant_id LIMIT 1`, a.user_id);
  }
  function pairOfAssistant(asstId: number): any | undefined { if (!asstReady()) return undefined; seed(); return row<any>(`${PAIR_SQL} WHERE p.assistant_id=? AND s.bound_user_id=p.expert_user_id AND s.kind='sales'`, asstId); }
  const pairOn = (p: any) => Boolean(p && globalOn() && p.enabled === 1 && p.asst_enabled === 1 && !p.stopped_reason);
  const accountReady = (a: any) => Boolean(a && a.status === "connected" && a.session_ct && core.masterOn() && core.liveState(a) !== "down");
  /** True when an auto-reply may be considered at all for this account (mode deliberately ignored). */
  const activeFor = (a: any) => { const p = pairOfAccount(a); return pairOn(p) && accountReady(a) ? p : null; };
  const readsOn = (p: any) => Boolean(p && p.asst_enabled === 1 && (p.reads_enabled === 1 || pairOn(p)));

  /* ---------------- owner (takeover) ---------------- */
  function ownerOf(a: any, t: ArTarget): { owner: "assistant" | "expert"; reason: string | null; by: number | null; at: string | null; nightAt: string | null } {
    if (t.chatId != null) { const c = row<any>("SELECT * FROM bale_ar_chats WHERE id=? AND account_id=?", t.chatId, a.id); return { owner: c?.owner === "expert" ? "expert" : "assistant", reason: c?.owner_reason ?? null, by: c?.owner_by ?? null, at: c?.owner_at ?? null, nightAt: c?.night_at ?? null }; }
    const s = row<any>("SELECT ar_owner, ar_reason, ar_by, ar_at, ar_night_at FROM bale_conversation_state WHERE account_id=? AND customer_id=?", a.id, t.customerId);
    return { owner: s?.ar_owner === "expert" ? "expert" : "assistant", reason: s?.ar_reason ?? null, by: s?.ar_by ?? null, at: s?.ar_at ?? null, nightAt: s?.ar_night_at ?? null };
  }
  /** Hand the conversation to the expert (or back). Handing to the expert cancels every pending / queued auto or assistant row. */
  function setOwner(a: any, t: ArTarget, owner: "assistant" | "expert", reason: string, by: number | null): number {
    const at = iso(); let cancelled = 0;
    if (t.chatId != null) {
      run("UPDATE bale_ar_chats SET owner=?, owner_reason=?, owner_by=?, owner_at=? WHERE id=? AND account_id=?", owner, reason, by, at, t.chatId, a.id);
      if (owner === "expert") cancelled = Number(run("UPDATE bale_ar_messages SET status='cancelled', block_reason='human_mode', updated_at=? WHERE chat_id=? AND status='queued' AND source='auto_reply'", at, t.chatId).changes);
    } else {
      run(`INSERT INTO bale_conversation_state(customer_id,account_id,mode,updated_at,ar_owner,ar_reason,ar_by,ar_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(customer_id,account_id) DO UPDATE SET ar_owner=excluded.ar_owner, ar_reason=excluded.ar_reason, ar_by=excluded.ar_by, ar_at=excluded.ar_at, updated_at=excluded.updated_at`,
        t.customerId, a.id, owner === "expert" ? "human" : "assistant", at, owner, reason, by, at);
      if (owner === "expert") cancelled = Number(run(`UPDATE bale_outbox SET status='cancelled', block_reason='human_mode', updated_at=? WHERE account_id=? AND customer_id=?
        AND status IN ('pending_approval','queued') AND source IN ('auto_reply','assistant')`, at, a.id, t.customerId).changes);
    }
    core.audit({ u: by ? core.userRow(by) : undefined, accountId: a.id, customerId: t.customerId ?? null, action: owner === "expert" ? "autoreply.takeover" : "autoreply.giveback",
      outcome: reason.slice(0, 40), detail: { chatId: t.chatId ?? null, cancelled } });
    return cancelled;
  }

  /* ---------------- conversation facts ---------------- */
  type Facts = { lastIn: { id: number; at: string; text: string | null } | null; humanAfter: boolean; autoTexts: number; autoFiles: number; autoAny: number };
  function facts(a: any, t: ArTarget): Facts {
    if (t.chatId != null) {
      const li = row<any>("SELECT id, created_at, text FROM bale_ar_messages WHERE chat_id=? AND direction='in' ORDER BY id DESC LIMIT 1", t.chatId);
      if (!li) return { lastIn: null, humanAfter: false, autoTexts: 0, autoFiles: 0, autoAny: 0 };
      const humanAfter = Boolean(row("SELECT 1 FROM bale_ar_messages WHERE chat_id=? AND direction='out' AND source='expert' AND id>?", t.chatId, li.id));
      const c = row<any>(`SELECT SUM(CASE WHEN attachment_id IS NULL THEN 1 ELSE 0 END) t, SUM(CASE WHEN attachment_id IS NOT NULL THEN 1 ELSE 0 END) f FROM bale_ar_messages
        WHERE chat_id=? AND source='auto_reply' AND reply_to=? AND status IN ('queued','sending','sent')`, t.chatId, li.id);
      return { lastIn: { id: li.id, at: li.created_at, text: li.text }, humanAfter, autoTexts: Number(c?.t ?? 0), autoFiles: Number(c?.f ?? 0), autoAny: Number(c?.t ?? 0) + Number(c?.f ?? 0) };
    }
    const li = row<any>("SELECT id, created_at, text FROM bale_messages WHERE account_id=? AND customer_id=? AND direction='in' ORDER BY id DESC LIMIT 1", a.id, t.customerId);
    if (!li) return { lastIn: null, humanAfter: false, autoTexts: 0, autoFiles: 0, autoAny: 0 };
    // A human reply = any 'out' row after it that is not one of our auto_reply sends (CRM «بفرست», reminder, assistant draft, Bale app).
    const humanAfter = Boolean(row(`SELECT 1 FROM bale_messages m LEFT JOIN bale_outbox o ON o.id=m.outbox_id WHERE m.account_id=? AND m.customer_id=? AND m.direction='out'
      AND m.id>? AND COALESCE(o.source,'')<>'auto_reply'`, a.id, t.customerId, li.id));
    const c = row<any>(`SELECT SUM(CASE WHEN attachment_id IS NULL THEN 1 ELSE 0 END) t, SUM(CASE WHEN attachment_id IS NOT NULL THEN 1 ELSE 0 END) f FROM bale_outbox
      WHERE account_id=? AND customer_id=? AND source='auto_reply' AND reply_to_msg_id=? AND status IN ('queued','sending','sent')`, a.id, t.customerId, li.id);
    return { lastIn: { id: li.id, at: li.created_at, text: li.text }, humanAfter, autoTexts: Number(c?.t ?? 0), autoFiles: Number(c?.f ?? 0), autoAny: Number(c?.t ?? 0) + Number(c?.f ?? 0) };
  }
  /** Auto sends of this pair (both tables) in the window; stage enqueue also counts queued rows. */
  function pairSent(a: any, ms: number, withQueued: boolean): number {
    const st = withQueued ? "('sent','sending','queued')" : "('sent','sending')";
    return Number(row<any>(`SELECT count(*) n FROM bale_outbox WHERE account_id=? AND source='auto_reply' AND status IN ${st} AND COALESCE(sent_at,updated_at)>?`, a.id, since(ms))?.n ?? 0)
      + Number(row<any>(`SELECT count(*) n FROM bale_ar_messages WHERE account_id=? AND source='auto_reply' AND status IN ${st} AND COALESCE(sent_at,updated_at)>?`, a.id, since(ms))?.n ?? 0);
  }
  /** Unknown-chat sends that count toward the ACCOUNT caps (bale_outbox counts the rest in lib/bale-outbox.ts). */
  const arSentSince = (accountId: number, ms: number) => Number(row<any>("SELECT count(*) n FROM bale_ar_messages WHERE account_id=? AND direction='out' AND source='auto_reply' AND status IN ('sent','sending') AND COALESCE(sent_at,updated_at)>?", accountId, since(ms))?.n ?? 0);
  const arQueued = (accountId: number) => Number(row<any>("SELECT count(*) n FROM bale_ar_messages WHERE account_id=? AND status='queued'", accountId)?.n ?? 0);

  /**
   * Auto-reply rules shared by both conversation kinds (the generic checks — master, connection, scope, text filters, account caps —
   * are done by the caller). kind: reply (runner text) | plan (runner plan file) | hold (server, after escalation) | night (server).
   */
  function rules(a: any, p: any, t: ArTarget, o: { kind: "reply" | "plan" | "hold" | "night"; stage: "enqueue" | "send"; replyTo?: number | null; rawText?: string; selfId?: number }): ArBlock | null {
    if (!pairOn(p)) return "autoreply_off";
    if (t.chatId != null && p.allow_unknown !== 1) return "unknown_off";
    if (o.kind === "plan" && (p.allow_plan_file !== 1 || !core.attachmentsOn())) return "plan_file_off";
    const own = ownerOf(a, t);
    // Escalated conversations still get the one holding / after-hours text (no content); a human takeover silences everything.
    if (own.owner === "expert" && !((o.kind === "hold" || o.kind === "night") && String(own.reason ?? "").startsWith("escalated"))) return "human_mode";
    const f = facts(a, t);
    if (!f.lastIn) return "not_a_reply";
    // «برگردون به مسعود»: Masoud answers only from the customer's NEXT message (nothing older than the give-back).
    if (own.reason === "expert_giveback" && own.at && f.lastIn.at <= own.at && o.kind !== "hold") return "not_a_reply";
    if (f.humanAfter) return "human_replied";
    if (o.stage === "enqueue") {
      if (Date.parse(f.lastIn.at) < now().getTime() - Math.max(5, Number(p.reply_window_min) || AR_REPLY_WINDOW_MIN) * 60_000) return "reply_window";
      if ((o.kind === "reply" || o.kind === "plan") && !inDay()) return "after_hours";
      if (o.kind === "night" || o.kind === "hold" ? f.autoAny > 0 : o.kind === "plan" ? f.autoFiles > 0 : f.autoTexts > 0) return "already_replied";
      if (o.kind === "reply" || o.kind === "plan") {
        const raw = String(o.rawText ?? "");
        if (arVoice(raw).problem) return "signature";
        if (escalation(raw)) return "escalated";
      }
    }
    if (pairSent(a, 86_400_000, o.stage === "enqueue") >= Math.max(1, Number(p.per_day) || 40)) return "cap_pair_day";
    if (pairSent(a, 3_600_000, o.stage === "enqueue") >= Math.max(1, Number(p.per_hour) || 10)) return "cap_pair_hour";
    return null;
  }

  /* ---------------- escalation / takeover side effects ---------------- */
  function escalate(a: any, p: any, t: ArTarget, kind: EscKind, from: "inbound" | "draft") {
    setOwner(a, t, "expert", `escalated:${kind}:${from}`, null);
    const title = "گفتگو به شما سپرده شد";
    const body = `${p.display_name ?? "دستیار"} جواب نداد: ${AR_ESC_FA[kind]}. خودتان جواب بدهید.`;
    if (t.customerId != null) core.bell(a.user_id, t.customerId, "bale-escalated", title, body); else core.bellNoCustomer(a.user_id, `${title} (ناشناس)`, body);
    core.audit({ accountId: a.id, customerId: t.customerId ?? null, action: "autoreply.escalate", outcome: kind, detail: { from, chatId: t.chatId ?? null } });
  }

  /* ---------------- unknown chats (no CRM customer) ---------------- */
  /** Inbound from a peer that matched no customer. Stored ONLY while the pair is ON with allow_unknown; text + peer id, never a phone. */
  function inboundUnknown(a: any, ev: { messageId: string; peerId: string; text: string | null; hasFile: boolean; fromSelf: boolean; at: string }): { stored: boolean; chatId?: number; messageId?: number; escalated?: string | null; night?: boolean } {
    const p = activeFor(a); if (!p || p.allow_unknown !== 1) return { stored: false };
    const t = iso();
    let c = row<any>("SELECT * FROM bale_ar_chats WHERE account_id=? AND peer_id=?", a.id, ev.peerId);
    if (!c) {
      if (ev.fromSelf) return { stored: false }; // never start a stored chat from our own side
      const id = Number(run("INSERT INTO bale_ar_chats(account_id,peer_id,first_at,last_at) VALUES(?,?,?,?)", a.id, ev.peerId, ev.at, ev.at).lastInsertRowid);
      c = row<any>("SELECT * FROM bale_ar_chats WHERE id=?", id);
    }
    const dir = ev.fromSelf ? "out" : "in";
    const ins = run(`INSERT INTO bale_ar_messages(chat_id,account_id,direction,source,text,has_file,status,bale_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,bale_msg_id) DO NOTHING`, c.id, a.id, dir, dir === "in" ? "customer" : "expert", ev.text, ev.hasFile ? 1 : 0, dir === "in" ? "received" : "external", ev.messageId, ev.at, t);
    if (ins.changes !== 1) return { stored: false }; // duplicate or the echo of our own send
    run("UPDATE bale_ar_chats SET last_at=? WHERE id=?", ev.at, c.id);
    const target: ArTarget = { chatId: c.id };
    if (dir === "out") { // PM: the expert wrote from the Bale app → the conversation is his; no automatic return.
      if (c.owner !== "expert") setOwner(a, target, "expert", "expert_app_reply", a.user_id);
      return { stored: true, chatId: c.id, messageId: Number(ins.lastInsertRowid) };
    }
    core.audit({ accountId: a.id, action: "autoreply.unknown_inbound", outcome: "stored", detail: { chatId: c.id, hasFile: ev.hasFile } });
    const r = afterInbound(a, p, target, ev.text);
    return { stored: true, chatId: c.id, messageId: Number(ins.lastInsertRowid), ...r };
  }
  /** Shared by both kinds after a customer message is stored: escalation → hold text; closed hours → night text. */
  function afterInbound(a: any, p: any, t: ArTarget, text: string | null): { escalated: string | null; night: boolean } {
    if (!pairOn(p)) return { escalated: null, night: false };
    const own = ownerOf(a, t);
    if (own.owner === "expert") return { escalated: null, night: false };
    const k = text ? escalation(text) : null;
    const open = inDay();
    if (k) { escalate(a, p, t, k, "inbound"); serverReply(a, p, t, open ? "hold" : "night"); return { escalated: k, night: !open }; }
    if (!open) { const r = serverReply(a, p, t, "night"); return { escalated: null, night: r === "queued" }; }
    return { escalated: null, night: false };
  }
  /** Server-generated text (hold / night). Night: once per conversation per closed window. Goes through the same send path. */
  function serverReply(a: any, p: any, t: ArTarget, kind: "hold" | "night"): string {
    if (kind === "night") {
      const own = ownerOf(a, t);
      if (own.nightAt && own.nightAt >= iso(closedSince())) return "night_already_sent";
    }
    const text = kind === "hold" ? S("autoreply_hold_text") : S("autoreply_night_text");
    const r = t.chatId != null ? enqueueUnknown(a, p, t.chatId, text, { kind }) : core_enqueueMatched?.(a, p, t.customerId!, text, kind) ?? "no_outbox";
    if (r === "queued" && kind === "night") {
      if (t.chatId != null) run("UPDATE bale_ar_chats SET night_at=? WHERE id=?", iso(), t.chatId);
      else run(`INSERT INTO bale_conversation_state(customer_id,account_id,mode,updated_at,ar_night_at) VALUES(?,?,'assistant',?,?)
        ON CONFLICT(customer_id,account_id) DO UPDATE SET ar_night_at=excluded.ar_night_at`, t.customerId, a.id, iso(), iso());
    }
    return r;
  }
  /** Injected by lib/bale-outbox.ts (matched customers go through bale_outbox and its full check()). */
  let core_enqueueMatched: ((a: any, p: any, customerId: number, text: string, kind: "hold" | "night") => string) | null = null;
  const bindOutbox = (fn: typeof core_enqueueMatched) => { core_enqueueMatched = fn; };

  /** Enqueue a reply in an unknown chat (runner reply / plan, or server hold / night). Returns "queued" or a block reason. */
  function enqueueUnknown(a: any, p: any, chatId: number, text: string, o: { kind: "reply" | "plan" | "hold" | "night"; attachmentId?: number | null; assistantId?: number | null }): string {
    const t = iso(); const target: ArTarget = { chatId };
    const block = (reason: string) => { core.audit({ accountId: a.id, action: `autoreply.unknown_${o.kind}`, outcome: `blocked:${reason}`, detail: { chatId } }); return reason; };
    if (!core.masterOn()) return block("bale_disabled");
    if (!a || a.status !== "connected" || !a.session_ct) return block("not_connected");
    if (core.liveState(a) === "down") return block("session_not_live");
    if (!row("SELECT 1 FROM bale_ar_chats WHERE id=? AND account_id=?", chatId, a.id)) return block("unknown_off");
    const raw = String(text ?? "");
    const voiced = o.kind === "reply" || o.kind === "plan" ? arVoice(raw).text : raw.trim();
    const body = o.kind === "plan" ? planCaption(voiced) : voiced;
    const tp = core.textProblem(body); if (tp) return block(tp);
    if (o.kind === "plan") { const f = o.attachmentId != null ? core.planFiles?.byId(o.attachmentId) : null; if (!f || f.status !== "active" || !core.planFiles!.read(f)) return block("attachment_missing"); }
    const r = rules(a, p, target, { kind: o.kind, stage: "enqueue", rawText: raw });
    if (r) {
      if (r === "escalated") { const k = escalation(raw); if (k) escalate(a, p, target, k, "draft"); serverReply(a, p, target, inDay() ? "hold" : "night"); }
      return block(r);
    }
    if (row("SELECT 1 FROM bale_ar_messages WHERE chat_id=? AND status IN ('queued','sending')", chatId)) return block("already_pending");
    if (accountCapHit(a, true)) return block("cap_day");
    const f = facts(a, target);
    const id = Number(run(`INSERT INTO bale_ar_messages(chat_id,account_id,direction,source,ar_kind,text,has_file,attachment_id,reply_to,assistant_id,status,created_at,updated_at)
      VALUES(?,?,'out','auto_reply',?,?,?,?,?,?,'queued',?,?)`, chatId, a.id, o.kind, body, o.attachmentId != null ? 1 : 0, o.attachmentId ?? null, f.lastIn?.id ?? null, o.assistantId ?? p.assistant_id, t, t).lastInsertRowid);
    core.audit({ accountId: a.id, action: `autoreply.unknown_${o.kind}`, outcome: "queued", detail: { chatId, arMessageId: id } });
    return "queued";
  }
  let accountCapHit: (a: any, withQueued: boolean) => boolean = () => false;
  let planCaption: (s: string) => string = s => s;
  const bindAccountCaps = (fn: typeof accountCapHit, caption: typeof planCaption) => { accountCapHit = fn; planCaption = caption; };

  /** Worker: one unknown-chat send for this account (called when bale_outbox had nothing due). Same gap / errors / auto-stop. */
  async function sendOneUnknown(a: any): Promise<string> {
    const m = row<any>("SELECT * FROM bale_ar_messages WHERE account_id=? AND status='queued' ORDER BY id LIMIT 1", a.id);
    if (!m) return "idle";
    const block = (reason: string) => { run("UPDATE bale_ar_messages SET status='blocked', block_reason=?, updated_at=? WHERE id=?", reason, iso(), m.id);
      core.audit({ accountId: a.id, action: "autoreply.unknown_send", outcome: `blocked:${reason}`, detail: { arMessageId: m.id } }); return `blocked:${reason}`; };
    const p = pairOfAccount(a);
    if (!core.masterOn()) return block("bale_disabled");
    if (a.status !== "connected" || !a.session_ct) return block("not_connected");
    if (core.liveState(a) === "down") return block("session_not_live");
    const r = rules(a, p, { chatId: m.chat_id }, { kind: m.ar_kind ?? "reply", stage: "send", replyTo: m.reply_to });
    if (r) return block(r);
    if (accountCapHit(a, false)) return block("cap_day");
    const chat = row<any>("SELECT * FROM bale_ar_chats WHERE id=?", m.chat_id);
    if (!chat) return block("unknown_off");
    let file: { row: any; bytes: Buffer } | null = null;
    if (m.attachment_id != null) {
      const f = core.planFiles?.byId(m.attachment_id); const bytes = f && f.status === "active" ? core.planFiles!.read(f) : null;
      if (!f || !bytes) return block("attachment_missing");
      file = { row: f, bytes };
    }
    if (run("UPDATE bale_ar_messages SET status='sending', attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'", iso(), m.id).changes !== 1) return "raced";
    const deliver = () => file
      ? core.sidecar.sendFile({ accountRef: core.ref(a), phone: "", peerId: chat.peer_id, caption: m.text, fileName: file.row.display_name, mime: file.row.mime, fileB64: file.bytes.toString("base64"), sha256: file.row.sha256, typingMs: 1500 })
      : core.sidecar.send({ accountRef: core.ref(a), phone: "", peerId: chat.peer_id, text: m.text, typingMs: Math.min(8000, 1200 + String(m.text).length * 50) });
    try {
      let out;
      try { out = await deliver(); }
      catch (e: any) { if (e?.code !== "not_attached" || !(await core.attachOne(a))) throw e; out = await deliver(); }
      const t = iso();
      run("UPDATE bale_ar_messages SET status='sent', sent_at=?, bale_msg_id=?, error=NULL, updated_at=? WHERE id=?", t, out.messageId, t, m.id);
      run("UPDATE bale_accounts SET next_send_at=?, last_seen_at=? WHERE id=?", new Date(now().getTime() + core.gapMs()).toISOString(), t, a.id);
      core.audit({ accountId: a.id, action: "autoreply.unknown_send", outcome: "sent", detail: { arMessageId: m.id, kind: m.ar_kind ?? "reply" } });
      return "sent";
    } catch (e: any) {
      const code = typeof e?.code === "string" ? e.code : "error"; const t = iso();
      run("UPDATE bale_ar_messages SET status='failed', error=?, updated_at=? WHERE id=?", code, t, m.id);
      if (code === "peer_blocked") core.autoStop(a, "account_banned", null, "peer_blocked");
      else if (["rate_limited", "account_banned", "session_invalid"].includes(code)) core.autoStop(a, code, null);
      core.audit({ accountId: a.id, action: "autoreply.unknown_send", outcome: code, detail: { arMessageId: m.id } });
      return `error:${code}`;
    }
  }

  /** Auto-stop hook: every pair of this expert goes OFF with the reason; queued unknown-chat rows are blocked. */
  function onAutoStop(a: any, code: string) {
    const t = iso();
    run("UPDATE bale_autoreply_pairs SET enabled=0, stopped_reason=?, updated_at=? WHERE expert_user_id=?", code, t, a.user_id);
    run("UPDATE bale_ar_messages SET status='blocked', block_reason='auto_stopped', updated_at=? WHERE account_id=? AND status='queued'", t, a.id);
  }

  /** Backlog rule (PM): unanswered customer messages older than the window are handed to the expert once (no reply is sent). */
  let lastSweep = 0;
  function sweep(force = false): number {
    if (!force && now().getTime() - lastSweep < 60_000) return 0;
    lastSweep = now().getTime(); let n = 0;
    for (const p of pairs()) {
      if (!pairOn(p)) continue;
      const a = row<any>("SELECT * FROM bale_accounts WHERE user_id=? AND kind<>'system_test'", p.expert_user_id); if (!a) continue;
      const cut = since(Math.max(5, Number(p.reply_window_min) || AR_REPLY_WINDOW_MIN) * 60_000);
      const lo = since(7 * 86_400_000);
      for (const c of rows<any>(`SELECT customer_id, MAX(id) mid FROM bale_messages WHERE account_id=? AND created_at>? GROUP BY customer_id`, a.id, lo)) {
        const last = row<any>("SELECT * FROM bale_messages WHERE id=?", c.mid);
        if (!last || last.direction !== "in" || last.created_at >= cut) continue;
        const t: ArTarget = { customerId: c.customer_id };
        if (ownerOf(a, t).owner === "expert") continue;
        if (facts(a, t).autoAny > 0) continue;
        setOwner(a, t, "expert", "stale_backlog", null); n++;
        core.bell(a.user_id, c.customer_id, "bale-escalated", "پیام بی‌جواب قدیمی به شما سپرده شد", "این پیام بیش از ۲۴ ساعت بی‌جواب مانده؛ مسعود به آن جواب نمی‌دهد.");
      }
      for (const c of rows<any>("SELECT * FROM bale_ar_chats WHERE account_id=? AND owner='assistant' AND last_at>?", a.id, lo)) {
        const last = row<any>("SELECT * FROM bale_ar_messages WHERE chat_id=? AND status NOT IN ('blocked','cancelled','failed') ORDER BY id DESC LIMIT 1", c.id);
        if (!last || last.direction !== "in" || last.created_at >= cut) continue;
        setOwner(a, { chatId: c.id }, "expert", "stale_backlog", null); n++;
        core.bellNoCustomer(a.user_id, "پیام بی‌جواب قدیمی (ناشناس) به شما سپرده شد", "این پیام بیش از ۲۴ ساعت بی‌جواب مانده؛ مسعود به آن جواب نمی‌دهد.");
      }
    }
    return n;
  }

  /* ---------------- wake webhook (optional; both env vars unset by default) ---------------- */
  function wakeConfig(): { url: string; key: string } | null {
    const env = core.env(); const url = String(env.BALE_AUTOREPLY_WAKE_URL ?? "").trim(); const key = String(env.BALE_AUTOREPLY_WAKE_KEY ?? "").trim();
    if (!url || !key) return null;
    try {
      const u = new URL(url);
      const loop = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
      if (!(u.protocol === "https:" || (u.protocol === "http:" && loop))) return null;
    } catch { return null; }
    return { url, key };
  }
  /** Fire-and-forget; retries 0 s / 2 s / 8 s / 30 s. Logs eventId, pair, attempt and status only — never the URL, key or any text. */
  async function wake(eventId: number, pair: string): Promise<{ ok: boolean; attempts: number } | null> {
    const cfg = wakeConfig(); if (!cfg) return null;
    const f = core.fetchImpl ?? ((u: string, i: any) => fetch(u, i));
    const sleep = core.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
    const log = core.log ?? ((m: string, d: Record<string, unknown>) => console.info(m, JSON.stringify(d)));
    let attempts = 0;
    for (const d of AR_WAKE_DELAYS_MS) {
      if (d) await sleep(d);
      attempts++;
      try {
        const r = await f(cfg.url, { method: "POST", headers: { "content-type": "application/json", "x-autoreply-wake-key": cfg.key }, body: JSON.stringify({ eventId, pair }), signal: AbortSignal.timeout(5000) });
        log("bale autoreply wake", { eventId, pair, attempt: attempts, status: r.status });
        if (r.ok) return { ok: true, attempts };
      } catch (e) { log("bale autoreply wake", { eventId, pair, attempt: attempts, status: (e as Error)?.name ?? "error" }); }
    }
    return { ok: false, attempts };
  }

  /* ---------------- views ---------------- */
  const label = (p: any) => `${p?.display_name ?? "دستیار"} (خودکار)`;
  function pairView(p: any) {
    const a = row<any>("SELECT * FROM bale_accounts WHERE user_id=? AND kind<>'system_test'", p.expert_user_id);
    const exp = core.userRow(p.expert_user_id);
    const cnt = (sql: string, ...x: any[]) => Number(row<any>(sql, ...x)?.n ?? 0);
    return {
      assistantId: p.assistant_id, slug: p.slug, assistantName: p.display_name, label: label(p), expertUserId: p.expert_user_id, expertName: core.nameOf(exp),
      enabled: p.enabled === 1, active: Boolean(pairOn(p) && accountReady(a)), readsEnabled: p.reads_enabled === 1, allowUnknown: p.allow_unknown === 1, allowPlanFile: p.allow_plan_file === 1,
      perHour: Number(p.per_hour), perDay: Number(p.per_day), replyWindowMin: Number(p.reply_window_min), stoppedReason: p.stopped_reason ?? null,
      updatedAt: p.updated_at, updatedBy: p.updated_by ? core.nameOf(core.userRow(p.updated_by)) : null,
      account: a ? { status: a.status, session: a.status === "connected" ? core.liveState(a) : null, mode: a.mode } : null,
      sentLastHour: a ? pairSent(a, 3_600_000, false) : 0, sentToday: a ? pairSent(a, 86_400_000, false) : 0,
      handedToExpert: a ? cnt("SELECT count(*) n FROM bale_conversation_state WHERE account_id=? AND ar_owner='expert'", a.id) + cnt("SELECT count(*) n FROM bale_ar_chats WHERE account_id=? AND owner='expert'", a.id) : 0,
      unknownChats: a ? cnt("SELECT count(*) n FROM bale_ar_chats WHERE account_id=?", a.id) : 0,
    };
  }
  function settingsView() {
    return { globalEnabled: globalOn(), dayStart: S("autoreply_day_start"), dayEnd: S("autoreply_day_end"), days: [...arParseDays(S("autoreply_days"))].sort(),
      holdText: S("autoreply_hold_text"), nightText: S("autoreply_night_text"), holidays: arParseHolidays(S("autoreply_holidays")),
      openNow: inDay(), wakeConfigured: Boolean(wakeConfig()), updatedAt: settingMeta()?.updated_at ?? null, updatedBy: settingMeta()?.by ?? null };
  }
  /** Conversation list for the live view (expert own account / admin read-only). Names come from the CRM only for matched customers. */
  function liveList(a: any, p: any, limit = 60) {
    const lo = since(14 * 86_400_000);
    const matched = rows<any>(`SELECT m.customer_id, MAX(m.id) mid FROM bale_messages m WHERE m.account_id=? AND m.created_at>? GROUP BY m.customer_id ORDER BY mid DESC LIMIT ?`, a.id, lo, limit)
      .map(x => {
        const last = row<any>("SELECT m.*, o.source, o.ar_kind FROM bale_messages m LEFT JOIN bale_outbox o ON o.id=m.outbox_id WHERE m.id=?", x.mid);
        const c = row<any>("SELECT id, name FROM customers WHERE id=?", x.customer_id);
        const own = ownerOf(a, { customerId: x.customer_id });
        const failed = row<any>("SELECT id FROM bale_outbox WHERE account_id=? AND customer_id=? AND source='auto_reply' AND status IN ('failed','blocked') AND updated_at>? ORDER BY id DESC LIMIT 1", a.id, x.customer_id, since(86_400_000));
        return { kind: "customer" as const, id: x.customer_id, customerId: x.customer_id, name: c?.name ?? null, lastAt: last?.created_at, lastText: last?.text ?? (last?.file_ref ? "فایل" : ""),
          lastDirection: last?.direction, lastBy: last?.direction === "in" ? "customer" : last?.source === "auto_reply" ? "assistant" : "expert", lastKind: last?.ar_kind ?? null,
          owner: own.owner, ownerReason: own.reason, failed: Boolean(failed && last?.direction === "in") };
      });
    const unknown = p && p.allow_unknown === 1 ? rows<any>("SELECT * FROM bale_ar_chats WHERE account_id=? AND last_at>? ORDER BY last_at DESC LIMIT ?", a.id, lo, limit).map(c => {
      const last = row<any>("SELECT * FROM bale_ar_messages WHERE chat_id=? AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 1", c.id);
      return { kind: "unknown" as const, id: c.id, customerId: null, name: null, label: "ناشناس", lastAt: last?.created_at ?? c.last_at, lastText: last?.text ?? (last?.has_file ? "فایل" : ""),
        lastDirection: last?.direction, lastBy: last?.direction === "in" ? "customer" : last?.source === "auto_reply" ? "assistant" : "expert", lastKind: last?.ar_kind ?? null,
        owner: c.owner, ownerReason: c.owner_reason, failed: last?.status === "failed" || last?.status === "blocked" };
    }) : [];
    const all = [...matched, ...unknown].map(x => ({ ...x, state: x.owner === "expert" ? (String(x.ownerReason ?? "").startsWith("escalated") || x.ownerReason === "stale_backlog" ? "needs_expert" : "expert") : x.failed ? "failed"
      : x.lastBy === "assistant" && x.lastKind === "night" ? "waiting" : x.lastBy === "customer" ? "unanswered" : "assistant" }));
    const rank = (s: string) => s === "needs_expert" ? 0 : s === "failed" ? 1 : 2;
    return all.sort((x, y) => rank(x.state) - rank(y.state) || String(y.lastAt).localeCompare(String(x.lastAt))).slice(0, limit);
  }
  function unknownMessages(a: any, chatId: number) {
    const c = row<any>("SELECT * FROM bale_ar_chats WHERE id=? AND account_id=?", chatId, a.id); if (!c) return null;
    const p = pairOfAccount(a);
    return { id: c.id, label: "ناشناس", owner: c.owner, ownerReason: c.owner_reason, ownerAt: c.owner_at, firstAt: c.first_at, lastAt: c.last_at,
      messages: rows<any>("SELECT * FROM bale_ar_messages WHERE chat_id=? ORDER BY id DESC LIMIT 200", c.id).reverse().map(m => ({ id: m.id, direction: m.direction, text: m.text, hasFile: Boolean(m.has_file || m.attachment_id),
        status: m.status, kind: m.ar_kind ?? null, by: m.direction === "in" ? "customer" : m.source === "auto_reply" ? "assistant" : "expert",
        byLabel: m.direction === "in" ? "ناشناس" : m.source === "auto_reply" ? label(p) : core.nameOf(core.userRow(a.user_id)), blockReason: m.block_reason ?? null, createdAt: m.created_at })) };
  }

  return { globalOn, pairs, pairOfAccount, pairOfAssistant, pairOn, activeFor, readsOn, ownerOf, setOwner, facts, rules, escalate, escalation, afterInbound, serverReply,
    inboundUnknown, enqueueUnknown, sendOneUnknown, onAutoStop, sweep, wake, wakeConfig, arSentSince, arQueued, pairView, settingsView, liveList, unknownMessages, label, inDay,
    bindOutbox, bindAccountCaps, maskPreview: (t: string | null) => maskText(t ?? "").replace(/\s+/g, " ").slice(0, 500) };
}
export type BaleAutoreply = ReturnType<typeof createBaleAutoreply>;

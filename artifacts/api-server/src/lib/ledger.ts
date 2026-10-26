/**
 * General ledger — package G1 (2026-10-26): SCHEMA ONLY.
 *
 * Additive: creates new gl_* / treasury / bank-statement tables, their integrity triggers and indexes,
 * seeds the chart of accounts and gl_settings (every flag OFF), and records schema_migrations
 * 'general-ledger-v1'. Nothing in the app writes to these tables yet (no posting hooks, no routes,
 * no notifications, no SMS). Existing tables, triggers and the payment-order trigger are untouched.
 *
 * Rules fixed with finance (Salamatian) and the PM:
 *  - every GL amount is INTEGER RIAL (`*_rial`, typeof integer enforced); toman is display-only.
 *  - percentages round to the nearest rial; any rounding remainder is ONE line of the same voucher on
 *    6203 «اختلاف گرد کردن» so the voucher itself balances.
 *  - numbering: `temp_no` (per fiscal year, at posting) + permanent `ref_no` (UNIQUE, never changes);
 *    the FINAL number (final_period + final_seq, gapless, in event_date order) is written once, only at
 *    month close and only inside an already locked period.
 *  - a voucher is immutable: only the final number may be set once; status lives in side tables.
 *  - the opening voucher carries control-account totals only (enforced later in G2/W2, not here).
 */
import type { DatabaseSync } from "node:sqlite";

export const LEDGER_MIGRATION = "general-ledger-v1";

/** Flags read by later packages. All OFF. Changed only by a release, never from a page. */
export const GL_FLAG_DEFAULTS: Readonly<Record<string, "0">> = Object.freeze({
  "gl.shadow_nonbank": "0", // G3: shadow posting of non-bank events
  "gl.shadow_bank": "0", // G4: shadow posting of bank payments via the queue (never blocks /pay)
  "gl.bank_blocking": "0", // after a clean one-month parallel run only
});

type Acc = [code: string, title: string, category: string, nature: "debit" | "credit" | "both", tafsili: string, active: 0 | 1, note?: string];
const KOL: Array<[string, string, string, "debit" | "credit" | "both"]> = [
  ["11", "موجودی نقد", "asset", "debit"], ["12", "دریافتنی‌ها", "asset", "debit"],
  ["21", "پرداختنی‌ها", "liability", "credit"], ["22", "وجوه مشتریان", "liability", "credit"],
  ["23", "مالیات", "liability", "credit"], ["31", "حقوق مالکانه", "equity", "credit"],
  ["41", "درآمد عملیاتی", "revenue", "credit"], ["49", "سایر درآمدها", "revenue", "credit"],
  ["51", "بهای تمام‌شده", "cogs", "debit"], ["61", "هزینه‌های فروش", "expense", "debit"],
  ["62", "هزینه‌های عمومی", "expense", "debit"], ["81", "حساب‌های انتظامی", "memo", "both"],
];
const MOEIN: Acc[] = [
  ["1101", "صندوق (تنخواه نقدی)", "asset", "debit", "CB", 1],
  ["1102", "بانک‌ها", "asset", "debit", "BK", 1],
  ["1103", "وجوه در راه درگاه (زرین‌پال)", "asset", "debit", "GW", 1],
  ["1201", "دریافتنی از تأمین‌کنندگان اعتبار (سهم شرکت)", "asset", "debit", "FD,PL", 1],
  ["1202", "دریافتنی از مشتریان (هزینه‌ی استعلام)", "asset", "debit", "CU", 0, "پرسش باز؛ غیرفعال تا تصمیم"],
  ["1203", "پیش‌پرداخت به تأمین‌کنندگان خدمت", "asset", "debit", "VN", 1],
  ["1204", "علی‌الحساب کارکنان / پیش‌پرداخت پورسانت", "asset", "debit", "SP", 1],
  ["2101", "پرداختنی به مشتریان بابت خرید کالا", "liability", "credit", "CU", 1],
  ["2102", "پورسانت پرداختنی فروشندگان و بازاریابان", "liability", "credit", "SP", 1],
  ["2103", "پرداختنی به تأمین‌کنندگان خدمت", "liability", "credit", "VN", 1],
  ["2109", "سایر پرداختنی‌ها", "liability", "credit", "", 1],
  ["2201", "موجودی کیف نقدی مشتریان", "liability", "credit", "CU", 1],
  ["2301", "مالیات و عوارض ارزش افزوده", "liability", "credit", "", 0, "Q9؛ غیرفعال تا تصمیم"],
  ["3101", "سرمایه", "equity", "credit", "OW", 1],
  ["3102", "جاری شرکا / مالک (بدهی به مالک)", "equity", "both", "OW", 1],
  ["3103", "سود و زیان انباشته", "equity", "credit", "", 1],
  ["3104", "تراز افتتاحیه (حساب واسط)", "equity", "both", "", 1, "فقط سند افتتاحیه"],
  ["4101", "فروش کالای اعتباری", "revenue", "credit", "PL", 1],
  ["4102", "تخفیف توسعه (کاهنده‌ی فروش)", "contra_revenue", "debit", "PL", 1, "Q8 منتظر محمد"],
  ["4103", "درآمد هزینه‌ی تشکیل پرونده", "revenue", "credit", "PL", 1],
  ["4104", "درآمد استعلام اعتبار", "revenue", "credit", "", 0, "Q6؛ غیرفعال تا تصمیم"],
  ["4901", "سود حساب بانکی و سایر درآمدها", "revenue", "credit", "BK", 1],
  ["5101", "بهای تمام‌شده‌ی فروش اعتباری", "cogs", "debit", "PL", 1],
  ["6101", "هزینه‌ی پورسانت فروش", "expense", "debit", "SP", 1],
  ["6102", "پاداش دقت داده و پاداش تیمی", "expense", "debit", "SP", 1],
  ["6201", "هزینه‌ی استعلام اعتبار (ICS24)", "expense", "debit", "VN", 1, "ICS24 فعلاً بیرون از دفتر"],
  ["6202", "کارمزد درگاه و بانک", "expense", "debit", "GW,BK", 1],
  ["6203", "اختلاف گرد کردن (ریال)", "expense", "both", "", 1, "تنها یک ردیف در همان سند"],
  ["6209", "سایر هزینه‌ها", "expense", "debit", "", 1],
  ["8101", "اعتبار تخصیص‌یافته‌ی مشتریان (انتظامی)", "memo", "debit", "CU,PL", 1, "Q7 منتظر محمد"],
  ["8102", "طرف حساب انتظامی اعتبار تأمین‌کنندگان", "memo", "credit", "FD,PL", 1, "Q7 منتظر محمد"],
];

const INT_RIAL = (c: string, min: string) => `${c} INTEGER NOT NULL CHECK(typeof(${c})='integer' AND ${c} ${min})`;
const DATE_OK = (c: string) => `(${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS gl_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_user_id INTEGER);

CREATE TABLE IF NOT EXISTS gl_fiscal_years (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  start_date TEXT NOT NULL UNIQUE CHECK${DATE_OK("start_date")}, end_date TEXT NOT NULL CHECK${DATE_OK("end_date")},
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closing','closed')),
  locked_until TEXT CHECK(locked_until IS NULL OR ${DATE_OK("locked_until")}),
  created_at TEXT NOT NULL, CHECK(end_date > start_date));

CREATE TABLE IF NOT EXISTS gl_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE CHECK(code GLOB '[1-9][0-9]' OR code GLOB '[1-9][0-9][0-9][0-9]'),
  title TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('kol','moein')),
  parent_id INTEGER REFERENCES gl_accounts(id),
  category TEXT NOT NULL CHECK(category IN ('asset','liability','equity','revenue','contra_revenue','cogs','expense','memo')),
  nature TEXT NOT NULL CHECK(nature IN ('debit','credit','both')),
  tafsili_types TEXT NOT NULL DEFAULT '', postable INTEGER NOT NULL DEFAULT 0 CHECK(postable IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), note TEXT, created_at TEXT NOT NULL,
  CHECK((level='kol' AND length(code)=2 AND parent_id IS NULL AND postable=0) OR (level='moein' AND length(code)=4 AND parent_id IS NOT NULL)));

CREATE TABLE IF NOT EXISTS gl_tafsili (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('CU','SP','BK','CB','GW','FD','PL','VN','OW')),
  ref_id INTEGER, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, UNIQUE(type, ref_id));

CREATE TABLE IF NOT EXISTS gl_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_year_id INTEGER NOT NULL REFERENCES gl_fiscal_years(id),
  ref_no TEXT NOT NULL UNIQUE CHECK(length(ref_no) BETWEEN 4 AND 40),
  temp_no INTEGER NOT NULL CHECK(typeof(temp_no)='integer' AND temp_no > 0),
  final_period INTEGER CHECK(final_period IS NULL OR final_period BETWEEN 1 AND 12),
  final_seq INTEGER CHECK(final_seq IS NULL OR (typeof(final_seq)='integer' AND final_seq > 0)),
  finalized_at TEXT,
  event_date TEXT NOT NULL CHECK${DATE_OK("event_date")},
  kind TEXT NOT NULL CHECK(kind IN ('opening','auto','manual','reversal','closing','backfill')),
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT, source_id TEXT, source_key TEXT UNIQUE,
  reverses_voucher_id INTEGER UNIQUE REFERENCES gl_vouchers(id),
  ${INT_RIAL("total_rial", "> 0")},
  line_count INTEGER NOT NULL CHECK(line_count >= 2),
  created_by_user_id INTEGER, approved_by_user_id INTEGER,
  created_at TEXT NOT NULL,
  CHECK((final_period IS NULL) = (final_seq IS NULL)),
  CHECK((kind = 'reversal') = (reverses_voucher_id IS NOT NULL)),
  CHECK(approved_by_user_id IS NULL OR created_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id),
  UNIQUE(fiscal_year_id, temp_no), UNIQUE(fiscal_year_id, final_period, final_seq));

CREATE TABLE IF NOT EXISTS gl_voucher_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL REFERENCES gl_vouchers(id),
  line_no INTEGER NOT NULL CHECK(line_no > 0),
  account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
  tafsili_id INTEGER REFERENCES gl_tafsili(id), tafsili2_id INTEGER REFERENCES gl_tafsili(id),
  ${INT_RIAL("debit_rial", ">= 0")} DEFAULT 0,
  ${INT_RIAL("credit_rial", ">= 0")} DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  CHECK((debit_rial > 0) + (credit_rial > 0) = 1),
  UNIQUE(voucher_id, line_no));

CREATE TABLE IF NOT EXISTS gl_voucher_seals (
  voucher_id INTEGER PRIMARY KEY REFERENCES gl_vouchers(id), sealed_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS gl_voucher_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, voucher_id INTEGER NOT NULL REFERENCES gl_vouchers(id),
  storage_key TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL, uploaded_by_user_id INTEGER, created_at TEXT NOT NULL,
  UNIQUE(voucher_id, sha256));

CREATE TABLE IF NOT EXISTS gl_voucher_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('manual','opening')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
  event_date TEXT CHECK(event_date IS NULL OR ${DATE_OK("event_date")}),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  created_by_user_id INTEGER NOT NULL, submitted_at TEXT,
  decided_by_user_id INTEGER, decided_at TEXT, decision_note TEXT,
  voucher_id INTEGER UNIQUE REFERENCES gl_vouchers(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(decided_by_user_id IS NULL OR decided_by_user_id <> created_by_user_id));

CREATE TABLE IF NOT EXISTS gl_posting_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, source_type TEXT, source_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT,
  voucher_id INTEGER REFERENCES gl_vouchers(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS gl_exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  code TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', voucher_id INTEGER REFERENCES gl_vouchers(id),
  created_at TEXT NOT NULL, UNIQUE(source_type, source_id, code));

CREATE TABLE IF NOT EXISTS treasury_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('bank','cash_box','gateway')),
  code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  ownership TEXT NOT NULL DEFAULT 'company' CHECK(ownership IN ('company','owner')),
  finance_bank_account_id INTEGER, custodian_user_id INTEGER,
  cash_limit_rial INTEGER CHECK(cash_limit_rial IS NULL OR (typeof(cash_limit_rial)='integer' AND cash_limit_rial >= 0)),
  settles_to_treasury_id INTEGER REFERENCES treasury_accounts(id),
  gl_tafsili_id INTEGER UNIQUE REFERENCES gl_tafsili(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
  CHECK(kind <> 'cash_box' OR finance_bank_account_id IS NULL));

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  treasury_account_id INTEGER NOT NULL REFERENCES treasury_accounts(id),
  import_batch TEXT NOT NULL, txn_date TEXT NOT NULL CHECK${DATE_OK("txn_date")}, txn_time TEXT,
  amount_rial INTEGER NOT NULL CHECK(typeof(amount_rial)='integer' AND amount_rial <> 0),
  balance_after_rial INTEGER CHECK(balance_after_rial IS NULL OR typeof(balance_after_rial)='integer'),
  description TEXT NOT NULL DEFAULT '', bank_ref TEXT, row_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bank_reconciliation_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_line_id INTEGER NOT NULL REFERENCES bank_statement_lines(id),
  voucher_line_id INTEGER NOT NULL REFERENCES gl_voucher_lines(id),
  method TEXT NOT NULL CHECK(method IN ('auto','manual')), matched_by_user_id INTEGER, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bank_reconciliation_unmatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL UNIQUE REFERENCES bank_reconciliation_matches(id),
  reason TEXT NOT NULL, by_user_id INTEGER, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_voucher_lines(account_id, tafsili_id);
CREATE INDEX IF NOT EXISTS idx_gl_lines_voucher ON gl_voucher_lines(voucher_id);
CREATE INDEX IF NOT EXISTS idx_gl_vouchers_date ON gl_vouchers(fiscal_year_id, event_date, id);
CREATE INDEX IF NOT EXISTS idx_gl_queue_status ON gl_posting_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_bank_lines_treasury ON bank_statement_lines(treasury_account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_bank_match_stmt ON bank_reconciliation_matches(statement_line_id);
CREATE INDEX IF NOT EXISTS idx_bank_match_vline ON bank_reconciliation_matches(voucher_line_id);

-- fiscal years: a lock only moves forward; a closed year never reopens; dates fixed once vouchers exist
CREATE TRIGGER IF NOT EXISTS gl_fy_guard BEFORE UPDATE ON gl_fiscal_years BEGIN
  SELECT RAISE(ABORT, 'gl_period_unlock_forbidden') WHERE OLD.locked_until IS NOT NULL AND (NEW.locked_until IS NULL OR NEW.locked_until < OLD.locked_until);
  SELECT RAISE(ABORT, 'gl_fiscal_year_closed') WHERE OLD.status = 'closed' AND NEW.status <> 'closed';
  SELECT RAISE(ABORT, 'gl_fiscal_year_dates_fixed') WHERE (NEW.start_date IS NOT OLD.start_date OR NEW.end_date IS NOT OLD.end_date)
    AND EXISTS (SELECT 1 FROM gl_vouchers v WHERE v.fiscal_year_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS gl_fy_no_delete BEFORE DELETE ON gl_fiscal_years BEGIN SELECT RAISE(ABORT, 'gl_fiscal_year_immutable'); END;

-- accounts: identity fixed once used
CREATE TRIGGER IF NOT EXISTS gl_accounts_guard BEFORE UPDATE ON gl_accounts
WHEN (NEW.code IS NOT OLD.code OR NEW.level IS NOT OLD.level OR NEW.parent_id IS NOT OLD.parent_id OR NEW.category IS NOT OLD.category OR NEW.nature IS NOT OLD.nature)
  AND EXISTS (SELECT 1 FROM gl_voucher_lines l WHERE l.account_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'gl_account_in_use'); END;
CREATE TRIGGER IF NOT EXISTS gl_accounts_no_delete BEFORE DELETE ON gl_accounts BEGIN SELECT RAISE(ABORT, 'gl_account_immutable'); END;
CREATE TRIGGER IF NOT EXISTS gl_tafsili_guard BEFORE UPDATE ON gl_tafsili
WHEN (NEW.type IS NOT OLD.type OR NEW.ref_id IS NOT OLD.ref_id OR NEW.code IS NOT OLD.code)
  AND EXISTS (SELECT 1 FROM gl_voucher_lines l WHERE l.tafsili_id = OLD.id OR l.tafsili2_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'gl_tafsili_in_use'); END;
CREATE TRIGGER IF NOT EXISTS gl_tafsili_no_delete BEFORE DELETE ON gl_tafsili BEGIN SELECT RAISE(ABORT, 'gl_tafsili_immutable'); END;

-- vouchers: fiscal year / period lock at insert; the final number never at insert
CREATE TRIGGER IF NOT EXISTS gl_period_lock BEFORE INSERT ON gl_vouchers BEGIN
  SELECT RAISE(ABORT, 'gl_fiscal_year_mismatch') WHERE NOT EXISTS (SELECT 1 FROM gl_fiscal_years f WHERE f.id = NEW.fiscal_year_id AND NEW.event_date BETWEEN f.start_date AND f.end_date);
  SELECT RAISE(ABORT, 'gl_fiscal_year_closed') WHERE NEW.kind <> 'closing' AND EXISTS (SELECT 1 FROM gl_fiscal_years f WHERE f.id = NEW.fiscal_year_id AND f.status = 'closed');
  SELECT RAISE(ABORT, 'gl_period_locked') WHERE NEW.kind <> 'closing' AND EXISTS (SELECT 1 FROM gl_fiscal_years f WHERE f.id = NEW.fiscal_year_id AND f.locked_until IS NOT NULL AND NEW.event_date <= f.locked_until);
  SELECT RAISE(ABORT, 'gl_final_no_at_close_only') WHERE NEW.final_period IS NOT NULL OR NEW.final_seq IS NOT NULL OR NEW.finalized_at IS NOT NULL;
END;
-- vouchers: financial and identity columns never change; the final number is written once, sealed + locked period only
CREATE TRIGGER IF NOT EXISTS gl_voucher_immutable BEFORE UPDATE ON gl_vouchers BEGIN
  SELECT RAISE(ABORT, 'voucher_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.fiscal_year_id IS NOT OLD.fiscal_year_id OR NEW.ref_no IS NOT OLD.ref_no
    OR NEW.temp_no IS NOT OLD.temp_no OR NEW.event_date IS NOT OLD.event_date OR NEW.kind IS NOT OLD.kind OR NEW.description IS NOT OLD.description
    OR NEW.source_type IS NOT OLD.source_type OR NEW.source_id IS NOT OLD.source_id OR NEW.source_key IS NOT OLD.source_key
    OR NEW.reverses_voucher_id IS NOT OLD.reverses_voucher_id OR NEW.total_rial IS NOT OLD.total_rial OR NEW.line_count IS NOT OLD.line_count
    OR NEW.created_by_user_id IS NOT OLD.created_by_user_id OR NEW.approved_by_user_id IS NOT OLD.approved_by_user_id OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'voucher_final') WHERE OLD.final_seq IS NOT NULL;
  SELECT RAISE(ABORT, 'gl_final_requires_seal') WHERE NEW.final_seq IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gl_voucher_seals s WHERE s.voucher_id = OLD.id);
  SELECT RAISE(ABORT, 'gl_final_requires_locked_period') WHERE NEW.final_seq IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gl_fiscal_years f WHERE f.id = OLD.fiscal_year_id AND f.locked_until IS NOT NULL AND OLD.event_date <= f.locked_until);
END;
CREATE TRIGGER IF NOT EXISTS gl_voucher_no_delete BEFORE DELETE ON gl_vouchers BEGIN SELECT RAISE(ABORT, 'voucher_immutable'); END;

-- lines: only before the seal, only on an active postable account
CREATE TRIGGER IF NOT EXISTS gl_lines_after_seal BEFORE INSERT ON gl_voucher_lines
WHEN EXISTS (SELECT 1 FROM gl_voucher_seals s WHERE s.voucher_id = NEW.voucher_id)
BEGIN SELECT RAISE(ABORT, 'gl_voucher_sealed'); END;
CREATE TRIGGER IF NOT EXISTS gl_lines_postable BEFORE INSERT ON gl_voucher_lines
WHEN NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.id = NEW.account_id AND a.postable = 1 AND a.active = 1)
BEGIN SELECT RAISE(ABORT, 'gl_account_not_postable'); END;
CREATE TRIGGER IF NOT EXISTS gl_lines_no_update BEFORE UPDATE ON gl_voucher_lines BEGIN SELECT RAISE(ABORT, 'voucher_immutable'); END;
CREATE TRIGGER IF NOT EXISTS gl_lines_no_delete BEFORE DELETE ON gl_voucher_lines BEGIN SELECT RAISE(ABORT, 'voucher_immutable'); END;

-- seal: debits = credits = total and the line count matches
CREATE TRIGGER IF NOT EXISTS gl_seal_balanced BEFORE INSERT ON gl_voucher_seals
WHEN NOT EXISTS (
  SELECT 1 FROM gl_vouchers v WHERE v.id = NEW.voucher_id
    AND v.line_count = (SELECT COUNT(*) FROM gl_voucher_lines l WHERE l.voucher_id = v.id)
    AND v.total_rial = (SELECT COALESCE(SUM(debit_rial), 0) FROM gl_voucher_lines l WHERE l.voucher_id = v.id)
    AND v.total_rial = (SELECT COALESCE(SUM(credit_rial), 0) FROM gl_voucher_lines l WHERE l.voucher_id = v.id))
BEGIN SELECT RAISE(ABORT, 'gl_voucher_unbalanced'); END;
CREATE TRIGGER IF NOT EXISTS gl_seals_no_update BEFORE UPDATE ON gl_voucher_seals BEGIN SELECT RAISE(ABORT, 'voucher_immutable'); END;
CREATE TRIGGER IF NOT EXISTS gl_seals_no_delete BEFORE DELETE ON gl_voucher_seals BEGIN SELECT RAISE(ABORT, 'voucher_immutable'); END;

-- append-only side tables
CREATE TRIGGER IF NOT EXISTS gl_att_no_update BEFORE UPDATE ON gl_voucher_attachments BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_att_no_delete BEFORE DELETE ON gl_voucher_attachments BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_exc_no_delete BEFORE DELETE ON gl_exceptions BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_lines_no_update BEFORE UPDATE ON bank_statement_lines BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_lines_no_delete BEFORE DELETE ON bank_statement_lines BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_match_no_update BEFORE UPDATE ON bank_reconciliation_matches BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_match_no_delete BEFORE DELETE ON bank_reconciliation_matches BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_unmatch_no_update BEFORE UPDATE ON bank_reconciliation_unmatches BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS bank_unmatch_no_delete BEFORE DELETE ON bank_reconciliation_unmatches BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
-- one live match per statement line and per voucher line (an unmatch row frees it; nothing is deleted)
CREATE TRIGGER IF NOT EXISTS bank_match_single BEFORE INSERT ON bank_reconciliation_matches
WHEN EXISTS (SELECT 1 FROM bank_reconciliation_matches m WHERE (m.statement_line_id = NEW.statement_line_id OR m.voucher_line_id = NEW.voucher_line_id)
  AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_unmatches u WHERE u.match_id = m.id))
BEGIN SELECT RAISE(ABORT, 'bank_line_already_matched'); END;
`;

/** Tables this package creates (used by tests and read-only release checks). */
export const LEDGER_TABLES = [
  "gl_settings", "gl_fiscal_years", "gl_accounts", "gl_tafsili", "gl_vouchers", "gl_voucher_lines", "gl_voucher_seals",
  "gl_voucher_attachments", "gl_voucher_drafts", "gl_posting_queue", "gl_exceptions",
  "treasury_accounts", "bank_statement_lines", "bank_reconciliation_matches", "bank_reconciliation_unmatches",
] as const;

/** Idempotent. Safe to call on every start. All-or-nothing via a SAVEPOINT (works inside or outside a transaction). */
export function ensureLedgerSchema(db: DatabaseSync, nowIso: string = new Date().toISOString()): void {
  db.exec("SAVEPOINT gl_ensure");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.exec(LEDGER_DDL);
    const flag = db.prepare("INSERT OR IGNORE INTO gl_settings(key,value,updated_at) VALUES(?,?,?)");
    for (const [k, v] of Object.entries(GL_FLAG_DEFAULTS)) flag.run(k, v, nowIso);
    const kol = db.prepare("INSERT OR IGNORE INTO gl_accounts(code,title,level,parent_id,category,nature,tafsili_types,postable,active,created_at) VALUES(?,?,'kol',NULL,?,?,'',0,1,?)");
    for (const [code, title, cat, nature] of KOL) kol.run(code, title, cat, nature, nowIso);
    const moein = db.prepare(`INSERT OR IGNORE INTO gl_accounts(code,title,level,parent_id,category,nature,tafsili_types,postable,active,note,created_at)
      VALUES(?,?,'moein',(SELECT id FROM gl_accounts WHERE code=?),?,?,?,1,?,?,?)`);
    for (const [code, title, cat, nature, tf, active, note] of MOEIN) moein.run(code, title, code.slice(0, 2), cat, nature, tf, active, note ?? null, nowIso);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(LEDGER_MIGRATION, nowIso);
    db.exec("RELEASE gl_ensure");
  } catch (error) {
    db.exec("ROLLBACK TO gl_ensure");
    db.exec("RELEASE gl_ensure");
    throw error;
  }
}

export function readGlFlags(db: DatabaseSync): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(GL_FLAG_DEFAULTS)) {
    const row = db.prepare("SELECT value FROM gl_settings WHERE key=?").get(k) as { value?: string } | undefined;
    out[k] = row?.value === "1";
  }
  return out;
}

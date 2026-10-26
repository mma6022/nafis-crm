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
  "gl.reports": "0", // G5: read-only ledger reports page (/accounting/ledger)
  "gl.nightly_compare": "0", // G5: nightly system-vs-ledger compare (report only, never fixes)
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
  ["2104", "پیش‌دریافت اعتبار از تأمین‌کنندگان (prefunded_full_credit)", "liability", "credit", "FD,PL", 0, "قاعده‌ی سلامتیان؛ کد منتظر تأیید، فعال‌سازی در G3"],
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
  ["6103", "هزینه‌ی بازاریابی (تخفیف توسعه)", "expense", "debit", "SP", 0, "فقط با marketing_expense؛ کد منتظر تأیید، فعال‌سازی در G3"],
  ["6104", "کارمزد تأمین‌کننده‌ی اعتبار", "expense", "debit", "FD,PL", 0, "net_of_fees: ردیف جدا، هرگز خالص درآمد؛ کد منتظر تأیید، فعال‌سازی در G3"],
  ["6201", "هزینه‌ی استعلام اعتبار (ICS24)", "expense", "debit", "VN", 1, "ICS24 فعلاً بیرون از دفتر"],
  ["6202", "کارمزد درگاه و بانک", "expense", "debit", "GW,BK", 1],
  ["6203", "اختلاف گرد کردن", "expense", "both", "", 1, "تنها یک ردیف در همان سند"],
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

/* ---------------------------------------------------------------------------------------------
 * general-ledger-v1b: admin-entered finance inputs (Mohammad's decision: no business input is
 * hard-coded). Effective-dated, append-only. The catalog below holds KEYS ONLY (type, allowed
 * values, scope); every VALUE is entered by an admin in the setup wizard (later package) with
 * effective_from, changed_by and a reason. Rows are never updated or deleted; a change is a new
 * row, and finance_settings_log records old -> new automatically. Readers (P7 event->account
 * mapping) resolve a key AS OF THE EVENT DATE with financeSettingAsOf().
 * ------------------------------------------------------------------------------------------- */
export const FINANCE_MIGRATION = "general-ledger-v1b";
export const FINANCE_V1C_MIGRATION = "general-ledger-v1c";
/** N8: the exact acknowledgment text for a treasury account owned by a person but used for company work. */
export const OWNER_PERSON_ACK_TEXT = "این حساب برای کار شرکت استفاده می‌شود و همهٔ گردشش در دفتر شرکت ثبت می‌شود";

type KeyDef = [key: string, type: string, scope: "global" | "loan_plan", title: string, allowed: string[] | null, min: number | null, max: number | null, usedBy: string, managedElsewhere?: string | null, listStatus?: "final", preselect?: string];
/**
 * Enum lists are 'proposed' until Armita / Salamatian confirm them; FINAL ones are marked.
 * `preselect` is ONLY the wizard's preselected option. It is never stored as a value: no default exists in finance_settings.
 */
export const FINANCE_SETTING_KEYS: KeyDef[] = [
  ["gl.fiscal_year_start_jalali", "jalali_mmdd", "global", "شروع سال مالی (ماه-روز شمسی)", null, null, null, "G2"],
  ["gl.ledger_start_date", "date", "global", "تاریخ شروع دفتر کل", null, null, null, "G2"],
  ["gl.opening_base_date", "date", "global", "تاریخ مبنای سند افتتاحیه", null, null, null, "G2"],
  ["fee.inquiry.payer", "enum", "global", "پرداخت‌کننده‌ی هزینه‌ی استعلام", ["customer", "company"], null, null, "P7"],
  ["fee.inquiry.amount_rial", "int_rial", "global", "مبلغ هزینه‌ی استعلام (ریال)", null, 0, null, "P7"],
  ["plan.supplier_deposit_method", "enum", "loan_plan", "روش واریز تأمین‌کننده برای این طرح", ["gross", "net_of_fees", "to_customer_direct", "prefunded_full_credit"], null, null, "P7", null, "final"],
  ["discount.development.nature", "enum", "global", "ماهیت تخفیف توسعه", ["revenue_reduction", "marketing_expense"], null, null, "P7", null, "final", "revenue_reduction"],
  ["discount.development.rate_bp", "bp", "global", "درصد تخفیف توسعه (صدم درصد)", null, 0, 10000, "P7"],
  ["tax.vat.applies", "bool", "global", "مشمول مالیات بر ارزش افزوده", null, null, null, "P7"],
  ["tax.vat.rate_bp", "bp", "global", "نرخ ارزش افزوده (صدم درصد)", null, 0, 10000, "P7"],
  ["commission.recognition_timing", "enum", "global", "زمان شناسایی پورسانت", ["on_disbursement", "on_supplier_settlement", "on_approval"], null, null, "P7"],
  ["commission.on_account_timing", "enum", "global", "زمان پرداخت علی‌الحساب", ["none", "on_disbursement", "monthly"], null, null, "P7"],
  ["gateway.zarinpal.fee_bp", "bp", "global", "کارمزد زرین‌پال (صدم درصد)", null, 0, 10000, "P7"],
  ["gateway.zarinpal.fee_cap_rial", "int_rial", "global", "سقف کارمزد زرین‌پال (ریال)", null, 0, null, "P7"],
  ["gateway.zarinpal.settlement_days", "int", "global", "دوره‌ی تسویه‌ی زرین‌پال (روز کاری)", null, 0, 30, "G4"],
  ["sms.payment_link_enabled", "bool", "global", "پیامک لینک پرداخت (فقط نمایش؛ خاموش و دست‌نخورده)", null, null, null, "-", "notification_settings"],
  ["finance.accountant_role", "role", "global", "نقش حسابدار", null, null, null, "G5"],
  ["finance.approver_role", "role", "global", "نقش تأییدکننده‌ی سند", null, null, null, "G5"],
];

/** Purposes a bank / cash / gateway account can serve (JSON array in treasury_accounts.purpose). */
export const TREASURY_PURPOSES = ["customer_payouts", "supplier_receipts", "fee_receipts", "commission_payouts", "gateway_settlement", "petty_cash", "owner_transfers", "general"] as const;

const NV = "NEW.value";
export const FINANCE_DDL = `
CREATE TABLE IF NOT EXISTS finance_setting_keys (
  key TEXT PRIMARY KEY CHECK(key GLOB '[a-z]*' AND length(key) <= 64),
  value_type TEXT NOT NULL CHECK(value_type IN ('int_rial','int','bp','date','jalali_mmdd','enum','bool','role','text')),
  allowed_values TEXT CHECK(allowed_values IS NULL OR (json_valid(allowed_values) AND json_type(allowed_values) = 'array')),
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK(scope_type IN ('global','loan_plan')),
  min_value INTEGER, max_value INTEGER, title TEXT NOT NULL, used_by TEXT,
  managed_elsewhere TEXT,
  list_status TEXT CHECK(list_status IS NULL OR list_status IN ('proposed','final')),
  ui_preselect TEXT,
  created_at TEXT NOT NULL,
  CHECK((value_type = 'enum') = (allowed_values IS NOT NULL)),
  CHECK((value_type = 'enum') = (list_status IS NOT NULL)),
  CHECK(ui_preselect IS NULL OR allowed_values IS NOT NULL));
CREATE TRIGGER IF NOT EXISTS finance_keys_preselect_insert BEFORE INSERT ON finance_setting_keys
WHEN NEW.ui_preselect IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(NEW.allowed_values) j WHERE j.value = NEW.ui_preselect)
BEGIN SELECT RAISE(ABORT, 'finance_setting_preselect_invalid'); END;
CREATE TRIGGER IF NOT EXISTS finance_keys_preselect_update BEFORE UPDATE OF ui_preselect, allowed_values ON finance_setting_keys
WHEN NEW.ui_preselect IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(NEW.allowed_values) j WHERE j.value = NEW.ui_preselect)
BEGIN SELECT RAISE(ABORT, 'finance_setting_preselect_invalid'); END;

CREATE TABLE IF NOT EXISTS finance_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL REFERENCES finance_setting_keys(key),
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK(scope_type IN ('global','loan_plan')),
  scope_id INTEGER,
  value TEXT,
  effective_from TEXT NOT NULL CHECK${DATE_OK("effective_from")},
  changed_by_user_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) >= 3),
  created_at TEXT NOT NULL,
  CHECK((scope_type = 'global') = (scope_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_fin_settings_asof ON finance_settings(key, scope_type, scope_id, effective_from, id);

CREATE TABLE IF NOT EXISTS finance_settings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_id INTEGER NOT NULL UNIQUE REFERENCES finance_settings(id),
  key TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id INTEGER,
  old_value TEXT, new_value TEXT, effective_from TEXT NOT NULL,
  changed_by_user_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS finance_keys_guard BEFORE UPDATE ON finance_setting_keys
WHEN EXISTS (SELECT 1 FROM finance_settings s WHERE s.key = OLD.key)
  AND (NEW.key IS NOT OLD.key OR NEW.value_type IS NOT OLD.value_type OR NEW.scope_type IS NOT OLD.scope_type)
BEGIN SELECT RAISE(ABORT, 'finance_setting_key_in_use'); END;
CREATE TRIGGER IF NOT EXISTS finance_keys_no_delete BEFORE DELETE ON finance_setting_keys BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;

CREATE TRIGGER IF NOT EXISTS finance_settings_validate BEFORE INSERT ON finance_settings
BEGIN
  SELECT RAISE(ABORT, 'finance_setting_unknown_key') WHERE NOT EXISTS (SELECT 1 FROM finance_setting_keys k WHERE k.key = NEW.key);
  SELECT RAISE(ABORT, 'finance_setting_managed_elsewhere') FROM finance_setting_keys k WHERE k.key = NEW.key AND k.managed_elsewhere IS NOT NULL;
  SELECT RAISE(ABORT, 'finance_setting_scope') FROM finance_setting_keys k WHERE k.key = NEW.key AND k.scope_type <> NEW.scope_type;
  SELECT RAISE(ABORT, 'finance_setting_invalid_value') FROM finance_setting_keys k WHERE k.key = NEW.key AND ${NV} IS NOT NULL AND NOT (
    CASE k.value_type
      WHEN 'int_rial' THEN ${NV} GLOB '[0-9]*' AND ${NV} NOT GLOB '*[^0-9]*' AND length(${NV}) <= 15
      WHEN 'int' THEN ${NV} GLOB '[0-9]*' AND ${NV} NOT GLOB '*[^0-9]*' AND length(${NV}) <= 9
      WHEN 'bp' THEN ${NV} GLOB '[0-9]*' AND ${NV} NOT GLOB '*[^0-9]*' AND length(${NV}) <= 5
      WHEN 'date' THEN ${DATE_OK(NV)} AND length(${NV}) = 10
      WHEN 'jalali_mmdd' THEN ${NV} GLOB '[0-1][0-9]-[0-3][0-9]' AND CAST(substr(${NV},1,2) AS INTEGER) BETWEEN 1 AND 12 AND CAST(substr(${NV},4,2) AS INTEGER) BETWEEN 1 AND 31
      WHEN 'enum' THEN EXISTS (SELECT 1 FROM json_each(k.allowed_values) j WHERE j.value = ${NV})
      WHEN 'bool' THEN ${NV} IN ('0','1')
      WHEN 'role' THEN ${NV} GLOB '[a-z]*' AND ${NV} NOT GLOB '*[^a-z0-9_-]*' AND length(${NV}) <= 40
      ELSE length(trim(${NV})) > 0 END
    AND (k.value_type NOT IN ('int_rial','int','bp') OR ((k.min_value IS NULL OR CAST(${NV} AS INTEGER) >= k.min_value) AND (k.max_value IS NULL OR CAST(${NV} AS INTEGER) <= k.max_value))));
  SELECT RAISE(ABORT, 'gl_period_locked') FROM gl_fiscal_years f
    WHERE NEW.effective_from BETWEEN f.start_date AND f.end_date AND (f.status = 'closed' OR (f.locked_until IS NOT NULL AND NEW.effective_from <= f.locked_until));
END;
CREATE TRIGGER IF NOT EXISTS finance_settings_log_insert AFTER INSERT ON finance_settings
BEGIN
  INSERT INTO finance_settings_log(setting_id,key,scope_type,scope_id,old_value,new_value,effective_from,changed_by_user_id,reason,created_at)
  VALUES(NEW.id, NEW.key, NEW.scope_type, NEW.scope_id,
    (SELECT p.value FROM finance_settings p WHERE p.key = NEW.key AND p.scope_type = NEW.scope_type AND p.scope_id IS NEW.scope_id
       AND p.id <> NEW.id AND p.effective_from <= NEW.effective_from ORDER BY p.effective_from DESC, p.id DESC LIMIT 1),
    NEW.value, NEW.effective_from, NEW.changed_by_user_id, NEW.reason, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS finance_settings_no_update BEFORE UPDATE ON finance_settings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS finance_settings_no_delete BEFORE DELETE ON finance_settings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS finance_log_no_update BEFORE UPDATE ON finance_settings_log BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS finance_log_no_delete BEFORE DELETE ON finance_settings_log BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;

CREATE TRIGGER IF NOT EXISTS gl_payable_beneficiary BEFORE INSERT ON gl_voucher_lines
WHEN EXISTS (SELECT 1 FROM gl_accounts a WHERE a.id = NEW.account_id AND a.code IN ('2102','6103'))
  AND NOT EXISTS (SELECT 1 FROM gl_vouchers v WHERE v.id = NEW.voucher_id AND v.kind = 'opening')
  AND NOT EXISTS (SELECT 1 FROM gl_tafsili t WHERE t.id = NEW.tafsili_id AND t.type = 'SP')
BEGIN SELECT RAISE(ABORT, 'gl_beneficiary_required'); END;

CREATE TABLE IF NOT EXISTS gl_opening_balance_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date TEXT NOT NULL CHECK${DATE_OK("as_of_date")},
  supersedes_set_id INTEGER UNIQUE REFERENCES gl_opening_balance_sets(id),
  entered_by_user_id INTEGER NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) >= 3),
  approved_by_user_id INTEGER, approved_at TEXT,
  voucher_id INTEGER UNIQUE REFERENCES gl_vouchers(id),
  created_at TEXT NOT NULL,
  CHECK(approved_by_user_id IS NULL OR approved_by_user_id <> entered_by_user_id),
  CHECK((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  CHECK(voucher_id IS NULL OR approved_by_user_id IS NOT NULL));
CREATE TABLE IF NOT EXISTS gl_opening_balance_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES gl_opening_balance_sets(id),
  account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
  tafsili_id INTEGER REFERENCES gl_tafsili(id),
  treasury_account_id INTEGER REFERENCES treasury_accounts(id),
  ${INT_RIAL("debit_rial", ">= 0")} DEFAULT 0,
  ${INT_RIAL("credit_rial", ">= 0")} DEFAULT 0,
  note TEXT, created_at TEXT NOT NULL,
  CHECK((debit_rial > 0) + (credit_rial > 0) = 1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_opening_line_unique ON gl_opening_balance_lines(set_id, account_id, IFNULL(tafsili_id, 0), IFNULL(treasury_account_id, 0));
CREATE TRIGGER IF NOT EXISTS gl_opening_set_no_delete BEFORE DELETE ON gl_opening_balance_sets BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_opening_lines_after_approval BEFORE INSERT ON gl_opening_balance_lines
WHEN EXISTS (SELECT 1 FROM gl_opening_balance_sets s WHERE s.id = NEW.set_id AND s.approved_by_user_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'gl_opening_set_approved'); END;
CREATE TRIGGER IF NOT EXISTS gl_opening_lines_postable BEFORE INSERT ON gl_opening_balance_lines
WHEN NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.id = NEW.account_id AND a.postable = 1 AND a.active = 1)
BEGIN SELECT RAISE(ABORT, 'gl_account_not_postable'); END;
CREATE TRIGGER IF NOT EXISTS gl_opening_lines_no_update BEFORE UPDATE ON gl_opening_balance_lines BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_opening_lines_no_delete BEFORE DELETE ON gl_opening_balance_lines BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;

CREATE TABLE IF NOT EXISTS payment_order_prior_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_order_id INTEGER NOT NULL,
  paid_date TEXT NOT NULL CHECK${DATE_OK("paid_date")},
  tracking_no TEXT NOT NULL CHECK(length(trim(tracking_no)) BETWEEN 4 AND 64),
  ${INT_RIAL("amount_rial", "> 0")},
  treasury_account_id INTEGER REFERENCES treasury_accounts(id),
  receipt_filename TEXT NOT NULL CHECK(length(trim(receipt_filename)) > 0),
  receipt_mime TEXT NOT NULL CHECK(receipt_mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  entered_by_user_id INTEGER NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) >= 3),
  gl_voucher_id INTEGER UNIQUE REFERENCES gl_vouchers(id),
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_prior_pay_order ON payment_order_prior_payments(payment_order_id);
CREATE TABLE IF NOT EXISTS payment_order_prior_payment_voids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prior_payment_id INTEGER NOT NULL UNIQUE REFERENCES payment_order_prior_payments(id),
  voided_by_user_id INTEGER NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) >= 3), created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS prior_pay_single BEFORE INSERT ON payment_order_prior_payments
WHEN EXISTS (SELECT 1 FROM payment_order_prior_payments p WHERE p.payment_order_id = NEW.payment_order_id
  AND NOT EXISTS (SELECT 1 FROM payment_order_prior_payment_voids v WHERE v.prior_payment_id = p.id))
BEGIN SELECT RAISE(ABORT, 'prior_payment_exists'); END;
CREATE TRIGGER IF NOT EXISTS prior_pay_no_delete BEFORE DELETE ON payment_order_prior_payments BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS prior_pay_void_no_update BEFORE UPDATE ON payment_order_prior_payment_voids BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS prior_pay_void_no_delete BEFORE DELETE ON payment_order_prior_payment_voids BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
`;

const PURPOSE_OK = (c: string) => `(${c} IS NOT NULL AND json_valid(${c}) AND json_type(${c}) = 'array' AND json_array_length(${c}) >= 1
  AND NOT EXISTS (SELECT 1 FROM json_each(${c}) j WHERE j.value NOT IN (${TREASURY_PURPOSES.map((p) => `'${p}'`).join(",")})))`;
const SHEBA_OK = (c: string) => `(${c} GLOB 'IR[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')`;
/** Runs after treasury_accounts has its sheba/purpose columns (added by ALTER on databases created by v1). */
const TREASURY_RULES_DDL = `
CREATE TRIGGER IF NOT EXISTS treasury_rules_insert BEFORE INSERT ON treasury_accounts
BEGIN
  SELECT RAISE(ABORT, 'treasury_cash_box_no_sheba') WHERE NEW.kind = 'cash_box' AND NEW.sheba IS NOT NULL;
  SELECT RAISE(ABORT, 'treasury_bank_sheba_required') WHERE NEW.kind = 'bank' AND (NEW.sheba IS NULL OR NOT ${SHEBA_OK("NEW.sheba")});
  SELECT RAISE(ABORT, 'treasury_sheba_invalid') WHERE NEW.kind = 'gateway' AND NEW.sheba IS NOT NULL AND NOT ${SHEBA_OK("NEW.sheba")};
  SELECT RAISE(ABORT, 'treasury_purpose_invalid') WHERE NOT ${PURPOSE_OK("NEW.purpose")};
END;
CREATE TRIGGER IF NOT EXISTS treasury_rules_update BEFORE UPDATE OF kind, sheba, purpose ON treasury_accounts
BEGIN
  SELECT RAISE(ABORT, 'treasury_cash_box_no_sheba') WHERE NEW.kind = 'cash_box' AND NEW.sheba IS NOT NULL;
  SELECT RAISE(ABORT, 'treasury_bank_sheba_required') WHERE NEW.kind = 'bank' AND (NEW.sheba IS NULL OR NOT ${SHEBA_OK("NEW.sheba")});
  SELECT RAISE(ABORT, 'treasury_sheba_invalid') WHERE NEW.kind = 'gateway' AND NEW.sheba IS NOT NULL AND NOT ${SHEBA_OK("NEW.sheba")};
  SELECT RAISE(ABORT, 'treasury_purpose_invalid') WHERE NOT ${PURPOSE_OK("NEW.purpose")};
END;
CREATE UNIQUE INDEX IF NOT EXISTS idx_treasury_sheba ON treasury_accounts(sheba) WHERE sheba IS NOT NULL;
`;

/** v1c (N7 / N8, Salamatian via Armita 2026-10-26). Old trigger names are dropped once; the new ones carry _v1c. */
const V1C_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["treasury_accounts", "owner_type", "TEXT"],
  ["treasury_accounts", "owner_ack", "INTEGER"],
  ["treasury_accounts", "owner_ack_by_user_id", "INTEGER"],
  ["treasury_accounts", "owner_ack_at", "TEXT"],
  ["treasury_accounts", "owner_ack_text", "TEXT"],
  ["payment_order_prior_payments", "ledger_start_date", "TEXT"],
  ["payment_order_prior_payments", "pre_start", "INTEGER"],
  ["payment_order_prior_payments", "opening_mismatch", "INTEGER"],
  ["gl_opening_balance_sets", "prior_payments_confirmed_by_user_id", "INTEGER"],
  ["gl_opening_balance_sets", "prior_payments_confirmed_at", "TEXT"],
];
const LEDGER_START_ASOF = (d: string) => `(SELECT s.value FROM finance_settings s WHERE s.key = 'gl.ledger_start_date' AND s.scope_type = 'global' AND s.effective_from <= ${d} ORDER BY s.effective_from DESC, s.id DESC LIMIT 1)`;
const OWNER_RULES = (t: string) => `
  SELECT RAISE(ABORT, 'treasury_owner_type_invalid') WHERE ${t}.owner_type IS NULL OR ${t}.owner_type NOT IN ('company','owner_person')
    OR ${t}.ownership IS NOT (CASE ${t}.owner_type WHEN 'company' THEN 'company' ELSE 'owner' END);
  SELECT RAISE(ABORT, 'treasury_owner_ack_required') WHERE ${t}.owner_type = 'owner_person' AND NOT (
    ${t}.owner_ack IS 1 AND ${t}.owner_ack_by_user_id IS NOT NULL AND ${t}.owner_ack_at IS NOT NULL AND ${t}.owner_ack_text IS '${OWNER_PERSON_ACK_TEXT}');
  SELECT RAISE(ABORT, 'treasury_owner_ack_unexpected') WHERE ${t}.owner_type = 'company'
    AND (${t}.owner_ack IS NOT NULL OR ${t}.owner_ack_by_user_id IS NOT NULL OR ${t}.owner_ack_at IS NOT NULL OR ${t}.owner_ack_text IS NOT NULL);`;
const V1C_DDL = `
DROP TRIGGER IF EXISTS prior_pay_guard;
DROP TRIGGER IF EXISTS gl_opening_set_guard;
CREATE TRIGGER IF NOT EXISTS treasury_owner_insert_v1c BEFORE INSERT ON treasury_accounts
BEGIN ${OWNER_RULES("NEW")}
END;
CREATE TRIGGER IF NOT EXISTS treasury_owner_update_v1c BEFORE UPDATE OF owner_type, ownership, owner_ack, owner_ack_by_user_id, owner_ack_at, owner_ack_text ON treasury_accounts
BEGIN ${OWNER_RULES("NEW")}
END;

CREATE TABLE IF NOT EXISTS payment_order_prior_payment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prior_payment_id INTEGER NOT NULL UNIQUE REFERENCES payment_order_prior_payments(id),
  marker TEXT NOT NULL CHECK(marker IN ('pre_opening','in_ledger')),
  ledger_start_date TEXT NOT NULL, opening_mismatch INTEGER NOT NULL CHECK(opening_mismatch IN (0,1)),
  entered_by_user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS prior_pay_log_no_update_v1c BEFORE UPDATE ON payment_order_prior_payment_log BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS prior_pay_log_no_delete_v1c BEFORE DELETE ON payment_order_prior_payment_log BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;

-- N7: cutoff = the gl.ledger_start_date setting in effect when the record is entered (never hardcoded).
-- The app supplies ledger_start_date / pre_start / opening_mismatch; the DB checks them against the setting and the opening sets.
CREATE TRIGGER IF NOT EXISTS prior_pay_cutoff_v1c BEFORE INSERT ON payment_order_prior_payments
BEGIN
  SELECT RAISE(ABORT, 'finance_setting_missing:gl.ledger_start_date') WHERE ${LEDGER_START_ASOF("substr(NEW.created_at,1,10)")} IS NULL;
  SELECT RAISE(ABORT, 'prior_payment_cutoff_mismatch') WHERE NEW.ledger_start_date IS NOT ${LEDGER_START_ASOF("substr(NEW.created_at,1,10)")}
    OR NEW.pre_start IS NOT (NEW.paid_date < NEW.ledger_start_date);
  SELECT RAISE(ABORT, 'prior_payment_pre_start_no_voucher') WHERE NEW.pre_start = 1 AND NEW.gl_voucher_id IS NOT NULL;
  SELECT RAISE(ABORT, 'prior_payment_mismatch_flag') WHERE NEW.opening_mismatch IS NOT (NEW.pre_start = 1 AND EXISTS (
    SELECT 1 FROM gl_opening_balance_sets o WHERE EXISTS (SELECT 1 FROM gl_opening_balance_lines l WHERE l.set_id = o.id)));
END;
CREATE TRIGGER IF NOT EXISTS prior_pay_log_insert_v1c AFTER INSERT ON payment_order_prior_payments
BEGIN
  INSERT INTO payment_order_prior_payment_log(prior_payment_id,marker,ledger_start_date,opening_mismatch,entered_by_user_id,created_at)
  VALUES(NEW.id, CASE WHEN NEW.pre_start = 1 THEN 'pre_opening' ELSE 'in_ledger' END, NEW.ledger_start_date, NEW.opening_mismatch, NEW.entered_by_user_id, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS prior_pay_guard_v1c BEFORE UPDATE ON payment_order_prior_payments
BEGIN
  SELECT RAISE(ABORT, 'gl_append_only') WHERE NEW.id IS NOT OLD.id OR NEW.payment_order_id IS NOT OLD.payment_order_id OR NEW.paid_date IS NOT OLD.paid_date OR NEW.tracking_no IS NOT OLD.tracking_no
    OR NEW.amount_rial IS NOT OLD.amount_rial OR NEW.treasury_account_id IS NOT OLD.treasury_account_id OR NEW.receipt_filename IS NOT OLD.receipt_filename
    OR NEW.receipt_mime IS NOT OLD.receipt_mime OR NEW.receipt_sha256 IS NOT OLD.receipt_sha256 OR NEW.entered_by_user_id IS NOT OLD.entered_by_user_id
    OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at OR (OLD.gl_voucher_id IS NOT NULL AND NEW.gl_voucher_id IS NOT OLD.gl_voucher_id)
    OR NEW.ledger_start_date IS NOT OLD.ledger_start_date OR NEW.pre_start IS NOT OLD.pre_start OR NEW.opening_mismatch IS NOT OLD.opening_mismatch;
  SELECT RAISE(ABORT, 'prior_payment_pre_start_no_voucher') WHERE NEW.pre_start = 1 AND NEW.gl_voucher_id IS NOT NULL;
END;

-- N7: the opening set is approved only after someone confirmed that all step-4 «قبلاً پرداخت شده» records are entered.
CREATE TRIGGER IF NOT EXISTS gl_opening_set_guard_v1c BEFORE UPDATE ON gl_opening_balance_sets
BEGIN
  SELECT RAISE(ABORT, 'gl_append_only') WHERE NEW.id IS NOT OLD.id OR NEW.as_of_date IS NOT OLD.as_of_date OR NEW.supersedes_set_id IS NOT OLD.supersedes_set_id
    OR NEW.entered_by_user_id IS NOT OLD.entered_by_user_id OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.approved_by_user_id IS NOT NULL AND (NEW.approved_by_user_id IS NOT OLD.approved_by_user_id OR NEW.approved_at IS NOT OLD.approved_at))
    OR (OLD.voucher_id IS NOT NULL AND NEW.voucher_id IS NOT OLD.voucher_id)
    OR (OLD.prior_payments_confirmed_at IS NOT NULL AND (NEW.prior_payments_confirmed_at IS NOT OLD.prior_payments_confirmed_at OR NEW.prior_payments_confirmed_by_user_id IS NOT OLD.prior_payments_confirmed_by_user_id));
  SELECT RAISE(ABORT, 'gl_opening_confirm_incomplete') WHERE (NEW.prior_payments_confirmed_at IS NULL) <> (NEW.prior_payments_confirmed_by_user_id IS NULL);
  SELECT RAISE(ABORT, 'gl_opening_unbalanced') WHERE OLD.approved_by_user_id IS NULL AND NEW.approved_by_user_id IS NOT NULL AND NOT (
    (SELECT count(*) FROM gl_opening_balance_lines l WHERE l.set_id = OLD.id) >= 2
    AND (SELECT COALESCE(SUM(debit_rial), 0) FROM gl_opening_balance_lines l WHERE l.set_id = OLD.id) = (SELECT COALESCE(SUM(credit_rial), 0) FROM gl_opening_balance_lines l WHERE l.set_id = OLD.id));
  SELECT RAISE(ABORT, 'gl_opening_prior_payments_unconfirmed') WHERE OLD.approved_by_user_id IS NULL AND NEW.approved_by_user_id IS NOT NULL AND NEW.prior_payments_confirmed_at IS NULL;
END;
`;

function ensureFinanceV1c(db: DatabaseSync, nowIso: string): void {
  for (const [table, column, ddl] of V1C_COLUMNS) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  // Existing treasury rows (none live at v1b) map from the v1 ownership column; owner rows still need the ack via the UI.
  db.exec("UPDATE treasury_accounts SET owner_type='company' WHERE owner_type IS NULL AND ownership='company'");
  db.exec(V1C_DDL);
  // Catalog sync: enum lists / list status / preselect / title follow the code, unless a stored value would fall outside the new list.
  const upd = db.prepare(`UPDATE finance_setting_keys SET allowed_values=?, list_status=?, ui_preselect=?, title=?
    WHERE key=? AND (allowed_values IS NOT ? OR list_status IS NOT ? OR ui_preselect IS NOT ? OR title IS NOT ?)
      AND NOT EXISTS (SELECT 1 FROM finance_settings s WHERE s.key = finance_setting_keys.key AND s.value IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE j.value = s.value))`);
  for (const [k, , , title, allowed, , , , , listStatus, preselect] of FINANCE_SETTING_KEYS) {
    if (!allowed) continue;
    const a = JSON.stringify(allowed), st = listStatus ?? "proposed", pre = preselect ?? null;
    upd.run(a, st, pre, title, k, a, st, pre, title, a);
  }
  db.prepare("UPDATE gl_accounts SET title=? WHERE code='2104' AND title=?").run(
    "پیش‌دریافت اعتبار از تأمین‌کنندگان (prefunded_full_credit)", "پیش‌دریافت اعتبار از تأمین‌کنندگان (prepaid_full_credit)");
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(FINANCE_V1C_MIGRATION, nowIso);
}

export const FINANCE_TABLES = [
  "finance_setting_keys", "finance_settings", "finance_settings_log",
  "gl_opening_balance_sets", "gl_opening_balance_lines",
  "payment_order_prior_payments", "payment_order_prior_payment_voids", "payment_order_prior_payment_log",
] as const;

function ensureFinanceInputs(db: DatabaseSync, nowIso: string): void {
  const cols = new Set((db.prepare("PRAGMA table_info(treasury_accounts)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("sheba")) db.exec("ALTER TABLE treasury_accounts ADD COLUMN sheba TEXT");
  if (!cols.has("purpose")) db.exec("ALTER TABLE treasury_accounts ADD COLUMN purpose TEXT");
  if (!cols.has("purpose_note")) db.exec("ALTER TABLE treasury_accounts ADD COLUMN purpose_note TEXT");
  db.exec(FINANCE_DDL);
  db.exec(TREASURY_RULES_DDL);
  const key = db.prepare(`INSERT OR IGNORE INTO finance_setting_keys(key,value_type,allowed_values,scope_type,min_value,max_value,title,used_by,managed_elsewhere,list_status,ui_preselect,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [k, type, scope, title, allowed, min, max, usedBy, elsewhere, listStatus, preselect] of FINANCE_SETTING_KEYS)
    key.run(k, type, allowed ? JSON.stringify(allowed) : null, scope, min, max, title, usedBy, elsewhere ?? null, allowed ? (listStatus ?? "proposed") : null, preselect ?? null, nowIso);
  // Approved title for 6203 (title edits are allowed; identity is not). Only if still the v1 seed text.
  db.prepare("UPDATE gl_accounts SET title='اختلاف گرد کردن' WHERE code='6203' AND title='اختلاف گرد کردن (ریال)'").run();
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(FINANCE_MIGRATION, nowIso);
}

/**
 * Salamatian's final rule (for G3/P7): development discount.
 *  - revenue_reduction: debit 4102 (contra-sales); no beneficiary.
 *  - marketing_expense: debit 6103 and credit 2102 with the beneficiary's SP tafsili (a payable to that person). Beneficiary REQUIRED.
 * Also enforced in the DB: lines on 2102/6103 outside the opening voucher need an SP tafsili (gl_beneficiary_required).
 */
export function assertDevelopmentDiscountInputs(nature: string | null, beneficiaryTafsiliId: number | null): void {
  if (nature !== "revenue_reduction" && nature !== "marketing_expense") throw new Error("finance_setting_missing:discount.development.nature");
  if (nature === "marketing_expense" && !(Number.isInteger(beneficiaryTafsiliId) && (beneficiaryTafsiliId as number) > 0)) throw new Error("discount_beneficiary_required");
}

/**
 * The value in effect for `key` on `eventDate` (YYYY-MM-DD): the latest effective_from <= eventDate,
 * ties broken by the later row. null = never set (or explicitly unset) -> callers must not post and
 * should raise a gl_exceptions row instead of guessing a default.
 */
export function financeSettingAsOf(db: DatabaseSync, key: string, eventDate: string, scope: { type: "global" } | { type: "loan_plan"; id: number } = { type: "global" }): string | null {
  const row = db.prepare(`SELECT value FROM finance_settings WHERE key=? AND scope_type=? AND scope_id IS ? AND effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1`).get(key, scope.type, scope.type === "global" ? null : scope.id, eventDate) as { value: string | null } | undefined;
  return row?.value ?? null;
}

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
    ensureFinanceInputs(db, nowIso);
    ensureFinanceV1c(db, nowIso);
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

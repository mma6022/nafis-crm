import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    

// src/gl-backfill-cli.ts
import { DatabaseSync } from "node:sqlite";
import { realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/gl-backfill.ts
import { createHash } from "node:crypto";

// src/lib/ledger.ts
var GL_FLAG_DEFAULTS = Object.freeze({
  "gl.shadow_nonbank": "0",
  // G3: shadow posting of non-bank events
  "gl.shadow_bank": "0",
  // G4: shadow posting of bank payments via the queue (never blocks /pay)
  "gl.bank_blocking": "0",
  // after a clean one-month parallel run only
  "gl.reports": "0",
  // G5: read-only ledger reports page (/accounting/ledger)
  "gl.nightly_compare": "0",
  // G5: nightly system-vs-ledger compare (report only, never fixes)
  "gl.p7_prefunded": "0"
  // G6c: P7 'prefunded_full_credit' path (company share on 2104) — awaiting Salamatian's P7 sign-off
});
var INT_RIAL = (c, min) => `${c} INTEGER NOT NULL CHECK(typeof(${c})='integer' AND ${c} ${min})`;
var DATE_OK = (c) => `(${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
var LEDGER_DDL = `
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
var OWNER_PERSON_ACK_TEXT = "\u0627\u06CC\u0646 \u062D\u0633\u0627\u0628 \u0628\u0631\u0627\u06CC \u06A9\u0627\u0631 \u0634\u0631\u06A9\u062A \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F \u0648 \u0647\u0645\u0647\u0654 \u06AF\u0631\u062F\u0634\u0634 \u062F\u0631 \u062F\u0641\u062A\u0631 \u0634\u0631\u06A9\u062A \u062B\u0628\u062A \u0645\u06CC\u200C\u0634\u0648\u062F";
var TREASURY_PURPOSES = ["customer_payouts", "supplier_receipts", "fee_receipts", "commission_payouts", "gateway_settlement", "petty_cash", "owner_transfers", "general"];
var NV = "NEW.value";
var FINANCE_DDL = `
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
var PURPOSE_OK = (c) => `(${c} IS NOT NULL AND json_valid(${c}) AND json_type(${c}) = 'array' AND json_array_length(${c}) >= 1
  AND NOT EXISTS (SELECT 1 FROM json_each(${c}) j WHERE j.value NOT IN (${TREASURY_PURPOSES.map((p) => `'${p}'`).join(",")})))`;
var SHEBA_OK = (c) => `(${c} GLOB 'IR[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')`;
var TREASURY_RULES_DDL = `
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
var LEDGER_START_ASOF = (d) => `(SELECT s.value FROM finance_settings s WHERE s.key = 'gl.ledger_start_date' AND s.scope_type = 'global' AND s.effective_from <= ${d} ORDER BY s.effective_from DESC, s.id DESC LIMIT 1)`;
var OWNER_RULES = (t) => `
  SELECT RAISE(ABORT, 'treasury_owner_type_invalid') WHERE ${t}.owner_type IS NULL OR ${t}.owner_type NOT IN ('company','owner_person')
    OR ${t}.ownership IS NOT (CASE ${t}.owner_type WHEN 'company' THEN 'company' ELSE 'owner' END);
  SELECT RAISE(ABORT, 'treasury_owner_ack_required') WHERE ${t}.owner_type = 'owner_person' AND NOT (
    ${t}.owner_ack IS 1 AND ${t}.owner_ack_by_user_id IS NOT NULL AND ${t}.owner_ack_at IS NOT NULL AND ${t}.owner_ack_text IS '${OWNER_PERSON_ACK_TEXT}');
  SELECT RAISE(ABORT, 'treasury_owner_ack_unexpected') WHERE ${t}.owner_type = 'company'
    AND (${t}.owner_ack IS NOT NULL OR ${t}.owner_ack_by_user_id IS NOT NULL OR ${t}.owner_ack_at IS NOT NULL OR ${t}.owner_ack_text IS NOT NULL);`;
var V1C_DDL = `
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

-- N7: the opening set is approved only after someone confirmed that all step-4 \xAB\u0642\u0628\u0644\u0627\u064B \u067E\u0631\u062F\u0627\u062E\u062A \u0634\u062F\u0647\xBB records are entered.
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
function financeSettingAsOf(db2, key, eventDate, scope = { type: "global" }) {
  const row = db2.prepare(`SELECT value FROM finance_settings WHERE key=? AND scope_type=? AND scope_id IS ? AND effective_from <= ?
    ORDER BY effective_from DESC, id DESC LIMIT 1`).get(key, scope.type, scope.type === "global" ? null : scope.id, eventDate);
  return row?.value ?? null;
}

// src/lib/gl-posting.ts
var GlPostingError = class extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
    this.name = "GlPostingError";
  }
  code;
};
var fail = (code, message) => {
  throw new GlPostingError(code, message);
};
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}
function addDays(date, days) {
  if (!isIsoDate(date)) fail("gl_bad_date");
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}
function tehranDateOf(iso2) {
  const d = typeof iso2 === "string" ? new Date(iso2) : iso2;
  if (Number.isNaN(d.getTime())) fail("gl_bad_date");
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  return ["year", "month", "day"].map((k) => p.find((x) => x.type === k).value).join("-");
}
function tomanToRial(v) {
  const s = typeof v === "bigint" ? v.toString() : String(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) fail("gl_bad_amount", "toman must be an integer");
  const r = Number(BigInt(s) * 10n);
  if (!Number.isSafeInteger(r)) fail("gl_bad_amount");
  return r;
}
function rial(v) {
  if (v === void 0 || v === null) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("gl_bad_amount", "rial must be a non-negative safe integer");
  return v;
}
function assertInTransaction(db2) {
  if (!db2.isTransaction) fail("gl_no_transaction");
}
var one = (db2, sql, ...p) => db2.prepare(sql).get(...p);
function fiscalYearFor(db2, eventDate) {
  if (!isIsoDate(eventDate)) fail("gl_bad_date");
  const fy = one(db2, "SELECT id,status,locked_until FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date", eventDate);
  if (!fy) fail("gl_no_fiscal_year", eventDate);
  return fy;
}
function isPeriodOpen(db2, eventDate) {
  const fy = one(db2, "SELECT status,locked_until FROM gl_fiscal_years WHERE ? BETWEEN start_date AND end_date", eventDate);
  return !!fy && fy.status !== "closed" && !(fy.locked_until && eventDate <= fy.locked_until);
}
var TAFSILI_TYPES = /* @__PURE__ */ new Set(["CU", "SP", "BK", "CB", "GW", "FD", "PL", "VN", "OW"]);
function ensureTafsili(db2, type, refId, title, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!TAFSILI_TYPES.has(type)) fail("gl_tafsili_type");
  if (!Number.isSafeInteger(refId) || refId <= 0) fail("gl_tafsili_ref");
  const found = one(db2, "SELECT id FROM gl_tafsili WHERE type=? AND ref_id=?", type, refId);
  if (found) return found.id;
  const safeTitle = String(title ?? "").trim() || `${type}-${refId}`;
  db2.prepare("INSERT INTO gl_tafsili(type,ref_id,code,title,active,created_at) VALUES(?,?,?,?,1,?)").run(type, refId, `${type}-${refId}`, safeTitle, nowIso);
  return one(db2, "SELECT id FROM gl_tafsili WHERE type=? AND ref_id=?", type, refId).id;
}
function resolveLines(db2, lines) {
  if (!Array.isArray(lines) || lines.length < 2) fail("gl_voucher_too_few_lines");
  return lines.map((l) => {
    const acc = one(db2, "SELECT id,postable,active,tafsili_types FROM gl_accounts WHERE code=?", l.account);
    if (!acc) fail("gl_account_unknown", l.account);
    if (!acc.postable || !acc.active) fail("gl_account_not_postable", l.account);
    const d = rial(l.debitRial), c = rial(l.creditRial);
    if ((d > 0 ? 1 : 0) + (c > 0 ? 1 : 0) !== 1) fail("gl_line_side", "each line is debit XOR credit, > 0");
    const tf = l.tafsiliId ?? null;
    if (tf !== null) {
      const t = one(db2, "SELECT type FROM gl_tafsili WHERE id=?", tf);
      if (!t) fail("gl_tafsili_unknown");
      const allowed = acc.tafsili_types.split(",").filter(Boolean);
      if (allowed.length && !allowed.includes(t.type)) fail("gl_tafsili_type_mismatch", `${l.account}:${t.type}`);
    }
    return { account_id: acc.id, code: l.account, tafsili_id: tf, tafsili2_id: l.tafsili2Id ?? null, debit_rial: d, credit_rial: c, description: String(l.description ?? "") };
  });
}
var fingerprint = (lines) => JSON.stringify(lines.map((l) => [l.account_id, l.tafsili_id ?? null, l.tafsili2_id ?? null, l.debit_rial, l.credit_rial]));
function existingBySourceKey(db2, sourceKey, eventDate, lines) {
  const v = one(db2, "SELECT id,temp_no,ref_no,event_date FROM gl_vouchers WHERE source_key=?", sourceKey);
  if (!v) return null;
  const have = db2.prepare("SELECT account_id,tafsili_id,tafsili2_id,debit_rial,credit_rial FROM gl_voucher_lines WHERE voucher_id=? ORDER BY line_no").all(v.id);
  if (v.event_date !== eventDate || fingerprint(have) !== fingerprint(lines)) fail("gl_source_conflict", sourceKey);
  return { voucherId: v.id, created: false, tempNo: v.temp_no, refNo: v.ref_no };
}
function postVoucher(db2, input) {
  assertInTransaction(db2);
  if (!input || typeof input.sourceKey !== "string" || !/^gl:[a-z0-9_:.-]{3,120}$/i.test(input.sourceKey)) fail("gl_source_key");
  if (!isIsoDate(input.eventDate)) fail("gl_bad_date");
  const kind = input.kindOverride ?? input.kind;
  if (!["auto", "manual", "opening", "backfill", "reversal"].includes(kind)) fail("gl_kind");
  const lines = resolveLines(db2, input.lines);
  const dr = lines.reduce((s, l) => s + l.debit_rial, 0), cr = lines.reduce((s, l) => s + l.credit_rial, 0);
  if (!Number.isSafeInteger(dr) || dr !== cr) fail("gl_voucher_unbalanced", `${dr}<>${cr}`);
  const prior = existingBySourceKey(db2, input.sourceKey, input.eventDate, lines);
  if (prior) return prior;
  const fy = fiscalYearFor(db2, input.eventDate);
  if (fy.status === "closed") fail("gl_fiscal_year_closed");
  if (fy.locked_until && input.eventDate <= fy.locked_until) fail("gl_period_locked", input.eventDate);
  const now = input.nowIso ?? (/* @__PURE__ */ new Date()).toISOString();
  db2.exec("SAVEPOINT gl_post_voucher");
  try {
    const tempNo = one(db2, "SELECT COALESCE(MAX(temp_no),0)+1 n FROM gl_vouchers WHERE fiscal_year_id=?", fy.id).n;
    const refNo = `GL-${fy.id}-${String(tempNo).padStart(6, "0")}`;
    const res = db2.prepare(`INSERT INTO gl_vouchers(fiscal_year_id,ref_no,temp_no,event_date,kind,description,source_type,source_id,source_key,reverses_voucher_id,total_rial,line_count,created_by_user_id,approved_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fy.id,
      refNo,
      tempNo,
      input.eventDate,
      kind,
      String(input.description ?? ""),
      input.sourceType ?? null,
      input.sourceId === void 0 || input.sourceId === null ? null : String(input.sourceId),
      input.sourceKey,
      input.reversesVoucherId ?? null,
      dr,
      lines.length,
      input.createdByUserId ?? null,
      input.approvedByUserId ?? null,
      now
    );
    const voucherId = Number(res.lastInsertRowid);
    const ins = db2.prepare("INSERT INTO gl_voucher_lines(voucher_id,line_no,account_id,tafsili_id,tafsili2_id,debit_rial,credit_rial,description) VALUES(?,?,?,?,?,?,?,?)");
    lines.forEach((l, i) => ins.run(voucherId, i + 1, l.account_id, l.tafsili_id, l.tafsili2_id, l.debit_rial, l.credit_rial, l.description));
    db2.prepare("INSERT INTO gl_voucher_seals(voucher_id,sealed_at) VALUES(?,?)").run(voucherId, now);
    db2.exec("RELEASE gl_post_voucher");
    return { voucherId, created: true, tempNo, refNo };
  } catch (e) {
    db2.exec("ROLLBACK TO gl_post_voucher");
    db2.exec("RELEASE gl_post_voucher");
    throw e;
  }
}
function reverseVoucher(db2, voucherId, opts) {
  assertInTransaction(db2);
  const v = one(db2, "SELECT id,kind,event_date,ref_no FROM gl_vouchers WHERE id=?", voucherId);
  if (!v) fail("gl_voucher_unknown");
  if (!one(db2, "SELECT 1 x FROM gl_voucher_seals WHERE voucher_id=?", voucherId)) fail("gl_voucher_unsealed");
  if (v.kind === "reversal") fail("gl_reverse_reversal");
  if (!opts || String(opts.reason ?? "").trim().length < 5) fail("gl_reason_required");
  const sourceKey = opts.sourceKey ?? `gl:reversal:${voucherId}`;
  const done = one(db2, "SELECT id,source_key FROM gl_vouchers WHERE reverses_voucher_id=?", voucherId);
  const eventDate = opts.eventDate ?? (isPeriodOpen(db2, v.event_date) ? v.event_date : fail("gl_period_locked", "reversal date required"));
  const lines = db2.prepare(`SELECT a.code account,l.tafsili_id,l.tafsili2_id,l.debit_rial,l.credit_rial,l.description FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.voucher_id=? ORDER BY l.line_no`).all(voucherId).map((l) => ({ account: l.account, tafsiliId: l.tafsili_id, tafsili2Id: l.tafsili2_id, debitRial: l.credit_rial, creditRial: l.debit_rial, description: l.description }));
  if (done && done.source_key !== sourceKey) fail("gl_already_reversed");
  return postVoucher(db2, {
    eventDate,
    kind: "auto",
    kindOverride: "reversal",
    reversesVoucherId: voucherId,
    description: `\u0628\u0631\u06AF\u0634\u062A \u0633\u0646\u062F ${v.ref_no}: ${String(opts.reason).trim()}`,
    sourceType: "gl_voucher",
    sourceId: voucherId,
    sourceKey,
    lines,
    createdByUserId: opts.byUserId ?? null,
    nowIso: opts.nowIso
  });
}
function recordGlException(db2, sourceType, sourceId, code, note, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  db2.prepare("INSERT OR IGNORE INTO gl_exceptions(source_type,source_id,code,note,created_at) VALUES(?,?,?,?,?)").run(sourceType, String(sourceId), code.slice(0, 120), note.slice(0, 500), nowIso);
}

// src/lib/gl-shadow.ts
var GL_SHADOW_MIGRATION = "general-ledger-g3-shadow-nonbank";
var GL_SHADOW_BANK_MIGRATION = "general-ledger-g4-shadow-bank";
var FLAG = `(SELECT value FROM gl_settings WHERE key='gl.shadow_nonbank')='1'`;
var BANK_FLAG = `(SELECT value FROM gl_settings WHERE key='gl.shadow_bank')='1'`;
var NOWSQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
var GL_MAPPING_DDL = `
CREATE TABLE IF NOT EXISTS gl_event_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL CHECK(event_code GLOB 'P[0-9]*'), version INTEGER NOT NULL CHECK(version >= 1),
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  UNIQUE(event_code, version), UNIQUE(event_code, effective_from));
CREATE TRIGGER IF NOT EXISTS gl_event_mappings_no_update BEFORE UPDATE ON gl_event_mappings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
CREATE TRIGGER IF NOT EXISTS gl_event_mappings_no_delete BEFORE DELETE ON gl_event_mappings BEGIN SELECT RAISE(ABORT, 'gl_append_only'); END;
`;
var GL_MAPPING_V1 = [
  ["P1", { dr: "8101", cr: "8102", deferred: "Q7" }, "\u062A\u062E\u0635\u06CC\u0635 \u0627\u0639\u062A\u0628\u0627\u0631 \u0648\u0627\u0645 (\u0627\u0646\u062A\u0638\u0627\u0645\u06CC\u061B \u0645\u0646\u062A\u0638\u0631 Q7)"],
  ["P2", { dr: "1103", cr: "2201" }, "\u067E\u0631\u062F\u0627\u062E\u062A \u0632\u0631\u06CC\u0646\u200C\u067E\u0627\u0644 \u062A\u0623\u06CC\u06CC\u062F\u0634\u062F\u0647"],
  ["P4", { dr: "2201", cr: "4103" }, "\u0647\u0632\u06CC\u0646\u0647\u200C\u06CC \u062A\u0634\u06A9\u06CC\u0644 \u067E\u0631\u0648\u0646\u062F\u0647"],
  ["P5", { dr: "2201", cr: "2201" }, "\u0627\u0646\u062A\u0642\u0627\u0644 \u0646\u0642\u062F\u06CC \u0628\u06CC\u0646 \u0645\u0634\u062A\u0631\u06CC\u0627\u0646"],
  ["P6", { dr: "8101", cr: "8101", deferred: "Q7" }, "\u0627\u0646\u062A\u0642\u0627\u0644 \u0627\u0639\u062A\u0628\u0627\u0631\u06CC (\u0627\u0646\u062A\u0638\u0627\u0645\u06CC\u061B \u0645\u0646\u062A\u0638\u0631 Q7)"],
  ["P7", {
    receivable: "1201",
    cogs: "5101",
    sales: "4101",
    payable: "2101",
    discount: { revenue_reduction: "4102", marketing_expense: "6103" },
    supported_methods: ["gross"],
    memo: { dr: "8102", cr: "8101", deferred: "Q7" }
  }, "\u062A\u0633\u0648\u06CC\u0647\u200C\u06CC \u062E\u0631\u06CC\u062F \u06A9\u0627\u0644\u0627"],
  ["P10", { expense: "6101", payable: "2102", kinds: ["salesperson_commission", "p1_referral_share"] }, "\u067E\u0648\u0631\u0633\u0627\u0646\u062A \u0641\u0631\u0648\u0634\u0646\u062F\u0647"],
  ["P11", { expense: "6102", payable: "2102", kinds: ["data_accuracy_bonus", "team_bonus"] }, "\u067E\u0627\u062F\u0627\u0634 \u062F\u0642\u062A \u062F\u0627\u062F\u0647 \u0648 \u062A\u06CC\u0645\u06CC"],
  ["P8", { dr: "2101", cr: "1102" }, "\u067E\u0631\u062F\u0627\u062E\u062A \u062F\u0633\u062A\u0648\u0631 \u067E\u0631\u062F\u0627\u062E\u062A \u0628\u0647 \u0645\u0634\u062A\u0631\u06CC"],
  ["P9", { reverses: "P8" }, "\u0628\u0631\u06AF\u0634\u062A \xAB\u067E\u0631\u062F\u0627\u062E\u062A\u200C\u0634\u062F\u0647\u200C\u06CC \u0627\u0634\u062A\u0628\u0627\u0647\xBB"],
  ["P18", { counter: "W3", deferred_counter: "W3" }, "\u0648\u0627\u0631\u06CC\u0632/\u0628\u0631\u062F\u0627\u0634\u062A \u062F\u0633\u062A\u06CC \u0628\u0627\u0646\u06A9 (\u062D\u0633\u0627\u0628 \u0645\u0642\u0627\u0628\u0644 \u0627\u0632 \u0648\u06CC\u0632\u0627\u0631\u062F W3)"],
  ["P12", { kinds: ["returned_case_deduction", "paid_mark_reversal"], expense_of: { salesperson_commission: "6101", p1_referral_share: "6101", data_accuracy_bonus: "6102", team_bonus: "6102" }, default_expense: "6101", payable: "2102" }, "\u06A9\u0633\u0631 \u067E\u0648\u0631\u0633\u0627\u0646\u062A"]
];
var P7_PREFUNDED_DRAFT = Object.freeze({ account: "2104", tafsili: "PL", noNegative: true, status: "awaiting_salamatian_p7_signoff" });
var P7_PREFUNDED_FLAG = "gl.p7_prefunded";
function p7CompanyShareAccount(db2, m, method, planTafsiliId, eventDate, amountRial) {
  if (method === "gross" && m.supported_methods.includes("gross")) return { account: m.receivable };
  if (method !== "prefunded_full_credit") return { skip: `gl_deferred:deposit_method:${method}`, note: "\u062D\u0633\u0627\u0628\u200C\u0647\u0627\u06CC \u0627\u06CC\u0646 \u0631\u0648\u0634 (\u06F2\u06F1\u06F0\u06F4/\u06F6\u06F1\u06F0\u06F4) \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A\u0646\u062F" };
  const rule = { ...P7_PREFUNDED_DRAFT, ...m.prefunded ?? {} };
  const flag2 = one2(db2, "SELECT value FROM gl_settings WHERE key=?", P7_PREFUNDED_FLAG)?.value === "1";
  if (!flag2) return { skip: "gl_deferred:deposit_method:prefunded_full_credit", note: "\u0642\u0627\u0639\u062F\u0647\u200C\u06CC \u062B\u0628\u062A P7 \u067E\u06CC\u0634\u200C\u062F\u0631\u06CC\u0627\u0641\u062A \u06A9\u0627\u0645\u0644 \u0627\u0639\u062A\u0628\u0627\u0631 \u0645\u0646\u062A\u0638\u0631 \u062A\u0623\u06CC\u06CC\u062F \u062E\u0627\u0646\u0645 \u0633\u0644\u0627\u0645\u062A\u06CC\u0627\u0646 \u0627\u0633\u062A" };
  const acc = one2(db2, "SELECT id,active FROM gl_accounts WHERE code=?", rule.account);
  if (!acc || !acc.active) return { skip: `gl_account_inactive:${rule.account}`, note: `\u06A9\u062F \u062D\u0633\u0627\u0628 ${rule.account} \u0645\u0646\u062A\u0638\u0631 \u062A\u0623\u06CC\u06CC\u062F \u0622\u0631\u0645\u06CC\u062A\u0627 \u0648 \u062E\u0627\u0646\u0645 \u0633\u0644\u0627\u0645\u062A\u06CC\u0627\u0646 \u0627\u0633\u062A` };
  if (rule.noNegative && amountRial > 0) {
    const b = one2(db2, `SELECT COALESCE(SUM(l.credit_rial),0)-COALESCE(SUM(l.debit_rial),0) bal FROM gl_voucher_lines l JOIN gl_vouchers v ON v.id=l.voucher_id
      WHERE l.account_id=? AND l.tafsili_id IS ? AND v.event_date<=?`, acc.id, planTafsiliId, eventDate);
    if (Number(b?.bal ?? 0) < amountRial) return { skip: "gl_prefunded_insufficient:2104", note: "\u0645\u0627\u0646\u062F\u0647\u200C\u06CC \u067E\u06CC\u0634\u200C\u062F\u0631\u06CC\u0627\u0641\u062A \u0627\u06CC\u0646 \u0637\u0631\u062D \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u062E\u0631\u06CC\u062F \u06A9\u0627\u0641\u06CC \u0646\u06CC\u0633\u062A (\u0642\u0627\u0639\u062F\u0647\u200C\u06CC \u067E\u06CC\u0634\u0646\u0647\u0627\u062F\u06CC: \u06F2\u06F1\u06F0\u06F4 \u0645\u0646\u0641\u06CC \u0646\u0634\u0648\u062F)" };
  }
  return { account: rule.account };
}
var COMMISSION_KINDS = ["salesperson_commission", "p1_referral_share", "data_accuracy_bonus", "team_bonus", "returned_case_deduction", "paid_mark_reversal"];
var q = (s) => `'${s.replace(/'/g, "''")}'`;
function captureTriggers(db2) {
  const has2 = (t) => !!db2.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const ins = (key, ev, st, sid, payload) => `INSERT OR IGNORE INTO gl_posting_queue(source_key,event_type,source_type,source_id,payload_json,status,attempts,created_at,updated_at)
     VALUES(${key}, ${ev}, ${q(st)}, CAST(${sid} AS TEXT), COALESCE(${payload},'{}'), 'pending', 0, ${NOWSQL}, ${NOWSQL});`;
  const out = [];
  if (has2("wallet_ledger_v2")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_wallet_ledger AFTER INSERT ON wallet_ledger_v2
    WHEN ${FLAG} AND (NEW.kind='cash_payment' OR NEW.kind LIKE 'loan_credit:%')
    BEGIN ${ins(
    `CASE WHEN NEW.kind='cash_payment' THEN 'gl:'||NEW.idempotency_key ELSE 'gl:loan-credit:'||NEW.id END`,
    `CASE WHEN NEW.kind='cash_payment' THEN 'P2' ELSE 'P1' END`,
    "wallet_ledger_v2",
    "NEW.id",
    `json_object('at',NEW.created_at)`
  )} END;`);
  if (has2("loan_filing_fee_charges")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_filing_fee AFTER INSERT ON loan_filing_fee_charges
    WHEN ${FLAG} AND NEW.amount_toman NOT IN ('0','')
    BEGIN ${ins(`'gl:filing-fee:'||NEW.id`, `'P4'`, "loan_filing_fee_charges", "NEW.id", `json_object('at',NEW.created_at)`)} END;`);
  if (has2("wallet_transfers")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_wallet_transfer AFTER INSERT ON wallet_transfers
    WHEN ${FLAG} AND NEW.status='completed'
    BEGIN ${ins(`'gl:wallet-transfer:'||NEW.id`, `CASE NEW.wallet_type WHEN 'cash' THEN 'P5' ELSE 'P6' END`, "wallet_transfers", "NEW.id", `json_object('at',NEW.created_at)`)} END;`);
  if (has2("goods_finance_ledger") && has2("goods_purchases")) out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_goods_finance AFTER INSERT ON goods_finance_ledger
    WHEN ${FLAG} AND (NEW.kind='company_credit' OR NEW.kind IN (${COMMISSION_KINDS.map(q).join(",")}))
    BEGIN ${ins(
    `CASE WHEN NEW.kind='company_credit' THEN 'gl:goods:'||NEW.purchase_id||':settle' ELSE 'gl:goods-fin:'||NEW.id END`,
    `CASE WHEN NEW.kind='company_credit' THEN 'P7' WHEN NEW.kind IN ('salesperson_commission','p1_referral_share') THEN 'P10' WHEN NEW.kind IN ('data_accuracy_bonus','team_bonus') THEN 'P11' ELSE 'P12' END`,
    "goods_finance_ledger",
    "NEW.id",
    `CASE WHEN NEW.kind='company_credit' THEN (SELECT json_object('at',NEW.created_at,'purchase_id',p.id,'plan_id',p.plan_id,'customer_id',p.customer_id,
          'credit',p.credit_amount_toman,'payout',p.payout_amount_toman,'base_payout',p.base_payout_amount_toman,'discount',p.development_discount_toman,
          'company',p.company_credit_toman,'fee_discount',p.fee_discount_toman) FROM goods_purchases p WHERE p.id=NEW.purchase_id)
        ELSE json_object('at',NEW.created_at) END`
  )} END;`);
  if (has2("accounting_documents")) {
    const rev = `CASE WHEN instr(NEW.request_key,':r')>0 THEN substr(NEW.request_key,instr(NEW.request_key,':r')+2) ELSE '0' END`;
    const rest = `substr(NEW.request_key,16)`;
    const rOrder = `substr(${rest},1,instr(${rest},':')-1)`, rRev = `CAST(substr(${rest},instr(${rest},':')+1) AS INTEGER)`;
    out.push(`CREATE TRIGGER IF NOT EXISTS gl_capture_accounting_doc AFTER INSERT ON accounting_documents
    WHEN ${BANK_FLAG} AND (NEW.source='payment_order' OR NEW.source='manual')
    BEGIN ${ins(
      `CASE WHEN NEW.source='payment_order' THEN 'gl:payment-order:'||NEW.source_order_id||':r'||${rev}
            WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN 'gl:payment-order:'||${rOrder}||':r'||(${rRev}-1)||':reversal'
            ELSE 'gl:acc-doc:'||NEW.id END`,
      `CASE WHEN NEW.source='payment_order' THEN 'P8' WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN 'P9' ELSE 'P18' END`,
      "accounting_documents",
      "NEW.id",
      `CASE WHEN NEW.source='payment_order' THEN json_object('at',NEW.created_at,'event_date',NEW.transaction_date,'order_id',NEW.source_order_id,'rev',${rev})
            WHEN NEW.request_key GLOB 'payment-revert:*:*' THEN json_object('at',NEW.created_at,'event_date',NEW.document_date,'order_id',${rOrder},'orig_key','gl:payment-order:'||${rOrder}||':r'||(${rRev}-1))
            ELSE json_object('at',NEW.created_at,'event_date',NEW.transaction_date) END`
    )} END;`);
  }
  return out;
}
function ensureGlShadowSchema(db2, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  db2.exec("SAVEPOINT gl_shadow_ensure");
  try {
    db2.exec(GL_MAPPING_DDL);
    const seed = db2.prepare("INSERT OR IGNORE INTO gl_event_mappings(event_code,version,effective_from,mapping_json,note,created_at) VALUES(?,1,'2000-01-01',?,?,?)");
    for (const [ev, m, note] of GL_MAPPING_V1) seed.run(ev, JSON.stringify(m), note, nowIso);
    for (const sql of captureTriggers(db2)) db2.exec(sql);
    db2.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(GL_SHADOW_MIGRATION, nowIso);
    db2.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)").run(GL_SHADOW_BANK_MIGRATION, nowIso);
    db2.exec("RELEASE gl_shadow_ensure");
  } catch (e) {
    db2.exec("ROLLBACK TO gl_shadow_ensure");
    db2.exec("RELEASE gl_shadow_ensure");
    throw e;
  }
}
function glMappingAsOf(db2, eventCode, eventDate) {
  const r = db2.prepare("SELECT version,mapping_json FROM gl_event_mappings WHERE event_code=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1").get(eventCode, eventDate);
  if (!r) throw new Error(`gl_mapping_missing:${eventCode}`);
  return { version: r.version, m: JSON.parse(r.mapping_json) };
}
var one2 = (db2, sql, ...p) => db2.prepare(sql).get(...p);
var cu = (db2, id, now) => ensureTafsili(db2, "CU", id, `\u0645\u0634\u062A\u0631\u06CC #${id}`, now);
var sp = (db2, id, now) => ensureTafsili(db2, "SP", id, `\u0641\u0631\u0648\u0634\u0646\u062F\u0647 #${id}`, now);
var pl = (db2, id, now) => ensureTafsili(db2, "PL", id, `\u0637\u0631\u062D #${id}`, now);
var bk = (db2, id, now) => ensureTafsili(db2, "BK", id, `\u0628\u0627\u0646\u06A9 #${id}`, now);
var absToman = (v) => {
  const s = String(v).trim();
  return s.startsWith("-") ? s.slice(1) : s;
};
function buildShadowVoucher(db2, row, nowIso) {
  const payload = JSON.parse(row.payload_json || "{}");
  const at = String(payload.at ?? "");
  const ev = String(payload.event_date ?? "");
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(ev) ? ev : tehranDateOf(at);
  const start = financeSettingAsOf(db2, "gl.ledger_start_date", eventDate);
  if (!start) throw new Error("finance_setting_missing:gl.ledger_start_date");
  if (eventDate < start) return { skip: "gl_before_ledger_start", note: "\u067E\u06CC\u0634 \u0627\u0632 \u0634\u0631\u0648\u0639 \u062F\u0641\u062A\u0631\u061B \u062F\u0631 \u0627\u0641\u062A\u062A\u0627\u062D\u06CC\u0647/\u0628\u0627\u0632\u067E\u062E\u0634" };
  const { version, m } = glMappingAsOf(db2, row.event_type, eventDate);
  if (m.deferred) return { skip: `gl_deferred:${m.deferred}`, note: `\u0631\u0648\u06CC\u062F\u0627\u062F ${row.event_type} \u0645\u0646\u062A\u0638\u0631 \u067E\u0627\u0633\u062E ${m.deferred}` };
  const base = { eventDate, kind: "auto", sourceKey: row.source_key, sourceType: row.source_type, sourceId: row.source_id, nowIso };
  const sid = Number(row.source_id);
  const desc = (t) => `${t} (\u0646\u06AF\u0627\u0634\u062A ${row.event_type} \u0646\u0633\u062E\u0647 ${version})`;
  switch (row.event_type) {
    case "P2": {
      const l = one2(db2, "SELECT l.amount, w.customer_id, l.idempotency_key key FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id WHERE l.id=?", sid);
      if (!l) throw new Error("gl_source_missing");
      const r = tomanToRial(l.amount);
      return { post: { ...base, description: desc("\u067E\u0631\u062F\u0627\u062E\u062A \u0632\u0631\u06CC\u0646\u200C\u067E\u0627\u0644"), lines: [{ account: m.dr, debitRial: r }, { account: m.cr, tafsiliId: cu(db2, l.customer_id, nowIso), creditRial: r }] } };
    }
    case "P4": {
      const f = one2(db2, "SELECT amount_toman, customer_id, plan_id FROM loan_filing_fee_charges WHERE id=?", sid);
      if (!f) throw new Error("gl_source_missing");
      const r = tomanToRial(f.amount_toman);
      if (r === 0) return { skip: "gl_zero_amount", note: "\u0647\u0632\u06CC\u0646\u0647\u200C\u06CC \u0635\u0641\u0631 \u0633\u0646\u062F \u0646\u062F\u0627\u0631\u062F" };
      return { post: { ...base, description: desc("\u0647\u0632\u06CC\u0646\u0647\u200C\u06CC \u062A\u0634\u06A9\u06CC\u0644 \u067E\u0631\u0648\u0646\u062F\u0647"), lines: [{ account: m.dr, tafsiliId: cu(db2, f.customer_id, nowIso), debitRial: r }, { account: m.cr, tafsiliId: pl(db2, f.plan_id, nowIso), creditRial: r }] } };
    }
    case "P5": {
      const t = one2(db2, "SELECT from_customer_id,to_customer_id,amount_toman FROM wallet_transfers WHERE id=? AND status='completed'", sid);
      if (!t) throw new Error("gl_source_missing");
      const r = tomanToRial(t.amount_toman);
      return { post: { ...base, description: desc("\u0627\u0646\u062A\u0642\u0627\u0644 \u0646\u0642\u062F\u06CC \u0628\u06CC\u0646 \u0645\u0634\u062A\u0631\u06CC\u0627\u0646"), lines: [{ account: m.dr, tafsiliId: cu(db2, t.from_customer_id, nowIso), debitRial: r }, { account: m.cr, tafsiliId: cu(db2, t.to_customer_id, nowIso), creditRial: r }] } };
    }
    case "P7": {
      const pid = Number(payload.purchase_id), planId = Number(payload.plan_id), custId = Number(payload.customer_id);
      if (!pid || !planId || !custId) throw new Error("gl_source_missing");
      recordGlException(db2, "goods_purchases", pid, "gl_deferred:Q7:memo", "\u0633\u0646\u062F \u0627\u0646\u062A\u0638\u0627\u0645\u06CC \u06F8\u06F1\u06F0\u06F1/\u06F8\u06F1\u06F0\u06F2 \u0645\u0646\u062A\u0638\u0631 Q7", nowIso);
      const method = financeSettingAsOf(db2, "plan.supplier_deposit_method", eventDate, { type: "loan_plan", id: planId });
      const nature = financeSettingAsOf(db2, "discount.development.nature", eventDate);
      const missing = [!method && "plan.supplier_deposit_method", !nature && "discount.development.nature"].filter(Boolean);
      if (missing.length) return { skip: `finance_setting_missing:${missing.join(",")}`, note: "\u062A\u0646\u0638\u06CC\u0645 \u0645\u0627\u0644\u06CC \u062F\u0631 \u062A\u0627\u0631\u06CC\u062E \u0631\u0648\u06CC\u062F\u0627\u062F \u062E\u0627\u0644\u06CC \u0627\u0633\u062A" };
      if (method !== "prefunded_full_credit" && !m.supported_methods.includes(method)) return { skip: `gl_deferred:deposit_method:${method}`, note: "\u062D\u0633\u0627\u0628\u200C\u0647\u0627\u06CC \u0627\u06CC\u0646 \u0631\u0648\u0634 (\u06F2\u06F1\u06F0\u06F4/\u06F6\u06F1\u06F0\u06F4) \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A\u0646\u062F" };
      const discountAcc = m.discount[nature];
      if (!discountAcc || nature === "marketing_expense") return { skip: `gl_deferred:discount_nature:${nature}`, note: "\u062D\u0633\u0627\u0628 \u06F6\u06F1\u06F0\u06F3 \u0648 \u0630\u06CC\u200C\u0646\u0641\u0639 \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A\u0646\u062F" };
      const credit = tomanToRial(String(payload.credit)), discount = tomanToRial(String(payload.discount)), company = tomanToRial(String(payload.company)), payout = tomanToRial(String(payload.payout));
      if (company + discount !== credit) throw new Error("gl_p7_amounts_inconsistent");
      const plT0 = method === "prefunded_full_credit" ? one2(db2, "SELECT id FROM gl_tafsili WHERE type='PL' AND ref_id=?", planId)?.id ?? null : null;
      const share = p7CompanyShareAccount(db2, m, method, plT0, eventDate, company);
      if ("skip" in share) return share;
      const plT = pl(db2, planId, nowIso), cuT = cu(db2, custId, nowIso);
      const prefunded = share.account !== m.receivable;
      const lines = [
        { account: share.account, tafsiliId: plT, debitRial: company, description: prefunded ? "\u0633\u0647\u0645 \u0634\u0631\u06A9\u062A \u0627\u0632 \u067E\u06CC\u0634\u200C\u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0623\u0645\u06CC\u0646\u200C\u06A9\u0646\u0646\u062F\u0647" : "\u0633\u0647\u0645 \u0634\u0631\u06A9\u062A" },
        { account: discountAcc, tafsiliId: plT, debitRial: discount, description: "\u062A\u062E\u0641\u06CC\u0641 \u062A\u0648\u0633\u0639\u0647" },
        { account: m.cogs, tafsiliId: plT, debitRial: payout, description: `\u067E\u0631\u062F\u0627\u062E\u062A\u06CC \u0645\u0634\u062A\u0631\u06CC (\u067E\u0627\u06CC\u0647 ${payload.base_payout ?? "-"} \u060C \u06A9\u0633\u0631 \u06A9\u0627\u0631\u0645\u0632\u062F ${payload.fee_discount ?? "0"} \u062A\u0648\u0645\u0627\u0646)` },
        { account: m.sales, tafsiliId: plT, creditRial: credit, description: "\u0641\u0631\u0648\u0634 \u0627\u0639\u062A\u0628\u0627\u0631\u06CC" },
        { account: m.payable, tafsiliId: cuT, creditRial: payout, description: "\u062A\u0639\u0647\u062F \u067E\u0631\u062F\u0627\u062E\u062A \u0628\u0647 \u0645\u0634\u062A\u0631\u06CC" }
      ].filter((l) => (l.debitRial ?? 0) > 0 || (l.creditRial ?? 0) > 0);
      return { post: { ...base, sourceType: "goods_purchases", sourceId: pid, description: desc(`\u062A\u0633\u0648\u06CC\u0647\u200C\u06CC \u062E\u0631\u06CC\u062F #${pid}`), lines } };
    }
    case "P10":
    case "P11":
    case "P12": {
      const g = one2(db2, "SELECT id,kind,amount_toman,salesperson_id FROM goods_finance_ledger WHERE id=?", sid);
      if (!g) throw new Error("gl_source_missing");
      if (!g.salesperson_id) throw new Error("gl_salesperson_missing");
      const neg = String(g.amount_toman).trim().startsWith("-");
      const r = tomanToRial(absToman(g.amount_toman));
      if (r === 0) return { skip: "gl_zero_amount", note: "\u0631\u062F\u06CC\u0641 \u0635\u0641\u0631" };
      let expense = m.expense;
      if (row.event_type === "P12") {
        const meta = one2(db2, "SELECT meta_json FROM team_commission_ledger_meta WHERE ledger_id=?", g.id);
        const rk = meta?.meta_json ? JSON.parse(meta.meta_json).reversedKind : void 0;
        expense = rk && m.expense_of[rk] || m.default_expense;
      }
      const spT = sp(db2, g.salesperson_id, nowIso);
      const reverse = row.event_type === "P12" || neg;
      const lines = reverse ? [{ account: m.payable, tafsiliId: spT, debitRial: r }, { account: expense, tafsiliId: spT, creditRial: r }] : [{ account: expense, tafsiliId: spT, debitRial: r }, { account: m.payable, tafsiliId: spT, creditRial: r }];
      return { post: { ...base, description: desc(`${g.kind}`), lines } };
    }
    case "P8": {
      const d = one2(db2, "SELECT fund_id,amount_toman,transaction_type,source FROM accounting_documents WHERE id=?", sid);
      if (!d || d.source !== "payment_order" || d.transaction_type !== "withdrawal") throw new Error("gl_source_missing");
      const oid = Number(payload.order_id);
      const o = one2(db2, "SELECT customer_id,purchase_id FROM customer_payment_orders WHERE id=?", oid);
      if (!o) throw new Error("gl_source_missing");
      const r = tomanToRial(d.amount_toman);
      return { post: {
        ...base,
        sourceType: "customer_payment_orders",
        sourceId: oid,
        description: desc(`\u067E\u0631\u062F\u0627\u062E\u062A \u062F\u0633\u062A\u0648\u0631 \u067E\u0631\u062F\u0627\u062E\u062A #${oid} (r${payload.rev ?? 0})`),
        lines: [{ account: m.dr, tafsiliId: cu(db2, o.customer_id, nowIso), debitRial: r, description: o.purchase_id ? `\u062E\u0631\u06CC\u062F #${o.purchase_id}` : "" }, { account: m.cr, tafsiliId: bk(db2, d.fund_id, nowIso), creditRial: r }]
      } };
    }
    case "P9": {
      const origKey = String(payload.orig_key ?? "");
      const v = one2(db2, "SELECT id FROM gl_vouchers WHERE source_key=?", origKey);
      if (v) return { reverse: { voucherId: v.id, eventDate, reason: `\u0628\u0631\u06AF\u0634\u062A \xAB\u067E\u0631\u062F\u0627\u062E\u062A\u200C\u0634\u062F\u0647\u200C\u06CC \u0627\u0634\u062A\u0628\u0627\u0647\xBB \u062F\u0633\u062A\u0648\u0631 #${payload.order_id}`, sourceKey: row.source_key } };
      const q0 = one2(db2, "SELECT status,last_error FROM gl_posting_queue WHERE source_key=?", origKey);
      if (!q0) return { skip: "gl_original_not_captured", note: `\u0633\u0646\u062F \u067E\u0631\u062F\u0627\u062E\u062A ${origKey} \u062F\u0631 \u0635\u0641 \u0646\u06CC\u0633\u062A (\u067E\u06CC\u0634 \u0627\u0632 \u0631\u0648\u0634\u0646 \u0634\u062F\u0646 \u067E\u0631\u0686\u0645\u061B \u062C\u0628\u0631\u0627\u0646 G6)` };
      if (q0.status === "skipped") return { skip: `gl_original_skipped:${q0.last_error ?? "-"}`, note: `\u0633\u0646\u062F \u067E\u0631\u062F\u0627\u062E\u062A \u0627\u0635\u0644\u06CC \u062B\u0628\u062A \u0646\u0634\u062F\u0647 \u0628\u0648\u062F\u061B \u0628\u0631\u06AF\u0634\u062A \u0647\u0645 \u0633\u0646\u062F \u0646\u062F\u0627\u0631\u062F` };
      throw new Error("gl_original_pending");
    }
    case "P18":
      return { skip: "gl_deferred:W3:counter_account", note: "\u0633\u0646\u062F \u062F\u0633\u062A\u06CC \u0628\u0627\u0646\u06A9: \u062D\u0633\u0627\u0628 \u0645\u0642\u0627\u0628\u0644 \u0628\u0627\u06CC\u062F \u062F\u0631 \u0648\u06CC\u0632\u0627\u0631\u062F W3 \u0627\u0646\u062A\u062E\u0627\u0628 \u0634\u0648\u062F" };
    default:
      throw new Error(`gl_event_unknown:${row.event_type}`);
  }
}

// src/lib/gl-backfill.ts
var has = (db2, t) => !!db2.prepare("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?").get(t);
var iso = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
};
var one3 = (db2, sql, ...p) => db2.prepare(sql).get(...p);
var STD_P7 = /^goods:(\d+):company_credit$/;
var COMMISSION = { salesperson_commission: "P10", p1_referral_share: "P10", data_accuracy_bonus: "P11", team_bonus: "P11", returned_case_deduction: "P12", paid_mark_reversal: "P12" };
function collectBackfillEvents(db2) {
  const out = [];
  const push = (e) => out.push({ ...e, at: iso(e.at), backfillKey: `gl:backfill:${e.table}:${e.id}` });
  if (has(db2, "wallet_ledger_v2")) {
    for (const r of db2.prepare("SELECT id,kind,idempotency_key k,created_at FROM wallet_ledger_v2 WHERE kind='cash_payment' OR kind LIKE 'loan_credit:%'").all()) {
      const p2 = r.kind === "cash_payment";
      push({ at: r.created_at, table: "wallet_ledger_v2", id: r.id, eventType: p2 ? "P2" : "P1", sourceKey: p2 ? `gl:${r.k}` : `gl:loan-credit:${r.id}`, sourceType: "wallet_ledger_v2", sourceId: String(r.id), payload: { at: r.created_at } });
    }
  }
  if (has(db2, "loan_filing_fee_charges")) {
    for (const r of db2.prepare("SELECT id,created_at FROM loan_filing_fee_charges WHERE amount_toman NOT IN ('0','')").all())
      push({ at: r.created_at, table: "loan_filing_fee_charges", id: r.id, eventType: "P4", sourceKey: `gl:filing-fee:${r.id}`, sourceType: "loan_filing_fee_charges", sourceId: String(r.id), payload: { at: r.created_at } });
  }
  if (has(db2, "wallet_transfers")) {
    for (const r of db2.prepare("SELECT id,wallet_type,created_at FROM wallet_transfers WHERE status='completed'").all())
      push({ at: r.created_at, table: "wallet_transfers", id: r.id, eventType: r.wallet_type === "cash" ? "P5" : "P6", sourceKey: `gl:wallet-transfer:${r.id}`, sourceType: "wallet_transfers", sourceId: String(r.id), payload: { at: r.created_at } });
  }
  if (has(db2, "goods_finance_ledger") && has(db2, "goods_purchases")) {
    const rows = db2.prepare("SELECT id,purchase_id,kind,amount_toman,idempotency_key k,created_at FROM goods_finance_ledger ORDER BY id").all();
    const corrections = /* @__PURE__ */ new Map();
    for (const r of rows) {
      if (r.kind === "company_credit") {
        const std = STD_P7.exec(r.k);
        if (std && Number(std[1]) === r.purchase_id) {
          const p = one3(
            db2,
            "SELECT id,plan_id,customer_id,credit_amount_toman,payout_amount_toman,base_payout_amount_toman,fee_discount_toman FROM goods_purchases WHERE id=?",
            r.purchase_id
          );
          const disc = one3(db2, "SELECT amount_toman a FROM goods_finance_ledger WHERE idempotency_key=?", `goods:${r.purchase_id}:development_discount`)?.a ?? "0";
          const credit = (BigInt(String(r.amount_toman).trim()) + BigInt(String(disc).trim())).toString();
          push({
            at: r.created_at,
            table: "goods_finance_ledger",
            id: r.id,
            eventType: "P7",
            sourceKey: `gl:goods:${r.purchase_id}:settle`,
            sourceType: "goods_finance_ledger",
            sourceId: String(r.id),
            payload: p ? {
              at: r.created_at,
              purchase_id: p.id,
              plan_id: p.plan_id,
              customer_id: p.customer_id,
              credit,
              payout: p.payout_amount_toman,
              base_payout: p.base_payout_amount_toman,
              discount: disc,
              company: r.amount_toman,
              fee_discount: p.fee_discount_toman,
              purchase_credit: p.credit_amount_toman
            } : { at: r.created_at }
          });
        } else {
          const prefix = r.k.endsWith(":company_credit") ? r.k.slice(0, -":company_credit".length) : r.k;
          corrections.set(prefix, [...corrections.get(prefix) ?? [], r]);
        }
      } else if (COMMISSION[r.kind]) {
        push({ at: r.created_at, table: "goods_finance_ledger", id: r.id, eventType: COMMISSION[r.kind], sourceKey: `gl:goods-fin:${r.id}`, sourceType: "goods_finance_ledger", sourceId: String(r.id), payload: { at: r.created_at } });
      }
    }
    for (const [prefix, cc] of corrections) {
      const all = rows.filter((r) => r.k.startsWith(`${prefix}:`) && (r.kind === "company_credit" || r.kind === "development_discount"));
      const first = cc[0];
      push({
        at: first.created_at,
        table: "goods_finance_ledger",
        id: first.id,
        eventType: "P7C",
        sourceKey: `gl:goods:${first.purchase_id}:correction:${first.id}`,
        sourceType: "goods_finance_ledger",
        sourceId: String(first.id),
        payload: { at: first.created_at, purchase_id: first.purchase_id, rows: all.map((r) => [r.id, r.kind, r.amount_toman]) }
      });
    }
  }
  if (has(db2, "accounting_documents")) {
    for (const d of db2.prepare("SELECT id,source,source_order_id,request_key,transaction_date,document_date,created_at FROM accounting_documents WHERE source IN ('payment_order','manual')").all()) {
      const rk = String(d.request_key ?? "");
      const rev = rk.includes(":r") ? rk.slice(rk.indexOf(":r") + 2) : "0";
      const m = /^payment-revert:([^:]+):(\d+)$/.exec(rk);
      if (d.source === "payment_order") push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P8", sourceKey: `gl:payment-order:${d.source_order_id}:r${rev}`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.transaction_date, order_id: d.source_order_id, rev } });
      else if (m) push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P9", sourceKey: `gl:payment-order:${m[1]}:r${Number(m[2]) - 1}:reversal`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.document_date, order_id: m[1], orig_key: `gl:payment-order:${m[1]}:r${Number(m[2]) - 1}` } });
      else push({ at: d.created_at, table: "accounting_documents", id: d.id, eventType: "P18", sourceKey: `gl:acc-doc:${d.id}`, sourceType: "accounting_documents", sourceId: String(d.id), payload: { at: d.created_at, event_date: d.transaction_date } });
    }
  }
  const tOrder = ["wallet_ledger_v2", "loan_filing_fee_charges", "wallet_transfers", "goods_finance_ledger", "accounting_documents"];
  return out.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : tOrder.indexOf(a.table) - tOrder.indexOf(b.table) || a.id - b.id);
}
var FORCED_CODE = "gl_forced_post_after_start";
function forcedPostDigest(e) {
  return createHash("sha256").update(JSON.stringify([e.seq, e.purchaseId, e.reason, e.decision, e.decidedBy, e.decidedAt, e.addedAt])).digest("hex").slice(0, 16);
}
function validateForcedPostList(raw) {
  const bad = (why) => {
    throw new Error(`gl_forced_post_list_invalid:${why}`);
  };
  const entries = raw && typeof raw === "object" && Array.isArray(raw.entries) ? raw.entries : bad("no_entries");
  const seen = /* @__PURE__ */ new Set();
  return entries.map((x, i) => {
    const e = x;
    if (!e || typeof e !== "object") bad(`entry_${i + 1}`);
    if (e.seq !== i + 1) bad(`seq_${i + 1}`);
    if (!Number.isSafeInteger(e.purchaseId) || e.purchaseId <= 0) bad(`purchase_${i + 1}`);
    if (seen.has(e.purchaseId)) bad(`duplicate_purchase_${e.purchaseId}`);
    seen.add(e.purchaseId);
    for (const k of ["reason", "decision", "decidedBy", "decidedAt", "addedAt"]) if (typeof e[k] !== "string" || !e[k].trim() || e[k].length > 300) bad(`${k}_${i + 1}`);
    return { seq: e.seq, purchaseId: e.purchaseId, reason: e.reason, decision: e.decision, decidedBy: e.decidedBy, decidedAt: e.decidedAt, addedAt: e.addedAt };
  });
}
function assertForcedAppendOnly(db2, list) {
  const bySeq = new Map(list.map((e) => [e.seq, e]));
  for (const r of db2.prepare(`SELECT source_id, code, note FROM gl_exceptions WHERE code LIKE '${FORCED_CODE}:%'`).all()) {
    const seq = Number(/^gl_forced_post_after_start:(\d+)/.exec(r.code)?.[1]);
    const dg = /digest=([0-9a-f]{16})/.exec(r.note)?.[1];
    const e = bySeq.get(seq);
    if (!e || String(e.purchaseId) !== r.source_id || forcedPostDigest(e) !== dg) throw new Error(`gl_forced_post_list_not_append_only:seq_${seq}`);
  }
}
var eventDateOf = (e) => {
  const ev = String(e.payload.event_date ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(ev) ? ev : tehranDateOf(String(e.payload.at ?? e.at));
};
var endOfTehranDay = (d) => new Date(Date.parse(`${addDays(d, 1)}T00:00:00+03:30`)).toISOString();
function buildEvent(db2, e, nowIso, forced) {
  const row = { id: 0, source_key: e.sourceKey, event_type: e.eventType, source_type: e.sourceType, source_id: e.sourceId, payload_json: JSON.stringify(e.payload), attempts: 0 };
  if (e.eventType !== "P7" && e.eventType !== "P7C") return buildShadowVoucher(db2, row, nowIso);
  const eventDate = eventDateOf(e);
  const start = financeSettingAsOf(db2, "gl.ledger_start_date", eventDate);
  if (!start) throw new Error("finance_setting_missing:gl.ledger_start_date");
  const pid = Number(e.payload.purchase_id);
  const f = forced.get(pid);
  const base = eventDate < start && !f ? null : financeSettingAsOf(db2, "gl.opening_base_date", eventDate);
  if (eventDate < start && !f) return { skip: "gl_before_ledger_start", note: "\u067E\u06CC\u0634 \u0627\u0632 \u0634\u0631\u0648\u0639 \u062F\u0641\u062A\u0631\u061B \u0645\u0627\u0646\u062F\u0647 \u062F\u0631 \u0633\u0646\u062F \u0627\u0641\u062A\u062A\u0627\u062D\u06CC\u0647" };
  if (!base) throw new Error("finance_setting_missing:gl.opening_base_date");
  const orders = has(db2, "customer_payment_orders") ? db2.prepare("SELECT id, created_at FROM customer_payment_orders WHERE purchase_id=? ORDER BY created_at, id").all(pid) : [];
  const inOpening = orders.find((o) => iso(o.created_at) < endOfTehranDay(base));
  if (f && (eventDate < start || eventDate <= base)) {
    if (inOpening) return { skip: `gl_forced_post_conflict:in_opening_2101`, note: `\u0627\u0633\u062A\u062B\u0646\u0627\u06CC \u062A\u0627\u0631\u06CC\u062E\u200C\u062F\u0627\u0631 #${f.seq} \u0631\u062F \u0634\u062F: \u062F\u0633\u062A\u0648\u0631 \u067E\u0631\u062F\u0627\u062E\u062A #${inOpening.id} \u062F\u0631 \u062C\u0645\u0639 \u06F2\u06F1\u06F0\u06F1 \u0627\u0641\u062A\u062A\u0627\u062D\u06CC\u0647 \u0627\u0633\u062A (\u062B\u0628\u062A \u062F\u0648\u0628\u0627\u0631\u0647 \u0646\u0645\u06CC\u200C\u0634\u0648\u062F)` };
    const startEff = financeSettingAsOf(db2, "gl.ledger_start_date", addDays(base, 1)) ?? start;
    const cands = [start, startEff, addDays(base, 1), ...orders[0] ? [tehranDateOf(iso(orders[0].created_at))] : []];
    const postDate = cands.reduce((a, b2) => a > b2 ? a : b2);
    const why = orders[0] ? `= max(\u0634\u0631\u0648\u0639 \u062F\u0641\u062A\u0631 ${start}\u060C \u0627\u06CC\u062C\u0627\u062F \u062F\u0633\u062A\u0648\u0631 \u067E\u0631\u062F\u0627\u062E\u062A #${orders[0].id} \u062F\u0631 ${tehranDateOf(iso(orders[0].created_at))})` : `= \u0634\u0631\u0648\u0639 \u062F\u0641\u062A\u0631 ${start}`;
    const note = `\u0627\u0633\u062A\u062B\u0646\u0627\u06CC \u062A\u0627\u0631\u06CC\u062E\u200C\u062F\u0627\u0631 #${f.seq} digest=${forcedPostDigest(f)}: \u062E\u0631\u06CC\u062F #${pid} \u062A\u0633\u0648\u06CC\u0647\u200C\u06CC ${eventDate}\u060C \u062B\u0628\u062A \u0628\u0627 \u062A\u0627\u0631\u06CC\u062E ${postDate} ${why}. \u062A\u0635\u0645\u06CC\u0645: ${f.decidedBy}\u060C \u06A9\u0627\u0631\u062A ${f.decision}\u060C ${f.decidedAt}. ${f.reason}`.slice(0, 500);
    const fx = { entry: f, settledDate: eventDate, postDate, note };
    const e2 = { ...e, payload: { ...e.payload, event_date: postDate, settled_date: eventDate, forced_seq: f.seq } };
    const b = e.eventType === "P7" ? buildShadowVoucher(db2, { ...row, payload_json: JSON.stringify(e2.payload) }, nowIso) : buildP7C(db2, e2, postDate, nowIso, pid);
    if ("post" in b) return { post: { ...b.post, description: `${b.post.description} \u2014 \u0627\u0633\u062A\u062B\u0646\u0627\u06CC \u062A\u0627\u0631\u06CC\u062E\u200C\u062F\u0627\u0631 #${f.seq}: \u062A\u0633\u0648\u06CC\u0647 ${eventDate}\u060C \u062B\u0628\u062A ${postDate} (\u062A\u0635\u0645\u06CC\u0645 ${f.decidedBy}\u060C \u06A9\u0627\u0631\u062A ${f.decision})` }, forced: fx };
    if ("skip" in b) return { ...b, forced: fx };
    return b;
  }
  if (eventDate <= base) return { skip: "gl_before_opening_base", note: "\u062A\u0627 \u062A\u0627\u0631\u06CC\u062E \u0645\u0628\u0646\u0627\u061B \u0645\u0627\u0646\u062F\u0647\u200C\u06CC \u06F2\u06F1\u06F0\u06F1 \u062F\u0631 \u0633\u0646\u062F \u0627\u0641\u062A\u062A\u0627\u062D\u06CC\u0647" };
  if (inOpening) return { skip: "gl_in_opening_2101", note: `\u062F\u0633\u062A\u0648\u0631 \u067E\u0631\u062F\u0627\u062E\u062A #${inOpening.id} \u062F\u0631 \u062C\u0645\u0639 \u06F2\u06F1\u06F0\u06F1 \u0627\u0641\u062A\u062A\u0627\u062D\u06CC\u0647 \u0627\u0633\u062A` };
  if (e.eventType === "P7") return buildShadowVoucher(db2, row, nowIso);
  return buildP7C(db2, e, eventDate, nowIso, pid);
}
function buildP7C(db2, e, eventDate, nowIso, pid) {
  const { version, m } = glMappingAsOf(db2, "P7", eventDate);
  const nature = financeSettingAsOf(db2, "discount.development.nature", eventDate);
  if (!nature) return { skip: "finance_setting_missing:discount.development.nature", note: "\u062A\u0646\u0638\u06CC\u0645 \u0645\u0627\u0644\u06CC \u062F\u0631 \u062A\u0627\u0631\u06CC\u062E \u0631\u0648\u06CC\u062F\u0627\u062F \u062E\u0627\u0644\u06CC \u0627\u0633\u062A" };
  const discountAcc = m.discount[nature];
  if (!discountAcc || nature === "marketing_expense") return { skip: `gl_deferred:discount_nature:${nature}`, note: "\u062D\u0633\u0627\u0628 \u06F6\u06F1\u06F0\u06F3 \u0648 \u0630\u06CC\u200C\u0646\u0641\u0639 \u0647\u0646\u0648\u0632 \u0641\u0639\u0627\u0644 \u0646\u06CC\u0633\u062A\u0646\u062F" };
  const p = one3(db2, "SELECT plan_id FROM goods_purchases WHERE id=?", pid);
  if (!p) throw new Error("gl_source_missing");
  const method = financeSettingAsOf(db2, "plan.supplier_deposit_method", eventDate, { type: "loan_plan", id: p.plan_id });
  let shareAcc = m.receivable;
  if (method === "prefunded_full_credit") {
    const share = p7CompanyShareAccount(db2, m, method, null, eventDate, 0);
    if ("skip" in share) return share;
    if (!one3(db2, "SELECT 1 x FROM gl_vouchers WHERE source_key=?", `gl:goods:${pid}:settle`)) return { skip: "gl_prefunded_p7c_without_p7", note: "\u0633\u0646\u062F P7 \u0627\u06CC\u0646 \u062E\u0631\u06CC\u062F \u0647\u0646\u0648\u0632 \u062B\u0628\u062A \u0646\u0634\u062F\u0647\u061B \u0627\u0635\u0644\u0627\u062D\u06CC\u0647 \u0647\u0645 \u0645\u0646\u062A\u0638\u0631 \u0645\u06CC\u200C\u0645\u0627\u0646\u062F" };
    shareAcc = share.account;
  }
  const plT = ensureTafsili(db2, "PL", p.plan_id, `\u0637\u0631\u062D #${p.plan_id}`, nowIso);
  const lines = [];
  let sum = 0n;
  for (const [, kind, amt] of e.payload.rows) {
    const v = BigInt(String(amt).trim());
    sum += v;
    if (v === 0n) continue;
    const r = tomanToRial((v < 0n ? -v : v).toString());
    const acc = kind === "company_credit" ? shareAcc : discountAcc;
    lines.push(v > 0n ? { account: acc, tafsiliId: plT, debitRial: r, description: kind } : { account: acc, tafsiliId: plT, creditRial: r, description: kind });
  }
  if (sum !== 0n) throw new Error("gl_p7_correction_changes_credit");
  if (lines.length < 2) return { skip: "gl_zero_amount", note: "\u0627\u0635\u0644\u0627\u062D\u06CC\u0647\u200C\u06CC \u0628\u06CC\u200C\u0627\u062B\u0631" };
  return { post: {
    eventDate,
    kind: "backfill",
    sourceKey: e.sourceKey,
    sourceType: "goods_purchases",
    sourceId: pid,
    nowIso,
    description: `\u0627\u0635\u0644\u0627\u062D \u062A\u0633\u0648\u06CC\u0647\u200C\u06CC \u062E\u0631\u06CC\u062F #${pid} (\u0639\u0644\u0627\u0645\u062A \u0628\u0631\u06AF\u0634\u062A\u06CC\u060C \u0646\u06AF\u0627\u0634\u062A P7 \u0646\u0633\u062E\u0647 ${version})`,
    lines
  } };
}
function runGlBackfill(db2, opts) {
  if (db2.isTransaction) throw new Error("gl_backfill_in_transaction");
  const nowIso = opts.nowIso ?? (/* @__PURE__ */ new Date()).toISOString();
  const exclude = new Set(opts.excludeFees ?? []);
  const forcedList = validateForcedPostList({ entries: opts.forcedPost ?? [] });
  const forced = new Map(forcedList.map((f) => [f.purchaseId, f]));
  const batch = Math.max(1, Math.min(opts.batchSize ?? 50, 50));
  const report = { mode: opts.apply ? "apply" : "dry-run", events: 0, created: 0, byType: {}, accounts: {}, exceptions: [], forcedPosts: [], controls: null, items: [] };
  if (!has(db2, "gl_vouchers") || !has(db2, "gl_accounts")) throw new Error("gl_ledger_schema_missing");
  const vBefore = one3(db2, "SELECT COALESCE(MAX(id),0) m FROM gl_vouchers")?.m ?? 0;
  const begin = () => db2.exec(opts.apply ? "BEGIN IMMEDIATE" : "BEGIN");
  begin();
  try {
    ensureGlShadowSchema(db2, nowIso);
    assertForcedAppendOnly(db2, forcedList);
    const events = collectBackfillEvents(db2);
    report.events = events.length;
    let inBatch = 0;
    for (const e of events) {
      const item = processOne(db2, e, exclude, !!opts.retrySkipped, nowIso, forced);
      report.items.push(item);
      const fPid = e.eventType === "P7" || e.eventType === "P7C" ? Number(e.payload.purchase_id) : 0;
      const fe = fPid ? forced.get(fPid) : void 0;
      if (fe) {
        const ex = one3(db2, `SELECT voucher_id, note FROM gl_exceptions WHERE source_type='goods_purchases' AND source_id=? AND code=?`, String(fPid), forcedCode(fe, e));
        const v = item.voucherId ? one3(db2, "SELECT event_date FROM gl_vouchers WHERE id=?", item.voucherId) : void 0;
        if (ex || (item.code ?? "").startsWith("gl_forced_post"))
          report.forcedPosts.push({ seq: fe.seq, purchaseId: fPid, eventType: e.eventType, sourceKey: e.sourceKey, settledDate: eventDateOf(e), postDate: v?.event_date ?? "-", voucherId: item.voucherId, status: item.status, code: item.code });
      }
      (report.byType[e.eventType] ??= {})[item.status] = ((report.byType[e.eventType] ??= {})[item.status] ?? 0) + 1;
      if (item.status === "skip" || item.status === "excluded" || item.status === "fail") {
        if (item.code !== "gl_before_ledger_start") report.exceptions.push({ table: e.table, id: e.id, eventType: e.eventType, code: item.code ?? "-" });
      }
      if (opts.apply && ++inBatch >= batch) {
        db2.exec("COMMIT");
        begin();
        inBatch = 0;
      }
    }
    for (const r of db2.prepare(`SELECT a.code, SUM(l.debit_rial) d, SUM(l.credit_rial) c FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE l.voucher_id > ? GROUP BY a.code ORDER BY a.code`).all(vBefore))
      report.accounts[r.code] = { debitRial: r.d, creditRial: r.c };
    report.created = one3(db2, "SELECT COUNT(*) n FROM gl_vouchers WHERE id > ?", vBefore).n;
    report.controls = backfillControls(db2, report.items);
    db2.exec(opts.apply ? "COMMIT" : "ROLLBACK");
  } catch (err) {
    try {
      db2.exec("ROLLBACK");
    } catch {
    }
    throw err;
  }
  if (!opts.keepItems) report.items = report.items.filter((i) => i.status === "fail");
  return report;
}
var forcedCode = (f, e) => e.eventType === "P7" ? `${FORCED_CODE}:${f.seq}` : `${FORCED_CODE}:${f.seq}:correction:${e.id}`;
function processOne(db2, e, exclude, retrySkipped, nowIso, forced) {
  const base = { table: e.table, id: e.id, eventType: e.eventType, sourceKey: e.sourceKey };
  const v = one3(db2, "SELECT id,event_date FROM gl_vouchers WHERE source_key IN (?,?) LIMIT 1", e.sourceKey, e.backfillKey);
  if (v) return { ...base, eventDate: v.event_date, status: "already", code: null, voucherId: v.id };
  const q2 = one3(db2, "SELECT id,status,last_error,attempts FROM gl_posting_queue WHERE source_key=?", e.sourceKey);
  const reopened = q2?.status === "skipped" && (e.eventType === "P7" || e.eventType === "P7C") && forced.has(Number(e.payload.purchase_id)) && (q2.last_error === "gl_before_ledger_start" || q2.last_error === "gl_before_opening_base");
  if (q2 && q2.status === "skipped" && !retrySkipped && !reopened) return { ...base, eventDate: null, status: "already", code: q2.last_error, voucherId: null };
  const upsert = (status, err, voucherId) => db2.prepare(`INSERT INTO gl_posting_queue(source_key,event_type,source_type,source_id,payload_json,status,attempts,next_attempt_at,last_error,voucher_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,NULL,?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET status=excluded.status, attempts=attempts+1, next_attempt_at=NULL, last_error=excluded.last_error, voucher_id=excluded.voucher_id, updated_at=excluded.updated_at
      WHERE gl_posting_queue.status<>'posted'`).run(e.sourceKey, e.eventType, e.sourceType, e.sourceId, JSON.stringify(e.payload), status, err, voucherId, nowIso, nowIso);
  let eventDate = null;
  try {
    eventDate = eventDateOf(e);
  } catch {
    eventDate = null;
  }
  if (e.eventType === "P4" && exclude.has(e.id)) {
    recordGlException(db2, "loan_filing_fee_charges", e.id, "gl_excluded:fee_list", "\u0647\u0632\u06CC\u0646\u0647\u200C\u06CC \u0628\u062F\u0648\u0646 \u067E\u0631\u0648\u0646\u062F\u0647\u060C \u0637\u0628\u0642 \u0641\u0647\u0631\u0633\u062A \u0627\u0633\u062A\u062B\u0646\u0627 (--exclude-fee)", nowIso);
    upsert("skipped", "gl_excluded:fee_list", null);
    return { ...base, eventDate, status: "excluded", code: "gl_excluded:fee_list", voucherId: null };
  }
  db2.exec("SAVEPOINT gl_backfill_one");
  try {
    const b = buildEvent(db2, e, nowIso, forced);
    let out;
    if ("skip" in b) {
      recordGlException(db2, e.sourceType, e.sourceId, b.skip, b.note, nowIso);
      upsert("skipped", b.skip, null);
      out = { ...base, eventDate, status: "skip", code: b.skip, voucherId: null };
    } else {
      const r = "reverse" in b ? reverseVoucher(db2, b.reverse.voucherId, { eventDate: b.reverse.eventDate, reason: b.reverse.reason, sourceKey: b.reverse.sourceKey, nowIso }) : postVoucher(db2, { ...b.post, kind: "backfill" });
      upsert("posted", null, r.voucherId);
      const fx = "post" in b ? b.forced : void 0;
      if (fx) {
        db2.prepare("INSERT OR IGNORE INTO gl_exceptions(source_type,source_id,code,note,voucher_id,created_at) VALUES('goods_purchases',?,?,?,?,?)").run(String(fx.entry.purchaseId), forcedCode(fx.entry, e), fx.note, r.voucherId, nowIso);
      }
      out = { ...base, eventDate: fx ? fx.postDate : eventDate, status: r.created ? "post" : "already", code: fx ? forcedCode(fx.entry, e) : null, voucherId: r.voucherId };
    }
    db2.exec("RELEASE gl_backfill_one");
    return out;
  } catch (err) {
    db2.exec("ROLLBACK TO gl_backfill_one");
    db2.exec("RELEASE gl_backfill_one");
    const msg = String(err?.message ?? err).slice(0, 300);
    upsert("failed", msg, null);
    return { ...base, eventDate, status: "fail", code: msg.split(" ")[0].slice(0, 120), voucherId: null };
  }
}
var accBal = (db2, code) => one3(db2, "SELECT COALESCE(SUM(l.credit_rial),0)-COALESCE(SUM(l.debit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id WHERE a.code=?", code).n;
function backfillControls(db2, items) {
  const t = one3(db2, "SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM gl_voucher_lines");
  const inScope = (ev) => items.filter((i) => i.eventType === ev && (i.status === "post" || i.status === "already" && i.voucherId));
  const sumSrc = (ids, sql) => ids.reduce((s, id) => s + tomanToRial(String(one3(db2, sql, id)?.a ?? "0").replace(/^-/, "")), 0);
  const fees = sumSrc(inScope("P4").map((i) => i.id), "SELECT amount_toman a FROM loan_filing_fee_charges WHERE id=?");
  const p7 = inScope("P7");
  const purchaseOf = (gflId) => one3(db2, "SELECT purchase_id p FROM goods_finance_ledger WHERE id=?", gflId).p;
  const p7Purchases = p7.map((i) => purchaseOf(i.id));
  const sales = sumSrc(p7Purchases, "SELECT credit_amount_toman a FROM goods_purchases WHERE id=?");
  const forcedSet = new Set(db2.prepare(`SELECT source_id s FROM gl_exceptions WHERE source_type='goods_purchases' AND code GLOB '${FORCED_CODE}:[0-9]*' AND code NOT LIKE '%:correction:%' AND voucher_id IS NOT NULL`).all().map((r) => Number(r.s)));
  const forcedPurchases = p7Purchases.filter((p) => forcedSet.has(p)).sort((a, b) => a - b);
  const payout = sumSrc(p7Purchases.filter((p) => !forcedSet.has(p)), "SELECT payout_amount_toman a FROM goods_purchases WHERE id=?");
  const forcedPayout = sumSrc(forcedPurchases, "SELECT payout_amount_toman a FROM goods_purchases WHERE id=?");
  const comm = ["P10", "P11"].flatMap(inScope).map((i) => i.id), neg = inScope("P12").map((i) => i.id);
  const commissions = sumSrc(comm, "SELECT amount_toman a FROM goods_finance_ledger WHERE id=?") - sumSrc(neg, "SELECT amount_toman a FROM goods_finance_ledger WHERE id=?");
  const opening2101 = one3(db2, "SELECT COALESCE(SUM(l.credit_rial),0)-COALESCE(SUM(l.debit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id JOIN gl_vouchers v ON v.id=l.voucher_id WHERE a.code='2101' AND v.kind='opening'").n;
  const p8 = one3(db2, "SELECT COALESCE(SUM(l.debit_rial),0)-COALESCE(SUM(l.credit_rial),0) n FROM gl_voucher_lines l JOIN gl_accounts a ON a.id=l.account_id JOIN gl_vouchers v ON v.id=l.voucher_id WHERE a.code='2101' AND v.kind<>'opening' AND v.source_key LIKE 'gl:payment-order:%'").n;
  let overlap = [], gaps = [];
  const base = one3(db2, "SELECT value FROM finance_settings WHERE key='gl.opening_base_date' AND scope_type='global' ORDER BY effective_from DESC, id DESC LIMIT 1")?.value;
  if (base && has(db2, "customer_payment_orders")) {
    const cutoff = endOfTehranDay(base);
    const inOpening = new Set(db2.prepare("SELECT purchase_id p FROM customer_payment_orders WHERE purchase_id IS NOT NULL AND created_at < ?").all(cutoff).map((r) => r.p));
    overlap = p7Purchases.filter((p) => inOpening.has(p));
    const p7Set = new Set(p7Purchases);
    gaps = items.filter((i) => i.eventType === "P7" && i.status !== "post" && !i.voucherId && i.code !== "gl_in_opening_2101").map((i) => purchaseOf(i.id)).filter((p) => !inOpening.has(p) && !p7Set.has(p));
  }
  return {
    tbBalanced: t.d === t.c,
    totalDebitRial: t.d,
    totalCreditRial: t.c,
    gl4103Rial: accBal(db2, "4103"),
    feesInScopeRial: fees,
    gl4101Rial: accBal(db2, "4101"),
    salesInScopeRial: sales,
    gl2102Rial: accBal(db2, "2102"),
    commissionsInScopeRial: commissions,
    gl2101Rial: accBal(db2, "2101"),
    opening2101Rial: opening2101,
    postStartP7PayoutRial: payout,
    forcedP7PayoutRial: forcedPayout,
    forcedPurchases,
    p8PaidRial: p8,
    p7Overlap: overlap,
    p7Gaps: [...new Set(gaps)].sort((a, b) => a - b)
  };
}

// src/gl-backfill-cli.ts
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : void 0;
}
var flag = (name) => process.argv.includes(name);
var dbPath = arg("--db");
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: gl-backfill-cli --db <path> [--apply] [--exclude-fee ids] [--retry-skipped] [--out file]");
  process.exit(2);
}
var real = realpathSync(dbPath);
var configured = ["CRM_DB_PATH", "DATABASE_PATH", "DB_PATH", "SQLITE_PATH"].map((k) => process.env[k]).filter(Boolean).map((p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
});
var looksLive = real.startsWith("/opt/nafisvam") || real.startsWith("/var/lib") || configured.includes(real);
var apply = flag("--apply");
if (apply && looksLive) {
  console.error("gl_backfill_apply_refused_on_live: G6 allows --apply only on a copy");
  process.exit(3);
}
var forcedFile = arg("--forced-post") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "gl-backfill-forced-post.json");
if (!existsSync(forcedFile)) {
  console.error("gl_forced_post_list_missing: pass --forced-post <file>");
  process.exit(2);
}
var forcedPost;
try {
  forcedPost = validateForcedPostList(JSON.parse(readFileSync(forcedFile, "utf8")));
} catch (e) {
  console.error(String(e.message ?? e).slice(0, 200));
  process.exit(2);
}
var excludeFees = (arg("--exclude-fee") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
var db = new DatabaseSync(real);
db.exec("PRAGMA foreign_keys=ON");
db.exec("PRAGMA busy_timeout=5000");
try {
  const r = runGlBackfill(db, { apply, excludeFees, forcedPost, retrySkipped: flag("--retry-skipped") });
  const out = JSON.stringify(r, null, 2);
  const file = arg("--out");
  if (file) writeFileSync(file, out, { mode: 384 });
  console.log(JSON.stringify({ mode: r.mode, events: r.events, created: r.created, byType: r.byType, controls: r.controls, forcedPosts: r.forcedPosts, exceptions: r.exceptions.length }, null, 2));
} finally {
  db.close();
}
//# sourceMappingURL=gl-backfill-cli.mjs.map

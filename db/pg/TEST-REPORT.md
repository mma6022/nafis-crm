# Trigger translation test report

Date: 11 Nov 2026 (America/Los_Angeles). Ran against `nafisvam_masked` (PG) and a working copy of `/root/pg-migration/work/masked-20261111T140120Z.db` (SQLite) with original triggers re-applied and `crm_*` UDFs registered. Every case ran in a transaction and was rolled back. Phones and national IDs were not printed.

## Install

- **205 / 205** triggers translated and `CREATE`d on `nafisvam_masked`.
- `idx_call_logs_customer_actual_time` built as an expression index on `sqlite_julianday_immutable(created_at)`.

## Comparison suite

- Targeted cases (identity mobile insert/update, reminder one-open, call-log site_notify insert/update/delete, sms_off71, finance unknown key, append-only, assistant bell IGNORE, treasury sheba) **all matched** (same RAISE message text, or same count deltas).
- Generic UPDATE/DELETE/INSERT on every trigger table: **203 / 205** triggers had at least one matching case.
- **2 skipped** (not a translation mismatch): `gl_capture_filing_fee` and `site_notify_loan_filing_fee_charges_insert`. Every `loan_applications` row already has a `loan_filing_fee_charges` row, so a clone cannot satisfy SQLite’s `UNIQUE(application_id)` without inventing a parent. PostgreSQL is also **missing** those unique indexes (`UNIQUE(application_id)` and `UNIQUE(idempotency_key)` — only the pkey exists). The same `gl_capture_*` and `site_notify_*` patterns passed on other tables (`goods_finance_ledger`, `wallet_ledger_v2`, `call_logs`, …). This is a migrator unique-constraint follow-up, not a trigger rewrite bug.

## Translator notes

- `WHEN` clauses (including subqueries) are moved into the plpgsql function body.
- `RAISE(ABORT, 'msg')` → `RAISE EXCEPTION '%', 'msg'` (message text preserved, including inside string literals such as `customer repeat request is append-only`).
- `RAISE(IGNORE)` → `RETURN NULL`.
- `INSERT OR IGNORE` → `INSERT … ON CONFLICT DO NOTHING`.
- `GLOB` → `sqlite_glob`, `IS`/`IS NOT` → `IS NOT DISTINCT FROM` / `IS DISTINCT FROM` (outside literals), `json_object` → `json_build_object`, `CAST(… AS INTEGER)` → `BIGINT`, boolean `WHEN 1 AND (1)` → `TRUE AND (TRUE)`.

## Schema-audit follow-up (2026-11-11)

After UNIQUE/CHECK were added to `migrate.py` and remigrated into `nafisvam_verify` / `nafisvam_masked` (schema audit CLEAN on both):

- cases_passed 152, cases_failed 0, cases_both_skipped 64
- triggers_with_passing_case 205 / 205
- `gl_capture_filing_fee` and `site_notify_loan_filing_fee_charges_insert` now both skip with `no-free-parent-for-unique-fk:application_id` (UNIQUE on `loan_filing_fee_charges.application_id` is present on PG).

# SQLite vs PostgreSQL schema audit

Date: 2026-11-11 (America/Los_Angeles). Test DBs only: `nafisvam_verify`, `nafisvam_masked`. Live `nafisvam` / live sqlite were not written.

## Scope

All 327 tables in the verify/masked copies, plus `customer_dossier` (created at API startup / by the migrator; not in the 327-table backup). Compared SQLite `sqlite_master` SQL + `PRAGMA index_list` / `index_info` / `table_info` / `foreign_key_list` to PostgreSQL constraints and indexes.

## Gaps found on the previous PG schema

| Kind | Count | Cause |
| --- | --- | --- |
| Missing UNIQUE (column-level, `origin='u'` autoindexes) | 64 of 108 | `migrate.py` skipped every `sqlite_autoindex_*` and `extract_table_extras` only parsed table-level UNIQUE |
| Missing CHECK | 196 of 217 | Column-level `CHECK (...)` was not copied; table-level CHECKs were already present |
| Missing indexes (explicit / partial / unique) | 0 | Already migrated, including the `call_logs` julianday expression index |
| Missing FKs | 0 | |
| DEFAULT mismatch | 0 | |
| NOT NULL mismatch | 292 | All INTEGER PRIMARY KEY columns: SQLite pragma `notnull=0`, PG PRIMARY KEY implies NOT NULL. Expected, not a gap |
| Extra table on PG | 1 | `customer_dossier` |

`loan_filing_fee_charges` was missing `UNIQUE (application_id)` and `UNIQUE (idempotency_key)`, which the app uses for INSERT OR IGNORE / ON CONFLICT upserts.

CHECK bodies also used SQLite `typeof()` (11 times) and `GLOB`. Those are now provided or rewritten (`typeof()` in `sqlite_compat.sql`, `GLOB` → `sqlite_glob(pat, col)`).

## migrate.py fixes (focused)

1. Emit every `origin='u'` UNIQUE (including column-level) and every column- or table-level CHECK in `CREATE TABLE`.
2. Create `customer_dossier` when it is absent from the sqlite copy.
3. Add PostgreSQL `typeof()` compatibility for finance/GL CHECKs.
4. Commit each FK / index / view / trigger DDL on success. A mid-loop failure previously `ROLLBACK`ed the whole transaction and dropped already-created indexes.

## Re-migration results

Both `--database nafisvam_verify` and `--database nafisvam_masked` completed `MIGRATION_OK` (327 tables, checksums match, no live DB). `schema_audit.py` reports **CLEAN** on both:

- sqlite_tables 327, pg_tables 328 (`customer_dossier` extra, allowed)
- missing_uniques 0, missing_indexes 0, missing_checks 0
- notnull / default / FK / PK / column mismatches: 0
- 108 UNIQUE constraints, 217 CHECKs, 662 indexes, 243 FKs
- `loan_filing_fee_charges`: `UNIQUE (application_id)`, `UNIQUE (idempotency_key)` present

Auditor comparison normalizes PG pretty-print (`GLOB`→`sqlite_glob`, `BETWEEN`, `IN`, one-element `IN` as equality, `LIKE`→`~~`, `TRIM`, casts, grouping parentheses) so equivalent CHECKs are not reported as missing.

## Triggers

205 triggers + the julianday expression index reinstalled on both test DBs after remigration.

Full trigger suite on `nafisvam_masked` vs the masked sqlite copy (triggers applied from `sqlite-triggers.json`):

- cases_passed 152, cases_failed 0, cases_both_skipped 64
- triggers_with_passing_case **205 / 205**, failing 0, uncovered 0
- The two previously skipped cases (`gl_capture_filing_fee`, `site_notify_loan_filing_fee_charges_insert`) now **agree on both sides**: each skips with `no-free-parent-for-unique-fk:application_id` because every loan application already has a filing-fee row and `UNIQUE (application_id)` is enforced on SQLite and PG. That is the ON CONFLICT / INSERT OR IGNORE behavior the app relies on.

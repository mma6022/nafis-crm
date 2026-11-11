# Nafis Vam CRM — SQLite → PostgreSQL inventory

Date: 11 Nov 2026. Inventory is of the live 20261111320000 release (commit `7f591e7` + overlays `dp-team-no-assistant` + `perf-poll-cache`) and of a read-only copy of backup `/var/backups/nafisvam/pre-wal-normal-20261111T134704Z.db` (66 MB, integrity ok). Live file was not opened for writes. Another worker switched SQLite to WAL around 13:47 UTC; this work did not interfere (`customers.db-wal` was already present).

## Why PostgreSQL (not MySQL)

PostgreSQL 18 is in the Ubuntu 26.04 distro, has robust JSON and transactional DDL, and matches the unused Replit `@workspace/db` package (`drizzle-orm/node-postgres`). No strong reason to pick MySQL.

## Server (read-only inventory)

| Item | Value |
|---|---|
| Host | Ubuntu 26.04 LTS, 3 vCPU, 3.8 GiB RAM (≈2.6 GiB available at inventory), no swap, 33 GiB free on 96 GiB disk |
| Live DB | `/var/lib/nafisvam/customers.db` (66 MB). Reached via symlink `/opt/nafisvam/current/attached_assets/customers_1789823100050.db` — `CRM_DATABASE_PATH` is **not** set in `crm.env` |
| PostgreSQL | **Installed this session**: 18.6, cluster `postgresql@18-main`, `listen_addresses=127.0.0.1` only, port 5432, `shared_buffers=128MB`, `max_connections=40`. Role `nafisvam`, databases `nafisvam` / `nafisvam_masked` / `nafisvam_verify`. Password in root-only `/root/pg-migration/pg.env` (mode 600; never printed) |

## Schema size (backup / masked copies)

- 327 tables, 224–226 indexes, 2 views (`customer_chat_owners`, `customer_chat_history`), 205 triggers, 243 foreign keys, 194 AUTOINCREMENT tables
- ~241,352 rows on the 13:47 UTC backup (earlier morning masked copy was 237,710)
- Declared types only: INTEGER, INT, TEXT, REAL, BLOB, plus one typeless column on a snapshot table
- SQLite INTEGER is 64-bit → mapped to PG `BIGINT`
- Typeless surprise: `dp_items.boost_rank` is declared INTEGER but 16 rows store non-integer REALs. Migrator now widens such columns to `DOUBLE PRECISION` after a `typeof()` scan (no values printed)

## Data layer (the hard part)

The live API does **not** use Drizzle/`@workspace/db`. The real layer is synchronous Node `node:sqlite` (`DatabaseSync`) in `artifacts/api-server/src/lib/crm-db.ts`.

| Surface | Count |
|---|---|
| Source files importing `DatabaseSync` / `node:sqlite` | 52 |
| Source files importing `crm-db` | 109 |
| Files calling `crmDb.prepare` / `crmDb.exec` directly | 65 |
| Fixture/scripts mentioning sqlite | 180 |
| `sqlite_master` checks | 90 matches / 64 files |
| `INSERT OR IGNORE` | 130 / 53 files |
| `ON CONFLICT` | 92 / 50 files |
| `AUTOINCREMENT` | 192 / 60 files |
| `PRAGMA` | 96 / 46 files |
| `julianday(` | 128 / 33 files |
| `json_extract` / `json_each` / `json_valid` | used in reports, filing, commission, call history |
| `GLOB` | mostly CHECK constraints in ledger/finance |
| `strftime` / `datetime` | triggers, reminders, site notifications, link-page defaults |

Public helpers: `queryRows`, `queryRow`, `execute` (returns lastInsertRowid), `executeChanges`, `runTransaction`, `runImmediateTransaction`. All **synchronous**. A correct PG port must either wrap libpq in a sync worker (`Atomics.wait`) or convert the call sites to async — otherwise the event loop stays blocked and the main win is only cross-process writers.

### Startup migrations

`crm-db.ts` (~1623 lines) plus other libs run SQLite-only startup work on every boot: `PRAGMA busy_timeout`, `PRAGMA foreign_keys`, `PRAGMA table_info`, table rebuilds (`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; …`), `schema_migrations`, and `ensureSchemaObject` against `sqlite_master`. In PG mode these must be skipped or rewritten; the migrator already materializes schema + a `sqlite_master` compatibility view of the original CREATE texts.

### Custom functions and triggers

JS UDFs registered on the connection:

- `crm_customer_mobile_key`
- `crm_customer_national_code_key`
- `crm_persian_search_key`

Ported to SQL in `sql/sqlite_compat.sql`. Triggers on the live backup: 205, including identity guards, ~120 `site_notify_*` feed triggers, GL/finance immutability, reminder “one open”, `sms_off71_block`, etc. SQLite trigger syntax (`RAISE(ABORT,…)`, `WHEN` before `BEGIN`, `strftime`, `IS NOT`) is not valid plpgsql without translation.

### Daily backup

`database-backup.ts` uses `VACUUM INTO` at 00:01 Tehran and `PRAGMA integrity_check`. That path must become `pg_dump` (and must not log row values).

## Processes that touch the DB

Currently only `nafisvam-crm.service` (node, www-data) had the live file open.

Also designed to use `/var/lib/nafisvam/customers.db`:

- `nafisvam-release-manager.service` (`manager-server.mjs`) — historically fails with `activation_failed` when SQLite is busy
- `nafisvam-export-public-plans` (timer every 5 minutes)
- `nafisvam-balebot-watch` (timer every 60s, Python/sqlite3)
- Flag / live / snap / guard Python scripts under `/root/*/flag.py`, `live.py`, `snap.py` (including `/root/perf-320000/live.py`)
- `mask_copy.py` (SQLite only)
- Auto-backup scheduler inside the API
- Many historical `/root/assistants*` repair scripts

The Bale sidecar talks to the API, not the file. Repair/social-proxy services do not appear to open this DB.

**All of the above scripts must be ported or wrapped before a live cutover**, or they will keep pointing at a frozen SQLite file.

## Risk (honest)

**High. The application is not ready to cut over at 00:00 Tehran tonight.**

Reasons:

1. Sync `DatabaseSync` is wired through 100+ files. `DB_DRIVER=pg` is designed but the Node driver is not finished or tested against fixtures.
2. 157 of 205 triggers failed the first translator; a WHEN-clause fix is in progress. Identity and notify triggers must work before live writes.
3. SQLite typeless columns, text timestamps, integer booleans, `GLOB` CHECKs, `julianday` indexes, `json_each` set-returning functions, and `INSERT OR IGNORE` all need the compatibility layer plus app tests.
4. Release manager, `live.py`, flag scripts, public-plans export, balebot-watch, and `VACUUM INTO` backups are still SQLite.
5. Box has no swap; PG is conservatively tuned. WAL (already being applied) is the right same-day speed fix.
6. Fixture suites have not been run against `nafisvam_masked`. Hot-endpoint app benchmarks have not been run (need the driver).
7. GitHub push is unavailable; commits stay local.

Data migration itself is **low-volume and already proven on a copy**: 327/327 tables, row counts and checksums matched, ~36 seconds.

## Recommendation

Keep live traffic on SQLite+WAL tonight. Use the installed PostgreSQL and the dry-run databases for continued porting and tests. Cut over only after: triggers green, `DB_DRIVER=pg` boots the API, full fixtures + pkgtest pass on `nafisvam_masked`, hot endpoints are benchmarked, and Mohammad triggers the midnight plan.

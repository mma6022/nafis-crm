# Cutover plan — SQLite → PostgreSQL (00:00 Tehran)

**Do not run this tonight unless the readiness checklist below is all green and Mohammad explicitly triggers it.** This file is the runbook. Scripts live in `/root/pg-migration/cutover/`.

Timezone: 00:00 Tehran = 20:30 UTC = 12:30 PM America/Los_Angeles.

## Readiness checklist (as of 11 Nov 2026, ~18:00 Tehran / 07:00 AM PT)

| Item | Status |
|---|---|
| PostgreSQL 18 installed, localhost only, env file root-only | **Done** |
| Migrator + checksums on a backup (unmasked, on the server) | **Done**: 327/327 tables matched, 241,352 rows, 243 FKs, 2 views, 36.4 s |
| Masked copy loaded into `nafisvam_masked` (phones + national IDs) | **Done**: 35.3 s, checksums ok, triggers skipped (mask_copy drops them) |
| All 205 triggers translated and verified | **Not done** (58 created, 147 failed after WHEN-clause fix: PG disallows subqueries in WHEN; some RAISE/GLOB/NEW bodies still need a plpgsql rewrite) |
| `idx_call_logs_customer_actual_time` (`julianday`) | **Not done** (`julianday(text)` still missing at index build; 225/226 indexes succeed) |
| `DB_DRIVER=sqlite\|pg` in the API, behavior identical | **Not done** — driver not landed; branch `feat/pg-migration` is for this work |
| Full fixture suites + pkgtest against `nafisvam_masked` | **Not done** |
| Hot-endpoint benches (after-call/pending, reminders, messages, today plan) vs SQLite | **Not done** (need the driver) |
| `live.py`, flag scripts, release manager, public-plans, balebot-watch, `VACUUM INTO` backup | **Not done** (still SQLite) |
| R.sh tested on a non-live path | Script written; not exercised |

**Verdict: do not cut the live panel over tonight.** If Mohammad still wants a midnight *backup* of the main DB, take it (step 2 only) and leave SQLite+WAL in place.

## What a real cutover would do

1. `cutover/00-lock.sh` — `mkdir /root/DEPLOY.lock` (fail if held).
2. `cutover/01-stop-writers.sh` — stop `nafisvam-crm`, bale sidecar, release-manager, public-plans and balebot-watch timers; confirm the live file has no `fuser`.
3. `cutover/02-backup.sh` — sqlite `backup()` API to `/var/backups/nafisvam/pre-pg-cutover-<UTC>.db`, `integrity_check`, never deletes older backups. This is the “backup of the main DB at midnight” Mohammad asked for.
4. `cutover/03-migrate.sh` — `migrate.py --sqlite <that backup> --env /root/pg-migration/pg.env --database nafisvam`. Must print `MIGRATION_OK` and `mismatch=0`.
5. Switch the app with a **new release** via the full routine (not a bare env edit on the running tree):
   - Package a build whose `crm-db` honors `DB_DRIVER=pg`
   - `NAFISVAM_EXPECTED_BASELINE` = whatever is live at that moment (today that was `20261111320000` when 320000 was shipped on top of 350000; **re-read `/opt/nafisvam/current` at cutover**)
   - Install a drop-in `/etc/systemd/system/nafisvam-crm.service.d/db-driver.conf` that EnvironmentFile's a `www-data`-readable copy of the DSN (`/etc/nafisvam/pg-app.env`, mode 640 `root:www-data`, copied from `/root/pg-migration/pg.env` plus `DB_DRIVER=pg` and `DATABASE_URL=…`). Do **not** print it. Do **not** change existing flags.
   - Release manager, healthz, journal, smoke
   - Have `cutover/R.sh` ready **before** activation
6. Start writers again only after healthz is green.
7. Append `ASSISTANTS-RELEASE.md`. GitHub push is unavailable — keep the commit local and record the SHA in the log.
8. `rmdir /root/DEPLOY.lock` only when the release is confirmed.

Quiet-window rule still applies unless Mohammad declares a break. 00:00 Tehran is outside expert calling hours, which helps, but the release-manager / busy-DB failure mode is exactly why writers are stopped first.

## Rollback (`cutover/R.sh`)

- Removes the `db-driver.conf` drop-in, reloads systemd, starts CRM (and bale, release-manager, timers) on the existing SQLite file via the symlink.
- **Does not copy PostgreSQL writes back.** Any work done on PG after cutover would be missing from SQLite and must be copied back in a separate, planned step before or instead of this rollback.
- Does not drop the PG databases or delete the cutover backup.

## Exact commands (when triggered, as root)

```bash
# 0. Confirm baseline actually live *now*
readlink -f /opt/nafisvam/current
# 1. lock + stop + backup + migrate
bash /root/pg-migration/cutover/00-lock.sh
bash /root/pg-migration/cutover/01-stop-writers.sh
bash /root/pg-migration/cutover/02-backup.sh
bash /root/pg-migration/cutover/03-migrate.sh
# 2. Only if MIGRATION_OK and the PG-capable package has passed
#    tests + pkgtest: run the normal release-manager flow with
#    NAFISVAM_EXPECTED_BASELINE=<live RID from step 0>
# 3. If anything fails before writers are started:
bash /root/pg-migration/cutover/R.sh
# and start the services 01 stopped, if R.sh did not already
```

## Dry-run (safe, already used)

```bash
bash /root/pg-migration/dry-run.sh
# SRC=…/some-other-backup.db bash /root/pg-migration/dry-run.sh
```

Uses a **backup**, never the live file. Writes only to `nafisvam_verify` and `nafisvam_masked`. Masked dump redacts phones and national IDs. No flags changed.

## If we only take the midnight backup

```bash
# writers can stay up; use the sqlite backup API
python3 /root/pg-migration/cutover/02-backup.sh
# leave SQLite+WAL as primary; do not switch DB_DRIVER
```

`02-backup.sh` as written assumes writers may already be stopped; running it while the CRM is up is still safe because it uses `Connection.backup()`, but do not also run `01-stop-writers.sh` unless doing the full cutover.

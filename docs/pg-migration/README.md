# PostgreSQL migration (in progress)

Live traffic stays on SQLite until this driver is finished and fixtures are green.

- Inventory and risk: [INVENTORY.md](./INVENTORY.md)
- Midnight runbook (do not run until the checklist is green): [CUTOVER.md](./CUTOVER.md)
- Server scripts (install, migrator, dry-run, R.sh) live on the box/server at `/workspace/pg-migration` and `/root/pg-migration`. They are not required to boot the API.

`DB_DRIVER` is reserved (`sqlite` | `pg`). This branch refuses any value other than `sqlite` so a partial cutover cannot boot against Postgres by accident.

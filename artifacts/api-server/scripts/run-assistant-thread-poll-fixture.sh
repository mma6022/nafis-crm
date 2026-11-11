#!/bin/bash
# Point the crm-db singleton at a throwaway masked copy. Never the live DB.
set -eu
LIVE=/var/lib/nafisvam/customers.db
SRC=${ASSISTANT_POLL_FIXTURE_DB:-${MASKED_DB:-/workspace/vth-error-idle/rel/masked-official.db}}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp /tmp/el-poll-crm-XXXXXX.db)
cleanup() { rm -f "$TMP" "$TMP-wal" "$TMP-shm"; }
trap cleanup EXIT
python3 - "$LIVE" "$SRC" "$TMP" <<'PY'
import os, sqlite3, sys
live, src, dst = (os.path.realpath(p) for p in sys.argv[1:])
if not os.path.isfile(src):
    raise SystemExit(f"missing source db")
if src == live or dst == live or dst.startswith("/var/lib/"):
    raise SystemExit("refusing live database path")
s = sqlite3.connect(src); d = sqlite3.connect(dst); s.backup(d)
ok = d.execute("PRAGMA integrity_check").fetchone()[0]
d.close(); s.close()
if ok != "ok":
    raise SystemExit(f"integrity_check {ok}")
print("ok throwaway crm-db copy")
PY
chmod 600 "$TMP"
export CRM_DATABASE_PATH="$TMP"
export NODE_ENV=production
export LOG_LEVEL="${LOG_LEVEL:-warn}"
export BALE_BOT_WORKER=0
export LOAN_REQUEST_DRAFTS_JOBS=off
export SITE_LEAD_ALERTS=off
# Session secret is only for module import of auth; never printed.
export SESSION_SECRET="${SESSION_SECRET:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')}"
cd "$ROOT"
node scripts/run-bundled-fixture.mjs scripts/assistant-thread-poll-fixture.mjs

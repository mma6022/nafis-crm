#!/bin/bash
set -eu
LIVE=/var/lib/nafisvam/customers.db
SRC=${CUSTOMER_BALE_FIXTURE_DB:-${MASKED_DB:-/workspace/team-model/rel/masked-pkgtest.db}}
[ -f "$SRC" ] || { echo "SKIP (set CUSTOMER_BALE_FIXTURE_DB or MASKED_DB to a masked copy)"; exit 0; }
SRC=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SRC")
[ "$SRC" != "$LIVE" ] || { echo "Refusing live DB"; exit 2; }
DIR=$(mktemp -d /tmp/cb-fx-XXXXXX)
trap 'rm -rf "$DIR"' EXIT
cp "$SRC" "$DIR/customers.db"
chmod 600 "$DIR/customers.db"
export CRM_DATABASE_PATH=$DIR/customers.db
export NODE_ENV=production
export BALE_BOT_WORKER=0
exec node scripts/run-bundled-fixture.mjs scripts/customer-bale-fixture.mjs

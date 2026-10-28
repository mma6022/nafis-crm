#!/usr/bin/env bash
# Release 84(A): fixture for release-registry/append.py in a temp dir (never touches /var/lib).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
AP="$HERE/release-registry/append.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$HERE/release-registry/site-releases.json" "$HERE/release-registry/crm-releases-meta.json" "$T/"
chmod 0640 "$T"/*.json
fail() { echo "FAIL: $*"; exit 1; }
python3 "$AP" site --dir "$T" --rid 20261029010000 --commit abcdef1 --branch site/test-84 --desc "آزمایش" >/dev/null
python3 - "$T" <<'PY'
import json,sys,os,stat
d=json.load(open(sys.argv[1]+"/site-releases.json"))
r=[x for x in d["releases"] if x["rid"]=="20261029010000"][0]
assert len(d["releases"])==24, len(d["releases"])
assert "20261028212415" in r["rollback"], r["rollback"]
assert d.get("updatedAt")
assert stat.S_IMODE(os.stat(sys.argv[1]+"/site-releases.json").st_mode)==0o640
PY
echo "ok - site append, default rollback = relink to previous RID, mode kept"
if python3 "$AP" site --dir "$T" --rid 20261029010000 --commit abcdef1 --branch x --desc d >/dev/null 2>&1; then fail "duplicate accepted"; fi
echo "ok - duplicate refused"
python3 "$AP" site --dir "$T" --rid 20261029010000 --commit abcdef2 --branch x --desc d2 --replace >/dev/null
python3 -c "import json,sys;d=json.load(open('$T/site-releases.json'));r=[x for x in d['releases'] if x['rid']=='20261029010000'];assert len(r)==1 and r[0]['commit']=='abcdef2'"
echo "ok - --replace"
for bad in "--rid 2026 --commit abcdef1" "--rid 20261029020000 --commit zz" "--rid 20261029020000 --commit abcdef1 --branch a;b"; do
  # shellcheck disable=SC2086
  if python3 "$AP" site --dir "$T" --branch ok $bad --desc d >/dev/null 2>&1; then fail "accepted: $bad"; fi
done
echo "ok - invalid input refused"
python3 "$AP" crm --dir "$T" --rid 20261029030000 --commit abcdef3 --branch feat/x --desc "بدون تغییر ساختار" >/dev/null
python3 -c "import json;d=json.load(open('$T/crm-releases-meta.json'));assert d['schemaCutoff']=='20261028211337', d['schemaCutoff']"
echo "ok - crm append keeps cut-off"
python3 "$AP" crm --dir "$T" --rid 20261029040000 --commit abcdef4 --branch feat/y --desc "با تغییر ساختار" --schema-change "new column" >/dev/null
python3 -c "import json;d=json.load(open('$T/crm-releases-meta.json'));assert d['schemaCutoff']=='20261029040000', d['schemaCutoff']"
echo "ok - crm --schema-change raises cut-off"
ls -A "$T" | grep -q '\.tmp' && fail "tmp left behind" || true
echo "release-registry append fixture: passed"

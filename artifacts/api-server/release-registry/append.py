#!/usr/bin/env python3
"""Append one release to the 84(A) release registry (stdlib only, run as root by a deploy script).

  append.py site --rid 20261029010203 --commit abc1234 --branch site/x --desc "توضیح کوتاه" \
            [--rollback "bash /root/site56/site-R.sh"] [--notes "..."] [--dir DIR] [--replace]
  append.py crm  --rid 20261029010203 --commit abc1234 --branch feat/x --desc "LABEL-84" \
            [--schema-change "table foo"] [--dir DIR] [--replace]

Default DIR = /var/lib/nafisvam/release-registry (env NAFISVAM_RELEASE_REGISTRY_DIR).
flock on DIR/.lock, validation identical to the API, duplicate RID refused unless --replace,
atomic write (tmp + fsync + rename) keeping the existing owner/group/mode (new file: 0640).
Never touches a release directory, the DB, nginx or any service. Prints one line, no secrets.
"""
import argparse, datetime, fcntl, json, os, re, sys, tempfile

RID_RE = re.compile(r"^\d{14}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{7,40}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
RELINK = "ln -sfn /opt/nafisvam-site/releases/{p} /opt/nafisvam-site/current.new && mv -T /opt/nafisvam-site/current.new /opt/nafisvam-site/current"


def die(msg, code=2):
    print(f"append: {msg}", file=sys.stderr)
    sys.exit(code)


def valid_rid(rid):
    if not RID_RE.match(rid or ""):
        return False
    try:
        datetime.datetime.strptime(rid, "%Y%m%d%H%M%S")
        return True
    except ValueError:
        return False


def clean(s, n):
    if s is None:
        return None
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", s).strip()
    return s[:n] or None


def load(path, empty):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return empty
    except json.JSONDecodeError as e:
        die(f"{os.path.basename(path)} is not valid JSON ({e.msg}); refusing to overwrite", 3)


def write_atomic(path, doc):
    d = os.path.dirname(path)
    st = os.stat(path) if os.path.exists(path) else None
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, st.st_mode & 0o777 if st else 0o640)
        if st and os.geteuid() == 0:
            os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["site", "crm"])
    ap.add_argument("--rid", required=True)
    ap.add_argument("--commit")
    ap.add_argument("--branch")
    ap.add_argument("--desc", required=True)
    ap.add_argument("--rollback")
    ap.add_argument("--notes")
    ap.add_argument("--schema-change")
    ap.add_argument("--dir", default=os.environ.get("NAFISVAM_RELEASE_REGISTRY_DIR", "/var/lib/nafisvam/release-registry"))
    ap.add_argument("--replace", action="store_true")
    a = ap.parse_args(argv)

    if not valid_rid(a.rid):
        die("rid must be a real 14-digit UTC timestamp YYYYMMDDHHMMSS")
    commit = (a.commit or "").strip().lower() or None
    if commit and not COMMIT_RE.match(commit):
        die("commit must be 7-40 hex chars")
    branch = (a.branch or "").strip() or None
    if branch and not BRANCH_RE.match(branch):
        die("branch has invalid characters")
    desc = clean(a.desc, 200)
    if not desc:
        die("desc is required")
    if not os.path.isdir(a.dir):
        die(f"registry dir missing: {a.dir}", 3)

    with open(os.path.join(a.dir, ".lock"), "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        if a.kind == "site":
            path = os.path.join(a.dir, "site-releases.json")
            doc = load(path, {"version": 1, "releases": []})
            rows = doc.get("releases")
            if not isinstance(rows, list):
                die("site-releases.json has no releases list; refusing", 3)
            exists = [r for r in rows if isinstance(r, dict) and r.get("rid") == a.rid]
            if exists and not a.replace:
                die(f"rid {a.rid} already registered (use --replace)", 4)
            rows = [r for r in rows if not (isinstance(r, dict) and r.get("rid") == a.rid)]
            older = sorted((r["rid"] for r in rows if isinstance(r, dict) and isinstance(r.get("rid"), str) and r["rid"] < a.rid), reverse=True)
            rollback = clean(a.rollback, 500)
            if not rollback:
                rollback = f"بازگشت به {older[0]}: " + RELINK.format(p=older[0]) if older else "قدیمی‌ترین نسخه؛ نسخه‌ی قبلی ثبت نشده."
            rows.append({"rid": a.rid, "commit": commit, "branch": branch, "description": desc,
                         "rollback": rollback, "notes": clean(a.notes, 300)})
            rows.sort(key=lambda r: str(r.get("rid", "")), reverse=True)
            doc["releases"] = rows
        else:
            path = os.path.join(a.dir, "crm-releases-meta.json")
            doc = load(path, {"version": 1, "schemaCutoff": None, "releases": {}})
            rel = doc.get("releases")
            if not isinstance(rel, dict):
                die("crm-releases-meta.json has no releases map; refusing", 3)
            if a.rid in rel and not a.replace:
                die(f"rid {a.rid} already registered (use --replace)", 4)
            sc = clean(a.schema_change, 200)
            rel[a.rid] = {"commit": commit, "branch": branch, "description": desc, "schemaChange": sc}
            if sc and (not doc.get("schemaCutoff") or a.rid > doc["schemaCutoff"]):
                doc["schemaCutoff"] = a.rid
        doc["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        write_atomic(path, doc)
    print(f"append: {a.kind} {a.rid} ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())

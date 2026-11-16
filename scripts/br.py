#!/usr/bin/env python3
"""Nightly review helper for diagnostic_reports (table name: diagnostic_reports).

Intended path on the server: /root/bugreports/br.py
The server has no sqlite3 CLI — this uses the Python stdlib only.

  python3 br.py --db /var/lib/nafisvam/customers.db list-open
  python3 br.py --db /var/lib/nafisvam/customers.db mark 12 resolved --note '…' --ref 'fix/…@abc / RID …'

list-open prints a masked table (id, Tehran time, page, role, redacted text).
mark backs up the row, writes an undo log, then updates resolution_* only.
The auto-repair `status` column and the report save path are not touched.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

STATUSES = ("open", "in_progress", "resolved", "wont_fix")
LIVE = "/var/lib/nafisvam/customers.db"
TEHRAN = timezone(timedelta(hours=3, minutes=30))


def mask_text(value: object, max_len: int = 240) -> str:
    text = str(value or "")
    text = re.sub(r"[۰-۹]", lambda m: str("۰۱۲۳۴۵۶۷۸۹".index(m.group(0))), text)
    text = re.sub(r"[٠-٩]", lambda m: str("٠١٢٣٤٥٦٧٨٩".index(m.group(0))), text)
    text = re.sub(r"\b(?:Bearer|Basic)\s+\S+", "[redacted]", text, flags=re.I)
    text = re.sub(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[email]", text, flags=re.I)
    text = re.sub(r"(?<!\d)0?9\d{9}(?!\d)", lambda m: m.group(0)[:4] + "***" + m.group(0)[-2:], text)
    text = re.sub(r"(?<!\d)\d{10,11}(?!\d)", "[id]", text)
    text = re.sub(r"\b\d{8,}\b", "[number]", text)
    return text[:max_len]


def to_tehran(iso: str) -> str:
    raw = (iso or "").strip()
    if not raw:
        return ""
    try:
        if raw.endswith("Z"):
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(TEHRAN).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return raw


def connect(db_path: str) -> sqlite3.Connection:
    path = os.path.realpath(db_path)
    if not os.path.isfile(path):
        raise SystemExit(f"db not found: {db_path}")
    con = sqlite3.connect(f"file:{path}?mode=rw", uri=True)
    con.row_factory = sqlite3.Row
    return con


def list_open(con: sqlite3.Connection) -> int:
    cols = {r["name"] for r in con.execute("PRAGMA table_info(diagnostic_reports)")}
    if "resolution_status" not in cols:
        print("resolution columns missing; run the CRM so the additive migration can apply", file=sys.stderr)
        return 2
    has_users = bool(con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone())
    role_sql = "u.role" if has_users else "NULL"
    join_sql = "LEFT JOIN users u ON u.id = r.user_id" if has_users else ""
    rows = con.execute(
        f"""SELECT r.id, r.created_at, r.page, r.description, {role_sql} AS role
            FROM diagnostic_reports r {join_sql}
            WHERE COALESCE(r.resolution_status, 'open') = 'open'
            ORDER BY r.id"""
    ).fetchall()
    print("id\tcreated_at_tehran\tpage\trole\ttext")
    for r in rows:
        print("\t".join([
            str(r["id"]),
            to_tehran(r["created_at"]),
            mask_text(r["page"], 120),
            str(r["role"] or "—"),
            mask_text(r["description"]),
        ]))
    print(f"# {len(rows)} open", file=sys.stderr)
    return 0


def mark(con: sqlite3.Connection, report_id: int, status: str, note: str | None, ref: str | None, by: str, undo_dir: Path) -> int:
    if status not in STATUSES:
        raise SystemExit(f"status must be one of: {', '.join(STATUSES)}")
    cols = {r["name"] for r in con.execute("PRAGMA table_info(diagnostic_reports)")}
    if "resolution_status" not in cols:
        print("resolution columns missing; run the CRM so the additive migration can apply", file=sys.stderr)
        return 2
    row = con.execute("SELECT * FROM diagnostic_reports WHERE id=?", (report_id,)).fetchone()
    if row is None:
        print(f"no report {report_id}", file=sys.stderr)
        return 2
    undo_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    undo_path = undo_dir / f"mark-{report_id}-{stamp}.json"
    backup = {k: row[k] for k in row.keys()}
    undo_path.write_text(json.dumps({"action": "mark", "id": report_id, "before": backup}, ensure_ascii=False, indent=2) + "\n")
    os.chmod(undo_path, 0o600)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    resolved_at = now if status in ("resolved", "wont_fix") else None
    resolved_by = by if status in ("resolved", "wont_fix", "in_progress") else None
    con.execute(
        """UPDATE diagnostic_reports
           SET resolution_status=?, resolved_at=?, resolved_by=?, resolution_note=?, fix_ref=?, updated_at=?
           WHERE id=?""",
        (status, resolved_at, resolved_by, note, ref, now, report_id),
    )
    con.commit()
    print(f"marked {report_id} {status}; undo {undo_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Review diagnostic_reports (Python only; no sqlite3 CLI).")
    p.add_argument("--db", required=True, help="SQLite path (pass the live path only when running on the server over SSH)")
    p.add_argument("--undo-dir", default=os.environ.get("BUGREPORTS_UNDO_DIR", ""), help="Where mark writes the row backup (default: <script>/undo)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list-open")
    m = sub.add_parser("mark")
    m.add_argument("id", type=int)
    m.add_argument("status", choices=STATUSES)
    m.add_argument("--note", default=None)
    m.add_argument("--ref", default=None, help="branch/commit/RID of the fix")
    m.add_argument("--by", default=os.environ.get("USER") or "operator")
    args = p.parse_args(argv)
    undo_dir = Path(args.undo_dir) if args.undo_dir else Path(__file__).resolve().parent / "undo"
    con = connect(args.db)
    try:
        if args.cmd == "list-open":
            return list_open(con)
        return mark(con, args.id, args.status, args.note, args.ref, args.by, undo_dir)
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())

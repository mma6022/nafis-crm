#!/usr/bin/env python3
"""Compare SQLite vs PostgreSQL schema (constraints, uniques, indexes, CHECKs,
NOT NULL, DEFAULTs, FKs) for the Nafis Vam CRM. Never prints row values,
phones, national IDs, or the database password.

Usage:
  python3 schema_audit.py --sqlite COPY.db --env /root/pg-migration/pg.env --database nafisvam_masked
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIVE = "/var/lib/nafisvam/customers.db"


def qid(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def load_env(path: str) -> dict[str, str]:
    vals: dict[str, str] = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            vals[k] = v
    return vals


def refuse_live(path: str) -> None:
    if os.path.exists(LIVE) and os.path.realpath(path) == os.path.realpath(LIVE):
        print("REFUSE_LIVE_DB: pass a copy or backup, not the live file", file=sys.stderr)
        sys.exit(5)


def norm_ident(s: str) -> str:
    return (s or "").strip().strip('"').lower()


def norm_cols(cols) -> tuple[str, ...]:
    return tuple(norm_ident(c) for c in cols if c)


def norm_expr(s: str | None) -> str:
    if not s:
        return ""
    t = " ".join(s.split())
    t = t.replace('"', "")
    t = re.sub(r"\s+", " ", t)
    return t.lower().strip()


# SQLite GLOB in CHECK constraints is rewritten to sqlite_glob(pat, col) on PG.
_GLOB_RE = re.compile(
    r"""(?:(\w+)|"([^"]+)")\s+(NOT\s+)?GLOB\s+('(?:[^']|'')*')""",
    re.I,
)


def rewrite_glob_in_sql(sql: str) -> str:
    def repl(m: re.Match) -> str:
        ident = m.group(2) if m.group(2) is not None else m.group(1)
        expr = f"sqlite_glob({m.group(4)}, {ident})"
        return f"NOT {expr}" if m.group(3) else expr
    return _GLOB_RE.sub(repl, sql)


def _unwrap_parens(t: str) -> str:
    changed = True
    while changed and t:
        changed = False
        if t.startswith("(") and t.endswith(")"):
            depth = 0
            wrap = True
            for i, ch in enumerate(t):
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0 and i != len(t) - 1:
                        wrap = False
                        break
            if wrap and depth == 0:
                t = t[1:-1]
                changed = True
    return t


def canon_check(s: str | None) -> str:
    """Normalize a SQLite or PG CHECK so rewritten-but-equivalent forms match.

    PG pretty-prints BETWEEN, IN, LIKE, TRIM, casts, and quotes; migrate.py
    also rewrites GLOB to sqlite_glob(). These are not schema gaps.
    """
    if not s:
        return ""
    t = rewrite_glob_in_sql(s)
    t = t.lower()
    t = t.replace('"', "")
    t = re.sub(r"::[a-z_]\w*", "", t)
    t = re.sub(r"^\s*check\s*", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip()

    def bet(m: re.Match) -> str:
        a, lo, hi = m.group(1), m.group(2), m.group(3)
        return f"(({a}>={lo})and({a}<={hi}))"

    t = re.sub(r"(\S+)\s+between\s+(\S+)\s+and\s+(\S+)", bet, t)
    t = re.sub(r"trim\s*\(\s*both\s+from\s+", "trim(", t)
    t = re.sub(r"\bnot\s+like\b", "not~~", t)
    t = re.sub(r"\blike\b", "~~", t)

    def in_repl(m: re.Match) -> str:
        items = ",".join(x.strip() for x in m.group(2).split(","))
        return f"{m.group(1)}=any(array[{items}])"

    def notin_repl(m: re.Match) -> str:
        items = ",".join(x.strip() for x in m.group(2).split(","))
        return f"not({m.group(1)}=any(array[{items}]))"

    t = re.sub(r"(\S+)\s+not\s+in\s*\(([^)]+)\)", notin_repl, t)
    t = re.sub(r"(\S+)\s+in\s*\(([^)]+)\)", in_repl, t)
    t = re.sub(r"\s+", "", t)
    # PG pretty-prints a one-element IN as equality: IN ('nightly') → = 'nightly'
    t = re.sub(r"=any\(array\[('[^']*'|-?\d+(?:\.\d+)?)\]\)", r"=\1", t)
    t = _unwrap_parens(t)
    # PG adds grouping parens around every AND/OR/IS NULL term; drop all
    # parentheses (inside string literals kept) so equivalent CHECKs match.
    out = []
    quote = None
    i = 0
    while i < len(t):
        ch = t[i]
        if quote:
            out.append(ch)
            if ch == quote:
                if quote == "'" and i + 1 < len(t) and t[i + 1] == "'":
                    out.append(t[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch == "'":
            quote = ch
            out.append(ch)
            i += 1
            continue
        if ch in "()":
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# ---------- SQLite side ----------
def split_table_parts(create_sql: str | None) -> list[str]:
    if not create_sql:
        return []
    m = re.search(r"\((.*)\)\s*$", create_sql, re.S)
    if not m:
        return []
    body = m.group(1)
    parts, buf = [], []
    depth, quote, i = 0, None, 0
    while i < len(body):
        ch = body[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                if quote == "'" and i + 1 < len(body) and body[i + 1] == "'":
                    buf.append(body[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        i += 1
    if buf:
        parts.append("".join(buf).strip())
    return parts


def sqlite_checks_from_sql(create_sql: str | None) -> list[str]:
    """Table-level and column-level CHECK expressions (normalized later)."""
    out = []
    for p in split_table_parts(create_sql):
        # table-level
        m = re.match(r"(?:CONSTRAINT\s+\S+\s+)?CHECK\s*\((.*)\)\s*$", p, re.I | re.S)
        if m:
            out.append(m.group(1).strip())
            continue
        # column-level: ... CHECK ( ... )  possibly more than one
        for cm in re.finditer(r"\bCHECK\s*\(", p, re.I):
            start = cm.end() - 1
            depth, quote, j = 0, None, start
            while j < len(p):
                ch = p[j]
                if quote:
                    if ch == quote:
                        if quote == "'" and j + 1 < len(p) and p[j + 1] == "'":
                            j += 2
                            continue
                        quote = None
                    j += 1
                    continue
                if ch in ("'", '"'):
                    quote = ch
                elif ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        out.append(p[start + 1 : j].strip())
                        break
                j += 1
    return out


def inspect_sqlite(path: str) -> dict:
    refuse_live(path)
    c = sqlite3.connect(f"file:{os.path.abspath(path)}?mode=ro", uri=True)
    tables = [
        r[0]
        for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY 1"
        )
    ]
    creates = {
        r[0]: r[1]
        for r in c.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
    }
    out_tables = {}
    for t in tables:
        cols = []
        for cid, name, ctype, notnull, dflt, pk in c.execute(f"PRAGMA table_info({qid(t)})"):
            cols.append(
                {
                    "name": name,
                    "type": (ctype or "").upper(),
                    "notnull": bool(notnull),
                    "default": dflt,
                    "pk": int(pk or 0),
                }
            )
        pk = [col["name"] for col in sorted([c for c in cols if c["pk"]], key=lambda x: x["pk"])]
        # indexes
        uniques = []
        indexes = []
        for idx in c.execute(f"PRAGMA index_list({qid(t)})"):
            seq, name, unique, origin, partial = (list(idx) + [None, None])[:5]
            # index_xinfo: seqno, cid, name, desc, coll, key
            xinfo = list(c.execute(f"PRAGMA index_xinfo({qid(name)})"))
            key_cols = [r[2] for r in xinfo if r[5] and r[2] is not None]
            expr_bits = []
            for r in xinfo:
                if not r[5]:
                    continue
                if r[2] is None:
                    expr_bits.append({"expr": True, "desc": bool(r[3])})
                else:
                    expr_bits.append({"col": r[2], "desc": bool(r[3])})
            sqlrow = c.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (name,)
            ).fetchone()
            sql = sqlrow[0] if sqlrow else None
            rec = {
                "name": name,
                "unique": bool(unique),
                "origin": origin,
                "partial": bool(partial),
                "cols": key_cols,
                "sql": sql,
            }
            if unique and origin in ("u", "pk"):
                uniques.append(rec)
            if origin == "c" or (sql and not name.startswith("sqlite_autoindex_")):
                indexes.append(rec)
            elif unique and origin == "u":
                # also track unique constraints separately; they should appear as uniques
                pass
        fks = []
        groups = {}
        for row in c.execute(f"PRAGMA foreign_key_list({qid(t)})"):
            groups.setdefault(row[0], []).append(row)
        for fid, rows in groups.items():
            fks.append(
                {
                    "id": fid,
                    "table": rows[0][2],
                    "from": [r[3] for r in rows],
                    "to": [r[4] for r in rows],
                    "on_update": rows[0][5] or "NO ACTION",
                    "on_delete": rows[0][6] or "NO ACTION",
                }
            )
        checks = sqlite_checks_from_sql(creates.get(t))
        out_tables[t] = {
            "cols": cols,
            "pk": pk,
            "uniques": uniques,  # origin pk + u
            "indexes": indexes,  # explicit CREATE INDEX (unique and not)
            "fks": fks,
            "checks": checks,
        }
    views = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='view' ORDER BY 1")]
    return {"tables": tables, "views": views, "detail": out_tables, "creates": {k: bool(v) for k, v in creates.items()}}


# ---------- PostgreSQL side ----------
def inspect_pg(env: dict, database: str) -> dict:
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(
        host=env.get("PGHOST", "127.0.0.1"),
        port=int(env.get("PGPORT", "5432")),
        user=env.get("PGUSER", "nafisvam"),
        password=env["PGPASSWORD"],
        dbname=database,
        sslmode=env.get("PGSSLMODE", "disable"),
    )
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"
    )
    tables = [r[0] for r in cur.fetchall()]
    cur.execute(
        "SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1"
    )
    views = [r[0] for r in cur.fetchall()]

    # columns
    cur.execute(
        """
        SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
               c.column_default, c.ordinal_position
        FROM information_schema.columns c
        WHERE c.table_schema='public'
        ORDER BY c.table_name, c.ordinal_position
        """
    )
    cols_by = defaultdict(list)
    for t, name, typ, nullable, dflt, ord_ in cur.fetchall():
        cols_by[t].append(
            {"name": name, "type": typ, "notnull": nullable == "NO", "default": dflt, "ord": ord_}
        )

    # primary keys
    cur.execute(
        """
        SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
        WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY'
        ORDER BY tc.table_name, kcu.ordinal_position
        """
    )
    pks = defaultdict(list)
    for t, col, _ord in cur.fetchall():
        pks[t].append(col)

    # unique constraints (not pkey)
    cur.execute(
        """
        SELECT tc.table_name, tc.constraint_name, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         AND tc.table_name=kcu.table_name
        WHERE tc.table_schema='public' AND tc.constraint_type='UNIQUE'
        ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
        """
    )
    uq = defaultdict(lambda: defaultdict(list))
    for t, cname, col, _ord in cur.fetchall():
        uq[t][cname].append(col)

    # unique indexes (including those not registered as constraints, and partial)
    cur.execute(
        """
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname='public'
        ORDER BY 1, 2
        """
    )
    indexes = defaultdict(list)
    for t, name, idef in cur.fetchall():
        indexes[t].append({"name": name, "sql": idef, "unique": "UNIQUE" in idef.upper()})

    # checks
    cur.execute(
        """
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE contype='c' AND connamespace = 'public'::regnamespace
        """
    )
    checks = defaultdict(list)
    for t, cname, cdef in cur.fetchall():
        t = t.strip('"')
        checks[t].append({"name": cname, "def": cdef})

    # fks
    cur.execute(
        """
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE contype='f' AND connamespace = 'public'::regnamespace
        """
    )
    fks = defaultdict(list)
    for t, cname, cdef in cur.fetchall():
        t = t.strip('"')
        fks[t].append({"name": cname, "def": cdef})

    conn.close()
    detail = {}
    for t in tables:
        detail[t] = {
            "cols": cols_by.get(t, []),
            "pk": pks.get(t, []),
            "unique_constraints": {k: v for k, v in uq.get(t, {}).items()},
            "indexes": indexes.get(t, []),
            "checks": checks.get(t, []),
            "fks": fks.get(t, []),
        }
    return {"tables": tables, "views": views, "detail": detail}


def unique_key_from_cols(cols) -> tuple[str, ...]:
    return norm_cols(cols)


def pg_unique_colsets(pg_table: dict) -> set[tuple[str, ...]]:
    sets = set()
    for cols in pg_table.get("unique_constraints", {}).values():
        sets.add(unique_key_from_cols(cols))
    # unique indexes: parse columns from indexdef
    for idx in pg_table.get("indexes", []):
        if not idx.get("unique"):
            continue
        cols = parse_index_cols(idx.get("sql") or "")
        if cols:
            sets.add(unique_key_from_cols(cols))
    if pg_table.get("pk"):
        sets.add(unique_key_from_cols(pg_table["pk"]))
    return sets


def parse_index_cols(indexdef: str) -> list[str]:
    """Best-effort column names from CREATE [UNIQUE] INDEX ... ON t (cols) [WHERE ...]."""
    m = re.search(r"\bon\s+\S+\s+using\s+\w+\s*\((.*)\)(?:\s+WHERE\s+.*)?$", indexdef, re.I | re.S)
    if not m:
        m = re.search(r"\bon\s+\S+\s*\((.*)\)(?:\s+WHERE\s+.*)?$", indexdef, re.I | re.S)
    if not m:
        return []
    body = m.group(1)
    parts, buf, depth, quote = [], [], 0, None
    for i, ch in enumerate(body + ","):
        if quote:
            if ch == quote:
                quote = None
            buf.append(ch)
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            continue
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            p = "".join(buf).strip()
            buf = []
            # strip ASC/DESC, ops, expressions: if it's a simple ident, keep it
            p = re.sub(r"\s+(ASC|DESC)\b", "", p, flags=re.I).strip()
            # btree (customer_id, (fn(created_at)) DESC, id)
            ident = re.match(r'^"?([A-Za-z_][A-Za-z0-9_]*)"?$', p)
            if ident:
                parts.append(ident.group(1))
            else:
                parts.append(p)  # expression
        else:
            buf.append(ch)
    return parts


def pg_index_partial(indexdef: str) -> str:
    m = re.search(r"\bWHERE\s+(.+)$", indexdef, re.I | re.S)
    return norm_expr(m.group(1) if m else "")


def sqlite_index_partial(sql: str | None) -> str:
    if not sql:
        return ""
    m = re.search(r"\bWHERE\s+(.+)$", sql, re.I | re.S)
    return norm_expr(m.group(1) if m else "")


def compare(sqlite: dict, pg: dict) -> dict:
    s_tables = set(sqlite["tables"])
    p_tables = set(pg["tables"])
    # ignore migrator bookkeeping
    ignore = {"sqlite_master_sql", "sqlite_master"}
    p_tables_cmp = p_tables - ignore
    missing_on_pg = sorted(s_tables - p_tables_cmp)
    extra_on_pg = sorted(p_tables_cmp - s_tables)

    missing_uniques = []
    extra_uniques = []
    missing_indexes = []
    missing_checks = []
    notnull_mismatch = []
    default_mismatch = []
    missing_fks = []
    pk_mismatch = []
    col_mismatch = []

    for t in sorted(s_tables & p_tables_cmp):
        sd, pd = sqlite["detail"][t], pg["detail"][t]
        # columns
        scols = {norm_ident(c["name"]): c for c in sd["cols"]}
        pcols = {norm_ident(c["name"]): c for c in pd["cols"]}
        if set(scols) != set(pcols):
            col_mismatch.append(
                {
                    "table": t,
                    "only_sqlite": sorted(set(scols) - set(pcols)),
                    "only_pg": sorted(set(pcols) - set(scols)),
                }
            )
        for n, sc in scols.items():
            pc = pcols.get(n)
            if not pc:
                continue
            if sc["notnull"] != pc["notnull"]:
                # SQLite INTEGER PRIMARY KEY (and any PK) often has pragma notnull=0;
                # PostgreSQL PRIMARY KEY implies NOT NULL. That is expected, not a gap.
                if sc["name"] in sd["pk"] or pc["name"] in pd.get("pk", []):
                    continue
                notnull_mismatch.append(
                    {"table": t, "col": sc["name"], "sqlite": sc["notnull"], "pg": pc["notnull"]}
                )
            # default: presence (None vs not). Don't require identical SQL.
            s_has = sc["default"] is not None and str(sc["default"]).strip() != ""
            p_has = pc["default"] is not None and str(pc["default"]).strip() != ""
            # identity default on PK is expected extra on PG
            pdef = str(pc["default"] or "")
            if "nextval" in pdef or "identity" in pdef.lower():
                p_has = s_has  # ignore identity sequence default
            if s_has != p_has:
                default_mismatch.append(
                    {"table": t, "col": sc["name"], "sqlite_has": s_has, "pg_has": p_has}
                )

        if norm_cols(sd["pk"]) != norm_cols(pd["pk"]):
            pk_mismatch.append({"table": t, "sqlite": sd["pk"], "pg": pd["pk"]})

        # uniques: sqlite origin u (not pk) must exist on PG
        pg_u = pg_unique_colsets(pd)
        # also include unique indexes' column sets already in pg_u
        for uq in sd["uniques"]:
            if uq["origin"] == "pk":
                continue
            key = unique_key_from_cols(uq["cols"])
            if not key:
                continue
            if key not in pg_u:
                missing_uniques.append(
                    {"table": t, "name": uq["name"], "cols": list(uq["cols"]), "origin": uq["origin"]}
                )

        # explicit indexes (origin c): match by column set + unique + partial predicate
        pg_idx_keys = set()
        for idx in pd["indexes"]:
            cols = parse_index_cols(idx.get("sql") or "")
            pg_idx_keys.add(
                (tuple(norm_ident(c) if re.match(r"^[A-Za-z_]", c or "") else norm_expr(c) for c in cols),
                 bool(idx.get("unique")),
                 pg_index_partial(idx.get("sql") or ""))
            )
        for idx in sd["indexes"]:
            cols = idx["cols"] or []
            # expression indexes: sqlite index_info may have None col names
            key = (
                tuple(norm_ident(c) for c in cols),
                bool(idx["unique"]),
                sqlite_index_partial(idx.get("sql")),
            )
            # also accept uniquely-constrained colset as covering a unique index
            if key not in pg_idx_keys:
                # if unique and the colset is already a unique constraint, that's OK
                if idx["unique"] and unique_key_from_cols(cols) in pg_u and not sqlite_index_partial(idx.get("sql")):
                    continue
                # name match on pg (same index name)
                if any(norm_ident(p["name"]) == norm_ident(idx["name"]) for p in pd["indexes"]):
                    continue
                missing_indexes.append(
                    {
                        "table": t,
                        "name": idx["name"],
                        "unique": idx["unique"],
                        "partial": idx["partial"],
                        "cols": cols,
                        "sql": idx.get("sql"),
                    }
                )

        # CHECKs: compare canonical forms so GLOB→sqlite_glob, BETWEEN, IN, LIKE, TRIM
        # and PG casts/parentheses are not reported as missing.
        pg_checks = [canon_check(c["def"]) for c in pd["checks"]]
        for ch in sd["checks"]:
            nch = canon_check(ch)
            ok = False
            for pch in pg_checks:
                if not nch or not pch:
                    continue
                if nch == pch or nch in pch or pch in nch:
                    ok = True
                    break
                # token overlap fallback for remaining pretty-print variants
                toks = set(re.findall(r"[a-z_][a-z0-9_]{2,}|'[^']+'", nch))
                if toks and toks <= set(re.findall(r"[a-z_][a-z0-9_]{2,}|'[^']+'", pch)):
                    ok = True
                    break
            if not ok:
                missing_checks.append({"table": t, "expr": ch, "canon": nch})

        # FKs: compare (from cols, to table, to cols, on_delete, on_update)
        def fk_key(from_cols, to_table, to_cols, on_del, on_upd):
            return (
                unique_key_from_cols(from_cols),
                norm_ident(to_table),
                unique_key_from_cols(to_cols),
                (on_del or "NO ACTION").upper().replace("_", " "),
                (on_upd or "NO ACTION").upper().replace("_", " "),
            )

        pg_fk_keys = set()
        for fk in pd["fks"]:
            d = fk["def"]
            # FOREIGN KEY (a,b) REFERENCES t(c,d) ON DELETE X ON UPDATE Y
            m = re.search(
                r"FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\S+)\s*\(([^)]+)\)"
                r"(?:\s+ON DELETE\s+([A-Z ]+))?"
                r"(?:\s+ON UPDATE\s+([A-Z ]+))?",
                d,
                re.I,
            )
            if not m:
                continue
            src = [x.strip() for x in m.group(1).split(",")]
            dstt = m.group(2)
            dst = [x.strip() for x in m.group(3).split(",")]
            od = (m.group(4) or "NO ACTION").strip()
            ou = (m.group(5) or "NO ACTION").strip()
            pg_fk_keys.add(fk_key(src, dstt, dst, od, ou))
        for fk in sd["fks"]:
            k = fk_key(fk["from"], fk["table"], fk["to"], fk["on_delete"], fk["on_update"])
            if k not in pg_fk_keys:
                missing_fks.append(
                    {
                        "table": t,
                        "from": fk["from"],
                        "to_table": fk["table"],
                        "to": fk["to"],
                        "on_delete": fk["on_delete"],
                        "on_update": fk["on_update"],
                    }
                )

    return {
        "sqlite_tables": len(s_tables),
        "pg_tables": len(p_tables_cmp),
        "missing_on_pg": missing_on_pg,
        "extra_on_pg": extra_on_pg,
        "missing_uniques": missing_uniques,
        "missing_indexes": missing_indexes,
        "missing_checks": missing_checks,
        "notnull_mismatch": notnull_mismatch,
        "default_mismatch": default_mismatch,
        "missing_fks": missing_fks,
        "pk_mismatch": pk_mismatch,
        "col_mismatch": col_mismatch,
        "counts": {
            "missing_on_pg": len(missing_on_pg),
            "extra_on_pg": len(extra_on_pg),
            "missing_uniques": len(missing_uniques),
            "missing_indexes": len(missing_indexes),
            "missing_checks": len(missing_checks),
            "notnull_mismatch": len(notnull_mismatch),
            "default_mismatch": len(default_mismatch),
            "missing_fks": len(missing_fks),
            "pk_mismatch": len(pk_mismatch),
            "col_mismatch": len(col_mismatch),
        },
    }


def is_clean(diff: dict) -> bool:
    c = diff["counts"]
    # customer_dossier may exist only on PG (created at API startup / by the migrator).
    extras = [x for x in diff.get("extra_on_pg") or [] if x != "customer_dossier"]
    return all(v == 0 for k, v in c.items() if k != "extra_on_pg") and len(extras) == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", required=True)
    ap.add_argument("--env", default="/root/pg-migration/pg.env")
    ap.add_argument("--database", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    if args.database not in {"nafisvam_masked", "nafisvam_verify"}:
        print("REFUSE_DB: only nafisvam_masked or nafisvam_verify", file=sys.stderr)
        return 5
    sqlite = inspect_sqlite(args.sqlite)
    env = load_env(args.env)
    pg = inspect_pg(env, args.database)
    diff = compare(sqlite, pg)
    # dossier note
    diff["customer_dossier_in_sqlite"] = "customer_dossier" in sqlite["tables"]
    diff["customer_dossier_in_pg"] = "customer_dossier" in pg["tables"]
    text = json.dumps(diff, ensure_ascii=False, indent=2)
    out = args.out or "/tmp/schema-diff.json"
    Path(out).write_text(text)
    c = diff["counts"]
    print("schema_audit", args.database)
    print("sqlite_tables", diff["sqlite_tables"], "pg_tables", diff["pg_tables"])
    print("customer_dossier sqlite", diff["customer_dossier_in_sqlite"], "pg", diff["customer_dossier_in_pg"])
    for k, v in c.items():
        print(f"  {k}: {v}")
    if diff["missing_on_pg"]:
        print("missing_tables", " ".join(diff["missing_on_pg"]))
    # summarize missing uniques by table
    if diff["missing_uniques"]:
        print("missing_uniques:")
        for u in diff["missing_uniques"]:
            print(f"  {u['table']} ({', '.join(u['cols'])})")
    if diff["missing_indexes"]:
        print("missing_indexes:")
        for u in diff["missing_indexes"][:30]:
            print(f"  {u['table']}.{u['name']} unique={u['unique']} partial={u['partial']} cols={u['cols']}")
        if len(diff["missing_indexes"]) > 30:
            print("  ...", len(diff["missing_indexes"]) - 30, "more")
    if diff["missing_checks"]:
        print("missing_checks:", len(diff["missing_checks"]))
        # group by table
        by = defaultdict(int)
        for ch in diff["missing_checks"]:
            by[ch["table"]] += 1
        for t, n in sorted(by.items(), key=lambda x: -x[1])[:20]:
            print(f"  {t}: {n}")
    if diff["notnull_mismatch"]:
        print("notnull_mismatch:")
        for u in diff["notnull_mismatch"][:20]:
            print(f"  {u['table']}.{u['col']} sqlite={u['sqlite']} pg={u['pg']}")
    if diff["default_mismatch"]:
        print("default_mismatch:")
        for u in diff["default_mismatch"][:20]:
            print(f"  {u['table']}.{u['col']} sqlite_has={u['sqlite_has']} pg_has={u['pg_has']}")
    if diff["missing_fks"]:
        print("missing_fks:", len(diff["missing_fks"]))
    if diff["pk_mismatch"]:
        print("pk_mismatch:", len(diff["pk_mismatch"]))
    if diff["col_mismatch"]:
        print("col_mismatch:", len(diff["col_mismatch"]))
    print("wrote", out)
    print("CLEAN" if is_clean(diff) else "DIFFS_REMAIN")
    return 0 if is_clean(diff) else 1


if __name__ == "__main__":
    sys.exit(main())

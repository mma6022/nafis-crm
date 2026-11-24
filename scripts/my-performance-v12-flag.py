#!/usr/bin/env python3
"""flag.my_performance_v12 (call_queue_settings).
Usage: my-performance-v12-flag.py on|off|show [db]
Touches ONLY this key (+ one call_queue_settings_log row). Never touches
flag.my_performance_v1, flag.my_performance_inquiry, flag.sales_performance_v1,
flag.expert_lockdown, or flag.multi_team_v1.
Only '1' is ON. Default / absent / anything else is OFF.
"""
import sqlite3, sys, os
from datetime import datetime, timezone

KEY = "flag.my_performance_v12"
LIVE = "/var/lib/nafisvam/customers.db"

mode = (sys.argv[1] if len(sys.argv) > 1 else "show").strip()
db = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CRM_DATABASE_PATH") or LIVE
if mode not in ("on", "off", "show"):
    sys.exit("usage: my-performance-v12-flag.py on|off|show [db]")
if os.path.realpath(db) == os.path.realpath(LIVE) and mode != "show" and not os.environ.get("NAFISVAM_ALLOW_LIVE_FLAG"):
    sys.exit("Refusing to write the live database (set NAFISVAM_ALLOW_LIVE_FLAG=1 to override).")

con = sqlite3.connect(db)
c = con.cursor()
row = c.execute("SELECT value, updated_at FROM call_queue_settings WHERE key=?", (KEY,)).fetchone()
old = row[0] if row else None
if mode == "show":
    print(f"{KEY}={'1' if old == '1' else '0 (OFF)'} raw={old!r} updated_at={row[1] if row else None}")
    con.close(); raise SystemExit(0)
new = "1" if mode == "on" else "0"
if old == new:
    print(f"{KEY} already {new}")
    con.close(); raise SystemExit(0)
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
c.execute("INSERT INTO call_queue_settings(key, value, updated_by, updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=NULL, updated_at=excluded.updated_at", (KEY, new, now))
try:
    c.execute("INSERT INTO call_queue_settings_log(key, old_value, new_value, user_id, at) VALUES(?,?,?,NULL,?)", (KEY, old, new, now))
except sqlite3.Error:
    pass
con.commit(); con.close()
print(f"{KEY} {old!r} -> {new}")

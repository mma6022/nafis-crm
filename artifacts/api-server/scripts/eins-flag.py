#!/usr/bin/env python3
"""EINS: expert-intro SMS for NEW Instagram / site-request customers (pattern wuk6lgtho227bxc: name, sale_name, sale_mobile).
Usage: eins-flag.py on|off|show [db]
Touches ONLY call_queue_settings key flag.expert_intro_new_lead (+ one call_queue_settings_log row). Never touches
notification_settings or team_sales_config. Absent or anything other than '1' = OFF (the shipped state).
'on' only queues customers created AFTER it (no backfill). 'off' writes '0': instant, no restart; on its next tick
(<=1 min) the worker marks every still-waiting row skipped («غیرفعال») so nothing queued is sent later.
Needs Mohammad's direct OK, a contact phone on each expert and a healthy SMS route (proxy) before 'on'."""
import sqlite3, sys, datetime
KEY = "flag.expert_intro_new_lead"
mode = sys.argv[1] if len(sys.argv) > 1 else "show"
db = sys.argv[2] if len(sys.argv) > 2 else "/var/lib/nafisvam/customers.db"
c = sqlite3.connect(db, timeout=30, isolation_level=None)
c.execute("PRAGMA busy_timeout=30000")
if mode == "show":
    r = c.execute("SELECT value, updated_at FROM call_queue_settings WHERE key=?", (KEY,)).fetchone()
    print(KEY, "=", "(absent = OFF)" if r is None else f"{r[0]} {r[1]} | {'ON' if r[0] == '1' else 'OFF'}")
    if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='expert_intro_newlead'").fetchone():
        for s, src, n in c.execute("SELECT status, source, COUNT(*) FROM expert_intro_newlead GROUP BY 1, 2 ORDER BY 1, 2"):
            print(f"  {s:15} {src:13} {n}")
    else: print("  expert_intro_newlead: not created yet (created on first new lead while ON)")
    n = c.execute("SELECT COUNT(DISTINCT s.id) FROM salespersons s JOIN users u ON u.salesperson_id=s.id AND u.active=1 WHERE s.active=1 AND TRIM(COALESCE(u.customer_contact_phone,''))<>''").fetchone()[0]
    print("  active experts with a contact phone (sale_mobile):", n)
    sys.exit(0)
if mode not in ("on", "off"): sys.exit("usage: eins-flag.py on|off|show [db]")
new = "1" if mode == "on" else "0"
d = datetime.datetime.now(datetime.timezone.utc); now = d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"
c.execute("BEGIN IMMEDIATE")
r = c.execute("SELECT value FROM call_queue_settings WHERE key=?", (KEY,)).fetchone()
old = r[0] if r else None
if old is None and new == "0":
    c.execute("ROLLBACK"); print(KEY, "absent = OFF already, nothing written"); sys.exit(0)
if old == new:
    c.execute("ROLLBACK"); print(KEY, "already", new); sys.exit(0)
c.execute("INSERT INTO call_queue_settings(key, value, updated_by, updated_at) VALUES(?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=NULL, updated_at=excluded.updated_at", (KEY, new, now))
c.execute("INSERT INTO call_queue_settings_log(key, old_value, new_value, user_id, at) VALUES(?,?,?,NULL,?)", (KEY, old, new, now))
c.execute("COMMIT")
print(KEY, old, "->", new, now)

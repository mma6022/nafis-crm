#!/usr/bin/env python3
"""SALES-FIXES 480000 fixtures (local masked stack only, started with SEED=mt480/seed_shots.py). Bugs 3, 4 + changes 5, 7, 8, 9 + kill switches."""
import json, sys, urllib.request, sqlite3, os
API = "http://127.0.0.1:52648/api"; RUN = "/workspace/q-480000/run"
tok = lambda n: open(f"{RUN}/{n}.token").read().strip()
def call(m, p, t, b=None):
    r = urllib.request.Request(API + p, method=m, data=json.dumps(b).encode() if b is not None else None,
                               headers={"Content-Type": "application/json", "Cookie": "crm_session=" + t})
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, None
ok = bad = 0
def chk(n, c):
    global ok, bad
    print(("PASS " if c else "FAIL ") + n); ok += bool(c); bad += (not c)
db = sqlite3.connect(f"{RUN}/q480.db"); db.execute("PRAGMA busy_timeout=5000")
assert os.path.realpath(f"{RUN}/q480.db") != "/var/lib/nafisvam/customers.db"
def flag(k, v):
    if v is None: db.execute("DELETE FROM call_queue_settings WHERE key=?", (k,))
    else: db.execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    db.commit()
E, H = tok("expert"), tok("hasani")
own = db.execute("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").fetchone()[0]
oth = db.execute("SELECT id FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").fetchone()[0]
case = db.execute("SELECT la.id, la.customer_id FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE c.salesperson_id=6 AND la.deleted_at IS NULL AND la.status<>'rejected' AND la.stage<>'completed' ORDER BY la.id LIMIT 1").fetchone()
chk("guard: expert_lockdown still on", db.execute("SELECT value FROM call_queue_settings WHERE key='flag.expert_lockdown'").fetchone()[0] == "1")
# ---- bug 3: reminders
rem = lambda cid, extra={}: call("POST", "/reminders", E, {"customerId": cid, "subject": "fx480", "message": "fx480 reminder", "remindAt": "2026-11-17T12:00:00.000Z", **extra})
c, b = rem(own); chk(f"bug3 own customer reminder (daily list / مشتریان من) = {c}", c == 201)
c, b = rem(case[1], {"loanApplicationId": case[0], "caseScope": "case"}); chk(f"bug3 case-scoped reminder (پرونده‌های تسهیلات #{case[0]}) = {c}", c == 201)
c, b = rem(None); chk(f"bug3 personal reminder = {c}", c == 201)
c, b = rem(oth); chk(f"bug3 other expert's customer stays closed = {c} {(b or {}).get('error')}", c == 403)
c, b = call("GET", "/customers?search=09", E); chk(f"bug3 root cause still there: old GET /customers for a locked expert = {c} (so the form now uses /sales-fixes/search)", c in (403, 422))
nm = db.execute("SELECT name FROM customers WHERE id=?", (own,)).fetchone()[0]
c, b = call("GET", "/sales-fixes/search?q=" + urllib.parse.quote(nm.split(" ")[-1]), E)
sps = {db.execute("SELECT salesperson_id FROM customers WHERE id=?", (x["id"],)).fetchone()[0] for x in (b or {}).get("items", [])}
chk(f"item9 search returns only own customers (sp {sorted(sps)}) and cases list per hit", c == 200 and sps <= {6} and all("cases" in x for x in b["items"]))
c, b = call("GET", f"/sales-fixes/search?q={oth}", E); chk("item9 search by another expert's customer id finds nothing", c == 200 and not any(x["id"] == oth for x in b["items"]))
# ---- bug 4: incoming in «اکنون»
c, q = call("GET", "/daily-customer-inline/queue", E)
inc = [x for x in (q or {}).get("items", []) if x["kind"] == "incoming_call" and x.get("live") and not x["done"]]
chk(f"bug4 seeded live incoming calls in the queue = {len(inc)}", len(inc) >= 2)
chk("bug4 every live incoming call sits in the «اکنون» block and is urgent", bool(inc) and all(x["blockIdx"] == q["nowBlock"] and x["urgent"] for x in inc) and q["inHours"])
unk = [x for x in inc if x["customer_id"] is None]; kn = [x for x in inc if x["customer_id"] is not None]
chk("bug4 registered customer → task carries customer_id (button opens /today?customer=…)", bool(kn) and db.execute("SELECT salesperson_id FROM customers WHERE id=?", (kn[0]["customer_id"],)).fetchone()[0] == 6)
chk("bug4 new number → item without customer (name step first)", bool(unk))
if unk:
    eid = int(unk[0]["id"].split("-")[1])
    c, b = call("POST", f"/daily-customer-inline/queue/unknown/{eid}/name", E, {"firstName": "کیوان", "lastName": "نمونه"})
    chk(f"bug4 name step creates the customer for this expert = {c}", c == 200 and b and b.get("customerId"))
    if c == 200:
        sp = db.execute("SELECT salesperson_id FROM customers WHERE id=?", (b["customerId"],)).fetchone()[0]
        chk(f"bug4 named customer owned by the expert (sp {sp}) → first call", sp == 6)
        c2, bd = call("GET", f"/daily-customer-inline/customers/{b['customerId']}", E)
        chk(f"bug4 named customer's board opens = {c2}, first={bd.get('first') if bd else None}", c2 == 200)
# old rule switch
flag("flag.sf480_incoming_now", "0"); db.execute("UPDATE voip_after_call_events SET started_at='2026-11-17T06:30:00.000Z', ended_at='2026-11-17T06:30:00.000Z' WHERE external_id LIKE 'sf480-shot-%'"); db.commit()
c, q2 = call("GET", "/daily-customer-inline/queue", E)
old = [x for x in q2["items"] if x["kind"] == "incoming_call" and x.get("live") and not x["done"]]
flag("flag.sf480_incoming_now", None)
c, q3 = call("GET", "/daily-customer-inline/queue", E)
new = [x for x in q3["items"] if x["kind"] == "incoming_call" and x.get("live") and not x["done"]]
chk(f"bug4 a live call older than the urgent window: switch '0' → urgent={[x['urgent'] for x in old]}, default → urgent={[x['urgent'] for x in new]}", old and not any(x["urgent"] for x in old) and new and all(x["urgent"] for x in new))
# ---- item 5: no popups
c, b = call("GET", "/reminder-must/config", E); chk(f"item5 mandatory reminder popup feed off for the expert: {b}", c == 200 and b.get("enabled") is False)
flag("flag.sf480_no_popups", "0"); c, b = call("GET", "/reminder-must/config", E); chk(f"item5 kill switch '0' → old feed back: {b}", b.get("enabled") is True); flag("flag.sf480_no_popups", None)
# ---- item 7/8: lists open, scope kept
c, b = call("GET", "/expert-lockdown/me", E); chk(f"item7 lockdown still on, /customers allowed: {b.get('locked')}, {'/customers' in b.get('allowedPages', [])}", b.get("locked") is True and "/customers" in b["allowedPages"])
chk("item7 other lockdown pages unchanged (no /reminders, no /calls)", "/reminders" not in b["allowedPages"] and "/calls" not in b["allowedPages"])
n_own = db.execute("SELECT COUNT(*) FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL").fetchone()[0]
c, b = call("GET", "/sales-fixes/my-customers", E); chk(f"item7 «مشتریان من» = own customers only ({b.get('total')} = {n_own})", c == 200 and b["total"] == n_own)
c, b = call("GET", "/sales-fixes/cases", E)
cs = {db.execute("SELECT c.salesperson_id FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.id=?", (x["id"],)).fetchone()[0] for x in b["cases"]}
chk(f"item8 kanban cases = own only ({b.get('total')} cases, sp {sorted(cs)})", c == 200 and cs <= {6} and b["total"] > 0)
c, b = call("GET", "/files-carousel/board", E)
chk(f"item7 board: no card is 'locked' (states {sorted({x['state'] for x in b['cards']})})", all(x["state"] != "locked" for x in b["cards"]))
nt = [x for x in b["cards"] if x["state"] in ("open", "later")]
if nt:
    c, r = call("POST", f"/loan-applications/{nt[0]['fileId']}/sf480-probe", E, {}); chk(f"item7 write on a non-turn own file passes the files guard (probe → {c}, not 423)", c != 423)
    flag("flag.sf480_open_lists", "0"); c, r = call("POST", f"/loan-applications/{nt[0]['fileId']}/sf480-probe", E, {})
    c2, me = call("GET", "/expert-lockdown/me", E); flag("flag.sf480_open_lists", None)
    chk(f"item7 kill switch '0' → old board turn 423 ({c} {(r or {}).get('error')}) and /customers locked again ({'/customers' in me['allowedPages']})", c == 423 and "/customers" not in me["allowedPages"])
c, b = call("GET", "/sales-fixes/my-customers", H); chk("item7 other expert's list has none of user 8's customers", c == 200 and b["total"] == db.execute("SELECT COUNT(*) FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL").fetchone()[0])
# ---- bug 1 kill switch
cx = db.execute("SELECT id FROM customers WHERE salesperson_id=3 AND status='in_progress' AND coalesce(priority,0)<>1 ORDER BY id DESC LIMIT 1").fetchone()[0]
call("PATCH", f"/customers/{cx}", H, {"status": "cancelled"}); flag("flag.sf480_owner_status", "0")
c, b = call("PATCH", f"/customers/{cx}", H, {"status": "in_progress"}); flag("flag.sf480_owner_status", None)
chk(f"bug1 kill switch '0' → old 409 reactivation_required ({c} {(b or {}).get('error')})", c == 409)
c, b = call("PATCH", f"/customers/{cx}", H, {"status": "in_progress"}); chk(f"bug1 default → cancelled leaves with a plain PATCH ({c})", c == 200)
db.execute("DELETE FROM reminders WHERE subject='fx480'"); db.commit()
for k in ("flag.sf480_owner_priority", "flag.sf480_owner_status", "flag.sf480_open_lists", "flag.sf480_no_popups", "flag.sf480_incoming_now"):
    assert db.execute("SELECT COUNT(*) FROM call_queue_settings WHERE key=?", (k,)).fetchone()[0] == 0
print(f"RESULT {ok} pass / {bad} fail"); sys.exit(1 if bad else 0)

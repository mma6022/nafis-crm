#!/usr/bin/env python3
"""SALES-FIXES 480000 fixtures, bugs 1+2 (local masked stack only). Never live."""
import json, sys, urllib.request, sqlite3, os
API=os.environ.get("API","http://127.0.0.1:52648/api"); RUN="/workspace/q-480000/run"
assert "127.0.0.1" in API
tok=lambda n: open(f"{RUN}/{n}.token").read().strip()
def call(m,p,t,b=None):
    r=urllib.request.Request(API+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"Content-Type":"application/json","Authorization":"Bearer "+t,"Cookie":"crm_session="+t})
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, None
ok=0; bad=0
def chk(n,c):
    global ok,bad
    print(("PASS " if c else "FAIL ")+n); ok+=c; bad+=(not c)
H=tok("hasani")
db=sqlite3.connect(f"{RUN}/q480.db")
cid=int(sys.argv[1]) if len(sys.argv)>1 else db.execute("select id from customers where salesperson_id=3 and status='in_progress' and coalesce(priority,0)<>1 order by id limit 1").fetchone()[0]
seq=["cancelled","in_progress","completed","in_progress","cancelled","completed","in_progress"]
for i,s in enumerate(seq):
    c,b=call("PATCH",f"/customers/{cid}",H,{"status":s})
    chk(f"bug1 status change #{i+1} → {s} (cust {cid}) = {c} {'' if c==200 else (b or {}).get('error')}", c==200)
row=db.execute("select status from customers where id=?",(cid,)).fetchone(); chk(f"bug1 final status in DB = {row[0]}", row[0]=="in_progress")
# bug 2: P1 set by promote, own expert lowers it, then raises/lowers again
p1=[r[0] for r in db.execute("""select cu.id from customers cu where cu.salesperson_id=3 and cu.priority=1 and status='in_progress' and
 (select source from customer_priority_history h where h.customer_id=cu.id and h.new_priority=1 order by id desc limit 1) in ('promote','expert_upgrade') order by id limit 1""")]
pid=p1[0]
c,b=call("PATCH",f"/customers/{pid}",H,{"priority":2})
chk(f"bug2 owner lowers P1 (last P1 source promote, cust {pid}) = {c} {'' if c==200 else (b or {}).get('error')} (was 403 p1_revert_admin_only)", c==200)
nsp=db.execute("select salesperson_id from customers where id=?",(pid,)).fetchone()[0]
print(f"     note: existing nonP1 auto-transfer rule moved cust {pid} to sp {nsp} (unchanged behaviour)")
# repeated priority changes on an own non-P1 customer
q=db.execute("select id from customers where salesperson_id=3 and status='in_progress' and priority in (2,3) order by id limit 1").fetchone()[0]
for i,pr in enumerate([3,2,3,2]):
    c,b=call("PATCH",f"/customers/{q}",H,{"priority":pr})
    chk(f"bug2 owner priority change #{i+1} → P{pr} (cust {q}) = {c} {'' if c==200 else (b or {}).get('error')}", c==200)
# scope: expert 8 (sp 6) may NOT change a customer of sp 3
E=tok("expert")
c,b=call("PATCH",f"/customers/{q}",E,{"priority":3}); chk(f"scope: other expert PATCH priority = {c} {(b or {}).get('error')} (must be 403)", c==403)
c,b=call("PATCH",f"/customers/{cid}",E,{"status":"cancelled"}); chk(f"scope: other expert PATCH status = {c} {(b or {}).get('error')} (must be 403)", c==403)
# bug 2b: expert 8 (sp 6) on own customers: P2→P3→P2, promote to P1 (form with reason), then lower again
e8=db.execute("select id from customers where salesperson_id=6 and status='in_progress' and priority in (2,3) order by id desc limit 1").fetchone()[0]
for pr in (3,2):
    c,b=call("PATCH",f"/customers/{e8}",E,{"priority":pr}); chk(f"bug2 user8 own cust {e8} → P{pr} = {c} {'' if c==200 else (b or {}).get('error')}", c==200)
c,b=call("POST",f"/customers/{e8}/priority",E,{"level":1,"reason":"تست محلی"}); chk(f"bug2 user8 promote own cust {e8} → P1 = {c} {'' if c in (200,201) else (b or {}).get('error')}", c in (200,201))
own=db.execute("select salesperson_id from customers where id=?",(e8,)).fetchone()[0]
print(f"     note: after promote cust {e8} is with sp {own} (existing P1 routing)")
print(f"RESULT {ok} pass / {bad} fail"); sys.exit(1 if bad else 0)

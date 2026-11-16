#!/usr/bin/env python3
"""Local masked copy only: fake Persian names everywhere, no descriptions/notes text with real data, and seeded incoming calls for user 8."""
import sqlite3, sys, os, random, datetime
db = sys.argv[1]
assert os.path.realpath(db) != "/var/lib/nafisvam/customers.db" and "/workspace/q-480000/run/" in os.path.realpath(db)
c = sqlite3.connect(db); random.seed(480)
F = ["آرش","مهسا","نیما","سارا","رضا","لیلا","کاوه","نگار","بهرام","شیرین","پویا","مریم","امید","ترانه","سینا","هانیه","فرهاد","یاسمن","کیان","الهام"]
L = ["رستمی","نادری","کیانی","صالحی","مرادی","فرهمند","پارسا","توکلی","جلالی","شریفی","امینی","نوروزی","یزدانی","کامرانی","زارعی","بهرامی"]
ids = [r[0] for r in c.execute("SELECT id FROM customers")]
for i in ids:
    c.execute("UPDATE customers SET name=?, description=NULL, phone=? WHERE id=?", (f"{random.choice(F)} {random.choice(L)}", "0900" + str(i).zfill(7), i))
# free-text fields that may hold real data (shot DB only)
SAMPLE = ["مدارک را تا فردا می‌فرستد.", "برای طرح ۵۰ میلیونی سؤال داشت؛ عصر دوباره تماس بگیرم.", "ضامن دارد؛ منتظر فیش حقوقی است.", "گفت هفته‌ی بعد تماس بگیرید."]
for t, cols in (("call_logs", ["subject","customer_request","expert_notes","one_line_note"]), ("assistant_customer_notes", ["body"]), ("dci_expert_notes", ["body"]),
                ("dci_inbound_notes", ["body"]), ("loan_application_notes", ["text","author_name"])):
    for col in cols:
        try: c.execute(f"UPDATE {t} SET {col}=? WHERE {col} IS NOT NULL AND {col}<>''", (SAMPLE[hash(t+col) % len(SAMPLE)],))
        except sqlite3.OperationalError: pass
for t, col in (("loan_applications","salesperson_name_snapshot"),("call_logs","salesperson_name_snapshot"),("voip_after_call_events","expert_name"),("voip_after_call_events","contact_name")):
    try: c.execute(f"UPDATE {t} SET {col}='کارشناس نمونه' WHERE {col} IS NOT NULL")
    except sqlite3.OperationalError: pass
try: c.execute("UPDATE users SET name='کارشناس نمونه' WHERE id<>8"); c.execute("UPDATE users SET name='کارشناس فروش' WHERE id=8")
except sqlite3.OperationalError: pass
try: c.execute("UPDATE salespersons SET name='کارشناس نمونه'")
except sqlite3.OperationalError: pass
c.commit()
now = datetime.datetime(2026,11,17,7,49,20,tzinfo=datetime.timezone.utc)
own = c.execute("SELECT id, phone FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL AND status='in_progress' ORDER BY id DESC LIMIT 1 OFFSET 3").fetchone()
mx = c.execute("SELECT COALESCE(MAX(id),0) FROM voip_after_call_events").fetchone()[0]
def ev(eid, phone, cust, at):
    c.execute("""INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,expert_name,salesperson_id,customer_id,has_recording,is_live)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)""", (eid, f"sf480-shot-{eid}", phone, "incoming", "ANSWERED", at.isoformat().replace("+00:00","Z"), at.isoformat().replace("+00:00","Z"), "212", '["212"]', 8, "کارشناس", 6, cust))
if os.environ.get("SEED_INCOMING", "1") == "1":
    ev(mx+1, own[1], own[0], now)
    ev(mx+2, "09120000480", None, now + datetime.timedelta(seconds=20))
c.commit(); print("seeded", own[0], mx+1, mx+2)

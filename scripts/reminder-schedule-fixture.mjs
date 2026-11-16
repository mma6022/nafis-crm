// Synthetic fixture for GET /api/assistant-runner/reminders/schedule (assistantsrs, READ ONLY). In-memory DB only, no network, no SMS.
// Run: node scripts/run-bundled-fixture.mjs scripts/reminder-schedule-fixture.mjs
// Needs a scratch CRM DB for module-level imports: NODE_ENV=production CRM_DATABASE_PATH=<scratch copy> (the fixture itself only uses :memory:).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createAssistants, ensureAssistantSchema } from "../src/lib/assistants.ts";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,description TEXT,created_at TEXT,salesperson_id INTEGER,priority INTEGER,status TEXT,national_code TEXT,
  first_name TEXT,last_name TEXT,merged_into_customer_id INTEGER);
CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,salesperson_id INTEGER,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,created_at TEXT,
  subject TEXT,customer_id INTEGER,notified_at TEXT,source TEXT,closed_at TEXT,voided_at TEXT,snooze_until TEXT,snooze_used INTEGER DEFAULT 0,note TEXT,created_by INTEGER);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,customer_name TEXT NOT NULL,owner_id INTEGER,resource_type TEXT NOT NULL,
  resource_id INTEGER NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',permission TEXT NOT NULL,created_at TEXT NOT NULL,actor_key TEXT,recipient_user_id INTEGER);
CREATE TABLE site_notification_reads(user_id INTEGER NOT NULL,event_id INTEGER NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
INSERT INTO salespersons VALUES(3,'S3'),(4,'S4'),(5,'T5'),(6,'S6');
INSERT INTO users VALUES(1,'admin','A','admin',NULL,1),(2,'u2','U2','salesperson',3,1),(3,'u3','U3','salesperson',4,1),(4,'reg','R','registrar',NULL,1),
  (6,'t5','T5','salesperson',5,1),(8,'u8','U8','salesperson',6,1),(29,'x29','X29','admin',NULL,1);
INSERT INTO customers(id,name,phone,created_at,salesperson_id,priority,status,first_name,last_name) VALUES
  (100,'Alpha One','09121234567','2026-10-01',3,1,'in_progress','Alpha','One'),
  (101,'Bravo Twotwo','09120000001','2026-10-01',3,2,'in_progress','Bravo','Twotwo'),
  (110,'Charlie Three','09120000003','2026-10-01',4,1,'in_progress',NULL,NULL),
  (120,'Delta Four','09120000004','2026-10-01',6,3,'in_progress',NULL,NULL);`);
const R_ = db.prepare("INSERT INTO reminders(id,user_id,salesperson_id,message,remind_at,created_at,subject,customer_id,source,done,voided_at,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
const add = (id, uid, sp, at, cid, o = {}) => R_.run(id, uid, sp, o.message ?? "MSGTEXT", at, "2026-10-20T00:00:00Z", o.subject ?? "call back 09121234567", cid, o.source ?? "manual", o.done ?? 0, o.voided ?? null, o.note ?? null);
// clock: 2026-11-02T08:00Z = 11:30 Tehran, Mon 2 Nov
add(1, 2, 3, "2026-11-02T06:30:00.000Z", 100);                         // today 10:00 Tehran, overdue
add(2, 2, 3, "2026-11-02T06:45:00.000Z", 101, { subject: "SECRET-P2" }); // today 10:15, P2 (out of p1 scope), overdue, same hour
add(3, 2, 3, "2026-11-03T10:00:00.000Z", null, { subject: "PERSONAL-SUBJ", message: "PERSONAL-MSG", note: "PERSONAL-NOTE" }); // personal 13:30 Tehran
add(4, 2, 3, "2026-10-28T05:00:00.000Z", 100);                         // old overdue
add(5, 2, 3, "2026-11-04T06:00:00.000Z", 100, { done: 1 });            // done → excluded
add(6, 2, 3, "2026-11-04T06:00:00.000Z", 100, { voided: "2026-11-01T00:00:00Z" }); // voided → excluded
add(7, 2, 3, "2026-11-02T20:29:00.000Z", 100);                         // 23:59 Tehran 2 Nov
add(8, 2, 3, "2026-11-02T20:31:00.000Z", 100);                         // 00:01 Tehran 3 Nov
add(9, 2, 3, "2026-11-20T08:00:00.000Z", 100);                         // outside default 15 days
add(10, 2, 3, "2026-11-05 09:00:00", 100);                             // legacy no-Z → UTC → 12:30 Tehran
for (let i = 0; i < 9; i++) add(20 + i, 2, 3, new Date(Date.UTC(2026, 10, 6, 4, 30) + i * 3600_000).toISOString(), 100); // 9 on 6 Nov, one per hour
add(30, 3, 4, "2026-11-03T06:00:00.000Z", 110);
add(40, 8, 6, "2026-11-04T06:00:00.000Z", 120);
add(41, 8, 6, "2026-11-04T07:00:00.000Z", null, { subject: "K-PERSONAL" });
add(50, 29, null, "2026-11-03T06:00:00.000Z", null);
add(51, 6, 5, "2026-11-03T06:00:00.000Z", null);
ensureAssistantSchema(db);
const As = Object.fromEntries(db.prepare("SELECT * FROM assistants").all().map(a => [a.slug, a]));
let clock = new Date("2026-11-02T08:00:00Z");
const users = { 1: "admin", 2: "salesperson", 3: "salesperson", 8: "salesperson" };
const as = createAssistants({ db, now: () => clock, sales: { activeSiteLeads: () => new Map(), siteLeadHistory: () => [] }, actor: res => { const id = Number(res.locals.uid); return users[id] ? { id, role: users[id], salespersonId: null, name: "x" } : null; } });
const app = express();
app.use("/api/assistant-runner", as.runner);
app.use(express.json());
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, as.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const call = async (method, p, body, user, bearer) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": String(user) } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, t };
};
const S = (u, m, p, b) => call(m, `/api${p}`, b, u);
const G = (tok, q = "") => call("GET", `/api/assistant-runner/reminders/schedule${q}`, null, null, tok);
const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
const snap = (skip = ["assistant_audit", "assistant_tokens", "assistants", "sqlite_sequence"]) => Object.fromEntries(tables().filter(t => !skip.includes(t)).map(t => [t, JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all())]));
let passed = 0; const ok = (n) => { passed++; console.log("ok", n); };
try {
  const tok = {};
  for (const slug of ["somayeh", "mohaddeseh", "masoud", "sarina", "ahmad"]) { const r = await S(1, "POST", `/admin/assistants/${As[slug].id}/tokens`, { name: `${slug}-fx` }); if (r.s === 201) tok[slug] = r.j.token; }
  await S(1, "PUT", "/admin/assistants/global", { enabled: true });
  for (const slug of Object.keys(tok)) await S(1, "POST", `/admin/assistants/${As[slug].id}/enable`);
  assert.equal((await G(null)).s, 401); assert.equal((await G("x".repeat(40))).s, 401);
  ok("auth: no / bad token → 401");
  const before = snap(); const remBefore = JSON.stringify(db.prepare("SELECT * FROM reminders ORDER BY id").all());
  const auditBefore = db.prepare("SELECT COUNT(*) n FROM assistant_audit").get().n;

  const d = await G(tok.somayeh); assert.equal(d.s, 200, d.t);
  const ids = d.j.items.map(x => x.id);
  assert.deepEqual(ids, [4, 1, 2, 7, 8, 3, 10, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
  assert.deepEqual(d.j.expert, { userId: 2, salespersonId: 3 });
  assert.equal(d.j.range.from, "2026-11-02"); assert.equal(d.j.range.days, 15); assert.equal(d.j.range.toExclusive, "2026-11-17"); assert.equal(d.j.days.length, 15);
  assert.equal(d.j.range.startAt, "2026-11-01T20:30:00.000Z");
  ok("default range = overdue + today + 14 days; done/voided excluded; sorted");

  const by = Object.fromEntries(d.j.items.map(x => [x.id, x]));
  assert.equal(by[1].overdue, true); assert.equal(by[2].overdue, true); assert.equal(by[4].overdue, true); assert.equal(by[7].overdue, false); assert.equal(by[3].overdue, false);
  assert.equal(d.j.totals.overdue, 3); assert.equal(d.j.totals.overdueBeforeFrom, 1); assert.deepEqual(d.j.overdueBeforeFrom.byDay, [{ date: "2026-10-28", count: 1 }]);
  assert.equal(by[4].tehranDate, "2026-10-28"); assert.equal(by[4].tehranTime, "08:30");
  ok("overdue flags + overdue before from");

  assert.equal(by[7].tehranDate, "2026-11-02"); assert.equal(by[7].tehranTime, "23:59");
  assert.equal(by[8].tehranDate, "2026-11-03"); assert.equal(by[8].tehranTime, "00:01");
  assert.equal(by[10].remindAt, "2026-11-05T09:00:00.000Z"); assert.equal(by[10].tehranTime, "12:30");
  assert.equal(by[1].tehranTime, "10:00"); assert.ok(by[1].tehranFa && /۱۴۰۵/.test(by[1].tehranFa));
  ok("Tehran day boundary (UTC 20:29/20:31) + legacy no-Z timestamp");

  const p = by[3];
  assert.deepEqual(Object.keys(p).sort(), ["id", "kind", "overdue", "remindAt", "snoozedUntil", "tehranDate", "tehranFa", "tehranTime"]);
  assert.equal(p.kind, "personal");
  for (const s of ["PERSONAL-SUBJ", "PERSONAL-MSG", "PERSONAL-NOTE", "MSGTEXT"]) assert.ok(!d.t.includes(s), s);
  ok("personal reminders: time only, no subject/message/note");

  assert.equal(by[1].kind, "customer"); assert.equal(by[1].customerId, 100); assert.equal(by[1].inScope, true); assert.equal(by[1].customerName, "Alpha One");
  assert.equal(by[1].priority, 1); assert.equal(by[1].source, "manual"); assert.ok(by[1].subject.startsWith("call back ") && !by[1].subject.includes("09121234567"));
  assert.equal(by[2].priority, 2); assert.equal(by[2].inScope, false); assert.equal(by[2].subject, null); assert.equal(by[2].customerName, "Bravo T…");
  assert.ok(!d.t.includes("SECRET-P2")); assert.ok(!/09\d{9}/.test(d.t)); assert.ok(!/phone|mobile/i.test(d.t));
  ok("customer rows of every priority; in-scope name + masked subject; out-of-scope masked name, no subject; no phones");

  const day = Object.fromEntries(d.j.days.map(x => [x.date, x]));
  assert.equal(day["2026-11-02"].count, 3); assert.deepEqual(day["2026-11-02"].overHours, ["10"]); assert.equal(day["2026-11-02"].hours.find(h => h.hour === "10").count, 2);
  assert.equal(day["2026-11-02"].overdueCount, 2); assert.equal(day["2026-11-02"].overDayLimit, false);
  assert.equal(day["2026-11-03"].count, 2); assert.equal(day["2026-11-03"].personalCount, 1); assert.equal(day["2026-11-03"].customerCount, 1);
  assert.equal(day["2026-11-06"].count, 9); assert.equal(day["2026-11-06"].overDayLimit, true); assert.deepEqual(day["2026-11-06"].overHours, []);
  assert.deepEqual(d.j.overLimitDays, ["2026-11-06"]); assert.deepEqual(d.j.limits, { perDay: 8, perHour: 1 });
  assert.equal(day["2026-11-10"].count, 0);
  ok("per-day / per-hour summary with > 8 / day and > 1 / hour flags");

  const q31 = await G(tok.somayeh, "?days=31"); assert.ok(q31.j.items.some(x => x.id === 9)); assert.equal(q31.j.days.length, 31);
  const q99 = await G(tok.somayeh, "?days=99"); assert.equal(q99.j.range.days, 31); assert.equal(q99.j.range.clamped, true);
  for (const q of ["?days=0", "?days=abc", "?days=-1", "?from=bad", "?from=2026-02-30", "?from=2026-11-2"]) assert.equal((await G(tok.somayeh, q)).s, 400, q);
  const f3 = await G(tok.somayeh, "?from=2026-11-03&days=1");
  assert.deepEqual(f3.j.items.map(x => x.id), [4, 1, 2, 8, 3]); assert.equal(f3.j.totals.overdueBeforeFrom, 3);
  const fa = await G(tok.somayeh, "?from=۲۰۲۶-۱۱-۰۳&days=۱"); assert.equal(fa.s, 200); assert.equal(fa.j.range.from, "2026-11-03");
  ok("days clamp ≤ 31, validation, explicit from");

  for (const q of ["?userId=3", "?user=8", "?salespersonId=4&user_id=3", "?expert=8&assistant=masoud"]) {
    const r = await G(tok.somayeh, q); assert.equal(r.s, 200); assert.deepEqual(r.j.items.map(x => x.id), ids, q); assert.equal(r.j.expert.userId, 2);
  }
  const mo = await G(tok.mohaddeseh); assert.deepEqual(mo.j.items.map(x => x.id), [30]); assert.equal(mo.j.expert.userId, 3);
  const ma = await G(tok.masoud); assert.deepEqual(ma.j.items.map(x => x.id), [40, 41]); assert.equal(ma.j.items[0].priority, 3); assert.equal(ma.j.items[0].inScope, true);
  assert.ok(!ma.t.includes("K-PERSONAL"));
  assert.ok(!mo.j.items.some(x => [1, 2, 3, 40, 41, 50, 51].includes(x.id)));
  assert.ok(!ma.j.items.some(x => [1, 2, 3, 30, 50, 51].includes(x.id)));
  for (const r of [mo, ma, d]) assert.ok(!r.j.items.some(x => [50, 51].includes(x.id)));
  ok("scoping: own bound expert only; user params ignored; no cross-expert, no user 29 / trainee rows");

  if (tok.sarina) { const r = await G(tok.sarina); assert.equal(r.s, 403); assert.equal(r.j.error, "sales_only"); }
  if (tok.ahmad) { const r = await G(tok.ahmad); assert.ok([403, 423].includes(r.s)); }
  // a sales row bound to a trainee fails closed
  db.prepare("UPDATE assistants SET bound_salesperson_id=5, bound_user_id=6 WHERE slug='mohaddeseh'").run();
  const tr = await G(tok.mohaddeseh); assert.equal(tr.s, 403);
  db.prepare("UPDATE assistants SET bound_salesperson_id=4, bound_user_id=3 WHERE slug='mohaddeseh'").run();
  ok("filing / manager / trainee-bound → refused");

  const after = snap(); for (const t of Object.keys(before)) assert.equal(after[t], before[t], `table ${t} changed`);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM reminders ORDER BY id").all()), remBefore);
  const au = db.prepare("SELECT action, outcome FROM assistant_audit WHERE id > ? ").all(0).filter(x => x.action === "GET /reminders/schedule");
  assert.ok(au.length >= 1 && au.every(x => ["ok", "sales_only"].includes(x.outcome)));
  assert.ok(db.prepare("SELECT COUNT(*) n FROM assistant_audit").get().n > auditBefore);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { const r = await call(m, "/api/assistant-runner/reminders/schedule", {}, null, tok.somayeh); assert.ok([403, 404, 405].includes(r.s), `${m} ${r.s}`); }
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM reminders ORDER BY id").all()), remBefore);
  ok("no writes: every table except the usual auth/audit bookkeeping unchanged; write verbs refused");
  console.log(`reminder-schedule fixture: ${passed} passed`);
} finally { srv.close(); }

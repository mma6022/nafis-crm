// Synthetic «دستیار هوشمند» fixture: in-memory DB only, no network, no SMS. Run: node scripts/run-bundled-fixture.mjs scripts/assistant-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createAssistants, ensureAssistantSchema, hashAssistantToken, hasBannedWord, inQuietHours } from "../src/lib/assistants.ts";
import { createSmartFiling, ensureSmartFilingSchema, hashRunnerToken } from "../src/lib/smart-filing.ts";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,description TEXT,created_at TEXT,salesperson_id INTEGER,priority INTEGER,status TEXT,national_code TEXT,
  first_name TEXT,last_name TEXT,father_name TEXT,birth_date_jalali TEXT,postal_code TEXT,address TEXT,city TEXT,email TEXT,merged_into_customer_id INTEGER);
CREATE TABLE call_logs(id INTEGER PRIMARY KEY,customer_id INTEGER,salesperson_id INTEGER,subject TEXT,customer_request TEXT,expert_notes TEXT,created_at TEXT);
CREATE TABLE reminders(id INTEGER PRIMARY KEY,user_id INTEGER,salesperson_id INTEGER,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,created_at TEXT,subject TEXT,customer_id INTEGER);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,plan_ids TEXT,requested_amount TEXT,approved_amount TEXT,duration_months INTEGER,requested_duration_months INTEGER,status TEXT,stage TEXT,deleted_at TEXT,created_at TEXT);
CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,requirement_key TEXT,label TEXT,mime_type TEXT,size_bytes INTEGER,storage_path TEXT,status TEXT);
CREATE TABLE customer_identity_documents(id INTEGER PRIMARY KEY,customer_id INTEGER,document_type TEXT,mime_type TEXT,size_bytes INTEGER,storage_path TEXT,is_latest INTEGER);
INSERT INTO salespersons VALUES(3,'حسنی'),(4,'قاسمی'),(5,'کارآموز۵'),(6,'کاظمی'),(19,'کارآموز۱۹'),(20,'کارآموز۲۰');
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(2,'s.hasani','حسنی','salesperson',3,1),(3,'m.ghasemi','قاسمی','salesperson',4,1),(4,'reg','ثبت','registrar',NULL,1),
  (6,'trainee5','کارآموز','salesperson',5,1),(8,'m.kazemi','کاظمی','salesperson',6,1),(27,'t19','کارآموز۱۹','salesperson',19,1),(29,'hasani','ادمین۲۹','admin',NULL,1),(30,'acc','حسابدار','accountant',NULL,1);
INSERT INTO loan_plans VALUES(7,'ترنم'),(8,'ترنم'),(21,'ترنم'),(3,'دیگر');
INSERT INTO customers(id,name,phone,description,created_at,salesperson_id,priority,status,national_code) VALUES
  (100,'مشتری حسنی P1','09121234567','کد ملی 0012345678','2026-10-01',3,1,'in_progress','0012345678'),
  (101,'مشتری حسنی P2','09120000001','','2026-10-01',3,2,'in_progress',NULL),
  (102,'حسنی انصرافی','09120000002','','2026-10-01',3,1,'cancelled',NULL),
  (110,'مشتری قاسمی','09120000003','','2026-10-01',4,1,'in_progress',NULL),
  (120,'مشتری کاظمی P3','09120000004','','2026-10-01',6,3,'in_progress',NULL),
  (121,'کاظمی ادغام','09120000005','','2026-10-01',6,3,'in_progress',NULL),
  (130,'مشتری کارآموز','09120000006','','2026-10-01',5,1,'in_progress',NULL),
  (140,'بدون کارشناس','09120000007','','2026-10-01',NULL,NULL,'in_progress',NULL),
  (150,'ثبت هوشمند کاظمی','09120000008','','2026-10-01',6,3,'in_progress',NULL),
  (151,'ثبت ازکی حسنی','09120000009','','2026-10-01',3,1,'in_progress',NULL);
UPDATE customers SET merged_into_customer_id=120 WHERE id=121;
INSERT INTO loan_applications(id,customer_id,plan_id,status,stage,created_at,requested_amount) VALUES(500,150,7,'reviewing','x','2026-10-02','300000000'),(501,151,8,'reviewing','funder_initial_approval','2026-10-02','1'),(502,120,3,'reviewing','funder_initial_approval','2026-10-02','1');
INSERT INTO call_logs VALUES(1,100,3,'تماس اول','درخواست','یادداشت 09121234567','2026-10-02');
INSERT INTO reminders(id,user_id,salesperson_id,message,remind_at,created_at,subject,customer_id) VALUES(1,2,3,'پیگیری','2026-10-30','2026-10-02','پیگیری',100);`);
ensureSmartFilingSchema(db);
db.exec("INSERT INTO smart_filing_jobs(application_id,customer_id,panel_id,plan_id,status,created_at,updated_at) VALUES(500,150,1,7,'waiting_human','x','x')");
db.exec(`CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL,customer_name TEXT NOT NULL,owner_id INTEGER,resource_type TEXT NOT NULL,
  resource_id INTEGER NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',permission TEXT NOT NULL,created_at TEXT NOT NULL,actor_key TEXT,recipient_user_id INTEGER);
CREATE TABLE site_notification_reads(user_id INTEGER NOT NULL,event_id INTEGER NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id));`);
const bellRows = () => db.prepare("SELECT * FROM site_notification_events WHERE resource_type='assistant' ORDER BY id").all();
ensureAssistantSchema(db); ensureAssistantSchema(db); // idempotent
const cookie = db.prepare("PRAGMA schema_version").get().schema_version;
ensureAssistantSchema(db);
assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, cookie, "second start must not bump schema_version");
const As = Object.fromEntries(db.prepare("SELECT * FROM assistants").all().map(a => [a.slug, a]));
assert.deepEqual(Object.keys(As).sort(), ["masoud", "mohaddeseh", "sarina", "somayeh"]);
assert.equal(As.somayeh.bound_user_id, 2); assert.equal(As.mohaddeseh.bound_user_id, 3); assert.equal(As.masoud.bound_user_id, 8);
assert.equal(As.sarina.bound_user_id, null); assert.equal(As.sarina.bound_role, "registrar");
assert.ok(Object.values(As).every(a => a.enabled === 0)); // seeded off
assert.equal(db.prepare("SELECT value FROM assistant_settings WHERE key='global_enabled'").get().value, "0");

let clock = new Date("2026-10-26T07:00:00Z"); // 10:30 Tehran
const users = { 1: "admin", 2: "salesperson", 3: "salesperson", 4: "registrar", 6: "salesperson", 8: "salesperson", 27: "salesperson", 29: "admin", 30: "accountant" };
const as = createAssistants({ db, now: () => clock, actor: res => { const id = Number(res.locals.uid); return users[id] ? { id, role: users[id], salespersonId: null, name: "x" } : null; } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asst-fx-"));
const sf = createSmartFiling({ db, env: () => ({}), filesRoot: path.join(tmp, "f"), docRoots: [], actor: () => null });
const app = express();
app.use("/api/smart-filing-runner", sf.runner);
app.use("/api/assistant-runner", as.runner);
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, as.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const call = async (method, p, body, user, bearer) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": String(user) } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const S = (u, m, p, b) => call(m, `/api${p}`, b, u);
const R = (tok, m, p, b) => call(m, `/api/assistant-runner${p}`, b, null, tok);
const snap = () => JSON.stringify(["customers", "call_logs", "reminders", "loan_applications", "users", "smart_filing_jobs"].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
let passed = 0; const ok = (name) => { passed++; console.log("ok", name); };
try {
  // pure helpers
  assert.ok(hasBannedWord("این سپرده است")); assert.ok(hasBannedWord("براورد")); assert.ok(hasBannedWord("برآورد")); assert.ok(hasBannedWord("سپ\u200cرده"));
  assert.ok(hasBannedWord("تخميني")); assert.ok(!hasBannedWord("سلام، با مشتری تماس بگیر"));
  assert.ok(inQuietHours(new Date("2026-10-26T17:00:00Z"))); assert.ok(inQuietHours(new Date("2026-10-26T04:30:00Z"))); assert.ok(!inQuietHours(new Date("2026-10-26T05:00:00Z")));
  ok("helpers");
  const before = snap();
  // admin-only
  assert.equal((await S(2, "GET", "/admin/assistants")).s, 403);
  assert.equal((await S(4, "GET", "/admin/assistants")).s, 403);
  assert.equal((await S(1, "GET", "/admin/assistants")).j.globalEnabled, false);
  ok("admin only");
  // tokens: admin issues (shown once), stored hashed
  const iss = {};
  for (const slug of ["somayeh", "mohaddeseh", "masoud", "sarina"]) {
    const r = await S(1, "POST", `/admin/assistants/${As[slug].id}/tokens`, { name: `${slug}-fx` }); assert.equal(r.s, 201); iss[slug] = r.j.token;
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM assistant_tokens").all()).includes(r.j.token));
    assert.equal(db.prepare("SELECT token_hash FROM assistant_tokens WHERE id=?").get(r.j.id).token_hash, hashAssistantToken(r.j.token));
  }
  assert.ok(!JSON.stringify((await S(1, "GET", "/admin/assistants")).j).includes(iss.masoud));
  ok("tokens hashed, shown once");
  // no token / bad token → 401; disabled → 423
  assert.equal((await R(null, "GET", "/me")).s, 401);
  assert.equal((await R("x".repeat(30), "GET", "/me")).s, 401);
  assert.equal((await R(iss.masoud, "GET", "/me")).s, 423); // all off
  assert.equal((await R(iss.masoud, "POST", "/messages", { kind: "alert", body: "x", customerId: 120 })).s, 423); assert.equal(bellRows().length, 0); // no bell while off
  await S(1, "POST", `/admin/assistants/${As.masoud.id}/enable`);
  assert.equal((await R(iss.masoud, "GET", "/me")).s, 423); // global still off
  assert.equal((await S(8, "GET", "/assistant/mine")).j.assistants.length, 0); // no avatar while global off
  await S(1, "PUT", "/admin/assistants/global", { enabled: true });
  for (const slug of ["somayeh", "mohaddeseh", "sarina"]) await S(1, "POST", `/admin/assistants/${As[slug].id}/enable`);
  const me = await R(iss.masoud, "GET", "/me"); assert.equal(me.s, 200); assert.equal(me.j.assistant.label, "دستیار مسعود"); assert.equal(me.j.assistant.expert.userId, 8);
  ok("401/423 + enable");
  // the existing smart-filing runner token still works and is not accepted here (and vice-versa)
  const oldTok = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO smart_filing_runner_tokens(name,token_hash,created_at) VALUES('sarina-runner-1',?,'now')").run(hashRunnerToken(oldTok));
  assert.equal((await call("GET", "/api/smart-filing-runner/my-jobs", null, null, oldTok)).s, 200);
  assert.equal((await R(oldTok, "GET", "/me")).s, 401);
  assert.equal((await call("GET", "/api/smart-filing-runner/my-jobs", null, null, iss.sarina)).s, 401);
  ok("smart-filing runner token separate and unchanged");
  // scope
  const ids = async (tok) => (await R(tok, "GET", "/customers?limit=200")).j.items.map(c => c.id).sort((a, b) => a - b);
  assert.deepEqual(await ids(iss.somayeh), [100, 151]); // own P1 only, not cancelled
  assert.deepEqual(await ids(iss.mohaddeseh), [110]);
  assert.deepEqual(await ids(iss.masoud), [120, 150]); // own, not merged
  assert.deepEqual(await ids(iss.sarina), [150, 151]); // registrar smart-filing cases only
  for (const [tok, id] of [[iss.somayeh, 101], [iss.somayeh, 110], [iss.somayeh, 102], [iss.masoud, 121], [iss.masoud, 130], [iss.masoud, 140], [iss.sarina, 120], [iss.sarina, 100], [iss.mohaddeseh, 99999]]) {
    assert.equal((await R(tok, "GET", `/customers/${id}`)).s, 404, `out of scope ${id}`);
    assert.equal((await R(tok, "GET", `/customers/${id}/calls`)).s, 404);
  }
  assert.ok(db.prepare("SELECT COUNT(*) n FROM assistant_audit WHERE outcome='not_in_scope'").get().n >= 9);
  const c100 = await R(iss.somayeh, "GET", "/customers/100"); assert.equal(c100.s, 200);
  const txt = JSON.stringify(c100.j); assert.ok(!txt.includes("09121234567") && !txt.includes("0012345678")); assert.ok(!/priority|salesperson|amount/i.test(txt));
  const calls = await R(iss.somayeh, "GET", "/customers/100/calls"); assert.ok(!JSON.stringify(calls.j).includes("09121234567"));
  assert.equal((await R(iss.somayeh, "GET", "/customers/100/reminders")).j.items.length, 1);
  const sar = await R(iss.sarina, "GET", "/customers/150"); assert.equal(sar.s, 200); assert.equal(sar.j.smartFilingJobs.length, 1); assert.ok(!/amount/i.test(JSON.stringify(sar.j)));
  ok("scope + masking");
  // blocked writes: priority / assignment / money / contracts / stage / sms / reminders
  for (const [m, p] of [["PUT", "/customers/100/priority"], ["POST", "/customers/100/assign"], ["PATCH", "/customers/100"], ["POST", "/customers/100/salesperson"], ["POST", "/customers/100/status"],
    ["POST", "/payments"], ["POST", "/payment-orders"], ["POST", "/wallets"], ["PUT", "/fees"], ["POST", "/contracts"], ["POST", "/loan-applications/500/stage"], ["POST", "/sms"], ["POST", "/customer-messages"], ["POST", "/reminders"], ["DELETE", "/customers/100"], ["POST", "/anything-else"]]) {
    const r = await R(iss.somayeh, m, p, { priority: 1, salespersonId: 6 }); assert.equal(r.s, 403, `${m} ${p}`);
  }
  assert.ok(db.prepare("SELECT COUNT(*) n FROM assistant_audit WHERE outcome='forbidden'").get().n >= 16);
  ok("blocked writes denied");
  // messages: masking, banned words, case binding, recipients, trainees
  const m1 = await R(iss.masoud, "POST", "/messages", { kind: "suggestion", body: "با مشتری 09120000004 تماس بگیر", customerId: 120, clientId: "c1" });
  assert.equal(m1.s, 201); assert.equal(m1.j.delivered, "now"); assert.ok(!m1.j.message.body.includes("09120000004"));
  assert.equal((await R(iss.masoud, "POST", "/messages", { kind: "suggestion", body: "x", customerId: 120, clientId: "c1" })).j.delivered, "duplicate");
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "برآورد وام شما", customerId: 120 })).s, 422);
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "سلام", customerId: 100 })).s, 404); // not his customer
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "سلام", userId: 2 })).s, 404); // not his expert
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "سلام", userId: 6 })).s, 404); // trainee
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "x".repeat(2001) })).s, 422);
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "بدون پرونده", userId: 4 })).s, 422); // case required
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 4, customerId: 150 })).s, 201); // registrar
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 1, customerId: 150 })).s, 201); // admin
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 8, customerId: 150 })).s, 201); // the case's own expert
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 2, customerId: 150 })).s, 404); // another expert
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 6, customerId: 150 })).s, 404); // trainee
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 29, customerId: 150 })).s, 404); // user 29
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 30, customerId: 150 })).s, 404); // other role
  assert.equal((await R(iss.sarina, "POST", "/messages", { body: "پرونده", userId: 4, customerId: 120 })).s, 404); // not a filing case
  ok("messages + Sarina binding");
  // v3 bell: one addressed row per case-bound line (masked), only for the thread's own user
  { const b = bellRows(); assert.deepEqual(b.map(r => [r.recipient_user_id, r.customer_id]), [[8, 120], [4, 150], [1, 150], [8, 150]]);
    assert.ok(b.every(r => r.kind === "assistant-message" && r.permission === "assistant.recipient" && r.actor_key.startsWith("assistant:")));
    assert.ok(!JSON.stringify(b).includes("09120000004")); assert.equal(b[0].title, "دستیار مسعود · پیشنهاد"); assert.equal(b[0].resource_id, m1.j.message.id);
    assert.ok(!b.some(r => [2, 6, 27, 29, 30].includes(r.recipient_user_id))); }
  assert.equal((await R(iss.masoud, "POST", "/messages", { body: "جواب چت", customerId: 120 })).s, 201); assert.equal(bellRows().length, 4); // sales chat reply stays in chat
  db.prepare("DELETE FROM assistant_messages WHERE body='جواب چت'").run();
  ok("bell rows: addressed, masked, role-scoped");
  // staff side: who sees what
  const mineK = await S(8, "GET", "/assistant/mine"); assert.deepEqual(mineK.j.assistants.map(a => a.slug).sort(), ["masoud", "sarina"]);
  assert.equal(mineK.j.assistants.find(a => a.slug === "masoud").online, true);
  for (const u of [6, 27, 29, 30]) assert.equal((await S(u, "GET", "/assistant/mine")).j.assistants.length, 0, `user ${u} sees nothing`);
  assert.deepEqual((await S(2, "GET", "/assistant/mine")).j.assistants.map(a => a.slug).sort(), ["sarina", "somayeh"]);
  assert.deepEqual((await S(4, "GET", "/assistant/mine")).j.assistants.map(a => a.slug), ["sarina"]);
  const tK = mineK.j.assistants.find(a => a.slug === "masoud").threadId;
  const tS = mineK.j.assistants.find(a => a.slug === "sarina").threadId;
  const tH = (await S(2, "GET", "/assistant/mine")).j.assistants.find(a => a.slug === "sarina").threadId;
  assert.equal((await S(2, "GET", `/assistant/threads/${tK}/messages`)).s, 404); // someone else's thread
  const hist = await S(8, "GET", `/assistant/threads/${tK}/messages`); assert.equal(hist.j.messages.length, 1); assert.equal(hist.j.messages[0].authorLabel, "دستیار مسعود");
  assert.equal((await S(8, "GET", `/assistant/threads/${tS}/messages`)).j.messages.length, 1);
  assert.equal((await S(2, "GET", `/assistant/threads/${tH}/messages`)).j.messages.length, 0);
  // case reassigned away from Kazemi → the Sarina message disappears from his thread
  db.prepare("UPDATE customers SET salesperson_id=4 WHERE id=150").run();
  assert.equal((await S(8, "GET", `/assistant/threads/${tS}/messages`)).j.messages.length, 0);
  db.prepare("UPDATE customers SET salesperson_id=6 WHERE id=150").run();
  ok("staff visibility");
  // user message → runner event (long-poll) → seen; actions
  const after0 = (await R(iss.masoud, "GET", "/events")).j.cursor;
  const waitP = R(iss.masoud, "GET", `/events?after=${after0}&wait=5`);
  await new Promise(r => setTimeout(r, 300));
  const um = await S(8, "POST", `/assistant/threads/${tK}/messages`, { body: "مشتری 120 رو بررسی کن", clientId: "u1" }); assert.equal(um.s, 201);
  const ev = await waitP; assert.equal(ev.s, 200); assert.equal(ev.j.events[0].type, "user_message"); assert.equal(ev.j.events[0].message.body, "مشتری 120 رو بررسی کن");
  const seen = await S(8, "GET", `/assistant/threads/${tK}/messages?after=999`); assert.equal(seen.j.userSeen[0].seen, true);
  assert.equal((await R(iss.masoud, "POST", "/events/ack", { upTo: ev.j.cursor })).s, 200);
  assert.equal((await R(iss.masoud, "POST", "/events/ack", { upTo: 99999 })).s, 422);
  assert.equal((await S(8, "POST", `/assistant/messages/${m1.j.message.id}/action`, { action: "later" })).s, 200);
  assert.equal((await S(2, "POST", `/assistant/messages/${m1.j.message.id}/action`, { action: "call" })).s, 404);
  const ev2 = await R(iss.masoud, "GET", `/events?after=${ev.j.cursor}`); assert.equal(ev2.j.events[0].type, "message_action"); assert.equal(ev2.j.events[0].action, "later");
  // call_logged on in-scope customer only
  db.exec("INSERT INTO call_logs(id,customer_id,salesperson_id,subject,created_at) VALUES(2,120,6,'تماس','x'),(3,100,3,'تماس','x')");
  const ev3 = await R(iss.masoud, "GET", `/events?after=${ev2.j.cursor}`); assert.deepEqual(ev3.j.events.map(e => [e.type, e.customerId]), [["call_logged", 120]]);
  { const ev8 = bellRows().find(r => r.resource_id === m1.j.message.id);
    assert.equal((await S(8, "POST", `/assistant/threads/${tK}/read`, { upTo: m1.j.message.id })).s, 200);
    assert.ok(db.prepare("SELECT 1 FROM site_notification_reads WHERE user_id=8 AND event_id=?").get(ev8.id), "reading the chat marks its bell row read");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM site_notification_reads WHERE user_id<>8").get().n, 0); }
  ok("events long-poll + ack + seen");
  // typing
  assert.equal((await R(iss.masoud, "POST", "/typing", { threadId: tK, seconds: 10 })).s, 200);
  assert.equal((await S(8, "GET", `/assistant/threads/${tK}/messages?after=999`)).j.typing, true);
  assert.equal((await R(iss.masoud, "POST", "/typing", { threadId: tH, seconds: 10 })).s, 404); // not his thread
  ok("typing");
  // rate limit / digest / high cap / DND
  await S(1, "PUT", `/admin/assistants/${As.mohaddeseh.id}`, { maxMessagesPerHour: 2 });
  const G = (b) => R(iss.mohaddeseh, "POST", "/messages", { body: "سلام", ...b });
  assert.equal((await G({})).j.delivered, "now"); assert.equal((await G({})).j.delivered, "now"); assert.equal((await G({})).j.delivered, "digest");
  for (let i = 0; i < 3; i++) assert.equal((await G({ priority: "high" })).j.delivered, "now");
  assert.equal((await G({ priority: "high" })).s, 429);
  clock = new Date(clock.getTime() + 61 * 60_000);
  assert.equal((await G({})).j.delivered, "now");
  await S(3, "PUT", "/assistant/prefs", { dndMinutes: 30 });
  assert.equal((await G({})).j.delivered, "held_dnd");
  await S(3, "PUT", "/assistant/prefs", { dndMinutes: 0 });
  assert.equal((await G({ kind: "alert" })).j.delivered, "digest"); // cap 2 reached (now + held)
  const nf = await R(iss.mohaddeseh, "POST", "/notifications", { body: "یادآوری", priority: "high", customerId: 110 }); assert.equal(nf.s, 201); assert.equal(nf.j.message.kind, "alert");
  { const b = bellRows().filter(r => r.recipient_user_id === 3); assert.deepEqual(b.map(r => [r.customer_id, r.title]), [[110, "دستیار محدثه · هشدار · فوری"]]); } // case-less + digested → no bell
  ok("rate limit/digest/DND");
  // notes are the only customer-bound write, audited as «دستیار …»
  assert.equal((await R(iss.masoud, "POST", "/customers/120/assistant-notes", { body: "پیگیری فردا" })).s, 201);
  assert.equal((await R(iss.masoud, "POST", "/customers/100/assistant-notes", { body: "x" })).s, 404);
  assert.equal((await R(iss.masoud, "POST", "/customers/120/assistant-notes", { body: "مبلغ سپرده" })).s, 422);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM assistant_audit WHERE actor_label='دستیار مسعود' AND outcome='ok'").get().n >= 3);
  assert.ok(!JSON.stringify(db.prepare("SELECT detail_json FROM assistant_audit").all()).includes("پیگیری فردا")); // text length only
  ok("notes + audit");
  // reminder proposals: suggestion only; the expert's click saves via the existing reminders API
  {
    const remBefore = db.prepare("SELECT COUNT(*) n FROM reminders").get().n;
    const future = new Date(clock.getTime() + 86400_000).toISOString();
    assert.equal((await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 110, remindAt: future, note: "x" })).s, 404); // other expert
    assert.equal((await R(iss.somayeh, "POST", "/reminder-proposals", { remindAt: future })).s, 422);
    assert.equal((await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 100, remindAt: "2020-01-01T00:00:00Z" })).s, 422);
    assert.equal((await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 100, remindAt: new Date(clock.getTime() + 40 * 86400_000).toISOString() })).s, 422);
    assert.equal((await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 100, remindAt: future, note: "سپرده" })).s, 422);
    const pr = await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 100, remindAt: future, note: "پیگیری مدارک", reason: "فردا ساعت ۱۰ پیگیری مدارک؟" });
    assert.equal(pr.s, 201); assert.equal(pr.j.message.kind, "reminder_proposal"); assert.equal(pr.j.message.proposal.status, "pending");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders").get().n, remBefore, "assistant never creates a reminder");
    const pid = pr.j.message.proposal.id;
    const th = (await S(2, "GET", "/assistant/mine")).j.assistants.find(a => a.slug === "somayeh");
    assert.ok(th);
    assert.equal((await S(3, "POST", `/assistant/reminder-proposals/${pid}/decide`, { accept: false })).s, 404); // not the owner
    assert.equal((await S(2, "POST", `/assistant/reminder-proposals/${pid}/decide`, { accept: true })).s, 422); // no reminder saved
    // someone else's reminder can't be linked
    db.prepare("INSERT INTO reminders(id,user_id,salesperson_id,message,remind_at,created_at,subject,customer_id) VALUES(900,3,4,'x',?,?,'x',100)").run(future, clock.toISOString());
    assert.equal((await S(2, "POST", `/assistant/reminder-proposals/${pid}/decide`, { accept: true, reminderId: 900 })).s, 422);
    // the expert's own click → existing POST /api/reminders (simulated row) → link
    db.prepare("INSERT INTO reminders(id,user_id,salesperson_id,message,remind_at,created_at,subject,customer_id) VALUES(901,2,3,'پیگیری مدارک',?,?,'پیگیری مدارک',100)").run(future, clock.toISOString());
    const dec = await S(2, "POST", `/assistant/reminder-proposals/${pid}/decide`, { accept: true, reminderId: 901 });
    assert.equal(dec.s, 200); assert.equal(dec.j.proposal.status, "accepted"); assert.equal(dec.j.proposal.reminderId, 901);
    assert.equal((await S(2, "POST", `/assistant/reminder-proposals/${pid}/decide`, { accept: false })).s, 409);
    const pr2 = await R(iss.somayeh, "POST", "/reminder-proposals", { customerId: 100, remindAt: future });
    assert.equal((await S(2, "POST", `/assistant/reminder-proposals/${pr2.j.message.proposal.id}/decide`, { accept: true, reminderId: 901 })).s, 409); // already linked
    assert.equal((await S(2, "POST", `/assistant/reminder-proposals/${pr2.j.message.proposal.id}/decide`, { accept: false })).j.proposal.status, "rejected");
    const ev = await R(iss.somayeh, "GET", "/events?after=0&wait=0");
    assert.ok(ev.j.events.some(e => e.type === "suggestion_action" && e.proposalId === pid && e.accepted === true));
    db.exec("DELETE FROM reminders WHERE id IN (900,901)");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reminders").get().n, remBefore);
    // credit-inquiry permission setting: default manager, admin-only change
    assert.equal((await S(2, "GET", "/assistant/settings")).j.creditInquiryPermission, "manager");
    assert.equal((await S(2, "PUT", "/admin/assistants/settings", { creditInquiryPermission: "expert" })).s, 403);
    assert.equal((await S(1, "PUT", "/admin/assistants/settings", { creditInquiryPermission: "bad" })).s, 422);
    assert.equal((await S(1, "PUT", "/admin/assistants/settings", { creditInquiryPermission: "expert" })).s, 200);
    assert.equal((await S(1, "GET", "/admin/assistants")).j.creditInquiryPermission, "expert");
    await S(1, "PUT", "/admin/assistants/settings", { creditInquiryPermission: "manager" });
  }
  ok("reminder proposals (one-click, never auto) + credit-inquiry setting");
  // revoke mid long-poll → 401; disable → 423
  const tokRow = db.prepare("SELECT id FROM assistant_tokens WHERE token_hash=?").get(hashAssistantToken(iss.somayeh));
  const lp = R(iss.somayeh, "GET", "/events?after=999999&wait=6");
  await new Promise(r => setTimeout(r, 400));
  await S(1, "POST", `/admin/assistant-tokens/${tokRow.id}/revoke`);
  const t0 = Date.now(); const lpr = await lp; assert.equal(lpr.s, 401); assert.ok(Date.now() - t0 < 4000);
  assert.equal((await R(iss.somayeh, "GET", "/me")).s, 401);
  await S(1, "POST", `/admin/assistants/${As.masoud.id}/disable`);
  assert.equal((await R(iss.masoud, "GET", "/me")).s, 423);
  assert.equal((await S(8, "GET", "/assistant/mine")).j.assistants.map(a => a.slug).join(), "sarina");
  await S(1, "PUT", "/admin/assistants/global", { enabled: false });
  assert.equal((await R(iss.sarina, "GET", "/me")).s, 423);
  assert.equal((await S(4, "GET", "/assistant/mine")).j.assistants.length, 0);
  ok("revoke mid-poll + disable + global off");
  // per-IP failure limiter
  for (let i = 0; i < 20; i++) await R("y".repeat(30), "GET", "/me");
  assert.equal((await R("y".repeat(30), "GET", "/me")).s, 429);
  ok("429 limiter");
  // body limit
  const big = await fetch(`http://127.0.0.1:${port}/api/assistant-runner/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${iss.sarina}` }, body: JSON.stringify({ body: "x".repeat(300_000) }) });
  assert.ok([413, 429].includes(big.status));
  // core CRM tables untouched (calls inserted by the fixture itself excepted)
  db.exec("DELETE FROM call_logs WHERE id IN (2,3)");
  assert.equal(snap(), before, "no CRM table changed by assistant traffic");
  const audit = await S(1, "GET", "/admin/assistant-audit?limit=5"); assert.equal(audit.s, 200); assert.equal((await S(8, "GET", "/admin/assistant-audit")).s, 403);
  ok("CRM tables unchanged + audit view");
  console.log(`assistant fixture: ${passed} groups passed`);
} finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

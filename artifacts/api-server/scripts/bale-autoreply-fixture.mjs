// «پاسخ خودکار دستیارها در بله» pilot core fixture: in-memory DB + MOCK sidecar on loopback. Never talks to Bale, never sends SMS.
// Run: node scripts/run-bundled-fixture.mjs scripts/bale-autoreply-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createBale, ensureBaleSchema } from "../src/lib/bale.ts";
import { createHttpBaleSidecar } from "../src/lib/bale-sidecar-client.ts";
import { arEscalation, arVoice, arInDay, AR_DEFAULT_SETTINGS } from "../src/lib/bale-autoreply.ts";
import { startMockBaleSidecar } from "./bale-mock-sidecar.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bale-ar-"));
const wfile = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c, { mode: 0o600 }); return p; };
const KEY1 = wfile("k1", crypto.randomBytes(32).toString("base64"));
const sidecarToken = crypto.randomBytes(32).toString("base64url"); const TOK = wfile("tok", sidecarToken);
const mock = await startMockBaleSidecar({ token: sidecarToken });
const WAKE_KEY = "wake-" + crypto.randomBytes(12).toString("hex");
let ENV = { BALE_SESSION_KEY_FILE: KEY1, BALE_SIDECAR_TOKEN_FILE: TOK, BALE_SIDECAR_URL: `http://127.0.0.1:${mock.port}` };

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(2,'s.hasani','حسنی','salesperson',3,1),(3,'m.ghasemi','قاسمی','salesperson',4,1),
  (6,'trainee5','کارآموز','salesperson',5,1),(8,'m.kazemi','کاظمی','salesperson',6,1),(27,'t19','کارآموز۱۹','salesperson',19,1),(28,'t20','کارآموز۲۰','salesperson',20,1),
  (29,'hasani','ادمین۲۹','admin',NULL,1);
INSERT INTO customers VALUES(200,'مشتری کاظمی','09121110001',6,NULL),(201,'ادغام کاظمی','09121110002',6,200),(202,'کاظمی دوم','09121110003',6,NULL),
  (203,'کاظمی سوم','09121110004',6,NULL),(204,'کاظمی چهارم','09121110005',6,NULL),(205,'کاظمی پنجم','09121110006',6,NULL),(206,'کاظمی ششم','09121110007',6,NULL),
  (210,'مشتری حسنی','09122220001',3,NULL),(220,'مشتری قاسمی','09123330001',4,NULL),(230,'مشتری کارآموز','09124440001',5,NULL);
CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,salesperson_id INTEGER,customer_id INTEGER,subject TEXT,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,notified_at TEXT,call_id INTEGER,created_at TEXT);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,customer_name TEXT,owner_id INTEGER,resource_type TEXT,resource_id INTEGER,kind TEXT,title TEXT,body TEXT,permission TEXT,created_at TEXT,actor_key TEXT,recipient_user_id INTEGER);
CREATE TABLE assistants(id INTEGER PRIMARY KEY,slug TEXT,display_name TEXT,kind TEXT,bound_user_id INTEGER,bound_salesperson_id INTEGER,enabled INTEGER);
CREATE TABLE assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,type TEXT,thread_id INTEGER,user_id INTEGER,customer_id INTEGER,message_id INTEGER,data_json TEXT,created_at TEXT);
CREATE TABLE assistant_threads(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,user_id INTEGER);
CREATE TABLE assistant_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER,author TEXT,body TEXT,created_at TEXT);
CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,active INTEGER DEFAULT 1);
INSERT INTO loan_plans VALUES(7,'ترنم',1);
CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,deleted_at TEXT,amount INTEGER,national_code TEXT);
CREATE TABLE loan_application_documents(id INTEGER PRIMARY KEY,application_id INTEGER,label TEXT,status TEXT,file_path TEXT,note TEXT);
INSERT INTO loan_applications VALUES(1,200,NULL,500000000,'0012345678'),(2,210,NULL,1,'x');
INSERT INTO loan_application_documents VALUES(1,1,'فیش حقوقی','approved','/data/secret/1.pdf','یادداشت داخلی'),(2,1,'گواهی کسر از حقوق','pending','/data/secret/2.pdf',NULL),(3,2,'مدرک حسنی','uploaded','/x',NULL);
INSERT INTO assistants VALUES(10,'masoud','مسعود','sales',8,6,1),(11,'somayeh','سمیه','sales',2,3,1),(12,'mohaddeseh','محدثه','sales',3,4,1),
  (13,'sales-t5','کارآموزیار','sales',6,5,1),(14,'sarina','سارینا','filing',NULL,NULL,1),(15,'sales-29','دستیار۲۹','sales',29,NULL,1);`);
ensureBaleSchema(db); ensureBaleSchema(db);

let clock = new Date("2026-10-26T07:00:00Z"); // Monday 10:30 Tehran
const T = s => new Date(s);
const wakeCalls = []; const wakeLog = []; let wakeStatus = [500, 500, 200];
const sidecar = createHttpBaleSidecar(() => ENV, { timeoutMs: 3000 });
const bale = createBale({ db, env: () => ENV, sidecar, now: () => clock, random: () => 0.5, actor: res => (res.locals.uid ? { id: res.locals.uid } : null),
  planFilesDir: path.join(tmp, "data", "bale-plan-files"),
  arWake: { fetchImpl: async (url, init) => { wakeCalls.push({ url, init }); const s = wakeStatus.shift() ?? 200; return { ok: s < 300, status: s }; }, sleep: async () => {}, log: (m, d) => wakeLog.push(m + " " + JSON.stringify(d)) } });
const app = express();
app.use(bale.internal);
// Runner scope mirrors routes/assistants.ts scopeSql for sales assistants: own bound salesperson, not merged, never trainees (5/19/20).
const TRAINEE_SP = new Set([5, 19, 20]);
const inScope = (a, cid) => { const c = db.prepare("SELECT * FROM customers WHERE id=?").get(cid); return Boolean(c && c.merged_into_customer_id == null && !TRAINEE_SP.has(a.bound_salesperson_id) && c.salesperson_id === a.bound_salesperson_id); };
const runner = express.Router();
runner.use(express.json(), (req, res, next) => { res.locals.assistant = db.prepare("SELECT * FROM assistants WHERE id=?").get(Number(req.headers["x-asst"])); next(); });
runner.post("/bale/auto-reply", (req, res) => bale.runnerAutoReply(req, res, { inScope }));
runner.get("/bale/auto-reply/state", (req, res) => bale.runnerAutoReplyState(req, res));
runner.get("/bale/conversations/:customerId/messages", (req, res) => bale.runnerConversation(req, res, { inScope }));
runner.get("/bale/ar-chats", (req, res) => bale.runnerArChats(req, res));
runner.get("/bale/ar-chats/:id/messages", (req, res) => bale.runnerArChats(req, res));
runner.get("/customers/:id/documents", (req, res) => bale.runnerDocuments(req, res, { inScope }));
app.use("/runner", runner);
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, bale.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const API = `http://127.0.0.1:${port}`;
const J = async r => { const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
const S = async (u, method, p, body) => J(await fetch(`${API}/api${p}`, { method, headers: { "content-type": "application/json", ...(u ? { "x-user": String(u) } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const R = async (asst, method, p, body) => J(await fetch(`${API}/runner${p}`, { method, headers: { "content-type": "application/json", "x-asst": String(asst) }, body: body ? JSON.stringify(body) : undefined }));
const one = (sql, ...p) => db.prepare(sql).get(...p); const all = (sql, ...p) => db.prepare(sql).all(...p);
const acc = uid => one("SELECT * FROM bale_accounts WHERE user_id=?", uid);
const pair = slug => one("SELECT * FROM bale_autoreply_pairs WHERE slug=?", slug);
const autoAll = cid => all("SELECT * FROM bale_outbox WHERE customer_id=? AND source='auto_reply' ORDER BY id", cid);
const autoRows = cid => autoAll(cid).filter(x => x.status !== "blocked"); // refused attempts are kept as 'blocked' (never sendable)
const bells = (uid, kind) => one("SELECT count(*) n FROM site_notification_events WHERE recipient_user_id=? AND kind=?", uid, kind).n;
let mseq = 0; const PH = { 200: "09121110001", 202: "09121110003", 203: "09121110004", 204: "09121110005", 205: "09121110006", 206: "09121110007", 210: "09122220001" };
const inb = (ref, cid, text, extra = {}) => mock.inbound(API, ref, [{ messageId: `m-${++mseq}`, peerId: mock.peerOf(PH[cid]), peerPhone: PH[cid], text, date: clock.getTime(), ...extra }]);
const gapReset = () => db.prepare("UPDATE bale_accounts SET next_send_at=NULL").run();
const tick = async () => { gapReset(); return bale.worker ? bale.worker.tick() : bale._internal.outbox.tick(); };
const sent = () => mock.sent.length;
let passed = 0; const ok = n => { passed++; console.log("ok", n); };
const ON = { enabled: true, confirm: "روشن" };

try {
  // ---------- pure helpers ----------
  assert.equal(arEscalation("سلام وقت بخیر"), null);
  assert.equal(arEscalation("تضمین می‌کنید وام جور بشه؟"), "promise");
  assert.equal(arEscalation("قسط ماهانه ۵ میلیون تومان است"), "amount");
  assert.equal(arEscalation("تا ۱۴۰۵/۰۸/۱۰ واریز میشه"), "date");
  assert.equal(arEscalation("ازتون شکایت می‌کنم، کلاهبردارید"), "anger");
  assert.deepEqual(arVoice("مدارک رسید، بررسی می‌کنم.\nمسعود"), { text: "مدارک رسید، بررسی می‌کنم.", problem: null });
  assert.equal(arVoice("من دستیار کاظمی هستم").problem, "signature");
  assert.equal(arVoice("این یک پاسخ خودکار است").problem, "signature");
  assert.ok(arInDay(T("2026-10-26T05:00:00Z"), "08:30", "20:00", "0,1,2,3,4,5"), "Mon 08:30 Tehran open");
  assert.ok(!arInDay(T("2026-10-26T04:59:00Z"), "08:30", "20:00", "0,1,2,3,4,5"), "Mon 08:29 closed");
  assert.ok(!arInDay(T("2026-10-26T16:30:00Z"), "08:30", "20:00", "0,1,2,3,4,5"), "Mon 20:00 closed");
  assert.ok(!arInDay(T("2026-10-30T07:00:00Z"), "08:30", "20:00", "0,1,2,3,4,5"), "Friday closed");
  assert.ok(arInDay(T("2026-10-31T07:00:00Z"), "08:30", "20:00", "0,1,2,3,4,5"), "Saturday open");
  assert.ok(!arInDay(T("2026-10-31T07:00:00Z"), "08:30", "20:00", "0,1,2,3,4,5", JSON.stringify([{ date: "2026-10-31", label: "تعطیل رسمی" }])), "official holiday closed");
  assert.ok(arInDay(T("2026-11-01T07:00:00Z"), "08:30", "20:00", "0,1,2,3,4,5", JSON.stringify([{ date: "2026-10-31", label: "x" }])), "day after holiday open");
  ok("helpers: escalation words (promise / amount / date / anger), expert voice (signature stripped, bot mention refused), hours Sat–Thu 08:30–20:00, Friday closed");

  // ---------- defaults: everything OFF ----------
  const ps = all("SELECT * FROM bale_autoreply_pairs ORDER BY assistant_id");
  assert.deepEqual(ps.map(p => [p.slug, p.expert_user_id, p.enabled, p.reads_enabled, p.allow_unknown, p.allow_plan_file]),
    [["masoud", 8, 0, 0, 0, 0], ["somayeh", 2, 0, 0, 0, 0], ["mohaddeseh", 3, 0, 0, 0, 0]], "3 pairs, all OFF; no pair for trainees / 29 / filing");
  assert.equal(one("SELECT value FROM bale_settings WHERE key='autoreply_enabled'").value, "0");
  for (const k of Object.keys(AR_DEFAULT_SETTINGS)) assert.equal(one("SELECT value FROM bale_settings WHERE key=?", k).value, AR_DEFAULT_SETTINGS[k]);
  assert.equal(AR_DEFAULT_SETTINGS.autoreply_day_start, "08:30"); assert.equal(AR_DEFAULT_SETTINGS.autoreply_day_end, "20:00");
  let r = await S(1, "GET", "/admin/bale/autoreply"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.settings.globalEnabled, false); assert.equal(r.j.pairs.length, 3);
  assert.ok(r.j.pairs.every(p => p.enabled === false && p.label.endsWith("(خودکار)")));
  ensureBaleSchema(db); assert.equal(one("SELECT count(*) n FROM bale_autoreply_pairs").n, 3, "idempotent seed");
  ok("defaults: global switch 0, three pairs (Kazemi–Masoud, Hasani–Somayeh, Ghasemi–Mohaddeseh) all OFF, PM texts / hours as admin-editable settings");

  // ---------- connect Kazemi + Hasani (mock wizard), account modes stay off ----------
  r = await S(1, "PUT", "/admin/bale/master", { enabled: true }); assert.equal(r.s, 200, JSON.stringify(r.j));
  for (const [u, ph] of [[8, "09120000006"], [2, "09120000002"]]) {
    r = await S(u, "POST", "/bale/connect/start", { phone: ph }); assert.equal(r.s, 200, JSON.stringify(r.j));
    r = await S(u, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.account.mode, "off");
  }
  await bale._internal.outbox.syncSessions(true);
  const K = acc(8), H = acc(2); const KREF = `acc-${K.id}`, HREF = `acc-${H.id}`;
  assert.equal(K.mode, "off"); assert.equal(H.mode, "off");
  ok("setup: mock-connected Kazemi + Hasani, both account modes off");

  // ---------- OFF → nothing ----------
  r = await inb(KREF, 200, "سلام، مدارک رو فرستادم"); assert.equal(r.j.stored, 1);
  assert.equal(autoRows(200).length, 0);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام، رسید. بررسی می‌کنم." }); assert.equal(r.s, 423, JSON.stringify(r.j)); assert.equal(r.j.error, "autoreply_off");
  r = await R(10, "GET", "/bale/conversations/200/messages"); assert.equal(r.s, 423, "reads off by default");
  r = await R(10, "GET", "/bale/ar-chats"); assert.equal(r.s, 404, JSON.stringify(r.j));
  r = await inb(KREF, 200, "تضمین می‌کنید؟"); assert.equal(r.j.stored, 1);
  assert.deepEqual(autoAll(200).map(x => [x.status, x.block_reason, x.ar_kind]), [], "OFF: the refused runner attempt stores no outbox row; no hold text while OFF"); assert.equal(bells(8, "bale-escalated"), 0, "no escalation while OFF");
  r = await mock.inbound(API, KREF, [{ messageId: "u-off", peerId: "p-stranger", text: "سلام وام میخواستم" }]); assert.equal(r.j.stored, 0);
  assert.equal(one("SELECT count(*) n FROM bale_ar_messages").n, 0, "unknown chats not stored while OFF");
  const ev0 = one("SELECT data_json FROM assistant_events WHERE type='bale_inbound' ORDER BY id DESC LIMIT 1"); assert.ok(!JSON.parse(ev0.data_json).autoReply);
  await tick(); assert.equal(sent(), 0); assert.equal(wakeCalls.length, 0);
  ok("OFF: inbound stored as before, runner reply 423 autoreply_off, reads 423, no hold / night / escalation, unknown chats not stored, tick sends nothing, no wake");

  // ---------- who may switch ----------
  for (const u of [8, 2, 3, 6, 29]) { r = await S(u, "PUT", "/admin/bale/autoreply/pairs/10", ON); assert.equal(r.s, 403, `user ${u}`); }
  for (const u of [8, 2, 6, 29]) { r = await S(u, "PUT", "/admin/bale/autoreply/settings", { globalEnabled: true, confirm: "روشن" }); assert.equal(r.s, 403, `user ${u} global`); }
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { enabled: true }); assert.equal(r.s, 428, JSON.stringify(r.j));
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { globalEnabled: true }); assert.equal(r.s, 428, JSON.stringify(r.j));
  r = await S(8, "PUT", "/bale/me/autoreply", { enabled: true }); assert.equal(r.s, 403, JSON.stringify(r.j)); assert.equal(r.j.error, "admin_only");
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/11", { allowUnknown: true }); assert.equal(r.s, 422, "unknown numbers: masoud only");
  for (const k of ["readsEnabled", "allowPlanFile", "allowUnknown"]) { r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { [k]: true }); assert.equal(r.s, 428, `${k} needs «روشن»`); }
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/12", { readsEnabled: false }); assert.equal(r.s, 200, "turning OFF needs no confirm");
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { perHour: 99 }); assert.equal(r.s, 422, JSON.stringify(r.j));
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { holdText: "حتما وام شما جور میشه" }); assert.equal(r.s, 422, "hold text with a promise refused");
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { dayStart: "8:3x" }); assert.equal(r.s, 422, JSON.stringify(r.j));
  for (const u of [8, 29]) { r = await S(u, "PUT", "/admin/bale/autoreply/settings", { holidays: [] }); assert.equal(r.s, 403, `holidays user ${u}`); }
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { holidays: [{ date: "1405/08/10", label: "x" }] }); assert.equal(r.s, 422, JSON.stringify(r.j));
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { holidays: [{ date: "2026-11-05", label: "تاسوعا" }, { date: "2026-11-04", label: "x" }, { date: "2026-11-05", label: "dup" }] }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await S(1, "GET", "/admin/bale/autoreply"); assert.deepEqual(r.j.settings.holidays.map(h => h.date), ["2026-11-04", "2026-11-05"], "sorted, de-duplicated");
  assert.equal(r.j.settings.globalEnabled, false, "editing holidays never turns anything on"); assert.ok(r.j.settings.updatedBy);
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { holidays: [] }); assert.equal(r.s, 200);
  assert.equal(pair("masoud").enabled, 0);
  ok("switches: admin only (not 29 / experts / trainees), typed «روشن» confirm (428), expert may not turn ON, allowUnknown masoud only, limits, texts and holidays validated");

  // ---------- ON (Masoud only) — mode stays off, fully automatic ----------
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { globalEnabled: true, confirm: "روشن" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { ...ON, readsEnabled: true, allowUnknown: true, allowPlanFile: true }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.pair.enabled, true);
  assert.equal(acc(8).mode, "off", "turning the pair ON never touches the account mode");
  clock = new Date(clock.getTime() + 60_000);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "سلام، خوش آمدید" }); assert.equal(r.s, 422, JSON.stringify(r.j)); assert.equal(r.j.error, "not_a_reply", "never a first message");
  r = await inb(KREF, 202, "سلام، برای وام کارمندی چه مدارکی لازمه؟"); assert.equal(r.j.stored, 1);
  const evA = JSON.parse(one("SELECT data_json FROM assistant_events WHERE type='bale_inbound' AND customer_id=202 ORDER BY id DESC LIMIT 1").data_json); assert.equal(evA.autoReply, true);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "سلام، کارت ملی و فیش حقوقی رو بفرستید لطفاً.\nمسعود" }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "queued");
  const o1 = autoRows(202)[0]; assert.equal(o1.status, "queued"); assert.equal(o1.ar_kind, "reply"); assert.ok(o1.reply_to_msg_id > 0); assert.ok(!o1.text.includes("مسعود"), "signature stripped");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "یک پیام دیگر" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "already_replied", "once per customer message");
  const s0 = sent(); await tick(); assert.equal(sent(), s0 + 1); assert.equal(mock.sent.at(-1).text, o1.text);
  assert.equal(one("SELECT status FROM bale_outbox WHERE id=?", o1.id).status, "sent"); assert.equal(acc(8).mode, "off");
  r = await S(8, "GET", "/bale/customers/202/messages"); assert.equal(r.s, 200, JSON.stringify(r.j));
  const outMsg = r.j.messages.find(m => m.direction === "out"); assert.equal(outMsg.expertName, "مسعود (خودکار)"); assert.equal(outMsg.auto, true);
  assert.equal(r.j.autoReply.label, "مسعود (خودکار)"); assert.equal(r.j.autoReply.on, true);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "و یه چیز دیگه" }); assert.ok([409, 422].includes(r.s), "latest message is ours → no second send");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "من دستیار کاظمی هستم" }); assert.ok(r.s >= 400);
  ok("ON: fully automatic with account mode off (unchanged); reply-only (first message refused), one reply per customer message, signature stripped, history label «مسعود (خودکار)»");

  // ---------- voice ----------
  r = await inb(KREF, 202, "ممنون، کی بفرستم؟"); assert.equal(r.j.stored, 1);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "سلام، من دستیار هوشمند هستم و کمکتان می‌کنم" }); assert.equal(r.s, 422, JSON.stringify(r.j)); assert.equal(r.j.error, "signature");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "هر وقت آماده شد همین‌جا بفرستید." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await tick();
  ok("voice: replies are written as Kazemi — any mention of assistant / bot / automatic reply is refused, no signature");

  // ---------- escalation on inbound → hold text, owner = Kazemi, bell ----------
  r = await inb(KREF, 203, "سلام، تضمین می‌کنید که وام تا آخر ماه جور میشه؟"); assert.equal(r.j.stored, 1);
  let rows3 = autoRows(203); assert.equal(rows3.length, 1); assert.equal(rows3[0].ar_kind, "hold"); assert.equal(rows3[0].text, AR_DEFAULT_SETTINGS.autoreply_hold_text);
  assert.equal(bells(8, "bale-escalated"), 1);
  let own = one("SELECT ar_owner, ar_reason FROM bale_conversation_state WHERE customer_id=203"); assert.equal(own.ar_owner, "expert"); assert.match(own.ar_reason, /^escalated:promise:inbound/);
  const evE = JSON.parse(one("SELECT data_json FROM assistant_events WHERE type='bale_inbound' AND customer_id=203 ORDER BY id DESC LIMIT 1").data_json); assert.equal(evE.autoReply, false); assert.equal(evE.escalated, "promise");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 203, text: "بله حتماً" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "human_mode");
  await tick(); assert.equal(mock.sent.at(-1).text, AR_DEFAULT_SETTINGS.autoreply_hold_text, "holding text went out through the normal send path");
  r = await inb(KREF, 203, "پس چی شد؟"); assert.equal(autoRows(203).length, 1, "after escalation Masoud stays silent");
  ok("escalation (inbound): promise word → conversation to Kazemi, one holding text, bell, runner refused human_mode, wake skipped");

  // ---------- escalation on a draft ----------
  r = await inb(KREF, 204, "سلام، برای ۲۰۰ میلیون قسطش چقدر میشه؟"); assert.equal(r.j.stored, 1);
  assert.equal(autoRows(204).length, 1, "amount question → escalated on inbound already"); assert.equal(autoRows(204)[0].ar_kind, "hold");
  r = await inb(KREF, 205, "سلام، وقت بخیر"); assert.equal(r.j.stored, 1); assert.equal(autoRows(205).length, 0);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 205, text: "قسط شما ماهی ۵ میلیون تومان می‌شود" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "escalated");
  rows3 = autoRows(205).filter(x => x.status !== "blocked"); assert.equal(rows3.length, 1); assert.equal(rows3[0].ar_kind, "hold");
  assert.deepEqual(autoAll(205).filter(x => x.text.includes("میلیون")).map(x => [x.status, x.block_reason]), [["blocked", "escalated"]], "the draft is kept only as blocked (never sendable)");
  own = one("SELECT ar_owner, ar_reason FROM bale_conversation_state WHERE customer_id=205"); assert.equal(own.ar_owner, "expert"); assert.match(own.ar_reason, /^escalated:amount:draft/);
  await tick(); await tick();
  ok("escalation (draft): amount in Masoud's draft → refused, holding text instead, conversation to Kazemi, bell");

  // ---------- takeover / giveback ----------
  r = await inb(KREF, 200, "سلام دوباره، مدارک رو دیدید؟"); assert.equal(r.j.stored, 1);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام، دیدم؛ بررسی می‌کنم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  const pend = autoRows(200).at(-1); assert.equal(pend.status, "queued");
  for (const u of [2, 3]) { r = await S(u, "POST", "/bale/me/autoreply/customer/200/takeover"); assert.equal(r.s, 404, `user ${u} cannot take over Kazemi's customer`); }
  r = await S(8, "POST", "/bale/me/autoreply/customer/210/takeover"); assert.equal(r.s, 404, "not his customer");
  r = await S(8, "POST", "/bale/me/autoreply/customer/201/takeover"); assert.equal(r.s, 404, "merged customer");
  r = await S(8, "POST", "/bale/me/autoreply/customer/200/takeover"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.owner.owner, "expert"); assert.equal(r.j.cancelled, 1);
  assert.equal(one("SELECT status FROM bale_outbox WHERE id=?", pend.id).status, "cancelled");
  let s1 = sent(); await tick(); assert.equal(sent(), s1, "takeover: nothing sent " + JSON.stringify(mock.sent.slice(s1)));
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "human_mode");
  // send-time enforcement: a queued row whose conversation is taken over between enqueue and send is blocked
  r = await inb(KREF, 206, "سلام، طرح ترنم چیه؟"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, text: "سلام، توضیحش رو می‌فرستم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  // simulate the race (owner flips after enqueue, without the cancel step) — the send-time rule must still stop it
  db.prepare(`INSERT INTO bale_conversation_state(customer_id,account_id,mode,updated_at,ar_owner,ar_reason) VALUES(206,(SELECT id FROM bale_accounts WHERE user_id=8),'human',datetime('now'),'expert','expert_button')
    ON CONFLICT(customer_id,account_id) DO UPDATE SET ar_owner='expert', ar_reason='expert_button'`).run();
  s1 = sent(); await tick(); assert.equal(sent(), s1, JSON.stringify(mock.sent.slice(s1)) + JSON.stringify(all("SELECT id,customer_id,status,block_reason,ar_kind FROM bale_outbox ORDER BY id DESC LIMIT 4"))); assert.equal(autoAll(206).at(-1).block_reason, "human_mode");
  r = await S(8, "POST", "/bale/me/autoreply/customer/200/giveback"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.owner.owner, "assistant");
  clock = new Date(clock.getTime() + 60_000);
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 422, JSON.stringify(r.j)); assert.equal(r.j.error, "not_a_reply", "after giveback: only the customer's NEXT message");
  r = await inb(KREF, 200, "سلام، خبری شد؟"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام، هنوز در حال بررسیه." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  await tick();
  ok("takeover: «خودم جواب می‌دم» cancels pending auto rows, blocks at send time and at enqueue; own customers only (404 for others / merged); «برگردون به مسعود» answers only the next message");

  // ---------- Kazemi writes from the Bale app / CRM → his, no automatic return ----------
  r = await inb(KREF, 202, "باشه ممنون"); r = await inb(KREF, 202, "خودم جواب دادم از گوشی", { fromSelf: true });
  own = one("SELECT ar_owner, ar_reason FROM bale_conversation_state WHERE customer_id=202"); assert.equal(own.ar_owner, "expert"); assert.equal(own.ar_reason, "expert_app_reply");
  r = await inb(KREF, 202, "یه سوال دیگه"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "بفرمایید" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "human_mode");
  clock = new Date(clock.getTime() + 2 * 3_600_000); sentCheck: {
    r = await inb(KREF, 202, "هستید؟"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, text: "بله" }); assert.equal(r.j.error, "human_mode", "no automatic return, even hours later");
  }
  ok("Kazemi replied from the Bale app → conversation is his (expert_app_reply), Masoud silent with no automatic return");

  // ---------- caps ----------
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { perHour: 1 }); assert.equal(r.s, 200, JSON.stringify(r.j));
  clock = new Date(clock.getTime() + 2 * 3_600_000);
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id IN (203,204,205,206)").run();
  r = await inb(KREF, 206, "سلام، فایل طرح رو میفرستید؟"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, text: "سلام، الان می‌فرستم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await inb(KREF, 203, "سلام"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 203, text: "سلام، در خدمتم." }); assert.equal(r.s, 429, JSON.stringify(r.j)); assert.equal(r.j.error, "cap_pair_hour");
  await tick();
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { perHour: 10, perDay: 1 }); clock = new Date(clock.getTime() + 2 * 3_600_000);
  r = await inb(KREF, 204, "سلام"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 204, text: "سلام، در خدمتم." }); assert.equal(r.s, 429, JSON.stringify(r.j)); assert.equal(r.j.error, "cap_pair_day");
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { perDay: 40 });
  ok("caps: per-hour and per-day pair caps refuse (no queue) — admin-editable within 1–20 / 1–80");

  // ---------- backlog (24 h) ----------
  r = await inb(KREF, 205, "سلام، پیام قدیمی", { date: clock.getTime() - 25 * 3_600_000 });
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 205, text: "سلام" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "reply_window");
  own = one("SELECT ar_owner, ar_reason FROM bale_conversation_state WHERE customer_id=205"); assert.equal(own.ar_owner, "expert"); assert.equal(own.ar_reason, "stale_backlog");
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=204").run();
  db.prepare("INSERT INTO bale_messages(account_id,customer_id,direction,text,bale_msg_id,status,created_at) VALUES(?,?,'in','قدیمی','old-204','received',?)").run(K.id, 204, new Date(clock.getTime() - 30 * 3_600_000).toISOString());
  db.prepare("UPDATE bale_messages SET created_at=? WHERE customer_id=204 AND bale_msg_id<>'old-204'").run(new Date(clock.getTime() - 40 * 3_600_000).toISOString());
  assert.ok(bale._internal.outbox.autoreply.sweep(true) >= 1);
  assert.equal(one("SELECT ar_owner, ar_reason FROM bale_conversation_state WHERE customer_id=204").ar_reason, "stale_backlog");
  ok("backlog: only the latest unanswered message under 24 h is answered; older → Kazemi (runner refused + sweep hands it over with a bell)");

  // ---------- night text ----------
  clock = T("2026-10-27T17:30:00Z"); // Tue 21:00 Tehran
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=203").run();
  r = await inb(KREF, 203, "سلام، شب بخیر؛ مدارک رو فرستادم");
  let n3 = autoRows(203).filter(x => x.ar_kind === "night"); assert.equal(n3.length, 1); assert.equal(n3[0].text, AR_DEFAULT_SETTINGS.autoreply_night_text); assert.equal(n3[0].status, "queued");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 203, text: "سلام" }); assert.equal(r.s, 409, JSON.stringify(r.j)); assert.equal(r.j.error, "after_hours");
  s1 = sent(); await tick(); assert.equal(sent(), s1 + 1, "night text is not held by the quiet hours"); assert.equal(mock.sent.at(-1).text, AR_DEFAULT_SETTINGS.autoreply_night_text);
  clock = T("2026-10-27T19:30:00Z"); r = await inb(KREF, 203, "یه چیز دیگه هم بگم");
  assert.equal(autoRows(203).filter(x => x.ar_kind === "night").length, 1, "once per conversation per night");
  clock = T("2026-10-28T17:30:00Z"); r = await inb(KREF, 203, "شب بعد");
  assert.equal(autoRows(203).filter(x => x.ar_kind === "night").length, 2, "next night: one more");
  r = await inb(HREF, 210, "سلام شب بخیر"); assert.equal(r.j.stored, 1); assert.equal(autoRows(210).length, 0, "pair OFF (Somayeh) → no night text");
  r = await S(1, "PUT", "/admin/bale/autoreply/settings", { nightText: "سلام، رسید. فردا خبر می‌دم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  clock = T("2026-10-30T07:00:00Z"); // Friday 10:30 → closed
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=206").run();
  r = await inb(KREF, 206, "سلام، هستید؟"); n3 = autoRows(206).filter(x => x.ar_kind === "night"); assert.equal(n3.length, 1, JSON.stringify([autoAll(206).slice(-2), one("SELECT * FROM bale_conversation_state WHERE customer_id=206"), all("SELECT action,outcome,detail_json FROM bale_audit ORDER BY id DESC LIMIT 4")])); assert.equal(n3[0].text, "سلام، رسید. فردا خبر می‌دم.", "configurable");
  await tick(); await tick();
  ok("night: one after-hours text per conversation per closed window (Friday closed), configurable, runner refused after_hours, pair-only");

  // ---------- unknown numbers (Kazemi pair only) ----------
  clock = T("2026-10-31T07:00:00Z"); // Saturday 10:30
  r = await mock.inbound(API, KREF, [{ messageId: "u-1", peerId: "990011", text: "سلام، شماره‌تون رو از دوستم گرفتم، وام میدید؟", date: clock.getTime() }]); assert.equal(r.j.stored, 1);
  const chat = one("SELECT * FROM bale_ar_chats"); assert.equal(chat.peer_id, "990011");
  const chatCols = all("PRAGMA table_info(bale_ar_chats)").map(c => c.name).concat(all("PRAGMA table_info(bale_ar_messages)").map(c => c.name));
  assert.ok(!chatCols.some(c => /phone/.test(c)), "no phone column at all");
  const evU = one("SELECT * FROM assistant_events WHERE type='bale_inbound' ORDER BY id DESC LIMIT 1"); assert.equal(evU.assistant_id, 10); assert.equal(evU.customer_id, null);
  assert.equal(JSON.parse(evU.data_json).unknown, true);
  r = await R(10, "GET", "/bale/ar-chats"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.chats[0].label, "ناشناس");
  r = await R(10, "GET", `/bale/ar-chats/${chat.id}/messages`); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.messages.length, 1);
  assert.ok(!JSON.stringify(r.j).match(/09\d{9}|customerId|"name"|loan|case|national|stage/i), "no customer / case data " + JSON.stringify(r.j));
  r = await R(11, "GET", "/bale/ar-chats"); assert.equal(r.s, 404, "other pairs never see unknown chats");
  r = await R(10, "POST", "/bale/auto-reply", { arChatId: chat.id, text: "سلام، بله. اسم و شهرتون رو بفرمایید تا راهنمایی کنم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await R(10, "POST", "/bale/auto-reply", { arChatId: chat.id, text: "یک پیام دیگر" }); assert.equal(r.s, 409, JSON.stringify(r.j));
  s1 = sent(); await tick(); assert.equal(sent(), s1 + 1); const us = mock.sent.at(-1); assert.equal(us.phone, ""); assert.equal(us.peerId, "990011");
  r = await R(10, "POST", "/bale/auto-reply", { arChatId: 999, text: "x" }); assert.equal(r.s, 404, JSON.stringify(r.j));
  r = await mock.inbound(API, KREF, [{ messageId: "u-2", peerId: "990011", text: "سود وامتون ۲۳ درصده؟", date: clock.getTime() }]);
  assert.equal(one("SELECT owner FROM bale_ar_chats WHERE id=?", chat.id).owner, "expert", "unknown escalation → Kazemi");
  assert.equal(one("SELECT count(*) n FROM bale_ar_messages WHERE chat_id=? AND ar_kind='hold'", chat.id).n, 1);
  r = await S(8, "GET", "/bale/me/autoreply"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.ok(r.j.list.some(x => x.kind === "unknown" && x.label === "ناشناس" && x.name === null), JSON.stringify(r.j.list));
  r = await S(2, "GET", `/bale/me/autoreply/unknown/${chat.id}`); assert.equal(r.s, 404, "Hasani cannot read Kazemi's unknown chat");
  r = await S(2, "POST", `/bale/me/autoreply/unknown/${chat.id}/giveback`); assert.equal(r.s, 404, JSON.stringify(r.j));
  r = await S(1, "GET", `/admin/bale/autoreply/pairs/10/unknown/${chat.id}`); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.readOnly, true);
  assert.ok(!JSON.stringify(r.j).includes("990011") && r.j.messages.length >= 2, "admin unknown thread: text + label, no peer id / phone");
  for (const u of [8, 29]) { r = await S(u, "GET", `/admin/bale/autoreply/pairs/10/unknown/${chat.id}`); assert.equal(r.s, 403, `admin unknown thread user ${u}`); }
  r = await S(1, "GET", `/admin/bale/autoreply/pairs/11/unknown/${chat.id}`); assert.equal(r.s, 404, "other pair's account never resolves the chat");
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/11", { ...ON }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await mock.inbound(API, HREF, [{ messageId: "u-h1", peerId: "880011", text: "سلام" }]); assert.equal(r.j.stored, 0, "Somayeh pair: unknown numbers never stored");
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/11", { enabled: false });
  await tick();
  ok("unknown numbers: Kazemi pair only, text + Bale id (no phone column), label «ناشناس», generic reply via peerId, no customer data, escalation → Kazemi, isolated from other experts");

  // ---------- plan file: reply only, within caps ----------
  {
    const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% taranom plan\n"), crypto.randomBytes(3000), Buffer.from("\n%%EOF\n")]);
    const fd = new FormData(); fd.append("file", new Blob([PDF], { type: "application/pdf" }), "taranom.pdf");
    let u = await J(await fetch(`${API}/api/admin/bale/plans/7/file`, { method: "POST", headers: { "x-user": "1" }, body: fd })); assert.equal(u.s, 200, JSON.stringify(u.j));
    db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=206").run();
    r = await inb(KREF, 206, "سلام، فایل طرح ترنم رو بفرستید");
    r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, planId: 7, text: "فایل طرح ترنم" }); assert.equal(r.s, 423, JSON.stringify(r.j)); assert.equal(r.j.error, "plan_file_off", "attachments switch OFF");
    u = await S(1, "PUT", "/admin/bale/attachments", { enabled: true }); if (u.s === 404) u = await S(1, "PUT", "/admin/bale/attachments/enabled", { enabled: true });
    assert.equal(u.s, 200, JSON.stringify(u.j));
    r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, planId: 7, text: "فایل طرح ترنم" }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "queued", "auto plan file: never a draft");
    r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, planId: 7, text: "دوباره" }); assert.equal(r.s, 409, "one plan file per customer message");
    const f0 = mock.state.sentFiles.length; await tick(); assert.equal(mock.state.sentFiles.length, f0 + 1);
    r = await R(10, "POST", "/bale/auto-reply", { customerId: 202, planId: 7, text: "فایل" }); assert.equal(r.s, 409, "plan file needs a reply target (taken over)");
    r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", { allowPlanFile: false });
    r = await inb(KREF, 206, "یکی دیگه"); r = await R(10, "POST", "/bale/auto-reply", { customerId: 206, planId: 7, text: "فایل" }); assert.equal(r.s, 423, JSON.stringify(r.j));
    r = await S(1, "PUT", "/admin/bale/attachments", { enabled: false }); if (r.s === 404) await S(1, "PUT", "/admin/bale/attachments/enabled", { enabled: false });
  }
  ok("plan file: only as a reply, queued (no draft) through the existing plan-file path, once per message, needs both switches; contracts untouched");

  // ---------- pair isolation + lock + scope ----------
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 210, text: "سلام" }); assert.equal(r.s, 404, "Masoud → Hasani's customer");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 201, text: "سلام" }); assert.equal(r.s, 404, "merged");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 230, text: "سلام" }); assert.equal(r.s, 404, "trainee customer");
  r = await R(11, "POST", "/bale/auto-reply", { customerId: 210, text: "سلام" }); assert.equal(r.s, 423, JSON.stringify(r.j)); assert.equal(r.j.error, "autoreply_off", "Somayeh stays OFF while Masoud is ON");
  r = await R(11, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 423, JSON.stringify(r.j)); // Somayeh OFF: refused before scope
  r = await R(13, "POST", "/bale/auto-reply", { customerId: 230, text: "سلام" }); assert.equal(r.s, 404, "trainee assistant: no pair");
  r = await R(15, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 403, "user 29");
  r = await R(14, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 403, "filing assistant");
  db.prepare("UPDATE assistants SET bound_user_id=2 WHERE id=10").run();
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 404, "pair lock: Masoud rebound to another expert → nothing");
  db.prepare("UPDATE assistants SET bound_user_id=8 WHERE id=10").run();
  ok("pair isolation: each pair only its own expert's customers; Somayeh OFF independent; trainees / 29 / filing / rebound assistant refused");

  r = await R(10, "GET", "/bale/conversations/200/messages"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.ok(r.j.messages.length > 0);
  assert.ok(r.j.messages.some(m => m.by === "assistant") && r.j.messages.some(m => m.by === "customer"));
  for (const cid of [201, 210, 220, 230, 9999]) { r = await R(10, "GET", `/bale/conversations/${cid}/messages`); assert.equal(r.s, 404, `conv ${cid}`); r = await R(10, "GET", `/customers/${cid}/documents`); assert.equal(r.s, 404, `docs ${cid}`); }
  r = await R(10, "GET", "/customers/200/documents"); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.documents, [{ label: "فیش حقوقی", status: "تأیید شد" }, { label: "گواهی کسر از حقوق", status: "منتظر" }]);
  assert.ok(!JSON.stringify(r.j).match(/secret|یادداشت|0012345678|500000000/), "label + status only");
  r = await R(13, "GET", "/customers/230/documents"); assert.equal(r.s, 404, JSON.stringify(r.j)); r = await R(15, "GET", "/customers/200/documents"); assert.equal(r.s, 403, JSON.stringify(r.j));
  r = await R(11, "GET", "/customers/210/documents"); assert.equal(r.s, 423, "Somayeh reads OFF");
  assert.ok(one("SELECT count(*) n FROM bale_audit WHERE outcome='not_in_scope'").n > 0, "denials audited");
  r = await R(10, "GET", "/bale/auto-reply/state"); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.on, true); assert.ok(!JSON.stringify(r.j).match(/0912/));
  ok("scoped reads: Bale messages + documents (label / status only) for own customers; merged / other experts / trainees / unknown ids → 404; 29 → 403; audited");

  // ---------- wake webhook ----------
  assert.equal(wakeCalls.length, 0, "env unset → never called");
  ENV = { ...ENV, BALE_AUTOREPLY_WAKE_URL: "http://10.1.2.3/wake", BALE_AUTOREPLY_WAKE_KEY: WAKE_KEY };
  r = await inb(KREF, 200, "سلام، یه سوال"); await new Promise(r2 => setTimeout(r2, 20)); assert.equal(wakeCalls.length, 0, "non-loopback http refused");
  ENV = { ...ENV, BALE_AUTOREPLY_WAKE_URL: "https://runner.example/wake" };
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=200").run();
  r = await inb(KREF, 200, "سلام، یه سوال دیگه"); await new Promise(r2 => setTimeout(r2, 50));
  assert.equal(wakeCalls.length, 3, "retried 500, 500 → 200");
  const body = JSON.parse(wakeCalls[0].init.body); assert.deepEqual(Object.keys(body).sort(), ["eventId", "pair"]); assert.equal(body.pair, "masoud");
  assert.equal(wakeCalls[0].init.headers["x-autoreply-wake-key"], WAKE_KEY);
  assert.ok(wakeLog.length === 3 && wakeLog.every(l => !l.includes(WAKE_KEY) && !l.includes("runner.example") && !l.includes("سوال")), "logs: no key / URL / text");
  wakeStatus = [500, 500, 500, 500, 500]; const w = await bale._internal.outbox.autoreply.wake(1, "masoud"); assert.deepEqual(w, { ok: false, attempts: 4 });
  delete ENV.BALE_AUTOREPLY_WAKE_URL; delete ENV.BALE_AUTOREPLY_WAKE_KEY; ENV = { ...ENV };
  ok("wake webhook: unset → no call; https or loopback only; POST {eventId, pair} + key header; 4 tries with backoff; logs carry no key / URL / text");

  // ---------- auto-stop ----------
  db.prepare("UPDATE bale_conversation_state SET ar_owner='assistant', ar_reason=NULL WHERE customer_id=200").run();
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام، در خدمتم." }); assert.equal(r.s, 200, JSON.stringify(r.j));
  mock.state.sendError = "rate_limited"; await tick(); mock.state.sendError = null;
  assert.equal(pair("masoud").enabled, 0); assert.equal(pair("masoud").stopped_reason, "rate_limited"); assert.equal(acc(8).mode, "off");
  r = await R(10, "POST", "/bale/auto-reply", { customerId: 200, text: "سلام" }); assert.equal(r.s, 423, JSON.stringify(r.j));
  r = await S(1, "GET", "/admin/bale/autoreply"); assert.equal(r.j.pairs[0].stoppedReason, "rate_limited");
  ok("auto-stop: rate limit → Masoud pair OFF with the reason, account mode stays off, only an admin turns it back on");

  // ---------- expert OFF switch + final ----------
  r = await S(1, "PUT", "/admin/bale/autoreply/pairs/10", ON); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(pair("masoud").stopped_reason, null);
  r = await S(8, "PUT", "/bale/me/autoreply", { enabled: false }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(pair("masoud").enabled, 0);
  r = await S(2, "PUT", "/bale/me/autoreply", { enabled: false }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(pair("masoud").enabled, 0);
  r = await S(6, "GET", "/bale/me/autoreply"); assert.ok(r.s === 403 || r.j.paired === false);
  const blob = JSON.stringify(all("SELECT * FROM bale_audit")) + JSON.stringify(all("SELECT * FROM bale_ar_messages")) + JSON.stringify(all("SELECT data_json FROM assistant_events"));
  assert.ok(!blob.includes("09121110") && !blob.includes(WAKE_KEY), "no customer phone / wake key in audit, unknown chats or events");
  assert.equal(acc(8).mode, "off"); assert.equal(acc(2).mode, "off");
  ok("expert «خاموش» works (OFF only); no phones or secrets in audit / events / unknown chats; account modes never changed");

  console.log(`\nbale-autoreply-fixture: ${passed} groups passed`);
} finally {
  srv.close(); mock.srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
}

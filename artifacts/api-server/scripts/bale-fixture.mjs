// Synthetic «حساب شخصی بله» 1a + 1b fixture: in-memory DB + MOCK sidecar on loopback. Never talks to Bale, never sends SMS.
// Run: node scripts/run-bundled-fixture.mjs scripts/bale-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createBale, ensureBaleSchema, normalizeIranMobile, baleEligible, baleChatViewer } from "../src/lib/bale.ts";
import { createHttpBaleSidecar, isLoopbackUrl } from "../src/lib/bale-sidecar-client.ts";
import { sealBaleSession, openBaleSession, baleSessionAad } from "../src/lib/bale-crypto.ts";
import { inBaleQuiet, quietEndAfter, isLoanTypeQuestion, baleTextProblem, withAmountDisclaimer, BALE_AMOUNT_DISCLAIMER } from "../src/lib/bale-outbox.ts";
import { startMockBaleSidecar } from "./bale-mock-sidecar.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bale-fx-"));
const wfile = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c, { mode: 0o600 }); return p; };
const KEY1 = wfile("k1", crypto.randomBytes(32).toString("base64")); const KEY2 = wfile("k2", crypto.randomBytes(32).toString("hex"));
const sidecarToken = crypto.randomBytes(32).toString("base64url"); const TOK = wfile("tok", sidecarToken);
const mock = await startMockBaleSidecar({ token: sidecarToken });
let ENV = { BALE_SESSION_KEY_FILE: KEY1, BALE_SIDECAR_TOKEN_FILE: TOK, BALE_SIDECAR_URL: `http://127.0.0.1:${mock.port}` };

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(2,'s.hasani','حسنی','salesperson',3,1),(3,'m.ghasemi','قاسمی','salesperson',4,1),(4,'reg','ثبت','registrar',NULL,1),
  (6,'trainee5','کارآموز','salesperson',5,1),(8,'m.kazemi','کاظمی','salesperson',6,1),(27,'t19','کارآموز۱۹','salesperson',19,1),(28,'t20','کارآموز۲۰','salesperson',20,1),
  (29,'hasani','ادمین۲۹','admin',NULL,1),(30,'acc','حسابدار','accountant',NULL,1),(31,'old','غیرفعال','salesperson',7,0);
INSERT INTO customers VALUES(100,'مشتری حسنی','09120000001',3,NULL),(101,'ادغام حسنی','09120000002',3,100),(110,'مشتری قاسمی','09120000003',4,NULL),(130,'مشتری کارآموز','09120000004',5,NULL),
  (102,'مشتری تازه','09120000011',3,NULL),(103,'بدون بله','09990000008',3,NULL),(104,'بی‌شماره','',3,NULL),(105,'تازه دوم','+98 912 000 0015',3,NULL);
CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,salesperson_id INTEGER,customer_id INTEGER,subject TEXT,message TEXT,remind_at TEXT,sent_sms INTEGER DEFAULT 0,done INTEGER DEFAULT 0,notified_at TEXT,call_id INTEGER,created_at TEXT);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,customer_name TEXT,owner_id INTEGER,resource_type TEXT,resource_id INTEGER,kind TEXT,title TEXT,body TEXT,permission TEXT,created_at TEXT,actor_key TEXT,recipient_user_id INTEGER);
CREATE TABLE assistants(id INTEGER PRIMARY KEY,slug TEXT,display_name TEXT,kind TEXT,bound_user_id INTEGER,bound_salesperson_id INTEGER,enabled INTEGER);
CREATE TABLE assistant_events(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,type TEXT,thread_id INTEGER,user_id INTEGER,customer_id INTEGER,message_id INTEGER,data_json TEXT,created_at TEXT);
CREATE TABLE assistant_threads(id INTEGER PRIMARY KEY AUTOINCREMENT,assistant_id INTEGER,user_id INTEGER);
CREATE TABLE assistant_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id INTEGER,author TEXT,body TEXT,created_at TEXT);
INSERT INTO assistants VALUES(1,'sales-hasani','مریم','sales',2,3,1),(2,'sarina','سارینا','filing',NULL,NULL,1),(3,'sales-ghasemi','علی','sales',3,4,1);`);
ensureBaleSchema(db); ensureBaleSchema(db);
const cookie = db.prepare("PRAGMA schema_version").get().schema_version;
ensureBaleSchema(db);
assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, cookie, "second start must not bump schema_version");

let clock = new Date("2026-10-26T07:00:00Z");
const sidecar = createHttpBaleSidecar(() => ENV, { timeoutMs: 3000 });
const bale = createBale({ db, env: () => ENV, sidecar, now: () => clock, random: () => 0.5, actor: res => (res.locals.uid ? { id: res.locals.uid } : null) });
const app = express();
app.use(bale.internal);
const RUNNER_SCOPE = new Set([100, 102, 105, 110]);
app.post("/runner/bale/send", express.json(), (req, res) => {
  res.locals.assistant = db.prepare("SELECT * FROM assistants WHERE id=?").get(Number(req.headers["x-asst"]));
  bale.runnerSend(req, res, { inScope: (_a, cid) => RUNNER_SCOPE.has(cid) });
});
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, bale.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const S = async (u, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { "content-type": "application/json", ...(u ? { "x-user": String(u) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, cc: r.headers.get("cache-control") };
};
const acc = uid => db.prepare("SELECT * FROM bale_accounts WHERE user_id=?").get(uid);
let passed = 0; const ok = n => { passed++; console.log("ok", n); };
const SECRETS = new Set();
try {
  // helpers
  assert.equal(normalizeIranMobile("۰۹۱۲ ۱۲۳ ۴۵۶۷"), "09121234567"); assert.equal(normalizeIranMobile("+989121234567"), "09121234567");
  assert.equal(normalizeIranMobile("00989121234567"), "09121234567"); assert.equal(normalizeIranMobile("0912123"), null); assert.equal(normalizeIranMobile("02112345678"), null);
  assert.ok(isLoopbackUrl("http://127.0.0.1:18470")); assert.ok(!isLoopbackUrl("http://10.0.0.1:18470")); assert.ok(!isLoopbackUrl("https://127.0.0.1"));
  const U = id => db.prepare("SELECT * FROM users WHERE id=?").get(id);
  assert.deepEqual([1, 2, 3, 4, 6, 8, 27, 28, 29, 30, 31].filter(i => baleEligible(U(i))), [2, 3, 8]);
  assert.deepEqual([1, 2, 4, 6, 27, 28, 29, 30].map(i => baleChatViewer(U(i))), ["all", "own", null, null, null, null, null, null]);
  ok("helpers: phone normalize, loopback-only, eligibility (trainees 5/19/20, 29, registrar, inactive excluded)");

  // defaults
  assert.equal(db.prepare("SELECT value FROM bale_settings WHERE key='master_enabled'").get().value, "0");
  assert.equal(db.prepare("SELECT count(*) n FROM bale_accounts").get().n, 0);
  let r = await S(2, "GET", "/bale/me"); assert.equal(r.s, 200); assert.equal(r.j.masterEnabled, false); assert.equal(r.j.eligible, true); assert.equal(r.j.account, null);
  assert.equal(r.j.ready, true); assert.equal(r.cc, "no-store");
  r = await S(2, "POST", "/bale/connect/start", { phone: "09120000000" }); assert.equal(r.s, 423); assert.equal(r.j.error, "bale_disabled");
  assert.equal(mock.log.filter(l => l.path === "/v1/auth/start").length, 0, "master OFF → sidecar never called");
  ok("default OFF: master switch 0, no accounts, connect blocked with 423 before the sidecar");

  // who may switch / connect
  for (const u of [2, 4, 6, 29]) { r = await S(u, "PUT", "/admin/bale/master", { enabled: true }); assert.equal(r.s, 403, `user ${u} master`); }
  r = await S(1, "PUT", "/admin/bale/master", { enabled: true }); assert.equal(r.s, 200); assert.equal(r.j.masterEnabled, true);
  for (const u of [1, 4, 6, 27, 28, 29, 30, 31]) {
    r = await S(u, "POST", "/bale/connect/start", { phone: "09120000000" }); assert.equal(r.s, 403, `user ${u} start`); assert.equal(r.j.error, "not_eligible");
  }
  assert.equal(mock.log.filter(l => l.path === "/v1/auth/start").length, 0);
  r = await S(6, "GET", "/bale/me"); assert.equal(r.j.eligible, false);
  ok("only admin (not 29) flips the master switch; admin/registrar/trainees/29/inactive cannot connect");

  // happy path (code) for hasani
  r = await S(2, "POST", "/bale/connect/start", { phone: "abc" }); assert.equal(r.s, 422); assert.equal(r.j.error, "phone_invalid");
  r = await S(2, "POST", "/bale/connect/start", { phone: "۰۹۱۲۰۰۰۰۰۰۰" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.flow.step, "code"); assert.equal(r.j.flow.phoneMasked, "0912•••00"); assert.ok(!JSON.stringify(r.j).includes("09120000000"));
  const st1 = mock.log.findLast(l => l.path === "/v1/auth/start").body;
  assert.match(st1.deviceHash, /^[0-9a-f-]{36}$/); assert.ok(!st1.deviceHash.startsWith("ce5ced83")); assert.equal(st1.accountRef, "user-2");
  r = await S(2, "POST", "/bale/connect/code", { code: "12" }); assert.equal(r.s, 422); assert.equal(r.j.error, "bad_code");
  r = await S(2, "POST", "/bale/connect/code", { code: "00000" }); assert.equal(r.s, 422); assert.equal(r.j.error, "wrong_code");
  r = await S(2, "POST", "/bale/connect/password", { password: "x" }); assert.equal(r.s, 409);
  r = await S(3, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 410, "another expert cannot use hasani's flow");
  r = await S(2, "POST", "/bale/connect/code", { code: "۱۱۱۱۱" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.account.status, "connected"); assert.equal(r.j.account.mode, "off"); assert.equal(r.j.flow, null);
  const tok1 = mock.log.length; let a2 = acc(2);
  assert.match(a2.session_ct, /^v1:[0-9a-f]{8}:/); assert.equal(a2.device_hash, st1.deviceHash); assert.equal(a2.bale_user_id, "777000111");
  assert.ok(!JSON.stringify(r.j).includes("mock."), "token never returned");
  const plain = openBaleSession(ENV, a2.session_ct, baleSessionAad(a2.id, 2)).plaintext; assert.match(plain, /^mock\./); SECRETS.add(plain);
  assert.throws(() => openBaleSession(ENV, a2.session_ct, baleSessionAad(a2.id, 3)), "AAD binds the row");
  r = await S(2, "POST", "/bale/connect/start", { phone: "09120000000" }); assert.equal(r.s, 409); assert.equal(r.j.error, "already_connected");
  ok("wizard: phone → code (wrong code, cross-user flow refused) → connected; per-expert device id; token sealed, never returned; mode stays off");

  // 2FA path for ghasemi + 3/h limit
  r = await S(3, "POST", "/bale/connect/start", { phone: "09120000003" }); assert.equal(r.s, 200);
  r = await S(3, "POST", "/bale/connect/code", { code: "22222" }); assert.equal(r.s, 200); assert.equal(r.j.flow.step, "password");
  r = await S(3, "POST", "/bale/connect/password", { password: "wrong-2fa" }); assert.equal(r.s, 422); assert.equal(r.j.error, "wrong_password");
  r = await S(3, "POST", "/bale/connect/password", { password: "mock-2fa" }); assert.equal(r.s, 200); assert.equal(r.j.account.status, "connected");
  SECRETS.add("mock-2fa"); SECRETS.add("wrong-2fa"); SECRETS.add(openBaleSession(ENV, acc(3).session_ct, baleSessionAad(acc(3).id, 3)).plaintext);
  assert.notEqual(acc(3).device_hash, acc(2).device_hash);
  ok("2FA: code → password_needed → wrong password → connected; device ids differ per expert");

  for (let i = 0; i < 3; i++) { r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 200, `start ${i}`); }
  r = await S(8, "GET", "/bale/me"); assert.equal(r.j.startsLeft, 0);
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 429); assert.equal(r.j.error, "too_many_starts");
  r = await S(8, "POST", "/bale/connect/code", { code: "99999" }); assert.equal(r.s, 410); assert.equal(r.j.error, "code_expired");
  r = await S(8, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 410, "expired flow is gone");
  clock = new Date(clock.getTime() + 61 * 60_000);
  r = await S(8, "POST", "/bale/connect/start", { phone: "09990000009" }); assert.equal(r.s, 502); assert.equal(r.j.error, "number_banned");
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 200);
  for (let i = 0; i < 5; i++) { r = await S(8, "POST", "/bale/connect/code", { code: "00000" }); assert.equal(r.s, 422); }
  r = await S(8, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 429); assert.equal(r.j.error, "too_many_tries");
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 200, "3rd start in the new hour");
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 429, "failed (banned) start also counts");
  clock = new Date(clock.getTime() + 61 * 60_000);
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 200);
  clock = new Date(clock.getTime() + 6 * 60_000);
  r = await S(8, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 410, "flow TTL 5 min"); assert.equal(r.j.error, "no_flow");
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 200);
  r = await S(8, "POST", "/bale/connect/cancel"); assert.equal(r.j.flow, null);
  ok("limits: 3 starts/h per expert (failed ones count), 5 tries per flow, 5-min flow TTL, expired code drops the flow, cancel");

  // modes
  r = await S(2, "PUT", "/bale/me/mode", { mode: "everything" }); assert.equal(r.s, 422);
  r = await S(2, "PUT", "/bale/me/mode", { mode: "approve_first" }); assert.equal(r.s, 200); assert.equal(acc(2).mode, "approve_first");
  r = await S(8, "PUT", "/bale/me/mode", { mode: "auto" }); assert.equal(r.s, 409, "not connected");
  r = await S(1, "GET", "/admin/bale"); assert.equal(r.s, 200); assert.equal(r.j.sidecar.reachable, true); assert.deepEqual(r.j.experts.map(e => e.userId), [2, 3, 8]);
  assert.ok(!JSON.stringify(r.j).includes("v1:"), "admin view never contains ciphertext"); assert.equal(r.j.limits.perHour, 20);
  r = await S(29, "GET", "/admin/bale"); assert.equal(r.s, 403);
  r = await S(1, "PUT", `/admin/bale/accounts/${acc(2).id}/mode`, { mode: "off" }); assert.equal(r.s, 200); assert.equal(acc(2).mode, "off");
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" }); assert.equal(r.s, 200); assert.equal(acc(2).mode, "auto");
  ok("modes: expert sets off/approve_first/auto only when connected; admin forces off; admin view has no ciphertext; 29 blocked");

  // chat tab scope
  const aid = acc(2).id;
  db.exec(`INSERT INTO bale_messages(account_id,customer_id,direction,text,status,created_at) VALUES(${aid},100,'in','سلام، وام ترنم را می‌خواستم','read','2026-10-26T06:00:00Z'),(${aid},100,'out','سلام، در خدمتم','sent','2026-10-26T06:01:00Z')`);
  r = await S(2, "GET", "/bale/customers/100/messages"); assert.equal(r.s, 200); assert.equal(r.j.messages.length, 2); assert.equal(r.j.readOnly, false, "the owner may act (1b)");
  assert.equal(r.j.expert.name, "حسنی"); assert.equal(r.j.expert.connected, true);
  r = await S(1, "GET", "/bale/customers/100/messages"); assert.equal(r.s, 200); assert.equal(r.j.messages.length, 2); assert.equal(r.j.readOnly, true); assert.equal(r.j.canSend, false);
  r = await S(1, "GET", "/bale/customers/110/messages"); assert.equal(r.s, 200); assert.equal(r.j.messages.length, 0);
  for (const [u, c, s] of [[3, 100, 404], [2, 110, 404], [2, 101, 404], [2, 999, 404], [2, "x", 404], [6, 130, 403], [27, 100, 403], [28, 100, 403], [29, 100, 403], [4, 100, 403], [30, 100, 403]]) {
    r = await S(u, "GET", `/bale/customers/${c}/messages`); assert.equal(r.s, s, `user ${u} customer ${c}`); assert.ok(!r.j.messages);
  }
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE action='chat.view' AND outcome IN ('forbidden','not_in_scope')").get().n >= 11);
  ok("«گفتگوی بله» tab: admin all, expert own (merged/foreign → 404), trainees/29/registrar/accountant → 403, denials audited");

  // disconnect
  r = await S(2, "POST", "/bale/me/disconnect"); assert.equal(r.s, 200); assert.equal(r.j.remoteSignOut, "ok");
  const so = mock.log.findLast(l => l.path === "/v1/session/signout").body; assert.ok(SECRETS.has(so.token)); assert.equal(so.deviceHash, acc(2).device_hash);
  a2 = acc(2); assert.equal(a2.session_ct, null); assert.equal(a2.status, "disconnected"); assert.equal(a2.mode, "off"); assert.equal(a2.disconnected_by, 2);
  r = await S(2, "POST", "/bale/me/disconnect"); assert.equal(r.s, 409);
  mock.state.failSignOut = true;
  r = await S(1, "POST", `/admin/bale/accounts/${acc(3).id}/disconnect`); assert.equal(r.s, 200); assert.equal(r.j.remoteSignOut, "failed");
  assert.equal(acc(3).session_ct, null, "session deleted even when SignOut fails"); assert.equal(acc(3).last_error, "signout_failed"); assert.equal(acc(3).disconnected_by, 1);
  mock.state.failSignOut = false;
  // reconnect keeps the same per-expert device id
  r = await S(2, "POST", "/bale/connect/start", { phone: "09120000000" }); assert.equal(r.s, 200);
  assert.equal(mock.log.findLast(l => l.path === "/v1/auth/start").body.deviceHash, a2.device_hash);
  r = await S(2, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.s, 200); SECRETS.add(openBaleSession(ENV, acc(2).session_ct, baleSessionAad(acc(2).id, 2)).plaintext);
  ok("disconnect: expert + admin; SignOut sent with the sealed token; session deleted even when SignOut fails; reconnect reuses device id");

  // key rotation + missing key + sidecar down + master off
  const before = acc(2).session_ct;
  ENV = { ...ENV, BALE_SESSION_KEY_FILE: KEY2, BALE_SESSION_KEY_FILE_PREVIOUS: KEY1 };
  const o = openBaleSession(ENV, before, baleSessionAad(acc(2).id, 2)); assert.ok(o.rotated); assert.notEqual(o.rotated.keyId, before.split(":")[1]);
  assert.equal(openBaleSession(ENV, o.rotated.value, baleSessionAad(acc(2).id, 2)).plaintext, o.plaintext);
  const s2 = sealBaleSession(ENV, "x", "a"); assert.equal(s2.keyId, o.rotated.keyId);
  ENV = { ...ENV, BALE_SESSION_KEY_FILE: path.join(tmp, "missing") };
  r = await S(8, "GET", "/bale/me"); assert.equal(r.j.ready, false);
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 503); assert.equal(r.j.error, "key_missing");
  ENV = { ...ENV, BALE_SESSION_KEY_FILE: KEY2 };
  mock.state.down = true;
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 502); assert.equal(r.j.error, "sidecar_unavailable");
  mock.state.down = false;
  ENV = { ...ENV, BALE_SIDECAR_URL: "http://192.168.1.5:18470" };
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 503); assert.equal(r.j.error, "sidecar_not_configured");
  ENV = { ...ENV, BALE_SIDECAR_URL: `http://127.0.0.1:${mock.port}` };
  r = await S(1, "PUT", "/admin/bale/master", { enabled: false }); assert.equal(r.s, 200);
  assert.equal(acc(2).status, "connected", "master OFF keeps sessions");
  r = await S(8, "POST", "/bale/connect/start", { phone: "09120000006" }); assert.equal(r.s, 423);
  ok("crypto: rotation via _PREVIOUS (lazy re-seal), missing key → 503, sidecar down → 502, non-loopback sidecar refused, master OFF keeps sessions");

  // nothing secret anywhere in the DB / audit
  const dump = JSON.stringify(["bale_accounts", "bale_audit", "bale_settings"].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
  for (const s of SECRETS) assert.ok(!dump.includes(s), "secret leaked into DB");
  for (const s of ["11111", "22222", "00000", "09120000000", "09120000003", "09120000006", "09990000009"]) assert.ok(!dump.includes(s), `leak ${s}`);
  const actions = db.prepare("SELECT DISTINCT action FROM bale_audit").all().map(x => x.action);
  for (const a of ["connect.start", "connect.connected", "connect.code", "connect.password", "mode.expert", "mode.admin", "disconnect.expert", "disconnect.admin", "admin.master_on", "admin.master_off", "chat.view"]) assert.ok(actions.includes(a), a);
  r = await S(1, "GET", "/admin/bale/audit?limit=500"); assert.equal(r.s, 200); assert.ok(r.j.items.length > 10 && r.j.items.length <= 200);
  r = await S(2, "GET", "/admin/bale/audit"); assert.equal(r.s, 403);
  ok("no code, 2FA password, session token or full phone in bale_accounts / bale_audit / settings; audit covers every action");

  // ======================================== 1b: outbox, runner, reminders, inbound ========================================
  const T = iso => new Date(iso);
  const setS = (k, v) => db.prepare("INSERT INTO bale_settings(key,value,updated_at) VALUES(?,?,'fx') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
  const OB = id => db.prepare("SELECT * FROM bale_outbox WHERE id=?").get(id);
  const bells = (u, kind) => db.prepare("SELECT count(*) n FROM site_notification_events WHERE recipient_user_id=? AND kind=?").get(u, kind).n;
  const tick = () => bale.worker.tick();
  const send = (c, text, extra = {}) => S(2, "POST", `/bale/customers/${c}/send`, { text, ...extra });
  const R = async (asst, body, headers = {}) => {
    const x = await fetch(`http://127.0.0.1:${port}/runner/bale/send`, { method: "POST", headers: { "content-type": "application/json", "x-asst": String(asst), ...headers }, body: JSON.stringify(body) });
    return { s: x.status, j: await x.json() };
  };

  assert.equal(inBaleQuiet(T("2026-10-27T17:59:00Z"), "21:30", "08:30"), false, "21:29");
  assert.equal(inBaleQuiet(T("2026-10-27T18:00:00Z"), "21:30", "08:30"), true, "21:30");
  assert.equal(inBaleQuiet(T("2026-10-27T04:59:00Z"), "21:30", "08:30"), true, "08:29");
  assert.equal(inBaleQuiet(T("2026-10-27T05:00:00Z"), "21:30", "08:30"), false, "08:30");
  assert.equal(quietEndAfter(T("2026-10-27T18:30:00Z"), "08:30").toISOString(), "2026-10-28T05:00:00.000Z");
  assert.equal(quietEndAfter(T("2026-10-28T01:00:00Z"), "08:30").toISOString(), "2026-10-28T05:00:00.000Z");
  for (const t of ["وام نقد می‌خواهید یا کالا؟", "نقدی میخواید؟", "امتیاز یا نقد", "ترجیح می‌دهید کالا باشد"]) assert.ok(isLoanTypeQuestion(t), t);
  for (const t of ["مدارک را بفرستید", "پرونده‌ی کالای شما ثبت شد", "فردا ساعت ۱۰ تماس می‌گیرم"]) assert.ok(!isLoanTypeQuestion(t), t);
  const BW = ["برآورد", "تخمینی"];
  assert.equal(baleTextProblem("  ", BW), "empty"); assert.equal(baleTextProblem("ا".repeat(1001), BW), "too_long");
  assert.equal(baleTextProblem("برآ\u200cورد اولیه", BW), "banned_word"); assert.equal(baleTextProblem("مبلغ تخمـینی", BW), "banned_word");
  assert.equal(baleTextProblem("سلام، مدارک را بفرستید", BW), null);
  const d1 = withAmountDisclaimer("قسط ماهانه ۲ میلیون تومان است"); assert.ok(d1.endsWith(BALE_AMOUNT_DISCLAIMER)); assert.equal(withAmountDisclaimer(d1), d1);
  assert.ok(withAmountDisclaimer("طرح ترنم مناسب شماست").includes(BALE_AMOUNT_DISCLAIMER));
  assert.equal(withAmountDisclaimer("فردا ساعت ۱۰ تماس می‌گیرم"), "فردا ساعت ۱۰ تماس می‌گیرم", "times are not amounts");
  assert.equal(baleTextProblem(d1, JSON.parse(db.prepare("SELECT value FROM bale_settings WHERE key='banned_words'").get().value)), null, "the disclaimer itself passes the filters");
  ok("1b helpers: quiet window across midnight, «نقد/کالا/امتیاز» question filter, banned words through ZWNJ/tatweel, disclaimer only for amounts/plans");

  // ---- expert command: checks in order, nothing stored when blocked, sends with gap ----
  clock = T("2026-10-27T06:30:00Z"); // 10:00 Tehran
  const hid = acc(2).id; const REF = `acc-${hid}`;
  r = await send(100, "سلام"); assert.equal(r.s, 423); assert.equal(r.j.error, "bale_disabled");
  r = await S(1, "PUT", "/admin/bale/master", { enabled: true }); assert.equal(r.s, 200);
  db.prepare("UPDATE bale_accounts SET mode='off' WHERE id=?").run(hid);
  r = await send(100, "سلام"); assert.equal(r.s, 423); assert.equal(r.j.error, "mode_off"); assert.ok(r.j.message.length > 5);
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" }); assert.equal(r.s, 200);
  for (const [c, s, e] of [[110, 404, "out_of_scope"], [101, 404, "out_of_scope"], [999, 404, "out_of_scope"], [130, 404, "out_of_scope"], [104, 422, "no_phone"]]) {
    r = await send(c, "سلام"); assert.equal(r.s, s, `customer ${c}`); assert.equal(r.j.error, e);
  }
  for (const u of [1, 4, 6, 27, 29, 30]) { r = await S(u, "POST", "/bale/customers/100/send", { text: "سلام" }); assert.equal(r.s, 403, `user ${u}`); }
  for (const [t, e] of [["برآ\u200cورد اولیه این است", "banned_word"], ["نقد می‌خواهید یا کالا؟", "loan_type_question"], ["ب".repeat(1001), "too_long"], ["  ", "empty"]]) {
    r = await send(100, t); assert.equal(r.s, 422, e); assert.equal(r.j.error, e);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM bale_outbox").get().n, 0, "blocked expert typing is not stored (audited only)");
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE action='outbox.expert_command' AND outcome LIKE 'blocked:%'").get().n >= 9);
  r = await send(102, "سلام، از نفیس وام هستم"); assert.equal(r.s, 200); assert.equal(r.j.status, "queued"); const o102 = r.j.outboxId;
  assert.equal(OB(o102).is_new_chat, 1, "first message to a customer with no prior chat (explicit expert command)");
  r = await send(100, "سلام، لطفاً مدارک را بفرستید"); assert.equal(r.s, 200); const o100 = r.j.outboxId;
  r = await send(100, "دوباره"); assert.equal(r.s, 409); assert.equal(r.j.error, "already_pending");
  let t = await tick(); assert.equal(t.results[hid], "sent"); assert.ok(mock.attached.has(REF), "worker attached the session");
  assert.equal(mock.sent.at(-1).phone, "09120000011"); assert.ok(mock.sent.at(-1).typingMs >= 1200); assert.equal(OB(o102).status, "sent");
  t = await tick(); assert.equal(t.results[hid], "gap", "random gap between two sends");
  clock = new Date(clock.getTime() + 83_000);
  t = await tick(); assert.equal(t.results[hid], "sent"); assert.equal(OB(o100).status, "sent"); assert.equal(mock.sent.at(-1).text, "سلام، لطفاً مدارک را بفرستید");
  assert.equal(db.prepare("SELECT count(*) n FROM bale_messages WHERE account_id=? AND direction='out' AND outbox_id IS NOT NULL").get(hid).n, 2);
  assert.equal(db.prepare("SELECT peer_id FROM bale_contacts WHERE account_id=? AND customer_id=100").get(hid).peer_id, mock.peerOf("09120000001"));
  r = await S(2, "GET", "/bale/customers/100/messages"); assert.equal(r.j.canSend, true); assert.equal(r.j.sendState.sentLastHour, 2); assert.equal(r.j.sendState.hasPriorChat, true);
  assert.ok(!JSON.stringify(r.j).includes("0912"), "tab never shows the phone");
  ok("expert send: master/mode/scope/merged/no-phone/filters/already-pending checked; blocked typing not stored; first chat only by expert; gap between sends");

  // ---- caps ----
  clock = new Date(clock.getTime() + 83_000);
  setS("per_hour", 3);
  r = await send(100, "پیگیری مدارک"); assert.equal(r.s, 200); const oCap = r.j.outboxId;
  r = await send(102, "سلام دوباره"); assert.equal(r.s, 429); assert.equal(r.j.error, "cap_hour"); assert.ok(r.j.message);
  setS("per_hour", 20); setS("per_day", 3);
  r = await send(102, "سلام دوباره"); assert.equal(r.s, 429); assert.equal(r.j.error, "cap_day");
  setS("per_day", 80); setS("new_chats_per_day", 1);
  r = await send(105, "سلام"); assert.equal(r.s, 429); assert.equal(r.j.error, "cap_new_chats");
  setS("new_chats_per_day", 15); setS("per_hour", 2);
  t = await tick(); assert.equal(t.results[hid], "held:cap_hour", "a cap at send time holds the row, it is not dropped");
  assert.equal(OB(oCap).status, "queued"); assert.ok(OB(oCap).scheduled_at > clock.toISOString());
  setS("per_hour", 20);
  t = await tick(); assert.equal(t.results[hid], "idle", "held row waits for its time");
  r = await S(2, "POST", `/bale/outbox/${oCap}/send-now`); assert.equal(r.s, 200);
  t = await tick(); assert.equal(t.results[hid], "sent");
  r = await S(2, "POST", `/bale/outbox/${oCap}/send-now`); assert.equal(r.s, 409);
  ok("caps: per-hour, per-day, new-chats-per-day block at enqueue (429 + Persian message); at send time they hold; «همین الان» releases");

  // ---- quiet hours ----
  clock = T("2026-10-27T17:58:00Z"); // 21:28 Tehran
  r = await send(100, "یک پیام دیروقت"); assert.equal(r.s, 200); assert.equal(r.j.heldUntil, null); const oLate = r.j.outboxId;
  clock = T("2026-10-27T18:01:00Z"); // 21:31
  t = await tick(); assert.equal(t.results[hid], "held:quiet"); assert.equal(OB(oLate).scheduled_at, "2026-10-28T05:00:00.000Z");
  r = await send(102, "سلام، فردا صبح تماس می‌گیرم"); assert.equal(r.s, 200); assert.equal(r.j.heldUntil, "2026-10-28T05:00:00.000Z"); assert.ok(r.j.message.length > 5);
  const oQ = r.j.outboxId;
  r = await S(2, "GET", "/bale/customers/102/messages"); assert.equal(r.j.sendState.quietNow, true); assert.equal(r.j.sendState.quietEnd, "2026-10-28T05:00:00.000Z");
  t = await tick(); assert.equal(t.results[hid], "idle");
  r = await S(2, "POST", `/bale/outbox/${oQ}/send-now`); assert.equal(r.s, 200);
  t = await tick(); assert.equal(t.results[hid], "sent", "only the expert's «همین الان» passes quiet hours"); assert.equal(OB(oQ).status, "sent");
  clock = T("2026-10-28T05:01:00Z");
  t = await tick(); assert.equal(t.results[hid], "sent"); assert.equal(OB(oLate).status, "sent");
  ok("quiet hours 21:30–08:30 Tehran: rows held to 08:30 (at enqueue and at send time); «همین الان» is the only bypass");

  // ---- approve-first + runner ----
  clock = T("2026-10-28T06:00:00Z"); // 09:30
  r = await S(2, "PUT", "/bale/me/mode", { mode: "approve_first" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await R(1, { customerId: 100, text: "سلام، مدارک رسید. قسط حدود ۳ میلیون تومان است", reason: "پیگیری مدارک" });
  assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "pending_approval"); const oD = r.j.outboxId;
  assert.ok(OB(oD).text.endsWith(BALE_AMOUNT_DISCLAIMER)); assert.equal(bells(2, "bale-draft"), 1);
  t = await tick(); assert.equal(t.results[hid], undefined, "drafts are never sent without approval");
  r = await S(2, "PUT", `/bale/outbox/${oD}`, { text: "برآورد اولیه" }); assert.equal(r.s, 422); assert.equal(r.j.error, "banned_word");
  r = await S(2, "PUT", `/bale/outbox/${oD}`, { text: "سلام، مدارک رسید. قسط ماهانه ۳ میلیون تومان" }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.ok(r.j.text.endsWith(BALE_AMOUNT_DISCLAIMER));
  r = await S(3, "POST", `/bale/outbox/${oD}/approve`); assert.ok([404, 409].includes(r.s), "another expert cannot approve");
  r = await S(1, "POST", `/bale/outbox/${oD}/approve`); assert.equal(r.s, 403, "admin cannot approve for the expert");
  r = await S(2, "POST", `/bale/outbox/${oD}/approve`); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "queued");
  t = await tick(); assert.equal(t.results[hid], "sent"); assert.ok(mock.sent.at(-1).text.startsWith("سلام، مدارک رسید. قسط ماهانه"));
  r = await S(2, "POST", `/bale/outbox/${oD}/approve`); assert.equal(r.s, 409);
  // runner scope + filters + explicit flag
  r = await R(1, { customerId: 110, text: "سلام" }); assert.equal(r.s, 404); assert.equal(r.j.error, "out_of_scope");
  r = await R(1, { customerId: 130, text: "سلام" }); assert.equal(r.s, 404, "not in the assistant's scope");
  r = await R(2, { customerId: 100, text: "سلام" }); assert.equal(r.s, 403, "filing assistant cannot send");
  r = await R(3, { customerId: 110, text: "سلام" }); assert.equal(r.s, 423, "ghasemi is not connected");
  r = await R(1, { customerId: 100, text: "نقد یا کالا؟" }); assert.equal(r.s, 422); assert.equal(r.j.error, "loan_type_question");
  r = await R(1, { customerId: 105, text: "سلام" }); assert.equal(r.s, 422); assert.equal(r.j.error, "no_prior_chat");
  r = await R(1, { customerId: 105, text: "سلام", explicitExpertCommand: true }); assert.equal(r.s, 422, "explicit flag without a recent expert message is ignored");
  const th = db.prepare("INSERT INTO assistant_threads(assistant_id,user_id) VALUES(1,2)").run().lastInsertRowid;
  db.prepare("INSERT INTO assistant_messages(thread_id,author,body,created_at) VALUES(?,'assistant','x',?),(?,'user','old',?)").run(th, clock.toISOString(), th, new Date(clock.getTime() - 20 * 60_000).toISOString());
  r = await R(1, { customerId: 105, text: "سلام", explicitExpertCommand: true }); assert.equal(r.s, 422, "assistant's own message / old expert message do not count");
  db.prepare("INSERT INTO assistant_messages(thread_id,author,body,created_at) VALUES(?,'user','به ۱۰۵ پیام بده',?)").run(th, new Date(clock.getTime() - 5 * 60_000).toISOString());
  r = await R(1, { customerId: 105, text: "سلام", explicitExpertCommand: true }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "pending_approval"); const o105 = r.j.outboxId;
  assert.equal(OB(o105).explicit_expert_command, 1);
  r = await S(2, "POST", `/bale/outbox/${o105}/cancel`); assert.equal(r.s, 200, JSON.stringify(r.j)); r = await S(2, "POST", `/bale/outbox/${o105}/cancel`); assert.equal(r.s, 409);
  r = await S(2, "GET", "/bale/outbox"); assert.equal(r.s, 200, JSON.stringify(r.j));
  const foreign = r.j.items.find(i => i.blockReason === "out_of_scope"); assert.ok(foreign); assert.equal(foreign.customerName, null); assert.equal(foreign.text, null);
  assert.ok(r.j.items.some(i => i.blockReason === "loan_type_question" && i.text === "نقد یا کالا؟" && i.blockMessage));
  // reassigned after drafting → no actions
  r = await R(1, { customerId: 102, text: "سلام" }); assert.equal(r.j.error, "no_prior_chat", "we wrote to 102 but it never answered → still no prior chat");
  r = await R(1, { customerId: 100, text: "سلام، وقت دارید؟" }); assert.equal(r.s, 200, JSON.stringify(r.j)); const oRe = r.j.outboxId;
  db.prepare("UPDATE customers SET salesperson_id=4 WHERE id=100").run();
  r = await S(2, "POST", `/bale/outbox/${oRe}/approve`); assert.equal(r.s, 404); assert.equal(r.j.error, "out_of_scope"); assert.ok(r.j.message);
  r = await send(100, "سلام"); assert.equal(r.s, 404); assert.equal(r.j.error, "out_of_scope");
  db.prepare("UPDATE customers SET salesperson_id=3 WHERE id=100").run();
  r = await S(2, "POST", `/bale/outbox/${oRe}/cancel`); assert.equal(r.s, 200, JSON.stringify(r.j));
  // runner never bypasses quiet hours (auto mode)
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" });
  clock = T("2026-10-28T18:30:00Z");
  r = await R(1, { customerId: 100, text: "شب بخیر", sendNow: true }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.status, "queued"); assert.equal(r.j.heldUntil, "2026-10-29T05:00:00.000Z");
  assert.equal(OB(r.j.outboxId).send_now, 0); await S(2, "POST", `/bale/outbox/${r.j.outboxId}/cancel`);
  ok("«اول تأیید من»: draft + bell, edit (filters re-run), approve/cancel by the owner only; runner: sales assistant only, scope, explicit flag needs a recent expert message, no quiet bypass; out-of-scope rows hide name/text");

  // ---- reminder type «پیام به مشتری» ----
  clock = T("2026-10-29T06:00:00Z");
  r = await S(2, "PUT", "/bale/me/mode", { mode: "approve_first" });
  const addRem = (u, sp, c, at) => Number(db.prepare("INSERT INTO reminders(user_id,salesperson_id,customer_id,subject,remind_at,done,created_at) VALUES(?,?,?,'پیگیری',?,0,?)").run(u, sp, c, at, clock.toISOString()).lastInsertRowid);
  const in10 = new Date(clock.getTime() + 10 * 60_000).toISOString();
  const rem1 = addRem(2, 3, 100, in10), remF = addRem(3, 4, 110, in10), remDone = addRem(2, 3, 100, in10), remC = addRem(2, 3, 100, in10);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: remF, text: "سلام" }); assert.equal(r.s, 404);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: rem1, text: "برآورد" }); assert.equal(r.s, 422);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: rem1, text: "سلام، طبق قرار امروز تماس می‌گیرم" }); assert.equal(r.s, 200);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: rem1, text: "x" }); assert.equal(r.s, 409);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: remDone, text: "سلام" }); assert.equal(r.s, 200);
  r = await S(2, "POST", "/bale/reminder-messages", { reminderId: remC, text: "سلام" }); assert.equal(r.s, 200);
  r = await S(2, "POST", `/bale/reminder-messages/${remC}/cancel`); assert.equal(r.s, 200);
  r = await S(2, "GET", "/bale/customers/100/messages"); assert.equal(r.j.sendState.reminders.length, 2);
  db.prepare("UPDATE reminders SET done=1 WHERE id=?").run(remDone);
  t = await tick(); assert.equal(t.reminders, 0, "not due yet");
  clock = new Date(clock.getTime() + 11 * 60_000);
  t = await tick(); assert.equal(t.reminders, 1);
  const rm = db.prepare("SELECT * FROM bale_reminder_messages WHERE reminder_id=?").get(rem1); assert.equal(rm.status, "enqueued");
  assert.equal(OB(rm.outbox_id).source, "reminder"); assert.equal(OB(rm.outbox_id).status, "pending_approval");
  assert.equal(db.prepare("SELECT status FROM bale_reminder_messages WHERE reminder_id=?").get(remDone).status, "cancelled", "reminder done before due → no message");
  assert.equal(db.prepare("SELECT status FROM bale_reminder_messages WHERE reminder_id=?").get(remC).status, "cancelled");
  r = await S(2, "POST", `/bale/outbox/${rm.outbox_id}/approve`); assert.equal(r.s, 200);
  t = await tick(); assert.equal(t.results[hid], "sent"); assert.equal(db.prepare("SELECT done FROM reminders WHERE id=?").get(rem1).done, 1, "sent → reminder done");
  ok("reminder «پیام به مشتری»: own reminders only, filters at link time, due → outbox (draft in approve-first), done/cancelled → nothing, sent → reminder done");

  // ---- auto-stop on rate limit / ban; peer not found; sidecar down retries ----
  clock = T("2026-10-29T07:00:00Z");
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" });
  r = await send(100, "پیام اول"); const oS1 = r.j.outboxId; r = await send(102, "پیام دوم"); const oS2 = r.j.outboxId;
  mock.state.sendError = "rate_limited";
  t = await tick(); assert.equal(t.results[hid], "error:rate_limited");
  let a2s = acc(2); assert.equal(a2s.mode, "off"); assert.equal(a2s.stopped_reason, "rate_limited"); assert.equal(a2s.status, "connected"); assert.ok(a2s.session_ct);
  assert.equal(OB(oS1).status, "failed"); assert.equal(OB(oS2).status, "blocked"); assert.equal(OB(oS2).block_reason, "auto_stopped");
  assert.equal(bells(2, "bale-stopped"), 1); assert.equal(bells(1, "bale-stopped"), 1); assert.equal(bells(29, "bale-stopped"), 0);
  r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account.stoppedReason, "rate_limited");
  mock.state.sendError = null;
  r = await S(2, "PUT", "/bale/me/mode", { mode: "auto" }); assert.equal(acc(2).stopped_reason, null);
  r = await send(103, "سلام"); assert.equal(r.s, 200); const o103 = r.j.outboxId;
  t = await tick(); assert.equal(t.results[hid], "error:peer_not_found"); assert.equal(OB(o103).error, "no_bale_account"); assert.equal(acc(2).mode, "auto");
  assert.ok(bells(2, "bale-failed") >= 1);
  r = await send(100, "پیام سوم"); const oS3 = r.j.outboxId;
  mock.state.down = true; t = await tick(); mock.state.down = false;
  assert.equal(t.results[hid], "error:sidecar_unavailable"); assert.equal(OB(oS3).status, "queued"); assert.equal(OB(oS3).attempts, 1);
  t = await tick(); assert.equal(t.results[hid], "idle", "back-off");
  clock = new Date(clock.getTime() + 61_000);
  t = await tick(); assert.equal(t.results[hid], "sent");
  ok("auto-stop: rate limit → mode off + queued rows blocked + bell to expert and admins (not 29); peer not found → «بله ندارد»; sidecar down → retry with back-off");

  // ---- re-attach after a sidecar restart (+ lazy re-seal under the rotated key) and not_attached mid-flight ----
  clock = new Date(clock.getTime() + 90_000);
  const keyBefore = acc(2).session_key_id;
  mock.restart(); assert.equal(mock.attached.size, 0);
  r = await send(100, "پیام چهارم");
  t = await tick(); assert.equal(t.results[hid], "sent"); assert.ok(mock.attached.has(REF));
  assert.notEqual(acc(2).session_key_id, keyBefore, "re-sealed under the current key on attach");
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE action='session.attach' AND outcome='ok'").get().n >= 2);
  clock = new Date(clock.getTime() + 2_000); db.prepare("UPDATE bale_accounts SET next_send_at=NULL WHERE id=?").run(hid); // skip the gap; sync is <60 s old
  mock.attached.clear();
  r = await send(102, "پیام پنجم");
  t = await tick(); assert.equal(t.results[hid], "sent", "not_attached → re-attach once → sent");
  assert.equal(mock.log.filter(l => l.path === "/v1/send").length - mock.sent.length >= 1, true);
  ok("sessions: new sidecar bootId → every connected session re-attached (lazy key re-seal); not_attached during a send → re-attach + retry");

  // ---- general rule (2026-10-26): status + sending follow the REAL sidecar session; a local attach failure never stops the account ----
  {
    clock = new Date(clock.getTime() + 200_000); db.prepare("UPDATE bale_accounts SET next_send_at=NULL WHERE id=?").run(hid);
    const before = acc(2); r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account.session, "live");
    mock.restart(); mock.state.attachError = "client_error"; // the live 2026-10-26 failure: sidecar up, attach fails locally
    clock = new Date(clock.getTime() + 61_000); await tick();
    let a2 = acc(2); assert.equal(a2.status, "connected"); assert.equal(a2.mode, before.mode, "mode untouched"); assert.ok(a2.session_ct, "session kept");
    assert.equal(db.prepare("SELECT outcome o FROM bale_audit WHERE action='session.attach' ORDER BY id DESC").get().o, "client_error", "real code, not unknown");
    r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account.status, "connected"); assert.equal(r.j.account.session, "down");
    r = await S(1, "GET", "/admin/bale"); assert.ok(JSON.stringify(r.j).includes('"session":"down"'), "admin list shows the real state");
    r = await send(100, "قفل"); assert.equal(r.s, 423); assert.equal(r.j.error, "session_not_live");
    r = await R(1, { customerId: 100, text: "پیشنهاد دستیار" }); assert.equal(r.s, 423); assert.equal(r.j.status, "blocked"); assert.equal(r.j.error, "session_not_live");
    r = await S(2, "GET", "/bale/customers/100/messages"); assert.equal(r.j.canSend, false); assert.match(r.j.sendBlockedMessage, /ناقص/);
    // a row approved just before the drop: held (never sent), then released once the session is live again
    const sentBefore = mock.sent.length;
    const qid = Number(db.prepare(`INSERT INTO bale_outbox(account_id,customer_id,text,source,explicit_expert_command,status,created_by,created_at,updated_at,approved_by,approved_at)
      VALUES(?,100,'در صف','expert_command',1,'queued',2,?,?,2,?)`).run(hid, clock.toISOString(), clock.toISOString(), clock.toISOString()).lastInsertRowid);
    let t = await tick(); assert.equal(t.results[hid], "held:session_not_live"); assert.equal(mock.sent.length, sentBefore, "locked: sidecar send never called");
    mock.state.attachError = null; clock = new Date(clock.getTime() + 61_000); t = await tick();
    assert.equal(t.results[hid], "sent"); assert.equal(OB(qid).status, "sent");
    r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account.session, "live");
    // still down after 15 min → blocked with a bell, never sent
    mock.restart(); mock.state.attachError = "timeout"; clock = new Date(clock.getTime() + 200_000); await tick();
    const old = new Date(clock.getTime() - 16 * 60_000).toISOString();
    const q2 = Number(db.prepare(`INSERT INTO bale_outbox(account_id,customer_id,text,source,explicit_expert_command,status,created_by,created_at,updated_at,approved_by,approved_at)
      VALUES(?,100,'کهنه','expert_command',1,'queued',2,?,?,2,?)`).run(hid, old, old, old).lastInsertRowid);
    t = await tick(); assert.equal(t.results[hid], "blocked:session_not_live"); assert.equal(OB(q2).block_reason, "session_not_live");
    mock.state.attachError = null; clock = new Date(clock.getTime() + 61_000); await tick(); assert.equal((await S(2, "GET", "/bale/me")).j.account.session, "live");
    assert.equal(acc(2).mode, before.mode);
    ok("live rule: attach fails locally → «down» (status stays connected, mode/session kept, real code in audit); sends 423 session_not_live; queued rows held, never sent; live again → sent");
  }

  // ---- decision (b): "one customer blocked me" (UNVERIFIED) — safe default stops the whole account; conversation_pause is opt-in ----
  clock = new Date(clock.getTime() + 200_000); db.prepare("UPDATE bale_accounts SET next_send_at=NULL WHERE id=?").run(hid);
  assert.equal(db.prepare("SELECT value FROM bale_settings WHERE key='peer_block_mode'").get().value, "account_stop", "default = whole-account stop");
  mock.state.blockedPhones.add("09120000011"); // customer 102
  r = await send(102, "پیام ششم"); const oB1 = r.j.outboxId; r = await send(100, "پیام هفتم"); const oB2 = r.j.outboxId;
  t = await tick(); assert.equal(t.results[hid], "error:peer_blocked"); await new Promise(z => setTimeout(z, 50));
  let aB = acc(2); assert.equal(aB.mode, "off"); assert.equal(aB.status, "banned"); assert.equal(aB.session_ct, null); assert.equal(aB.stopped_reason, "account_banned");
  assert.equal(OB(oB1).error, "peer_blocked"); assert.equal(OB(oB2).block_reason, "auto_stopped"); assert.equal(mock.attached.has(REF), false, "banned → live client detached");
  assert.deepEqual(JSON.parse(db.prepare("SELECT detail_json d FROM bale_audit WHERE action='account.auto_stop' ORDER BY id DESC").get().d), { blockedRows: 1, from: "peer_blocked", unverified: true });
  r = await S(1, "GET", "/admin/bale"); assert.deepEqual(r.j.peerBlock, { mode: "account_stop", verified: false });
  for (const [u, body, s] of [[29, { mode: "conversation_pause" }, 403], [2, { mode: "conversation_pause" }, 403], [1, { mode: "pause" }, 422]]) { r = await S(u, "PUT", "/admin/bale/peer-block-mode", body); assert.equal(r.s, s); }
  r = await S(2, "POST", "/bale/connect/start", { phone: "09120000000" }); assert.equal(r.s, 200); r = await S(2, "POST", "/bale/connect/code", { code: "11111" }); assert.equal(r.j.account.status, "connected");
  await S(2, "PUT", "/bale/me/mode", { mode: "auto" }); await tick();
  r = await S(1, "PUT", "/admin/bale/peer-block-mode", { mode: "conversation_pause" }); assert.equal(r.s, 200); assert.equal(r.j.peerBlock.mode, "conversation_pause");
  clock = new Date(clock.getTime() + 200_000);
  r = await send(102, "پیام هشتم"); const oB3 = r.j.outboxId;
  t = await tick(); assert.equal(t.results[hid], "error:peer_blocked");
  aB = acc(2); assert.equal(aB.mode, "auto", "only the conversation pauses"); assert.equal(aB.status, "connected"); assert.ok(aB.session_ct);
  assert.equal(OB(oB3).error, "peer_blocked"); assert.equal(bells(2, "bale-paused"), 1);
  r = await send(102, "دوباره"); assert.equal(r.s, 422); assert.equal(r.j.error, "conversation_paused");
  r = await S(2, "GET", "/bale/customers/102/messages"); assert.equal(r.j.paused.reason, "peer_blocked"); assert.equal(r.j.paused.unverified, true);
  r = await send(100, "پیام نهم"); assert.equal(r.s, 200); clock = new Date(clock.getTime() + 200_000); t = await tick(); assert.equal(t.results[hid], "sent", "other chats keep going");
  r = await S(2, "POST", "/bale/customers/110/resume"); assert.equal(r.s, 404);
  r = await S(2, "POST", "/bale/customers/102/resume"); assert.equal(r.s, 200); r = await S(2, "POST", "/bale/customers/102/resume"); assert.equal(r.s, 409);
  r = await S(2, "GET", "/bale/customers/102/messages"); assert.equal(r.j.paused, null);
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE action IN ('conversation.pause','conversation.resume','admin.peer_block_mode')").get().n >= 3);
  mock.state.blockedPhones.clear(); await S(1, "PUT", "/admin/bale/peer-block-mode", { mode: "account_stop" });
  ok("(b) peer_blocked UNVERIFIED: default account_stop = old ban behaviour (+ detach); admin-only conversation_pause pauses just that chat (bell, 422, resume, audit)");

  // ---- inbound ----
  const API = `http://127.0.0.1:${port}`;
  const peer100 = db.prepare("SELECT peer_id FROM bale_contacts WHERE account_id=? AND customer_id=100").get(hid).peer_id;
  const raw = async (tok, headers = {}) => (await fetch(`${API}/internal/bale/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-bale-internal-token": tok, ...headers }, body: JSON.stringify({ accountRef: REF, events: [] }) })).status;
  assert.equal(await raw("nope"), 403); assert.equal(await raw(""), 403); assert.equal(await raw(sidecarToken, { "x-forwarded-for": "1.2.3.4" }), 403);
  assert.equal(await raw(sidecarToken, { "x-real-ip": "1.2.3.4" }), 403); assert.equal(await raw(sidecarToken), 200);
  r = await mock.inbound(API, REF, [{ messageId: "in-1", peerId: peer100, text: "سلام، مدارک را فرستادم. کد ملی 0012345678", date: clock.getTime() }]);
  assert.equal(r.s, 200); assert.deepEqual(r.j, { stored: 1, ignored: 0 });
  assert.equal(bells(2, "bale-inbound"), 1);
  const ev = db.prepare("SELECT * FROM assistant_events WHERE type='bale_inbound'").get(); assert.equal(ev.assistant_id, 1); assert.equal(ev.customer_id, 100);
  assert.ok(!ev.data_json.includes("0012345678"), "assistant event preview is masked");
  r = await mock.inbound(API, REF, [{ messageId: "in-1", peerId: peer100, text: "dup" }]); assert.equal(r.j.stored, 0, "duplicate ignored");
  const ign0 = acc(2).inbound_ignored;
  r = await mock.inbound(API, REF, [{ messageId: "in-2", peerId: "p-x", peerPhone: "09120000003", text: "مشتری دیگری" }, { messageId: "in-3", peerId: "p-y", text: "ناشناس" }]);
  assert.deepEqual(r.j, { stored: 0, ignored: 2 }); assert.equal(acc(2).inbound_ignored, ign0 + 2);
  assert.equal(db.prepare("SELECT count(*) n FROM bale_messages WHERE text IN ('مشتری دیگری','ناشناس')").get().n, 0, "other people's chats are never stored");
  r = await mock.inbound(API, REF, [{ messageId: "in-4", peerId: "p-105", peerPhone: "+989120000015", text: "سلام، من هم وام می‌خواهم" }]); assert.equal(r.j.stored, 1);
  assert.equal(db.prepare("SELECT has_prior_chat h, peer_id p FROM bale_contacts WHERE account_id=? AND customer_id=105").get(hid).p, "p-105");
  r = await R(1, { customerId: 105, text: "سلام، خوش آمدید" }); assert.equal(r.s, 200, "after the customer wrote, the assistant may reply"); await S(2, "POST", `/bale/outbox/${r.j.outboxId}/cancel`);
  const b0 = bells(2, "bale-inbound");
  r = await mock.inbound(API, REF, [{ messageId: "in-5", peerId: peer100, text: "از گوشی خودم", fromSelf: true }, { messageId: "in-6", peerId: peer100, hasFile: true }]);
  assert.equal(r.j.stored, 2); assert.equal(bells(2, "bale-inbound"), b0 + 1, "own messages from the phone: stored, no bell");
  assert.equal(db.prepare("SELECT direction d, status s FROM bale_messages WHERE bale_msg_id='in-5'").get().d, "out");
  assert.equal(db.prepare("SELECT file_ref f FROM bale_messages WHERE bale_msg_id='in-6'").get().f, "bale:pending");
  r = await mock.inbound(API, "acc-999", [{ messageId: "in-7", peerId: peer100, text: "x" }]); assert.equal(r.j.stored, 0);
  await S(1, "PUT", "/admin/bale/master", { enabled: false });
  r = await mock.inbound(API, REF, [{ messageId: "in-8", peerId: peer100, text: "x" }]); assert.equal(r.j.stored, 0, "master OFF → nothing stored");
  assert.ok(mock.attached.has(REF)); clock = new Date(clock.getTime() + 61_000); await tick();
  assert.equal(mock.attached.has(REF), false, "master OFF → worker detaches every live client"); assert.equal(acc(2).status, "connected", "…but keeps the sealed session");
  await S(1, "PUT", "/admin/bale/master", { enabled: true }); clock = new Date(clock.getTime() + 61_000); await tick();
  assert.ok(mock.attached.has(REF), "master ON again → re-attached");
  r = await S(2, "GET", "/bale/customers/100/messages"); assert.ok(r.j.messages.some(m => m.direction === "in" && m.text.startsWith("سلام، مدارک را فرستادم")));
  assert.ok(r.j.messages.filter(m => m.direction === "out").length >= 5);
  r = await S(3, "GET", "/bale/customers/100/messages"); assert.equal(r.s, 404);
  ok("inbound: loopback + token + not proxied; own customers only (by peer or unique phone), others counted not stored; bell + masked assistant event; dedupe; fromSelf; file marker");

  // ---- decision (c): «پیام از شماره‌ی ناشناس» — no text, one bell per chat, link to an OWN customer only, audited ----
  const UK = () => db.prepare("SELECT * FROM bale_unknown_chats WHERE account_id=? ORDER BY id").all(hid);
  assert.deepEqual(UK().map(x => [x.peer_id, x.status, x.messages]), [["p-x", "open", 1], ["p-y", "open", 1]]);
  assert.ok(!Object.keys(UK()[0]).some(k => /text|phone/.test(k)), "no text / phone column");
  assert.equal(bells(2, "bale-unknown"), 2);
  const ub = db.prepare("SELECT * FROM site_notification_events WHERE kind='bale-unknown' ORDER BY id").get();
  assert.equal(ub.customer_id, 0); assert.equal(ub.resource_type, "bale-unknown"); assert.equal(ub.title, "پیام از شماره‌ی ناشناس"); assert.equal(ub.recipient_user_id, 2);
  r = await mock.inbound(API, REF, [{ messageId: "u-1", peerId: "p-y", text: "باز هم من" }, { messageId: "u-2", peerId: "p-z", text: "من", fromSelf: true }]);
  assert.deepEqual(r.j, { stored: 0, ignored: 2 }); assert.equal(UK().length, 2); assert.equal(UK()[1].messages, 2); assert.equal(bells(2, "bale-unknown"), 2, "one bell per chat, not per message");
  r = await S(2, "GET", "/bale/unknown"); assert.equal(r.j.items.length, 2); assert.ok(!JSON.stringify(r.j).includes("p-y"), "peer id never leaves the API");
  r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account.unknownOpen, 2);
  r = await S(3, "GET", "/bale/unknown"); assert.equal(r.j.items.length, 0); r = await S(1, "GET", "/bale/unknown"); assert.equal(r.s, 403);
  r = await S(2, "GET", "/bale/my-customers?q=" + encodeURIComponent("مشتری")); assert.deepEqual(r.j.items.map(x => x.id).sort(), [100, 102]);
  r = await S(2, "GET", "/bale/my-customers?q=۰۰۱۵"); assert.deepEqual(r.j.items, [{ id: 105, name: "تازه دوم", phoneMasked: "0912•••15" }]);
  r = await S(2, "GET", "/bale/my-customers?q=0003"); assert.deepEqual(r.j.items, [], "another expert's customer never shows");
  const [ux, uy] = UK();
  for (const [cid, s, e] of [[110, 404, "out_of_scope"], [101, 404, "out_of_scope"], [999, 404, "out_of_scope"], [100, 409, "customer_has_chat"]]) {
    r = await S(2, "POST", `/bale/unknown/${uy.id}/link`, { customerId: cid }); assert.equal(r.s, s, `link → ${cid}`); assert.equal(r.j.error, e);
  }
  r = await S(3, "POST", `/bale/unknown/${uy.id}/link`, { customerId: 110 }); assert.equal(r.s, 404, "another expert cannot touch my unknown chats");
  await S(1, "PUT", "/admin/bale/master", { enabled: false }); r = await S(2, "POST", `/bale/unknown/${uy.id}/link`, { customerId: 103 }); assert.equal(r.s, 423); await S(1, "PUT", "/admin/bale/master", { enabled: true });
  r = await S(2, "POST", `/bale/unknown/${uy.id}/link`, { customerId: 103 }); assert.equal(r.s, 200); assert.equal(r.j.items.length, 1);
  assert.deepEqual({ ...db.prepare("SELECT peer_id p, has_prior_chat h FROM bale_contacts WHERE account_id=? AND customer_id=103").get(hid) }, { p: "p-y", h: 1 });
  assert.equal(db.prepare("SELECT count(*) n FROM bale_messages WHERE customer_id=103").get().n, 0, "nothing from before the link is stored");
  assert.deepEqual(JSON.parse(db.prepare("SELECT detail_json d FROM bale_audit WHERE action='unknown.link' AND outcome='ok'").get().d), { unknownId: uy.id });
  r = await S(2, "POST", `/bale/unknown/${uy.id}/link`, { customerId: 103 }); assert.equal(r.s, 404, "already linked");
  r = await S(2, "POST", `/bale/unknown/${ux.id}/link`, { customerId: 103 }); assert.equal(r.s, 409); assert.equal(r.j.error, "customer_has_chat");
  r = await mock.inbound(API, REF, [{ messageId: "u-3", peerId: "p-y", text: "سلام، من مشتری شما هستم" }]); assert.equal(r.j.stored, 1);
  assert.equal(db.prepare("SELECT customer_id c FROM bale_messages WHERE bale_msg_id='u-3'").get().c, 103, "after the link the chat lands in the customer's tab");
  r = await S(2, "POST", `/bale/unknown/${ux.id}/dismiss`); assert.equal(r.s, 200); r = await S(2, "POST", `/bale/unknown/${ux.id}/dismiss`); assert.equal(r.s, 404);
  r = await mock.inbound(API, REF, [{ messageId: "u-4", peerId: "p-x", text: "x" }]); assert.equal(r.j.stored, 0); assert.equal(bells(2, "bale-unknown"), 2, "dismissed: silent");
  assert.equal(db.prepare("SELECT count(*) n FROM bale_messages WHERE text IN ('ناشناس','باز هم من','مشتری دیگری','x')").get().n, 0);
  ok("(c) unknown sender: opaque peer only (no text/phone), one bell per chat, list/search own customers (masked phone), link → bale_contacts + audit, conflicts, dismiss");

  // ---- secrets / phones ----
  const dump1b = JSON.stringify(["bale_accounts", "bale_audit", "bale_outbox", "bale_contacts", "bale_reminder_messages", "site_notification_events", "assistant_events", "bale_unknown_chats"].map(x => db.prepare(`SELECT * FROM ${x}`).all()));
  for (const s of SECRETS) assert.ok(!dump1b.includes(s), "secret leaked");
  for (const p of ["09120000001", "09120000011", "09120000015", "9120000015", "09990000008"]) assert.ok(!dump1b.includes(p), `phone ${p} stored`);
  ok("1b: no session token, no customer phone in outbox / contacts / audit / bells / assistant events");
  console.log(`\nbale-fixture: ${passed} groups passed`);
} finally { srv.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

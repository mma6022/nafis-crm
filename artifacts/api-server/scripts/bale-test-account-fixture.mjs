// «حساب تستی» fixture: in-memory DB + MOCK sidecar on loopback. Fake 0999… numbers only — never a real number, never Bale, never SMS.
// Run: node scripts/run-bundled-fixture.mjs scripts/bale-test-account-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createBale, ensureBaleSchema } from "../src/lib/bale.ts";
import { createHttpBaleSidecar } from "../src/lib/bale-sidecar-client.ts";
import { openBaleSession, baleSessionAad } from "../src/lib/bale-crypto.ts";
import { startMockBaleSidecar } from "./bale-mock-sidecar.mjs";

// Capture everything the app prints, to prove the login code / 2FA password never reach a log.
const captured = [];
for (const k of ["log", "info", "warn", "error", "debug"]) { const o = console[k].bind(console); console[k] = (...a) => { captured.push(a.map(String).join(" ")); o(...a); }; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bale-test-fx-"));
const wfile = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c, { mode: 0o600 }); return p; };
const KEY = wfile("k1", crypto.randomBytes(32).toString("base64"));
const sidecarToken = crypto.randomBytes(32).toString("base64url"); const TOK = wfile("tok", sidecarToken);
const mock = await startMockBaleSidecar({ token: sidecarToken });
const ENV = { BALE_SESSION_KEY_FILE: KEY, BALE_SIDECAR_TOKEN_FILE: TOK, BALE_SIDECAR_URL: `http://127.0.0.1:${mock.port}` };

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,salesperson_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
INSERT INTO users VALUES(1,'admin','مدیر','admin',NULL,1),(2,'s.hasani','حسنی','salesperson',3,1),(3,'m.ghasemi','قاسمی','salesperson',4,1),(4,'reg','ثبت','registrar',NULL,1),
  (6,'trainee5','کارآموز','salesperson',5,1),(8,'m.kazemi','کاظمی','salesperson',6,1),(27,'t19','کارآموز۱۹','salesperson',19,1),(28,'t20','کارآموز۲۰','salesperson',20,1),
  (29,'hasani','ادمین۲۹','admin',NULL,1),(30,'acc','حسابدار','accountant',NULL,1),(31,'old','غیرفعال','salesperson',7,0),(32,'oldadmin','مدیر غیرفعال','admin',NULL,0);
INSERT INTO customers VALUES(100,'مشتری حسنی','09120000001',3,NULL),(105,'مشتری با فاصله','+98 912 000 0015',3,NULL);
CREATE TABLE site_notification_events(id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER,customer_name TEXT,owner_id INTEGER,resource_type TEXT,resource_id INTEGER,kind TEXT,title TEXT,body TEXT,permission TEXT,created_at TEXT,actor_key TEXT,recipient_user_id INTEGER);`);
ensureBaleSchema(db); ensureBaleSchema(db);

let clock = new Date("2026-10-26T07:00:00Z"); // 10:30 Tehran
const sidecar = createHttpBaleSidecar(() => ENV, { timeoutMs: 3000 });
const bale = createBale({ db, env: () => ENV, sidecar, now: () => clock, random: () => 0.5, actor: res => (res.locals.uid ? { id: res.locals.uid } : null) });
const app = express();
app.use(bale.internal);
app.use(express.json({ limit: "100kb" }));
app.use("/api", (req, res, next) => { res.locals.uid = Number(req.headers["x-user"] || 0); next(); }, bale.staff);
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r)); const port = srv.address().port;
const S = async (u, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { "content-type": "application/json", ...(u ? { "x-user": String(u) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const setting = k => db.prepare("SELECT value FROM bale_settings WHERE key=?").get(k)?.value;
const testAcc = () => db.prepare("SELECT * FROM bale_accounts WHERE kind='system_test'").get();
// The send route kicks a test tick itself; wait for it instead of reading its "busy".
const tick = async () => { for (let i = 0; i < 100; i++) { const t = (await bale.worker.tick()).test; if (t !== "busy") return t; await new Promise(r => setTimeout(r, 10)); } throw new Error("tick stuck"); };
const later = s => { clock = new Date(clock.getTime() + s * 1000); };
let passed = 0; const ok = n => { passed++; console.log("ok", n); };
// FAKE test numbers (0999 000 1xxx); 09990000008 = mock "no Bale account".
const T1 = "09990001001", T2 = "09990001002", T3 = "09990001003", T4 = "09990001004", NOBALE = "09990000008";
const CODE = "22222", PASS = "mock-2fa-Secret!";
try {
  /* ---------- defaults ---------- */
  assert.equal(setting("test_enabled"), "0"); assert.equal(setting("master_enabled"), "0");
  const cols = db.prepare("PRAGMA table_info(bale_accounts)").all().map(c => c.name); assert.ok(cols.includes("kind"));
  let r = await S(1, "GET", "/admin/bale/test"); assert.equal(r.s, 200); assert.equal(r.j.enabled, false); assert.equal(r.j.account, null); assert.deepEqual(r.j.allowlist, []);
  assert.equal(r.j.allowMax, 3); assert.equal(r.j.masterEnabled, false);
  r = await S(1, "POST", "/admin/bale/test/connect/start", { phone: "09990002000" }); assert.equal(r.s, 423); assert.equal(r.j.error, "test_disabled");
  assert.equal(mock.log.filter(l => l.path === "/v1/auth/start").length, 0);
  ok("defaults: test switch OFF, master OFF, no test account; connect refused (423) before the sidecar");

  /* ---------- roles: admin only; never 29, never trainees / experts / registrar / accountant / inactive ---------- */
  const routes = [["GET", "/admin/bale/test"], ["PUT", "/admin/bale/test/enabled", { enabled: true }], ["POST", "/admin/bale/test/allowlist", { phone: T1 }],
    ["DELETE", "/admin/bale/test/allowlist/1"], ["POST", "/admin/bale/test/connect/start", { phone: "09990002000" }], ["POST", "/admin/bale/test/connect/code", { code: CODE }],
    ["POST", "/admin/bale/test/connect/password", { password: PASS }], ["POST", "/admin/bale/test/connect/cancel"], ["POST", "/admin/bale/test/disconnect"],
    ["POST", "/admin/bale/test/send", { allowId: 1, text: "سلام" }]];
  for (const u of [0, 2, 3, 4, 6, 8, 27, 28, 29, 30, 31, 32]) for (const [m, p, b] of routes) {
    r = await S(u, m, p, b); assert.equal(r.s, 403, `user ${u} ${m} ${p}`); assert.equal(r.j.error, "forbidden");
  }
  assert.equal(setting("test_enabled"), "0"); assert.equal(db.prepare("SELECT count(*) n FROM bale_test_allowlist").get().n, 0);
  assert.ok(db.prepare("SELECT count(*) n FROM bale_audit WHERE outcome='forbidden' AND user_id=29").get().n >= routes.length, "29's attempts audited");
  assert.equal(mock.log.filter(l => l.path === "/v1/auth/start").length, 0);
  ok("roles: admin only — experts (2,3,8), registrar 4, trainees (6,27,28), 29, accountant, inactive users, anonymous → 403 on every route (audited)");

  /* ---------- switch ---------- */
  r = await S(1, "PUT", "/admin/bale/test/enabled", { enabled: true }); assert.equal(r.s, 200); assert.equal(r.j.enabled, true);
  assert.equal(setting("master_enabled"), "0", "test switch never touches the experts' master switch");
  ok("own test switch ON while the experts' master switch stays OFF");

  /* ---------- allowlist (admin-entered; max 3; never a customer; masked) ---------- */
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: "12345" }); assert.equal(r.s, 422); assert.equal(r.j.error, "phone_invalid");
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: "۰۹۱۲ ۰۰۰ ۰۰۰۱" }); assert.equal(r.s, 409); assert.equal(r.j.error, "customer_number");
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: "09120000015" }); assert.equal(r.s, 409, "customer stored as +98 with spaces"); assert.equal(r.j.error, "customer_number");
  for (const p of [T1, T2, NOBALE]) { r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: p }); assert.equal(r.s, 200, JSON.stringify(r.j)); }
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: "+98 999 000 1001" }); assert.equal(r.s, 409); assert.equal(r.j.error, "allowlist_full");
  assert.equal(r.j.message.includes("۳"), true);
  r = await S(1, "GET", "/admin/bale/test"); assert.deepEqual(r.j.allowlist.map(x => x.phoneMasked), ["0999•••01", "0999•••02", "0999•••08"]);
  const dumpAllow = JSON.stringify(db.prepare("SELECT * FROM bale_test_allowlist").all());
  for (const p of [T1, T2, NOBALE]) { assert.ok(!dumpAllow.includes(p), "allowlist numbers sealed"); assert.ok(!JSON.stringify(r.j).includes(p), "API never returns the full number"); }
  const [A1, A2, A3] = r.j.allowlist.map(x => x.id);
  r = await S(1, "DELETE", `/admin/bale/test/allowlist/${A3}`); assert.equal(r.s, 200); assert.equal(r.j.allowlist.length, 2);
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: T1 }); assert.equal(r.s, 409); assert.equal(r.j.error, "allowlist_duplicate");
  r = await S(1, "POST", "/admin/bale/test/allowlist", { phone: NOBALE }); assert.equal(r.s, 200); const A3b = r.j.allowlist.at(-1).id;
  ok("allowlist: admin-entered, max 3, duplicate / invalid / customer number refused, sealed in DB, masked in the API, removable");

  /* ---------- connect wizard: number → code → 2FA → connected (code / password never stored or logged) ---------- */
  r = await S(1, "POST", "/admin/bale/test/connect/start", { phone: "۰۹۹۹۰۰۰۲۰۰۰" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.flow.step, "code"); assert.equal(r.j.flow.phoneMasked, "0999•••00"); assert.ok(!JSON.stringify(r.j).includes("09990002000"));
  assert.equal(mock.log.findLast(l => l.path === "/v1/auth/start").body.accountRef, "system-test");
  r = await S(1, "POST", "/admin/bale/test/connect/code", { code: "00000" }); assert.equal(r.s, 422); assert.equal(r.j.error, "wrong_code");
  r = await S(1, "POST", "/admin/bale/test/connect/code", { code: CODE }); assert.equal(r.s, 200); assert.equal(r.j.flow.step, "password");
  r = await S(1, "POST", "/admin/bale/test/connect/password", { password: "wrong-pass-X" }); assert.equal(r.s, 422); assert.equal(r.j.error, "wrong_password");
  r = await S(1, "POST", "/admin/bale/test/connect/password", { password: "mock-2fa" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  assert.equal(r.j.account.status, "connected"); assert.equal(r.j.account.phoneMasked, "0999•••00"); assert.equal(r.j.flow, null);
  let ta = testAcc(); assert.equal(ta.user_id, 0); assert.equal(ta.salesperson_id, null); assert.equal(ta.kind, "system_test"); assert.equal(ta.mode, "off");
  const token = openBaleSession(ENV, ta.session_ct, baleSessionAad(ta.id, 0)).plaintext; assert.match(token, /^mock\./); assert.match(ta.session_ct, /^v1:/);
  assert.ok(!JSON.stringify(r.j).includes(token));
  r = await S(1, "POST", "/admin/bale/test/connect/start", { phone: "09990002000" }); assert.equal(r.s, 409); assert.equal(r.j.error, "already_connected");
  // Not an expert's account: invisible to the expert views and the admin expert list / account routes.
  r = await S(1, "GET", "/admin/bale"); assert.ok(!JSON.stringify(r.j.experts).includes("system_test")); assert.ok(r.j.experts.every(e => e.account == null));
  r = await S(1, "PUT", `/admin/bale/accounts/${ta.id}/mode`, { mode: "auto" }); assert.equal(r.s, 404);
  r = await S(2, "GET", "/bale/me"); assert.equal(r.j.account, null);
  ok("wizard: number → code (wrong code) → 2FA (wrong pass) → connected; owner = system (user 0, no salesperson, kind system_test); session sealed; masked number; hidden from expert routes");

  /* ---------- send: only allowlisted numbers ---------- */
  r = await S(1, "POST", "/admin/bale/test/send", { phone: "09990009999", text: "سلام" }); assert.equal(r.s, 403); assert.equal(r.j.error, "not_allowlisted");
  r = await S(1, "POST", "/admin/bale/test/send", { phone: "09120000001", text: "سلام" }); assert.equal(r.s, 403, "customer number refused"); assert.equal(r.j.error, "not_allowlisted");
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: 999, text: "سلام" }); assert.equal(r.s, 403); assert.equal(r.j.error, "not_allowlisted");
  r = await S(1, "POST", "/admin/bale/test/send", { customerId: 100, text: "سلام" }); assert.equal(r.s, 403);
  assert.equal(db.prepare("SELECT count(*) n FROM bale_audit WHERE action='test.send_request' AND outcome='not_allowlisted'").get().n, 4);
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "" }); assert.equal(r.s, 422); assert.equal(r.j.error, "empty");
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "وام نقدی می‌خواهید یا کالایی؟" }); assert.equal(r.s, 422); assert.equal(r.j.error, "loan_type_question");
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "x".repeat(1001) }); assert.equal(r.s, 422); assert.equal(r.j.error, "too_long");
  r = await S(1, "POST", "/admin/bale/test/send", { phone: "+98 999 000 1001", text: "پیام تستی ۱" }); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.queued.heldUntil, null);
  await new Promise(res => setTimeout(res, 50)); await tick();
  assert.equal(mock.sent.length, 1); assert.equal(mock.sent[0].phone, T1); assert.equal(mock.sent[0].accountRef, `acc-${ta.id}`);
  r = await S(1, "GET", "/admin/bale/test"); const m1 = r.j.messages.at(-1); assert.equal(m1.status, "sent"); assert.equal(m1.phoneMasked, "0999•••01");
  assert.ok(db.prepare("SELECT peer_id FROM bale_test_allowlist WHERE id=?").get(A1).peer_id, "peer id learned");
  assert.equal(db.prepare("SELECT count(*) n FROM bale_outbox").get().n, 0, "nothing in the customer outbox");
  ok("send: non-allowlisted / customer / unknown id refused (403, audited); same text filters; allowlisted → sent through the system account only");

  /* ---------- gap, caps, quiet hours ---------- */
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A2, text: "پیام تستی ۲ مبلغ ۵۰ میلیون" }); assert.equal(r.s, 200);
  assert.ok(r.j.queued.text.includes("بانک"), "amount disclaimer appended");
  assert.equal(await tick(), "gap", "random gap between messages");
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A2, text: "دوباره" }); assert.equal(r.s, 409); assert.equal(r.j.error, "already_pending");
  later(90); assert.equal(await tick(), "sent"); assert.equal(mock.sent.length, 2);
  db.prepare("UPDATE bale_settings SET value='2' WHERE key='per_hour'").run();
  later(90); r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "سوم" }); assert.equal(r.s, 429); assert.equal(r.j.error, "cap_hour");
  db.prepare("UPDATE bale_settings SET value='20' WHERE key='per_hour'").run();
  clock = new Date("2026-10-26T19:00:00Z"); // 22:30 Tehran = quiet
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "شبانه" }); assert.equal(r.s, 200); assert.ok(r.j.queued.heldUntil); assert.match(r.j.queued.message, /.+/);
  assert.equal(await tick(), "idle", "held until quiet hours end"); assert.equal(mock.sent.length, 2);
  clock = new Date("2026-10-27T05:05:00Z"); // 08:35 Tehran
  assert.equal(await tick(), "sent"); assert.equal(mock.sent.length, 3);
  ok("same rules as experts: random gap, one pending per number, per-hour cap, quiet hours hold, amount disclaimer");

  /* ---------- error mapping ---------- */
  later(200); r = await S(1, "POST", "/admin/bale/test/send", { allowId: A3b, text: "به شماره‌ی بی‌بله" }); await tick();
  r = await S(1, "GET", "/admin/bale/test"); let last = r.j.messages.at(-1);
  assert.equal(last.status, "failed"); assert.equal(last.error, "no_bale_account"); assert.match(last.errorMessage, /peer_not_found/);
  mock.state.blockedPhones.add(T2);
  later(200); await S(1, "POST", "/admin/bale/test/send", { allowId: A2, text: "تست بلاک" }); later(1); await tick();
  r = await S(1, "GET", "/admin/bale/test"); last = r.j.messages.at(-1); assert.equal(last.error, "peer_blocked"); assert.match(last.errorMessage, /تأییدنشده/);
  assert.equal(r.j.account.status, "connected", "peer_blocked does not stop the test account"); assert.equal(r.j.enabled, true);
  assert.ok(db.prepare("SELECT 1 FROM bale_audit WHERE action='test.send' AND outcome='peer_blocked' AND detail_json LIKE '%unverified%'").get());
  mock.state.blockedPhones.clear();
  mock.state.down = true; later(200); await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "سرویس قطع" }); later(1); await tick();
  r = await S(1, "GET", "/admin/bale/test"); last = r.j.messages.at(-1); assert.equal(last.status, "queued"); assert.equal(last.error, "sidecar_unavailable");
  mock.state.down = false; later(120); assert.equal(await tick(), "sent", "retried after the sidecar came back");
  mock.state.sendError = "rate_limited"; later(200); await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "محدودیت" }); later(1); await tick();
  r = await S(1, "GET", "/admin/bale/test"); last = r.j.messages.at(-1); assert.equal(last.error, "rate_limited"); assert.match(last.errorMessage, /rate_limited/);
  assert.equal(r.j.enabled, false, "rate_limited → test switch OFF"); assert.equal(r.j.account.stoppedReason, "rate_limited"); assert.equal(setting("master_enabled"), "0");
  assert.equal(db.prepare("SELECT count(*) n FROM site_notification_events").get().n, 0, "no bells to experts / customers");
  mock.state.sendError = null;
  r = await S(1, "PUT", "/admin/bale/test/enabled", { enabled: true }); assert.equal(r.j.enabled, true);
  mock.state.sendError = "account_banned"; later(200); await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "بن" }); later(1); await tick();
  ta = testAcc(); assert.equal(ta.status, "banned"); assert.equal(ta.session_ct, null); assert.equal(setting("test_enabled"), "0");
  r = await S(1, "GET", "/admin/bale/test"); assert.match(r.j.messages.at(-1).errorMessage, /account_banned/);
  mock.state.sendError = null;
  ok("error mapping: peer_not_found → no_bale_account; peer_blocked (unverified, account kept); sidecar down → retry; rate_limited / account_banned → test switch OFF (+ session cleared on ban), no bells, master untouched");

  /* ---------- reconnect (session_invalid path) + inbound ---------- */
  await S(1, "PUT", "/admin/bale/test/enabled", { enabled: true });
  later(3700); r = await S(1, "POST", "/admin/bale/test/connect/start", { phone: "09990002000" }); assert.equal(r.s, 200, JSON.stringify(r.j));
  r = await S(1, "POST", "/admin/bale/test/connect/code", { code: "11111" }); assert.equal(r.s, 200); assert.equal(r.j.account.status, "connected");
  ta = testAcc(); assert.equal(db.prepare("SELECT count(*) n FROM bale_accounts WHERE kind='system_test'").get().n, 1, "same row reused");
  const peerA1 = db.prepare("SELECT peer_id FROM bale_test_allowlist WHERE id=?").get(A1).peer_id;
  const base = `http://127.0.0.1:${port}`; const ref = `acc-${ta.id}`;
  const before = ta.inbound_ignored;
  db.prepare("UPDATE bale_test_allowlist SET peer_id=NULL WHERE id=?").run(A2); // number 2 not yet known by peer → matched by phone
  r = await mock.inbound(base, ref, [
    { messageId: "in-1", peerId: peerA1, text: "جواب از شماره‌ی تستی ۱", date: clock.getTime() },
    { messageId: "in-2", peerId: "p-unknown", peerPhone: T3, text: "غریبه: متن نباید ذخیره شود", date: clock.getTime() },
    { messageId: "in-3", peerId: "p-cust", peerPhone: "09120000001", text: "مشتری: متن نباید ذخیره شود", date: clock.getTime() },
    { messageId: "in-4", peerId: "p-new2", peerPhone: T2, text: "جواب از شماره‌ی ۲", date: clock.getTime() },
    { messageId: "in-1", peerId: peerA1, text: "تکراری", date: clock.getTime() },
  ]);
  assert.equal(r.s, 200); assert.equal(r.j.stored, 2); assert.equal(r.j.ignored, 2);
  ta = testAcc(); assert.equal(ta.inbound_ignored - before, 2);
  const dumpAll = JSON.stringify(db.prepare("SELECT * FROM bale_test_messages").all()) + JSON.stringify(db.prepare("SELECT * FROM bale_unknown_chats").all())
    + JSON.stringify(db.prepare("SELECT * FROM bale_messages").all()) + JSON.stringify(db.prepare("SELECT * FROM bale_audit").all());
  assert.ok(!dumpAll.includes("غریبه") && !dumpAll.includes("مشتری: متن") && !dumpAll.includes("p-unknown") && !dumpAll.includes("p-cust") && !dumpAll.includes(T3));
  assert.equal(db.prepare("SELECT count(*) n FROM bale_unknown_chats").get().n, 0); assert.equal(db.prepare("SELECT count(*) n FROM bale_messages").get().n, 0);
  r = await S(1, "GET", "/admin/bale/test"); const ins = r.j.messages.filter(m => m.direction === "in");
  assert.deepEqual(ins.map(m => [m.phoneMasked, m.status]), [["0999•••01", "received"], ["0999•••02", "received"]]);
  assert.equal(db.prepare("SELECT peer_id FROM bale_test_allowlist WHERE id=?").get(A2).peer_id, "p-new2", "peer learned from phone match");
  await S(1, "PUT", "/admin/bale/test/enabled", { enabled: false });
  r = await mock.inbound(base, ref, [{ messageId: "in-9", peerId: peerA1, text: "وقتی خاموش است" }]); assert.equal(r.j.stored, 0);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM bale_test_messages").all()).includes("وقتی خاموش است"));
  ok("inbound: allowlisted senders (by peer or phone) shown in the box; strangers & customers only counted (no text, no peer, no phone); dedupe; switch OFF → nothing stored");

  /* ---------- sessions follow the TEST switch only; expert master switch untouched ---------- */
  await bale._internal.outbox.syncSessions(true); assert.ok(!mock.attached.has(ref), "test OFF → test client closed");
  r = await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "خاموش" }); assert.equal(r.s, 423); assert.equal(r.j.error, "test_disabled");
  await S(1, "PUT", "/admin/bale/test/enabled", { enabled: true }); await bale._internal.outbox.syncSessions(true); assert.ok(mock.attached.has(ref), "test ON → attached though master OFF");
  assert.equal(setting("master_enabled"), "0");
  ok("sidecar client follows the test switch (attach / detach) while the master switch stays OFF");

  /* ---------- disconnect ---------- */
  later(200); await S(1, "POST", "/admin/bale/test/send", { allowId: A1, text: "در صف" });
  db.prepare("UPDATE bale_test_messages SET scheduled_at=? WHERE status IN ('queued','sending')").run(new Date(clock.getTime() + 3600_000).toISOString());
  db.prepare("UPDATE bale_test_messages SET status='queued' WHERE status='sending'").run();
  r = await S(1, "POST", "/admin/bale/test/disconnect"); assert.equal(r.s, 200); assert.equal(r.j.account.status, "disconnected"); assert.equal(r.j.remoteSignOut, "ok");
  ta = testAcc(); assert.equal(ta.session_ct, null); assert.ok(mock.log.some(l => l.path === "/v1/session/signout" && l.body.accountRef === ref));
  assert.equal(db.prepare("SELECT count(*) n FROM bale_test_messages WHERE status='queued'").get().n, 0);
  r = await S(1, "POST", "/admin/bale/test/disconnect"); assert.equal(r.s, 409);
  const acts = new Set(db.prepare("SELECT action FROM bale_audit WHERE action LIKE 'test.%'").all().map(x => x.action));
  for (const a of ["test.enabled_on", "test.enabled_off", "test.allow.add", "test.allow.remove", "test.connect.start", "test.connect.connected", "test.send_request", "test.send", "test.auto_stop", "test.inbound", "test.disconnect"])
    assert.ok(acts.has(a), `audit ${a}`);
  ok("«قطع اتصال»: remote sign-out, session wiped, queued test messages blocked; audit rows for every step");

  /* ---------- the code / 2FA password never in the DB or logs; numbers never in the DB in clear ---------- */
  const SEALED = new Set(["session_ct", "phone_ct"]);
  let dump = "";
  // Every bale_* table (customers hold fake 0912000000x numbers, which contain "00000" by themselves).
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bale%'").all())
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) dump += JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !SEALED.has(k)))) + "\n";
  for (const s of [CODE, "11111", "00000", "mock-2fa", "wrong-pass-X", token, T1, T2, NOBALE, "09990002000"]) {
    assert.ok(!dump.includes(s), `secret/number in DB: ${s.slice(0, 2)}…`);
    assert.ok(!captured.some(l => l.includes(s)), `secret/number in logs: ${s.slice(0, 2)}…`);
  }
  ok("login code, 2FA password, session token and full test numbers appear nowhere in the DB or in captured logs");
  console.log(`\nbale-test-account-fixture: ${passed} groups passed`);
} finally { srv.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

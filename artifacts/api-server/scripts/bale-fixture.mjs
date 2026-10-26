// Synthetic «حساب شخصی بله» 1a fixture: in-memory DB + MOCK sidecar on loopback. Never talks to Bale, never sends SMS.
// Run: node scripts/run-bundled-fixture.mjs scripts/bale-fixture.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import express from "express";
import { createBale, ensureBaleSchema, normalizeIranMobile, baleEligible, baleChatViewer } from "../src/lib/bale.ts";
import { createHttpBaleSidecar, isLoopbackUrl } from "../src/lib/bale-sidecar-client.ts";
import { sealBaleSession, openBaleSession, baleSessionAad } from "../src/lib/bale-crypto.ts";
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
INSERT INTO customers VALUES(100,'مشتری حسنی','09120000001',3,NULL),(101,'ادغام حسنی','09120000002',3,100),(110,'مشتری قاسمی','09120000003',4,NULL),(130,'مشتری کارآموز','09120000004',5,NULL);`);
ensureBaleSchema(db); ensureBaleSchema(db);
const cookie = db.prepare("PRAGMA schema_version").get().schema_version;
ensureBaleSchema(db);
assert.equal(db.prepare("PRAGMA schema_version").get().schema_version, cookie, "second start must not bump schema_version");

let clock = new Date("2026-10-26T07:00:00Z");
const sidecar = createHttpBaleSidecar(() => ENV, { timeoutMs: 3000 });
const bale = createBale({ db, env: () => ENV, sidecar, now: () => clock, actor: res => (res.locals.uid ? { id: res.locals.uid } : null) });
const app = express(); app.use(express.json({ limit: "100kb" }));
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
  r = await S(2, "GET", "/bale/customers/100/messages"); assert.equal(r.s, 200); assert.equal(r.j.messages.length, 2); assert.equal(r.j.readOnly, true);
  assert.equal(r.j.expert.name, "حسنی"); assert.equal(r.j.expert.connected, true);
  r = await S(1, "GET", "/bale/customers/100/messages"); assert.equal(r.s, 200); assert.equal(r.j.messages.length, 2);
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
  console.log(`\nbale-fixture: ${passed} groups passed`);
} finally { srv.close(); await mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

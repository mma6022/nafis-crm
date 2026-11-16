// crm-expert-intro-sms fixture. Section 1: core on a synthetic in-memory DB. Section 2 (EXPERT_INTRO_FIXTURE_DB): HTTP + hook on a
// throwaway DB copy. The provider is ALWAYS mocked (global fetch replaced); no SMS, no staff notifications, never touches live.
// Usage: [EXPERT_INTRO_FIXTURE_DB=/path/copy.db] node scripts/run-bundled-fixture.mjs scripts/expert-intro-sms-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const sent = []; let fetchMode = "ok";
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("fixture: non-local fetch blocked " + u.hostname);
  sent.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
  if (fetchMode === "reject") return new Response(JSON.stringify({ ok: false, error: "provider_rejected" }), { status: 502 });
  if (fetchMode === "throw") throw new Error("network");
  return new Response(JSON.stringify({ ok: true, data: { meta: { status: true }, data: { message_outbox_ids: [700000 + sent.length] } } }), { status: 200 });
};

let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const core = await import("../src/lib/expert-intro-sms-core.ts");
const R = core.REASONS;
const T = (s) => new Date(s);
const IN = T("2026-10-25T10:00:00+03:30"), LATE = T("2026-10-25T22:30:00+03:30"), EARLY = T("2026-10-26T06:00:00+03:30");

function synth() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE notification_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY, name TEXT, mobile TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT, salesperson_id INTEGER, mobile TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, salesperson_id INTEGER, merged_into_customer_id INTEGER);
    CREATE TABLE customer_priority_history(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, old_salesperson_id INTEGER, new_salesperson_id INTEGER);
    CREATE TABLE team_sales_transfer_snapshot(customer_id INTEGER, previous_salesperson_id INTEGER);`);
  for (const [id, n, m] of [[6, "کاظمی نمونه", "09120000006"], [3, "کارشناس الف", "09120000003"], [4, "کارشناس ب", null], [5, "کارآموز", null], [19, "کارآموز۲", null], [20, "کارآموز۳", null]])
    db.prepare("INSERT INTO salespersons(id,name,mobile) VALUES(?,?,?)").run(id, n, m);
  for (const [id, sp] of [[8, 6], [10, 3], [11, 4], [12, 5]]) db.prepare("INSERT INTO users(id,username,role,salesperson_id) VALUES(?,?, 'salesperson', ?)").run(id, "u" + id, sp);
  core.ensureExpertIntroSchema(db);
  core.setUserContactPhone(db, 10, "021-12345678"); // landline, 11 digits
  core.setUserContactPhone(db, 12, "09120000012");
  for (let i = 1; i <= 12; i++) db.prepare("INSERT INTO customers(id,phone,salesperson_id) VALUES(?,?,6)").run(i, `0935000${String(i).padStart(4, "0")}`);
  return db;
}
const q = (db, sql, ...a) => db.prepare(sql).all(...a);
const n = (db, sql, ...a) => Number(db.prepare(sql).get(...a).n);
const on = (db, c, o, nw, now = IN, ipp = true) => core.onSalespersonChange(db, { customerId: c, oldSalespersonId: o, newSalespersonId: nw, source: "promote", qualifierId: 6 }, { ippanelEnabled: ipp, now });
const enable = (db, code = "fxpattern1") => core.saveExpertIntroSettings(db, { enabled: true, patternCode: code });

await ok("template, params, phone normalisation, render", async () => {
  assert.equal(core.EXPERT_INTRO_TEMPLATE, "سلام %name%  عزیز از تماس شما با مجموعه نفیس سپاسگزاریم. به دلیل حجم بالای پیام‌های دریافتی، ممکن است پاسخگویی کمی زمان‌بر باشد. ممنون از صبوریتون. کارشناس شما: %sale_name% شماره تماس: %sale_mobile% با احترام، مجموعه نفیس");
  assert.deepEqual([core.EXPERT_INTRO_PARAM_CUSTOMER, core.EXPERT_INTRO_PARAM_NAME, core.EXPERT_INTRO_PARAM_PHONE], ["name", "sale_name", "sale_mobile"]);
  assert.equal(core.renderIntroText("", "الف", "02112345678"), "سلام مشتری  عزیز از تماس شما با مجموعه نفیس سپاسگزاریم. به دلیل حجم بالای پیام‌های دریافتی، ممکن است پاسخگویی کمی زمان‌بر باشد. ممنون از صبوریتون. کارشناس شما: الف شماره تماس: 02112345678 با احترام، مجموعه نفیس");
  assert.equal(core.customerParam("  "), "مشتری"); assert.equal(core.customerParam(null), "مشتری"); assert.equal(core.customerParam(" علی "), "علی");
  assert.equal(core.mobileKey("+98 912 000 0001"), "09120000001"); assert.equal(core.mobileKey("۰۹۱۲۰۰۰۰۰۰۱"), "09120000001");
  assert.equal(core.mobileKey("02112345678"), null);
  assert.equal(core.normalizeContactPhone("021 1234 5678"), "02112345678"); assert.equal(core.normalizeContactPhone(""), null);
  assert.equal(core.normalizeContactPhone("12"), undefined);
});
await ok("Tehran window 08:00–21:00, queued for next 08:00", async () => {
  assert.ok(core.inSendWindow(T("2026-10-25T08:00:00+03:30"))); assert.ok(!core.inSendWindow(T("2026-10-25T07:59:00+03:30")));
  assert.ok(core.inSendWindow(T("2026-10-25T20:59:00+03:30"))); assert.ok(!core.inSendWindow(T("2026-10-25T21:00:00+03:30")));
  assert.equal(core.nextSendTime(LATE).toISOString(), T("2026-10-26T08:00:00+03:30").toISOString());
  assert.equal(core.nextSendTime(EARLY).toISOString(), T("2026-10-26T08:00:00+03:30").toISOString());
  assert.equal(core.nextSendTime(IN).getTime(), IN.getTime());
});
await ok("switch OFF (default): hook writes nothing, tick sends nothing", async () => {
  const db = synth();
  assert.equal(core.getExpertIntroSettings(db).enabled, false);
  core.saveExpertIntroSettings(db, { patternCode: "fxpattern1" });
  assert.deepEqual(on(db, 1, 6, 3), { action: "none" });
  assert.equal(n(db, "SELECT count(*) n FROM expert_intro_sms"), 0); assert.equal(n(db, "SELECT count(*) n FROM expert_intro_sms_log"), 0);
  let calls = 0; await core.expertIntroTick(db, { send: async () => { calls++; return "1"; }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.equal(calls, 0);
});
await ok("trigger only qualifier → non-qualifier; skips logged with reasons", async () => {
  const db = synth(); enable(db);
  assert.equal(on(db, 1, 3, 4).action, "none"); // closer → closer: not a trigger
  assert.equal(on(db, 1, null, 3).action, "none"); assert.equal(on(db, 1, 3, 6).action, "none");
  assert.deepEqual(on(db, 2, 6, 5), { action: "skipped", reason: R.trainee });
  assert.deepEqual(on(db, 3, 6, 4), { action: "skipped", reason: R.noExpertPhone });
  db.prepare("INSERT INTO customer_priority_history(customer_id,old_salesperson_id,new_salesperson_id) VALUES(4,3,6)").run();
  assert.deepEqual(on(db, 4, 6, 3), { action: "skipped", reason: R.oldCustomer });
  db.prepare("INSERT INTO team_sales_transfer_snapshot VALUES(5,4)").run();
  assert.deepEqual(on(db, 5, 6, 3), { action: "skipped", reason: R.oldCustomer });
  db.prepare("UPDATE customers SET phone='09120000006' WHERE id=6").run(); // staff (Kazemi) number
  assert.deepEqual(on(db, 6, 6, 3), { action: "skipped", reason: R.testNumber });
  core.saveExpertIntroSettings(db, { blockedPhones: "09350000007" });
  assert.deepEqual(on(db, 7, 6, 3), { action: "skipped", reason: R.testNumber });
  db.prepare("UPDATE customers SET phone='123' WHERE id=8").run();
  assert.deepEqual(on(db, 8, 6, 3), { action: "skipped", reason: R.badCustomerPhone });
  assert.deepEqual(on(db, 9, 6, 3, IN, false), { action: "skipped", reason: R.ippanelOff });
  core.saveExpertIntroSettings(db, { patternCode: "" });
  assert.deepEqual(on(db, 10, 6, 3), { action: "skipped", reason: R.noPattern });
  assert.equal(n(db, "SELECT count(*) n FROM expert_intro_sms"), 0);
  assert.ok(n(db, "SELECT count(*) n FROM expert_intro_sms_log WHERE status='skipped'") >= 9);
});
await ok("queue → send once per (customer, expert); duplicate skipped; reassigned dropped", async () => {
  const db = synth(); enable(db);
  db.prepare("UPDATE customers SET salesperson_id=3 WHERE id IN (1,2)").run();
  db.prepare("UPDATE customers SET name='علی نمونه' WHERE id=1").run();
  assert.equal(on(db, 1, 6, 3).action, "queued");
  assert.deepEqual(on(db, 1, 6, 3), { action: "skipped", reason: R.duplicate });
  assert.equal(on(db, 2, 6, 3).action, "queued");
  db.prepare("UPDATE customers SET salesperson_id=4 WHERE id=2").run();
  const got = [];
  const r = await core.expertIntroTick(db, { send: async (a) => { got.push(a); return "555"; }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.equal(r.sent, 1); assert.equal(r.skipped, 1);
  assert.deepEqual(got, [{ recipient: "09350000001", patternCode: "fxpattern1", params: { name: "علی نمونه", sale_name: "کارشناس الف", sale_mobile: "02112345678" } }]);
  assert.equal(q(db, "SELECT status,provider_id FROM expert_intro_sms WHERE customer_id=1")[0].provider_id, "555");
  const r2 = await core.expertIntroTick(db, { send: async () => { throw new Error("must not"); }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.equal(r2.sent, 0);
  assert.deepEqual(on(db, 1, 6, 3), { action: "skipped", reason: R.duplicate });
  assert.deepEqual(core.customerIntroLog(db, 1).map((x) => x.status), ["skipped", "sent", "skipped", "queued"]);
});
await ok("outside hours: queued with deferred reason, waits, sends after 08:00", async () => {
  const db = synth(); enable(db); db.prepare("UPDATE customers SET salesperson_id=3 WHERE id=1").run();
  assert.equal(on(db, 1, 6, 3, LATE).action, "queued");
  assert.equal(core.customerIntroLog(db, 1)[0].reason, R.deferred);
  let c = 0; const send = async () => { c++; return "9"; };
  assert.equal((await core.expertIntroTick(db, { send, now: () => EARLY, qualifierId: 6, ippanelEnabled: () => true })).waiting, 1);
  assert.equal(c, 0);
  assert.equal((await core.expertIntroTick(db, { send, now: () => T("2026-10-26T08:00:30+03:30"), qualifierId: 6, ippanelEnabled: () => true })).sent, 1);
});
await ok("failed / uncertain logged and never auto-retried; switch OFF drops the queue", async () => {
  const db = synth(); enable(db); db.prepare("UPDATE customers SET salesperson_id=3 WHERE id IN (1,2,3)").run();
  on(db, 1, 6, 3); on(db, 2, 6, 3);
  let c = 0;
  await core.expertIntroTick(db, { send: async (a) => { c++; throw new Error(a.recipient.endsWith("1") ? "sms_provider_rejected" : "sms_delivery_unknown"); }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.deepEqual(q(db, "SELECT status FROM expert_intro_sms ORDER BY customer_id").map((x) => x.status), ["failed", "uncertain"]);
  await core.expertIntroTick(db, { send: async () => { c++; return "1"; }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.equal(c, 2);
  assert.equal(on(db, 2, 6, 3).reason, R.duplicate); // uncertain blocks
  on(db, 3, 6, 3); core.saveExpertIntroSettings(db, { enabled: false });
  const r = await core.expertIntroTick(db, { send: async () => { c++; return "1"; }, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
  assert.equal(r.skipped, 1); assert.equal(c, 2); assert.equal(core.customerIntroLog(db, 3)[0].reason, R.disabled);
});
await ok("relay sender: HMAC headers, pattern payload, strict parse, localhost only", async () => {
  const f = []; const fetcher = async (u, i) => { f.push({ u: String(u), i }); return new Response(JSON.stringify({ ok: true, data: { meta: { status: true }, data: { message_outbox_ids: [42] } } })); };
  const id = await core.sendPatternViaRelay({ recipient: "09350000001", patternCode: "fxp", params: { sale_name: "x", sale_mobile: "02112345678" } }, { relayUrl: "http://127.0.0.1:1/send", fromNumber: "+983000000", secret: "fixture-only", fetcher });
  assert.equal(id, "42"); const b = JSON.parse(f[0].i.body);
  assert.deepEqual(b, { sending_type: "pattern", from_number: "+983000000", code: "fxp", recipients: ["+989350000001"], params: { sale_name: "x", sale_mobile: "02112345678" } });
  assert.match(f[0].i.headers["X-Relay-Signature"], /^[0-9a-f]{64}$/);
  await assert.rejects(core.sendPatternViaRelay({ recipient: "09350000001", patternCode: "fxp", params: {} }, { relayUrl: "http://example.com/send", fromNumber: "x", secret: "s", fetcher }), /sms_relay_not_configured/);
  await assert.rejects(core.sendPatternViaRelay({ recipient: "09350000001", patternCode: "fxp", params: {} }, { relayUrl: "http://127.0.0.1:1/send", fromNumber: "x", fetcher }), /sms_relay_not_configured/);
  const bad = async () => new Response(JSON.stringify({ ok: true, data: { meta: { status: false } } }));
  await assert.rejects(core.sendPatternViaRelay({ recipient: "09350000001", patternCode: "fxp", params: {} }, { relayUrl: "http://127.0.0.1:1/send", fromNumber: "x", secret: "s", fetcher: bad }), /sms_provider_rejected/);
  const junk = async () => new Response("nope");
  await assert.rejects(core.sendPatternViaRelay({ recipient: "09350000001", patternCode: "fxp", params: {} }, { relayUrl: "http://127.0.0.1:1/send", fromNumber: "x", secret: "s", fetcher: junk }), /sms_delivery_unknown/);
  assert.equal(f.length, 1);
});
await ok("settings validation", async () => {
  const db = synth();
  assert.throws(() => core.saveExpertIntroSettings(db, { enabled: "yes" }), /سوییچ/);
  assert.throws(() => core.saveExpertIntroSettings(db, { patternCode: "bad code!" }), /الگو/);
  assert.throws(() => core.saveExpertIntroSettings(db, { blockedPhones: "0912" }), /معتبر/);
  assert.throws(() => core.setUserContactPhone(db, 10, "abc"), /شماره تماس/);
  assert.equal(core.getExpertIntroSettings(db).enabled, false);
});

const src = process.env.EXPERT_INTRO_FIXTURE_DB;
if (!src) { console.log(`SKIP DB section (set EXPERT_INTRO_FIXTURE_DB). expert-intro-sms fixture: ${passed} passed`); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expert-intro-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath; process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
process.env.IR_RELAY_SHARED_SECRET = "fixture-only-not-a-secret";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, queryRows, execute } = db;
  const glue = await import("../src/lib/expert-intro-sms.ts");
  const ts = await import("../src/lib/team-sales.ts");
  const express = (await import("express")).default;
  const router = (await import("../src/routes/expert-intro-sms.ts")).default;
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: [], customerScope: "all" },
    sales: { id: 9001, role: "salesperson", salespersonId: 3, fullName: "s", permissions: ["customers.view"], customerScope: "assigned" },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", router);
  const sock = path.join(dir, "api.sock"); server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor ?? "", ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  const settingsBefore = queryRows("SELECT key,value FROM notification_settings WHERE key='team_sales_config'");

  await ok("migration on the copy: tables + users.customer_contact_phone; switch OFF by default", async () => {
    assert.ok(queryRows("PRAGMA table_info(users)").some((c) => c.name === "customer_contact_phone"));
    for (const t of ["expert_intro_sms", "expert_intro_sms_log"]) assert.ok(queryRow("SELECT 1 x FROM sqlite_master WHERE name=?", [t]));
    const r = await call("GET", "/expert-intro-sms/settings", "admin");
    assert.equal(r.status, 200); assert.equal(r.body.enabled, false); assert.equal(r.body.provider, "IPPanel");
    assert.equal(r.body.template, core.EXPERT_INTRO_TEMPLATE); assert.equal(typeof r.body.relayConfigured, "boolean");
    assert.ok(Array.isArray(r.body.experts) && r.body.experts.length > 0);
  });
  await ok("admin only: non-admin 403, anonymous 401", async () => {
    for (const [m, u, b] of [["GET", "/expert-intro-sms/settings"], ["PUT", "/expert-intro-sms/settings", { enabled: true }], ["POST", "/expert-intro-sms/test-send", { phone: "09350000001", expertName: "x", expertPhone: "02112345678" }], ["PUT", "/users/1/customer-contact-phone", { phone: "02112345678" }], ["GET", "/expert-intro-sms/user-phones"]]) {
      assert.equal((await call(m, u, "sales", b)).status, 403, u); assert.equal((await call(m, u, null, b)).status, 401, u);
    }
    assert.equal((await call("GET", "/expert-intro-sms/settings", "admin")).body.enabled, false);
    assert.equal(sent.length, 0);
  });
  await ok("hook with switch OFF writes nothing (real logPriorityChange path)", async () => {
    const c = queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1");
    const before = Number(queryRow("SELECT count(*) n FROM expert_intro_sms_log").n);
    ts.logPriorityChange({ customerId: c.id, oldSalespersonId: 6, newSalespersonId: 3, oldPriority: null, newPriority: null, actorUserId: null, source: "customer_update", reason: "fixture" });
    assert.equal(Number(queryRow("SELECT count(*) n FROM expert_intro_sms_log").n), before);
    assert.equal(Number(queryRow("SELECT count(*) n FROM expert_intro_sms").n), 0);
  });
  await ok("test-send (mocked provider): placeholder expert, number never stored", async () => {
    const fx = "09350009999";
    assert.equal((await call("POST", "/expert-intro-sms/test-send", "admin", { phone: fx, expertName: "کارشناس تست", expertPhone: "02112345678" })).status, 400); // no pattern yet
    assert.equal((await call("PUT", "/expert-intro-sms/settings", "admin", { patternCode: "fxpattern1" })).status, 200);
    const r = await call("POST", "/expert-intro-sms/test-send", "admin", { phone: fx, expertName: "کارشناس تست", expertPhone: "02112345678" });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.providerId, /^\d+$/);
    assert.equal(sent.length, 1); assert.deepEqual(sent[0].body.recipients, ["+989350009999"]);
    assert.deepEqual(sent[0].body.params, { name: "مشتری", sale_name: "کارشناس تست", sale_mobile: "02112345678" });
    assert.equal(sent[0].body.code, "fxpattern1"); assert.ok(r.body.text.includes("سلام مشتری  عزیز") && r.body.text.includes("کارشناس شما: کارشناس تست شماره تماس: 02112345678"));
    assert.equal((await call("POST", "/expert-intro-sms/test-send", "admin", { phone: fx, expertName: "کارشناس تست", expertPhone: "02112345678" })).status, 429);
    assert.equal(sent.length, 1);
    const dump = JSON.stringify(queryRows("SELECT * FROM expert_intro_sms_log")) + JSON.stringify(queryRows("SELECT * FROM notification_settings"));
    for (const v of [fx, "9350009999", "0009999", "9999"]) assert.ok(!dump.includes(v), "number leaked: " + v);
    assert.equal(queryRow("SELECT value FROM notification_settings WHERE key='expert_intro_sms_enabled'"), undefined);
  });
  await ok("user field «شماره تماس برای مشتری»: admin sets / clears / rejects bad", async () => {
    const u = queryRow("SELECT id FROM users WHERE salesperson_id=3 AND active=1 ORDER BY (role='salesperson') DESC, id LIMIT 1");
    assert.equal((await call("PUT", `/users/${u.id}/customer-contact-phone`, "admin", { phone: "۰۲۱-۱۲۳۴۵۶۷۸" })).body.phone, "02112345678");
    assert.equal((await call("PUT", `/users/${u.id}/customer-contact-phone`, "admin", { phone: "12" })).status, 400);
    assert.equal((await call("GET", "/expert-intro-sms/user-phones", "admin")).body.find((x) => x.userId === u.id).phone, "02112345678");
    assert.equal((await call("PUT", "/users/999999/customer-contact-phone", "admin", { phone: "" })).status, 404);
  });
  await ok("switch ON (copy only): Kazemi → closer queues; tick sends via mocked relay; customer history", async () => {
    assert.equal((await call("PUT", "/expert-intro-sms/settings", "admin", { enabled: true })).body.enabled, true);
    const pick = queryRows(`SELECT c.id FROM customers c WHERE c.salesperson_id=6 AND c.merged_into_customer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM customer_priority_history h WHERE h.customer_id=c.id) AND NOT EXISTS (SELECT 1 FROM team_sales_transfer_snapshot s WHERE s.customer_id=c.id) ORDER BY c.id LIMIT 1`)[0];
    assert.ok(pick);
    execute("UPDATE customers SET phone='09350001234', salesperson_id=3 WHERE id=?", [pick.id]);
    ts.logPriorityChange({ customerId: pick.id, oldSalespersonId: 6, newSalespersonId: 3, oldPriority: null, newPriority: null, actorUserId: null, source: "promote", reason: null });
    assert.equal(queryRow("SELECT status FROM expert_intro_sms WHERE customer_id=?", [pick.id]).status, "queued");
    execute("UPDATE expert_intro_sms SET created_at=?, next_attempt_at=? WHERE customer_id=?", [IN.toISOString(), IN.toISOString(), pick.id]);
    const before = sent.length;
    const r = await core.expertIntroTick((await import("../src/lib/crm-db.ts")).crmDb, { send: glue.sendExpertIntroPattern, now: () => IN, qualifierId: 6, ippanelEnabled: () => true });
    assert.equal(r.sent, 1); assert.equal(sent.length, before + 1); assert.deepEqual(sent.at(-1).body.recipients, ["+989350001234"]);
    const h = await call("GET", `/customers/${pick.id}/expert-intro-sms`, "admin");
    assert.deepEqual(h.body.map((x) => x.status), ["sent", "queued"]);
    assert.equal((await call("GET", `/customers/${pick.id}/expert-intro-sms`, "sales")).status, 200);
    await call("PUT", "/expert-intro-sms/settings", "admin", { enabled: false });
  });
  await ok("team_sales_config untouched; all sends were mocked to localhost", async () => {
    assert.deepEqual(queryRows("SELECT key,value FROM notification_settings WHERE key='team_sales_config'"), settingsBefore);
    assert.ok(sent.every((s) => new URL(s.url).hostname === "127.0.0.1"));
  });
  console.log(`expert-intro-sms fixture: ${passed} passed`);
} finally {
  server?.close(); fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

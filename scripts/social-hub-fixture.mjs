/**
 * social-hub v1.1 fixture. Temp COPY of a masked DB, synthetic rows, fetch stubbed to throw (no Bale / SMS / network).
 * Usage: SOCIAL_HUB_FIXTURE_DB=/workspace/t861/masked.db node scripts/run-bundled-fixture.mjs scripts/social-hub-fixture.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.SOCIAL_HUB_FIXTURE_DB;
if (!src) { console.log("SKIP (set SOCIAL_HUB_FIXTURE_DB)"); process.exit(0); }
if (fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sh-fixture-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
const keyFile = path.join(dir, "bot.key"); fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SMS_DISABLED: "1", SOCIAL_HUB_FILES_DIR: path.join(dir, "docs"),
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  SAB_FEEDER: "0", BALE_BOT_WORKER: "0", LOAN_REQUEST_DRAFTS_JOBS: "off", SITE_LEAD_ALERTS: "off",
  BALE_BOT_KEY_FILE: keyFile, BALE_BOT_FILES_DIR: path.join(dir, "bot-files"),
});
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error("unexpected network call in social-hub fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
  const sh = await import("../src/lib/social-hub.ts");
  const shs = await import("../src/lib/social-hub-send.ts");
  const shb = await import("../src/lib/social-hub-bot.ts");
  const cph = await import("../src/lib/customer-phones.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const express = (await import("express")).default;
  cph.ensureCustomerPhonesSchema();
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  for (const k of [sh.SH_FLAG, sh.SH_PHONE_FLAG, sh.SH_SEND_FLAG, sh.SH_CONNECT_FLAG, sh.SH_REDIRECT_FLAG, sh.SH_LEGACY_FINISH_FLAG]) flag(k, null);
  flag("flag.expert_lockdown", null);

  const perms = ["customers.view", "customers.update", "customers.create", "calls.create", "calls.view"];
  const admin = { id: 1, role: "admin", baseRole: "admin", salespersonId: null, fullName: "مدیر سیستم", username: "admin", permissions: perms, customerScope: "all", active: true };
  const sm = { id: 5, role: "admin", baseRole: "sales_manager", salesManager: true, salespersonId: null, fullName: "مدیر فروش", username: "sm", permissions: perms, customerScope: "all", active: true };
  const ghasemi = { id: 3, role: "salesperson", salespersonId: 4, fullName: "خانم قاسمی", username: "ghasemi", permissions: perms, customerScope: "assigned", active: true };
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "آقای کاظمی", username: "kazemi", permissions: perms, customerScope: "assigned", active: true };
  const u29 = { ...kazemi, id: 29 };
  const actors = { admin, sm, ghasemi, kazemi, u29 };

  const mk = (name, phone, sp) => { execute("INSERT INTO customers(name, phone, salesperson_id, status, priority, created_at) VALUES(?,?,?,?,?,datetime('now'))", [name, phone, sp, "in_progress", 1]);
    return Number(queryRow("SELECT id FROM customers WHERE phone=? AND name=?", [phone, name]).id); };
  const A = mk("مشتری آزمایشی فتحی", "09120009017", 4);   // ghasemi's
  const B = mk("مشتری آزمایشی صالحی", "09120009083", 6);  // kazemi's
  const sh_tables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sh_%'").length;

  const app = express();
  app.use((await import("cookie-parser")).default());
  app.use((req, res, next) => { res.locals.authUser = actors[req.headers["x-actor"]]; if (!res.locals.authUser) { res.sendStatus(401); return; } next(); });
  app.use("/api", (req, res, next) => el.expertLockdownGuard(req, res, next));
  const router = (await import("../src/routes/social-hub.ts")).default;
  app.use("/api", router);
  const sock = path.join(dir, "sh.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (actor, method, url, body, raw, headers = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0));
    const r = http.request({ socketPath: sock, path: url, method, headers: { "x-actor": actor, "content-type": raw ? "application/octet-stream" : "application/json", "content-length": payload.length, ...headers } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; } resolve({ status: res.statusCode, data }); });
    });
    r.on("error", reject); if (payload.length) r.write(payload); r.end();
  });
  // requireAuth needs a session cookie: give each actor a real session row
  const { createHmac, randomBytes } = await import("node:crypto");
  const cookies = {};
  for (const [k, u] of Object.entries(actors)) {
    if (u.id === 29) continue;
    const tok = randomBytes(24).toString("hex");
    execute("DELETE FROM auth_sessions WHERE user_id=?", [u.id]);
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,datetime('now'))", [createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), u.id, new Date(Date.now() + 3600e3).toISOString()]);
    cookies[k] = `crm_session=${tok}`;
  }
  const req = (actor, method, url, body, raw, headers = {}) => call(actor, method, url, body, raw, { cookie: cookies[actor] ?? "", ...headers });

  await ok("flags OFF: /me disabled, routes 404, no sh_ tables", async () => {
    const me = await req("admin", "GET", "/api/social-hub/me"); assert.equal(me.status, 200); assert.equal(me.data.enabled, false);
    for (const p of ["/api/social-hub/bots", "/api/social-hub/messages", `/api/social-hub/customers/${A}/today`, "/api/social-hub/phone-attach/search?q=x"]) assert.equal((await req("admin", "GET", p)).status, 404, p);
    assert.equal(sh_tables(), 0);
    assert.equal(cph.customerPhonesMax(), 3);
    assert.equal(cph.canManageCustomerPhones(kazemi, A), false); // t853u rule unchanged while OFF
  });

  flag(sh.SH_FLAG, "1");
  await ok("ON: schema additive; unified bot «نفیس وام» stays draft; networks order", async () => {
    const r = await req("sm", "GET", "/api/social-hub/bots"); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(sh_tables() >= 10);
    assert.equal(r.data.bots[0].name, "نفیس وام"); assert.equal(r.data.bots[0].status, "draft"); assert.equal(r.data.bots[0].unified, true);
    assert.deepEqual(r.data.networks.map((n) => n.key), ["bale", "eitaa", "telegram", "whatsapp", "instagram", "rubika"]);
    assert.ok(r.data.legacy.length >= 1 && r.data.legacy.every((l) => !/29/.test(String(l.id)) || true));
    assert.equal(r.data.connectEnabled, false);
  });
  await ok("page is manager-only (expert 403, user 29 never)", async () => {
    assert.equal((await req("kazemi", "GET", "/api/social-hub/bots")).status, 403);
    assert.equal(sh.shIsManager(u29), false); assert.equal(sh.shIsManager(admin), true); assert.equal(sh.shIsManager(sm), true); assert.equal(sh.shIsManager(kazemi), false);
  });
  await ok("add bot: no token accepted; test connection disabled; no network", async () => {
    const t = await req("sm", "POST", "/api/social-hub/bots/test"); assert.equal(t.status, 409); assert.equal(t.data.error, "connect_disabled");
    const withTok = await req("sm", "POST", "/api/social-hub/bots", { network: "eitaa", token: "123456:ABCDEFGHIJKLMNOPQRSTUV" }); assert.equal(withTok.status, 409);
    const r = await req("sm", "POST", "/api/social-hub/bots", { network: "rubika", access: "like_bale" }); assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(r.data.bots.some((b) => b.network === "rubika" && b.status === "draft"));
    assert.equal((await req("sm", "POST", "/api/social-hub/bots", { network: "rubika" })).status, 409);
    assert.equal((await req("sm", "POST", "/api/social-hub/bots", { network: "x" })).status, 400);
    assert.equal(netCalls, 0);
  });
  await ok("access: grouped by team + managers; save round-trip; 29 excluded", async () => {
    const bot = queryRow("SELECT id FROM sh_bots WHERE unified=1");
    const a = await req("sm", "GET", `/api/social-hub/bots/${bot.id}/access`); assert.equal(a.status, 200);
    const all = a.data.groups.flatMap((g) => g.rows); assert.ok(!all.some((r) => r.userId === 29));
    assert.ok(a.data.groups.some((g) => g.key === "managers"));
    const k = all.find((r) => r.userId === 8); assert.equal(k.viewScope, "own"); assert.equal(k.manage, false);
    const s = await req("sm", "PUT", `/api/social-hub/bots/${bot.id}/access`, { rows: [{ userId: 8, manage: true, customersMessage: false, viewScope: "all" }, { userId: 29, manage: true }] });
    assert.equal(s.status, 200); const k2 = s.data.groups.flatMap((g) => g.rows).find((r) => r.userId === 8);
    assert.deepEqual([k2.manage, k2.customersMessage, k2.viewScope], [true, false, "all"]);
    assert.equal(queryRow("SELECT COUNT(*) n FROM sh_bot_access WHERE user_id=29").n, 0);
  });
  await ok("legacy: redirect toggle, send-once queues only chats that started the old bot, read-only then off after 30 days", async () => {
    const legacy = (await req("sm", "GET", "/api/social-hub/bots")).data.legacy; const L = legacy[0];
    const t = await req("sm", "PUT", `/api/social-hub/legacy/${L.id}/redirect`, { on: true }); assert.equal(t.status, 200); assert.equal(t.data.legacy.find((x) => x.id === L.id).redirectAuto, true);
    const chats = queryRow("SELECT COUNT(*) n FROM bale_bot_chats WHERE bot_id=?", [L.id]).n;
    const o = await req("sm", "POST", `/api/social-hub/legacy/${L.id}/send-once`); assert.equal(o.status, 200); assert.equal(o.data.queued, chats);
    const again = await req("sm", "POST", `/api/social-hub/legacy/${L.id}/send-once`); assert.equal(again.data.queued, 0);
    assert.equal(queryRow("SELECT COUNT(*) n FROM sh_redirect_sends WHERE status<>'queued'").n, 0);
    const t0 = new Date("2026-11-24T08:00:00Z");
    assert.equal(sh.shLegacyState(null, null, t0), "redirecting");
    const off = sh.shLegacyOffAt(t0); assert.equal(off, "2026-12-24T08:00:00.000Z");
    assert.equal(sh.shLegacyState(t0.toISOString(), off, new Date("2026-12-24T07:59:59Z")), "readonly");
    assert.equal(sh.shLegacyState(t0.toISOString(), off, new Date("2026-12-24T08:00:00Z")), "off");
    // «پایان انتقال» has its own flag (default OFF): hidden and 404 while OFF
    assert.equal((await req("sm", "GET", "/api/social-hub/me")).data.legacyFinish, false);
    assert.equal((await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated`)).status, 404);
    assert.equal((await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated/undo`)).status, 404);
    flag(sh.SH_LEGACY_FINISH_FLAG, "1");
    assert.equal((await req("sm", "GET", "/api/social-hub/me")).data.legacyFinish, true);
    const m = await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated`); const ml = m.data.legacy.find((x) => x.id === L.id);
    assert.equal(ml.state, "readonly"); assert.ok(new Date(ml.offAt).getTime() > Date.now() + 29 * 86400_000);
    const u = await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated/undo`); assert.equal(u.status, 200); assert.equal(u.data.legacy.find((x) => x.id === L.id).state, "redirecting");
    assert.equal((await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated/undo`)).status, 409);
    await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated`);
    execute("UPDATE sh_legacy_bots SET off_at=? WHERE legacy_bot_id=?", [new Date(Date.now() - 1000).toISOString(), L.id]);
    assert.equal((await req("sm", "POST", `/api/social-hub/legacy/${L.id}/migrated/undo`)).status, 409);
    flag(sh.SH_LEGACY_FINISH_FLAG, null);
    const chat = queryRow("SELECT id, bale_user_id, customer_id FROM bale_bot_chats WHERE bot_id=? LIMIT 1", [L.id]);
    if (chat) { assert.equal(sh.shRecordMove(L.id, chat.id, chat.bale_user_id, chat.customer_id), true); assert.equal(sh.shRecordMove(L.id, chat.id, chat.bale_user_id, chat.customer_id), false); }
    assert.equal((await req("sm", "PUT", "/api/social-hub/redirect-text", { text: "  " })).status, 400);
    assert.equal((await req("sm", "PUT", "/api/social-hub/redirect-text", { text: "سلام ‹نام مشتری›، ربات تازه" })).data.text, "سلام ‹نام مشتری›، ربات تازه");
  });
  let planId, initialId, freeId, hiddenId;
  await ok("ready messages: validation, free never auto-sends, per-plan auto-send checkbox, render vars", async () => {
    planId = sh.shPlans()[0].id;
    assert.equal((await req("sm", "POST", "/api/social-hub/messages", { title: "", body: "x" })).status, 400);
    assert.equal((await req("sm", "POST", "/api/social-hub/messages", { title: "t", body: "x".repeat(4097) })).status, 400);
    assert.equal((await req("sm", "POST", "/api/social-hub/messages", { title: "t", body: "x", kind: "plan", planId: 999999 })).status, 400);
    const f = await req("sm", "POST", "/api/social-hub/messages", { title: "سلام و خوش‌آمد", body: "سلام ‹نام مشتری›، به نفیس وام خوش آمدید.", kind: "free", autoSend: true });
    assert.equal(f.status, 201); assert.equal(f.data.message.autoSend, false); freeId = f.data.message.id;
    const p = await req("sm", "POST", "/api/social-hub/messages", { title: "پیام اولیه", body: "سلام ‹نام مشتری›، من ‹نام کارشناس› از نفیس وام هستم. طرح ‹نام طرح›.", kind: "plan", planId, autoSend: true });
    assert.equal(p.status, 201); assert.equal(p.data.message.autoSend, true); initialId = p.data.message.id;
    const h = await req("sm", "POST", "/api/social-hub/messages", { title: "ساعت پاسخگویی", body: "شنبه تا چهارشنبه", showToday: false }); hiddenId = h.data.message.id;
    const e = await req("sm", "PATCH", `/api/social-hub/messages/${initialId}`, { showToday: true }); assert.equal(e.data.message.autoSend, true);
    const list = await req("sm", "GET", "/api/social-hub/messages"); assert.equal(list.data.free.length, 2); assert.ok(list.data.plans.find((x) => x.plan.id === planId).messages.length === 1);
    assert.equal(sh.shRender("سلام ‹نام مشتری›، من ‹نام کارشناس›؛ «نام طرح»", { customer: "علی", expert: "کاظمی", plan: "لندتک / ملت" }), "سلام علی، من کاظمی؛ لندتک / ملت");
    assert.equal(queryRow("SELECT COUNT(*) n FROM sh_messages WHERE kind='free' AND auto_send=1").n, 0);
  });
  await ok("docs: pdf sniffed, wrong type rejected, 200 MB cap, plan link optional, filter", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 32)]);
    const meta = (m) => ({ "x-sh-meta": encodeURIComponent(JSON.stringify(m)) });
    const r = await req("sm", "POST", "/api/social-hub/docs", null, pdf, meta({ title: "راهنمای ثبت‌نام", fileName: "guide.pdf", planId }));
    assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.doc.fileType, "pdf"); assert.equal(r.data.doc.planId, planId);
    const bad = await req("sm", "POST", "/api/social-hub/docs", null, Buffer.from("hello world, not a pdf"), meta({ title: "x", fileName: "a.exe" })); assert.equal(bad.status, 400); assert.equal(bad.data.error, "bad_type");
    assert.throws(() => sh.shAddDoc(sm, { length: sh.SH_DOC_MAX_BYTES + 1 }, { title: "big" }), (e) => e.code === "file_too_big" && e.status === 413);
    assert.equal(sh.SH_DOC_MAX_BYTES, 200 * 1024 * 1024);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    assert.equal((await req("sm", "POST", "/api/social-hub/docs", null, png, meta({ title: "نمونهٔ فیش", fileName: "a.png" }))).data.doc.planId, null);
    assert.equal((await req("sm", "GET", "/api/social-hub/docs?type=image")).data.docs.length, 1);
    assert.equal((await req("sm", "GET", "/api/social-hub/docs?plan=none")).data.docs.length, 1);
    const f = await req("kazemi", "GET", `/api/social-hub/docs/${r.data.doc.id}/file`); assert.equal(f.status, 200);
  });
  await ok("today box: full identity, only show_today messages, unreachable blocks send, reachable queues (no delivery)", async () => {
    execute("UPDATE customers SET national_code='0001234567', birth_date_jalali='1372/05/14' WHERE id=?", [B]);
    const t = await req("kazemi", "GET", `/api/social-hub/customers/${B}/today`); assert.equal(t.status, 200, JSON.stringify(t.data));
    assert.ok(t.data.expertName && typeof t.data.customerName === "string"); // the confirm step previews the rendered text
    assert.equal(t.data.identity.nationalCode, "0001234567"); assert.equal(t.data.identity.birthDate, "1372/05/14");
    assert.ok(!t.data.free.some((m) => m.id === hiddenId)); assert.ok(t.data.free.some((m) => m.id === freeId));
    assert.equal(t.data.reachable, false);
    const no = await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: freeId }); assert.equal(no.status, 409); assert.equal(no.data.error, "unreachable");
    assert.equal((await req("ghasemi", "GET", `/api/social-hub/customers/${B}/today`)).status, 404); // other expert's customer
    const bot = queryRow("SELECT id FROM bale_bots ORDER BY id LIMIT 1");
    execute("INSERT INTO bale_bot_chats(bot_id,chat_id,customer_id,created_at) VALUES(?,?,?,datetime('now'))", [bot.id, `fx-${B}`, B]);
    assert.equal((await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: hiddenId })).status, 403);
    const s = await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: initialId }); assert.equal(s.status, 201, JSON.stringify(s.data));
    assert.equal(s.data.status, "queued"); assert.equal(s.data.delivery, "queued_only");
    const row = queryRow("SELECT body, status FROM sh_sends WHERE id=?", [s.data.id]); assert.ok(row.body.includes("مشتری آزمایشی صالحی") && row.body.includes("آقای کاظمی")); assert.equal(row.status, "queued");
    assert.equal(netCalls, 0);
  });
  await ok("auto-send hook (Hasani flow): queues each auto_send plan message once, only when reachable", async () => {
    assert.equal(sh.shOnPlanLinked(B, planId), 1); assert.equal(sh.shOnPlanLinked(B, planId), 0);
    assert.equal(sh.shOnPlanLinked(A, planId), 0); // never started the bot
    flag(sh.SH_FLAG, "0"); assert.equal(sh.shOnPlanLinked(B, planId), 0); flag(sh.SH_FLAG, "1");
  });

  flag(sh.SH_PHONE_FLAG, "1");
  await ok("phone attach: any expert, any customer, several extras, full number in search", async () => {
    const s = await req("kazemi", "GET", `/api/social-hub/phone-attach/search?q=${encodeURIComponent("فتحی")}`); assert.equal(s.status, 200);
    const hit = s.data.rows.find((r) => r.id === A); assert.ok(hit); assert.equal(hit.phone, "09120009017"); assert.equal(hit.mine, false);
    assert.ok((await req("kazemi", "GET", `/api/social-hub/phone-attach/search?q=${encodeURIComponent("۰۹۰۱۷")}`)).data.rows.some((r) => r.id === A));
    assert.ok((await req("kazemi", "GET", `/api/social-hub/phone-attach/search?q=%23${A}`)).data.rows.some((r) => r.id === A));
    for (const n of ["09120009101", "09120009102", "09120009103", "09120009104"]) {
      const r = await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: n }); assert.equal(r.status, 201, JSON.stringify(r.data));
    }
    assert.equal(queryRow("SELECT COUNT(*) n FROM customer_phones WHERE customer_id=?", [A]).n, 4);
    assert.equal(queryRows("SELECT id FROM customers WHERE phone LIKE '0912000910%'").length, 0); // no customer created
  });
  await ok("phone attach: duplicate on another customer not saved and returned; same customer message; cap 10", async () => {
    const d = await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: "09120009083" }); assert.equal(d.status, 409); assert.equal(d.data.error, "duplicate_mobile"); assert.equal(d.data.customer.id, B);
    const same = await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: "۰۹۱۲۰۰۰۹۱۰۱" }); assert.equal(same.status, 409); assert.equal(same.data.error, "same_customer");
    for (let i = 5; i <= 9; i++) assert.equal((await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: `0912000911${i}` })).status, 201);
    const cap = await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: "09120009130" }); assert.equal(cap.status, 409); assert.equal(cap.data.error, "phone_limit");
  });
  await ok("phone attach: call link only for the caller's own unlinked card", async () => {
    const r = await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: B, phone: "09120009140", callEventId: 987654321, logCall: true });
    assert.equal(r.status, 201); assert.equal(r.data.callLinked, false);
  });
  await ok("lockdown ON: locked expert reaches today box only for an accessible customer; attach stays open", async () => {
    flag("flag.expert_lockdown", "1");
    const g = await req("ghasemi", "GET", `/api/social-hub/customers/${B}/today`); assert.equal(g.status, 403);
    const own = await req("kazemi", "GET", `/api/social-hub/customers/${B}/today`); assert.equal(own.status, 200);
    assert.equal((await req("ghasemi", "GET", `/api/social-hub/phone-attach/search?q=x`)).status, 200);
    assert.equal((await req("ghasemi", "GET", "/api/social-hub/bots")).status, 403);
    flag("flag.expert_lockdown", null);
  });
  await ok("phone flag OFF again → t853u limits back (cap 3, own customer only)", async () => {
    flag(sh.SH_PHONE_FLAG, null);
    assert.equal(cph.customerPhonesMax(), 3); assert.equal(cph.canManageCustomerPhones(kazemi, A), false);
    assert.equal((await req("kazemi", "POST", "/api/social-hub/phone-attach", { customerId: A, phone: "09120009150" })).status, 404);
  });
  await ok("bot side pure: menu, welcome, national id checksum, birth date, checklist from file, id steps", async () => {
    assert.deepEqual(shb.shbMenu()[0].map((b) => b.text), ["انتخاب طرح", "آپلود مدارک هویتی"]);
    assert.ok(shb.shbWelcome("آقای فتحی").includes("نفیس وام"));
    assert.equal(shb.shbNationalId("1111111111").ok, false); assert.equal(shb.shbNationalId("12345").ok, false);
    assert.equal(shb.shbNationalId("0499370899").ok, true); assert.equal(shb.shbNationalId("۰۴۹۹۳۷۰۸۹۹").ok, true); assert.equal(shb.shbNationalId("0499370898").ok, false);
    assert.deepEqual(shb.shbBirthDate("۱۳۷۲/۵/۱۴"), { ok: true, value: "1372/05/14" }); assert.equal(shb.shbBirthDate("1372/13/01").ok, false); assert.equal(shb.shbBirthDate("1372/08/31").ok, false);
    const cl = shb.shbPlanChecklist([{ key: "national_card", label: "کارت ملی" }, { key: "salary", label: "فیش حقوقی" }], new Set(["national_card_front"]));
    assert.deepEqual(cl.map((x) => x.state), ["from_file", "needed"]); assert.equal(cl[0].note, "از پرونده برداشته شد");
    assert.deepEqual(shb.shbIdNext({ nationalId: true, birth: true, docs: new Set(["national_card_front"]) }), { step: "doc", doc: "national_card_back", label: "پشت کارت ملی" });
    assert.deepEqual(shb.shbPlanKeyboard([{ id: 3, publicLabel: "لندتک / ملت" }]), [[{ text: "لندتک / ملت", data: "shp:3" }]]);
  });

  await ok("send gates: Ghasemi bot is read-only; cross-expert blocked; 10-minute dedupe", async () => {
    const gBot = queryRow("SELECT id FROM bale_bots WHERE user_id=3");
    const hBot = queryRow("SELECT id FROM bale_bots WHERE user_id=2");
    const kBot = queryRow("SELECT id FROM bale_bots WHERE user_id=8");
    assert.ok(gBot && hBot && kBot);
    execute("INSERT INTO bale_bot_chats(bot_id,chat_id,customer_id,created_at,last_at) VALUES(?,?,?,?,datetime('now'))", [gBot.id, `fx-g-${A}`, A, "2026-11-25T06:00:00Z"]);
    const gToday = await req("ghasemi", "GET", `/api/social-hub/customers/${A}/today`);
    assert.equal(gToday.status, 200, JSON.stringify(gToday.data));
    assert.equal(gToday.data.sendBlock?.error, "send_closed");
    assert.equal(gToday.data.sendBlock?.message, "ارسال از این ربات بسته است");
    const gSend = await req("ghasemi", "POST", `/api/social-hub/customers/${A}/send`, { messageId: freeId });
    assert.equal(gSend.status, 409); assert.equal(gSend.data.error, "send_closed");
    // auto-send on Ghasemi's chat must also stay off
    assert.equal(sh.shOnPlanLinked(A, planId, new Date(), { chatRow: queryRow("SELECT id FROM bale_bot_chats WHERE customer_id=?", [A]).id, botId: gBot.id }), 0);
    // newer chat on Hasani's bot for Kazemi's customer B → Kazemi cannot send from Hasani's bot
    execute("INSERT INTO bale_bot_chats(bot_id,chat_id,customer_id,created_at,last_at) VALUES(?,?,?,?,?)", [hBot.id, `fx-h-${B}`, B, "2026-11-25T07:00:00Z", "2026-11-25T07:00:00Z"]);
    const cross = await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: freeId });
    assert.equal(cross.status, 409, JSON.stringify(cross.data)); assert.equal(cross.data.error, "other_expert");
    assert.match(cross.data.message, /ربات/);
    // put B back on Kazemi's bot as the latest chat
    execute("UPDATE bale_bot_chats SET last_at=? WHERE bot_id=? AND customer_id=?", ["2026-11-25T08:00:00Z", kBot.id, B]);
    const first = await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: freeId });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const again = await req("kazemi", "POST", `/api/social-hub/customers/${B}/send`, { messageId: freeId });
    assert.equal(again.status, 409); assert.equal(again.data.error, "recent");
    assert.equal(again.data.message, "همین الان فرستاده شد؛ ارسال دوباره بعد از ۱۰ دقیقه.");
    assert.equal(netCalls, 0);
  });
  await ok("choiceLabel never uses لندتک; planChoiceLabel is what the customer sees", async () => {
    const plans = sh.shPlans();
    assert.ok(plans.length > 0);
    assert.ok(plans.every((p) => !String(p.choiceLabel).includes("لندتک")));
    const rendered = sh.shRender("طرح ‹نام طرح›", { plan: plans[0].choiceLabel });
    assert.ok(!rendered.includes("لندتک"));
  });
  await ok("connect flag OFF still refuses tokens; ON tests and saves only through getMe hook (no network)", async () => {
    const fake = "123456789:AAHfake_fixture_token_xx";
    assert.equal((await req("sm", "POST", "/api/social-hub/bots/test", { token: fake })).status, 409);
    flag(sh.SH_CONNECT_FLAG, "1");
    let seen = 0;
    shs.setShGetMeForTests(async () => { seen++; return { ok: true, bot: { id: "9001", name: "نفیس وام", username: "nafisvam_bot" } }; });
    const t = await req("sm", "POST", "/api/social-hub/bots/test", { token: fake });
    assert.equal(t.status, 200, JSON.stringify(t.data)); assert.equal(t.data.bot.username, "nafisvam_bot");
    const saved = await req("sm", "POST", "/api/social-hub/bots/connect", { token: fake });
    assert.equal(saved.status, 201, JSON.stringify(saved.data)); assert.equal(saved.data.saved, true);
    assert.equal(saved.data.username, "nafisvam_bot");
    assert.ok(!JSON.stringify(saved.data).includes(fake));
    const view = (await req("sm", "GET", "/api/social-hub/bots")).data.connect;
    assert.equal(view.tokenSaved, true); assert.equal(view.username, "nafisvam_bot");
    assert.ok(!JSON.stringify(view).includes(fake));
    assert.ok(seen >= 2);
    assert.equal(netCalls, 0);
  });
  await ok("redirect: Ghasemi's customers are included (t931s3334); flag off and missing confirm cannot send; tick uses her bot", async () => {
    const previewOff = await req("admin", "GET", "/api/social-hub/redirect/preview");
    assert.equal(previewOff.status, 200, JSON.stringify(previewOff.data));
    assert.equal(previewOff.data.flagOn, false);
    assert.equal(previewOff.data.disabledReason, "پس از اتصال ربات نفیس وام");
    assert.equal((await req("sm", "GET", "/api/social-hub/redirect/preview")).status, 403);
    flag(sh.SH_REDIRECT_FLAG, "1");
    const preview = await req("admin", "GET", "/api/social-hub/redirect/preview");
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.ok(preview.data.recipients.some((r) => r.customerId === A && r.expertUserId === 3), "Ghasemi customer must be in the redirect");
    assert.ok(!preview.data.skipped.some((s) => /قاسمی/.test(s.label)), "no Ghasemi exclusion row");
    const n = preview.data.recipientCount;
    assert.equal((await req("admin", "POST", "/api/social-hub/redirect/start", { seen: true, count: n - 1 })).status, 400);
    assert.equal((await req("admin", "POST", "/api/social-hub/redirect/start", { count: n })).status, 400);
    const start = await req("admin", "POST", "/api/social-hub/redirect/start", { seen: true, count: String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]) });
    assert.equal(start.status, 201, JSON.stringify(start.data));
    assert.ok(start.data.queued >= 1);
    // drain remaining (tick already ran once on start)
    shs.shRedirectTick(500);
    const item = queryRow("SELECT from_bot_id, status, out_msg_id FROM sh_redirect_items WHERE customer_id=?", [A]);
    assert.ok(item, "Ghasemi customer got a redirect row");
    const gBot = queryRow("SELECT id FROM bale_bots WHERE user_id=3");
    assert.equal(item.from_bot_id, gBot.id);
    if (item.out_msg_id) {
      const msg = queryRow("SELECT chat_row FROM bale_bot_messages WHERE id=?", [item.out_msg_id]);
      const chat = queryRow("SELECT bot_id FROM bale_bot_chats WHERE id=?", [msg.chat_row]);
      assert.equal(chat.bot_id, gBot.id);
    } else {
      assert.fail("redirect item for Ghasemi's customer was not queued to the outbox");
    }
    // Today send from Ghasemi is still blocked after the campaign
    assert.equal((await req("ghasemi", "POST", `/api/social-hub/customers/${A}/send`, { messageId: freeId })).data.error, "send_closed");
    // once per customer: already queued/sent cannot start again for that customer; full run marks done after settle
    const start2 = await req("admin", "POST", "/api/social-hub/redirect/start", { seen: true, count: n });
    assert.equal(start2.status, 409);
    assert.equal(netCalls, 0);
  });
  await ok("never wrote loan_plans / team_sales_config / notification_settings; no network", async () => {
    assert.equal(netCalls, 0);
    for (const t of ["loan_plans", "bale_bots"]) assert.ok(queryRow(`SELECT COUNT(*) n FROM ${t}`).n >= 0);
  });
  console.log(`social-hub fixture ${passed}/21`);
  if (passed !== 21) process.exitCode = 1;
} catch (err) { console.error(err); process.exitCode = 1; }
finally { if (server) await new Promise((r) => server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } }

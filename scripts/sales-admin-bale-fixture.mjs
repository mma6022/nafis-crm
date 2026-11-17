// «مدیریت فروش» v1.3 fixture (flag.sales_admin_bale_v13 on top of flag.sales_manager_console_v1 + flag.sales_admin_merge_v12), t358s1326.
// No network, no Bale message, no SMS: globalThis.fetch throws; the Bale HTTP layer is a recording stub; no transcript worker runs.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/sales-admin-bale-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const keyFile = path.join(dir, "bot.key"); fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1", BALE_BOT_WORKER: "0", SAB_FEEDER: "0",
  SMS_DISABLED: "1", BALE_BOT_KEY_FILE: keyFile, BALE_BOT_FILES_DIR: path.join(dir, "bale"),
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "fixture-placeholder";
delete process.env.OPENAI_API_KEY;
const netCalls = [];
globalThis.fetch = async (u) => { netCalls.push(String(u).replace(/bot[^/]+/, "bot<x>")); throw new Error("no network in fixture"); };
let passed = 0; const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const sab = await import("../src/lib/sales-admin-bale.ts");
  const bb = await import("../src/lib/bale-bot.ts");
  const cb = await import("../src/lib/customer-bale.ts");
  const acr = await import("../src/lib/automatic-call-reports.ts");
  const { queryRow, queryRows, execute } = db;
  const setKey = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const get = (k) => queryRow("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null;
  const flags = (smc, merge, bale) => { setKey("flag.sales_manager_console_v1", smc); setKey("flag.sales_admin_merge_v12", merge); setKey(sab.SAB_FLAG, bale); };
  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const allTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  const hashAll = () => Object.fromEntries(allTables().map((t) => [t, tableHash(t)]));
  const changedSince = (h0) => Object.keys(hashAll()).filter((t) => tableHash(t) !== (h0[t] ?? "new")).sort();
  const guarded = ["team_sales_config", "notification_settings", "sales_teams", "sales_team_members", "sales_intake_shares", "loan_plans", "contract_templates", "users",
    "bale_accounts", "bale_settings", "bale_outbox", "bale_messages", "bale_conversation_state", "sms_outbox", "sms_log"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));
  const custBefore = hash("SELECT id, salesperson_id FROM customers ORDER BY id");

  // Bale HTTP stub: records method + chat + text only (never the token); answers like Bale.
  const baleCalls = [];
  bb.setBaleBotFetch(async (url, init) => {
    const m = /\/bot[^/]+\/(\w+)$/.exec(String(url)); const method = m ? m[1] : "?"; let body = {};
    try { body = JSON.parse(init?.body ?? "{}"); } catch { body = {}; }
    baleCalls.push({ method, chat_id: body.chat_id ?? null, text: body.text ?? null });
    const result = method === "getMe" ? { id: 990001, first_name: "ربات آزمایشی", username: "fixture_test_bot", is_bot: true }
      : method === "sendMessage" ? { message_id: 1000 + baleCalls.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id) } } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const tokens = {};
  for (const id of [1, 2, 3, 5, 6, 8]) {
    const tok = crypto.randomBytes(24).toString("base64url"); tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]);
  }
  const app = express(); app.use(sab.sabBaleAdminRedirect); app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/api", auth.requireAuth, router);
  app.use((_req, res) => res.status(404).send("spa"));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body, raw = false) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: "127.0.0.1", port, agent: false, method, path: raw ? p : `/api${p}`, headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, text: t, headers: res.headers }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });
  const MANAGER = 5, ADMIN = 1, KAZEMI = 8, HASANI = 2, GHASEMI = 3, ASLANIAN = 6;
  const activeUsers = queryRows("SELECT id FROM users WHERE active=1 ORDER BY id").map((r) => Number(r.id));
  const bots = queryRows("SELECT * FROM bale_bots ORDER BY id");
  const baseline = () => ({
    view: activeUsers.map((id) => [id, bb.bbView(bb.bbUser(id))]), manage: activeUsers.map((id) => [id, bb.bbCanManage(bb.bbUser(id))]),
    live: queryRows("SELECT * FROM bale_bots ORDER BY id").map((b) => [b.id, bb.botLive(b)]), ai: bots.map((b) => [b.id, cb.cbAiLiveFor(b)]),
  });
  flags(null, null, null); const B0 = baseline();
  const sabPaths = [["GET", "/sales-admin/bale/state"], ["GET", "/sales-admin/bale/voice?page=2"], ["PUT", "/sales-admin/bale/ai", { botId: 1, on: false }], ["PUT", "/sales-admin/bale/view", { scope: "user", id: 8, level: "none" }],
    ["PUT", "/sales-admin/bale/quick", { items: [] }], ["PUT", "/sales-admin/bale/voice/mode", { mode: "off" }], ["POST", "/sales-admin/bale/key", { value: "sk-fixture-0000000000" }]];

  await ok("flag OFF (any combination short of all three): /sales-admin/bale/* 404, /bale-bot/quick 404, /bale-bot/admin not redirected, /me has no bale key, hooks = today, nothing written", async () => {
    const h0 = hashAll();
    for (const [smc, merge, bale] of [[null, null, null], [null, null, "1"], ["1", null, "1"], ["1", "1", null], [null, "1", "1"]]) {
      flags(smc, merge, bale);
      for (const [m, p, b] of sabPaths) {
        const r = await call(ADMIN, m, p, b); assert.equal(r.status, 404, `${m} ${p} ${smc}/${merge}/${bale} → ${r.status}`);
        const r2 = await call(MANAGER, m, p, b); assert.ok([403, 404].includes(r2.status), `manager ${m} ${p} → ${r2.status}`); // v1.1 (merge OFF) is admin-only → 403
      }
      assert.equal((await call(KAZEMI, "GET", "/bale-bot/quick")).status, 404);
      const r = await call(null, "GET", "/bale-bot/admin", undefined, true); assert.equal(r.status, 404); assert.equal(r.text, "spa");
      if (smc === "1") { const me = await call(ADMIN, "GET", "/sales-admin/me"); assert.equal(me.status, 200); assert.equal(me.body.bale, undefined); }
      assert.deepEqual(baseline(), B0, "hooks return today's answers");
    }
    const ch = changedSince(h0).filter((t) => t !== "call_queue_settings" && t !== "auth_sessions" && !t.startsWith("smc_")); // smc_* = the v1.1 console schema (created by its own middleware while the console flag is ON)
    assert.deepEqual(ch, [], `no writes while OFF: ${ch}`);
  });

  flags("1", "1", "1");
  await ok("ON: sales manager + admin 200; experts (Kazemi, Hasani, Ghasemi, Aslanian) 403; /me says bale; user 29 is in no list", async () => {
    for (const u of [MANAGER, ADMIN]) assert.equal((await call(u, "GET", "/sales-admin/bale/state")).status, 200);
    for (const u of [KAZEMI, HASANI, GHASEMI, ASLANIAN]) { assert.equal((await call(u, "GET", "/sales-admin/bale/state")).status, 403); assert.equal((await call(u, "PUT", "/sales-admin/bale/ai", { botId: 1, on: false })).status, 403); }
    assert.equal((await call(MANAGER, "GET", "/sales-admin/me")).body.bale, true);
    const s = (await call(MANAGER, "GET", "/sales-admin/bale/state")).body;
    const ids = JSON.stringify(s).match(/"userId":(\d+)/g) ?? [];
    assert.ok(ids.length > 3 && !ids.includes('"userId":29'), "no user 29");
    assert.equal(s.canWrite, true); assert.equal(s.flag, "flag.sales_admin_bale_v13");
  });

  await ok("ON with nothing saved = today: same inbox view / manage / bot live / AI per bot for every user and bot; GET state writes nothing; voice mode default 'auto'", async () => {
    const h0 = hashAll();
    assert.deepEqual(baseline(), B0);
    await call(MANAGER, "GET", "/sales-admin/bale/state");
    const ch = changedSince(h0).filter((t) => t !== "auth_sessions"); assert.deepEqual(ch, [], `GET wrote ${ch}`);
    assert.equal(sab.sabVoiceMode(), "auto");
    const s = (await call(MANAGER, "GET", "/sales-admin/bale/state")).body;
    assert.equal(s.voice.mode, "auto"); assert.equal(s.voice.modeSet, false);
    for (const e of s.bots.experts) assert.equal(e.mode, e.bot ? "own" : "shared");
    assert.equal(s.view.managers.level, "all");
    for (const t of s.view.teams) for (const m of t.members) assert.equal(m.effective, "own");
  });

  await ok("Ghasemi's read-only bot is not in the connect/switch list and cannot be switched, toggled or connected", async () => {
    const s = (await call(MANAGER, "GET", "/sales-admin/bale/state")).body;
    assert.ok(!s.bots.experts.some((e) => e.userId === GHASEMI), "Ghasemi not listed");
    assert.ok(!JSON.stringify(s.bots).includes("ghasemi_nafisvam_bot"));
    const gb = bots.find((b) => b.user_id === GHASEMI);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/bale/ai", { botId: gb.id, on: false })).status, 403);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/bale/mode", { userId: GHASEMI, mode: "shared" })).status, 403);
    assert.equal((await call(MANAGER, "POST", "/sales-admin/bale/bots/connect", { userId: GHASEMI, token: "123456:ABCDEFGHIJKLMNOPQRSTUVWX" })).status, 403);
    assert.equal(get(sab.K.ai(gb.id)), null); assert.equal(get(sab.K.mode(GHASEMI)), null);
  });

  await ok("AI per bot: Kazemi's bot OFF → only that bot stops AI replies; history row; «برگرداندن» puts the key back to absent (= today)", async () => {
    const kb = bots.find((b) => b.user_id === KAZEMI); const hb = bots.find((b) => b.user_id === HASANI);
    const r = await call(MANAGER, "PUT", "/sales-admin/bale/ai", { botId: kb.id, on: false }); assert.equal(r.status, 200); assert.ok(r.body.changed && r.body.auditId > 0);
    assert.equal(get(sab.K.ai(kb.id)), "0");
    assert.equal(cb.cbAiLiveFor(kb), false); assert.equal(cb.cbAiLiveFor(hb), cb.cbAiLive());
    assert.ok(queryRow("SELECT 1 FROM call_queue_settings_log WHERE key=? AND new_value='0'", [sab.K.ai(kb.id)]));
    assert.equal(queryRow("SELECT section FROM smc_audit WHERE id=?", [r.body.auditId]).section, "bale_bots");
    const u = await call(MANAGER, "POST", `/sales-admin/audit/${r.body.auditId}/revert`); assert.equal(u.status, 200);
    assert.equal(get(sab.K.ai(kb.id)), null); assert.equal(cb.cbAiLiveFor(kb), cb.cbAiLive());
  });

  await ok("own/shared: Kazemi → «ربات مشترک» pauses his own bot (token kept, no poll/send); undo resumes; «یکسان برای همه» skips Ghasemi", async () => {
    const kb = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [KAZEMI]);
    const r = await call(MANAGER, "PUT", "/sales-admin/bale/mode", { userId: KAZEMI, mode: "shared" }); assert.equal(r.status, 200);
    assert.equal(bb.botLive(queryRow("SELECT * FROM bale_bots WHERE user_id=?", [KAZEMI])), false);
    assert.equal(queryRow("SELECT token_ct FROM bale_bots WHERE id=?", [kb.id]).token_ct, kb.token_ct, "token untouched");
    await call(MANAGER, "POST", `/sales-admin/audit/${r.body.auditId}/revert`);
    assert.equal(bb.botLive(queryRow("SELECT * FROM bale_bots WHERE user_id=?", [KAZEMI])), B0.live.find(([id]) => id === kb.id)[1]);
    const all = await call(MANAGER, "PUT", "/sales-admin/bale/mode", { all: true, mode: "shared" }); assert.equal(all.status, 200);
    assert.equal(get(sab.K.mode(GHASEMI)), null, "Ghasemi untouched");
    assert.equal(bb.botLive(queryRow("SELECT * FROM bale_bots WHERE user_id=?", [GHASEMI])), B0.live.find(([id]) => id === bots.find((b) => b.user_id === GHASEMI).id)[1]);
    await call(MANAGER, "POST", `/sales-admin/audit/${all.body.auditId}/revert`);
    assert.deepEqual(baseline(), B0);
  });

  await ok("view levels: «هیچ» hides the inbox (403) but keeps customer ownership; team «همه» lifts members; managers row; user > team; undo; never opens the inbox to someone the bale flags keep out", async () => {
    let r = await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "user", id: KAZEMI, level: "none" }); assert.equal(r.status, 200);
    assert.equal(bb.bbView(bb.bbUser(KAZEMI)), null); assert.equal((await call(KAZEMI, "GET", "/bale-bot/me")).status, 403);
    assert.equal(hash("SELECT id, salesperson_id FROM customers ORDER BY id"), custBefore, "assignment stays (§6-28)");
    const t = await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "team", id: 1, level: "all" }); assert.equal(t.status, 200);
    assert.equal(bb.bbView(bb.bbUser(HASANI)), "all", "team 1 member lifted");
    assert.equal(bb.bbView(bb.bbUser(KAZEMI)), null, "user row wins over team");
    assert.equal(bb.bbCanManage(bb.bbUser(HASANI)), false, "an expert with «همه» still cannot manage bots");
    // MANAGER (5) has no flag.bale_bot.user.5 → stays out whatever the level
    const m = await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "managers", level: "all" }); assert.equal(m.status, 200);
    assert.equal(bb.bbView(bb.bbUser(MANAGER)), B0.view.find(([id]) => id === MANAGER)[1]);
    const n = await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "managers", level: "none" });
    assert.equal(bb.bbView(bb.bbUser(ADMIN)), null);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "user", id: 29, level: "all" })).status, 404, "never 29");
    for (const id of [n.body.auditId, m.body.auditId, t.body.auditId, r.body.auditId]) assert.equal((await call(ADMIN, "POST", `/sales-admin/audit/${id}/revert`)).status, 200);
    assert.deepEqual(baseline(), B0);
  });

  await ok("canned messages: validation; save 4 (history + undo); experts see titles only; a tap sends that body at once through the stubbed Bale send; read-only Ghasemi bot refuses; no real network", async () => {
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/bale/quick", { items: [{ title: "ا".repeat(41), body: "x" }] })).status, 422);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/bale/quick", { items: Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, body: "b" })) })).status, 422);
    const QM = [["سلام و خوش‌آمد", "سلام، از نفیس وام پیام می‌دهم."], ["لیست مدارک", "کارت ملی و آخرین فیش حقوق را همین‌جا بفرستید."], ["توضیح طرح", "شرایط را همین‌جا می‌فرستم."], ["درخواست ارسال مدارک", "لطفاً مدارک را در همین گفتگو بفرستید."]];
    const r = await call(MANAGER, "PUT", "/sales-admin/bale/quick", { items: QM.map(([title, body]) => ({ title, body })) }); assert.equal(r.status, 200);
    const items = sab.sabQuickMessages(); assert.equal(items.length, 4);
    const q = await call(KAZEMI, "GET", "/bale-bot/quick"); assert.equal(q.status, 200); assert.deepEqual(q.body.items.map((x) => x.title), QM.map((x) => x[0])); assert.ok(!q.text.includes("فیش"), "titles only");
    // connect Aslanian's bot through the section (stubbed getMe), then a tap on his own chat
    const c = await call(MANAGER, "POST", "/sales-admin/bale/bots/connect", { userId: ASLANIAN, token: "990001:FIXTUREtokenFIXTUREtoken123" });
    assert.equal(c.status, 200, JSON.stringify(c.body)); assert.ok(!c.text.includes("FIXTUREtoken"));
    const bot = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [ASLANIAN]);
    const chat = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,created_at) VALUES(?,?,?,?)", [bot.id, "777001", "مشتری آزمایشی", new Date().toISOString()]);
    baleCalls.length = 0;
    const s = await call(ASLANIAN, "POST", `/bale-bot/chats/${chat}/quick/${items[1].id}`); assert.equal(s.status, 200, JSON.stringify(s.body));
    for (let i = 0; i < 40 && !baleCalls.some((x) => x.method === "sendMessage"); i++) await sleep(50);
    const sent = baleCalls.filter((x) => x.method === "sendMessage");
    assert.equal(sent.length, 1); assert.equal(sent[0].text, QM[1][1]); assert.equal(String(sent[0].chat_id), "777001");
    assert.equal(queryRow("SELECT status FROM bale_bot_messages WHERE chat_row=? ORDER BY id DESC", [chat]).status, "sent");
    assert.equal((await call(ASLANIAN, "POST", `/bale-bot/chats/${chat}/quick/qnope`)).status, 404);
    const gb = bots.find((b) => b.user_id === GHASEMI); const gchat = queryRow("SELECT id FROM bale_bot_chats WHERE bot_id=? LIMIT 1", [gb.id]);
    if (gchat) assert.notEqual((await call(ADMIN, "POST", `/bale-bot/chats/${gchat.id}/quick/${items[0].id}`)).status, 200, "read-only bot never sends");
    assert.equal(baleCalls.filter((x) => x.method === "sendMessage").length, 1);
    assert.deepEqual(netCalls, [], "no real network");
    const u = await call(MANAGER, "POST", `/sales-admin/audit/${r.body.auditId}/revert`); assert.equal(u.status, 200); assert.equal(get(sab.K.quick), null);
  });

  await ok("bot connect: token never in a response, smc_audit, bale_bot_log or settings log; new bot AI off (§6-26); second connect for the same expert refused (no reconnect); not undoable here", async () => {
    const bot = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [ASLANIAN]);
    assert.equal(get(sab.K.ai(bot.id)), "0"); assert.equal(get(sab.K.mode(ASLANIAN)), "own"); assert.ok(bot.token_ct && !bot.token_ct.includes("FIXTUREtoken"));
    for (const t of ["smc_audit", "bale_bot_log", "call_queue_settings_log", "call_queue_settings"]) assert.ok(!JSON.stringify(queryRows(`SELECT * FROM ${t}`)).includes("FIXTUREtoken"), t);
    const again = await call(MANAGER, "POST", "/sales-admin/bale/bots/connect", { userId: ASLANIAN, token: "990002:OTHERtokenOTHERtokenOTHER12" }); assert.equal(again.status, 409); assert.equal(again.body.error, "has_bot");
    const a = queryRow("SELECT id FROM smc_audit WHERE section='bale_bots' ORDER BY id DESC LIMIT 1");
    assert.equal((await call(MANAGER, "POST", `/sales-admin/audit/${a.id}/revert`)).status, 409);
    const s = (await call(MANAGER, "GET", "/sales-admin/bale/state")).body; assert.ok(!JSON.stringify(s).includes("token_ct") && !JSON.stringify(s).includes("FIXTUREtoken"));
  });

  await ok("OpenAI key: stored once, answer is only {set, savedAt}; never echoed in state, smc_audit or logs; bad value 400", async () => {
    const KEY = "sk-fixture-SECRETvalue-1234567890abcdef";
    assert.equal((await call(MANAGER, "POST", "/sales-admin/bale/key", { value: "short" })).status, 400);
    const r = await call(MANAGER, "POST", "/sales-admin/bale/key", { value: KEY }); assert.equal(r.status, 200);
    assert.ok(!r.text.includes(KEY) && !r.text.includes("7890abcdef") && !r.text.includes("cdef\""), "not echoed");
    assert.equal(r.body.openai.set, true);
    const s = await call(MANAGER, "GET", "/sales-admin/bale/state"); assert.ok(!s.text.includes(KEY) && !s.text.includes("abcdef"));
    for (const t of ["smc_audit", "call_queue_settings_log", "call_queue_settings", "bale_bot_log"]) assert.ok(!JSON.stringify(queryRows(`SELECT * FROM ${t}`)).includes(KEY), t);
  });

  await ok("voice: default auto; «فقط ذخیره؛ تبدیل دستی» stops automatic queueing (hook), auto restores; list = audio without successful text (failed included), no 29; «تبدیل انتخاب‌شده/همه» only queue rows (no provider call); off refuses; undo", async () => {
    // a synthetic auto-capture event so the hook is observable
    const ev = execute(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,has_recording,recording_file,is_live,auto_capture,auto_queued,expert_user_id,extensions_json)
      VALUES('fx-voice-1','09120000000','outgoing','ANSWERED',datetime('now','-1 hour'),datetime('now','-55 minutes'),1,'fx/rec1.wav',0,1,0,8,'[]')`);
    const m = await call(MANAGER, "PUT", "/sales-admin/bale/voice/mode", { mode: "manual" }); assert.equal(m.status, 200);
    await acr.queueAutomaticCallReports();
    assert.deepEqual({ ...queryRow("SELECT auto_queued, capture_error FROM voip_after_call_events WHERE id=?", [ev]) }, { auto_queued: 0, capture_error: null }, "manual → untouched");
    await call(MANAGER, "POST", `/sales-admin/audit/${m.body.auditId}/revert`); assert.equal(sab.sabVoiceMode(), "auto");
    const s = (await call(MANAGER, "GET", "/sales-admin/bale/state")).body.voice;
    assert.ok(s.total > 100, `list total ${s.total}`);
    assert.ok(!queryRows("SELECT expert_user_id FROM voip_after_call_events WHERE id IN (" + s.rows.map((r) => r.id).join(",") + ")").some((r) => r.expert_user_id === 29));
    // Armita review: 20 rows a page, total + pages for every page; page 2 is the next 20; out-of-range clamps; experts 403; OFF 404 (case 1).
    assert.equal(s.rows.length, 20); assert.equal(s.page, 1); assert.equal(s.per, 20); assert.equal(s.pages, Math.ceil(s.total / 20));
    const p2 = (await call(MANAGER, "GET", "/sales-admin/bale/voice?page=2")).body;
    assert.equal(p2.page, 2); assert.equal(p2.total, s.total); assert.equal(p2.rows.length, Math.min(20, s.total - 20));
    assert.ok(!p2.rows.some((r) => s.rows.some((x) => x.id === r.id)), "page 2 rows differ from page 1");
    assert.equal((await call(MANAGER, "GET", "/sales-admin/bale/voice?page=99999")).body.page, s.pages);
    assert.equal((await call(KAZEMI, "GET", "/sales-admin/bale/voice?page=2")).status, 403);
    const completed = queryRow("SELECT e.id FROM voip_after_call_events e JOIN voip_recording_transcripts t ON t.external_id=COALESCE(e.recording_provider_id,e.external_id) AND t.state='completed' AND t.source_file=e.recording_file LIMIT 1");
    assert.ok(!sab.sabUntranscribed(5000).some((r) => r.id === completed.id), "completed calls are not listed");
    assert.ok(sab.sabUntranscribed(5000).some((r) => r.t_state === "failed"), "failed ones are listed (§6-33)");
    const pick = s.rows.filter((r) => r.state !== "queued" && r.state !== "processing").slice(0, 2).map((r) => r.id);
    const q0 = queryRow("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE state='queued'").n;
    const t = await call(MANAGER, "POST", "/sales-admin/bale/voice/transcribe", { ids: pick }); assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.requested, 2); assert.equal(t.body.queuedNow, 2);
    assert.equal(queryRow("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE state='queued' AND requested_by=0").n - q0, 2);
    const all = await call(MANAGER, "POST", "/sales-admin/bale/voice/transcribe", { all: true }); assert.equal(all.status, 200);
    assert.ok(queryRow("SELECT COUNT(*) n FROM voip_recording_transcripts WHERE state IN ('queued','processing')").n <= 10, "existing queue cap respected");
    assert.ok(JSON.parse(get(sab.K.voicePending)).length > 100, "the rest waits in sab.voice.pending");
    assert.ok(JSON.parse(get(sab.K.voicePending)).length > s.per * 2, "«تبدیل همه» covers rows beyond the first pages");
    const off = await call(MANAGER, "PUT", "/sales-admin/bale/voice/mode", { mode: "off" });
    assert.equal((await call(MANAGER, "POST", "/sales-admin/bale/voice/transcribe", { all: true })).status, 409);
    await call(MANAGER, "POST", `/sales-admin/audit/${off.body.auditId}/revert`);
    assert.deepEqual(netCalls, [], "no provider call");
  });

  await ok("/bale-bot/admin → 301 /sales-admin#s-bale (no-store) while ON; HEAD too; other paths untouched", async () => {
    const r = await call(null, "GET", "/bale-bot/admin", undefined, true);
    assert.equal(r.status, 301); assert.equal(r.headers.location, "/sales-admin#s-bale"); assert.equal(r.headers["cache-control"], "no-store");
    assert.equal((await call(null, "GET", "/bale-bot/admin/", undefined, true)).status, 301);
    assert.equal((await call(null, "HEAD", "/bale-bot/admin", undefined, true)).status, 301);
    assert.equal((await call(null, "GET", "/bale-bot", undefined, true)).status, 404);
    assert.equal((await call(null, "POST", "/bale-bot/admin", {}, true)).status, 404);
  });

  await ok("guarded tables unchanged (team_sales_config, notification_settings, sales_teams/members, intake shares, loan_plans, contract templates, users, Bale personal sessions/outbox, SMS); no Bale message besides the one stubbed tap", async () => {
    for (const t of guarded) assert.equal(tableHash(t), before[t], t);
    assert.equal(baleCalls.filter((x) => x.method === "sendMessage").length, 1);
    assert.deepEqual(netCalls, []);
  });

  await ok("flag back OFF with settings saved: routes 404, no redirect, hooks = today again", async () => {
    await call(MANAGER, "PUT", "/sales-admin/bale/view", { scope: "user", id: KAZEMI, level: "none" });
    await call(MANAGER, "PUT", "/sales-admin/bale/voice/mode", { mode: "manual" });
    setKey(sab.SAB_FLAG, null);
    assert.equal((await call(MANAGER, "GET", "/sales-admin/bale/state")).status, 404);
    assert.equal((await call(null, "GET", "/bale-bot/admin", undefined, true)).status, 404);
    assert.equal(bb.bbView(bb.bbUser(KAZEMI)), B0.view.find(([id]) => id === KAZEMI)[1]);
    const ev = execute(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,has_recording,recording_file,is_live,auto_capture,auto_queued,expert_user_id,extensions_json)
      VALUES('fx-voice-2','09120000000','outgoing','ANSWERED',datetime('now','-1 hour'),datetime('now','-55 minutes'),1,'fx/rec2.wav',0,1,0,8,'[]')`);
    await acr.queueAutomaticCallReports();
    const row = queryRow("SELECT auto_queued, capture_error FROM voip_after_call_events WHERE id=?", [ev]);
    assert.ok(row.auto_queued === 1 || row.capture_error, "OFF → automatic queueing runs as today");
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}

// t927 (Mohammad t927u): Hasani reads Kazemi + Ghasemi Bale chats and can open their files.
// Flag flag.bale_view_as_v1 + setting bale_view_as.user.2=8,3. Send-as is NOT granted. User 29 untouched.
// No network, no SMS, no Bale send, never the live DB.
// Usage: T927_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t927-bale-view-as-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.T927_FIXTURE_DB || process.env.MASKED_DB || process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set T927_FIXTURE_DB or MASKED_DB to a masked copy)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t927-bva-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const keyFile = path.join(dir, "bot.key"); fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1", BALE_BOT_WORKER: "0", SAB_FEEDER: "0",
  SMS_DISABLED: "1", BALE_BOT_KEY_FILE: keyFile, BALE_BOT_FILES_DIR: path.join(dir, "bale"),
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "fixture-placeholder";
delete process.env.OPENAI_API_KEY;
globalThis.fetch = async () => { throw new Error("no network in t927 fixture"); };

let passed = 0;
const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
let server;

try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const bb = await import("../src/lib/bale-bot.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const bva = await import("../src/lib/bale-view-as.ts");
  const { getCustomer } = await import("../src/routes/crm.ts");
  const { perfCacheInvalidate } = await import("../src/lib/perf-poll-cache.ts");
  const { queryRow, queryRows, execute } = db;
  const setKey = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");

  const HASANI = 2, GHASEMI = 3, TAJIK = 7, KAZEMI = 8, USER29 = 29;
  const SP_HASANI = 3, SP_GHASEMI = 4, SP_ASLANIAN = 5, SP_KAZEMI = 6;
  const now = new Date().toISOString();
  const cid = () => Number(queryRow("SELECT MAX(id) AS m FROM customers").m) + 1;
  const cHasani = cid();
  const cKazemi = cHasani + 1;
  const cGhasemi = cHasani + 2;
  const cAslanian = cHasani + 3;
  for (const [id, name, sp] of [
    [cHasani, "مشتری نمونه t927 حسنی", SP_HASANI],
    [cKazemi, "مشتری نمونه t927 کاظمی", SP_KAZEMI],
    [cGhasemi, "مشتری نمونه t927 قاسمی", SP_GHASEMI],
    [cAslanian, "مشتری نمونه t927 اصلانیان", SP_ASLANIAN],
  ]) {
    execute(`INSERT INTO customers (id,name,phone,created_at,salesperson_id,priority,status,national_code)
      VALUES (?,?,?,?,?,2,'in_progress',?)`, [id, name, `09001927${String(id).slice(-3).padStart(3, "0")}`, now, sp, `00001927${String(id).slice(-2).padStart(2, "0")}`]);
  }
  const appId = Number(queryRow("SELECT COALESCE(MAX(id),0) AS m FROM loan_applications").m) + 1;
  const consultId = Number(queryRow("SELECT consultation_id AS m FROM loan_applications LIMIT 1")?.m ?? 1);
  execute(`INSERT INTO loan_applications (id, consultation_id, customer_id, plan_ids, requested_amount, duration_months, stage, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?, 'draft', 'requested', ?, ?)`, [appId, consultId, cKazemi, "[]", "10000000", 12, now, now]);

  const botOf = (uid) => queryRow("SELECT id FROM bale_bots WHERE user_id=?", [uid]);
  const botH = botOf(HASANI); const botK = botOf(KAZEMI); const botG = botOf(GHASEMI); const botT = botOf(TAJIK);
  assert.ok(botH && botK && botG && botT, "expected bots for Hasani, Kazemi, Ghasemi, Tajik");
  const nextChat = () => Number(queryRow("SELECT COALESCE(MAX(id),0) AS m FROM bale_bot_chats").m) + 1;
  const insChat = (botId, customerId, unread, tag) => {
    const id = nextChat();
    execute(`INSERT INTO bale_bot_chats (id, bot_id, chat_id, first_name, customer_id, unread, last_at, last_preview, last_out, created_at)
      VALUES (?,?,?,?,?,?,?,?,'0',?)`, [id, botId, `t927-${tag}-${id}`, tag, customerId, unread, now, "سلام t927", now]);
    return id;
  };
  const chatH = insChat(botH.id, cHasani, 1, "hasani");
  const chatK = insChat(botK.id, cKazemi, 1, "kazemi");
  const chatG = insChat(botG.id, null, 0, "ghasemi");
  const chatT = insChat(botT.id, null, 1, "tajik");

  const guarded = ["team_sales_config", "notification_settings", "sales_teams", "sales_team_members", "users"];
  const beforeGuard = Object.fromEntries(guarded.map((t) => {
    try { return [t, hash(`SELECT * FROM ${t} ORDER BY rowid`)]; } catch { return [t, "absent"]; }
  }));
  const beforeOwners = hash("SELECT id, salesperson_id FROM customers ORDER BY id");

  const tokens = {};
  for (const id of [1, HASANI, GHASEMI, KAZEMI]) {
    const tok = crypto.randomBytes(24).toString("base64url"); tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), now]);
  }
  const app = express(); app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/api", auth.requireAuth, router);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: "127.0.0.1", port, agent: false, method, path: `/api${p}`,
      headers: { cookie: `crm_session=${tokens[user]}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => {
        let j = null; try { j = JSON.parse(t); } catch { j = t; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });

  const hasaniU = () => bb.bbUser(HASANI);
  const elU = { id: HASANI, role: "salesperson", salespersonId: SP_HASANI, customerScope: "assigned" };
  const authHasani = auth.getAuthUserById(HASANI);
  const idsOf = (chats) => new Set((chats ?? []).map((c) => c.id));
  const setOff = () => { setKey(bva.BVA_FLAG, null); setKey(bva.bvaUserKey(HASANI), null); perfCacheInvalidate(`bale-bot-me:${HASANI}`); };
  const setOn = () => { setKey(bva.BVA_FLAG, "1"); setKey(bva.bvaUserKey(HASANI), "8,3"); perfCacheInvalidate(`bale-bot-me:${HASANI}`); };

  setKey("flag.expert_lockdown", "1");
  setKey("flag.bale_bot", "1");
  setKey("flag.bale_bot.user.2", "1");
  setKey("flag.bale_bot.user.3", "1");
  setKey("flag.bale_bot.user.7", "1");
  setKey("flag.bale_bot.user.8", "1");
  setOff();

  await ok("flag OFF: Hasani view is own; helpers empty; cannot see Kazemi/Ghasemi/Tajik chats; no file access", async () => {
    assert.equal(bva.bvaOn(), false);
    assert.deepEqual(bva.bvaOwnerUserIds(hasaniU()), []);
    assert.equal(bb.bbView(hasaniU()), "own");
    assert.equal(el.elCustomerAccess(elU, cKazemi), null);
    assert.equal(el.elCustomerAccess(elU, cGhasemi), null);
    assert.equal(el.elCustomerAccess(elU, cAslanian), null);
    assert.equal(getCustomer(cKazemi, authHasani), undefined);
    const me = await call(HASANI, "GET", "/bale-bot/me");
    assert.equal(me.status, 200); assert.equal(me.body.view, "own"); assert.equal(me.body.viewAs, undefined);
    const list = await call(HASANI, "GET", "/bale-bot/chats");
    assert.equal(list.status, 200);
    const ids = idsOf(list.body.chats);
    assert.ok(ids.has(chatH), "own chat visible");
    assert.equal(ids.has(chatK), false);
    assert.equal(ids.has(chatG), false);
    assert.equal(ids.has(chatT), false);
    assert.equal((await call(HASANI, "GET", `/bale-bot/chats/${chatK}`)).status, 404);
    const page = await call(HASANI, "GET", `/customers/${cKazemi}`);
    assert.ok([403, 404].includes(page.status), `customer page ${page.status}`);
  });

  await ok("flag ON without a grant: same answers as OFF", async () => {
    setKey(bva.BVA_FLAG, "1");
    assert.equal(bva.bvaOn(), true);
    assert.deepEqual(bva.bvaOwnerUserIds(hasaniU()), []);
    assert.equal(el.elCustomerAccess(elU, cKazemi), null);
    const list = await call(HASANI, "GET", "/bale-bot/chats");
    const ids = idsOf(list.body.chats);
    assert.equal(ids.has(chatK), false);
    assert.equal(ids.has(chatG), false);
  });

  await ok("flag ON + grant 8,3: Hasani sees her chats plus Kazemi and Ghasemi, not Tajik; view stays own", async () => {
    setOn();
    const granted = bva.bvaOwnerUserIds(hasaniU());
    assert.equal(granted.length, 2, JSON.stringify(granted));
    assert.ok(granted.includes(8) && granted.includes(3), JSON.stringify(granted));
    assert.equal(bb.bbView(hasaniU()), "own");
    const me = await call(HASANI, "GET", "/bale-bot/me");
    assert.equal(me.status, 200); assert.equal(me.body.view, "own");
    assert.ok(Array.isArray(me.body.viewAs) && me.body.viewAs.includes(8) && me.body.viewAs.includes(3) && me.body.viewAs.length === 2, JSON.stringify(me.body.viewAs));
    const list = await call(HASANI, "GET", "/bale-bot/chats");
    assert.equal(list.status, 200);
    const ids = idsOf(list.body.chats);
    assert.ok(ids.has(chatH) && ids.has(chatK) && ids.has(chatG));
    assert.equal(ids.has(chatT), false);
    const names = new Set((list.body.experts ?? []).map((e) => e.id));
    assert.ok(names.has(HASANI) && names.has(KAZEMI) && names.has(GHASEMI));
    assert.equal(names.has(TAJIK), false);
    const one = await call(HASANI, "GET", `/bale-bot/chats/${chatK}`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.chat.canWrite, false);
    assert.equal(one.body.chat.sendBlocked, "view_only");
    assert.equal(one.body.chat.mine, false);
    const unreadAfter = queryRow("SELECT unread FROM bale_bot_chats WHERE id=?", [chatK]).unread;
    assert.equal(Number(unreadAfter), 1, "opening as viewer must not clear the owner's unread");
  });

  await ok("view-as is read-only: send / link are 403 view_only", async () => {
    const send = await call(HASANI, "POST", `/bale-bot/chats/${chatK}/messages`, { text: "نباید فرستاده شود" });
    assert.equal(send.status, 403);
    assert.equal(send.body.error, "view_only");
    const link = await call(HASANI, "POST", `/bale-bot/chats/${chatG}/link`, { customerId: cGhasemi });
    assert.equal(link.status, 403);
    assert.equal(queryRow("SELECT customer_id FROM bale_bot_chats WHERE id=?", [chatG]).customer_id, null);
  });

  await ok("file access: Kazemi and Ghasemi customers open; Aslanian stays closed; ownership unchanged", async () => {
    assert.equal(el.elCustomerAccess(elU, cKazemi), "delegated");
    assert.equal(el.elCustomerAccess(elU, cGhasemi), "delegated");
    assert.equal(el.elCustomerAccess(elU, cAslanian), null);
    assert.ok(getCustomer(cKazemi, authHasani), "getCustomer Kazemi");
    assert.ok(getCustomer(cGhasemi, authHasani), "getCustomer Ghasemi");
    assert.equal(getCustomer(cAslanian, authHasani), undefined);
    const pageK = await call(HASANI, "GET", `/customers/${cKazemi}`);
    assert.equal(pageK.status, 200, JSON.stringify(pageK.body?.error ?? pageK.body));
    const pageA = await call(HASANI, "GET", `/customers/${cAslanian}`);
    assert.ok([403, 404].includes(pageA.status), `aslanian ${pageA.status}`);
    const loan = await call(HASANI, "GET", `/loan-applications/${appId}`);
    assert.equal(loan.status, 200, JSON.stringify(loan.body?.error ?? loan.body));
    assert.equal(queryRow("SELECT salesperson_id FROM customers WHERE id=?", [cKazemi]).salesperson_id, SP_KAZEMI);
    assert.equal(queryRow("SELECT salesperson_id FROM customers WHERE id=?", [cGhasemi]).salesperson_id, SP_GHASEMI);
  });

  await ok("user 29 is ignored in a grant and never written; grant mentioning 29 is dropped", async () => {
    setKey(bva.bvaUserKey(HASANI), "8,3,29");
    const g29 = bva.bvaOwnerUserIds(hasaniU());
    assert.equal(g29.length, 2);
    assert.ok(g29.includes(8) && g29.includes(3));
    setKey(bva.bvaUserKey(USER29), "8,3");
    const u29 = bb.bbUser(USER29);
    assert.deepEqual(bva.bvaOwnerUserIds(u29 ?? { id: USER29 }), []);
  });

  await ok("flag OFF again restores the previous inbox and file answers; guarded tables unchanged", async () => {
    setOff();
    assert.equal(bva.bvaOn(), false);
    assert.equal(el.elCustomerAccess(elU, cKazemi), null);
    const list = await call(HASANI, "GET", "/bale-bot/chats");
    const ids = idsOf(list.body.chats);
    assert.ok(ids.has(chatH));
    assert.equal(ids.has(chatK), false);
    assert.equal(ids.has(chatG), false);
    assert.equal((await call(HASANI, "GET", `/customers/${cKazemi}`)).status !== 200, true);
    for (const t of guarded) {
      let nowH;
      try { nowH = hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { nowH = "absent"; }
      assert.equal(nowH, beforeGuard[t], `guarded table changed: ${t}`);
    }
    assert.equal(hash("SELECT id, salesperson_id FROM customers ORDER BY id"), beforeOwners);
    assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key='flag.expert_lockdown'").value, "1");
    assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key='flag.multi_team_v1'")?.value ?? "1", "1");
  });

  console.log(`t927-bale-view-as: ${passed} ok`);
} finally {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

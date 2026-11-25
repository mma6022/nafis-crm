// «مدیریت فروش» — ویرایش ربات بله‌ی کارشناس‌ها (flag.smc_bot_edit_v1) fixture.
// No network, no Bale message, no SMS: globalThis.fetch throws; Bale HTTP layer is a recording stub.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/smc-bot-edit-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smc-bot-edit-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
const keyFile = path.join(dir, "bot.key");
fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });

Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath,
  NODE_ENV: "production",
  LOG_LEVEL: "silent",
  DP_TEST_NO_BELLS: "1",
  BALE_BOT_WORKER: "0",
  SAB_FEEDER: "0",
  SMS_DISABLED: "1",
  BALE_BOT_KEY_FILE: keyFile,
  BALE_BOT_FILES_DIR: path.join(dir, "bale"),
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9",
  AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});

const netCalls = [];
globalThis.fetch = async (u) => {
  netCalls.push(String(u).replace(/bot[^/]+/, "bot<x>"));
  throw new Error("no network in fixture");
};

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const sab = await import("../src/lib/sales-admin-bale.ts");
  const bb = await import("../src/lib/bale-bot.ts");
  const { openBotToken, baleBotAad } = await import("../src/lib/bale-bot-crypto.ts");
  const { SMC_BOT_EDIT_FLAG } = await import("../src/lib/smc-bot-edit.ts");
  const shSend = await import("../src/lib/social-hub-send.ts");
  const bva = await import("../src/lib/bale-view-as.ts");
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { queryRow, queryRows, execute } = db;

  const setKey = (k, v) => v == null
    ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

  const flags = (smc, merge, bale, botEdit) => {
    setKey("flag.sales_manager_console_v1", smc);
    setKey("flag.sales_admin_merge_v12", merge);
    setKey(sab.SAB_FLAG, bale);
    setKey(SMC_BOT_EDIT_FLAG, botEdit);
  };

  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const allTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  const hashAll = () => Object.fromEntries(allTables().map((t) => [t, tableHash(t)]));
  const changedSince = (h0) => Object.keys(hashAll()).filter((t) => tableHash(t) !== (h0[t] ?? "new")).sort();

  const guarded = [
    "team_sales_config", "notification_settings", "sales_teams", "sales_team_members", "sales_intake_shares",
    "loan_plans", "contract_templates", "contracts", "users",
    "bale_accounts", "bale_settings", "bale_outbox", "bale_messages", "bale_conversation_state",
    "sms_outbox", "sms_log",
  ];
  const guardedBefore = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));

  const baleCalls = [];
  let nextBotUserId = 990100;
  const tokenToBot = new Map();
  bb.setBaleBotFetch(async (url, init) => {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(String(url));
    const tok = m ? m[1] : "";
    const method = m ? m[2] : "?";
    let body = {};
    try { body = JSON.parse(init?.body ?? "{}"); } catch { body = {}; }
    baleCalls.push({ method, chat_id: body.chat_id ?? null });
    if (method === "getMe") {
      if (tok.includes("INVALID")) {
        return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
      }
      if (!tokenToBot.has(tok)) {
        const id = nextBotUserId++;
        tokenToBot.set(tok, { id, first_name: `ربات آزمایشی ${id}`, username: `fx_bot_${id}`, is_bot: true });
      }
      return new Response(JSON.stringify({ ok: true, result: tokenToBot.get(tok) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Bale API call: ${method}`);
  });

  const tokens = {};
  for (const id of [1, 2, 3, 5, 6, 7, 8]) {
    const tok = crypto.randomBytes(24).toString("base64url");
    tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [
      crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"),
      id,
      new Date(Date.now() + 86400000).toISOString(),
      new Date().toISOString(),
    ]);
  }
  // Also make sure user 29 exists and test-verify they stay excluded/blocked if inactive
  const u29tok = crypto.randomBytes(24).toString("base64url");
  tokens[29] = u29tok;
  execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [
    crypto.createHmac("sha256", process.env.SESSION_SECRET).update(u29tok).digest("hex"),
    29,
    new Date(Date.now() + 86400000).toISOString(),
    new Date().toISOString(),
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", auth.requireAuth, router);
  app.use((_req, res) => res.status(404).send("spa"));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;

  const call = (user, method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({
      host: "127.0.0.1",
      port,
      agent: false,
      method,
      path: `/api${p}`,
      headers: {
        ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}),
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
      },
    }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(t); } catch { j = t; }
        resolve({ status: res.statusCode, body: j, text: t });
      });
    });
    rq.on("error", reject);
    if (data) rq.write(data);
    rq.end();
  });

  const ADMIN = 1, MANAGER = 5, HASANI = 2, GHASEMI = 3, ASLANIAN = 6, TAJIK = 7, KAZEMI = 8, NEVER29 = 29;

  await ok("flag OFF: /sales-admin/bots* 404, /sales-admin/me omits botEdit, zero writes", async () => {
    flags("1", "1", "1", null);
    const meOff = await call(ADMIN, "GET", "/sales-admin/me");
    assert.equal(meOff.status, 200);
    assert.equal(meOff.body.botEdit, undefined);

    const h0 = hashAll();
    for (const [m, p, b] of [
      ["GET", "/sales-admin/bots"],
      ["POST", "/sales-admin/bots/test", { token: "12345:ABCDEFGHIJKLMNOPQRST" }],
      ["POST", "/sales-admin/bots/8/test", {}],
      ["PUT", "/sales-admin/bots/8", { botName: "تست" }],
      ["POST", "/sales-admin/bots/8/disconnect", {}],
    ]) {
      const r = await call(ADMIN, m, p, b);
      assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
    }
    assert.deepEqual(changedSince(h0), [], "no DB writes while flag OFF");

    flags(null, null, null, "1");
    assert.equal((await call(ADMIN, "GET", "/sales-admin/bots")).status, 404, "console flag OFF still 404");
  });

  flags("1", "1", "1", "1");

  await ok("ON: admin + manager 200; experts + user 29 403; /me includes botEdit:true; Ghasemi listed; user 29 excluded", async () => {
    const meOn = await call(ADMIN, "GET", "/sales-admin/me");
    assert.equal(meOn.status, 200);
    assert.equal(meOn.body.botEdit, true);
    assert.equal(meOn.body.bale, true);

    for (const u of [ADMIN, MANAGER]) {
      assert.equal((await call(u, "GET", "/sales-admin/bots")).status, 200);
    }
    for (const u of [HASANI, GHASEMI, ASLANIAN, TAJIK, KAZEMI]) {
      assert.equal((await call(u, "GET", "/sales-admin/bots")).status, 403);
      assert.equal((await call(u, "PUT", "/sales-admin/bots/8", { botName: "x" })).status, 403);
      assert.equal((await call(u, "POST", "/sales-admin/bots/test", { token: "12345:ABCDEFGHIJKLMNOPQRST" })).status, 403);
    }
    assert.ok([401, 403].includes((await call(NEVER29, "GET", "/sales-admin/bots")).status));

    const list = (await call(ADMIN, "GET", "/sales-admin/bots")).body;
    assert.equal(list.flag, "flag.smc_bot_edit_v1");
    assert.equal(list.hasKey, true);
    const ids = list.experts.map((e) => e.userId);
    assert.ok(!ids.includes(29), "user 29 never listed");
    assert.ok(ids.includes(KAZEMI) && ids.includes(HASANI) && ids.includes(GHASEMI) && ids.includes(TAJIK) && ids.includes(ASLANIAN));

    const gh = list.experts.find((e) => e.userId === GHASEMI);
    assert.equal(gh.readonlySend, true);
    assert.equal(gh.bot.tokenSaved, true);
    assert.equal(gh.bot.tokenStatusLabel, "ثبت شده");
    assert.equal(JSON.stringify(list).includes("token_ct"), false);
  });

  await ok("edit botName + status + revert via smc_audit", async () => {
    const beforeRow = queryRow("SELECT id, bot_name, status FROM bale_bots WHERE user_id=?", [KAZEMI]);
    const r = await call(ADMIN, "PUT", `/sales-admin/bots/${KAZEMI}`, { botName: "ربات کاظمی (جدید)", status: "off" });
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, true);
    assert.ok(r.body.auditId > 0);
    assert.equal(r.body.expert.bot.name, "ربات کاظمی (جدید)");
    assert.equal(r.body.expert.bot.status, "off");

    // Re-save identical values -> changed:false, no extra audit
    const noop = await call(ADMIN, "PUT", `/sales-admin/bots/${KAZEMI}`, { botName: "ربات کاظمی (جدید)", status: "off" });
    assert.equal(noop.status, 200);
    assert.equal(noop.body.changed, false);

    // Revert restores original name and status
    const rev = await call(ADMIN, "POST", `/sales-admin/audit/${r.body.auditId}/revert`, {});
    assert.equal(rev.status, 200);
    const afterRev = queryRow("SELECT bot_name, status FROM bale_bots WHERE user_id=?", [KAZEMI]);
    assert.equal(afterRev.bot_name, beforeRow.bot_name);
    assert.equal(afterRev.status, beforeRow.status);
  });

  const tokAslanian = "777111222:AbCdEfGhIjKlMnOpQrStUvWxYz1234";
  const tokTajikNew = "888222333:ZyXwVuTsRqPoNmLkJiHgFeDcBa5678";

  await ok("connect new bot for Aslanian + masked write-only token never leaked in responses/logs/audit", async () => {
    const noTok = await call(ADMIN, "PUT", `/sales-admin/bots/${ASLANIAN}`, { status: "on", botName: "بی‌توکن" });
    assert.equal(noTok.status, 422);
    assert.equal(noTok.body.error, "no_token");

    const badTest = await call(ADMIN, "POST", "/sales-admin/bots/test", { token: "123:short" });
    assert.equal(badTest.status, 400);
    assert.equal(badTest.text.includes("123:short"), false);

    const badAuth = await call(ADMIN, "POST", "/sales-admin/bots/test", { token: "123456:INVALID_TOKEN_SHAPE_OK" });
    assert.equal(badAuth.status, 400);
    assert.equal(badAuth.text.includes("INVALID_TOKEN_SHAPE_OK"), false);

    const goodTest = await call(ADMIN, "POST", "/sales-admin/bots/test", { token: tokAslanian });
    assert.equal(goodTest.status, 200);
    assert.equal(goodTest.body.ok, true);
    assert.ok(goodTest.body.bot.username.startsWith("fx_bot_"));
    assert.equal(goodTest.text.includes(tokAslanian), false);

    const conn = await call(MANAGER, "PUT", `/sales-admin/bots/${ASLANIAN}`, {
      botName: "ربات آرش اصلانیان",
      status: "on",
      mode: "own",
      ai: false,
      token: tokAslanian,
    });
    assert.equal(conn.status, 200);
    assert.equal(conn.body.changed, true);
    assert.equal(conn.body.expert.bot.name, "ربات آرش اصلانیان");
    assert.equal(conn.body.expert.bot.tokenSaved, true);
    assert.equal(conn.body.expert.bot.tokenStatusLabel, "ثبت شده");
    assert.equal(conn.text.includes(tokAslanian), false);

    const row = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [ASLANIAN]);
    assert.ok(row?.token_ct);
    assert.equal(openBotToken(process.env, row.token_ct, baleBotAad(row.id, ASLANIAN)).plaintext, tokAslanian);

    // Token connect audit row is non-revertible
    const rev = await call(ADMIN, "POST", `/sales-admin/audit/${conn.body.auditId}/revert`, {});
    assert.equal(rev.status, 409);
    assert.equal(rev.body.error, "not_revertible");

    // Duplicate bot_user_id refused for another expert
    const dup = await call(ADMIN, "PUT", `/sales-admin/bots/${TAJIK}`, { token: tokAslanian });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "bot_in_use");

    // Replace Tajik token and test saved token
    const rep = await call(ADMIN, "PUT", `/sales-admin/bots/${TAJIK}`, {
      botName: "ربات خانم تاجیک",
      token: tokTajikNew,
    });
    assert.equal(rep.status, 200);
    assert.equal(rep.text.includes(tokTajikNew), false);

    const savedTest = await call(ADMIN, "POST", `/sales-admin/bots/${TAJIK}/test`, {});
    assert.equal(savedTest.status, 200);
    assert.equal(savedTest.body.ok, true);
    assert.equal(savedTest.text.includes(tokTajikNew), false);

    // Ensure token never leaked into smc_audit, bale_bot_log, or call_queue_settings_log
    const auditDump = JSON.stringify(queryRows("SELECT summary_fa, before_json, after_json FROM smc_audit"));
    const logDump = JSON.stringify(queryRows("SELECT action, outcome, detail FROM bale_bot_log"));
    const setDump = JSON.stringify(queryRows("SELECT key, old_value, new_value FROM call_queue_settings_log"));
    for (const tok of [tokAslanian, tokTajikNew]) {
      assert.equal(auditDump.includes(tok), false, "token must never appear in smc_audit");
      assert.equal(logDump.includes(tok), false, "token must never appear in bale_bot_log");
      assert.equal(setDump.includes(tok), false, "token must never appear in call_queue_settings_log");
    }
  });

  await ok("Ghasemi stays redirect-only (mode/ai rejected 403; botSends false; shSendGate closed); Hasani view-only intact", async () => {
    assert.equal((await call(ADMIN, "PUT", `/sales-admin/bots/${GHASEMI}`, { mode: "shared" })).status, 403);
    assert.equal((await call(ADMIN, "PUT", `/sales-admin/bots/${GHASEMI}`, { ai: true })).status, 403);

    const metaEdit = await call(ADMIN, "PUT", `/sales-admin/bots/${GHASEMI}`, { botName: "ربات خانم قاسمی (انتقال)", status: "on" });
    assert.equal(metaEdit.status, 200);
    assert.equal(metaEdit.body.expert.readonlySend, true);

    const ghRow = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [GHASEMI]);
    assert.equal(bb.botSends(ghRow), false, "Ghasemi regular Bale send stays blocked");
    assert.equal(shSend.shIsReadonlyBotUser(GHASEMI), true, "Ghasemi social-hub readonly stays true");

    // Hasani view-as stays view-only on Kazemi & Ghasemi
    setKey("flag.bale_view_as_v1", "1");
    setKey("bale_view_as.user.2", "8,3");
    const hasaniUser = bb.bbUser(HASANI);
    assert.equal(bb.bbView(hasaniUser), "own");
    assert.deepEqual(bva.bvaOwnerUserIds({ id: HASANI }), [8, 3], "Hasani sees Kazemi & Ghasemi view-only");
    assert.equal(bva.bvaCanSeeBotOwner({ id: HASANI }, KAZEMI), true);
    assert.equal(bva.bvaCanSeeBotOwner({ id: HASANI }, GHASEMI), true);
    const kazemiChat = queryRow("SELECT c.id FROM bale_bot_chats c JOIN bale_bots b ON b.id=c.bot_id WHERE b.user_id=? LIMIT 1", [KAZEMI]);
    if (kazemiChat) {
      setKey("flag.bale_bot", "1");
      setKey("flag.bale_bot.user.2", "1");
      const sendTry = await call(HASANI, "POST", `/bale-bot/chats/${kazemiChat.id}/messages`, { text: "تست" });
      assert.equal(sendTry.status, 403, "Hasani cannot send from Kazemi bot");
    }
  });

  await ok("disconnect clears token while keeping chat rows; works without sales_admin_bale_v13", async () => {
    const disc = await call(ADMIN, "POST", `/sales-admin/bots/${ASLANIAN}/disconnect`, {});
    assert.equal(disc.status, 200);
    assert.equal(disc.body.expert.bot.tokenSaved, false);
    assert.equal(disc.body.expert.bot.tokenStatusLabel, "ثبت نشده");
    assert.equal(disc.body.expert.bot.status, "off");

    flags("1", null, null, "1");
    assert.equal((await call(ADMIN, "GET", "/sales-admin/me")).body.botEdit, true);
    assert.equal((await call(ADMIN, "GET", "/sales-admin/bots")).status, 200);
    assert.equal((await call(MANAGER, "GET", "/sales-admin/bots")).status, 403, "unmerged console is admin-only");
  });

  await ok("red lines: zero network calls, zero Bale sends, guarded tables untouched", async () => {
    assert.deepEqual(netCalls, [], "zero real network fetches");
    assert.ok(baleCalls.every((c) => c.method === "getMe"), `unexpected Bale API call: ${JSON.stringify(baleCalls)}`);
    for (const t of guarded) {
      assert.equal(tableHash(t), guardedBefore[t], `guarded table ${t} modified`);
    }
  });

  console.log(`\nALL ${passed} SMC-BOT-EDIT TESTS PASSED`);
} finally {
  try { server?.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

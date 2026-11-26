/**
 * t945u social-hub bot manage fixture (edit / delete / re-add). Temp COPY of a masked DB, synthetic rows, fetch stubbed to throw (no Bale / SMS / network).
 * Usage: SOCIAL_HUB_FIXTURE_DB=/workspace/t861/masked.db node scripts/run-bundled-fixture.mjs scripts/t945-sh-bot-manage-fixture.mjs
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t945-sh-fixture-"));
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
  for (const k of [sh.SH_FLAG, sh.SH_PHONE_FLAG, sh.SH_SEND_FLAG, sh.SH_AUTO_SEND_FLAG, sh.SH_CONNECT_FLAG, sh.SH_REDIRECT_FLAG, sh.SH_LEGACY_FINISH_FLAG]) flag(k, null);
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

  const tbl = (t) => { try { return JSON.stringify(queryRows(`SELECT * FROM ${t}`)); } catch { return null; } };
  const guardedBefore = Object.fromEntries(["loan_plans", "team_sales_config", "notification_settings"].map((t) => [t, tbl(t)]));
  flag(sh.SH_FLAG, "1"); flag(sh.SH_CONNECT_FLAG, "1");
  const tokWrong = "700100200:WrongBotTokenFixtureOnly_aaaaaaaa";
  const tokRight = "700100300:RightBotTokenFixtureOnly_bbbbbbbb";
  const bots = { [tokWrong]: { id: "9101", name: "ربات اشتباهی", username: "wrong_fx_bot" }, [tokRight]: { id: "9102", name: "نفیس وام", username: "right_fx_bot" } };
  shs.setShGetMeForTests(async (t) => (bots[t] ? { ok: true, bot: bots[t] } : { ok: false, error: "bad_token" }));
  const dump = () => JSON.stringify(queryRows("SELECT * FROM sh_log")) + JSON.stringify(queryRows("SELECT * FROM sh_bots")) + JSON.stringify(queryRows("SELECT id,user_id,bot_user_id,bot_username,bot_name,status,token_key_id FROM bale_bots"));
  const unified = () => queryRow("SELECT * FROM bale_bots WHERE user_id=0");

  await ok("wrong key saved by the manager is replaced by the right one; a different bot restarts the update offset; same bot keeps it", async () => {
    assert.equal((await req("sm", "POST", "/api/social-hub/bots/connect", { token: tokWrong })).status, 201);
    const row0 = unified(); assert.ok(row0.token_ct);
    execute("UPDATE bale_bots SET next_offset=55, backlog_skipped=1 WHERE id=?", [row0.id]);
    const r = await req("sm", "POST", "/api/social-hub/bots/connect", { token: tokRight });
    assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.username, "right_fx_bot");
    const row1 = unified(); assert.equal(row1.id, row0.id); assert.equal(row1.next_offset, 0); assert.equal(row1.backlog_skipped, 0);
    assert.equal(row1.bot_username, "right_fx_bot");
    execute("UPDATE bale_bots SET next_offset=9, backlog_skipped=1 WHERE id=?", [row1.id]);
    assert.equal((await req("sm", "POST", "/api/social-hub/bots/connect", { token: tokRight })).status, 201);
    assert.equal(unified().next_offset, 9);
    assert.ok(!JSON.stringify(r.data).includes(tokRight));
  });

  let chatRow = 0;
  await ok("DELETE on the unified bot: key wiped, row + chats kept, view back to draft, audit has who/when/@username and no key", async () => {
    const row = unified();
    execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,created_at) VALUES(?,?,?,datetime('now'))", [row.id, "fx-chat-1", "مشتری آزمایشی"]);
    chatRow = Number(queryRow("SELECT id FROM bale_bot_chats WHERE bot_id=? AND chat_id='fx-chat-1'", [row.id]).id);
    const before = (await req("sm", "GET", "/api/social-hub/bots")).data;
    const ub = before.bots.find((b) => b.unified);
    const del = await req("sm", "DELETE", `/api/social-hub/bots/${ub.id}`);
    assert.equal(del.status, 200, JSON.stringify(del.data));
    const after = unified();
    assert.equal(after.token_ct, null); assert.equal(after.token_key_id, null); assert.equal(after.status, "off");
    assert.equal(after.bot_user_id, null); assert.equal(after.bot_username, null); assert.equal(after.next_offset, 0);
    assert.equal(after.id, row.id);
    assert.ok(queryRow("SELECT 1 x FROM bale_bot_chats WHERE id=?", [chatRow]), "chats kept");
    assert.equal(del.data.connect.tokenSaved, false); assert.equal(del.data.connect.status, "draft");
    const u = del.data.bots.find((b) => b.unified); assert.equal(u.status, "draft"); assert.equal(u.handle, null);
    const log = queryRow("SELECT * FROM sh_log WHERE action='bot_disconnect' ORDER BY id DESC LIMIT 1");
    assert.equal(log.user_id, 5); assert.ok(log.at); assert.equal(JSON.parse(log.detail).username, "right_fx_bot"); assert.equal(JSON.parse(log.detail).keyWiped, true);
    for (const t of [tokWrong, tokRight]) assert.ok(!dump().includes(t) && !JSON.stringify(del.data).includes(t));
    assert.equal(sh_openable(row.id), false, "no sealed key is left to open");
    assert.equal(netCalls, 0);
  });
  function sh_openable(id) { const r = queryRow("SELECT token_ct FROM bale_bots WHERE id=?", [id]); return Boolean(r?.token_ct); }

  await ok("second delete is a clear 404; test-saved refuses with no key", async () => {
    const id = (await req("sm", "GET", "/api/social-hub/bots")).data.bots.find((b) => b.unified).id;
    const again = await req("sm", "DELETE", `/api/social-hub/bots/${id}`);
    assert.equal(again.status, 404); assert.equal(again.data.error, "not_connected");
    assert.equal((await req("sm", "POST", "/api/social-hub/bots/test-saved")).status, 409);
  });

  await ok("add again after delete: new key saves, connects, test-saved works", async () => {
    const r = await req("admin", "POST", "/api/social-hub/bots/connect", { token: tokRight });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const v = (await req("admin", "GET", "/api/social-hub/bots")).data;
    assert.equal(v.connect.tokenSaved, true); assert.equal(v.connect.username, "right_fx_bot");
    assert.ok(queryRow("SELECT 1 x FROM bale_bot_chats WHERE id=?", [chatRow]));
    assert.equal((await req("admin", "POST", "/api/social-hub/bots/test-saved")).status, 200);
    assert.ok(!dump().includes(tokRight));
  });

  await ok("a running «پیام انتقال» campaign blocks the disconnect (409) until it is stopped", async () => {
    execute("INSERT INTO sh_redirect_campaigns(started_by,started_at,status,recipient_count,snapshot) VALUES(1,datetime('now'),'running',1,'{}')");
    const id = (await req("sm", "GET", "/api/social-hub/bots")).data.bots.find((b) => b.unified).id;
    const r = await req("sm", "DELETE", `/api/social-hub/bots/${id}`);
    assert.equal(r.status, 409); assert.equal(r.data.error, "campaign_running"); assert.ok(unified().token_ct);
    execute("DELETE FROM sh_redirect_campaigns WHERE status='running'");
  });

  await ok("only manager / admin: experts 403, no session 401; flag OFF → 404; connect flag OFF → 409 and nothing changes", async () => {
    const id = (await req("sm", "GET", "/api/social-hub/bots")).data.bots.find((b) => b.unified).id;
    for (const a of ["kazemi", "ghasemi"]) {
      assert.equal((await req(a, "DELETE", `/api/social-hub/bots/${id}`)).status, 403);
      assert.equal((await req(a, "PATCH", `/api/social-hub/bots/${id}`, { handle: "x_bot" })).status, 403);
    }
    assert.equal((await call("nobody", "DELETE", `/api/social-hub/bots/${id}`)).status, 401);
    const snap = JSON.stringify(unified());
    flag(sh.SH_CONNECT_FLAG, null);
    const off = await req("sm", "DELETE", `/api/social-hub/bots/${id}`); assert.equal(off.status, 409); assert.equal(JSON.stringify(unified()), snap);
    flag(sh.SH_CONNECT_FLAG, "1");
    flag(sh.SH_FLAG, null); assert.equal((await req("sm", "DELETE", `/api/social-hub/bots/${id}`)).status, 404); flag(sh.SH_FLAG, "1");
  });

  await ok("draft bot of another network: add → edit handle → delete (archived, audited) → add the same network again", async () => {
    const add = await req("sm", "POST", "/api/social-hub/bots", { network: "eitaa", handle: "@wrong_eitaa", access: "managers" });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    const b = add.data.bots.find((x) => x.network === "eitaa"); assert.ok(b);
    assert.equal((await req("sm", "POST", "/api/social-hub/bots", { network: "eitaa" })).status, 409);
    assert.equal((await req("sm", "PATCH", `/api/social-hub/bots/${b.id}`, { handle: "bad handle!" })).status, 400);
    const ed = await req("sm", "PATCH", `/api/social-hub/bots/${b.id}`, { handle: "@right_eitaa" });
    assert.equal(ed.status, 200, JSON.stringify(ed.data)); assert.equal(ed.data.bots.find((x) => x.id === b.id).handle, "@right_eitaa");
    const cleared = await req("sm", "PATCH", `/api/social-hub/bots/${b.id}`, { handle: "" }); assert.equal(cleared.data.bots.find((x) => x.id === b.id).handle, null);
    const del = await req("sm", "DELETE", `/api/social-hub/bots/${b.id}`);
    assert.equal(del.status, 200, JSON.stringify(del.data)); assert.ok(!del.data.bots.some((x) => x.id === b.id));
    const row = queryRow("SELECT * FROM sh_bots WHERE id=?", [b.id]); assert.ok(row.archived_at); assert.equal(row.status, "off");
    assert.ok(queryRow("SELECT 1 x FROM sh_log WHERE action='bot_remove' AND ref_id=?", [b.id]));
    assert.ok(queryRow("SELECT 1 x FROM sh_log WHERE action='bot_edit' AND ref_id=?", [b.id]));
    assert.equal((await req("sm", "GET", `/api/social-hub/bots/${b.id}/access`)).status, 404);
    assert.equal((await req("sm", "DELETE", `/api/social-hub/bots/${b.id}`)).status, 404);
    const again = await req("sm", "POST", "/api/social-hub/bots", { network: "eitaa", handle: "@fresh_eitaa" });
    assert.equal(again.status, 201); assert.equal(again.data.bots.filter((x) => x.network === "eitaa").length, 1);
    const uni = again.data.bots.find((x) => x.unified);
    assert.equal((await req("sm", "PATCH", `/api/social-hub/bots/${uni.id}`, { handle: "x_bot" })).status, 409);
  });

  await ok("old schema (full unique index, no archived_at) upgrades in place; unified row and data survive; idempotent", async () => {
    const { crmDb } = await import("../src/lib/crm-db.ts");
    crmDb.exec("DELETE FROM sh_bots WHERE archived_at IS NOT NULL; DROP INDEX IF EXISTS ux_sh_bots_network; ALTER TABLE sh_bots DROP COLUMN archived_at; CREATE UNIQUE INDEX ux_sh_bots_network ON sh_bots(network);");
    sh._resetShSchemaForTests();
    const r = await req("sm", "GET", "/api/social-hub/bots"); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(queryRows("PRAGMA table_info(sh_bots)").some((c) => c.name === "archived_at"));
    assert.match(queryRow("SELECT sql FROM sqlite_master WHERE name='ux_sh_bots_network'").sql, /archived_at IS NULL/);
    assert.ok(r.data.bots.some((x) => x.unified)); assert.equal(r.data.connect.tokenSaved, true);
    sh._resetShSchemaForTests(); assert.equal((await req("sm", "GET", "/api/social-hub/bots")).status, 200);
    assert.equal(queryRows("SELECT 1 FROM sh_bots WHERE unified=1").length, 1);
  });

  await ok("red lines: zero network calls; loan_plans / team_sales_config / notification_settings untouched", async () => {
    assert.equal(netCalls, 0);
    for (const t of Object.keys(guardedBefore)) assert.equal(tbl(t), guardedBefore[t], `${t} modified`);
  });
  console.log(`t945 sh-bot-manage fixture ${passed}/9`);
  if (passed !== 9) process.exitCode = 1;
} catch (err) { console.error(err); process.exitCode = 1; }
finally { if (server) await new Promise((r) => server.close(r)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } }

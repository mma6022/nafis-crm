// customers-priority-kanban v1 (flag.customers_priority_kanban_v1): flag probe + list nextReminderAt + priority PATCH path.
// No network. No live DB. Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/customers-priority-kanban-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpk-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/^(SAPI_|IR_RELAY|ICS24_|NAFIS_IDTEST)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1",
  BALE_BOT_WORKER: "0", SAB_FEEDER: "0", SMS_DISABLED: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "fixture-placeholder";
delete process.env.OPENAI_API_KEY;
const netCalls = [];
globalThis.fetch = async (u) => { netCalls.push(String(u).slice(0, 40)); throw new Error("no network in fixture"); };

let passed = 0;
const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
let server;

try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const cpk = await import("../src/lib/customers-priority-kanban.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { queryRow, queryRows, execute } = db;
  const setKey = (k, v) => v == null
    ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql, params = []) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql, params))).digest("hex");
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const guarded = ["team_sales_config", "notification_settings", "contracts", "contract_templates", "loan_plans"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));

  const ADMIN = 1, KAZEMI = 8, HASANI = 2, TRAINEE = 31;
  const tokens = {};
  for (const id of [ADMIN, KAZEMI, HASANI, TRAINEE]) {
    const tok = crypto.randomBytes(24).toString("base64url");
    tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]);
  }
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use("/elapi", auth.requireAuth, el.expertLockdownGuard, router);
  app.use("/api", auth.requireAuth, router);
  app.use((_req, res) => res.status(404).send("spa"));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body, prefix = "/api") => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({
      host: "127.0.0.1", port, agent: false, method, path: `${prefix}${p}`,
      headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
    }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, text: t }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });

  const mine = queryRow("SELECT id, priority, status FROM customers WHERE salesperson_id=(SELECT salesperson_id FROM users WHERE id=?) AND merged_into_customer_id IS NULL AND COALESCE(status,'in_progress')='in_progress' AND priority=3 ORDER BY id LIMIT 1", [KAZEMI]);
  const other = queryRow("SELECT id FROM customers WHERE salesperson_id=(SELECT salesperson_id FROM users WHERE id=?) AND merged_into_customer_id IS NULL AND COALESCE(status,'in_progress')='in_progress' ORDER BY id LIMIT 1", [HASANI]);
  assert.ok(mine?.id, "need one of Kazemi's P3 customers");
  assert.ok(other?.id, "need one of Hasani's customers");
  const CID = Number(mine.id);
  const OTHER = Number(other.id);
  const REM_AT = "2026-11-19T06:30:00.000Z"; // 10:00 Tehran on 19 Nov 2026 / 28 Aban
  execute(
    "INSERT INTO reminders(user_id,salesperson_id,customer_id,subject,message,remind_at,sent_sms,done,created_at,created_by,note,voided_at) VALUES(?,?,?,?,?,?,0,0,?,?,NULL,NULL)",
    [KAZEMI, 6, CID, "پیگیری", "fixture reminder", REM_AT, new Date().toISOString(), KAZEMI],
  );
  const remId = queryRow("SELECT id FROM reminders WHERE customer_id=? AND user_id=? AND message='fixture reminder' ORDER BY id DESC LIMIT 1", [CID, KAZEMI]).id;

  await ok("flag absent or '0': /customers-priority-kanban/me is 404; list has no nextReminderAt; cpkOn is false", async () => {
    setKey(cpk.CPK_FLAG, null);
    assert.equal(cpk.cpkOn(), false);
    for (const u of [ADMIN, KAZEMI]) assert.equal((await call(u, "GET", "/customers-priority-kanban/me")).status, 404, `${u} absent`);
    setKey(cpk.CPK_FLAG, "0");
    assert.equal(cpk.cpkOn(), false);
    assert.equal((await call(KAZEMI, "GET", "/customers-priority-kanban/me")).status, 404);
    const list = await call(KAZEMI, "GET", `/customers?customerId=${CID}&limit=1`);
    assert.equal(list.status, 200, list.text);
    const item = list.body.items.find((x) => x.id === CID) ?? list.body.items[0];
    assert.ok(item, "list item");
    assert.equal(Object.prototype.hasOwnProperty.call(item, "nextReminderAt"), false, "no nextReminderAt while OFF");
  });

  await ok("flag ON: me is {enabled:true}; list includes nextReminderAt for the expert's open reminder; another customer stays null", async () => {
    setKey(cpk.CPK_FLAG, "1");
    assert.equal(cpk.cpkOn(), true);
    const me = await call(KAZEMI, "GET", "/customers-priority-kanban/me");
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body, { enabled: true });
    const list = await call(KAZEMI, "GET", `/customers?customerId=${CID}&limit=1`);
    assert.equal(list.status, 200, list.text);
    const item = list.body.items.find((x) => x.id === CID);
    assert.ok(item, "flag-on item");
    assert.equal(item.nextReminderAt, REM_AT);
    const otherList = await call(KAZEMI, "GET", `/customers?customerId=${OTHER}&limit=1`);
    // assigned-scope expert may not see the other owner; if 200 and empty / no item, that's fine
    if (otherList.status === 200 && otherList.body.items?.some((x) => x.id === OTHER)) {
      assert.equal(otherList.body.items.find((x) => x.id === OTHER).nextReminderAt, null);
    }
  });

  await ok("flag ON: unauthenticated me is 401; only the viewer's own open reminder is attached", async () => {
    const noAuth = await call(null, "GET", "/customers-priority-kanban/me");
    assert.equal(noAuth.status, 401);
    // Do not insert a second open reminder on the same customer (reminders-follow keeps one open).
    assert.equal(cpk.cpkNextReminderAt([CID], KAZEMI).get(CID), REM_AT);
    assert.equal(cpk.cpkNextReminderAt([CID], HASANI).get(CID), undefined);
  });

  const histBefore = queryRow("SELECT COUNT(*) AS n FROM customer_priority_history WHERE customer_id=?", [CID]).n;
  const oldPri = Number(mine.priority);

  await ok("priority PATCH uses the existing path: expert can change own customer; history source is customer_update; other expert's customer is rejected", async () => {
    setKey(cpk.CPK_FLAG, "1");
    const next = oldPri === 3 ? 2 : 3;
    const res = await call(KAZEMI, "PATCH", `/customers/${CID}`, { priority: next });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.priority, next);
    const row = queryRow("SELECT old_priority, new_priority, source, actor_user_id FROM customer_priority_history WHERE customer_id=? ORDER BY id DESC LIMIT 1", [CID]);
    assert.equal(Number(row.old_priority), oldPri);
    assert.equal(Number(row.new_priority), next);
    assert.equal(row.source, "customer_update");
    assert.equal(Number(row.actor_user_id), KAZEMI);
    assert.equal(queryRow("SELECT COUNT(*) AS n FROM customer_priority_history WHERE customer_id=?", [CID]).n, histBefore + 1);
    const deny = await call(KAZEMI, "PATCH", `/customers/${OTHER}`, { priority: 2 });
    assert.ok(deny.status === 404 || deny.status === 403, `other customer: ${deny.status} ${deny.text}`);
    // restore
    const back = await call(KAZEMI, "PATCH", `/customers/${CID}`, { priority: oldPri });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.priority, oldPri);
  });

  await ok("lockdown: flag OFF keeps GET /customers 403 for the expert; flag ON opens me + own list, not another expert's customer", async () => {
    setKey(cpk.CPK_FLAG, null);
    assert.equal((await call(KAZEMI, "GET", "/customers-priority-kanban/me", undefined, "/elapi")).status, 404);
    assert.equal((await call(KAZEMI, "GET", `/customers?limit=1`, undefined, "/elapi")).status, 403);
    setKey(cpk.CPK_FLAG, "1");
    const me = await call(KAZEMI, "GET", "/customers-priority-kanban/me", undefined, "/elapi");
    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body, { enabled: true });
    const list = await call(KAZEMI, "GET", `/customers?customerId=${CID}&limit=5`, undefined, "/elapi");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.items.every((x) => x.id !== OTHER), "other expert's customer is not listed");
    assert.ok(list.body.items.some((x) => x.id === CID), "own customer is listed");
    const deny = await call(KAZEMI, "GET", `/customers/${OTHER}`, undefined, "/elapi");
    assert.ok(deny.status === 403 || deny.status === 404, `other file ${deny.status}`);
  });

  await ok("trainee 31 cannot change Kazemi's customer; guarded tables untouched; no network", async () => {
    const beforePri = queryRow("SELECT priority FROM customers WHERE id=?", [CID]).priority;
    const deny = await call(TRAINEE, "PATCH", `/customers/${CID}`, { priority: 1 });
    assert.ok(deny.status === 404 || deny.status === 403, `trainee: ${deny.status} ${deny.text}`);
    assert.equal(queryRow("SELECT priority FROM customers WHERE id=?", [CID]).priority, beforePri);
    // lockdown guard still wraps the same router
    const locked = await call(KAZEMI, "PATCH", `/customers/${CID}`, { priority: oldPri }, "/elapi");
    assert.ok(locked.status === 200 || locked.status === 403, `lockdown path ${locked.status}`);
    if (locked.status === 200) assert.equal(locked.body.priority, oldPri);
    for (const t of guarded) assert.equal(tableHash(t), before[t], t);
    assert.equal(netCalls.length, 0, "no network");
  });

  execute("DELETE FROM reminders WHERE id=? OR (customer_id=? AND message IN ('fixture reminder','hasani reminder should not attach'))", [remId, CID]);
  setKey(cpk.CPK_FLAG, null);
  console.log(`customers-priority-kanban fixture ${passed}/6`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
}

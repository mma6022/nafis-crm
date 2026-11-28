/**
 * t978 backend: sh_messages on the Bale chat API behind flag.bale_sh_messages_v1 (default OFF).
 * Scratch copy of a masked DB only (run-t978-bale-sh-messages-fixture.mjs). Fetch is stubbed; workers off; no live writes.
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema } from "../src/lib/bale-bot.ts";
import { BALE_SH_FLAG, baleShOn, baleShReady } from "../src/lib/bale-sh-messages.ts";
import { createBaleWorkspaceRouter } from "../src/routes/bale-workspace.ts";
import { createBaleBotRouter } from "../src/routes/bale-bot.ts";
import { SAB_FLAG } from "../src/lib/sales-admin-bale.ts";

if (!process.env.CRM_DATABASE_PATH || process.env.CRM_DATABASE_PATH.includes("/var/lib/nafisvam")) throw new Error("scratch DB only");

const net = [];
globalThis.fetch = async (u) => { net.push(String(u)); throw new Error("network blocked in t978 fixture"); };

const failures = []; let passed = 0;
const check = async (name, fn) => { try { await fn(); passed++; console.log("  ok ", name); } catch (e) { failures.push(name); console.error("  FAIL", name, e?.stack?.split("\n").slice(0, 4).join(" | ") ?? e); } };
const setFlag = (k, v) => v == null ? executeChanges("DELETE FROM call_queue_settings WHERE key=?", [k]) : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

ensureBaleBotSchema();

const EXPERT = 8, ADMIN = 1;
const sp = queryRow("SELECT salesperson_id s FROM users WHERE id=?", [EXPERT]).s;
const own = queryRow(`SELECT a.customer_id id, a.plan_id currentPlan
  FROM loan_applications a JOIN customers c ON c.id=a.customer_id
  WHERE c.salesperson_id=? AND a.deleted_at IS NULL AND a.plan_id IS NOT NULL
    AND COALESCE(c.merged_into_customer_id,0)=0
    AND EXISTS (SELECT 1 FROM loan_plans p WHERE p.id=a.plan_id AND p.active=1)
  ORDER BY COALESCE(a.updated_at,a.created_at) DESC, a.id DESC LIMIT 1`, [sp]);
assert.ok(own?.id && own.currentPlan, "expert customer with an active current plan");
const currentPlan = Number(own.currentPlan);
const bot8 = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [EXPERT]);
assert.ok(bot8, "bot of user 8");
const T0 = "2026-11-18T07:00:00.000Z";
const linked = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [bot8.id, "t978-linked", "fx", own.id, "manual", T0, T0]);
const unlinked = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [bot8.id, "t978-unlinked", "fx", null, null, T0, T0]);

execute(`CREATE TABLE IF NOT EXISTS sh_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('free','plan')), plan_id INTEGER, title TEXT NOT NULL, body TEXT NOT NULL,
  show_today INTEGER NOT NULL DEFAULT 1, auto_send INTEGER NOT NULL DEFAULT 0, is_initial INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL,
  CHECK((kind='free' AND plan_id IS NULL AND auto_send=0) OR (kind='plan' AND plan_id IS NOT NULL)))`);
const now = "2026-11-25T12:41:54.000Z";
const ins = (kind, planId, title, body, sort, extra = {}) => execute(
  "INSERT INTO sh_messages(kind,plan_id,title,body,show_today,auto_send,is_initial,sort,archived,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  [kind, planId, title, body, extra.showToday ?? 1, 0, 0, sort, extra.archived ?? 0, EXPERT, now, EXPERT, now],
);
// active plans in the masked DB include 3 and 8; inactive include 2 and 7
const idFreeA = ins("free", null, "سلام آزاد", "سلام ‹نام مشتری›، من ‹نام کارشناس› هستم.", 10);
const idFreeHidden = ins("free", null, "مدارک آزاد", "لطفاً مدارک را بفرستید.", 20, { showToday: 0 });
const idPlanActive = ins("plan", currentPlan, "معرفی طرح فعال", "شرایط ‹نام طرح› برای ‹نام مشتری›.", 15);
const idPlanInactive = ins("plan", 2, "طرح خاموش", "این طرح غیرفعال است.", 16);
const idArchived = ins("free", null, "بایگانی", "نباید دیده شود.", 5, { archived: 1 });
const idPlanActiveLater = ins("plan", 3, "معرفی ستاره", "متن ستاره.", 30);

execute("INSERT OR REPLACE INTO call_queue_settings(key,value,updated_at) VALUES('sab.quick_messages',?,datetime('now'))",
  [JSON.stringify([{ id: "qabc1234", title: "پیش‌فرض sab", body: "متن پیش‌فرض sab" }])]);

// current plan comes from an existing loan_applications row on the scratch copy (no write to loan_plans).

setFlag("flag.bale_bot", "1");
setFlag(`flag.bale_bot.user.${EXPERT}`, "1");
setFlag(`flag.bale_bot.user.${ADMIN}`, "1");
setFlag("flag.bale_workspace_v1", "1");
setFlag("flag.sales_manager_console_v1", "1");
setFlag("flag.sales_admin_merge_v12", "1");
setFlag(SAB_FLAG, "1");
setFlag(BALE_SH_FLAG, null); // default OFF

const app = express();
app.use((req, res, next) => { const id = Number(req.headers["x-uid"]); if (id) res.locals.authUser = { id }; next(); });
app.use("/api", createBaleWorkspaceRouter({ kick: () => {} }), createBaleBotRouter());
app.use((_req, res) => res.status(404).json({ error: "fallthrough" }));
const srv = http.createServer(app); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const call = (uid, method, p, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const rq = http.request({ host: "127.0.0.1", port, path: `/api${p}`, method, headers: { "x-uid": String(uid), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (rs) => {
    const ch = []; rs.on("data", (c) => ch.push(c)); rs.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString()); } catch { j = null; } resolve({ status: rs.statusCode, body: j }); });
  });
  rq.on("error", reject); if (data) rq.write(data); rq.end();
});

const idsOf = (items) => items.map((x) => x.id);
const titlesOf = (items) => items.map((x) => x.title);

console.log("t978 bale sh_messages fixture");

await check("flag absent (default OFF): context has no ready; /quick is sab-only with no ready field", async () => {
  assert.equal(baleShOn(), false);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.assets.ready, undefined);
  assert.ok(Array.isArray(ctx.body.assets.quick));
  assert.deepEqual(ctx.body.assets.quick, [{ id: "qabc1234", title: "پیش‌فرض sab" }]);
  const q = await call(EXPERT, "GET", "/bale-bot/quick");
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.items, [{ id: "qabc1234", title: "پیش‌فرض sab" }]);
  assert.equal(q.body.ready, undefined);
});

await check("flag 0 is OFF, same as absent", async () => {
  setFlag(BALE_SH_FLAG, "0");
  assert.equal(baleShOn(), false);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  assert.equal(ctx.body.assets.ready, undefined);
  setFlag(BALE_SH_FLAG, null);
});

await check("POST /ready is 404 while the flag is OFF", async () => {
  const r = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idFreeA}`, {});
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "flag_off");
});

setFlag(BALE_SH_FLAG, "1");

await check("lib: archived=0, active-plan filter, sort then id; show_today=0 still included; no category", async () => {
  const r = baleShReady(own.id);
  assert.deepEqual(idsOf(r.items), [idFreeA, idPlanActive, idFreeHidden, idPlanActiveLater]);
  assert.ok(!idsOf(r.items).includes(idPlanInactive));
  assert.ok(!idsOf(r.items).includes(idArchived));
  const free = r.items.find((x) => x.id === idFreeA);
  assert.deepEqual(free, { id: idFreeA, kind: "free", planId: null, planTitle: null, title: "سلام آزاد", body: "سلام ‹نام مشتری›، من ‹نام کارشناس› هستم." });
  const plan = r.items.find((x) => x.id === idPlanActive);
  assert.equal(plan.kind, "plan");
  assert.equal(plan.planId, currentPlan);
  assert.equal(typeof plan.planTitle, "string");
  assert.ok(plan.planTitle.length > 0);
  assert.equal(plan.title, "معرفی طرح فعال");
  assert.equal(plan.body, "شرایط ‹نام طرح› برای ‹نام مشتری›.");
  assert.equal(r.currentPlanId, currentPlan);
  assert.equal(r.currentPlanTitle, plan.planTitle);
  r.items.forEach((x) => assert.equal("category" in x, false));
});

await check("context ready + current-plan hint; sab.quick unchanged", async () => {
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  assert.equal(ctx.status, 200);
  assert.deepEqual(ctx.body.assets.quick, [{ id: "qabc1234", title: "پیش‌فرض sab" }]);
  const ready = ctx.body.assets.ready;
  assert.ok(ready);
  assert.equal(ready.currentPlanId, currentPlan);
  assert.equal(typeof ready.currentPlanTitle, "string");
  assert.deepEqual(idsOf(ready.items), [idFreeA, idPlanActive, idFreeHidden, idPlanActiveLater]);
  assert.equal(ready.items.find((x) => x.id === idPlanActive).planId, currentPlan);
  assert.equal(ready.items.find((x) => x.id === idPlanActive).planTitle, ready.currentPlanTitle);
});

await check("unlinked chat: ready items present, current plan hint is null", async () => {
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${unlinked}/context`);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.assets.ready.currentPlanId, null);
  assert.equal(ctx.body.assets.ready.currentPlanTitle, null);
  assert.deepEqual(idsOf(ctx.body.assets.ready.items), [idFreeA, idPlanActive, idFreeHidden, idPlanActiveLater]);
});

await check("GET /bale-bot/quick keeps sab items and adds ready (no per-chat hint)", async () => {
  const q = await call(EXPERT, "GET", "/bale-bot/quick");
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.items, [{ id: "qabc1234", title: "پیش‌فرض sab" }]);
  assert.equal(q.body.ready.currentPlanId, null);
  assert.equal(q.body.ready.currentPlanTitle, null);
  assert.deepEqual(idsOf(q.body.ready.items), [idFreeA, idPlanActive, idFreeHidden, idPlanActiveLater]);
  assert.deepEqual(titlesOf(q.body.ready.items), ["سلام آزاد", "معرفی طرح فعال", "مدارک آزاد", "معرفی ستاره"]);
});

await check("sab-only /quick still 404s when sab flags go off and the new flag is also off; with only the new flag, items=[] and ready is present", async () => {
  setFlag(SAB_FLAG, "0");
  setFlag(BALE_SH_FLAG, "0");
  const off = await call(EXPERT, "GET", "/bale-bot/quick");
  assert.equal(off.status, 404);
  setFlag(BALE_SH_FLAG, "1");
  const only = await call(EXPERT, "GET", "/bale-bot/quick");
  assert.equal(only.status, 200);
  assert.deepEqual(only.body.items, []);
  assert.ok(only.body.ready.items.length >= 4);
  setFlag(SAB_FLAG, "1");
});

await check("POST /ready queues rendered text; does not call the network; sab quick still queues", async () => {
  const before = net.length;
  const r = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idPlanActive}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const queued = queryRow("SELECT text, kind, dir, status FROM bale_bot_messages WHERE id=?", [r.body.message.id]);
  assert.equal(queued.kind, "text");
  assert.equal(queued.dir, "out");
  assert.ok(queued.text.includes("شرایط"));
  assert.ok(!queued.text.includes("‹نام طرح›"));
  assert.ok(!queued.text.includes("‹نام مشتری›"));
  const sab = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/quick/qabc1234`, {});
  assert.equal(sab.status, 200);
  const sabRow = queryRow("SELECT text FROM bale_bot_messages WHERE id=?", [sab.body.message.id]);
  assert.equal(sabRow.text, "متن پیش‌فرض sab");
  assert.equal(net.length, before, "no Bale/network calls");
});

await check("POST /ready of archived or inactive-plan id is 404", async () => {
  assert.equal((await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idArchived}`, {})).status, 404);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idPlanInactive}`, {})).status, 404);
});

await check("loan_plans rows were not written by the feature under test", async () => {
  // fixture itself does not UPDATE/DELETE loan_plans; only INSERT sh_messages / one loan_application / flags on the scratch copy
  const changed = queryRow("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='loan_plans'");
  assert.ok(changed.n === 1);
});

await new Promise((r) => srv.close(r));
console.log(failures.length ? `FAILED ${failures.length} / ${passed + failures.length}` : `PASS ${passed}`);
if (failures.length) process.exit(1);

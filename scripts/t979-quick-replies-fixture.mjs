/**
 * t979 v1.1 backend: three-tab «پیام‌های آماده» (category column, ready tab/category, expert type change, held send + undo) behind flag.quick_replies_v11 (default OFF).
 * Scratch copy of a masked DB only (run-t978-bale-sh-messages-fixture.mjs). Fetch is stubbed; workers off; no live writes.
 */
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema } from "../src/lib/bale-bot.ts";
import { BALE_SH_FLAG, QR_FLAG, baleShOn, baleShReady, qrOn, baleShSetType } from "../src/lib/bale-sh-messages.ts";
import { ensureSocialHubSchema, _resetShSchemaForTests, shCreateMessage, shUpdateMessage, shMessages } from "../src/lib/social-hub.ts";
import { createBaleWorkspaceRouter } from "../src/routes/bale-workspace.ts";
import { createBaleBotRouter } from "../src/routes/bale-bot.ts";
import { SAB_FLAG } from "../src/lib/sales-admin-bale.ts";

if (!process.env.CRM_DATABASE_PATH || process.env.CRM_DATABASE_PATH.includes("/var/lib/nafisvam")) throw new Error("scratch DB only");

const net = [];
globalThis.fetch = async (u) => { net.push(String(u)); throw new Error("network blocked in t979 fixture"); };

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
const linked = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [bot8.id, "t979-linked", "fx", own.id, "manual", T0, T0]);
const unlinked = execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [bot8.id, "t979-unlinked", "fx", null, null, T0, T0]);

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
setFlag(QR_FLAG, null); // default OFF
setFlag("flag.social_hub_v1", "1");

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
const mgr = { id: 5, fullName: "fx manager", username: "fx" };
const colsOf = () => queryRows("PRAGMA table_info(sh_messages)").map((c) => c.name);
const outRow = (id) => queryRow("SELECT * FROM bale_bot_messages WHERE id=?", [id]);

console.log("t979 quick replies v1.1 fixture");

await check("legacy table has no category column before the migration", async () => { assert.ok(!colsOf().includes("category")); });
await check("OFF (both flags absent): no ready, POST ready/type/undo are 404, nothing changed in the table", async () => {
  assert.equal(qrOn(), false); assert.equal(baleShOn(), false);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  assert.equal(ctx.body.assets.ready, undefined);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idFreeA}`, {})).status, 404);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/ready/${idFreeA}/type`, { tab: "educational" })).status, 404);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/messages/1/undo`, {})).status, 404);
  assert.ok(!colsOf().includes("category"), "the Bale read/flag paths never alter the table");
});

await check("migration (runs with the first social-hub request): adds category, every existing free message → general, ids/rows untouched; idempotent", async () => {
  const before = queryRows("SELECT id,kind,plan_id,title,body,archived,sort FROM sh_messages ORDER BY id");
  _resetShSchemaForTests(); ensureSocialHubSchema();
  assert.ok(colsOf().includes("category"));
  const after = queryRows("SELECT id,kind,plan_id,title,body,archived,sort FROM sh_messages ORDER BY id");
  assert.deepEqual(after, before);
  assert.ok(queryRows("SELECT category FROM sh_messages WHERE kind='free'").every((r) => r.category === "general"));
  _resetShSchemaForTests(); ensureSocialHubSchema(); // second run: no error, no change
  assert.deepEqual(queryRows("SELECT id,kind,plan_id,title,body,archived,sort FROM sh_messages ORDER BY id"), before);
  assert.throws(() => execute("UPDATE sh_messages SET category='bogus' WHERE id=?", [idFreeA]), /constraint/i);
});

await check("older flag only (t978 behaviour): ready has no tab/category/v11; ready send is immediate (no hold)", async () => {
  setFlag(BALE_SH_FLAG, "1");
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  const r = ctx.body.assets.ready;
  assert.equal(r.v11, undefined); assert.equal(r.holdMs, undefined);
  assert.ok(r.items.every((x) => x.tab === undefined && x.category === undefined && x.showToday === undefined));
  const s = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idFreeA}`, {});
  assert.equal(s.status, 200); assert.equal(s.body.undoMs, undefined);
  assert.equal(outRow(s.body.message.id).retry_at, null);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/messages/${s.body.message.id}/undo`, {})).status, 404, "undo is a v1.1 feature");
  setFlag(BALE_SH_FLAG, null);
});

setFlag(QR_FLAG, "1");
await check("v1.1 ON: ready is exposed (implies the Bale list) with v11/holdMs; items carry tab/category/showToday; same filters and order as t978", async () => {
  assert.equal(qrOn(), true); assert.equal(baleShOn(), true);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`);
  const r = ctx.body.assets.ready;
  assert.equal(r.v11, true); assert.equal(r.holdMs, 6000);
  assert.equal(r.currentPlanId, currentPlan);
  assert.deepEqual(idsOf(r.items), [idFreeA, idPlanActive, idFreeHidden, idPlanActiveLater]);
  const by = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.deepEqual([by[idFreeA].tab, by[idFreeA].category, by[idFreeA].showToday], ["general", "general", true]);
  assert.deepEqual([by[idPlanActive].tab, by[idPlanActive].category], ["plans", null]);
  assert.equal(by[idFreeHidden].showToday, false, "show_today=0 is still offered in the Bale tray (design §3); it only limits the wizard");
  assert.ok(!idsOf(r.items).includes(idPlanInactive) && !idsOf(r.items).includes(idArchived));
  assert.deepEqual(ctx.body.assets.quick, [{ id: "qabc1234", title: "پیش‌فرض sab" }], "sab.quick stays");
  const q = await call(EXPERT, "GET", "/bale-bot/quick"); assert.equal(q.body.ready.v11, true); assert.deepEqual(q.body.items, [{ id: "qabc1234", title: "پیش‌فرض sab" }]);
});

await check("manager API: create/update with category; invalid refused; plan messages ignore it; list splits general/educational; v11 shown", async () => {
  const edu = shCreateMessage(mgr, { kind: "free", title: "آموزش ثبت چک", body: "چک را این‌طور ثبت کنید.", category: "educational" });
  assert.equal(edu.category, "educational"); assert.equal(edu.tab, "educational");
  const gen = shCreateMessage(mgr, { kind: "free", title: "پیام عمومی تازه", body: "سلام" });
  assert.equal(gen.category, "general");
  assert.throws(() => shCreateMessage(mgr, { kind: "free", title: "x", body: "y", category: "bogus" }), (e) => e.code === "category_invalid");
  const pl = shCreateMessage(mgr, { kind: "plan", planId: currentPlan, title: "پیام طرح تازه", body: "متن", category: "educational" });
  assert.equal(pl.category, "general"); assert.equal(pl.tab, "plans");
  const upd = shUpdateMessage(mgr, gen.id, { category: "educational" });
  assert.equal(upd.tab, "educational");
  const keep = shUpdateMessage(mgr, gen.id, { title: "عنوان دیگر" }); assert.equal(keep.category, "educational", "absent category keeps the old one");
  const l = shMessages(); assert.equal(l.v11, true);
  assert.ok(l.educational.some((m) => m.id === edu.id) && l.educational.some((m) => m.id === gen.id));
  assert.ok(l.general.some((m) => m.id === idFreeA) && !l.general.some((m) => m.id === edu.id));
  assert.ok(l.free.length === l.general.length + l.educational.length);
  // counters per tab as the tray computes them
  const r = baleShReady(own.id); const cnt = { plans: 0, general: 0, educational: 0 }; for (const x of r.items) cnt[x.tab]++;
  assert.equal(cnt.educational, 2); assert.equal(cnt.plans, 3);
  shUpdateMessage(mgr, gen.id, { category: "general" });
  execute("UPDATE sh_messages SET archived=1 WHERE id IN (?,?,?)", [edu.id, gen.id, pl.id]);
});

await check("expert type change: one tab only (leaves the old one); plans needs an active plan; plan→free clears auto-send; validation", async () => {
  const to = (id, body) => call(EXPERT, "POST", `/bale-bot/ready/${id}/type`, body);
  let r = await to(idFreeA, { tab: "educational" }); assert.equal(r.status, 200); assert.equal(r.body.item.tab, "educational"); assert.equal(r.body.item.category, "educational");
  let ready = baleShReady(null).items;
  assert.ok(ready.filter((x) => x.id === idFreeA).length === 1 && ready.find((x) => x.id === idFreeA).tab === "educational");
  r = await to(idFreeA, { tab: "plans", planId: 3 }); assert.equal(r.status, 200); assert.deepEqual([r.body.item.tab, r.body.item.planId, r.body.item.kind], ["plans", 3, "plan"]);
  assert.equal((await to(idFreeA, { tab: "plans", planId: 2 })).body.error, "plan_required", "inactive plan refused");
  assert.equal((await to(idFreeA, { tab: "plans" })).body.error, "plan_required");
  execute("UPDATE sh_messages SET auto_send=1 WHERE id=?", [idFreeA]);
  r = await to(idFreeA, { tab: "general" }); assert.equal(r.status, 200); assert.deepEqual([r.body.item.tab, r.body.item.kind, r.body.item.planId], ["general", "free", null]);
  const row = queryRow("SELECT kind,plan_id,auto_send,category FROM sh_messages WHERE id=?", [idFreeA]);
  assert.deepEqual([row.kind, row.plan_id, row.auto_send, row.category], ["free", null, 0, "general"]);
  assert.equal((await to(idFreeA, { tab: "nope" })).body.error, "tab_invalid");
  assert.equal((await to(idArchived, { tab: "general" })).status, 404);
  assert.equal((await to(987654, { tab: "general" })).status, 404);
  assert.ok(queryRow("SELECT 1 x FROM sh_log WHERE action='message_type' AND ref_id=?", [idFreeA]), "audited (ids and codes only)");
  assert.equal(queryRow("SELECT COUNT(*) n FROM sh_messages").n >= 6, true);
});

let heldId;
await check("direct send is held (undo window): 6 s retry_at, status sending, never touches the network, sab quick still immediate", async () => {
  const s = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idPlanActive}`, {});
  assert.equal(s.status, 200); assert.equal(s.body.undoMs, 6000);
  heldId = s.body.message.id; const row = outRow(heldId);
  assert.equal(row.status, "sending"); assert.equal(row.error_code, null);
  const ms = Date.parse(row.retry_at) - Date.now(); assert.ok(ms > 4000 && ms <= 6100, `hold ${ms}`);
  assert.ok(row.text.includes("شرایط") && !row.text.includes("‹"));
  assert.deepEqual(net, [], "no network call");
  const q = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/quick/qabc1234`, {}); assert.equal(q.status, 200);
  assert.equal(outRow(q.body.message.id).retry_at, null);
});
await check("undo inside the hold removes the unsent message and restores the chat preview; a second undo is 404", async () => {
  const before = queryRow("SELECT last_preview FROM bale_bot_chats WHERE id=?", [linked]);
  const u = await call(EXPERT, "POST", `/bale-bot/messages/${heldId}/undo`, {}); assert.equal(u.status, 200); assert.equal(u.body.ok, true);
  assert.equal(outRow(heldId), undefined);
  const prev = queryRow("SELECT last_preview FROM bale_bot_chats WHERE id=?", [linked]).last_preview;
  assert.equal(prev, "متن پیش‌فرض sab", "preview = the last remaining message");
  const lone = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idPlanActive}`, {});
  assert.equal(queryRow("SELECT last_preview p FROM bale_bot_chats WHERE id=?", [linked]).p.includes("شرایط"), true);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/messages/${lone.body.message.id}/undo`, {})).status, 200);
  assert.equal(queryRow("SELECT last_preview p FROM bale_bot_chats WHERE id=?", [linked]).p, "متن پیش‌فرض sab", "restored after undo");
  assert.equal((await call(EXPERT, "POST", `/bale-bot/messages/${heldId}/undo`, {})).status, 404);
});
await check("undo after the hold, for a sent message, or for someone else's message → refused (409/403), message untouched", async () => {
  const s = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idFreeHidden}`, {}); const id = s.body.message.id;
  execute("UPDATE bale_bot_messages SET retry_at=? WHERE id=?", [new Date(Date.now() - 1000).toISOString(), id]);
  let u = await call(EXPERT, "POST", `/bale-bot/messages/${id}/undo`, {}); assert.equal(u.status, 409); assert.equal(u.body.error, "already_sent"); assert.ok(outRow(id));
  execute("UPDATE bale_bot_messages SET status='sent' WHERE id=?", [id]);
  u = await call(EXPERT, "POST", `/bale-bot/messages/${id}/undo`, {}); assert.equal(u.status, 409);
  const s2 = await call(EXPERT, "POST", `/bale-bot/chats/${linked}/ready/${idFreeHidden}`, {}); const id2 = s2.body.message.id;
  u = await call(ADMIN, "POST", `/bale-bot/messages/${id2}/undo`, {}); assert.ok([403, 404, 409].includes(u.status), `other user: ${u.status}`); assert.ok(outRow(id2), "not removed by someone else");
});
await check("v1.1 flag back OFF: ready/type/undo are gone again; the table keeps its column and data", async () => {
  setFlag(QR_FLAG, null);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${linked}/context`); assert.equal(ctx.body.assets.ready, undefined);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/ready/${idFreeA}/type`, { tab: "general" })).status, 404);
  assert.equal((await call(EXPERT, "POST", `/bale-bot/messages/1/undo`, {})).status, 404);
  assert.ok(colsOf().includes("category"));
});
await check("no network, loan_plans untouched", async () => {
  assert.deepEqual(net, []);
  assert.deepEqual(queryRows("SELECT id FROM loan_plans WHERE active=1 ORDER BY id").map((r) => r.id).includes(currentPlan), true);
});

srv.close();
console.log(failures.length ? `FAIL ${failures.length}: ${failures.join("; ")}` : `PASS ${passed}`);
process.exit(failures.length ? 1 : 0);

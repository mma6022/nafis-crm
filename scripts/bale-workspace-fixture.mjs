// «فضای کار بله» v1.0 fixture — scratch copy of a masked DB only (run-bale-workspace-fixture.mjs). No real Bale, SMS, sapi or OpenAI:
// every fetch throws, the invite transport is a stub, the bot worker is off (queued rows stay «sending»).
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { crmDb, queryRow, queryRows, execute, executeChanges } from "../src/lib/crm-db.ts";
import { ensureBaleBotSchema } from "../src/lib/bale-bot.ts";
import * as B from "../src/lib/bale-workspace.ts";
import { createBaleWorkspaceRouter } from "../src/routes/bale-workspace.ts";
import { createBaleBotRouter } from "../src/routes/bale-bot.ts";

if (!process.env.CRM_DATABASE_PATH || process.env.CRM_DATABASE_PATH.includes("/var/lib/nafisvam")) throw new Error("scratch DB only");
const net = [];
globalThis.fetch = async (u) => { net.push(String(u).replace(/bot[^/]+/, "bot<redacted>")); throw new Error("network blocked in fixture"); };

const failures = []; let passed = 0;
const check = async (name, fn) => { try { await fn(); passed++; console.log("  ok ", name); } catch (e) { failures.push(name); console.error("  FAIL", name, e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e); } };
const setFlag = (k, v) => v == null ? executeChanges("DELETE FROM call_queue_settings WHERE key=?", [k]) : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
const tables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
const cols = (t) => queryRows(`PRAGMA table_info(${t})`).map((r) => r.name).join(",");
const plansHash = () => JSON.stringify(queryRows("SELECT * FROM loan_plans ORDER BY id"));
const guarded = ["loan_plans", "contracts", "notification_settings", "customers", "bale_bot_chats", "bale_bot_messages", "call_queue_settings", "bale_outbox"].filter((t) => tables().includes(t));
const colsBefore = Object.fromEntries(guarded.map((t) => [t, cols(t)]));
const plansBefore = plansHash();
const tsc = queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value ?? null;

// HTTP harness: x-uid → res.locals.authUser (the real requireApiAuth is not under test here)
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

const EXPERT = 8, OTHER_EXPERT = 2, ADMIN = 1, MANAGER = 5, GHASEMI = 3, U29 = 29;
const sp = (uid) => queryRow("SELECT salesperson_id s FROM users WHERE id=?", [uid]).s;
ensureBaleBotSchema();
const bot8 = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [EXPERT]); assert.ok(bot8, "bot of user 8");
const botG = queryRow("SELECT * FROM bale_bots WHERE user_id=?", [GHASEMI]);
const own = queryRows("SELECT id,name FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND phone<>'' ORDER BY id DESC LIMIT 4", [sp(EXPERT)]);
const other = queryRow("SELECT id,name FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND phone<>'' ORDER BY id DESC LIMIT 1", [sp(OTHER_EXPERT)]);
assert.ok(own.length >= 3 && other, "fixture customers");
const T0 = "2026-11-18T07:00:00.000Z"; // 10:30 Tehran
const mkChat = (botId, cid, chatId) => execute("INSERT INTO bale_bot_chats(bot_id,chat_id,first_name,customer_id,link_method,unread,last_at,created_at) VALUES(?,?,?,?,?,0,?,?)", [botId, chatId, "fx", cid, cid ? "manual" : null, T0, T0]);
const msg = (chat, dir, text, at, status) => execute("INSERT INTO bale_bot_messages(chat_row,dir,kind,text,status,sent_at,created_at) VALUES(?,?,?,?,?,?,?)", [chat, dir, "text", text, status ?? (dir === "out" ? "sent" : null), at, at]);
const chatA = mkChat(bot8.id, own[0].id, "fx-a"); msg(chatA, "in", "سلام", T0);
const chatB = mkChat(bot8.id, own[1].id, "fx-b"); msg(chatB, "in", "سلام", T0); msg(chatB, "out", "در خدمتم", "2026-11-17T01:00:00.000Z");
const chatC = mkChat(bot8.id, own[2].id, "fx-c"); // never wrote
const chatG = botG ? mkChat(botG.id, null, "fx-g") : null; if (chatG) msg(chatG, "in", "سلام", T0);

console.log("bale-workspace fixture");
await check("flag OFF: routes fall through (404), no bws_ table, tick does nothing", async () => {
  setFlag(B.BWS_FLAG, null);
  const r = await call(EXPERT, "GET", "/bale-workspace/me"); assert.equal(r.status, 404); assert.equal(r.body?.error, "fallthrough");
  setFlag(B.BWS_FLAG, "0"); assert.equal((await call(ADMIN, "GET", "/bale-workspace/admin/state")).status, 404);
  assert.deepEqual(B.bwsTick(new Date(T0)), { bulk: 0, noreply: 0, handoff: 0, auto: 0 });
  assert.ok(!tables().some((t) => t.startsWith("bws_")));
  const me = await call(EXPERT, "GET", "/bale-bot/me"); assert.equal(me.status, 200); assert.equal(me.body.workspace, undefined);
  const list = await call(EXPERT, "GET", "/bale-bot/chats"); assert.equal(list.body.counts.stars, undefined); assert.equal(list.body.chats[0].stars, undefined);
});
await check("flag ON: additive schema only (new bws_* tables, guarded tables' columns unchanged)", async () => {
  const before = tables(); setFlag(B.BWS_FLAG, "1");
  const r = await call(EXPERT, "GET", "/bale-workspace/me"); assert.equal(r.status, 200); assert.equal(r.body.canManage, false); assert.equal(r.body.inbox, "own");
  const added = tables().filter((t) => !before.includes(t)); assert.ok(added.length >= 7 && added.every((t) => t.startsWith("bws_")), added.join());
  for (const t of guarded) assert.equal(cols(t), colsBefore[t], `columns of ${t}`);
  assert.equal((await call(MANAGER, "GET", "/bale-workspace/me")).body.canManage, true);
  assert.equal((await call(ADMIN, "GET", "/bale-workspace/me")).body.canManage, true);
});
await check("user 29 is never served", async () => { assert.equal((await call(U29, "GET", "/bale-workspace/me")).status, 403); });
await check("ج stars: own chat set/clear, sorted 3>2>1>none, filter, other-expert customer refused", async () => {
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatB}/stars`, { stars: 3 })).body.stars, 3);
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatC}/stars`, { stars: 1 })).body.stars, 1);
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/stars`, { stars: 4 })).status, 400);
  const l = await call(EXPERT, "GET", "/bale-bot/chats"); const ids = l.body.chats.map((c) => c.id);
  assert.ok(ids.indexOf(chatB) < ids.indexOf(chatC) && ids.indexOf(chatC) < ids.indexOf(chatA), "order");
  assert.equal(l.body.counts.stars[3] >= 1, true);
  const f = await call(EXPERT, "GET", "/bale-bot/chats?star=1"); assert.deepEqual(f.body.chats.map((c) => c.id), [chatC]);
  if (chatG) assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatG}/stars`, { stars: 2 })).status, 404);
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatC}/stars`, { stars: 0 })).body.stars, 0);
});
await check("الف context: own customer in full (phone + national id), assets present; locked/other experts see no other customer's numbers", async () => {
  const r = await call(EXPERT, "GET", `/bale-workspace/chats/${chatA}/context`); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.context.restricted, false); assert.ok(r.body.context.customer.phone); assert.ok("nationalCode" in r.body.context.customer);
  assert.ok(Array.isArray(r.body.context.calls) && Array.isArray(r.body.context.cases)); assert.ok(r.body.assets && Array.isArray(r.body.assets.training));
  assert.equal((await call(OTHER_EXPERT, "GET", `/bale-workspace/chats/${chatA}/context`)).status, 404); // not their bot
  const m = await call(ADMIN, "GET", `/bale-workspace/chats/${chatA}/context`); assert.equal(m.status, 200, "admin " + JSON.stringify(m.body)); assert.equal(m.body.context.restricted, false);
  const oc = mkChat(bot8.id, other.id, "fx-other"); const x = await call(EXPERT, "GET", `/bale-workspace/chats/${oc}/context`); assert.equal(x.status, 200, "oc " + JSON.stringify(x.body));
  assert.equal(x.body.context.restricted, true); assert.equal(x.body.context.customer.phone, undefined); assert.equal(x.body.context.customer.nationalCode, undefined);
  executeChanges("DELETE FROM bale_bot_chats WHERE id=?", [oc]);
});
await check("و plan terms: manager edits (own table, loan_plans untouched); expert sends one message; resend updates the row", async () => {
  const p = queryRows("SELECT id FROM loan_plans WHERE active=1 ORDER BY id LIMIT 2").map((r) => r.id); assert.equal(p.length, 2);
  assert.equal((await call(EXPERT, "PUT", `/bale-workspace/admin/plan-terms/${p[0]}`, { body: "x" })).status, 403);
  assert.equal((await call(MANAGER, "PUT", `/bale-workspace/admin/plan-terms/${p[0]}`, { body: "اقساط ۱۸ ماهه." })).status, 200);
  assert.equal((await call(ADMIN, "PUT", `/bale-workspace/admin/plan-terms/${p[1]}`, { body: "سقف ۲۰۰ میلیون." })).status, 200);
  const n0 = queryRow("SELECT COUNT(*) n FROM bale_bot_messages WHERE chat_row=? AND dir='out'", [chatA]).n;
  const s = await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/plan-terms`, { planIds: p }); assert.equal(s.status, 200, JSON.stringify(s.body));
  const m = queryRow("SELECT * FROM bale_bot_messages WHERE id=?", [s.body.messageId]);
  assert.equal(m.status, "sending"); assert.ok(m.text.includes("اقساط ۱۸ ماهه.") && m.text.includes("سقف ۲۰۰ میلیون.") && m.text.includes(own[0].name));
  assert.equal(queryRow("SELECT COUNT(*) n FROM bale_bot_messages WHERE chat_row=? AND dir='out'", [chatA]).n, n0 + 1, "one message");
  assert.equal(queryRow("SELECT COUNT(*) n FROM bws_plans_explained WHERE customer_id=?", [own[0].id]).n, 2);
  const s2 = await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/plan-terms`, { planIds: [p[0]] }); assert.equal(s2.status, 200);
  assert.equal(queryRow("SELECT COUNT(*) n FROM bws_plans_explained WHERE customer_id=?", [own[0].id]).n, 2, "updated, not duplicated");
  assert.equal(queryRow("SELECT message_id m FROM bws_plans_explained WHERE customer_id=? AND plan_id=?", [own[0].id, p[0]]).m, s2.body.messageId);
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/plan-terms`, { planIds: [] })).status, 400);
  if (chatG) assert.equal((await call(ADMIN, "POST", `/bale-workspace/chats/${chatG}/plan-terms`, { planIds: p })).status, 409, "Ghasemi's bot read-only");
  assert.equal(plansHash(), plansBefore, "loan_plans unchanged");
});
let inviteCalls = { bale: 0, sms: 0 };
const stub = (baleState, smsState, later) => B.setBwsInviteTransport({
  async bale() { inviteCalls.bale++; return { state: baleState, ref: "77" }; }, baleState() { return { state: later ?? baleState }; },
  async sms(o) { inviteCalls.sms++; assert.ok(o.phone && /^09\d{9}$/.test(o.phone)); return { state: smsState }; },
});
await check("ه invite: no Bale account → SMS still goes AND «این شماره بله ندارد»", async () => {
  stub("queued", "sent", "no_bale");
  const r = await call(EXPERT, "POST", `/bale-workspace/customers/${own[0].id}/invite`); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(inviteCalls.sms, 1); assert.equal(inviteCalls.bale, 1);
  const p = await call(EXPERT, "GET", `/bale-workspace/invites/${r.body.invite.id}`);
  assert.equal(p.body.invite.bale, "no_bale"); assert.equal(p.body.invite.sms, "sent"); assert.equal(p.body.invite.error, "این شماره بله ندارد");
});
await check("ه invite: both legs OK → one history line; 1-minute repeat guard; other expert's customer refused; manager allowed", async () => {
  stub("sent", "sent");
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/customers/${own[0].id}/invite`)).status, 429);
  const r = await call(EXPERT, "POST", `/bale-workspace/customers/${own[1].id}/invite`); assert.equal(r.body.invite.line, "دعوت به بله در بله و پیامک فرستاده شد.");
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/customers/${other.id}/invite`)).status, 403);
  assert.equal((await call(MANAGER, "POST", `/bale-workspace/customers/${own[2].id}/invite`)).status, 200);
  const b = await call(EXPERT, "GET", `/bale-workspace/customers/${own[1].id}/brief`); assert.equal(b.body.chatId, chatB); assert.equal(b.body.invites[0].line, "دعوت به بله در بله و پیامک فرستاده شد.");
});
await check("ه invite: default transport (not wired) sends nothing and reports not_connected / not_configured", async () => {
  B.setBwsInviteTransport(null); executeChanges("DELETE FROM bws_invites");
  const r = await call(EXPERT, "POST", `/bale-workspace/chats/${chatC}/invite`); assert.equal(r.body.invite.bale, "not_connected"); assert.equal(r.body.invite.sms, "not_configured");
});
await check("د access: expert gets 403 on every manager route (bulk / scenario / training / invite text)", async () => {
  for (const [m, p, b] of [["GET", "/bale-workspace/admin/state"], ["POST", "/bale-workspace/admin/scenarios", { name: "x", kind: "bulk", body: "x", audience: {} }],
    ["POST", "/bale-workspace/admin/scenarios/preview", { audience: {} }], ["PUT", "/bale-workspace/admin/invite", { text: "x" }], ["PUT", "/bale-workspace/admin/auto", { on: true }],
    ["POST", "/bale-workspace/admin/training", { title: "x", audience: "customer", url: "https://x.ir" }]]) assert.equal((await call(EXPERT, m, p, b)).status, 403, p);
});
await check("د bulk: preview count = confirmed count; stale count refused; Ghasemi's bot never in the audience; no daily cap; sends paced per tick", async () => {
  const pv = await call(MANAGER, "POST", "/bale-workspace/admin/scenarios/preview", { audience: { who: "all" } });
  const all = B.audienceChats({ who: "all", stars: null, experts: null }); assert.equal(pv.body.count, all.length);
  if (chatG) assert.ok(!all.some((c) => c.id === chatG), "Ghasemi excluded");
  assert.ok(!all.some((c) => Number(c.owner_id) === 29));
  const sv = await call(MANAGER, "POST", "/bale-workspace/admin/scenarios", { name: "انبوه آزمایشی", kind: "bulk", body: "سلام {name}", audience: { who: "all" } }); assert.equal(sv.status, 200);
  const id = sv.body.scenario.id; assert.equal(sv.body.scenario.status, "draft");
  assert.equal(B.bwsTick(new Date(T0)).bulk, 0, "draft sends nothing");
  const bad = await call(MANAGER, "POST", `/bale-workspace/admin/scenarios/${id}/confirm`, { count: pv.body.count + 1 }); assert.equal(bad.status, 409); assert.equal(bad.body.count, pv.body.count);
  const ok = await call(MANAGER, "POST", `/bale-workspace/admin/scenarios/${id}/confirm`, { count: pv.body.count }); assert.equal(ok.body.scenario.status, "active");
  assert.equal(B.bwsTick(new Date("2026-11-18T19:00:00.000Z")).bulk, 0, "22:30 Tehran: outside send hours");
  let total = 0; for (let i = 0; i < 50; i++) { const n = B.bwsTick(new Date(T0)).bulk; total += n; if (!n) break; assert.ok(n <= B.BWS_BULK_PER_TICK); }
  assert.equal(total, pv.body.count, "everyone, no cap"); assert.equal(B.scenarioById(id).status, "done");
  assert.equal(B.bwsTick(new Date(T0)).bulk, 0, "nothing twice");
  const m = queryRow("SELECT text FROM bale_bot_messages WHERE id=(SELECT message_id FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=?)", [id, chatA]);
  assert.equal(m.text, `سلام ${own[0].name}`);
});
await check("د no-reply: Y after X hours, then hand-off to the expert if still no reply; «لغو» / «توقف» change nothing", async () => {
  executeChanges("UPDATE bale_bot_messages SET status='sent', sent_at=? WHERE status='sending'", ["2026-11-17T01:00:00.000Z"]); // pretend the earlier sends went out (fixture only)
  const sv = await call(MANAGER, "POST", "/bale-workspace/admin/scenarios", { name: "بی‌پاسخ", kind: "noreply", body: "هنوز سؤالی دارید؟", cond: { hours: 24 }, audience: { who: "linked", experts: [EXPERT] } });
  const id = sv.body.scenario.id; const cnt = (await call(MANAGER, "POST", "/bale-workspace/admin/scenarios/preview", { audience: sv.body.scenario.audience })).body.count;
  assert.equal((await call(MANAGER, "POST", `/bale-workspace/admin/scenarios/${id}/confirm`, { count: cnt })).status, 200);
  msg(chatA, "in", "لغو", "2026-11-17T02:00:00.000Z"); // customer wrote «لغو»: still in the audience, nothing removed
  assert.ok(B.audienceChats(B.scenarioById(id).audience).some((c) => c.id === chatA));
  const t1 = new Date("2026-11-18T06:00:00.000Z"); const r1 = B.bwsTick(t1);
  const yB = queryRow("SELECT message_id m FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='y'", [id, chatB]); assert.ok(yB?.m, "Y to chat B");
  assert.ok(!queryRow("SELECT 1 FROM bws_scenario_sends WHERE scenario_id=? AND chat_row=? AND stage='y'", [id, chatA]), "chat A replied last → no Y");
  assert.ok(r1.noreply >= 1); assert.equal(B.bwsTick(t1).noreply, 0, "no second Y");
  executeChanges("UPDATE bale_bot_messages SET status='sent', sent_at=? WHERE id=?", [t1.toISOString(), yB.m]);
  assert.equal(B.bwsTick(new Date("2026-11-18T10:00:00.000Z")).handoff, 0, "not yet X hours after Y");
  const r3 = B.bwsTick(new Date("2026-11-19T07:00:00.000Z")); assert.ok(r3.handoff >= 1);
  assert.ok(queryRow("SELECT 1 FROM bale_bot_notices WHERE user_id=? AND kind='bws_noreply' AND chat_row=?", [EXPERT, chatB]), "expert notified");
  assert.equal(B.bwsTick(new Date("2026-11-19T08:00:00.000Z")).handoff, 0, "hand-off once");
  await call(MANAGER, "POST", `/bale-workspace/admin/scenarios/${id}/pause`);
});
await check("د auto: global switch OFF → nothing; ON → once per chat after a new inbound", async () => {
  const sv = await call(ADMIN, "POST", "/bale-workspace/admin/scenarios", { name: "خودکار", kind: "auto", body: "خوش آمدید", audience: { who: "messaged" } });
  const id = sv.body.scenario.id; const cnt = (await call(ADMIN, "POST", "/bale-workspace/admin/scenarios/preview", { audience: { who: "messaged" } })).body.count;
  await call(ADMIN, "POST", `/bale-workspace/admin/scenarios/${id}/confirm`, { count: cnt });
  const at = new Date(Date.now() + 1000).toISOString(); msg(chatA, "in", "سلام دوباره", at);
  const t = new Date(T0); assert.equal(B.bwsTick(t).auto, 0, "switch off");
  assert.equal((await call(ADMIN, "PUT", "/bale-workspace/admin/auto", { on: true })).body.autoOn, true);
  assert.equal(B.bwsTick(t).auto, 1); assert.equal(B.bwsTick(t).auto, 0);
  await call(ADMIN, "POST", `/bale-workspace/admin/scenarios/${id}/pause`); await call(ADMIN, "PUT", "/bale-workspace/admin/auto", { on: false });
});
await check("ز training files: link (https only) + PDF upload; expert-facing files never go to a customer; customer file queues a document", async () => {
  assert.equal((await call(MANAGER, "POST", "/bale-workspace/admin/training", { title: "قرارداد", audience: "customer", planScope: "all", url: "http://x.ir" })).status, 400);
  const l = await call(MANAGER, "POST", "/bale-workspace/admin/training", { title: "قرارداد", audience: "customer", planScope: "all", url: "https://nafisvam.com/guide" }); assert.equal(l.status, 200);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 32)]);
  const up = await new Promise((resolve) => { const rq = http.request({ host: "127.0.0.1", port, path: "/api/bale-workspace/admin/training", method: "POST",
    headers: { "x-uid": String(MANAGER), "content-type": "application/pdf", "content-length": pdf.length, "x-bws-meta": encodeURIComponent(JSON.stringify({ title: "نحوهٔ ثبت سفته", audience: "customer", planScope: "all", fileName: "safte.pdf" })) } },
    (rs) => { const ch = []; rs.on("data", (c) => ch.push(c)); rs.on("end", () => resolve({ status: rs.statusCode, body: JSON.parse(Buffer.concat(ch).toString()) })); }); rq.end(pdf); });
  assert.equal(up.status, 200); assert.equal(up.body.item.kind, "file");
  const ex = await call(ADMIN, "POST", "/bale-workspace/admin/training", { title: "راهنمای کارشناس", audience: "expert", planScope: "all", url: "https://nafisvam.com/x" });
  assert.equal((await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/training/${ex.body.item.id}`)).status, 403);
  const s = await call(EXPERT, "POST", `/bale-workspace/chats/${chatA}/training/${up.body.item.id}`); assert.equal(s.status, 200);
  const m = queryRow("SELECT kind, file_state, send_as, status FROM bale_bot_messages WHERE id=?", [s.body.messageId]); assert.deepEqual([m.kind, m.file_state, m.send_as, m.status], ["document", "stored", "document", "sending"]);
  const ctx = await call(EXPERT, "GET", `/bale-workspace/chats/${chatA}/context`); assert.ok(ctx.body.assets.training.some((t) => t.audience === "expert")); assert.ok(ctx.body.assets.training.every((t) => t.audience === "expert"));
  const bad = await call(MANAGER, "POST", "/bale-workspace/admin/training", { title: "x", audience: "customer", planScope: "selected", planIds: [], url: "https://x.ir" }); assert.equal(bad.status, 400);
});
await check("lockdown allowlist covers only the expert routes (admin stays closed)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(`${process.cwd()}/src/lib/expert-lockdown.ts`, "utf8");
  const line = src.split("\n").find((l) => l.includes("bale-workspace\\/(me|")); assert.ok(line);
  const re = new RegExp(line.trim().replace(/^\//, "").replace(/\/,$/, ""));
  for (const p of ["/bale-workspace/me", "/bale-workspace/chats/5/context", "/bale-workspace/customers/9/invite", "/bale-workspace/invites/3", "/bale-workspace/training/4/file"]) assert.ok(re.test(p), p);
  for (const p of ["/bale-workspace/admin/state", "/bale-workspace/admin/scenarios", "/bale-workspace/chats/5/context/x"]) assert.ok(!re.test(p), p);
});
await check("no network, team_sales_config untouched", async () => {
  assert.deepEqual(net, []); assert.equal(queryRow("SELECT value FROM notification_settings WHERE key='team_sales_config'")?.value ?? null, tsc);
});
srv.close(); crmDb.close?.();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

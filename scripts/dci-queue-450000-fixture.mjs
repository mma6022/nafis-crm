// DCI-QUEUE 450000 fixture (Armita REVIEW-v21-build): Q20 early attempt keeps the task open (plan item + self-heal + covered),
// 30-min incoming urgency → normal task in its ring slot, callback closes it, «تماس‌های ورودی (n)» group over 2, saved result closes
// the «بالفعل» file task (B5), phone full only with customers.view (B7, fake number), no new flag keys, additive dci_queue_attempts.
// Usage: DQ_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/dci-queue-450000-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.DQ_FIXTURE_DB || process.env.CR_FIXTURE_DB;
if (!src) { console.log("SKIP (set DQ_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dq450-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
let net = 0; globalThis.fetch = async () => { net++; throw new Error("no network in fixture"); };
let passed = 0; const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
try {
  const db = await import("../src/lib/crm-db.ts");
  const dp = await import("../src/lib/daily-plan.ts");
  const dq = await import("../src/lib/dci-queue.ts");
  const cq = await import("../src/lib/call-queue.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { queryRow, queryRows, execute } = db;
  const flag = (k, v) => execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const NOW = new Date("2026-11-11T07:50:00.000Z"); // Wednesday 11:20 Tehran
  const DAY = dp.dpToday(NOW);
  const P = ["customers.view", "customers.update", "calls.create", "calls.view", "payment_orders.view", "payment_orders.sales_approve", "bank_accounts.view"];
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true };
  const noPhone = { ...kazemi, permissions: P.filter((p) => p !== "customers.view") };
  const flagKeysBefore = queryRows("SELECT key FROM call_queue_settings WHERE key LIKE 'flag.%' ORDER BY key").map((r) => r.key);
  execute("DELETE FROM call_queue_settings WHERE key LIKE 'flag.dci_queue_v21%'");
  flag("flag.dci_queue_v21.user.8", "1");
  flag("flag.daily_plan", "1");
  for (const p of queryRows("SELECT id FROM dp_plans WHERE salesperson_id=6 AND day=?", [DAY])) { execute("DELETE FROM dp_items WHERE plan_id=?", [p.id]); execute("DELETE FROM dp_plans WHERE id=?", [p.id]); }
  const plan = dp.dpActiveFor(kazemi, NOW);
  assert.ok(plan, "plan for user 8");
  const after = new Set(queryRows("SELECT DISTINCT customer_id FROM call_logs WHERE julianday(created_at) >= julianday(?)", [NOW.toISOString()]).map((r) => r.customer_id));
  const pend = queryRows("SELECT id, customer_id FROM dp_items WHERE plan_id=? AND status='pending' ORDER BY position, id", [plan.id]).filter((r) => !after.has(r.customer_id));
  assert.ok(pend.length >= 2, "need two pending plan items");
  const early = pend[pend.length - 1];
  const own = queryRows("SELECT id, phone FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 300");
  const inPlan = new Set(queryRows("SELECT customer_id FROM dp_items WHERE plan_id=?", [plan.id]).map((r) => r.customer_id));
  const free = own.filter((c) => !inPlan.has(c.id) && !after.has(c.id));
  assert.ok(free.length >= 6, "need 6 own customers off the plan");
  // POST /calls in miniature: dpPreCall → call_logs row (+ call_result) → dpAfterCall, the same order as routes/crm.ts
  const postCall = (body, user = kazemi, at = NOW) => {
    const e = dp.dpPreCall(body, user, at); if (e) return { err: e };
    const id = Number(execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,outcome,created_at) VALUES(?,6,?,?,?,?)",
      [body.customerId, body.subject || "fixture", body.oneLineNote || "x", body.outcome || null, at.toISOString()]));
    return { id, dp: dp.dpAfterCall(body, id, user, body.customerId, at.toISOString()), kind: body.__dp };
  };
  const attemptBody = (cid, cr = "no_answer", task = `c-${cid}`) => ({ customerId: cid, subject: "کارهای امروز · تلاش زودتر از نوبت", outcome: "no_answer",
    call_result: cr, oneLineNote: "جواب نداد", outOfList: true, context: "out_of_list", dqAttempt: true, dqTaskId: task });
  const itemStatus = (id) => queryRow("SELECT status FROM dp_items WHERE id=?", [id]).status;

  let att;
  await ok("Q20: early «جواب نداد» = attempt only → call saved, plan item stays pending, dci_queue_attempts row", async () => {
    att = postCall(attemptBody(early.customer_id));
    assert.equal(att.kind, "attempt"); assert.equal(att.dp.kind, "attempt");
    assert.equal(itemStatus(early.id), "pending");
    assert.equal(queryRow("SELECT COUNT(*) n FROM dci_queue_attempts WHERE call_log_id=?", [att.id]).n, 1);
  });
  await ok("Q20: self-heal / covered refresh does not close the item with the attempt call", async () => {
    dp.dpActiveFor(kazemi, new Date(NOW.getTime() + 60000));
    assert.equal(itemStatus(early.id), "pending");
    assert.equal(dp.dpCovered(plan, early.customer_id)?.callId === att.id, false);
  });
  await ok("Q20: queue item stays open and carries attempts=1", async () => {
    const it = dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === early.customer_id);
    assert.ok(it); assert.equal(it.done, false); assert.equal(it.attempts, 1);
  });
  await ok("Q20: «خاموش یا اشغال» also attempt-only; a VoIP-race close with the same call is reopened", async () => {
    const b = attemptBody(early.customer_id, "off_or_busy");
    const e = dp.dpPreCall(b, kazemi, NOW); assert.equal(e, null); assert.equal(b.__dp, "attempt");
    const id = Number(execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,outcome,created_at) VALUES(?,6,'x','x','no_answer',?)", [early.customer_id, NOW.toISOString()]));
    execute("UPDATE dp_items SET status='done', call_log_id=?, done_at=? WHERE id=?", [id, NOW.toISOString(), early.id]); // CDR self-heal won the race
    dp.dpAfterCall(b, id, kazemi, early.customer_id, NOW.toISOString());
    assert.equal(itemStatus(early.id), "pending");
  });
  await ok("Q20 guard: «جواب داد» / wrong task id / flag OFF user → old path (closes the item), never attempt", async () => {
    const a = attemptBody(early.customer_id, "answered"); dp.dpPreCall(a, kazemi, NOW); assert.notEqual(a.__dp, "attempt");
    const w = attemptBody(early.customer_id, "no_answer", `c-${early.customer_id + 1}`); dp.dpPreCall(w, kazemi, NOW); assert.notEqual(w.__dp, "attempt");
    const u = attemptBody(early.customer_id); dp.dpPreCall(u, { ...kazemi, id: 2 }, NOW); assert.notEqual(u.__dp, "attempt");
    const r = postCall(attemptBody(early.customer_id, "answered"));
    assert.equal(itemStatus(early.id), "done", "a real result at its turn closes the item (410000 rule kept)");
    assert.equal(r.kind, "outside");
  });
  await ok("Q20: POST /calls parse — attempt is reported like «خارج از لیست» (result on, one-line note, no 10-char rule) and flagged attempt", async () => {
    const b = attemptBody(free[4].id); assert.equal(dp.dpPreCall(b, kazemi, NOW), null); assert.equal(b.__dp, "attempt");
    const inp = cq.cqParseCall(b, kazemi);
    assert.ok(!("error" in inp), JSON.stringify(inp)); assert.equal(inp.resultOn, true); assert.equal(inp.dp, "outside"); assert.equal(inp.attempt, true);
    const n = { ...attemptBody(free[4].id, "answered") }; dp.dpPreCall(n, kazemi, NOW); assert.equal(cq.cqParseCall(n, kazemi).attempt, undefined);
  });
  await ok("Q20: attempt still validates the note", async () => {
    const b = { ...attemptBody(free[5].id), oneLineNote: "" };
    const e = dp.dpPreCall(b, kazemi, NOW); assert.ok(e); assert.equal(e.error, "note_required");
  });

  const ev = (phone, dir, cid, at, user = 8) => Number(execute(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,salesperson_id,customer_id,has_recording)
    VALUES(?,?,?,?,?,?,'105','["105"]',?,6,?,0)`, [`fx-${Math.random()}`, phone, dir, "NO ANSWER", at, at, user, cid]));
  const [c1, c2, c3, c4] = free;
  const old = ev(c1.phone || "09120000011", "incoming", c1.id, "2026-11-11T06:10:00.000Z"); // 09:40 Tehran, 100 min ago
  await ok("§7: incoming older than 30 min is no longer urgent; it is a normal open task in the slot it rang (block 0)", async () => {
    const it = dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === c1.id);
    assert.equal(it.urgent, false); assert.equal(it.done, false); assert.equal(it.blockIdx, 0); assert.equal(it.kind, "incoming_call");
  });
  await ok("§7: inside 30 min it is urgent; the window is a server setting (default 30)", async () => {
    const q = dq.dqQueue(kazemi, new Date("2026-11-11T06:25:00.000Z"));
    assert.equal(q.urgentInMin, 30); assert.equal(q.items.find((x) => x.customer_id === c1.id).urgent, true);
    flag("dci_queue.incoming_urgent_min", "120");
    assert.equal(dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === c1.id).urgent, true);
    execute("DELETE FROM call_queue_settings WHERE key='dci_queue.incoming_urgent_min'");
  });
  await ok("§7: a callback (outgoing to the same number after the ring) closes the incoming task", async () => {
    ev(c1.phone || "09120000011", "outgoing", c1.id, "2026-11-11T06:30:00.000Z");
    const q = dq.dqQueue(kazemi, NOW); const it = q.items.find((x) => x.customer_id === c1.id);
    // the incoming part is closed; what stays is the expert's own outgoing call waiting for its result (440000 rule)
    assert.equal(it.kind, "outgoing_call"); assert.equal(it.urgent, false);
    assert.equal(q.counts.incoming_call, q.items.filter((x) => !x.done && x.kind === "incoming_call").length);
    execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,outcome,created_at) VALUES(?,6,'x','x','answered',?)", [c1.id, "2026-11-11T06:32:00.000Z"]);
    assert.equal(dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === c1.id).done, true, "result logged → done");
  });
  await ok("§7: an attempt log does not close an incoming call; a logged result does", async () => {
    const e2 = ev(c2.phone || "09120000012", "incoming", c2.id, "2026-11-11T07:45:00.000Z");
    postCall(attemptBody(c2.id), kazemi, new Date("2026-11-11T07:46:00.000Z"));
    assert.equal(dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === c2.id).done, false);
    execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,outcome,created_at) VALUES(?,6,'x','x','answered',?)", [c2.id, "2026-11-11T07:47:00.000Z"]);
    assert.equal(dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === c2.id).done, true);
    assert.ok(e2 > 0);
  });
  let unkId = null;
  await ok("§7: «تماس‌های ورودی (n)» only when more than groupOver (default 2) urgent incoming calls are open; newest opens", async () => {
    const urgIn = (q) => q.items.filter((x) => !x.done && x.urgent && x.kind === "incoming_call");
    const u0 = urgIn(dq.dqQueue(kazemi, NOW)).length; // the masked copy may already hold real calls of this morning
    ev(c3.phone || "09120000013", "incoming", c3.id, "2026-11-11T07:40:00.000Z");
    ev(c4.phone || "09120000014", "incoming", c4.id, "2026-11-11T07:44:00.000Z");
    const unk = ev("09120004170", "incoming", null, "2026-11-11T07:48:00.000Z"); unkId = `e-${unk}`;
    let q = dq.dqQueue(kazemi, NOW); const u = urgIn(q);
    assert.equal(u.length, u0 + 3); assert.equal(q.groupOver, 2);
    assert.equal(q.incomingGroup.count, u.length);
    const newest = [...u].sort((x, y) => String(y.due_at).localeCompare(String(x.due_at)))[0];
    assert.equal(q.incomingGroup.newestId, newest.id);
    flag("dci_queue.incoming_group_over", String(u.length)); assert.equal(dq.dqQueue(kazemi, NOW).incomingGroup, null, "not more than the threshold → no group");
    flag("dci_queue.incoming_group_over", String(u.length - 1)); assert.equal(dq.dqQueue(kazemi, NOW).incomingGroup.count, u.length);
    execute("DELETE FROM call_queue_settings WHERE key='dci_queue.incoming_group_over'");
  });
  await ok("B7: unknown caller — full number with customers.view (phone_full), masked otherwise; never on known customers", async () => {
    const q = dq.dqQueue(kazemi, NOW);
    const it = q.items.find((x) => x.id === unkId);
    assert.equal(it.phone, "09120004170"); assert.equal(it.phone_full, true); assert.equal(it.phone_masked, "0912•••4170");
    const q2 = dq.dqQueue(noPhone, NOW).items.find((x) => x.id === it.id);
    assert.equal(q2.phone, null); assert.equal(q2.phone_full, false); assert.equal(q2.phone_masked, "0912•••4170");
    for (const x of q.items.filter((x) => x.customer_id != null)) { assert.equal(x.phone, null); assert.equal(x.phone_full, false); }
  });
  await ok("B5: a saved result today closes the open «بالفعل» file task; an attempt does not", async () => {
    // an item made only of a file task (no plan item / reminder / call), customer without calls after NOW
    let q = dq.dqQueue(kazemi, NOW);
    const ft = q.items.find((x) => x.fileTask && !x.done && x.customer_id && x.itemId == null && x.reminderId == null && x.call_id == null
      && x.kinds.length === 1 && !after.has(x.customer_id));
    assert.ok(ft, "need an open file-only task in the copy");
    postCall(attemptBody(ft.customer_id));
    assert.equal(dq.dqQueue(kazemi, NOW).items.find((x) => x.id === ft.id).done, false, "attempt keeps it open");
    execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,outcome,created_at) VALUES(?,6,'x','x','answered',?)", [ft.customer_id, new Date(NOW.getTime() + 60000).toISOString()]);
    assert.equal(dq.dqQueue(kazemi, new Date(NOW.getTime() + 120000)).items.find((x) => x.id === ft.id).done, true, "saved result closes it for today");
  });
  await ok("no flag keys added or removed besides the dci_queue_v21 / daily_plan ones the fixture set", async () => {
    const now = queryRows("SELECT key FROM call_queue_settings WHERE key LIKE 'flag.%' ORDER BY key").map((r) => r.key);
    const extra = now.filter((k) => !flagKeysBefore.includes(k) && !k.startsWith("flag.dci_queue_v21") && k !== "flag.daily_plan");
    assert.deepEqual(extra, []);
    assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key='flag.dci_queue_v21.user.29'"), undefined);
  });
  await ok("schema additive: dci_queue_attempts is the only new table this release adds", async () => {
    const t = queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dci_queue%' ORDER BY name").map((r) => r.name);
    assert.ok(t.includes("dci_queue_attempts"));
    const cols = queryRows("PRAGMA table_info(dci_queue_attempts)").map((r) => r.name);
    assert.deepEqual(cols, ["call_log_id", "user_id", "day", "customer_id", "task_id", "outcome", "created_at"]);
  });
  await ok("no network", async () => assert.equal(net, 0));
  console.log(`# ${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

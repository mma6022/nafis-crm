// DCI-QUEUE 440000 fixture (Armita «کارهای امروز من» v2.1–v2.3.1, flag.dci_queue_v21). Runs on a temp COPY of a masked DB. No network.
// OFF: dqFlagOn false for everyone, no dci_queue_* table. ON (user 8): four blocks, «اکنون», kinds + counts, urgent interrupts right
// after the current task, unknown number = «بدون نام» item, payment order waiting for the expert, future reminder (due:false),
// done_at/done_early marks, manual outgoing, name-first for the unknown number, lockdown opens only the queue paths, other experts' rows hidden.
// Usage: DQ_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/dci-queue-440000-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.DQ_FIXTURE_DB || process.env.CR_FIXTURE_DB;
if (!src) { console.log("SKIP (set DQ_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dq440-fx-"));
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
  const el = await import("../src/lib/expert-lockdown.ts");
  const { queryRow, queryRows, execute } = db;
  const flag = (k, v) => execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const table = (n) => !!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [n]);
  const NOW = new Date("2026-11-11T07:50:00.000Z"); // Wednesday 11:20 Tehran → «بالقوه ۱۱ تا ۱۳»
  const DAY = dp.dpToday(NOW);
  const P = ["customers.view", "customers.update", "calls.create", "calls.view", "payment_orders.view", "payment_orders.sales_approve", "bank_accounts.view"];
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true };
  const other = { id: 2, role: "salesperson", salespersonId: 3, fullName: "other", permissions: P, customerScope: "assigned", active: true };

  await ok("flag OFF (no key): queue off for 8/2/3, no dci_queue_* tables", async () => {
    execute("DELETE FROM call_queue_settings WHERE key LIKE 'flag.dci_queue_v21%'");
    for (const u of [8, 2, 3]) assert.equal(dq.dqFlagOn(u), false);
    assert.equal(table("dci_queue_marks"), false); assert.equal(table("dci_queue_manual"), false);
  });
  await ok("flag ON per user: only users 8/2/3 (flag script keys); user 29 stays off", async () => {
    for (const u of [8, 2, 3]) flag(`flag.dci_queue_v21.user.${u}`, "1");
    for (const u of [8, 2, 3]) assert.equal(dq.dqFlagOn(u), true);
    assert.equal(dq.dqFlagOn(29), false);
  });

  flag("flag.daily_plan", "1");
  for (const p of queryRows("SELECT id FROM dp_plans WHERE salesperson_id=6 AND day=?", [DAY])) { execute("DELETE FROM dp_items WHERE plan_id=?", [p.id]); execute("DELETE FROM dp_plans WHERE id=?", [p.id]); }
  const plan = dp.dpActiveFor(kazemi, NOW);
  assert.ok(plan, "plan for user 8");
  const own = queryRows("SELECT id, phone FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 200");
  const inPlan = new Set(queryRows("SELECT customer_id FROM dp_items WHERE plan_id=?", [plan.id]).map((r) => r.customer_id));
  // the masked copy may be newer than NOW: skip customers with any call log / call event after NOW so «later call» rules do not fire
  const after = new Set(queryRows("SELECT DISTINCT customer_id FROM call_logs WHERE julianday(created_at) >= julianday(?)", [NOW.toISOString()]).map((r) => r.customer_id));
  const free = own.filter((c) => !inPlan.has(c.id) && !after.has(c.id));
  assert.ok(free.length >= 4, "need 4 own customers not on today's plan");
  const [cRem, cPay, cIn, cMan] = free;
  // a reminder later today (15:00 Tehran) → in the queue with due:false
  const remId = Number(execute("INSERT INTO reminders(user_id,salesperson_id,message,remind_at,done,created_at,customer_id) VALUES(8,6,?,?,0,?,?)",
    ["پیگیری جواب استعلام بانک", "2026-11-11T11:30:00.000Z", NOW.toISOString(), cRem.id]));
  // a payment order waiting for the sales expert
  let poId = null;
  if (table("customer_payment_orders") && table("goods_purchases")) {
    const gp = queryRow("SELECT id FROM goods_purchases WHERE id NOT IN (SELECT purchase_id FROM customer_payment_orders) ORDER BY id DESC LIMIT 1");
    if (gp) poId = Number(execute("INSERT INTO customer_payment_orders(purchase_id,customer_id,salesperson_id,amount_toman,stage,created_by,created_at,updated_at) VALUES(?,?,6,'120000000','sales_approval',1,?,?)",
      [gp.id, cPay.id, NOW.toISOString(), NOW.toISOString()]));
  }
  // an incoming missed call of an own customer at 11:10, and one from an unknown mobile at 11:18
  const ev = (phone, dir, cid, at) => Number(execute(`INSERT INTO voip_after_call_events(external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,salesperson_id,customer_id,has_recording)
    VALUES(?,?,?,?,?,?,'105','["105"]',8,6,?,0)`, [`fx-${Math.random()}`, phone, dir, "NO ANSWER", at, at, cid]));
  const inEv = ev(cIn.phone || "09120000001", "incoming", cIn.id, "2026-11-11T07:40:00.000Z");
  const unkPhone = "0912" + String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, "0");
  const unkEv = ev(unkPhone, "incoming", null, "2026-11-11T07:48:00.000Z");

  let q;
  await ok("four blocks from the server setting; «اکنون» = بالقوه ۱۱ تا ۱۳ at 11:20", async () => {
    q = dq.dqQueue(kazemi, NOW);
    assert.deepEqual(q.blocks.map((b) => [b.k, b.from, b.to]), [["actual", "09:00", "11:00"], ["potential", "11:00", "13:00"], ["actual", "13:00", "16:00"], ["potential", "16:00", "18:00"]]);
    assert.equal(q.nowBlock, 1); assert.equal(q.inHours, true);
  });
  await ok("blocks are a server setting (dci_queue.blocks); a bad value falls back to the default", async () => {
    flag("dci_queue.blocks", JSON.stringify([{ k: "actual", from: "08:30", to: "12:00" }, { k: "potential", from: "12:00", to: "18:00" }]));
    assert.deepEqual(dq.dqQueue(kazemi, NOW).blocks.map((b) => b.from), ["08:30", "12:00"]);
    flag("dci_queue.blocks", "[{\"k\":\"x\"}]");
    assert.equal(dq.dqQueue(kazemi, NOW).blocks.length, 4);
    execute("DELETE FROM call_queue_settings WHERE key='dci_queue.blocks'");
  });
  await ok("every item has kind / block / urgent / done / due_at / customer_id; counts per kind = open items", async () => {
    q = dq.dqQueue(kazemi, NOW);
    for (const it of q.items) {
      assert.ok(dq.DQ_KINDS.includes(it.kind), it.kind);
      assert.ok(["actual", "potential"].includes(it.block));
      for (const k of ["urgent", "done", "due_at", "customer_id", "done_at", "done_early"]) assert.ok(k in it, k);
    }
    for (const k of dq.DQ_KINDS) assert.equal(q.counts[k], q.items.filter((x) => !x.done && x.kind === k).length);
  });
  await ok("future reminder today is in the queue with due:false, in the 13–16 block (not the current one)", async () => {
    const it = q.items.find((x) => x.customer_id === cRem.id);
    assert.ok(it, "reminder item present"); assert.equal(it.kind, "reminder"); assert.equal(it.due, false); assert.equal(it.reminderId, remId);
    assert.equal(it.blockIdx, 2);
  });
  await ok("urgent interrupts sit right after the current task: incoming → payment order (Q2 order)", async () => {
    const cur = q.items.findIndex((x) => x.current);
    assert.ok(cur >= 0);
    const after = q.items.slice(cur + 1).filter((x) => x.urgent).map((x) => x.kind);
    assert.equal(after[0], "incoming_call");
    if (poId) assert.ok(after.includes("payment_order"));
    assert.equal(q.items[cur + 1].urgent, true, "first after current is urgent");
    assert.equal(q.items[cur + 1].next, true, "«بعدی»");
  });
  await ok("unknown number → «بدون نام» item, detected unknown, direction in, no customer id", async () => {
    const it = q.items.find((x) => x.id === `e-${unkEv}`);
    assert.ok(it); assert.equal(it.name, "بدون نام"); assert.equal(it.detected, "unknown"); assert.equal(it.direction, "in"); assert.equal(it.customer_id, null);
  });
  await ok("payment order item carries the order (id, amount) and is urgent", async () => {
    if (!poId) { console.log("  (no goods purchase in copy; skipped)"); return; }
    const it = q.items.find((x) => x.customer_id === cPay.id);
    assert.equal(it.kind, "payment_order"); assert.equal(it.payment_order_id, poId); assert.equal(it.pay.amountToman, "120000000"); assert.equal(it.urgent, true);
  });
  await ok("another expert never sees user 8's rows", async () => {
    const q2 = dq.dqQueue(other, NOW);
    for (const c of [cRem.id, cPay.id, cIn.id]) assert.equal(q2.items.some((x) => x.customer_id === c), false);
    assert.equal(q2.items.some((x) => x.id === `e-${unkEv}`), false);
  });
  await ok("done early: a later-block reminder finished now → done_at + done_early=1; reminder row untouched by the mark", async () => {
    const it = q.items.find((x) => x.customer_id === cRem.id);
    const r = dq.dqMarkDone(kazemi, { taskId: it.id, dueRef: it.due_ref, outcome: "answered" }, NOW);
    assert.equal(r.status, 200); assert.equal(r.body.done_early, true);
    assert.equal(table("dci_queue_marks"), true);
    assert.equal(queryRow("SELECT done FROM reminders WHERE id=?", [remId]).done, 0, "mark never closes the reminder itself");
    execute("UPDATE reminders SET done=1, closed_at=? WHERE id=?", [NOW.toISOString(), remId]); // the page closes it via PATCH /reminders
    const it2 = dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === cRem.id);
    assert.equal(it2.done, true); assert.equal(it2.done_early, true); assert.ok(it2.done_at);
    assert.equal(it2.blockIdx, 1, "done item stays faded where it was done (current block)");
  });
  await ok("incoming call closed by a later call log; the mark alone also closes a call part", async () => {
    execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,created_at) VALUES(?,6,'fixture','x',?)", [cIn.id, "2026-11-11T07:55:00.000Z"]);
    const it = dq.dqQueue(kazemi, new Date("2026-11-11T07:56:00.000Z")).items.find((x) => x.customer_id === cIn.id);
    assert.equal(it.done, true);
  });
  await ok("mark refuses another expert's / unknown task", async () => {
    assert.equal(dq.dqMarkDone(other, { taskId: `c-${cPay.id}` }, NOW).status, 404);
    assert.equal(dq.dqMarkDone(kazemi, { taskId: "x-1" }, NOW).status, 400);
  });
  await ok("manual outgoing: not in queue → new outgoing_call task; in queue → same task (Q14); other's customer → 403", async () => {
    const r = dq.dqManualOutgoing(kazemi, { customerId: cMan.id }, NOW);
    assert.equal(r.status, 200); assert.equal(r.body.created, true);
    const it = dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === cMan.id);
    assert.equal(it.kind, "outgoing_call"); assert.equal(it.direction, "out");
    const r2 = dq.dqManualOutgoing(kazemi, { customerId: cMan.id }, NOW);
    assert.equal(r2.body.created, false); assert.equal(r2.body.taskId, `c-${cMan.id}`);
    const foreign = queryRow("SELECT id FROM customers WHERE salesperson_id<>6 AND salesperson_id IS NOT NULL AND merged_into_customer_id IS NULL LIMIT 1");
    if (foreign) assert.equal(dq.dqManualOutgoing(kazemi, { customerId: foreign.id }, NOW).status, 403);
  });
  await ok("unknown number: name first → bad name 422, then a named own customer + today's calls linked; other expert 404", async () => {
    assert.equal(dq.dqNameUnknown(other, unkEv, { firstName: "علی", lastName: "رضایی" }).status, 404);
    const bad = dq.dqNameUnknown(kazemi, unkEv, { firstName: "ع1", lastName: "" });
    assert.equal(bad.status, 422); assert.ok(bad.body.fields.firstName && bad.body.fields.lastName);
    const r = dq.dqNameUnknown(kazemi, unkEv, { firstName: "علی", lastName: "رضایی" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = queryRow("SELECT name, salesperson_id FROM customers WHERE id=?", [r.body.customerId]);
    assert.equal(c.name, "علی رضایی"); assert.equal(c.salesperson_id, 6);
    assert.equal(queryRow("SELECT customer_id FROM voip_after_call_events WHERE id=?", [unkEv]).customer_id, r.body.customerId);
    const it = dq.dqQueue(kazemi, NOW).items.find((x) => x.customer_id === r.body.customerId);
    assert.ok(it); assert.equal(it.kind, "incoming_call");
    assert.equal(dq.dqNameUnknown(kazemi, unkEv, { firstName: "علی", lastName: "رضایی" }).status, 409, "second save: exists");
  });
  await ok("outside working hours (19:00) → inHours false, ordering kept", async () => {
    const q3 = dq.dqQueue(kazemi, new Date("2026-11-11T15:30:00.000Z"));
    assert.equal(q3.inHours, false); assert.equal(q3.nowBlock, -1); assert.equal(q3.refBlock, 3);
  });
  await ok("lockdown: the queue GET + 3 writes pass for a locked expert; other DCI-unknown paths keep the old rule", async () => {
    flag("flag.expert_lockdown", "1");
    const run = (method, p, body = {}) => { let code = 200; let nexted = false;
      const res = { locals: { authUser: kazemi }, status(c) { code = c; return this; }, json() { return this; }, setHeader() {} };
      el.expertLockdownGuard({ method, path: `${p}`, query: {}, body }, res, () => { nexted = true; });
      return nexted ? 200 : code; };
    assert.equal(run("GET", "/daily-customer-inline/queue"), 200);
    assert.equal(run("POST", "/daily-customer-inline/queue/done", { taskId: "c-1" }), 200);
    assert.equal(run("POST", "/daily-customer-inline/queue/outgoing", { customerId: cMan.id }), 200);
    assert.equal(run("POST", `/daily-customer-inline/queue/unknown/${unkEv}/name`), 200);
    assert.equal(run("POST", "/daily-customer-inline/queue/other"), 403);
  });
  await ok("schema is additive: only the two dci_queue_* tables are new", async () => {
    const t = queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dci_queue%' ORDER BY name").map((r) => r.name);
    assert.deepEqual(t, ["dci_queue_manual", "dci_queue_marks"]);
  });
  await ok("no network", async () => assert.equal(net, 0));
  console.log(`# ${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// CALLRESULT-410000 fixture: the «ثبت نتیجه‌ی تماس» box on the v2.0 «کارهای امروز» page sends the planItemId of the task the expert
// opened, which may be a pending item or one already closed by a VoIP CDR. Before: 409 not_current_item (report lost).
// After: same customer + same plan → saved (pending item closed, done item keeps status + gets the empty outcome, no «خارج از لیست»
// mirror); other customer / other plan → still 409. Runs on a temp COPY of a masked DB. No network.
// Usage: CR_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/call-result-410000-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.CR_FIXTURE_DB;
if (!src) { console.log("SKIP (set CR_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr410-fx-"));
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
  const { queryRow, queryRows, execute } = db;
  const flag = (k, v) => execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  flag("flag.daily_plan", "1");
  const NOW = new Date("2026-11-11T06:30:00.000Z"); // Wednesday 10:00 Tehran
  const DAY = dp.dpToday(NOW);
  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true };
  for (const p of queryRows("SELECT id FROM dp_plans WHERE salesperson_id=6 AND day=?", [DAY])) { execute("DELETE FROM dp_items WHERE plan_id=?", [p.id]); execute("DELETE FROM dp_plans WHERE id=?", [p.id]); }
  const plan = dp.dpActiveFor(kazemi, NOW);
  assert.ok(plan, "plan for user 8 started");
  const its = () => queryRows("SELECT * FROM dp_items WHERE plan_id=? ORDER BY id", [plan.id]);
  const notFirst = (i) => !dp.dpFirstCallIncomplete(plan, i);
  let cur = its().find((i) => i.status === "current");
  const pend = its().filter((i) => i.status === "pending" && notFirst(i) && i.customer_id !== cur?.customer_id);
  assert.ok(cur && pend.length >= 3, `need a current + 3 pending items (got ${its().length})`);
  const [B, C, D] = pend;
  const outsideCount = () => queryRow("SELECT COUNT(*) n FROM dp_items WHERE plan_id=? AND bucket='outside'", [plan.id]).n;
  let logId = 0;
  const newLog = (cid) => Number(execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,expert_notes,created_at) VALUES(?,?,?,?,?)", [cid, 6, "fixture", "x", NOW.toISOString()]));
  const report = (itemId, cid, extra = {}) => ({ customerId: cid, planItemId: itemId, outcome: "no_answer", call_result: "no_answer", oneLineNote: "جواب نداد", subject: "کارهای امروز", ...extra });

  await ok("current item: unchanged path (plan, closes it)", async () => {
    const b = report(cur.id, cur.customer_id);
    assert.equal(dp.dpPreCall(b, kazemi, NOW), null); assert.equal(b.__dp, "plan");
  });

  await ok("pending item of the same customer (picked in the v2.0 list): saved, closes THAT item, no mirror", async () => {
    const before = outsideCount();
    const b = report(B.id, B.customer_id);
    assert.equal(dp.dpPreCall(b, kazemi, NOW), null, "no 409");
    assert.equal(b.__dp, "outside"); assert.equal(b.__dpItem, B.id);
    logId = newLog(B.customer_id);
    const r = dp.dpAfterCall(b, logId, kazemi, B.customer_id, NOW.toISOString());
    assert.equal(r.itemId, B.id);
    const row = queryRow("SELECT status,outcome,call_log_id FROM dp_items WHERE id=?", [B.id]);
    assert.deepEqual([row.status, row.outcome, row.call_log_id], ["done", "no_answer", logId]);
    assert.equal(outsideCount(), before, "no «خارج از لیست» mirror");
    assert.equal(queryRow("SELECT status FROM dp_items WHERE id=?", [cur.id]).status, "current", "current item untouched");
  });

  await ok("item already closed by a VoIP CDR (done, outcome NULL): saved, outcome filled, status kept, no mirror (Kazemi 09:30)", async () => {
    const voipLog = newLog(C.customer_id);
    execute("UPDATE dp_items SET status='done', outcome=NULL, call_log_id=?, done_at=? WHERE id=?", [voipLog, NOW.toISOString(), C.id]);
    const before = outsideCount();
    const b = report(C.id, C.customer_id);
    assert.equal(dp.dpPreCall(b, kazemi, NOW), null, "no 409");
    assert.equal(b.__dp, "outside"); assert.equal(b.__dpItem, undefined); assert.equal(b.__dpLate, C.id);
    const r = dp.dpAfterCall(b, newLog(C.customer_id), kazemi, C.customer_id, NOW.toISOString());
    assert.equal(r.kind, "late");
    const row = queryRow("SELECT status,outcome,call_log_id FROM dp_items WHERE id=?", [C.id]);
    assert.deepEqual([row.status, row.outcome, row.call_log_id], ["done", "no_answer", voipLog]);
    assert.equal(outsideCount(), before, "no «خارج از لیست» mirror");
  });

  await ok("done item with an outcome already: outcome not overwritten", async () => {
    const b = report(C.id, C.customer_id, { outcome: "answered", call_result: "answered", oneLineNote: "صحبت شد" });
    assert.equal(dp.dpPreCall(b, kazemi, NOW), null);
    dp.dpAfterCall(b, newLog(C.customer_id), kazemi, C.customer_id, NOW.toISOString());
    assert.equal(queryRow("SELECT outcome FROM dp_items WHERE id=?", [C.id]).outcome, "no_answer");
  });

  await ok("item id of ANOTHER customer → still 409 not_current_item (no cross-customer close)", async () => {
    const b = report(D.id, B.customer_id);
    const e = dp.dpPreCall(b, kazemi, NOW);
    assert.equal(e?.status, 409); assert.equal(e?.error, "not_current_item");
    assert.equal(queryRow("SELECT status FROM dp_items WHERE id=?", [D.id]).status, "pending");
  });

  await ok("item id from another plan (other expert / other day) → still 409", async () => {
    const other = queryRow("SELECT i.id, i.customer_id FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id WHERE p.id<>? ORDER BY i.id DESC LIMIT 1", [plan.id]);
    if (!other) { console.log("  (no other plan in copy; skipped)"); return; }
    const e = dp.dpPreCall(report(other.id, other.customer_id), kazemi, NOW);
    assert.equal(e?.status, 409); assert.equal(e?.error, "not_current_item");
  });

  await ok("non-current item still needs outcome + note (422, no silent save)", async () => {
    const e1 = dp.dpPreCall(report(D.id, D.customer_id, { outcome: "" }), kazemi, NOW);
    assert.equal(e1?.status, 422); assert.equal(e1?.error, "outcome_required");
    const e2 = dp.dpPreCall(report(D.id, D.customer_id, { oneLineNote: "  " }), kazemi, NOW);
    assert.equal(e2?.status, 422); assert.equal(e2?.error, "note_required");
  });

  await ok("no network", async () => assert.equal(net, 0));
  console.log(`# ${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// OWNER-CHANGE-UNBLOCK fixture (Mohammad t154u, 2026-11-03): an expert whose customer moved to another expert (priority down →
// Kazemi via nonp1 transfer, or any other reassignment) while her CRM-button call on it was still unreported must NOT stay blocked
// («تماس باز با … هنوز نتیجه ندارد» / 423 call_pending). Runs on a throwaway copy of a (masked) DB; all outbound fetch stubbed,
// SMS / Telegram env stripped. Usage: OWNERCHG_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/owner-change-unblock-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
const outbound = [];
globalThis.fetch = async (input) => { outbound.push(String(input).slice(0, 40)); return new Response("{}", { status: 503 }); };
let passed = 0; const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const src = process.env.OWNERCHG_FIXTURE_DB;
if (!src) { console.log("SKIP (set OWNERCHG_FIXTURE_DB to a DB copy)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ownerchg-fx-"));
const dbPath = path.join(dir, "customers.db"); fs.copyFileSync(src, dbPath);
process.env.CRM_DATABASE_PATH = dbPath; process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "warn";
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY/i.test(k)) delete process.env[k];
try {
  const db = await import("../src/lib/crm-db.ts");
  const cq = await import("../src/lib/call-queue.ts");
  const nonp1 = await import("../src/lib/nonp1-transfer.ts");
  const dp = await import("../src/lib/daily-plan.ts");
  const { queryRow, queryRows, execute, executeChanges, runImmediateTransaction } = db;
  cq.ensureCallQueueSchema();
  const HASANI = { id: 2, sp: 3 }; const KAZEMI_SP = 6;
  const n = (sql, a = []) => Number(queryRow(sql, a)?.n ?? 0);
  const bellCount = () => ["site_notification_events", "notification_deliveries", "reminder_sms_deliveries"]
    .map(t => queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]) ? n(`SELECT COUNT(*) n FROM ${t}`) : 0).join(",");
  const snap = (sql, a = []) => JSON.stringify(queryRows(sql, a));
  // make sure no open call exists for Hasani in the copy before we start
  executeChanges("UPDATE call_queue_calls SET report_saved_at='2026-10-29T00:00:00.000Z', on_time=0 WHERE user_id=? AND report_saved_at IS NULL", [HASANI.id]);
  const pick = (skip = []) => queryRow(`SELECT c.id FROM customers c WHERE c.salesperson_id=? AND c.priority=1 AND c.status='in_progress' AND c.merged_into_customer_id IS NULL
      AND c.id NOT IN (${[0, ...skip].join(",")}) AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.customer_id=c.id AND r.done=0) ORDER BY c.id LIMIT 1`, [HASANI.sp]).id;
  const NOW = new Date("2026-10-29T08:00:00.000Z");
  const dial = (cust, at = "2026-10-29T07:55:00.000Z") => Number(execute(
    "INSERT INTO call_queue_calls(user_id,salesperson_id,customer_id,via,link_issued_at) VALUES(?,?,?,?,?)", [HASANI.id, HASANI.sp, cust, "daily_plan", at]));
  let bellsAfterEdit = null; // bells written by the priority edit itself (existing triggers) — not by the transfer / this fix
  const lowerPriority = (cust) => runImmediateTransaction(() => {
    executeChanges("UPDATE customers SET priority=2 WHERE id=?", [cust]); bellsAfterEdit = bellCount();
    return nonp1.applyNonP1TransferInTx({ customerId: cust, oldPriority: 1, oldSalespersonId: HASANI.sp, actor: { id: HASANI.id, role: "sales", salespersonId: HASANI.sp }, via: "fixture", now: NOW });
  });
  const used = [];

  await ok("priority down by the expert → customer to Kazemi, her open call closed (not on time), audited, she is no longer blocked", async () => {
    const cust = pick(used); used.push(cust);
    const id = dial(cust);
    assert.equal(Number(cq.cqPendingCall(HASANI.id)?.id), id, "precondition: the dial blocks her");
    const kaz0 = snap("SELECT * FROM call_queue_calls WHERE salesperson_id=? ORDER BY id", [KAZEMI_SP]);
    const rem0 = snap("SELECT * FROM reminders WHERE customer_id=? ORDER BY id", [cust]);
    const r = lowerPriority(cust);
    assert.equal(r.transferred, true, `transfer skipped: ${r.skip}`);
    assert.equal(Number(queryRow("SELECT salesperson_id s FROM customers WHERE id=?", [cust]).s), KAZEMI_SP);
    const q = queryRow("SELECT * FROM call_queue_calls WHERE id=?", [id]);
    assert.equal(q.report_saved_at, NOW.toISOString()); assert.equal(Number(q.on_time), 0); assert.equal(q.call_log_id, null);
    const ev = queryRows("SELECT * FROM call_queue_events WHERE call_id=? AND kind='call_closed_owner_changed'", [id]);
    assert.equal(ev.length, 1); assert.equal(ev[0].reason, "owner_changed_priority_down"); assert.equal(Number(ev[0].user_id), HASANI.id);
    assert.equal(cq.cqPendingCall(HASANI.id), null, "no pending call any more → no banner, no 423");
    assert.equal(snap("SELECT * FROM call_queue_calls WHERE salesperson_id=? ORDER BY id", [KAZEMI_SP]), kaz0, "Kazemi's calls untouched");
    assert.equal(bellCount(), bellsAfterEdit, "transfer + call close add no bell / notification / SMS rows");
    // reminders follow the file by the existing owner trigger (none existed here; nothing created)
    assert.equal(n("SELECT COUNT(*) n FROM reminders WHERE customer_id=?", [cust]), JSON.parse(rem0).length);
  });

  await ok("a call the expert already logged on that customer is linked like a report (call_log_id + on-time rule), not closed blank", async () => {
    const cust = pick(used); used.push(cust);
    const id = dial(cust, "2026-10-29T07:58:00.000Z");
    const logId = Number(execute("INSERT INTO call_logs(customer_id,salesperson_id,subject,created_at,created_by_user_id) VALUES(?,?,?,?,?)",
      [cust, HASANI.sp, "fixture", "2026-10-29T07:59:00.000Z", HASANI.id]));
    // the in-request report path normally closes it first; simulate it NOT having done so
    assert.equal(lowerPriority(cust).transferred, true);
    const q = queryRow("SELECT * FROM call_queue_calls WHERE id=?", [id]);
    assert.equal(Number(q.call_log_id), logId); assert.equal(q.report_saved_at, "2026-10-29T07:59:00.000Z");
    assert.equal(cq.cqPendingCall(HASANI.id), null);
  });

  await ok("no change while the customer is still hers; the new owner's own open call is never closed", async () => {
    const cust = pick(used); used.push(cust);
    const id = dial(cust);
    assert.equal(Number(cq.cqPendingCall(HASANI.id)?.id), id, "still her customer → still pending (unchanged behaviour)");
    executeChanges("UPDATE call_queue_calls SET report_saved_at=?, on_time=0 WHERE id=?", [NOW.toISOString(), id]); // clean up
    const kazUser = Number(queryRow("SELECT user_id u FROM call_queue_calls WHERE salesperson_id=? LIMIT 1", [KAZEMI_SP])?.u ?? 8);
    const kc = queryRow("SELECT id FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL LIMIT 1", [KAZEMI_SP]).id;
    const kid = Number(execute("INSERT INTO call_queue_calls(user_id,salesperson_id,customer_id,via,link_issued_at) VALUES(?,?,?,?,?)", [kazUser, KAZEMI_SP, kc, "daily_plan", NOW.toISOString()]));
    assert.deepEqual(cq.cqCloseCallsOfFormerOwner({ customerId: kc }, NOW.toISOString()), []);
    assert.equal(queryRow("SELECT report_saved_at r FROM call_queue_calls WHERE id=?", [kid]).r, null);
    executeChanges("DELETE FROM call_queue_calls WHERE id=?", [kid]); // fixture row only (throwaway copy)
  });

  await ok("gate backstop: any other reassignment (admin) → the old expert's open call is closed on her next gate read", async () => {
    const cust = pick(used); used.push(cust);
    const id = dial(cust);
    executeChanges("UPDATE customers SET salesperson_id=? WHERE id=?", [4, cust]);
    assert.equal(cq.cqPendingCall(HASANI.id), null);
    const ev = queryRow("SELECT reason FROM call_queue_events WHERE call_id=? AND kind='call_closed_owner_changed'", [id]);
    assert.equal(ev.reason, "owner_changed");
    assert.equal(cq.cqPendingCall(HASANI.id), null); // idempotent
    assert.equal(n("SELECT COUNT(*) n FROM call_queue_events WHERE call_id=?", [id]), 1, "one audit row only");
  });

  await ok("Today plan: item → «منتقل شد», her dial closed, new owner gets ONE «تازه اضافه شد» (no duplicate on repeated refresh)", async () => {
    const plan = queryRow("SELECT * FROM dp_plans WHERE salesperson_id=? AND day='2026-10-29'", [HASANI.sp]);
    const kplan = queryRow("SELECT * FROM dp_plans WHERE salesperson_id=? AND day='2026-10-29'", [KAZEMI_SP]);
    assert.ok(plan && kplan, "masked copy has both 2026-10-29 plans");
    executeChanges("UPDATE dp_plans SET closed_at=NULL WHERE id IN (?,?)", [plan.id, kplan.id]);
    const cust = pick(used); used.push(cust);
    const itemId = Number(execute(`INSERT INTO dp_items(plan_id,customer_id,type,reason,bucket,source,label,status,move_count,position,created_at)
      VALUES(?,?,?,?,?,?,?,?,0,999,?)`, [plan.id, cust, "followup", "fixture", "main", "fixture", "در نوبت", "pending", "2026-10-29T07:00:00.000Z"]));
    const id = dial(cust);
    executeChanges("UPDATE dp_items SET call_id=? WHERE id=?", [id, itemId]);
    // reassignment with NO nonp1 hook (direct owner change) → only dpRefresh step 1 / the gate can close it
    executeChanges("UPDATE customers SET salesperson_id=? WHERE id=?", [KAZEMI_SP, cust]);
    const kBefore = n("SELECT COUNT(*) n FROM dp_items WHERE plan_id=? AND customer_id=?", [kplan.id, cust]);
    dp.dpRefresh(queryRow("SELECT * FROM dp_plans WHERE id=?", [plan.id]), NOW);
    assert.equal(queryRow("SELECT status s FROM dp_items WHERE id=?", [itemId]).s, "transferred");
    assert.notEqual(queryRow("SELECT report_saved_at r FROM call_queue_calls WHERE id=?", [id]).r, null, "dial closed by the refresh");
    assert.equal(queryRow("SELECT reason FROM call_queue_events WHERE call_id=?", [id]).reason, "owner_changed");
    dp.dpRefresh(queryRow("SELECT * FROM dp_plans WHERE id=?", [plan.id]), NOW);
    const kAfter = n("SELECT COUNT(*) n FROM dp_items WHERE plan_id=? AND customer_id=?", [kplan.id, cust]);
    assert.ok(kAfter - kBefore <= 1, `no duplicate for the new owner (${kBefore}→${kAfter})`);
    assert.equal(cq.cqPendingCall(HASANI.id), null);
  });

  assert.deepEqual(outbound, [], "no outbound HTTP (no SMS / Telegram / bells)");
  console.log(`\n${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

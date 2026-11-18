/**
 * t861: a failed click-to-call originate arrives from Simotel as an "outgoing" CDR whose dst is the literal «failed»
 * (the expert's own phone did not answer; the customer was never dialed). The CRM stored «failed» as the phone and
 * the today queue showed it as the number. Covers: only a valid phone is stored; the number comes from the expert's
 * click-to-call record (exact originated_call_id, else one unambiguous click call by extension + time); never guessed;
 * no call log for a never-dialed customer; a re-sync keeps FAILED; normal CDRs unchanged; the queue never shows «failed».
 * Runs on a temp COPY of a masked DB; synthetic numbers only; no network, no SMS, no live writes.
 * Usage: T861_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t861-failed-originate-fixture.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.T861_FIXTURE_DB;
if (!src) { console.log("SKIP (set T861_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t861-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SMS_DISABLED: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
  SAB_FEEDER: "0", BALE_BOT_WORKER: "0", LOAN_REQUEST_DRAFTS_JOBS: "off", SITE_LEAD_ALERTS: "off",
});
globalThis.fetch = async () => { throw new Error("unexpected network call in t861 fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
try {
  const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
  const vac = await import("../src/lib/voip-after-call.ts");
  const { callExtensions } = await import("../src/lib/simotel.ts");
  const { dqQueue } = await import("../src/lib/dci-queue.ts");
  vac.ensureAfterCallSchema();

  const EXT = "210", USER = 2, SP = 3;
  const P1 = "09120000861", P2 = "09120000862", P3 = "09120000863", P4 = "09120000864";
  const cust = (phone) => {
    const c = queryRow("SELECT id FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL AND phone NOT LIKE '0912000086%' ORDER BY id LIMIT 1", [SP]);
    execute("UPDATE customers SET phone=? WHERE id=?", [phone, c.id]); return c.id;
  };
  const C1 = cust(P1), C2 = cust(P2), C3 = cust(P3), C4 = cust(P4);
  assert.equal(new Set([C1, C2, C3, C4]).size, 4);
  const now = new Date();
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  const T0 = now.getTime() - 20 * 60000;
  const click = (id, phone, cid, createdMs, endedMs, orig = null) => execute(
    `INSERT INTO voip_click_calls(id,user_id,extension,customer_id,phone,state,originate_id,active,created_at,ended_at,updated_at,cust_status)
     VALUES(?,?,?,?,?,'me_timeout',?,0,?,?,?, 'NOT_DIALED')`,
    [id, USER, EXT, cid, phone, orig, new Date(createdMs).toISOString(), new Date(endedMs).toISOString(), new Date(endedMs).toISOString()]);
  // Shape of the real CDR (event e-2989), masked: outgoing, src = the expert's extension, dst = «failed», 1 s, NO ANSWER.
  const cdr = (id, startMs, extra = {}) => ({
    _id: id, cuid: "", src: EXT, dst: "failed", type: "outgoing", start: new Date(startMs).toISOString(),
    disposition: "NO ANSWER", duration: 1, billsec: 0,
    endtime: { $date: { $numberLong: String(startMs + 1000) } }, ...extra,
  });
  const ev = (id) => queryRow("SELECT * FROM voip_after_call_events WHERE external_id=?", [id]);
  const logsBefore = queryRow("SELECT count(*) n FROM call_logs").n;

  // A: click call created 2.7 s before the CDR start (the common case, like e-2989).
  click(990001, P1, C1, T0, T0 + 32000);
  // B: the CDR arrives at the 30 s ring timeout (the other real cluster).
  click(990002, P2, C2, T0 + 120000, T0 + 151000);
  // C: two click calls within the window → ambiguous → no number.
  click(990003, P3, C3, T0 + 240000, T0 + 275000); click(990004, P4, C4, T0 + 241000, T0 + 276000);
  // D: no click call at all. E: exact originated_call_id outside the time window.
  click(990005, P4, C4, T0 + 300000, T0 + 330000, "orig.call.t861.fixture");
  const rows = [
    cdr("t861-a", T0 + 2700),
    cdr("t861-b", T0 + 120000 + 30800),
    cdr("t861-c", T0 + 242500),
    cdr("t861-d", T0 + 600000),
    cdr("t861-e", T0 + 900000, { originated_call_id: "orig.call.t861.fixture" }),
    { _id: "t861-normal", cuid: "", src: EXT, dst: P1, type: "outgoing", start: at(-5 * 60000), disposition: "ANSWERED", duration: 60, billsec: 50,
      endtime: { $date: { $numberLong: String(now.getTime() - 4 * 60000) } } },
  ];

  await ok("«failed» is not an extension", () => assert.deepEqual(callExtensions(rows[0], [EXT]), [EXT]));
  vac.ingestAfterCalls(rows, now);

  await ok("A: number from the click call, customer linked, status FAILED, no «failed» anywhere", () => {
    const e = ev("t861-a");
    assert.equal(e.phone, P1); assert.equal(e.customer_id, C1); assert.equal(e.status, "FAILED");
    assert.equal(e.peer_source, "click_call"); assert.deepEqual(JSON.parse(e.extensions_json), [EXT]); assert.equal(e.expert_user_id, USER);
  });
  await ok("A: no call log for a customer who was never dialed", () => assert.equal(ev("t861-a").call_log_id, null));
  await ok("B: CDR at the ring timeout matches its click call", () => { const e = ev("t861-b"); assert.equal(e.phone, P2); assert.equal(e.customer_id, C2); });
  await ok("C: ambiguous click calls → empty number, never guessed", () => { const e = ev("t861-c"); assert.equal(e.phone, ""); assert.equal(e.customer_id, null); assert.equal(e.peer_source, "none"); });
  await ok("D: no click call → empty number", () => { const e = ev("t861-d"); assert.equal(e.phone, ""); assert.equal(e.status, "FAILED"); });
  await ok("E: exact originated_call_id wins", () => { const e = ev("t861-e"); assert.equal(e.phone, P4); assert.equal(e.customer_id, C4); });
  await ok("normal CDR unchanged (number from dst, call log created)", () => {
    const e = ev("t861-normal"); assert.equal(e.phone, P1); assert.equal(e.status, "ANSWERED"); assert.equal(e.peer_source, null); assert.ok(e.call_log_id != null);
    assert.equal(queryRow("SELECT count(*) n FROM call_logs").n, logsBefore + 1);
  });
  await ok("no stored phone is a non-phone string", () => {
    const bad = queryRows("SELECT phone FROM voip_after_call_events WHERE external_id LIKE 't861-%'").filter(r => r.phone !== "" && vac.dialedNumber(r.phone) !== r.phone);
    assert.deepEqual(bad, []);
  });
  vac.ingestAfterCalls(rows, now);
  await ok("re-sync keeps FAILED and the recovered number, still no call log", () => {
    const e = ev("t861-a"); assert.equal(e.status, "FAILED"); assert.equal(e.phone, P1); assert.equal(e.call_log_id, null);
  });
  await ok("cdrPeerPhone validates", () => {
    assert.equal(vac.cdrPeerPhone(rows[0]), null); assert.equal(vac.cdrPeerPhone({ ...rows[0], dst: "*" }), null);
    assert.equal(vac.cdrPeerPhone({ ...rows[0], dst: "+989120000861" }), P1);
    assert.equal(vac.cdrPeerPhone({ ...rows[0], dst: "00441234567890" }), "00441234567890", "an international number as dialed is kept");
    assert.equal(vac.cdrPeerPhone({ ...rows[0], dst: "FAILED " }), null);
  });
  await ok("today queue never shows «failed»; no-number calls stay separate items", () => {
    const u = { id: USER, role: "salesperson", salespersonId: SP, fullName: "x", username: "x", permissions: ["calls.create", "calls.view", "customers.view"], customerScope: "assigned", active: true };
    const q = dqQueue(u, now);
    const s = JSON.stringify(q);
    assert.ok(!s.includes('"failed"'), "queue JSON contains «failed»");
    const items = (q.items ?? q.queue ?? []).filter(i => String(i.id ?? "").startsWith("e-"));
    const ids = items.map(i => i.id);
    const cId = `e-${ev("t861-c").id}`, dId = `e-${ev("t861-d").id}`;
    if (ids.length) { assert.ok(ids.includes(cId) && ids.includes(dId), `separate items ${ids}`); for (const i of items) assert.ok(i.phone == null || vac.dialedNumber(i.phone) === i.phone); }
    else assert.fail("no unknown items found in the queue: " + Object.keys(q));
  });
  console.log(`t861 fixture: ${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

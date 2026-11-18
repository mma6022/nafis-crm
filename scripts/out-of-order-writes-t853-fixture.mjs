// t853u: note / call start / follow-up on a later or earlier item of THIS expert's today list must succeed.
// Other experts' items still 409. Runs on a temp COPY of a masked DB. No network. Never the live DB.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaults = [
  process.env.CR_FIXTURE_DB,
  "/workspace/sam-v12/shots-masked-live-510000.db",
].filter(Boolean);
const src = defaults.find((p) => fs.existsSync(p));
if (!src) { console.log("SKIP (no masked DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t853-ooo-"));
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
  const fc = await import("../src/lib/files-carousel.ts");
  const { queryRow, queryRows, execute } = db;
  const flag = (k, v) => execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  flag("flag.daily_plan", "1");
  const NOW = new Date("2026-11-18T06:30:00.000Z"); // Wednesday 10:00 Tehran
  const DAY = dp.dpToday(NOW);
  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const kazemi = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true };
  dp.ensureDailyPlanSchema();
  const own = queryRows("SELECT id, phone FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL AND phone IS NOT NULL AND phone <> '' ORDER BY id LIMIT 4");
  assert.ok(own.length >= 3, "need at least 3 of this expert's customers in the copy");
  for (const p of queryRows("SELECT id FROM dp_plans WHERE salesperson_id=6 AND day=?", [DAY])) {
    execute("DELETE FROM dp_items WHERE plan_id=?", [p.id]); execute("DELETE FROM dp_plans WHERE id=?", [p.id]);
  }
  const planId = Number(execute("INSERT INTO dp_plans(salesperson_id,user_id,day,mode,started_at,created_at) VALUES(?,?,?,?,?,?)",
    [6, 8, DAY, "assistant", NOW.toISOString(), NOW.toISOString()]));
  const addItem = (cid, status, pos) => Number(execute(
    "INSERT INTO dp_items(plan_id,customer_id,type,source,bucket,position,status,created_at,became_current_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [planId, cid, "followup", "list", "main", pos, status, NOW.toISOString(), status === "current" ? NOW.toISOString() : null]));
  const curId = addItem(own[0].id, "current", 1);
  const pendId = addItem(own[1].id, "pending", 2);
  const laterId = addItem(own[2].id, "pending", 3);
  const plan = dp.dpActiveFor(kazemi, NOW);
  assert.ok(plan && plan.id === planId, "seeded plan is active");

  await ok("dpStartCall on a later (pending) today-list item succeeds", async () => {
    const r = dp.dpStartCall(kazemi, pendId, NOW);
    assert.equal(r.error, undefined, r.message ?? "no error");
    assert.equal(r.ok, true);
    assert.ok(r.callId > 0);
    assert.ok(String(r.tel || "").startsWith("tel:"));
  });

  await ok("dpStartCall on an even later pending item also succeeds (out of order)", async () => {
    // a pending call on a previous customer would 423 call_pending — close that report slot first
    execute("UPDATE call_queue_calls SET report_saved_at=? WHERE user_id=? AND report_saved_at IS NULL", [NOW.toISOString(), 8]);
    const r = dp.dpStartCall(kazemi, laterId, NOW);
    assert.equal(r.error, undefined, r.message ?? "no error");
    assert.equal(r.ok, true);
  });

  await ok("dpStartCall on an id that is not this expert's today list still 409", async () => {
    const e = dp.dpStartCall(kazemi, 9_999_999, NOW);
    assert.equal(e.status, 409);
    assert.equal(e.error, "not_current_item");
  });

  await ok("dpPreCall report for a later pending item is saved (not 409)", async () => {
    execute("UPDATE call_queue_calls SET report_saved_at=? WHERE user_id=? AND report_saved_at IS NULL", [NOW.toISOString(), 8]);
    const b = { customerId: own[2].id, planItemId: laterId, outcome: "answered", call_result: "answered", oneLineNote: "صحبت شد", subject: "کارهای امروز" };
    assert.equal(dp.dpPreCall(b, kazemi, NOW), null);
    assert.ok(b.__dpItem === laterId || b.__dp === "outside" || b.__dp === "plan");
  });

  await ok("dpMove stays current-only (queue move is not a note/result save)", async () => {
    const e = dp.dpMove(kazemi, laterId, { reason: "other", text: "بعدا", to: "17:00" }, NOW);
    assert.equal(e.status, 409);
    assert.equal(e.error, "not_current_item");
  });

  // files-carousel: follow-up on a pending own card
  await ok("fcExpertFollowup on a later own file is not rejected as not_current / board_turn", async () => {
    try { fc.ensureFcSchema(); } catch { console.log("  (no files-carousel schema; skipped)"); return; }
    const cols = queryRows("PRAGMA table_info(loan_applications)").map((c) => c.name);
    const ownerCol = ["salesperson_id", "owner", "owner_salesperson_id", "assigned_salesperson_id"].find((c) => cols.includes(c));
    if (!ownerCol) { console.log("  (no owner column; skipped)"); return; }
    const mine = queryRows(`SELECT id FROM loan_applications WHERE deleted_at IS NULL AND ${ownerCol}=6
      AND COALESCE(status,'') NOT IN ('rejected','cancelled') ORDER BY id DESC LIMIT 8`);
    if (!mine.length) { console.log("  (no own files in copy; skipped)"); return; }
    flag("flag.files_carousel", "1");
    const b = mine[mine.length > 1 ? 1 : 0].id;
    const r = fc.fcExpertFollowup(kazemi, { fileId: b, outcome: "no_answer", note: "پیگیری شد" }, NOW);
    if (r && r.error === "bad_outcome") {
      const r2 = fc.fcExpertFollowup(kazemi, { fileId: b, outcome: "answered", note: "پیگیری شد" }, NOW);
      assert.notEqual(r2?.error, "not_current", r2?.message);
      assert.notEqual(r2?.error, "board_turn", r2?.message);
      assert.notEqual(r2?.error, "files_locked", r2?.message);
      if (r2?.error === "file_not_found") { console.log("  (file not in today's deck; skipped)"); return; }
      return;
    }
    assert.notEqual(r?.error, "not_current", r?.message);
    assert.notEqual(r?.error, "board_turn", r?.message);
    assert.notEqual(r?.error, "files_locked", r?.message);
    if (r?.error === "file_not_found") { console.log("  (file not in today's deck; skipped)"); return; }
  });

  await ok("no network", async () => assert.equal(net, 0));
  console.log(`# ${passed} passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

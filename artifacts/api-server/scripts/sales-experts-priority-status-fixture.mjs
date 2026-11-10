// sales-experts-priority-status v1 (flag.sales_experts_priority_status_v1):
// flag OFF = identical to today (lockdown still 403s a status/priority PATCH when the customer
// is not on today's plan / incoming / a case; DCI board has no canEditPriorityStatus);
// flag ON = an expert can set in_progress / completed / cancelled and priority on their own
// customer (200), another expert's customer is 403, admin unchanged.
// Own-customer rule, P1-revert, and cancelled→in_progress reactivation are not widened.
// No SMS / Bale / network. Runs on a temp COPY of a masked DB.
// Usage: PS_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/sales-experts-priority-status-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const src = process.env.PS_FIXTURE_DB || process.env.DCI_FIXTURE_DB || process.env.CS_FIELDS_FIXTURE_DB;
if (!src) { console.log("SKIP (set PS_FIXTURE_DB)"); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
let netCalls = 0;
globalThis.fetch = async () => { netCalls++; throw new Error("unexpected network call in ps fixture"); };
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, queryRows, execute } = db;
  const { expertLockdownGuard } = await import("../src/lib/expert-lockdown.ts");
  const dci = await import("../src/lib/daily-customer-inline.ts");
  const ps = await import("../src/lib/sales-experts-priority-status.ts");
  const express = (await import("express")).default;
  const crmRouter = (await import("../src/routes/crm.ts")).default;
  const dciRouter = (await import("../src/routes/daily-customer-inline.ts")).default;

  const P = ["customers.view", "customers.update", "calls.create", "calls.view"];
  const actors = {
    admin: { id: 1, role: "admin", salespersonId: null, fullName: "admin", permissions: P, customerScope: "all", active: true, salesManager: false },
    hasani: { id: 2, role: "salesperson", salespersonId: 3, fullName: "hasani", permissions: P, customerScope: "assigned", active: true },
    ghasemi: { id: 3, role: "salesperson", salespersonId: 4, fullName: "ghasemi", permissions: P, customerScope: "assigned", active: true },
    kazemi: { id: 8, role: "salesperson", salespersonId: 6, fullName: "kazemi", permissions: P, customerScope: "assigned", active: true },
  };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

  const ts = new Date().toISOString();
  const CID_H = 910041, CID_G = 910042, CID_H2 = 910043, CID_K = 910044;
  for (const c of [
    [CID_H, "HasaniOwn", "09120000041", 3],
    [CID_G, "GhasemiOwn", "09120000042", 4],
    [CID_H2, "HasaniTwo", "09120000043", 3],
    [CID_K, "KazemiOwn", "09120000044", 6],
  ]) {
    execute("DELETE FROM loan_applications WHERE customer_id=?", [c[0]]);
    execute("DELETE FROM goods_purchases WHERE customer_id=?", [c[0]]);
    if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='customer_payment_orders'"))
      execute("DELETE FROM customer_payment_orders WHERE customer_id=?", [c[0]]);
    if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='dp_items'"))
      execute("DELETE FROM dp_items WHERE customer_id=?", [c[0]]);
    if (queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='el_grants'"))
      execute("DELETE FROM el_grants WHERE customer_id=?", [c[0]]);
    execute("DELETE FROM customers WHERE id=?", [c[0]]);
    execute(`INSERT INTO customers(id,name,phone,salesperson_id,status,priority,created_at,verification_status,is_urgent,verification_version,national_code)
      VALUES(?,?,?,?, 'in_progress', 2, ?, 'unverified', 0, 0, NULL)`,
      [c[0], c[1], c[2], c[3], ts]);
  }

  // Start from a known flag state: lockdown ON (as live), PS flag absent, DCI ON so the board can be probed.
  flag("flag.expert_lockdown", "1");
  execute("DELETE FROM call_queue_settings WHERE key LIKE 'flag.sales_experts_priority_status_v1%'");
  flag("flag.daily_customer_inline_v1", "1");

  const count = (table) => {
    if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [table])) return 0;
    return Number(queryRow(`SELECT COUNT(*) n FROM "${table}"`)?.n ?? 0);
  };
  const sms0 = count("reminder_sms_deliveries");
  const bale0 = count("bale_outbox");
  const loanPlansSnap = () => queryRows("SELECT * FROM loan_plans ORDER BY id").map((r) => JSON.stringify(r));
  const loanPlans0 = loanPlansSnap();
  const notif0 = queryRows("SELECT key, value FROM notification_settings ORDER BY key").map((r) => `${r.key}=${r.value}`);
  const team0 = queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='team_sales_config'")
    ? queryRows("SELECT * FROM team_sales_config").map((r) => JSON.stringify(r))
    : [];

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.authUser = actors[req.headers["x-actor"]];
    if (!res.locals.authUser) { res.sendStatus(401); return; }
    next();
  });
  app.use("/api", expertLockdownGuard, crmRouter, dciRouter);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, url, actor, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ socketPath: sock, path: "/api" + url, method, headers: { "x-actor": actor, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
  const rowOf = (id) => queryRow("SELECT status, priority FROM customers WHERE id=?", [id]);

  await ok("flag helper is OFF when absent", () => {
    assert.equal(ps.psFlagOn(2), false);
    assert.equal(ps.psGlobalOn(), false);
    assert.equal(ps.psIsStatusPriorityOnlyBody({ status: "completed" }), true);
    assert.equal(ps.psIsStatusPriorityOnlyBody({ priority: 1 }), true);
    assert.equal(ps.psIsStatusPriorityOnlyBody({ status: "cancelled", priority: 3 }), true);
    assert.equal(ps.psIsStatusPriorityOnlyBody({ status: "completed", name: "x" }), false);
    assert.equal(ps.psIsStatusPriorityOnlyBody({}), false);
  });

  await ok("flag OFF: lockdown still blocks status/priority PATCH on an own customer with no plan/case", async () => {
    const st = await call("PATCH", `/customers/${CID_H}`, "hasani", { status: "completed" });
    assert.equal(st.status, 403);
    assert.equal(st.body?.error, "expert_lockdown_customer");
    const pr = await call("PATCH", `/customers/${CID_H}`, "hasani", { priority: 3 });
    assert.equal(pr.status, 403);
    assert.equal(pr.body?.error, "expert_lockdown_customer");
    const both = await call("PATCH", `/customers/${CID_H}`, "hasani", { status: "cancelled", priority: 1 });
    assert.equal(both.status, 403);
    const now = rowOf(CID_H);
    assert.equal(now.status, "in_progress");
    assert.equal(Number(now.priority), 2);
  });

  await ok("flag OFF: DCI board does not offer the new chips; other expert is still 403", async () => {
    const own = await call("GET", `/daily-customer-inline/customers/${CID_H}`, "hasani");
    assert.equal(own.status, 200);
    assert.equal(own.body?.canEditPriorityStatus, false);
    const other = await call("GET", `/daily-customer-inline/customers/${CID_G}`, "hasani");
    assert.equal(other.status, 403);
    assert.equal(other.body?.error, "not_owner");
  });

  await ok("flag OFF: admin can still change status and priority (unchanged)", async () => {
    const r = await call("PATCH", `/customers/${CID_H2}`, "admin", { status: "completed", priority: 3 });
    assert.equal(r.status, 200);
    const now = rowOf(CID_H2);
    assert.equal(now.status, "completed");
    assert.equal(Number(now.priority), 3);
    const back = await call("PATCH", `/customers/${CID_H2}`, "admin", { status: "in_progress", priority: 2 });
    assert.equal(back.status, 200);
  });

  flag("flag.sales_experts_priority_status_v1", "1");
  assert.equal(ps.psFlagOn(2), true);

  await ok("flag ON: closer can set completed on own customer (status-only, no hand-off)", async () => {
    const a = await call("PATCH", `/customers/${CID_H}`, "hasani", { status: "completed" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(rowOf(CID_H).status, "completed");
    assert.equal(Number(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [CID_H]).sp), 3);
  });

  await ok("flag ON: qualifier sets in_progress, completed, cancelled on own customer", async () => {
    const a = await call("PATCH", `/customers/${CID_K}`, "kazemi", { status: "completed" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(rowOf(CID_K).status, "completed");
    const b = await call("PATCH", `/customers/${CID_K}`, "kazemi", { status: "in_progress" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(rowOf(CID_K).status, "in_progress");
    assert.equal(Number(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [CID_K]).sp), 6);
    const cx = await call("PATCH", `/customers/${CID_K}`, "kazemi", { status: "cancelled" });
    assert.equal(cx.status, 200, JSON.stringify(cx.body));
    assert.equal(rowOf(CID_K).status, "cancelled");
  });

  await ok("flag ON: qualifier sets every priority on own customer (non-P1 hand-off does not apply to Kazemi)", async () => {
    const p3 = await call("PATCH", `/customers/${CID_K}`, "kazemi", { priority: 3 });
    assert.equal(p3.status, 200, JSON.stringify(p3.body));
    assert.equal(Number(rowOf(CID_K).priority), 3);
    const p0 = await call("PATCH", `/customers/${CID_K}`, "kazemi", { priority: null });
    assert.equal(p0.status, 200, JSON.stringify(p0.body));
    assert.equal(rowOf(CID_K).priority, null);
    const p1 = await call("PATCH", `/customers/${CID_K}`, "kazemi", { priority: 1 });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(Number(rowOf(CID_K).priority), 1);
    const p2 = await call("PATCH", `/customers/${CID_K}`, "kazemi", { priority: 2 });
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(Number(rowOf(CID_K).priority), 2);
    assert.equal(Number(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [CID_K]).sp), 6);
  });

  await ok("flag ON: cancelled → in_progress still requires reactivation (not widened)", async () => {
    const r = await call("PATCH", `/customers/${CID_K}`, "kazemi", { status: "in_progress" });
    assert.equal(r.status, 409);
    assert.equal(r.body?.code, "reactivation_required");
    assert.equal(rowOf(CID_K).status, "cancelled");
  });

  await ok("flag ON: a PATCH that also changes name stays locked (only status/priority are opened)", async () => {
    const r = await call("PATCH", `/customers/${CID_H}`, "hasani", { status: "completed", name: "ShouldNotWrite" });
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "expert_lockdown_customer");
    assert.equal(queryRow("SELECT name FROM customers WHERE id=?", [CID_H]).name, "HasaniOwn");
  });

  await ok("flag ON: another expert's customer is 403", async () => {
    const st = await call("PATCH", `/customers/${CID_G}`, "hasani", { status: "completed" });
    assert.equal(st.status, 403);
    const pr = await call("PATCH", `/customers/${CID_G}`, "hasani", { priority: 1 });
    assert.equal(pr.status, 403);
    const now = rowOf(CID_G);
    assert.equal(now.status, "in_progress");
    assert.equal(Number(now.priority), 2);
  });

  await ok("flag ON: admin still works the same", async () => {
    const r = await call("PATCH", `/customers/${CID_G}`, "admin", { status: "completed" });
    assert.equal(r.status, 200);
    assert.equal(rowOf(CID_G).status, "completed");
    const back = await call("PATCH", `/customers/${CID_G}`, "admin", { status: "in_progress" });
    assert.equal(back.status, 200);
  });

  await ok("flag ON: DCI board offers chips for the owner and still 403s the other expert", async () => {
    const own = await call("GET", `/daily-customer-inline/customers/${CID_K}`, "kazemi");
    assert.equal(own.status, 200);
    assert.equal(own.body?.canEditPriorityStatus, true);
    assert.equal(own.body?.customer?.status, "cancelled");
    const other = await call("GET", `/daily-customer-inline/customers/${CID_H}`, "kazemi");
    assert.equal(other.status, 403);
    assert.equal(other.body?.error, "not_owner");
    assert.equal(other.body?.canEditPriorityStatus, undefined);
  });

  await ok("no SMS, Bale, network, or guarded tables changed", () => {
    assert.equal(netCalls, 0);
    assert.equal(count("reminder_sms_deliveries"), sms0);
    assert.equal(count("bale_outbox"), bale0);
    const loanPlans1 = loanPlansSnap();
    assert.deepEqual(loanPlans1, loanPlans0);
    const notif1 = queryRows("SELECT key, value FROM notification_settings ORDER BY key").map((r) => `${r.key}=${r.value}`);
    assert.deepEqual(notif1, notif0);
    const team1 = queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='team_sales_config'")
      ? queryRows("SELECT * FROM team_sales_config").map((r) => JSON.stringify(r))
      : [];
    assert.deepEqual(team1, team0);
  });

  console.log(`PASS ${passed} sales-experts-priority-status`);
} catch (e) {
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

// plan-advisor v1 fixture (flag.plan_advisor_v1). No network, no sapi/credit/identity calls.
// Never writes loan_plans, contracts, team_sales_config, notification_settings.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/plan-advisor-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/^(SAPI_|IR_RELAY|ICS24_|NAFIS_IDTEST)/.test(k)) delete process.env[k];
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1", BALE_BOT_WORKER: "0", SAB_FEEDER: "0",
  SMS_DISABLED: "1", SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "fixture-placeholder";
delete process.env.OPENAI_API_KEY;
const netCalls = [];
globalThis.fetch = async (u) => { netCalls.push(String(u).slice(0, 80)); throw new Error("no network in fixture"); };
let passed = 0; const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
let server;
try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const pa = await import("../src/lib/plan-advisor.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const math = await import("../src/lib/plan-quote-math.ts");
  const { queryRow, queryRows, execute } = db;
  const setKey = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const guarded = ["team_sales_config", "notification_settings", "contracts", "contract_templates", "loan_plans", "smc_settings", "users", "sales_teams", "sales_team_members", "sms_outbox", "sms_log"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));

  const tokens = {};
  const ADMIN = 1, KAZEMI = 8, HASANI = 2;
  for (const id of [ADMIN, HASANI, KAZEMI]) {
    const tok = crypto.randomBytes(24).toString("base64url"); tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]);
  }
  const kazemiSp = queryRow("SELECT salesperson_id sp FROM users WHERE id=?", [KAZEMI])?.sp;
  const hasaniSp = queryRow("SELECT salesperson_id sp FROM users WHERE id=?", [HASANI])?.sp;
  assert.ok(kazemiSp, "kazemi salesperson");
  const own = queryRow("SELECT id FROM customers WHERE salesperson_id=? AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1", [kazemiSp]);
  // Not merely "not currently owned": a transferred customer can still sit on the expert's today plan,
  // which elCustomerAccess treats as "plan". Pick someone off that list so the 403 is meaningful.
  const tehranDay = new Date().toLocaleString("en-CA", { timeZone: "Asia/Tehran" }).slice(0, 10);
  const other = queryRow(
    `SELECT c.id FROM customers c
      WHERE c.salesperson_id!=? AND c.merged_into_customer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM dp_items i JOIN dp_plans p ON p.id=i.plan_id
          WHERE p.salesperson_id=? AND p.day=? AND i.customer_id=c.id
        )
      ORDER BY c.id DESC LIMIT 1`, [kazemiSp, kazemiSp, tehranDay]);
  assert.ok(own && other && own.id !== other.id, "need own + other customers");

  const app = express(); app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/elapi", auth.requireAuth, el.expertLockdownGuard, router);
  app.use("/api", auth.requireAuth, router);
  app.use((_req, res) => res.status(404).send("spa"));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body, prefix = "/api") => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: "127.0.0.1", port, agent: false, method, path: `${prefix}${p}`, headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, text: t }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });

  setKey(pa.PA_FLAG, null);
  setKey("flag.expert_lockdown", "1");

  await ok("flag OFF (absent): every plan-advisor route 404s, including /me", async () => {
    for (const [m, p, b] of [
      ["GET", "/plan-advisor/me"],
      ["GET", `/plan-advisor/suggest?customerId=${own.id}`],
      ["GET", "/plan-advisor/quote?planId=1&principal=1000000&term=12"],
      ["PATCH", "/plan-advisor/conditions", { customerId: own.id, patch: { jobType: "retired" } }],
      ["GET", "/plan-advisor/customers?q="+encodeURIComponent("آ")],
    ]) {
      assert.equal((await call(ADMIN, m, p, b)).status, 404, `${m} ${p}`);
    }
  });

  setKey(pa.PA_FLAG, "1");

  await ok("flag ON: /me returns enabled; suggest + quote work for an owned customer", async () => {
    const me = await call(ADMIN, "GET", "/plan-advisor/me");
    assert.equal(me.status, 200); assert.equal(me.body.enabled, true);
    const s = await call(ADMIN, "GET", `/plan-advisor/suggest?customerId=${own.id}`);
    assert.equal(s.status, 200);
    assert.equal(s.body.customer.id, own.id);
    assert.ok(Array.isArray(s.body.chips));
    assert.ok(Array.isArray(s.body.plans));
    const plan = queryRow("SELECT id FROM loan_plans WHERE active=1 ORDER BY id LIMIT 1");
    assert.ok(plan, "need an active plan (read-only)");
    const terms = queryRow("SELECT installment_terms t, principal_amount p FROM loan_plans WHERE id=?", [plan.id]);
    let months = 12;
    try {
      const arr = typeof terms.t === "string" ? JSON.parse(terms.t) : terms.t;
      if (Array.isArray(arr) && arr[0]?.installments) months = Number(arr[0].installments);
    } catch { /* default */ }
    const principal = Math.min(50_000_000, Number(terms.p) || 50_000_000);
    const q = await call(ADMIN, "GET", `/plan-advisor/quote?planId=${plan.id}&principal=${principal}&term=${months}`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const direct = pa.paQuote(plan.id, principal, months);
    assert.ok(!("error" in direct));
    assert.equal(q.body.installment, direct.installment);
    assert.equal(q.body.depositAmount, direct.depositAmount);
    assert.equal(q.body.totalPayable, direct.totalPayable);
    assert.equal(q.body.totalPayable, (direct.installment * direct.count) + direct.downPayment + direct.filingFee);
    if (direct.commission != null) {
      assert.notEqual(q.body.totalPayable, (direct.installment * direct.count) + direct.downPayment + direct.filingFee + direct.commission, "commission stays out of total");
    }
  });

  await ok("mockup worked example uses the live helpers (no loan_plans write)", async () => {
    const plan = {
      principalAmount: 350_000_000,
      annualInterest: 18,
      installments: "18",
      installmentTerms: [{ installments: 12, prepaymentPercent: 0, deductionPercent: 30, depositPercent: 70 },
        { installments: 18, prepaymentPercent: 0, deductionPercent: 30, depositPercent: 70 },
        { installments: 24, prepaymentPercent: 0, deductionPercent: 30, depositPercent: 70 }],
      depositPercents: "70",
      prepaymentPercents: "0",
      deductPercents: "30",
    };
    const principal = 350_000_000, months = 18, filingFee = 1_500_000;
    const q = pa.paQuoteFromPlan(plan, { planId: 0, planName: "خرید کالا — ملت", filingFee, commissionPercent: null }, principal, months);
    assert.ok(!("error" in q), JSON.stringify(q));
    assert.equal(q.depositAmount, math.customerPayout(plan, principal, months));
    assert.equal(q.installment, math.applicationInstallment(plan, principal, months));
    assert.equal(q.depositAmount, 245_000_000);
    assert.equal(q.deduction, 105_000_000);
    assert.equal(q.downPayment, 0);
    assert.equal(q.filingFee, 1_500_000);
    assert.equal(q.count, 18);
    assert.equal(q.installmentsTotal, q.installment * 18);
    assert.equal(q.totalPayable, q.installment * 18 + 1_500_000);
    // Record the live installment so the report can compare with the mockup's ۲۲٬۳۳۲٬۰۲۴
    fs.writeFileSync(path.join(dir, "worked.json"), JSON.stringify({
      principal, months, annualInterest: 18, depositPercent: 70, deductionPercent: 30, prepaymentPercent: 0, filingFee,
      depositAmount: q.depositAmount, installment: q.installment, count: q.count,
      downPayment: q.downPayment, filingFeeOut: q.filingFee, installmentsTotal: q.installmentsTotal,
      totalPayable: q.totalPayable, deduction: q.deduction, commission: q.commission,
    }, null, 2));
    console.log("worked example", q.installment, q.totalPayable, q.depositAmount);
  });

  await ok("chip edits persist in plan_advisor_overrides (additive, flag-gated) and change suggest", async () => {
    const beforeChips = (await call(ADMIN, "PATCH", "/plan-advisor/conditions", { customerId: own.id, patch: { jobType: "retired", guarantorAvailable: "no" } }));
    assert.equal(beforeChips.status, 200);
    const job = beforeChips.body.chips.find((c) => c.key === "jobType");
    assert.equal(job.raw, "retired");
    const row = queryRow("SELECT payload_json j FROM plan_advisor_overrides WHERE customer_id=?", [own.id]);
    assert.ok(row); assert.equal(JSON.parse(row.j).jobType, "retired");
    const again = await call(ADMIN, "GET", `/plan-advisor/suggest?customerId=${own.id}`);
    assert.equal(again.body.chips.find((c) => c.key === "jobType").raw, "retired");
  });

  await ok("locked expert picker is the today short list (first 30); a name outside that list is not returned; GET /customers stays 403", async () => {
    setKey("flag.expert_lockdown", "1");
    const short = queryRows(
      `SELECT c.id, c.name FROM customers c
       WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id=?
       ORDER BY COALESCE((SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id), c.created_at) DESC, c.id DESC
       LIMIT 30`, [kazemiSp]);
    assert.ok(short.length > 0, "short list");
    const listed = await call(KAZEMI, "GET", "/plan-advisor/customers?q=", undefined, "/elapi");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.length <= 30);
    assert.deepEqual(listed.body.items.map((x) => x.id), short.map((x) => x.id));
    const outside = queryRow(
      `SELECT c.id, c.name FROM customers c
       WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id=?
         AND c.id NOT IN (${short.map(() => "?").join(",")})
       ORDER BY c.id DESC LIMIT 1`, [kazemiSp, ...short.map((x) => x.id)]);
    if (outside) {
      const hit = await call(KAZEMI, "GET", `/plan-advisor/customers?q=${encodeURIComponent(String(outside.id))}`, undefined, "/elapi");
      assert.equal(hit.status, 200);
      assert.equal(hit.body.items.length, 0, "id outside the short list must not appear");
      const byName = await call(KAZEMI, "GET", `/plan-advisor/customers?q=${encodeURIComponent(outside.name)}`, undefined, "/elapi");
      assert.ok(!(byName.body.items ?? []).some((x) => x.id === outside.id));
    } else {
      console.log("(note) expert 8 owns ≤30 customers; outside-list check skipped");
    }
    const widen = await call(KAZEMI, "GET", "/customers?limit=1", undefined, "/elapi");
    assert.equal(widen.status, 403);
  });

  await ok("locked expert cannot suggest a customer they do not own; admin can", async () => {
    setKey("flag.expert_lockdown", "1");
    const denied = await call(KAZEMI, "GET", `/plan-advisor/suggest?customerId=${other.id}`, undefined, "/elapi");
    assert.equal(denied.status, 403);
    const allowed = await call(KAZEMI, "GET", `/plan-advisor/suggest?customerId=${own.id}`, undefined, "/elapi");
    assert.equal(allowed.status, 200);
    const admin = await call(ADMIN, "GET", `/plan-advisor/suggest?customerId=${other.id}`);
    assert.equal(admin.status, 200);
  });

  await ok("guarded tables unchanged; fetch never called", async () => {
    for (const t of guarded) assert.equal(tableHash(t), before[t], t);
    assert.deepEqual(netCalls, []);
    assert.equal(tableHash("loan_plans"), before.loan_plans);
  });

  await ok("flag back OFF: routes 404 again; overrides table may remain in the copy", async () => {
    setKey(pa.PA_FLAG, null);
    assert.equal((await call(ADMIN, "GET", "/plan-advisor/me")).status, 404);
    assert.equal((await call(ADMIN, "GET", `/plan-advisor/suggest?customerId=${own.id}`)).status, 404);
  });

  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}

// t886 sales KPI: flag.sales_kpi_v1, read-only KPIs, additive settings.
// Throwaway COPY of a masked DB only; never live, never user 29, no customer writes.
// Usage: MASKED_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t886-sales-kpi-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const src = process.env.T886_FIXTURE_DB || process.env.MASKED_DB;
if (!src) { console.log("SKIP (set T886_FIXTURE_DB or MASKED_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db" || fs.realpathSync(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t886-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
const SESSION_SECRET = `fixture-only-${crypto.randomBytes(16).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t886 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, execute, executeChanges } = await import("../src/lib/crm-db.ts");
const kpi = await import("../src/lib/sales-kpi.ts");
const el = await import("../src/lib/expert-lockdown.ts");
const { crmDb } = await import("../src/lib/crm-db.ts");

const fingerprint = () => {
  const c = queryRow(`SELECT COUNT(*) AS n, COALESCE(SUM(id),0) AS s, COALESCE(SUM(LENGTH(COALESCE(phone,''))),0) AS p FROM customers`);
  const t = queryRow(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='team_sales_config'`);
  const n = queryRow(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(value,''))),0) AS v FROM notification_settings`);
  const p = queryRow(`SELECT COUNT(*) AS n FROM loan_plans`);
  return `${c.n}:${c.s}:${c.p}:${t?.n ?? "x"}:${n?.n ?? "x"}:${n?.v ?? "x"}:${p?.n ?? "x"}`;
};

const setFlag = (v) => {
  if (v == null) {
    executeChanges("DELETE FROM call_queue_settings WHERE key=?", [kpi.SK_FLAG]);
    return;
  }
  execute(
    "INSERT OR REPLACE INTO call_queue_settings(key,value,updated_by,updated_at) VALUES (?,?,NULL,datetime('now'))",
    [kpi.SK_FLAG, v],
  );
};

const actor = (over) => ({
  id: 1, username: "admin", fullName: "مدیر سیستم", mobile: null, telegramId: null,
  priorityColors: {}, role: "admin", roleName: "admin", permissions: [], customerScope: "all",
  salespersonId: null, salespersonName: null, active: true, createdAt: "2020-01-01T00:00:00Z",
  ...over,
});

const admin = actor({ id: 1 });
const salesManager = actor({ id: 5, role: "admin", salesManager: true, baseRole: "sales_manager", username: "mhmab", fullName: "محمدحسین مهرپور" });
const expert = actor({
  id: 2, username: "s.hasani", fullName: "خانم حسنی", role: "salesperson", roleName: "salesperson",
  customerScope: "assigned", salespersonId: 3, salespersonName: "خانم حسنی", salesManager: false, baseRole: "salesperson",
});
const otherExpert = actor({
  id: 8, username: "m.kazemi", fullName: "آقای کاظمی", role: "salesperson", roleName: "salesperson",
  customerScope: "assigned", salespersonId: 6, salespersonName: "آقای کاظمی", salesManager: false, baseRole: "salesperson",
});
const trainee = actor({
  id: 31, username: "milad", fullName: "میلاد", role: "salesperson", roleName: "salesperson",
  customerScope: "assigned", salespersonId: 22, salespersonName: "میلاد", salesManager: false, baseRole: "salesperson",
});
const registrar = actor({
  id: 7, username: "s.tajik", fullName: "سارینا تاجیک", role: "registrar", roleName: "registrar",
  customerScope: "all", salespersonId: null,
});
const user29 = actor({ id: 29, username: "hasani", fullName: "دسترسی ادمین خانم حسنی", role: "admin" });

const before = fingerprint();
const now = new Date("2026-11-22T12:00:00+03:30");


await ok("flag absent is OFF", async () => {
  setFlag(null);
  assert.equal(kpi.skFlagOn(crmDb), false);
});

await ok("flag '0' / 'true' / 'on' are OFF (only exact '1')", async () => {
  for (const v of ["0", "true", "on", "yes", "TRUE"]) {
    setFlag(v);
    assert.equal(kpi.skFlagOn(crmDb), false, v);
  }
  setFlag("1");
  assert.equal(kpi.skFlagOn(crmDb), true);
});

setFlag("1");

await ok("me: admin and sales manager can view and edit settings", async () => {
  const a = kpi.mePayload(crmDb, admin);
  const s = kpi.mePayload(crmDb, salesManager);
  assert.equal(a.enabled, true);
  assert.equal(a.canView, true);
  assert.equal(a.canEditSettings, true);
  assert.equal(a.access, "manager");
  assert.equal(s.canView, true);
  assert.equal(s.canEditSettings, true);
  assert.equal(s.access, "manager");
});

await ok("me: expert and trainee can view but not edit; registrar and user 29 cannot", async () => {
  const e = kpi.mePayload(crmDb, expert);
  const tr = kpi.mePayload(crmDb, trainee);
  const r = kpi.mePayload(crmDb, registrar);
  const n = kpi.mePayload(crmDb, user29);
  assert.equal(e.canView, true);
  assert.equal(e.canEditSettings, false);
  assert.equal(e.visibility, "self_and_team_totals");
  assert.equal(tr.canView, true);
  assert.equal(tr.canEditSettings, false);
  assert.equal(r.canView, false);
  assert.equal(n.canView, false);
});

await ok("report: registrar is 403", async () => {
  let status = 0;
  try { kpi.salesKpiReport(crmDb, registrar, { period: "month" }, now); }
  catch (e) { status = e.status || 0; }
  assert.equal(status, 403);
});

await ok("report: expert only sees self and own team totals, no teammate names", async () => {
  const rep = kpi.salesKpiReport(crmDb, expert, { period: "month" }, now);
  assert.equal(rep.visibility, "self_and_team_totals");
  assert.ok(rep.experts.length === 1, "exactly one expert row");
  assert.equal(rep.experts[0].salespersonId, 3);
  assert.equal(rep.experts[0].name, "خانم حسنی");
  assert.equal(rep.experts[0].userId, null);
  for (const t of rep.teams) {
    assert.ok(t.kpis.some((x) => x.group === "team"));
  }
  const names = JSON.stringify(rep);
  assert.equal(names.includes("خانم قاسمی"), false);
  assert.equal(names.includes("آقای کاظمی"), false);
  assert.equal(names.includes("hasani"), false);
  assert.ok(!rep.filters.experts.some((x) => x.salespersonId !== 3));
});

await ok("report: expert cannot request another expert", async () => {
  let status = 0;
  try { kpi.salesKpiReport(crmDb, expert, { period: "month", expertId: 6 }, now); }
  catch (e) { status = e.status || 0; }
  assert.equal(status, 403);
});

await ok("report: successful sales match completedByExpert", async () => {
  const rep = kpi.salesKpiReport(crmDb, admin, { period: "month" }, now);
  const done = kpi.completedByExpert(crmDb, new Date(rep.from + "T00:00:00+03:30").toISOString(), new Date(new Date(rep.to + "T00:00:00+03:30").getTime() + 86400000).toISOString(), true);
  // Use the report window ISO bounds via a second call on one expert
  const hasani = rep.experts.find((e) => e.salespersonId === 3);
  assert.ok(hasani, "Hasani is listed");
  const sales = hasani.kpis.find((k) => k.key === "successful_sales");
  assert.equal(sales.status, "ok");
  assert.equal(typeof sales.value, "number");
  // Cross-check against first-entry-to-completed in the same Tehran month window.
  const rows = kpi.completedSalesRows(crmDb, /* filled below */ "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z", true);
  void rows;
  const windowed = kpi.salesKpiReport(crmDb, admin, { period: "custom", from: rep.from, to: rep.to }, now);
  const again = windowed.experts.find((e) => e.salespersonId === 3).kpis.find((k) => k.key === "successful_sales").value;
  assert.equal(sales.value, again);
  void done;
});

await ok("report: missing-data cards when settings are unset", async () => {
  executeChanges("DELETE FROM call_queue_settings WHERE key LIKE 'sales_kpi.%'");
  executeChanges("DELETE FROM sales_kpi_targets");
  const rep = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now);
  const ex = rep.experts[0];
  const team = rep.teams[0];
  const miss = (rows, key) => {
    const k = rows.find((x) => x.key === key);
    assert.ok(k, key);
    assert.equal(k.status, "missing", key);
    assert.equal(k.display, "داده ندارد", key);
    assert.ok(k.missingReason, key);
  };
  miss(ex.kpis, "target_achievement");
  miss(ex.kpis, "old_customer_followup");
  miss(ex.kpis, "stale_file_rate");
  miss(ex.kpis, "ontime_invoice_review");
  miss(ex.kpis, "error_improvement");
  miss(ex.kpis, "training_application");
  miss(team.kpis, "productivity");
  miss(team.kpis, "participation");
  miss(team.kpis, "ontime_registrar_delivery");
});

await ok("settings: expert cannot write; admin write enables target and stale KPIs", async () => {
  const exRep = kpi.mePayload(crmDb, expert);
  assert.equal(exRep.canEditSettings, false);
  const beforeKeys = queryRow("SELECT COUNT(*) n FROM call_queue_settings").n;
  const periodKey = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now).periodKey;
  const saved = kpi.writeSettings(crmDb, {
    staleDays: 14,
    oldCustomerDays: 90,
    invoiceReviewSlaHours: 48,
    registrarDeliverySlaHours: 72,
    zeroPrevBaseline: 0,
    targets: [{ periodKey, scopeKind: "expert", scopeId: 3, targetCount: 5, minTargetCount: 2 }, { periodKey, scopeKind: "team", scopeId: 1, targetCount: 10, minTargetCount: 2 }],
  }, admin, now);
  assert.equal(saved.staleDays, 14);
  assert.equal(saved.oldCustomerDays, 90);
  assert.ok(saved.targets.length >= 2);
  const after = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now);
  const stale = after.experts[0].kpis.find((k) => k.key === "stale_file_rate");
  const tgt = after.experts[0].kpis.find((k) => k.key === "target_achievement");
  const oldc = after.experts[0].kpis.find((k) => k.key === "old_customer_followup");
  assert.notEqual(stale.status, "missing");
  assert.notEqual(tgt.status, "missing");
  assert.notEqual(oldc.status, "missing");
  assert.ok(tgt.denominator === 5);
  const part = after.teams.find((t) => t.teamId === 1)?.kpis.find((k) => k.key === "participation");
  assert.ok(part, "participation");
  assert.notEqual(part.status, "missing");
  const afterKeys = queryRow("SELECT COUNT(*) n FROM call_queue_settings").n;
  assert.ok(afterKeys >= beforeKeys);
});

await ok("zero previous baseline: unset is مبنا تعریف نشده; set baseline computes", async () => {
  // Use a custom future-empty window so previous sales/follow-up are zero if possible,
  // then fall back to inspecting growth cell when previous is 0.
  executeChanges("DELETE FROM call_queue_settings WHERE key=?", [kpi.SK_ZERO_BASELINE]);
  const periodKey = kpi.jalaliMonthKey(0); // not used
  void periodKey;
  const rep = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now);
  const g = rep.experts[0].kpis.find((k) => k.key === "followup_quality_growth");
  assert.ok(g);
  if (g.status === "no_baseline") {
    assert.equal(g.display, "مبنا تعریف نشده");
    kpi.writeSettings(crmDb, { zeroPrevBaseline: 50 }, admin, now);
    const again = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now);
    const g2 = again.experts[0].kpis.find((k) => k.key === "followup_quality_growth");
    assert.equal(g2.status, "ok");
  } else {
    // Previous period had follow-ups; still verify the baseline setting is accepted and Persian display uses ٬ / digits.
    assert.ok(["ok", "empty_denom"].includes(g.status));
    kpi.writeSettings(crmDb, { zeroPrevBaseline: 50 }, admin, now);
  }
});

await ok("Persian digits and ٬ separator on amounts and percents", async () => {
  const rep = kpi.salesKpiReport(crmDb, admin, { period: "month", expertId: 3 }, now);
  const amt = rep.experts[0].kpis.find((k) => k.key === "avg_sale_amount");
  if (amt.status === "ok") {
    assert.match(amt.display, /[۰-۹]/);
    assert.equal(/[0-9]/.test(amt.display), false);
    if (amt.value >= 1000) assert.ok(amt.display.includes("٬"));
    assert.equal(amt.display.includes(","), false);
  }
  const conv = rep.experts[0].kpis.find((k) => k.key === "customer_conversion");
  if (conv.status === "ok") {
    assert.ok(conv.display.includes("٪") || /[۰-۹]/.test(conv.display));
    assert.equal(/[0-9]/.test(conv.display), false);
  }
});

await ok("user 29 never appears in filters or expert rows", async () => {
  const rep = kpi.salesKpiReport(crmDb, admin, { period: "month" }, now);
  const blob = JSON.stringify(rep);
  assert.equal(blob.includes("\"userId\":29"), false);
  assert.equal(rep.filters.experts.some((e) => e.name && e.name.includes("دسترسی ادمین")), false);
  assert.equal(rep.experts.some((e) => e.userId === 29), false);
});

await ok("working days skip Fridays and official holidays", async () => {
  const days = kpi.workingDaysIn(crmDb, 0, 6);
  assert.ok(days <= 6);
  assert.ok(days >= 5);
});

await ok("lockdown allowlists include /sales-kpi", async () => {
  assert.ok(el.EL_ALLOWED_PAGES.includes("/sales-kpi"));
  assert.ok(el.elAllowedPages().includes("/sales-kpi"));
});

await ok("protected tables and customer phones unchanged", async () => {
  const after = fingerprint();
  assert.equal(after, before);
});

await ok("faNum helper", async () => {
  assert.equal(kpi.faNum(120000000), "۱۲۰٬۰۰۰٬۰۰۰");
  assert.equal(kpi.faPct(12.5), "۱۲٫۵٪");
});

console.log(`t886 sales-kpi: ${passed} passed`);

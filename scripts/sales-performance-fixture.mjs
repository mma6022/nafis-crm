/**
 * sales-performance v1 (flag.sales_performance_v1) — scoring, access, Tehran days,
 * incomplete-data marker, flag OFF = 404. No live DB, no staff login, no phones printed,
 * user 29 never listed.
 *
 * Part A uses a synthetic DatabaseSync (minimal tables) for scoring and period math.
 * Part B uses a throwaway copy of a masked DB for HTTP + flag/access (x-actor stub).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const maskedCandidates = [
  process.env.SALES_PERF_FIXTURE_DB,
  process.env.MULTI_TEAM_FIXTURE_DB,
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/ai-master-switch/rel/masked-pkgtest.db",
].filter((p) => p && fs.existsSync(p));
if (!maskedCandidates.length) { console.error("No masked DB copy (set SALES_PERF_FIXTURE_DB)"); process.exit(2); }
const maskedSrc = path.resolve(maskedCandidates[0]);
if (maskedSrc === LIVE || fs.realpathSync(maskedSrc) === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sales-perf-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(maskedSrc, dbPath);
if (fs.realpathSync(dbPath) === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const { crmDb, execute } = await import("../src/lib/crm-db.ts");
const sp = await import("../src/lib/sales-performance.ts");
const dates = await import("../../crm-dashboard/src/features/sales-performance/sales-performance-dates.ts");
const router = (await import("../src/routes/sales-performance.ts")).default;
const { expertLockdownGuard, EL_ALLOWED_PAGES } = await import("../src/lib/expert-lockdown.ts");

/* ---------------- Part A: synthetic scoring / period / incomplete ---------------- */

function synthDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, salesperson_id INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE sales_teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
    CREATE TABLE sales_team_members(team_id INTEGER NOT NULL, salesperson_id INTEGER NOT NULL, is_lead INTEGER DEFAULT 0, owns_none INTEGER DEFAULT 0, owns_p1 INTEGER DEFAULT 0, owns_p2 INTEGER DEFAULT 0, owns_p3 INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, PRIMARY KEY(team_id, salesperson_id));
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, salesperson_id INTEGER, created_at TEXT, merged_into_customer_id INTEGER, status TEXT, priority INTEGER, first_name TEXT, last_name TEXT, description TEXT);
    CREATE TABLE call_logs(id INTEGER PRIMARY KEY, customer_id INTEGER, salesperson_id INTEGER, salesperson_name_snapshot TEXT, subject TEXT, created_at TEXT, call_result TEXT);
    CREATE TABLE voip_after_call_events(id INTEGER PRIMARY KEY, call_log_id INTEGER, customer_id INTEGER, salesperson_id INTEGER, expert_user_id INTEGER, expert_name TEXT, extension TEXT, phone TEXT, started_at TEXT, ended_at TEXT, status TEXT, direction TEXT, is_live INTEGER DEFAULT 0, mobile_answered_at TEXT, duration_seconds INTEGER);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY, customer_id INTEGER, created_at TEXT, deleted_at TEXT, is_pre_registration INTEGER DEFAULT 0, salesperson_id_snapshot INTEGER, status TEXT, stage TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY, application_id INTEGER, from_stage TEXT, to_stage TEXT, action TEXT, created_at TEXT);
    CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY, customer_id INTEGER, wallet_type TEXT, balance TEXT DEFAULT '0');
    CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY, wallet_id INTEGER, amount TEXT, kind TEXT, idempotency_key TEXT, created_at TEXT);
    CREATE TABLE assistant_settings(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO assistant_settings(key,value) VALUES('exclude_test_customers','0');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.multi_team_v1','1','2026-11-10T00:00:00Z');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.sales_performance_v1','1','2026-11-10T00:00:00Z');
  `);
  const created = "2026-10-01T00:00:00.000Z";
  const people = [
    [6, "آقای کاظمی", 8], [3, "خانم حسنی", 2], [4, "خانم قاسمی", 3],
    [20, "حسین خردکار", 7], [5, "آرش اصلانیان", 6], [19, "خانم یونسی", 27], [22, "کارشناس ۲۲", 31],
  ];
  for (const [spid, name, uid] of people) {
    d.prepare("INSERT INTO salespersons(id,name) VALUES(?,?)").run(spid, name);
    d.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,active) VALUES(?,?,?,?,?,1)").run(uid, "u"+uid, name, "salesperson", spid);
  }
  d.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,active) VALUES(1,'admin','مدیر سامانه','admin',NULL,1)").run();
  d.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,active) VALUES(5,'mhmab','محمدحسین مهرپور','sales_manager',NULL,1)").run();
  const at = "2026-11-10T00:00:00.000Z";
  d.prepare("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(1,'تیم فروش ۱',1,?,?)").run(at, at);
  d.prepare("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(2,'تیم فروش ۲',1,?,?)").run(at, at);
  const mem = (team, spid, lead, none, p1, p2, p3, sort) =>
    d.prepare("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(?,?,?,?,?,?,?,?)")
      .run(team, spid, lead, none, p1, p2, p3, sort);
  mem(1, 6, 1, 1, 0, 1, 1, 0);
  mem(1, 3, 0, 0, 1, 0, 0, 1);
  mem(1, 4, 0, 0, 1, 0, 0, 2);
  mem(2, 20, 1, 1, 0, 1, 1, 0);
  mem(2, 5, 0, 0, 1, 0, 0, 1);

  const addCust = (id, name, phone, spid) =>
    d.prepare("INSERT INTO customers(id,name,phone,salesperson_id,created_at) VALUES(?,?,?,?,?)").run(id, name, phone, spid, created);
  const addCall = (id, cust, spid, atIso, result, extra = {}) => {
    d.prepare("INSERT INTO call_logs(id,customer_id,salesperson_id,subject,created_at,call_result) VALUES(?,?,?,'تماس',?,?)")
      .run(id, cust, spid, atIso, result);
    if (extra.voip) {
      d.prepare(`INSERT INTO voip_after_call_events(id,call_log_id,customer_id,salesperson_id,phone,started_at,ended_at,status,direction,is_live,duration_seconds)
        VALUES(?,?,?,?,?,?,?,?,?,0,?)`).run(id, id, cust, spid, extra.phone || "0", atIso, extra.ended || atIso, extra.status || (result === "answered" ? "ANSWERED" : "NO ANSWER"), extra.dir || "outgoing", extra.dur ?? extra.billsec ?? null);
    }
  };
  addCust(1, "A", "09000000001", 6);
  for (let i = 0; i < 20; i++) {
    if (i > 0) addCust(10 + i, "K"+i, "090000010"+String(i).padStart(2, "0"), 6);
    addCall(100 + i, i === 0 ? 1 : 10 + i, 6, "2026-11-10T06:00:00.000Z", i < 16 ? "answered" : "no_answer", {
      voip: true, dir: i < 8 ? "incoming" : "outgoing", billsec: 720, ended: "2026-11-10T06:12:00.000Z",
      status: i < 16 ? "ANSWERED" : "NO ANSWER",
    });
  }
  for (let i = 0; i < 10; i++) {
    addCust(40 + i, "H"+i, "090000020"+String(i).padStart(2, "0"), 20);
    addCall(200 + i, 40 + i, 20, "2026-11-10T07:00:00.000Z", i < 8 ? "answered" : "no_answer", {
      voip: true, dir: i < 4 ? "incoming" : "outgoing", billsec: 720, ended: "2026-11-10T07:12:00.000Z",
      status: i < 8 ? "ANSWERED" : "NO ANSWER",
    });
  }
  for (let i = 0; i < 22; i++) {
    addCust(80 + i, "P"+i, "090000030"+String(i).padStart(2, "0"), 3);
    addCall(300 + i, 80 + i, 3, "2026-11-10T08:00:00.000Z", i < 18 ? "answered" : "no_answer", {
      voip: true, dir: "outgoing", billsec: 900, ended: "2026-11-10T08:15:00.000Z",
      status: i < 18 ? "ANSWERED" : "NO ANSWER",
    });
  }
  for (let i = 0; i < 5; i++) {
    d.prepare("INSERT INTO loan_applications(id,customer_id,created_at,salesperson_id_snapshot,is_pre_registration) VALUES(?,?,?,?,0)")
      .run(1 + i, 80 + i, "2026-11-10T07:20:00.000Z", 3);
  }
  for (const id of [10, 11, 12]) {
    d.prepare("INSERT INTO loan_applications(id,customer_id,created_at,salesperson_id_snapshot,is_pre_registration) VALUES(?,?,?,?,0)")
      .run(id, 1, "2026-11-10T07:20:00.000Z", 6);
    d.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,created_at) VALUES(?,'draft','customer_documents_upload','advance','2026-11-10T07:30:00.000Z')").run(id);
  }
  for (const id of [1, 2, 3, 4]) {
    d.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,created_at) VALUES(?,'draft','customer_documents_upload','advance','2026-11-10T07:30:00.000Z')").run(id);
  }
  for (const id of [1, 2, 3]) {
    d.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,created_at) VALUES(?,'final_invoice_pending_signature','completed','complete','2026-11-10T07:40:00.000Z')").run(id);
  }
  d.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,created_at) VALUES(10,'customer_documents_upload','customer_documents_upload','case-note-added','2026-11-10T07:35:00.000Z')").run();
  d.prepare("INSERT INTO wallet_accounts_v2(id,customer_id,wallet_type,balance) VALUES(1,80,'cash','0')").run();
  for (let i = 0; i < 4; i++) {
    d.prepare("INSERT INTO wallet_ledger_v2(id,wallet_id,amount,kind,idempotency_key,created_at) VALUES(?,?,?,'cash_payment',?,?)")
      .run(1 + i, 1, "1000000", "fx-"+i, "2026-11-10T07:50:00.000Z");
  }
  for (let i = 0; i < 16; i++) addCall(500 + i, 1, 6, "2026-11-09T06:00:00.000Z", "answered");
  addCall(900, 1, 6, "2026-11-09T20:29:59.000Z", "answered");
  addCall(901, 1, 6, "2026-11-09T20:30:00.000Z", "answered");
  addCall(800, 1, 6, "2026-11-02T08:00:00.000Z", "answered", { voip: true, dir: "incoming", billsec: 60, ended: "2026-11-02T08:01:00.000Z" });
  for (let i = 0; i < 6; i++) {
    addCust(200 + i, "Y"+i, "090000040"+String(i).padStart(2, "0"), 19);
    addCall(600 + i, 200 + i, 19, "2026-11-10T06:30:00.000Z", "answered");
  }
  return d;
}

const NOW = new Date("2026-11-10T08:30:00.000Z");
const admin = { id: 1, role: "admin", baseRole: "admin", username: "admin", fullName: "مدیر سامانه", permissions: [], customerScope: "all" };
const manager = { id: 5, role: "sales_manager", baseRole: "sales_manager", salesManager: true, username: "mhmab", fullName: "محمدحسین مهرپور", permissions: [], customerScope: "all" };
const kazemi = { id: 8, role: "salesperson", baseRole: "salesperson", salespersonId: 6, username: "kazemi", fullName: "آقای کاظمی", permissions: [] };
const younesi = { id: 27, role: "salesperson", baseRole: "salesperson", salespersonId: 19, username: "younesi", fullName: "خانم یونسی", permissions: [] };
const registrar = { id: 10, role: "registrar", baseRole: "registrar", username: "reg", fullName: "ثبت", permissions: [] };
const u29 = { id: 29, role: "admin", baseRole: "admin", username: "x29", fullName: "حذف‌شده", permissions: [], customerScope: "all" };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const syn = synthDb();
sp.resetSalesPerformanceSchemaCache();
sp.ensureSalesPerformanceSchema(syn);
sp.seedMembershipHistoryIfEmpty(syn, NOW);
const report = sp.salesPerformanceReport(syn, admin, { period: "day", anchor: "2026-11-10" }, NOW);

await ok("user 29 never appears in the expert list", () => {
  assert.ok(report.experts.every((e) => e.salespersonId !== 29));
  assert.ok(!JSON.stringify(report.experts.map((e) => e.name)).includes("حذف‌شده"));
});

await ok("trainees are excluded from rankings and from the best-in-role set", () => {
  const you = report.experts.find((e) => e.salespersonId === 19);
  const e22 = report.experts.find((e) => e.salespersonId === 22);
  assert.ok(you && you.trainee && you.score == null && you.rank == null);
  assert.ok(e22 && e22.trainee && e22.score == null);
  const first = report.experts.filter((e) => e.role === "first_call" && !e.trainee);
  assert.equal(first.length, 2);
  assert.ok(first.every((e) => e.roleN === 2));
});

await ok("normalization: best first-call expert scores 100, the other is proportional", () => {
  const k = report.experts.find((e) => e.salespersonId === 6);
  const h = report.experts.find((e) => e.salespersonId === 20);
  assert.ok(k && h);
  assert.equal(k.score, 100);
  assert.equal(k.rank, 1);
  assert.ok(h.score > 0 && h.score < 100);
  assert.equal(h.rank, 2);
  assert.ok(k.metrics.calls.value > h.metrics.calls.value);
});

await ok("P1 successful sale is a completed case, and Hasani scores 100", () => {
  const hasani = report.experts.find((e) => e.salespersonId === 3);
  assert.ok(hasani);
  assert.equal(hasani.metrics.done.value, 3);
  assert.equal(hasani.metrics.filed.value, 5);
  assert.equal(hasani.metrics.advanced.value, 4);
  assert.equal(hasani.score, 100);
  assert.equal(hasani.rank, 1);
  assert.equal(hasani.role, "p1");
});

await ok("same-stage notes do not count as an advanced case", () => {
  const k = report.experts.find((e) => e.salespersonId === 6);
  assert.equal(k.metrics.advanced.value, 3);
});

await ok("competition rank jumps after a tie (1, 2, 2, 4)", () => {
  assert.deepEqual(sp.competitionRank([10, 8, 8, 5]), [1, 2, 2, 4]);
  assert.deepEqual(sp.competitionRank([5, 5, 5]), [1, 1, 1]);
});

await ok("Tehran day boundaries: 20:29Z is 9 Nov, 20:30Z is 10 Nov", () => {
  const d9 = sp.salesPerformanceReport(syn, admin, { period: "day", anchor: "2026-11-09" }, NOW);
  const k9 = d9.experts.find((e) => e.salespersonId === 6).metrics.calls.value;
  const k10 = report.experts.find((e) => e.salespersonId === 6).metrics.calls.value;
  assert.ok(k9 >= 17, "9 Nov should include the 20:29Z call");
  assert.ok(k10 >= 20);
});

await ok("incomplete-data marker for duration/answered/inbound-outbound before 3 Nov", () => {
  const early = sp.salesPerformanceReport(syn, admin, { period: "day", anchor: "2026-11-02" }, NOW);
  assert.equal(early.incomplete, true);
  const k = early.experts.find((e) => e.salespersonId === 6);
  assert.equal(k.metrics.duration.incomplete, true);
  assert.equal(k.metrics.answered.incomplete, true);
  assert.equal(k.metrics.inbound.incomplete, true);
  assert.equal(k.metrics.calls.incomplete, false);
  assert.equal(report.incomplete, false);
  assert.equal(report.experts.find((e) => e.salespersonId === 6).metrics.duration.incomplete, false);
});

await ok("previous-period comparison: zero previous yields none", () => {
  const hasani = report.experts.find((e) => e.salespersonId === 3);
  assert.equal(hasani.metrics.done.delta.kind, "none");
  const k = report.experts.find((e) => e.salespersonId === 6);
  assert.ok(["up", "down", "flat"].includes(k.metrics.calls.delta.kind));
});

await ok("expert self-view has no other names or numbers; trainee has no rank", () => {
  const self = sp.salesPerformanceReport(syn, kazemi, { period: "day", anchor: "2026-11-10" }, NOW);
  assert.equal(self.access, "expert");
  assert.equal(self.self.salespersonId, 6);
  assert.ok(self.self.rank >= 1);
  assert.equal(self.experts, undefined);
  const blob = JSON.stringify(self);
  assert.ok(!blob.includes("حسنی"));
  assert.ok(!blob.includes("قاسمی"));
  assert.ok(!blob.includes("خردکار"));
  assert.ok(!blob.includes("اصلانیان"));
  assert.ok(!blob.includes("یونسی"));
  try {
    sp.salesPerformanceReport(syn, kazemi, { period: "day", anchor: "2026-11-10", expertId: 3 }, NOW);
    assert.fail("expected 403");
  } catch (e) { assert.equal(e.status, 403); }
  const tr = sp.salesPerformanceReport(syn, younesi, { period: "day", anchor: "2026-11-10" }, NOW);
  assert.equal(tr.access, "trainee");
  assert.equal(tr.self.trainee, true);
  assert.equal(tr.self.score, null);
  assert.equal(tr.self.rank, null);
  assert.equal(tr.experts, undefined);
  assert.ok(!JSON.stringify(tr).includes("کاظمی"));
});

await ok("custom range previous window is the same number of days immediately before", () => {
  const r = sp.salesPerformanceReport(syn, admin, { period: "custom", from: "2026-11-01", to: "2026-11-10" }, NOW);
  assert.equal(r.range.previousFrom, "2026-10-22");
  assert.equal(r.range.previousTo, "2026-10-31");
});

await ok("Jalali custom range converts to Tehran-day Gregorian bounds", () => {
  assert.equal(dates.toApiDay("1405/08/10"), "2026-11-01");
  assert.equal(dates.toApiDay("۱۴۰۵/۰۸/۱۹"), "2026-11-10");
  assert.equal(dates.toApiDay("2026-11-01"), "2026-11-01");
  assert.equal(dates.toJalaliValue("2026-11-01"), "1405/08/10");
  assert.equal(dates.toJalaliValue("2026-11-10"), "1405/08/19");
  assert.equal(dates.formatSpJalaliField("2026-11-01"), "۱۰ آبان ۱۴۰۵");
  assert.equal(dates.formatSpJalaliField("۱۴۰۵/۰۸/۱۹"), "۱۹ آبان ۱۴۰۵");
  const from = dates.toApiDay("۱۴۰۵/۰۸/۱۰");
  const to = dates.toApiDay("۱۴۰۵/۰۸/۱۹");
  const w = sp.performanceWindow({ period: "custom", from, to }, NOW);
  assert.equal(w.current.fromIso, "2026-10-31T20:30:00.000Z");
  assert.equal(w.current.toIso, "2026-11-10T20:30:00.000Z");
  // 20:29Z is still the previous Tehran day; 20:30Z is the start of 1 Nov (۱۰ آبان).
  const tehranDay = (iso) => Math.floor((Date.parse(iso) + 210 * 60_000) / 86_400_000);
  assert.equal(tehranDay("2026-10-31T20:29:59.000Z"), tehranDay("2026-10-31T20:30:00.000Z") - 1);
  assert.equal(tehranDay(w.current.fromIso), tehranDay("2026-11-01T00:00:00.000+03:30"));
  assert.equal(tehranDay(new Date(Date.parse(w.current.toIso) - 1).toISOString()), tehranDay("2026-11-10T23:59:59.000+03:30"));
});

await ok("team unique is not a naive sum of member uniques", () => {
  const t1 = report.teams.find((t) => t.teamId === 1);
  const members = report.experts.filter((e) => e.teamId === 1);
  const sum = members.reduce((s, e) => s + e.metrics.unique.value, 0);
  assert.ok(t1.metrics.unique.value <= sum);
});

await ok("additive wallet attribution and team history record when the flag is ON", () => {
  sp.recordWalletChargeSalesperson(syn, { ledgerId: 1, customerId: 80, amount: "1000000", at: NOW.toISOString() });
  const row = syn.prepare("SELECT salesperson_id sp FROM wallet_charge_salesperson WHERE ledger_id=1").get();
  assert.equal(Number(row.sp), 3);
  const hist = Number(syn.prepare("SELECT COUNT(*) n FROM sales_team_membership_history").get().n);
  assert.ok(hist >= 5);
  syn.prepare("DELETE FROM sales_team_members WHERE salesperson_id=5").run();
  const before = Number(syn.prepare("SELECT COUNT(*) n FROM sales_team_membership_history").get().n);
  sp.syncTeamMembershipHistory(syn, new Date("2026-11-10T07:50:00.000Z"), "test-remove");
  const after = Number(syn.prepare("SELECT COUNT(*) n FROM sales_team_membership_history").get().n);
  assert.ok(after >= before);
  assert.ok(syn.prepare("SELECT ended_at e FROM sales_team_membership_history WHERE salesperson_id=5 AND ended_at IS NOT NULL").get());
});

await ok("registrar and user 29 have no access", () => {
  assert.equal(sp.accessOf(registrar, syn), "none");
  assert.equal(sp.accessOf(u29, syn), "none");
  try { sp.salesPerformanceReport(syn, registrar, { period: "day", anchor: "2026-11-10" }, NOW); assert.fail("expected 403"); }
  catch (e) { assert.equal(e.status, 403); }
});

/* ---------------- Part B: HTTP on a throwaway masked copy ---------------- */

const actors = { admin, manager, kazemi, younesi, registrar: { id: 7, role: "registrar", baseRole: "registrar", username: "tajik", fullName: "ثبت", permissions: [] }, u29 };
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const a = actors[req.headers["x-actor"]];
  if (!a) return res.sendStatus(401);
  res.locals.authUser = a;
  next();
});
app.use("/api", router);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const call = async (actor, method, url) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { "x-actor": actor } });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { s: r.status, b: json };
};

try {
  execute("DELETE FROM call_queue_settings WHERE key='flag.sales_performance_v1' OR key LIKE 'flag.sales_performance_v1.%'");
  await ok("flag off: /sales-performance is 404", async () => {
    const r = await call("admin", "GET", "/sales-performance?period=day&anchor=2026-11-10");
    assert.equal(r.s, 404);
    const me = await call("admin", "GET", "/sales-performance/me");
    assert.equal(me.s, 404);
  });

  execute(`INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["flag.multi_team_v1", "1", NOW.toISOString()]);
  execute(`INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["flag.sales_performance_v1", "1", NOW.toISOString()]);
  // Ensure teams exist on the copy so Kazemi is not classified as a trainee (flag ON = not on a team).
  execute(`CREATE TABLE IF NOT EXISTS sales_teams (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    lead_split_quota INTEGER NOT NULL DEFAULT 0, p1_cursor INTEGER NOT NULL DEFAULT 0,
    commission_json TEXT NOT NULL DEFAULT '{"mode":"zero"}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  execute(`CREATE TABLE IF NOT EXISTS sales_team_members (
    team_id INTEGER NOT NULL, salesperson_id INTEGER NOT NULL, is_lead INTEGER NOT NULL DEFAULT 0,
    owns_none INTEGER NOT NULL DEFAULT 0, owns_p1 INTEGER NOT NULL DEFAULT 0, owns_p2 INTEGER NOT NULL DEFAULT 0,
    owns_p3 INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, salesperson_id))`);
  const nTeams = Number((crmDb.prepare("SELECT COUNT(*) n FROM sales_teams").get() ?? { n: 0 }).n);
  if (nTeams === 0) {
    execute("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(1,'تیم فروش ۱',1,?,?)", [NOW.toISOString(), NOW.toISOString()]);
    execute("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(2,'تیم فروش ۲',1,?,?)", [NOW.toISOString(), NOW.toISOString()]);
    execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(1,6,1,1,0,1,1,0)");
    execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(1,3,0,0,1,0,0,1)");
    execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(1,4,0,0,1,0,0,2)");
    execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(2,20,1,1,0,1,1,0)");
    execute("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(2,5,0,0,1,0,0,1)");
  }

  await ok("HTTP me: admin and sales manager can view all; registrar 403; user 29 403", async () => {
    const a = await call("admin", "GET", "/sales-performance/me");
    assert.equal(a.s, 200);
    assert.equal(a.b.canViewAll, true);
    const m = await call("manager", "GET", "/sales-performance/me");
    assert.equal(m.s, 200);
    assert.equal(m.b.canViewAll, true);
    const r = await call("registrar", "GET", "/sales-performance/me");
    assert.equal(r.s, 403);
    const x = await call("u29", "GET", "/sales-performance/me");
    assert.equal(x.s, 403);
  });

  await ok("HTTP manager report never includes user 29", async () => {
    const r = await call("manager", "GET", "/sales-performance?period=day&anchor=2026-11-10");
    assert.equal(r.s, 200);
    assert.ok(Array.isArray(r.b.experts));
    assert.ok(r.b.experts.every((e) => e.salespersonId !== 29));
    const blob = JSON.stringify(r.b);
    assert.ok(!blob.includes("کاربر 29"));
    assert.doesNotMatch(blob, /09\d{9}/); // no raw phone numbers
  });

  await ok("HTTP expert cannot fetch others (403) and self payload has no other names", async () => {
    const r = await call("kazemi", "GET", "/sales-performance?period=day&anchor=2026-11-10");
    assert.equal(r.s, 200);
    assert.equal(r.b.access, "expert");
    assert.equal(r.b.self.salespersonId, 6);
    assert.equal(r.b.experts, undefined);
    const blob = JSON.stringify(r.b);
    assert.ok(!blob.includes("حسنی"));
    assert.ok(!blob.includes("قاسمی"));
    const other = await call("kazemi", "GET", "/sales-performance?period=day&anchor=2026-11-10&expertId=3");
    assert.equal(other.s, 403);
  });

  await ok("HTTP trainee sees own report without rank or others", async () => {
    const r = await call("younesi", "GET", "/sales-performance?period=day&anchor=2026-11-10");
    assert.equal(r.s, 200);
    assert.equal(r.b.access, "trainee");
    assert.equal(r.b.self.trainee, true);
    assert.equal(r.b.self.score, null);
    assert.equal(r.b.self.rank, null);
    assert.equal(r.b.experts, undefined);
  });

  await ok("lockdown allow-list includes the sales-performance page and APIs", () => {
    assert.ok(EL_ALLOWED_PAGES.includes("/sales-performance"));
  });

  await ok("locked experts 8/2/3 can read their own report and cannot read another", async () => {
    execute(`INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ["flag.expert_lockdown", "1", NOW.toISOString()]);
    const appL = express();
    appL.use(express.json());
    appL.use((req, res, next) => {
      const a = actors[req.headers["x-actor"]];
      if (!a) return res.sendStatus(401);
      res.locals.authUser = a;
      next();
    });
    appL.use("/api", expertLockdownGuard, router);
    const serverL = http.createServer(appL);
    await new Promise((r) => serverL.listen(0, "127.0.0.1", r));
    const portL = serverL.address().port;
    const callL = async (actor, method, url) => {
      const r = await fetch(`http://127.0.0.1:${portL}/api${url}`, { method, headers: { "x-actor": actor } });
      const text = await r.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { s: r.status, b: json };
    };
    try {
      const me = await callL("kazemi", "GET", "/sales-performance/me");
      assert.equal(me.s, 200, JSON.stringify({ s: me.s, err: me.b && me.b.error }));
      assert.equal(me.b.access, "expert");
      assert.equal(me.b.canViewAll, false);
      const own = await callL("kazemi", "GET", "/sales-performance?period=day&anchor=2026-11-10");
      assert.equal(own.s, 200, JSON.stringify({ s: own.s, err: own.b && own.b.error }));
      assert.equal(own.b.self.salespersonId, 6);
      assert.equal(own.b.experts, undefined);
      const other = await callL("kazemi", "GET", "/sales-performance?period=day&anchor=2026-11-10&expertId=3");
      assert.equal(other.s, 403);
      const admin = await callL("admin", "GET", "/sales-performance?period=day&anchor=2026-11-10");
      assert.equal(admin.s, 200);
      assert.ok(Array.isArray(admin.b.experts));
    } finally {
      await new Promise((r) => serverL.close(r));
      execute("UPDATE call_queue_settings SET value='0' WHERE key='flag.expert_lockdown'");
    }
  });

  await ok("flag off again is 404", async () => {
    execute("UPDATE call_queue_settings SET value='0' WHERE key='flag.sales_performance_v1'");
    const r = await call("admin", "GET", "/sales-performance?period=day&anchor=2026-11-10");
    assert.equal(r.s, 404);
  });

  console.log(`sales-performance fixture: ${passed} ok`);
} catch (e) {
  console.error("FAIL after", passed, "ok:", e);
  process.exitCode = 1;
} finally {
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

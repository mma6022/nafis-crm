import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(path.resolve("artifacts/api-server/package.json"));
const { build } = require("esbuild");
const root = "/tmp/nafisvam-sales-report-fixture";
fs.mkdirSync(root, { recursive: true });
await build({ entryPoints: ["artifacts/api-server/src/lib/sales-report.ts"], bundle: true, platform: "node", format: "esm", outfile: root + "/core.mjs" });
const { buildSalesReport, reportRange, dayNumber } = await import(root + "/core.mjs");
const now = new Date("2026-10-14T12:00:00Z");
assert.equal(reportRange({ period: "week" }, now).from, "2026-10-10");
assert.equal(reportRange({ period: "week" }, now).to, "2026-10-16");
assert.equal(reportRange({ period: "month" }, now).from, "2026-09-23");
assert.equal(reportRange({ period: "month" }, now).to, "2026-10-22");
assert.equal(reportRange({ period: "quarter" }, now).from, "2026-09-23");
assert.equal(reportRange({ period: "quarter" }, now).to, "2026-12-21");
assert.equal(reportRange({ period: "quarter", anchor: "2026-03-21" }, now).to, "2026-06-21");
assert.equal(reportRange({ period: "month", anchor: "2026-03-20" }, now).from, "2026-02-20");
assert.equal(dayNumber("2026-10-13T20:30:00Z"), dayNumber("2026-10-14T00:00:00+03:30"));
assert.equal(dayNumber("2026-10-13 20:30:00"), dayNumber("2026-10-14T00:00:00+03:30"));
for (const input of [{ period: "other" }, { anchor: "2026-02-30" }, { period: "custom", from: "2026-10-15", to: "2026-10-14" }, { period: "custom", from: "2020-01-01", to: "2026-01-01" }, { granularity: "year" }, { period: "custom" }]) assert.throws(() => reportRange(input, now));
const rows = [
  [1, "09100000001", "2026-10-13T20:30:00Z", 1],
  [2, "+989100000001", "2026-10-14T04:00:00Z", 1], // same unique phone
  [3, "۰۹۱۰۰۰۰۰۰۰۲", "2026-10-12T08:00:00Z", 1],
  [4, "09100000003", "2026-10-05T08:00:00Z", 1],
  [5, "09100000004", "2026-09-01T08:00:00Z", 1],
  [6, "09100000005", "2026-07-01T08:00:00Z", 1],
  [7, "09100000006", "2026-10-14T08:00:00Z", 2],
  [8, "09100000007", "2026-10-13T20:29:59Z", 1],
];
const customers = rows.map(([id, phone, created_at, salesperson_id]) => ({ id, phone, created_at, salesperson_id }));
const calls = [
  [1, "ANSWERED"], [1, "NO ANSWER"], [2, "BUSY"], [3, "NO ANSWER"], [3, "BUSY"],
  [4, null], [5, "ANSWERED"], [6, "MISSED"], [7, "ANSWERED"],
].map(([customer_id, status]) => ({ customer_id, status, created_at: "2026-10-14T08:00:00Z" }));
// A known failed call plus an unknown report is NOT proof that this number never answered.
calls.push({ customer_id: 4, status: "MISSED", created_at: "2026-10-14T09:00:00Z" });
calls.push({ customer_id: 8, status: "completed", mobile_answered_at: "2026-10-14T08:30:00Z", created_at: "2026-10-14T08:30:00Z" });
calls.push({ customer_id: 6, status: "ANSWERED", created_at: "2026-10-14T20:30:00Z" }); // next Tehran day
const applications = [
  [101, 1, "100000000", 0], [102, 2, "200000000", 1], [103, 3, "300000000", 0],
  [104, 4, "400000000", 1], [105, 5, "500000000", 0], [106, 7, "600000000", 0],
  [107, 8, "700000000", 0],
].map(([id, customer_id, requested_amount, is_pre_registration]) => ({ id, customer_id, requested_amount, is_pre_registration, created_at: "2026-10-14T08:00:00Z" }));
const own = customers.filter(c => c.salesperson_id === 1);
const report = buildSalesReport(own, calls, applications, { period: "day" }, now);
const cohort = key => report.cohorts.find(c => c.key === key);
assert.equal(report.summary.leads, 6);
assert.equal(cohort("current").leads, 1, "duplicate phone normalized");
assert.equal(cohort("current").requests, 2);
assert.equal(cohort("current").requesters, 1);
assert.equal(cohort("current").requestedAmount, "300000000");
assert.equal(cohort("previous").leads, 5);
assert.equal(cohort("previousDays").leads, 5);
assert.equal(cohort("previousWeek").leads, 1);
assert.equal(cohort("previousMonth").leads, 1);
assert.equal(cohort("older").leads, 1);
assert.equal(report.summary.contacted, 6);
assert.equal(report.summary.answered, 3);
assert.equal(report.summary.unanswered, 2);
assert.equal(report.summary.unknownOutcome, 1);
assert.equal(report.summary.requesters, 5);
assert.equal(report.summary.requests, 6);
assert.equal(report.summary.cases, 4);
assert.equal(report.summary.contactedRequesters, 5);
assert.equal(report.summary.contactedRequestRate, 83.33);
assert.equal(report.summary.noAnswerRate, 33.33);
assert.equal(report.monthly.current.requesters, 4);
assert.equal(report.monthly.previous.requesters, 1);
assert.equal(report.monthly.current.requestShare, 80);
assert.equal(report.monthly.previous.requestShare, 20);
assert.equal(report.trend[0].newRequesters, 1);
assert.equal(report.trend[0].previousRequesters, 4);
const noCalls = buildSalesReport(own, [], applications, { period: "day" }, now);
assert.equal(noCalls.summary.contactedRequesters, 0);
assert.equal(noCalls.summary.requesters, 5, "do not invent a call for a saved application");
assert.equal(noCalls.summary.contactedRequestRate, null);
const empty = buildSalesReport([], [], [], { period: "month" }, now);
assert.equal(empty.trend.length, 30);
assert.equal(empty.summary.noAnswerRate, null);
assert.equal(empty.summary.requestRate, null);
assert.equal(empty.summary.requestedAmount, "0");
const weekly = buildSalesReport(own, calls, applications, { period: "quarter", granularity: "week" }, now);
assert(weekly.trend.length >= 13 && weekly.trend.length <= 14);
assert.equal(weekly.trend[0].date, "2026-09-23", "partial first week clipped to selected range");
console.log("PASS pure report: Tehran boundaries, Jalali weeks/months/quarters/year rollover, invalid dates, unique phones, cohorts, deduped requests, exact amounts, unknown outcomes, percentages, empty trend, monthly shares");

// Compile the real route with isolated infrastructure. No CRM DB is opened.
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE customers(id INTEGER,phone TEXT,created_at TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
 CREATE TABLE call_logs(id INTEGER,customer_id INTEGER,created_at TEXT);
 CREATE TABLE voip_after_call_events(id INTEGER,customer_id INTEGER,call_log_id INTEGER,started_at TEXT,status TEXT,mobile_answered_at TEXT,is_live INTEGER);
 CREATE TABLE loan_applications(id INTEGER,customer_id INTEGER,created_at TEXT,requested_amount TEXT,is_pre_registration INTEGER,deleted_at TEXT);
 CREATE TABLE salespersons(id INTEGER,name TEXT);`);
for (const c of customers) db.prepare("INSERT INTO customers VALUES(?,?,?,?,NULL)").run(c.id, c.phone, c.created_at, c.salesperson_id);
for (const a of applications) db.prepare("INSERT INTO loan_applications VALUES(?,?,?,?,?,NULL)").run(a.id, a.customer_id, a.created_at, a.requested_amount, a.is_pre_registration);
for (let i = 0; i < calls.length; i++) {
  const c = calls[i]; db.prepare("INSERT INTO call_logs VALUES(?,?,?)").run(i + 1, c.customer_id, c.created_at);
  if (c.status) db.prepare("INSERT INTO voip_after_call_events VALUES(?,?,?,?,?,?,0)").run(i + 1, c.customer_id, i + 1, c.created_at, c.status, c.mobile_answered_at ?? null);
}
db.exec("INSERT INTO salespersons VALUES(1,'کارشناس آزمایشی یک'),(2,'کارشناس آزمایشی دو')");
globalThis.salesReportFixtureDb = db;
await build({
  entryPoints: ["artifacts/api-server/src/routes/sales-reports.ts"], bundle: true, platform: "node", format: "esm", outfile: root + "/route.mjs", packages: "external",
  plugins: [{ name: "isolated-report-infra", setup(b) {
    b.onResolve({ filter: /\/(auth|access-control|crm-db)$/ }, args => ({ path: args.path.split("/").pop(), namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "auth"
      ? `export const requireAuth=(req,res,next)=>{if(!res.locals.authUser)return res.status(401).json({error:"Unauthorized"});next()};`
      : args.path === "access-control" ? `export const requirePermission=p=>(req,res,next)=>{const u=res.locals.authUser;if(u.role!=="admin"&&!u.permissions.includes(p))return res.status(403).json({error:"Forbidden"});next()};`
      : `export const queryRows=(sql,args=[])=>globalThis.salesReportFixtureDb.prepare(sql).all(...args);` }));
  }}],
});
// Resolve external express in the temp output explicitly.
if (!fs.existsSync(root + "/node_modules")) fs.symlinkSync(path.resolve("artifacts/api-server/node_modules"), root + "/node_modules", "dir");
const express = require("express"), app = express();
let serving = false;
app.use((req, res, next) => {
  const fixtureCookie = /(?:^|;\s*)sr-fixture-role=([a-z]+)/.exec(req.headers.cookie ?? "")?.[1];
  const role = req.headers["x-fixture-role"] ?? (serving ? fixtureCookie ?? "admin" : undefined);
  if (role) res.locals.authUser = { role, salespersonId: role === "unlinked" ? null : 1, customerScope: role === "admin" || role === "broad" ? "all" : "assigned", permissions: role === "registrar" ? [] : ["reports.view"] };
  next();
});
app.get("/__fixture/session/:role", (req, res) => {
  if (!["admin", "salesperson", "registrar"].includes(req.params.role)) { res.sendStatus(400); return; }
  res.cookie("sr-fixture-role", req.params.role, { httpOnly: true }); res.redirect("/sales-reports");
});
app.get("/api/auth/session", (_req, res) => res.json({ user: {
  ...res.locals.authUser, id: res.locals.authUser?.role === "admin" ? 1 : 2,
  username: "synthetic-report", fullName: "حساب آزمایشی گزارش", roleName: "آزمایشی", active: true,
  salespersonName: "کارشناس آزمایشی", createdAt: "2026-10-01T08:00:00Z",
} }));
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/api/reminders", (_req, res) => res.json([]));
app.get("/api/chat/unread", (_req, res) => res.json({ count: 0 }));
app.get("/api/chat/events", (_req, res) => res.status(204).end());
app.get("/api/site-notifications", (_req, res) => res.json({ items: [], unreadCount: 0, pageCounts: {}, total: 0, scopeVersion: "synthetic" }));
app.use("/api", (await import(root + "/route.mjs")).default);
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/api/sales-reports?period=day&anchor=2026-10-14";
async function request(role, extra = "") {
  const r = await fetch(base + extra, { headers: role ? { "x-fixture-role": role } : {} });
  return { status: r.status, data: await r.json() };
}
try {
  assert.equal((await request()).status, 401);
  assert.equal((await request("registrar")).status, 403);
  // 2026-10-26: the team report is admin-only; every non-admin (expert, unlinked, broad custom role) gets 403 + link to /my-performance.
  for (const role of ["salesperson", "unlinked", "broad"]) {
    const r = await request(role); assert.equal(r.status, 403, role); assert.equal(r.data.link, "/my-performance");
  }
  assert.equal((await request("salesperson", "&salespersonId=1&salespersonId=2")).status, 403);
  assert.equal((await request("admin", "&salespersonId=oops")).status, 400);
  assert.equal((await request("admin", "&anchor=2026-02-30")).status, 400);
  const admin = await request("admin");
  assert.equal(admin.data.summary.leads, 7); assert.equal(admin.data.salespeople.length, 2);
  assert.equal(admin.data.scope.canSelectSalesperson, true);
  const filtered = await request("admin", "&salespersonId=2");
  assert.equal(filtered.data.summary.leads, 1); assert.equal(filtered.data.summary.requests, 1);
  console.log("PASS real route+synthetic SQLite: authentication, permission, admin-only (expert/unlinked/broad 403 + /my-performance), all/specific salesperson, forged/duplicate filter rejected, scoped joins and unique counts");
} finally { server.close(); if (!process.argv.includes("--serve")) db.close(); }
if (process.argv.includes("--serve")) {
  serving = true;
  app.use("/api", (_req, res) => res.status(404).json({ error: "synthetic_route_not_implemented" }));
  const publicDir = path.resolve(process.env.SALES_REPORT_FIXTURE_PUBLIC ?? "artifacts/crm-dashboard/dist/public");
  app.use(express.static(publicDir));
  app.use((_req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.listen(5604, "0.0.0.0", () => console.log("Synthetic sales report preview ready on 5604"));
}

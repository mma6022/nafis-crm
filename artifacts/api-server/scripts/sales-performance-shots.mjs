/**
 * Local shots of «گزارش عملکرد فروش» on a disposable synth dataset.
 * No live DB, no staff login, no phones in the page, user 29 never listed.
 * Bottom nav is the current sales-shell dock (ss-dock / ss-tb), not Armita's older mock dock.
 * Writes SHOTS_OUT or /workspace/sales-perf/shots/.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;

const LIVE = "/var/lib/nafisvam/customers.db";
const OUT = process.env.SHOTS_OUT || "/workspace/sales-perf/shots";
const UI = "/workspace/sales-perf/src/artifacts/crm-dashboard/src/features/sales-performance/sales-performance-ui.ts";
const CSS_SP = "/workspace/sales-perf/src/artifacts/crm-dashboard/src/features/sales-performance/sales-performance.css";
const CSS_SS = "/workspace/sales-perf/src/artifacts/crm-dashboard/src/features/sales-shell/sales-shell.css";
const STANDALONE = "/workspace/nafis-design/screens/sales-performance/index.html";
const PUPPETEER = "/workspace/sales-perf/src/artifacts/crm-dashboard/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const ESBUILD = "/workspace/sales-perf/src/artifacts/api-server/node_modules/esbuild/bin/esbuild";

const ALL_SCENES = "overview range-custom expert ranks score team compare self trainee empty loading error".split(" ");
const sceneFilter = (process.env.SHOTS_SCENES || "").split(",").map((x) => x.trim()).filter(Boolean);
const SCENES = sceneFilter.length ? ALL_SCENES.filter((sc) => sceneFilter.includes(sc)) : ALL_SCENES;
const sceneNo = (sc) => String(ALL_SCENES.indexOf(sc) + 1).padStart(2, "0");

const maskedCandidates = [
  process.env.SALES_PERF_FIXTURE_DB,
  process.env.MULTI_TEAM_FIXTURE_DB,
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/ai-master-switch/rel/masked-pkgtest.db",
].filter((p) => p && fs.existsSync(p));
if (!maskedCandidates.length) { console.error("No masked DB copy"); process.exit(2); }
const maskedSrc = path.resolve(maskedCandidates[0]);
if (maskedSrc === LIVE || fs.realpathSync(maskedSrc) === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sales-perf-shots-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(maskedSrc, dbPath);
if (fs.realpathSync(dbPath) === LIVE) { console.error("Refusing to use the live database."); process.exit(2); }
process.env.CRM_DATABASE_PATH = dbPath;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const sp = await import("../src/lib/sales-performance.ts");

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
const kazemi = { id: 8, role: "salesperson", baseRole: "salesperson", salespersonId: 6, username: "kazemi", fullName: "آقای کاظمی", permissions: [] };
const younesi = { id: 27, role: "salesperson", baseRole: "salesperson", salespersonId: 19, username: "younesi", fullName: "خانم یونسی", permissions: [] };

const syn = synthDb();
sp.resetSalesPerformanceSchemaCache();
sp.ensureSalesPerformanceSchema(syn);
sp.seedMembershipHistoryIfEmpty(syn, NOW);
const day = sp.salesPerformanceReport(syn, admin, { period: "day", anchor: "2026-11-10" }, NOW);
const custom = sp.salesPerformanceReport(syn, admin, { period: "custom", from: "2026-11-01", to: "2026-11-10" }, NOW);
const empty = sp.salesPerformanceReport(syn, admin, { period: "custom", from: "2026-09-01", to: "2026-09-02" }, NOW);
const self = sp.salesPerformanceReport(syn, kazemi, { period: "day", anchor: "2026-11-10" }, NOW);
const trainee = sp.salesPerformanceReport(syn, younesi, { period: "day", anchor: "2026-11-10" }, NOW);

function assertSafe(blob, label) {
  if (/کاربر 29|salespersonId":29/.test(blob)) throw new Error(`user 29 leaked in ${label}`);
  if (/09\d{9}/.test(blob)) throw new Error(`phone leaked in ${label}`);
}
for (const [n, r] of [["day", day], ["custom", custom], ["empty", empty], ["self", self], ["trainee", trainee]]) {
  assertSafe(JSON.stringify(r), n);
}

const meManager = { enabled: true, access: "manager", canView: true, canViewAll: true, self: null };
const meKazemi = { enabled: true, access: "expert", canView: true, canViewAll: false, self: { salespersonId: 6, name: "آقای کاظمی", trainee: false, role: "first_call", roleLabel: "تماس اول", teamName: "تیم فروش ۱" } };
const meYounesi = { enabled: true, access: "trainee", canView: true, canViewAll: false, self: { salespersonId: 19, name: "خانم یونسی", trainee: true, role: null, roleLabel: null, teamName: null } };

const STATES = {
  overview: { view: "overview", me: meManager, report: day, period: "day" },
  "range-custom": { view: "range-custom", me: meManager, report: custom, period: "custom", customFrom: "2026-11-01", customTo: "2026-11-10" },
  expert: { view: "expert", me: meManager, report: day, period: "day", expertId: 6 },
  ranks: { view: "ranks", me: meManager, report: day, period: "day", rankMetric: "calls" },
  score: { view: "score", me: meManager, report: day, period: "day", rankMetric: "score" },
  team: { view: "team", me: meManager, report: day, period: "day" },
  compare: { view: "compare", me: meManager, report: day, period: "day" },
  self: { view: "self", me: meKazemi, report: self, period: "day" },
  trainee: { view: "trainee", me: meYounesi, report: trainee, period: "day" },
  empty: { view: "empty", me: meManager, report: empty, period: "custom", customFrom: "2026-09-01", customTo: "2026-09-02" },
  loading: { view: "loading", me: meManager, report: day, period: "day" },
  error: { view: "error", me: meManager, report: null, period: "day" },
};

const bundle = path.join(dir, "sales-performance-ui.js");
const bundled = spawnSync(ESBUILD, [UI, "--bundle", "--format=iife", `--outfile=${bundle}`, "--global-name=SalesPerformanceUI", "--platform=browser"], { encoding: "utf8" });
if (bundled.status !== 0) { console.error(bundled.stdout, bundled.stderr); process.exit(1); }

const standalone = fs.readFileSync(STANDALONE, "utf8");
const style = standalone.slice(standalone.indexOf("<style>"), standalone.indexOf("</style>") + 8);
const ssCss = fs.readFileSync(CSS_SS, "utf8");
const spCss = fs.readFileSync(CSS_SP, "utf8");
const extra = `<style>
${ssCss}
${spCss}
/* shots: current sales-shell dock; hide the older mock dock from the design stylesheet */
.demo,.dock,.tabbar,.pg-dock,footer.dock,nav.dock{display:none!important}
.app-shell.ssv2{min-height:100vh;background:var(--nf-surface,#F7F8FC)}
.app-shell.ssv2 .app-main{min-width:0}
.ss-i .ss-ic svg,.ss-tb-ic svg,.ss-pc svg{width:22px;height:22px}
</style>`;

const ICO = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3.5"/><path d="M21 21v-2a3.5 3.5 0 0 0-3-3.45M16 3.13a3.5 3.5 0 0 1 0 6.74"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v2.6a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h2.6a2 2 0 0 1 2 1.7c.1.9.3 1.7.6 2.5a2 2 0 0 1-.4 2.1L7.7 9.5a16 16 0 0 0 6.8 6.8l1.2-1.2a2 2 0 0 1 2.1-.4c.8.3 1.6.5 2.5.6a2 2 0 0 1 1.7 2z"/></svg>',
};

function dockHtml() {
  const item = (cls, ic, label, current) =>
    `<a class="${cls}" href="#" ${current ? 'aria-current="page"' : ''}><span class="${cls === "ss-i" ? "ss-ic" : "ss-tb-ic"}">${ic}</span><span class="${cls === "ss-i" ? "ss-lb" : ""}">${label}</span></a>`;
  const desktop = `<nav class="ss-dock" aria-label="ناوبری اصلی" data-testid="ss-dock">
    ${item("ss-i", ICO.today, "امروز")}
    ${item("ss-i", ICO.people, "مشتری‌ها")}
    ${item("ss-i", ICO.files, "پرونده‌ها")}
    <button type="button" class="ss-p" aria-label="تماس"><span class="ss-pc">${ICO.phone}</span> تماس</button>
    <a class="ss-i" href="#" aria-current="page" aria-label="بیشتر"><span class="ss-ic">${ICO.more}</span><span class="ss-lb">بیشتر</span></a>
  </nav>`;
  const mobile = `<nav class="ss-tb" aria-label="ناوبری اصلی" data-testid="ss-tabbar">
    ${item("ss-tb-i", ICO.today, "امروز")}
    ${item("ss-tb-i", ICO.people, "مشتری‌ها")}
    <button type="button" class="ss-tb-p" aria-label="تماس"><span class="ss-pc">${ICO.phone}</span><span class="ss-ps">تماس</span></button>
    ${item("ss-tb-i", ICO.files, "پرونده‌ها")}
    <a class="ss-tb-i" href="#" aria-current="page"><span class="ss-tb-ic">${ICO.more}</span>بیشتر</a>
  </nav>`;
  return desktop + mobile;
}

function pageHtml(sc) {
  const st = STATES[sc];
  return `<!DOCTYPE html><html lang="fa" dir="rtl" class="ssv2-on"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>گزارش عملکرد فروش، نفیس وام</title>
${style}
${extra}
</head><body class="ssv2">
<div class="app-shell ssv2">
  <header class="topbar ss-top">
    <div class="ss-brand">نفیس وام <small>میز کار</small></div>
    <div class="ss-ttl"><h1>گزارش عملکرد فروش</h1><p>سه‌شنبه ۱۹ آبان ۱۴۰۵، ساعت ۱۲:۰۰</p></div>
  </header>
  <main class="app-main" id="sp-root"></main>
  ${dockHtml()}
</div>
<script src="/sales-performance-ui.js"></script>
<script>
const st = ${JSON.stringify(st)};
SalesPerformanceUI.mountSalesPerformance(document.getElementById("sp-root"), st, {});
</script>
</body></html>`;
}

const app = express();
app.get("/sales-performance-ui.js", (_req, res) => res.type("js").send(fs.readFileSync(bundle)));
app.get("/", (req, res) => {
  const sc = SCENES.includes(req.query.sc) ? req.query.sc : "overview";
  const html = pageHtml(sc);
  assertSafe(html, "html "+sc);
  res.type("html").send(html);
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log("shot server", base);

const puppeteer = (await import(pathToFileURL(PUPPETEER).href)).default;
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  headless: "new",
});

fs.mkdirSync(path.join(OUT, "desktop"), { recursive: true });
fs.mkdirSync(path.join(OUT, "mobile"), { recursive: true });

const sizes = [
  { key: "1280", dir: "desktop", w: 1280, h: 900, scale: 1 },
  { key: "1280@2x", dir: "desktop", w: 1280, h: 900, scale: 2, skipFlat: false },
  { key: "390", dir: "mobile", w: 390, h: 844, scale: 1 },
  { key: "390@2x", dir: "mobile", w: 390, h: 844, scale: 2 },
];

const notes = {
  overview: "دید مدیر، همهٔ کارشناسان، بازهٔ امروز (۱۹ آبان ۱۴۰۵)",
  "range-custom": "بازهٔ دلخواه ۱ تا ۱۰ نوامبر ۲۰۲۶ و انتخابگر؛ ممکن است «داده‌ی ناقص» دیده شود چون بازه قبل از ۳ نوامبر را هم در بر می‌گیرد",
  expert: "جزئیات آقای کاظمی از دید مدیر، با شکست وزن",
  ranks: "رتبه‌بندی تعداد تماس؛ کارآموزان جدا",
  score: "امتیاز عملکرد به تفکیک نقش",
  team: "گزارش دو تیم (بدون امتیاز تیمی)",
  compare: "مقایسهٔ تیم فروش ۱ و تیم فروش ۲",
  self: "دید خود آقای کاظمی؛ رتبه بدون نام بقیه",
  trainee: "دید خود خانم یونسی، بدون رتبه و امتیاز",
  empty: "بازهٔ دلخواه بدون داده (۱–۲ سپتامبر ۲۰۲۶)",
  loading: "اسکلت بارگذاری",
  error: "خطا با «تلاش دوباره»",
};

try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  for (const sc of SCENES) {
    for (const sz of sizes) {
      await page.setViewport({ width: sz.w, height: sz.h, deviceScaleFactor: sz.scale });
      await page.goto(`${base}/?sc=${encodeURIComponent(sc)}`, { waitUntil: "networkidle0", timeout: 30000 });
      await page.evaluate(() => { document.documentElement.classList.add("ssv2-on"); });
      const height = await page.evaluate((minH) => {
        const doc = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, minH);
        return doc;
      }, sz.h);
      if (height > sz.h) await page.setViewport({ width: sz.w, height: height, deviceScaleFactor: sz.scale });
      const n = sceneNo(sc);
      const fileA = path.join(OUT, sz.dir, `${n}-${sc}${sz.key.includes("@2x") ? "@2x" : ""}.png`);
      const fileB = path.join(OUT, `${sc}-${sz.key}.png`);
      await page.screenshot({ path: fileA, fullPage: true, type: "png" });
      fs.copyFileSync(fileA, fileB);
      const html = await page.content();
      assertSafe(html, `${sc} ${sz.key}`);
      console.log("shot", sc, sz.key, fileB);
    }
  }

  const index = `# گزارش عملکرد فروش v1.0 — masked/synth shots

Local only. Captured from the \`feat/sales-performance\` worktree against a disposable synthetic dataset (schema from a masked copy; no live staff logins, no live writes). Phones in the fixture are placeholders and never appear in the UI or these files. User 29 is excluded and does not appear.

Flag \`flag.sales_performance_v1\` is ON only in this shot dataset so the UI can be captured. The release package keeps the flag OFF (absent).

Bottom nav is the **current sales-shell dock** (\`ss-dock\` / \`ss-tb\`), not the older dock in Armita's mock shots. \`bottom-nav-v2\` is still later.

Anchor time for the numbers: **سه‌شنبه ۱۹ آبان ۱۴۰۵، ساعت ۱۲:۰۰** (Tehran) / \`2026-11-10T08:30:00.000Z\`.

## Layout

Each of the 12 design scenes has four PNGs:

- \`desktop/0N-<scene>.png\` — 1280×(at least 900), device scale 1
- \`desktop/0N-<scene>@2x.png\` — 1280, device scale 2
- \`mobile/0N-<scene>.png\` — 390×(at least 844), device scale 1
- \`mobile/0N-<scene>@2x.png\` — 390, device scale 2 (official mobile @2x)

Flat aliases at the shots root: \`<scene>-1280.png\`, \`<scene>-1280@2x.png\`, \`<scene>-390.png\`, \`<scene>-390@2x.png\`. Height grows to the document so the fixed dock sits under the content and the 1280 table can show its sticky name column and horizontal scroll.

## Scenes

| # | Scene | Notes |
|---|---|---|
${ALL_SCENES.map((sc, i) => `| ${String(i + 1).padStart(2, "0")} | ${sc} | ${notes[sc]} |`).join("\n")}

## Known differences from the design mock

- Numbers are computed from the synthetic fixture (not the design's «نمونه» figures). There is no «نمونه» label.
- The dock is the current sales-shell, as requested; the mock still shows the older bottom nav.
- «داده‌ی ناقص» appears on the custom-range scene when the window overlaps days before 3 Nov 2026, per the product decision.
- Team history and wallet-charge attribution are recorded only from flag-on (additive). Historical wallet charges in the fixture fall back to the current owner.
- Design references: \`/workspace/nafis-design/screens/sales-performance/\` (index sha256 starts \`969b5132\`).
`;
  fs.writeFileSync(path.join(OUT, "INDEX.md"), index);
  console.log("wrote", path.join(OUT, "INDEX.md"), "scenes", SCENES.length);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

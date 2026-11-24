/**
 * عملکرد من v1.1 (flag.my_performance_v1) — own report, team rank without colleague
 * names, inquiry flag OFF by default, flag OFF = 404. Does not toggle
 * sales_performance_v1 / expert_lockdown / multi_team_v1.
 *
 * Part A: synthetic DatabaseSync.
 * Part B: HTTP on a throwaway file copy of the synth DB (x-actor stub).
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
  "/workspace/t861/masked.db",
  "/workspace/team-model/rel/masked-pkgtest.db",
  "/workspace/ai-master-switch/rel/masked-pkgtest.db",
].filter((p) => p && fs.existsSync(p));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "my-work-fx-"));
const dbPath = path.join(dir, "customers.db");
const maskedPath = path.join(dir, "masked.db");
if (maskedCandidates.length) {
  const src = path.resolve(maskedCandidates[0]);
  if (fs.existsSync(LIVE) && fs.realpathSync(src) === fs.realpathSync(LIVE)) {
    console.error("Refusing to use the live database."); process.exit(2);
  }
  fs.copyFileSync(src, maskedPath);
}

function buildSynth(target = ":memory:") {
  const d = new DatabaseSync(target);
  d.exec(`
    CREATE TABLE call_queue_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT);
    CREATE TABLE call_queue_settings_log(id INTEGER PRIMARY KEY, key TEXT, old_value TEXT, new_value TEXT, user_id INTEGER, at TEXT);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, role TEXT, salesperson_id INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE sales_teams(id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
    CREATE TABLE sales_team_members(team_id INTEGER NOT NULL, salesperson_id INTEGER NOT NULL, is_lead INTEGER DEFAULT 0, owns_none INTEGER DEFAULT 0, owns_p1 INTEGER DEFAULT 0, owns_p2 INTEGER DEFAULT 0, owns_p3 INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, PRIMARY KEY(team_id, salesperson_id));
    CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, phone TEXT, salesperson_id INTEGER, created_at TEXT, merged_into_customer_id INTEGER, status TEXT, priority INTEGER, first_name TEXT, last_name TEXT, description TEXT);
    CREATE TABLE call_logs(id INTEGER PRIMARY KEY, customer_id INTEGER, salesperson_id INTEGER, salesperson_name_snapshot TEXT, subject TEXT, created_at TEXT, call_result TEXT);
    CREATE TABLE voip_after_call_events(id INTEGER PRIMARY KEY, call_log_id INTEGER, customer_id INTEGER, salesperson_id INTEGER, expert_user_id INTEGER, expert_name TEXT, extension TEXT, phone TEXT, started_at TEXT, ended_at TEXT, status TEXT, direction TEXT, is_live INTEGER DEFAULT 0, mobile_answered_at TEXT, duration_seconds INTEGER);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY, customer_id INTEGER, created_at TEXT, deleted_at TEXT, is_pre_registration INTEGER DEFAULT 0, salesperson_id_snapshot INTEGER, status TEXT, stage TEXT);
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY, application_id INTEGER, from_stage TEXT, to_stage TEXT, action TEXT, created_at TEXT);
    CREATE TABLE contract_generations(id INTEGER PRIMARY KEY, customer_id INTEGER, loan_application_id INTEGER, status TEXT, provider_status TEXT, created_at TEXT, updated_at TEXT, sent_at TEXT, deleted_at TEXT, superseded_at TEXT);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY, salesperson_id INTEGER, customer_id INTEGER, remind_at TEXT, done INTEGER, closed_at TEXT, voided_at TEXT, replaced_by INTEGER);
    CREATE TABLE bale_bots(id INTEGER PRIMARY KEY, user_id INTEGER);
    CREATE TABLE bale_bot_chats(id INTEGER PRIMARY KEY, bot_id INTEGER, last_at TEXT);
    CREATE TABLE bale_bot_messages(id INTEGER PRIMARY KEY, chat_row INTEGER, dir TEXT, status TEXT, sent_at TEXT, created_at TEXT, deleted_at TEXT);
    CREATE TABLE assistant_settings(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO assistant_settings(key,value) VALUES('exclude_test_customers','0');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.multi_team_v1','1','2026-11-10T00:00:00Z');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.sales_performance_v1','1','2026-11-10T00:00:00Z');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.expert_lockdown','1','2026-11-10T00:00:00Z');
    INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.my_performance_v1','1','2026-11-10T00:00:00Z');
  `);
  const created = "2026-10-01T00:00:00.000Z";
  const at = "2026-11-10T00:00:00.000Z";
  const people = [
    [6, "آقای کاظمی", 8], [3, "خانم حسنی", 2], [4, "خانم قاسمی", 3],
    [20, "حسین خردکار", 7], [5, "آرش اصلانیان", 6], [19, "خانم یونسی", 27],
  ];
  for (const [spid, name, uid] of people) {
    d.prepare("INSERT INTO salespersons(id,name) VALUES(?,?)").run(spid, name);
    d.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,active) VALUES(?,?,?,?,?,1)").run(uid, "u"+uid, name, "salesperson", spid);
  }
  d.prepare("INSERT INTO users(id,username,full_name,role,salesperson_id,active) VALUES(1,'admin','مدیر سامانه','admin',NULL,1)").run();
  d.prepare("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(1,'تیم فروش ۱',1,?,?)").run(at, at);
  d.prepare("INSERT INTO sales_teams(id,name,enabled,created_at,updated_at) VALUES(2,'تیم فروش ۲',1,?,?)").run(at, at);
  const mem = (team, sp, lead, none, p1, p2, p3, sort) =>
    d.prepare("INSERT INTO sales_team_members(team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order) VALUES(?,?,?,?,?,?,?,?)")
      .run(team, sp, lead, none, p1, p2, p3, sort);
  mem(1, 6, 1, 1, 0, 0, 0, 0);
  mem(1, 3, 0, 0, 1, 0, 0, 1);
  mem(1, 4, 0, 0, 1, 0, 0, 2);
  mem(2, 20, 1, 1, 0, 0, 0, 0);
  mem(2, 5, 0, 0, 1, 0, 0, 1);

  const addCust = (id, name, phone, spid, createdAt = created) =>
    d.prepare("INSERT INTO customers(id,name,phone,salesperson_id,created_at) VALUES(?,?,?,?,?)").run(id, name, phone, spid, createdAt);
  const addCall = (id, cust, spid, atIso, result, extra = {}) => {
    d.prepare("INSERT INTO call_logs(id,customer_id,salesperson_id,subject,created_at,call_result) VALUES(?,?,?,'تماس',?,?)")
      .run(id, cust, spid, atIso, result);
    if (extra.voip !== false) {
      d.prepare(`INSERT INTO voip_after_call_events(id,call_log_id,customer_id,salesperson_id,phone,started_at,ended_at,status,direction,is_live,mobile_answered_at,duration_seconds)
        VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`).run(
        id, id, cust, spid, extra.phone || "09000000000", atIso, extra.ended || atIso,
        extra.status || (result === "answered" ? "ANSWERED" : result === "busy" ? "BUSY" : "NO ANSWER"),
        extra.dir || "outgoing",
        result === "answered" ? atIso : null,
        extra.billsec ?? 60,
      );
    }
  };

  addCust(1, "A", "09000000001", 6);
  // Kazemi: 20 calls on 10 Nov, mix of in/out and answered / no-answer+busy, spread hours 9–18 Tehran.
  const hoursZ = { 9: "2026-11-10T05:45:00.000Z", 10: "2026-11-10T06:45:00.000Z", 12: "2026-11-10T08:45:00.000Z", 14: "2026-11-10T10:45:00.000Z", 15: "2026-11-10T11:45:00.000Z" };
  let cid = 10, callId = 100;
  const kCalls = [
    [hoursZ[9], 2, "answered", "outgoing"],
    [hoursZ[10], 4, "answered", "incoming"],
    [hoursZ[12], 6, "answered", "outgoing"],
    [hoursZ[15], 5, "no_answer", "outgoing"],
    [hoursZ[14], 3, "no_answer", "outgoing"],
  ];
  for (const [iso, n, result, dir] of kCalls) {
    for (let i = 0; i < n; i++) {
      addCust(cid, "K"+cid, "09000001"+String(cid).padStart(3, "0"), 6, "2026-11-10T06:00:00.000Z");
      addCall(callId, cid, 6, iso, result, { dir, billsec: result === "answered" ? 180 : 0, status: result === "answered" ? "ANSWERED" : result === "busy" ? "BUSY" : "NO ANSWER" });
      cid++; callId++;
    }
  }
  // 4 of those customers are "new" in window; already created_at in window. Add 0 more beyond the 20.
  // Hasani (3): fewer calls so Kazemi ranks above or we just assert rank is a number in 1..3
  for (let i = 0; i < 8; i++) {
    addCust(80 + i, "H"+i, "090000020"+String(i).padStart(2, "0"), 3, "2026-11-10T07:00:00.000Z");
    addCall(300 + i, 80 + i, 3, "2026-11-10T08:00:00.000Z", "answered", { dir: "outgoing", billsec: 90 });
  }
  // Ghasemi (4): more successful P1 work but fewer calls
  for (let i = 0; i < 3; i++) {
    addCust(200 + i, "G"+i, "090000030"+String(i).padStart(2, "0"), 4, "2026-11-10T07:00:00.000Z");
    addCall(400 + i, 200 + i, 4, "2026-11-10T08:10:00.000Z", "answered", { dir: "outgoing", billsec: 60 });
  }

  // Filed + signed for Kazemi
  for (const id of [10, 11, 12]) {
    d.prepare("INSERT INTO loan_applications(id,customer_id,created_at,salesperson_id_snapshot,is_pre_registration) VALUES(?,?,?,?,0)")
      .run(id, 10 + (id - 10), "2026-11-10T07:20:00.000Z", 6);
  }
  d.prepare("INSERT INTO contract_generations(id,customer_id,loan_application_id,status,provider_status,created_at,updated_at) VALUES(1,10,10,'signed','accept','2026-11-10T09:00:00.000Z','2026-11-10T09:00:00.000Z')").run();
  d.prepare("INSERT INTO contract_generations(id,customer_id,loan_application_id,status,provider_status,created_at,updated_at) VALUES(2,11,11,'signed','accept','2026-11-10T09:10:00.000Z','2026-11-10T09:10:00.000Z')").run();

  // Follow-ups: 8 due, 5 done on time
  for (let i = 0; i < 8; i++) {
    d.prepare("INSERT INTO reminders(id,salesperson_id,customer_id,remind_at,done,closed_at,voided_at,replaced_by) VALUES(?,?,?,?,?,?,NULL,NULL)")
      .run(1 + i, 6, 10 + i, "2026-11-10T10:00:00.000Z", i < 5 ? 1 : 0, i < 5 ? "2026-11-10T12:00:00.000Z" : null);
  }

  // Bale: 2 chats, 5 outbound messages for Kazemi (user 8)
  d.prepare("INSERT INTO bale_bots(id,user_id) VALUES(1,8)").run();
  d.prepare("INSERT INTO bale_bot_chats(id,bot_id,last_at) VALUES(1,1,'2026-11-10T10:00:00.000Z')").run();
  d.prepare("INSERT INTO bale_bot_chats(id,bot_id,last_at) VALUES(2,1,'2026-11-10T11:00:00.000Z')").run();
  for (let i = 0; i < 5; i++) {
    d.prepare("INSERT INTO bale_bot_messages(id,chat_row,dir,status,sent_at,created_at) VALUES(?,?, 'out','sent',?,?)")
      .run(1 + i, i < 3 ? 1 : 2, "2026-11-10T10:15:00.000Z", "2026-11-10T10:15:00.000Z");
  }
  d.prepare("INSERT INTO bale_bot_messages(id,chat_row,dir,status,sent_at,created_at) VALUES(90,1,'in',NULL,'2026-11-10T10:00:00.000Z','2026-11-10T10:00:00.000Z')").run();

  // Younesi (trainee, not on a team): a few calls, no rank
  for (let i = 0; i < 4; i++) {
    addCust(500 + i, "Y"+i, "090000040"+String(i).padStart(2, "0"), 19, "2026-11-10T06:00:00.000Z");
    addCall(600 + i, 500 + i, 19, "2026-11-10T06:30:00.000Z", "answered");
  }
  return d;
}

const synFile = dbPath;
buildSynth(synFile).close();
if (fs.existsSync(LIVE) && fs.realpathSync(synFile) === fs.realpathSync(LIVE)) {
  console.error("Refusing to use the live database."); process.exit(2);
}

// crm-db runs production schema checks; point it at a full masked copy, not the synth file.
process.env.CRM_DATABASE_PATH = fs.existsSync(maskedPath) ? maskedPath : synFile;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "warn";
process.env.SESSION_SECRET ||= `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`;

const { crmDb, execute } = await import("../src/lib/crm-db.ts");
const mp = await import("../src/lib/my-performance-v11.ts");
const router = (await import("../src/routes/my-performance-v11.ts")).default;

const NOW = new Date("2026-11-10T12:00:00.000Z"); // 15:30 Tehran
const kazemi = { id: 8, role: "salesperson", baseRole: "salesperson", salespersonId: 6, username: "kazemi", fullName: "آقای کاظمی", permissions: [] };
const younesi = { id: 27, role: "salesperson", baseRole: "salesperson", salespersonId: 19, username: "younesi", fullName: "خانم یونسی", permissions: [] };
const registrar = { id: 10, role: "registrar", baseRole: "registrar", username: "reg", fullName: "ثبت", permissions: [] };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const syn = new DatabaseSync(dbPath);

await ok("flag helpers: only '1' is ON", () => {
  assert.equal(mp.mpFlagOnDb(syn), true);
  assert.equal(mp.mpInquiryOnDb(syn), false);
  syn.prepare("UPDATE call_queue_settings SET value='yes' WHERE key=?").run(mp.MP_FLAG);
  assert.equal(mp.mpFlagOnDb(syn), false);
  syn.prepare("UPDATE call_queue_settings SET value='1' WHERE key=?").run(mp.MP_FLAG);
  assert.equal(mp.mpFlagOnDb(syn), true);
});

await ok("me payload for expert; inquiry off", () => {
  const me = mp.myWorkMePayload(syn, kazemi);
  assert.equal(me.enabled, true);
  assert.equal(me.inquiry, false);
  assert.equal(me.canView, true);
  assert.equal(me.self.salespersonId, 6);
  assert.equal(me.self.teamName, "تیم فروش ۱");
  assert.equal(me.self.trainee, false);
});

const report = mp.myWorkReport(syn, kazemi, { period: "day", anchor: "2026-11-10" }, NOW);

await ok("own calls, no-answer includes busy, duration present", () => {
  assert.equal(report.self.calls.value, 20);
  assert.equal(report.self.outbound.value, 16);
  assert.equal(report.self.inbound.value, 4);
  assert.equal(report.self.answered.value, 12);
  assert.equal(report.self.noAnswer.value, 8);
  assert.ok(report.self.durationSec.value > 0);
});

await ok("new customers, filed, signed, bale, follow-ups", () => {
  assert.equal(report.self.newCustomers.value, 20); // 20 customers created in window for sp 6 (ids 10+)
  assert.equal(report.self.filed.value, 3);
  assert.equal(report.self.signed.value, 2);
  assert.equal(report.self.baleChats.value, 2);
  assert.equal(report.self.baleMessages.value, 5);
  assert.equal(report.self.followups.due, 8);
  assert.equal(report.self.followups.done, 5);
});

await ok("team section is rank + averages only; no colleague names", () => {
  assert.equal(report.team.name, "تیم فروش ۱");
  assert.ok(report.team.of === 3);
  assert.ok(report.team.rank >= 1 && report.team.rank <= 3);
  assert.ok(Number.isFinite(report.team.averages.calls));
  const blob = JSON.stringify(report);
  assert.ok(!blob.includes("حسنی"), blob);
  assert.ok(!blob.includes("قاسمی"));
  assert.ok(!blob.includes("خردکار"));
  assert.ok(!blob.includes("اصلانیان"));
  assert.ok(!blob.includes("یونسی"));
  assert.ok(!("experts" in report) || report.experts == null);
  assert.ok(!blob.includes("members"));
});

await ok("trend is hours 9-18 with current hour marked", () => {
  assert.equal(report.trend.kind, "hour");
  assert.equal(report.trend.columns.length, 10);
  assert.equal(report.trend.columns[0].key, "9");
  assert.equal(report.trend.columns[6].key, "15");
  assert.equal(report.trend.columns[6].value, 5);
  assert.equal(report.trend.columns.filter((c) => c.current).length, 1);
});

await ok("trainee sees own numbers, no rank, no colleague names", () => {
  const tr = mp.myWorkReport(syn, younesi, { period: "day", anchor: "2026-11-10" }, NOW);
  assert.equal(tr.access, "trainee");
  assert.equal(tr.self.trainee, true);
  assert.equal(tr.self.calls.value, 4);
  assert.equal(tr.team, null);
  const blob = JSON.stringify(tr);
  assert.ok(!blob.includes("کاظمی"));
  assert.ok(!blob.includes("حسنی"));
});

await ok("flag OFF is 404; existing flags stay '1'", () => {
  syn.prepare("UPDATE call_queue_settings SET value='0' WHERE key=?").run(mp.MP_FLAG);
  try { mp.myWorkReport(syn, kazemi, { period: "day", anchor: "2026-11-10" }, NOW); assert.fail("expected 404"); }
  catch (e) { assert.equal(e.status, 404); }
  syn.prepare("UPDATE call_queue_settings SET value='1' WHERE key=?").run(mp.MP_FLAG);
  const keep = (k) => syn.prepare("SELECT value v FROM call_queue_settings WHERE key=?").get(k).v;
  assert.equal(keep("flag.sales_performance_v1"), "1");
  assert.equal(keep("flag.expert_lockdown"), "1");
  assert.equal(keep("flag.multi_team_v1"), "1");
});

await ok("registrar has no access", () => {
  const me = mp.myWorkMePayload(syn, registrar);
  assert.equal(me.canView, false);
  try { mp.myWorkReport(syn, registrar, { period: "day" }, NOW); assert.fail("expected 403"); }
  catch (e) { assert.equal(e.status, 403); }
});

await ok("inquiry flag stays off on the report", () => {
  assert.equal(report.inquiry, false);
  assert.ok(!("inquiryValue" in report.self));
});

/* -------- HTTP on the masked copy (crmDb) -------- */
function setFlag(key, value) {
  const now = new Date().toISOString();
  crmDb.prepare("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, value, now);
}
const flagSnap = (k) => crmDb.prepare("SELECT value v FROM call_queue_settings WHERE key=?").get(k)?.v ?? null;
const beforeSp = flagSnap("flag.sales_performance_v1");
const beforeEl = flagSnap("flag.expert_lockdown");
const beforeMt = flagSnap("flag.multi_team_v1");
setFlag(mp.MP_FLAG, "1");

const actors = { kazemi, younesi, registrar };
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
const call = async (actor, url) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { headers: { "x-actor": actor } });
  const b = await r.json().catch(() => null);
  return { s: r.status, b };
};

await ok("HTTP expert report hides colleague names", async () => {
  const r = await call("kazemi", "/my-work?period=day&anchor=2026-11-10");
  assert.equal(r.s, 200, JSON.stringify(r.b));
  assert.equal(r.b.self.salespersonId, 6);
  assert.ok(Number.isFinite(r.b.self.calls.value));
  assert.ok(r.b.team == null || !("members" in r.b.team));
  const blob = JSON.stringify(r.b);
  assert.ok(!blob.includes("حسنی"), blob.slice(0, 400));
  assert.ok(!blob.includes("قاسمی"));
  const me = await call("kazemi", "/my-work/me");
  assert.equal(me.s, 200);
  assert.equal(me.b.inquiry, false);
});

await ok("HTTP flag OFF returns 404 and does not change other flags", async () => {
  setFlag(mp.MP_FLAG, "0");
  const r = await call("kazemi", "/my-work?period=day&anchor=2026-11-10");
  assert.equal(r.s, 404);
  assert.equal(flagSnap("flag.sales_performance_v1"), beforeSp);
  assert.equal(flagSnap("flag.expert_lockdown"), beforeEl);
  assert.equal(flagSnap("flag.multi_team_v1"), beforeMt);
  setFlag(mp.MP_FLAG, "1");
});

await ok("HTTP registrar 403", async () => {
  const r = await call("registrar", "/my-work/me");
  assert.equal(r.s, 403);
});

server.close();
console.log(`passed ${passed} checks`);

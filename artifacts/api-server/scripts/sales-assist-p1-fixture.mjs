// Task B (2026-10-26): «پیشنهاد دستیار فروش» P1 daily quota. Synthetic in-memory DB only; no real data, no notification.
// Checks: quota size (default 10) oldest first, stable through the Tehran day, red > 7 days on top, overdue reminders before the quota,
// B3: overdue reminders first, site lead right after, B2: red P1 ahead of «از کاظمی», trainees excluded, the «بی‌تماس» rule = manager_p1_no_call_days (3), admin-editable settings,
// and nothing but the two new assistant_settings keys is written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

process.env.NODE_ENV = "production"; process.env.LOG_LEVEL = "silent";
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "crm-sa-p1-"));
const stubDb = `
  import { DatabaseSync } from "node:sqlite";
  export const databasePath = ":memory:";
  export const crmDb = new DatabaseSync(":memory:");
  crmDb.exec(\`CREATE TABLE customers(id INTEGER PRIMARY KEY, first_name TEXT, official_first_name TEXT, priority INTEGER, is_urgent INTEGER, credit_rank TEXT,
      created_at TEXT NOT NULL, status TEXT, salesperson_id INTEGER, merged_into_customer_id INTEGER);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY, customer_id INTEGER, plan_id INTEGER, stage TEXT, deleted_at TEXT);
    CREATE TABLE customer_tags(customer_id INTEGER, tag TEXT);
    CREATE TABLE call_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, subject TEXT, expert_notes TEXT, customer_request TEXT, created_at TEXT);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, remind_at TEXT, done INTEGER DEFAULT 0);
    CREATE TABLE customer_identity_documents(customer_id INTEGER, document_type TEXT, is_latest INTEGER, storage_path TEXT);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY, required_documents TEXT);
    CREATE TABLE loan_application_documents(application_id INTEGER, requirement_key TEXT, storage_path TEXT, status TEXT);
    CREATE TABLE assistant_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by_user_id INTEGER);\`);
  export const queryRow=(sql,params=[])=>crmDb.prepare(sql).get(...params);
  export const queryRows=(sql,params=[])=>crmDb.prepare(sql).all(...params);
  export const execute=(sql,params=[])=>Number(crmDb.prepare(sql).run(...params).lastInsertRowid);
`;
const stubTeam = `export const getTeamSalesConfig=()=>({enabled:true,qualifierSalespersonId:6,closerSalespersonIds:[3,4]});`;
const stubLeads = `export const TOP=[]; export const topOfList=()=>TOP; export const realCallSql=(c)=>"COALESCE("+c+",'')<>'note'";`;
const plugin = { name: "fx", setup(ctx) {
  ctx.onResolve({ filter: /\/crm-db$/ }, () => ({ path: "db", namespace: "fx" }));
  ctx.onResolve({ filter: /\/team-sales$/ }, () => ({ path: "team", namespace: "fx" }));
  ctx.onResolve({ filter: /\/site-leads$/ }, () => ({ path: "leads", namespace: "fx" }));
  ctx.onLoad({ filter: /.*/, namespace: "fx" }, (a) => ({ contents: a.path === "db" ? stubDb : a.path === "team" ? stubTeam : stubLeads, resolveDir: apiRoot, loader: "ts" }));
} };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok -", name); };
try {
  const out = path.join(temp, "lib.mjs");
  await build({ stdin: { contents: 'export * from "./src/lib/sales-assist"; export * as db from "./src/lib/crm-db"; export * as leads from "./src/lib/site-leads";', resolveDir: apiRoot, loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent", plugins: [plugin],
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(apiRoot, "package.json")).href)});` } });
  const sa = await import(pathToFileURL(out).href);
  const { crmDb, execute, queryRows } = sa.db;
  const DAY = 86400_000;
  // 2026-10-26 14:00 Tehran = 10:30 UTC; Tehran day started 2026-10-25 20:30 UTC.
  const now = new Date("2026-10-26T10:30:00Z");
  const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  const sql = (msAgo) => iso(msAgo).replace("T", " ").replace(/\.\d+Z$/, "");
  const cust = (id, sp, pri, createdAgo = 60 * DAY) => execute("INSERT INTO customers(id,first_name,priority,created_at,status,salesperson_id) VALUES(?,?,?,?,?,?)", [id, `مشتری ${id}`, pri, sql(createdAgo), "in_progress", sp]);
  const call = (cid, agoMs, subject = "call") => execute("INSERT INTO call_logs(customer_id,subject,created_at) VALUES(?,?,?)", [cid, subject, iso(agoMs)]);
  // Hasani-like closer sp 3: 14 P1 customers, last call 1..14 days ago (id 100+d). #120 P1 never called but created 20 d ago.
  for (let d = 1; d <= 14; d++) { cust(100 + d, 3, 1); call(100 + d, d * DAY + 3600_000); }
  cust(120, 3, 1, 20 * DAY);
  // #121: P1, only a 'note' (not a real call) 2 h ago, last real call 30 d ago → still stale (realCallSql reused).
  cust(121, 3, 1); call(121, 30 * DAY); call(121, 2 * 3600_000, "note");
  // #130: P1 with an overdue reminder, called 1 d ago (not stale) → must still come before every quota customer.
  cust(130, 3, 1); call(130, DAY + 3600_000); execute("INSERT INTO reminders(customer_id,remind_at) VALUES(?,?)", [130, iso(3600_000)]);
  // Other expert sp 4 and a trainee sp 5 with stale P1 customers.
  cust(200, 4, 1); call(200, 10 * DAY);
  cust(500, 5, 1); call(500, 10 * DAY);
  const order = (sp = 3, t = now) => sa.scoreForSalesperson(sp, t);
  const ids = (l) => l.map((x) => x.customerId);

  ok("defaults: quota 10, red 7 days, «بی‌تماس» = manager_p1_no_call_days (3)", () => {
    assert.deepEqual(sa.getP1Settings(), { quota: 10, redDays: 7, noCallDays: 3 });
  });
  let first;
  ok("B3: overdue reminder first, then the red P1 quota (oldest first), then the rest", () => {
    const l = order(); first = l;
    assert.equal(l[0].customerId, 130); assert.equal(l[0].reason.kind, "reminder"); assert.equal(l[0].p1Stale, null);
    // stale > 3 days as of day start: 121(30d),120(20d),114..104 → 10 oldest = 121,120,114,113,112,111,110,109,108,107 — all > 7 d = red
    assert.deepEqual(ids(l.slice(1, 11)), [121, 120, 114, 113, 112, 111, 110, 109, 108, 107]);
    assert.ok(l.slice(1, 11).every((x) => x.p1Stale && x.p1Stale.red && x.reason.kind === "p1_stale"));
    assert.deepEqual(l.slice(1, 11).map((x) => x.p1Stale.quotaRank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rest = ids(l.slice(11)); for (const id of [106, 105, 104, 103, 102, 101]) assert.ok(rest.includes(id));
    assert.ok(l.slice(11).every((x) => x.p1Stale == null));
  });
  ok("red label only above 7 days; chip p1_stale with tone red", () => {
    const by = new Map(first.map((x) => [x.customerId, x]));
    for (const id of [121, 120, 114, 108]) { assert.equal(by.get(id).p1Stale.red, true); assert.equal(by.get(id).chips[0].key, "p1_stale"); assert.equal(by.get(id).chips[0].tone, "red"); }
    assert.equal(by.get(121).p1Stale.daysSince, 30); assert.equal(by.get(107).p1Stale.daysSince, 7); assert.equal(by.get(107).p1Stale.red, true); // 7 d 1 h > 7 d
    // with red = 12 days: 121,120,114,113,112 red (> 12 d), 111..107 plain; red block first
    sa.saveP1Settings(sa.validateP1Settings({ redDays: 12 }).values, 1);
    const l12 = order(); const q = l12.filter((x) => x.p1Stale);
    assert.deepEqual(q.map((x) => x.p1Stale.red), [true, true, true, true, true, false, false, false, false, false]);
    assert.equal(q[5].chips[0].tone, undefined);
    // B3: the reminder, then the red block, then the not-red quota
    assert.deepEqual(ids(l12.slice(0, 7)), [130, 121, 120, 114, 113, 112, 111]);
    sa.saveP1Settings(sa.validateP1Settings({ redDays: 7 }).values, 1);
  });
  ok("box of 3: the overdue reminder, then the two oldest red P1; summary counts", () => {
    const r = sa.suggestionsFor(3, now, 3);
    assert.deepEqual(ids(r.items), [130, 121, 120]);
    assert.deepEqual(r.p1Quota, { quota: 10, redDays: 7, noCallDays: 3, remaining: 10, red: 10 });
  });
  ok("stable through the day: a customer called today leaves and is NOT replaced", () => {
    const later = new Date(now.getTime() + 3 * 3600_000); // 17:00 Tehran
    call(121, -1 * 3600_000); // called at 15:00 Tehran
    const l = order(3, later);
    const q = l.filter((x) => x.p1Stale);
    assert.equal(q.length, 9); assert.ok(!q.some((x) => x.customerId === 121)); assert.ok(!q.some((x) => x.customerId === 106));
    assert.deepEqual(sa.p1QuotaSummary(l).remaining, 9);
  });
  ok("next Tehran day: a fresh quota (106 now enters)", () => {
    const tomorrow = new Date(now.getTime() + DAY);
    const q = order(3, tomorrow).filter((x) => x.p1Stale).map((x) => x.customerId);
    assert.equal(q.length, 10); assert.ok(q.includes(106) || q.includes(105)); assert.ok(!q.includes(121));
    crmDb.prepare("DELETE FROM call_logs WHERE customer_id=121 AND created_at>?").run(iso(0)); // undo the synthetic «called today»
  });
  ok("B3: site lead right after the overdue reminder, above the red P1", () => {
    cust(140, 3, 1); call(140, 2 * DAY);
    sa.leads.TOP.push({ customerId: 140, kind: "site_lead", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    const l = order(); assert.equal(l[0].customerId, 130); assert.equal(l[1].customerId, 140); assert.equal(l[1].tier, 3); assert.equal(l[2].customerId, 121);
    sa.leads.TOP.length = 0;
  });
  ok("B2: red P1 ahead of «از کاظمی»; not-red quota stays below it; tier field unchanged", () => {
    // #150 sp 3 «از کاظمی» (P1, called 1 d ago → not stale); #151 sp 3 red P1 (25 d) that is ALSO «از کاظمی» → counts as red.
    cust(150, 3, 1); call(150, DAY);
    sa.leads.TOP.push({ customerId: 150, kind: "from_kazemi", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    let l = order(); const reds = l.filter((x) => x.p1Stale?.red).map((x) => x.customerId);
    const iK = ids(l).indexOf(150); assert.equal(l[iK].tier, 2);
    assert.ok(reds.every((id) => ids(l).indexOf(id) < iK), "every red P1 before «از کاظمی»");
    assert.ok(iK > ids(l).indexOf(130), "B3: the overdue reminder before «از کاظمی»");
    // red = 12 d: not-red quota customers come after «از کاظمی» (the old tier order)
    sa.saveP1Settings(sa.validateP1Settings({ redDays: 12 }).values, 1);
    l = order(); assert.deepEqual(ids(l.slice(0, 7)), [130, 121, 120, 114, 113, 112, 150]);
    assert.ok(ids(l).indexOf(111) > ids(l).indexOf(150), "not-red quota after «از کاظمی»");
    sa.saveP1Settings(sa.validateP1Settings({ redDays: 7 }).values, 1);
    // «از کاظمی» + red P1 on the same customer
    cust(151, 3, 1, 90 * DAY); call(151, 25 * DAY);
    sa.leads.TOP.push({ customerId: 151, kind: "from_kazemi", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    l = order(); const x151 = l.find((x) => x.customerId === 151);
    assert.equal(x151.tier, 2); assert.equal(x151.p1Stale?.red, true); assert.ok(ids(l).indexOf(151) < ids(l).indexOf(150));
    sa.leads.TOP.length = 0; crmDb.prepare("DELETE FROM call_logs WHERE customer_id IN (150,151)").run(); crmDb.prepare("DELETE FROM customers WHERE id IN (150,151)").run();
  });
  ok("B2 for every expert: sp 4 red P1 before its «از کاظمی»; trainees still nothing", () => {
    cust(210, 4, 1); call(210, DAY);
    sa.leads.TOP.push({ customerId: 210, kind: "from_kazemi", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    assert.deepEqual(ids(order(4)), [200, 210]);
    cust(510, 5, 1); sa.leads.TOP.push({ customerId: 510, kind: "from_kazemi", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    assert.deepEqual(order(5), []);
    sa.leads.TOP.length = 0; crmDb.prepare("DELETE FROM call_logs WHERE customer_id IN (210)").run(); crmDb.prepare("DELETE FROM customers WHERE id IN (210,510)").run();
  });
  ok("B3 for every expert: sp 4 overdue reminder > site lead (with or without a reminder) > red P1 > «از کاظمی»; tier field unchanged", () => {
    // #211 overdue reminder (called 1 d ago), #212 site lead, #213 site lead WITH an overdue reminder, #210 «از کاظمی», #200 red P1 (10 d)
    for (const c of [210, 211, 212, 213]) { cust(c, 4, 1); call(c, DAY + 7200_000); }
    execute("INSERT INTO reminders(customer_id,remind_at) VALUES(?,?)", [211, iso(3600_000)]); execute("INSERT INTO reminders(customer_id,remind_at) VALUES(?,?)", [213, iso(1800_000)]);
    sa.leads.TOP.push({ customerId: 212, kind: "site_lead", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false },
      { customerId: 213, kind: "site_lead", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false },
      { customerId: 210, kind: "from_kazemi", startedAt: iso(3600_000), dueAt: iso(-3600_000), windowNow: false });
    const l = order(4); const id = ids(l);
    assert.ok(id.indexOf(211) < id.indexOf(212) && id.indexOf(213) < id.indexOf(212), `reminders first: ${id}`);
    assert.deepEqual(id.slice(2), [212, 200, 210]);
    assert.equal(l.find((x) => x.customerId === 213).tier, 3); assert.equal(l.find((x) => x.customerId === 211).tier, 1);
    assert.deepEqual(order(5), []);
    sa.leads.TOP.length = 0; crmDb.prepare("DELETE FROM reminders WHERE customer_id IN (211,213)").run();
    crmDb.prepare("DELETE FROM call_logs WHERE customer_id IN (210,211,212,213)").run(); crmDb.prepare("DELETE FROM customers WHERE id IN (210,211,212,213)").run();
  });
  ok("each expert only gets their own customers; trainee 5 gets nothing", () => {
    assert.deepEqual(ids(order(4)), [200]); assert.equal(order(4)[0].p1Stale.red, true);
    assert.deepEqual(order(5), []); assert.equal(sa.salesAssistScope(5), null); assert.equal(sa.salesAssistScope(19), null); assert.equal(sa.salesAssistScope(20), null);
  });
  ok("admin-editable: quota 2 / red 12 days; quota 0 switches it off", () => {
    const v = sa.validateP1Settings({ quota: 2, redDays: 12 }); assert.equal(v.ok, true); sa.saveP1Settings(v.values, 1);
    const q = order().filter((x) => x.p1Stale); assert.deepEqual(ids(q), [121, 120]); assert.ok(q.every((x) => x.p1Stale.red));
    assert.equal(order().find((x) => x.customerId === 114).p1Stale, null);
    sa.saveP1Settings(sa.validateP1Settings({ quota: 0 }).values, 1);
    assert.equal(order().filter((x) => x.p1Stale).length, 0); assert.equal(order()[0].customerId, 130);
  });
  ok("validation rejects bad values / unknown fields", () => {
    for (const b of [{ quota: -1 }, { quota: 51 }, { quota: 2.5 }, { redDays: 0 }, { redDays: 61 }, { foo: 1 }, null, []]) assert.equal(sa.validateP1Settings(b).ok, false);
  });
  ok("the manager threshold is reused: manager_p1_no_call_days=10 shrinks the stale set", () => {
    sa.saveP1Settings([["sales_assist_p1_quota", "10"], ["sales_assist_p1_red_days", "7"]], 1);
    execute("INSERT INTO assistant_settings(key,value,updated_at) VALUES('manager_p1_no_call_days','10',?)", [iso(0)]);
    const q = order().filter((x) => x.p1Stale).map((x) => x.customerId); assert.deepEqual(q.sort(), [111, 112, 113, 114, 120, 121].sort());
    crmDb.prepare("DELETE FROM assistant_settings WHERE key='manager_p1_no_call_days'").run();
  });
  ok("read-only: only the two new keys were ever written; customers / calls / reminders unchanged", () => {
    assert.deepEqual(queryRows("SELECT key FROM assistant_settings ORDER BY key").map((r) => r.key), ["sales_assist_p1_quota", "sales_assist_p1_red_days"]);
    assert.equal(queryRows("SELECT COUNT(*) n FROM reminders")[0].n, 1);
    assert.equal(queryRows("SELECT COUNT(*) n FROM customers WHERE priority<>1")[0].n, 0);
  });
  console.log(`sales-assist P1 fixture: ${n} checks passed`);
} finally { rmSync(temp, { recursive: true, force: true }); }

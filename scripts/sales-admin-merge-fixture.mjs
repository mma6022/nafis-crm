// «مدیریت فروش» v1.2 merge fixture (flag.sales_admin_merge_v12 on top of flag.sales_manager_console_v1):
// value parity with the old pages, idempotent import, access (admin + sales manager when ON, admin-only when OFF), sales_teams-only writes,
// conversion = plan only over HTTP (exact write list) + gated apply on the temp copy, flag OFF = old pages byte-identical.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/sales-admin-merge-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const src = process.env.SMC_FIXTURE_DB || process.env.DQ_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smc-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", DP_TEST_NO_BELLS: "1",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("no network in fixture"); };
let passed = 0; const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
let server;
try {
  const express = (await import("express")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const smc = await import("../src/lib/sales-manager-console.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const { queryRow, queryRows, execute } = db;
  const flag = (v) => execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES('flag.sales_manager_console_v1',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [v]);
  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");
  const tableHash = (t) => { try {
    if (t === "sales_team_members") return hash("SELECT team_id,salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order FROM sales_team_members ORDER BY team_id,salesperson_id");
    return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const allTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  const hashAll = () => Object.fromEntries(allTables().map((t) => [t, tableHash(t)]));
  const changedSince = (h0) => Object.keys(hashAll()).filter((t) => tableHash(t) !== (h0[t] ?? "new")).sort();
  // intake probe: a child process creates customers on a COPY (VACUUM INTO) of this DB through the real create path
  const snap = (name) => { const p = path.join(dir, `${name}.db`); execute(`VACUUM INTO '${p}'`); return p; };
  const probe = (dbFile) => {
    const r = spawnSync(process.execPath, [path.resolve("scripts/run-bundled-fixture.mjs"), "scripts/sales-admin-intake-probe.mjs"],
      { env: { ...process.env, SMC_FIXTURE_DB: dbFile }, encoding: "utf8", timeout: 120000 });
    const line = String(r.stdout).split("\n").find((l) => l.startsWith("PROBE "));
    assert.ok(line, `probe output (${r.status}): ${String(r.stderr).slice(0, 400)}`);
    return JSON.parse(line.slice(6));
  };
  const guarded = ["sales_teams", "sales_team_members", "sales_intake_shares", "notification_settings", "team_sales_config", "loan_plans", "contract_templates", "voip_extensions", "users"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));
  const custBefore = hash("SELECT id, salesperson_id FROM customers ORDER BY id");
  const snapToday = snap("today"); // flags OFF, nothing touched: «امروز»

  const cookieParser = (await import("cookie-parser")).default;
  // real cookie sessions (same as the app): requireAuth → router; tokens only live in this temp copy
  const tokens = {};
  for (const id of [1, 2, 5, 8, 27]) {
    const tok = crypto.randomBytes(24).toString("base64url"); tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]);
  }
  const app = express(); app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/api", auth.requireAuth, router);
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: "127.0.0.1", port, agent: false, method, path: `/api${p}`, headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, text: t }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });

  const MANAGER = 5, ADMIN = 1, LEAD = 8, HASANI = 2, ADMIN2 = 27;
  assert.equal(queryRow("SELECT role FROM users WHERE id=?", [MANAGER]).role, "sales_manager");
  const merge = await import("../src/lib/sales-admin-merge.ts");
  const setKey = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const smcFlag = (v) => setKey("flag.sales_manager_console_v1", v);
  const mergeFlag = (v) => setKey("flag.sales_admin_merge_v12", v);
  const FLAG_KEYS = ["flag.sales_manager_console_v1", "flag.sales_admin_merge_v12"];
  // tables the merged page must never write (sales_teams is the only live table it may write)
  const never = ["sales_team_members", "sales_intake_shares", "sales_intake_split", "notification_settings", "default_owner_rule_settings", "default_owner_rule_settings_log",
    "lead_intake_settings", "sales_assist_settings", "dp_capacity_log", "dp_plans", "dp_items", "users", "loan_plans", "contract_templates", "voip_extensions", "salespersons"];
  const cqsHash = () => hash(`SELECT key, value FROM call_queue_settings WHERE key NOT IN (${FLAG_KEYS.map((k) => `'${k}'`).join(",")}) ORDER BY key`);
  const snapshotGuards = () => ({ ...Object.fromEntries(never.map((t) => [t, tableHash(t)])), call_queue_settings: cqsHash(), customers: hash("SELECT id, salesperson_id FROM customers ORDER BY id") });
  // the old pages' GET endpoints, as the admin sees them today
  const OLD = { queue: "/call-queue/settings", discipline: "/call-queue/discipline/settings", daily: "/admin/settings/daily-plan", assist: "/sales-assist/weights",
    owner: "/admin/default-owner-rule", intake: "/lead-intake/admin/settings", teams: "/sales-teams", teamsIntake: "/sales-teams/intake" };
  const strip = (k, b) => {
    if (b == null || typeof b !== "object") return b;
    const o = JSON.parse(JSON.stringify(b));
    if (k === "teams") delete o.todayLabel;
    if (k === "owner") { delete o.settings?.updatedAt; }
    return o;
  };
  const oldResponses = async (u = ADMIN) => {
    const out = {};
    for (const [k, p] of Object.entries(OLD)) { const r = await call(u, "GET", p); out[k] = { status: r.status, body: strip(k, r.body) }; }
    return out;
  };

  const base0 = snapshotGuards();
  const teams0 = JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled,lead_split_quota,commission_json FROM sales_teams ORDER BY id")));
  const old0 = await oldResponses();
  const oldMgr0 = await oldResponses(MANAGER);
  for (const [k, v] of Object.entries(old0)) assert.equal(v.status, 200, `old page ${k} answers today (${v.status})`);

  await ok("both flags OFF: /sales-admin/* and /sales-admin/merge/* are 404; nothing created", async () => {
    for (const p of ["/sales-admin/me", "/sales-admin/merge/state"]) assert.equal((await call(ADMIN, "GET", p)).status, 404, p);
    assert.equal((await call(ADMIN, "PUT", "/sales-admin/merge/teams/2", { name: "x" })).status, 404);
    assert.equal(queryRow("SELECT name FROM sqlite_master WHERE name='smc_settings'"), undefined);
  });
  await ok("merge flag ON alone (console OFF) changes nothing: still 404", async () => {
    mergeFlag("1");
    for (const u of [ADMIN, MANAGER]) assert.equal((await call(u, "GET", "/sales-admin/me")).status, 404);
    assert.equal((await call(ADMIN, "GET", "/sales-admin/merge/state")).status, 404);
    mergeFlag(null);
  });
  smcFlag("1");
  await ok("console ON, merge OFF = live v1.1: admin-only, /me has no merge fields, merge routes 404, no import row", async () => {
    const me = await call(ADMIN, "GET", "/sales-admin/me"); assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.body).sort(), ["canManage", "enabled", "roleLabel"]);
    for (const u of [MANAGER, LEAD, HASANI]) assert.equal((await call(u, "GET", "/sales-admin/me")).status, 403, `user ${u}`);
    assert.equal((await call(ADMIN, "GET", "/sales-admin/merge/state")).status, 404);
    assert.equal((await call(ADMIN, "PUT", "/sales-admin/merge/teams/2", { name: "x" })).status, 404);
    assert.equal(queryRow("SELECT 1 x FROM smc_settings WHERE section='merge_import'"), undefined);
    assert.equal(merge.samImport(ADMIN).ok, false, "import refuses while merge is OFF");
    assert.equal(queryRow("SELECT 1 x FROM smc_settings WHERE section='merge_import'"), undefined);
  });
  mergeFlag("1");
  await ok("access (t356s1307): sales manager 5 and admins 1/27 → 200; lead 8, expert 2 → 403; user 29 and inactive never; no session 401", async () => {
    for (const u of [MANAGER, ADMIN, ADMIN2]) {
      const r = await call(u, "GET", "/sales-admin/me"); assert.equal(r.status, 200, `user ${u}`); assert.equal(r.body.merged, true); assert.equal(r.body.path, "/sales-admin");
      assert.equal((await call(u, "GET", "/sales-admin/merge/state")).status, 200);
    }
    assert.equal((await call(MANAGER, "GET", "/sales-admin/me")).body.roleLabel, "مدیر فروش");
    for (const u of [LEAD, HASANI]) for (const [m, p, b] of [["GET", "/sales-admin/me"], ["GET", "/sales-admin/state"], ["GET", "/sales-admin/merge/state"], ["PUT", "/sales-admin/merge/teams/2", { enabled: false }]]) {
      const r = await call(u, m, p, b); assert.equal(r.status, 403, `${u} ${m} ${p}`);
    }
    assert.equal((await call(null, "GET", "/sales-admin/me")).status, 401);
    assert.equal(smc.smcCanManage({ id: 29, active: true, role: "admin" }), false, "user 29 never");
    assert.equal(smc.smcCanManage({ id: 1, active: false, role: "admin" }), false, "inactive never");
    assert.deepEqual(smc.samAccessRoles(), ["admin", "sales_manager"]);
  });
  await ok("access setting: smc_settings('access_roles')=[\"admin\"] narrows to admin-only; junk roles (salesperson) are ignored; removing it restores the default", async () => {
    execute("INSERT INTO smc_settings(section,payload_json,version,updated_at) VALUES('access_roles','[\"admin\"]',1,datetime('now'))");
    assert.equal((await call(MANAGER, "GET", "/sales-admin/me")).status, 403); assert.equal((await call(ADMIN, "GET", "/sales-admin/me")).status, 200);
    execute("UPDATE smc_settings SET payload_json='[\"salesperson\",\"admin\"]' WHERE section='access_roles'");
    assert.equal((await call(HASANI, "GET", "/sales-admin/me")).status, 403, "a setting can never widen to experts");
    execute("DELETE FROM smc_settings WHERE section='access_roles'");
    assert.equal((await call(MANAGER, "GET", "/sales-admin/me")).status, 200);
  });
  let view;
  await ok("import: values carried over exactly — every value equals what the old pages' GET endpoints return", async () => {
    const r = await call(ADMIN, "GET", "/sales-admin/merge/state"); assert.equal(r.status, 200); view = r.body;
    assert.equal(view.parity.ok, true, JSON.stringify(view.parity.diffs)); assert.deepEqual(view.parity.diffs, []);
    const v = view.values;
    assert.deepEqual(v.queue, old0.queue.body.settings, "تنظیمات صف تماس");
    assert.deepEqual(v.discipline, old0.discipline.body.settings, "نظم پیگیری");
    assert.deepEqual(v.daily, old0.daily.body.settings, "لیست روزانه dp.*");
    assert.deepEqual(v.assist.settings, old0.assist.body.settings, "وزن دستیار فروش"); assert.deepEqual(v.assist.p1, old0.assist.body.p1, "سهمیه‌ی اولویت ۱");
    const { updatedByUserId: _x, ...ownerOld } = old0.owner.body.settings; const { registrarNames: _n, ...ownerNew } = v.defaultOwner;
    assert.deepEqual(ownerNew, ownerOld, "قانون ثبت مشتری");
    assert.deepEqual(v.defaultSourceBySeller, old0.intake.body.defaultSourceBySeller, "منبع پیش‌فرض فرم");
    for (const t of old0.teams.body.teams) {
      const n = v.teams.find((x) => x.id === t.id); assert.ok(n, `team ${t.id}`);
      assert.equal(n.name, t.name); assert.equal(n.enabled, t.enabled);
      assert.deepEqual(n.members.map((m) => [m.salespersonId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, m.sortOrder]),
        t.members.map((m) => [m.salespersonId, m.isLead, m.ownsNone, m.ownsP1, m.ownsP2, m.ownsP3, m.sortOrder]), `members/priorities of team ${t.id}`);
    }
    const dbShares = queryRows("SELECT source, team_id teamId, percent FROM sales_intake_shares ORDER BY source, team_id");
    assert.deepEqual(v.intake, JSON.parse(JSON.stringify(dbShares)), "درصد مشتری جدید / لید فرم سایت");
    assert.ok(!/"(userId|id|user_id|salespersonId)":29\b/.test(r.text), "no user 29");
    assert.ok(!/password|رمز عبور|09\d{9}/.test(r.text), "no password fields, no phone numbers");
  });
  await ok("import is idempotent: reopening writes nothing (same version, same audit count, same hash)", async () => {
    const v1 = queryRow("SELECT version, payload_json FROM smc_settings WHERE section='merge_import'"); const a1 = queryRow("SELECT COUNT(*) n FROM smc_audit").n;
    for (let i = 0; i < 3; i++) assert.equal((await call(MANAGER, "GET", "/sales-admin/merge/state")).status, 200);
    assert.equal(merge.samImport(ADMIN).changed, false);
    const v2 = queryRow("SELECT version, payload_json FROM smc_settings WHERE section='merge_import'");
    assert.equal(v2.version, v1.version); assert.equal(v2.payload_json, v1.payload_json); assert.equal(queryRow("SELECT COUNT(*) n FROM smc_audit").n, a1);
    assert.equal(queryRows("SELECT id FROM smc_audit WHERE section='merge'").length, 1);
  });
  await ok("console team names follow the live sales_teams names after import (live wins, §2)", async () => {
    const t = smc.loadDoc("teams");
    for (const lt of view.values.teams.filter((x) => x.enabled)) assert.equal(t.teams.find((x) => x.id === `t${lt.id}`)?.name, lt.name);
  });
  await ok("team writes (t358s1318 §3): rename = sales_teams only; deactivate preview writes nothing; deactivate removes the members (old disableTeam) + membership history + audit; intake guard; undo brings them back", async () => {
    const cq0 = JSON.parse(JSON.stringify(queryRows("SELECT key,value FROM call_queue_settings ORDER BY key")));
    const h0 = hashAll(); const st0 = JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled FROM sales_teams ORDER BY id")));
    const mem = (t) => JSON.parse(JSON.stringify(queryRows("SELECT salesperson_id,is_lead,owns_none,owns_p1,owns_p2,owns_p3,sort_order FROM sales_team_members WHERE team_id=? ORDER BY salesperson_id", [t])));
    const m2 = mem(2); assert.ok(m2.length >= 2);
    let r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "تیم فروش دو" }); assert.equal(r.status, 200, r.text);
    assert.equal(queryRow("SELECT name FROM sales_teams WHERE id=2").name, "تیم فروش دو");
    assert.deepEqual(changedSince(h0), ["sales_teams", "smc_audit"], "rename writes sales_teams + the history row only");
    const renameAudit = r.body.auditId; assert.ok(renameAudit > 0);
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/1", { enabled: false }); assert.equal(r.status, 409, "team 1 still has 100% of new customers"); assert.equal(r.body.error, "intake_destination");
    assert.equal(mem(1).length, 3, "a refused deactivation removes nobody");
    const h1 = hashAll();
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: false, preview: true }); assert.equal(r.status, 200, r.text);
    assert.equal(r.body.preview, true); assert.equal(r.body.removed.length, m2.length); assert.equal(r.body.blocked, null);
    assert.deepEqual(changedSince(h1), [], "the confirm step writes nothing");
    const hist0 = queryRow("SELECT COUNT(*) n FROM sales_team_membership_history").n;
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: false }); assert.equal(r.status, 200, r.text);
    assert.equal(queryRow("SELECT enabled FROM sales_teams WHERE id=2").enabled, 0); assert.deepEqual(mem(2), [], "members removed from the team (old behavior)");
    assert.equal(r.body.removed.length, m2.length);
    const closed = queryRow("SELECT COUNT(*) n FROM sales_team_membership_history WHERE team_id=2 AND ended_at IS NOT NULL").n; assert.ok(closed >= m2.length, "membership history closed for the removed members");
    const deact = queryRow("SELECT id, summary_fa, before_json FROM smc_audit WHERE section='teams_live' ORDER BY id DESC LIMIT 1");
    assert.ok(/بیرون آمدند/.test(deact.summary_fa)); assert.equal(JSON.parse(deact.before_json).members.length, m2.length, "the removed members are in the history row");
    const changed = changedSince(h1); for (const t of changed) assert.ok(["sales_teams", "sales_team_members", "sales_team_membership_history", "smc_audit"].includes(t), `deactivate wrote ${t}`);
    for (const t of ["notification_settings", "team_sales_config", "sales_intake_shares", "users", "customers"]) assert.ok(!changed.includes(t), t);
    r = await call(ADMIN, "POST", `/sales-admin/audit/${deact.id}/revert`); assert.equal(r.status, 200, r.text);
    assert.equal(queryRow("SELECT enabled FROM sales_teams WHERE id=2").enabled, 1); assert.deepEqual(mem(2), m2, "undo puts the same members back with the same priorities");
    assert.ok(queryRow("SELECT COUNT(*) n FROM sales_team_membership_history").n > hist0);
    // plain deactivate → «فعال کردن» brings back the members the last deactivation removed
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: false })).status, 200);
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: true, preview: true }); assert.equal(r.body.returning.length, m2.length);
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: true }); assert.equal(r.status, 200, r.text); assert.deepEqual(mem(2), m2);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "" })).status, 400);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "تیم فروش ۱" })).status, 409);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/99", { name: "x" })).status, 404);
    r = await call(MANAGER, "POST", `/sales-admin/audit/${renameAudit}/revert`); assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled FROM sales_teams ORDER BY id"))), st0, "sales_teams back to the start");
    for (const t of ["notification_settings", "team_sales_config", "sales_team_members", "sales_intake_shares", "users", "customers", "loan_plans", "contract_templates"]) assert.equal(tableHash(t), h0[t] ?? "absent", `${t} identical after the round trip`);
    assert.deepEqual(JSON.parse(JSON.stringify(queryRows("SELECT key,value FROM call_queue_settings ORDER BY key"))), cq0, "no per-user panel flag turned on by bringing members back");
  });
  await ok("parity still ok after the round trip; audit lists the live-team rows in Persian", async () => {
    assert.equal(merge.samParity().ok, true, JSON.stringify(merge.samParity().diffs));
    const a = await call(MANAGER, "GET", "/sales-admin/audit"); assert.ok(a.body.rows.some((x) => x.section === "teams_live" && x.sectionFa === "تیم‌ها (جدول زنده)"));
  });
  await ok("conversion is only a plan over HTTP: lists exactly smc_settings(dist), smc_audit, default_owner_rule_settings(config), default_owner_rule_settings_log; nothing written by reading it", async () => {
    const g = snapshotGuards();
    const v = (await call(MANAGER, "GET", "/sales-admin/merge/state")).body.conversion;
    assert.deepEqual(v.writes.map((w) => w.table), ["smc_settings", "smc_audit", "default_owner_rule_settings", "default_owner_rule_settings_log"]);
    assert.equal(v.applicable, true); assert.equal(v.intakeFollowsDist, true); assert.deepEqual(v.blockers, [], "both flags ON: intake follows the rules, parity ok");
    assert.equal(v.parity.ok, true, JSON.stringify(v.parity)); assert.ok(v.parity.cases >= 8);
    assert.deepEqual(v.teamRule.conds, [{ field: "registrar", values: ["*"] }, { field: "reg_source", values: ["*"] }]);
    assert.equal(v.memberRule.rule.targets[0].id, "e6", "the registration rule's target expert (salesperson 6)");
    const after = snapshotGuards(); for (const k of Object.keys(g)) assert.equal(after[k], g[k], k);
    assert.ok(!smc.loadDoc("dist").team.rules.some((r) => r.id === merge.CONVERSION_RULE_ID));
  });

  // Flag OFF again: old pages answer exactly as before anything was turned on
  mergeFlag("0");
  await ok("merge flag back OFF: old pages' responses identical to the start (admin and sales manager), console admin-only again, merge routes 404", async () => {
    const old1 = await oldResponses(); const mgr1 = await oldResponses(MANAGER);
    for (const k of Object.keys(OLD)) { assert.deepEqual(old1[k], old0[k], `admin ${k}`); assert.deepEqual(mgr1[k], oldMgr0[k], `manager ${k}`); }
    assert.equal((await call(MANAGER, "GET", "/sales-admin/me")).status, 403);
    assert.deepEqual(Object.keys((await call(ADMIN, "GET", "/sales-admin/me")).body).sort(), ["canManage", "enabled", "roleLabel"]);
    assert.equal((await call(ADMIN, "GET", "/sales-admin/merge/state")).status, 404);
    const g = snapshotGuards(); for (const k of Object.keys(base0)) assert.equal(g[k], base0[k], `${k} identical to the start`);
    assert.deepEqual(JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled,lead_split_quota,commission_json FROM sales_teams ORDER BY id"))), teams0, "sales_teams settings identical to the start");
  });

  // Gated conversion on this temp copy only (proof of the exact writes). Never on live without Mohammad.
  mergeFlag("1");
  const dp = await import("../src/lib/daily-plan.ts");
  const dor = await import("../src/lib/default-owner-rule.ts");
  const ALLOWED = { daily: ["call_queue_settings", "call_queue_settings_log"], model: ["call_queue_settings", "call_queue_settings_log", "sales_assist_settings", "assistant_settings"],
    discipline: ["call_queue_settings", "call_queue_settings_log"], owner: ["default_owner_rule_settings", "default_owner_rule_settings_log", "lead_intake_settings", "lead_intake_settings_log"],
    capacity: ["dp_capacity_log", "assistant_events", "dp_test_bells", "site_notification_events"] };
  const rawVals = (t, keyCol) => { try { return JSON.parse(JSON.stringify(queryRows(`SELECT ${keyCol} k, ${t === "sales_assist_settings" ? "settings_json" : "value"} v FROM ${t} ORDER BY ${keyCol}`))); } catch { return "absent"; } };
  const valueTables = () => ({ cqs: rawVals("call_queue_settings", "key"), sas: rawVals("sales_assist_settings", "id"), as: rawVals("assistant_settings", "key"),
    dor: rawVals("default_owner_rule_settings", "key"), lis: rawVals("lead_intake_settings", "key") });
  const edits = {
    daily: () => ({ guardPct: old0.daily.body.settings.guardPct === 30 ? 40 : 30 }),
    model: () => ({ queue: { newRedHours: old0.queue.body.settings.newRedHours === 5 ? 6 : 5 }, assist: { snoozeHours: old0.assist.body.settings.snoozeHours === 3 ? 1 : 3 }, p1: { quota: old0.assist.body.p1.quota === 12 ? 13 : 12 } }),
    discipline: () => ({ alertDays: old0.discipline.body.settings.alertDays === 4 ? 5 : 4 }),
    owner: () => ({ config: { ...(({ updatedAt, updatedByUserId, ...c }) => c)(old0.owner.body.settings), registrarMode: "selected", registrarUserIds: [2] }, defaultSourceBySeller: { "3": "referral" } }),
  };
  await ok("the four folded sections are editable (t358s1318 §2): same tables as the old pages + history; old pages show the new value; «برگرداندن» restores the exact rows; never notification_settings / team_sales_config", async () => {
    for (const [key, body] of Object.entries(edits)) {
      const v0 = valueTables(); const h0 = hashAll();
      for (const u of [LEAD, HASANI]) assert.equal((await call(u, "PUT", `/sales-admin/merge/section/${key}`, body())).status, 403, `${key} by ${u}`);
      assert.deepEqual(changedSince(h0), [], `${key}: a refused write writes nothing`);
      const r = await call(MANAGER, "PUT", `/sales-admin/merge/section/${key}`, body()); assert.equal(r.status, 200, `${key}: ${r.text}`); assert.equal(r.body.changed, true, key);
      const changed = changedSince(h0);
      for (const t of changed) assert.ok([...ALLOWED[key], "smc_audit"].includes(t), `${key} wrote ${t}`);
      assert.ok(!changed.includes("notification_settings") && !changed.includes("team_sales_config"), `${key}: standing rule`);
      const now = await oldResponses(MANAGER);
      if (key === "daily") assert.equal(now.daily.body.settings.guardPct, body().guardPct);
      if (key === "model") { assert.equal(now.queue.body.settings.newRedHours, body().queue.newRedHours); assert.equal(now.assist.body.settings.snoozeHours, body().assist.snoozeHours); assert.equal(now.assist.body.p1.quota, body().p1.quota); }
      if (key === "discipline") assert.equal(now.discipline.body.settings.alertDays, body().alertDays);
      if (key === "owner") { assert.deepEqual(now.owner.body.settings.registrarUserIds, [2]); assert.deepEqual(now.intake.body.defaultSourceBySeller, { "3": "referral" }); }
      const audit = queryRow("SELECT id, section FROM smc_audit ORDER BY id DESC LIMIT 1"); assert.equal(audit.section, `merge_${key}`);
      assert.ok((await call(MANAGER, "GET", "/sales-admin/audit")).body.rows.some((x) => x.id === audit.id && /جدول زنده/.test(x.sectionFa)));
      const u = await call(MANAGER, "POST", `/sales-admin/audit/${audit.id}/revert`); assert.equal(u.status, 200, `${key} undo: ${u.text}`);
      assert.deepEqual(valueTables(), v0, `${key}: undo restores the exact rows`);
      const back = await oldResponses(MANAGER);
      for (const k of ["queue", "discipline", "daily"]) assert.deepEqual(back[k].body.settings, oldMgr0[k].body.settings, `${key} undo → old page ${k} settings identical to the start`);
      assert.deepEqual(back.intake.body.defaultSourceBySeller, oldMgr0.intake.body.defaultSourceBySeller);
      assert.deepEqual(back.assist.body.settings, oldMgr0.assist.body.settings); assert.deepEqual(back.assist.body.p1, oldMgr0.assist.body.p1);
      const { updatedAt: _a, updatedByUserId: _b, ...o1 } = back.owner.body.settings; const { updatedAt: _c, updatedByUserId: _d, ...o0 } = oldMgr0.owner.body.settings; assert.deepEqual(o1, o0);
    }
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/section/daily", { guardPct: 999 })).status, 422, "the old validator still applies");
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/section/bale", {})).status, 404, "no other sections");
  });
  await ok("capacity (daily list): preview writes nothing; confirm writes dp_capacity_log (+ the old page's events), audited; undo returns the previous capacity", async () => {
    const ex = dp.dpExperts()[0]; assert.ok(ex, "an eligible expert"); const day = dp.dpNextWork(dp.dpToday()); const sp = ex.salespersonId;
    const h0 = hashAll();
    let r = await call(MANAGER, "PUT", "/sales-admin/merge/section/capacity", { salespersonId: sp, date: day, capacity: 9, reason: "آزمون" }); assert.equal(r.status, 200, r.text);
    assert.equal(r.body.preview.preview, true); assert.deepEqual(changedSince(h0), [], "preview writes nothing");
    r = await call(MANAGER, "PUT", "/sales-admin/merge/section/capacity", { salespersonId: sp, date: day, capacity: 9, reason: "آزمون", confirm: true }); assert.equal(r.status, 200, r.text);
    for (const t of changedSince(h0)) assert.ok([...ALLOWED.capacity, "smc_audit"].includes(t), `capacity wrote ${t}`);
    assert.equal(dp.dpCapacity(sp, day).capacity, 9);
    const first = r.body.auditId;
    r = await call(MANAGER, "PUT", "/sales-admin/merge/section/capacity", { salespersonId: sp, date: day, capacity: 11, reason: "آزمون ۲", confirm: true }); const second = r.body.auditId;
    r = await call(MANAGER, "POST", `/sales-admin/audit/${second}/revert`); assert.equal(r.status, 200, r.text); assert.equal(dp.dpCapacity(sp, day).capacity, 9, "undo → previous capacity");
    const prev = JSON.parse(queryRow("SELECT before_json FROM smc_audit WHERE id=?", [first]).before_json).capacity;
    r = await call(MANAGER, "POST", `/sales-admin/audit/${first}/revert`);
    if (prev == null) assert.equal(r.status, 409, "no previous capacity → cannot undo to «none» (said in Persian)"); else assert.equal(r.status, 200);
  });
  await ok("intake follows the distribution rules only when both flags are ON; before the conversion nothing changes (no explicit rule)", async () => {
    assert.equal(merge.samIntakeFollowsDist().active, true);
    assert.equal(dor.defaultOwnerDecision("staff_form", 2).via, undefined, "no explicit rule yet → the old «قانون ثبت» decides");
    mergeFlag("0"); assert.equal(merge.samIntakeFollowsDist().active, false); mergeFlag("1");
  });
  const snapFlagsOn = snap("flags-on");
  await ok("conversion order + parity (temp copy only): refused unless intake follows the rules; refused without approval; refused when the result would differ; writes exactly the listed tables; idempotent", async () => {
    const u = auth.getAuthUserById ? auth.getAuthUserById(ADMIN) : { id: ADMIN, active: true, role: "admin" };
    mergeFlag("0"); assert.equal(merge.samApplyConversion(u, { approvedBy: "t358s1318" }).error, "intake_not_following_dist", "merge OFF → refused"); mergeFlag("1");
    dor.setIntakeDistHook(null); assert.equal(merge.samApplyConversion(u, { approvedBy: "t358s1318" }).error, "intake_not_following_dist", "build without the intake change → refused");
    assert.ok(merge.samConversionPlan().blockers.length >= 1);
    dor.setIntakeDistHook((s, r) => merge.samDistDecision(s, r));
    assert.equal(merge.samApplyConversion(u, { approvedBy: "" }).error, "approval_required");
    // Kazemi on leave in the console → the converted rule would not reach him → refused (parity)
    const t0 = smc.loadDoc("teams"); const tLeave = JSON.parse(JSON.stringify(t0)); tLeave.experts.find((e) => e.id === "e6").status = "inactive";
    execute("UPDATE smc_settings SET payload_json=? WHERE section='teams'", [JSON.stringify(tLeave)]);
    const blocked = merge.samApplyConversion(u, { approvedBy: "t358s1318" }); assert.equal(blocked.error, "blocked", JSON.stringify(blocked));
    execute("UPDATE smc_settings SET payload_json=? WHERE section='teams'", [JSON.stringify(t0)]);
    const h0 = hashAll();
    const r = merge.samApplyConversion(u, { approvedBy: "t358s1318" }); assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(changedSince(h0), ["default_owner_rule_settings", "default_owner_rule_settings_log", "smc_audit", "smc_settings"].sort());
    assert.equal(queryRow("SELECT COUNT(*) n FROM default_owner_rule_settings_log WHERE via='smc_merge_conversion'").n, 1);
    const cfg = JSON.parse(queryRow("SELECT value FROM default_owner_rule_settings WHERE key='config'").value); assert.equal(cfg.enabled, false); assert.equal(cfg.ownerSalespersonId, 6);
    const h1 = hashAll();
    assert.equal(merge.samApplyConversion(u, { approvedBy: "t358s1318" }).changed, false);
    assert.deepEqual(changedSince(h1), [], "second run writes nothing");
    const d = dor.defaultOwnerDecision("staff_form", 2); assert.equal(d.apply, true); assert.equal(d.via, "dist"); assert.equal(d.ownerSalespersonId, 6);
  });
  const snapConverted = snap("converted");
  await ok("new customers land exactly as today: real create path on copies — today (flags OFF) = flags ON = after the conversion (every source × priority × registrar, portal, staff form)", async () => {
    const today = probe(snapToday), on = probe(snapFlagsOn), conv = probe(snapConverted);
    assert.ok(Object.keys(today.owners).length >= 160);
    assert.ok(!Object.values(today.owners).some((v) => String(v).startsWith("ERR")), JSON.stringify(today.owners));
    assert.deepEqual(on.owners, today.owners, "flags ON, before the conversion");
    assert.deepEqual(conv.owners, today.owners, "after the conversion");
    const kaz = Object.values(today.owners).filter((v) => v === 6).length; assert.ok(kaz >= 120, `Kazemi gets today's share (${kaz})`);
    assert.deepEqual(conv.portal, today.portal); assert.equal(today.portal.salespersonId, 6);
    for (const k of Object.keys(today.decisions)) assert.equal(conv.decisions[k].owner, today.decisions[k].owner, `decision ${k}`);
    assert.ok(Object.values(conv.decisions).every((d) => d.via === "dist"), "after the conversion the owner comes from the distribution rule");
    assert.deepEqual(conv.history, today.history, "same customer_priority_history rows by source");
    console.log(`   probe: ${Object.keys(today.owners).length} customers, ${kaz} to Kazemi (6), P1 to 3/4 by the team cursor, identical in all three`);
  });
  mergeFlag("0");
  await ok("flags OFF at the end: console back to admin-only, merge routes 404", async () => {
    assert.equal((await call(ADMIN, "GET", "/sales-admin/merge/state")).status, 404);
    smcFlag("0"); assert.equal((await call(ADMIN, "GET", "/sales-admin/me")).status, 404);
  });
  await ok("rollback hazard, measured: flags turned OFF AFTER the conversion → the create path still lands as today, but the registration rule is off, so the portal / staff-form owner falls back (undo the conversion first)", async () => {
    const today = probe(snapToday); const off = probe(snap("converted-off"));
    assert.deepEqual(off.owners, today.owners, "create path: the team split decided these anyway");
    const diffs = Object.keys(today.decisions).filter((k) => today.decisions[k].owner !== off.decisions[k].owner);
    assert.ok(diffs.length > 0, "decisions differ once both the rule and the hook are off");
    console.log(`   rollback: ${diffs.length}/${Object.keys(today.decisions).length} staff-form/portal decisions change; portal owner ${today.portal.salespersonId} → ${off.portal.salespersonId}`);
  });
  await ok("PATCH /sales-teams/:id works (updateTeam import fixed): manager renames team 2 and back; members kept; bad id 400; expert 403", async () => {
    const m0 = JSON.parse(JSON.stringify(queryRows("SELECT salesperson_id FROM sales_team_members WHERE team_id=2 ORDER BY salesperson_id")));
    let r = await call(MANAGER, "PATCH", "/sales-teams/2", { name: "تیم فروش دو" }); assert.equal(r.status, 200, r.text); assert.equal(r.body.team.name, "تیم فروش دو");
    assert.equal(queryRow("SELECT name FROM sales_teams WHERE id=2").name, "تیم فروش دو");
    assert.deepEqual(JSON.parse(JSON.stringify(queryRows("SELECT salesperson_id FROM sales_team_members WHERE team_id=2 ORDER BY salesperson_id"))), m0);
    r = await call(MANAGER, "PATCH", "/sales-teams/2", { name: teams0.find((t) => t.id === 2).name }); assert.equal(r.status, 200, r.text);
    assert.equal((await call(MANAGER, "PATCH", "/sales-teams/abc", { name: "x" })).status, 400);
    assert.equal((await call(HASANI, "PATCH", "/sales-teams/2", { name: "x" })).status, 403);
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close(); fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

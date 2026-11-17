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

const src = process.env.SMC_FIXTURE_DB || process.env.DQ_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smc-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
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
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const guarded = ["sales_teams", "sales_team_members", "sales_intake_shares", "notification_settings", "team_sales_config", "loan_plans", "contract_templates", "voip_extensions", "users"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));
  const custBefore = hash("SELECT id, salesperson_id FROM customers ORDER BY id");

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
    const rq = http.request({ host: "127.0.0.1", port, method, path: `/api${p}`, headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
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
  await ok("only sales_teams is written: rename + deactivate/reactivate by the sales manager (§6-20), intake guard, revert; every other table identical", async () => {
    const before = snapshotGuards(); const st0 = JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled FROM sales_teams ORDER BY id")));
    let r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "تیم فروش دو" }); assert.equal(r.status, 200, r.text);
    assert.equal(queryRow("SELECT name FROM sales_teams WHERE id=2").name, "تیم فروش دو");
    const renameAudit = r.body.auditId; assert.ok(renameAudit > 0);
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/1", { enabled: false }); assert.equal(r.status, 409, "team 1 still has 100% of new customers"); assert.equal(r.body.error, "intake_destination");
    r = await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { enabled: false }); assert.equal(r.status, 200, r.text);
    assert.equal(queryRow("SELECT enabled FROM sales_teams WHERE id=2").enabled, 0);
    r = await call(ADMIN, "PUT", "/sales-admin/merge/teams/2", { enabled: true }); assert.equal(r.status, 200, r.text);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "" })).status, 400);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/2", { name: "تیم فروش ۱" })).status, 409);
    assert.equal((await call(MANAGER, "PUT", "/sales-admin/merge/teams/99", { name: "x" })).status, 404);
    r = await call(MANAGER, "POST", `/sales-admin/audit/${renameAudit}/revert`); assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(JSON.stringify(queryRows("SELECT id,name,enabled FROM sales_teams ORDER BY id"))), st0, "sales_teams back to the start");
    const after = snapshotGuards(); for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} must not be written`);
    assert.ok(queryRows("SELECT section FROM smc_audit WHERE section='teams_live'").length >= 4);
  });
  await ok("parity still ok after the round trip; audit lists the live-team rows in Persian", async () => {
    assert.equal(merge.samParity().ok, true, JSON.stringify(merge.samParity().diffs));
    const a = await call(MANAGER, "GET", "/sales-admin/audit"); assert.ok(a.body.rows.some((x) => x.section === "teams_live" && x.sectionFa === "تیم‌ها (جدول زنده)"));
  });
  await ok("conversion is only a plan over HTTP: lists exactly smc_settings(dist), smc_audit, default_owner_rule_settings(config), default_owner_rule_settings_log; nothing written by reading it", async () => {
    const g = snapshotGuards();
    const v = (await call(MANAGER, "GET", "/sales-admin/merge/state")).body.conversion;
    assert.deepEqual(v.writes.map((w) => w.table), ["smc_settings", "smc_audit", "default_owner_rule_settings", "default_owner_rule_settings_log"]);
    assert.equal(v.applicable, true); assert.ok(v.blockers.length >= 1, "blocker: live intake does not read console rules yet");
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
  await ok("conversion apply (temp copy only): refused without approval; with an approval id writes exactly the listed tables; idempotent; registrar lead routes to e6", async () => {
    const u = auth.getAuthUserById ? auth.getAuthUserById(ADMIN) : { id: ADMIN, active: true, role: "admin" };
    assert.equal(merge.samApplyConversion(u, { approvedBy: "" }).error, "approval_required");
    const allTables = queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    const h0 = Object.fromEntries(allTables.map((t) => [t, tableHash(t)]));
    const r = merge.samApplyConversion(u, { approvedBy: "t000u-fixture" }); assert.equal(r.ok, true, JSON.stringify(r));
    const changed = allTables.filter((t) => tableHash(t) !== h0[t]).sort();
    assert.deepEqual(changed, ["default_owner_rule_settings", "default_owner_rule_settings_log", "smc_audit", "smc_settings"].sort(), `changed: ${changed}`);
    assert.equal(queryRow("SELECT COUNT(*) n FROM default_owner_rule_settings_log WHERE via='smc_merge_conversion'").n, 1);
    const cfg = JSON.parse(queryRow("SELECT value FROM default_owner_rule_settings WHERE key='config'").value); assert.equal(cfg.enabled, false); assert.equal(cfg.ownerSalespersonId, 6);
    const h1 = Object.fromEntries(allTables.map((t) => [t, tableHash(t)]));
    assert.equal(merge.samApplyConversion(u, { approvedBy: "t000u-fixture" }).changed, false);
    assert.deepEqual(allTables.filter((t) => tableHash(t) !== h1[t]), [], "second run writes nothing");
    const rt = smc.routeLead({ registrar: "7", reg_source: "manual" }, { commit: false }); assert.equal(rt.expertId, "e6"); assert.equal(rt.teamRule, 1);
  });
  mergeFlag("0");
  await ok("flags OFF at the end: console back to admin-only, merge routes 404", async () => {
    assert.equal((await call(ADMIN, "GET", "/sales-admin/merge/state")).status, 404);
    smcFlag("0"); assert.equal((await call(ADMIN, "GET", "/sales-admin/me")).status, 404);
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close(); fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

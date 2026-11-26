// t942u «دسترسی این صفحه» v1 — end-to-end fixture on a COPY of the masked DB (never the live DB, no network).
// Chain: requireAuth → leadAnnotatorMask → registrarWriteGuard → expertLockdownGuard → filesCarouselGuard → pageAccessGuard → router.
// Usage: PA_FIXTURE_DB=/workspace/social-hub-send/run/sh.db node scripts/run-bundled-fixture.mjs scripts/page-access-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

globalThis.__DatabaseSync = DatabaseSync;
globalThis.fetch = async () => { throw new Error("no network in fixture"); };
const src = process.env.PA_FIXTURE_DB || "/workspace/social-hub-send/run/sh.db";
if (!fs.existsSync(src)) { console.log("SKIP (missing PA_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK|KAVENEGAR|VOIP|ISSABEL/i.test(k)) delete process.env[k];
const SECRET = `fixture-only-${crypto.randomBytes(8).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SESSION_SECRET: SECRET, SMS_DISABLED: "1",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder" });

let passed = 0, failed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log("ok -", name); }
  catch (e) { failed++; console.log("not ok -", name, "::", String(e?.message || e), "\n   ", String(e?.stack || "").split("\n").slice(1, 4).join(" | ")); }
};
let server;
try {
  const db = await import("../src/lib/crm-db.ts");
  const { queryRow, queryRows, execute } = db;
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { requireAuth } = await import("../src/lib/auth.ts");
  const { leadAnnotatorMask } = await import("../src/lib/lead-annotator-mask.ts");
  const { makeRegistrarWriteGuard } = await import("../src/lib/registrar-view.ts");
  const { expertLockdownGuard } = await import("../src/lib/expert-lockdown.ts");
  const { filesCarouselGuard } = await import("../src/lib/files-carousel.ts");
  const { pageAccessGuard, pageAccessLockdownBypass, paEffective } = await import("../src/lib/page-access.ts");
  const reg = await import("../src/lib/page-access-registry.ts");
  const router = (await import("../src/routes/index.ts")).default;
  const authRouter = (await import("../src/routes/auth.ts")).default;
  const app = express();
  app.use(express.json({ limit: "2mb" })); app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => db.crmDb), pageAccessLockdownBypass, expertLockdownGuard, filesCarouselGuard, pageAccessGuard, router);
  const sock = path.join(dir, "api.sock");
  server = app.listen(sock); await once(server, "listening");
  const call = (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ socketPath: sock, path: "/api" + p, method, headers: { Cookie: `crm_session=${tok}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (r) => {
      let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: r.statusCode, body: j }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });
  const session = (uid) => {
    const t = crypto.randomBytes(24).toString("base64url"); const h = crypto.createHmac("sha256", SECRET).update(t).digest("hex"); const now = new Date();
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [h, uid, new Date(+now + 864e5).toISOString(), now.toISOString()]);
    return t;
  };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql) => { try { return crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex"); } catch { return "absent"; } };
  const guarded = ["team_sales_config", "notification_settings", "contracts", "users", "loan_plans", "role_permissions", "app_roles"];
  const guardBefore = Object.fromEntries(guarded.map((t) => [t, hash(`SELECT * FROM ${t} ORDER BY rowid`)]));
  const tableExists = (t) => Boolean(queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", [t]));

  // Today's production flags around this feature.
  // 2, 3, 8 are the lockdown experts on the masked copy: run the main path with lockdown OFF and test lockdown on its own below.
  flag("flag.expert_lockdown", "0"); flag("flag.multi_team_v1", "1"); flag("flag.page_access_v1", null);
  const ADMIN = session(1), SM = session(5), HASANI = session(2), GHASEMI = session(3), KAZEMI = session(8), REG = session(7), U31 = session(31), U6 = session(6);
  const sess = async (t) => (await call("GET", "/auth/session", t)).body;
  const baseline = {};
  for (const [n, t] of Object.entries({ ADMIN, SM, HASANI, GHASEMI, KAZEMI, REG, U31, U6 })) baseline[n] = await sess(t);
  const probes = [["GET", "/manager/sales-report?range=month"], ["GET", "/manual-verifications"], ["GET", "/voice-notes/usage"], ["GET", "/mobile-calls"], ["GET", "/customers?limit=1"]];
  const probe = async (t) => { const o = {}; for (const [m, p] of probes) o[p] = (await call(m, p, t)).status; return o; };
  const probeBase = { HASANI: await probe(HASANI), REG: await probe(REG), U31: await probe(U31), ADMIN: await probe(ADMIN) };

  await ok("flag absent: /me enabled:false, admin routes 404, no tables created", async () => {
    assert.deepEqual((await call("GET", "/page-access/me", HASANI)).body, { enabled: false });
    assert.deepEqual((await call("GET", "/page-access/me", ADMIN)).body, { enabled: false });
    assert.equal((await call("GET", "/page-access/pages/customers", ADMIN)).status, 404);
    assert.equal((await call("POST", "/page-access/pages/customers/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: 0 })).status, 404);
    assert.equal(tableExists("page_access_grants"), false); assert.equal(tableExists("page_access_log"), false);
  });
  await ok("flag '0' / 'true' are OFF too", async () => {
    for (const v of ["0", "true", "on"]) { flag("flag.page_access_v1", v); assert.deepEqual((await call("GET", "/page-access/me", HASANI)).body, { enabled: false }); }
    flag("flag.page_access_v1", null);
  });

  flag("flag.page_access_v1", "1");
  await ok("flag ON with no rows: sessions + endpoint statuses identical to OFF", async () => {
    for (const [n, t] of Object.entries({ ADMIN, SM, HASANI, GHASEMI, KAZEMI, REG, U31, U6 })) assert.deepEqual(await sess(t), baseline[n], n);
    assert.deepEqual(await probe(HASANI), probeBase.HASANI); assert.deepEqual(await probe(REG), probeBase.REG); assert.deepEqual(await probe(ADMIN), probeBase.ADMIN);
    const me = (await call("GET", "/page-access/me", HASANI)).body;
    assert.equal(me.enabled, true); assert.equal(me.canManage, false); assert.deepEqual(me.granted, {}); assert.deepEqual(me.blocked, []);
    assert.equal((await call("GET", "/page-access/me", ADMIN)).body.canManage, true);
    assert.equal((await call("GET", "/page-access/me", SM)).body.canManage, true);
  });
  await ok("non-admins cannot read or write (403)", async () => {
    assert.equal((await call("GET", "/page-access/pages/customers", HASANI)).status, 403);
    assert.equal((await call("POST", "/page-access/pages/customers/grants", REG, { subjectKind: "user", userIds: [2], level: "view", baseVersion: 0 })).status, 403);
  });
  await ok("status view: chip counts (admins + SM counted), roles with defaults, never pages", async () => {
    const st = (await call("GET", "/page-access/pages/customers", ADMIN)).body;
    assert.equal(st.grantable, "both");
    const always = st.always.map((x) => x.id).sort((a, b) => a - b);
    assert.ok(always.includes(1) && always.includes(5) && !always.includes(29), JSON.stringify(always));
    assert.ok(st.roles.some((r) => r.slug === "salesperson" && r.default === "manage"));
    assert.ok(!st.roles.some((r) => r.slug === "admin" || r.slug === "sales_manager"));
    const active = queryRows("SELECT id,role FROM users WHERE active=1 AND id<>29");
    const roleSlugs = st.roles.map((r) => r.slug);
    const expected = active.filter((u) => ["admin", "sales_manager"].includes(u.role) || roleSlugs.includes(u.role)).length;
    assert.equal(st.counts.people, expected); assert.equal(st.counts.roles, st.roles.length);
    for (const k of ["users", "releases", "assistants-settings", "call-queue-settings"]) {
      const s = (await call("GET", `/page-access/pages/${k}`, ADMIN)).body; assert.equal(s.grantable, "never", k);
      assert.equal((await call("POST", `/page-access/pages/${k}/grants`, ADMIN, { subjectKind: "role", roleSlug: "registrar", level: "view", baseVersion: 0 })).status, 409, k);
    }
    assert.equal((await call("GET", "/page-access/pages/ledger", ADMIN)).status, 200, "phase 2: every page has the API");
    assert.equal((await call("GET", "/page-access/pages/no-such-page", ADMIN)).status, 404);
  });
  await ok("subjects: admins, sales manager and user 29 are never pickable; trainees are ordinary experts (t961), lockdown flagged", async () => {
    const s = (await call("GET", "/page-access/pages/sales-reports/subjects", ADMIN)).body;
    const ids = s.users.map((u) => u.id);
    for (const id of [1, 5, 27, 29]) assert.ok(!ids.includes(id), `user ${id} listed`);
    assert.equal(s.users.find((u) => u.id === 31)?.trainee, false, "t961: trainees are treated like other experts");
    for (const bad of [[1], [5], [29], [27]]) assert.equal((await call("POST", "/page-access/pages/sales-reports/grants", ADMIN, { subjectKind: "user", userIds: bad, level: "view", baseVersion: s.version })).status, 422, String(bad));
    assert.equal((await call("POST", "/page-access/pages/sales-reports/grants", ADMIN, { subjectKind: "role", roleSlug: "sales_manager", level: "view", baseVersion: s.version })).status, 422);
  });

  let v = 0;
  const ver = async (k) => (await call("GET", `/page-access/pages/${k}`, ADMIN)).body.version;
  await ok("admin-only page: user grant opens exactly its endpoints (sales report) — others stay 403", async () => {
    assert.equal(probeBase.HASANI["/manager/sales-report?range=month"], 403);
    v = await ver("sales-reports");
    const r = await call("POST", "/page-access/pages/sales-reports/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: v });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("GET", "/manager/sales-report?range=month", HASANI)).status, 200);
    assert.equal((await call("GET", "/manager/sales-report/settings", HASANI)).status, 200);
    assert.equal((await call("PUT", "/manager/sales-report/settings", HASANI, { flags: {} })).status, 403, "view grant does not open settings writes");
    assert.equal((await call("GET", "/manual-verifications", HASANI)).status, 403);
    assert.equal((await call("GET", "/voice-notes/usage", HASANI)).status, 403);
    assert.equal((await call("GET", "/page-access/pages/sales-reports", HASANI)).status, 403, "elevated user is not an admin of page-access");
    assert.equal((await call("GET", "/manager/sales-report?range=month", GHASEMI)).status, 403, "other users unchanged");
    const me = (await call("GET", "/page-access/me", HASANI)).body; assert.deepEqual(me.granted, { "sales-reports": "view" });
  });
  await ok("conflict: stale baseVersion → 409 and nothing written", async () => {
    const n = queryRow("SELECT COUNT(*) n FROM page_access_log").n;
    const r = await call("POST", "/page-access/pages/sales-reports/grants", ADMIN, { subjectKind: "user", userIds: [3], level: "view", baseVersion: v });
    assert.equal(r.status, 409); assert.equal(queryRow("SELECT COUNT(*) n FROM page_access_log").n, n);
  });
  await ok("level edit of an existing grant is an update (one active row)", async () => {
    const r = await call("POST", "/page-access/pages/sales-reports/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "manage", baseVersion: await ver("sales-reports") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(queryRow("SELECT COUNT(*) n FROM page_access_grants WHERE page_key='sales-reports' AND subject_id='2' AND revoked_at IS NULL").n, 1);
    assert.equal(queryRow("SELECT action FROM page_access_log ORDER BY id DESC LIMIT 1").action, "update");
    assert.equal((await call("PUT", "/manager/sales-report/settings", HASANI, { flags: {} })).status === 403, false, "manage opens settings PUT");
  });
  await ok("view-only pages reject «دیدن و کار کردن»", async () => {
    for (const k of ["manual-verifications", "voice-notes-usage", "contracts"]) {
      const r = await call("POST", `/page-access/pages/${k}/grants`, ADMIN, { subjectKind: "user", userIds: [3], level: "manage", baseVersion: await ver(k) });
      assert.equal(r.status, 422, k);
    }
  });
  await ok("history + revert of the newest change only (with confirm on the client)", async () => {
    const h = (await call("GET", "/page-access/pages/sales-reports/history", ADMIN)).body;
    assert.equal(h.items.length, 2); assert.equal(h.items[0].action, "update"); assert.ok(h.revertBatch);
    assert.equal((await call("POST", "/page-access/pages/sales-reports/revert", ADMIN, { batch: h.items[1].batch })).status, 409, "older change is not revertable");
    const r = await call("POST", "/page-access/pages/sales-reports/revert", ADMIN, { batch: h.revertBatch });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(queryRow("SELECT level FROM page_access_grants WHERE page_key='sales-reports' AND subject_id='2' AND revoked_at IS NULL").level, "view");
    const h2 = (await call("GET", "/page-access/pages/sales-reports/history", ADMIN)).body;
    assert.equal(h2.items[0].action, "revert"); assert.equal(h2.items[1].reverted, true);
    assert.equal(h2.revertBatch, h2.items[0].batch, "a revert is itself revertable (undoes the undo)");
    assert.equal(h2.items[0].prior.effect, "allow"); assert.equal(h2.items[0].prior.level, "manage");
    assert.equal(h2.items[0].result.effect, "allow"); assert.equal(h2.items[0].result.level, "view");
    const r2 = await call("POST", "/page-access/pages/sales-reports/revert", ADMIN, { batch: h2.revertBatch });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(queryRow("SELECT level FROM page_access_grants WHERE page_key='sales-reports' AND subject_id='2' AND revoked_at IS NULL").level, "manage", "revert of revert restores the pre-revert state");
    const h3 = (await call("GET", "/page-access/pages/sales-reports/history", ADMIN)).body;
    assert.equal(h3.items[0].action, "revert"); assert.equal(h3.items[1].reverted, true); assert.equal(h3.items[1].action, "revert");
    assert.equal(h3.revertBatch, h3.items[0].batch);
    assert.equal((await call("POST", "/page-access/pages/sales-reports/revert", ADMIN, { batch: h3.items[2].batch })).status, 409, "older change is still not revertable");
    // leave the grant at «manage» — the next case revokes it
  });
  await ok("revoke (برداشتن) closes the page again", async () => {
    const st = (await call("GET", "/page-access/pages/sales-reports", ADMIN)).body;
    const row = st.users.find((u) => u.id === 2 && u.kind === "granted");
    const r = await call("POST", `/page-access/pages/sales-reports/rows/${row.rowId}/remove`, ADMIN, { baseVersion: st.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("GET", "/manager/sales-report?range=month", HASANI)).status, 403);
    // undo bar = revert of that batch
    const h = (await call("GET", "/page-access/pages/sales-reports/history", ADMIN)).body;
    assert.equal((await call("POST", "/page-access/pages/sales-reports/revert", ADMIN, { batch: h.revertBatch })).status, 200);
    assert.equal((await call("GET", "/manager/sales-report?range=month", HASANI)).status, 200);
  });
  await ok("role grant on a permission page adds the page permissions; trainees get it like any expert (t961)", async () => {
    assert.ok(!baseline.REG.user.permissions.includes("accounting.view") && !baseline.GHASEMI.user.permissions.includes("accounting.view"));
    let r = await call("POST", "/page-access/pages/accounting/grants", ADMIN, { subjectKind: "role", roleSlug: "registrar", level: "view", baseVersion: await ver("accounting") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await sess(REG)).user.permissions.includes("accounting.view"));
    assert.ok(!(await sess(REG)).user.permissions.includes("accounting.manage"), "view level adds only view permissions");
    r = await call("POST", "/page-access/pages/accounting/grants", ADMIN, { subjectKind: "role", roleSlug: "salesperson", level: "view", baseVersion: await ver("accounting") });
    assert.equal(r.status, 200);
    assert.ok((await sess(GHASEMI)).user.permissions.includes("accounting.view"), "normal expert gets it");
    assert.ok((await sess(U31)).user.permissions.includes("accounting.view"), "t961: a trainee gets a role grant like other experts");
    assert.equal((await call("GET", "/page-access/me", U31)).body.granted.accounting, "view");
    r = await call("POST", "/page-access/pages/accounting/grants", ADMIN, { subjectKind: "user", userIds: [31], level: "manage", baseVersion: await ver("accounting") });
    assert.equal(r.status, 200);
    const s31 = (await sess(U31)).user.permissions; assert.ok(s31.includes("accounting.view") && s31.includes("accounting.manage"));
    assert.ok(!s31.includes("accounting.opening"), "never-permissions are never added");
    r = await call("POST", "/page-access/pages/voice-notes-usage/grants", ADMIN, { subjectKind: "role", roleSlug: "salesperson", level: "view", baseVersion: await ver("voice-notes-usage") });
    assert.equal(r.status, 200);
    assert.equal((await call("GET", "/voice-notes/usage", GHASEMI)).status, 200, "role grant opens the admin page for an expert");
    assert.equal((await call("GET", "/voice-notes/usage", U31)).status, 200, "t961: trainee reached by the role grant");
    const st = (await call("GET", "/page-access/pages/accounting", ADMIN)).body;
    assert.ok(st.roles.some((x) => x.slug === "registrar" && x.grant?.level === "view"));
    assert.ok(st.users.some((x) => x.id === 31 && x.kind === "granted" && x.level === "manage"));
  });
  await ok("block (بستن) beats role default + role grant; page-local endpoint 403; unblock restores", async () => {
    const st0 = await call("GET", "/mobile-calls", GHASEMI);
    let r = await call("POST", "/page-access/pages/mobile-calls/blocks", ADMIN, { userId: 3, baseVersion: await ver("mobile-calls") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await call("GET", "/mobile-calls", GHASEMI); assert.equal(b.status, 403); assert.equal(b.body.error, "page_access_blocked");
    assert.deepEqual((await call("GET", "/page-access/me", GHASEMI)).body.blocked, ["mobile-calls"]);
    assert.equal((await call("GET", "/mobile-calls", HASANI)).status, st0.status, "others unchanged");
    const st = (await call("GET", "/page-access/pages/mobile-calls", ADMIN)).body;
    const row = st.users.find((u) => u.id === 3 && u.kind === "blocked"); assert.ok(row);
    assert.ok(!st.users.some((u) => u.kind === "granted" && u.id === 3));
    r = await call("POST", "/page-access/pages/voice-notes-usage/blocks", ADMIN, { userId: 3, baseVersion: await ver("voice-notes-usage") });
    assert.equal((await call("GET", "/voice-notes/usage", GHASEMI)).status, 403, "user block beats the role grant");
    r = await call("POST", `/page-access/pages/mobile-calls/rows/${row.rowId}/remove`, ADMIN, { baseVersion: st.version });
    assert.equal(r.status, 200); assert.equal((await call("GET", "/mobile-calls", GHASEMI)).status, st0.status);
  });
  await ok("t961 lockdown: a per-user grant opens ONLY its page inside expert_lockdown; role grants and everything else stay locked; flag stays ON", async () => {
    flag("flag.expert_lockdown", "1");
    try {
      const st = async (m, p, t, b) => (await call(m, p, t, b)).status;
      assert.equal(await st("GET", "/voice-notes/usage", KAZEMI), 403);
      assert.equal((await call("GET", "/expert-lockdown/me", KAZEMI)).body.locked, true);
      // a role grant is ignored while locked
      let r = await call("POST", "/page-access/pages/voice-notes-usage/grants", ADMIN, { subjectKind: "role", roleSlug: "salesperson", level: "view", baseVersion: await ver("voice-notes-usage") });
      assert.equal(r.status, 200); assert.equal(await st("GET", "/voice-notes/usage", KAZEMI), 403, "role grant does not override the lockdown");
      r = await call("POST", "/page-access/pages/voice-notes-usage/grants", ADMIN, { subjectKind: "user", userIds: [8], level: "view", baseVersion: await ver("voice-notes-usage") });
      assert.equal(r.status, 200);
      assert.equal(await st("GET", "/voice-notes/usage", KAZEMI), 200, "the user grant opens the page");
      const me = (await call("GET", "/expert-lockdown/me", KAZEMI)).body; assert.equal(me.locked, true); assert.ok(me.allowedPages.includes("/voice-notes-usage"), "the page joins allowedPages");
      assert.equal(await st("GET", "/manager/sales-report?range=month", KAZEMI), 403, "other pages stay locked");
      assert.equal(await st("GET", "/mobile-calls", KAZEMI), 403);
      assert.equal(await st("GET", "/voice-notes/usage", GHASEMI), 403, "other locked experts unchanged");
      // customers page: view = GET only, manage adds writes
      assert.equal(await st("GET", "/customers?limit=1", KAZEMI), 403);
      r = await call("POST", "/page-access/pages/customers/grants", ADMIN, { subjectKind: "user", userIds: [8], level: "view", baseVersion: await ver("customers") });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.notEqual(await st("GET", "/customers?limit=1", KAZEMI), 403, "customers GET opens by the grant");
      assert.equal(await st("PATCH", "/customers/999999999", KAZEMI, {}), 403, "view level: no writes inside the lockdown");
      assert.equal(await st("GET", "/mobile-calls", KAZEMI), 403, "still locked elsewhere");
      assert.equal((await call("GET", "/expert-lockdown/me", KAZEMI)).body.locked, true, "lockdown flag untouched");
      // «بستن» still wins
      r = await call("POST", "/page-access/pages/voice-notes-usage/blocks", ADMIN, { userId: 8, baseVersion: await ver("voice-notes-usage") });
      assert.equal(r.status, 200); assert.equal(await st("GET", "/voice-notes/usage", KAZEMI), 403, "a block beats the grant");
      const sub = (await call("GET", "/page-access/pages/voice-notes-usage/subjects", ADMIN)).body;
      assert.equal(sub.users.find((u) => u.id === 8).locked, true);
    } finally { flag("flag.expert_lockdown", "0"); }
  });
  await ok("social monitor: requireAuth inside its router keeps the elevated user", async () => {
    const r = await call("POST", "/page-access/pages/social-monitor-reports/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: await ver("social-monitor-reports") });
    assert.equal(r.status, 200);
    const d = new Date().toISOString().slice(0, 10);
    const g = await call("GET", `/social-monitor/reports?from=${d}&to=${d}`, HASANI);
    assert.notEqual(g.status, 403, JSON.stringify(g.body).slice(0, 120));
    assert.equal((await call("GET", `/social-monitor/reports?from=${d}&to=${d}`, GHASEMI)).status, 403);
  });
  // ---- phase 2 ----
  await ok("phase 2 ledger: view grant opens exactly the GL report GETs (not commission totals, no accounting.view)", async () => {
    const paths = ["/gl/reports/trial-balance", "/gl/reports/status", "/gl/reports/accounts"];
    const before = {}; for (const x of paths) before[x] = (await call("GET", x, HASANI)).status;
    const ctBefore = (await call("GET", "/gl/reports/commission-totals", HASANI)).status;
    const permsBefore = (await sess(HASANI)).user.permissions;
    for (const x of paths) assert.equal(before[x], 403, x);
    const r = await call("POST", "/page-access/pages/ledger/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: await ver("ledger") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const x of paths) assert.notEqual((await call("GET", x, HASANI)).status, 403, x);
    assert.equal((await call("GET", "/gl/reports/commission-totals", HASANI)).status, ctBefore, "commission totals unchanged");
    for (const x of paths) assert.equal((await call("GET", x, GHASEMI)).status, 403, "others unchanged " + x);
    const s2 = await sess(HASANI); assert.deepEqual(s2.user.permissions, permsBefore, "ledger grant adds no permission (no accounting.view)");
    assert.deepEqual((await call("GET", "/page-access/me", HASANI)).body.granted.ledger, "view");
  });
  await ok("phase 2 manager pages: cs-report view grant opens only its GETs; call-queue-events manage opens seen", async () => {
    assert.equal((await call("GET", "/call-summary-fields/report", HASANI)).status, 403);
    const permsBefore = (await sess(HASANI)).user.permissions;
    let r = await call("POST", "/page-access/pages/cs-report/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: await ver("cs-report") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual((await call("GET", "/call-summary-fields/report", HASANI)).status, 403);
    assert.notEqual((await call("GET", "/call-summary-fields/config", HASANI)).status, 403);
    assert.equal((await call("GET", "/call-summary-fields/report", GHASEMI)).status, 403, "others unchanged");
    r = await call("POST", "/page-access/pages/cs-report/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "manage", baseVersion: await ver("cs-report") });
    assert.notEqual(r.status, 200, "view-only cap");
    const evBefore = (await call("GET", "/call-queue/events", HASANI)).status;
    r = await call("POST", "/page-access/pages/call-queue-events/grants", ADMIN, { subjectKind: "user", userIds: [2], level: "manage", baseVersion: await ver("call-queue-events") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual((await call("GET", "/call-queue/events", HASANI)).status, 403, `before ${evBefore}`);
    assert.notEqual((await call("POST", "/call-queue/events/999999999/seen", HASANI, {})).status, 403);
    assert.equal((await call("POST", "/call-queue/events/999999999/seen", GHASEMI, {})).status, 403, "others unchanged");
    const s2 = await sess(HASANI); assert.deepEqual(s2.user.permissions, permsBefore, "elevation never edits permissions");
  });
  await ok("phase 2 block-only pages: grant → 409 block_only, block works, a stray allow row is ignored", async () => {
    for (const k of ["sales-kpi", "sales-performance", "sales-teams", "my-work", "bale-connect", "smart-filing"]) {
      const r = await call("POST", `/page-access/pages/${k}/grants`, ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: await ver(k) });
      assert.equal(r.status, 409, k); assert.equal(r.body.error, "block_only", k);
    }
    const r = await call("POST", "/page-access/pages/customer-segments/blocks", ADMIN, { userId: 3, baseVersion: await ver("customer-segments") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((await call("GET", "/page-access/me", GHASEMI)).body.blocked.includes("customer-segments"));
    execute("INSERT INTO page_access_grants(page_key,subject_kind,subject_id,effect,level,created_by,created_at) VALUES('sales-kpi','user','2','allow','view',1,datetime('now'))");
    assert.equal(paEffective({ id: 2, role: baseline.HASANI.user.role, salespersonId: baseline.HASANI.user.salespersonId }).grants["sales-kpi"], undefined);
    execute("DELETE FROM page_access_grants WHERE page_key='sales-kpi' AND effect='allow'");
    const me = (await call("GET", "/page-access/me", HASANI)).body;
    assert.equal(me.pages.length, 58); assert.equal(me.pages.find((p) => p.key === "sales-kpi").grantable, "block");
    assert.ok(me.pages.find((p) => p.key === "sales-kpi").note);
  });
  await ok("phase 2 never pages: sales-admin / bale-bot-admin → 409, with their own note", async () => {
    for (const k of ["sales-admin", "bale-bot-admin"]) {
      const r = await call("POST", `/page-access/pages/${k}/grants`, ADMIN, { subjectKind: "user", userIds: [2], level: "view", baseVersion: await ver(k) });
      assert.equal(r.status, 409, k);
      const me = (await call("GET", "/page-access/me", ADMIN)).body; assert.ok(me.pages.find((p) => p.key === k).note, k);
    }
  });
  await ok("user 29 never: resolver ignores rows for 29", async () => {
    execute("INSERT INTO page_access_grants(page_key,subject_kind,subject_id,effect,level,created_by,created_at) VALUES('sales-reports','user','29','allow','manage',1,datetime('now'))");
    const e = paEffective({ id: 29, role: "salesperson", salespersonId: 99 });
    assert.deepEqual(e, { grants: {}, blocked: [] });
    execute("DELETE FROM page_access_grants WHERE subject_id='29'");
  });
  await ok("fail-closed: broken table → no extra access, blockable endpoint 503 for non-admins, admin unaffected", async () => {
    execute("ALTER TABLE page_access_grants RENAME TO page_access_grants_x");
    try {
      const s = await sess(HASANI); assert.deepEqual(s.user.permissions, baseline.HASANI.user.permissions);
      assert.equal((await call("GET", "/manager/sales-report?range=month", HASANI)).status, 403);
      assert.equal((await call("GET", "/mobile-calls", HASANI)).status, 503);
      assert.equal((await call("GET", "/mobile-calls", ADMIN)).status, probeBase.ADMIN["/mobile-calls"]);
    } finally { execute("ALTER TABLE page_access_grants_x RENAME TO page_access_grants"); }
  });
  await ok("flag back OFF: exactly today's behaviour even with rows present", async () => {
    flag("flag.page_access_v1", "0");
    try {
    for (const [n, t] of Object.entries({ ADMIN, SM, HASANI, GHASEMI, KAZEMI, REG, U31, U6 })) assert.deepEqual(await sess(t), baseline[n], n);
    assert.deepEqual(await probe(HASANI), probeBase.HASANI); assert.deepEqual(await probe(REG), probeBase.REG); assert.deepEqual(await probe(U31), probeBase.U31);
    assert.deepEqual((await call("GET", "/page-access/me", HASANI)).body, { enabled: false });
    } finally { flag("flag.page_access_v1", "1"); }
  });
  await ok("customers scope via «مدیریت فروش» (console ON): grant writes own/team/all + revert restores", async () => {
    flag("flag.sales_manager_console_v1", "1");
    const sub = (await call("GET", "/page-access/pages/customers/subjects", ADMIN)).body;
    const cand = sub.users.find((u) => u.scopeAvailable && !u.trainee);
    if (!cand) { console.log("   (no console expert on this copy; scope path skipped)"); return; }
    const target = cand.scope === "team" ? "all" : "team";
    const a0 = queryRow("SELECT COUNT(*) n FROM smc_audit WHERE section='access'").n;
    const r = await call("POST", "/page-access/pages/customers/grants", ADMIN, { subjectKind: "user", userIds: [cand.id], level: "view", scope: target, baseVersion: sub.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sub2 = (await call("GET", "/page-access/pages/customers/subjects", ADMIN)).body;
    assert.equal(sub2.users.find((u) => u.id === cand.id).scope, target);
    const h = (await call("GET", "/page-access/pages/customers/history", ADMIN)).body;
    assert.equal((await call("POST", "/page-access/pages/customers/revert", ADMIN, { batch: h.revertBatch })).status, 200);
    const sub3 = (await call("GET", "/page-access/pages/customers/subjects", ADMIN)).body;
    assert.equal(sub3.users.find((u) => u.id === cand.id).scope, cand.scope);
    assert.ok(queryRow("SELECT COUNT(*) n FROM smc_audit WHERE section='access'").n === a0 + 2, "console history shows both changes");
    flag("flag.sales_manager_console_v1", null);
  });
  await ok("guarded tables untouched (contracts, loan_plans, team_sales_config, notification_settings, users, roles)", async () => {
    for (const t of guarded) assert.equal(hash(`SELECT * FROM ${t} ORDER BY rowid`), guardBefore[t], `${t} changed`);
  });
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`page-access: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

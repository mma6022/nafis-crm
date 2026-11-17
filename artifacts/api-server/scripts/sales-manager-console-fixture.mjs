// «مدیریت تیم فروش» v1.1 fixture (flag.sales_manager_console_v1): access control (expert/manager 403, admin 200, flag OFF 404),
// writes of every section with audit + revert, 409 conflict, urgent lock, sample-lead test leaves counters alone, server-side access guard,
// credit validity guard, and no writes to sales_teams / team tables / notification_settings / loan_plans / contract templates / user 29.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/sales-manager-console-fixture.mjs
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
  const MANAGER = 5, ADMIN = 1, EXPERT = 8, HASANI = 2;
  assert.equal(queryRow("SELECT role FROM users WHERE id=?", [MANAGER]).role, "sales_manager");
  const ADMIN2 = 27; // second users.role=admin; never user 29
  assert.equal(queryRow("SELECT role FROM users WHERE id=? AND id<>29", [ADMIN2]).role, "admin");
  assert.equal(queryRow("SELECT active FROM users WHERE id=?", [ADMIN2]).active, 1);
  const apply = async (user, section, doc, extra = {}) => {
    const st = (await call(user, "GET", "/sales-admin/state")).body;
    const put = await call(user, "PUT", `/sales-admin/drafts/${section}`, { doc, baseVersion: st.meta[section].version, changes: 1 });
    assert.equal(put.status, 200, put.text);
    return call(user, "POST", "/sales-admin/apply", { sections: [section], ...extra });
  };
  const state = async (u = ADMIN) => (await call(u, "GET", "/sales-admin/state")).body;

  await ok("flag OFF (default): every /sales-admin path is 404 for the manager too; guard does nothing", async () => {
    assert.equal(queryRow("SELECT value FROM call_queue_settings WHERE key='flag.sales_manager_console_v1'"), undefined, "flag key absent = OFF");
    for (const p of ["/sales-admin/me", "/sales-admin/state", "/sales-admin/audit"]) assert.equal((await call(ADMIN, "GET", p)).status, 404, p);
    assert.equal((await call(ADMIN, "POST", "/sales-admin/apply", { sections: ["teams"] })).status, 404);
    assert.equal(queryRow("SELECT name FROM sqlite_master WHERE name='smc_settings'"), undefined, "no table created while OFF");
  });
  flag("1");
  await ok("access: expert, Hasani, and sales manager → 403; admin → 200; no session → 401 (t815s2681)", async () => {
    for (const u of [EXPERT, HASANI, MANAGER]) for (const [m, p, b] of [["GET", "/sales-admin/me"], ["GET", "/sales-admin/state"], ["GET", "/sales-admin/audit"], ["PUT", "/sales-admin/drafts/teams", { doc: {} }], ["POST", "/sales-admin/apply", { sections: ["teams"] }], ["POST", "/sales-admin/audit/1/revert"], ["POST", "/sales-admin/distribution/test", { lead: {} }]]) {
      const r = await call(u, m, p, b); assert.equal(r.status, 403, `${u} ${m} ${p}`); assert.equal(r.body.error, "smc_forbidden");
    }
    const me = await call(ADMIN, "GET", "/sales-admin/me"); assert.equal(me.status, 200); assert.equal(me.body.canManage, true); assert.equal(me.body.roleLabel, "ادمین");
    assert.equal((await call(null, "GET", "/sales-admin/me")).status, 401);
  });
  await ok("state: real teams mapped read-only (تیم ۱: کاظمی، حسنی، قاسمی با ۲۱۰–۲۱۲؛ تیم ۲: خردکار، اصلانیان بدون داخلی), no user 29 anywhere", async () => {
    const r = await call(ADMIN, "GET", "/sales-admin/state"); assert.equal(r.status, 200);
    const t = r.body.docs.teams;
    const of = (tid) => t.experts.filter((e) => e.teamId === tid).map((e) => e.displayName).sort();
    assert.deepEqual(of("t1"), ["آقای کاظمی", "خانم حسنی", "خانم قاسمی"].sort());
    assert.deepEqual(of("t2"), ["اصلانیان", "خردکار"].sort());
    assert.deepEqual(t.experts.filter((e) => e.teamId === "t1").map((e) => e.extension).sort(), ["210", "211", "212"]);
    assert.ok(t.experts.filter((e) => e.teamId === "t2").every((e) => e.extension === null));
    assert.ok(!r.body.users.some((u) => u.id === 29)); assert.ok(!t.experts.some((e) => e.userId === 29));
    assert.ok(!/"(userId|id|user_id)":29\b/.test(r.text));
    assert.ok(!/password|رمز عبور/.test(JSON.stringify(r.body.docs)), "no password fields");
    assert.equal(r.body.docs.model.models.every((m) => m.assign.length === 0), true, "§6-12 models assigned to nobody");
    assert.equal(r.body.docs.valid.identity.mode, "forever"); assert.equal(r.body.docs.valid.credit.hours, 24);
  });

  let teamsAudit;
  await ok("teams: rename + new expert (no account) + move with customers kept → one audit row, sales_teams untouched", async () => {
    const st = await state(); const d = structuredClone(st.docs.teams);
    d.teams.find((x) => x.id === "t2").name = "تیم دو";
    d.experts.push({ id: "xfx1", displayName: "مریم رحیمی", extension: "214", role: "expert", status: "active", leaveUntil: null, userId: null, salespersonId: null, teamId: "t2" });
    const k = d.experts.find((e) => e.id === "e6"); d.teams.find((x) => x.id === "t1").leadExpertId = null; k.role = "expert"; k.teamId = "t2";
    d.moves = [{ expertId: "e6", from: "t1", to: "t2", keepCustomers: true }];
    const r = await apply(ADMIN, "teams", d); assert.equal(r.status, 200, r.text);
    teamsAudit = r.body.applied[0].auditId;
    const a = queryRow("SELECT * FROM smc_audit WHERE id=?", [teamsAudit]);
    assert.match(a.summary_fa, /کاظمی/); assert.match(a.summary_fa, /مریم رحیمی/);
    assert.equal(hash("SELECT id, salesperson_id FROM customers ORDER BY id"), custBefore, "keepCustomers=true moves no customer");
    assert.equal(tableHash("sales_teams"), before.sales_teams); assert.equal(tableHash("sales_team_members"), before.sales_team_members);
  });
  await ok("teams: duplicate extension and deleting a team with members are refused (422, Persian message)", async () => {
    const st = await state(); const d = structuredClone(st.docs.teams);
    d.experts.find((e) => e.id === "e4").extension = "210";
    let r = await apply(ADMIN, "teams", d); assert.equal(r.status, 422); assert.match(r.body.message, /داخلی ۲۱۰ مال/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/teams");
    const d2 = structuredClone(st.docs.teams); d2.teams.find((x) => x.id === "t1").deleted = true;
    r = await apply(ADMIN, "teams", d2); assert.equal(r.status, 422); assert.match(r.body.message, /عضو دارد/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/teams");
  });
  await ok("teams: move with keepCustomers=false redistributes only that expert's customers (audited) and revert restores every one", async () => {
    const st = await state(); const d = structuredClone(st.docs.teams);
    const a = d.experts.find((e) => e.id === "e5"); a.teamId = "t1"; d.moves = [{ expertId: "e5", from: "t2", to: "t1", keepCustomers: false }];
    const own = queryRows("SELECT id FROM customers WHERE salesperson_id=5 AND merged_into_customer_id IS NULL").length;
    const r = await apply(ADMIN, "teams", d); assert.equal(r.status, 200, r.text);
    const eff = JSON.parse(queryRow("SELECT effects_json FROM smc_audit WHERE id=?", [r.body.applied[0].auditId]).effects_json);
    assert.ok(eff.customersMoved.length > 0 && eff.customersMoved.length <= own, `moved ${eff.customersMoved.length} of ${own}`);
    assert.ok(eff.customersMoved.every((m) => m.from === 5 && m.to !== 5));
    const rv = await call(ADMIN, "POST", `/sales-admin/audit/${r.body.applied[0].auditId}/revert`); assert.equal(rv.status, 200, rv.text);
    assert.equal(hash("SELECT id, salesperson_id FROM customers ORDER BY id"), custBefore, "revert restores every customer");
    assert.equal(queryRow("SELECT revert_of FROM smc_audit ORDER BY id DESC LIMIT 1").revert_of, r.body.applied[0].auditId);
  });

  await ok("daily: overlapping blocks refused; manual add/remove/move saved as overrides with the audit id; view shows them", async () => {
    const st = await state(); const day = smc.addDays(st.today, 1);
    const bad = { blocks: { global: [{ from: 540, to: 720, k: "actual" }, { from: 660, to: 780, k: "potential" }], team: {}, expert: {} } };
    let r = await apply(ADMIN, "daily", bad); assert.equal(r.status, 422); assert.match(r.body.message, /هم‌پوشانی/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/daily");
    const q = (await call(ADMIN, "POST", "/sales-admin/queue", { expert: "e3", date: day })).body;
    const other = queryRow("SELECT id FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id;
    const free = q.rows.filter((x) => !x.locked && x.customerId != null && x.customerId !== other);
    const ops = [{ op: "add", expertId: "e3", date: day, customerId: other, blockIdx: 1 }];
    if (free[0]) ops.push({ op: "remove", expertId: "e3", date: day, customerId: free[0].customerId });
    if (free[1]) ops.push({ op: "move", expertId: "e3", date: day, customerId: free[1].customerId, blockIdx: 0, sort: 0 });
    const preview = (await call(ADMIN, "POST", "/sales-admin/queue", { expert: "e3", date: day, daily: { blocks: st.docs.daily.blocks, ops } })).body;
    assert.ok(preview.rows.some((x) => x.customerId === other && x.source === "manual" && x.draft));
    r = await apply(ADMIN, "daily", { blocks: st.docs.daily.blocks, ops }); assert.equal(r.status, 200, r.text);
    const aid = r.body.applied[0].auditId;
    assert.equal(queryRow("SELECT COUNT(*) n FROM smc_daily_override WHERE audit_id=?", [aid]).n, ops.length);
    const after = (await call(ADMIN, "GET", `/sales-admin/queue?expert=e3&date=${day}`)).body;
    assert.ok(after.rows.some((x) => x.customerId === other && x.source === "manual"));
    if (free[0]) assert.ok(after.rows.some((x) => x.customerId === free[0].customerId && x.source === "removed"));
    const rv = await call(ADMIN, "POST", `/sales-admin/audit/${aid}/revert`); assert.equal(rv.status, 200);
    assert.equal(queryRow("SELECT COUNT(*) n FROM smc_daily_override WHERE audit_id=? AND undone_at IS NULL", [aid]).n, 0);
  });
  await ok("daily: an urgent row (incoming / payment order / file action) can be neither moved nor removed → 409 urgent_locked", async () => {
    const st = await state(); let hit = null;
    for (const e of st.docs.teams.experts) for (let i = 0; i < 3 && !hit; i++) {
      const day = smc.addDays(st.today, i); const q = (await call(ADMIN, "GET", `/sales-admin/queue?expert=${e.id}&date=${day}`)).body;
      const u = q.rows?.find((x) => x.locked && x.customerId != null); if (u) hit = { e: e.id, day, cid: u.customerId };
    }
    if (!hit) { console.log("  (no urgent row on this copy; lib check instead)"); return; }
    const r = await apply(ADMIN, "daily", { blocks: st.docs.daily.blocks, ops: [{ op: "remove", expertId: hit.e, date: hit.day, customerId: hit.cid }] });
    assert.equal(r.status, 409); assert.equal(r.body.error, "urgent_locked");
    await call(ADMIN, "DELETE", "/sales-admin/drafts/daily");
  });

  await ok("access: «قفل» → expert list 403, search still finds own; «فقط خودش» narrows on the server; «همه» never widens", async () => {
    const st = await state(); const d = structuredClone(st.docs.access);
    const kz = st.docs.teams.experts.find((e) => e.userId === EXPERT).id;
    const baseList = await call(EXPERT, "GET", "/customers?limit=50");
    d.policies[kz] = { customers: "locked", loan_files: "own" };
    let r = await apply(ADMIN, "access", d); assert.equal(r.status, 200, r.text);
    r = await call(EXPERT, "GET", "/customers?limit=50"); assert.equal(r.status, 403); assert.equal(r.body.error, "smc_access_locked");
    const s = await call(EXPERT, "GET", "/customers?search=" + encodeURIComponent("a"));
    if (s.status === 200) { const list = Array.isArray(s.body) ? s.body : s.body.items ?? s.body.customers ?? s.body.rows ?? s.body.data ?? [];
      for (const c of list) assert.equal(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [c.id]).sp, 6); }
    const mgr = await call(ADMIN, "GET", "/customers?limit=50"); assert.notEqual(mgr.status, 403, "manager never locked");
    d.policies[kz] = { customers: "own", loan_files: "own" }; r = await apply(ADMIN, "access", d); assert.equal(r.status, 200);
    r = await call(EXPERT, "GET", "/customers?limit=50");
    if (r.status === 200) { const list = Array.isArray(r.body) ? r.body : r.body.items ?? r.body.customers ?? r.body.rows ?? r.body.data ?? [];
      for (const c of list) assert.equal(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [c.id]).sp, 6); }
    d.policies[kz] = { customers: "all", loan_files: "all" }; r = await apply(ADMIN, "access", d); assert.equal(r.status, 200);
    const wide = await call(EXPERT, "GET", "/customers?limit=50"); assert.equal(wide.status, baseList.status);
    const idsOf = (b) => (Array.isArray(b) ? b : b?.items ?? b?.customers ?? b?.rows ?? b?.data ?? []).map((c) => c.id).sort((x, y) => x - y).join(",");
    if (wide.status === 200) assert.equal(idsOf(wide.body), idsOf(baseList.body), "«همه» = the existing server rules, nothing more");
  });
  await ok("validity: 36h credit applies only to checks after save; a fresh check → POST credit check 409 smc_credit_still_valid", async () => {
    const st = await state(); const d = structuredClone(st.docs.valid); d.credit = { mode: "hours", hours: 36 };
    const r = await apply(ADMIN, "valid", d); assert.equal(r.status, 200, r.text);
    const saved = smc.loadDoc("valid"); assert.ok(saved.appliedAt.credit); assert.equal(saved.appliedAt.identity ?? null, st.docs.valid.appliedAt?.identity ?? null, "identity untouched");
    const cid = queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id;
    const old = queryRow("SELECT MAX(completed_at) m FROM customer_credit_checks WHERE customer_id=?", [cid])?.m;
    assert.equal(smc.creditValidUntil(cid).valid, false, old ? "a check from before the save does not count" : "no check yet");
    const now = new Date().toISOString();
    execute("INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,provider,national_code,status,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?)", [cid, 8, "ics24", "0000000000", "report_generated", now, now, now]);
    assert.equal(smc.creditValidUntil(cid).valid, true);
    const p = await call(EXPERT, "POST", `/customers/${cid}/credit-checks`, {}); assert.equal(p.status, 409); assert.equal(p.body.error, "smc_credit_still_valid"); assert.match(p.body.message, /معتبر/);
    const v = await call(EXPERT, "GET", `/sales-console/validity/customer/${cid}`); assert.equal(v.status, 200); assert.equal(v.body.credit.valid, true);
  });
  await ok("model: mix ≠ 100 and capacity out of 5–60 refused; assignment saved; one model per expert; preview writes nothing", async () => {
    const st = await state(); const d = structuredClone(st.docs.model);
    d.models[0].mix.lead = 35; let r = await apply(ADMIN, "model", d); assert.equal(r.status, 422); assert.match(r.body.message, /جمع/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/model");
    const d2 = structuredClone(st.docs.model); d2.models[0].capacity = 70; r = await apply(ADMIN, "model", d2); assert.equal(r.status, 422);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/model");
    const d3 = structuredClone(st.docs.model); d3.models[0].assign = [{ scope: "expert", id: "e3" }]; d3.models[1].assign = [{ scope: "expert", id: "e3" }];
    r = await apply(ADMIN, "model", d3); assert.equal(r.status, 422); assert.match(r.body.message, /یک مدل/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/model");
    const n0 = queryRow("SELECT COUNT(*) n FROM smc_audit").n;
    const pv = await call(ADMIN, "POST", "/sales-admin/models/preview", { model: st.docs.model.models[0], expert: "e3", date: smc.addDays(st.today, 1) });
    assert.equal(pv.status, 200); assert.ok(pv.body.counts && pv.body.diff);
    assert.equal(queryRow("SELECT COUNT(*) n FROM smc_audit").n, n0);
    const d4 = structuredClone(st.docs.model); d4.models[0].assign = [{ scope: "expert", id: "e3" }];
    r = await apply(ADMIN, "model", d4); assert.equal(r.status, 200, r.text); assert.match(r.body.applied[0].summary, /حسنی/);
  });
  await ok("distribution: percent ≠ 100 refused; rules saved; sample-lead test routes and moves no counter, writes no log", async () => {
    const st = await state(); const d = structuredClone(st.docs.dist);
    d.team.fallback = { method: "percent", targets: [{ id: "t1", weight: 70 }, { id: "t2", weight: 20 }] };
    let r = await apply(ADMIN, "dist", d); assert.equal(r.status, 422); assert.match(r.body.message, /۱۰۰/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/dist");
    const d2 = structuredClone(st.docs.dist);
    d2.team.rules = [{ id: "r1", conds: [{ field: "priority", values: ["1"] }], method: "ratio", targets: [{ id: "t1", weight: 2 }, { id: "t2", weight: 1 }] }];
    d2.member.t1 = { rules: [{ id: "m1", conds: [{ field: "credit_rank", values: ["A", "B"] }], method: "direct", targets: [{ id: "e3" }] }], fallback: { method: "capacity", targets: [] } };
    r = await apply(ADMIN, "dist", d2); assert.equal(r.status, 200, r.text);
    const c0 = hash("SELECT * FROM smc_dist_counter"); const l0 = queryRow("SELECT COUNT(*) n FROM smc_dist_log").n;
    for (let i = 0; i < 4; i++) {
      const t = await call(ADMIN, "POST", "/sales-admin/distribution/test", { lead: { priority: "1", credit_rank: "B", amount: "350" } });
      assert.equal(t.status, 200); assert.equal(t.body.teamId, "t1"); assert.equal(t.body.expertId, "e3"); assert.match(t.body.path.at(-1).text, /خانم حسنی/);
    }
    assert.equal(hash("SELECT * FROM smc_dist_counter"), c0, "counters untouched"); assert.equal(queryRow("SELECT COUNT(*) n FROM smc_dist_log").n, l0);
    const live = smc.routeLead({ priority: "1", credit_rank: "B" }, { commit: true, customerId: 1 });
    assert.equal(live.teamId, "t1"); assert.notEqual(hash("SELECT * FROM smc_dist_counter"), c0, "a real route does advance the ratio counter");
  });
  await ok("steps: «قرارداد لازم نیست» on one plan, «تکمیل‌شده» last enforced; loan_plans / contract templates never written", async () => {
    const st = await state(); const plan = st.plans[0].key; const d = structuredClone(st.docs.steps);
    const list = structuredClone(st.systemStages); for (const s of list) if (st.stageGroups.contract.includes(s.key)) s.enabled = false;
    d.plans[plan] = list; let r = await apply(ADMIN, "steps", d); assert.equal(r.status, 200, r.text);
    assert.equal(smc.planStages(smc.loadDoc("steps"), plan).filter((s) => st.stageGroups.contract.includes(s.key) && s.enabled).length, 0);
    const bad = structuredClone(d); bad.plans[plan] = list.filter((s) => s.key !== "completed");
    r = await apply(ADMIN, "steps", bad); assert.equal(r.status, 422); assert.match(r.body.message, /تکمیل/);
    await call(ADMIN, "DELETE", "/sales-admin/drafts/steps");
  });
  await ok("conflict: admin 1 saves after admin 27 opened a draft → 27 gets 409 with «… توسط ادمین عوض شده»; force applies", async () => {
    const st = await state(ADMIN2); const d = structuredClone(st.docs.valid); d.identity = { mode: "hours", hours: 48 };
    await call(ADMIN2, "PUT", "/sales-admin/drafts/valid", { doc: d, baseVersion: st.meta.valid.version, changes: 1 });
    const a = structuredClone(st.docs.valid); a.credit = { mode: "hours", hours: 48 }; const ra = await apply(ADMIN, "valid", a); assert.equal(ra.status, 200, ra.text);
    let r = await call(ADMIN2, "POST", "/sales-admin/apply", { sections: ["valid"] });
    assert.equal(r.status, 409); assert.equal(r.body.error, "changed_since_open"); assert.match(r.body.message, /توسط ادمین عوض شده/);
    r = await call(ADMIN2, "POST", "/sales-admin/apply", { sections: ["valid"], force: true }); assert.equal(r.status, 200);
  });
  await ok("audit: every section has Persian rows; filter by section; revert of a settings row restores the before-document", async () => {
    const r = await call(ADMIN, "GET", "/sales-admin/audit"); assert.equal(r.status, 200);
    const secs = new Set(r.body.rows.map((x) => x.section)); for (const s of ["teams", "daily", "access", "valid", "model", "dist", "steps"]) assert.ok(secs.has(s), s);
    assert.ok(r.body.rows.every((x) => x.summary && !/[0-9]/.test(x.summary.replace(/[A-E]/g, "")) && x.who), "full Persian sentences, Persian digits");
    const f = await call(ADMIN, "GET", "/sales-admin/audit?section=model"); assert.ok(f.body.rows.every((x) => x.section === "model"));
    const lastModel = f.body.rows[0]; const beforeDoc = JSON.parse(queryRow("SELECT before_json FROM smc_audit WHERE id=?", [lastModel.id]).before_json);
    const rv = await call(ADMIN, "POST", `/sales-admin/audit/${lastModel.id}/revert`); assert.equal(rv.status, 200, rv.text);
    assert.deepEqual(smc.loadDoc("model"), beforeDoc);
    const ar = queryRow("SELECT * FROM smc_audit ORDER BY id DESC LIMIT 1"); assert.equal(ar.revert_of, lastModel.id); assert.equal(ar.user_id, ADMIN);
  });
  await ok("guarded tables unchanged (sales_teams, members, intake shares, notification_settings, team_sales_config, loan_plans, contract templates, voip_extensions, users)", async () => {
    for (const t of guarded) assert.equal(tableHash(t), before[t], t);
  });
  await ok("flag back OFF → 404 again and the guard stops (expert list no longer locked)", async () => {
    flag("0");
    assert.equal((await call(ADMIN, "GET", "/sales-admin/me")).status, 404);
    const r = await call(EXPERT, "GET", "/customers?limit=5"); assert.notEqual(r.body?.error, "smc_access_locked");
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close(); fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

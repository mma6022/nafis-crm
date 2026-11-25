// t938u: «مدیریت فروش» access policies (customers & loan_files: own / team / all / locked)
// End-to-end fixture on a copy of masked DB with full middleware chain:
// requireAuth -> leadAnnotatorMask -> makeRegistrarWriteGuard -> expertLockdownGuard -> filesCarouselGuard -> router (incl. smcEnforceGuard).
// Usage: T938_FIXTURE_DB=/workspace/social-hub-send/run/sh.db NODE_ENV=production node scripts/run-bundled-fixture.mjs scripts/t938-smc-access-scope-fixture.mjs
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

const src = process.env.T938_FIXTURE_DB || "/workspace/social-hub-send/run/sh.db";
if (!fs.existsSync(src)) { console.log("SKIP (missing T938_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t938-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);

for (const k of Object.keys(process.env)) {
  if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK|KAVENEGAR|VOIP|ISSABEL/i.test(k)) delete process.env[k];
}
const SECRET = `fixture-only-${crypto.randomBytes(8).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath,
  NODE_ENV: "production",
  LOG_LEVEL: "warn",
  SESSION_SECRET: SECRET,
  SMS_DISABLED: "1",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9",
  AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder",
});

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
  const smcScope = await import("../src/lib/smc-access-scope.ts");
  const seg = await import("../src/lib/customer-segments.ts");
  const router = (await import("../src/routes/index.ts")).default;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use("/api", requireAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => db.crmDb), expertLockdownGuard, filesCarouselGuard, router);

  const sock = path.join(dir, "api.sock");
  server = app.listen(sock);
  await once(server, "listening");

  const call = (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({
      socketPath: sock,
      path: "/api" + p,
      method,
      headers: {
        Cookie: `crm_session=${tok}`,
        ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
      },
    }, (r) => {
      let s = "";
      r.on("data", (c) => (s += c));
      r.on("end", () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: r.statusCode, body: j }); });
    });
    rq.on("error", reject);
    if (data) rq.write(data);
    rq.end();
  });

  const session = (uid) => {
    const t = crypto.randomBytes(24).toString("base64url");
    const h = crypto.createHmac("sha256", SECRET).update(t).digest("hex");
    const now = new Date();
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [
      h, uid, new Date(+now + 864e5).toISOString(), now.toISOString(),
    ]);
    return t;
  };
  const flag = (k, v) => v == null
    ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);

  const ADMIN = session(1);
  const U28 = session(28); // sp=20 (Team 2 with sp=5)
  const HASANI = session(2); // sp=3 (Team 1 with sp=6, sp=4)
  const hash = (sql) => { try { return crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex"); } catch { return "absent"; } };
  const guarded = ["team_sales_config", "notification_settings", "contracts", "users"];
  const before = Object.fromEntries(guarded.map((t) => [t, hash(`SELECT * FROM ${t} ORDER BY rowid`)]));

  // Find concrete customers & loan_applications for sp=20 (own), sp=5 (team 2), sp=6 (team 1), sp=4 (team 1)
  const cidOwn = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=20 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
  const cidTeam2 = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=5 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
  const cidTeam1 = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
  const cidGhasemi = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=4 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);

  const appOwn = queryRow("SELECT la.id, la.customer_id FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.deleted_at IS NULL AND c.merged_into_customer_id IS NULL AND c.salesperson_id=20 ORDER BY la.id DESC LIMIT 1");
  const appTeam2 = queryRow("SELECT la.id, la.customer_id FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.deleted_at IS NULL AND c.merged_into_customer_id IS NULL AND c.salesperson_id=5 ORDER BY la.id DESC LIMIT 1");
  const appTeam1 = queryRow("SELECT la.id, la.customer_id FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.deleted_at IS NULL AND c.merged_into_customer_id IS NULL AND c.salesperson_id=6 ORDER BY la.id DESC LIMIT 1");
  assert.ok(cidOwn && cidTeam2 && cidTeam1 && cidGhasemi, "fixture needs customers across sp 20, 5, 6, 4");
  assert.ok(appOwn && appTeam2 && appTeam1, "fixture needs loan_applications across sp 20, 5, 6");

  // Ensure prerequisite live flags match today's production environment
  flag("flag.expert_lockdown", "1");
  flag("flag.multi_team_v1", "1");
  flag("flag.daily_customer_inline_v1", "1");
  flag("flag.sales_fixes_480000", null); // enabled unless '0'
  flag("flag.bale_view_as_v1", "1");
  flag("bale_view_as.user.2", "8,3");

  const spOf = (cid) => Number(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [cid])?.sp);
  const appSpOf = (aid) => Number(queryRow("SELECT c.salesperson_id sp FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.id=?", [aid])?.sp);

  // Helper to set policy for e20 via /sales-admin/apply
  const setPolicy = async (customersLevel, loanFilesLevel) => {
    const st = await call("GET", "/sales-admin/state", ADMIN);
    assert.equal(st.status, 200);
    const d = structuredClone(st.body.docs.access);
    d.policies.e20 = { customers: customersLevel, loan_files: loanFilesLevel };
    let r = await call("PUT", "/sales-admin/drafts/access", ADMIN, { doc: d, baseVersion: st.body.meta.access.version, changes: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call("POST", "/sales-admin/apply", ADMIN, { sections: ["access"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };

  await ok("flag OFF: smcAccessScope returns none and creates no smc_* tables", async () => {
    flag("flag.sales_manager_console_v1", "0");
    flag("flag.sales_admin_merge_v12", "0");
    assert.equal((await call("GET", "/sales-admin/state", ADMIN)).status, 404);
    assert.equal((await call("GET", "/customers?limit=50", U28)).status, 403);
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam2}`, U28)).status, 403);
    assert.equal((await call("GET", `/loan-applications/${appTeam2.id}`, U28)).status, 404);
  });

  // Enable SMC console flags
  flag("flag.sales_manager_console_v1", "1");
  flag("flag.sales_admin_merge_v12", "1");

  await ok("own/own: user 28 sees strictly own customers and own loan files", async () => {
    await setPolicy("own", "own");
    const mc = await call("GET", "/sales-fixes/my-customers", U28);
    assert.equal(mc.status, 200);
    assert.ok(mc.body.items.every((x) => spOf(x.id) === 20));
    assert.equal((await call("GET", "/customers?limit=50", U28)).status, 403);
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam2}`, U28)).status, 403);
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam1}`, U28)).status, 403);
    const cases = await call("GET", "/sales-fixes/cases", U28);
    assert.equal(cases.status, 200);
    assert.ok(cases.body.cases.every((x) => appSpOf(x.id) === 20));
    assert.equal((await call("GET", `/loan-applications/${appTeam2.id}`, U28)).status, 404);
  });

  await ok("customers=team, loan_files=own (no re-login): Team 2 customers open read-only; Team 1 closed; loan files stay own", async () => {
    await setPolicy("team", "own");
    const mc = await call("GET", "/sales-fixes/my-customers", U28);
    assert.equal(mc.status, 200);
    const sps = new Set(mc.body.items.map((x) => spOf(x.id)));
    assert.ok(sps.has(20) && sps.has(5), `expected Team 2 sps {20,5}, got ${[...sps]}`);
    assert.ok(!sps.has(6) && !sps.has(3) && !sps.has(4), `Team 1 leaked: ${[...sps]}`);

    const list = await call("GET", "/customers?limit=50", U28);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listArr = Array.isArray(list.body) ? list.body : list.body.items ?? list.body.customers ?? [];
    assert.ok(listArr.length > 0 && listArr.every((x) => [20, 5].includes(spOf(x.id))));

    const srTeam2 = await call("GET", `/sales-fixes/search?q=${cidTeam2}`, U28);
    assert.equal(srTeam2.status, 200);
    assert.ok(srTeam2.body.items.some((x) => x.id === cidTeam2));
    const srTeam1 = await call("GET", `/sales-fixes/search?q=${cidTeam1}`, U28);
    assert.equal(srTeam1.status, 200);
    assert.ok(!srTeam1.body.items.some((x) => x.id === cidTeam1));

    const dci2 = await call("GET", `/daily-customer-inline/customers/${cidTeam2}`, U28);
    assert.equal(dci2.status, 200, JSON.stringify(dci2.body));
    assert.equal(dci2.body.access, "view");
    assert.equal(dci2.body.canPromote, false);
    assert.equal(dci2.body.canEditPriorityStatus, false);
    assert.equal(dci2.body.wallet, null);
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam1}`, U28)).status, 403);

    assert.equal((await call("GET", `/customers/${cidTeam2}`, U28)).status, 200, "GET /customers/:id");
    assert.equal((await call("GET", `/customers/${cidTeam1}`, U28)).status, 403);
    assert.equal((await call("GET", `/customers/${cidTeam2}/file-card`, U28)).status, 200, "GET /file-card");
    const cp2 = await call("GET", `/customers/${cidTeam2}/consult-profile`, U28);
    assert.equal(cp2.status, 200, "GET /consult-profile");
    assert.equal(cp2.body.canEdit, false);
    assert.equal((await call("GET", `/customers/${cidTeam2}/wallet`, U28)).status, 200, "GET /wallet");
    assert.equal((await call("GET", `/customers/${cidTeam1}/wallet`, U28)).status, 403);
    assert.equal((await call("GET", `/social-hub/customers/${cidTeam2}/today`, U28)).status, 200, "GET /social-hub/today");
    assert.ok([403, 404].includes((await call("GET", `/social-hub/customers/${cidTeam1}/today`, U28)).status));

    // Under expert_lockdown=1, /consultations/report stays locked; when expert_lockdown=0, consultations & report widen to Team 2, exclude Team 1
    assert.equal((await call("GET", "/consultations/report?limit=100", U28)).status, 403);
    flag("flag.expert_lockdown", "0");
    const cr = await call("GET", "/consultations/report?limit=100", U28);
    const cl = await call("GET", "/consultations?limit=100", U28);
    flag("flag.expert_lockdown", "1");
    assert.equal(cr.status, 200, "GET /consultations/report");
    assert.equal(cl.status, 200, "GET /consultations");
    assert.ok(cr.body.items.every((x) => [20, 5].includes(spOf(x.customerId))));
    const clArr = Array.isArray(cl.body) ? cl.body : cl.body.items ?? cl.body.consultations ?? [];
    assert.ok(clArr.every((x) => [20, 5].includes(spOf(x.customerId))));

    // Loan files stayed own!
    const cases = await call("GET", "/sales-fixes/cases", U28);
    assert.equal(cases.status, 200);
    assert.ok(cases.body.cases.every((x) => appSpOf(x.id) === 20));
    const las = await call("GET", "/loan-applications?limit=50", U28);
    assert.equal(las.status, 200);
    const laArr = Array.isArray(las.body) ? las.body : las.body.items ?? [];
    assert.ok(laArr.every((x) => appSpOf(x.id) === 20));
    assert.equal((await call("GET", `/loan-applications/${appTeam2.id}`, U28)).status, 404);
    assert.equal((await call("GET", `/multi-case/cases/${appTeam2.id}`, U28)).status, 404);
  });

  await ok("customers=own, loan_files=team: customers stay own; Team 2 loan files open; Team 1 closed", async () => {
    await setPolicy("own", "team");
    const mc = await call("GET", "/sales-fixes/my-customers", U28);
    assert.equal(mc.status, 200);
    assert.ok(mc.body.items.every((x) => spOf(x.id) === 20));
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam2}`, U28)).status, 403);

    const cases = await call("GET", "/sales-fixes/cases", U28);
    assert.equal(cases.status, 200);
    assert.ok(cases.body.cases.some((x) => appSpOf(x.id) === 5), "Team 2 case visible");
    assert.ok(cases.body.cases.every((x) => [20, 5].includes(appSpOf(x.id))), "no Team 1 case");

    assert.equal((await call("GET", `/loan-applications/${appTeam2.id}`, U28)).status, 200);
    assert.equal((await call("GET", `/loan-applications/${appTeam1.id}`, U28)).status, 404);
    assert.equal((await call("GET", `/multi-case/cases/${appTeam2.id}`, U28)).status, 200);
    assert.ok([403, 404].includes((await call("GET", `/multi-case/cases/${appTeam1.id}`, U28)).status));

    // Search by Team 2 customer with case returns that customer with Team 2 cases; customer without loan_files=team wouldn't
    const srApp = await call("GET", `/sales-fixes/search?q=${appTeam2.customer_id}`, U28);
    assert.equal(srApp.status, 200);
    const hit = srApp.body.items.find((x) => x.id === Number(appTeam2.customer_id));
    assert.ok(hit && hit.cases.length >= 1, "search finds Team 2 customer via Team 2 loan_files scope");
  });

  await ok("customers=all, loan_files=all: Team 1 + Team 2 customers and loan files visible read-only", async () => {
    await setPolicy("all", "all");
    const mc = await call("GET", "/sales-fixes/my-customers?limit=200", U28);
    assert.equal(mc.status, 200);
    const ownTotal = Number(queryRow("SELECT COUNT(*) n FROM customers WHERE salesperson_id=20 AND merged_into_customer_id IS NULL").n);
    const allTotal = Number(queryRow("SELECT COUNT(*) n FROM customers WHERE merged_into_customer_id IS NULL").n);
    assert.equal(mc.body.total, allTotal);
    assert.ok(mc.body.total > ownTotal);
    const sps = new Set(mc.body.items.map((x) => spOf(x.id)));
    assert.ok(sps.has(6) && sps.has(3) && sps.has(4), `expected multi-team sps, got ${[...sps]}`);

    const list = await call("GET", "/customers?limit=50", U28);
    assert.equal(list.status, 200);
    const listArr = Array.isArray(list.body) ? list.body : list.body.items ?? list.body.customers ?? [];
    assert.ok(listArr.some((x) => spOf(x.id) !== 20));

    const sr1 = await call("GET", `/sales-fixes/search?q=${cidTeam1}`, U28);
    assert.equal(sr1.status, 200);
    assert.ok(sr1.body.items.some((x) => x.id === cidTeam1));

    const dci1 = await call("GET", `/daily-customer-inline/customers/${cidTeam1}`, U28);
    assert.equal(dci1.status, 200);
    assert.equal(dci1.body.access, "view");
    assert.equal(dci1.body.canPromote, false);
    assert.equal(dci1.body.canEditPriorityStatus, false);
    assert.equal(dci1.body.wallet, null);

    assert.equal((await call("GET", `/customers/${cidTeam1}`, U28)).status, 200);
    assert.equal((await call("GET", `/loan-applications/${appTeam1.id}`, U28)).status, 200);
    assert.equal((await call("GET", `/multi-case/cases/${appTeam1.id}`, U28)).status, 200);
    const cases = await call("GET", "/sales-fixes/cases", U28);
    assert.equal(cases.status, 200);
    assert.ok(cases.body.cases.some((x) => appSpOf(x.id) === 6));

    // Customer segments scope follows customers=all
    const u28Obj = queryRow("SELECT id, role, salesperson_id salespersonId FROM users WHERE id=28");
    const segScope = seg.actorScope({ ...u28Obj, permissions: [], customerScope: "assigned" });
    assert.equal(segScope?.kind, "all");
  });

  await ok("writes/mutations on non-own customers/files stay strictly blocked even under all/all", async () => {
    assert.equal((await call("PATCH", `/customers/${cidTeam1}`, U28, { name: "x" })).status, 403);
    assert.equal((await call("POST", `/daily-customer-inline/customers/${cidTeam1}/notes`, U28, { body: "test" })).status, 403);
    assert.ok([403, 404].includes((await call("POST", `/customers/${cidTeam1}/calls`, U28, { note: "test" })).status));
    assert.equal((await call("POST", `/customers/${cidTeam1}/reminders`, U28, { title: "test", dueAt: new Date(Date.now() + 3600e3).toISOString() })).status, 403);
    assert.equal((await call("PATCH", `/customers/${cidTeam1}/consult-profile`, U28, { jobType: "free" })).status, 403);
    assert.equal((await call("POST", `/customers/${cidTeam1}/file-card`, U28, { body: "test" })).status, 403);
    assert.equal((await call("POST", `/customers/${cidTeam1}/wallet/cash-payment`, U28, { amountToman: "10000" })).status, 403);
    assert.ok([403, 404].includes((await call("POST", `/social-hub/customers/${cidTeam1}/send`, U28, { messageId: 1 })).status));
    assert.ok([403, 404].includes((await call("PATCH", `/loan-applications/${appTeam1.id}`, U28, { notes: "test" })).status));
  });

  await ok("immediate revert to own/own without re-login and locked still blocks", async () => {
    await setPolicy("own", "own");
    assert.equal((await call("GET", `/daily-customer-inline/customers/${cidTeam1}`, U28)).status, 403);
    assert.equal((await call("GET", `/loan-applications/${appTeam1.id}`, U28)).status, 404);

    await setPolicy("locked", "locked");
    const r = await call("GET", "/customers?limit=50", U28);
    assert.equal(r.status, 403);
    assert.ok(["smc_access_locked", "expert_lockdown"].includes(r.body.error), r.body.error);
    await setPolicy("own", "own");
  });

  await ok("bale_view_as (Hasani user 2 -> 8,3) still works with smc own and team", async () => {
    const st = await call("GET", "/sales-admin/state", ADMIN);
    const d = structuredClone(st.body.docs.access);
    const hKey = st.body.docs.teams.experts.find((e) => e.userId === 2).id;
    d.policies[hKey] = { customers: "own", loan_files: "own" };
    await call("PUT", "/sales-admin/drafts/access", ADMIN, { doc: d, baseVersion: st.body.meta.access.version, changes: 1 });
    assert.equal((await call("POST", "/sales-admin/apply", ADMIN, { sections: ["access"] })).status, 200);
    // Hasani sees Kazemi (sp=6) and Ghasemi (sp=4) customers via bale_view_as even when smc=own (and Team 2 stays blocked)
    assert.equal((await call("GET", `/customers/${cidTeam1}`, HASANI)).status, 200);
    assert.equal((await call("GET", `/customers/${cidGhasemi}`, HASANI)).status, 200);
    assert.equal((await call("GET", `/customers/${cidTeam2}`, HASANI)).status, 403);
    // Also when Hasani has smc=team, bale_view_as + team both work cleanly
    d.policies[hKey] = { customers: "team", loan_files: "own" };
    await call("PUT", "/sales-admin/drafts/access", ADMIN, { doc: d, baseVersion: st.body.meta.access.version + 1, changes: 1 });
    assert.equal((await call("POST", "/sales-admin/apply", ADMIN, { sections: ["access"] })).status, 200);
    assert.equal((await call("GET", `/customers/${cidTeam1}`, HASANI)).status, 200);
    assert.equal((await call("GET", `/customers/${cidTeam2}`, HASANI)).status, 403);
  });

  await ok("user 29 is never widened even if smc_settings contains a policy", async () => {
    const fake29 = { id: 29, role: "salesperson", salespersonId: 99, customerScope: "assigned" };
    assert.equal(smcScope.smcAccessScope(fake29, "customers").kind, "none");
    assert.equal(smcScope.smcAccessScope(fake29, "loan_files").kind, "none");
  });

  await ok("guarded live tables untouched", async () => {
    for (const t of guarded) {
      assert.equal(hash(`SELECT * FROM ${t} ORDER BY rowid`), before[t], `${t} changed`);
    }
  });
} finally {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`t938-smc-access-scope: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

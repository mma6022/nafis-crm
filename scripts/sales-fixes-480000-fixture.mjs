// SALES-FIXES 480000 fixture (Mohammad t810u). In-process: the real /api chain (requireAuth → lead mask → registrar guard →
// expertLockdownGuard → filesCarouselGuard → routes) on a throwaway COPY of a masked DB, real session rows on the copy only,
// fetch stubbed (0 network). Bugs 1 (status any number of times), 2 (owner priority), 3 (reminders from list / مشتریان من / case),
// 4 (live incoming in «اکنون», unknown → name → own customer), 5 (popup feed off), 7 (lists open, own scope, lockdown kept),
// 8 (own cases), 9 (own search), and every kill switch ('0' → old behaviour). Never user 29. Prints ids/codes only.
//   SF480_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/sales-fixes-480000-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
globalThis.__DatabaseSync = DatabaseSync;
let net = 0; globalThis.fetch = async () => { net++; throw new Error("no network in fixture"); };
const src = process.env.SF480_FIXTURE_DB || process.env.DQ_FIXTURE_DB;
if (!src) { console.log("SKIP (set SF480_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf480-fx-"));
const dbPath = path.join(dir, "crm.db"); fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/IPPANEL|TELEGRAM|SMS|RELAY|BALE|OPENAI|DEEPSEEK|KAVENEGAR|VOIP|ISSABEL/i.test(k)) delete process.env[k];
const SECRET = `fixture-only-${crypto.randomBytes(8).toString("hex")}-not-a-real-secret-0123456789`;
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn", SESSION_SECRET: SECRET, SMS_DISABLED: "1",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-placeholder" });
let passed = 0, failed = 0;
const ok = async (n, f) => { try { await f(); passed++; console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "::", String(e?.message || e).split("\n")[0].slice(0, 160)); } };
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
  const router = (await import("../src/routes/index.ts")).default;
  const dp = await import("../src/lib/daily-plan.ts");
  const dq = await import("../src/lib/dci-queue.ts");
  const np = await import("../src/lib/nonp1-transfer.ts");
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use("/api", requireAuth, leadAnnotatorMask, makeRegistrarWriteGuard(() => db.crmDb), expertLockdownGuard, filesCarouselGuard, router);
  const sock = path.join(dir, "api.sock"); server = app.listen(sock); await once(server, "listening");
  const http = await import("node:http");
  const call = (method, p, tok, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ socketPath: sock, path: "/api" + p, method, headers: { Cookie: `crm_session=${tok}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (r) => {
      let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: r.statusCode, body: j }); });
    }); rq.on("error", reject); if (data) rq.write(data); rq.end();
  });
  const session = (uid) => { const t = crypto.randomBytes(24).toString("base64url"); const h = crypto.createHmac("sha256", SECRET).update(t).digest("hex");
    const now = new Date(); execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)", [h, uid, new Date(+now + 864e5).toISOString(), now.toISOString()]); return t; };
  const flag = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const SF = ["flag.sf480_owner_priority", "flag.sf480_owner_status", "flag.sf480_open_lists", "flag.sf480_no_popups", "flag.sf480_incoming_now", "flag.sf480_reactivate_keep_owner"];
  const flagKeysBefore = queryRows("SELECT key FROM call_queue_settings WHERE key LIKE 'flag.%' ORDER BY key").map((r) => r.key);
  assert.equal(SF.filter((k) => flagKeysBefore.includes(k)).length, 0, "no sf480 rows in the copy (kill switches default ON by absence)");
  const u8 = queryRow("SELECT id, salesperson_id sp FROM users WHERE id=8 AND active=1");
  const hasaniId = Number(queryRow("SELECT id FROM users WHERE salesperson_id=3 AND role='salesperson' AND active=1 AND id<>29 ORDER BY id LIMIT 1").id);
  assert.ok(u8 && Number(u8.sp) === 6, "user 8 = sp 6");
  const E = session(8), H = session(hasaniId);
  const elOn = queryRow("SELECT value FROM call_queue_settings WHERE key='flag.expert_lockdown'")?.value;
  const spOf = (cid) => Number(queryRow("SELECT salesperson_id sp FROM customers WHERE id=?", [cid])?.sp);
  const usedClosers = new Set();
  const closerClean = (wantPri) => {
    const priSql = wantPri ? "AND priority=?" : "AND priority IN (2,3)";
    const rows = queryRows(`SELECT id, priority p FROM customers WHERE salesperson_id=3 AND status='in_progress' AND merged_into_customer_id IS NULL ${priSql} ORDER BY id DESC`, wantPri ? [wantPri] : []);
    const hit = rows.find((r) => !usedClosers.has(Number(r.id)) && np.openCaseReason(Number(r.id)) == null);
    assert.ok(hit, `need a closer non-P1 customer with no open case (pri=${wantPri ?? "2|3"})`);
    usedClosers.add(Number(hit.id));
    return Number(hit.id);
  };
  // ---------- bug 1: status any number of times (own expert, cancelled ↔ others)
  await ok("bug1 own expert (user 8) changes status ×7 incl. leaving «لغو» with a plain PATCH", async () => {
    const cid = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND COALESCE(priority,0)<>1 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
    for (const s of ["cancelled", "in_progress", "completed", "in_progress", "cancelled", "completed", "in_progress"]) {
      const r = await call("PATCH", `/customers/${cid}`, E, { status: s }); assert.equal(r.status, 200, `→ ${s}: ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
    }
    assert.equal(queryRow("SELECT status FROM customers WHERE id=?", [cid]).status, "in_progress"); assert.equal(spOf(cid), 6);
    assert.ok(queryRow("SELECT COUNT(*) n FROM customer_reactivations WHERE customer_id=?", [cid]).n >= 1, "reactivation audited");
  });
  let stayCid = null;
  await ok("bug1 closer (sp 3): cancel → «در حال انجام» stays with the closer (t812s2668, no auto-move to Kazemi)", async () => {
    const cid = stayCid = closerClean();
    assert.equal((await call("PATCH", `/customers/${cid}`, H, { status: "cancelled" })).status, 200);
    const r = await call("PATCH", `/customers/${cid}`, H, { status: "in_progress" }); assert.equal(r.status, 200, `${r.status} ${r.body?.code || ""}`);
    assert.equal(spOf(cid), 3, `stayed with closer, got sp ${spOf(cid)}`);
    assert.equal(queryRow("SELECT COUNT(*) n FROM customer_priority_history WHERE customer_id=? AND source='nonp1_auto_transfer' AND reason='reactivation'", [cid]).n, 0);
    // the closer can still write afterwards (no 403 from losing ownership)
    const r2 = await call("PATCH", `/customers/${cid}`, H, { status: "cancelled" }); assert.equal(r2.status, 200, `second write ${r2.status} ${r2.body?.code || ""}`);
    assert.equal((await call("PATCH", `/customers/${cid}`, H, { status: "in_progress" })).status, 200);
    assert.equal(spOf(cid), 3);
  });
  await ok("bug1 closer later changes a reactivated P2/P3 to another non-1 priority → still auto-moves to Kazemi (non-P1 rule unchanged)", async () => {
    const cid = closerClean();
    const pri = Number(queryRow("SELECT priority p FROM customers WHERE id=?", [cid]).p);
    const next = pri === 2 ? 3 : 2;
    assert.equal((await call("PATCH", `/customers/${cid}`, H, { status: "cancelled" })).status, 200);
    assert.equal((await call("PATCH", `/customers/${cid}`, H, { status: "in_progress" })).status, 200);
    assert.equal(spOf(cid), 3, "still closer after reactivation");
    const r = await call("PATCH", `/customers/${cid}`, H, { priority: next }); assert.equal(r.status, 200, `${r.status} ${r.body?.code || ""}`);
    assert.equal(spOf(cid), 6, "non-P1 priority change still moves to qualifier");
  });
  await ok("bug1 kill switch flag.sf480_reactivate_keep_owner='0' → reactivation auto-moves to Kazemi again", async () => {
    const cid = stayCid; assert.ok(cid, "reuses the closer customer that stayed after reactivation");
    assert.equal((await call("PATCH", `/customers/${cid}`, H, { status: "cancelled" })).status, 200);
    flag("flag.sf480_reactivate_keep_owner", "0");
    const r = await call("PATCH", `/customers/${cid}`, H, { status: "in_progress" }); flag("flag.sf480_reactivate_keep_owner", null);
    assert.equal(r.status, 200, `${r.status} ${r.body?.code || ""}`);
    assert.equal(spOf(cid), 6, `old rule should move to Kazemi, got sp ${spOf(cid)}`);
    assert.ok(queryRow("SELECT COUNT(*) n FROM customer_priority_history WHERE customer_id=? AND source='nonp1_auto_transfer' AND reason='reactivation'", [cid]).n >= 1);
  });
  await ok("bug1 kill switch flag.sf480_owner_status='0' → old 409 reactivation_required", async () => {
    const cid = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND COALESCE(priority,0)<>1 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1 OFFSET 1").id);
    assert.equal((await call("PATCH", `/customers/${cid}`, E, { status: "cancelled" })).status, 200);
    flag("flag.sf480_owner_status", "0"); const r = await call("PATCH", `/customers/${cid}`, E, { status: "in_progress" }); flag("flag.sf480_owner_status", null);
    assert.equal(r.status, 409); assert.equal(r.body?.code, "reactivation_required");
    assert.equal((await call("PATCH", `/customers/${cid}`, E, { status: "in_progress" })).status, 200);
  });
  await ok("bug1 another expert still cannot change the status (scope)", async () => {
    const cid = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=3 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1").id);
    const r = await call("PATCH", `/customers/${cid}`, E, { status: "completed" }); assert.ok([403, 404].includes(r.status), String(r.status));
  });
  // ---------- bug 2: priority
  const promoP1 = queryRow(`SELECT cu.id FROM customers cu WHERE cu.salesperson_id=3 AND cu.priority=1 AND cu.status='in_progress' AND cu.merged_into_customer_id IS NULL AND
    (SELECT source FROM customer_priority_history h WHERE h.customer_id=cu.id AND h.new_priority=1 ORDER BY id DESC LIMIT 1) IN ('promote','expert_upgrade') ORDER BY cu.id LIMIT 2`);
  await ok("bug2 kill switch '0' → owner lowering a promote-P1 is the old 403", async () => {
    if (!promoP1) { console.log("   (no promote-P1 customer in this copy — skipped)"); return; }
    flag("flag.sf480_owner_priority", "0"); const r = await call("PATCH", `/customers/${promoP1.id}`, H, { priority: 2 }); flag("flag.sf480_owner_priority", null);
    assert.equal(r.status, 403);
  });
  await ok("bug2 owner lowers a P1 that came from promote/expert_upgrade (was 403 p1_revert_admin_only)", async () => {
    if (!promoP1) { console.log("   (no promote-P1 customer in this copy — skipped)"); return; }
    const r = await call("PATCH", `/customers/${promoP1.id}`, H, { priority: 2 }); assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 80)}`);
    assert.ok(queryRow("SELECT COUNT(*) n FROM customer_priority_history WHERE customer_id=? AND new_priority=2", [promoP1.id]).n >= 1, "logged in priority history");
  });
  await ok("bug2 owner changes priority ×4 in a row (P3/P2)", async () => {
    const cid = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND status='in_progress' AND priority IN (2,3) AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1").id);
    for (const p of [3, 2, 3, 2]) { const r = await call("PATCH", `/customers/${cid}`, E, { priority: p }); assert.equal(r.status, 200, `P${p}: ${r.status} ${r.body?.code || r.body?.error || ""}`); }
    assert.equal(spOf(cid), 6, "still own");
  });
  await ok("bug2 another expert cannot change the priority", async () => {
    const cid = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=3 AND status='in_progress' AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1").id);
    const r = await call("PATCH", `/customers/${cid}`, E, { priority: 3 }); assert.ok([403, 404].includes(r.status), String(r.status));
  });
  // ---------- bug 3: reminders
  const own = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
  const oth = Number(queryRow("SELECT id FROM customers WHERE salesperson_id=3 AND merged_into_customer_id IS NULL ORDER BY id DESC LIMIT 1").id);
  const kase = queryRow(`SELECT la.id, la.customer_id cid FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE c.salesperson_id=6 AND la.deleted_at IS NULL
    AND la.status<>'rejected' AND la.stage<>'completed' ORDER BY la.id DESC LIMIT 1`);
  let at = null;
  const rem = (cid, extra = {}) => call("POST", "/reminders", E, { customerId: cid, subject: "sf480-fx", message: "sf480 fixture reminder", remindAt: at, ...extra });
  await ok("bug3 reminder for an own customer (daily list / «مشتریان من») = 201", async () => {
    let r; for (let d = 1; d <= 9 && (!r || r.status !== 201); d++) { at = new Date(Date.now() + d * 864e5); at.setUTCHours(7, 0, 0, 0); at = at.toISOString(); r = await rem(own); }
    assert.equal(r.status, 201, `${r.status} ${JSON.stringify(r.body)?.slice(0, 100)}`);
  });
  await ok("bug3 case-scoped reminder from a «پرونده‌های تسهیلات» page = 201", async () => {
    assert.ok(kase, "own open case"); const r = await rem(Number(kase.cid), { loanApplicationId: Number(kase.id), caseScope: "case" }); assert.equal(r.status, 201, `${r.status} ${JSON.stringify(r.body)?.slice(0, 100)}`);
  });
  await ok("bug3 another expert's customer stays 403", async () => { assert.equal((await rem(oth)).status, 403); });
  await ok("bug3 the reminder form's customer search is own-scoped (/sales-fixes/search)", async () => {
    const nm = String(queryRow("SELECT name FROM customers WHERE id=?", [own]).name || "").trim().split(/\s+/).pop();
    const r = await call("GET", `/sales-fixes/search?q=${encodeURIComponent(nm || String(own))}`, E); assert.equal(r.status, 200);
    assert.ok(r.body.items.every((x) => spOf(x.id) === 6), "own only"); assert.ok(r.body.items.every((x) => Array.isArray(x.cases)), "cases per hit");
    const r2 = await call("GET", `/sales-fixes/search?q=${oth}`, E); assert.ok(!r2.body.items.some((x) => x.id === oth));
  });
  // ---------- bug 4: live incoming in «اکنون»
  await ok("bug4 a live incoming call older than the urgent window stays urgent in «اکنون»; '0' → old rule", async () => {
    flag("flag.dci_queue_v21.user.8", "1"); flag("flag.daily_plan", "1");
    const d = new Date(); let NOW = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 50));
    while ([4, 5].includes(new Date(+NOW + 12600e3).getUTCDay())) NOW = new Date(+NOW + 864e5); // Thu/Fri off → next Sat–Wed
    const P = ["customers.view", "customers.update", "calls.create", "calls.view", "payment_orders.view", "bank_accounts.view"];
    const kz = { id: 8, role: "salesperson", salespersonId: 6, fullName: "kz", permissions: P, customerScope: "assigned", active: true };
    const cust = queryRow("SELECT id, phone FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL AND phone IS NOT NULL ORDER BY id DESC LIMIT 1 OFFSET 3");
    const mx = Number(queryRow("SELECT COALESCE(MAX(id),0) m FROM voip_after_call_events").m);
    const t = new Date(+NOW - 95 * 60e3).toISOString();
    const ins = (id, phone, cid) => execute(`INSERT INTO voip_after_call_events(id,external_id,phone,direction,status,started_at,ended_at,extension,expert_user_id,salesperson_id,customer_id,has_recording,is_live,extensions_json)
      VALUES(?,?,?,'incoming','ANSWERED',?,?,'212',8,6,?,0,1,'["212"]')`, [id, `sf480-fx-${id}`, phone, t, t, cid]);
    ins(mx + 1, cust.phone, cust.id); ins(mx + 2, "09120000481", null);
    const q = dq.dqQueue(kz, NOW); const inc = q.items.filter((x) => x.kind === "incoming_call" && x.live && !x.done && [`c-${cust.id}`, `e-${mx + 2}`].includes(String(x.id)));
    if (inc.length !== 2) console.log('   dbg', NOW.toISOString(), JSON.stringify(q.items.filter((x) => x.kind === 'incoming_call').map((x) => [x.id, x.live, x.done, x.urgent, x.customer_id])).slice(0, 400), mx);
    assert.equal(inc.length, 2, `seeded live calls in the queue: ${inc.length}`);
    assert.ok(inc.every((x) => x.urgent && x.blockIdx === q.nowBlock), JSON.stringify(inc.map((x) => [x.urgent, x.blockIdx, q.nowBlock])));
    assert.ok(inc.some((x) => x.customer_id === cust.id) && inc.some((x) => x.customer_id == null), "registered + unknown");
    flag("flag.sf480_incoming_now", "0"); const q0 = dq.dqQueue(kz, NOW); flag("flag.sf480_incoming_now", null);
    const old = q0.items.filter((x) => inc.some((y) => y.id === x.id)); assert.ok(old.length && old.every((x) => !x.urgent), "old rule: not urgent after the window");
    globalThis.__sfUnknown = mx + 2;
  });
  await ok("bug4 unknown number → name step creates the expert's own customer (then «تماس اول»)", async () => {
    const r = await call("POST", `/daily-customer-inline/queue/unknown/${globalThis.__sfUnknown}/name`, E, { firstName: "کیوان", lastName: "نمونه" });
    assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)?.slice(0, 100)}`); assert.equal(spOf(r.body.customerId), 6);
    assert.equal((await call("GET", `/daily-customer-inline/customers/${r.body.customerId}`, E)).status, 200);
  });
  // ---------- 5: popups
  await ok("item5 the mandatory reminder popup feed is off for the expert; '0' → back", async () => {
    const r = await call("GET", "/reminder-must/config", E); assert.equal(r.body?.enabled, false);
    const was = queryRow("SELECT value FROM call_queue_settings WHERE key='flag.reminder_must'")?.value;
    flag("flag.sf480_no_popups", "0"); const r0 = await call("GET", "/reminder-must/config", E); flag("flag.sf480_no_popups", null);
    assert.equal(r0.body?.enabled, was === "1", `old feed follows flag.reminder_must (${was})`);
  });
  // ---------- 7 / 8: lists open, lockdown kept, own scope
  await ok("item7 lockdown still on; «مشتریان من» (/customers) allowed; other pages unchanged; '0' → locked again", async () => {
    assert.equal(elOn, "1", "flag.expert_lockdown untouched (=1)");
    const r = await call("GET", "/expert-lockdown/me", E); assert.equal(r.body.locked, true); assert.ok(r.body.allowedPages.includes("/customers"));
    assert.ok(!r.body.allowedPages.includes("/reminders") && !r.body.allowedPages.includes("/calls"));
    flag("flag.sf480_open_lists", "0"); const r0 = await call("GET", "/expert-lockdown/me", E); flag("flag.sf480_open_lists", null);
    assert.ok(!r0.body.allowedPages.includes("/customers"));
  });
  await ok("item7 old GET /customers stays locked for the expert (server-enforced)", async () => { assert.ok([403, 422].includes((await call("GET", "/customers?search=09", E)).status)); });
  await ok("item7 «مشتریان من» = exactly the expert's own customers", async () => {
    const n = Number(queryRow("SELECT COUNT(*) n FROM customers WHERE salesperson_id=6 AND merged_into_customer_id IS NULL").n);
    const r = await call("GET", "/sales-fixes/my-customers", E); assert.equal(r.status, 200); assert.equal(r.body.total, n); assert.ok(r.body.items.every((x) => spOf(x.id) === 6));
  });
  await ok("item8 kanban cases = own only", async () => {
    const r = await call("GET", "/sales-fixes/cases", E); assert.equal(r.status, 200); assert.ok(r.body.cases.length > 0);
    for (const c of r.body.cases) assert.equal(Number(queryRow("SELECT c.salesperson_id sp FROM loan_applications la JOIN customers c ON c.id=la.customer_id WHERE la.id=?", [c.id]).sp), 6);
  });
  await ok("item7 files board: no 'locked' card; a non-turn own open file passes the guard; '0' → 423", async () => {
    const r = await call("GET", "/files-carousel/board", E);
    if (r.status !== 200 || !Array.isArray(r.body?.cards)) { console.log(`   (board off in this copy: ${r.status})`); return; }
    assert.ok(r.body.cards.every((x) => x.state !== "locked"));
    const nt = r.body.cards.find((x) => x.state === "open" || x.state === "later"); if (!nt) { console.log("   (no non-turn open file)"); return; }
    assert.notEqual((await call("POST", `/loan-applications/${nt.fileId}/sf480-probe`, E, {})).status, 423);
    flag("flag.sf480_open_lists", "0"); const r0 = await call("POST", `/loan-applications/${nt.fileId}/sf480-probe`, E, {}); flag("flag.sf480_open_lists", null);
    assert.equal(r0.status, 423);
  });
  await ok("item9 user 29 gets nothing from the new endpoints", async () => {
    const u29 = queryRow("SELECT id FROM users WHERE id=29 AND active=1"); if (!u29) return;
    const t = session(29); for (const p of ["/sales-fixes/search?q=09", "/sales-fixes/my-customers", "/sales-fixes/cases"]) assert.ok([403, 404, 423].includes((await call("GET", p, t)).status), p);
    execute("DELETE FROM auth_sessions WHERE user_id=29 AND created_at >= ?", [new Date(Date.now() - 36e5).toISOString()]);
  });
  await ok("guard: no sf480 flag rows left, no new flag keys, no network", async () => {
    const after = queryRows("SELECT key FROM call_queue_settings WHERE key LIKE 'flag.%' ORDER BY key").map((r) => r.key).filter((k) => !["flag.dci_queue_v21.user.8", "flag.daily_plan"].includes(k));
    assert.deepEqual(after, flagKeysBefore.filter((k) => !["flag.dci_queue_v21.user.8", "flag.daily_plan"].includes(k))); assert.equal(net, 0);
  });
} catch (e) { failed++; console.log("not ok - setup ::", String(e?.stack || e).split("\n").slice(0, 3).join(" | ").slice(0, 300)); }
finally { try { server?.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`# ${passed} passed`); if (failed) console.log(`# ${failed} failed`);
console.log(failed ? "sales-fixes-480000 fixture FAIL" : `sales-fixes-480000 fixture PASS (${passed} checks)`);
process.exit(failed ? 1 : 0);

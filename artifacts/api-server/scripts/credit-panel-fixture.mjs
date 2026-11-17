// credit-panel v1 fixture (flag.credit_panel_v1): «کارهای امروز» credit card + «اعتبارسنجی سریع».
// No network, no provider call: globalThis.fetch throws and records; the sapi debt client is a recording stub (setCpClient). No ICS24 / SMS.
// Usage: SMC_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/credit-panel-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const src = process.env.SMC_FIXTURE_DB;
if (!src) { console.log("SKIP (set SMC_FIXTURE_DB)"); process.exit(0); }
assert.notEqual(fs.realpathSync(src), "/var/lib/nafisvam/customers.db", "refusing live DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-fx-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath); fs.chmodSync(dbPath, 0o600);
for (const k of Object.keys(process.env)) if (/^(SAPI_|IR_RELAY|ICS24_|NAFIS_IDTEST)/.test(k)) delete process.env[k]; // never a real provider config in tests
Object.assign(process.env, { CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "silent", DP_TEST_NO_BELLS: "1", BALE_BOT_WORKER: "0", SAB_FEEDER: "0",
  SMS_DISABLED: "1", SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789` });
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "fixture-placeholder";
delete process.env.OPENAI_API_KEY;
const netCalls = [];
globalThis.fetch = async (u) => { netCalls.push(String(u).slice(0, 40)); throw new Error("no network in fixture"); };
let passed = 0; const ok = async (n, f) => { await f(); passed++; console.log("ok -", n); };
let server;
// Synthetic, valid-checksum test codes (not real people).
const nid = (nine) => { const s = nine.split("").reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11; return nine + String(s < 2 ? s : 11 - s); };
const FAKE_A = nid("000000011"), FAKE_B = nid("000000022");
try {
  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const db = await import("../src/lib/crm-db.ts");
  const auth = await import("../src/lib/auth.ts");
  const { default: router } = await import("../src/routes/index.ts");
  const cp = await import("../src/lib/credit-panel.ts");
  const el = await import("../src/lib/expert-lockdown.ts");
  const { queryRow, queryRows, execute } = db;
  const setKey = (k, v) => v == null ? execute("DELETE FROM call_queue_settings WHERE key=?", [k])
    : execute("INSERT INTO call_queue_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, v]);
  const hash = (sql) => crypto.createHash("sha256").update(JSON.stringify(queryRows(sql))).digest("hex");
  const tableHash = (t) => { try { return hash(`SELECT * FROM ${t} ORDER BY rowid`); } catch { return "absent"; } };
  const allTables = () => queryRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
  const hashAll = () => Object.fromEntries(allTables().map((t) => [t, tableHash(t)]));
  const changedSince = (h0) => Object.keys(hashAll()).filter((t) => tableHash(t) !== (h0[t] ?? "new")).sort();
  const guarded = ["team_sales_config", "notification_settings", "contracts", "contract_templates", "loan_plans", "smc_settings", "users", "sales_teams", "sales_team_members", "sms_outbox", "sms_log", "customer_credit_checks"];
  const before = Object.fromEntries(guarded.map((t) => [t, tableHash(t)]));

  // provider stub: records part + payload shape (code replaced by a marker), answers like the documented shapes
  const calls = []; let mode = {};
  cp.setCpClient(async (part, code, isCompany) => {
    calls.push({ part, code: code === FAKE_A ? "A" : code === FAKE_B ? "B" : "?", isCompany });
    if (mode[part] === "fail") throw new Error("SAPI request failed (500)");
    if (part === "unpaidChequePro") return { nationalCode: code, legalId: "", name: "نمونه", count: 1, chequeList: [{ accountNumber: "0101234567001", amount: 250000000, bouncedAmount: 250000000,
      bankCode: "18", branchCode: "1", branchDescription: "بانک تجارت — شعبه مرکزی", dishonoringBranchName: "بانک تجارت — شعبه ولیعصر", dishonorReason: "حساب دارای کسری موجودی است.",
      branchCodeBounced: "2", chequeDate: "14030120", backDate: "14030122", chequeID: "x1", chequeNumber: "0001234567" }] };
    if (part === "chequeColor") return { chequeColor: "زرد", chequeColorCode: 2 };
    return { count: 3, info: { nationalCode: code, name: "نمونه", totalAmount: 2500000000, debtTotalAmount: 1450000000, pastExpiredTotalAmount: 320000000, deferredTotalAmount: 180000000,
      suspiciousTotalAmount: 95000000, dishonored: 120000000 } };
  });

  const tokens = {};
  const ADMIN = 1, KAZEMI = 8, HASANI = 2;
  for (const id of [ADMIN, HASANI, KAZEMI]) {
    const tok = crypto.randomBytes(24).toString("base64url"); tokens[id] = tok;
    execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      [crypto.createHmac("sha256", process.env.SESSION_SECRET).update(tok).digest("hex"), id, new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()]);
  }
  const app = express(); app.use(cookieParser()); app.use(express.json({ limit: "2mb" }));
  app.use("/elapi", auth.requireAuth, el.expertLockdownGuard, router); // the live guard order (app.ts) for the lockdown checks
  app.use("/api", auth.requireAuth, router);
  app.use((_req, res) => res.status(404).send("spa"));
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const call = (user, method, p, body, prefix = "/api") => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({ host: "127.0.0.1", port, agent: false, method, path: `${prefix}${p}`, headers: { ...(user ? { cookie: `crm_session=${tokens[user]}` } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: res.statusCode, body: j, text: t }); });
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });

  // two of Kazemi's customers: A gets a synthetic code, B has none (birth date cleared); one of Hasani's customers for the access check
  const mine = queryRows("SELECT id FROM customers WHERE salesperson_id=(SELECT salesperson_id FROM users WHERE id=?) AND merged_into_customer_id IS NULL AND COALESCE(status,'in_progress')<>'cancelled' ORDER BY id LIMIT 2", [KAZEMI]).map((r) => r.id);
  const other = queryRow("SELECT id FROM customers WHERE salesperson_id=(SELECT salesperson_id FROM users WHERE id=?) AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1", [HASANI]).id;
  assert.equal(mine.length, 2);
  const [CA, CB] = mine;
  execute("UPDATE customers SET national_code=NULL WHERE national_code IN (?,?)", [FAKE_A, FAKE_B]);
  execute("UPDATE customers SET national_code=?, birth_date_jalali=NULL WHERE id=?", [FAKE_A, CA]);
  execute("UPDATE customers SET national_code=NULL, birth_date_jalali=NULL WHERE id=?", [CB]);
  const cpPaths = (id) => [["GET", "/credit-panel/me"], ["GET", `/credit-panel/customers/${id}`], ["POST", `/credit-panel/customers/${id}/inquiry`, {}],
    ["POST", `/credit-panel/customers/${id}/birth-date`, { birthDateJalali: "1358/04/15" }]];

  await ok("flag OFF: every /credit-panel route 404 for admin and expert; today's credit-check list still answers; nothing written; no provider call", async () => {
    setKey(cp.CP_FLAG, null);
    const h0 = hashAll();
    for (const u of [ADMIN, KAZEMI]) for (const [m, p, b] of cpPaths(CA)) assert.equal((await call(u, m, p, b)).status, 404, `${u} ${m} ${p}`);
    setKey(cp.CP_FLAG, "0");
    for (const [m, p, b] of cpPaths(CA)) assert.equal((await call(ADMIN, m, p, b)).status, 404, `'0' ${m} ${p}`);
    { const t = await call(KAZEMI, "GET", `/customers/${CA}/credit-checks`); assert.equal(t.status, 200, `${CA} ${t.text}`); }
    const ch = changedSince(h0).filter((t) => t !== "call_queue_settings" && t !== "auth_sessions");
    assert.deepEqual(ch, [], `OFF wrote ${ch}`);
    assert.equal(tableHash("customer_debt_inquiries"), "absent");
    assert.equal(calls.length, 0);
  });

  setKey(cp.CP_FLAG, "1");
  await ok("ON: /me enabled; empty view (no inquiry yet, validity 24h default from «اعتبارسنجی»); masked code only; GET writes nothing but the additive table", async () => {
    assert.equal((await call(KAZEMI, "GET", "/credit-panel/me")).body.enabled, true);
    const h0 = hashAll();
    const r = await call(KAZEMI, "GET", `/credit-panel/customers/${CA}`);
    assert.equal(r.status, 200); assert.equal(r.body.lastAt, null); assert.equal(r.body.valid, false); assert.equal(r.body.validHours, 24);
    assert.equal(r.body.customer.nationalCodeMasked, `${FAKE_A.slice(0, 3)}••••${FAKE_A.slice(-3)}`); assert.equal(r.body.customer.isCompany, false);
    assert.ok(!r.text.includes(FAKE_A), "full code never in the response");
    for (const p of cp.CP_PARTS) assert.equal(r.body.parts[p].data, null);
    const ch = changedSince(h0).filter((t) => t !== "auth_sessions"); assert.deepEqual(ch, ["customer_debt_inquiries"]);
  });

  await ok("access: another expert's customer 404 (view + inquiry + birth date); no national code → 400 national_code_missing, no provider call", async () => {
    for (const [m, p, b] of cpPaths(other).slice(1)) assert.equal((await call(KAZEMI, m, p, b)).status, 404, `${m} ${p}`);
    const r = await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/inquiry`, {});
    assert.equal(r.status, 400); assert.equal(r.body.code, "national_code_missing");
    assert.equal(calls.length, 0);
  });

  let firstAt;
  await ok("new inquiry: the three endpoints together (isCompany false), one «آخرین استعلام» time, raw rial/compact dates kept, code/legalId not stored", async () => {
    const r = await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(calls.map((c) => c.part).sort(), ["activeLoans", "chequeColor", "unpaidChequePro"]);
    assert.ok(calls.every((c) => c.code === "A" && c.isCompany === false));
    assert.ok(r.body.lastAt); assert.equal(r.body.valid, true); assert.deepEqual(r.body.failed, []);
    assert.equal(r.body.parts.unpaidChequePro.data.chequeList[0].amount, 250000000);
    assert.equal(r.body.parts.unpaidChequePro.data.chequeList[0].chequeDate, "14030120");
    assert.equal(r.body.parts.chequeColor.data.chequeColor, "زرد");
    assert.equal(r.body.parts.activeLoans.data.info.debtTotalAmount, 1450000000);
    const row = queryRow("SELECT * FROM customer_debt_inquiries WHERE customer_id=? ORDER BY id DESC LIMIT 1", [CA]);
    assert.ok(!JSON.stringify(row).includes(FAKE_A), "no full code stored"); assert.ok(!/legalId|nationalCode/.test(JSON.stringify(row)));
    assert.equal(row.valid_hours, 24); assert.equal(row.ok_parts, 3);
    firstAt = r.body.lastAt;
  });

  await ok("still valid → 409 still_valid with the short confirm text, no provider call; confirmFresh → fresh run, time moves", async () => {
    const n = calls.length;
    const r = await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, {});
    assert.equal(r.status, 409); assert.equal(r.body.code, "still_valid"); assert.equal(r.body.error, "استعلام قبلی هنوز معتبر است. استعلام تازه گرفته شود؟");
    assert.equal(calls.length, n);
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true });
    assert.equal(r2.status, 200); assert.equal(calls.length, n + 3); assert.ok(r2.body.lastAt > firstAt);
  });

  await ok("partial failure: the failed part keeps its previous value and is flagged; «تلاش دوباره» for that part only clears it", async () => {
    execute("UPDATE customer_debt_inquiries SET created_at=? WHERE customer_id=?", [new Date(Date.now() - 3 * 86400000).toISOString(), CA]); // make it expired (3 days)
    const v0 = (await call(ADMIN, "GET", `/credit-panel/customers/${CA}`)).body; assert.equal(v0.valid, false);
    mode = { chequeColor: "fail" };
    const r = await call(ADMIN, "POST", `/credit-panel/customers/${CA}/inquiry`, {});
    assert.equal(r.status, 200); assert.deepEqual(r.body.failed, ["chequeColor"]);
    assert.equal(r.body.parts.chequeColor.error, true); assert.equal(r.body.parts.chequeColor.data.chequeColor, "زرد", "previous colour kept");
    assert.equal(r.body.parts.activeLoans.error, false);
    mode = {};
    const n = calls.length;
    const r2 = await call(ADMIN, "POST", `/credit-panel/customers/${CA}/inquiry`, { only: ["chequeColor"] });
    assert.equal(r2.status, 200); assert.deepEqual(calls.slice(n).map((c) => c.part), ["chequeColor"]); assert.equal(r2.body.parts.chequeColor.error, false);
    assert.equal(r2.body.parts.activeLoans.data.count, 3);
  });

  await ok("complete failure → 502 «استعلام الآن انجام نشد», the previous result and its time stay", async () => {
    const v0 = (await call(ADMIN, "GET", `/credit-panel/customers/${CA}`)).body;
    mode = { unpaidChequePro: "fail", chequeColor: "fail", activeLoans: "fail" };
    const r = await call(ADMIN, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true });
    assert.equal(r.status, 502); assert.equal(r.body.error, "استعلام الآن انجام نشد");
    const v1 = (await call(ADMIN, "GET", `/credit-panel/customers/${CA}`)).body;
    assert.equal(v1.lastAt, v0.lastAt); assert.equal(v1.parts.activeLoans.data.count, 3);
    mode = {};
  });

  await ok("rate limit (credit-check-guard caps, expert only): a 4th run for one customer in 24h → 429; admin unaffected", async () => {
    execute("DELETE FROM customer_debt_inquiries WHERE customer_id=?", [CA]);
    for (let i = 0; i < 3; i++) assert.equal((await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true })).status, 200, `run ${i}`);
    const r = await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true });
    assert.equal(r.status, 429); assert.equal(r.body.code, "credit_rate_limited");
    assert.equal((await call(ADMIN, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true })).status, 200);
  });

  await ok("birth date (wizard step 2): Jalali validated, saved on the customer; replacing needs confirm; verification resets like the live national-code save", async () => {
    assert.equal((await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/birth-date`, { birthDateJalali: "1358/13/01" })).status, 400);
    assert.equal((await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/birth-date`, { birthDateJalali: "1358/07/31" })).status, 400);
    const r = await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/birth-date`, { birthDateJalali: "۱۳۵۸/۴/۱۵" });
    assert.equal(r.status, 200); assert.equal(queryRow("SELECT birth_date_jalali b FROM customers WHERE id=?", [CB]).b, "1358/04/15");
    assert.equal(queryRow("SELECT verification_status v FROM customers WHERE id=?", [CB]).v, "unverified");
    const r2 = await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/birth-date`, { birthDateJalali: "1358/04/16" });
    assert.equal(r2.status, 409); assert.equal(r2.body.code, "confirm_replace");
    assert.equal((await call(KAZEMI, "POST", `/credit-panel/customers/${CB}/birth-date`, { birthDateJalali: "1358/04/16", confirmReplace: true })).status, 200);
    const v = (await call(KAZEMI, "GET", `/credit-panel/customers/${CB}`)).body; assert.equal(v.customer.hasBirthDate, true); assert.equal(v.customer.hasNationalCode, false);
  });

  await ok("expert lockdown (flag.expert_lockdown on): OFF → /credit-panel/me denied as today; ON → /me open, own customer readable, inquiry on a customer not in today's list 403, other expert 403", async () => {
    setKey("flag.expert_lockdown", "1");
    setKey(cp.CP_FLAG, null);
    const off = await call(KAZEMI, "GET", "/credit-panel/me", undefined, "/elapi"); assert.equal(off.status, 403); assert.equal(off.body.error, "expert_lockdown");
    setKey(cp.CP_FLAG, "1");
    assert.equal((await call(KAZEMI, "GET", "/credit-panel/me", undefined, "/elapi")).status, 200);
    assert.equal((await call(KAZEMI, "GET", `/credit-panel/customers/${CA}`, undefined, "/elapi")).status, 200);
    const n = calls.length;
    const w = await call(KAZEMI, "POST", `/credit-panel/customers/${CA}/inquiry`, { confirmFresh: true }, "/elapi");
    assert.equal(w.status, 403); assert.equal(w.body.error, "expert_lockdown_customer"); assert.equal(calls.length, n);
    assert.equal((await call(KAZEMI, "GET", `/credit-panel/customers/${other}`, undefined, "/elapi")).status, 403);
  });

  await ok("guarded tables unchanged (team_sales_config, notification_settings, contracts, contract_templates, loan_plans, smc_settings, users, teams, SMS, ICS24 checks); fetch never called", async () => {
    for (const t of guarded) assert.equal(tableHash(t), before[t], t);
    assert.deepEqual(netCalls, []);
  });

  await ok("flag back OFF with results saved: routes 404 again", async () => {
    setKey(cp.CP_FLAG, null);
    for (const [m, p, b] of cpPaths(CA)) assert.equal((await call(ADMIN, m, p, b)).status, 404);
  });
  console.log(`\n${passed} passed`);
} catch (e) {
  console.error("FAIL", e); process.exitCode = 1;
} finally {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}

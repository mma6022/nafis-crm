// Draft resume + wallet filing-fee fixture (fix/draft-resume-wallet-fee). Throwaway DB copy, in-process HTTP on 127.0.0.1 only, no outbound network, no SMS.
// Usage: DRAFT_FEE_RESUME_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/request-drafts-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const src = process.env.DRAFT_FEE_RESUME_FIXTURE_DB;
if (!src) { console.log("SKIP: set DRAFT_FEE_RESUME_FIXTURE_DB to a scrubbed local copy of the CRM DB (the routes need the real schema)."); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-fee-resume-fx-"));
const dbPath = path.join(dir, "customers.db");
fs.copyFileSync(src, dbPath);
const migPath = path.join(dir, "migration.db");
fs.copyFileSync(src, migPath);
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, SESSION_SECRET: secret, NODE_ENV: "production", LOG_LEVEL: "silent", LOAN_REQUEST_DRAFTS_JOBS: "off",
  CONTRACTS_STORAGE_DIR: path.join(dir, "contracts"), AUTO_BACKUP_DIR: path.join(dir, "backups"),
  AI_INTEGRATIONS_OPENAI_BASE_URL: "http://127.0.0.1:9", AI_INTEGRATIONS_OPENAI_API_KEY: "fixture-dummy",
});
for (const k of ["SAPI_RELAY_URL", "SMS_API_KEY", "KAVENEGAR_API_KEY", "SIMOTEL_BASE_URL"]) delete process.env[k];
const nativeFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("http://127.0.0.1:")) { outbound.push(String(url).slice(0, 60)); throw new Error("External network forbidden in draft-fee-resume fixture"); }
  return nativeFetch(url, options);
};

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };
const DAY = 86_400_000, H = 3_600_000, MIN = 60_000;

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { requireAuth } = await import("../src/lib/auth.ts");
const db = await import("../src/lib/crm-db.ts");
const lib = await import("../src/lib/loan-request-drafts.ts");
const draftsRouter = (await import("../src/routes/loan-request-drafts.ts")).default;
const loanRouter = (await import("../src/routes/loan-applications.ts")).default;
const { execute, queryRow, queryRows, executeChanges } = db;

const PROTECTED = ["contract_templates", "contract_generations", "goods_finance_ledger", "team_commission_ledger_meta", "team_commission_purchases",
  "team_commission_settings", "reminder_sms_deliveries", "wallet_share_links", "loan_applications"].filter((t) => queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [t]));
const counts = () => Object.fromEntries(PROTECTED.map((t) => [t, Number(queryRow(`SELECT COUNT(*) n FROM ${t}`).n)]));
const protectedBefore = counts();
const caseIdsBefore = queryRows("SELECT id FROM loan_applications ORDER BY id").map((r) => r.id).join(",");

// ---------------------------------------------------------------- seed (fixture rows only)
const ts = new Date().toISOString();
const spA = execute("INSERT INTO salespersons(name,active,created_at) VALUES('fixture A',1,?)", [ts]);
const spB = execute("INSERT INTO salespersons(name,active,created_at) VALUES('fixture B',1,?)", [ts]);
const sessions = {};
const legacySp = queryRow("SELECT c.salesperson_id sp FROM loan_applications a JOIN customers c ON c.id=a.customer_id WHERE a.deleted_at IS NULL AND a.stage='draft' AND COALESCE(a.is_pre_registration,0)=1 AND c.salesperson_id IS NOT NULL ORDER BY a.id LIMIT 1")?.sp ?? null;
for (const [key, role, sp] of [["admin", "admin", null], ["registrar", "registrar", null], ["salesA", "salesperson", spA], ["salesB", "salesperson", spB], ["funder", "funder", null], ["salesLegacy", "salesperson", legacySp]]) {
  // users.salesperson_id is unique: for an existing salesperson, a session is opened for its existing user (throwaway copy only).
  const existing = sp != null ? queryRow("SELECT id FROM users WHERE salesperson_id=? AND role='salesperson'", [sp])?.id : null;
  const uid = existing ?? execute("INSERT INTO users(username,password_hash,full_name,role,salesperson_id,active,created_at) VALUES(?,'unused',?,?,?,1,?)",
    [`fx-${key}-${randomBytes(3).toString("hex")}`, `fx ${key}`, role, sp, ts]);
  const token = randomBytes(24).toString("base64url");
  execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    [createHmac("sha256", secret).update(token).digest("hex"), uid, new Date(Date.now() + 3_600_000).toISOString(), ts]);
  sessions[key] = { uid, cookie: `crm_session=${token}` };
}
let phoneSeq = 0;
const customer = (sp, extra = {}) => execute("INSERT INTO customers(name,phone,salesperson_id,created_at,national_code,birth_date_jalali,verification_status) VALUES(?,?,?,?,?,?,?)",
  [`fx customer ${++phoneSeq}`, `0999${String(9000000 + phoneSeq).slice(-7)}`, sp, ts, extra.nc ?? null, extra.birth ?? null, extra.verified ? "verified" : "unverified"]);
const cA1 = customer(spA), cA2 = customer(spA), cB1 = customer(spB);
const cA3 = customer(spA, { nc: "1234567890", birth: "1370/01/01", verified: true });
execute(`INSERT INTO customer_credit_checks(customer_id,requested_by_user_id,national_code,status,score,score_label,created_at,updated_at,completed_at)
  VALUES(?,?,'1234567890','report_generated',700,'A',?,?,?)`, [cA3, sessions.admin.uid, ts, ts, ts]);
execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash','5000',?) ON CONFLICT(customer_id,wallet_type) DO UPDATE SET balance='5000'", [cA3, ts]);
const templateId = queryRow("SELECT id FROM contract_templates ORDER BY id LIMIT 1")?.id ?? null; // referenced only, never changed
const planId = execute("INSERT INTO loan_plans(name,filing_fee_toman,principal_amount,installment_terms,contract_template_id,active,created_at) VALUES('fx plan','1200','100000000','[{\"installments\":12}]',?,1,?)", [templateId, ts]);
const plan2 = execute("INSERT INTO loan_plans(name,filing_fee_toman,principal_amount,installment_terms,contract_template_id,active,created_at) VALUES('fx plan 2','1200','100000000','[{\"installments\":12}]',?,1,?)", [templateId, ts]);
execute("INSERT INTO loan_plan_conditions(plan_id) VALUES(?)", [planId]);
execute("INSERT INTO loan_plan_conditions(plan_id) VALUES(?)", [plan2]);

const app = express();
app.use(express.json(), cookieParser());
app.use("/api", requireAuth, draftsRouter, loanRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (who, method, route, body, headers = {}) => {
  const res = await fetch(base + route, { method, headers: { ...(who ? { Cookie: sessions[who].cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, etag: res.headers.get("etag"), cache: res.headers.get("cache-control") };
};


const ledger = (cid) => ({
  charges: Number(queryRow("SELECT COUNT(*) n FROM loan_filing_fee_charges WHERE customer_id=?", [cid]).n),
  walletOut: Number(queryRow("SELECT COUNT(*) n FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id WHERE w.customer_id=? AND l.kind='filing_fee_out'", [cid]).n),
  company: Number(queryRow("SELECT COUNT(*) n FROM company_wallet_ledger WHERE kind='filing_fee' AND fee_charge_id IN (SELECT id FROM loan_filing_fee_charges WHERE customer_id=?)", [cid]).n),
  balance: queryRow("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'", [cid])?.balance ?? null,
});
const walletTotalsBefore = queryRow("SELECT COUNT(*) n, COALESCE(SUM(CAST(balance AS INTEGER)),0) s FROM wallet_accounts_v2 WHERE customer_id NOT IN (?)", [cA3]);
try {
  let d3, chargeId, appId;
  await ok("route is registered before /loan-applications/:id; 401/403/404 scope", async () => {
    assert.equal((await call(null, "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`)).status, 401);
    assert.equal((await call("funder", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`)).status, 403);
    assert.equal((await call("salesB", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`)).status, 404, "other team's customer");
    const r = await call("salesA", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`);
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.application, null);
  });
  await ok("double submit of the fee (same draft-bound key, then a new key) → one charge, one wallet row, one company row", async () => {
    d3 = (await call("salesA", "POST", "/loan-request-drafts", { customerId: cA3, step: 6, payload: { planId, amount: "40000000", duration: "12" } })).json.draft;
    const key = `draft-${d3.id}-plan-${planId}`;
    const [a, b] = await Promise.all([1, 2].map(() => call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId, draftId: d3.id }, { "Idempotency-Key": key })));
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.json, b.json]));
    assert.equal(a.json.chargeId, b.json.chargeId); chargeId = a.json.chargeId;
    const c = await call("registrar", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId, draftId: d3.id }, { "Idempotency-Key": randomUUID() });
    assert.equal(c.status, 200); assert.equal(c.json.chargeId, chargeId);
    assert.deepEqual(ledger(cA3), { charges: 1, walletOut: 1, company: 1, balance: "3800" });
  });
  await ok("paid draft, no case yet: «ادامه» resumes at the saved step with the fee (no charge)", async () => {
    const d = (await call("salesA", "GET", `/loan-request-drafts/by-customer/${cA3}`)).json.draft;
    assert.equal(d.id, d3.id); assert.equal(d.feeChargeId, chargeId); assert.equal(d.paid, true); assert.ok(d.step >= 7);
    assert.equal((await call("salesA", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`)).json.application, null);
    assert.deepEqual(ledger(cA3), { charges: 1, walletOut: 1, company: 1, balance: "3800" });
  });
  await ok("fee consumed by a pre-registration case (stage draft, hidden): guard returns that case; any new fee attempt → no charge", async () => {
    db.runTransaction(() => {
      const consultation = execute("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)", [cA3, "40000000", ts]);
      appId = execute("INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,stage,status,is_pre_registration,created_at) VALUES(?,?,?,?,?,?,'draft','requested',1,?)",
        [consultation, cA3, sessions.salesA.uid, JSON.stringify([planId]), planId, "40000000", ts]);
      executeChanges("UPDATE loan_filing_fee_charges SET application_id=? WHERE id=?", [appId, chargeId]);
      lib.closeDraftsForCase(cA3, chargeId, appId, sessions.salesA.uid, d3.id);
    });
    const g = await call("salesA", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`);
    assert.equal(g.json.application.id, appId); assert.equal(g.json.application.feeChargeId, chargeId); assert.equal(g.json.application.feePaid, true);
    assert.equal(g.json.application.stage, "draft");
    assert.equal((await call("salesA", "GET", `/loan-request-drafts/by-customer/${cA3}`)).json.draft, null, "the submitted draft is closed: «ادامه» goes to the case");
    // same plan, fresh key (old device draft / other tab): the linked charge is replayed with its case, nothing deducted
    const same = await call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId }, { "Idempotency-Key": randomUUID() });
    assert.equal(same.status, 200, JSON.stringify(same.json)); assert.equal(same.json.chargeId, chargeId); assert.equal(same.json.applicationId, appId);
    // other plan (the remaining double-charge vector): refused while the paid case is open
    const other = await call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId: plan2 }, { "Idempotency-Key": randomUUID() });
    assert.equal(other.status, 409); assert.equal(other.json.error, "open_pre_registration_case");
    assert.deepEqual(ledger(cA3), { charges: 1, walletOut: 1, company: 1, balance: "3800" }, "wallet unchanged by the resume");
  });
  await ok("case POST with the already-linked fee returns the same case (double submit never makes a 2nd case)", async () => {
    const n0 = Number(queryRow("SELECT COUNT(*) n FROM loan_applications WHERE customer_id=?", [cA3]).n);
    const r = await call("salesA", "POST", "/loan-applications", { customerId: cA3, planId, requestedAmount: "40000000", durationMonths: 12, conditionId: 1, feeChargeId: chargeId });
    assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    assert.equal(Number(r.json.id ?? r.json.application?.id), appId);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM loan_applications WHERE customer_id=?", [cA3]).n), n0);
    assert.deepEqual(ledger(cA3), { charges: 1, walletOut: 1, company: 1, balance: "3800" });
  });
  await ok("rejected / advanced cases do not block: guard is null once the case leaves stage draft", async () => {
    executeChanges("UPDATE loan_applications SET stage='documents' WHERE id=?", [appId]);
    assert.equal((await call("salesA", "GET", `/loan-applications/open-pre-registration?customerId=${cA3}`)).json.application, null);
    executeChanges("UPDATE loan_applications SET stage='draft' WHERE id=?", [appId]);
  });
  await ok("existing hidden pre-registration cases in the copy resolve through the guard (scoped)", async () => {
    const rows = queryRows("SELECT a.id, a.customer_id, (SELECT MAX(CAST(f.amount_toman AS INTEGER)) FROM loan_filing_fee_charges f WHERE f.application_id=a.id) fee FROM loan_applications a WHERE a.deleted_at IS NULL AND a.stage='draft' AND COALESCE(a.is_pre_registration,0)=1 AND COALESCE(a.status,'')<>'rejected' AND a.customer_id<>? ORDER BY a.id", [cA3]);
    for (const r of rows) {
      const g = await call("admin", "GET", `/loan-applications/open-pre-registration?customerId=${r.customer_id}`);
      assert.equal(g.status, 200);
      if (Number(r.fee) > 0) assert.equal(g.json.application?.id, r.id, `paid case ${r.id} → continue there`);
      else assert.equal(g.json.application, null, `fee-less leftover ${r.id} does not block a new request`);
    }
    console.log(`  hidden pre-registration cases in copy: ${rows.map((r) => `${r.id}${Number(r.fee) > 0 ? "(paid)" : "(no fee)"}`).join(",") || "none"}`);
  });
  await ok("no wallet / ledger change outside the fixture customer; protected tables untouched; no outbound request", async () => {
    assert.deepEqual(queryRow("SELECT COUNT(*) n, COALESCE(SUM(CAST(balance AS INTEGER)),0) s FROM wallet_accounts_v2 WHERE customer_id NOT IN (?)", [cA3]), walletTotalsBefore);
    const c = counts(); c.loan_applications -= 1; assert.deepEqual(c, protectedBefore);
    assert.deepEqual(outbound, []);
  });
  console.log(`Draft-fee-resume fixture passed: ${passed} checks.`);
} finally {
  server.close();
  globalThis.fetch = nativeFetch;
  try { db.crmDb?.close?.(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

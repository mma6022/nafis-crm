// «در انتظار ثبت» (server-side request drafts) fixture. Throwaway DB copy, in-process HTTP on 127.0.0.1 only, no outbound network, no SMS.
// Usage: REQUEST_DRAFTS_FIXTURE_DB=/path/to/scrubbed-copy.db node scripts/run-bundled-fixture.mjs scripts/request-drafts-fixture.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const src = process.env.REQUEST_DRAFTS_FIXTURE_DB;
if (!src) { console.log("SKIP: set REQUEST_DRAFTS_FIXTURE_DB to a scrubbed local copy of the CRM DB (the routes need the real schema)."); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-drafts-fx-"));
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
  if (!String(url).startsWith("http://127.0.0.1:")) { outbound.push(String(url).slice(0, 60)); throw new Error("External network forbidden in request-drafts fixture"); }
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
const mig = await import("./request-drafts-migrate.mjs");
const rb = await import("./request-drafts-rollback.mjs");
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

try {
  let d1, d3;
  await ok("401 without session; funder (view-only, no create) gets 403", async () => {
    assert.equal((await call(null, "GET", "/loan-request-drafts")).status, 401);
    assert.equal((await call("funder", "GET", "/loan-request-drafts")).status, 403);
    assert.equal((await call("funder", "POST", "/loan-request-drafts", { customerId: cA1 })).status, 403);
  });
  await ok("salesperson creates a draft for own customer; payload is whitelisted (no OTP/documents)", async () => {
    const r = await call("salesA", "POST", "/loan-request-drafts", { customerId: cA1, step: 2, payload: { amount: "50000000", duration: "12", otp: "1234", documents: [1], creditResult: { x: 1 } } });
    assert.equal(r.status, 201); d1 = r.json.draft ?? r.json;
    assert.equal(d1.customerId, cA1); assert.equal(d1.source, "crm"); assert.equal(d1.version, 1); assert.equal(d1.step, 2);
    assert.equal(d1.salespersonId, spA); assert.equal(d1.paid, false); assert.equal(d1.locked, false); assert.equal(d1.canDelete, false);
    assert.deepEqual(Object.keys(d1.payload).sort(), ["amount", "duration"]);
    assert.equal(d1.autoDeleteAt, null, "auto-delete is OFF: no deletion date is shown"); assert.equal(d1.expiringSoon, false);
    assert.equal(r.cache, "no-store");
  });
  await ok("one open draft per customer: 409 draft_exists returns the draft", async () => {
    const r = await call("registrar", "POST", "/loan-request-drafts", { customerId: cA1 });
    assert.equal(r.status, 409); assert.equal(r.json.error, "draft_exists"); assert.equal(r.json.draft.id, d1.id);
    assert.equal((await call("salesA", "GET", `/loan-request-drafts/by-customer/${cA1}`)).json.draft.id, d1.id);
    assert.equal((await call("salesA", "GET", `/loan-request-drafts/by-customer/${cA2}`)).json.draft, null);
  });
  await ok("other team's salesperson cannot see, continue or create (404, server-enforced)", async () => {
    assert.equal((await call("salesB", "GET", `/loan-request-drafts/${d1.id}`)).status, 404);
    assert.equal((await call("salesB", "PUT", `/loan-request-drafts/${d1.id}`, { version: 1, step: 3 })).status, 404);
    assert.equal((await call("salesB", "GET", `/loan-request-drafts/by-customer/${cA1}`)).status, 404);
    assert.equal((await call("salesB", "POST", "/loan-request-drafts", { customerId: cA2 })).status, 404);
    const list = await call("salesB", "GET", "/loan-request-drafts?scope=all");
    assert.equal(list.status, 200); assert.equal(list.json.seesAll, false); assert.ok(!list.json.items.some((i) => i.id === d1.id));
    assert.ok((await call("salesA", "GET", "/loan-request-drafts")).json.items.some((i) => i.id === d1.id));
  });
  await ok("queue search keeps the role scope (filters bound before scope) and finds the customer id in every form", async () => {
    // Regression: the scope param was bound first while its SQL came last, so with a search the
    // salesperson filter compared against the search text — salesperson B searching A's id saw A's drafts.
    const fa = (v) => String(v).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
    const cAx = execute("INSERT INTO customers(name,phone,salesperson_id,created_at,verification_status) VALUES('fx scope probe',?,?,?,'unverified')",
      [`0912${String(spA).padStart(7, "0")}`, spA, ts]);
    const dx = (await call("salesA", "POST", "/loan-request-drafts", { customerId: cAx })).json.draft;
    assert.ok(dx?.id, "probe draft created");
    const phoneA1 = queryRow("SELECT phone FROM customers WHERE id=?", [cA1]).phone;
    for (const q of [String(spA), String(cA1), `#${cA1}`, `#${fa(cA1)}`, fa(cA1), phoneA1, String(cAx), "fx scope probe", "fx customer"]) {
      for (const scope of ["all", "mine"]) {
        const r = await call("salesB", "GET", `/loan-request-drafts?scope=${scope}&search=${encodeURIComponent(q)}`);
        assert.equal(r.status, 200);
        assert.ok(!r.json.items.some((i) => i.salespersonId === spA), `salesB search ${q} (${scope}) leaked salesperson A's draft`);
      }
    }
    for (const q of [String(cA1), `#${cA1}`, `#${fa(cA1)}`, fa(cA1)]) {
      const items = (await call("salesA", "GET", `/loan-request-drafts?search=${encodeURIComponent(q)}`)).json.items;
      assert.equal(items[0]?.id, d1.id, `salesA ${q}: exact id first`);
      if (q.startsWith("#")) assert.ok(items.every((i) => i.customerId === cA1), `${q} means the id only`);
    }
    assert.ok((await call("salesA", "GET", `/loan-request-drafts?search=${encodeURIComponent(phoneA1)}`)).json.items.some((i) => i.id === d1.id), "mobile still matches");
    assert.ok((await call("registrar", "GET", `/loan-request-drafts?search=${encodeURIComponent(String(cAx))}`)).json.items.some((i) => i.id === dx.id), "all-scope roles unchanged");
    execute("DELETE FROM loan_request_drafts WHERE id=?", [dx.id]); // throwaway copy: keep later counts as before
  });
  await ok("autosave needs a version (428), stale version → 409 with server copy, If-Match works", async () => {
    assert.equal((await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { step: 3 })).status, 428);
    const a = await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { version: 1, step: 3, payload: { conditionId: 4 } });
    assert.equal(a.status, 200); assert.equal(a.json.draft.version, 2); assert.equal(a.etag, '"2"'); assert.equal(a.json.draft.payload.amount, "50000000");
    const stale = await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { version: 1, step: 4 });
    assert.equal(stale.status, 409); assert.equal(stale.json.error, "draft_version_conflict"); assert.equal(stale.json.draft.version, 2);
    const m = await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { step: 4 }, { "If-Match": '"2"' });
    assert.equal(m.status, 200); assert.equal(m.json.draft.step, 4);
    assert.equal((await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { version: 3, step: 99 })).json.draft.step, 10, "step clamps to 1..10");
  });
  await ok("registrar sees all and continues another salesperson's draft; case owner unchanged", async () => {
    const list = await call("registrar", "GET", "/loan-request-drafts?scope=all");
    assert.equal(list.json.seesAll, true); assert.ok(list.json.items.some((i) => i.id === d1.id));
    const cur = (await call("registrar", "GET", `/loan-request-drafts/${d1.id}`)).json.draft;
    assert.equal(cur.canContinue, true); assert.equal(cur.canDelete, false);
    const r = await call("registrar", "PUT", `/loan-request-drafts/${d1.id}`, { version: cur.version, step: 5 });
    assert.equal(r.status, 200); assert.equal(r.json.draft.salespersonId, spA); assert.equal(r.json.draft.updatedByName, "fx registrar");
    assert.equal(queryRow("SELECT salesperson_id FROM loan_request_drafts WHERE id=?", [d1.id]).salesperson_id, spA);
  });
  await ok("delete: admin only, reason required, soft delete + audit + in-CRM notification; customer can start again", async () => {
    assert.equal((await call("registrar", "DELETE", `/loan-request-drafts/${d1.id}`, { reason: "تکراری" })).status, 403);
    assert.equal((await call("salesA", "DELETE", `/loan-request-drafts/${d1.id}`, { reason: "تکراری" })).status, 403);
    const nr = await call("admin", "DELETE", `/loan-request-drafts/${d1.id}`, { reason: " " });
    assert.equal(nr.status, 422); assert.equal(nr.json.error, "delete_reason_required");
    assert.equal((await call("admin", "GET", `/loan-request-drafts/${d1.id}`)).json.draft.canDelete, true);
    assert.equal((await call("admin", "DELETE", `/loan-request-drafts/${d1.id}`, { reason: "مشتری منصرف شد" })).status, 200);
    const row = queryRow("SELECT * FROM loan_request_drafts WHERE id=?", [d1.id]);
    assert.equal(row.status, "deleted"); assert.equal(row.delete_kind, "manual"); assert.equal(row.delete_reason, "مشتری منصرف شد"); assert.equal(row.deleted_by, sessions.admin.uid);
    assert.ok(queryRow("SELECT 1 FROM loan_request_draft_events WHERE draft_id=? AND action='deleted' AND reason='مشتری منصرف شد' AND actor_user_id=?", [d1.id, sessions.admin.uid]));
    assert.ok(queryRow("SELECT 1 FROM site_notification_events WHERE resource_type='loan_draft' AND resource_id=? AND kind='draft_deleted' AND owner_id=?", [d1.id, spA]));
    assert.equal((await call("admin", "DELETE", `/loan-request-drafts/${d1.id}`, { reason: "دوباره" })).status, 410);
    assert.equal((await call("salesA", "PUT", `/loan-request-drafts/${d1.id}`, { version: 99 })).status, 410, "deleted draft is closed");
    assert.ok(!(await call("admin", "GET", "/loan-request-drafts")).json.items.some((i) => i.id === d1.id));
    assert.equal((await call("salesA", "POST", "/loan-request-drafts", { customerId: cA1 })).status, 201);
  });
  let chargeId;
  await ok("filing fee with draftId: one charge, linked to the draft, pricing unchanged, fee + plan locked", async () => {
    d3 = (await call("salesA", "POST", "/loan-request-drafts", { customerId: cA3, step: 6, payload: { planId, amount: "40000000", duration: "12" } })).json.draft;
    const key = randomUUID();
    const r = await call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId, draftId: d3.id }, { "Idempotency-Key": key });
    assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.amountToman, "1200"); chargeId = r.json.chargeId;
    const again = await call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId, draftId: d3.id }, { "Idempotency-Key": randomUUID() });
    assert.equal(again.status, 200); assert.equal(again.json.chargeId, chargeId);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM loan_filing_fee_charges WHERE customer_id=?", [cA3]).n), 1, "never charged twice");
    assert.equal(queryRow("SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'", [cA3]).balance, "3800");
    const locked = await call("salesA", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId: plan2, draftId: d3.id }, { "Idempotency-Key": randomUUID() });
    assert.equal(locked.status, 409); assert.equal(locked.json.error, "draft_fee_plan_locked");
    const other = await call("salesB", "POST", "/loan-applications/filing-fee-charges", { customerId: cA3, planId, draftId: d3.id }, { "Idempotency-Key": randomUUID() });
    assert.equal(other.status, 404);
    const d = (await call("salesA", "GET", `/loan-request-drafts/${d3.id}`)).json.draft;
    assert.equal(d.feeChargeId, chargeId); assert.equal(d.paid, true); assert.equal(d.locked, true); assert.equal(d.feeAmountToman, "1200"); assert.ok(d.step >= 7);
    assert.equal(d.autoDeleteAt, null); assert.equal(d.canDelete, false); d3 = d;
  });
  await ok("paid draft: amount locked for non-admin, plan bound to the charge, admin delete → 409 PAID_DRAFT_NOT_DELETABLE", async () => {
    const r = await call("salesA", "PUT", `/loan-request-drafts/${d3.id}`, { version: d3.version, payload: { amount: "45000000" } });
    assert.equal(r.status, 409); assert.equal(r.json.error, "draft_amount_locked");
    const p = await call("registrar", "PUT", `/loan-request-drafts/${d3.id}`, { version: d3.version, payload: { planId: plan2, duration: "12" } });
    assert.equal(p.status, 200); assert.equal(p.json.draft.planId, planId); assert.equal(p.json.draft.payload.planId, planId);
    const del = await call("admin", "DELETE", `/loan-request-drafts/${d3.id}`, { reason: "تست حذف" });
    assert.equal(del.status, 409); assert.equal(del.json.error, "PAID_DRAFT_NOT_DELETABLE");
    assert.equal((await call("admin", "GET", `/loan-request-drafts/${d3.id}`)).json.draft.canDelete, false);
    const c = (await call("salesA", "GET", "/loan-request-drafts/counts")).json;
    assert.ok(c.total >= 2 && c.paid >= 1);
  });
  await ok("submit validates draftId; a fee that becomes a case closes the draft (same path as POST /loan-applications)", async () => {
    const wrong = await call("salesA", "POST", "/loan-applications", { customerId: cA3, planId, requestedAmount: "40000000", durationMonths: 12, conditionId: 1, feeChargeId: chargeId, draftId: 999999 });
    assert.equal(wrong.status, 404); assert.equal(wrong.json.error, "draft_not_found");
    const otherDraft = queryRow("SELECT id FROM loan_request_drafts WHERE customer_id=? AND deleted_at IS NULL", [cA1]).id;
    assert.equal((await call("salesA", "POST", "/loan-applications", { customerId: cA3, planId, requestedAmount: "1", durationMonths: 12, conditionId: 1, feeChargeId: chargeId, draftId: otherDraft })).status, 404);
    // Simulate the create-case transaction outcome without the contract/document steps.
    db.runTransaction(() => {
      const consultation = execute("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)", [cA3, "40000000", ts]);
      const appId = execute("INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,stage,status,created_at) VALUES(?,?,?,?,?,?,'draft','requested',?)",
        [consultation, cA3, sessions.salesA.uid, JSON.stringify([planId]), planId, "40000000", ts]);
      executeChanges("UPDATE loan_filing_fee_charges SET application_id=? WHERE id=?", [appId, chargeId]);
      lib.closeDraftsForCase(cA3, chargeId, appId, sessions.salesA.uid, d3.id);
    });
    const row = queryRow("SELECT * FROM loan_request_drafts WHERE id=?", [d3.id]);
    assert.equal(row.status, "submitted"); assert.ok(row.application_id); assert.equal(row.delete_kind, null);
    assert.ok(!(await call("salesA", "GET", "/loan-request-drafts")).json.items.some((i) => i.id === d3.id));
    const g = await call("salesA", "PUT", `/loan-request-drafts/${d3.id}`, { version: row.version });
    assert.equal(g.status, 410); assert.equal(g.json.applicationId, row.application_id);
    // remove the simulated case again so the case table is exactly as before
    executeChanges("DELETE FROM loan_request_draft_events WHERE draft_id=?", [d3.id]);
    executeChanges("DELETE FROM loan_request_drafts WHERE id=?", [d3.id]);
    executeChanges("UPDATE loan_filing_fee_charges SET application_id=NULL WHERE id=?", [chargeId]);
    executeChanges("DELETE FROM loan_application_stage_history WHERE application_id=?", [row.application_id]);
    executeChanges("DELETE FROM loan_applications WHERE id=?", [row.application_id]);
  });
  await ok("sync closes a draft whose fee became a case through another path", async () => {
    const d = (await call("salesA", "POST", "/loan-request-drafts", { customerId: cA3 })).json.draft;
    assert.ok(d, "new draft for cA3");
    lib.linkDraftFee(queryRow("SELECT * FROM loan_request_drafts WHERE id=?", [d.id]), chargeId, { id: sessions.salesA.uid });
    const consultation = execute("INSERT INTO consultation_forms(customer_id,requested_amount,updated_at) VALUES(?,?,?)", [cA3, "1", ts]);
    const appId = execute("INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,stage,status,created_at) VALUES(?,?,?,?,?,?,'draft','requested',?)",
      [consultation, cA3, sessions.salesA.uid, JSON.stringify([planId]), planId, "1", ts]);
    executeChanges("UPDATE loan_filing_fee_charges SET application_id=? WHERE id=?", [appId, chargeId]);
    assert.ok(!(await call("admin", "GET", "/loan-request-drafts")).json.items.some((i) => i.id === d.id));
    assert.equal(queryRow("SELECT status FROM loan_request_drafts WHERE id=?", [d.id]).status, "submitted");
    executeChanges("DELETE FROM loan_request_draft_events WHERE draft_id=?", [d.id]);
    executeChanges("DELETE FROM loan_request_drafts WHERE id=?", [d.id]);
    executeChanges("UPDATE loan_filing_fee_charges SET application_id=NULL WHERE id=?", [chargeId]);
    executeChanges("DELETE FROM loan_applications WHERE id=?", [appId]);
  });
  await ok("drafts never appear as cases: loan_applications ids unchanged", async () => {
    assert.equal(queryRows("SELECT id FROM loan_applications ORDER BY id").map((r) => r.id).join(","), caseIdsBefore);
  });
  await ok("lib and migrate script share the DDL", async () => {
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    assert.equal(norm(mig.DRAFTS_DDL), norm(lib.DRAFTS_DDL));
    assert.equal(typeof lib.orphanFeeCandidates, "undefined"); assert.equal(typeof lib.syncOrphanFees, "undefined");
  });
  await ok("orphan paid fees: never converted; ADMIN only, read-only, computed at read time (non-admin → none, server-enforced)", async () => {
    const t0 = Date.now();
    const draftsBefore = Number(queryRow("SELECT COUNT(*) n FROM loan_request_drafts").n);
    const portal = execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_customer_id,created_at) VALUES(?,?,?,?,?,?)",
      [cB1, planId, "1200", `fx-portal-${randomUUID()}`, cB1, new Date(t0 - 20 * MIN).toISOString()]);
    const zero = execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
      [cB1, planId, "0", `fx-zero-${randomUUID()}`, sessions.salesB.uid, new Date(t0 - 30 * MIN).toISOString()]);
    lib.runDraftMaintenance(t0); lib.runDraftMaintenance(t0 + DAY);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM loan_request_drafts").n), draftsBefore, "no draft created from any orphan fee");
    const adm = (await call("admin", "GET", "/loan-request-drafts")).json;
    const row = adm.orphanFees.find((o) => o.chargeId === portal);
    assert.ok(row && row.kind === "orphan_fee" && row.readOnly === true && row.amountToman === "1200" && row.byCustomer === true);
    assert.ok(!("canContinue" in row) && !("canDelete" in row), "no actions on orphan rows");
    assert.ok(!adm.orphanFees.some((o) => o.chargeId === zero), "0-toman charges are not listed");
    assert.ok(!adm.items.some((i) => i.feeChargeId === portal), "not a draft");
    const live = [105, 127, 157].filter((id) => queryRow("SELECT 1 FROM loan_filing_fee_charges WHERE id=? AND application_id IS NULL AND CAST(amount_toman AS INTEGER)>0", [id]));
    for (const id of live) assert.ok(adm.orphanFees.some((o) => o.chargeId === id), `paid orphan ${id} shown to admin`);
    assert.ok((await call("admin", "GET", "/loan-request-drafts/counts")).json.orphanFees >= 1 + live.length);
    for (const who of ["registrar", "salesB", "salesA", "salesLegacy"]) {
      const r = (await call(who, "GET", "/loan-request-drafts?scope=all")).json;
      assert.deepEqual(r.orphanFees, [], `${who} never sees orphan fees`);
      assert.equal((await call(who, "GET", "/loan-request-drafts/counts")).json.orphanFees, 0);
    }
    assert.equal((await call("funder", "GET", "/loan-request-drafts")).status, 403);
    console.log(`  orphan paid fees visible to admin: ${adm.orphanFees.length} (ids ${adm.orphanFees.map((o) => o.chargeId).join(",")})`);
    executeChanges("DELETE FROM loan_filing_fee_charges WHERE id IN (?,?)", [portal, zero]);
  });
  await ok("hidden pre-registration cases (stage draft): display only; admin/registrar all, salesperson only own customers'", async () => {
    const hidden = queryRows("SELECT a.id, c.salesperson_id sp FROM loan_applications a JOIN customers c ON c.id=a.customer_id WHERE a.deleted_at IS NULL AND a.stage='draft' AND COALESCE(a.is_pre_registration,0)=1 ORDER BY a.id");
    const ids = (r) => r.json.legacyCases.map((x) => x.applicationId).sort((a, b) => a - b).join(",");
    const all = hidden.map((h) => h.id).join(",");
    assert.equal(ids(await call("admin", "GET", "/loan-request-drafts")), all);
    assert.equal(ids(await call("registrar", "GET", "/loan-request-drafts")), all);
    assert.equal(ids(await call("salesLegacy", "GET", "/loan-request-drafts")), hidden.filter((h) => h.sp === legacySp).map((h) => h.id).join(","));
    assert.equal(ids(await call("salesA", "GET", "/loan-request-drafts")), "", "other salesperson sees none");
    const one = (await call("admin", "GET", "/loan-request-drafts")).json.legacyCases[0];
    if (one) { assert.equal(one.kind, "legacy_case"); assert.equal(one.readOnly, true); assert.ok(!("canContinue" in one) && !("canDelete" in one)); }
    assert.deepEqual((await call("admin", "GET", "/loan-request-drafts?paid=1")).json.legacyCases, [], "not in the paid filter");
    assert.equal((await call("salesA", "GET", "/loan-request-drafts/counts")).json.legacyCases, 0);
    console.log(`  hidden pre-registration cases: ${hidden.length} (ids ${all}); salesperson ${legacySp} sees ${hidden.filter((h) => h.sp === legacySp).length}`);
  });

  // ---------------------------------------------------------------- clock edges (simulated now = 12:00 Tehran = 08:30Z)
  const T = Date.parse("2026-11-01T08:30:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const seed = (updatedMs, warnedMs = null, extra = {}) => {
    const c = customer(spA);
    let fee = null;
    if (extra.fee != null) fee = execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
      [c, planId, extra.fee, `fx-edge-${randomUUID()}`, sessions.salesA.uid, iso(extra.feeAt ?? updatedMs)]);
    const id = execute(`INSERT INTO loan_request_drafts(customer_id,source,created_by_user_id,salesperson_id,step,payload_json,fee_charge_id,created_at,updated_at,expiry_warned_at)
      VALUES(?,'crm',?,?,3,'{}',?,?,?,?)`, [c, sessions.salesA.uid, spA, fee, iso(Math.min(updatedMs, T - 60 * DAY)), iso(updatedMs), warnedMs == null ? null : iso(warnedMs)]);
    if (extra.looseFee) execute("INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
      [c, planId, "1200", `fx-loose-${randomUUID()}`, sessions.salesA.uid, iso(extra.looseFee)]);
    return id;
  };
  const row = (id) => queryRow("SELECT * FROM loan_request_drafts WHERE id=?", [id]);
  const e = {
    almost30: seed(T - 30 * DAY + MIN, null),            // 29d23h59m, never warned
    exact30: seed(T - 30 * DAY, T - 25 * H),             // exactly 30d, warned 25h ago
    warnedRecently: seed(T - 31 * DAY, T - 23 * H),      // warned <24h ago
    future: seed(T + 2 * H, null),                       // clock skew: saved "in the future"
    staleWarning: seed(T - 31 * DAY, T - 40 * DAY),      // activity after the warning: warning no longer counts
    before25: seed(T - 25 * DAY + MIN, null),
    exact25: seed(T - 25 * DAY, null),
    zeroFee: seed(T - 60 * DAY, T - 10 * DAY, { fee: "0" }),
    paidOld: seed(T - 60 * DAY, T - 10 * DAY, { fee: "1200", feeAt: T - 60 * DAY }),
    looseMoney: seed(T - 60 * DAY, T - 10 * DAY, { looseFee: T + 10 * DAY }),  // customer has a paid caseless charge not yet linked
    paid25h: seed(T - 2 * DAY, null, { fee: "1200", feeAt: T - 25 * H }),
    paid23h: seed(T - 2 * DAY, null, { fee: "1200", feeAt: T - 23 * H }),
  };
  await ok("auto-delete ships OFF: the job sends no expiry warning and deletes nothing, even 60+ days later", async () => {
    assert.equal(lib.autoDeleteEnabled(), false, "default off");
    for (const v of ["", "1", "true", "ON", "yes"]) assert.equal(lib.autoDeleteEnabled({ LOAN_REQUEST_DRAFTS_AUTO_DELETE: v }), false, `"${v}" is not on`);
    const snap = () => queryRows("SELECT id,status,deleted_at,expiry_warned_at,updated_at,version FROM loan_request_drafts ORDER BY id").map((r) => JSON.stringify(r)).join("\n");
    const before = snap();
    const expBefore = Number(queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE resource_type='loan_draft' AND kind='draft_expiring'").n);
    for (const t of [T - MIN, T, T + DAY, T + 62 * DAY]) {
      const r = lib.runDraftMaintenance(t);
      assert.equal(r.autoDelete, false); assert.deepEqual(r.warned, []); assert.deepEqual(r.expired, []);
    }
    assert.equal(snap(), before, "no draft row changed (no warning stamp, no delete)");
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE resource_type='loan_draft' AND kind='draft_expiring'").n), expBefore, "no warning notification");
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM loan_request_draft_events WHERE action IN ('expiry_warned','auto_expired')").n), 0);
    const d = (await call("admin", "GET", `/loan-request-drafts/${e.exact30}`)).json.draft;
    assert.equal(d.autoDeleteAt, null); assert.equal(d.expiringSoon, false);
    assert.equal((await call("admin", "GET", "/loan-request-drafts/counts")).json.autoDelete, false);
    executeChanges("UPDATE loan_request_drafts SET last_reminded_on=NULL"); // the paid-reminder pass ran; reset so the guarded-on edge checks start clean
  });
  // The edge checks below exercise the guarded code path with the flag explicitly ON inside this throwaway process only.
  process.env.LOAN_REQUEST_DRAFTS_AUTO_DELETE = "on";
  await ok("11:59 Tehran: boundaries just before; no paid reminders before 12:00", async () => {
    const r = lib.runDraftMaintenance(T - MIN);
    assert.ok(!r.expired.includes(e.exact30), "exact30 is 29d23h59m at 11:59");
    assert.ok(r.warned.includes(e.almost30)); assert.ok(r.warned.includes(e.staleWarning));
    assert.ok(!r.warned.includes(e.exact25), "exact25 is 24d23h59m at 11:59"); assert.ok(!r.warned.includes(e.future));
    assert.equal(r.reminded.length, 0);
  });
  await ok("12:00 Tehran: expiry, warnings and paid reminders exactly at the boundaries", async () => {
    const r = lib.runDraftMaintenance(T);
    assert.ok(r.expired.includes(e.exact30)); assert.equal(row(e.exact30).delete_kind, "auto_expired"); assert.equal(row(e.exact30).status, "expired");
    assert.ok(queryRow("SELECT 1 FROM loan_request_draft_events WHERE draft_id=? AND action='auto_expired'", [e.exact30]));
    for (const k of ["almost30", "warnedRecently", "future", "staleWarning", "before25", "exact25", "zeroFee", "paidOld", "looseMoney", "paid25h", "paid23h"])
      assert.equal(row(e[k]).deleted_at, null, `${k} must not be deleted`);
    assert.ok(row(e.almost30).expiry_warned_at, "almost30 warned (from day 25)");
    assert.ok(row(e.staleWarning).expiry_warned_at >= row(e.staleWarning).updated_at, "stale warning replaced by a fresh one");
    assert.equal(row(e.future).expiry_warned_at, null);
    assert.equal(row(e.before25).expiry_warned_at, null, "24d23h59m: no warning yet");
    assert.ok(row(e.exact25).expiry_warned_at, "exactly 25d: warned");
    for (const k of ["zeroFee", "paidOld", "looseMoney"]) assert.equal(row(e[k]).expiry_warned_at, iso(T - 10 * DAY), `${k} untouched`);
    assert.ok(r.reminded.includes(e.paid25h) && r.reminded.includes(e.paidOld)); assert.ok(!r.reminded.includes(e.paid23h));
    assert.ok(queryRow("SELECT 1 FROM site_notification_events WHERE resource_type='loan_draft' AND resource_id=? AND kind='draft_paid_pending'", [e.paid25h]));
    assert.ok(queryRow("SELECT 1 FROM site_notification_events WHERE resource_type='loan_draft' AND resource_id=? AND kind='draft_expiring'", [e.exact25]));
  });
  await ok("same day again: once-per-day reminder, no double warning; warned <24h is not expired yet", async () => {
    const before = Number(queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE resource_type='loan_draft'").n);
    const r = lib.runDraftMaintenance(T + 5 * MIN);
    assert.equal(r.reminded.length, 0); assert.equal(r.expired.length, 0);
    assert.deepEqual(r.warned, [e.before25], "only the draft that crossed day 25 since 12:00 (24d23h59m → 25d4m)");
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM site_notification_events WHERE resource_type='loan_draft'").n), before + 1);
    assert.equal(lib.runDraftMaintenance(T + 6 * MIN).warned.length, 0, "no second warning");
  });
  await ok("+1h: warned-recently draft (warned 24h ago now) expires; anything with money never does", async () => {
    const r = lib.runDraftMaintenance(T + 1 * H + MIN);
    assert.ok(r.expired.includes(e.warnedRecently));
    for (const k of ["zeroFee", "paidOld", "looseMoney", "paid25h"]) assert.equal(row(e[k]).deleted_at, null);
  });
  await ok("next day 12:00: reminders again (both paid drafts now >24h); 60 days later still nothing with money deleted", async () => {
    const r = lib.runDraftMaintenance(T + DAY);
    assert.ok(r.reminded.includes(e.paid25h) && r.reminded.includes(e.paid23h));
    lib.runDraftMaintenance(T + 60 * DAY); lib.runDraftMaintenance(T + 62 * DAY);
    for (const k of ["zeroFee", "paidOld", "paid25h", "paid23h"]) assert.equal(row(e[k]).deleted_at, null, k);
    assert.equal(Number(queryRow("SELECT COUNT(*) n FROM loan_request_drafts d JOIN loan_filing_fee_charges f ON f.id=d.fee_charge_id WHERE d.status IN ('expired','deleted')").n), 0);
  });
  await ok("activity after the warning resets the clock (autosave clears the warning)", async () => {
    const id = seed(Date.now() - 26 * DAY, Date.now() - 2 * DAY);
    const d = (await call("salesA", "GET", `/loan-request-drafts/${id}`)).json.draft;
    assert.equal((await call("salesA", "PUT", `/loan-request-drafts/${id}`, { version: d.version, step: 4 })).status, 200);
    assert.equal(row(id).expiry_warned_at, null);
    const r = lib.runDraftMaintenance(Date.now() + 10 * MIN);
    assert.ok(!r.expired.includes(id) && !r.warned.includes(id));
  });
  delete process.env.LOAN_REQUEST_DRAFTS_AUTO_DELETE;

  // ---------------------------------------------------------------- migration / rollback on a separate copy
  await ok("migration is schema-only: dry run writes nothing, apply creates 3 empty tables + marker and converts 0; rollback drops them", async () => {
    const m = new DatabaseSync(migPath);
    try {
      const fp0 = mig.fingerprint(m);
      const plan = mig.planMigration(m);
      assert.equal(plan.schemaOnly, true); assert.equal(plan.convert, 0); assert.deepEqual(plan.tablesToCreate, mig.DRAFT_TABLES); assert.equal(plan.markerPresent, false);
      assert.ok(!m.prepare("SELECT 1 FROM sqlite_master WHERE name='loan_request_drafts'").get(), "dry run created nothing");
      const a = mig.applyMigration(m);
      assert.equal(a.converted, 0); assert.deepEqual(a.createdTables, mig.DRAFT_TABLES);
      for (const t of mig.DRAFT_TABLES) assert.equal(Number(m.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n), 0, `${t} empty`);
      assert.ok(m.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(mig.MARKER));
      assert.ok(!m.prepare("SELECT 1 FROM sqlite_master WHERE name='loan_request_drafts_migration_snapshot'").get(), "no snapshot table");
      assert.deepEqual(mig.fingerprint(m), fp0, "protected tables + fee sums unchanged by apply");
      assert.deepEqual(mig.applyMigration(m).createdTables, [], "re-apply changes nothing");
      const p2 = mig.planMigration(m); assert.deepEqual(p2.tablesToCreate, []); assert.equal(p2.markerPresent, true);
      for (const id of plan.readTimeOnly.paidWithoutCaseIds) assert.ok(m.prepare("SELECT 1 FROM loan_filing_fee_charges WHERE id=? AND application_id IS NULL").get(id), `charge ${id} untouched`);
      // rollback refuses while drafts exist, unless --force
      const anyCustomer = m.prepare("SELECT id FROM customers LIMIT 1").get().id;
      m.prepare("INSERT INTO loan_request_drafts(customer_id,created_at,updated_at) VALUES(?,?,?)").run(anyCustomer, ts, ts);
      assert.equal(rb.applyRollback(m, {}).applied, false);
      m.prepare("DELETE FROM loan_request_drafts").run();
      const r = rb.applyRollback(m, {}); assert.equal(r.applied, true); assert.deepEqual([...r.dropped].sort(), [...mig.DRAFT_TABLES].sort());
      assert.ok(!m.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(mig.MARKER));
      assert.deepEqual(mig.fingerprint(m), fp0, "unchanged by rollback");
      console.log(`  migration on copy: schema only, converted 0; read-time only: ${plan.readTimeOnly.paidWithoutCase} paid fees without case (ids ${plan.readTimeOnly.paidWithoutCaseIds.join(",")}, ${plan.readTimeOnly.paidWithoutCaseSumToman} toman), hidden pre-registration cases ${plan.readTimeOnly.hiddenPreRegistrationDraftCaseIds.join(",")}`);
    } finally { m.close(); }
  });
  await ok("protected tables untouched (contracts, commissions, ledgers, SMS), no outbound request", async () => {
    assert.deepEqual(counts(), protectedBefore);
    assert.deepEqual(outbound, []);
  });
  console.log(`Request-drafts fixture passed: ${passed} checks.`);
} finally {
  server.close();
  globalThis.fetch = nativeFetch;
  try { db.crmDb?.close?.(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

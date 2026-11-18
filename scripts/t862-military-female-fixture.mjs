// t862 (Mohammad t862s2908): «خانم» answer for «پایان خدمت» on the customer file and the site form.
// A 2437-like file (woman, verified, fresh B3 credit, شغل آزاد, guarantor B3, no bounced/overdue) on a throwaway COPY of
// a masked DB: «ندارد» hides every plan whose conditions all need military service; «خانم» (and «مشمول نیست») keep them.
// Never live, never user 29, no network, no sapi/ICS24. loan_plans / loan_plan_conditions are read only (hash checked).
// Usage: T862_FIXTURE_DB=/path/masked.db node scripts/run-bundled-fixture.mjs scripts/t862-military-female-fixture.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const src = process.env.T862_FIXTURE_DB || process.env.DCI_FIXTURE_DB;
if (!src) { console.log("SKIP (set T862_FIXTURE_DB to a masked copy)"); process.exit(0); }
if (path.resolve(src) === "/var/lib/nafisvam/customers.db") throw new Error("REFUSE_LIVE_DB");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t862-mil-"));
const dbPath = path.join(dir, "crm.db");
fs.copyFileSync(src, dbPath);
fs.chmodSync(dbPath, 0o600);
Object.assign(process.env, {
  CRM_DATABASE_PATH: dbPath, NODE_ENV: "production", LOG_LEVEL: "warn",
  OPENAI_API_KEY: "fixture-placeholder-not-a-key",
  SESSION_SECRET: `fixture-only-${Math.random().toString(36).slice(2)}-not-a-real-secret-0123456789`,
});
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "http://127.0.0.1:9";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "fixture-placeholder";
globalThis.fetch = async () => { throw new Error("unexpected network call in t862 fixture"); };

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

const { queryRow, queryRows, execute } = await import("../src/lib/crm-db.ts");
const dossier = await import("../src/lib/customer-dossier.ts");
const site = await import("../src/lib/site-apply.ts");
const match = await import("../src/lib/plan-profile-match.ts");
const { latestApplicantProfile } = await import("../src/lib/team-sales.ts");
const loanRouter = (await import("../src/routes/loan-applications.ts")).default;

const planHash = () => crypto.createHash("sha256").update(JSON.stringify([
  queryRows("SELECT * FROM loan_plans ORDER BY id"), queryRows("SELECT * FROM loan_plan_conditions ORDER BY id")])).digest("hex");
const plansBefore = planHash();

// Synthetic 2437-like customer on the copy only (masked phone/ID placeholders, never a real person).
const cid = Number(queryRow("SELECT MAX(id) AS m FROM customers").m) + 1;
assert.notEqual(cid, 29);
const now = new Date();
execute(`INSERT INTO customers (id,name,phone,created_at,salesperson_id,priority,status,national_code,credit_rank,credit_checked_at,
  verification_status,first_name,last_name,official_first_name,birth_date_jalali,city)
  VALUES (?,?,?,?,NULL,2,'in_progress',?,?,?,'verified',?,?,?,?,NULL)`,
  [cid, "مشتری نمونه t862", "09000000000", now.toISOString(), "0000000000", "B3", now.toISOString(), "مشتری", "نمونه", "مشتری", "1338/12/10"]);
execute(`INSERT INTO customer_credit_checks (customer_id,requested_by_user_id,provider,national_code,status,score,score_label,created_at,updated_at,completed_at)
  VALUES (?,1,'fixture','0000000000','report_generated',584,'B3',?,?,?)`, [cid, now.toISOString(), now.toISOString(), now.toISOString()]);

const admin = { id: 1, role: "admin", salespersonId: null, fullName: "admin" };
const file = (military) => ({
  city: "تهران", amount_range: "300m_500m", loan_purpose: "goods", job_status: "self_employed",
  documents: ["sayadi_cheque", "guarantor"], has_military_card: military, can_refer_retiree: "no",
  has_bounced_or_overdue: "no", need_timing: "this_month", credit_rank: "B3", g_credit_rank: "B3",
});

const layer = loanRouter.stack.find((l) => l.route?.path === "/customers/:customerId/eligible-plans" && l.route.methods.get);
assert.ok(layer, "eligible-plans route");
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const eligible = () => {
  let status = 200, body = null;
  const res = { locals: { authUser: { id: 1, role: "admin", salespersonId: null, customerScope: "all", permissions: ["loan_applications.view"] } },
    status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  handler({ params: { customerId: String(cid) }, query: {} }, res, (e) => { if (e) throw e; });
  assert.equal(status, 200, JSON.stringify(body));
  return [...new Set(body.plans.map((p) => p.planId))].sort((a, b) => a - b);
};

// Plans whose every condition needs military service (the set «ندارد» hides); on the live data these are
// ستاره آبی(3), ترنم(8), فیروزه(12), آسا ۱(20), فراسا(22), زحل(23), آسا ۲(26).
const SEVEN = [3, 8, 12, 20, 22, 23, 26];
let withNo, withFemale;

await ok("old values still saved and read: yes / no / not_applicable", () => {
  for (const v of ["yes", "no", "not_applicable"]) {
    dossier.saveDossier(cid, admin, file(v), new Date(), { final: true });
    assert.equal(dossier.buildDossier(cid, {}).has_military_card, v);
  }
  assert.equal(dossier.militaryFromDossier("yes"), "has_card");
  assert.equal(dossier.militaryFromDossier("no"), "no_card");
  assert.equal(dossier.militaryFromDossier("not_applicable"), null);
  assert.equal(dossier.militaryFromDossier(""), null);
});

await ok("«ندارد» on a woman's file hides the seven military-only plans (the 2437 symptom)", () => {
  dossier.saveDossier(cid, admin, file("no"), new Date(), { final: true });
  assert.equal(latestApplicantProfile(cid)?.military, "no_card");
  withNo = eligible();
  for (const id of SEVEN) assert.ok(!withNo.includes(id), `plan ${id} hidden with «ندارد»`);
});

await ok("«خانم» is accepted, stored as female, and read back", () => {
  dossier.saveDossier(cid, admin, file("female"), new Date(), { final: true });
  const row = queryRow("SELECT answers_json FROM customer_dossier WHERE customer_id=?", [cid]);
  assert.equal(JSON.parse(row.answers_json).has_military_card, "female");
  assert.equal(dossier.buildDossier(cid, {}).has_military_card, "female");
  assert.equal(dossier.militaryFromDossier("female"), "female");
  assert.equal(latestApplicantProfile(cid)?.military, "female");
  assert.equal(dossier.overlayFirstCallAnswers(dossier.buildDossier(cid, {}), {}).military, "female");
});

await ok("«خانم» never removes a plan that needs military service: the seven come back", () => {
  withFemale = eligible();
  for (const id of SEVEN) assert.ok(withFemale.includes(id), `plan ${id} offered with «خانم»`);
  for (const id of withNo) assert.ok(withFemale.includes(id), `plan ${id} still offered`);
  const r = match.profileReasons({ jobs: [], gJobs: [], needsMilitary: true }, { military: "female" }, null);
  assert.deepEqual(r.map((x) => [x.code, x.kind]), [["military_ok", "met"]]);
  assert.equal(match.rowAllowsProfile({ needs_military_service: 1 }, { military: "female" }), true);
  assert.equal(match.rowAllowsProfile({ needs_military_service: 1 }, { military: "no_card" }), false);
});

await ok("«خانم» and «مشمول نیست» give the same plan list", () => {
  dossier.saveDossier(cid, admin, file("not_applicable"), new Date(), { final: true });
  assert.deepEqual(eligible(), withFemale);
});

await ok("invalid value is still rejected with 400 (stored value kept)", () => {
  dossier.saveDossier(cid, admin, file("female"), new Date(), { final: true });
  assert.throws(() => dossier.saveDossier(cid, admin, file("woman"), new Date(), { final: false }), (e) => e.status === 400);
  assert.equal(dossier.buildDossier(cid, {}).has_military_card, "female");
});

await ok("site form: «خانم» (female) accepted by validateSiteApply and labelled; old values unchanged", () => {
  const T0 = Date.parse("2026-11-18T10:00:00Z");
  const body = (m) => ({ type: "apply", name: "سارا نمونه", phone: "09120000000", amount_range: "100m_300m", job_status: "self_employed",
    documents: ["guarantor"], has_military_card: m, can_refer_retiree: "no", has_bounced_or_overdue: "no", need_timing: "this_month",
    consent: true, website: "", startedAt: T0 - 20_000, fillMs: 20_000 });
  for (const m of ["yes", "no", "not_applicable", "female"]) {
    const r = site.validateSiteApply(body(m), T0);
    assert.equal(r.ok, true, `${m}: ${JSON.stringify(r)}`);
    assert.equal(r.apply.answers.has_military_card, m);
  }
  const bad = site.validateSiteApply(body("woman"), T0);
  assert.equal(bad.ok, false); assert.ok(bad.fields.includes("has_military_card"));
  assert.equal(site.MILITARY_FA.female, "خانم");
  assert.equal(site.MILITARY_FA.not_applicable, "مشمول نیست");
});

await ok("loan_plans and loan_plan_conditions unchanged", () => { assert.equal(planHash(), plansBefore); });

console.log(`plans with «ندارد»: [${withNo}]  with «خانم»: [${withFemale}]`);
console.log(`t862 military-female fixture: ${passed}/8 passed (throwaway copy ${dir})`);
fs.rmSync(dir, { recursive: true, force: true });

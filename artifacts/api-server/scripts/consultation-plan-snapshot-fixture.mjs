import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

// Exercise the production consultation handlers/evaluator against an isolated
// synthetic database. No customer database, sessions, or provider is opened.
const source = await readFile(new URL("../src/routes/crm.ts", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const temp = await mkdtemp(path.join(os.tmpdir(), "consultation-snapshot-"));
let server;
try {
  const bundle = path.join(temp, "fixture.mjs");
  const definitions = section("function consultationFromRow", "function parseJsonArray");
  const fields = section("const consultationSelect =", "router.get(");
  const createRoute = section('router.post(\n  "/consultations",', 'router.get(\n  "/consultations/:id",');
  const matchRoutes = section('router.get(\n  "/consultations/:id/loan-plan-matches",', "function roleResponse");
  const evaluator = section("function parseRankList", 'router.get("/public/loan-plans"');
  await build({
    stdin: {
      resolveDir: path.resolve("."),
      loader: "ts",
      contents: `
        import express from "express";
        import { DatabaseSync } from "node:sqlite";
        import * as schemas from "@workspace/api-zod";
        import { questionnaireError, consultationRankMatches } from "./src/lib/consultation-questionnaire";
        import { consultationMaximumAmount } from "./src/lib/consultation-limits";
        import { acceptedGradeEdit, compactRankList, expandRankList, GRADE_EDIT_ERROR, isLegacyGradeLetter, parseStoredRanks } from "./src/lib/credit-subgrades";
        const {CreateConsultationBody, CreateConsultationResponse, MatchConsultationLoanPlansParams,
          MatchConsultationLoanPlansResponse, GetConsultationHistoricalLoanPlanMatchesResponse} = schemas;
        export const db = new DatabaseSync(":memory:");
        db.exec(\`CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,credit_rank TEXT,salesperson_id INTEGER);
          CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
          CREATE TABLE consultation_forms(id INTEGER PRIMARY KEY,customer_id INTEGER,questionnaire_version INTEGER DEFAULT 0,
            credit_rank TEXT,created_at TEXT,updated_at TEXT,plan_matches_snapshot TEXT,
            has_check INTEGER,has_promissory INTEGER,has_guarantor INTEGER,has_guarantor_check INTEGER,
            has_guarantor_promissory INTEGER,job_type TEXT,has_business_license INTEGER,has_account_turnover INTEGER,
            needs_fast_receive INTEGER,has_avg_balance INTEGER,loan_purpose TEXT,requested_amount TEXT,extra_notes TEXT,
            guarantor_credit_rank TEXT,guarantor_check_type TEXT,guarantor_job_type TEXT,collateral_type TEXT,
            guarantor_collateral_type TEXT,customer_check_status TEXT,receive_mode TEXT,loan_pref TEXT,need_days TEXT,
            has_customer_salary_deduct INTEGER,has_guarantor_salary_deduct INTEGER,
            author_user_id INTEGER,requested_amount_toman INTEGER,military_status TEXT);
          INSERT INTO customers VALUES(1,'Synthetic customer','00000000001','A1',10),
            (2,'Other synthetic customer','00000000002','B1',20);
          INSERT INTO salespersons VALUES(10,'One'),(20,'Two');\`);
        export let plans = [];
        export function setPlans(value) { plans = value; }
        const planSelect = "SELECT * FROM fixture_plans";
        const planFromRow = row => structuredClone(row);
        const queryRow = (sql, params=[]) => db.prepare(sql).get(...params);
        // Grade options come from consult_options (credit sub-grades); everything else reads the fixture plans.
        const queryRows = (sql, params=[]) => /consult_options/.test(sql)
          ? consultationQuestionnaireOptions().filter(o => o.fieldKey === params[0]).map(o => ({option_value:o.value}))
          : plans.filter(p => p.active);
        const execute = (sql, params=[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
        const executeChanges = (sql, params=[]) => db.prepare(sql).run(...params).changes;
        const runTransaction = fn => {
          db.exec("BEGIN"); try { const result=fn(); db.exec("COMMIT"); return result; }
          catch(error) { db.exec("ROLLBACK"); throw error; }
        };
        const getCustomer = (id,user) => queryRow("SELECT * FROM customers WHERE id=?" +
          (user.customerScope === "assigned" ? " AND salesperson_id=?" : ""),
          user.customerScope === "assigned" ? [id,user.salespersonId] : [id]);
        const consultationQuestionnaireOptions = () => [
          {fieldKey:"credit_rank",value:"C"}, {fieldKey:"guarantor_credit_rank",value:"A1"},
          {fieldKey:"guarantor_credit_rank",value:"C"}, {fieldKey:"job_type",value:"business"},
          {fieldKey:"guarantor_check_type",value:"physical"},
          {fieldKey:"customer_check_status",value:"physical"}
        ];
        export const app=express();
        const router=express.Router();
        const requirePermission = () => (req,res,next) => {
          if(req.header("X-Actor")==="denied") return res.status(403).json({error:"forbidden"});
          next();
        };
        app.use(express.json(),(req,res,next)=>{
          res.locals.authUser = req.header("X-Actor")==="expert"
            ? {id:7,customerScope:"assigned",salespersonId:10} : {id:1,customerScope:"all"};
          next();
        });
        ${definitions}
        ${fields}
        ${evaluator}
        ${createRoute}
        ${matchRoutes}
        app.use(router);
        app.use((error,req,res,next)=>res.status(500).json({error:"fixture_evaluation_failure"}));
      `,
    },
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    // Express uses CommonJS node builtins when bundled as ESM.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const fixture = await import(pathToFileURL(bundle).href);
  server = fixture.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, actor = "admin") {
    const response = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Actor": actor },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const condition = {
    id: 11, planId: 1, sortOrder: 0, customerRanks: '["C"]',
    customerJobs: [], guarantorJobs: [], needsGuarantor: false,
    needsCustomerCheck: true,
  };
  const plan = { id: 1, name: "Original plan", filingFeeToman: "0", principalAmount: "50000000", active: true,
    createdAt: "2026-01-01T00:00:00Z", conditions: [condition] };
  fixture.setPlans([plan, { ...plan, id: 2, name: "Unsuitable plan",
    conditions: [{ ...condition, id: 12, planId: 2, customerRanks: '["A"]' }] },
    { ...plan, id: 3, name: "Needs review", conditions: [] },
    { ...plan, id: 4, name: "Amount-limited plan",
      conditions: [{ ...condition, id: 14, planId: 4, maxPrincipal: "10000000" }] }]);
  const input = { customerId: 1, questionnaireVersion: 1, creditRank: "C",
    jobType: "business", customerCheckStatus: "physical",
    hasCustomerSalaryDeduct: false, hasGuarantor: false };
  const first = await request("/consultations", input, "expert");
  assert.equal(first.status, 201);
  const url = `/consultations/${first.data.id}/historical-loan-plan-matches`;
  const original = (await request(url, undefined, "expert")).data.snapshot;
  assert.equal(original.matches.length, 4);
  assert.equal(original.capturedAt, first.data.createdAt);
  assert.equal(original.requestedAmount, null);
  assert.equal(original.matches[0].status, "eligible");
  assert.equal(original.matches[0].plan.name, "Original plan");
  assert.deepEqual(original.matches[0].plan.conditions[0].customerRanks, '["C"]');
  assert.ok(original.matches.find(m => m.plan.id === 2).failedRequirements.length);
  assert.equal(original.matches.find(m => m.plan.id === 3).status, "needs_review");
  const missingAmount = original.matches.find(m => m.plan.id === 4);
  assert.equal(missingAmount.status, "eligible");
  assert.equal(missingAmount.customerMaximumAmount, "10000000");
  assert.ok(!missingAmount.missingInformation.includes("مبلغ درخواستی مشتری"));
  const currentMissingAmount = (await request(`/consultations/${first.data.id}/loan-plan-matches`))
    .data.find(m => m.plan.id === 4);
  assert.equal(currentMissingAmount.status, "eligible");
  assert.equal(currentMissingAmount.customerMaximumAmount, "10000000");
  const withinLimit = await request("/consultations", { ...input, requestedAmount: "9000000" });
  const withinSnapshot = (await request(`/consultations/${withinLimit.data.id}/historical-loan-plan-matches`)).data.snapshot;
  assert.equal(withinSnapshot.matches.find(m => m.plan.id === 4).status, "eligible");
  const overLimit = await request("/consultations", { ...input, requestedAmount: "11000000" });
  const overSnapshot = (await request(`/consultations/${overLimit.data.id}/historical-loan-plan-matches`)).data.snapshot;
  assert.equal(overSnapshot.matches.find(m => m.plan.id === 4).status, "not_eligible");
  assert.ok(overSnapshot.matches.find(m => m.plan.id === 4).failedRequirements.length);
  // V2: guarantor rank is required only when a guarantor exists. Promissory
  // availability is universal, and only actually matched paths determine caps.
  const guarantorInput = { ...input, questionnaireVersion: 2, hasGuarantor: true,
    guarantorCreditRank: "A1", guarantorCheckType: "physical", hasGuarantorSalaryDeduct: false };
  assert.equal((await request("/consultations", { ...guarantorInput, guarantorCreditRank: undefined })).status, 400);
  assert.equal((await request("/consultations", { ...guarantorInput, guarantorCreditRank: "not-a-rank" })).status, 400);
  const path1 = { ...condition, id: 21, maxPrincipal: "80000000", needsGuarantor: true,
    guarantorRanks: '["A"]', collateralType: "promissory", guarantorCollateralType: "promissory",
    needsCustomerPromissory: true, needsGuarantorPromissory: true };
  fixture.setPlans([{ ...plan, principalAmount: "500000000", conditions: [
    path1,
    { ...path1, id: 22, maxPrincipal: "120000000" },
    { ...path1, id: 23, maxPrincipal: "400000000", guarantorRanks: '["C"]' },
    { ...path1, id: 24, maxPrincipal: "450000000", needsGuarantorSalaryDeduct: true },
    { ...path1, id: 25, maxPrincipal: "480000000", guarantorJobs: ["formal"] },
  ] }]);
  const v2 = await request("/consultations", guarantorInput);
  assert.equal(v2.status, 201);
  assert.equal(v2.data.guarantorCreditRank, "A1");
  assert.equal(v2.data.hasPromissory, true);
  const v2History = (await request(`/consultations/${v2.data.id}/historical-loan-plan-matches`)).data.snapshot;
  assert.equal(v2History.matches[0].status, "eligible");
  assert.equal(v2History.matches[0].customerMaximumAmount, "480000000");
  assert.equal(v2History.matches[0].matchedConditionId, 25);
  assert.equal((await request(`/consultations/${v2.data.id}/loan-plan-matches`)).data[0].customerMaximumAmount, "480000000");
  const noGuarantor = await request("/consultations", { ...input, questionnaireVersion: 2,
    guarantorCreditRank: "A1" });
  assert.equal(noGuarantor.status, 201);
  assert.equal(noGuarantor.data.guarantorCreditRank, null);
  assert.equal((await request(`/consultations/${noGuarantor.data.id}/loan-plan-matches`)).data[0].status, "not_eligible");
  fixture.setPlans([{ ...plan, principalAmount: "100000000", conditions: [path1,
    { ...path1, id: 22, maxPrincipal: "120000000" }] }]);
  assert.equal((await request(`/consultations/${v2.data.id}/loan-plan-matches`)).data[0].customerMaximumAmount, "100000000");
  // Pending facts and malformed limits never silently expose the global amount.
  for (const changed of [
    { ...plan, conditions: [{ ...path1, maxPrincipal: "rank * 100000000" }] },
  ]) {
    fixture.setPlans([changed]);
    const match = (await request(`/consultations/${v2.data.id}/loan-plan-matches`)).data[0];
    assert.equal(match.status, "needs_review");
    assert.equal(match.customerMaximumAmount, null);
  }
  // Advice assumes occupation, turnover and average balance are compatible,
  // even for negative legacy answers; actual guarantor collateral still matters.
  fixture.setPlans([{ ...plan, needsAccountTurnover: true, needsAvgBalance: true,
    conditions: [{ ...path1, guarantorJobs: ["formal"] }] }]);
  const assumed = await request("/consultations", { ...guarantorInput,
    hasAccountTurnover: false, hasAvgBalance: false, guarantorJobType: "different" });
  assert.equal(assumed.status, 201);
  assert.equal(assumed.data.hasAccountTurnover, false);
  assert.equal(assumed.data.hasAvgBalance, false);
  const assumedMatch = (await request(`/consultations/${assumed.data.id}/loan-plan-matches`)).data[0];
  assert.equal(assumedMatch.status, "eligible");
  assert.equal(assumedMatch.customerMaximumAmount, "50000000");
  fixture.setPlans([{ ...plan, conditions: [{ ...path1, guarantorJobs: ["formal"],
    guarantorCollateralType: "digital_check" }] }]);
  const wrongCollateral = (await request(`/consultations/${assumed.data.id}/loan-plan-matches`)).data[0];
  assert.equal(wrongCollateral.status, "not_eligible");
  assert.ok(wrongCollateral.failedRequirements.some(reason => reason.includes("چک دیجیتال")));
  assert.ok(!wrongCollateral.missingInformation.some(reason => /شغل ضامن|گردش|میانگین/.test(reason)));
  fixture.setPlans([{ ...plan, conditions: [{ ...condition, needsCustomerPromissory: true,
    collateralType: "promissory" }] }]);
  const promissoryOnly = await request("/consultations", { ...input, questionnaireVersion: 2 });
  assert.equal((await request(`/consultations/${promissoryOnly.data.id}/loan-plan-matches`)).data[0].status, "eligible");
  assert.deepEqual((await request(`/consultations/${v2.data.id}/historical-loan-plan-matches`)).data.snapshot, v2History);
  fixture.setPlans([{ ...plan, name: "Renamed plan",
    conditions: [{ ...condition, customerRanks: '["A"]' }] }]);
  const live = await request(`/consultations/${first.data.id}/loan-plan-matches`);
  assert.equal(live.data[0].status, "not_eligible");
  assert.equal(live.data[0].plan.name, "Renamed plan");
  assert.deepEqual((await request(url)).data.snapshot, original);
  fixture.setPlans([]);
  assert.deepEqual((await request(`/consultations/${first.data.id}/loan-plan-matches`)).data, []);
  assert.deepEqual((await request(url)).data.snapshot, original);
  const second = await request("/consultations", input);
  assert.notEqual(first.data.id, second.data.id);
  assert.deepEqual((await request(`/consultations/${second.data.id}/historical-loan-plan-matches`)).data.snapshot.matches, []);
  assert.deepEqual((await request(url)).data.snapshot, original);
  assert.equal(fixture.db.prepare("SELECT credit_rank FROM customers WHERE id=1").get().credit_rank, "A1");
  const foreign = await request("/consultations", { ...input, customerId: 2 });
  assert.equal((await request(`/consultations/${foreign.data.id}/historical-loan-plan-matches`, undefined, "expert")).status, 404);
  assert.equal((await request(url, undefined, "denied")).status, 403);
  assert.equal((await request("/consultations/99999/historical-loan-plan-matches")).status, 404);
  fixture.db.prepare("INSERT INTO consultation_forms(id,customer_id,created_at,updated_at) VALUES(99,1,?,?)")
    .run("2020-01-01", "2020-01-01");
  assert.equal((await request("/consultations/99/historical-loan-plan-matches")).data.snapshot, null);
  await request("/consultations/99/loan-plan-matches");
  assert.equal((await request("/consultations/99/historical-loan-plan-matches")).data.snapshot, null);
  // crm-plans-consult phase 1: the author is recorded; «پایان خدمت» comes from Kazemi data (none here -> null,
  // shown as «باید بررسی شود»); «ندارد» blocks a route only when that route requires end of military service.
  assert.equal(fixture.db.prepare("SELECT author_user_id FROM consultation_forms WHERE id=?").get(first.data.id).author_user_id, 7);
  assert.equal(fixture.db.prepare("SELECT author_user_id FROM consultation_forms WHERE id=?").get(second.data.id).author_user_id, 1);
  assert.equal(first.data.militaryStatus, null);
  const noCard = await request("/consultations", { ...input, questionnaireVersion: 2, militaryStatus: "no_card" });
  assert.equal(noCard.status, 201);
  assert.equal(noCard.data.militaryStatus, "no_card");
  const militaryMatch = async (needsMilitaryService, id) => {
    fixture.setPlans([{ ...plan, conditions: [{ ...condition, needsMilitaryService }] }]);
    return (await request(`/consultations/${id}/loan-plan-matches`)).data[0];
  };
  assert.equal((await militaryMatch(false, noCard.data.id)).status, "eligible");
  const blocked = await militaryMatch(true, noCard.data.id);
  assert.equal(blocked.status, "not_eligible");
  assert.ok(blocked.failedRequirements.some(reason => reason.includes("پایان خدمت")));
  const hasCard = await request("/consultations", { ...input, questionnaireVersion: 2, militaryStatus: "has_card" });
  assert.equal((await militaryMatch(true, hasCard.data.id)).status, "eligible");
  const unknownMilitary = await request("/consultations", { ...input, questionnaireVersion: 2 });
  assert.equal(unknownMilitary.data.militaryStatus, null);
  assert.equal((await militaryMatch(false, unknownMilitary.data.id)).status, "eligible");
  assert.equal((await militaryMatch(true, unknownMilitary.data.id)).status, "needs_review");
  // An evaluation failure must roll back the consultation, not leave a partial save.
  fixture.setPlans([{ ...plan, conditions: null }]);
  const count = fixture.db.prepare("SELECT COUNT(*) AS n FROM consultation_forms").get().n;
  const failed = await fetch(base + "/consultations", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(failed.status, 500);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM consultation_forms").get().n, count);
  fixture.db.close();
  console.log("Consultation snapshot checks passed: immutable plans/conditions/reasons, fresh evaluation, empty snapshot, no backfill, rank preservation, customer scope, permissions, author, «پایان خدمت» and atomic rollback.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

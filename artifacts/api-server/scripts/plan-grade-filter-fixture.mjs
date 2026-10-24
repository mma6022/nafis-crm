// Plan-step credit-grade filter fixture (staff wizard «ثبت درخواست تسهیلات», customer portal, call form).
// Synthetic in-memory data only. Never touches live; sends nothing.
// Usage: node scripts/run-bundled-fixture.mjs scripts/plan-grade-filter-fixture.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire as makeRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { CREDIT_SUBGRADES, expandRankList, gradeMatches } from "../src/lib/credit-subgrades.ts";
import { conditionAcceptsCreditRank } from "../src/lib/credit-rank-eligibility.ts";
import { consultationRankMatches } from "../src/lib/consultation-questionnaire.ts";
import { matchPlans, plansFromRows } from "../src/lib/team-sales-rules.ts";

const root = process.cwd(); // run from artifacts/api-server (the bundle lives in a temp dir)
// esbuild is loaded at runtime (the bundler cannot bundle itself).
const { transformSync } = makeRequire(path.join(process.cwd(), "package.json"))("esbuild");
let passed = 0; const ok = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const LETTERS = ["A", "B", "C", "D", "E"];
const VALUES = [...CREDIT_SUBGRADES, ...LETTERS, "unknown", "", null];
// Rank lists shaped like the live plan conditions (after the sub-grade migration).
const LISTS = [["A"], ["B"], ["A", "B"], ["A", "B", "C"], ["A", "B", "C", "D"], ["C", "D"], ["A", "B", "C", "D", "E"], ["A2", "B1"], ["B2"], []];
const expected = (value, list) => {
  if (!list.length) return true;                       // no rank rule → everyone
  const v = String(value ?? "").trim().toUpperCase();
  if (!v || v === "UNKNOWN") return false;              // no grade never passes a ranked rule
  const exp = expandRankList(list);
  return v.length === 1 ? exp.some((g) => g[0] === v) : exp.includes(v);
};

/* ---------- 1. one matcher, every path ---------- */
const base = { callResult: "answered", urgency: "now", amountMillion: 50, mode: "simple", checkStatus: "any", canPromissory: "yes", bouncedCheque: "no", guarantorCount: 1 };
const callFormPlans = (custList, gList = []) => plansFromRows(
  [{ id: 1, name: "p", active: 1, principal_amount: 100000000 }],
  [{ id: 1, plan_id: 1, customer_ranks: JSON.stringify(expandRankList(custList)), guarantor_ranks: JSON.stringify(expandRankList(gList)), needs_guarantor: gList.length ? 1 : 0, max_principal: 100000000 }],
);
ok("applicant: wizard/portal matcher = expected for 15 sub-grades + letters + unknown × live-shaped lists", () => {
  for (const v of VALUES) for (const l of LISTS) {
    assert.equal(conditionAcceptsCreditRank(v, expandRankList(l)), expected(v, l), `wizard ${v} vs ${l}`);
  }
});
ok("applicant: call form = wizard/portal for every sub-grade and letter (unknown → assumption, not rejection)", () => {
  for (const v of [...CREDIT_SUBGRADES, ...LETTERS]) for (const l of LISTS) {
    assert.equal(matchPlans({ ...base, creditRank: v }, callFormPlans(l)).length > 0, expected(v, l), `call form ${v} vs ${l}`);
  }
  const m = matchPlans({ ...base, creditRank: "unknown" }, callFormPlans(["A"]));
  assert.equal(m.length, 1); assert.ok(m[0].assumptions.some((s) => s.includes("رتبهٔ متقاضی")));
});
ok("applicant: consultation matcher agrees for every sub-grade and letter", () => {
  for (const v of [...CREDIT_SUBGRADES, ...LETTERS]) for (const l of LISTS.filter((x) => x.length)) {
    assert.equal(consultationRankMatches(v, expandRankList(l)), expected(v, l), `consult ${v} vs ${l}`);
  }
});
ok("guarantor: same matcher for all 15 sub-grades + letters; unknown → assumption", () => {
  for (const g of [...CREDIT_SUBGRADES, ...LETTERS]) for (const l of LISTS.filter((x) => x.length)) {
    assert.equal(gradeMatches(g, expandRankList(l)), expected(g, l), `guarantor matcher ${g} vs ${l}`);
    assert.equal(matchPlans({ ...base, creditRank: "A1", gRank: g }, callFormPlans(["A"], l)).length > 0, expected(g, l), `call form guarantor ${g} vs ${l}`);
  }
  const m = matchPlans({ ...base, creditRank: "A1", gRank: "unknown" }, callFormPlans(["A"], ["A", "B"]));
  assert.equal(m.length, 1); assert.ok(m[0].assumptions.some((s) => s.includes("رتبهٔ ضامن")));
});
ok("ordering: A1 first … E3 last (15)", () => { assert.equal(CREDIT_SUBGRADES.length, 15); assert.equal(CREDIT_SUBGRADES[0], "A1"); assert.equal(CREDIT_SUBGRADES[14], "E3"); });

/* ---------- 2. the wizard's server route, with the real freshness rule ---------- */
const db = new DatabaseSync(":memory:");
db.exec(`
 CREATE TABLE customers(id INTEGER PRIMARY KEY,salesperson_id INTEGER,merged_into_customer_id INTEGER,verification_status TEXT,identity_changed_at TEXT);
 CREATE TABLE customer_credit_checks(id INTEGER PRIMARY KEY,customer_id INTEGER,status TEXT,score INTEGER,score_label TEXT,created_at TEXT,completed_at TEXT);
 CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT,active INTEGER,principal_amount TEXT,installment_terms TEXT,required_documents TEXT,needs_guarantor INTEGER,contract_template_id INTEGER,primary_contract_template_id INTEGER);
 CREATE TABLE loan_plan_conditions(id INTEGER PRIMARY KEY,plan_id INTEGER,customer_ranks TEXT,max_principal TEXT,installment_options TEXT,sort_order INTEGER,notes TEXT,needs_guarantor INTEGER);
 CREATE TABLE contract_templates(id INTEGER,mappings_json TEXT,deleted_at TEXT);`);
const plans = [[1, ["A"]], [2, ["A", "B"]], [3, ["A", "B", "C"]], [4, ["A", "B", "C", "D"]], [5, ["C", "D"]], [6, ["B"]], [7, []]];
for (const [id, list] of plans) {
  db.prepare("INSERT INTO loan_plans VALUES(?,?,1,'100000000','[12,24]','[]',0,NULL,NULL)").run(id, `plan ${id}`);
  db.prepare("INSERT INTO loan_plan_conditions VALUES(?,?,?,'50000000','[12]',0,NULL,0)").run(id * 10, id, JSON.stringify(expandRankList(list)));
}
const src = readFileSync(path.join(root, "src/routes/loan-applications.ts"), "utf8");
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, `source slice ${from}`); return src.slice(a, b); };
const fresh = cut("export function freshSuccessfulCredit(", "\nconst freshIdentityDocumentTypes").replace("export ", "");
const scoped = cut("function getScopedCustomer(", "\nfunction netLoanAmount(");
const terms = cut("export function effectivePlanTerms(", "\nexport function payablePlan(").replace("export ", "");
const route = cut('router.get("/customers/:customerId/eligible-plans"', 'router.get("/loan-applications/filing-fee-plans"');
let handler;
const queryRow = (sql, args = []) => db.prepare(sql).get(...args);
const queryRows = (sql, args = []) => db.prepare(sql).all(...args);
const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
new Function("router", "requirePermission", "user", "queryRow", "queryRows", "parseJson", "conditionAcceptsCreditRank", "separateRequirementKeys", "documentLabel", "error",
  transformSync(fresh + "\n" + scoped + "\n" + terms + "\n" + route, { loader: "ts" }).code)(
  { get: (_p, _perm, fn) => { handler = fn; } }, () => {}, (res) => res.actor, queryRow, queryRows, parseJson, conditionAcceptsCreditRank, new Set(), (k) => k,
  (res, status, code) => res.status(status).json({ error: code }));
const invoke = (customerId, ignore) => {
  const res = { actor: { role: "admin", customerScope: "all" }, statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
  handler({ params: { customerId: String(customerId) }, query: ignore === undefined ? {} : { ignoreCreditRank: ignore } }, res); return res.body;
};
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let cid = 1000;
const customerWith = (label, { identityChangedMsAgo = null, checkMsAgo = 60_000 } = {}) => {
  const id = ++cid;
  db.prepare("INSERT INTO customers VALUES(?,NULL,NULL,'verified',?)").run(id, identityChangedMsAgo == null ? null : iso(identityChangedMsAgo));
  if (label !== undefined) db.prepare("INSERT INTO customer_credit_checks(customer_id,status,score,score_label,created_at,completed_at) VALUES(?,'report_generated',600,?,?,?)").run(id, label, iso(checkMsAgo + 30_000), iso(checkMsAgo));
  return id;
};
ok("wizard eligible-plans: every sub-grade and letter gets exactly the plans whose conditions list it", () => {
  for (const v of [...CREDIT_SUBGRADES, ...LETTERS]) {
    const body = invoke(customerWith(v));
    assert.equal(body.credit.fresh, true); assert.equal(body.credit.rank, v);
    const want = plans.filter(([, l]) => expected(v, l)).map(([id]) => id);
    assert.deepEqual(body.plans.map((p) => p.planId), want, v);
  }
});
ok("wizard eligible-plans: unknown/empty grade only gets rank-free plans", () => {
  for (const v of ["unknown", ""]) assert.deepEqual(invoke(customerWith(v)).plans.map((p) => p.planId), [7]);
});
ok("wizard eligible-plans: an inquiry taken before an identity change is not used (fresh=false, no plans)", () => {
  const id = customerWith("B1", { checkMsAgo: 20 * 60_000, identityChangedMsAgo: 10 * 60_000 });
  const body = invoke(id);
  assert.equal(body.credit.fresh, false); assert.equal(body.credit.rank, null); assert.deepEqual(body.plans, []);
  db.prepare("INSERT INTO customer_credit_checks(customer_id,status,score,score_label,created_at,completed_at) VALUES(?,'report_generated',600,'B1',?,?)").run(id, iso(60_000), iso(30_000));
  const after = invoke(id);
  assert.equal(after.credit.fresh, true); assert.deepEqual(after.plans.map((p) => p.planId), [2, 3, 4, 6, 7]);
});
ok("wizard eligible-plans: a check older than 24 h is not used", () => {
  assert.equal(invoke(customerWith("A1", { checkMsAgo: 25 * 3600_000 })).credit.fresh, false);
});

/* ---------- 3. the wizard's credit step reads the same verdict as the plan step ---------- */
ok("wizard credit step trusts the server's credit.fresh (identity-change aware), not a client-only 24 h rule", () => {
  const wz = readFileSync(path.join(root, "../crm-dashboard/src/components/loan-applications/CreateWizard.tsx"), "utf8");
  const step = wz.slice(wz.indexOf("const latestCredit = creditChecks?.[0];"), wz.indexOf("const startCreditCheck"));
  assert.match(step, /useListCustomerEligiblePlans\(customer\.id, \{ ignoreCreditRank: false \}/);
  assert.match(step, /const hasFreshCredit = serverCredit \? serverCredit\.credit\.fresh/);
  assert.ok(wz.includes('data-testid="credit-stale-identity"'));
  assert.ok(wz.includes('data-testid="empty-plans-stale-credit"'));
});

console.log(`\n${passed} passed`);

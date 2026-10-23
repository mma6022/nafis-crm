// «درصد واریز به مشتری» (loanPlan.depositPercents): newer installment_terms vs legacy deposit_percents. Synthetic plans only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";

const libSource = fs.readFileSync(new URL("../src/lib/plan-payout-percent.ts", import.meta.url), "utf8");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "payout-")), "lib.mjs");
fs.writeFileSync(tmp, (await transform(libSource, { loader: "ts", format: "esm", target: "es2022" })).code);
const lib = await import(tmp);
const { resolvePlanPayoutPercent: r, PAYOUT_PERCENT_MISSING_FA, PAYOUT_PERCENT_NO_MONTHS_FA, PlanPayoutPercentMissingError } = lib;
const terms = (...pairs) => JSON.stringify(pairs.map(([installments, depositPercent]) => ({ installments, prepaymentPercent: 0, deductionPercent: 20, depositPercent })));

// legacy only
let x = r({ deposit_percents: '{"18": "55", "24": "60"}' }, 24);
assert.deepEqual([x.value, x.source, x.warning, x.conflict], ["60", "legacy", null, null]);
// newer only (the 4 goods plans with no legacy map)
x = r({ deposit_percents: null, installment_terms: terms([24, 53.5]) }, 24);
assert.deepEqual([x.value, x.source, x.warning], ["53.5", "newer", null]);
// both, agreeing → newer, no conflict
x = r({ deposit_percents: '{"24": "60"}', installment_terms: terms([24, 60]) }, 24);
assert.deepEqual([x.value, x.source, x.conflict], ["60", "newer", null]);
// both, conflicting → newer wins, conflict reported
x = r({ deposit_percents: '{"18": "55"}', installment_terms: terms([18, 43.5]) }, 18);
assert.deepEqual([x.value, x.source, x.conflict], ["43.5", "newer", { months: 18, newer: "43.5", legacy: "55" }]);
// newer has the count but no percent → falls back to legacy
x = r({ deposit_percents: '{"12": "60"}', installment_terms: JSON.stringify([{ installments: 12 }]) }, 12);
assert.deepEqual([x.value, x.source], ["60", "legacy"]);
// missing month in both → EMPTY + warning (old code printed the raw JSON here)
x = r({ deposit_percents: '{"18": "60", "24": "60"}', installment_terms: terms([18, 60], [24, 60]) }, 12);
assert.equal(x.value, "");
assert.equal(x.warning, `${PAYOUT_PERCENT_MISSING_FA} (۱۲ قسط)`);
assert.ok(!/[{}"]/.test(x.value));
x = r({ deposit_percents: null, installment_terms: null }, 24);
assert.deepEqual([x.value, x.warning], ["", `${PAYOUT_PERCENT_MISSING_FA} (۲۴ قسط)`]);
// malformed data → never raw text; valid other source still used
for (const plan of [
  { deposit_percents: "{bad json", installment_terms: "not json" },
  { deposit_percents: '{"24": "abc"}', installment_terms: terms([24, "شصت"]) },
  { deposit_percents: '{"24": "150"}', installment_terms: terms([24, -5]) },
  { deposit_percents: "[60]", installment_terms: '{"installments":24}' },
  { deposit_percents: "متن قدیمی", installment_terms: "[null, 5]" },
]) {
  x = r(plan, 24);
  assert.equal(x.value, "", JSON.stringify(plan));
  assert.ok(x.warning?.startsWith(PAYOUT_PERCENT_MISSING_FA));
  assert.ok(x.malformed.length > 0);
}
x = r({ deposit_percents: '{"24": "57"}', installment_terms: terms([24, "abc"]) }, 24);
assert.deepEqual([x.value, x.source], ["57", "legacy"]);
// Persian digits / decimal separator, array snapshots, legacy scalar
assert.equal(r({ installment_terms: terms([24, "۵۵٫۵"]) }, 24).value, "55.5");
assert.equal(r({ installment_terms: [{ installments: "۲۴", depositPercent: 58 }], deposit_percents: { 24: "57" } }, 24).value, "58");
assert.equal(r({ deposit_percents: "60" }, 36).value, "60");
// months from the approved application terms; standalone (no months) only when unambiguous
assert.equal(r({ _approved_duration_months: 18, installment_terms: terms([12, 63], [18, 60]) }).value, "60");
assert.equal(r({ installment_terms: terms([24, 58]) }).value, "58");
x = r({ deposit_percents: '{"18": "60", "24": "55"}', installment_terms: terms([18, 60], [24, 55]) });
assert.deepEqual([x.value, x.warning], ["", PAYOUT_PERCENT_NO_MONTHS_FA]);

// Wired into the contract resolver + formula (no silent 0)
const source = fs.readFileSync(new URL("../src/routes/contracts.ts", import.meta.url), "utf8");
const section = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return source.slice(a, b).replace(/^export /gm, ""); };
const code = [section("function normalizeNumber(", "type FormulaToken"), section("export function mappingUsesPayoutPercent(", "function contractDateValue("),
  section("function formatNumber(", "function shouldGroupContractValue("), section("export function evaluateFormulaTokens(", "const formulaValue")].join("\n");
const ctx = vm.createContext({ fields: {}, queryRow: () => undefined, resolvePlanPayoutPercent: r, PlanPayoutPercentMissingError });
vm.runInContext((await transform(code, { loader: "ts", target: "es2022" })).code, ctx);
const plan20 = { id: 20, principal_amount: "300000000", deposit_percents: null, installment_terms: terms([24, 60]) };
assert.equal(ctx.loanPlanFieldValue(plan20, "loanPlan.depositPercents", 24), "60");
assert.equal(ctx.loanPlanFieldValue(plan20, "loanPlan.depositPercents", 12), "");
assert.equal(ctx.loanPlanFieldValue({ deposit_percents: '{"18":"60","24":"60"}' }, "loanPlan.depositPercents", 12), "");
const tokens = [{ type: "field", field: "loanPlan.principalAmount" }, { type: "operator", value: "*" }, { type: "field", field: "loanPlan.depositPercents" }, { type: "operator", value: "/" }, { type: "literal", value: "100" }];
assert.equal(ctx.evaluateFormulaTokens({ tokens }, {}, plan20, 24), "180000000");
assert.throws(() => ctx.evaluateFormulaTokens({ tokens }, {}, plan20, 12), (e) => e instanceof PlanPayoutPercentMissingError && e.warning === `${PAYOUT_PERCENT_MISSING_FA} (۱۲ قسط)`);
assert.equal(ctx.mappingUsesPayoutPercent({ variable: "payabletoamr", sourceType: "formula", formula: { tokens } }), true);
assert.equal(ctx.mappingUsesPayoutPercent({ variable: "x", sourceType: "loanPlan", loanPlanField: "loanPlan.depositPercents" }), true);
assert.equal(ctx.mappingUsesPayoutPercent({ variable: "x", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" }), false);
// generate route answers with the Persian warning (shown by the existing error UI via payload.message)
assert.match(source, /error: "plan_payout_percent_missing", message: payout\.warning/);
assert.match(source, /router\.get\("\/contracts\/templates\/:id\/plan-warnings"/);
for (const f of ["../src/lib/plan-payout-percent.ts", "../src/routes/contracts.ts", "../../crm-dashboard/src/pages/Contracts.tsx", "../../crm-dashboard/src/pages/LoanApplicationDetail.tsx"])
  assert.ok(!fs.readFileSync(new URL(f, import.meta.url), "utf8").includes("\u0633\u067e\u0631\u062f"), `forbidden word root in ${f}`);
console.log("PASS payout percent: legacy, newer, both/conflict, missing month (empty + warning), malformed, formula guard");

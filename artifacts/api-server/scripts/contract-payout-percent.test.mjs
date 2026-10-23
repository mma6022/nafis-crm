// Exercise the actual route functions in isolation, with synthetic settings only.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transform } from "esbuild";

const source = fs.readFileSync(new URL("../src/routes/contracts.ts", import.meta.url), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return source.slice(a, b).replace(/^export /gm, "");
}
const code = [
  section("function normalizeNumber(", "type FormulaToken"),
  section("const loanPlanFields:", "function fieldValue("),
  section("export function loanPlanFieldValue(", "function contractDateValue("),
  section("function formatNumber(", "function shouldGroupContractValue("),
  section("export function evaluateFormulaTokens(", "const formulaValue"),
].join("\n");
let settings = 6000, lookups = 0;
const context = vm.createContext({
  fields: {},
  queryRow(sql, params) {
    assert.equal(sql, "SELECT customer_payout_bps FROM goods_plan_settings WHERE plan_id=?");
    assert.equal(params[0], 20);
    lookups++;
    return settings === undefined ? undefined : { customer_payout_bps: settings };
  },
});
vm.runInContext((await transform(code, { loader: "ts", target: "es2022" })).code, context);
const field = "loanPlan.customerPayoutPercent";
assert.equal(vm.runInContext(`loanPlanFields["${field}"]`, context), "درصد واریز به مشتری");
assert.equal(context.loanPlanFieldValue({ id: 20 }, field), "60");
settings = 6025;
assert.equal(context.loanPlanFieldValue({ id: 20 }, field), "60.25");
settings = 0;
assert.equal(context.loanPlanFieldValue({ id: 20 }, field), "0");
settings = 10000;
assert.equal(context.loanPlanFieldValue({ id: 20 }, field), "100");
for (const invalid of [undefined, null, -1, 10001, 60.5, "6000"]) {
  settings = invalid;
  assert.throws(() => context.loanPlanFieldValue({ id: 20 }, field), /formula_value_invalid/);
}
settings = 7000;
const plan = { id: 20, principal_amount: "300000000", _goods_customer_payout_bps: 6000 };
const before = lookups;
assert.equal(context.loanPlanFieldValue(plan, field), "60");
const tokens = [
  { type: "field", field: "loanPlan.principalAmount" },
  { type: "operator", value: "*" }, { type: "field", field },
  { type: "operator", value: "/" }, { type: "literal", value: "100" },
];
assert.equal(context.evaluateFormulaTokens({ tokens }, {}, plan), "180000000");
assert.equal(lookups, before, "Purchase snapshot must not load newer settings");
assert.equal(context.evaluateFormulaTokens({ tokens }, {}, { id: 20, principal_amount: "300000000" }), "210000000");
assert.throws(() => context.loanPlanFieldValue({ id: 20, _goods_customer_payout_bps: null }, field), /formula_value_invalid/);
const goods = fs.readFileSync(new URL("../src/lib/goods-documents.ts", import.meta.url), "utf8");
assert.match(goods, /_goods_customer_payout_bps: payoutSnapshot\?\.payout_bps/);
assert.match(goods, /loanPlanFieldValue\(formulaPlan, mapping\.loanPlanField\)/);
assert.match(goods, /evaluateFormulaTokens\(mapping\.formula, customer, formulaPlan\)/);
console.log("PASS payout percentage catalog, basis-point conversion, bounds, direct mapping, formula and purchase snapshot");
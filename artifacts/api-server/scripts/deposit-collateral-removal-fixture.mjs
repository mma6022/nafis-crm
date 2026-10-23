// Bank-deposit collateral was removed as a product option. Proves:
//  1) plans with every other collateral type rank exactly as before (rank table + package order),
//  2) a legacy stored "deposit" value (key or old/renamed label) never throws and is treated as unspecified (neutral),
//  3) no deposit label is emitted to customers.
// The old label words are written as escapes so this file never contains them.
import assert from "node:assert/strict";
import { collateralRank, selectInstagramLoanPackages } from "../src/lib/instagram-loan-packages.ts";
import { projectInstagramPublicPlans } from "../src/lib/instagram-public-plans.ts";

const OLD_LABEL = "\u0633\u067e\u0631\u062f\u0647 \u0628\u0627\u0646\u06a9\u06cc";            // legacy label (old word)
const RENAMED_LABEL = "\u062d\u0633\u0627\u0628 \u0645\u0633\u062f\u0648\u062f\u06cc \u0628\u0627\u0646\u06a9\u06cc"; // short-lived rename

// 1) Ranks for all real collateral types — identical to the pre-removal values.
const BEFORE = [
  [null, 2], [undefined, 2], [[], 0], [["سفته"], 1], [["سفته", "سفته"], 1],
  [["چک"], 3], [["چک فیزیکی"], 3], [["چک دیجیتال"], 3], [["سند ملکی"], 3], [["سند خودرو"], 3],
  [["گواهی کسر از حقوق"], 3], [["سفته", "چک فیزیکی"], 3], [["وثیقه"], 2], [["بدون وثیقه"], 2],
];
for (const [values, rank] of BEFORE) assert.equal(collateralRank(values), rank, `rank unchanged for ${JSON.stringify(values)}`);

// 2) Legacy values: neutral rank 2 (= unspecified), never a throw.
for (const values of [[OLD_LABEL], [RENAMED_LABEL], ["deposit"], ["DEPOSIT "]]) {
  assert.doesNotThrow(() => collateralRank(values));
  assert.equal(collateralRank(values), 2, "legacy deposit collateral is neutral");
}

// Package order for plans with other collateral types is unchanged, and adding a legacy-deposit plan
// does not reorder them.
const plan = (name, payout, customerCollateral) => ({
  name, options: [{ installmentCount: 12, customerPayout: payout, installmentAmount: null }],
  customerDocuments: [], guarantorDocuments: null, guarantorRequired: false, customerCollateral, guarantorCollateral: [],
});
const others = [
  plan("طرح چک", 100_000_000, ["چک فیزیکی"]),
  plan("طرح سفته", 100_000_000, ["سفته"]),
  plan("طرح بدون وثیقه", 100_000_000, []),
  plan("طرح ملک", 100_000_000, ["سند ملکی"]),
  plan("طرح نامشخص", 100_000_000, null),
];
const names = (plans, pkgs) => pkgs.map((p) => p.options.map((o) => plans[o.planIndex]?.name ?? o.planName ?? JSON.stringify(o)).join("+"));
const order = names(others, selectInstagramLoanPackages(others, 90_000_000));
// Baseline captured from the pre-removal code (HEAD 458de68) with the same inputs.
assert.deepEqual(order, ["طرح بدون وثیقه", "طرح سفته", "طرح نامشخص", "طرح چک", "طرح ملک"], "order of non-deposit plans unchanged");
const withLegacy = [...others, plan("طرح قدیمی", 100_000_000, [RENAMED_LABEL])];
let legacyOrder;
assert.doesNotThrow(() => { legacyOrder = names(withLegacy, selectInstagramLoanPackages(withLegacy, 90_000_000)); });
assert.deepEqual(legacyOrder.filter((n) => n !== "طرح قدیمی"), order,
  "a legacy deposit plan does not change the relative order of other plans");

// 3) Public projection: a condition stored with collateral "deposit" is unspecified, not an error, and emits no label.
const base = { principalAmount: "100000000", installmentTerms: '[{"installments":"12","depositPercent":"80"}]', active: 1 };
const projected = projectInstagramPublicPlans([
  { ...base, name: "قدیمی", collateralType: "deposit" },
  { ...base, name: "قدیمی ۲", conditions: [{ collateralType: "deposit", maxPrincipal: "100000000" }] },
  { ...base, name: "ملکی", collateralType: "property" },
  { ...base, name: "چکی", collateralType: "physical_check", needsCustomerCheck: 1 },
], new Map());
const by = Object.fromEntries(projected.map((p) => [p.name, p]));
assert.equal(by["قدیمی"].customerCollateral, null, "legacy deposit → unspecified");
assert.deepEqual(by["ملکی"].customerCollateral, ["سند ملکی"], "property unchanged");
assert.deepEqual(by["چکی"].customerCollateral, ["چک فیزیکی"], "check unchanged");
const text = JSON.stringify(projected);
for (const w of [OLD_LABEL, RENAMED_LABEL, "deposit\""]) assert(!text.includes(w), `no deposit label emitted (${w})`);
console.log("deposit-collateral-removal: ok", JSON.stringify(order));


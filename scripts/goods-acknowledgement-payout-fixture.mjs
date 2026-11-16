import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  entryPoints: ["src/lib/goods-acknowledgement-payout.ts"], bundle: true,
  platform: "node", format: "esm", write: false,
});
const { settledAcknowledgementPayout: resolve } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const formula = { tokens: [
  { type: "field", field: "loanPlan.principalAmount" },
  { type: "operator", value: "*" },
  { type: "field", field: "loanPlan.customerPayoutPercent" },
  { type: "operator", value: "/" },
  { type: "literal", value: "100" },
] };
for (const amount of ["75000000", "78000000", "76363760", "0", "1"]) {
  assert.equal(resolve(formula, amount), amount);
}
const reversed = structuredClone(formula);
[reversed.tokens[0], reversed.tokens[2]] = [reversed.tokens[2], reversed.tokens[0]];
assert.equal(resolve(reversed, "75000000"), "75000000");
const unrelated = structuredClone(formula);
unrelated.tokens[2].field = "loanPlan.commissionPercent";
assert.equal(resolve(unrelated, "75000000"), null);
assert.equal(resolve(null, "75000000"), null);
assert.throws(() => resolve(formula, "-1"), /template_payout_invalid/);
assert.equal(formula.tokens[2].field, "loanPlan.customerPayoutPercent");
console.log("Acknowledgement payout: reduced/increased/base/zero/rounding and unrelated formulas passed.");

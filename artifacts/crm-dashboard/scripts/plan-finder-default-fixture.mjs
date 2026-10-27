import assert from "node:assert/strict";
import { bestPayoutDuration, planFinderCalc } from "../../api-server/src/lib/plan-quote-math.ts";

const term = (installments, depositPercent) => ({ installments, prepaymentPercent: null, deductionPercent: null, depositPercent: String(depositPercent) });
const plan = (terms, conditions, principalAmount = "200000000") => ({
  id: 1, name: "fixture", principalAmount, annualInterest: "23", installments: terms.map(t => t.installments).join(","),
  installmentTerms: terms, conditions,
});

// 1. Max is a middle option: 24 months pays 78% vs 70% / 75%.
{
  const p = plan([term(12, 70), term(24, 78), term(36, 75)], [{ id: 1, maxPrincipal: "200000000", installmentOptions: [12, 24, 36] }]);
  const c = planFinderCalc(p);
  assert.deepEqual(c.durations, [12, 24, 36]);
  assert.equal(c.best, 24);
  assert.equal(c.payout(24), 156000000);
}
// 2. Max is the last option because a longer-term condition has a higher ceiling (same payout %).
{
  const p = plan([term(12, 80), term(36, 80)], [
    { id: 1, maxPrincipal: "100000000", installmentOptions: [12] },
    { id: 2, maxPrincipal: "300000000", installmentOptions: [36] },
  ]);
  const c = planFinderCalc(p);
  assert.equal(c.best, 36);
  assert.equal(c.payout(36), 240000000);
  // The customer's maximum caps every duration's principal: then only the payout % decides, and 80/80 ties go to the shorter term.
  assert.equal(planFinderCalc(p, "100000000").best, 12);
  assert.equal(planFinderCalc(p, "150000000").best, 36); // 100M×80% < 150M×80%
}
// 3. Customer cap applies before the comparison: 36 months has the higher ceiling but a lower %, cap makes 12 months win.
{
  const p = plan([term(12, 80), term(36, 70)], [
    { id: 1, maxPrincipal: "100000000", installmentOptions: [12] },
    { id: 2, maxPrincipal: "300000000", installmentOptions: [36] },
  ]);
  assert.equal(planFinderCalc(p).best, 36); // 70% of 300M > 80% of 100M
  assert.equal(planFinderCalc(p, "100000000").best, 12); // both capped at 100M: 80% > 70%
}
// 4. Ties pick the shortest; durations without a computable payout are skipped; nothing computable falls back to the first.
assert.equal(bestPayoutDuration([12, 18, 24], () => 5), 12);
assert.equal(bestPayoutDuration([12, 18, 24], n => (n === 12 ? null : n === 18 ? 9 : 7)), 18);
assert.equal(bestPayoutDuration([12, 18], () => null), 12);
assert.equal(bestPayoutDuration([], () => 1), null);
// 5. Installment uses the real PMT on the same capped principal.
{
  const p = plan([term(12, 80)], [{ id: 1, maxPrincipal: "120000000", installmentOptions: [12] }]);
  const i = planFinderCalc(p).installment(12);
  assert.ok(i > 10000000 && i < 11500000, `installment ${i}`);
}
console.log("PASS: plan finder defaults to the installment count with the highest received amount.");

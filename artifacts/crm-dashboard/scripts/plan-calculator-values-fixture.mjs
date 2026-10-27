// Run: node --experimental-strip-types artifacts/crm-dashboard/scripts/plan-calculator-values-fixture.mjs
import assert from 'node:assert/strict';
import { monthlyPmt, parseCalculatorAmount, principalCeiling, calculatorDurations, calculatorCeiling,
  customerPayout, maximumCustomerPayout, planAnnualInterest, cashCalculatorBounds,
  principalFromCustomerPayout, eligibleConditionId } from '../../api-server/src/lib/plan-quote-math.ts';

// Independently known end-of-period PMT reference (1% monthly, twelve payments).
assert.ok(Math.abs(monthlyPmt(1_000_000, 12, 12) - 88_848.7886783417) < 0.000001);
assert.equal(monthlyPmt(12_000_000, 0, 12), 1_000_000);
for (const input of [[0, 23, 12], [-1, 23, 12], [100, -1, 12], [100, NaN, 12],
  [100, 23, 0], [100, 23, 1.5], [100, 23, 601], [Infinity, 23, 12]]) {
  assert.equal(monthlyPmt(...input), null);
}
assert.equal(parseCalculatorAmount('۱۰۰٬۰۰۰٬۰۰۰'), 100_000_000);
assert.equal(parseCalculatorAmount('١٠٠٠٠٠'), 100_000);
for (const value of ['', '0', '-100', 'abc', '1.5', null, '9007199254740992']) {
  assert.equal(parseCalculatorAmount(value), null);
}
const plan = {
  principalAmount: '100000000', annualInterest: '23', installments: '["12","24"]',
  installmentTerms: [], depositPercents: '{"12":"60","24":"75"}',
  prepaymentPercents: '{"12":"0","24":"0"}', deductPercents: '{"12":"10","24":"15"}',
  conditions: [],
};
assert.equal(principalCeiling(plan), 100_000_000);
assert.equal(maximumCustomerPayout(plan), 75_000_000);
assert.equal(customerPayout(plan, 50_000_000, 12), 30_000_000);
assert.equal(customerPayout(plan, 50_000_000, 24), 37_500_000);
assert.equal(customerPayout(plan, 50_000_000, 36), null);
assert.equal(customerPayout({ ...plan, depositPercents: null }, 50_000_000, 12), null);
assert.equal(customerPayout({ ...plan, depositPercents: '{"12":"0"}' }, 50_000_000, 12), 0);
assert.equal(planAnnualInterest({ ...plan, annualInterest: '{"12":"0","24":"23"}' }, 12), 0);
assert.equal(planAnnualInterest({ ...plan, annualInterest: '{"12":"0","24":"23"}' }, 24), 23);
assert.equal(planAnnualInterest({ ...plan, annualInterest: '{"12":"0"}' }, 24), null);
const conditional = { ...plan, conditions: [
  { id: 1, maxPrincipal: '40000000', installmentOptions: [12] },
  { id: 2, maxPrincipal: '80000000', installmentOptions: [24] },
] };
assert.equal(principalCeiling(conditional), 80_000_000);
assert.equal(principalCeiling(conditional, 1), 40_000_000);
assert.equal(calculatorCeiling(conditional, 12), 40_000_000);
assert.equal(calculatorCeiling(conditional, 24), 80_000_000);
assert.equal(calculatorCeiling(conditional, 36), null);
assert.deepEqual(calculatorDurations(conditional, 1), [12]);
assert.equal(maximumCustomerPayout(conditional), 60_000_000);
assert.equal(principalCeiling(conditional, 999), null);
assert.equal(maximumCustomerPayout({ ...conditional, depositPercents: '{"12":"60"}' }), null);
assert.equal(principalCeiling({ ...conditional, conditions: [{ id: 1, maxPrincipal: 'bad' }] }), null);
assert.equal(maximumCustomerPayout({ ...plan, installmentTerms: [
  { installments: 12, prepaymentPercent: 0, deductionPercent: 30, depositPercent: 65 },
] }), 65_000_000);
assert.equal(principalFromCustomerPayout(plan, 600_000, 12, 100_000_000), 1_000_000);
assert.equal(principalFromCustomerPayout(plan, 600_000, 24, 100_000_000), 800_000);
assert.equal(principalFromCustomerPayout(plan, 75_000_001, 24, 100_000_000), null);
assert.equal(principalFromCustomerPayout(plan, 0, 12, 100_000_000), null);
assert.equal(principalFromCustomerPayout({ ...plan, depositPercents: '{"12":0}' }, 1, 12, 100_000_000), null);
assert.equal(principalFromCustomerPayout({ ...plan, depositPercents: '{"12":30}' }, 1, 12, 2), 2);
assert.equal(principalFromCustomerPayout(plan, 1, 12, 100_000_000, 1000), null);
const eligible = { planId: 1, name: 'fixture', maximumAmount: '20000000', allowedDurations: [12, 24], conditions: [
  { id: 1, minimumAmount: '1000', maximumAmount: '10000000', allowedDurations: [12] },
  { id: 2, minimumAmount: '1000', maximumAmount: '20000000', allowedDurations: [24] },
] };
assert.deepEqual(cashCalculatorBounds(conditional, 12, eligible), { minimumPrincipal: 1000, maximumPrincipal: 10_000_000, durations: [12, 24] });
assert.equal(cashCalculatorBounds(conditional, 24, eligible).maximumPrincipal, 20_000_000);
assert.equal(maximumCustomerPayout(conditional, eligible), 15_000_000);
assert.equal(cashCalculatorBounds(conditional, 36, eligible).maximumPrincipal, null);
assert.equal(eligibleConditionId(eligible, '1000000', 12), 1);
assert.equal(eligibleConditionId(eligible, '800000', 24), 2);
assert.equal(eligibleConditionId(eligible, '10000001', 12), null);
assert.equal(eligibleConditionId(eligible, '1000000', 36), null);
assert.equal(eligibleConditionId(eligible, '1', 12), null);
process.stdout.write('PASS PMT reference/zero/invalid cases, original-principal payout separation, duration maps and condition-specific ceilings.\n');

// Run: node --experimental-strip-types artifacts/crm-dashboard/scripts/plan-display-values-fixture.mjs
import assert from 'node:assert/strict';
import { displayPlanTerms, durationPercent, planDurations } from '../src/customer-portal/plan-display-values.ts';

assert.deepEqual(planDurations('["12","24","12"]'), [12, 24]);
assert.deepEqual(planDurations('["۱۲","۲۴"]'), [12, 24]);
assert.deepEqual(planDurations('[-1,0,12,601]'), [12]);
assert.equal(durationPercent('{"12":"25.5","24":"40"}', 12), 25.5);
assert.equal(durationPercent('{"12":"25.5","24":"40"}', 24), 40);
assert.equal(durationPercent('{"12":"0"}', 12), 0);
assert.equal(durationPercent('{"12":"10"}', 24), null);
assert.equal(durationPercent('{"۱۲":"۱۴.۵"}', 12), 14.5);
for (const invalid of [null, '', 'not-a-rule', '{"12":"bad"}', '101', '-1', '[]', 'true']) {
  assert.equal(durationPercent(invalid, 12), null, `Reject invalid percentage ${invalid}`);
}

assert.deepEqual(displayPlanTerms({
  installmentTerms: [], installments: '["12","24"]',
  prepaymentPercents: '{"12":"5","24":"10"}',
  deductPercents: '{"12":"10","24":"20"}',
  depositPercents: '{"12":"0","24":"30"}',
}), [
  { installments: 12, prepaymentPercent: 5, deductionPercent: 10, depositPercent: 0 },
  { installments: 24, prepaymentPercent: 10, deductionPercent: 20, depositPercent: 30 },
]);
assert.deepEqual(displayPlanTerms({
  installmentTerms: [{ installments: 12, prepaymentPercent: 0, deductionPercent: 10, depositPercent: 25 }],
  installments: '["24"]', prepaymentPercents: '99', deductPercents: '99', depositPercents: '99',
}), [{ installments: 12, prepaymentPercent: 0, deductionPercent: 10, depositPercent: 25 }]);
assert.deepEqual(displayPlanTerms({
  installmentTerms: [], installments: '["12"]',
  prepaymentPercents: null, deductPercents: '{"24":"10"}', depositPercents: 'bad',
}), [{ installments: 12, prepaymentPercent: null, deductionPercent: null, depositPercent: null }]);
process.stdout.write('PASS plan display: structured/legacy duration terms, Persian digits, explicit zero and fail-closed missing/invalid percentages.\n');

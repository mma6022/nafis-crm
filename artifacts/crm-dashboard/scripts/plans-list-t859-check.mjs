// t859: plans list shows «both» as «هردو» and percentages as Persian digits + «٪». Display only (no loan_plans writes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faPercent, processModeLabel, PROCESS_MODE_FA } from '../src/lib/plan-list-format.ts';

assert.equal(processModeLabel('both'), 'هردو');
assert.equal(processModeLabel('both', null), 'هردو');
assert.equal(processModeLabel('both', 'هردو'), 'هردو');
assert.equal(processModeLabel('in_person'), 'حضوری');
assert.equal(processModeLabel('remote'), 'غیرحضوری');
assert.equal(processModeLabel('in_person', 'حضوری (شعبه)'), 'حضوری (شعبه)', 'dictionary label wins');
assert.equal(processModeLabel(''), '—');
assert.equal(processModeLabel(null), '—');
assert.equal(processModeLabel('other'), 'other');
assert.equal(PROCESS_MODE_FA.both, 'هردو');

assert.equal(faPercent(40), '۴۰٪');
assert.equal(faPercent('40'), '۴۰٪');
assert.equal(faPercent(0), '۰٪');
assert.equal(faPercent(5.5), '۵٫۵٪');
assert.equal(faPercent('23'), '۲۳٪');
assert.equal(faPercent('23%'), '۲۳٪');
assert.equal(faPercent('۲۳٪'), '۲۳٪');
assert.equal(faPercent(null), '—');
assert.equal(faPercent(undefined), '—');
assert.equal(faPercent(''), '—');
assert.equal(faPercent('23 تا 25%'), '۲۳ تا ۲۵٪');

const page = readFileSync(new URL('../src/pages/LoanPlans.tsx', import.meta.url), 'utf8');
assert.ok(page.includes("from '@/lib/plan-list-format'"), 'LoanPlans imports the formatter');
assert.ok(page.includes('processModeLabel(plan.processMode'), 'روش اجرا uses processModeLabel');
assert.ok(!page.includes("{plan.processMode || '—'}"), 'raw processMode no longer rendered');
for (const f of ['prepaymentPercent', 'deductionPercent', 'depositPercent']) assert.ok(page.includes(`faPercent(term.${f})`), f);
for (const f of ['commissionPercent', 'operationCostsPercent', 'grantedDiscountPercent', 'purchaseCommissionPercent', 'salesCommissionPercent', 'loanAcquisitionFeePercent']) {
  assert.ok(page.includes(`faPercent(plan.${f})`), f);
  assert.ok(!page.includes(`\`\${plan.${f}}٪\``), `${f} raw`);
}
assert.ok(page.includes('faPercent(plan.annualInterest)'), 'annual interest on the list card');
assert.ok(!/\{term\.(prepayment|deduction|deposit)Percent\}٪/.test(page), 'no Latin-digit term percents left');
console.log('plans-list-t859 PASS (both→هردو, Persian % with ٪, display only)');

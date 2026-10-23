import assert from 'node:assert/strict';
import { buildPlanFinderRequest } from '../src/customer-portal/plan-finder-answers.ts';
import { portalApi } from '../src/customer-portal/api.ts';
import { CreateConsultationBody } from '../../../lib/api-zod/src/generated/api.ts';
import { questionnaireError } from '../../api-server/src/lib/consultation-questionnaire.ts';

const allowed = new Set(['questionnaireVersion', 'creditRank', 'customerCheckStatus',
  'hasCustomerSalaryDeduct', 'jobType', 'hasGuarantor', 'guarantorCreditRank',
  'guarantorCheckType', 'hasGuarantorSalaryDeduct', 'requestedAmount']);
const options = [
  ['credit_rank', 'A1'], ['job_type', 'employee'], ['customer_check_status', 'none'],
  ['customer_check_status', 'sayad'], ['guarantor_credit_rank', 'B1'],
  ['guarantor_check_type', 'none'], ['guarantor_check_type', 'sayad'],
].map(([fieldKey, value], id) => ({ id, fieldKey, value, labelFa: value, sortOrder: id }));
const base = { creditRank: 'A1', jobType: 'employee', customerCheckStatus: 'none',
  hasCustomerSalaryDeduct: 'no', hasGuarantor: 'no' };
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async (url, init) => {
  assert.equal(url, '/api/customer-portal/plan-finder');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  const body = JSON.parse(init.body);
  assert.ok(Object.keys(body).every(key => allowed.has(key)), 'Server-owned fields must not be submitted');
  const parsed = CreateConsultationBody.safeParse({ ...body, customerId: 41 });
  assert.ok(parsed.success);
  assert.equal(questionnaireError(parsed.data, options), null);
  requests++;
  return Response.json({ consultationId: requests, matches: [] }, { status: 201 });
};
try {
  const variants = [
    base,
    { ...base, customerCheckStatus: 'sayad', hasCustomerSalaryDeduct: 'yes' },
    { ...base, hasGuarantor: 'yes', guarantorCreditRank: 'B1', guarantorCheckType: 'sayad', hasGuarantorSalaryDeduct: 'yes' },
    { ...base, hasGuarantor: 'true', guarantorCreditRank: 'B1', guarantorCheckType: 'none', hasGuarantorSalaryDeduct: '0' },
    { ...base, guarantorCreditRank: 'B1', guarantorCheckType: 'sayad', hasGuarantorSalaryDeduct: 'yes' },
  ];
  for (const answers of variants) {
    const body = buildPlanFinderRequest(answers);
    if (!body.hasGuarantor) assert.equal(body.guarantorCreditRank, undefined);
    const result = await portalApi.planFinder(body);
    assert.ok(Number.isSafeInteger(result.consultationId));
    assert.deepEqual(result.matches, []);
  }
  assert.equal(requests, variants.length);
  assert.equal(buildPlanFinderRequest(variants[3]).hasGuarantorSalaryDeduct, false);
  console.log('PASS: actual portal transport, server schema, both guarantor branches and stale hidden answers.');
} finally {
  globalThis.fetch = originalFetch;
}

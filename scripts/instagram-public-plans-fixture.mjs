import assert from "node:assert/strict";
import { projectInstagramPublicPlans } from "../src/lib/instagram-public-plans.ts";

const labels = new Map([
  ["employment_proof", "مدرک شغلی"],
  ["national_card", "کارت ملی"],
]);
const plan = {
  name: "طرح عمومی آزمایشی",
  principalAmount: "۱۲۰٬۰۰۰٬۰۰۰",
  installmentTerms: '[{"installments":"۱۲","depositPercent":"75"}]',
  depositPercents: '{"6":"50"}',
  requiredDocuments: '["employment_proof"]',
  bankName: "PRIVATE_BANK_MARKER",
  annualInterest: "PRIVATE_INTEREST_MARKER",
  customerJobs: "PRIVATE_JOB_MARKER",
  notes: "PRIVATE_NOTE_MARKER",
  customerRanks: "PRIVATE_RANK_MARKER",
  guarantorJobs: "PRIVATE_GUARANTOR_MARKER",
  id: 123456,
  templateId: "PRIVATE_TEMPLATE_MARKER",
  internalDocumentId: "fixture_internal_document_id",
};

const [projected] = projectInstagramPublicPlans([plan], labels);
assert.deepEqual(Object.keys(projected).sort(), [
  "customerCollateral", "customerDocuments", "guarantorCollateral", "guarantorDocuments",
  "guarantorRequired", "name", "options",
].sort(), "Only the allowed public plan fields are emitted");
assert.deepEqual(Object.keys(projected.options[0]).sort(), [
  "customerPayout", "installmentAmount", "installmentCount",
].sort(), "Only allowed installment option fields are emitted");
assert.deepEqual(projected.options, [{
  installmentCount: 12,
  customerPayout: 90_000_000,
  installmentAmount: null,
}], "Configured Persian-digit duration and valid payout percentage are projected accurately");
assert.deepEqual(projected.customerDocuments, ["مدرک شغلی"],
  "Only safe public dictionary labels are exposed; guarantor keys and internal IDs are not");
assert.equal(projected.guarantorDocuments, null,
  "Guarantor documents stay explicitly unknown when no plan-level source exists");
assert.equal(projected.guarantorRequired, null,
  "An absent guarantor flag stays unknown instead of claiming no guarantor");
assert.equal(projected.customerCollateral, null,
  "Absent collateral facts stay unknown");

const serialized = JSON.stringify(projected);
for (const forbidden of [
  "PRIVATE_BANK_MARKER", "PRIVATE_INTEREST_MARKER", "PRIVATE_JOB_MARKER",
  "PRIVATE_NOTE_MARKER", "PRIVATE_RANK_MARKER", "PRIVATE_GUARANTOR_MARKER",
  "PRIVATE_TEMPLATE_MARKER", "fixture_internal_document_id", "شناسه داخلی محرمانه",
  "bankName", "annualInterest", "customerJobs",
]) {
  assert(!serialized.includes(forbidden), `Private field or internal document data leaked: ${forbidden}`);
}
const [unknownDocument] = projectInstagramPublicPlans([{
  ...plan,
  requiredDocuments: '["employment_proof","fixture_internal_document_id"]',
}], labels);
assert.equal(unknownDocument.customerDocuments, null,
  "An unrecognized required-document identifier makes the public list explicitly unknown");
assert(!JSON.stringify(unknownDocument).includes("fixture_internal_document_id"),
  "Internal document identifiers are never copied into public context");
const [unclassifiedGuarantee] = projectInstagramPublicPlans([{
  ...plan,
  requiredDocuments: '["employment_proof","guarantee_check"]',
}], labels);
assert.equal(unclassifiedGuarantee.customerDocuments, null,
  "Plan-level guarantee documents are not guessed to belong to either party");

const [legacy] = projectInstagramPublicPlans([{
  name: "طرح قدیمی",
  principalAmount: "120,000,000",
  installmentTerms: null,
  depositPercents: '{"۶":"50","bad-duration":"25","12":null}',
  requiredDocuments: "[]",
}], labels);
assert.deepEqual(legacy.options, [
  { installmentCount: 12, customerPayout: null, installmentAmount: null },
  { installmentCount: 6, customerPayout: 60_000_000, installmentAmount: null },
  { installmentCount: null, customerPayout: 30_000_000, installmentAmount: null },
], "Legacy duration maps retain only valid numeric values and represent invalid values as null, never zero");
assert.deepEqual(legacy.customerDocuments, [], "An explicitly empty document list remains empty");

const [missingPercent] = projectInstagramPublicPlans([{
  name: "طرح ناقص",
  principalAmount: "120000000",
  installmentTerms: '[{"installments":"12"}]',
  depositPercents: null,
  requiredDocuments: null,
}], labels);
assert.deepEqual(missingPercent.options, [
  { installmentCount: 12, customerPayout: null, installmentAmount: null },
], "A missing payout percentage is unknown, not an assumed 100 percent");
assert.equal(missingPercent.customerDocuments, null);
assert.equal(missingPercent.guarantorDocuments, null);

const [invalidMoney] = projectInstagramPublicPlans([{
  name: "طرح با مبلغ نامعتبر",
  principalAmount: "120,00,000",
  installmentTerms: '[{"installments":"۱۲","depositPercent":"75"}]',
  depositPercents: null,
  requiredDocuments: "not-json",
}], labels);
assert.deepEqual(invalidMoney.options, [
  { installmentCount: 12, customerPayout: null, installmentAmount: null },
], "Invalid principal amounts are represented as unknown rather than zero");
assert.equal(invalidMoney.customerDocuments, null, "Invalid document configuration remains unknown");

const [invalidTerms] = projectInstagramPublicPlans([{
  name: "طرح با اقساط نامعتبر",
  principalAmount: "120000000",
  installmentTerms: "{invalid-json",
  depositPercents: '{"12":"75"}',
  requiredDocuments: "[]",
}], labels);
assert.deepEqual(invalidTerms.options, [
  { installmentCount: null, customerPayout: null, installmentAmount: null },
], "Invalid configured installment terms do not become a zero-valued or fabricated option");

const [scalarDuration] = projectInstagramPublicPlans([{
  name: "طرح با مدت scalar",
  principalAmount: "200000000",
  installments: "۱۲",
  installmentTerms: null,
  depositPercents: "75",
  requiredDocuments: "[]",
  needsGuarantor: 0,
  needsCustomerPromissory: 1,
  needsCustomerCheck: 0,
  needsCustomerSalaryDeduct: 0,
}], labels);
assert.deepEqual(scalarDuration.options, [
  { installmentCount: 12, customerPayout: 150_000_000, installmentAmount: null },
], "A scalar duration and scalar payout percentage project one valid cash-payout configuration");
assert.equal(scalarDuration.guarantorRequired, false);
assert.deepEqual(scalarDuration.customerCollateral, ["سفته"],
  "Authoritative customer promissory flags derive only a safe collateral label");

const [durationMap] = projectInstagramPublicPlans([{
  name: "طرح با نگاشت مدت",
  principalAmount: "100000000",
  installmentTerms: '{"۱۲":"75","24":{"depositPercent":"50"}}',
  depositPercents: null,
  requiredDocuments: "[]",
}], labels);
assert.deepEqual(durationMap.options.map(({ installmentCount, customerPayout }) => ({
  installmentCount,
  customerPayout,
})).sort((a, b) => a.installmentCount - b.installmentCount), [
  { installmentCount: 12, customerPayout: 75_000_000 },
  { installmentCount: 24, customerPayout: 50_000_000 },
], "Duration-keyed object configurations are supported without leaking their raw map");

const inactive = projectInstagramPublicPlans([{
  name: "طرح غیرفعال",
  principalAmount: "100000000",
  installmentTerms: '[{"installments":"12","depositPercent":"75"}]',
  depositPercents: null,
  requiredDocuments: "[]",
  active: 0,
}], labels);
assert.deepEqual(inactive, [], "Explicitly inactive plans are excluded from public selection");

const [conditionalPlan] = projectInstagramPublicPlans([{
  name: "طرح دارای شروط امن",
  principalAmount: "100000000",
  installmentTerms: '[{"installments":"12","depositPercent":"75"},{"installments":"24","depositPercent":"50"}]',
  depositPercents: null,
  requiredDocuments: "[]",
  needsGuarantor: 0,
  collateralType: "physical_check",
  customerJobs: "PRIVATE_CONDITION_JOB",
  conditions: [
    {
      maxPrincipal: "50000000",
      installmentOptions: "[12]",
      needsGuarantor: 1,
      needsCustomerPromissory: 0,
      needsCustomerCheck: 1,
      needsCustomerSalaryDeduct: 0,
      collateralType: "physical_check",
      customerRanks: "PRIVATE_CONDITION_RANK",
      customerJobs: "PRIVATE_CONDITION_JOB",
    },
    {
      maxPrincipal: "100000000",
      installmentOptions: "[24]",
      needsGuarantor: 0,
      needsCustomerPromissory: 1,
      needsCustomerCheck: 0,
      needsCustomerSalaryDeduct: 0,
      customerRanks: "PRIVATE_CONDITION_RANK",
      customerJobs: "PRIVATE_CONDITION_JOB",
    },
  ],
}], labels);
assert.deepEqual(conditionalPlan.options, [
  {
    installmentCount: 12,
    customerPayout: 37_500_000,
    installmentAmount: null,
    guarantorRequired: true,
    customerCollateral: ["چک فیزیکی"],
    guarantorCollateral: null,
  },
  {
    installmentCount: 24,
    customerPayout: 50_000_000,
    installmentAmount: null,
    guarantorRequired: false,
    customerCollateral: ["سفته"],
    guarantorCollateral: null,
  },
], "Condition max principal caps customer cash and condition security flags override plan-only flags");
assert.equal(conditionalPlan.guarantorRequired, null,
  "Conflicting condition requirements remain unknown at the unfiltered plan level");
const serializedConditional = JSON.stringify(conditionalPlan);
for (const forbidden of ["maxPrincipal", "PRIVATE_CONDITION_RANK", "PRIVATE_CONDITION_JOB"]) {
  assert(!serializedConditional.includes(forbidden),
    "Private condition filters and principal caps never reach the public DTO");
}

const [explicitNoCollateral] = projectInstagramPublicPlans([{
  name: "طرح بدون وثیقه شرطی",
  principalAmount: "100000000",
  installmentTerms: '[{"installments":"12","depositPercent":"75"}]',
  requiredDocuments: "[]",
  needsCustomerCheck: 1,
  customerCheck: "physical_check",
  conditions: [{
    maxPrincipal: "200000000",
    installmentOptions: "[12]",
    collateralType: "none",
    needsCustomerCheck: 0,
  }],
}], labels);
assert.deepEqual(explicitNoCollateral.options[0].customerCollateral, [],
  "An explicit condition-level none value clears legacy plan customer-check type");
assert.equal(explicitNoCollateral.options[0].customerPayout, 75_000_000,
  "A condition cap above plan principal never fabricates a higher cash payout");

const [contradictoryGuarantor] = projectInstagramPublicPlans([{
  name: "طرح با تعارض ضامن",
  principalAmount: "100000000",
  installmentTerms: '[{"installments":"12","depositPercent":"75"}]',
  requiredDocuments: "[]",
  needsGuarantor: 0,
  needsGuarantorCheck: 1,
  guarantorCheck: "physical_check",
  conditions: [{
    maxPrincipal: "100000000",
    installmentOptions: "[12]",
    needsGuarantor: 0,
  }],
}], labels);
assert.equal(contradictoryGuarantor.options[0].guarantorRequired, null,
  "A no-guarantor requirement conflicting with guarantor security becomes unknown/review");
assert.equal(contradictoryGuarantor.options[0].guarantorCollateral, null,
  "Conflicting guarantor security is not presented as a consistent obligation");

console.log("Instagram public plan projection fixture passed");
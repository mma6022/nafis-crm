import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
const require = createRequire(path.resolve("artifacts/api-server/package.json"));
const output = `/tmp/accepted-legacy-rial-${process.pid}.mjs`;
require("esbuild").buildSync({ entryPoints: ["artifacts/api-server/src/lib/accepted-legacy-rial-primary.ts"],
  outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
const { acceptedLegacyRialPrimary } = await import(output);
const application = { id: 30, customer_id: 128, plan_id: 8, stage: "expert_approval", status: "reviewing",
  initial_approval_at: "2026-09-30", current_primary_generation_id: 45,
  approved_amount: "100000000", requested_amount: "100000000", net_amount: "76000000",
  duration_months: 24, requested_duration_months: 24, plan_snapshot_json: '{"id":8}', condition_snapshot_json: "{}" };
const primary = { id: 45, customer_id: 128, loan_plan_id: 8, loan_application_id: 30,
  template_id: 4, generation_purpose: "primary", status: "signed", provider_status: "accept",
  provider_contract_id: "synthetic", link: "signed:synthetic", pdf_sha256: "a".repeat(64), docx_sha256: "b".repeat(64) };
const consent = { version: 1, explicitApproval: true, acceptedMoneyUnit: "toman", noCurrencyConversion: true,
  applicationId: 30, generationId: 45, customerId: 128, planId: 8, templateId: 4,
  providerContractId: "synthetic", pdfSha256: primary.pdf_sha256, docxSha256: primary.docx_sha256,
  amount: "100000000", netAmount: "76000000", durationMonths: 24,
  planSnapshotJson: application.plan_snapshot_json, conditionSnapshotJson: "{}",
  authorizedByUserId: 1, authorizedAt: "2026-10-21T08:30:00.000Z" };
const row = { reason: JSON.stringify(consent), actor_id: 1, actor_role: "admin", created_at: consent.authorizedAt };
let count = 0;
function test(a, p, r, proof, expected) {
  assert.equal(acceptedLegacyRialPrimary(a, p, String(a?.approved_amount), Number(a?.duration_months), () => r, proof), expected); count++;
}
test(application, primary, row, () => true, true);
test(application, primary, null, () => true, false);
test(application, primary, row, () => false, false);
test(application, primary, row, () => { throw Error("unreadable"); }, false);
for (const [key, value] of Object.entries({
  status: "rejected", initial_approval_at: null, current_primary_generation_id: 46, id: 31,
  customer_id: 129, plan_id: 9, approved_amount: "90000000", requested_amount: "90000000",
  duration_months: 18, requested_duration_months: 18, net_amount: "75000000",
  plan_snapshot_json: '{"id":9}', condition_snapshot_json: '{"changed":true}',
})) test({ ...application, [key]: value }, primary, row, () => true, false);
for (const [key, value] of Object.entries({
  status: "sent", provider_status: "readyForSign", link: "signed:other", provider_contract_id: "other",
  pdf_sha256: "c".repeat(64), docx_sha256: "d".repeat(64), deleted_at: "deleted",
  superseded_at: "superseded", id: 46, customer_id: 129, loan_plan_id: 9,
  loan_application_id: 31, template_id: 7, generation_purpose: "amendment",
})) test(application, { ...primary, [key]: value }, row, () => true, false);
for (const [key, value] of Object.entries({ explicitApproval: false, acceptedMoneyUnit: "rial",
  noCurrencyConversion: false, authorizedByUserId: 2, version: 2, authorizedAt: "invalid",
  amount: "1000000000", durationMonths: 18, templateId: 5 })) {
  test(application, primary, { ...row, reason: JSON.stringify({ ...consent, [key]: value }) }, () => true, false);
}
test(application, primary, { ...row, actor_role: "registrar" }, () => true, false);
test(application, primary, { ...row, reason: "invalid JSON" }, () => true, false);
test(application, primary, { ...row, created_at: "2026-10-22" }, () => true, false);
fs.unlinkSync(output);
console.log(JSON.stringify({ passed: count, acceptanceIsCaseAndDocumentBound: true,
  noTermChangesOrConversion: true, adminAuditRequired: true, renderedProofRequired: true }));

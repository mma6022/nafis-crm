// Static check: the loan flow gates never read the contract text/amount (no DB, no network).
// Mohammad, 25 Oct: «این که قرارداد ریاله یا تومنه رو کلا جدا کن از روند درخواست تسهیلات».
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const loans = read("../src/routes/loan-applications.ts");
const contracts = read("../src/routes/contracts.ts");
const lib = read("../src/lib/legacy-toman-replacement.ts");
const body = (src, head) => {
  const a = src.indexOf(head); assert.ok(a >= 0, `missing ${head}`);
  const b = src.indexOf("\nfunction ", a + head.length);
  return src.slice(a, b < 0 ? undefined : b);
};
// Rial/toman refusal message and plumbing are gone.
for (const s of ["primary_contract_legacy_rial_unit", "قرارداد قدیمی به ریال است", "legacyRialUnitReason", "withLegacyRialUnitReason",
  "legacyRialUnitRefused", "primaryPdfShowsPrincipal", "diagnoseRenderedPdfContainsPrincipal"])
  assert.ok(!loans.includes(s), `loan-applications still has ${s}`);
// No send-time / generation-time PDF principal or installment refusals.
for (const s of ["stage = \"validate_approved_terms\"", "rendered_amendment_principal_unverifiable",
  "rendered_primary_principal_unverifiable", "rendered_installment_count_unverifiable", "renderedPdfContainsInstallmentCount"])
  assert.ok(!contracts.includes(s), `contracts.ts still has ${s}`);
assert.ok(!loans.includes("rendered_primary_principal_unverifiable"));
// Gates are content-free.
const vpp = body(loans, "function verifiedPrimaryPrincipal(");
assert.ok(vpp.indexOf("if (!readContent) return true;") > 0 &&
  vpp.indexOf("if (!readContent) return true;") < vpp.indexOf("renderedPdfContainsPrincipal"), "verifiedPrimaryPrincipal gate is content-free");
assert.ok(/readContent = false\): boolean/.test(body(loans, "function signedPrimaryMatchesApprovedTerms(")));
assert.equal((loans.match(/signedPrimaryMatchesApprovedTerms\([^;]*?, true\)/g) ?? []).length, 1, "only the advisory eligibility reads content");
assert.ok(body(loans, "function tomanReplacementEligibility(").includes("signedPrimaryMatchesApprovedTerms(application, amount, duration, true)"));
const bound = body(loans, "function boundPrimaryMatchesApplication(");
assert.ok(!/manual_values_json|renderedPdf|mappings_snapshot_json/.test(bound), "boundPrimaryMatchesApplication is content-free");
const legacy = body(loans, "function legacySignedPrimaryTerms(");
assert.ok(!/manual_values_json|renderedPdf|mappings_json/.test(legacy), "legacy signed path does not read the contract");
assert.ok(legacy.includes("application.approved_amount ?? application.requested_amount"), "legacy amount comes from the CRM");
assert.ok(!/renderedPdf/.test(body(loans, "function tomanReplacementGenerationMatches(")));
const pre = body(contracts, "function preapprovedGenerationMatches(");
assert.ok(pre.indexOf("if (!readContent) return true;") > 0 && pre.indexOf("if (!readContent) return true;") < pre.indexOf("manual_values_json"));
assert.ok(!/renderedPdf/.test(body(contracts, "function tomanReplacementDocumentTermsMatch(")));
assert.ok(!/manual_values_json|normalizedContractInteger\(values/.test(body(lib, "export function tomanReplacementGenerationTermsMatch(")));
// Non-contract checks kept.
assert.ok(loans.includes("primary_contract_not_signed") || loans.includes("primary_contract_signature"), "signature checks kept");
assert.ok(vpp.includes("primary_contract_file_unverifiable"), "file integrity kept");
console.log("no-contract-content-check ok");

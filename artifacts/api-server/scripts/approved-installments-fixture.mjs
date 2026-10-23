import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.resolve("artifacts/api-server/package.json"));
const output = `/tmp/approved-installments-helper-${process.pid}.mjs`;
require("esbuild").buildSync({ entryPoints: ["artifacts/api-server/src/lib/approved-contract-installments.ts"],
  outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
const { appendApprovedInstallments, canRebuildUnsentInstallments, isApprovedInstallmentAppendix } = await import(output);
const app = { id: 1, stage: "approved_contract_pending_signature", status: "requested", initial_approval_at: "approved",
  duration_months: 12, requested_duration_months: 18, current_primary_generation_id: null };
const principal = { variable: "credit", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" };
const xml = '<w:document><w:body><w:p/><w:sectPr></w:sectPr></w:body></w:document>';
const mappings = [principal], values = { credit: "50,000,000", note: "1111111111111111" };
const rendered = appendApprovedInstallments(xml, app, mappings, values);
assert(rendered.indexOf("تعداد اقساط") < rendered.indexOf("<w:sectPr"));
assert(rendered.includes("اصل وام"));
assert.equal(values.crmApprovedInstallments, "12");
assert.equal(values.note, "1111111111111111");
assert.equal(mappings.length, 2);
assert(isApprovedInstallmentAppendix(mappings[1], rendered, "original template"));
assert(!isApprovedInstallmentAppendix({ ...mappings[1], systemGenerated: undefined }, rendered, ""));
assert(!isApprovedInstallmentAppendix(mappings[1], rendered + rendered, ""));
assert(!isApprovedInstallmentAppendix(mappings[1], rendered.replace("crmApprovedInstallmentsV1", "other"), ""));
assert.equal(appendApprovedInstallments(xml, { ...app, initial_approval_at: null }, [principal], {}), xml);
assert.equal(appendApprovedInstallments(xml, { ...app, duration_months: 18 }, [principal], {}), xml);
assert.equal(appendApprovedInstallments(xml, app, mappings, values), xml);
assert.throws(() => appendApprovedInstallments(xml, app, [principal, { variable: "crmApprovedInstallments" }], {}));
assert.throws(() => appendApprovedInstallments(xml, { ...app, duration_months: 601 }, [principal], {}));
const g = { id: 2, generation_purpose: "primary", status: "generated", pdf_path: "file", pdf_sha256: "hash", mappings_snapshot_json: "[]" };
assert(canRebuildUnsentInstallments(app, g, () => true));
assert(!canRebuildUnsentInstallments(app, g, () => false));
for (const [k, v] of Object.entries({ status: "signed", provider_contract_id: "contract", provider_file_id: "file",
  superseded_at: "old", deleted_at: "deleted", pdf_path: null, generation_purpose: "amendment",
  mappings_snapshot_json: "invalid" })) assert(!canRebuildUnsentInstallments(app, { ...g, [k]: v }, () => true));
for (const [k, v] of Object.entries({ status: "rejected", stage: "completed", duration_months: 18,
  initial_approval_at: null, current_primary_generation_id: 3 })) assert(!canRebuildUnsentInstallments({ ...app, [k]: v }, g, () => true));
// A note serial is not a generation identity and can recur across requests.
const otherValues = { credit: "80,000,000", note: values.note };
appendApprovedInstallments(xml, { ...app, id: 3 }, [principal], otherValues);
assert.equal(otherValues.note, values.note);
fs.unlinkSync(output);
console.log(JSON.stringify({ passed: true, sourceAndRenderedEvidenceBound: true, signedAndSentNeverRebuilt: true,
  repeatedNoteAllowed: true, declaredTermsOnly: true }));

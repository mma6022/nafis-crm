import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const temp = await mkdtemp(path.join(os.tmpdir(), "contract-preflight-"));
try {
  await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    export {isCertificatePreflightRetry} from "./src/lib/contract-preflight-retry";
    export {tomanReplacementGenerationTermsMatch,TOMAN_REPLACEMENT_PURPOSE} from "./src/lib/legacy-toman-replacement";
  ` }, outfile: path.join(temp, "test.mjs"), bundle: true, platform: "node", format: "esm" });
  const f = await import(pathToFileURL(path.join(temp, "test.mjs")));
  const application = { id: 1, customer_id: 2, plan_id: 3, approved_amount: "150000000",
    duration_months: 24, primary_manual_values_json: JSON.stringify({ note: "serial" }) };
  const consent = { sourceGenerationId: 10, tomanTemplateId: 7, approvedAmount: "150000000", durationMonths: 24 };
  const generation = { loan_application_id: 1, customer_id: 2, loan_plan_id: 3, template_id: 7,
    generation_purpose: f.TOMAN_REPLACEMENT_PURPOSE, status: "failed", error_message: "certificate_inactive",
    provider_file_id: null, provider_contract_id: null,
    mappings_snapshot_json: JSON.stringify([
      { variable: "principal", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
      { variable: "installments", sourceType: "loanPlan", loanPlanField: "loanPlan.installments" },
      { variable: "note", sourceType: "manual" },
    ]), manual_values_json: JSON.stringify({ principal: "150,000,000", installments: "24", note: "serial" }) };
  for (const error_message of ["certificate_inactive", "provider_certificate_check_failed"]) {
    const row = { ...generation, error_message };
    assert.equal(f.isCertificatePreflightRetry(row), true);
    assert.equal(f.tomanReplacementGenerationTermsMatch(row, application, consent), false,
      "failed certificate never qualifies as normal/signature/financial evidence");
    assert.equal(f.tomanReplacementGenerationTermsMatch(row, application, consent, true), true,
      "explicit send/reuse retry can revalidate replacement terms");
  }
  for (const patch of [
    { error_message: "provider_contract_send_failed" }, { provider_file_id: "uploaded" },
    { provider_contract_id: "accepted" }, { status: "sending" }, { status: "signed" },
  ]) assert.equal(f.isCertificatePreflightRetry({ ...generation, ...patch }), false);
  for (const patch of [{ customer_id: 999 }, { template_id: 999 }, { superseded_at: "now" },
    { manual_values_json: JSON.stringify({ principal: "149000000", installments: "24", note: "serial" }) },
    { manual_values_json: JSON.stringify({ principal: "150000000", installments: "23", note: "serial" }) },
    { manual_values_json: JSON.stringify({ principal: "150000000", installments: "24", note: "changed" }) },
  ]) assert.equal(f.tomanReplacementGenerationTermsMatch({ ...generation, ...patch }, application, consent, true), false);
  console.log("Certificate retries passed: narrow pre-upload classification, explicit replacement send opt-in, strict financial/signature defaults, recipient/template/amount/duration/manual-value guards.");
} finally { await rm(temp, { recursive: true, force: true }); }

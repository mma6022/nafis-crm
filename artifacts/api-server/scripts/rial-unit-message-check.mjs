// Message-only check for the template 4/5 rial-unit refusal (no DB, no network).
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/routes/loan-applications.ts", import.meta.url), "utf8");
const EXACT = "قرارداد قدیمی به ریال است؛ قرارداد تومانی جایگزین لازم است.";
assert.ok(src.includes(`primary_contract_legacy_rial_unit: "${EXACT}",`), "exact Persian message mapped");
assert.ok(/const LEGACY_RIAL_UNIT_REASON = "primary_contract_legacy_rial_unit";/.test(src));
assert.ok(/=== "template_unit_policy_unapproved"/.test(src), "keyed on the existing policy reason");
// The evidence check itself is unchanged: templates 4/5 still hard-reject.
const ev = fs.readFileSync(new URL("../src/lib/contract-evidence.ts", import.meta.url), "utf8");
assert.ok(ev.includes('if (templateEvidence && [4, 5].includes(Number(templateEvidence.templateId)))\n    return { matched: false, reason: "template_unit_policy_unapproved" };'));
console.log("rial-unit-message-check ok");

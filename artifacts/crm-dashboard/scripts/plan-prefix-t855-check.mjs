// t855: a plan name that already starts with «طرح» must not get a second «طرح » prefix. Display only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withPlanPrefix, multiCasePlanLabel } from "../src/lib/multi-case-plan-label.ts";

assert.equal(withPlanPrefix("طرح آسا 1"), "طرح آسا 1");
assert.equal(withPlanPrefix("طرح بازنشسته های تامین اجتماعی"), "طرح بازنشسته های تامین اجتماعی");
assert.equal(withPlanPrefix("  طرح ونوس "), "طرح ونوس");
assert.equal(withPlanPrefix("طرح\u200cمروارید"), "طرح\u200cمروارید");
assert.equal(withPlanPrefix("آسا 2"), "طرح آسا 2");
assert.equal(withPlanPrefix("ترنم ( بازنشسته ها )"), "طرح ترنم ( بازنشسته ها )");
assert.equal(withPlanPrefix("طرحواره"), "طرح طرحواره");
assert.equal(withPlanPrefix("لندتک / ملی"), "طرح لندتک / ملی");
assert.equal(withPlanPrefix("لندتک"), "طرح لندتک");
assert.equal(withPlanPrefix(""), "طرح");
assert.equal(withPlanPrefix(null), "طرح");
assert.equal(withPlanPrefix(multiCasePlanLabel({ planId: 20, planName: "طرح آسا 1", bankName: "ملی" })), "طرح آسا 1");
assert.equal(withPlanPrefix(multiCasePlanLabel({ planId: 26, planName: "آسا 2" })), "طرح آسا 2");

// The 7 masked-copy plans that start with «طرح» render once; the other 19 keep one prefix.
const names = ["مریخ","ترنم (100)","ستاره آبی","ستاره آبی","ستاره آبی","ستاره آبی (100) - ملت","ترنم","ترنم","طرح مروارید","طرح خورشید","طرح هرمز","طرح فیروزه","ونوس (200)","طرح ونوس","نیلوفر","سهیل (100)","سامان","سهیل","چابک","طرح آسا 1","ترنم ( بازنشسته ها )","فراسا","زحل","طرح بازنشسته های تامین اجتماعی","سپهر","آسا 2"];
assert.equal(names.length, 26);
for (const n of names) {
  const out = withPlanPrefix(n);
  assert.ok(!/^طرح\s+طرح(\s|$)/.test(out), `doubled: ${out}`);
  assert.ok(out.startsWith("طرح"), `no prefix: ${out}`);
}
assert.equal(names.filter((n) => withPlanPrefix(n) === n).length, 7);

// Wiring: the five surfaces use withPlanPrefix and no longer hard-code «طرح {».
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
for (const [file, re] of [
  ["features/daily-customer-inline/DailyCustomerInline.tsx", /withPlanPrefix\(f\.plan\)/],
  ["components/multi-case/McCustomerCases.tsx", /withPlanPrefix\(label\)/],
  ["pages/LoanApplicationDetail.tsx", /withPlanPrefix\(planHeading\)/],
  ["components/multi-case/CaseContextPicker.tsx", /withPlanPrefix\(multiCasePlanLabel\(row\)\)/],
  ["components/loan-applications/CreateWizard.tsx", /withPlanPrefix\(multiCasePlanLabel\(\{ planId: openCase\.planId/],
]) {
  const s = src(file);
  assert.match(s, re, file);
  assert.ok(!/[>،·]\s*طرح \{(f\.plan|label|planHeading|multiCasePlanLabel)/.test(s), `raw «طرح {» left in ${file}`);
}
console.log("PASS plan prefix t855");

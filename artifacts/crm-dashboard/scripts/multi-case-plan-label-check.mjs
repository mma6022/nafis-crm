import assert from "node:assert/strict";
import { multiCasePlanLabel, MULTI_CASE_PLAN_UNKNOWN } from "../src/lib/multi-case-plan-label.ts";

assert.equal(multiCasePlanLabel({ planId: 7, bankName: "بانک ملت - بانک صادرات" }), "لندتک / بانک ملت، بانک صادرات");
assert.equal(multiCasePlanLabel({ bank_name: "  بانک شهر  " }), "لندتک / بانک شهر");
assert.equal(multiCasePlanLabel({ bankName: "" }), MULTI_CASE_PLAN_UNKNOWN);
assert.equal(multiCasePlanLabel({ bankName: null }), MULTI_CASE_PLAN_UNKNOWN);
assert.equal(multiCasePlanLabel({ planId: 1, name: "ترنم" }), MULTI_CASE_PLAN_UNKNOWN);
console.log("PASS multi-case plan label");

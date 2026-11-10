import assert from "node:assert/strict";
import { multiCasePlanLabel, multiCaseUnreadyReason, MULTI_CASE_PLAN_UNKNOWN, MULTI_CASE_UNREADY_REASON } from "../src/lib/multi-case-plan-label.ts";

assert.equal(multiCasePlanLabel({ planId: 7, bankName: "بانک ملت - بانک صادرات" }), "لندتک / بانک ملت، بانک صادرات");
assert.equal(multiCasePlanLabel({ bank_name: "  بانک شهر  " }), "لندتک / بانک شهر");
assert.equal(multiCasePlanLabel({ bankName: "" }), MULTI_CASE_PLAN_UNKNOWN);
assert.equal(multiCasePlanLabel({ bankName: null }), MULTI_CASE_PLAN_UNKNOWN);
assert.equal(multiCasePlanLabel({ planId: 1, name: "ترنم" }), MULTI_CASE_PLAN_UNKNOWN);
assert.equal(multiCasePlanLabel({ planId: 17, bankName: "مسکن" }), "لندتک / مسکن");
assert.equal(multiCasePlanLabel({ planId: 1, bankName: "ملی" }), "لندتک / ملی");
assert.equal(multiCaseUnreadyReason(1), "فعلاً قابل انتخاب نیست؛ قالب قرارداد این طرح هنوز آماده نشده است.");
assert.equal(multiCaseUnreadyReason(17), "فعلاً قابل انتخاب نیست؛ مبلغ وام در قرارداد این طرح مشخص نشده است.");
assert.equal(multiCaseUnreadyReason(17), MULTI_CASE_UNREADY_REASON);
assert.equal(multiCaseUnreadyReason(99), MULTI_CASE_UNREADY_REASON);
assert.equal(multiCaseUnreadyReason(null), MULTI_CASE_UNREADY_REASON);
console.log("PASS multi-case plan label");

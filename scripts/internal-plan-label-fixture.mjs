import assert from "node:assert/strict";
import { internalPlanLabel, planLabelForCustomer } from "../src/lib/plan-label.ts";

assert.equal(internalPlanLabel("طرح لنتک اسکی‌وام", "بانک ملی"), "طرح لنتک اسکی‌وام");
assert.equal(internalPlanLabel("  طرح لنتک اسکی‌وام  ", "ملت"), "طرح لنتک اسکی‌وام");
assert.equal(internalPlanLabel("", "بانک ملی"), planLabelForCustomer("بانک ملی"));
assert.equal(internalPlanLabel(null, "بانک ملت"), planLabelForCustomer("بانک ملت"));
assert.equal(internalPlanLabel("   ", ""), "لندتک");
assert.equal(planLabelForCustomer("بانک ملی"), "لندتک / بانک ملی"); // customer-facing unchanged
console.log("PASS internal plan label");

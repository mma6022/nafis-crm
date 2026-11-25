import assert from "node:assert/strict";
import { internalPlanLabel, planChoiceLabel, planLabelForCustomer, withPlanPrefix } from "../src/lib/plan-label.ts";
import { readFileSync } from "node:fs";

assert.equal(internalPlanLabel("طرح لنتک اسکی‌وام", "بانک ملی"), "طرح لنتک اسکی‌وام");
assert.equal(internalPlanLabel("  طرح لنتک اسکی‌وام  ", "ملت"), "طرح لنتک اسکی‌وام");
assert.equal(internalPlanLabel("", "بانک ملی"), planLabelForCustomer("بانک ملی"));
assert.equal(internalPlanLabel(null, "بانک ملت"), planLabelForCustomer("بانک ملت"));
assert.equal(internalPlanLabel("   ", ""), "لندتک");
assert.equal(planLabelForCustomer("بانک ملی"), "لندتک / بانک ملی"); // customer-facing unchanged

assert.equal(planChoiceLabel("فراسا", "صادرات/ملت"), "فراسا / صادرات/ملت");
assert.equal(planChoiceLabel("ترنم", "اقتصاد نوین / ملت"), "ترنم / اقتصاد نوین / ملت");
assert.equal(planChoiceLabel("سپهر", "ملی(سامان)"), "سپهر / ملی(سامان)");
assert.equal(planChoiceLabel("ستاره آبی (100) - ملت", "ملت"), "ستاره آبی (100) - ملت"); // bank already in the name
assert.equal(planChoiceLabel("طرح آسا 1", "رفاه"), "طرح آسا 1 / رفاه");
assert.equal(planChoiceLabel("ترنم ( بازنشسته ها )", "بلوبانک"), "ترنم ( بازنشسته ها ) / بلوبانک");
assert.equal(planChoiceLabel("گردشگری - اقتصاد نوین  - دی", "گردشگری - اقتصاد نوین  - دی"), "گردشگری - اقتصاد نوین  - دی");
assert.equal(planChoiceLabel("لندتک", "ملت"), "ملت"); // do not invent a name or keep the provider prefix
assert.equal(planChoiceLabel("", "بانک ملی"), "بانک ملی");
assert.equal(planChoiceLabel(null, "گردشگری - اقتصاد نوین  - دی"), "گردشگری، اقتصاد نوین، دی");
assert.equal(planChoiceLabel("   ", ""), "");
assert.equal(planLabelForCustomer("صادرات/ملت"), "لندتک / صادرات/ملت"); // tracking/contract label unchanged
// t856: API-side «طرح» prefix never doubles (sales-manager console history, smart-filing manager bell).
assert.equal(withPlanPrefix("طرح آسا 1"), "طرح آسا 1");
assert.equal(withPlanPrefix("  طرح ونوس "), "طرح ونوس");
assert.equal(withPlanPrefix("طرح\u200cمروارید"), "طرح\u200cمروارید");
assert.equal(withPlanPrefix("آسا 2"), "طرح آسا 2");
assert.equal(withPlanPrefix("طرحواره"), "طرح طرحواره");
assert.equal(withPlanPrefix(""), "طرح");
const src = (p) => readFileSync(new URL(`../src/lib/${p}`, import.meta.url), "utf8");
assert.match(src("sales-manager-console.ts"), /withPlanPrefix\(planName\(Number\(k\.slice\(1\)\)\)\)/);
assert.ok(!/`طرح \$\{planName\(/.test(src("sales-manager-console.ts")));
assert.match(src("smart-filing.ts"), /v\.planName \? withPlanPrefix\(v\.planName\)/);
assert.ok(!/`طرح \$\{v\.planName\}`/.test(src("smart-filing.ts")));
console.log("PASS internal plan label");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/loan-applications/CreateWizard.tsx", import.meta.url), "utf8");
const stepTitles = [...source.matchAll(/\{ id: \d, title: "([^"]+)" \}/g)].map((match) => match[1]);
assert.deepEqual(stepTitles, [
  "انتخاب مشتری",
  "پروفایل و اعتبار",
  "طرح و شرایط",
  "هزینه تشکیل پرونده",
  "مدارک هویتی",
  "تایید نهایی",
]);

const renderedSteps = [
  source.indexOf("step === 1"),
  source.indexOf("step === 2"),
  source.indexOf("step === 3"),
  source.indexOf("step === 4"),
  source.indexOf("step === 5"),
  source.indexOf("step === 6"),
];
assert.ok(renderedSteps.every((position) => position >= 0));
assert.deepEqual(renderedSteps, [...renderedSteps].sort((a, b) => a - b), "wizard renders steps in numeric order");

const planStart = source.indexOf("function Step3PlanAndTerms");
const feeStart = source.indexOf("function StepFilingFee");
const customerStart = source.indexOf("function Step1Customer");
assert.ok(planStart > customerStart, "plan-and-terms step exists");
const feeBody = source.slice(feeStart, customerStart);
const planBody = source.slice(planStart);
assert.ok(feeBody.includes("selectedPlan: CustomerEligiblePlan"), "fee step requires an already selected plan");
assert.ok(!feeBody.includes("<select"), "fee step is a summary, not another plan selector");
assert.ok(feeBody.includes("chargeFilingFee({ customerId: customer.id, planId: plan.planId }"));
assert.ok(!planBody.includes("chargeFilingFee("), "plan and terms selection never initiates payment");
assert.ok(source.includes("{step === 4 && selectedCustomer && selectedPlan && ("), "fee screen cannot render before plan selection");
assert.ok(source.includes("disabled={!selectedPlan || !amount || !duration || Number(amount) <= 0}"), "plan, amount, and duration are required before fee");
assert.ok(source.includes("if (feeChargeId || hasPendingFeeAttempt"), "a paid or unresolved plan is locked against replacement");
assert.ok(source.includes("loan-fee:${selectedCustomer.id}:${selectedPlan.planId}"), "pending payment recovery stays tied to the same customer and plan");

console.log("Create-wizard flow fixture passed: customer, profile/credit, plan terms, fee summary, documents, review; no pre-terms payment.");
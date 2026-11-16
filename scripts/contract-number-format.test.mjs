import assert from "node:assert/strict";
import { groupContractNumber, isContractMoneyMapping, ungroupContractNumber } from "../src/lib/contract-number-format.ts";

const field = field => ({ type: "field", field });
const op = value => ({ type: "operator", value });
const literal = value => ({ type: "literal", value });
const formula = tokens => ({ variable: "result", sourceType: "formula", formula: { tokens } });
for (const mapping of [
  { variable: "credit", sourceType: "loanPlan", loanPlanField: "loanPlan.principalAmount" },
  { variable: "damage", sourceType: "loanPlan", loanPlanField: "loanPlan.penaltyValue" },
  { variable: "promissoryamount", sourceType: "manual", label: "مبلغ سفته" },
  { variable: "x", sourceType: "manual", label: "مبلغ چک" },
  formula([field("loanPlan.principalAmount"), op("*"), field("loanPlan.depositPercents"), op("/"), literal(100)]),
]) assert.equal(isContractMoneyMapping(mapping, { penalty_mode: "amount" }), true);
for (const mapping of [
  { variable: "promissorynoteno", sourceType: "manual", label: "شماره سفته" },
  { variable: "x", sourceType: "manual", label: "تعداد چک" },
  { variable: "nationalcode", sourceType: "customer", customerField: "customer.nationalCode" },
  { variable: "credit", sourceType: "customer", customerField: "customer.phone" },
  { variable: "contractnumber", sourceType: "contractNumber" },
  { variable: "date", sourceType: "date" },
  { variable: "duration", sourceType: "loanPlan", loanPlanField: "loanPlan.contractDurationDays" },
  { variable: "percent", sourceType: "loanPlan", loanPlanField: "loanPlan.annualInterest" },
  formula([field("loanPlan.installments"), op("*"), literal(12)]),
  formula([field("loanPlan.principalAmount"), op("/"), field("loanPlan.principalAmount"), op("*"), literal(100)]),
]) assert.equal(isContractMoneyMapping(mapping), false);
assert.equal(isContractMoneyMapping({ variable: "damage", sourceType: "loanPlan", loanPlanField: "loanPlan.penaltyValue" }, { penalty_mode: "percent" }), false);
assert.equal(groupContractNumber("123456789.25"), "123,456,789.25");
assert.equal(ungroupContractNumber("001,234,567"), "001234567");
assert.equal(ungroupContractNumber("۴۹۷٬۱۸۴"), "۴۹۷۱۸۴");
assert.equal(ungroupContractNumber("09123456789"), "09123456789");
assert.equal(ungroupContractNumber("1405/07/14"), "1405/07/14");
assert.equal(ungroupContractNumber("نشانی، پلاک ۱۲"), "نشانی، پلاک ۱۲");
assert.equal(ungroupContractNumber("1,2"), "1,2");
console.log("PASS: only monetary values grouped; identifiers, counts, dates and percentages ungrouped; monetary formula dimensions and leading zeros preserved.");

/**
 * Guarantee (collateral) options for the public plan export.
 *
 * A plan's eligibility conditions are alternative ways to qualify. Each one
 * becomes one option listing what the applicant must provide. `guaranteeTypes`
 * is the union, so the website can answer "does this plan accept a
 * promissory note?" while `guaranteeOptions` keeps combinations intact for
 * questions such as "can I get it without a guarantor?".
 */
export type GuaranteeType = "cheque" | "promissory" | "guarantor" | "none";

export type GuaranteeCondition = {
  collateralType?: string | null;
  needsGuarantor?: boolean;
  guarantorCollateralType?: string | null;
  needsCustomerPromissory?: boolean;
  needsGuarantorPromissory?: boolean;
  needsCustomerCheck?: boolean;
  needsGuarantorCheck?: boolean;
};

export type GuaranteePlan = {
  customerCheck?: string | null;
  needsCustomerPromissory?: boolean;
  needsGuarantor?: boolean;
  guarantorCheck?: string | null;
  needsGuarantorPromissory?: boolean;
  conditions?: GuaranteeCondition[];
};

const ORDER: GuaranteeType[] = ["cheque", "promissory", "guarantor", "none"];
const CHECKS = new Set(["digital_check", "physical_check", "digital", "physical", "check", "cheque"]);

const isCheck = (value: string | null | undefined): boolean => CHECKS.has(String(value ?? "").trim());
const isPromissory = (value: string | null | undefined): boolean => String(value ?? "").trim() === "promissory";

function option(types: Set<GuaranteeType>): GuaranteeType[] {
  if (!types.size) return ["none"];
  return ORDER.filter((type) => types.has(type));
}

export function conditionGuaranteeTypes(condition: GuaranteeCondition): GuaranteeType[] {
  const types = new Set<GuaranteeType>();
  if (isCheck(condition.collateralType) || condition.needsCustomerCheck) types.add("cheque");
  if (isPromissory(condition.collateralType) || condition.needsCustomerPromissory) types.add("promissory");
  if (condition.needsGuarantor) {
    types.add("guarantor");
    if (isCheck(condition.guarantorCollateralType) || condition.needsGuarantorCheck) types.add("cheque");
    if (isPromissory(condition.guarantorCollateralType) || condition.needsGuarantorPromissory) types.add("promissory");
  }
  return option(types);
}

/** Plan-level flags are only a fallback for plans without explicit conditions. */
export function planLevelGuaranteeTypes(plan: GuaranteePlan): GuaranteeType[] {
  const types = new Set<GuaranteeType>();
  if (isCheck(plan.customerCheck)) types.add("cheque");
  if (plan.needsCustomerPromissory) types.add("promissory");
  if (plan.needsGuarantor) {
    types.add("guarantor");
    if (isCheck(plan.guarantorCheck)) types.add("cheque");
    if (plan.needsGuarantorPromissory) types.add("promissory");
  }
  return option(types);
}

export function publicPlanGuarantees(plan: GuaranteePlan): {
  guaranteeTypes: GuaranteeType[];
  guaranteeOptions: GuaranteeType[][];
} {
  const raw = plan.conditions?.length
    ? plan.conditions.map(conditionGuaranteeTypes)
    : [planLevelGuaranteeTypes(plan)];
  const seen = new Set<string>();
  const guaranteeOptions = raw.filter((types) => {
    const key = types.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const union = new Set(guaranteeOptions.flat());
  // "none" in the union means at least one option needs no collateral at all.
  return { guaranteeTypes: ORDER.filter((type) => union.has(type)), guaranteeOptions };
}

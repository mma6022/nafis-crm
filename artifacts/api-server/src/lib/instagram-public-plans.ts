export type InstagramPublicPlanOption = {
  installmentCount: number | null;
  customerPayout: number | null;
  installmentAmount: null;
  guarantorRequired?: boolean | null;
  customerCollateral?: string[] | null;
  guarantorCollateral?: string[] | null;
};

export type InstagramPublicPlan = {
  name: string;
  options: InstagramPublicPlanOption[];
  customerDocuments: string[] | null;
  guarantorDocuments: null;
  guarantorRequired: boolean | null;
  customerCollateral: string[] | null;
  guarantorCollateral: string[] | null;
};

export type InstagramPublicPlanSource = {
  name: unknown;
  principalAmount: unknown;
  installmentTerms: unknown;
  depositPercents: unknown;
  requiredDocuments: unknown;
  installments?: unknown;
  active?: unknown;
  needsGuarantor?: unknown;
  needsCustomerPromissory?: unknown;
  needsGuarantorPromissory?: unknown;
  needsCustomerCheck?: unknown;
  needsGuarantorCheck?: unknown;
  needsCustomerSalaryDeduct?: unknown;
  needsGuarantorSalaryDeduct?: unknown;
  customerCheck?: unknown;
  guarantorCheck?: unknown;
  collateralType?: unknown;
  guarantorCollateralType?: unknown;
  conditions?: readonly InstagramPublicPlanConditionSource[];
};

export type InstagramPublicPlanConditionSource = {
  maxPrincipal?: unknown;
  installmentOptions?: unknown;
  needsGuarantor?: unknown;
  needsCustomerPromissory?: unknown;
  needsGuarantorPromissory?: unknown;
  needsCustomerCheck?: unknown;
  needsGuarantorCheck?: unknown;
  needsCustomerSalaryDeduct?: unknown;
  needsGuarantorSalaryDeduct?: unknown;
  collateralType?: unknown;
  guarantorCollateralType?: unknown;
};

const MAX_OPTIONS = 20;
const MAX_CUSTOMER_DOCUMENTS = 12;
const MAX_DOCUMENT_LABEL_LENGTH = 120;
const GUARANTOR_DOCUMENT_KEYS = new Set(["guarantee_check", "guarantee_promissory"]);
const COLLATERAL_LABELS = new Map([
  ["none", "بدون وثیقه"],
  ["physical_check", "چک فیزیکی"],
  ["digital_check", "چک دیجیتال"],
  ["promissory", "سفته"],
  ["salary_deduction", "گواهی کسر از حقوق"],
  ["property", "سند ملکی"],
  ["vehicle", "سند خودرو"],
  ["deposit", "حساب مسدودی بانکی"],
  ["check", "چک"],
]);

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function numericText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const raw = normalizeDigits(String(value)).trim();
  if (!raw) return null;
  const isGrouped = /^\d{1,3}(?:[,٬ ]\d{3})+$/.test(raw);
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw) && !isGrouped) return null;
  let normalized = raw;
  if (!normalized) return null;
  normalized = normalized.replace(/[٬,]/g, "");
  if (isGrouped) normalized = normalized.replace(/ /g, "");
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized)) return null;
  return normalized;
}

function parseMoney(value: unknown): number | null {
  const normalized = numericText(value);
  if (!normalized || normalized.includes(".")) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function parseInstallmentCount(value: unknown): number | null {
  const normalized = numericText(value);
  if (!normalized || normalized.includes(".")) return null;
  const count = Number(normalized);
  return Number.isSafeInteger(count) && count > 0 && count <= 1200 ? count : null;
}

function parseDepositPercent(value: unknown): number | null {
  const normalized = numericText(value);
  if (!normalized) return null;
  const percent = Number(normalized);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

function payout(principalAmount: unknown, depositPercent: unknown): number | null {
  const principal = parseMoney(principalAmount);
  const percent = parseDepositPercent(depositPercent);
  if (principal === null || percent === null) return null;
  const amount = Math.round(principal * percent / 100);
  return Number.isSafeInteger(amount) ? amount : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configured(value: unknown): boolean {
  return value !== null && value !== undefined &&
    !(typeof value === "string" && !value.trim());
}

function durationMap(value: unknown): Map<string, unknown> {
  const parsed = typeof value === "string" ? parsedJson(value) : value;
  const map = record(parsed);
  return new Map(Object.entries(map ?? {}));
}

function scalarOrMappedPercent(value: unknown, duration: number | null): unknown {
  const parsed = typeof value === "string" ? parsedJson(value) ?? value : value;
  const map = record(parsed);
  if (map) {
    if (duration === null) return undefined;
    return map[String(duration)] ?? map[normalizeDigits(String(duration))];
  }
  return parsed;
}

function publicOptions(plan: InstagramPublicPlanSource): InstagramPublicPlan["options"] {
  const rawTerms = plan.installmentTerms;
  const termsConfigured = configured(rawTerms);
  const terms = typeof rawTerms === "string" ? parsedJson(rawTerms) : rawTerms;
  const percentMap = durationMap(plan.depositPercents);
  const configuredTerm = (duration: unknown, percent: unknown) => {
    const installmentCount = parseInstallmentCount(duration);
    const resolvedPercent = percent === null || percent === undefined
      ? scalarOrMappedPercent(plan.depositPercents, installmentCount)
      : percent;
    return {
      installmentCount,
      customerPayout: payout(plan.principalAmount, resolvedPercent),
      installmentAmount: null,
    };
  };

  if (Array.isArray(terms) && terms.length) {
    return terms.slice(0, MAX_OPTIONS).map((term) => {
      const values = record(term);
      if (values) return configuredTerm(values.installments, values.depositPercent);
      return configuredTerm(term, undefined);
    });
  }
  if (termsConfigured && terms !== null && terms !== undefined && !Array.isArray(terms)) {
    const scalarDuration = parseInstallmentCount(terms);
    if (scalarDuration !== null) {
      return [configuredTerm(terms, scalarOrMappedPercent(plan.depositPercents, scalarDuration))];
    }
    const durationTerms = record(terms);
    if (durationTerms) {
      const looksLikeSingleTerm = Object.hasOwn(durationTerms, "installments");
      if (looksLikeSingleTerm) {
        return [configuredTerm(
          durationTerms.installments,
          durationTerms.depositPercent,
        )];
      }
      const entries = Object.entries(durationTerms).slice(0, MAX_OPTIONS);
      if (entries.length) {
        return entries.map(([duration, value]) => {
          const mappedValue = record(value);
          return configuredTerm(
            duration,
            mappedValue?.depositPercent ?? value,
          );
        });
      }
    }
    // Invalid configured data is explicit unknown data. Do not silently fall
    // back to a legacy value and make it appear authoritative.
    return [{ installmentCount: null, customerPayout: null, installmentAmount: null }];
  }
  if (termsConfigured && terms === null) {
    return [{ installmentCount: null, customerPayout: null, installmentAmount: null }];
  }

  const durations = parseInstallmentCount(plan.installments);
  if (durations !== null) {
    return [configuredTerm(
      plan.installments,
      scalarOrMappedPercent(plan.depositPercents, durations),
    )];
  }
  if (percentMap.size) {
    return [...percentMap.entries()].slice(0, MAX_OPTIONS).map(([duration, percent]) =>
      configuredTerm(duration, percent));
  }
  const scalarPercent = scalarOrMappedPercent(plan.depositPercents, null);
  if (scalarPercent !== undefined && scalarPercent !== null) {
    return [configuredTerm(undefined, scalarPercent)];
  }
  return [];
}

function conditionDurations(value: unknown): Set<number> {
  const parsed = typeof value === "string" ? parsedJson(value) : value;
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.map(parseInstallmentCount).filter((count): count is number => count !== null));
}

function effectiveConditionPlan(
  plan: InstagramPublicPlanSource,
  condition: InstagramPublicPlanConditionSource,
): InstagramPublicPlanSource {
  const planPrincipal = parseMoney(plan.principalAmount);
  const maximum = parseMoney(condition.maxPrincipal);
  const principalAmount = planPrincipal === null || maximum === null
    ? plan.principalAmount
    : Math.min(planPrincipal, maximum);
  const hasCustomerType = configured(condition.collateralType);
  const hasGuarantorType = configured(condition.guarantorCollateralType);
  const effective: InstagramPublicPlanSource = {
    ...plan,
    principalAmount,
    needsGuarantor: triStateBoolean(condition.needsGuarantor) ?? plan.needsGuarantor,
    needsCustomerPromissory:
      triStateBoolean(condition.needsCustomerPromissory) ?? plan.needsCustomerPromissory,
    needsGuarantorPromissory:
      triStateBoolean(condition.needsGuarantorPromissory) ?? plan.needsGuarantorPromissory,
    needsCustomerCheck:
      triStateBoolean(condition.needsCustomerCheck) ?? plan.needsCustomerCheck,
    needsGuarantorCheck:
      triStateBoolean(condition.needsGuarantorCheck) ?? plan.needsGuarantorCheck,
    needsCustomerSalaryDeduct:
      triStateBoolean(condition.needsCustomerSalaryDeduct) ?? plan.needsCustomerSalaryDeduct,
    needsGuarantorSalaryDeduct:
      triStateBoolean(condition.needsGuarantorSalaryDeduct) ?? plan.needsGuarantorSalaryDeduct,
    customerCheck: hasCustomerType ? condition.collateralType : plan.customerCheck,
    collateralType: hasCustomerType ? condition.collateralType : plan.collateralType,
    guarantorCheck: hasGuarantorType ? condition.guarantorCollateralType : plan.guarantorCheck,
    guarantorCollateralType: hasGuarantorType
      ? condition.guarantorCollateralType
      : plan.guarantorCollateralType,
  };
  const guarantorSecurity = derivedCollateral(effective, "guarantor");
  if (triStateBoolean(effective.needsGuarantor) === false && guarantorSecurity?.length) {
    // A no-guarantor flag conflicts with explicit guarantor security. Keep the
    // outcome unknown instead of publishing a contradictory eligibility claim.
    effective.needsGuarantor = null;
    effective.needsGuarantorPromissory = null;
    effective.needsGuarantorCheck = null;
    effective.needsGuarantorSalaryDeduct = null;
    effective.guarantorCheck = null;
    effective.guarantorCollateralType = null;
  }
  return effective;
}

function sameOptionTerms(left: InstagramPublicPlanOption, right: InstagramPublicPlanOption): boolean {
  return left.installmentCount === right.installmentCount &&
    left.customerPayout === right.customerPayout &&
    left.installmentAmount === right.installmentAmount;
}

function sameLabels(left: string[] | null, right: string[] | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConditionOption(
  previous: InstagramPublicPlanOption,
  next: InstagramPublicPlanOption,
): InstagramPublicPlanOption {
  return {
    ...previous,
    guarantorRequired: previous.guarantorRequired === next.guarantorRequired
      ? previous.guarantorRequired
      : null,
    customerCollateral: sameLabels(previous.customerCollateral ?? null, next.customerCollateral ?? null)
      ? previous.customerCollateral ?? null
      : null,
    guarantorCollateral: sameLabels(previous.guarantorCollateral ?? null, next.guarantorCollateral ?? null)
      ? previous.guarantorCollateral ?? null
      : null,
  };
}

function optionsWithConditions(plan: InstagramPublicPlanSource): InstagramPublicPlanOption[] {
  const conditions = plan.conditions;
  if (!conditions?.length) return publicOptions(plan);
  const byTerms: InstagramPublicPlanOption[] = [];
  for (const condition of conditions.slice(0, MAX_OPTIONS)) {
    const conditionPlan = effectiveConditionPlan(plan, condition);
    const allowedDurations = conditionDurations(condition.installmentOptions);
    const options = publicOptions(conditionPlan).filter((option) =>
      !allowedDurations.size ||
      (option.installmentCount !== null && allowedDurations.has(option.installmentCount)));
    for (const option of options) {
      const candidate: InstagramPublicPlanOption = {
        ...option,
        guarantorRequired: triStateBoolean(conditionPlan.needsGuarantor),
        customerCollateral: derivedCollateral(conditionPlan, "customer"),
        guarantorCollateral: derivedCollateral(conditionPlan, "guarantor"),
      };
      const existing = byTerms.find((item) => sameOptionTerms(item, candidate));
      if (existing) Object.assign(existing, mergeConditionOption(existing, candidate));
      else if (byTerms.length < MAX_OPTIONS) byTerms.push(candidate);
    }
  }
  return byTerms;
}

function commonOptionValue<T>(
  options: readonly InstagramPublicPlanOption[],
  get: (option: InstagramPublicPlanOption) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T | null {
  if (!options.length) return null;
  const first = get(options[0]);
  return options.every((option) => equal(first, get(option))) ? first : null;
}

function documentList(
  raw: unknown,
  labels: ReadonlyMap<string, string>,
): string[] | null {
  const parsed = typeof raw === "string" ? parsedJson(raw) : raw;
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return [];
  if (parsed.length > 100) return null;
  const result: string[] = [];
  for (const rawKey of parsed) {
    if (typeof rawKey !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(rawKey)) return null;
    const key = rawKey.trim();
    // This plan-level list cannot establish whether guarantee collateral is a
    // customer or guarantor responsibility, so do not present it as complete.
    if (GUARANTOR_DOCUMENT_KEYS.has(key)) return null;
    const label = labels.get(key);
    if (!label) return null;
    const safeLabel = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
      .slice(0, MAX_DOCUMENT_LABEL_LENGTH);
    if (!safeLabel) return null;
    if (!result.includes(safeLabel)) result.push(safeLabel);
    if (result.length > MAX_CUSTOMER_DOCUMENTS) return null;
  }
  return result;
}

function safePlanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function triStateBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function collateralLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return COLLATERAL_LABELS.get(key) ?? null;
}

function derivedCollateral(
  source: InstagramPublicPlanSource,
  side: "customer" | "guarantor",
): string[] | null {
  const isCustomer = side === "customer";
  const needsCheck = triStateBoolean(
    isCustomer ? source.needsCustomerCheck : source.needsGuarantorCheck,
  );
  const needsPromissory = triStateBoolean(
    isCustomer ? source.needsCustomerPromissory : source.needsGuarantorPromissory,
  );
  const needsSalaryDeduct = triStateBoolean(
    isCustomer ? source.needsCustomerSalaryDeduct : source.needsGuarantorSalaryDeduct,
  );
  const type = collateralLabel(isCustomer
    ? source.customerCheck ?? source.collateralType
    : source.guarantorCheck ?? source.guarantorCollateralType);
  const flags = [needsCheck, needsPromissory, needsSalaryDeduct];
  if (flags.every((flag) => flag === null) && type === null) return null;
  const result: string[] = [];
  if (needsPromissory === true) result.push("سفته");
  if (needsCheck === true) result.push(type && type !== "بدون وثیقه" ? type : "چک");
  if (needsSalaryDeduct === true) result.push("گواهی کسر از حقوق");
  if (type === "بدون وثیقه" && flags.every((flag) => flag !== true)) return [];
  const typeWasExplicitlyDisabled =
    (type === "سفته" && needsPromissory === false) ||
    (/چک/u.test(type ?? "") && needsCheck === false) ||
    (type === "گواهی کسر از حقوق" && needsSalaryDeduct === false);
  if (type && type !== "بدون وثیقه" && !typeWasExplicitlyDisabled && !result.includes(type)) {
    result.push(type);
  }
  if (!result.length && flags.every((flag) => flag === false)) return [];
  return result.length ? result : null;
}

function isActive(source: InstagramPublicPlanSource): boolean {
  if (!Object.hasOwn(source, "active")) return true;
  const active = triStateBoolean(source.active);
  return active === true;
}

/**
 * Creates the small public plan context used only for Instagram replies.
 * Internal plan fields and raw document identifiers are intentionally not copied.
 */
export function projectInstagramPublicPlans(
  plans: readonly InstagramPublicPlanSource[],
  documentLabels: ReadonlyMap<string, string>,
): InstagramPublicPlan[] {
  return plans.slice(0, 100)
    .filter(isActive)
    .map((plan) => {
      const options = optionsWithConditions(plan);
      const hasConditions = Boolean(plan.conditions?.length);
      return {
        name: safePlanName(plan.name),
        options,
        customerDocuments: documentList(plan.requiredDocuments, documentLabels),
        guarantorDocuments: null,
        guarantorRequired: hasConditions
          ? commonOptionValue(options, (option) => option.guarantorRequired ?? null)
          : triStateBoolean(plan.needsGuarantor),
        customerCollateral: hasConditions
          ? commonOptionValue(
            options,
            (option) => option.customerCollateral ?? null,
            sameLabels,
          )
          : derivedCollateral(plan, "customer"),
        guarantorCollateral: hasConditions
          ? commonOptionValue(
            options,
            (option) => option.guarantorCollateral ?? null,
            sameLabels,
          )
          : derivedCollateral(plan, "guarantor"),
      };
    });
}
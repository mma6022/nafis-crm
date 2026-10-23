import { isCertificatePreflightRetry } from "./contract-preflight-retry";
export const TOMAN_REPLACEMENT_ACTION = "authorize-toman-replacement";
export const TOMAN_REPLACEMENT_PURPOSE = "legacy_toman_replacement";

export type TomanReplacementConsent = {
  version: 1;
  priorStage: string;
  resumeStage: string;
  priorStatus: string;
  sourceGenerationId: number;
  tomanTemplateId: number;
  approvedAmount: string;
  durationMonths: number;
  reason: string;
  authorizedAt: string;
  authorizedByUserId: number;
  replacementGenerationId?: number | null;
  completedAt?: string | null;
};

export function parseTomanReplacementConsent(value: unknown): TomanReplacementConsent | null {
  if (typeof value !== "string") return null;
  try {
    const consent = JSON.parse(value) as Partial<TomanReplacementConsent>;
    if (consent.version !== 1 ||
        typeof consent.priorStage !== "string" ||
        typeof consent.resumeStage !== "string" ||
        typeof consent.priorStatus !== "string" ||
        !Number.isSafeInteger(consent.sourceGenerationId) ||
        !Number.isSafeInteger(consent.tomanTemplateId) ||
        typeof consent.approvedAmount !== "string" ||
        !/^[1-9]\d{0,17}$/.test(consent.approvedAmount) ||
        !Number.isSafeInteger(consent.durationMonths) ||
        Number(consent.durationMonths) < 1 || Number(consent.durationMonths) > 600 ||
        typeof consent.reason !== "string" ||
        typeof consent.authorizedAt !== "string" ||
        !Number.isSafeInteger(consent.authorizedByUserId)) return null;
    return consent as TomanReplacementConsent;
  } catch {
    return null;
  }
}

export function normalizedContractInteger(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[,\u060c\u066c\s]/g, "");
}

/** Denomination repair is not a duration amendment. Unknown original terms fail closed. */
export function tomanReplacementDurationChanged(application: any): boolean {
  const requested = Number(application?.requested_duration_months);
  const approved = Number(application?.duration_months);
  return !Number.isSafeInteger(requested) || requested < 1 || requested > 600 ||
    !Number.isSafeInteger(approved) || approved < 1 || approved > 600 || requested !== approved;
}

export function tomanReplacementNeedsInstallmentProof(application: any, mappings: unknown): boolean {
  return tomanReplacementDurationChanged(application) ||
    (Array.isArray(mappings) && mappings.some((mapping: any) =>
      (mapping?.sourceType ?? (mapping?.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
      ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping?.loanPlanField))));
}

export function tomanReplacementGenerationTermsMatch(
  generation: any,
  application: any,
  consent: TomanReplacementConsent,
  allowCertificateRetry = false,
): boolean {
  if (!generation || !application ||
      Number(generation.loan_application_id) !== Number(application.id) ||
      Number(generation.customer_id) !== Number(application.customer_id) ||
      Number(generation.loan_plan_id) !== Number(application.plan_id) ||
      Number(generation.template_id) !== consent.tomanTemplateId ||
      String(generation.generation_purpose ?? "") !== TOMAN_REPLACEMENT_PURPOSE ||
      generation.deleted_at || generation.superseded_at ||
      (!["generated", "sent", "signed"].includes(String(generation.status)) &&
        !(allowCertificateRetry && isCertificatePreflightRetry(generation))) ||
      String(application.approved_amount ?? "") !== consent.approvedAmount ||
      Number(application.duration_months) !== consent.durationMonths) return false;
  const mappings = typeof generation.mappings_snapshot_json === "string"
    ? safeJson(generation.mappings_snapshot_json) : generation.mappings_snapshot_json;
  const values = typeof generation.manual_values_json === "string"
    ? safeJson(generation.manual_values_json) : generation.manual_values_json;
  if (!Array.isArray(mappings) || !values || typeof values !== "object" || Array.isArray(values)) return false;
  const sourceType = (mapping: any) =>
    mapping?.sourceType ?? (mapping?.customerField ? "customer" : mapping?.loanPlanField ? "loanPlan" : "manual");
  const principal = mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" && mapping?.loanPlanField === "loanPlan.principalAmount");
  const durations = mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" &&
    ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping?.loanPlanField)));
  if (principal.length !== 1 || durations.length > 1 ||
      (tomanReplacementDurationChanged(application) && durations.length !== 1) ||
      normalizedContractInteger(values[principal[0].variable]) !== consent.approvedAmount ||
      durations.some((mapping: any) =>
        normalizedContractInteger(values[mapping.variable]) !== String(consent.durationMonths))) return false;
  const manual = mappings.filter((mapping: any) => sourceType(mapping) === "manual");
  const savedManual = typeof application.primary_manual_values_json === "string"
    ? safeJson(application.primary_manual_values_json) : application.primary_manual_values_json;
  if (!savedManual || typeof savedManual !== "object" || Array.isArray(savedManual)) return false;
  const savedKeys = Object.keys(savedManual).sort();
  const generationKeys = manual.map((mapping: any) => String(mapping.variable)).sort();
  if (savedKeys.length !== generationKeys.length ||
      savedKeys.some((key, index) => key !== generationKeys[index])) return false;
  return manual.every((mapping: any) =>
    typeof savedManual[mapping.variable] === "string" &&
    typeof values[mapping.variable] === "string" &&
    sameManualValue(savedManual[mapping.variable], values[mapping.variable]));
}

function safeJson(value: string): any {
  try { return JSON.parse(value); } catch { return null; }
}

function sameManualValue(expected: string, actual: string): boolean {
  if (expected.trim() === actual.trim()) return true;
  const numeric = (value: string) => value.trim()
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[٬،,\s]/g, "").replace(/٫/g, ".");
  const left = numeric(expected), right = numeric(actual);
  return /^[-+]?\d+(?:\.\d+)?$/.test(left) && left === right;
}
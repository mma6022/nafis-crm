import { compactRankList, gradeMatches, normalizeGrade, parseStoredRanks } from "./credit-subgrades";

/**
 * Guarantor credit grade («رتبهٔ ضامن») against a plan condition — the same rule the first-call form
 * (team-sales-rules matchPlans/evaluatePlans) and the consultation (evaluatePlanCondition) use:
 *  - the condition does not need a guarantor, or lists no guarantor grades  → no restriction;
 *  - the guarantor grade is missing / «نمی‌دونه» (unknown)                  → kept, flagged (status "unknown");
 *  - a known grade that gradeMatches() accepts                              → ok;
 *  - a known grade it rejects                                               → violated (the condition is not offered).
 * Matching is gradeMatches(): an old bare letter ("B") on the guarantor side matches any of its sub-grades,
 * a bare letter in the rule means its three sub-grades.
 */
export type GuarantorGradeStatus = "not_required" | "no_rule" | "ok" | "unknown" | "violated";
export type GuarantorGradeVerdict = { status: GuarantorGradeStatus; ranks: string[]; have: string | null; note: string | null };

export function conditionGuarantorRule(condition: any, plan?: any): { needsGuarantor: boolean; ranks: string[] } {
  const needs = condition?.needs_guarantor ?? plan?.needs_guarantor;
  return { needsGuarantor: Boolean(Number(needs ?? 0)), ranks: parseStoredRanks(condition?.guarantor_ranks) };
}

export function isUnknownGuarantorGrade(rank: unknown): boolean {
  const v = normalizeGrade(rank);
  return !v || v === "UNKNOWN";
}

export function guarantorGradeVerdict(condition: any, guarantorRank: unknown, plan?: any): GuarantorGradeVerdict {
  const { needsGuarantor, ranks } = conditionGuarantorRule(condition, plan);
  if (!needsGuarantor) return { status: "not_required", ranks, have: null, note: null };
  if (!ranks.length) return { status: "no_rule", ranks, have: null, note: null };
  const label = compactRankList(ranks).join("/");
  if (isUnknownGuarantorGrade(guarantorRank))
    return { status: "unknown", ranks, have: null, note: `رتبهٔ ضامن باید ${label} باشد` };
  const have = normalizeGrade(guarantorRank);
  if (gradeMatches(have, ranks)) return { status: "ok", ranks, have, note: null };
  return { status: "violated", ranks, have, note: `رتبهٔ ضامن (${have}) با ${label} این شرط نمی‌خواند` };
}

export const guarantorGradeAllows = (verdict: GuarantorGradeVerdict): boolean => verdict.status !== "violated";

/**
 * Which guarantor grade the staff wizard / customer portal use for a customer: the newest declaration from either the
 * consultation (staff or portal «پلن‌یاب», consultation_forms.has_guarantor / guarantor_credit_rank) or the
 * first-call form (team_sales_qualifications answers guarantorAvailable / gRank). No declaration, «ضامن ندارد», or
 * «نمی‌دونه» all leave the grade unknown, which (like the call form) keeps the condition and flags it.
 */
export type GuarantorGradeSource = {
  rank: string | null; hasGuarantor: boolean | null;
  source: "consultation" | "call_form" | null; sourceId: number | null; at: string | null;
};
export type ConsultationGuarantorRow = { id: number; has_guarantor: unknown; guarantor_credit_rank: unknown; created_at: string };
export type CallFormGuarantorRow = { id: number; guarantorAvailable: unknown; gRank: unknown; created_at: string };

export function pickGuarantorGrade(consultation?: ConsultationGuarantorRow | null, callForm?: CallFormGuarantorRow | null): GuarantorGradeSource {
  const fromConsultation = consultation && consultation.has_guarantor != null ? {
    rank: Number(consultation.has_guarantor) && !isUnknownGuarantorGrade(consultation.guarantor_credit_rank) ? normalizeGrade(consultation.guarantor_credit_rank) : null,
    hasGuarantor: Boolean(Number(consultation.has_guarantor)), source: "consultation" as const,
    sourceId: Number(consultation.id), at: String(consultation.created_at),
  } : null;
  const avail = callForm ? String(callForm.guarantorAvailable ?? "") : "";
  const fromCallForm = callForm && ["yes", "no", "unknown"].includes(avail) ? {
    rank: avail === "yes" && !isUnknownGuarantorGrade(callForm.gRank) ? normalizeGrade(callForm.gRank) : null,
    hasGuarantor: avail === "yes" ? true : avail === "no" ? false : null, source: "call_form" as const,
    sourceId: Number(callForm.id), at: String(callForm.created_at),
  } : null;
  const picked = fromConsultation && fromCallForm ? (fromCallForm.at > fromConsultation.at ? fromCallForm : fromConsultation)
    : fromConsultation ?? fromCallForm;
  return picked ?? { rank: null, hasGuarantor: null, source: null, sourceId: null, at: null };
}

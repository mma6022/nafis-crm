export type QuestionnaireOption = { id: number; fieldKey: string; value: string; labelFa: string; sortOrder: number };
export function questionnaireError(body: Record<string, unknown>, options: QuestionnaireOption[]): string | null {
  if (body.questionnaireVersion !== 1 && body.questionnaireVersion !== 2) return null;
  const selected = (field: string, value: unknown) => typeof value === "string" &&
    options.some(o => o.fieldKey === field && o.value === value);
  if (!selected("credit_rank", body.creditRank)) return "رتبه اعتباری متقاضی را از گزینه‌های معتبر انتخاب کنید.";
  if (!selected("job_type", body.jobType)) return "شغل متقاضی را از گزینه‌های معتبر انتخاب کنید.";
  if (!selected("customer_check_status", body.customerCheckStatus)) return "وضعیت چک متقاضی را انتخاب کنید.";
  if (typeof body.hasCustomerSalaryDeduct !== "boolean" || typeof body.hasGuarantor !== "boolean")
    return "وضعیت کسر از حقوق متقاضی و وجود ضامن را مشخص کنید.";
  if (body.hasGuarantor && (!selected("guarantor_check_type", body.guarantorCheckType) ||
      typeof body.hasGuarantorSalaryDeduct !== "boolean")) return "وضعیت چک و کسر از حقوق ضامن را مشخص کنید.";
  if (body.questionnaireVersion === 2 && body.hasGuarantor &&
      !selected("guarantor_credit_rank", body.guarantorCreditRank))
    return "رتبه اعتباری ضامن را از گزینه‌های معتبر انتخاب کنید.";
  return null;
}

/** Only consultation advice accepts a declared rank; verified scoring remains separate. */
export function consultationRankMatches(rank: string, permitted: string[]): boolean {
  const normalized = rank.trim().toUpperCase();
  return permitted.some(value => value === normalized || (/^[A-E]$/.test(value) && normalized.startsWith(value)));
}

export const INSTALLMENT_VARIABLE = "crmApprovedInstallments";
export const INSTALLMENT_MARKER = "crmApprovedInstallmentsV1";
export const INSTALLMENT_SOURCE = "approved-installments-v1";
const sourceType = (m: any) => m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual");
const durationMappings = (m: any[]) => m.filter(x => sourceType(x) === "loanPlan" &&
  ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(x.loanPlanField)));

/** Add server-owned approved terms only to a newly rendered replacement. */
export function appendApprovedInstallments(xml: string, application: any, mappings: any[], values: Record<string, string>): string {
  if (!application?.initial_approval_at ||
      Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      durationMappings(mappings).length) return xml;
  const count = Number(application.duration_months);
  const principal = mappings.filter(m => sourceType(m) === "loanPlan" && m.loanPlanField === "loanPlan.principalAmount");
  if (!Number.isSafeInteger(count) || count < 1 || count > 600 || principal.length !== 1 ||
      !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(principal[0].variable) ||
      mappings.some(m => m.variable === INSTALLMENT_VARIABLE) || xml.includes(INSTALLMENT_MARKER) ||
      !xml.includes("</w:body>")) throw Error("approved_contract_terms_not_rendered");
  const p = (text: string, marker = false) => `<w:p><w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>${
    marker ? `<w:bookmarkStart w:id="2147483000" w:name="${INSTALLMENT_MARKER}"/>` : ""
  }<w:r><w:rPr><w:rtl/><w:rFonts w:ascii="Vazirmatn" w:hAnsi="Vazirmatn" w:cs="Vazirmatn"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>${
    marker ? '<w:bookmarkEnd w:id="2147483000"/>' : ""
  }</w:p>`;
  const block = p(`اصل وام: %${principal[0].variable}% تومان`) +
    p(`تعداد اقساط: %${INSTALLMENT_VARIABLE}% قسط`, true);
  // sectPr must remain the body's last child in valid WordprocessingML.
  const boundary = xml.lastIndexOf("<w:sectPr");
  const at = boundary >= 0 ? boundary : xml.lastIndexOf("</w:body>");
  mappings.push({ variable: INSTALLMENT_VARIABLE, sourceType: "loanPlan",
    loanPlanField: "loanPlan.installments", systemGenerated: INSTALLMENT_SOURCE });
  values[INSTALLMENT_VARIABLE] = String(count);
  return xml.slice(0, at) + block + xml.slice(at);
}

/** The ordinary source-placeholder proof remains required for user mappings. */
export function isApprovedInstallmentAppendix(mapping: any, renderedXml: string, sourceText: string): boolean {
  return mapping?.variable === INSTALLMENT_VARIABLE && mapping?.sourceType === "loanPlan" &&
    mapping?.loanPlanField === "loanPlan.installments" && mapping?.systemGenerated === INSTALLMENT_SOURCE &&
    !sourceText.includes(`%${INSTALLMENT_VARIABLE}%`) &&
    (renderedXml.match(new RegExp(`w:name="${INSTALLMENT_MARKER}"`, "g")) ?? []).length === 1;
}

export function canRebuildUnsentInstallments(application: any, generation: any, compatibleExceptDuration: () => boolean): boolean {
  if (!application?.initial_approval_at || application.status === "rejected" ||
      application.stage !== "approved_contract_pending_signature" ||
      Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      (application.current_primary_generation_id != null &&
        Number(application.current_primary_generation_id) !== Number(generation?.id)) ||
      generation?.status !== "generated" || generation.deleted_at || generation.superseded_at ||
      generation.provider_contract_id || generation.provider_file_id ||
      generation.generation_purpose !== "primary" || !generation.pdf_path || !generation.pdf_sha256) return false;
  try {
    const mappings = JSON.parse(generation.mappings_snapshot_json || "[]");
    if (!Array.isArray(mappings) || durationMappings(mappings).length) return false;
  } catch { return false; }
  return compatibleExceptDuration() === true;
}

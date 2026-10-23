import { isStrictSignedProviderState } from "./emzame-signature";

export const ACCEPTED_LEGACY_RIAL_ACTION = "legacy-rial-primary-accepted-without-reissue";
type Query = (sql: string, args?: any[]) => any;

/** Owner-approved historical unit exception, not a waiver of rendered proof. */
export function acceptedLegacyRialPrimary(
  application: any, primary: any, amount: string, duration: number,
  queryRow: Query, proveLegacyPrincipal: () => boolean,
): boolean {
  if (!application || !primary || !application.initial_approval_at ||
      application.status === "rejected" || primary.deleted_at || primary.superseded_at ||
      primary.status !== "signed" || !isStrictSignedProviderState(primary.provider_status) ||
      String(primary.generation_purpose ?? "primary") !== "primary" ||
      ![4, 5].includes(Number(primary.template_id)) ||
      Number(application.current_primary_generation_id) !== Number(primary.id) ||
      Number(primary.loan_application_id) !== Number(application.id) ||
      Number(primary.customer_id) !== Number(application.customer_id) ||
      Number(primary.loan_plan_id) !== Number(application.plan_id) ||
      String(primary.link ?? "") !== `signed:${primary.provider_contract_id}` ||
      !primary.provider_contract_id || !/^[a-f0-9]{64}$/i.test(String(primary.pdf_sha256 ?? "")) ||
      !/^[a-f0-9]{64}$/i.test(String(primary.docx_sha256 ?? "")) ||
      !/^[1-9]\d{0,17}$/.test(amount) ||
      amount !== String(application.approved_amount) || amount !== String(application.requested_amount) ||
      !Number.isSafeInteger(duration) || duration < 1 || duration > 600 ||
      duration !== Number(application.duration_months) ||
      duration !== Number(application.requested_duration_months ?? application.duration_months)) return false;
  const row = queryRow(`SELECT h.reason,h.actor_id,h.created_at,u.role AS actor_role
    FROM loan_application_stage_history h JOIN users u ON u.id=h.actor_id
    WHERE h.application_id=? AND h.action=? ORDER BY h.id DESC LIMIT 1`,
  [Number(application.id), ACCEPTED_LEGACY_RIAL_ACTION]);
  if (!row || row.actor_role !== "admin" || !Number.isSafeInteger(Number(row.actor_id)) ||
      Number(row.actor_id) <= 0) return false;
  let consent: any;
  try { consent = JSON.parse(row.reason); } catch { return false; }
  if (!consent || consent.version !== 1 || consent.explicitApproval !== true ||
      consent.acceptedMoneyUnit !== "toman" || consent.noCurrencyConversion !== true ||
      consent.applicationId !== Number(application.id) || consent.generationId !== Number(primary.id) ||
      consent.customerId !== Number(application.customer_id) || consent.planId !== Number(application.plan_id) ||
      consent.templateId !== Number(primary.template_id) ||
      consent.providerContractId !== String(primary.provider_contract_id) ||
      consent.pdfSha256 !== String(primary.pdf_sha256) || consent.docxSha256 !== String(primary.docx_sha256) ||
      consent.amount !== amount || consent.durationMonths !== duration ||
      consent.netAmount !== String(application.net_amount ?? "") ||
      consent.planSnapshotJson !== String(application.plan_snapshot_json ?? "") ||
      consent.conditionSnapshotJson !== String(application.condition_snapshot_json ?? "") ||
      consent.authorizedByUserId !== Number(row.actor_id) || consent.authorizedAt !== row.created_at ||
      !Number.isFinite(Date.parse(consent.authorizedAt))) return false;
  // Checks original template, DOCX/PDF hashes, mapping, unique principal clause
  // and the unchanged numeric amount in the original rendered Rial document.
  try { return proveLegacyPrincipal() === true; } catch { return false; }
}

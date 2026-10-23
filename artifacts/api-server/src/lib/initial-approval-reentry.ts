type ReentryDependencies = {
  queryRow: (sql: string, params?: any[]) => any;
  queryRows: (sql: string, params?: any[]) => any[];
  documents: (applicationId: number) => any[];
  fileExists: (file: unknown) => boolean;
};

/**
 * A manually returned case has already replaced its requested-terms contract.
 * Recognize that explicit return without clearing or fabricating prior approvals.
 * Signature and rendered financial evidence are still checked by the caller.
 */
export function canReapproveInitialDecision(a: any, d: ReentryDependencies): boolean {
  if (!a || a.stage !== "funder_initial_approval" || a.status === "rejected" ||
      !a.initial_approval_at || Number(a.new_case_workflow) !== 1 ||
      !a.current_primary_generation_id || a.admin_approved_at) return false;
  if (d.queryRow("SELECT 1 FROM wallet_ledger_v2 WHERE application_id=? LIMIT 1", [a.id])) return false;
  const returned = d.queryRow(`SELECT h.id FROM loan_application_stage_history h
    JOIN users u ON u.id=h.actor_id
    WHERE h.application_id=? AND (
      (h.action='admin-stage-corrected' AND u.role='admin'
        AND h.to_stage='funder_initial_approval' AND h.from_stage<>'funder_initial_approval')
      OR (h.action='funder-initial-reject' AND u.role IN ('admin','registrar')
        AND h.to_stage='customer_documents_upload' AND json_valid(h.reason)
        AND json_extract(h.reason,'$.returnedToSales')=1))
      AND h.id>COALESCE((SELECT MAX(id) FROM loan_application_stage_history
        WHERE application_id=? AND action='funder-initial-approve'),0)
    ORDER BY h.id DESC LIMIT 1`, [a.id, a.id]);
  if (!returned || !d.queryRow(`SELECT 1 FROM loan_application_stage_history
    WHERE application_id=? AND action='review-customer-documents'
      AND from_stage='customer_documents_review' AND id<? LIMIT 1`, [a.id, returned.id])) return false;
  // Replacement primary signatures advance automatically; their review flag may
  // remain pending. Only that flag is handled separately, never identity files.
  if (!d.documents(Number(a.id)).every(row =>
    row.status === "approved" && d.fileExists(row.storage_path))) return false;
  const identities = d.queryRows(`SELECT document_type,approved_at,review_reason,storage_path
    FROM customer_identity_documents WHERE customer_id=? AND is_latest=1
    AND document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')`,
  [a.customer_id]);
  return identities.length === 5 && new Set(identities.map(row => row.document_type)).size === 5 &&
    identities.every(row => row.approved_at && !row.review_reason && d.fileExists(row.storage_path));
}

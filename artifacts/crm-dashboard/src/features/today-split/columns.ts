/** today-split-files-board v1.0.2 §3: the 7 board columns and the real stages in each (Armita). Every actionPolicy stage has exactly one column;
 * «لغوشده» = status 'rejected' at any stage. Shared by the stage-1 file sheet (stepper + «ستون …») and the stage-3 board. */
export type FbColumn = 'draft' | 'documents' | 'collateral' | 'signature' | 'review' | 'completed' | 'cancelled';
export const FB_COLUMNS: ReadonlyArray<{ key: FbColumn; label: string; stages: readonly string[] }> = [
  { key: 'draft', label: 'پیش‌نویس', stages: ['draft'] },
  { key: 'documents', label: 'مدارک', stages: ['customer_documents_upload', 'physical_documents_submission', 'physical_documents_correction', 'funder_documents_correction'] },
  { key: 'collateral', label: 'وثیقه و ضامن', stages: ['guarantor_registration', 'guarantor_documents_upload', 'collateral_upload'] },
  { key: 'signature', label: 'امضای مشتری', stages: ['primary_contract_pending_signature', 'approved_contract_pending_signature', 'funder_amendment_pending_signature', 'final_invoice_pending_signature'] },
  { key: 'review', label: 'در بررسی', stages: ['customer_documents_review', 'guarantor_documents_review', 'collateral_review', 'physical_documents_review', 'expert_approval', 'funder_initial_approval', 'funder_amendment_review', 'funder_result_review', 'wallet_charge_pending', 'admin_approval'] },
  { key: 'completed', label: 'تکمیل‌شده', stages: ['completed'] },
  { key: 'cancelled', label: 'لغوشده', stages: [] },
];
export function fbColumnOf(stage: string | null | undefined, status?: string | null): FbColumn {
  if (status === 'rejected') return 'cancelled';
  return FB_COLUMNS.find((c) => c.stages.includes(String(stage ?? '')))?.key ?? 'review';
}
export const fbColumnLabel = (k: FbColumn) => FB_COLUMNS.find((c) => c.key === k)?.label ?? '';
/** The 6-step stage indicator of the card sheet (the cancelled column is not a step). */
export const FB_STEPS: ReadonlyArray<{ key: FbColumn; label: string }> = [
  { key: 'draft', label: 'پیش‌نویس' }, { key: 'documents', label: 'مدارک' }, { key: 'collateral', label: 'وثیقه و ضامن' },
  { key: 'signature', label: 'امضای مشتری' }, { key: 'review', label: 'در بررسی' }, { key: 'completed', label: 'تکمیل' },
];

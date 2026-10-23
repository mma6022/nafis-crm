export const stages: Record<string, string> = {
  draft: 'در انتظار تکمیل قرارداد توسط کارشناس', funder_initial_approval: 'تصویب مبلغ وام',
  primary_contract_pending_signature: 'در انتظار امضای قرارداد اولیه',
  approved_contract_pending_signature: 'در انتظار امضای قرارداد جایگزین',
  customer_documents_upload: 'بارگذاری مدارک', customer_documents_review: 'بررسی مدارک',
  guarantor_registration: 'ثبت ضامن', guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن', collateral_upload: 'ثبت وثیقه',
  collateral_review: 'بررسی وثیقه', expert_approval: 'تصمیم تأمین‌کننده',
  physical_documents_submission: 'ارسال مدارک فیزیکی', physical_documents_correction: 'رفع نقص مدارک فیزیکی', physical_documents_review: 'بررسی مدارک فیزیکی',
  funder_documents_correction: 'اصلاح مدارک مردود تأمین‌کننده', funder_result_review: 'بررسی نتیجه تأمین‌کننده',
  wallet_charge_pending: 'در انتظار تأیید شارژ', admin_approval: 'تأیید نهایی', final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل‌شده',
};
// Current cases sign requested terms before the funding decision. Replacement
// signatures are conditional; this track describes the general workflow only.
export const stageOrder = [
  'draft', 'primary_contract_pending_signature',
  'customer_documents_upload', 'customer_documents_review',
  'guarantor_registration', 'guarantor_documents_upload', 'guarantor_documents_review',
  'collateral_upload', 'collateral_review', 'expert_approval',
  'funder_initial_approval', 'approved_contract_pending_signature',
  'physical_documents_submission', 'physical_documents_correction', 'physical_documents_review',
  'funder_documents_correction', 'funder_result_review', 'wallet_charge_pending',
  'admin_approval', 'final_invoice_pending_signature', 'completed',
];

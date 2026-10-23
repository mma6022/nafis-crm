// Shared display labels for «درخواست تسهیلات» (list, customer page loan cards, wizard).
// Strings are copied verbatim from the existing pages; nothing here changes server behaviour.

export const LOAN_STAGE_LABELS: Record<string, string> = {
  funder_initial_approval: 'تصویب مبلغ وام',
  draft: 'پیش‌نویس',
  primary_contract_pending_signature: 'در انتظار امضای قرارداد توسط مشتری',
  approved_contract_pending_signature: 'امضای قرارداد جایگزین توسط مشتری',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه',
  collateral_review: 'بررسی وثیقه',
  physical_documents_correction: 'رفع نقص مدارک فیزیکی',
  physical_documents_submission: 'ارسال مدارک فیزیکی',
  physical_documents_review: 'بررسی مدارک فیزیکی',
  expert_approval: 'ثبت تصمیم تأمین‌کننده مالی',
  funder_documents_correction: 'اصلاح مدارک مردود تأمین‌کننده',
  funder_result_review: 'بررسی نتیجه تامین‌کننده',
  funder_amendment_pending_signature: 'در انتظار امضای الحاقیه قرارداد',
  funder_amendment_review: 'بررسی الحاقیه قرارداد',
  admin_approval: 'تأیید نهایی مدیر و شارژ اعتبار',
  wallet_charge_pending: 'در انتظار تأیید شارژ توسط کارشناس ثبت',
  final_invoice_pending_signature: 'امضای صورت‌حساب نهایی',
  completed: 'تکمیل شده',
};

/** Verbatim `BUSINESS_STATUS_LABELS` from LoanApplications.tsx (handoff §3). */
export const BUSINESS_STATUS_LABELS: Record<string, string> = {
  waiting_sales: 'در انتظار اقدام کارشناس فروش',
  waiting_customer_signature: 'در انتظار امضای قرارداد توسط مشتری',
  waiting_registration: 'در انتظار اقدام کارشناس ثبت',
  waiting_funder_approval: 'در انتظار تایید تامین‌کننده مالی',
  waiting_wallet_charge: 'در انتظار تأیید شارژ توسط کارشناس ثبت',
  wallet_charged: 'در انتظار تأیید نهایی مدیر',
  canceled: 'لغو شده',
  completed: 'تکمیل شده',
};

/** UI role names (app_roles in access-control.ts) for «نوبت اقدام». */
export const ACTION_ROLE_NAMES: Record<string, string> = {
  salesperson: 'کارشناس فروش',
  registrar: 'ثبت‌نام‌کننده',
  admin: 'مدیر سیستم',
  customer: 'مشتری',
};

/** Same stage → businessStatus mapping the API applies (routes/loan-applications.ts), for rows that lack it. */
const STAGE_BUSINESS_STATUS: Record<string, string> = {
  funder_initial_approval: 'waiting_registration', draft: 'waiting_sales',
  primary_contract_pending_signature: 'waiting_customer_signature', approved_contract_pending_signature: 'waiting_customer_signature',
  customer_documents_upload: 'waiting_sales', customer_documents_review: 'waiting_registration', guarantor_registration: 'waiting_sales',
  guarantor_documents_upload: 'waiting_sales', guarantor_documents_review: 'waiting_registration', collateral_upload: 'waiting_sales',
  collateral_review: 'waiting_registration', expert_approval: 'waiting_registration', funder_amendment_pending_signature: 'waiting_sales',
  funder_amendment_review: 'waiting_registration', funder_result_review: 'waiting_registration', funder_documents_correction: 'waiting_sales',
  physical_documents_submission: 'waiting_sales', physical_documents_review: 'waiting_registration', physical_documents_correction: 'waiting_sales',
  wallet_charge_pending: 'waiting_wallet_charge', admin_approval: 'waiting_wallet_charge', final_invoice_pending_signature: 'wallet_charged', completed: 'completed',
};

export function loanBusinessStatus(app: { businessStatus?: string | null; stage?: string | null; status?: string | null; cancellationReason?: string | null }) {
  if (app.status === 'rejected' || app.cancellationReason) return 'canceled';
  return app.businessStatus || (app.stage ? STAGE_BUSINESS_STATUS[app.stage] : undefined) || '';
}

export function loanStageLabel(stage?: string | null) {
  return stage ? LOAN_STAGE_LABELS[stage] ?? stage : '';
}

/** The 10 display steps of the create wizard, grouped in 5 phases (handoff §5). `s`/`p` = internal step / part. */
export const WIZARD_PHASES = ['مشتری', 'هویت و اعتبار', 'طرح و مبلغ', 'پرداخت و مدارک', 'بازبینی و ثبت'] as const;
export const WIZARD_DISPLAY_STEPS: ReadonlyArray<{ n: number; s: number; p: number; label: string; phase: number }> = [
  { n: 1, s: 1, p: 0, label: 'انتخاب مشتری', phase: 0 },
  { n: 2, s: 2, p: 0, label: 'اطلاعات هویتی', phase: 1 },
  { n: 3, s: 2, p: 1, label: 'احراز هویت', phase: 1 },
  { n: 4, s: 2, p: 2, label: 'رتبه اعتباری', phase: 1 },
  { n: 5, s: 3, p: 0, label: 'طرح و شرط', phase: 2 },
  { n: 6, s: 3, p: 1, label: 'مبلغ و مدت', phase: 2 },
  { n: 7, s: 4, p: 0, label: 'هزینه تشکیل پرونده', phase: 3 },
  { n: 8, s: 5, p: 0, label: 'مدارک هویتی', phase: 3 },
  { n: 9, s: 6, p: 0, label: 'اطلاعات تکمیلی قرارداد', phase: 4 },
  { n: 10, s: 6, p: 1, label: 'بازبینی و ثبت', phase: 4 },
];
export const WIZARD_TOTAL_STEPS = WIZARD_DISPLAY_STEPS.length;

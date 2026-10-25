// Persian explanations for loan-case workflow refusals. Every decision dialog
// (تصویب مبلغ، تصمیم نهایی تأمین‌کننده، تأیید/رد مدیر، بررسی مدارک، خاتمه)
// uses this so the user sees the real reason instead of a generic retry text.

export const LOAN_DECISION_ERROR_MESSAGES: Record<string, string> = {
  current_primary_terms_not_verified: 'قرارداد اصلی امضاشده با شرایط مصوب این پرونده (مبلغ یا تعداد اقساط) قابل تطبیق نیست. قرارداد اصلی فعلی پرونده را بررسی کنید؛ تکرار همین اقدام نتیجه را تغییر نمی‌دهد.',
  legacy_signed_primary_terms_unverifiable: 'شرایط قرارداد اصلی امضاشده این پرونده قدیمی قابل تأیید نیست. پیش از تصمیم نهایی، قرارداد قبلی باید بررسی و اصلاح شود.',
  toman_replacement_terms_unverifiable: 'قرارداد جایگزین تومانی این پرونده هنوز امضا یا تأیید نشده است.',
  toman_replacement_terms_stale: 'قرارداد جایگزین تومانی با شرایط فعلی پرونده هم‌خوانی ندارد و باید دوباره صادر شود.',
  approved_financial_terms_reconciliation_conflict: 'اطلاعات پرونده هم‌زمان تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.',
  approved_financial_terms_missing: 'مبلغ مصوب این پرونده ثبت نشده است. ابتدا مرحلهٔ تصویب مبلغ وام باید انجام شود.',
  final_funder_approval_has_no_term_inputs: 'در این مرحله امکان تغییر شرایط تسهیلات وجود ندارد.',
  final_funder_decision_already_recorded: 'تصمیم نهایی تأمین‌کننده برای این پرونده قبلاً ثبت شده است. صفحه را تازه کنید.',
  initial_funder_decision_already_recorded: 'تصویب مبلغ این پرونده قبلاً ثبت شده است. صفحه را تازه کنید.',
  invalid_stage_transition: 'این اقدام در مرحله فعلی پرونده مجاز نیست؛ ممکن است پرونده جابه‌جا شده باشد. صفحه را تازه کنید.',
  invalid_transition: 'این اقدام در مرحله فعلی پرونده مجاز نیست؛ ممکن است پرونده جابه‌جا شده باشد. صفحه را تازه کنید.',
  action_forbidden: 'شما مجاز به انجام این اقدام در مرحله فعلی نیستید.',
  admin_role_required: 'این اقدام فقط برای مدیر مجاز است.',
  loan_application_not_found: 'پرونده پیدا نشد یا به شما تخصیص داده نشده است.',
  review_reason_required: 'درج دلیل این تصمیم الزامی است.',
  review_not_complete_or_no_defect: 'ابتدا نقص این مرحله را ثبت کنید.',
  documents_incomplete: 'همهٔ مدارک این مرحله هنوز بررسی یا تأیید نشده‌اند.',
  documents_missing: 'مدارک لازم این مرحله بارگذاری نشده‌اند.',
  collateral_incomplete: 'وثایق این مرحله هنوز کامل یا تأیید نشده‌اند.',
  guarantor_required: 'برای این پرونده ثبت ضامن الزامی است.',
  primary_contract_not_signed: 'قرارداد اصلی هنوز امضا نشده است.',
  primary_contract_not_approved: 'قرارداد اصلی هنوز تأیید نشده است.',
  primary_contract_not_current: 'قرارداد اصلی ثبت‌شده، قرارداد فعلی این پرونده نیست.',
  current_primary_contract_required: 'برای این پرونده قرارداد اصلی فعلی ثبت نشده است.',
  rendered_primary_principal_unverifiable: 'مبلغ اصل تسهیلات در متن قرارداد اصلی قابل تأیید نیست.',
  requested_primary_generation_required: 'قرارداد اصلی با مبلغ درخواستی این پرونده صادر نشده است.',
  requested_primary_terms_not_verified: 'قرارداد اصلی با مبلغ درخواستی این پرونده مطابقت ندارد.',
  requested_primary_or_documents_not_verified: 'قرارداد اولیه یا مدارک هنوز تأیید نشده‌اند.',
  approved_primary_generation_required: 'قرارداد با مبلغ مصوب برای این پرونده صادر نشده است.',
  approved_primary_generation_evidence_missing: 'سند قرارداد با مبلغ مصوب برای این پرونده پیدا نشد.',
  loan_amount_approval_required: 'ابتدا مبلغ وام باید تصویب شود.',
  final_documents_not_signed: 'اسناد پایانی (فاکتور و رسید) هنوز امضا نشده‌اند.',
  funder_not_approved: 'تأمین‌کنندهٔ مالی هنوز این پرونده را تأیید نکرده است.',
  financial_posting_history_unverified: 'این پرونده سابقهٔ تأیید مالی دارد، اما ثبت پرداخت آن قابل تأیید نیست. برای جلوگیری از پرداخت تکراری، ابتدا سابقهٔ مالی را بررسی کنید.',
  insufficient_cash_balance: 'موجودی نقدی برای این پرداخت کافی نیست.',
  physical_documents_incomplete: 'ابتدا نقص‌های شناخته‌شده مدارک فیزیکی را برطرف کنید.',
  physical_corrections_pending: 'اصلاح نقص‌های مدارک فیزیکی هنوز کامل نشده است.',
};

export function loanDecisionErrorCode(error: unknown): string | undefined {
  const failure = error as { data?: { error?: unknown; code?: unknown } | null; response?: { data?: { error?: unknown; code?: unknown } } } | null;
  const code = failure?.data?.code ?? failure?.data?.error ?? failure?.response?.data?.code ?? failure?.response?.data?.error;
  return typeof code === 'string' && code ? code : undefined;
}

/** Real Persian reason for a refused step; unknown codes still show the code. */
export function loanDecisionErrorMessage(error: unknown, fallback: string): string {
  const failure = error as { data?: { message?: unknown } | null; response?: { data?: { message?: unknown } } } | null;
  // The server sends the specific Persian reason (e.g. which contract check failed).
  const serverMessage = failure?.data?.message ?? failure?.response?.data?.message;
  if (typeof serverMessage === 'string' && /[\u0600-\u06FF]/.test(serverMessage) && serverMessage.length <= 400) return serverMessage;
  const code = loanDecisionErrorCode(error);
  if (code && LOAN_DECISION_ERROR_MESSAGES[code]) return LOAN_DECISION_ERROR_MESSAGES[code];
  const status = (error as { status?: unknown } | null)?.status;
  if (!code && (status === undefined || status === 0)) return 'ارتباط با سرور برقرار نشد. اتصال را بررسی کنید و دوباره تلاش کنید.';
  if (code && /^[a-z][a-z0-9_]{1,80}$/.test(code) && code !== 'workflow_error') return `${fallback} (کد خطا: ${code})`;
  return fallback;
}

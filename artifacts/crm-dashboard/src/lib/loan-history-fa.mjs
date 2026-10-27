// Display-only localization: never rewrite the original audit trail.
const actions = {
  created: 'ایجاد پرونده',
  'submit-primary-contract': 'ارسال قرارداد برای امضای مشتری',
  'confirm-signed-primary': 'تأیید امضای قرارداد مشتری',
  primary_signature_verified: 'تأیید امضای قرارداد مشتری',
  existing_signed_primary_confirmed: 'تأیید قرارداد امضاشده موجود',
  'approved-primary-signature-verified': 'تأیید امضای قرارداد با شرایط مصوب',
  amendment_signature_verified: 'تأیید امضای الحاقیه قرارداد',
  amendment_contract_approved: 'تأیید الحاقیه قرارداد',
  amendment_contract_rejected: 'رد الحاقیه قرارداد',
  'funder-initial-approve': 'تصویب مبلغ و مدت وام',
  'funder-initial-reject': 'رد اولیه درخواست پیش از صدور قرارداد',
  'expert-approve': 'تأیید نهایی تأمین‌کننده مالی',
  'expert-reject': 'رد نهایی تأمین‌کننده مالی',
  'admin-approve': 'تأیید نهایی مدیر و شارژ اعتبار',
  'admin-reject': 'رد پرونده توسط مدیر',
  'confirm-funder': 'تأیید نتیجه تأمین‌کننده مالی',
  'approve-physical-documents': 'تأیید مدارک فیزیکی',
  'approve-wallet-charge': 'تأیید شارژ اعتبار کیف پول',
  'submit-final-invoice': 'ارسال صورت‌حساب نهایی برای امضا',
  'confirm-signed-final-invoice': 'تأیید امضای صورت‌حساب نهایی',
  'final-invoice-signature-verified': 'تأیید امضای صورت‌حساب نهایی',
  complete: 'تکمیل پرونده',
  'cancel-case': 'لغو پرونده با ثبت دلیل',
  'submit-customer-documents': 'ارسال مدارک مشتری به کارشناس ثبت',
  'review-customer-documents': 'تأیید مدارک مشتری و ارسال به مرحله بعد',
  'start-guarantor-documents': 'ارسال ضامن به کارشناس ثبت',
  'submit-guarantor-documents': 'ارسال دوباره مدارک ضامن به کارشناس ثبت',
  'review-guarantor-documents': 'تأیید مدارک ضامن و ارسال به مرحله بعد',
  'submit-collateral': 'ارسال وثیقه به کارشناس ثبت',
  'review-collateral': 'تأیید وثیقه و ارسال به مرحله بعد',
  'return-customer-documents': 'بازگشت مدارک مشتری به فروش برای رفع نقص',
  'return-guarantor-documents': 'بازگشت مدارک ضامن به فروش برای رفع نقص',
  'return-collateral': 'بازگشت وثیقه به فروش برای رفع نقص',
  'return-funder-documents': 'بازگشت مدارک مردود تأمین‌کننده برای اصلاح',
  'submit-funder-corrections': 'ارسال مدارک اصلاح‌شده به تأمین‌کننده',
  'submit-physical-documents': 'ارسال مدارک فیزیکی برای بررسی',
  'return-physical-documents': 'بازگشت مدارک فیزیکی برای رفع نقص',
  'physical-documents-none-declared': 'ثبت نبود مدارک فیزیکی برای ارسال',
  'physical-review-auto-approved-no-documents': 'عبور خودکار از بررسی فیزیکی به دلیل نبود مدارک',
  'legacy-applications-reopened-for-initial-provider-approval': 'بازگشایی پرونده قدیمی برای تصویب اولیه مبلغ وام',
  'resequence-pending-legacy-approval': 'اصلاح ترتیب مراحل پرونده قدیمی در انتظار تصویب',
  'legacy-signed-primary-terms-reconciled': 'تطبیق شرایط مالی پرونده با قرارداد امضاشده قدیمی',
  application_edited_before_provider_approval: 'ویرایش درخواست پیش از تصویب تأمین‌کننده',
  'guarantor-registered': 'ثبت ضامن',
  'case-note-added': 'ثبت یادداشت پرونده',
  'guarantor-review-reopened-for-upload': 'بازگشت برای تکمیل اطلاعات و مدارک ضامن',
  'authorize-toman-replacement': 'ثبت اجازه جایگزینی قرارداد قدیمی ریالی با قرارداد تومانی',
  'toman-replacement-signature-verified': 'تأیید امضای قرارداد جایگزین تومانی',
  authorized_test_case_archived: 'بایگانی پرونده آزمایشی با مجوز',
  identity_document_approved: 'تأیید مدرک هویتی',
  identity_document_rejected: 'رد مدرک هویتی',
  identity_document_incomplete: 'ثبت نقص مدرک هویتی',
  customer_document_approved: 'تأیید مدرک تسهیلات',
  customer_document_incomplete: 'ثبت نقص مدرک تسهیلات',
  customer_document_rejected: 'رد مدرک تسهیلات',
  guarantor_document_approved: 'تأیید مدرک ضامن',
  guarantor_document_incomplete: 'ثبت نقص مدرک ضامن',
  guarantor_document_rejected: 'رد مدرک ضامن',
  collateral_approved: 'تأیید وثیقه',
  collateral_incomplete: 'ثبت نقص وثیقه',
  collateral_rejected: 'رد وثیقه',
  primary_contract_approved: 'تأیید قرارداد',
  primary_contract_incomplete: 'ثبت نقص قرارداد',
  primary_contract_rejected: 'رد قرارداد',
  customer_document_uploaded: 'بارگذاری مدرک تسهیلات',
  guarantor_document_uploaded: 'بارگذاری مدرک ضامن',
  identity_document_uploaded: 'جایگزینی مدرک هویتی',
  collateral_uploaded: 'بارگذاری وثیقه',
  generated_document_linked: 'پیوست سند تولیدشده به پرونده',
  physical_document_uploaded: 'بارگذاری مدرک فیزیکی',
  physical_document_removed: 'حذف مدرک فیزیکی',
  physical_approved: 'تأیید مدرک فیزیکی',
  physical_incomplete: 'ثبت نقص مدرک فیزیکی',
  physical_rejected: 'رد مدرک فیزیکی',
  physical_general_incomplete: 'ثبت نقص کلی مدارک فیزیکی',
  physical_corrected: 'ثبت اصلاح مدرک فیزیکی',
  'admin-stage-corrected': 'اصلاح دستی مرحله توسط مدیر',
  'admin-case-edited': 'ویرایش اطلاعات پرونده توسط مدیر',
};

const values = {
  draft: 'پیش‌نویس', reviewing: 'در حال بررسی', pending: 'در انتظار بررسی',
  approved: 'تأییدشده', rejected: 'ردشده', incomplete: 'دارای نقص',
  signed: 'امضاشده', sent: 'ارسال‌شده', generated: 'تولیدشده',
  completed: 'تکمیل‌شده', cancelled: 'لغوشده',
  admin: 'مدیر', salesperson: 'کارشناس فروش', expert: 'کارشناس ثبت',
  funder: 'تأمین‌کننده مالی', customer: 'مشتری', system: 'سامانه',
  project_owner_authorized_maintenance: 'نگهداری سامانه با مجوز مالک پروژه',
  draft_stage: 'پیش‌نویس', primary: 'قرارداد اصلی', amendment: 'الحاقیه',
  invoice: 'صورت‌حساب', acknowledgement: 'اقرارنامه',
  national_card: 'کارت ملی', national_card_front: 'روی کارت ملی',
  national_card_back: 'پشت کارت ملی', birth_certificate: 'شناسنامه',
  cheque: 'چک', promissory_note: 'سفته', guarantee: 'ضمانت',
  funder_initial_approval: 'تصویب مبلغ وام',
  primary_contract_pending_signature: 'در انتظار امضای قرارداد مشتری',
  approved_contract_pending_signature: 'در انتظار امضای قرارداد جایگزین',
  customer_documents_upload: 'بارگذاری مدارک مشتری',
  customer_documents_review: 'بررسی مدارک مشتری',
  guarantor_registration: 'ثبت ضامن',
  guarantor_documents_upload: 'بارگذاری مدارک ضامن',
  guarantor_documents_review: 'بررسی مدارک ضامن',
  collateral_upload: 'بارگذاری وثیقه', collateral_review: 'بررسی وثیقه',
  physical_documents_submission: 'ارسال مدارک فیزیکی',
  physical_documents_review: 'بررسی مدارک فیزیکی',
  physical_documents_correction: 'رفع نقص مدارک فیزیکی',
  expert_approval: 'تصمیم تأمین‌کننده مالی',
  funder_documents_correction: 'اصلاح مدارک مردود تأمین‌کننده',
  funder_result_review: 'بررسی نتیجه تأمین‌کننده',
  funder_amendment_pending_signature: 'در انتظار امضای الحاقیه',
  funder_amendment_review: 'بررسی الحاقیه قرارداد',
  admin_approval: 'تأیید نهایی مدیر',
  wallet_charge_pending: 'در انتظار تأیید شارژ اعتبار',
  final_invoice_pending_signature: 'در انتظار امضای صورت‌حساب نهایی',
};

const fields = {
  reason: 'دلیل', note: 'یادداشت', description: 'توضیحات',
  approvedAmount: 'مبلغ مصوب', requestedAmount: 'مبلغ درخواستی',
  netAmount: 'مبلغ خالص', removedTestCreditToman: 'اعتبار آزمایشی حذف‌شده',
  durationMonths: 'مدت', requestedDurationMonths: 'مدت درخواستی',
  approvedDurationMonths: 'مدت مصوب',
  actorRole: 'نقش ثبت‌کننده', priorStage: 'مرحله قبلی',
  resumeStage: 'مرحله ادامه پرونده', resumedStage: 'مرحله ادامه پرونده',
  priorStatus: 'وضعیت قبلی', priorUpdatedAt: 'آخرین تغییر قبلی',
  priorFinancialDecision: 'تصمیم مالی قبلی',
  generationId: 'شناسه نسخه قرارداد', priorPrimaryGenerationId: 'شناسه قرارداد اصلی قبلی',
  sourceGenerationId: 'شناسه قرارداد قبلی', replacementGenerationId: 'شناسه قرارداد جایگزین',
  reusedPrimaryGenerationId: 'شناسه قرارداد استفاده‌شده مجدد',
  retainedPrimaryGenerationId: 'شناسه قرارداد حفظ‌شده',
  supersededPrimaryGenerationId: 'شناسه قرارداد کنارگذاشته‌شده',
  retainedSignedGenerationId: 'شناسه قرارداد امضاشده حفظ‌شده',
  tomanTemplateId: 'شناسه قالب تومانی',
  authorizedByUserId: 'شناسه کاربر تأییدکننده', authorizedAt: 'زمان صدور اجازه',
  completedAt: 'زمان تکمیل', version: 'نسخه اطلاعات',
  documentReferences: 'ارجاعات مدارک', generationReferences: 'ارجاعات قراردادها',
  feesAndWalletsChanged: 'تغییر هزینه‌ها و کیف پول‌ها',
  customerAndPlanRetained: 'حفظ مشتری و طرح وام',
  archivedApplicationId: 'شناسه پرونده بایگانی‌شده',
  deletedTestPurchaseId: 'شناسه خرید آزمایشی حذف‌شده',
  removedTestCreditLedgerId: 'شناسه گردش اعتبار آزمایشی حذف‌شده',
  provenance: 'منشأ ثبت', operation: 'عملیات سیستمی', source: 'منبع ثبت',
  testPurchaseSnapshot: 'اطلاعات خرید آزمایشی',
  removedCreditSnapshot: 'اطلاعات اعتبار حذف‌شده',
  removedCreditLotSnapshot: 'اطلاعات تخصیص اعتبار حذف‌شده',
};
const moneyFields = new Set(['approvedAmount', 'requestedAmount', 'netAmount', 'removedTestCreditToman']);
const durationFields = new Set(['durationMonths', 'requestedDurationMonths', 'approvedDurationMonths']);
const faNumber = (value, grouped = false) => {
  const text = String(value);
  const formatted = grouped && /^\d+$/.test(text) ? BigInt(text).toLocaleString('fa-IR') : text;
  return formatted.replace(/[0-9]/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
};

export function historyActionLabel(action) {
  const [key, ...parts] = String(action || '').split(':');
  const label = actions[key] || values[key];
  if (!label) return /[\u0600-\u06ff]/.test(key) ? key : 'رویداد سیستمی بدون عنوان فارسی';
  // IDs are not amounts; keep them ungrouped. Do not expose internal slot names.
  const suffix = parts.flatMap(part => /^\d+$/.test(part)
    ? [`شناسه ${faNumber(part)}`] : values[part] ? [values[part]] : []);
  return `${label}${suffix.length ? ` (${suffix.join('، ')})` : ''}`;
}

function detailValue(key, value) {
  if (value == null) return 'ثبت نشده';
  if (typeof value === 'boolean') return value ? 'بله' : 'خیر';
  if (moneyFields.has(key)) return `${faNumber(value, true)} تومان`;
  if (durationFields.has(key)) return `${faNumber(value)} ماه`;
  if (Array.isArray(value)) return `${faNumber(value.length)} مورد`;
  if (typeof value === 'object') return 'اطلاعات سیستمی ثبت شده است';
  if (values[value]) return values[value];
  if (actions[value]) return actions[value];
  if (/At$/.test(key) && !Number.isNaN(Date.parse(String(value)))) {
    return new Date(value).toLocaleString('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran' });
  }
  if (['reason', 'note', 'description'].includes(key)) return String(value);
  if (/^[a-z][a-z0-9_.:/-]*$/i.test(String(value))) return 'مقدار سیستمی بدون ترجمه فارسی';
  return faNumber(value);
}

const adminFields = {
  stage: 'مرحله', requestedAmount: 'مبلغ درخواستی', durationMonths: 'مدت', planId: 'طرح', planName: 'طرح',
  conditionId: 'شرط طرح', conditionLabel: 'شرط طرح', needsGuarantor: 'نیاز به ضامن', guarantor: 'ضامن',
  manualValues: 'فیلدهای دستی قرارداد', notes: 'یادداشت', fullName: 'نام کامل', nationalCode: 'کد ملی', mobile: 'همراه',
  status: 'وضعیت', approvedAmount: 'مبلغ مصوب',
  netAmount: 'مبلغ خالص', approvedDurationMonths: 'مدت مصوب',
  initialApprovalAt: 'زمان تصویب اولیه', initialApprovalByUserId: 'شناسه تصویب‌کننده',
  initialApprovalReason: 'دلیل تصویب اولیه', currentPrimaryGenerationId: 'شناسه قرارداد جاری',
  approvedAmountSource: 'مبنای مبلغ مصوب', approvedAmountGenerationId: 'شناسه قرارداد مبلغ مصوب',
};
function adminValue(key, value) {
  if (value == null || value === '') return 'ثبت نشده';
  if (key === 'stage') return values[value] || 'مرحله نامشخص';
  if (key === 'requestedAmount' || key === 'approvedAmount' || key === 'netAmount') return `${faNumber(value, true)} تومان`;
  if (key === 'status') return { requested: 'درخواست شده', reviewing: 'در حال بررسی', approved: 'تأیید شده', rejected: 'رد شده' }[value] || 'نامشخص';
  if (key === 'durationMonths' || key === 'approvedDurationMonths') return `${faNumber(value)} ماه`;
  if (key.endsWith('At') && !Number.isNaN(Date.parse(String(value)))) return new Date(value).toLocaleString('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran' });
  if (key === 'approvedAmountSource') return values[value] || 'مبنای ثبت‌شدهٔ سیستمی';
  if (typeof value === 'boolean') return value ? 'بله' : 'خیر';
  if (Array.isArray(value)) return value.map(v => adminValue(key, v)).join('، ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v], i) => `${adminFields[k] || `فیلد دستی ${faNumber(i + 1)}`}: ${adminValue(k, v)}`).join('، ');
  }
  if (key === 'planId' || key === 'conditionId') return `شناسه ${faNumber(value)}`;
  return faNumber(value);
}
function adminSide(obj) {
  if (!obj || typeof obj !== 'object') return 'ثبت نشده';
  const parts = Object.entries(obj).map(([k, v]) => `${adminFields[k] || 'جزئیات تکمیلی'}: ${adminValue(k, v)}`);
  return parts.length ? parts.join('، ') : 'ثبت نشده';
}
function adminDetails(data) {
  const out = [];
  if (data.reason) out.push(`دلیل: ${String(data.reason)}`);
  if (data.before !== undefined) out.push(`قبل از اصلاح: ${adminSide(data.before)}`);
  if (data.after !== undefined) out.push(`بعد از اصلاح: ${adminSide(data.after)}`);
  if (data.requiresNewContract != null) out.push(`نیاز به قرارداد جدید: ${data.requiresNewContract ? 'بله' : 'خیر'}`);
  return out.join('؛ ');
}

export function historyDetailsFa(raw) {
  if (raw == null || raw === '') return '';
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return String(raw); }
  // Human-entered notes are retained verbatim, including punctuation and numbers.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return String(raw);
  if ('before' in data || 'after' in data) return adminDetails(data);
  return Object.entries(data)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${fields[key] || 'جزئیات سیستمی تکمیلی'}: ${detailValue(key, value)}`)
    .join('؛ ');
}

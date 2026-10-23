import assert from 'node:assert/strict';
import { historyActionLabel, historyDetailsFa } from '../src/lib/loan-history-fa.mjs';

const liveActions = [
  'created', 'generated_document_linked:primary:109', 'submit-primary-contract',
  'primary_signature_verified', 'approved-primary-signature-verified',
  'legacy-applications-reopened-for-initial-provider-approval',
  'funder-initial-approve', 'application_edited_before_provider_approval',
  'resequence-pending-legacy-approval', 'guarantor-registered',
  'physical-documents-none-declared', 'physical-review-auto-approved-no-documents',
  'authorized_test_case_archived', 'physical_document_uploaded:1234',
  'physical_document_removed:1234', 'submit-physical-documents', 'physical_approved:1',
  'physical_general_incomplete', 'return-physical-documents', 'cancel-case',
  'confirm-funder', 'approve-physical-documents', 'approve-wallet-charge', 'admin-approve',
  'identity_document_uploaded:national_card_front:1234', 'collateral_uploaded:slot_1:1234',
  'amendment_signature_verified', 'authorize-toman-replacement', 'toman-replacement-signature-verified',
];
for (const action of liveActions) {
  const label = historyActionLabel(action);
  assert.match(label, /[\u0600-\u06ff]/);
  assert.doesNotMatch(label, /[a-zA-Z]/);
  assert.doesNotMatch(label, /بدون عنوان/);
}
assert.equal(historyActionLabel('physical_document_uploaded:1234'), 'بارگذاری مدرک فیزیکی (شناسه ۱۲۳۴)');
assert.equal(historyActionLabel('new_system_event'), 'رویداد سیستمی بدون عنوان فارسی');
assert.equal(historyActionLabel('تأیید پرونده'), 'تأیید پرونده');
const details = historyDetailsFa(JSON.stringify({
  approvedAmount: '142000000', requestedDurationMonths: 24, approvedDurationMonths: 24,
  netAmount: '140000000', retainedPrimaryGenerationId: 109, reason: 'شرایط بدون تغییر تأیید شد',
}));
assert.match(details, /مبلغ مصوب: ۱۴۲٬۰۰۰٬۰۰۰ تومان/);
assert.match(details, /مدت مصوب: ۲۴ ماه/);
assert.match(details, /شناسه قرارداد حفظ‌شده: ۱۰۹/);
assert.doesNotMatch(details, /[a-zA-Z{}"]/);
assert.equal(historyDetailsFa('دلیل نقص: صفحه 2 ناخوانا است'), 'دلیل نقص: صفحه 2 ناخوانا است');
assert.equal(historyDetailsFa('{متن ناقص'), '{متن ناقص');
assert.equal(historyDetailsFa(null), '');
assert.equal(historyDetailsFa('{"priorStage":"expert_approval","priorStatus":"reviewing","feesAndWalletsChanged":false}'),
  'مرحله قبلی: تصمیم تأمین‌کننده مالی؛ وضعیت قبلی: در حال بررسی؛ تغییر هزینه‌ها و کیف پول‌ها: خیر');
assert.match(historyDetailsFa('{"newKey":"new_system_value"}'), /بدون ترجمه فارسی/);
assert.equal(historyDetailsFa('{"provenance":"project_owner_authorized_maintenance"}'),
  'منشأ ثبت: نگهداری سامانه با مجوز مالک پروژه');
assert.doesNotMatch(historyDetailsFa('{"newKey":{"internalId":1},"documentReferences":[1,2]}'), /[a-zA-Z{}"]/);
console.log('PASS: Persian history titles, financial details, identifiers and unchanged human notes.');

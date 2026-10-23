import assert from 'node:assert/strict';
import { consultationLabel } from '../src/lib/consultation-labels.ts';

assert.equal(consultationLabel('loan_type', 'goods'), 'خرید کالا');
assert.equal(consultationLabel('grant_days', '10_to_15'), '۱۰ تا ۱۵ روز');
assert.equal(consultationLabel('required_document', 'national_card'), 'کارت ملی پشت و رو');
assert.equal(consultationLabel('required_document', 'birth_certificate_all_pages'), 'تمام صفحات شناسنامه');
assert.equal(consultationLabel('required_document', 'guarantee_check'), 'چک ضمانت');
assert.equal(consultationLabel('required_document', 'custom_document', [
  { fieldKey: 'required_document', value: 'custom_document', labelFa: 'مدرک اختصاصی' },
]), 'مدرک اختصاصی');
assert.equal(consultationLabel('loan_type', 'goods', [
  { fieldKey: 'loan_type', value: 'goods', labelFa: 'تسهیلات خرید کالا' },
]), 'تسهیلات خرید کالا');
assert.equal(consultationLabel('required_document', 'مدرک فارسی قدیمی'), 'مدرک فارسی قدیمی');
assert.equal(consultationLabel('required_document', 'unknown_machine_code'), 'عنوان فارسی تعریف نشده است');
assert.equal(consultationLabel('grant_days', null), 'ثبت نشده');
console.log('Consultation Persian labels passed: loan type, day range, documents, dictionary overrides and explicit unknown-label handling.');

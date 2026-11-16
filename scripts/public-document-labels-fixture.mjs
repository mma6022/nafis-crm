import assert from 'node:assert/strict';
import { publicDocumentLabel } from '../src/lib/public-document-labels.ts';

assert.equal(publicDocumentLabel('employment_proof', 'مدرک شغلی'), 'مدرک شغلی');
assert.equal(publicDocumentLabel('custom_document', '  گواهی حرفه‌ای  '), 'گواهی حرفه‌ای');
assert.equal(publicDocumentLabel('national_card_front'), 'روی کارت ملی');
assert.equal(publicDocumentLabel('national_card_front', 'تصویر معتبر کارت ملی'), 'تصویر معتبر کارت ملی');
assert.equal(publicDocumentLabel('birth_certificate_last_page'), 'صفحه آخر شناسنامه');
assert.equal(publicDocumentLabel('مدرک درآمد'), 'مدرک درآمد');
assert.equal(publicDocumentLabel('unknown_code'), 'نام فارسی مدرک ثبت نشده است');
assert.equal(publicDocumentLabel('unknown_code', 'English label'), 'نام فارسی مدرک ثبت نشده است');
console.log('PASS Persian configured, legacy identity, custom and explicit missing document labels; stored keys unchanged.');

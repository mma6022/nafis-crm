import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faqLd } from '../src/lib/seo.ts';
import { splitMarkers, stripMarkers } from '../src/lib/markers.ts';

test('faqLd has the FAQPage shape and strips markers', () => {
  const ld = faqLd([{ q: 'سؤال اول؟', a: 'پاسخ اول. [تأیید محمد: فهرست مدارک]' }], '/blog/x');
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'FAQPage');
  assert.equal(ld.url, 'https://nafisvam.com/blog/x');
  assert.deepEqual(ld.mainEntity, [
    { '@type': 'Question', name: 'سؤال اول؟', acceptedAnswer: { '@type': 'Answer', text: 'پاسخ اول.' } },
  ]);
});

test('splitMarkers keeps markers as separate parts', () => {
  assert.deepEqual(splitMarkers('الف [جای‌خالی] ب'), [
    { text: 'الف ', marker: false },
    { text: '[جای‌خالی]', marker: true },
    { text: ' ب', marker: false },
  ]);
  assert.equal(stripMarkers('متن [تأیید محمد]'), 'متن');
});

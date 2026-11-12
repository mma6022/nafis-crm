import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faqLd } from '../src/lib/seo.ts';
import { splitMarkers, stripMarkers } from '../src/lib/markers.ts';

test('faqLd has the FAQPage shape and strips markers', () => {
  const ld = faqLd([{ q: 'سؤال اول؟', a: 'پاسخ اول. [تأیید محمد: فهرست مدارک]' }], '/blog/x');
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'FAQPage');
  assert.equal(ld.url, 'https://nafisvam.com/blog/x/');
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

test('absoluteUrl: pages end with / (the form nginx serves), files keep their name', async () => {
  const { absoluteUrl } = await import('../src/lib/site.ts');
  assert.equal(absoluteUrl('/'), 'https://nafisvam.com/');
  assert.equal(absoluteUrl('/contact'), 'https://nafisvam.com/contact/');
  assert.equal(absoluteUrl('/blog/x/'), 'https://nafisvam.com/blog/x/');
  assert.equal(absoluteUrl('/og-image.png'), 'https://nafisvam.com/og-image.png');
  assert.equal(absoluteUrl('/rss.xml'), 'https://nafisvam.com/rss.xml');
});

test('organization JSON-LD has the company landline and Bale sameAs', async () => {
  const { organizationLd } = await import('../src/lib/seo.ts');
  const { CONTACT, SITE } = await import('../src/lib/site.ts');
  const ld = organizationLd();
  assert.deepEqual(ld.sameAs, [SITE.instagram, CONTACT.baleUrl]);
  assert.equal(ld.contactPoint[0].telephone, CONTACT.phoneE164);
});

test('CONTACT constants are the approved company values only', async () => {
  const { CONTACT, contactTelHref } = await import('../src/lib/site.ts');
  assert.equal(CONTACT.phoneTel, '02191303819');
  assert.equal(CONTACT.phoneE164, '+982191303819');
  assert.equal(CONTACT.phoneDisplay, '۰۲۱-۹۱۳۰۳۸۱۹');
  assert.equal(CONTACT.baleUrl, 'https://ble.ir/nafisvambot');
  assert.equal(CONTACT.baleHandle, 'nafisvambot');
  assert.deepEqual(CONTACT.extensions.map((e) => e.ext), ['210', '211', '212']);
  assert.equal(contactTelHref(), 'tel:02191303819');
  assert.equal(contactTelHref('210'), 'tel:02191303819,210');
});

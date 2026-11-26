import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/pages/links.astro'), 'utf8');

/** v1.0 allowlist restored for /links (Mohammad t970s3577). Contact and footer stay on t806u. */
function extractSafeUrl(): (u: unknown) => string | null {
  const m = src.match(/var safeUrl = function \(u\) \{[\s\S]*?\n  \};|\s*var safeUrl = function \(u\) \{ return[^;]+; \};/);
  assert.ok(m, 'safeUrl function missing from links.astro');
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; ${m[0]}; return safeUrl;`)() as (u: unknown) => string | null;
}

// Live CRM public payload order as of 2026-11-26 (GET /api/public/link-page). Phone in the WhatsApp URL is a published business number.
const LIVE_LINKS = [
  { title: 'درخواست وام آنلاین', url: 'https://nafisvam.com/request/?src=links' },
  { title: 'کانال بله', url: 'https://ble.ir/nafisvam' },
  { title: 'صفحه‌ی اصلی', url: 'https://nafisvam.com/' },
  { title: 'واتساپ', url: 'https://wa.me/989003400472' },
  { title: 'اینستاگرام', url: 'https://instagram.com/nafisvamm' },
  { title: 'ایمیل', url: 'mailto:info@nafisvam.com' },
  { title: 'بله', url: 'https://ble.ir/kazemi_nafisvam_bot' },
];

test('links.astro uses the v1.0 safeUrl (https/tel/sms/mailto) and not the t806u messengers guard', () => {
  assert.match(src, /var safeUrl = function \(u\) \{ return \/\^\(https:\\\/\\\/\|tel:\|sms:\|mailto:\)\/i\.test\(String\(u\)\) \? String\(u\) : null; \};/);
  assert.doesNotMatch(src, /wa\\\.me\|api\\\.whatsapp/);
  assert.doesNotMatch(src, /ble\\\.ir\/nafisvambot/);
  assert.doesNotMatch(src, /tel:02191303819\(\?:,21\[0-2\]\)/);
});

test('all 7 current public link-page URLs pass safeUrl, in admin order', () => {
  const safeUrl = extractSafeUrl();
  assert.equal(LIVE_LINKS.length, 7);
  for (const l of LIVE_LINKS) {
    assert.equal(safeUrl(l.url), l.url, l.title);
  }
});

test('safeUrl still blocks javascript:, data: and other schemes', () => {
  const safeUrl = extractSafeUrl();
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('file:///etc/passwd'), null);
  assert.equal(safeUrl('vbscript:x'), null);
  assert.equal(safeUrl('http://nafisvam.com/'), null); // http is not https
  assert.equal(safeUrl('tel:02191303819'), 'tel:02191303819');
  assert.equal(safeUrl('sms:02191303819'), 'sms:02191303819');
});

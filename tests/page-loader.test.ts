import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loaderForSubmit, loaderUrlForLink } from '../src/scripts/page-loader.ts';
import { LOADER_MARK_CSS, LOADER_MARK_SVG } from '../src/scripts/loader-mark.ts';

const HERE = 'https://nafisvam.com/';
const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
const go = (href: string, extra: Partial<typeof click> = {}, a: { target?: string; download?: boolean; noLoader?: boolean } = {}, here = HERE) =>
  loaderUrlForLink({ href, ...a }, { ...click, ...extra }, here)?.href ?? null;

test('same-origin page links show the loader', () => {
  assert.equal(go('/plans/'), 'https://nafisvam.com/plans/');
  assert.equal(go('https://nafisvam.com/contact/#experts'), 'https://nafisvam.com/contact/#experts');
  assert.equal(go('/request/?src=home-header'), 'https://nafisvam.com/request/?src=home-header');
  assert.equal(go('/', {}, { target: '_self' }), 'https://nafisvam.com/');
});

test('tel:, external, downloads, files, new tabs, modifiers and same-page hashes do not', () => {
  for (const h of ['tel:02191303819', 'mailto:a@b.c', 'sms:0912', 'javascript:void(0)']) assert.equal(go(h), null, h);
  for (const h of ['https://emzami.ir/sign/x', 'https://wa.me/989121234567', 'https://t.me/+98912', 'https://ble.ir/98912', 'https://crm.nafisvam.com/portal'])
    assert.equal(go(h), null, h);
  assert.equal(go('/og-image.png'), null);
  assert.equal(go('/rss.xml'), null);
  assert.equal(go('/x/', {}, { download: true }), null);
  assert.equal(go('/x/', {}, { target: '_blank' }), null);
  assert.equal(go('/x/', {}, { noLoader: true }), null);
  for (const m of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) assert.equal(go('/x/', { [m]: true }), null, m);
  assert.equal(go('/x/', { button: 1 }), null);
  assert.equal(go('/x/', { defaultPrevented: true }), null);
  assert.equal(go('#callback'), null);
  assert.equal(go('#'), null);
  assert.equal(go('/contact/#experts', {}, {}, 'https://nafisvam.com/contact/'), null);
});

test('native form submits: same-origin GET/POST yes; dialog, new tab, other origin, JS-handled no', () => {
  const f = { method: 'get', target: '', action: '/plans/', defaultPrevented: false };
  assert.equal(loaderForSubmit(f, HERE), true);
  assert.equal(loaderForSubmit({ ...f, method: 'post', action: '' }, HERE), true);
  assert.equal(loaderForSubmit({ ...f, method: 'dialog' }, HERE), false);
  assert.equal(loaderForSubmit({ ...f, target: '_blank' }, HERE), false);
  assert.equal(loaderForSubmit({ ...f, action: 'https://crm.nafisvam.com/api/public/leads' }, HERE), false);
  assert.equal(loaderForSubmit({ ...f, defaultPrevented: true }, HERE), false);
});

test('loader mark: final colours, reduced-motion rule, small', () => {
  assert.match(LOADER_MARK_SVG, /fill="#29369B"/);
  assert.match(LOADER_MARK_SVG, /fill="#00006D"/);
  assert.match(LOADER_MARK_SVG, /class="nfpl-mark"/);
  assert.match(LOADER_MARK_CSS, /prefers-reduced-motion:\s*reduce/);
  assert.ok(LOADER_MARK_SVG.length < 9000, `inline logo ${LOADER_MARK_SVG.length} B`);
});

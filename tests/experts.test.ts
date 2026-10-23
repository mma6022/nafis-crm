import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPERTS, MESSENGERS, PREFILL, expertLink, hasChannel, pickerTrigger, type Expert } from '../src/data/experts.ts';

const q = `?text=${encodeURIComponent(PREFILL)}`;

test('experts: fixed order and exact names', () => {
  assert.deepEqual(EXPERTS.map((e) => e.name), ['خانم قاسمی', 'خانم حسنی', 'آقای کاظمی']);
});

test('expertLink: phone-number formats + prefill on WhatsApp/Telegram only', () => {
  const e = EXPERTS[0];
  assert.equal(expertLink(e, 'call'), 'tel:+989003400452');
  assert.equal(expertLink(e, 'whatsapp'), `https://wa.me/989003400452${q}`);
  assert.equal(expertLink(e, 'telegram'), `https://t.me/+989003400452${q}`);
  assert.equal(expertLink(e, 'bale'), 'https://ble.ir/989003400452');
});

test('expertLink: usernames, missing and invalid values', () => {
  const e: Expert = { id: 'x', name: 'x', phone: null, whatsapp: 'nafis_sales', telegram: 'nafis_sales', bale: 'nafis_sales' };
  assert.equal(expertLink(e, 'call'), null);
  assert.equal(expertLink(e, 'whatsapp'), null); // WhatsApp needs a number
  assert.equal(expertLink(e, 'telegram'), `https://t.me/nafis_sales${q}`);
  assert.equal(expertLink(e, 'bale'), 'https://ble.ir/nafis_sales');
  const bad: Expert = { id: 'y', name: 'y', phone: '02100000000', whatsapp: '?', telegram: '', bale: '@x' };
  for (const ch of ['call', 'whatsapp', 'telegram', 'bale'] as const) assert.equal(expertLink(bad, ch), null);
});

test('hasChannel / MESSENGERS / pickerTrigger', () => {
  assert.ok(hasChannel('call'));
  assert.deepEqual(MESSENGERS, ['whatsapp', 'telegram', 'bale']);
  assert.deepEqual(pickerTrigger('bale'), { href: '/contact/#experts', role: 'button', 'data-experts': 'bale', 'aria-haspopup': 'dialog' });
});

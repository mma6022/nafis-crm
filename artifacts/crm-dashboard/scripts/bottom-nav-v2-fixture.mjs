// bottom-nav-v2: per-role dock items, hide when no access, flag off = old nav.
import assert from 'node:assert/strict';
import { bnv2Slots, bnv2Rest, baleHrefOf, bnv2Kind, todayHrefOf } from '../src/features/bottom-nav-v2/layout.ts';

const EXPERT = [
  '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/messengers', '/internal-chat', '/bale-bot', '/goods-purchases', '/my-wallet', '/my-performance',
];
const ADMIN = [
  '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/messengers', '/internal-chat', '/bale-bot', '/bale-bot/admin', '/goods-purchases',
  '/sales-reports', '/users', '/settings/assistants',
];
const TRAINEE = [
  '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/goods-purchases', '/internal-chat',
];
const NO_PAY_NO_BALE = ['/today', '/customers', '/loan-applications', '/reminders', '/internal-chat', '/messengers'];

let n = 0;
const check = (name, fn) => { n++; fn(); console.log('ok', name); };

check('flag off expert = old dock (customers + messengers, payment-orders not on dock)', () => {
  const s = bnv2Slots({ flagOn: false, role: 'salesperson', visible: EXPERT });
  assert.deepEqual(s.before, ['/today', '/customers', '/loan-applications', '/reminders']);
  assert.deepEqual(s.after, ['/messengers', '/internal-chat']);
  assert.deepEqual(s.tabs, ['/today', '/customers', '/loan-applications']);
  assert.deepEqual(s.daily, ['/reminders', '/messengers', '/internal-chat']);
  assert.equal(s.primary, true);
  assert.equal(s.midSep, false);
  assert.equal(s.baleHref, null);
  assert.equal(s.labels['/customers'].label, 'مشتریان');
  assert.ok(!s.before.includes('/payment-orders'));
  assert.ok(!s.after.includes('/bale-bot'));
  const rest = bnv2Rest(EXPERT, s.used, s.listsFirst);
  assert.ok(rest.includes('/payment-orders'));
  assert.ok(rest.includes('/bale-bot'));
  assert.ok(!rest.includes('/customers'));
  assert.ok(!rest.includes('/messengers'));
});

check('flag on expert: payment-orders and bale-bot swap in; customers leave the dock', () => {
  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible: EXPERT });
  assert.equal(s.kind, 'expert');
  assert.deepEqual(s.before, ['/today', '/payment-orders', '/loan-applications', '/reminders']);
  assert.deepEqual(s.after, ['/bale-bot', '/internal-chat']);
  assert.deepEqual(s.tabs, ['/today', '/payment-orders', '/loan-applications']);
  assert.deepEqual(s.daily, ['/reminders', '/bale-bot', '/internal-chat']);
  assert.deepEqual(s.listsFirst, ['/customers', '/goods-purchases']);
  assert.equal(s.primary, true);
  assert.equal(s.midSep, false);
  assert.equal(s.labels['/payment-orders'].label, 'دستور پرداخت');
  assert.equal(s.labels['/bale-bot'].label, 'ربات بله');
  assert.equal(s.labels['/customers'].label, 'مشتری‌های من');
  const rest = bnv2Rest(EXPERT, s.used, s.listsFirst);
  assert.ok(!rest.includes('/payment-orders'));
  assert.ok(!rest.includes('/bale-bot'));
  assert.ok(!rest.includes('/customers'));
  assert.ok(rest.includes('/messengers')); // §6.4 remaining messenger only under «بیشتر»
});

check('flag on admin: reports, no primary, bale on mobile tabs, no reminders on dock', () => {
  const s = bnv2Slots({ flagOn: true, role: 'admin', visible: ADMIN });
  assert.equal(s.kind, 'admin');
  assert.deepEqual(s.before, ['/today', '/payment-orders', '/loan-applications', '/sales-reports']);
  assert.deepEqual(s.after, ['/bale-bot', '/internal-chat']);
  assert.deepEqual(s.tabs, ['/today', '/payment-orders', '/loan-applications', '/bale-bot']);
  assert.deepEqual(s.daily, ['/internal-chat']);
  assert.equal(s.primary, false);
  assert.equal(s.midSep, true);
  const rest = bnv2Rest(ADMIN, s.used, s.listsFirst);
  assert.ok(rest.includes('/bale-bot/admin')); // settings stay off the dock, admin-only item remains in more
  assert.ok(rest.includes('/messengers'));
  assert.ok(!s.before.includes('/reminders'));
  assert.ok(!s.tabs.includes('/customers'));
});

check('sales_manager keeps the expert dock, not the admin pattern', () => {
  assert.equal(bnv2Kind('sales_manager'), 'expert');
  const s = bnv2Slots({ flagOn: true, role: 'sales_manager', visible: EXPERT.concat('/sales-reports') });
  assert.equal(s.kind, 'expert');
  assert.ok(s.primary);
  assert.deepEqual(s.before, ['/today', '/payment-orders', '/loan-applications', '/reminders']);
  assert.ok(!s.before.includes('/sales-reports'));
});

check('trainee: same two swaps; messengers/bale hidden when not permitted', () => {
  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible: TRAINEE });
  assert.deepEqual(s.before, ['/today', '/payment-orders', '/loan-applications', '/reminders']);
  assert.deepEqual(s.after, ['/internal-chat']);
  assert.equal(s.baleHref, null);
  assert.ok(!s.tabs.includes('/customers'));
  assert.ok(!s.daily.includes('/bale-bot'));
});

check('no payment-orders and no bale access: those items are hidden, never invented', () => {
  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible: NO_PAY_NO_BALE });
  assert.deepEqual(s.before, ['/today', '/loan-applications', '/reminders']);
  assert.ok(!s.before.includes('/payment-orders'));
  assert.ok(!s.after.includes('/bale-bot'));
  assert.equal(s.baleHref, null);
  assert.ok(bnv2Rest(NO_PAY_NO_BALE, s.used, s.listsFirst).includes('/messengers'));
});

check('§6.1 own Bale inbox still shows ربات بله even if /bale-bot was not in the filtered list', () => {
  assert.equal(baleHrefOf(NO_PAY_NO_BALE, false), null);
  assert.equal(baleHrefOf(NO_PAY_NO_BALE, true), '/bale-bot');
  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible: NO_PAY_NO_BALE, hasOwnBaleInbox: true });
  assert.equal(s.baleHref, '/bale-bot');
  assert.ok(s.after.includes('/bale-bot'));
  assert.ok(s.daily.includes('/bale-bot'));
});

check('today falls back to / when daily-plan is off; primary stays off', () => {
  const vis = ['/', '/customers', '/loan-applications', '/reminders', '/payment-orders', '/bale-bot', '/internal-chat'];
  assert.equal(todayHrefOf(vis), '/');
  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible: vis });
  assert.deepEqual(s.before, ['/', '/payment-orders', '/loan-applications', '/reminders']);
  assert.equal(s.primary, false);
  assert.equal(s.midSep, true);
});

check('flag off is unchanged even for admin (old shared dock)', () => {
  const s = bnv2Slots({ flagOn: false, role: 'admin', visible: ADMIN });
  assert.deepEqual(s.before, ['/today', '/customers', '/loan-applications', '/reminders']);
  assert.deepEqual(s.after, ['/messengers', '/internal-chat']);
  assert.equal(s.primary, true);
  assert.equal(s.kind, 'expert');
});

console.log(`bottom-nav-v2 fixture: ${n} checks passed`);

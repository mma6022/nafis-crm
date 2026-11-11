// expert_lockdown: locked dock hides pages outside EL_ALLOWED_PAGES; 403 expert_lockdown is never retried.
import assert from 'node:assert/strict';
import { bnv2Slots, bnv2Rest } from '../src/features/bottom-nav-v2/layout.ts';
import {
  EL_ALLOWED_PAGES,
  EL_LOCKDOWN_HOME,
  filterLockedNavHrefs,
  isExpertLockdownError,
  navHrefAllowedWhenLocked,
  shouldRetryQuery,
} from '../src/features/expert-lockdown/guard.ts';
import { layoutFor } from '../src/components/nav-layout.ts';

const EXPERT = [
  '/', '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/messengers', '/internal-chat', '/bale-bot', '/goods-purchases', '/my-wallet',
  '/my-performance', '/sales-performance', '/sales-reports',
];

let n = 0;
const check = (name, fn) => { n++; fn(); console.log('ok', name); };

check('EL_ALLOWED_PAGES does not include / or customers or reminders', () => {
  assert.ok(EL_ALLOWED_PAGES.includes('/today'));
  assert.ok(EL_ALLOWED_PAGES.includes('/loan-applications'));
  assert.ok(EL_ALLOWED_PAGES.includes('/payment-orders'));
  assert.ok(EL_ALLOWED_PAGES.includes('/sales-performance'));
  assert.ok(!EL_ALLOWED_PAGES.includes('/'));
  assert.ok(!EL_ALLOWED_PAGES.includes('/customers'));
  assert.ok(!EL_ALLOWED_PAGES.includes('/reminders'));
  assert.ok(!EL_ALLOWED_PAGES.includes('/sales-reports'));
});

check('unlocked nav is unchanged', () => {
  assert.deepEqual(filterLockedNavHrefs(EXPERT, false), EXPERT);
});

check('locked dock and بیشتر hide any tab not in EL_ALLOWED_PAGES, including نمای کلی', () => {
  const visible = filterLockedNavHrefs(EXPERT, true);
  assert.ok(!visible.includes('/'));
  assert.ok(!visible.includes('/customers'));
  assert.ok(!visible.includes('/reminders'));
  assert.ok(!visible.includes('/sales-reports'));
  assert.ok(!visible.includes('/my-wallet'));
  assert.ok(visible.includes('/today'));
  assert.ok(visible.includes('/loan-applications'));
  assert.ok(visible.includes('/payment-orders'));
  assert.ok(visible.includes('/goods-purchases'));
  assert.ok(visible.includes('/messengers'));
  assert.ok(visible.includes('/internal-chat'));
  assert.ok(visible.includes('/bale-bot'));
  assert.ok(visible.includes('/sales-performance'));

  const s = bnv2Slots({ flagOn: true, role: 'salesperson', visible });
  assert.ok(!s.before.includes('/'));
  assert.ok(!s.before.includes('/customers'));
  assert.ok(!s.before.includes('/reminders'));
  assert.ok(!s.after.includes('/'));
  assert.ok(s.before.includes('/today'));
  assert.ok(s.before.includes('/payment-orders'));
  assert.ok(s.before.includes('/loan-applications'));
  const rest = bnv2Rest(visible, s.used, s.listsFirst);
  assert.ok(!rest.includes('/'));
  assert.ok(!rest.includes('/customers'));
  assert.ok(!rest.includes('/reminders'));
  assert.ok(!rest.includes('/sales-reports'));
  // listsFirst is computed from the already-filtered visible list
  assert.ok(!s.listsFirst.includes('/customers'));
  assert.ok(s.listsFirst.includes('/goods-purchases') || rest.includes('/goods-purchases') || s.before.includes('/goods-purchases'));
});

check('legacy sidebar expertLocked layout also has no / and nothing under بیشتر from forbidden pages', () => {
  const visible = filterLockedNavHrefs(EXPERT, true).map((href) => ({ href, label: href }));
  const laid = layoutFor('expertLocked', visible);
  const mainHrefs = laid.main.filter((m) => m.kind === 'link').map((m) => m.item.href);
  const moreHrefs = laid.more.flatMap((g) => g.items.map((i) => i.href));
  assert.ok(!mainHrefs.includes('/'));
  assert.ok(!moreHrefs.includes('/'));
  assert.ok(!mainHrefs.includes('/customers'));
  assert.ok(!moreHrefs.includes('/customers'));
  assert.ok(!mainHrefs.includes('/reminders'));
  assert.ok(!moreHrefs.includes('/reminders'));
  assert.ok(mainHrefs.includes('/today'));
});

check('trainee layout is not used as the locked filter (exclusion unchanged)', () => {
  const traineeVisible = ['/', '/customers', '/loan-applications', '/payment-orders', '/goods-purchases', '/reminders', '/internal-chat']
    .map((href) => ({ href, label: href }));
  const laid = layoutFor('trainee', traineeVisible);
  const mainHrefs = laid.main.filter((m) => m.kind === 'link').map((m) => m.item.href);
  // Trainee menu still includes / and reminders — we did not change the trainee exclusion or layout.
  assert.ok(mainHrefs.includes('/'));
  assert.ok(mainHrefs.includes('/reminders'));
  assert.ok(mainHrefs.includes('/customers'));
});

check('navHrefAllowedWhenLocked', () => {
  assert.equal(navHrefAllowedWhenLocked('/today'), true);
  assert.equal(navHrefAllowedWhenLocked('/today?x=1'), true);
  assert.equal(navHrefAllowedWhenLocked('/'), false);
  assert.equal(navHrefAllowedWhenLocked('/customers'), false);
  assert.equal(navHrefAllowedWhenLocked('/reminders'), false);
});

check('403 expert_lockdown is never retried; other errors still retry; customer 403 is not this code', () => {
  const lockdown = { status: 403, code: 'expert_lockdown' };
  const lockdownBody = { status: 403, body: { error: 'expert_lockdown' } };
  const customer = { status: 403, code: 'expert_lockdown_customer' };
  const server = { status: 500, code: 'boom' };
  const net = { status: 0 };
  assert.equal(isExpertLockdownError(lockdown), true);
  assert.equal(isExpertLockdownError(lockdownBody), true);
  assert.equal(isExpertLockdownError(customer), false);
  assert.equal(isExpertLockdownError(server), false);
  assert.equal(isExpertLockdownError(null), false);
  assert.equal(shouldRetryQuery(0, lockdown), false);
  assert.equal(shouldRetryQuery(0, lockdownBody), false);
  assert.equal(shouldRetryQuery(2, lockdown), false);
  assert.equal(shouldRetryQuery(0, customer), true); // not this error; default retry still applies
  assert.equal(shouldRetryQuery(0, server), true);
  assert.equal(shouldRetryQuery(3, server), false);
  assert.equal(shouldRetryQuery(0, net), true);
  assert.equal(EL_LOCKDOWN_HOME, '/today');
});

console.log(`passed ${n}`);

// عملکرد من v1.1 dock: flag off unchanged; flag on replaces the gold pill and adds the dock item.
import assert from 'node:assert/strict';
import { bnv2Slots } from '../src/features/bottom-nav-v2/layout.ts';
import { applyMyWorkDock, myWorkSlots, MY_WORK_HREF } from '../src/features/my-performance-v11/dock.ts';

const EXPERT = [
  '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/messengers', '/internal-chat', '/bale-bot', '/goods-purchases', '/my-wallet', '/my-performance',
];
const EXPERT_ON = [...EXPERT, MY_WORK_HREF];
const ADMIN = [
  '/today', '/customers', '/loan-applications', '/reminders', '/payment-orders',
  '/messengers', '/internal-chat', '/bale-bot', '/bale-bot/admin', '/goods-purchases',
  '/sales-reports', '/users', '/settings/assistants', MY_WORK_HREF,
];

let n = 0;
const check = (name, fn) => { n++; fn(); console.log('ok', name); };

check('flag off leaves bottom-nav-v2 expert dock unchanged, including the primary pill', () => {
  const base = bnv2Slots({ flagOn: true, role: 'salesperson', visible: EXPERT_ON });
  const s = applyMyWorkDock(base, false, EXPERT_ON);
  assert.deepEqual(s.before, base.before);
  assert.deepEqual(s.after, base.after);
  assert.deepEqual(s.tabs, base.tabs);
  assert.equal(s.primary, true);
  assert.ok(!s.before.includes(MY_WORK_HREF));
  assert.ok(!s.tabs.includes(MY_WORK_HREF));
});

check('flag on expert: عملکرد من on desktop after reminders and on mobile between pay and files; no primary', () => {
  const s = myWorkSlots({ flagOn: true, role: 'salesperson', visible: EXPERT_ON, myWork: true });
  assert.equal(s.kind, 'expert');
  assert.deepEqual(s.before, ['/today', '/payment-orders', '/loan-applications', '/reminders', MY_WORK_HREF]);
  assert.deepEqual(s.after, ['/bale-bot', '/internal-chat']);
  assert.deepEqual(s.tabs, ['/today', '/payment-orders', MY_WORK_HREF, '/loan-applications']);
  assert.ok(!s.tabs.includes('/reminders'));
  assert.equal(s.primary, false);
  assert.equal(s.labels[MY_WORK_HREF].label, 'عملکرد من');
  assert.ok(s.used.includes(MY_WORK_HREF));
});

check('flag on but href not visible: pill still removed, item not on dock', () => {
  const s = myWorkSlots({ flagOn: true, role: 'salesperson', visible: EXPERT, myWork: true });
  assert.equal(s.primary, false);
  assert.ok(!s.before.includes(MY_WORK_HREF));
  assert.ok(!s.tabs.includes(MY_WORK_HREF));
});

check('flag on admin: dock layout unchanged, no primary already', () => {
  const base = bnv2Slots({ flagOn: true, role: 'admin', visible: ADMIN });
  const s = applyMyWorkDock(base, true, ADMIN);
  assert.deepEqual(s.before, base.before);
  assert.deepEqual(s.tabs, base.tabs);
  assert.equal(s.primary, false);
  assert.equal(s.midSep, true);
  assert.ok(!s.before.includes(MY_WORK_HREF));
});

check('bottom-nav-v2 flag off + my-work on still does not invent a v2 dock', () => {
  const s = myWorkSlots({ flagOn: false, role: 'salesperson', visible: EXPERT_ON, myWork: true });
  // applyMyWorkDock still removes the primary when my-work is on even on the old dock,
  // because the gold pill must leave whenever this feature is on.
  assert.equal(s.primary, false);
  assert.deepEqual(s.before, ['/today', '/customers', '/loan-applications', '/reminders']);
});

console.log('passed', n, 'checks');

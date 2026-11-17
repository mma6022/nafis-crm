// node --experimental-strip-types src/features/sales-manager-console/merge-routes.test.mjs
import assert from 'node:assert/strict';
import { mergedTarget, MERGED_OLD_PATHS, KEPT_OLD_PATHS } from './merge-routes.ts';
const cases = [
  ['/sales-team-admin', '', '', '/sales-admin'], ['/sales-team-admin', '', '#s-dist', '/sales-admin#s-dist'], ['/sales-team-admin', '?open=model', '', '/sales-admin?open=model'],
  ['/sales-teams', '', '', '/sales-admin#s-teams'], ['/settings/default-owner', '', '', '/sales-admin#s-dist'],
  ['/settings/call-queue', '', '', '/sales-admin#s-model'], ['/sales-assist-settings', '', '', '/sales-admin#s-model'],
  ['/daily-plans', '', '', '/sales-admin#s-daily'], ['/daily-plans/settings', '', '', '/sales-admin#s-daily'],
  ['/daily-plans/expert/6/2026-11-18', '', '', '/sales-admin?expert=6&date=2026-11-18#s-daily'], ['/daily-plans/capacity/4', '', '', '/sales-admin?capacity=4#s-daily'],
  ['/call-queue-discipline', '', '', '/sales-admin#s-discipline'],
];
for (const [p, s, h, want] of cases) assert.equal(mergedTarget(p, s, h), want, p);
for (const p of [...KEPT_OLD_PATHS, '/users', '/today', '/my-queue', '/sales-admin', '/settings/notifications', '/daily-plans/expert/x/y']) assert.equal(mergedTarget(p), null, `${p} stays`);
assert.equal(MERGED_OLD_PATHS.length, 10);
console.log(`ok - ${cases.length} redirects, ${KEPT_OLD_PATHS.length + 6} kept paths`);

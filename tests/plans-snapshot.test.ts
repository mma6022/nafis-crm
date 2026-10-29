/** The LIVE build snapshot (refreshed from the CRM export by scripts/refresh-plans.mjs before every build). Offline:
 *  the live-count comparison itself is the build guard scripts/check-plans-live.mjs. Run: pnpm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import meta from '../src/data/loan-plans.snapshot.meta.json' with { type: 'json' };
import { parseComingSoonPlans, parseLoanPlans } from '../src/lib/loan-plans.ts';
import { combos, recommend, planFacts, FINDER_BANDS, FINDER_PRIOS } from '../src/lib/plans.ts';

const list = raw as { id: number }[];
const ids = list.map((p) => p.id).sort((a, b) => a - b);

test('live snapshot = its meta (count, ids, sha256): written by refresh-plans.mjs, not by hand', () => {
  const body = readFileSync(new URL('../src/data/loan-plans.snapshot.json', import.meta.url), 'utf8');
  assert.equal(meta.count, list.length);
  assert.deepEqual(meta.ids, ids);
  assert.equal(createHash('sha256').update(body).digest('hex'), meta.sha256);
  assert.match(meta.source, /^https:\/\/nafisvam\.com\/data\/loan-plans\.json$|^https?:\/\//);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('live snapshot parses fully and the site count = live active count', () => {
  const plans = parseLoanPlans(raw), soon = parseComingSoonPlans(raw);
  assert.equal(plans.length + soon.length, list.length, 'every exported plan is shown (calculable or «به‌زودی»)');
  assert.equal(planFacts(plans).planCount, plans.length, 'planCount = calculable plans');
  assert.equal(plans.length + soon.length, meta.count);
});

test('finder acceptance on the live snapshot: every band × priority → 1..3 cards', () => {
  const all = combos(parseLoanPlans(raw));
  for (const band of FINDER_BANDS)
    for (const prio of FINDER_PRIOS) {
      const r = recommend(all, { band, prio });
      assert.ok(r.cards.length >= 1 && r.cards.length <= 3, `${band},${prio}: ${r.cards.length}`);
    }
});

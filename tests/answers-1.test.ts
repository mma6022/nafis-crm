/** Designer ANSWERS-ADITYA-1 rules: request flow (§3, §6), finder preset (§9), calculator picks (§9), marker pills (mismatch 3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Logic tests run on a frozen fixture (the 2026-10-28 snapshot, 17 plans) so they stay deterministic when the live
// snapshot is refreshed at build time; the live snapshot itself is checked in plans-snapshot.test.ts.
import raw from './fixtures/loan-plans.2026-10-28.json' with { type: 'json' };
import { parseLoanPlans } from '../src/lib/loan-plans.ts';
import { combos, reqBands, calcPicks, bandOf, withoutUnbackedGuarantee, leadHtml, planFacts, FINDER_BANDS, type Combo } from '../src/lib/plans.ts';
import { stepOrder, parseDeepLink } from '../src/lib/request-flow.ts';
import { pillMarkers } from '../src/lib/ph-html.ts';

const plans = parseLoanPlans(raw);
const all = combos(plans);

/* §3 / §6: request wizard */
test('stepOrder (legal 2026-10-24): no need step; plan → plan, contact; no band → contact; else amount, contact', () => {
  assert.deepEqual(stepOrder(false, 4), ['amount', 'contact']);
  assert.deepEqual(stepOrder(false, 0), ['contact'], 'no amount band in the data skips the amount step');
  assert.deepEqual(stepOrder(true, 4), ['plan', 'contact']);
  for (const hasPlan of [true, false]) for (const n of [0, 4]) assert.ok(!stepOrder(hasPlan, n).includes('need'));
});

test('finder deep link: new ?a=band,prio; legacy ?a=type,band,prio still loads, type ignored', () => {
  assert.deepEqual(parseDeepLink('2,fast'), { band: 2, prio: 'fast' });
  assert.deepEqual(parseDeepLink('cash,2,fast'), { band: 2, prio: 'fast' });
  assert.deepEqual(parseDeepLink('goods,1,cheap'), { band: 1, prio: 'cheap' });
  assert.deepEqual(parseDeepLink('any'), {});
  assert.deepEqual(parseDeepLink('goods'), {});
  assert.deepEqual(parseDeepLink('9,bogus'), {});
  assert.deepEqual(parseDeepLink(null), {});
});

test('amount bands count every active plan (no plan-type filter)', () => {
  const bands = reqBands(all);
  assert.ok(bands.length > 0);
  for (const b of bands) {
    assert.equal(b.n, new Set(all.filter((c) => c.payout > b.lo && c.payout <= b.hi).map((c) => c.id)).size, b.key);
    assert.ok(b.n > 0, `${b.key}: empty bands are hidden`);
  }
  const types = new Set(all.filter((c) => bands.some((b) => c.payout > b.lo && c.payout <= b.hi)).map((c) => c.type));
  assert.ok(types.has('score') && types.has('goods'), 'plans of every type are counted');
});

/* P3: guarantee data now comes from data/plan-guarantees.ts (merged into every plan list); the preset passes through */
test('withoutUnbackedGuarantee: guarantee data present → preset is kept as is', () => {
  assert.ok(all.some((c) => Array.isArray(c.guarantees) && c.guarantees.length > 0), 'snapshot plans carry guaranteeTypes');
  const g = { page: 'no-guarantor' as const, label: 'بدون ضامن' };
  assert.deepEqual(withoutUnbackedGuarantee({ guarantee: g, prio: 'fast' }, all), { guarantee: g, prio: 'fast' });
  assert.equal(withoutUnbackedGuarantee(undefined, all), undefined);
});

/* §9: /calculator → 1–3 cards, one per plan, never empty; every plan type competes (legal 2026-10-24) */
test('calcPicks: 1–3 unique plans for every band × term, band match first, no type filter', () => {
  const terms = [...new Set(all.map((c) => c.term))];
  for (const band of FINDER_BANDS)
    for (const term of terms) {
      const r = calcPicks(all, band, term);
      const k = `${band},${term}`;
      assert.ok(r.length >= 1 && r.length <= 3, k);
      assert.equal(new Set(r.map((c) => c.id)).size, r.length, `${k}: deduped`);
      if (all.some((c) => bandOf(c.payout) === band)) assert.equal(bandOf(r[0]!.payout), band, `${k}: band match first`);
    }
  const picked = new Set(FINDER_BANDS.flatMap((b) => terms.flatMap((t) => calcPicks(all, b, t).map((c) => c.type))));
  assert.ok(picked.has('score') && picked.has('goods'), 'plans of every type can be picked');
  assert.deepEqual(calcPicks([], 0, 12), []);
});

/* mismatch 3: bracketless pills, marker kept in data-marker */
test('pillMarkers: bracketless pill text, data-marker keeps the marker, scripts untouched', () => {
  const out = pillMarkers('<p>متن [تأیید محمد: ساعت کاری] پایان</p><span class="ph">[جای‌خالی: نقشه]</span><script>x="[تأیید محمد]"</script>');
  assert.match(out, /<span class="ph" data-marker="\[تأیید محمد: ساعت کاری\]">تأیید محمد: ساعت کاری<\/span>/);
  assert.match(out, /<span class="ph" data-marker="\[جای‌خالی: نقشه\]">جای‌خالی: نقشه<\/span>/);
  assert.match(out, /<script>x="\[تأیید محمد\]"<\/script>/);
  assert.equal(out.replace(/data-marker="[^"]*"/g, '').replace(/<script[\s\S]*?<\/script>/, '').includes('['), false, 'no visible brackets');
  assert.equal(pillMarkers(out), out, 'idempotent');
  // leadHtml still emits the bracketed source pill; the middleware turns it into the bracketless one
  const lead = leadHtml('آ [تأیید محمد: x]', planFacts(plans));
  assert.match(lead, /<span class="ph">\[تأیید محمد: x\]<\/span>/);
  assert.match(pillMarkers(lead), /data-marker="\[تأیید محمد: x\]">تأیید محمد: x</);
});

test('check-markers counts markers from data-marker pills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nf-markers-'));
  mkdirSync(join(dir, 'dist'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'dist', 'index.html'), pillMarkers('<p>[تأیید محمد: الف]</p><p>[جای‌خالی: ب]</p>'));
  const script = resolve('scripts/check-markers.mjs');
  const out = execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.match(out, /markers: 2 visible marker\(s\) on 1\/1 page/);
  assert.throws(() => execFileSync(process.execPath, [script, '--strict'], { cwd: dir, stdio: 'pipe' }));
});

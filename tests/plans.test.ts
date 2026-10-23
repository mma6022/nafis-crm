/** UX-SPEC §6 acceptance: every one of the 3×3×3 = 27 answers yields 1–3 cards, never "not found". Run: pnpm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import { parseLoanPlans } from '../src/lib/loan-plans.ts';
import {
  combos, recommend, planFacts, bankNames, availableAmountBands, bandOf, millionsFa,
  FINDER_TYPES, FINDER_BANDS, FINDER_PRIOS, type Combo,
} from '../src/lib/plans.ts';

const plans = parseLoanPlans(raw);
const all = combos(plans);

test('snapshot parses fully', () => assert.equal(plans.length, (raw as unknown[]).length));

test('27 combinations → 1..3 cards, unique names, valid CTA params', () => {
  let n = 0;
  for (const type of FINDER_TYPES)
    for (const band of FINDER_BANDS)
      for (const prio of FINDER_PRIOS) {
        const r = recommend(all, { type, band, prio });
        n++;
        assert.ok(r.cards.length >= 1 && r.cards.length <= 3, `${type},${band},${prio}: ${r.cards.length}`);
        assert.equal(new Set(r.cards.map((c) => c.name)).size, r.cards.length);
        for (const c of r.cards) assert.ok(Number.isInteger(c.id) && Number.isInteger(c.term));
        if (type !== 'any') assert.equal(r.cards[0]!.type, type === 'cash' ? 'score' : 'goods', 'type is relaxed last');
      }
  assert.equal(n, 27);
});

test('exact match → featured card scores 100', () => {
  const r = recommend(all, { type: 'cash', band: 2, prio: 'fast' });
  assert.equal(r.exact, true);
  assert.equal(r.cards[0]!.score, 100);
  assert.equal(r.cards[0]!.days, 'under_7');
});

test('relaxation: priority is dropped before band', () => {
  // goods + fast: no goods plan is under_7, so the top card keeps type and band and loses priority
  const r = recommend(all, { type: 'goods', band: 2, prio: 'fast' });
  assert.equal(r.exact, false);
  assert.equal(r.cards[0]!.type, 'goods');
  assert.equal(bandOf(r.cards[0]!.payout), 2);
});

test('empty data never throws', () => assert.deepEqual(recommend([], { type: 'any', band: 0, prio: 'cheap' }).cards, []));

test('guarantee preset: unknown data is flagged, known data filters and relaxes last', () => {
  const r0 = recommend(all, { type: 'any', band: 1, prio: 'cheap' }, { guarantee: { exclude: ['guarantor'], label: 'بدون ضامن' } });
  assert.equal(r0.presetUnknown, true);
  const tagged: Combo[] = all.map((c) => ({ ...c, guarantees: c.id === 15 ? ['promissory'] : ['cheque'] }));
  const r1 = recommend(tagged, { type: 'goods', band: 0, prio: 'fast' }, { guarantee: { require: ['promissory'], label: 'سفته' } });
  assert.equal(r1.cards[0]!.id, 15);
  assert.equal(r1.cards[0]!.presetOk, true);
  assert.equal(r1.exact, false);
});

test('facts are computed from data', () => {
  const f = planFacts(plans);
  assert.equal(f.planCount, 18);
  assert.equal(f.goodsCount, 14);
  assert.equal(f.minPrincipal, 100e6);
  assert.equal(f.maxPrincipal, 700e6);
  assert.equal(f.minTerm, 12);
  assert.equal(f.maxTerm, 48);
  assert.ok(f.hasFast);
  assert.ok(bankNames(plans).has('ملی') && !bankNames(plans).has('بانک ملی'));
});

const BANDS_ALL = ['upto100', '100-300', '300-500']; // no plan pays out > 500M
const BANDS_CASH = ['100-300', '300-500'];
test('wizard bands (by payout) only list bands that contain a plan', () => {
  const all = combos(plans);
  assert.deepEqual(availableAmountBands(all).map((b) => b.value), BANDS_ALL);
  assert.deepEqual(availableAmountBands(all, 'score').map((b) => b.value), BANDS_CASH);
});

test('money format', () => {
  assert.equal(millionsFa(315e6), '۳۱۵');
  assert.equal(millionsFa(36_740_000), '۳۶٫۷');
});

import { planFactValue, toFinderPreset, fillFacts } from '../src/lib/plans';
test('PlanFact values reproduce the numbers written in the content (snapshot 2 Aban 1405)', () => {
  const cases: [number, string, number | undefined, string][] = [
    [18, 'installment', undefined, '۹٫۴ میلیون تومان'],
    [22, 'installment', undefined, '۱۶٫۶ میلیون تومان'],
    [1, 'payout', undefined, '۱۸۰ میلیون تومان'],
    [10, 'payout', undefined, '۳۱۵ میلیون تومان'],
    [11, 'rate', undefined, '۴٪'],
    [8, 'installment', 24, '۱۵٫۷ میلیون تومان'],
    [12, 'prepayment', undefined, '۱۴٫۳٪'],
  ];
  for (const [id, f, t, want] of cases) assert.equal(planFactValue(plans, id, f, t), want, `${id}.${f}`);
  assert.equal(planFactValue(plans, 999, 'principal'), null);
});
test('content presets map onto finder presets', () => {
  assert.deepEqual(toFinderPreset({ need: 'goods' }), { type: 'goods' });
  assert.equal(toFinderPreset({ guarantee: 'no-guarantor' }).guarantee?.label, 'بدون ضامن');
  assert.deepEqual(toFinderPreset({ guarantee: 'bogus' }), {});
  assert.equal(fillFacts('بین {planCount} طرح', planFacts(plans)), 'بین ۱۸ طرح');
});

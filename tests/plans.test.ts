/** UX-SPEC §6 acceptance: every one of the 3×3×3 = 27 answers yields 1–3 cards, never "not found". Run: pnpm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import { parseLoanPlans } from '../src/lib/loan-plans.ts';
import {
  combos, recommend, planFacts, bankNames, reqBands, bandOf, millionsFa,
  FINDER_TYPES, FINDER_BANDS, FINDER_PRIOS, comboQualifies, guaranteePagePlans, fastestGuaranteePlans, topPlanPerType, planMaxPayout, planBaseName, type Combo,
} from '../src/lib/plans.ts';
import type { GuaranteePage } from '../src/data/plan-guarantees.ts';

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

test('guarantee preset is a hard filter: only truly qualifying plans, empty when none', () => {
  const r0 = recommend(all, { type: 'any', band: 1, prio: 'cheap' }, { guarantee: { page: 'no-guarantor', label: 'بدون ضامن' } });
  assert.equal(r0.presetUnknown, false);
  assert.ok(r0.cards.length > 0);
  assert.ok(r0.cards.every((c) => comboQualifies(c, 'no-guarantor')));
  const r1 = recommend(all, { type: 'any', band: 0, prio: 'fast' }, { guarantee: { page: 'promissory', label: 'سفته' } });
  assert.ok(r1.cards.every((c) => c.id === 20));
  const r2 = recommend(all, { type: 'any', band: 0, prio: 'fast' }, { guarantee: { page: 'fast-no-cheque', label: 'فوری بدون چک' } });
  assert.deepEqual(r2.cards, []);
  // unknown guarantee data is never listed
  const unknown: Combo[] = all.map((c) => ({ ...c, guaranteeOptions: undefined, guarantees: undefined }));
  assert.deepEqual(recommend(unknown, { type: 'any', band: 1, prio: 'cheap' }, { guarantee: { page: 'cheque', label: 'چک' } }).cards, []);
});

test('guarantee pages: plan sets match Mohammad\'s answers (2026-10-23)', () => {
  const ids = (page: GuaranteePage) => guaranteePagePlans(plans, page).map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids('no-guarantor'), [3, 7, 8, 9, 12, 14, 15, 17, 18, 19, 21, 22]);
  assert.deepEqual(ids('no-cheque'), [15, 20, 21]);
  assert.deepEqual(ids('cheque'), [1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 18, 19, 22]);
  assert.deepEqual(ids('promissory'), [20]);
  assert.deepEqual(ids('fast-no-guarantor'), []);
  assert.deepEqual(ids('fast-no-cheque'), []);
  assert.equal(plans.find((p) => p.id === 21)?.retireesOnly, true);
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

test('wizard bands (by payout) only list bands that contain a plan', () => {
  const all = combos(plans);
  assert.deepEqual(reqBands(all).map((b) => b.key), ['0-100', '100-200', '200-300', '300-500']); // no plan pays out > 500M
  assert.ok(reqBands(all.filter((c) => c.type === 'score')).every((b) => b.n > 0));
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

test('fast sections: fastest ≤3 plans meeting the base condition, by grantDays then id (never empty)', () => {
  const ids = (b: 'no-cheque' | 'no-guarantor') => fastestGuaranteePlans(plans, b).map((p) => p.id);
  assert.deepEqual(ids('no-cheque'), [15, 20, 21]);
  assert.deepEqual(ids('no-guarantor'), [3, 7, 8]); // helper unchanged; the page now uses topPlanPerType
  for (const b of ['no-cheque', 'no-guarantor'] as const)
    for (const p of fastestGuaranteePlans(plans, b)) assert.ok(guaranteePagePlans(plans, b).some((q) => q.id === p.id));
});

test('«سریع‌ترین بدون ضامن»: one plan per type, highest مبلغ دریافتی, no repeated name', () => {
  const list = topPlanPerType(plans, 'no-guarantor');
  assert.deepEqual(list.map((p) => [p.id, p.loanType, planMaxPayout(p)]), [
    [9, 'goods', 290e6],
    [15, 'score', 165e6], // 17 (180M) is restricted to the main no-guarantor list
  ]);
  assert.equal(new Set(list.map((p) => planBaseName(p.name))).size, list.length);
  assert.equal(planBaseName('ترنم ( بازنشسته ها )'), planBaseName('ترنم'));
  assert.ok(!list.some((p) => p.id === 17));
  // every pick is the max of its type among the qualifying plans
  const pool = guaranteePagePlans(plans, 'no-guarantor');
  for (const p of list) for (const q of pool) if (q.loanType === p.loanType && !q.guaranteePages) assert.ok(planMaxPayout(q) <= planMaxPayout(p));
});

test('per-type pick skips a repeated name, picks up new types, stays 1–3', () => {
  const base = plans.find((p) => p.id === 8)!;
  const mk = (id: number, name: string, loanType: string, principalAmount: number) => ({
    ...base, id, name, loanType, principalAmount, guaranteeOptions: base.guaranteeOptions, guaranteePages: undefined,
  });
  const list = [mk(101, 'ترنم', 'goods', 900e6), mk(102, 'ترنم ( بازنشسته ها )', 'score', 900e6), mk(103, 'نیلوفر', 'score', 100e6), mk(104, 'بانک', 'bank', 50e6), mk(105, 'دیگر', 'zzz', 50e6)];
  const got = topPlanPerType(list, 'no-guarantor').map((p) => p.id);
  assert.deepEqual(got, [101, 103, 104]); // score's best repeats «ترنم» → next best; new type 'bank' included; max 3
});

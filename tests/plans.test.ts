/** UX-SPEC §6 acceptance: every one of the 3×3×3 = 27 answers yields 1–3 cards, never "not found". Run: pnpm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Logic tests run on a frozen fixture (the 2026-10-28 snapshot, 17 plans) so they stay deterministic when the live
// snapshot is refreshed at build time; the live snapshot itself is checked in plans-snapshot.test.ts.
import raw from './fixtures/loan-plans.2026-10-28.json' with { type: 'json' };
import { parseComingSoonPlans, parseLoanPlans } from '../src/lib/loan-plans.ts';
import {
  combos, recommend, planFacts, bankNames, reqBands, bandOf, millionsFa,
  FINDER_BANDS, FINDER_PRIOS, comboQualifies, guaranteePagePlans, fastestGuaranteePlans, topPlanPerType, planMaxPayout, planNoGuarantorPayout, planBaseName, type Combo,
} from '../src/lib/plans.ts';
import type { GuaranteePage } from '../src/data/plan-guarantees.ts';

const plans = parseLoanPlans(raw);
const all = combos(plans);

test('snapshot parses fully (plans without a calculable payout are listed «به‌زودی», never calculated)', () => {
  const soon = parseComingSoonPlans(raw);
  assert.equal(plans.length + soon.length, (raw as unknown[]).length);
  // PLANS-50 (Mohammad 2026-10-28 08:27): condition 396 now offers [18,24] → plan 4 is calculable at 24 months (110M); nothing «به‌زودی»
  assert.deepEqual(soon.map((p) => [p.id, p.terms]), []);
  assert.ok(plans.some((p) => p.id === 4));
});

test('parser: null payout/installment term = not calculable; a mixed plan keeps only its calculable terms', () => {
  const base = { name: 'x', installments: '12,18', loanType: 'score', processMode: 'both', grantDays: '10_to_15', bankName: 'ملی', platformName: 'y' };
  const mixed = { ...base, id: 901, installmentTerms: [{ installments: 12, payout: null, installment: null }, { installments: 18, payout: 60e6, installment: 5e6 }] };
  const none = { ...base, id: 902, installmentTerms: [{ installments: 12, payout: null, installment: null }] };
  const half = { ...base, id: 903, installmentTerms: [{ installments: 12, payout: 60e6, installment: null }] };
  assert.deepEqual(parseLoanPlans([mixed]).map((p) => p.installmentTerms.map((t) => t.installments)), [[18]]);
  assert.deepEqual(parseLoanPlans([none, half]), [], 'all-null plan is not calculable; a half-null term is malformed');
  assert.deepEqual(parseComingSoonPlans([mixed, none, half]).map((p) => p.id), [902]);
  assert.deepEqual(parseComingSoonPlans('x'), []);
});

test('9 combinations (band × priority; no type question since legal 2026-10-24) → 1..3 cards, unique names, valid CTA params', () => {
  let n = 0;
  for (const band of FINDER_BANDS)
    for (const prio of FINDER_PRIOS) {
        const r = recommend(all, { band, prio });
        n++;
        assert.ok(r.cards.length >= 1 && r.cards.length <= 3, `${band},${prio}: ${r.cards.length}`);
        assert.equal(new Set(r.cards.map((c) => c.name)).size, r.cards.length);
        for (const c of r.cards) assert.ok(Number.isInteger(c.id) && Number.isInteger(c.term));
      }
  assert.equal(n, 9);
});

test('exact match → featured card scores 100', () => {
  // 17 live plans (2026-10-28): the only under_7 plan is 11 هرمز (۱۵۰ میلیون → band 1)
  const r = recommend(all, { band: 1, prio: 'fast' });
  assert.equal(r.exact, true);
  assert.equal(r.cards[0]!.score, 100);
  assert.equal(r.cards[0]!.days, 'under_7');
});

test('relaxation: priority is dropped before band; every plan type competes', () => {
  // band 0 + fast: the top card keeps the band; the finder never filters by plan type
  const r = recommend(all, { band: 2, prio: 'cheap' });
  assert.equal(bandOf(r.cards[0]!.payout), 2);
  const types = new Set(FINDER_BANDS.flatMap((band) => FINDER_PRIOS.flatMap((prio) => recommend(all, { band, prio }).cards.map((c) => c.type))));
  assert.ok(types.has('score') && types.has('goods'), 'results include plans of every type');
});

test('empty data never throws', () => assert.deepEqual(recommend([], { band: 0, prio: 'cheap' }).cards, []));

test('guarantee preset is a hard filter: only truly qualifying plans, empty when none', () => {
  const r0 = recommend(all, { band: 1, prio: 'cheap' }, { guarantee: { page: 'no-guarantor', label: 'بدون ضامن' } });
  assert.equal(r0.presetUnknown, false);
  assert.ok(r0.cards.length > 0);
  assert.ok(r0.cards.every((c) => comboQualifies(c, 'no-guarantor')));
  const r1 = recommend(all, { band: 0, prio: 'fast' }, { guarantee: { page: 'promissory', label: 'سفته' } });
  assert.ok(r1.cards.every((c) => c.id === 20));
  // the fast pages exist now (/vam-fori-bedun-chek/): the preset lists the qualifying no-cheque plans
  const r2 = recommend(all, { band: 0, prio: 'fast' }, { guarantee: { page: 'fast-no-cheque', label: 'فوری بدون چک' } });
  assert.ok(r2.cards.length > 0 && r2.cards.every((c) => comboQualifies(c, 'fast-no-cheque')));
  // unknown guarantee data is never listed
  const unknown: Combo[] = all.map((c) => ({ ...c, guaranteeOptions: undefined, guarantees: undefined }));
  assert.deepEqual(recommend(unknown, { band: 1, prio: 'cheap' }, { guarantee: { page: 'cheque', label: 'چک' } }).cards, []);
});

test('guarantee pages: plan sets match Mohammad\'s answers (2026-10-23) on the 17 calculable live plans (10 خورشید inactive)', () => {
  const ids = (page: GuaranteePage) => guaranteePagePlans(plans, page).map((p) => p.id).sort((a, b) => a - b);
  assert.deepEqual(ids('no-guarantor'), [3, 7, 8, 9, 12, 14, 15, 17, 18, 19, 21, 22]);
  assert.deepEqual(ids('no-cheque'), [15, 20, 21]);
  assert.deepEqual(ids('cheque'), [1, 3, 4, 5, 7, 8, 9, 11, 12, 14, 18, 19, 22]); // 4 re-added (PLANS-50)
  assert.deepEqual(ids('promissory'), [20]);
  assert.deepEqual(ids('fast-no-guarantor'), [3, 7, 8, 9, 12, 14, 15, 18, 19, 21, 22]); // 17 is page-restricted
  assert.deepEqual(ids('fast-no-cheque'), [15, 20, 21]);
  assert.equal(plans.find((p) => p.id === 21)?.retireesOnly, true);
});

test('facts are computed from data', () => {
  const f = planFacts(plans);
  assert.equal(f.planCount, 17); // plan 4 calculable again (PLANS-50)
  assert.equal(f.goodsCount, 14); // + plan 4 (goods, PLANS-50)
  assert.equal(f.minAmount, '۶۰'); // مبلغ واریزی, never the principal (Mohammad 2026-10-28)
  assert.equal(f.maxAmount, '۲۹۰');
  assert.equal(f.minTerm, 12);
  assert.equal(f.maxTerm, 48);
  assert.ok(f.hasFast);
  assert.ok(bankNames(plans).has('ملی') && !bankNames(plans).has('بانک ملی'));
});

test('wizard bands (by payout) only list bands that contain a plan', () => {
  const all = combos(plans);
  assert.deepEqual(reqBands(all).map((b) => b.key), ['0-100', '100-200', '200-300']); // no plan pays out > 300M (10 inactive)
});

test('money format', () => {
  assert.equal(millionsFa(315e6), '۳۱۵');
  assert.equal(millionsFa(36_740_000), '۳۶٫۷');
});

import { planFactValue, toFinderPreset, fillFacts } from '../src/lib/plans';
test('PlanFact values reproduce the numbers written in the content (snapshot 2 Aban 1405)', () => {
  const cases: [number, string, number | undefined, string][] = [
    [1, 'payout', undefined, '۱۸۰ میلیون تومان'],
    [9, 'payout', undefined, '۲۹۰ میلیون تومان'],
    [11, 'term', 36, '۳۶ ماه'],
  ];
  for (const [id, f, t, want] of cases) assert.equal(planFactValue(plans, id, f, t), want, `${id}.${f}`);
  assert.equal(planFactValue(plans, 999, 'principal'), null);
  for (const f of ['principal', 'rate', 'prepayment', 'installment']) assert.equal(planFactValue(plans, 11, f), null, `${f} is never shown (Mohammad 2026-10-28; installment: site-credit-noinst v1.0)`);
  assert.equal(planFactValue(plans, 10, 'payout'), null, 'inactive plan 10 is not in the live data');
});
test('content presets map onto finder presets', () => {
  assert.deepEqual(toFinderPreset({ need: 'goods' }), {}, 'need (cash/goods) is ignored since legal 2026-10-24');
  assert.deepEqual(toFinderPreset({ need: 'cash', priority: 'fast' }), { prio: 'fast' });
  assert.equal(toFinderPreset({ guarantee: 'no-guarantor' }).guarantee?.label, 'بدون ضامن');
  assert.deepEqual(toFinderPreset({ guarantee: 'bogus' }), {});
  assert.equal(fillFacts('بین {planCount} طرح', planFacts(plans)), 'بین ۱۷ طرح');
});

test('fast pages: fastest ≤3 plans meeting the base condition, by grantDays (never empty)', () => {
  const ids = (b: 'no-cheque' | 'no-guarantor') => fastestGuaranteePlans(plans, b).map((p) => p.id);
  assert.deepEqual(ids('no-cheque'), [15, 20, 21]);
  assert.deepEqual(ids('no-guarantor'), [19, 8, 9]); // all 10_to_15 → ties by مبلغ واریزی without a guarantor (9 capped at ۳۰۰)
  for (const b of ['no-cheque', 'no-guarantor'] as const)
    for (const p of fastestGuaranteePlans(plans, b)) assert.ok(guaranteePagePlans(plans, b).some((q) => q.id === p.id));
});

test('«سریع‌ترین بدون ضامن»: one plan per type, highest مبلغ واریزی WITHOUT a guarantor, no repeated name', () => {
  const list = topPlanPerType(plans, 'no-guarantor');
  assert.deepEqual(list.map((p) => [p.id, p.loanType, planNoGuarantorPayout(p)]), [
    [19, 'goods', 214e6], // 9 مروارید: 290M with a guarantor, but no-guarantor only up to ۳۰۰ میلیون → 174M
    [15, 'score', 165e6], // 17 (180M) is restricted to the main no-guarantor list
  ]);
  const p9 = plans.find((p) => p.id === 9)!;
  assert.equal(p9.noGuarantorShare, 0.6);
  assert.equal(planMaxPayout(p9), 290e6);
  assert.equal(planNoGuarantorPayout(p9), 174e6);
  assert.equal(Math.round(planNoGuarantorPayout(plans.find((p) => p.id === 3)!)), 56e6); // ۱۰۰ میلیون cap → CRM card 56M (PLANS-49)
  assert.equal(planNoGuarantorPayout(plans.find((p) => p.id === 19)!), planMaxPayout(plans.find((p) => p.id === 19)!)); // no lower cap
  assert.equal(new Set(list.map((p) => planBaseName(p.name))).size, list.length);
  assert.equal(planBaseName('ترنم ( بازنشسته ها )'), planBaseName('ترنم'));
  assert.ok(!list.some((p) => p.id === 17));
  // every pick is the max of its type among the qualifying plans
  const pool = guaranteePagePlans(plans, 'no-guarantor');
  for (const p of list) for (const q of pool) if (q.loanType === p.loanType && !q.guaranteePages) assert.ok(planNoGuarantorPayout(q) <= planNoGuarantorPayout(p));
});

test('per-type pick skips a repeated name, picks up new types, stays 1–3', () => {
  const base = plans.find((p) => p.id === 8)!;
  const mk = (id: number, name: string, loanType: string, payout: number) => ({
    ...base, id, name, loanType, guaranteeOptions: base.guaranteeOptions, guaranteePages: undefined,
    installmentTerms: [{ installments: 24, payout, installment: Math.round(payout / 12) }],
  });
  const list = [mk(101, 'ترنم', 'goods', 900e6), mk(102, 'ترنم ( بازنشسته ها )', 'score', 900e6), mk(103, 'نیلوفر', 'score', 100e6), mk(104, 'بانک', 'bank', 50e6), mk(105, 'دیگر', 'zzz', 50e6)];
  const got = topPlanPerType(list, 'no-guarantor').map((p) => p.id);
  assert.deepEqual(got, [101, 103, 104]); // score's best repeats «ترنم» → next best; new type 'bank' included; max 3
});

test('no-guarantor share from data: a capped plan loses to a lower-payout plan without a cap', () => {
  const base = plans.find((p) => p.id === 8)!;
  const mk = (id: number, name: string, payout: number, noGuarantorShare?: number) => ({
    ...base, id, name, loanType: 'goods', guaranteePages: undefined,
    installmentTerms: [{ installments: 24, payout, installment: Math.round(payout / 12) }],
    ...(noGuarantorShare ? { noGuarantorShare } : {}),
  });
  const list = [mk(201, 'الف', 250e6, 0.4), mk(202, 'ب', 150e6)];
  assert.deepEqual(topPlanPerType(list, 'no-guarantor').map((p) => p.id), [202]);
  assert.deepEqual(topPlanPerType([mk(201, 'الف', 500e6)], 'no-guarantor').map((p) => p.id), [201]);
});

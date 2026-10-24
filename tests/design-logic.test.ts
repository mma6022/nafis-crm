/**
 * Phase-2 logic port (designer site.js → src/lib). Each block checks the TS port against the designer's own
 * functions (tests/fixtures/designer-site-logic.mjs, verbatim copy) and against hand-computed values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import { parseLoanPlans, type LoanPlan } from '../src/lib/loan-plans.ts';
import {
  combos, recommend, planFacts, bankNames, normBank, splitBanks, reqBands, installment, byId, bandOf, millionsFa,
  FINDER_BANDS, FINDER_PRIOS, REQ_BAND_KEYS, type Combo,
} from '../src/lib/plans.ts';
import { toEnDigits, mobileDigits, isValidMobile } from '../src/lib/format.ts';
import { readTrackingCode, submitLead, type LeadInput } from '../src/lib/lead.ts';
import { designer } from './fixtures/designer-site-logic.mjs';
import { PLAN_GUARANTEES } from '../src/data/plan-guarantees.ts';

const plans = parseLoanPlans(raw);
const all = combos(plans);
const D = designer(raw);
/** P3 (6:09): retiree-only plans (21) are hidden from the finder unless «بازنشسته هستم»; the designer never knew them */
const DR = designer((raw as { id: number }[]).filter((p) => !PLAN_GUARANTEES[p.id]?.retireesOnly));

/* ---------- installment ---------- */
test('installment: annuity P·r/(1−(1+r)^−n), r = annual/100/12', () => {
  // 100M at 24%/yr over 12 months: r = 0.02 → 9,455,960 (standard annuity table value)
  assert.equal(Math.round(installment(100e6, 24, 12)), 9_455_960);
  assert.equal(installment(120e6, 0, 12), 10e6, 'zero rate → P/n');
  for (const c of all) assert.ok(Math.abs(c.inst - D.installment(c.principal, c.rate, c.term)) < 1e-6);
  assert.equal(installment(1e6, 23, 0), 0, 'no term → 0, never Infinity');
});

/* ---------- received amount ---------- */
test('payout (received) = principal × depositPercent / 100, same combos as the designer', () => {
  assert.equal(all.length, D.combos.length);
  all.forEach((c, i) => {
    const d = D.combos[i];
    assert.equal(c.payout, d.payout);
    assert.equal(c.id, d.id);
    assert.equal(c.term, d.term);
    assert.equal(c.name, d.name);
  });
  const p = plans[0]!;
  const t = p.installmentTerms[0]!;
  assert.equal(all[0]!.payout, (p.principalAmount * t.depositPercent) / 100);
  assert.equal(millionsFa(315e6), D.millions(315e6));
  assert.equal(millionsFa(36_740_000), '۳۶٫۷');
});

/* ---------- plan-finder ranking ---------- */
test('recommend: same ranking and exact flag as site.js (type «any») for all 9 answers (ties: ANSWERS-1 §4)', () => {
  // site.js leaves full ties to array order; ANSWERS-1 §4 fixes them (payout ↓, installment ↑, id ↑).
  // So each position must match site.js on score and on the primary metric; only true ties may differ.
  let identical = 0;
  for (const band of FINDER_BANDS)
    for (const prio of FINDER_PRIOS) {
        const ours = recommend(all, { band, prio });
        const ref = DR.recommend({ band, prio, type: 'any' }); // 'any' = the designer's no-type scoring
        const k = `${band},${prio}`;
        const key = (c: Combo) => `${c.id}/${c.term}`;
        const metric = (c: Combo) => Math.round(prio === 'cheap' ? c.inst : c.payout);
        assert.equal(ours.cards.length, ref.cards.length, k);
        ours.cards.forEach((c, i) => {
          const r = ref.cards[i]!;
          assert.equal(c.score, r.s, `${k}#${i} score`);
          assert.equal(metric(c), metric(r), `${k}#${i} ${key(c)} vs ${key(r)}`);
        });
        if (ours.cards.map(key).join() === ref.cards.map(key).join()) identical++;
        assert.equal(ours.exact, ref.exact, k);
        assert.ok(ours.cards.length >= 1 && ours.cards.length <= 3);
        assert.equal(new Set(ours.cards.map((c) => c.name)).size, ours.cards.length, `${k}: names deduped`);
      }
  assert.ok(identical >= 6, `most answers identical to site.js (${identical}/9)`);
  // the tie itself: equal installment → higher payout first, then smaller id
  const [, x, y] = recommend(all, { band: 1, prio: 'cheap' }).cards;
  assert.ok(x!.inst < y!.inst || (x!.inst === y!.inst && (x!.payout > y!.payout || (x!.payout === y!.payout && x!.id < y!.id))));
});

test('recommend online: processMode=both ranks above in-person; deterministic id tie-break', () => {
  const mk = (id: number, o: Partial<Combo>): Combo => ({
    id, name: `طرح ${id}`, type: 'score', mode: 'in_person', days: '10_to_15', bank: 'ملی', platform: 'x',
    principal: 150e6, rate: 23, term: 12, prepay: 0, payout: 150e6, inst: 14e6, ...o,
  });
  const list = [mk(9, {}), mk(7, { mode: 'both' }), mk(5, { mode: 'both' })];
  assert.deepEqual(recommend(list, { band: 1, prio: 'online' }).cards.map((c) => c.id), [5, 7, 9]);
  assert.deepEqual(recommend([...list].reverse(), { band: 1, prio: 'online' }).cards.map((c) => c.id), [5, 7, 9]);
});

test('recommend on synthetic data: band > priority, plan type ignored; alternatives within 30 points', () => {
  const mk = (id: number, o: Partial<Combo>): Combo => ({
    id, name: `طرح ${id}`, type: 'score', mode: 'in_person', days: '10_to_15', bank: 'ملی', platform: 'x',
    principal: 150e6, rate: 23, term: 12, prepay: 0, payout: 150e6, inst: 14e6, ...o,
  });
  const list = [
    mk(1, { type: 'goods', payout: 150e6, days: 'under_7' }), // right band + fast (type does not matter)
    mk(2, { payout: 300e6, days: 'under_7' }), // adjacent band, fast
    mk(3, { payout: 150e6 }), // right band, slow
  ];
  const r = recommend(list, { band: 1, prio: 'fast' });
  assert.deepEqual(r.cards.map((c) => c.id), [1, 3, 2], 'band + priority first; band beats priority; every type listed');
  assert.equal(r.exact, true);
  assert.equal(r.cards[0]!.score, 100);
  assert.equal(r.cards[1]!.score, 70);
  const slowOnly = recommend(list.filter((c) => c.id !== 1), { band: 1, prio: 'fast' });
  assert.equal(slowOnly.exact, false);
  assert.deepEqual(slowOnly.cards.map((c) => c.id), [3, 2]);
  assert.equal(bandOf(99_999_999), 0);
  assert.equal(bandOf(100e6), 1);
  assert.equal(bandOf(200e6), 1);
  assert.equal(bandOf(200_000_001), 2);
});

/* ---------- reqBands ---------- */
test('reqBands: payout bands from data, labels and keys like site.js, empty bands hidden', () => {
  const ours = reqBands(all);
  assert.deepEqual(ours, D.reqBands(D.combos));
  assert.deepEqual(ours.map((b) => b.key), ['0-100', '100-200', '200-300', '300-500']);
  assert.deepEqual(ours.map((b) => b.label), ['تا ۱۰۰ میلیون تومان', '۱۰۰ تا ۲۰۰ میلیون تومان', '۲۰۰ تا ۳۰۰ میلیون تومان', '۳۰۰ تا ۵۰۰ میلیون تومان']);
  for (const b of ours) {
    const ids = new Set(all.filter((c) => c.payout > b.lo && c.payout <= b.hi).map((c) => c.id));
    assert.equal(b.n, ids.size, `${b.key} counts distinct plans`);
    assert.ok(b.n > 0);
  }
  for (const b of ours) assert.ok((REQ_BAND_KEYS as readonly string[]).includes(b.key));
  // synthetic: an empty middle band disappears, the open top band appears once a plan pays > 1000M
  const syn = [{ id: 1, payout: 50e6 }, { id: 1, payout: 80e6 }, { id: 2, payout: 1200e6 }, { id: 3, payout: 1000e6 }] as Combo[];
  const s = reqBands(syn);
  assert.deepEqual(s.map((b) => [b.key, b.n]), [['0-100', 1], ['500-1000', 1], ['1000-up', 1]]);
  assert.equal(s[2]!.label, 'بیش از ۱۰۰۰ میلیون تومان');
  assert.deepEqual(reqBands([]), []);
  assert.deepEqual(reqBands(syn.slice(0, 1)).map((b) => b.n), [1], 'boundary: 100M goes into (0,100]');
});

/* ---------- bank-name normalisation ---------- */
test('bank names: split on - | / ، , +, ZWNJ/space collapsed, «بانک» dropped → 12 on the snapshot', () => {
  assert.equal(bankNames(plans).size, 12);
  assert.deepEqual([...bankNames(plans)].sort(), [...D.bankSet].sort());
  assert.equal(normBank('  بانک   ملی '), 'ملی');
  assert.equal(normBank('اقتصاد\u200cنوین'), 'اقتصاد نوین');
  assert.equal(normBank('بانکداری'), 'بانکداری', 'only a whole leading word «بانک»');
  assert.deepEqual(splitBanks('بانک ملت | لندتک'), ['ملت', 'لندتک']);
  assert.deepEqual(splitBanks('گردشگری - اقتصاد نوین - دی'), ['گردشگری', 'اقتصاد نوین', 'دی']);
  assert.deepEqual(splitBanks('سپه+ رفاه، تجارت/صادرات,ملی'), ['سپه', 'رفاه', 'تجارت', 'صادرات', 'ملی']);
  const dup = [{ bankName: 'بانک ملی' }, { bankName: 'ملی' }, { bankName: 'ملی | سپه' }] as LoanPlan[];
  assert.equal(bankNames(dup).size, 2);
});

test('facts: amount/term range text and hero sample (plan 10) from data', () => {
  const f = planFacts(plans);
  assert.equal(f.amountRange, 'از ۱۰۰ تا ۷۰۰ میلیون تومان');
  assert.equal(f.termRange, 'بازپرداخت ۱۲ تا ۴۸ ماهه');
  assert.equal(f.bankCount, 12);
  const s = byId(all, 10)!;
  assert.equal(s.payout, Math.max(...all.filter((c) => c.id === 10).map((c) => c.payout)));
});

/* ---------- digits + mobile ---------- */
test('Persian/Arabic digits are normalised; mobile must be /^09\\d{9}$/', () => {
  assert.equal(toEnDigits('۰۹۱۲٣٤٥'), '0912345');
  assert.equal(mobileDigits('۰۹۱۲ ۳۴۵ ۶۷۸۹'), '09123456789');
  assert.ok(isValidMobile('۰۹۱۲ ۳۴۵ ۶۷۸۹'));
  assert.ok(isValidMobile('٠٩١٢-٣٤٥-٦٧٨٩'));
  assert.ok(isValidMobile('09123456789'));
  for (const bad of ['0912345678', '091234567890', '08123456789', '9123456789', '+989123456789', '', 'abc'])
    assert.equal(isValidMobile(bad), false, bad);
});

/* ---------- tracking code ---------- */
test('tracking code: shown only when the CRM returns a well-formed trackingCode', async () => {
  assert.equal(readTrackingCode({ ok: true, trackingCode: 'NV-7K3M-Q9TX' }), 'NV-7K3M-Q9TX');
  assert.equal(readTrackingCode({ ok: true }), undefined);
  assert.equal(readTrackingCode({ trackingCode: 12345 }), undefined);
  assert.equal(readTrackingCode({ trackingCode: '<img src=x>' }), undefined);
  assert.equal(readTrackingCode(null), undefined);
  const lead: LeadInput = {
    name: 'مریم', phone: '09123456789', amountBand: '100-200', contactTime: 'any',
    consent: true, website: '', startedAt: 1,
  };
  const reply = (status: number, body: string | null) => (async () => new Response(body, { status })) as typeof fetch;
  assert.deepEqual(await submitLead(lead, 'https://x/api', reply(201, '{"ok":true,"trackingCode":"NV-7K3M-Q9TX"}')), { trackingCode: 'NV-7K3M-Q9TX' });
  assert.deepEqual(await submitLead(lead, 'https://x/api', reply(200, '{"ok":true}')), {}, 'duplicate → no code');
  assert.deepEqual(await submitLead(lead, 'https://x/api', reply(204, null)), {});
  assert.deepEqual(await submitLead(lead, 'https://x/api', reply(201, 'not json')), {});
});

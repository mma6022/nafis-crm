/** Designer ANSWERS-ADITYA-1 rules: request flow (§3, §6), finder preset (§9), calculator picks (§9), marker pills (mismatch 3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import { parseLoanPlans } from '../src/lib/loan-plans.ts';
import { combos, reqBands, calcPicks, bandOf, withoutUnbackedGuarantee, leadHtml, planFacts, FINDER_TYPES, FINDER_BANDS, type Combo } from '../src/lib/plans.ts';
import { combosForNeed, stepOrder } from '../src/lib/request-flow.ts';
import { pillMarkers } from '../src/lib/ph-html.ts';

const plans = parseLoanPlans(raw);
const all = combos(plans);

/* §3 / §6: request wizard */
test('stepOrder: need=help → need, contact; plan → plan, contact; otherwise 3 steps', () => {
  assert.deepEqual(stepOrder(false, 'help', 4), ['need', 'contact']);
  assert.deepEqual(stepOrder(false, 'cash', 4), ['need', 'amount', 'contact']);
  assert.deepEqual(stepOrder(false, null, 4), ['need', 'amount', 'contact']);
  assert.deepEqual(stepOrder(false, 'goods', 0), ['need', 'contact'], 'a need without any band skips the amount step');
  assert.deepEqual(stepOrder(true, 'cash', 4), ['plan', 'contact']);
});

test('amount bands are filtered by need and counted after filtering', () => {
  const cash = combosForNeed(all, 'cash');
  const goods = combosForNeed(all, 'goods');
  assert.ok(cash.length && cash.every((c) => c.type === 'score'));
  assert.ok(goods.length && goods.every((c) => c.type === 'goods'));
  assert.equal(combosForNeed(all, 'help').length, all.length);
  for (const list of [cash, goods]) {
    const bands = reqBands(list);
    assert.ok(bands.length > 0);
    assert.ok(bands.reduce((a, b) => a + b.n, 0) <= reqBands(all).reduce((a, b) => a + b.n, 0));
    for (const b of bands) {
      assert.equal(b.n, new Set(list.filter((c) => c.payout > b.lo && c.payout <= b.hi).map((c) => c.id)).size, b.key);
      assert.ok(b.n > 0, `${b.key}: empty bands are hidden`);
    }
  }
});

/* §9: guarantee preset is dropped while plans have no guaranteeTypes */
test('withoutUnbackedGuarantee: no guarantee data → preset loses guarantee, keeps the rest', () => {
  assert.equal(all.some((c) => Array.isArray(c.guarantees)), false, 'snapshot still has no guaranteeTypes');
  const g = { exclude: ['guarantor' as const], label: 'بدون ضامن' };
  assert.deepEqual(withoutUnbackedGuarantee({ guarantee: g, type: 'cash' }, all), { type: 'cash' });
  assert.equal(withoutUnbackedGuarantee(undefined, all), undefined);
  const backed: Combo[] = all.map((c) => ({ ...c, guarantees: ['cheque'] }));
  assert.deepEqual(withoutUnbackedGuarantee({ guarantee: g }, backed), { guarantee: g });
});

/* §9: /calculator → 1–3 cards, one per plan, never empty */
test('calcPicks: 1–3 unique plans for every type × band × term, band match first', () => {
  const terms = [...new Set(all.map((c) => c.term))];
  for (const type of FINDER_TYPES)
    for (const band of FINDER_BANDS)
      for (const term of terms) {
        const r = calcPicks(all, type, band, term);
        const k = `${type},${band},${term}`;
        assert.ok(r.length >= 1 && r.length <= 3, k);
        assert.equal(new Set(r.map((c) => c.id)).size, r.length, `${k}: deduped`);
        if (type !== 'any') assert.ok(r.every((c) => c.type === (type === 'cash' ? 'score' : 'goods')), `${k}: type`);
        const anyMatch = all.some((c) => (type === 'any' || c.type === (type === 'cash' ? 'score' : 'goods')) && bandOf(c.payout) === band);
        if (anyMatch) assert.equal(bandOf(r[0]!.payout), band, `${k}: band match first`);
      }
  assert.deepEqual(calcPicks([], 'cash', 0, 12), []);
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

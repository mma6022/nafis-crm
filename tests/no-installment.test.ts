// site-credit-noinst v1.0: no «قسط» wording in the site source outside the allowed category words
// (same rule as scripts/check-installment.mjs, which also scans dist/ after a build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const J = '[\\u200c\\u200d\\u0640]?';
const WORD = new RegExp(`ق${J}س${J}ط|ا${J}ق${J}س${J}ا${J}ط`, 'g');
const strip = (t: string) => t.replace(/اقساطی/g, '').replace(/قسطیو/g, '');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

test('matcher: flags every قسط form, allows «اقساطی» and «قسطیو»', () => {
  for (const bad of ['قسط', 'قسطی', 'قسط‌ها', 'اقساط', 'تعداد اقساط', 'مبلغ هر قسط', 'محاسبه قسط'])
    assert.ok(strip(bad).match(WORD), bad);
  for (const ok of ['خرید اقساطی', 'تسهیلات اقساطی', 'قسطیو', 'مدت بازپرداخت', 'مبلغ واریزی']) assert.equal(strip(ok).match(WORD), null, ok);
});

test('src: no «قسط»/«اقساط» and no PlanFact field="installment"', () => {
  const hits: string[] = [];
  for (const f of walk(join(ROOT, 'src')).filter((x) => /\.(astro|tsx?|mdx?|css|json)$/.test(x))) {
    const t = readFileSync(f, 'utf8').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    for (const m of strip(t).matchAll(WORD)) hits.push(`${relative(ROOT, f)}: ${m[0]}`);
    if (/field=["']installment["']/.test(t)) hits.push(`${relative(ROOT, f)}: PlanFact installment`);
  }
  assert.deepEqual(hits, []);
});

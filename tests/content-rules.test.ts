/** Content rules from the designer handoff that live in the MDX sources. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import raw from '../src/data/loan-plans.snapshot.json' with { type: 'json' };
import { leadHtml, planFacts } from '../src/lib/plans.ts';
import { parseLoanPlans } from '../src/lib/loan-plans.ts';

const dir = 'src/content/blog/';
for (const f of readdirSync(dir).filter((x) => x.endsWith('.mdx'))) {
  test(`blog ${f}: inline CTA sits after the 2nd H2 (before the 3rd)`, () => {
    const body = readFileSync(dir + f, 'utf8').split(/^---$/m).slice(2).join('---');
    const h2 = [...body.matchAll(/^## /gm)].map((m) => m.index!);
    const cta = body.search(/^<InlineCTA/m);
    if (cta < 0) return;
    assert.ok(h2.length >= 3, 'needs ≥3 H2');
    assert.ok(cta > h2[1] && cta < h2[2], 'CTA must be between H2 #2 and #3');
  });
}

test('leadHtml: escapes, bold, live tokens, markers', () => {
  const f = planFacts(parseLoanPlans(raw));
  const h = leadHtml('a <b> **x** {goodsCount} [تأیید محمد: y]', f);
  assert.match(h, /&lt;b&gt;/);
  assert.match(h, /<strong>x<\/strong>/);
  assert.match(h, /<span data-plan-count="goodsCount">[۰-۹]+<\/span>/);
  assert.match(h, /<span class="ph">\[تأیید محمد: y\]<\/span>/);
});

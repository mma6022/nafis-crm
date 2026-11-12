#!/usr/bin/env node
// site-credit-noinst v1.0 guard (Mohammad t337u, Armita spec §2–§3; runs in build + build:preview after astro build):
// the customer sees only «مبلغ واریزی» and «مدت بازپرداخت» — no per-payment amount and no «قسط» wording anywhere.
//  - «قسط» in any form (قسط، قسطی، قسط‌ها، اقساط، …) fails the build in dist (html/js/json/xml/txt, \uXXXX unescaped)
//    and in src (astro/ts/tsx/mdx/md/css).
//  - Allowed (the only exceptions):
//      «اقساطی»  — the category words «خرید اقساطی» / «تسهیلات اقساطی» (spec §2.3: the category stays);
//      «قسطیو»   — a lender platform's own name from the CRM loan_plans export (data, not an installment figure;
//                  loan_plans rows are never edited from the site).
//  - <PlanFact field="installment"> and data-plan-fact="…:installment:…" may not come back.
//  - src/data/loan-plans.snapshot.json is CRM data (field names are Latin; the platform name above is allowed).
// Run: node scripts/check-installment.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const unesc = (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
// ق س ط with optional ZWNJ/ZWJ/tatweel between letters, and the plural ا ق س ا ط
const J = '[\\u200c\\u200d\\u0640]?';
export const WORD = new RegExp(`ق${J}س${J}ط|ا${J}ق${J}س${J}ا${J}ط`, 'g');
/** allowed forms: the category adjective «اقساطی» and the lender name «قسطیو» */
export const ALLOWED = [/اقساطی/g, /قسطیو/g];
export const strip = (t) => ALLOWED.reduce((s, re) => s.replace(re, ''), t);
export const hitsIn = (t) => [...strip(t).matchAll(WORD)];

const errors = [];
// self-test of the matcher
for (const bad of ['قسط', 'قسطی', 'قسط‌ها', 'اقساط', 'تعداد اقساط', 'مبلغ هر قسط', 'محاسبه قسط', 'ق\u200cسط', 'اقساط ماهانه'])
  if (!hitsIn(bad).length) errors.push(`matcher misses ${JSON.stringify(bad)}`);
for (const ok of ['خرید اقساطی', 'تسهیلات اقساطی', 'قسطیو', 'مدت بازپرداخت', 'مبلغ واریزی', 'بازپرداخت ۱۲ تا ۴۸ ماهه'])
  if (hitsIn(ok).length) errors.push(`matcher wrongly flags ${JSON.stringify(ok)}`);

const ctx = (t, i) => t.slice(Math.max(0, i - 40), i + 30).replace(/\s+/g, ' ');
if (!existsSync(join(DIST, 'index.html'))) { console.error('installment: dist/ not built'); process.exit(1); }
let distN = 0;
for (const f of walk(DIST).filter((x) => /\.(html|js|mjs|json|txt|xml)$/.test(x))) {
  distN++;
  const rel = relative(DIST, f);
  const t = unesc(readFileSync(f, 'utf8'));
  for (const m of hitsIn(t)) errors.push(`dist/${rel}: «${m[0]}» (…${ctx(strip(t), m.index)}…)`);
  if (/data-plan-fact="[^"]*:installment:/.test(t)) errors.push(`dist/${rel}: a PlanFact installment figure is back`);
}
let srcN = 0;
for (const f of walk(join(ROOT, 'src')).filter((x) => /\.(astro|tsx?|mdx?|css|json)$/.test(x))) {
  srcN++;
  const rel = relative(ROOT, f);
  const t = unesc(readFileSync(f, 'utf8'));
  for (const m of hitsIn(t)) errors.push(`${rel}:${strip(t).slice(0, m.index).split('\n').length}: «${m[0]}» (…${ctx(strip(t), m.index)}…)`);
  if (/field=["']installment["']/.test(t)) errors.push(`${rel}: <PlanFact field="installment"> is back`);
}
if (errors.length) {
  console.error(`installment: ${errors.length} problem(s)\n  ` + errors.slice(0, 80).join('\n  '));
  process.exit(1);
}
console.log(`installment: OK — no «قسط»/«اقساط» in ${distN} dist files or ${srcN} src files (allowed: «اقساطی» category words, lender name «قسطیو») · no PlanFact installment figure`);

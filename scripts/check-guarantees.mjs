#!/usr/bin/env node
// P3 content guard (runs in build + build:preview, after astro build):
//  1. Guarantee pages list EXACTLY the plans that truly meet the page condition. The rule is re-implemented here from
//     the raw guaranteeOptions (independent of lib/plans.ts) and must also equal the CONFIRMED table below, which is
//     Mohammad's 2026-10-23 answers. A mismatch anywhere fails the build.
//  2. Plan 17 only on /vam-bedun-zamen and always with its credit-score phrase; retiree-only plans carry their tag.
//  3. «سپرده» appears nowhere in dist (blog included).
//  4. /calculator FAQ answer is verbatim in the page AND its FAQPage JSON-LD, and the page never says «مبلغ اسمی».
//  5. Every lead/callback form in dist shows the exact consent text.
// Run: node --experimental-strip-types --no-warnings --import ./tests/ts-resolve.mjs scripts/check-guarantees.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLoanPlans } from '../src/lib/loan-plans.ts';
import { CONSENT_TEXT } from '../src/lib/callback.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const errors = [];
const plans = parseLoanPlans(JSON.parse(readFileSync(join(ROOT, 'src/data/loan-plans.snapshot.json'), 'utf8')));

/** independent page rules */
const has = (o, t) => o.includes(t);
const RULE = {
  'no-guarantor': (o) => !has(o, 'guarantor'),
  'no-cheque': (o) => !has(o, 'cheque'),
  cheque: (o) => has(o, 'cheque'),
  promissory: (o) => has(o, 'promissory'),
};
const PAGES = {
  'no-guarantor': { rule: 'no-guarantor', fast: false, file: 'vam-bedun-zamen' },
  'fast-no-guarantor': { rule: 'no-guarantor', fast: true, file: 'vam-bedun-zamen' },
  'no-cheque': { rule: 'no-cheque', fast: false, file: 'vam-bedun-chek' },
  'fast-no-cheque': { rule: 'no-cheque', fast: true, file: 'vam-bedun-chek' },
  cheque: { rule: 'cheque', fast: false, file: 'vam-ba-chek' },
  promissory: { rule: 'promissory', fast: false, file: 'vam-ba-safte' },
};
/** Mohammad's confirmed answers (2026-10-23). Changing plan data must change this table deliberately. */
const CONFIRMED = {
  'no-guarantor': [3, 7, 8, 9, 12, 14, 15, 17, 18, 19, 21, 22],
  'fast-no-guarantor': [],
  'no-cheque': [15, 20, 21],
  'fast-no-cheque': [],
  cheque: [1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 18, 19, 22],
  promissory: [20],
};
const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const expected = {};
for (const [page, def] of Object.entries(PAGES)) {
  expected[page] = uniq(
    plans
      .filter((p) => p.guaranteeOptions?.length)
      .filter((p) => !p.guaranteePages || p.guaranteePages.includes(page))
      .filter((p) => !def.fast || p.grantDays === 'under_7')
      .filter((p) => p.guaranteeOptions.some(RULE[def.rule]))
      .map((p) => p.id),
  );
  if (!same(expected[page], CONFIRMED[page]))
    errors.push(`${page}: plan data qualifies [${expected[page]}] but the confirmed list is [${CONFIRMED[page]}]`);
}

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const html = (slug) => {
  const f = join(DIST, slug, 'index.html');
  if (!existsSync(f)) {
    errors.push(`dist/${slug}/index.html missing`);
    return '';
  }
  return readFileSync(f, 'utf8');
};
/** one <GuaranteePlans page=…> block = from its data-guarantee-page attribute to the next block or </article> */
const block = (h, page) => {
  const start = h.indexOf(`data-guarantee-page="${page}"`);
  if (start < 0) return null;
  const ends = [h.indexOf('data-guarantee-page="', start + 1), h.indexOf('</article>', start)].filter((i) => i > 0);
  return h.slice(start, ends.length ? Math.min(...ends) : undefined);
};
const seen = {};
for (const [page, def] of Object.entries(PAGES)) {
  const h = html(def.file);
  if (!h) continue;
  const b = block(h, page);
  if (b == null) {
    errors.push(`${def.file}: no <GuaranteePlans page="${page}"> block`);
    continue;
  }
  const rows = [...b.matchAll(/data-plan-id="(\d+)"/g)].map((m) => +m[1]);
  const ids = uniq(rows);
  seen[page] = ids;
  if (rows.length !== ids.length) errors.push(`${def.file} [${page}]: a plan is listed twice`);
  if (!same(ids, expected[page])) errors.push(`${def.file} [${page}]: lists [${ids}] but qualifying plans are [${expected[page]}]`);
  if (ids.length === 0 && !/data-count="0"/.test(b)) errors.push(`${def.file} [${page}]: empty list without the empty state`);
  for (const id of ids) {
    const row = b.split(`data-plan-id="${id}"`)[1]?.split('data-plan-id=')[0] ?? '';
    const p = plans.find((x) => x.id === id);
    if (id === 17 && !/رتبه‌ی اعتباری/.test(row)) errors.push(`${def.file}: plan 17 row lacks the credit-score phrase`);
    if (p?.retireesOnly && !/ویژه‌ی بازنشسته‌ها/.test(row)) errors.push(`${def.file}: plan ${id} row lacks «ویژه‌ی بازنشسته‌ها»`);
  }
}
// plan 17 must not appear on any other guarantee page block
for (const [page, ids] of Object.entries(seen)) if (page !== 'no-guarantor' && ids.includes(17)) errors.push(`plan 17 listed on ${page}`);

const files = walk(DIST).filter((f) => f.endsWith('.html'));
for (const f of files) {
  const h = readFileSync(f, 'utf8');
  const rel = relative(DIST, f);
  // PM rule: «سپرده» is a forbidden word everywhere, the blog included
  if (h.includes('سپرده')) errors.push(`${rel}: contains forbidden word «سپرده»`);
  // lead/callback forms: CallbackForm (cb-card form) and RequestWizard (#rq-submit)
  const forms = (h.match(/class="cb-card"/g) ?? []).length + (h.match(/id="rq-submit"/g) ?? []).length;
  const consent = h.split(CONSENT_TEXT).length - 1;
  if (forms > 0 && consent < forms) errors.push(`${rel}: ${forms} lead/callback form(s) but ${consent} consent text(s)`);
}

const CALC = 'مبلغی که ماشین‌حساب نشون می‌ده، مبلغیه که به دستت می‌رسه، و جزئیات دقیقش رو کارشناس توی مشاوره‌ی رایگان توضیح می‌ده.';
const calc = html('calculator');
if (calc) {
  const ld = [...calc.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const j = JSON.parse(m[1]);
    return Array.isArray(j) ? j : [j];
  });
  const faq = ld.find((d) => d['@type'] === 'FAQPage');
  const body = calc.replace(/<script[\s\S]*?<\/script>/g, '');
  if (!body.includes(CALC)) errors.push('calculator: exact FAQ answer missing from the page');
  if (!faq?.mainEntity?.some((q) => q.acceptedAnswer?.text === CALC)) errors.push('calculator: exact FAQ answer missing from FAQPage JSON-LD');
  const visibleQ = [...body.matchAll(/<details><summary><span>([^<]*)<\/span>/g)].map((m) => m[1]);
  const ldQ = faq?.mainEntity?.map((q) => q.name) ?? [];
  if (visibleQ.join('|') !== ldQ.join('|')) errors.push(`calculator: visible FAQ [${visibleQ}] ≠ JSON-LD [${ldQ}]`);
  if (/مبلغ اسمی/.test(body)) errors.push('calculator: still mentions «مبلغ اسمی»');
}

// LAUNCH (PM 2026-10-23): one landline everywhere (۰۲۱-۹۱۳۰۳۸۱۹ / tel:+982191303819), no old number;
// plan and result cards never show the nominal amount (only مبلغ دریافتی / مبلغ هر قسط / تعداد اقساط).
const WRONG_PHONE = /91090380|۹۱۰۹۰۳۸۰|tel:0(?!9)\d/;
for (const f of walk(DIST).filter((x) => /\.(html|js|xml|txt|json|webmanifest)$/.test(x))) {
  const t = readFileSync(f, 'utf8');
  const rel = relative(DIST, f);
  if (WRONG_PHONE.test(t)) errors.push(`${rel}: old/unnormalised landline (${t.match(WRONG_PHONE)[0]})`);
  if (/مبلغ اسمی وام:/.test(t)) errors.push(`${rel}: a card still shows «مبلغ اسمی وام»`);
}
const home = html('');
if (home && !home.includes('tel:+982191303819')) errors.push('home: landline tel:+982191303819 missing');
if (home && !home.includes('۰۲۱-۹۱۳۰۳۸۱۹')) errors.push('home: landline ۰۲۱-۹۱۳۰۳۸۱۹ missing');
// PM decision: the office address is shown in the footer (every page), /contact, /about and the PostalAddress schema
const ADDRESS = 'تهران، پونک، بلوار عدل جنوبی، پلاک ۲۴، واحد ۲';
for (const slug of ['', 'contact', 'about']) {
  const t = html(slug);
  if (!t) continue;
  const n = t.split(`data-address>${ADDRESS}</address>`).length - 1;
  if (n < (slug ? 2 : 1)) errors.push(`${slug || 'home'}: visible address missing (found ${n}${slug ? ', need footer + page' : ''})`);
  if (!/"@type":"PostalAddress"/.test(t) || !t.includes('"streetAddress":"پونک، بلوار عدل جنوبی، پلاک ۲۴، واحد ۲"')) errors.push(`${slug || 'home'}: PostalAddress schema missing`);
}
// home canonical must equal the sitemap loc (https://nafisvam.com/)
if (home && !home.includes('<link rel="canonical" href="https://nafisvam.com/">')) errors.push('home: canonical is not https://nafisvam.com/ (sitemap loc)');

if (errors.length) {
  console.error(`guarantees: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(
  'guarantees: OK — ' +
    Object.entries(seen)
      .map(([p, ids]) => `${p} [${ids.join(',') || '—'}]`)
      .join(' · ') +
    ` · no «سپرده» anywhere (${files.length} pages) · consent text on every form · calculator FAQ exact · landline ۰۲۱-۹۱۳۰۳۸۱۹ only · address + PostalAddress · home canonical = sitemap · no nominal amount on cards`,
);

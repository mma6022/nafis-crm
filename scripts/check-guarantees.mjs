#!/usr/bin/env node
// P3 content guard (runs in build + build:preview, after astro build):
//  1. Guarantee pages list EXACTLY the plans that truly meet the page condition. The rule is re-implemented here from
//     the raw guaranteeOptions (independent of lib/plans.ts) and must also equal the CONFIRMED table below, which is
//     Mohammad's 2026-10-23 answers. A mismatch anywhere fails the build.
//  2. Plan 17 only on /vam-bedun-zamen and always with its credit-score phrase; retiree-only plans carry their tag.
//  3. «سپرده» appears nowhere in dist (blog included).
//  4. /calculator FAQ answer is verbatim in the page AND its FAQPage JSON-LD, and the page never says «مبلغ اسمی».
//  5. Every lead/callback form in dist shows the exact consent text.
//  6. Fast sections (PM 2026-10-23): never empty; the fastest ≤3 plans meeting the base condition, ordered by real
//     grantDays (ties by id), retiree tag kept, no time promise on /vam-bedun-chek and /vam-bedun-zamen, callback form below.
//     Post-launch PM rule for «سریع‌ترین بدون ضامن» (fast-no-guarantor): ONE plan per plan type (loanType), the highest
//     مبلغ دریافتی obtainable WITHOUT a guarantor (min(principal, no-guarantor cap) × depositPercent, max over its
//     terms; PM 2026-10-23: plan 9 is no-guarantor only up to ۳۰۰ میلیون) of that type, no repeated plan name (parenthetical
//     notes ignored, «ترنم ( بازنشسته ها )» = «ترنم»): a type whose best plan repeats a shown name takes its next best.
//     Page-restricted plans (17, pages ['no-guarantor']) stay out of the fast section.
//     Every fast section fails the build if two rows show the same plan name.
//  7. Plan cards everywhere: only مبلغ دریافتی / مبلغ هر قسط / تعداد اقساط + one «درخواست این طرح» button.
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
  /** one per type, highest مبلغ دریافتی WITHOUT a guarantor, IN THIS ORDER (goods: 19 چابک 214M — 9 مروارید is
   *  capped at ۳۰۰ میلیون without a guarantor → 174M; score: 15 نیلوفر 165M — 17 is restricted to the main list) */
  'fast-no-guarantor': [19, 15],
  'no-cheque': [15, 20, 21],
  /** fastest ≤3 qualifying plans (all 10_to_15 → ties by id) */
  'fast-no-cheque': [15, 20, 21],
  cheque: [1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 18, 19, 22],
  promissory: [20],
};
const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const expected = {};
const RANK = { under_7: 0, '10_to_15': 1 };
/** independent re-implementation of lib/plans topPlanPerType */
const baseName = (n) => {
  let s = String(n).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (!s.startsWith('طرح')) s = `طرح ${s}`;
  return s;
};
const payout = (p) => {
  const principal = Math.min(p.principalAmount, p.noGuarantorMaxPrincipal > 0 ? p.noGuarantorMaxPrincipal : Infinity);
  return Math.max(0, ...p.installmentTerms.map((t) => (principal * t.depositPercent) / 100));
};
/** the cap must be the number the public «بدون ضامن تا سقف (وام) N میلیون» text states, and vice versa */
const faNum = (s) => Number(String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
for (const p of plans) {
  const text = [p.guaranteeSummary ?? ''].join(' ');
  const m = text.match(/بدون ضامن تا سقف(?: وام)? ([۰-۹0-9]+) میلیون/);
  const stated = m ? faNum(m[1]) * 1e6 : undefined;
  if (stated !== p.noGuarantorMaxPrincipal)
    errors.push(`plan ${p.id}: no-guarantor cap ${p.noGuarantorMaxPrincipal ?? '—'} does not match its text (${stated ?? '—'})`);
}
const TYPE_ORDER = ['goods', 'score'];
const perType = (q) => {
  const r = (t) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);
  const types = [...new Set(q.map((p) => p.loanType))].sort((a, b) => r(a) - r(b) || a.localeCompare(b));
  const used = new Set();
  const out = [];
  for (const t of types) {
    const best = q
      .filter((p) => p.loanType === t && !used.has(baseName(p.name)))
      .sort((a, b) => payout(b) - payout(a) || (RANK[a.grantDays] ?? 9) - (RANK[b.grantDays] ?? 9) || a.id - b.id)[0];
    if (!best || out.length >= 3) continue;
    used.add(baseName(best.name));
    out.push(best.id);
  }
  return out;
};
for (const [page, def] of Object.entries(PAGES)) {
  const base = def.fast ? def.rule : page;
  const q = plans
    .filter((p) => p.guaranteeOptions?.length)
    .filter((p) => !p.guaranteePages || p.guaranteePages.includes(base))
    .filter((p) => p.guaranteeOptions.some(RULE[def.rule]));
  expected[page] = page === 'fast-no-guarantor'
    ? perType(q.filter((p) => !p.guaranteePages || p.guaranteePages.includes(page)))
    : def.fast
    ? q.sort((a, b) => (RANK[a.grantDays] ?? 9) - (RANK[b.grantDays] ?? 9) || a.id - b.id).slice(0, 3).map((p) => p.id)
    : uniq(q.map((p) => p.id));
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
  const ids = def.fast ? rows : uniq(rows);
  seen[page] = ids;
  if (rows.length !== uniq(rows).length) errors.push(`${def.file} [${page}]: a plan is listed twice`);
  if (!same(ids, expected[page])) errors.push(`${def.file} [${page}]: lists [${ids}] but expected [${expected[page]}]`);
  if (ids.length === 0 && !/data-count="0"/.test(b)) errors.push(`${def.file} [${page}]: empty list without the empty state`);
  if (def.fast) {
    if (ids.length === 0 || ids.length > 3) errors.push(`${def.file} [${page}]: fast section must list 1–3 plans (has ${ids.length})`);
    if (/gplans-empty/.test(b)) errors.push(`${def.file} [${page}]: fast section ships an empty state`);
    if (!/class="cb-card"/.test(b) && !/درخواست مشاوره‌ی رایگان/.test(b)) errors.push(`${def.file} [${page}]: no callback form below the fast list`);
    // no plan name twice in a fast section (rendered name, «(bank / platform)» and other notes ignored)
    const shown = [...b.matchAll(/<b class="gp-name"[^>]*>([\s\S]*?)<\/b>/g)].map((m) => baseName(m[1].replace(/<span[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '')));
    if (shown.length !== ids.length) errors.push(`${def.file} [${page}]: ${ids.length} rows but ${shown.length} plan names`);
    const dupName = shown.find((n, i) => shown.indexOf(n) !== i);
    if (dupName) errors.push(`${def.file} [${page}]: plan name «${dupName}» shown twice in the fast section`);
    if (page === 'fast-no-guarantor') {
      const types = ids.map((id) => plans.find((x) => x.id === id)?.loanType);
      if (new Set(types).size !== types.length) errors.push(`${def.file} [${page}]: more than one plan of the same type [${types}]`);
    }
  }
  for (const id of ids) {
    const row = b.split(`data-plan-id="${id}"`)[1]?.split('data-plan-id=')[0] ?? '';
    const p = plans.find((x) => x.id === id);
    if (id === 17 && !/رتبه‌ی اعتباری/.test(row)) errors.push(`${def.file}: plan 17 row lacks the credit-score phrase`);
    if (p?.retireesOnly && !/ویژه‌ی بازنشستگان/.test(row)) errors.push(`${def.file}: plan ${id} row lacks «ویژه‌ی بازنشستگان»`);
  }
}
// no time promise anywhere on the no-cheque / no-guarantor pages (they hold the fast sections)
for (const slug of ['vam-bedun-chek', 'vam-bedun-zamen']) {
  // page content only: the site header menu describes /vam-fori (its own page), not these pages
  const body = html(slug).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<header[\s\S]*?<\/header>/g, '');
  const m = body.match(/کمتر از [۰-۹0-9]+ روز|[۰-۹0-9]+ تا [۰-۹0-9]+ روز|زمان بررسی:/);
  if (m) errors.push(`${slug}: promises a review time («${m[0]}»)`);
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

 // plan cards (PlanCard, data-plan-card) and blog mini cards: only the 3 figures + one «درخواست این طرح» button
let cardCount = 0;
for (const f of files) {
  const h = readFileSync(f, 'utf8');
  const rel = relative(DIST, f);
  for (const m of h.matchAll(/<article class="nf-card plan[^"]*"[^>]*>([\s\S]*?)<\/article>|<div class="nf-card mini">([\s\S]*?)<\/a><\/div>/g)) {
    const card = m[1] ?? m[2];
    cardCount++;
    for (const bad of ['زمان بررسی', 'روش', 'جزئیات بیشتر', 'مبلغ اسمی', 'مبلغ قابل دریافت', 'پیش‌پرداخت', 'سود سالانه'])
      if (card.includes(bad)) errors.push(`${rel}: a plan card shows «${bad}»`);
    for (const need of ['مبلغ دریافتی', 'مبلغ هر قسط', 'تعداد اقساط'])
      if (!card.includes(need)) errors.push(`${rel}: a plan card lacks «${need}»`);
    const btns = (card.match(/<a [^>]*nf-btn/g) ?? []).length;
    if (btns !== 1 || !card.includes('درخواست این طرح')) errors.push(`${rel}: a plan card must have exactly one «درخواست این طرح» button (has ${btns})`);
  }
}
if (cardCount === 0) errors.push('no plan cards found in dist (hero sample / plans page)');

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
// Trailing slash (nginx 301s /contact → /contact/): every canonical, og:url and sitemap <loc> is the served form.
for (const f of walk(DIST).filter((x) => x.endsWith('.html') && !x.endsWith('/404.html'))) {
  const t = readFileSync(f, 'utf8');
  const rel = relative(DIST, f);
  for (const m of t.matchAll(/<link rel="canonical" href="([^"]+)"|<meta property="og:url" content="([^"]+)"/g)) {
    const u = m[1] ?? m[2];
    if (!u.endsWith('/')) errors.push(`${rel}: canonical/og:url without trailing slash (${u})`);
  }
}
for (const f of walk(DIST).filter((x) => /sitemap-\d+\.xml$/.test(x))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) if (!m[1].endsWith('/')) errors.push(`${relative(DIST, f)}: <loc> without trailing slash (${m[1]})`);
}

if (errors.length) {
  console.error(`guarantees: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(
  'guarantees: OK — ' +
    Object.entries(seen)
      .map(([p, ids]) => `${p} [${ids.join(',') || '—'}]`)
      .join(' · ') +
    ` · no «سپرده» anywhere (${files.length} pages) · consent text on every form · calculator FAQ exact · landline ۰۲۱-۹۱۳۰۳۸۱۹ only · address + PostalAddress · home canonical = sitemap · canonical/og:url/sitemap locs end with / · fast sections: no-guarantor = 1 per type by max مبلغ دریافتی without a guarantor (caps from data), no-cheque = fastest ≤3, no repeated name, + callback, no time promise · ${cardCount} plan cards = 3 figures + one button`,
);

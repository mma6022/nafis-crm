#!/usr/bin/env node
// Copy guard (Mohammad 2026-10-23, runs in build + build:preview after astro build):
//  1. «برآوردی» / «تخمینی» may not appear in dist except in the explicit ALLOW list below (FAQ answers and the legal
//     terms page, i.e. places that answer «is the number final?»). Nothing explanatory next to the calculator / plan
//     cards: the removed note «مبالغ برآوردی است و مبلغ/رقم قطعی …» fails the build anywhere (dist and src).
//  2. No national ID / registration number: 14013708689 in Latin, Persian or Arabic digits (any separators) fails the
//     build in dist, src and public. The footer shows the legal name «بهینه فام نفیس» only.
// Run: node scripts/check-copy.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const errors = [];
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
if (!existsSync(join(DIST, 'index.html'))) { console.error('copy: dist/ not built'); process.exit(1); }

/** dist file → exact phrases (each containing the word) that are allowed there. Anything else fails. */
const ALLOW = {
  'calculator/index.html': ['نه. اعداد برآوردی است و مبلغ قطعی پس از اعتبارسنجی اعلام می‌شود.'], // FAQ (verbatim-guarded by check-guarantees #4), visible + FAQPage JSON-LD
  'faq/index.html': ['این عدد برآوردی است و مبلغ قطعی پس از اعتبارسنجی اعلام می‌شود'], // FAQ answer «محاسبه‌گر قسط»
  'blog/vam-fori-chist/index.html': ['این ارقام برآوردی است.'], // blog FAQ answer (plan example)
  'terms/index.html': ['اعداد سایت برآوردی است', 'ماشین‌حساب و طرح‌یاب می‌بینید برآوردی است.'], // legal terms
};
const WORD = /برآوردی|تخمینی/g;
const REMOVED = /مبالغ\s*برآوردی\s*است\s*و\s*(مبلغ|رقم)\s*قطعی/;
const hits = [];
for (const f of walk(DIST).filter((x) => /\.(html|js|mjs|json|txt|xml)$/.test(x))) {
  const rel = relative(DIST, f);
  let t = readFileSync(f, 'utf8');
  if (REMOVED.test(t)) errors.push(`dist/${rel}: removed note «مبالغ برآوردی است …» is back`);
  for (const p of ALLOW[rel] || []) {
    const n = t.split(p).length - 1;
    if (n) hits.push(`${rel} ×${n}: «${p}»`);
    t = t.split(p).join('');
  }
  for (const m of t.matchAll(WORD)) errors.push(`dist/${rel}: «${m[0]}» not in allow list (…${t.slice(Math.max(0, m.index - 50), m.index + 30).replace(/\s+/g, ' ')}…)`);
}
for (const f of walk(join(ROOT, 'src')).filter((x) => /\.(astro|tsx?|mdx?|json)$/.test(x)))
  if (REMOVED.test(readFileSync(f, 'utf8'))) errors.push(`${relative(ROOT, f)}: removed note «مبالغ برآوردی است …» is back`);

// 2. national ID (digits built at runtime so this file never contains the number itself)
const DIGIT = { 0: '0۰٠', 1: '1۱١', 2: '2۲٢', 3: '3۳٣', 4: '4۴٤', 5: '5۵٥', 6: '6۶٦', 7: '7۷٧', 8: '8۸٨', 9: '9۹٩' };
const SEP = '[\\s\\-.\u200c\u200f\u200e\u00a0()/]{0,3}';
const ID = ['1401', '3708', '689'].join('');
const ID_RE = new RegExp(ID.split('').map((d) => `[${DIGIT[d]}]`).join(SEP));
const toFa = (s) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
for (const s of [ID, toFa(ID), '1401-3708-689', toFa('1401 3708 689')]) if (!ID_RE.test(s)) errors.push(`national-id matcher misses ${JSON.stringify(s)}`);
let idScanned = 0;
for (const f of [...walk(DIST), ...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public'))].filter((x) => /\.(html|js|mjs|css|xml|txt|json|webmanifest|svg|astro|tsx?|mdx?|ya?ml)$/.test(x))) {
  idScanned++;
  const t = readFileSync(f, 'utf8');
  if (ID_RE.test(t)) errors.push(`${relative(ROOT, f)}: national ID present`);
  if (/شناسه\s*ملی|شماره\s*ثبت/.test(t) && !f.includes('/scripts/')) errors.push(`${relative(ROOT, f)}: «شناسه ملی/شماره ثبت» label present`);
}
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!home.includes('<p class="legal-id">بهینه فام نفیس</p>')) errors.push('footer: legal line is not exactly «بهینه فام نفیس»');


// 4) اینماد: self-hosted badge only. Exactly this link (allowed external link), our /images/enamad.png, no external seal script/img.
const ENAMAD_LINK = 'href="https://trustseal.enamad.ir/?id=734294" target="_blank" rel="noopener" referrerpolicy="origin"';
if (!existsSync(join(DIST, 'images', 'enamad.png'))) errors.push('enamad: dist/images/enamad.png missing');
for (const f of walk(DIST).filter((p) => p.endsWith('.html'))) {
  const h = readFileSync(f, 'utf8'); const rel = f.slice(DIST.length + 1);
  if (/trustseal\.enamad\.ir\/(logo\.aspx|[^"']*\.js)|<script[^>]+enamad/i.test(h)) errors.push(`enamad: external seal image/script in ${rel}`);
  for (const m of h.matchAll(/href="https?:\/\/trustseal\.enamad\.ir[^"]*"[^>]*/g)) if (!m[0].startsWith(ENAMAD_LINK)) errors.push(`enamad: unexpected trustseal link in ${rel}: ${m[0].slice(0, 120)}`);
  if (h.includes('class="legal-id"') && !h.includes(`<a class="enamad" ${ENAMAD_LINK}><img src="/images/enamad.png" alt="نماد اعتماد الکترونیکی"`)) errors.push(`enamad: footer badge missing in ${rel}`);
}
if (!home.includes(`<a class="t t-enamad" ${ENAMAD_LINK}><img src="/images/enamad.png"`)) errors.push('enamad: home trust-bar chip missing');
if (errors.length) { console.error(`copy: ${errors.length} problem(s)\n  ` + errors.join('\n  ')); process.exit(1); }
console.log(`copy: OK — no «برآوردی/تخمینی» outside the allow list; allowed hits: ${hits.join(' · ')} · removed note absent (dist+src) · no national ID / registration label in ${idScanned} dist+src+public files · footer legal line = «بهینه فام نفیس»`);

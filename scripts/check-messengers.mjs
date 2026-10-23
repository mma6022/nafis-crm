#!/usr/bin/env node
// Expert picker + messenger links (Mohammad / PM 2026-10-23; design Armita CONTACT-EXPERTS.md). Run with
// `node --experimental-strip-types --import ./tests/ts-resolve.mjs` (reads src/data/experts.ts).
// The site has NO generic WhatsApp / Telegram / Bale link. Messenger + tel: links to experts exist ONLY in (a) the shared
// picker <dialog id="xp"> (on every page) and (b) the /contact «کارشناسان فروش» block <section id="experts">.
// Fails on:
// - any wa.me / api.whatsapp.com / whatsapp:// / t.me / telegram.me / ble.ir link anywhere in dist/ or src/ outside
//   those blocks (or outside the expertLink() templates in src/data/experts.ts);
// - inside them: a link that is not exactly the expected expert link (strict format: tel:+989…, wa.me/989…?text=PREFILL,
//   t.me/+989…|username ?text=PREFILL, ble.ir/989…|username; ble.ir/+… is a 404), a missing one, or a row for a channel
//   the expert does not have (hide rule);
// - picker: names not exactly «خانم قاسمی»، «خانم حسنی»، «آقای کاظمی» in that order, title / hours line / aria missing,
//   a raw expert phone number in visible text or labels (any digit script);
// - triggers: unknown data-experts, a trigger for a channel no expert has, no role=button or /contact/#experts fallback;
// - mobile bar «تماس» / «واتساپ» not opening the picker; Instagram not https://instagram.com/nafisvamm;
// - the mockup placeholder «جای‌خالی» anywhere in dist/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALL_CHANNELS, EXPERTS, PICKER_HOURS, PICKER_TITLE, PREFILL, expertLink, hasChannel } from '../src/data/experts.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const MSG = /(?:https?:)?\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com|t\.me|telegram\.me|ble\.ir)\b[^\s"'<>`)]*|\b(?:whatsapp|tg|bale):\/\/[^\s"'<>`)]*/gi;
const HREF = /href="((?:tel:|https:\/\/(?:wa\.me|t\.me|ble\.ir)\/)[^"]*)"/g;
const NAMES = ['خانم قاسمی', 'خانم حسنی', 'آقای کاظمی'];
const INSTAGRAM = 'https://instagram.com/nafisvamm';
const enc = encodeURIComponent(PREFILL);
const FORMAT = {
  call: /^tel:\+989\d{9}$/,
  whatsapp: new RegExp(`^https://wa\\.me/989\\d{9}\\?text=${enc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  telegram: new RegExp(`^https://t\\.me/(?:\\+989\\d{9}|[A-Za-z][A-Za-z0-9_]{4,31})\\?text=${enc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  bale: /^https:\/\/ble\.ir\/(?:989\d{9}|[A-Za-z][A-Za-z0-9_]{4,31})$/,
};
const amp = (s) => s.replace(/&amp;/g, '&');
const errors = [];

// 0) data sanity
if (EXPERTS.map((e) => e.name).join('|') !== NAMES.join('|')) errors.push(`src/data/experts.ts: names/order must be ${NAMES.join('، ')}`);
const expected = new Set();
for (const e of EXPERTS)
  for (const ch of ALL_CHANNELS) {
    const l = expertLink(e, ch);
    if (!l) continue;
    if (!FORMAT[ch].test(l)) errors.push(`src/data/experts.ts: ${e.name} ${ch} link has a bad format: ${l}`);
    expected.add(l);
  }
const DIGITS = ['0123456789', '۰۱۲۳۴۵۶۷۸۹', '٠١٢٣٤٥٦٧٨٩'];
const rawNumberRes = EXPERTS.flatMap((e) => [e.phone, e.whatsapp, e.telegram, e.bale])
  .filter((v) => v && /^09\d{9}$/.test(v))
  .map((v) => v.slice(1)) // 9003400452 (also matches 0900…, +98 900…)
  .filter((v, i, a) => a.indexOf(v) === i)
  .map((v) => new RegExp(v.split('').map((d) => `[${DIGITS.map((s) => s[+d]).join('')}]`).join('[\\s\\-.\u200c\u00a0]{0,2}')));
const visible = (h) =>
  amp(h.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ').replace(/\bhref="[^"]*"/g, '').replace(/<[^>]+>/g, ' '));

// checks the links of one allowed block against the data; `scope` labels errors
function checkBlock(rel, scope, html) {
  const found = [...html.matchAll(HREF)].map((m) => amp(m[1]));
  for (const l of found) if (!expected.has(l)) errors.push(`${rel} ${scope}: link is not an expected expert link: ${l}`);
  for (const l of html.match(MSG) ?? []) if (!expected.has(amp(l))) errors.push(`${rel} ${scope}: generic / unknown messenger link: ${l}`);
  for (const l of expected) if (!found.includes(l)) errors.push(`${rel} ${scope}: missing ${l}`);
  for (const re of rawNumberRes) if (re.test(visible(html))) errors.push(`${rel} ${scope}: raw expert phone number shown (${re.source.slice(0, 20)}…)`);
}

// 1) built output
const textFiles = walk(DIST).filter((f) => /\.(html|js|mjs|css|xml|txt|json|webmanifest|svg)$/.test(f));
let pickerPages = 0;
let triggers = 0;
for (const f of textFiles) {
  const rel = relative(DIST, f);
  let t = readFileSync(f, 'utf8');
  if (/جای[\u200c\s]?خالی/.test(t)) errors.push(`${rel}: mockup placeholder «جای‌خالی» in the build`);
  if (rel.endsWith('.html')) {
    const dlg = t.match(/<dialog id="xp"[\s\S]*?<\/dialog>/)?.[0];
    if (dlg) {
      pickerPages++;
      checkBlock(rel, 'picker', dlg);
      // hide rule: a row exists for (expert, channel) iff the data has the link; names exact and in order
      const names = [...dlg.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1].trim()).filter((n, i, a) => a.indexOf(n) === i);
      if (names.join('|') !== NAMES.join('|')) errors.push(`${rel} picker: names/order ${names.join('، ')} ≠ ${NAMES.join('، ')}`);
      for (const ch of ALL_CHANNELS) {
        const rows = (dlg.match(new RegExp(`data-ch="${ch}"`, 'g')) ?? []).length;
        const want = EXPERTS.filter((e) => expertLink(e, ch)).length;
        if (rows !== want) errors.push(`${rel} picker: ${rows} ${ch} rows, data has ${want}`);
      }
      if (!dlg.includes(PICKER_TITLE)) errors.push(`${rel} picker: title «${PICKER_TITLE}» missing`);
      if (!dlg.includes(PICKER_HOURS)) errors.push(`${rel} picker: hours line «${PICKER_HOURS}» missing`);
      if (!/aria-modal="true"/.test(dlg) || !/aria-labelledby="xp-h"/.test(dlg) || !/aria-describedby="xp-via"/.test(dlg))
        errors.push(`${rel} picker: aria-modal / aria-labelledby / aria-describedby missing`);
      t = t.replace(dlg, '');
    } else if (/data-experts=/.test(t)) errors.push(`${rel}: has expert-picker triggers but no <dialog id="xp">`);
    for (const m of t.matchAll(/<a\b[^>]*\bdata-experts="([^"]*)"[^>]*>/g)) {
      if (!ALL_CHANNELS.includes(m[1])) errors.push(`${rel}: unknown data-experts="${m[1]}"`);
      else if (!hasChannel(m[1])) errors.push(`${rel}: trigger for «${m[1]}» but no expert has that channel`);
      if (!/href="\/contact\/#experts"/.test(m[0])) errors.push(`${rel}: picker trigger without the /contact/#experts fallback href`);
      if (!/role="button"/.test(m[0])) errors.push(`${rel}: picker trigger without role="button"`);
      triggers++;
    }
    if (rel === 'contact/index.html') {
      const block = t.match(/<section[^>]*\bid="experts"[^>]*>[\s\S]*?<\/section>/)?.[0];
      if (!block) errors.push('contact: «کارشناسان فروش» block <section id="experts"> missing');
      else {
        checkBlock(rel, '#experts', block);
        t = t.replace(block, '');
      }
    }
    for (const re of rawNumberRes) if (re.test(visible(t))) errors.push(`${rel}: raw expert phone number in visible text`);
    for (const m of t.matchAll(/href="(https?:\/\/(?:www\.)?instagram\.com[^"]*)"/g)) if (m[1] !== INSTAGRAM) errors.push(`${rel}: Instagram link ${m[1]} ≠ ${INSTAGRAM}`);
    for (const m of t.matchAll(/href="(tel:[^"]*)"/g)) errors.push(`${rel}: tel: link outside the picker / contact#experts: ${m[1]}`);
  }
  for (const l of t.match(MSG) ?? []) errors.push(`${rel}: messenger link outside the picker / contact#experts: ${l}`);
}
if (!textFiles.some((f) => relative(DIST, f) === 'contact/index.html')) errors.push('dist/contact/index.html missing');

// the mobile bar «تماس» / «واتساپ» open the picker
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
const bar = home.match(/<nav class="bar"[\s\S]*?<\/nav>/)?.[0] ?? '';
if (!/data-experts="call"[^>]*>[\s\S]*?تماس/.test(bar)) errors.push('home: mobile bar «تماس» does not open the expert picker (call)');
if (hasChannel('whatsapp') && !/data-experts="whatsapp"[^>]*>[\s\S]*?واتساپ/.test(bar)) errors.push('home: mobile bar «واتساپ» does not open the expert picker (whatsapp)');
if (!home.includes(`href="${INSTAGRAM}"`)) errors.push(`home: footer Instagram ${INSTAGRAM} missing`);
const pagesN = textFiles.filter((f) => f.endsWith('.html')).length;
if (pickerPages < pagesN - 2) errors.push(`expert picker only on ${pickerPages}/${pagesN} pages`);

// 2) source: messenger URLs only in the expertLink() templates (and comments) of src/data/experts.ts
const srcFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public'))].filter((f) => /\.(astro|tsx?|jsx?|mdx?|json|ya?ml|xml|txt|html|css)$/.test(f));
for (const f of srcFiles) {
  const rel = relative(ROOT, f);
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const l of line.match(MSG) ?? []) {
        const ok = rel === 'src/data/experts.ts' && (/^\s*(?:if \(.*\) )?return `https:\/\/(?:wa\.me|t\.me|ble\.ir)\/\+?\$\{/.test(line) || /^\s*(\*|\/\/)/.test(line));
        if (!ok) errors.push(`${rel}:${i + 1}: messenger link outside src/data/experts.ts expertLink(): ${l}`);
      }
    });
}

if (errors.length) {
  console.error(`messengers: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
const per = ALL_CHANNELS.map((ch) => `${ch} ${EXPERTS.filter((e) => expertLink(e, ch)).length}`).join(' · ');
console.log(
  `messengers: OK — expert picker on ${pickerPages}/${pagesN} pages (${NAMES.join('، ')}; ${per}; strict formats, prefill on wa/tg, no raw numbers, title + hours + aria), ` +
    `${triggers} triggers (role=button, /contact/#experts fallback, only channels that exist); no generic / other messenger or tel: links in ${textFiles.length} dist files / ${srcFiles.length} source files; ` +
    `bar «تماس»/«واتساپ» open the picker; Instagram ${INSTAGRAM}; no «جای‌خالی»`,
);

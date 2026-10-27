#!/usr/bin/env node
// No call / messenger entry point anywhere (HANDOFF §0 v1.2 #13, Mohammad 2026-10-28: «شماره نمایش داده نشه، فقط فرم
// درخواست»). The only contact paths are the «درخواست مشاوره‌ی رایگان» callback form (/contact/#callback) and /request/.
// Fails on, in dist/ (html/js/css/xml/json/txt) and src/ + public/:
// - tel: / sms: / whatsapp: / tg: / bale: links, wa.me / api.whatsapp.com / t.me / telegram.me / ble.ir URLs;
// - the old expert picker (<dialog id="xp">, data-experts, /contact/#experts, <section id="experts">);
// - a raw Iranian mobile (09…, +989…, 00989…) or Tehran-style landline (021 + 8 digits) in visible text, in any digit
//   script, with spaces / dashes / ZWNJ between digits (the form-hint example ۰۹۱۲۳۴۵۶۷۸۹ is allowed);
// - «تماس با کارشناس», «واتساپ», «تلگرام» in visible text; «تماس» / «واتساپ» / «تلگرام» / «بله» in an aria-label or
//   title, or «تماس» inside a <nav> (menu label is «ارتباط با ما»);
// - CALLBACK_WHATSAPP not empty; Instagram not https://instagram.com/nafisvamm; the mockup placeholder «جای‌خالی».
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const MSG = /(?:https?:)?\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com|t\.me|telegram\.me|ble\.ir)\b[^\s"'<>`)]*|\b(?:whatsapp|tg|bale):\/?\/?[^\s"'<>`)]*/gi;
const LINK = /href="((?:tel|sms|whatsapp|tg|bale):[^"]*)"/gi;
const INSTAGRAM = 'https://instagram.com/nafisvamm';
const D = '[0-9۰-۹٠-٩]';
const SEP = '[\\s\\-.\u200c\u00a0]{0,2}';
const dig = (n) => Array(n).fill(D).join(SEP);
const nine = '[9۹٩]';
const zero = '[0۰٠]';
const MOBILE = new RegExp(`(?:(?:\\+|${zero}${zero})[9۹٩][8۸٨]${SEP}|${zero})${nine}${SEP}${dig(9)}(?!${D})`);
const LANDLINE = new RegExp(`${zero}[2۲٢][1۱١]${SEP}${dig(8)}(?!${D})`);
/** the mobile-format example in the form validation hint («مثل ۰۹۱۲۳۴۵۶۷۸۹») is not a contact number */
const EXAMPLE = /[0۰]9123456789|۰۹۱۲۳۴۵۶۷۸۹/g;
const amp = (s) => s.replace(/&amp;/g, '&');
const visible = (h) => amp(h.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' '));
const errors = [];

const textFiles = walk(DIST).filter((f) => /\.(html|js|mjs|css|xml|txt|json|webmanifest|svg)$/.test(f));
let pages = 0;
for (const f of textFiles) {
  const rel = relative(DIST, f);
  const t = readFileSync(f, 'utf8');
  if (/جای[\u200c\s]?خالی/.test(t)) errors.push(`${rel}: mockup placeholder «جای‌خالی» in the build`);
  for (const l of t.match(MSG) ?? []) errors.push(`${rel}: messenger link: ${l}`);
  if (!rel.endsWith('.html')) continue;
  pages++;
  for (const m of t.matchAll(LINK)) errors.push(`${rel}: call / messenger link ${m[1]}`);
  if (/<dialog[^>]*id="xp"/.test(t)) errors.push(`${rel}: old expert picker <dialog id="xp">`);
  if (/data-experts=/.test(t)) errors.push(`${rel}: expert-picker trigger (data-experts)`);
  if (/\/contact\/?#experts|id="experts"/.test(t)) errors.push(`${rel}: link / section #experts`);
  const vis = visible(t).replace(EXAMPLE, ' ');
  if (MOBILE.test(vis)) errors.push(`${rel}: raw mobile number in visible text («${vis.match(MOBILE)[0]}»)`);
  if (LANDLINE.test(vis)) errors.push(`${rel}: raw landline number in visible text`);
  for (const w of ['تماس با کارشناس', 'واتساپ', 'تلگرام']) if (vis.includes(w)) errors.push(`${rel}: visible «${w}»`);
  for (const m of t.matchAll(/\b(aria-label|title)="([^"]*)"/g))
    if (/تماس|واتساپ|تلگرام|(^|[\s«])بله([\s»]|$)/.test(m[2])) errors.push(`${rel}: ${m[1]}="${m[2]}"`);
  for (const nav of t.match(/<nav\b[\s\S]*?<\/nav>/g) ?? []) if (visible(nav).includes('تماس')) errors.push(`${rel}: «تماس» inside a <nav>`);
  for (const m of t.matchAll(/href="(https?:\/\/(?:www\.)?instagram\.com[^"]*)"/g)) if (m[1] !== INSTAGRAM) errors.push(`${rel}: Instagram link ${m[1]} ≠ ${INSTAGRAM}`);
}
if (!textFiles.some((f) => relative(DIST, f) === 'contact/index.html')) errors.push('dist/contact/index.html missing');
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!home.includes(`href="${INSTAGRAM}"`)) errors.push(`home: footer Instagram ${INSTAGRAM} missing`);
const contact = readFileSync(join(DIST, 'contact/index.html'), 'utf8');
if (!/id="callback"/.test(contact)) errors.push('contact: #callback form missing');

// source: no messenger URL / call link outside comments
const srcFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public'))].filter((f) => /\.(astro|tsx?|jsx?|mdx?|json|ya?ml|xml|txt|html|css)$/.test(f));
for (const f of srcFiles) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    for (const l of line.match(MSG) ?? []) if (!/\.test\(|=>\s*\/|RegExp/.test(line)) errors.push(`${rel}:${i + 1}: messenger link ${l}`);
    if (/href=["'{`]+(tel|sms):/.test(line)) errors.push(`${rel}:${i + 1}: tel:/sms: link`);
  });
}
const site = readFileSync(join(ROOT, 'src/lib/site.ts'), 'utf8');
if (!/export const CALLBACK_WHATSAPP = '';/.test(site)) errors.push("src/lib/site.ts: CALLBACK_WHATSAPP must stay ''");

if (errors.length) {
  console.error(`messengers: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(
  `messengers: OK — no tel:/sms:/messenger links, no picker, no raw numbers, no «تماس با کارشناس»/واتساپ/تلگرام in text, aria/title or nav ` +
    `on ${pages} pages / ${textFiles.length} dist files / ${srcFiles.length} source files; /contact #callback; Instagram ${INSTAGRAM}; no «جای‌خالی»`,
);

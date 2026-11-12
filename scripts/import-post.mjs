#!/usr/bin/env node
// Re-import a blog post from the content hand-off folder and lint it against the site's copy rules (one command):
//   node scripts/import-post.mjs [src.mdx] [--check-only]
// default src = /workspace/nafis-content/blog-sefr-ta-sad/post.mdx → src/content/blog/<frontmatter slug>.mdx
// Refuses post.v1.mdx (superseded). Exits 1 on any rule hit; then run `npm run build && npm test`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { stripAllowedContact } from './allowed-contact.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const src = args.find((a) => !a.startsWith('--')) ?? '/workspace/nafis-content/blog-sefr-ta-sad/post.mdx';
if (/\.v1\.mdx$/.test(basename(src))) { console.error('import-post: post.v1.mdx is superseded and must not be published'); process.exit(1); }
const raw = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) { console.error('import-post: no frontmatter'); process.exit(1); }
const [, fm, body] = m;
const field = (k) => (fm.match(new RegExp(`^${k}:\\s*"(.*)"\\s*$`, 'm')) ?? [])[1];
const slug = field('slug');
if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { console.error('import-post: bad slug', slug); process.exit(1); }
const errors = [], notes = [];
const strip = (s) => s.replace(/\u200c/g, '\u200c'); // keep ZWNJ; matching below is ZWNJ/space tolerant
const all = strip(raw);
const z = '[\\u200c\\s]?';
const banned = [
  ['سپرده', /سپرده/], ['برآورد/برآوردی', new RegExp(`بر${z}[اآأ]ورد`)], ['تخمینی', /تخمین/],
  ['% / ٪', /[%٪]/], ['درصد', /درصد/], ['نرخ', /نرخ/], ['سود', /(^|[^\u0600-\u06FF])سود/], ['بهره', /بهره(?!\u200c?مند)/], ['کارمزد', /کارمزد/],
  ['تضمین', /تضمین/], ['صد در صد', /صد\s*در\s*صد|۱۰۰\s*درصد/], ['حتماً/قطعاً', /(^|[^\u0600-\u06FF])(حتما|قطعا)\u064B?(?![\u0600-\u06FF])/],
  ['«تماس با کارشناس»', /تماس با کارشناس/], ['tel:/sms:/messenger', /\b(tel|sms|whatsapp|tg|bale):|wa\.me|t\.me|ble\.ir/],
  ['phone number', /(\+98|0098|۰۰۹۸|\+۹۸)|(^|[^\d۰-۹])(0|۰)(9|۹)[\d۰-۹]{2}[\s-]?[\d۰-۹]{3}[\s-]?[\d۰-۹]{4}|(^|[^\d۰-۹])(0|۰)[1-8۱-۸][\d۰-۹]{1,2}[\s-]?[\d۰-۹]{7,8}/],
  ['signature provider name', /امضامی|ساینو|امضا\s*نوین|سیگنو/],
];
for (const [n, re] of banned) {
  const src = n === 'tel:/sms:/messenger' || n === 'phone number' ? stripAllowedContact(all) : all;
  const hit = src.match(re);
  if (hit) errors.push(`banned: ${n} → «${src.slice(Math.max(0, hit.index - 20), hit.index + 30).replace(/\n/g, ' ')}»`);
}
// plan cards show only مبلغ واریزی / مبلغ هر قسط / تعداد اقساط (check-guarantees CARD_CLAIM); method, time, guarantee type live elsewhere
const cardClaim = body.match(/(روش|زمان|پیش‌پرداخت|مبلغ اسمی|ضمانت)[^.؟!«»"<\n]{0,60}روی کارت|روی کارت[^.؟!"<\n]{0,40}(روش|زمان بررسی|پیش‌پرداخت|مبلغ اسمی|ضمانت)/);
if (cardClaim) errors.push(`card claim (cards show only مبلغ واریزی، مبلغ هر قسط، تعداد اقساط; say «روش انجام هر طرح (حضوری یا غیرحضوری) در فهرست طرح‌ها آمده است»): «${cardClaim[0]}»`);
if (/secondary(Href)?=/.test(body)) errors.push('InlineCTA: second link prop present (live CTA = one primary button)');
if (/<script[^>]*application\/ld\+json|"@type"\s*:\s*"FAQPage"/.test(body)) errors.push('FAQ JSON-LD inside the body: the template builds it from `faq`');
// every Persian/latin number, so a reviewer sees them all (only approved stats + step numbers are expected)
const nums = [...body.matchAll(/[۰-۹0-9][۰-۹0-9,٬.]*/g)].map((x) => x[0]);
notes.push(`numbers in body: ${[...new Set(nums)].join(' ') || '—'}`);
// PM decisions (t628u)
const dec = {
  title: field('title') === 'صفر تا صد وام با نفیس وام؛ همراه شما تا واریز',
  h1: field('h1') === 'نفیس وام؛ صفر تا صد کار وامت رو ما انجام می‌دیم',
  'بیشتر طرح‌ها': /بیشتر طرح‌ها/.test(all),
  'امضای دیجیتال (no provider)': /امضای دیجیتال/.test(all),
  'softened «در تمام مراحل پیگیری پرونده»': /در تمام مراحل پیگیری پرونده/.test(all),
  '«تا واریز» only in title': (all.match(/تا واریز/g) ?? []).length === 1 && /تا واریز/.test(field('title') ?? ''),
};
for (const [k, v] of Object.entries(dec)) notes.push(`decision ${v ? '✓' : '✗'} ${k}`);
const dst = `src/content/blog/${slug}.mdx`;
if (errors.length) { console.error(errors.map((e) => '✗ ' + e).join('\n')); console.log(notes.join('\n')); process.exit(1); }
if (!checkOnly) { const same = existsSync(dst) && readFileSync(dst, 'utf8') === raw; writeFileSync(dst, raw); notes.push(`${same ? 'unchanged' : 'written'}: ${dst} (from ${src})`); }
console.log(notes.join('\n') + `\nimport-post: OK (${slug}) → next: npm run build && npm test`);

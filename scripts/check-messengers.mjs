#!/usr/bin/env node
// Messenger links (Armita/PM 2026-10-23): the site has NO generic WhatsApp link. Header, mobile bar «پیام», footer and
// /request point to /contact#experts; WhatsApp links exist ONLY inside the /contact «کارشناسان فروش» block
// (<section id="experts">), one per sales expert, for the numbers Mohammad gave us (SALES_EXPERTS in src/lib/site.ts).
// Fails on: any wa.me / api.whatsapp.com / whatsapp:// link anywhere in dist/ (html, js, xml, json, txt…) or src/ outside
// that block; a wa.me number that is not one of the experts; the experts block missing its WhatsApp links;
// the mobile bar «پیام» not pointing to /contact#experts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const WA = /(?:https?:)?\/\/(?:www\.)?wa\.me\b[^\s"'<>`)]*|(?:https?:)?\/\/api\.whatsapp\.com[^\s"'<>`)]*|\bwhatsapp:\/\/[^\s"'<>`)]*/gi;
const errors = [];

// Numbers Mohammad gave us, read from the source of truth.
const siteTs = readFileSync(join(ROOT, 'src/lib/site.ts'), 'utf8');
const experts = [...(siteTs.match(/SALES_EXPERTS = \[([\s\S]*?)\] as const/)?.[1] ?? '').matchAll(/mobile: '0(9\d{9})'/g)].map((m) => `98${m[1]}`);
if (experts.length === 0) errors.push('src/lib/site.ts: SALES_EXPERTS mobiles not found');
const allowed = new Set(experts.map((n) => `https://wa.me/${n}`));

// 1) built output
const textFiles = walk(DIST).filter((f) => /\.(html|js|mjs|css|xml|txt|json|webmanifest|svg)$/.test(f));
let allowedFound = 0;
for (const f of textFiles) {
  const rel = relative(DIST, f);
  let t = readFileSync(f, 'utf8');
  if (rel === 'contact/index.html') {
    const block = t.match(/<section[^>]*\bid="experts"[^>]*>[\s\S]*?<\/section>/)?.[0];
    if (!block) {
      errors.push('contact: «کارشناسان فروش» block <section id="experts"> missing');
    } else {
      const links = block.match(WA) ?? [];
      for (const l of links) {
        if (allowed.has(l)) allowedFound++;
        else errors.push(`contact#experts: WhatsApp link for a number Mohammad did not give us: ${l}`);
      }
      const missing = [...allowed].filter((a) => !links.includes(a));
      if (missing.length) errors.push(`contact#experts: expert WhatsApp link(s) missing: ${missing.join(', ')}`);
      t = t.replace(block, '');
    }
  }
  for (const l of t.match(WA) ?? []) errors.push(`${rel}: WhatsApp link outside /contact#experts: ${l}`);
}
if (!textFiles.some((f) => relative(DIST, f) === 'contact/index.html')) errors.push('dist/contact/index.html missing');

// the mobile bar «پیام» → /contact#experts (every page with the bar)
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
const bar = home.match(/<nav class="bar"[\s\S]*?<\/nav>/)?.[0] ?? '';
if (!/href="\/contact\/?#experts"[^>]*>[\s\S]*?پیام/.test(bar)) errors.push('home: mobile bar «پیام» does not link to /contact#experts');

// 2) source (components, pages, MDX/blog, data, public): the only allowed WhatsApp URL is the expertLinks template
const srcFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public'))].filter((f) => /\.(astro|tsx?|jsx?|mdx?|json|ya?ml|xml|txt|html|css)$/.test(f));
for (const f of srcFiles) {
  const rel = relative(ROOT, f);
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const l of line.match(WA) ?? []) {
      const ok = rel === 'src/lib/site.ts' && (/^\s*whatsapp: `https:\/\/wa\.me\/\$\{intl\}`,$/.test(line) || /^\s*\*/.test(line));
      if (!ok) errors.push(`${rel}:${i + 1}: WhatsApp link outside the /contact experts block: ${l}`);
    }
  });
}

if (errors.length) {
  console.error(`messengers: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`messengers: OK — WhatsApp only in /contact#experts (${allowedFound}/${allowed.size} expert links), none elsewhere in ${textFiles.length} dist files / ${srcFiles.length} source files; mobile bar «پیام» → /contact#experts`);

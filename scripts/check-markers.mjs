#!/usr/bin/env node
/**
 * Placeholder markers: «[تأیید محمد…]» (needs Mohammad's approval) and «[جای‌خالی…]» (content still missing).
 * On the page they render as bracketless pills `<span class="ph" data-marker="[…]">…</span>` (src/lib/ph-html.ts);
 * the check reads the marker back from data-marker.
 *
 * Policy (P1): markers are intentionally VISIBLE on the site until Mohammad replaces them, so the default run
 * only REPORTS them per page and fails if a marker that is visible in the source got lost in dist/ (a marker
 * must never be silently dropped). `--strict` fails on ANY marker in dist/ — use it for the production release
 * (the spec README: "build fail if markers present").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const strict = process.argv.includes('--strict');
const RE = /\[\s*(?:تأیید|تایید)\s*محمد[^\]]*\]|\[\s*جای[‌\s]?خالی[^\]]*\]|(?:تأیید محمد|جای[‌\s]?خالی)\s*:/g;
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const walk = (d, ext) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.some((e) => p.endsWith(e)) ? [p] : [];
  });

const dist = 'dist';
const pages = walk(dist, ['.html']);
let total = 0;
const report = [];
const seen = new Set();
for (const f of pages) {
  const html = readFileSync(f, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // bracketless pills (ANSWERS-1 mismatch 3): the marker lives in data-marker; count it, not the visible label
    .replace(/<span class="ph[^"]*" data-marker="([^"]*)">[^<]*<\/span>/g, (_, m) => ` ${dec(m)} `);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const m = [...new Set(text.match(RE) ?? [])];
  if (m.length) {
    total += m.length;
    report.push(`${relative(dist, f)}: ${m.length}`);
    m.forEach((x) => seen.add(x.replace(/\s+/g, ' ').trim()));
  }
}

// Source markers that must stay visible: MDX body text (not YAML/MDX comments) and .astro markup.
// (.tsx islands are skipped: their markers live in interaction-only states, e.g. the wizard success step.)
const src = walk('src', ['.mdx', '.astro']);
const lost = [];
for (const f of src) {
  let s = readFileSync(f, 'utf8');
  if (f.endsWith('.mdx')) s = s.replace(/^---[\s\S]*?\n---/, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '');
  else s = s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of s.match(/\[\s*(?:تأیید محمد|جای[‌\s]?خالی)[^\]\n]*\]/g) ?? []) {
    const k = m.replace(/\s+/g, ' ').trim();
    if (!/[{}$`]/.test(k) && ![...seen].some((x) => x.includes(k) || k.includes(x))) lost.push(`${relative('.', f)}: ${k}`);
  }
}

console.log(`markers: ${total} visible marker(s) on ${report.length}/${pages.length} page(s)${strict ? ' [strict]' : ''}`);
for (const r of report) console.log('  ' + r);
if (lost.length) {
  console.error(`\n✗ ${lost.length} source marker(s) not found in dist/ (dropped or hidden):`);
  for (const l of [...new Set(lost)]) console.error('  ' + l);
}
if (lost.length || (strict && total)) process.exit(1);

#!/usr/bin/env node
// Validates JSON-LD in dist/: every block parses; FAQPage blocks have the shape Google expects
// (mainEntity[] of Question{name} with acceptedAnswer Answer{text}, no placeholder markers);
// each blog post with a visible FAQ section has exactly one matching FAQPage.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const MARKER = /\[\s*(?:تأیید|تایید)\s*محمد[^\]]*\]|\[\s*جای[‌\s]?خالی[^\]]*\]/;
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const errors = [];
let faqPages = 0;
let questions = 0;

const str = (v) => typeof v === 'string' && v.trim().length > 0;

for (const file of walk(DIST).filter((f) => f.endsWith('.html'))) {
  const page = relative(DIST, file);
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const docs = [];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      docs.push(...(Array.isArray(j) ? j : [j]));
    } catch (e) {
      errors.push(`${page}: invalid JSON-LD (${e.message})`);
    }
  }
  const faqs = docs.filter((d) => d['@type'] === 'FAQPage');
  if (faqs.length > 1) errors.push(`${page}: ${faqs.length} FAQPage blocks (max 1)`);
  for (const f of faqs) {
    faqPages++;
    if (f['@context'] !== 'https://schema.org') errors.push(`${page}: FAQPage @context`);
    if (!Array.isArray(f.mainEntity) || f.mainEntity.length === 0) {
      errors.push(`${page}: FAQPage.mainEntity must be a non-empty array`);
      continue;
    }
    f.mainEntity.forEach((q, i) => {
      questions++;
      const at = `${page}: mainEntity[${i}]`;
      if (q['@type'] !== 'Question') errors.push(`${at} @type must be Question`);
      if (!str(q.name)) errors.push(`${at}.name empty`);
      if (q.acceptedAnswer?.['@type'] !== 'Answer') errors.push(`${at}.acceptedAnswer @type must be Answer`);
      if (!str(q.acceptedAnswer?.text)) errors.push(`${at}.acceptedAnswer.text empty`);
      if (MARKER.test(`${q.name} ${q.acceptedAnswer?.text}`)) errors.push(`${at} contains a placeholder marker`);
    });
  }
  // Blog posts: visible FAQ section ⇔ FAQPage with the same number of questions.
  if (/^blog\/[^/]+\/index\.html$/.test(page) && !/^blog\/(category|tag|\d+)\//.test(page)) {
    const sec = html.match(/aria-labelledby="bfaq"[\s\S]*?<\/section>/)?.[0];
    const visible = sec ? (sec.match(/<details/g) ?? []).length : 0;
    const ld = faqs[0]?.mainEntity?.length ?? 0;
    if (visible !== ld) errors.push(`${page}: visible FAQ items (${visible}) ≠ FAQPage questions (${ld})`);
  }
}

if (errors.length) {
  console.error(`jsonld: ${errors.length} problem(s)\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`jsonld: OK — ${faqPages} FAQPage block(s), ${questions} question(s)`);

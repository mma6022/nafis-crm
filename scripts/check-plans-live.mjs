#!/usr/bin/env node
// Build guard (after astro build): the shipped snapshot must equal the live active plan set, and the home page's
// prerendered HTML must state that count — never another plan count.
//  1. live export reachable (else FAIL), snapshot ids == live ids (count included)
//  2. snapshot file matches its meta (count, ids, sha256) — catches a hand-edited snapshot
//  3. dist/index.html: every «<N> طرح» count equals the live count, and the live count appears at least once
// Run: node scripts/check-plans-live.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fetchExport, idsOf } from './plans-export.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const body = readFileSync(join(ROOT, 'src/data/loan-plans.snapshot.json'), 'utf8');
const snap = JSON.parse(body);
const meta = JSON.parse(readFileSync(join(ROOT, 'src/data/loan-plans.snapshot.meta.json'), 'utf8'));
const errors = [];
const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const toNum = (s) => Number(s.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

let live;
try {
  ({ data: live } = await fetchExport());
} catch (e) {
  console.error(`check-plans-live: FAILED — ${e.message}`);
  process.exit(1);
}
const liveIds = idsOf(live), snapIds = idsOf(snap);
if (liveIds.join() !== snapIds.join()) errors.push(`snapshot plans [${snapIds}] (${snapIds.length}) ≠ live active plans [${liveIds}] (${liveIds.length}) — run node scripts/refresh-plans.mjs`);
if (meta.count !== snap.length || idsOf(snap).join() !== meta.ids.join()) errors.push('snapshot does not match its meta (count/ids)');
if (createHash('sha256').update(body).digest('hex') !== meta.sha256) errors.push('snapshot sha256 does not match its meta (hand-edited?)');

const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
// a) every bound plan count (data-plan-count="planCount", also replaced by JS later) b) every visible «N … طرح» phrase
const bound = [...html.matchAll(/data-plan-count="planCount"[^>]*>([۰-۹0-9]+)</g)].map((m) => toNum(m[1]));
//    («حداکثر ۳ طرح» = finder card limit, not a plan count)
const phrases = [...html.matchAll(/(حداکثر\s*)?([۰-۹0-9]+)\s*(?:<[^>]+>\s*)*طرح/g)].filter((m) => !m[1]).map((m) => toNum(m[2]));
const counts = [...bound, ...phrases];
const wrong = counts.filter((n) => n !== live.length);
if (!bound.length) errors.push(`dist/index.html: no «${fa(live.length)} طرح» count found`);
if (wrong.length) errors.push(`dist/index.html: plan counts ${[...new Set(wrong)].map(fa).join('، ')} ≠ live ${fa(live.length)}`);

if (errors.length) {
  console.error('check-plans-live: FAILED\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`check-plans-live: OK — snapshot = live ${live.length} active plans [${liveIds}], home HTML states «${fa(live.length)} طرح» (${bound.length} bound, ${phrases.length} phrases)`);

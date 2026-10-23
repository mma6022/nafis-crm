// Fails if the word «سپرده» appears in the dashboard source, public files or build output.
// Product rule: never use «سپرده» in the CRM UI ("assigned" → «تخصیص»). Catches ZWNJ/ZWJ/tatweel
// inside the word, diacritics, Arabic letter variants (ة، ۀ، ه + ٔ) and \uXXXX / HTML-entity escapes.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Truly unavoidable occurrences only. Each entry: file (relative to the dashboard) + max count + reason.
// Financial "deposit" wording awaits a PM decision on the replacement term; do not reword by guess.
const ALLOW = [
  { file: 'src/customer-portal/PlanDetails.tsx', max: 2, reason: 'depositPercent column/estimate (financial deposit) — wording pending PM decision' },
];

export function normalize(text) {
  return text
    .replace(/\\u\{?([0-9a-fA-F]{4,5})\}?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[\u200c\u200d\u200e\u200f\u0640\u064b-\u065f\u0670]/g, '')
    .replace(/[\u0629\u06c0\u06d5]/g, '\u0647');
}
const WORD = /\u0633\u067e\u0631\u062f\u0647/g; // سپرده
export const count = (text) => (normalize(text).match(WORD) || []).length;

const must = ['سپرده', 'سپرده‌ای', 'سپردهٔ', 'سپرده‌ها', 'سپردة', 'سپردۀ', 'سـپـرده', 'س‌پرده', '\\u0633\\u067e\\u0631\\u062f\\u0647', '&#1587;&#1662;&#1585;&#1583;&#1607;'];
const mustNot = ['تخصیص داده شد', 'سپردن', 'به من بسپار', 'سپر'];
for (const s of must) if (count(s) !== 1) { console.error(`self-test: should match ${s}`); process.exit(2); }
for (const s of mustNot) if (count(s)) { console.error(`self-test: should not match ${s}`); process.exit(2); }

const SKIP = new Set(['node_modules', '.git', 'scripts']);
const EXT = /\.(tsx?|jsx?|mjs|cjs|css|html|json|md|txt|svg|map)$/;
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else if (EXT.test(name)) yield p;
  }
}

const allowFor = (rel) => ALLOW.find((a) => a.file === rel);
const allowTotal = ALLOW.reduce((n, a) => n + a.max, 0);
const problems = [];
let distCount = 0; const distHits = [];
for (const d of ['src', 'public', 'index.html', 'dist']) {
  const abs = join(root, d);
  if (!existsSync(abs)) continue;
  const files = statSync(abs).isDirectory() ? [...walk(abs)] : [abs];
  for (const f of files) {
    if (d === 'dist' && f.endsWith('.map')) continue; // source maps embed sources; sources are checked directly
    const rel = relative(root, f);
    const lines = readFileSync(f, 'utf8').split('\n');
    const hits = []; let n = 0;
    lines.forEach((line, i) => { const c = count(line); if (c) { n += c; hits.push(`${rel}:${i + 1}`); } });
    if (!n) continue;
    if (d === 'dist') { distCount += n; distHits.push(...hits); continue; }
    const a = allowFor(rel);
    if (!a || n > a.max) problems.push(...hits);
  }
}
// Build output is minified, so it is checked by total: it may only carry the allowlisted occurrences.
if (distCount > allowTotal) problems.push(...distHits.map((h) => `${h} (dist total ${distCount} > allowed ${allowTotal})`));
if (problems.length) { console.error(`«سپرده» found (use «تخصیص» for "assigned"):\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`no-sepordeh: ok (src, public, index.html, dist; allowlisted: ${ALLOW.map((a) => `${a.file}×${a.max}`).join(', ') || 'none'})`);

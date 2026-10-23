// Fails if the banned root (s-p-r-d: the "deposit/entrust" word family, incl. the infinitive, the noun and
// the verb stems b-s-p-a-r / mi-s-p-a-r) appears in the dashboard (src, public, index.html, dist) or in the
// api-server src (user-visible strings, seeds, templates, comments). Product rule: "assigned" → «تخصیص»,
// financial guarantee → «وجه تضمین» (bank-deposit collateral was removed entirely).
// Catches ZWNJ/ZWJ/tatweel/bidi marks inside the word, diacritics, Arabic letter variants (ة ۀ ە ي ك)
// and \uXXXX / HTML-entity escapes. The banned letters are written as escapes so this file never contains them.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const api = join(root, '..', 'api-server');

// One exception: the contract variable label of loanPlan.depositPercents in contracts.ts. Contracts are admin-only
// territory (Mohammad's standing order: no code changes to contracts), so the live label stays until an admin/PM
// changes it. Exact line match, one hit only; anything else with the root still fails.
const EXCEPTIONS = [
  { file: 'api-server/src/routes/contracts.ts', line: '  "loanPlan.depositPercents": "\u062f\u0631\u0635\u062f \u0633\u067e\u0631\u062f\u0647",' },
];

export function normalize(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (_, a, b) => String.fromCodePoint(parseInt(a ?? b, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u0640\u064b-\u065f\u0670]/g, '')
    .replace(/[\u0629\u06c0\u06d5]/g, '\u0647').replace(/[\u064a\u0649]/g, '\u06cc').replace(/\u0643/g, '\u06a9');
}
// s-p-r-d (any form) | s-p-a-r (b-s-p-a-r, mi-s-p-a-r, ...)
const ROOT = /\u0633\u067e\u0631\u062f|\u0633\u067e\u0627\u0631/g;
export const count = (text) => (normalize(text).match(ROOT) || []).length;

// Self-test so the matcher itself can't silently rot.
const Z = '\u200c', S = '\u0633', P = '\u067e', R = '\u0631', D = '\u062f', A = '\u0627', H = '\u0647';
const must = [
  S + P + R + D + H, S + P + R + D + H + Z + '\u0627\u06cc', S + P + R + D + '\u06c0', S + P + R + D + '\u0629', S + P + R + D + H + '\u0654',
  S + P + R + D + '\u0646', S + P + R + D + '\u0645', '\u0628' + S + P + A + R, '\u0645\u06cc' + Z + S + P + A + R + '\u0645',
  S + '\u0640' + P + '\u0640' + R + D + H, S + Z + P + R + D + '\u0646', '\u0628' + S + P + A + R + '\u06cc\u062f',
  '\\u0633\\u067e\\u0631\\u062f\\u0647', '&#1587;&#1662;&#1585;&#1583;&#1607;', '&#x633;&#x67e;&#x627;&#x631;',
];
const mustNot = ['تخصیص داده شد', 'به من تخصیص بده', 'وجه تضمین', 'حساب مسدودی بانکی', 'سپر', 'سفارش', 'اسپری', 'سپاس'];
for (const s of must) if (count(s) !== 1) { console.error(`self-test: should match ${JSON.stringify(s)}`); process.exit(2); }
for (const s of mustNot) if (count(s)) { console.error(`self-test: should not match ${s}`); process.exit(2); }

const SKIP = new Set(['node_modules', '.git', 'scripts']);
const EXT = /\.(tsx?|jsx?|mjs|cjs|css|html|json|md|txt|svg|sql|map)$/;
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else if (EXT.test(name)) yield p;
  }
}

const targets = [...['src', 'public', 'index.html', 'dist'].map((d) => join(root, d)), join(api, 'src')].filter(existsSync);
const label = (f) => relative(join(root, '..'), f);
const used = new Map();
const hits = [];
for (const t of targets) {
  const files = statSync(t).isDirectory() ? [...walk(t)] : [t];
  for (const f of files) {
    const rel = label(f);
    if (rel.startsWith('crm-dashboard/dist/') && f.endsWith('.map')) continue; // maps embed sources, checked directly
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const n = count(line);
      if (!n) return;
      const ex = EXCEPTIONS.find((e) => e.file === rel && e.line === line);
      if (ex && n === 1 && !used.has(ex)) { used.set(ex, `${rel}:${i + 1}`); return; }
      hits.push(`${rel}:${i + 1}`);
    });
  }
}
if (hits.length) { console.error(`Banned root (s-p-r-d / s-p-a-r) found — use «تخصیص» (assigned) or «وجه تضمین» (guarantee):\n  ${hits.join('\n  ')}`); process.exit(1); }
const ex = [...used.values()];
console.log(`no-sepordeh: ok (${targets.map(label).join(', ')}; exceptions: ${ex.length ? ex.join(', ') : 'none'})`);

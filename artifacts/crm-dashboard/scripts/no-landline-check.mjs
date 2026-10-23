// Fails if the non-operational company landline (…91303819) appears in the dashboard source or build.
// Matches Latin, Persian and Arabic-Indic digits with any separators between them (spaces, dashes, dots, ZWNJ, etc.).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TARGET = '91303819';
const toLatin = (ch) => {
  const c = ch.codePointAt(0);
  if (c >= 0x6f0 && c <= 0x6f9) return String(c - 0x6f0);
  if (c >= 0x660 && c <= 0x669) return String(c - 0x660);
  return ch;
};
// Every digit run, allowing up to 3 non-digit, non-letter separator chars between digits.
export function containsLandline(text) {
  let digits = '';
  let gap = 0;
  for (const raw of text) {
    const ch = toLatin(raw);
    if (ch >= '0' && ch <= '9') { digits += ch; gap = 0; if (digits.includes(TARGET)) return true; continue; }
    if (/[\p{L}]/u.test(raw) || raw === '\n' || ++gap > 3) { digits = ''; gap = 0; }
  }
  return false;
}

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

// Self-test so the matcher itself can't silently rot.
const must = ['021-91303819', '۰۲۱-۹۱۳۰۳۸۱۹', '+982191303819', '021 9130 3819', '۹۱۳۰ ۳۸۱۹', '٩١٣٠٣٨١٩', '91.30.38.19'];
const mustNot = ['021-91090380', '09120000101', '9130 کد 3819'];
for (const s of must) if (!containsLandline(s)) { console.error(`self-test: should match ${s}`); process.exit(2); }
for (const s of mustNot) if (containsLandline(s)) { console.error(`self-test: should not match ${s}`); process.exit(2); }

const dirs = ['src', 'public', 'index.html', 'dist'].map((d) => join(root, d)).filter(existsSync);
const hits = [];
for (const d of dirs) {
  const files = statSync(d).isDirectory() ? [...walk(d)] : [d];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => { if (containsLandline(line)) hits.push(`${relative(root, f)}:${i + 1}`); });
  }
}
if (hits.length) { console.error(`Landline …91303819 found (it is not operational; do not show it):\n  ${hits.join('\n  ')}`); process.exit(1); }
console.log(`no-landline: ok (${dirs.map((d) => relative(root, d) || '.').join(', ')})`);

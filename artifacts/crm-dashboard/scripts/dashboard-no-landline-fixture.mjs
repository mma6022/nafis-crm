// The office landline 021-91303819 is not operational (Mohammad 2026-10-23) and must not appear anywhere in the
// dashboard (staff panel + customer portal): not in src/, not in the built bundle. Latin/Persian/Arabic digits, any separators.
// Runs as part of `build` (after vite) and as `test:dashboard-no-landline`.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = { 0: '0۰٠', 1: '1۱١', 3: '3۳٣', 8: '8۸٨', 9: '9۹٩' };
const SEP = '[\\s\\-–—_.()/\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\\\]{0,3}';
const LANDLINE = new RegExp('91303819'.split('').map(d => `[${D[d]}]`).join(SEP));

// self-test: the pattern catches the usual spellings
for (const s of ['021-91303819', '۰۲۱-۹۱۳۰۳۸۱۹', '+982191303819', '021 9130 3819', '۰۲۱‌-‌۹۱۳۰ ۳۸۱۹', '(021) 913-03-819', '٩١٣٠٣٨١٩'])
  assert.ok(LANDLINE.test(s), `pattern misses ${s}`);
for (const s of ['09003400452', '173819273', '91303818']) assert.ok(!LANDLINE.test(s), `false positive ${s}`);

const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const TEXT = /\.(tsx?|jsx?|mjs|cjs|css|html?|json|svg|txt|md)$/;
let n = 0;
for (const dir of ['src', 'public', 'index.html'].map(p => join(root, p)).filter(existsSync)) {
  for (const f of (dir.endsWith('.html') ? [dir] : walk(dir)).filter(f => TEXT.test(f))) {
    n++; assert.ok(!LANDLINE.test(readFileSync(f, 'utf8')), `${f} contains the office landline 021-91303819`);
  }
}
const dist = join(root, 'dist/public');
if (existsSync(dist)) {
  let m = 0;
  for (const f of walk(dist).filter(f => TEXT.test(f))) { m++; assert.ok(!LANDLINE.test(readFileSync(f, 'utf8')), `build ${f} contains the office landline 021-91303819`); }
  console.log(`build scanned: ${m} files`);
} else console.log('no dist/ — build scan skipped');
console.log(`dashboard-no-landline: ok (${n} source files)`);

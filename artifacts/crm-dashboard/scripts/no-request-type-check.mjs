// Legal 2026-10-24 (NOREQTYPE): staff consult forms never ask request type / receive mode, and the dashboard
// (src, public, index.html, dist if built) has no banned estimate words. Banned letters are escapes so this file
// itself is clean. Stored loanPref / loanPurpose / receiveMode must still be saved back unchanged.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const BANNED = [/\u0628\u0631\u0622\u0648\u0631\u062f/g, /\u062a\u062e\u0645\u06cc\u0646\u06cc/g]; // b-r-aa-v-r-d, t-kh-m-y-n-y
const norm = (t) => t.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u0640\u064b-\u065f\u0670]/g, '').replace(/[\u064a\u0649]/g, '\u06cc');
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === 'node_modules') continue; statSync(p).isDirectory() ? walk(p) : files.push(p); } };
for (const d of ['src', 'public', 'dist']) if (existsSync(join(root, d))) walk(join(root, d));
files.push(join(root, 'index.html'));
const hits = [];
for (const f of files) {
  if (!/\.(tsx?|jsx?|mjs|css|html|json|svg|md)$/.test(f)) continue;
  const t = norm(readFileSync(f, 'utf8'));
  for (const re of BANNED) { const m = t.match(re); if (m) hits.push(`${relative(root, f)} ×${m.length}`); }
}
assert.deepEqual(hits, [], 'banned estimate words in the dashboard');

// Every consult form/modal (edit: Consultations.tsx; create: Forms.tsx CreateConsultationForm).
const consult = readFileSync(join(root, 'src/pages/Consultations.tsx'), 'utf8');
const forms = readFileSync(join(root, 'src/components/Forms.tsx'), 'utf8');
for (const [name, src] of [['Consultations.tsx', consult], ['Forms.tsx', forms]]) {
  for (const id of ['consult-loan', 'consult-purpose', 'consult-receive', 'input-consultation-loan', 'input-consultation-purpose', 'input-consultation-receive'])
    assert.ok(!src.includes(`"${id}"`), `${name}: ${id} must not be an input`);
  for (const label of ['\u062a\u0631\u062c\u06cc\u062d \u062a\u0633\u0647\u06cc\u0644\u0627\u062a', '\u0647\u062f\u0641 \u062a\u0633\u0647\u06cc\u0644\u0627\u062a', '\u0634\u06cc\u0648\u0647 \u062f\u0631\u06cc\u0627\u0641\u062a', '\u0646\u062d\u0648\u0647 \u062f\u0631\u06cc\u0627\u0641\u062a'])
    assert.ok(!new RegExp(`>${label}<`).test(src), `${name}: label «${label}» must not be shown`);
  assert.ok(!/setValue\('(loanPref|loanPurpose|receiveMode)'/.test(src), `${name}: no editor for loanPref/loanPurpose/receiveMode`);
}
// Stored values kept: initialised from the record and sent back.
for (const k of ['loanPref', 'loanPurpose', 'receiveMode']) {
  assert.match(consult, new RegExp(`${k}: consultation\\.${k} \\?\\? ''`), `${k} initialised from stored value`);
  assert.match(consult, new RegExp(`${k}: form\\.${k}\\.trim\\(\\)`), `${k} saved back`);
}
console.log(`no-request-type: ok (${files.length} files scanned)`);

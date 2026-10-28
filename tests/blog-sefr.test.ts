// Blog «صفر تا صد وام» (Arad v2, PM t628u) + /vam-ani/ step count: copy rules via the one-command importer, brand once in <title>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const POST = 'src/content/blog/sefr-ta-sad-vam-nafis.mdx';

test('sefr-ta-sad post passes the importer rules (banned words, rates, phones, guarantees, card claims, single CTA)', () => {
  const out = execFileSync(process.execPath, ['scripts/import-post.mjs', POST, '--check-only'], { encoding: 'utf8' });
  assert.match(out, /import-post: OK \(sefr-ta-sad-vam-nafis\)/);
  assert.doesNotMatch(out, /decision ✗/);
});

test('SEO title carries the brand once; template drops the suffix only for brand titles', () => {
  const src = readFileSync(POST, 'utf8');
  assert.match(src, /^title: "صفر تا صد وام با نفیس وام؛ همراه شما تا واریز"$/m);
  assert.match(src, /^h1: "نفیس وام؛ صفر تا صد کار وامت رو ما انجام می‌دیم"$/m);
  const tpl = readFileSync('src/pages/blog/[slug].astro', 'utf8');
  assert.match(tpl, /rawTitle=\{brandInTitle\(d\)\}/);
  assert.match(readFileSync('src/lib/blog.ts', 'utf8'), /brandInTitle = \(d: Post\['data'\]\) => d\.title\.includes\('نفیس وام'\)/);
});

test('importer refuses the superseded post.v1.mdx', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/import-post.mjs', '/nonexistent/post.v1.mdx', '--check-only'], { stdio: 'pipe' }));
});

test('/vam-ani/ no longer says the form has two steps', () => {
  assert.doesNotMatch(readFileSync('src/content/pages/vam-ani.mdx', 'utf8'), /دو مرحله|۲ مرحله/);
});

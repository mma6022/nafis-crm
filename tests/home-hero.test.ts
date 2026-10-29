import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HERO_SEFR, heroSlogan } from '../src/lib/home-hero';
import { buildApplyPayload } from '../src/lib/apply';

const ZWNJ = '\u200c';
test('home hero «صفر تا صد»: approved copy verbatim (Mohammad t627u/t628u)', () => {
  assert.equal(heroSlogan(), 'نفیس وام؛ از صفر تا صد\u0650 وامت، کنارتیم');
  assert.equal(
    HERO_SEFR.lead,
    `بدون رفت${ZWNJ}وآمد، بدون سردرگمی. یه کارشناس اختصاصی از اولین تماس تا واریز وام همراهته و همه${ZWNJ}ی مراحل غیرحضوری و آنلاین انجام می${ZWNJ}شه.`,
  );
  assert.deepEqual(
    HERO_SEFR.badges.map((b) => b.text),
    ['کارشناس اختصاصی، فقط برای تو', 'صفر تا صد کار با ما', 'کاملاً آنلاین و غیرحضوری'],
  );
  assert.equal(HERO_SEFR.cta, 'ثبت درخواست');
  assert.match(HERO_SEFR.href, /^\/request\/(\?|$)/);
});

test('home hero: no banned words, no rates/percentages', () => {
  const all = [heroSlogan(), HERO_SEFR.lead, HERO_SEFR.cta, ...HERO_SEFR.badges.map((b) => b.text)].join(' ');
  for (const w of ['سپرده', 'برآورد', 'تخمینی']) assert.ok(!all.includes(w), w);
  assert.ok(!/[%٪]|درصد|نرخ|سود/.test(all));
});

test('home (home-order v1.0.1): slider first with slide 1 as h2, then the sefr block as the only h1, no scene.js', () => {
  const idx = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(idx, /HOME_HERO/, 'the sefr/slider switch is gone');
  assert.match(idx, /<HeroSlider facts=\{facts\} firstH1=\{false\} \/>/);
  assert.ok(idx.indexOf('<HeroSlider') < idx.indexOf('<HeroSefr'), 'slider is the first block after the header');
  const order = ['<HeroSlider', '<HeroSefr', 'id="why-h"', 'id="plan-finder"', 'id="calculator"', 'id="callback"', '<MidBanner n={1}', 'aria-labelledby="svc-h"', 'aria-labelledby="steps-h"', 'aria-labelledby="blog-h"', '<MidBanner n={2}', 'aria-labelledby="faq-h"'];
  const at = order.map((k) => idx.indexOf(k));
  assert.ok(at.every((v) => v > 0), 'all home blocks present');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'home-order v1.0.1 §2 block order');
  assert.match(idx, /<h2 id="why-h">/, '«چرا نفیس وام؟» heading visible (no .vh)');
  assert.match(idx, /import '\.\.\/styles\/home-order\.css'/);
  assert.match(idx, /mainClass="ho"/);
  const c = readFileSync(new URL('../src/components/home/HeroSefr.astro', import.meta.url), 'utf8');
  assert.equal((c.match(/<h1\b/g) ?? []).length, 1);
  assert.doesNotMatch(c, /import[^;\n]*scene|scene\.js['"]/, 'Armita scene.js is mockup-only');
  const sl = readFileSync(new URL('../src/components/home/HeroSlider.astro', import.meta.url), 'utf8');
  assert.match(sl, /i === 0 && firstH1 \? <h1 class="hb-h">/);
  assert.match(sl, /import '\.\.\/\.\.\/scripts\/home-banners\.js'/, '.rv reveal still loaded by the slider');
  assert.equal(HERO_SEFR.href, '/request/?src=home-top');
});

test('hero button: src=home-top survives the /request wizard payload (stored by the CRM as public_leads.src + site_apply_answers.src)', () => {
  const u = new URL(HERO_SEFR.href, 'https://nafisvam.com');
  assert.equal(u.pathname, '/request/');
  const src = u.searchParams.get('src'); // ApplyWizard reads ?src= on mount into meta.src (kept in sessionStorage across steps)
  assert.equal(src, 'home-top');
  const p = buildApplyPayload(
    { full_name: 'تست', mobile: '09120000012', amount_range: '100m_300m', loan_purpose: 'wedding', job_status: 'employee', documents: ['payslip'], has_military_card: 'no', can_refer_retiree: 'no', has_bounced_or_overdue: 'no', need_timing: 'this_week' } as never,
    { startedAt: 1_700_000_000_000, fillMs: 9_000, src, planId: null, term: null, utm: {} },
  );
  assert.equal(p.src, 'home-top');
  assert.match(String(p.src), /^[a-z0-9][a-z0-9_-]{0,39}$/, 'CRM public-leads SLUG_RE accepts it (else 400 src)');
});

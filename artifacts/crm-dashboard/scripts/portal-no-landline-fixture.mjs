// Customer portal must never show or dial the office landline (not operational, Mohammad 2026-10-23).
// Contact goes through ExpertPicker + src/customer-portal/sales-experts.ts. Run after `vite build` to also scan the bundle.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANDLINE = [/91303819/, /۹۱۳۰۳۸۱۹/, /\+98\s*21/, /tel:0?21/, /۰۲۱[-\s]?\d/, /SUPPORT_PHONE/];
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);

const portal = join(root, 'src/customer-portal');
for (const f of walk(portal).filter(f => /\.(tsx?|css)$/.test(f)))
  for (const re of LANDLINE) assert.ok(!re.test(readFileSync(f, 'utf8')), `${f} contains landline pattern ${re}`);

// Portal source: only ExpertPicker / sales-experts may build tel:/messenger links.
for (const f of walk(portal).filter(f => /\.tsx?$/.test(f) && !/(ExpertPicker\.tsx|sales-experts\.ts)$/.test(f)))
  assert.ok(!/tel:|wa\.me|t\.me\/|ble\.ir/.test(readFileSync(f, 'utf8')), `${f} has a direct tel:/messenger link; use ExpertPicker`);

const cfg = readFileSync(join(portal, 'sales-experts.ts'), 'utf8');
for (const [name, mobile] of [['خانم قاسمی', '09003400452'], ['خانم حسنی', '09003400462'], ['آقای کاظمی', '09003400472']])
  assert.ok(cfg.includes(`name: '${name}', mobile: '${mobile}'`), `sales-experts.ts missing ${name} ${mobile}`);
assert.ok(cfg.indexOf('خانم قاسمی') < cfg.indexOf('خانم حسنی') && cfg.indexOf('خانم حسنی') < cfg.indexOf('آقای کاظمی'), 'fixed order قاسمی، حسنی، کاظمی');
assert.ok(cfg.includes("'شنبه تا پنج‌شنبه، ۹ تا ۱۸'"), 'hours line');
assert.ok(cfg.includes("'سلام، از سایت نفیس وام پیام می‌دم و مشاوره می‌خوام.'"), 'prefill message');
const picker = readFileSync(join(portal, 'ExpertPicker.tsx'), 'utf8');
assert.ok(picker.includes('با کدام کارشناس تماس می‌گیرید؟'), 'picker title');
// Mockup guide text must never ship.
const PLACEHOLDER = [/جای‌?\u200c?خالی/, /جای خالی/, /\[جای/, /نگاشت شماره به کارشناس/];
for (const f of walk(portal).filter(f => /\.(tsx?|css)$/.test(f)))
  for (const re of PLACEHOLDER) assert.ok(!re.test(readFileSync(f, 'utf8')), `${f} contains mockup placeholder ${re}`);

const dist = join(root, 'dist/public/assets');
if (existsSync(dist)) {
  for (const f of walk(dist).filter(f => /\.(js|css|html)$/.test(f))) {
    const t = readFileSync(f, 'utf8');
    for (const re of [/91303819/, /۹۱۳۰۳۸۱۹/]) assert.ok(!re.test(t), `bundle ${f} contains landline`);
    for (const re of PLACEHOLDER) assert.ok(!re.test(t), `bundle ${f} contains mockup placeholder ${re}`);
  }
  console.log('bundle scanned:', dist);
} else console.log('no dist/ — bundle scan skipped');
console.log('portal-no-landline: ok');

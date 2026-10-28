import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPLY_CONSENT_TEXT, APPLY_MIN_FILL_MS, APPLY_STEPS, STEP_FIELDS, buildApplyPayload, emptyAnswers, firstIncompleteStep,
  maskMobile, shouldPost, stepErrors, submitApply, toggleDoc, type ApplyAnswers,
} from '../src/lib/apply';

const full: ApplyAnswers = {
  full_name: ' مریم احمدی ',
  mobile: '۰۹۱۲ ۰۰۰ ۰۰۱۲',
  amount_range: '100m_300m',
  loan_purpose: 'wedding',
  job_status: 'employee',
  documents: ['sayadi_cheque', 'payslip'],
  has_military_card: 'no',
  can_refer_retiree: 'yes',
  has_bounced_or_overdue: 'no',
  need_timing: 'this_week',
};
const meta = { startedAt: 1_700_000_000_000, fillMs: 12_345.6, src: 'Home-Finder', planId: 10, term: 36, utm: { utm_source: 'google', utm_medium: '' } };
const ALLOWED = new Set(['type', 'name', 'phone', 'amount_range', 'loan_purpose', 'job_status', 'documents', 'has_military_card', 'can_refer_retiree', 'has_bounced_or_overdue', 'need_timing', 'planId', 'term', 'src', 'consent', 'website', 'startedAt', 'fillMs', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);

test('7 steps in the design order (5 = military + retiree, 6 = bounced/overdue)', () => {
  assert.equal(APPLY_STEPS, 7);
  assert.equal(STEP_FIELDS.length, 7);
  assert.deepEqual(STEP_FIELDS[4], ['has_military_card', 'can_refer_retiree']);
  assert.deepEqual(STEP_FIELDS[5], ['has_bounced_or_overdue']);
});

test('payload: type apply, only CRM keys, snake_case enums, normalised phone, consent true, honeypot empty, fillMs int', () => {
  const p = buildApplyPayload(full, meta);
  for (const k of Object.keys(p)) assert.ok(ALLOWED.has(k), k);
  assert.equal(p.type, 'apply');
  assert.equal(p.name, 'مریم احمدی');
  assert.equal(p.phone, '09120000012');
  assert.deepEqual(p.documents, ['payslip', 'sayadi_cheque']);
  assert.equal(p.consent, true);
  assert.equal(p.website, '');
  assert.equal(p.fillMs, 12346);
  assert.equal(p.src, 'home-finder');
  assert.equal(p.planId, 10);
  assert.equal(p.term, 36);
  assert.equal(p.utm_source, 'google');
  assert.ok(!('utm_medium' in p));
  assert.ok(!('need' in p) && !('amountBand' in p) && !('contactTime' in p));
});

test('purpose is optional and omitted when empty; no plan → no planId/term', () => {
  const p = buildApplyPayload({ ...full, loan_purpose: undefined }, { startedAt: 1, fillMs: 9000 });
  assert.ok(!('loan_purpose' in p) && !('planId' in p) && !('term' in p) && !('src' in p));
});

test('incomplete answers never build a payload', () => {
  assert.throws(() => buildApplyPayload({ ...full, need_timing: undefined }, meta));
  assert.throws(() => buildApplyPayload({ ...full, mobile: '0912' }, meta));
});

test('step validation', () => {
  const e = emptyAnswers();
  assert.deepEqual(stepErrors(0, e), { full_name: true, mobile: true });
  assert.deepEqual(stepErrors(0, { ...e, full_name: 'x', mobile: '+98 912 000 0012' }), { mobile: true }); // 11 digits starting 09 only, like the design
  assert.deepEqual(stepErrors(0, { ...e, full_name: 'x', mobile: '0912-000-0012' }), {});
  assert.deepEqual(stepErrors(1, { ...e, amount_range: 'not_sure' }), {}); // purpose optional
  assert.deepEqual(stepErrors(1, e), { amount_range: true });
  assert.deepEqual(stepErrors(3, e), { documents: true });
  assert.deepEqual(stepErrors(4, { ...e, has_military_card: 'not_applicable' }), { can_refer_retiree: true });
  assert.equal(firstIncompleteStep(full), -1);
  assert.equal(firstIncompleteStep({ ...full, has_bounced_or_overdue: undefined }), 5);
});

test('documents: «هیچ‌کدام» is exclusive', () => {
  assert.deepEqual(toggleDoc(['payslip'], 'none'), ['none']);
  assert.deepEqual(toggleDoc(['none'], 'guarantor'), ['guarantor']);
  assert.deepEqual(toggleDoc(['payslip', 'guarantor'], 'payslip'), ['guarantor']);
});

test('thank-you mobile is masked; honeypot filled → no POST', () => {
  assert.equal(maskMobile('۰۹۱۲ ۰۰۰ ۰۰۱۲'), '0912***0012');
  assert.equal(maskMobile('bad'), '');
  assert.equal(shouldPost(''), true);
  assert.equal(shouldPost(undefined), true);
  assert.equal(shouldPost('http://spam'), false);
});

test('8 s minimum for this form; consent text verbatim', () => {
  assert.equal(APPLY_MIN_FILL_MS, 8000);
  assert.equal(APPLY_CONSENT_TEXT, 'با ثبت درخواست، می‌پذیرم کارشناس نفیس وام برای بررسی درخواستم با من تماس بگیرد. اطلاعات من فقط برای همین کار استفاده می‌شود.');
});

test('submitApply posts JSON once to the endpoint and resolves only on 2xx', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, trackingCode: 'NV-ABCD12' }), { status: 201 });
  }) as unknown as typeof fetch;
  const r = await submitApply(full, meta, 'https://crm.example/api/public/leads', ok);
  assert.equal(r.trackingCode, 'NV-ABCD12');
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.body as { type: string }).type, 'apply');
  const repeat = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await submitApply(full, meta, 'https://crm.example/x', repeat), {});
  const tooFast = (async () => new Response(JSON.stringify({ error: 'too_fast' }), { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(submitApply(full, meta, 'https://crm.example/x', tooFast), /too_fast/);
});

test('wizard UI: no rate/percent/offer, no priority/expert name, no SMS code input, consent wiring', () => {
  const src = readFileSync(new URL('../src/components/islands/ApplyWizard.tsx', import.meta.url), 'utf8');
  assert.match(src, /aria-describedby=\{last \? 'consent' : undefined\}/);
  assert.match(src, /id="consent"/);
  assert.doesNotMatch(src, /type="checkbox"/);
  assert.doesNotMatch(src, /نرخ|درصد|٪|%\s*سود|اولویت|کد تأیید|one-time-code/);
  assert.doesNotMatch(src, /سپرده|برآورد|تخمینی/);
});

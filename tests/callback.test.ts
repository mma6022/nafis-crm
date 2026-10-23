import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CB_DONE,
  CB_SUBMIT,
  CB_TITLE,
  CONSENT_TEXT,
  buildCallbackPayload,
  faMobile,
  isWorkingHours,
  nextOpening,
  step1Errors,
  step2Errors,
  submitCallback,
  successLine,
  tehranClock,
  timeOptions,
  type CallbackInput,
} from '../src/lib/callback';
import { normalizeIranMobile } from '../src/lib/format';
import { CALLBACK_WHATSAPP, WORK_HOURS } from '../src/lib/site';

// Tehran = UTC+03:30 (no DST since 2022). 2026-10-24 is a Saturday, 2026-10-28 a Wednesday, 2026-10-23 a Friday.
const teh = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh, mm) - 3.5 * 3600e3);
const SAT = 24, TUE = 27, WED = 28, THU = 29, FRI = 23;

const base: CallbackInput = {
  name: '  سارا   رضایی ',
  phone: '۰۹۱۲-۳۴۵-۶۷۸۹',
  contactTime: 'morning',
  consent: true,
  website: '',
  startedAt: 1_700_000_000_000,
  src: 'Home-Callback',
};

test('config: 9–18, morning 9–13, evening 13–18, Sat–Wed stand-in, WhatsApp link empty = hidden', () => {
  assert.equal(WORK_HOURS.start, 9);
  assert.equal(WORK_HOURS.end, 18);
  assert.deepEqual([...WORK_HOURS.morning], [9, 13]);
  assert.deepEqual([...WORK_HOURS.evening], [13, 18]);
  assert.deepEqual([...WORK_HOURS.days].sort(), [0, 1, 2, 3, 4, 6]); // Sat–Thu, Friday closed
  assert.equal(WORK_HOURS.daysConfirmed, true);
  assert.equal(CALLBACK_WHATSAPP, '');
});

test('tehranClock uses Asia/Tehran, not the machine zone', () => {
  assert.deepEqual(tehranClock(teh(SAT, 9)), { hour: 9, weekday: 6 });
  assert.deepEqual(tehranClock(teh(FRI, 23, 59)), { hour: 23, weekday: 5 });
  // 05:45 UTC Saturday = 09:15 Tehran Saturday
  assert.deepEqual(tehranClock(new Date(Date.UTC(2026, 9, 24, 5, 45))), { hour: 9, weekday: 6 });
});

test('working hours: work day and 09:00 ≤ t < 18:00 Tehran', () => {
  assert.equal(isWorkingHours(teh(SAT, 8, 59)), false);
  assert.equal(isWorkingHours(teh(SAT, 9)), true);
  assert.equal(isWorkingHours(teh(SAT, 17, 59)), true);
  assert.equal(isWorkingHours(teh(SAT, 18)), false);
  assert.equal(isWorkingHours(teh(WED, 12)), true);
  assert.equal(isWorkingHours(teh(THU, 12)), true);
  assert.equal(isWorkingHours(teh(THU, 18)), false);
  assert.equal(isWorkingHours(teh(FRI, 12)), false);
});

test('«همین الان» only inside working hours', () => {
  assert.deepEqual(timeOptions(true).map((o) => o.v), ['now', 'morning', 'evening']);
  assert.deepEqual(timeOptions(false).map((o) => o.v), ['morning', 'evening']);
});

test('next opening: today / tomorrow / next work day name', () => {
  assert.equal(nextOpening(teh(SAT, 7)), 'امروز');
  assert.equal(nextOpening(teh(TUE, 20)), 'فردا');
  assert.equal(nextOpening(teh(WED, 19)), 'فردا'); // Wed evening → Thursday
  assert.equal(nextOpening(teh(THU, 19)), 'شنبه'); // Thu evening → Saturday (Friday closed)
  assert.equal(nextOpening(teh(FRI, 10)), 'فردا'); // Friday → Saturday
});

test('copy: titles fixed, success line never promises minutes', () => {
  assert.equal(CB_TITLE, 'درخواست مشاوره‌ی رایگان');
  assert.equal(CB_SUBMIT, 'ثبت درخواست مشاوره');
  assert.equal(CB_DONE, 'درخواست مشاوره‌ی شما ثبت شد');
  assert.equal(successLine('morning', teh(TUE, 20)), 'فردا از ساعت ۹ صبح با شما تماس می‌گیریم.');
  assert.equal(successLine('now', teh(THU, 19)), 'شنبه از ساعت ۹ صبح با شما تماس می‌گیریم.');
  assert.equal(successLine('now', teh(WED, 19)), 'فردا از ساعت ۹ صبح با شما تماس می‌گیریم.');
  assert.match(successLine('evening', teh(SAT, 10)), /عصر \(۱۳ تا ۱۸\)/);
  for (const t of ['now', 'morning', 'evening'] as const)
    for (const at of [teh(SAT, 10), teh(SAT, 20), teh(FRI, 10)]) assert.doesNotMatch(successLine(t, at), /دقیقه/);
});

test('mobile normalisation: Persian/Arabic digits, spaces, dashes, +98 / 0098 / 98 / 9…', () => {
  for (const v of ['۰۹۱۲ ۳۴۵ ۶۷۸۹', '٠٩١٢٣٤٥٦٧٨٩', '+98 912 345 6789', '0098-912-345-6789', '989123456789', '9123456789'])
    assert.equal(normalizeIranMobile(v), '09123456789', v);
  for (const v of ['0912345678', '02191303819', '+1 912 345 6789', '']) assert.equal(normalizeIranMobile(v), null, v);
  assert.equal(faMobile('09123456789'), '۰۹۱۲ ۳۴۵ ۶۷۸۹');
});

test('step validation', () => {
  assert.deepEqual(step1Errors('سارا', '+98۹۱۲۳۴۵۶۷۸۹'), []);
  assert.deepEqual(step1Errors(' س ', '0912'), ['name', 'phone']);
  assert.deepEqual(step2Errors(null), ['time']);
  assert.deepEqual(step2Errors('evening'), []);
});

test('payload = handoff contract: kind, contactTime, optional need/planId, only allowed keys', () => {
  const p = buildCallbackPayload({ ...base, need: 'goods', planId: 19, utm: { utm_source: 'google', utm_medium: '' } }, teh(SAT, 10));
  assert.deepEqual(Object.keys(p).sort(), ['consent', 'contactTime', 'kind', 'name', 'need', 'phone', 'planId', 'src', 'startedAt', 'utm_source', 'website'].sort());
  assert.equal(p.kind, 'callback');
  assert.equal(p.name, 'سارا رضایی');
  assert.equal(p.phone, '09123456789');
  assert.equal(p.src, 'home-callback');
  const min = buildCallbackPayload(base, teh(SAT, 10));
  assert.equal('need' in min || 'planId' in min, false);
});

test('stale «همین الان» outside hours is sent as morning', () => {
  assert.equal(buildCallbackPayload({ ...base, contactTime: 'now' }, teh(SAT, 10)).contactTime, 'now');
  assert.equal(buildCallbackPayload({ ...base, contactTime: 'now' }, teh(SAT, 21)).contactTime, 'morning');
});

test('submitCallback: 2xx with code, duplicate without code, errors reject', async () => {
  const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await submitCallback(base, 'http://x', mk(201, { ok: true, trackingCode: 'CB-7K2M9Q' })), { trackingCode: 'CB-7K2M9Q' });
  assert.deepEqual(await submitCallback(base, 'http://x', mk(200, { ok: true, duplicate: true })), {});
  await assert.rejects(submitCallback(base, 'http://x', mk(429, { error: 'rate_limited' })), (e: { code: string; status: number }) => e.code === 'rate_limited' && e.status === 429);
  await assert.rejects(submitCallback(base, undefined, mk(201, {})), (e: { code: string }) => e.code === 'no_endpoint');
});

test('P3-C consent text is exact', () => {
  assert.equal(CONSENT_TEXT, 'با ثبت شماره، موافقت می‌کنید کارشناس نفیس وام برای مشاوره با شما تماس بگیرد. شماره‌تان جایی منتشر نمی‌شود.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSrc, postPublicLead, LeadError } from '../src/lib/lead';

// site-credit-noinst v1.1: the site has ONE body (type:'apply', tests/apply.test.ts); this file covers the shared POST.
const body = { type: 'apply', name: 'مریم احمدی', phone: '09123456789', consent: true, website: '', startedAt: 1, fillMs: 9000 };
const res = (status: number, b = '{}') => async () => new Response(status === 204 ? null : b, { status });

test('cleanSrc: slug only, lower-cased', () => {
  assert.equal(cleanSrc('Home-Finder'), 'home-finder');
  assert.equal(cleanSrc('x y'), undefined);
  assert.equal(cleanSrc(null), undefined);
});

test('success only on 2xx', async () => {
  await postPublicLead(body, 'https://x/api', res(201) as typeof fetch);
  await postPublicLead(body, 'https://x/api', res(204) as typeof fetch);
  await assert.rejects(postPublicLead(body, 'https://x/api', res(422, '{"ok":false,"error":"too_fast"}') as typeof fetch), (e: LeadError) => e.code === 'too_fast' && e.status === 422);
  await assert.rejects(postPublicLead(body, 'https://x/api', res(500, 'oops') as typeof fetch), (e: LeadError) => e.code === 'http');
  await assert.rejects(postPublicLead(body, 'https://x/api', (async () => { throw new TypeError('net'); }) as typeof fetch), (e: LeadError) => e.code === 'network');
});

test('missing endpoint is an error, never a fake success', async () => {
  await assert.rejects(postPublicLead(body, undefined), (e: LeadError) => e.code === 'no_endpoint');
});

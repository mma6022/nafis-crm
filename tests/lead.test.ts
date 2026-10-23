import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadPayload, submitLead, LeadError, type LeadInput } from '../src/lib/lead';

const base: LeadInput = {
  name: ' مریم احمدی ',
  phone: '۰۹۱۲ ۳۴۵ ۶۷۸۹',
  need: 'cash',
  amountBand: '100-200',
  contactTime: 'any',
  consent: true,
  website: '',
  startedAt: 1_700_000_000_000,
  src: 'Home-Finder',
  planId: 10,
  term: 36,
  utm: { utm_source: 'google', utm_medium: '' },
};

test('payload has only CRM keys, normalised phone, slug src', () => {
  const p = buildLeadPayload(base);
  assert.deepEqual(Object.keys(p).sort(), ['amountBand', 'consent', 'contactTime', 'name', 'need', 'phone', 'planId', 'src', 'startedAt', 'term', 'utm_source', 'website'].sort());
  assert.equal(p.phone, '09123456789');
  assert.equal(p.name, 'مریم احمدی');
  assert.equal(p.src, 'home-finder');
  assert.equal(p.website, '');
});

test('bad src dropped, term only with plan', () => {
  const p = buildLeadPayload({ ...base, src: 'x y', planId: null });
  assert.equal(p.src, undefined);
  assert.equal(p.term, undefined);
});

const res = (status: number, body = '{}') => async () => new Response(status === 204 ? null : body, { status });

test('success only on 2xx', async () => {
  await submitLead(base, 'https://x/api', res(201) as typeof fetch);
  await submitLead(base, 'https://x/api', res(204) as typeof fetch);
  await assert.rejects(submitLead(base, 'https://x/api', res(422, '{"ok":false,"error":"too_fast"}') as typeof fetch), (e: LeadError) => e.code === 'too_fast' && e.status === 422);
  await assert.rejects(submitLead(base, 'https://x/api', res(500, 'oops') as typeof fetch), (e: LeadError) => e.code === 'http');
  await assert.rejects(submitLead(base, 'https://x/api', (async () => { throw new TypeError('net'); }) as typeof fetch), (e: LeadError) => e.code === 'network');
});

test('missing endpoint is an error, never a fake success', async () => {
  await assert.rejects(submitLead(base, undefined), (e: LeadError) => e.code === 'no_endpoint');
});

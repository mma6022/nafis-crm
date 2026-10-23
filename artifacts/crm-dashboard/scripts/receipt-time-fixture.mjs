import assert from 'node:assert/strict';
import { receiptTime } from '../src/customer-portal/receipt-time.ts';

const now = new Date('2026-10-23T08:00:00Z'); // 11:30 Tehran
assert.equal(receiptTime('2026-10-23T06:54:00Z', now), 'امروز ۱۰:۲۴');
assert.equal(receiptTime('2026-10-22T19:35:00Z', now), 'دیروز ۲۳:۰۵');
assert.equal(receiptTime('2026-10-22T20:35:00Z', now), 'امروز ۰۰:۰۵', 'day boundary is Tehran midnight, not UTC');
assert.match(receiptTime('2026-10-01T06:54:00Z', now), /^۹ مهر ۱۴۰۵، ۱۰:۲۴$/);
assert.equal(receiptTime(null, now), null);
assert.equal(receiptTime('nope', now), null);
console.log('PASS: receipt time uses Tehran time, Persian digits and امروز/دیروز.');

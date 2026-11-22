// Cheap check for t882 quantity field: accept Persian/Latin input, display Persian, store ASCII.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/goods-api.ts');
const src = fs.readFileSync(srcPath, 'utf8');
assert.match(src, /export const digitsOnly/);
assert.match(src, /export const faId/);

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const digitsOnly = (v) => v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^0-9]/g, '');
const faId = (v) => String(v ?? '').replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

assert.equal(digitsOnly('1'), '1');
assert.equal(digitsOnly('۱'), '1');
assert.equal(digitsOnly('١'), '1');
assert.equal(digitsOnly('۱۲'), '12');
assert.equal(faId('1'), '۱');
assert.equal(faId(digitsOnly('۱۲')), '۱۲');
assert.equal(Number(digitsOnly('۳')), 3);
assert.equal(Number(digitsOnly('3')), 3);
assert.equal(faId('1') === '1', false);
console.log('t882 quantity digits check ok');

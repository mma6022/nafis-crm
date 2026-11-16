// LEAKS-46: node --experimental-strip-types scripts/customer-advice-filter-fixture.mjs
import assert from "node:assert/strict";
import { customerAdviceLeakReasons as r, customerSafeAdvice, CUSTOMER_ADVICE_FALLBACK } from "../src/lib/customer-advice-filter.ts";
const blocked = [
  ["سود این وام ۲۳ درصد است", ["percent", "interest"]], ["نرخ این طرح مناسب است", ["rate"]], ["اصل وام ۵۰ میلیون است", ["principal"]],
  ["اصل‌وام شما", ["principal"]], ["بهره سالانه کم است", ["interest"]], ["با ۱۸٪ سالانه", ["percent"]], ["20% deposit", ["percent"]],
  ["کارمزد ندارد", ["fee"]], ["the interest rate is low", ["interest", "rate"]], ["principal amount", ["principal"]], ["سودِ طرح", ["interest"]],
];
for (const [text, reasons] of blocked) assert.deepEqual(r(text).sort(), reasons.sort(), text);
const clean = [
  "مبلغ واریزی ۴۵ میلیون تومان و قسط ماهانه ۳ میلیون تومان در ۱۲ قسط است. [PLAN_ID:7]",
  "از این طرح بهره‌مند شوید و آسوده‌خاطر باشید.", "این طرح سودمند است", "ما درصدد کمک هستیم", "برای بهره برداری از طرح",
  "پیشنهاد: [PLAN_ID:3] و [PLAN_ID: 12]", "مدارک لازم: کارت ملی و فیش حقوقی", "separate accurate",
];
for (const text of clean) assert.deepEqual(r(text), [], text);
const s = customerSafeAdvice("طرح [PLAN_ID:7] با سود ۴ درصد و [PLAN_ID: 9]");
assert.equal(s.blocked, true); assert.equal(s.content, `${CUSTOMER_ADVICE_FALLBACK} [PLAN_ID:7] [PLAN_ID:9]`);
assert.deepEqual(r(s.content), []);
assert.equal(customerSafeAdvice(s.content).blocked, false);
const ok = customerSafeAdvice(clean[0]); assert.equal(ok.blocked, false); assert.equal(ok.content, clean[0]);
console.log(`customer-advice-filter: ok (${blocked.length} blocked, ${clean.length} clean)`);

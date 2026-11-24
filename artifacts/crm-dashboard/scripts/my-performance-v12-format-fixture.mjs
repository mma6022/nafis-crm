/**
 * عملکرد من v1.2 — faNum uses U+066C (not ASCII comma / U+060C).
 *   node --experimental-strip-types scripts/my-performance-v12-format-fixture.mjs
 */
import assert from "node:assert/strict";
import { FA_THOUSANDS, faNum, faPct, faToman } from "../src/features/my-performance-v12/format.ts";

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };

ok("faToman(12400000) groups with U+066C only", () => {
  const s = faToman(12_400_000);
  assert.equal(s, "۱۲\u066C۴۰۰\u066C۰۰۰ تومان");
  assert.equal(FA_THOUSANDS.codePointAt(0), 0x066C);
  assert.equal(faNum(12_400_000).codePointAt(2), 0x066C);
  const seps = [...s].filter((ch) => ch.codePointAt(0) === 0x066C);
  assert.equal(seps.length, 2);
  for (const ch of s) {
    assert.notEqual(ch.codePointAt(0), 0x002C, "ASCII comma");
    assert.notEqual(ch.codePointAt(0), 0x060C, "Arabic comma U+060C");
  }
  assert.equal(s.includes(","), false);
});

ok("faPct drops a trailing zero decimal", () => {
  assert.equal(faPct(0), "۰٪");
  assert.equal(faPct(10), "۱۰٪");
  assert.equal(faPct(10.0), "۱۰٪");
  assert.equal(faPct(8.2), "۸٫۲٪");
  assert.equal(faPct(50), "۵۰٪");
  assert.equal(faPct(66.7), "۶۶٫۷٪");
});

console.log(`passed ${passed} checks`);

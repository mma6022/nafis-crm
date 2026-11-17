/**
 * plan-advisor v1 display helpers (no new calculator math).
 *   node --experimental-strip-types scripts/plan-advisor-fixture.mjs
 */
import assert from "node:assert/strict";
import { faMonths, faNum, faToman, formatPrincipalInput, parsePrincipalInput, paStepLabel, paTotalPayable } from "../src/features/plan-advisor/helpers.ts";

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log("ok -", name); };

ok("§6.3 total payable is installment×count + down payment + file fee (commission stays out)", () => {
  assert.equal(paTotalPayable(22_332_024, 18, 0, 1_500_000), 22_332_024 * 18 + 1_500_000);
  assert.equal(paTotalPayable(1_000_000, 12, 5_000_000, 1_500_000), 18_500_000);
  assert.notEqual(paTotalPayable(1_000_000, 12, 0, 0) + 3_000_000, paTotalPayable(1_000_000, 12, 0, 0));
});

ok("Persian grouping and month list", () => {
  assert.equal(faNum(350_000_000), "۳۵۰٬۰۰۰٬۰۰۰");
  assert.ok(faToman(245_000_000).includes("تومان"));
  assert.equal(faMonths([]), "");
  assert.ok(faMonths([18]).includes("۱۸"));
  assert.ok(faMonths([12, 18, 24]).includes("و"));
});

ok("rendered numbers use the Persian thousands separator ٬, never a Latin comma", () => {
  const samples = [
    faNum(300_000_000), faNum(2301), faNum(18), faNum(12_300_000),
    faToman(19_864_314), faToman(357_857_652), faToman(12_300_000),
    formatPrincipalInput("300000000"), formatPrincipalInput("۳۰۰۰۰۰۰۰۰"),
    `سقف ${faToman(300_000_000)}`, `#${faNum(2301)}`,
  ];
  for (const s of samples) {
    assert.equal(s.includes(","), false, `Latin comma in ${JSON.stringify(s)}`);
    assert.equal(s.includes(","), false, s);
  }
  assert.equal(faNum(300_000_000), "۳۰۰٬۰۰۰٬۰۰۰");
  assert.equal(faNum(2301), "۲٬۳۰۱");
  assert.equal(faNum(18), "۱۸");
  assert.equal(faNum(12_300_000), "۱۲٬۳۰۰٬۰۰۰");
  assert.equal(formatPrincipalInput("300000000"), "۳۰۰٬۰۰۰٬۰۰۰");
  assert.ok(faNum(300_000_000).includes("٬"));
  assert.ok(faNum(2301).includes("٬"));
});

ok("principal input parses Western and Persian digits", () => {
  assert.equal(parsePrincipalInput("350000000"), 350_000_000);
  assert.equal(parsePrincipalInput("۳۵۰٬۰۰۰٬۰۰۰"), 350_000_000);
  assert.equal(parsePrincipalInput(""), null);
  assert.ok(formatPrincipalInput("350000000").includes("۳"));
});

ok("wizard step labels", () => {
  assert.ok(paStepLabel(0).includes("مشتری"));
  assert.ok(paStepLabel(1).includes("شرایط"));
  assert.ok(paStepLabel(3).includes("ماشین‌حساب"));
});

console.log(`\n${passed} passed`);

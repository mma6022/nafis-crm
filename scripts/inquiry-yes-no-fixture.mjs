/** Unit test: Today inquiry-column yes/no → دارد/ندارد. Never hits live. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { inquiryYesNoFa, inquiryGuarantorCondBits } from "../src/lib/inquiry-yes-no.ts";

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log("ok", name); }
  catch (e) { failed += 1; console.error("FAIL", name, e?.message || e); }
}

ok("yes / true → دارد", () => {
  assert.equal(inquiryYesNoFa("yes"), "دارد");
  assert.equal(inquiryYesNoFa("YES"), "دارد");
  assert.equal(inquiryYesNoFa("true"), "دارد");
  assert.equal(inquiryYesNoFa("  Yes  "), "دارد");
});
ok("no / false → ندارد", () => {
  assert.equal(inquiryYesNoFa("no"), "ندارد");
  assert.equal(inquiryYesNoFa("NO"), "ندارد");
  assert.equal(inquiryYesNoFa("false"), "ندارد");
});
ok("A1 and A2 stay unchanged", () => {
  assert.equal(inquiryYesNoFa("A1"), "A1");
  assert.equal(inquiryYesNoFa("A2"), "A2");
  assert.equal(inquiryYesNoFa("B2"), "B2");
});
ok("already-Persian and empty stay as-is", () => {
  assert.equal(inquiryYesNoFa("دارد"), "دارد");
  assert.equal(inquiryYesNoFa("ندارد"), "ندارد");
  assert.equal(inquiryYesNoFa(""), "");
  assert.equal(inquiryYesNoFa(null), "");
});

ok("چک ضامن: yes → دارد, no → ندارد", () => {
  const yes = inquiryGuarantorCondBits({ guarantorCheque: "yes" });
  assert.deepEqual(yes, ["چک ضامن: دارد"]);
  const no = inquiryGuarantorCondBits({ guarantorCheque: "no" });
  assert.deepEqual(no, ["چک ضامن: ندارد"]);
});
ok("ranks A1/A2 stay next to the mapped cheque label", () => {
  const bits = inquiryGuarantorCondBits({ guarantorCheque: "yes", gRank: "A2", gJobType: "employee" }, { employee: "کارمند" });
  assert.deepEqual(bits, ["چک ضامن: دارد", "رتبهٔ ضامن A2", "شغل ضامن: کارمند"]);
  assert.equal(bits.some((b) => /\byes\b|\bno\b/i.test(b)), false);
  const a1 = inquiryGuarantorCondBits({ gRank: "A1" });
  assert.deepEqual(a1, ["رتبهٔ ضامن A1"]);
});
ok("no leftover raw yes/no in other bits", () => {
  const bits = inquiryGuarantorCondBits({
    guarantorCheque: "YES",
    gRank: "A1",
    gJobType: "business",
    guarantorCondition: "با لیست بیمه",
  }, { business: "آزاد" });
  const text = bits.join("؛ ");
  assert.match(text, /چک ضامن: دارد/);
  assert.match(text, /رتبهٔ ضامن A1/);
  assert.match(text, /شغل ضامن: آزاد/);
  assert.match(text, /با لیست بیمه/);
  assert.equal(/\byes\b|\bno\b|\btrue\b|\bfalse\b/i.test(text), false);
});

const src = readFileSync(new URL("../src/lib/daily-customer-inline.ts", import.meta.url), "utf8");
ok("guarantorOf uses inquiryGuarantorCondBits, not raw cheque interpolation", () => {
  assert.match(src, /inquiryGuarantorCondBits\(a, JOB_LABELS\)/);
  assert.doesNotMatch(src, /چک ضامن: \$\{a\.guarantorCheque\}/);
});

if (failed) { console.error(failed, "failed"); process.exit(1); }
console.log("inquiry-yes-no fixture PASS");

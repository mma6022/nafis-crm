// Unit tests for t866 Bale identity parser. No DB, no network, no SAPI, no real customer data.
import assert from "node:assert/strict";
import {
  normalizeDigits, stripInvisible, normalizeIdentityText, validNationalChecksum,
  parseNationalId, parseBirthDate, extractIdentity, formatJalaliConfirm,
  nidFromNine, faDigits, CB_IDENTITY_STEPS_TEXTS, isYes, isNo, currentJalali,
} from "../src/lib/bale-identity-parse.ts";

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log("  ok ", name); }
  catch (e) { failures.push(name); console.error("  FAIL", name, e?.message ?? e); }
};

// Fixed «now» so range checks are stable: 21 Nov 2026 = 30 Aban 1405.
const NOW = new Date("2026-11-21T07:30:00.000Z");

const GOOD = nidFromNine("012345678"); // 0123456789
const GOOD9 = GOOD.slice(1);           // 9 digits, needs leading zero
const GOOD00 = nidFromNine("001234567"); // starts with 00 so an 8-digit typo pads back
const GOOD8 = GOOD00.slice(2);
assert.equal(GOOD.length, 10);
assert.ok(validNationalChecksum(GOOD), "fixture nid must be checksum-valid: " + GOOD);
assert.ok(validNationalChecksum(GOOD00), "00-padded fixture must be valid");
assert.equal(GOOD8.padStart(10, "0"), GOOD00);

console.log("\n== bale-identity-parse fixture ==\n");
console.log("  fixture nid shape", GOOD.slice(0, 2) + "******" + GOOD.slice(-2));

check("current jalali around Aban 1405 at the fixture now", () => {
  const j = currentJalali(NOW);
  assert.equal(j.year, 1405);
  assert.equal(j.month, 8);
});

check("normalize Persian and Arabic-Indic digits to Latin", () => {
  assert.equal(normalizeDigits("۰۱۲۳۴۵۶۷۸۹"), "0123456789");
  assert.equal(normalizeDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
  assert.equal(normalizeDigits("01۲۳٤٥"), "012345");
});

check("strip ZWNJ/ZWJ/LRM/RLM/bidi/BOM/NBSP", () => {
  const raw = "\u200e12\u200c34\u200d56\u200f78\u202a9\u202c\ufeff0";
  assert.equal(stripInvisible(raw), "1234567890");
  assert.equal(normalizeIdentityText("\u00a0۱۳۷۰\u202f/\u200c۵\u200f/\u200e۳"), "1370/5/3");
});

check("national id: 10 Latin, 10 Persian, 10 Arabic, dashes, spaces, pad 8-9", () => {
  const fa = normalizeDigits(GOOD).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const ar = normalizeDigits(GOOD).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
  assert.deepEqual(parseNationalId(GOOD), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(fa), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(ar), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(GOOD.slice(0, 5) + "-" + GOOD.slice(5)), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(GOOD.slice(0, 3) + " " + GOOD.slice(3, 6) + " " + GOOD.slice(6)), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(GOOD9), { ok: true, nid: GOOD });
  assert.deepEqual(parseNationalId(GOOD8), { ok: true, nid: GOOD00 });
  assert.deepEqual(parseNationalId(GOOD00), { ok: true, nid: GOOD00 });
  assert.equal(parseNationalId("\u200c" + GOOD + "\ufeff").ok, true);
});

check("national id: checksum and all-same rejected", () => {
  assert.deepEqual(parseNationalId("0012345678"), { ok: false, reason: "checksum" });
  assert.deepEqual(parseNationalId("0000000000"), { ok: false, reason: "checksum" });
  assert.deepEqual(parseNationalId("1111111111"), { ok: false, reason: "checksum" });
  assert.deepEqual(parseNationalId("123"), { ok: false, reason: "shape" });
  assert.deepEqual(parseNationalId("abc"), { ok: false, reason: "shape" });
});

const expectDate = (input, y, m, d) => {
  const r = parseBirthDate(input, NOW);
  assert.equal(r.ok, true, `expected ok for ${input}: ${JSON.stringify(r)}`);
  if (r.ok) {
    assert.equal(r.year, y);
    assert.equal(r.month, m);
    assert.equal(r.day, d);
    assert.equal(r.jalali, `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`);
  }
};

check("birth date: 1370/5/3, ۱۳۷۰-۰۵-۰۳, 13700503, dots, spaces", () => {
  expectDate("1370/5/3", 1370, 5, 3);
  expectDate("۱۳۷۰-۰۵-۰۳", 1370, 5, 3);
  expectDate("13700503", 1370, 5, 3);
  expectDate("1370.05.03", 1370, 5, 3);
  expectDate("1370 5 3", 1370, 5, 3);
  expectDate("1370/05/03", 1370, 5, 3);
});

check("birth date: 2-digit year 70/5/3 → 1370/05/03", () => {
  expectDate("70/5/3", 1370, 5, 3);
  expectDate("70-05-03", 1370, 5, 3);
});

check("birth date: dd/mm/yyyy order 3/5/1370", () => {
  expectDate("3/5/1370", 1370, 5, 3);
  expectDate("03/05/1370", 1370, 5, 3);
  expectDate("3-5-1370", 1370, 5, 3);
});

check("birth date: Gregorian year converted to Jalali", () => {
  // 1991-07-25 = 3 Mordad 1370 (UTC date parts via persian calendar)
  const r = parseBirthDate("1991/07/25", NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.year, 1370);
    assert.equal(r.month, 5);
    assert.equal(r.day, 3);
  }
  const r2 = parseBirthDate("25/07/1991", NOW);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  if (r2.ok) {
    assert.equal(r2.year, 1370);
    assert.equal(r2.month, 5);
    assert.equal(r2.day, 3);
  }
});

check("birth date: Persian month name", () => {
  expectDate("3 مرداد 1370", 1370, 5, 3);
  expectDate("۳ مرداد ۱۳۷۰", 1370, 5, 3);
  expectDate("1370 مرداد 3", 1370, 5, 3);
});

check("birth date: year-only is incomplete (live failed shape)", () => {
  const r = parseBirthDate("۱۳۵۳", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "shape");
  const r2 = parseBirthDate("تاریخ تولد ۱۳۵۳", NOW);
  assert.equal(r2.ok, false);
});

check("birth date: invalid day and future / too old rejected", () => {
  const r = parseBirthDate("1370/12/31", NOW); // Esfand 31 never
  assert.equal(r.ok, false);
  const future = parseBirthDate("1410/1/1", NOW);
  assert.equal(future.ok, false);
  const ancient = parseBirthDate("1190/1/1", NOW);
  assert.equal(ancient.ok, false);
});

check("confirm text uses Persian month and digits", () => {
  const t = formatJalaliConfirm({ year: 1370, month: 5, day: 3, jalali: "1370/05/03" });
  assert.equal(t, "تاریخ تولد شما ۳ مرداد ۱۳۷۰ است؟ بله/خیر");
  assert.equal(isYes("بله"), true);
  assert.equal(isYes("بلی"), true);
  assert.equal(isNo("خیر"), true);
  assert.equal(isNo("نه"), true);
  assert.equal(isYes("خیر"), false);
});

/* ----- real failed conversation SHAPES (synthetic values, same structure) ----- */

check("shape 2371-a: Latin 10-digit NID alone (no date in same message)", () => {
  const ex = extractIdentity(GOOD, NOW);
  assert.equal(ex.nid, GOOD);
  assert.equal(ex.birth, undefined);
});

check("shape 2371-b: «تاریخ تولد ۱۳۵۳» year only, Persian digits", () => {
  const ex = extractIdentity("تاریخ تولد ۱۳۵۳", NOW);
  assert.equal(ex.nid, undefined);
  assert.ok(!ex.birth);
});

check("shape 2371-c: «کد ملی» stuck to Latin 10-digit NID, no date", () => {
  const ex = extractIdentity("کد ملی" + GOOD, NOW);
  assert.equal(ex.nid, GOOD);
  assert.equal(ex.birth, undefined);
});

check("shape 2371-d: Latin 10-digit NID + spaces + Persian year only", () => {
  const ex = extractIdentity(`${GOOD}    ۱۳۵۳`, NOW);
  assert.equal(ex.nid, GOOD);
  assert.ok(!ex.birth, "year alone must not count as a full date");
});

check("shape 2371-e: «کدملی NID. تاریخ تولد YYYY/MM/D» mixed Persian NID + Latin month/day, period after NID", () => {
  // Live JS regex fails: Persian digits + period immediately after the 10 digits
  // (wording and '/' separators match the 16 Nov 17:43 attempt of customer 2371; digits are synthetic).
  const faNid = GOOD.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const msg = `کدملی ${faNid}. تاریخ تولد ۱۳۷۰/05/3`;
  const ex = extractIdentity(msg, NOW);
  assert.equal(ex.nid, GOOD, JSON.stringify(ex));
  assert.ok(ex.birth, JSON.stringify(ex));
  assert.equal(ex.birth.year, 1370);
  assert.equal(ex.birth.month, 5);
  assert.equal(ex.birth.day, 3);
});

check("shape 2344-today: two-line all-Persian NID + YYYY/M/DD (would match JS regex after digit normalise)", () => {
  const faNid = GOOD.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const msg = `${faNid}\n۱۳۷۰/۵/۰۳`;
  const ex = extractIdentity(msg, NOW);
  assert.equal(ex.nid, GOOD, JSON.stringify(ex));
  assert.equal(ex.birth?.jalali, "1370/05/03", JSON.stringify(ex));
});

check("shape: Latin NID and date on two lines — the 10 historical messages that already matched JS regex", () => {
  const msg = `${GOOD}\n1370/05/03`;
  const ex = extractIdentity(msg, NOW);
  assert.equal(ex.nid, GOOD);
  assert.equal(ex.birth?.jalali, "1370/05/03");
});

check("shape: 8-digit Persian NID (missing leading zeros) + Persian date on two lines (cust 2044 20 Nov)", () => {
  const fa8 = GOOD8.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const msg = `${fa8}\n۱۳۷۰/۰۵/۰۳`;
  const ex = extractIdentity(msg, NOW);
  assert.equal(ex.nid, GOOD00, JSON.stringify(ex));
  assert.equal(ex.birth?.jalali, "1370/05/03");
});

check("shape: 9-digit Latin NID then month-name date (cust 2259)", () => {
  const msg = `${GOOD9}\n3 مرداد 1370`;
  const ex = extractIdentity(msg, NOW);
  assert.equal(ex.nid, GOOD, JSON.stringify(ex));
  assert.equal(ex.birth?.jalali, "1370/05/03");
});

check("shape: both in one message with labels still extracts both", () => {
  const ex = extractIdentity(`کد ملی ${GOOD} تاریخ تولد 1370/5/3`, NOW);
  assert.equal(ex.nid, GOOD);
  assert.equal(ex.birth?.jalali, "1370/05/03");
});

check("prompts are the exact short Persian strings", () => {
  assert.ok(CB_IDENTITY_STEPS_TEXTS.askNid.includes("لطفاً فقط کد ملی‌تان را بفرستید"));
  assert.ok(CB_IDENTITY_STEPS_TEXTS.askNid.includes("مثال: ۰۰۱۲۳۴۵۶۷۸"));
  assert.ok(CB_IDENTITY_STEPS_TEXTS.askBirth.includes("حالا تاریخ تولد شمسی‌تان را بفرستید"));
  assert.ok(CB_IDENTITY_STEPS_TEXTS.askBirth.includes("مثال: ۱۳۷۰/۵/۳"));
  assert.equal(typeof CB_IDENTITY_STEPS_TEXTS.retryNidChecksum, "string");
});

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok\n");

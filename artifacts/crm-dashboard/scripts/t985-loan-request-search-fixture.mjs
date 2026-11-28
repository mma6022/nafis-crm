// t985: client-side wizard matcher (matchesCustomerSearch) — normalization, digits, #id.
import assert from "node:assert/strict";
import { matchesCustomerSearch, rankExactCustomerId, parseCustomerIdQuery } from "../src/lib/customer-id.ts";
import { normalizePersianSearchText } from "../src/lib/search.ts";

let n = 0;
const check = (name, fn) => { fn(); n++; console.log("ok -", name); };

const own = [
  { id: 1, name: "حديثه هشی‌مند", phone: "09120001111", nationalCode: "0012345678" },
  { id: 2, name: "علی رضایی", phone: "09123334444", nationalCode: "1122334455" },
];
const hit = (q) => rankExactCustomerId(
  own.filter((r) => matchesCustomerSearch(q, { id: r.id, name: r.name, phone: r.phone, extra: [r.nationalCode] })),
  q,
  (r) => r.id,
).map((r) => r.id);

check("Persian yeh matches stored Arabic yeh", () => {
  assert.deepEqual(hit("حدیثه"), [1]);
  assert.deepEqual(hit("حديثه"), [1]);
});
check("ZWNJ and partial last name", () => {
  assert.deepEqual(hit("هشیمند"), [1]);
  assert.deepEqual(hit("هشی‌مند"), [1]);
  assert.equal(normalizePersianSearchText("هشی‌مند"), "هشیمند");
});
check("phone Latin and Persian digits", () => {
  assert.deepEqual(hit("09120001111"), [1]);
  assert.deepEqual(hit("۰۹۱۲۰۰۰۱۱۱۱"), [1]);
  assert.deepEqual(hit("0001111"), [1]);
});
check("national id Latin and Persian digits", () => {
  assert.deepEqual(hit("0012345678"), [1]);
  assert.deepEqual(hit("۰۰۱۲۳۴۵۶۷۸"), [1]);
});
check("#id exact, bare number ranks id first", () => {
  assert.deepEqual(parseCustomerIdQuery("#۱"), { id: 1, explicit: true });
  assert.deepEqual(hit("#1"), [1]);
  assert.deepEqual(hit("#2"), [2]);
  assert.deepEqual(hit("علی"), [2]);
});

console.log(`PASS: t985 client loan-request search (${n} checks).`);

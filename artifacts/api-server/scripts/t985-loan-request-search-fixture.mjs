// t985: loan-request wizard customer search — normalization, digits, purpose, assigned scope.
// Synthetic in-memory data only. No live DB, no PII.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerCustomerIdentityFunctions, normalizePersianSearchText, normalizeCustomerNationalCode, normalizeCustomerMobile } from "../src/lib/customer-integrity.ts";
import { customerSearchSql } from "../src/lib/customer-id-search.ts";
import { dpSearchPurposeAllowed, DP_SEARCH_PURPOSES } from "../src/lib/dp-search-purpose.ts";

let n = 0;
const check = (name, fn) => { fn(); n++; console.log("ok -", name); };

check("purpose allowlist", () => {
  assert.equal(dpSearchPurposeAllowed("incoming_call"), true);
  assert.equal(dpSearchPurposeAllowed("loan_request"), true);
  assert.equal(dpSearchPurposeAllowed(""), false);
  assert.equal(dpSearchPurposeAllowed("customers"), false);
  assert.equal(dpSearchPurposeAllowed(undefined), false);
  assert.ok(DP_SEARCH_PURPOSES.has("loan_request"));
});

const db = new DatabaseSync(":memory:");
registerCustomerIdentityFunctions(db);
db.exec(`
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    national_code TEXT,
    salesperson_id INTEGER,
    merged_into_customer_id INTEGER
  );
  CREATE TABLE customer_phones(
    customer_id INTEGER NOT NULL,
    phone TEXT NOT NULL
  );
`);
const ins = db.prepare("INSERT INTO customers(id,name,phone,national_code,salesperson_id,merged_into_customer_id) VALUES(?,?,?,?,?,NULL)");
// Expert A (sp=3) owns row 1: Arabic yeh in first name, ZWNJ in last name, Persian-looking stored digits are Latin here.
ins.run(1, "حديثه هشی‌مند", "09120001111", "0012345678", 3);
ins.run(2, "علی رضایی", "09123334444", "1122334455", 3);
// Expert B (sp=4) owns a similar first name — must not appear in A's assigned search.
ins.run(3, "حدیثه دیگری", "09125556666", "9988776655", 4);
ins.run(4, "ستایش نمونه", "09127778888", "5566778899", 4);

const ANY_PHONE_LIKE_SQL = "EXISTS (SELECT 1 FROM customer_phones xp WHERE xp.customer_id=c.id AND xp.phone LIKE ?)";
db.prepare("INSERT INTO customer_phones(customer_id,phone) VALUES(?,?)").run(2, "09359876543");

function listFor(sp, raw) {
  const filters = ["c.merged_into_customer_id IS NULL", "c.salesperson_id = ?"];
  const params = [sp];
  const idSearch = raw ? customerSearchSql(raw) : null;
  if (raw && idSearch) {
    const searchDigits = idSearch.text.replace(/\D/g, "");
    const namePhone = `(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ? OR ${ANY_PHONE_LIKE_SQL}`;
    const existing = searchDigits.length >= 4
      ? `${namePhone} OR crm_customer_national_code_key(c.national_code) LIKE ?)`
      : `${namePhone})`;
    const existingParams = searchDigits.length >= 4
      ? [`%${idSearch.text}%`, `%${idSearch.text}%`, `%${idSearch.text}%`, `%${searchDigits}%`]
      : [`%${idSearch.text}%`, `%${idSearch.text}%`, `%${idSearch.text}%`];
    const clause = idSearch.where(existing, existingParams, "c.id");
    filters.push(clause.sql);
    params.push(...clause.params);
  }
  const order = idSearch?.orderPrefix("c.id") ?? { sql: "", params: [] };
  return db.prepare(`SELECT id FROM customers c WHERE ${filters.join(" AND ")} ORDER BY ${order.sql}c.id`).all(...params, ...order.params).map((r) => r.id);
}

check("partial first name with Persian yeh finds Arabic-yeh own customer only", () => {
  assert.deepEqual(listFor(3, "حدیثه"), [1]);
  assert.deepEqual(listFor(4, "حدیثه"), [3]);
});
check("ZWNJ last name matches typed form without ZWNJ", () => {
  assert.deepEqual(listFor(3, "هشیمند"), [1]);
  assert.deepEqual(listFor(3, "هشی‌مند"), [1]);
});
check("scope: another expert's customer is not in assigned results", () => {
  assert.deepEqual(listFor(3, "ستایش"), []);
  assert.deepEqual(listFor(4, "ستایش"), [4]);
});
check("phone: Latin, Persian and partial digits", () => {
  assert.deepEqual(listFor(3, "09120001111"), [1]);
  assert.deepEqual(listFor(3, "۰۹۱۲۰۰۰۱۱۱۱"), [1]);
  assert.deepEqual(listFor(3, "0001111"), [1]);
  assert.deepEqual(listFor(3, "09359876543"), [2], "extra phone");
});
check("national id: Latin and Persian digits", () => {
  assert.deepEqual(listFor(3, "0012345678"), [1]);
  assert.deepEqual(listFor(3, "۰۰۱۲۳۴۵۶۷۸"), [1]);
  assert.deepEqual(listFor(3, "12345678"), [1], "partial national id");
  assert.equal(normalizeCustomerNationalCode("۰۰۱۲۳۴۵۶۷۸"), "0012345678");
});
check("#id is exact and stays in assigned scope", () => {
  assert.deepEqual(listFor(3, "#1"), [1]);
  assert.deepEqual(listFor(3, "#۱"), [1]);
  assert.deepEqual(listFor(3, "#3"), [], "other owner's id is out of scope");
  assert.deepEqual(listFor(4, "#3"), [3]);
});
check("normalize helpers", () => {
  assert.equal(normalizePersianSearchText("حديثه هشی‌مند"), "حدیثه هشیمند");
  assert.equal(normalizeCustomerMobile("۰۹۱۲۱۱۱۲۲۲۲"), "09121112222");
});

db.close();
console.log(`PASS: t985 loan-request search (${n} checks).`);

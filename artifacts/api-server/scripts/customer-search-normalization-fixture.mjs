import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  normalizePersianSearchText,
  registerCustomerIdentityFunctions,
} from "../src/lib/customer-integrity.ts";

const db = new DatabaseSync(":memory:");
registerCustomerIdentityFunctions(db);
db.exec("CREATE TABLE customers(name TEXT NOT NULL);");
db.prepare("INSERT INTO customers(name) VALUES (?)").run("علي رضايي");
db.prepare("INSERT INTO customers(name) VALUES (?)").run("محمد کاظمی");
db.prepare("INSERT INTO customers(name) VALUES (?)").run("حديثه نمونه");
db.prepare("INSERT INTO customers(name) VALUES (?)").run("ستایش هشی‌مند");

const search = (term) => db.prepare(`
  SELECT name FROM customers
  WHERE crm_persian_search_key(name) LIKE crm_persian_search_key(?)
  ORDER BY name
`).all(`%${term}%`).map(({ name }) => name);

assert.deepEqual(search("علی"), ["علي رضايي"], "Persian ya finds an Arabic-ya customer name");
assert.deepEqual(search("علي"), ["علي رضايي"], "Arabic ya finds the same customer name");
assert.deepEqual(search("رضایی"), ["علي رضايي"], "Persian ya works inside a longer name");
assert.deepEqual(search("کاظمی"), ["محمد کاظمی"], "Persian kaf remains searchable");
assert.equal(normalizePersianSearchText("يىك"), "ییک");
assert.deepEqual(search("حدیثه"), ["حديثه نمونه"], "Persian yeh finds a name stored with Arabic yeh");
assert.deepEqual(search("حديثه"), ["حديثه نمونه"], "Arabic yeh finds the same stored name");
assert.deepEqual(search("هشیمند"), ["ستایش هشی‌مند"], "query without ZWNJ finds a name stored with ZWNJ");
assert.deepEqual(search("هشی‌مند"), ["ستایش هشی‌مند"], "query with ZWNJ finds the same name");
assert.equal(normalizePersianSearchText("هشی‌مند"), "هشیمند");
assert.equal(normalizePersianSearchText("  علی   رضا  "), "علی رضا");
db.close();
console.log("PASS: customer-name searches match Arabic and Persian ya variants, and ZWNJ, without changing stored names.");

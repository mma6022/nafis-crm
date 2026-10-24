// Customer id search: «1234», «#1234», «#۱۲۳۴», Arabic digits; exact id ranks first.
// Synthetic in-memory data only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { customerSearchSql, parseCustomerIdQuery, normalizeCustomerSearchText, toLatinDigits } from "../src/lib/customer-id-search";
import * as client from "../../crm-dashboard/src/lib/customer-id";

let n = 0;
const check = (name, fn) => { fn(); n++; console.log("ok -", name); };

check("digits", () => {
  assert.equal(toLatinDigits("۱۲۳۴"), "1234");
  assert.equal(toLatinDigits("١٢٣٤"), "1234");
  assert.equal(client.toPersianDigits(1234), "۱۲۳۴");
});
check("parse", () => {
  for (const [raw, want] of [["1234", { id: 1234, explicit: false }], ["#1234", { id: 1234, explicit: true }], ["#۱۲۳۴", { id: 1234, explicit: true }],
    ["۱۲۳۴", { id: 1234, explicit: false }], ["١٢٣٤", { id: 1234, explicit: false }], ["＃ 12", { id: 12, explicit: true }], [" 7 ", { id: 7, explicit: false }]]) {
    assert.deepEqual(parseCustomerIdQuery(raw), want, raw);
    assert.deepEqual(client.parseCustomerIdQuery(raw), want, "client " + raw);
  }
  for (const raw of ["", "#", "0", "#0", "علی", "12a", "1234567890", "12 34"]) {
    assert.equal(parseCustomerIdQuery(raw), null, raw);
    assert.equal(client.parseCustomerIdQuery(raw), null, "client " + raw);
  }
  assert.equal(normalizeCustomerSearchText("#۰۹۱۲"), "0912");
});

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE c(id INTEGER PRIMARY KEY, name TEXT, phone TEXT);
  CREATE TABLE o(id INTEGER PRIMARY KEY, customer_id INTEGER);`);
const ins = db.prepare("INSERT INTO c VALUES(?,?,?)");
ins.run(12, "مشتری دوازده", "09120001234");
ins.run(1234, "مشتری نمونه", "09125550000");
ins.run(55, "مشتری ۱۲۳۴", "09129990000");
ins.run(77, "دیگری", "09121112222");
db.prepare("INSERT INTO o VALUES(1234, 77)").run();
db.prepare("INSERT INTO o VALUES(9, 1234)").run();
db.prepare("INSERT INTO o VALUES(10, 12)").run();

const customers = (raw) => {
  const s = customerSearchSql(raw);
  const t = s.text;
  const w = s.where("(c.name LIKE ? OR c.phone LIKE ?)", [`%${t}%`, `%${t}%`], "c.id");
  const r = s.orderPrefix("c.id");
  return db.prepare(`SELECT id FROM c WHERE ${w.sql} ORDER BY ${r.sql}id`).all(...w.params, ...r.params).map((x) => x.id);
};
check("bare number keeps text matches and ranks id first", () => {
  assert.deepEqual(customers("1234"), [1234, 12]);
  assert.deepEqual(customers("۱۲۳۴"), [1234, 12]);
  assert.deepEqual(customers("١٢٣٤"), [1234, 12]);
});
check("#id means id only", () => {
  assert.deepEqual(customers("#1234"), [1234]);
  assert.deepEqual(customers("#۱۲۳۴"), [1234]);
  assert.deepEqual(customers("#99"), []);
});
check("text search unchanged", () => {
  assert.deepEqual(customers("نمونه"), [1234]);
  assert.deepEqual(customers("0912111"), [77]);
});
check("record lists: #n = customer n or record n, customer first", () => {
  const s = customerSearchSql("#1234");
  const w = s.where("(CAST(o.id AS TEXT)=?)", [s.text], "o.customer_id", { sql: "CAST(o.id AS TEXT)=?", params: [s.text] });
  const r = s.orderPrefix("o.customer_id");
  const rows = db.prepare(`SELECT id FROM o WHERE ${w.sql} ORDER BY ${r.sql}id`).all(...w.params, ...r.params).map((x) => x.id);
  assert.deepEqual(rows, [9, 1234]);
});
check("client matcher and ranking", () => {
  const rows = [{ id: 12, name: "مشتری دوازده", phone: "09120001234" }, { id: 55, name: "مشتری ۱۲۳۴" }, { id: 1234, name: "مشتری نمونه" }];
  const hit = (q) => client.rankExactCustomerId(rows.filter((r) => client.matchesCustomerSearch(q, r)), q, (r) => r.id).map((r) => r.id);
  assert.deepEqual(hit("1234"), [1234, 12, 55]);
  assert.deepEqual(hit("#۱۲۳۴"), [1234]);
  assert.deepEqual(hit("نمونه"), [1234]);
  assert.deepEqual(hit(""), [12, 55, 1234]);
});
console.log(`customer-id-search: ${n} checks passed`);

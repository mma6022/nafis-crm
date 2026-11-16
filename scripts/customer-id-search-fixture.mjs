// Customer id search: «1234», «#1234», «#۱۲۳۴», Arabic digits; exact id ranks first.
// Synthetic in-memory data only.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { customerSearchSql, commissionStatusSearchSql, parseCustomerIdQuery, normalizeCustomerSearchText, toLatinDigits } from "../src/lib/customer-id-search";
import { registerCustomerIdentityFunctions } from "../src/lib/customer-integrity";
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
registerCustomerIdentityFunctions(db);
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
// Commission status list (staff-wallet commissionStatusList): t=transfer, o=payment order, c=customer.
db.exec(`CREATE TABLE t(purchase_id INTEGER, order_id INTEGER, customer_id INTEGER, changed_at TEXT);`);
const tIns = db.prepare("INSERT INTO t VALUES(?,?,?,?)");
tIns.run(1234, 9, 77, "2026-10-20");   // purchase #1234 of another customer — newest
tIns.run(500, 1234, 12, "2026-10-19"); // payment order #1234 of another customer
tIns.run(501, 10, 1234, "2026-10-01"); // customer 1234 — oldest, must still rank first
tIns.run(502, 11, 55, "2026-10-18");
const commission = (raw) => {
  const s = commissionStatusSearchSql(raw);
  const where = s.where ? `WHERE ${s.where.sql}` : "";
  return db.prepare(`SELECT t.purchase_id id FROM t LEFT JOIN o ON o.id=t.order_id JOIN c ON c.id=t.customer_id ${where} ORDER BY ${s.order.sql}changed_at DESC,t.purchase_id DESC`)
    .all(...(s.where?.params ?? []), ...s.order.params).map((x) => x.id);
};
check("commissions: customer id first in all four forms, purchase/order numbers still found", () => {
  for (const q of ["1234", "#1234", "#۱۲۳۴", "۱۲۳۴", "١٢٣٤"]) assert.equal(commission(q)[0], 501, q);
  assert.deepEqual(commission("1234"), [501, 1234, 500]);
});
check("commissions: name and mobile search unchanged, empty = all", () => {
  assert.deepEqual(commission("نمونه"), [501]);
  assert.deepEqual(commission("0912111"), [1234]);
  assert.deepEqual(commission("۰۹۱۲۱۱۱"), [1234]);
  assert.deepEqual(commission(""), [1234, 500, 502, 501]);
});

// Loan applications / payment orders: same clause shapes as the routes, now with mobile.
db.exec(`CREATE TABLE a(id INTEGER PRIMARY KEY, customer_id INTEGER);
  INSERT INTO a VALUES(1234, 77); INSERT INTO a VALUES(3, 1234); INSERT INTO a VALUES(4, 12);`);
const loans = (raw) => {
  const s = customerSearchSql(raw); const like = `%${s.text}%`;
  const w = s.where("(CAST(a.id AS TEXT) LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)", [like, like, like], "c.id", { sql: "a.id=?", params: [s.idQuery?.id ?? 0] });
  const r = s.orderPrefix("c.id");
  return db.prepare(`SELECT a.id FROM a JOIN c ON c.id=a.customer_id WHERE ${w.sql} ORDER BY ${r.sql}a.id DESC`).all(...w.params, ...r.params).map((x) => x.id);
};
const orders = (raw) => {
  const s = customerSearchSql(raw); const t = s.text;
  const w = s.where("(c.name LIKE ? OR c.phone LIKE ? OR CAST(o.id AS TEXT)=?)", [`%${t}%`, `%${t}%`, t], "c.id", { sql: "CAST(o.id AS TEXT)=?", params: [t] });
  const r = s.orderPrefix("c.id");
  return db.prepare(`SELECT o.id FROM o JOIN c ON c.id=o.customer_id WHERE ${w.sql} ORDER BY ${r.sql}o.id DESC`).all(...w.params, ...r.params).map((x) => x.id);
};
check("loan applications: id first (four forms) and mobile match", () => {
  for (const q of ["1234", "#1234", "#۱۲۳۴", "۱۲۳۴"]) assert.equal(loans(q)[0], 3, q);
  assert.deepEqual(loans("#1234"), [3, 1234]);
  assert.deepEqual(loans("0912111"), [1234]);
  assert.deepEqual(loans("۰۹۱۲۵۵۵"), [3]);
});
check("payment orders: id first (four forms) and mobile match", () => {
  for (const q of ["1234", "#1234", "#۱۲۳۴", "۱۲۳۴"]) assert.equal(orders(q)[0], 9, q);
  assert.deepEqual(orders("#1234"), [9, 1234]);
  assert.deepEqual(orders("0912111"), [1234]);
});

// Source guards: the routes really use these shapes; placeholders say exactly the agreed text.
// Bundled into a temp dir, so resolve from the api-server package (scripts run with cwd = artifacts/api-server).
const src = (p) => readFileSync(new URL(p, `file://${process.cwd()}/scripts/`), "utf8");
check("routes carry the mobile / ranking clauses", () => {
  assert.match(src("../src/routes/loan-applications.ts"), /OR c\.phone LIKE \? OR p\.name LIKE \?\)", \[s, s, s, s\]/);
  assert.match(src("../src/routes/payment-orders.ts"), /OR c\.phone LIKE \? OR CAST\(o\.id AS TEXT\)=\?\)", \[`%\$\{t\}%`, `%\$\{t\}%`, t\]/);
  const wallet = src("../src/routes/wallet-management.ts");
  assert.ok(!/statusView && phoneDigits/.test(wallet), "wallet mobile search applies to every view");
  assert.match(wallet, /ORDER BY \$\{txRank\.sql\}createdAt DESC/);
  assert.match(src("../src/lib/staff-wallet.ts"), /ORDER BY \$\{commissionSearch\.order\.sql\}changed_at DESC/);
});
check("dashboard placeholders and consultation picker", () => {
  const P = "جست‌وجو با نام، موبایل یا شناسه (#۱۲۳۴)";
  const N = "جست‌وجو با نام یا شناسه (#۱۲۳۴)";
  const dash = (f) => src(`../../crm-dashboard/src/${f}`);
  for (const f of ["pages/Phone.tsx", "components/loan-applications/RequestDraftsQueue.tsx", "pages/Customers.tsx", "components/CallCustomerSelect.tsx", "components/CallCustomerPicker.tsx", "chat/StaffChatPage.tsx",
    "pages/WalletManagement.tsx", "pages/GoodsPurchases.tsx", "pages/InstagramInbox.tsx", "pages/CallbackRequests.tsx", "pages/PaymentOrders.tsx",
    "components/loan-applications/CreateWizard.tsx", "pages/LoanApplications.tsx", "pages/Consultations.tsx", "pages/Calls.tsx",
    "features/tx-status/TransactionsStatus.tsx", "components/Forms.tsx"]) assert.ok(dash(f).includes(P), f);
  for (const f of ["features/SocialMonitorReports.tsx", "pages/ManualVerifications.tsx"]) assert.ok(dash(f).includes(N), f);
  const consult = dash("pages/Consultations.tsx");
  assert.match(consult, /<CallCustomerSelect id="consult-customer"/);
  assert.ok(!/useListCustomers\(\{ limit: 100 \}/.test(consult), "no 100-customer cap");
});
console.log(`customer-id-search: ${n} checks passed`);

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// No production/customer databases, credentials, network or provider jobs.
const temp = await mkdtemp(path.join(os.tmpdir(), "registration-suggestions-"));
const db = new DatabaseSync(":memory:");
try {
  const out = path.join(temp, "suggestions.mjs");
  await build({ stdin: { contents: `
    export * from "./src/lib/registration-suggestions";
    export {registerCustomerIdentityFunctions} from "./src/lib/customer-integrity";`,
    resolveDir: process.cwd(), sourcefile: "suggestions-fixture.ts" },
    bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
  const f = await import(pathToFileURL(out).href);
  f.registerCustomerIdentityFunctions(db);
  db.exec(`
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,salesperson_id INTEGER,merged_into_customer_id INTEGER);
    CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE loan_plans(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE loan_applications(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,stage TEXT,status TEXT,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE goods_plan_wallets(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,balance_toman TEXT);
    CREATE TABLE goods_credit_lots(application_id INTEGER,purchase_id INTEGER,consumed INTEGER);
    CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY,customer_id INTEGER,plan_id INTEGER,wallet_id INTEGER,stage TEXT,payout_amount_toman TEXT,completed_at TEXT);
    CREATE TABLE customer_payment_orders(id INTEGER PRIMARY KEY,purchase_id INTEGER);
    CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
    INSERT INTO salespersons VALUES(10,'Synthetic A'),(20,'Synthetic B');
    INSERT INTO customers VALUES
      (1,'مشتري يك','09120000001',10,NULL),(2,'Synthetic two','09120000002',20,NULL),
      (3,'Archived audited','09120000003',10,4),(4,'Survivor','09120000004',20,NULL),
      (5,'Archived unaudited','09120000005',10,4);
    INSERT INTO customer_merge_audit VALUES(3,4);
    INSERT INTO loan_plans VALUES(1,'Used plan'),(2,'Available plan'),(3,'Reserved plan'),(4,'Unattributed plan'),(5,'Legacy plan');
    INSERT INTO goods_plan_wallets VALUES(1,1,1,'9000'),(2,1,2,'8000'),(3,1,3,'7000'),(4,1,4,'6000'),(5,2,2,'5000');
    INSERT INTO loan_applications VALUES
      (1,1,4,'completed','approved',NULL,'2026-01-01'),
      (2,1,2,'completed','approved',NULL,'2026-01-02'),
      (3,1,1,'completed','approved',NULL,'2026-01-03'),
      (4,1,2,'admin_approval','reviewing',NULL,'2026-01-04'),
      (5,1,2,'completed','approved','deleted','2026-01-05'),
      (6,2,2,'completed','approved',NULL,'2026-01-06'),
      (7,3,2,'completed','approved',NULL,'2026-01-07'),
      (8,1,3,'completed','approved',NULL,'2026-01-08'),
      (9,1,1,'completed','approved',NULL,'2026-01-09'),
      (10,1,2,'completed','approved',NULL,'2026-01-10'),
      (11,1,5,'completed','approved',NULL,'2026-01-11');
    INSERT INTO goods_credit_lots VALUES(2,NULL,0),(3,1,1),(6,NULL,0),(8,NULL,0),(9,NULL,0),(10,NULL,0);
    INSERT INTO goods_purchases VALUES
      (1,1,1,1,'completed','8000','2026-01-01'),
      (2,1,3,3,'invoice_draft','7000',NULL),
      (3,2,2,5,'completed','5000','2026-01-03'),
      (4,3,2,99,'completed','4000','2026-01-04'),
      (5,1,5,98,'completed','3000','2026-01-05'),
      (6,5,2,97,'completed','2000','2026-01-06'),
      (7,1,2,2,'completed','0','2026-01-07');
    INSERT INTO customer_payment_orders VALUES(1,3);
  `);
  const admin = { role: "admin", customerScope: "all", salespersonId: null };
  const assigned = { role: "custom-registrar", customerScope: "assigned", salespersonId: 10 };
  const other = { ...assigned, salespersonId: 20 };
  const noIdentity = { ...assigned, salespersonId: null };
  const goods = actor => f.goodsRegistrationSuggestions(db, actor, {});
  const payments = actor => f.paymentRegistrationSuggestions(db, actor, {});
  const ids = result => result.items.map(row => row.applicationId);
  const changed = db.prepare("SELECT total_changes() n").get().n;
  assert.deepEqual(ids(goods(assigned)), [1, 2, 8, 9, 10]);
  assert.deepEqual(ids(goods(other)), [6]);
  assert.equal(goods(noIdentity).total, 0);
  assert.equal(goods(admin).total, 6);
  assert.equal(goods(assigned).items.find(r => r.applicationId === 2).canCreate, true);
  assert.equal(goods(assigned).items.find(r => r.applicationId === 1).canCreate, false, "unattributed credit is visible, never fabricated");
  assert.equal(goods(assigned).items.find(r => r.applicationId === 8).canCreate, false, "reserved wallet remains guarded");
  assert.ok(ids(goods(assigned)).includes(9), "a prior purchase must not hide a new funded case");
  assert.equal(f.goodsRegistrationSuggestions(db, assigned, { q: "مشتری یک" }).total, 5, "Persian/Arabic search variants");
  assert.deepEqual(ids(f.goodsRegistrationSuggestions(db, assigned, { q: "8" })), [8]);
  assert.equal(f.goodsRegistrationSuggestions(db, assigned, { q: "' OR 1=1 --" }).total, 0);
  assert.deepEqual(payments(assigned).items.map(r => r.purchaseId), [1, 5, 7]);
  assert.deepEqual(payments(other).items.map(r => r.purchaseId), [4], "audited merge follows survivor ownership");
  assert.equal(payments(admin).total, 4, "existing orders and unaudited archived identities excluded");
  assert.equal(payments(noIdentity).total, 0);
  assert.equal(payments(assigned).items.find(r => r.purchaseId === 7).canCreate, false);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, changed, "recommendations must be strictly read-only");
  // Another employee creates the purchase/order: the next read removes the item.
  db.prepare("UPDATE goods_credit_lots SET purchase_id=7 WHERE application_id IN (2,10)").run();
  assert.deepEqual(ids(goods(assigned)), [1, 8, 9]);
  db.prepare("INSERT INTO customer_payment_orders VALUES(2,1)").run();
  assert.deepEqual(payments(assigned).items.map(r => r.purchaseId), [5, 7]);
  for (let i = 20; i < 45; i++) {
    db.prepare("INSERT INTO loan_applications VALUES(?,2,4,'completed','approved',NULL,?)")
      .run(i, `2026-02-${String(i - 19).padStart(2,"0")}`);
  }
  const paged = f.goodsRegistrationSuggestions(db, other, { page: "2" });
  assert.equal(paged.total, 26); assert.equal(paged.items.length, 10);
  assert.equal(paged.page, 2); assert.equal(paged.limit, 10);
  assert.equal(f.goodsRegistrationSuggestions(db, other, { page: "99" }).items.length, 0);
  for (const page of ["0", "-1", "1.5", "x", "1000000"]) {
    assert.throws(() => f.goodsRegistrationSuggestions(db, admin, { page }), /invalid_suggestion_page/);
    assert.throws(() => f.paymentRegistrationSuggestions(db, admin, { page }), /invalid_suggestion_page/);
  }
  console.log("Registration suggestions passed: completed-only, per-case attribution, new loans after old purchases, no duplicates, read-only, scope/merges, missing credit, reservations, search and pagination.");
} finally {
  db.close();
  await rm(temp, { recursive: true, force: true });
}

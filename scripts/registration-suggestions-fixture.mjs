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
    CREATE TABLE loan_application_stage_history(id INTEGER PRIMARY KEY,application_id INTEGER,from_stage TEXT,to_stage TEXT,created_at TEXT);
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
  // «در انتظار ایجاد»: wait time from stage history (not updated_at), Tehran calendar days, counts, access.
  {
    const iso = (daysAgo, hourUtc = 8) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString(); };
    db.exec("DELETE FROM goods_credit_lots; DELETE FROM loan_applications; DELETE FROM goods_purchases; DELETE FROM customer_payment_orders; DELETE FROM loan_application_stage_history;");
    const app = db.prepare("INSERT INTO loan_applications VALUES(?,?,?,'completed','approved',NULL,?)");
    app.run(100, 2, 2, iso(0)); app.run(101, 2, 4, iso(0)); app.run(102, 2, 1, iso(0));
    const hist = db.prepare("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,created_at) VALUES(?,?,?,?)");
    hist.run(100, "contract", "completed", iso(12)); hist.run(100, "completed", "contract", iso(11)); hist.run(100, "contract", "completed", iso(9));
    hist.run(101, "contract", "completed", iso(3));
    // 102: no history row (pre-history case) -> falls back to updated_at
    db.exec("INSERT INTO goods_credit_lots VALUES(100,NULL,0),(102,NULL,0)");
    const g = f.goodsRegistrationSuggestions(db, other, {});
    assert.deepEqual(g.items.map(r => r.applicationId), [100, 101, 102], "ordered by readySince, not updated_at");
    assert.equal(g.items[0].readySince, iso(9), "latest arrival at completed wins (re-completed case)");
    assert.equal(g.items[0].completedAt, g.items[0].readySince);
    assert.deepEqual(g.items.map(r => r.waitingDays), [9, 3, 0]);
    assert.equal(g.total, 3); assert.equal(g.old, 1);
    // 100 funded wallet(5000) -> actionable; 101 unattributed -> blocked; 102 has no wallet for plan 1 -> blocked
    assert.equal(g.actionable, 1); assert.equal(g.blocked, 2);
    assert.deepEqual(g.items.map(r => r.blocked), [false, true, true]);
    const gv = f.goodsRegistrationSuggestions(db, other, {}, { viewOnly: true });
    assert.equal(gv.viewOnly, true); assert.equal(gv.actionable, 0); assert.equal(gv.canCreate, false); assert.equal(g.canCreate, true);
    assert.equal(g.actionableCount, 1); assert.equal(g.blockedCount, 2); assert.equal(g.oldCount, 1);
    assert.ok(gv.items.every(r => r.canCreate === false), "view-only rows never carry a create action");
    // Tehran calendar: 21:00 UTC yesterday = 00:30 Tehran today -> 0 days; 20:00 UTC yesterday = 23:30 Tehran yesterday -> 1 day.
    db.exec("DELETE FROM loan_application_stage_history");
    hist.run(100, "contract", "completed", iso(1, 21)); hist.run(101, "contract", "completed", iso(1, 20));
    const nowTehranHour = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 210) / 60;
    if (nowTehranHour < 24) {
      const byId = Object.fromEntries(f.goodsRegistrationSuggestions(db, other, {}).items.map(r => [r.applicationId, r.waitingDays]));
      assert.equal(byId[100], 0); assert.equal(byId[101], 1);
    }
    db.prepare("INSERT INTO goods_purchases VALUES(?,?,?,?,'completed',?,?)").run(50, 2, 2, 5, "5000", iso(8));
    db.prepare("INSERT INTO goods_purchases VALUES(?,?,?,?,'completed',?,?)").run(51, 2, 4, 5, "0", iso(2));
    const p = f.paymentRegistrationSuggestions(db, other, {});
    assert.deepEqual(p.items.map(r => [r.purchaseId, r.waitingDays, r.blocked]), [[50, 8, false], [51, 2, true]]);
    assert.equal(p.actionable, 1); assert.equal(p.blocked, 1); assert.equal(p.old, 1);
    // Access: creators full; salesperson own-only read-only (scope forced even if role scope is 'all'); finance none.
    const perms = (...x) => x;
    const reg = { role: "registrar", customerScope: "all", salespersonId: null, permissions: perms("goods_purchases.view", "goods_purchases.manage", "payment_orders.view", "payment_orders.create") };
    const sp = { role: "salesperson", customerScope: "all", salespersonId: 20, permissions: perms("goods_purchases.view", "payment_orders.view") };
    const acc = { role: "accounting", customerScope: "all", salespersonId: null, permissions: perms("goods_purchases.view", "payment_orders.view", "payment_orders.pay") };
    assert.equal(f.goodsQueueAccess(reg).mode, "create"); assert.equal(f.paymentQueueAccess(reg).mode, "create");
    assert.equal(f.goodsQueueAccess(sp).mode, "view"); assert.equal(f.goodsQueueAccess(sp).actor.customerScope, "assigned");
    assert.equal(f.paymentQueueAccess(sp).actor.salespersonId, 20);
    assert.equal(f.goodsQueueAccess({ ...sp, permissions: [...sp.permissions, "goods_purchases.manage"] }).mode, "view", "salesperson never creates goods purchases");
    assert.equal(f.goodsQueueAccess(acc), null); assert.equal(f.paymentQueueAccess(acc), null);
    assert.equal(f.goodsQueueAccess({ ...sp, salespersonId: null }), null);
    assert.equal(f.goodsQueueAccess({ ...sp, permissions: [] }), null);
    assert.equal(f.goodsQueueAccess(admin).mode, "create");
    assert.deepEqual(f.pendingCreateCounts(db, { ...admin, permissions: [] }), { goods: 1, payments: 1 });
    assert.deepEqual(f.pendingCreateCounts(db, sp), { goods: null, payments: null });
    assert.deepEqual(f.pendingCreateCounts(db, acc), { goods: null, payments: null });
  }
  console.log("Pending-create passed: readySince from stage history, Tehran-day waits, actionable/blocked/old counts, view-only salesperson scope, finance excluded.");
  console.log("Registration suggestions passed: completed-only, per-case attribution, new loans after old purchases, no duplicates, read-only, scope/merges, missing credit, reservations, search and pagination.");
} finally {
  db.close();
  await rm(temp, { recursive: true, force: true });
}

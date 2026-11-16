import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installCustomerIdentityGuards, isAdminRole, normalizeCustomerMobile } from "../src/lib/customer-integrity.ts";
import { mergeCustomerRecords } from "../src/lib/customer-merge.ts";
import { assertArchivedCustomerSurvivorAccess } from "../src/lib/customer-merge-access.ts";
import { findVoipCustomerByPhone, listActiveVoipCustomers } from "../src/lib/voip-customer-lookup.ts";
import { paymentCustomerForActor, paymentOrderListScope } from "../src/lib/payment-order-scope.ts";

function fixture({
  collidingCalls = false,
  nationalSource = "۱۲۳",
  nationalTarget = "123",
} = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, national_code TEXT,
      status TEXT, merged_into_customer_id INTEGER, salesperson_id INTEGER, credit_rank TEXT
    );
    CREATE TABLE customer_merge_audit (
      id INTEGER PRIMARY KEY, survivor_customer_id INTEGER NOT NULL, source_customer_id INTEGER NOT NULL UNIQUE,
      actor_user_id INTEGER NOT NULL, assigned_salesperson_id INTEGER, created_at TEXT NOT NULL, details_json TEXT NOT NULL
    );
    CREATE TABLE salespersons (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, salesperson_id INTEGER);
    CREATE TABLE call_logs (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, external_id TEXT NOT NULL,
      salesperson_id INTEGER, salesperson_name_snapshot TEXT, UNIQUE(customer_id, external_id)
    );
    CREATE TABLE reminders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);
    CREATE TABLE consultation_forms (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);
    CREATE TABLE loan_applications (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, requested_by_user_id INTEGER NOT NULL,
      salesperson_id_snapshot INTEGER,
      salesperson_name_snapshot TEXT
    );
    CREATE TABLE customer_credit_checks (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, score INTEGER, created_at TEXT);
    CREATE TABLE customer_verification_events (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, checks_json TEXT);
    CREATE TABLE customer_identity_documents (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, document_type TEXT NOT NULL,
      storage_path TEXT NOT NULL, version INTEGER NOT NULL, is_latest INTEGER NOT NULL
    );
    CREATE TABLE goods_purchases (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);
    CREATE TABLE loan_filing_fee_charges (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);
  `);
  db.exec(`
    INSERT INTO salespersons VALUES(11,'Historical Source Seller'),(22,'Previous Target Seller'),
      (33,'New Survivor Owner'),(44,'Ambiguous Seller');
    INSERT INTO users VALUES
      (101,'salesperson',11),(102,'salesperson',22),(103,'admin',NULL),
      (104,'salesperson',44),(105,'salesperson',44),(106,'salesperson',NULL);
    INSERT INTO customers VALUES
      (1,'Source','+۹۸ ۹۱۲ ۰۰۰ ۰۰۰۱','۱۲۳','in_progress',NULL,11,'SourceRank'),
      (2,'Target','09120000001','123','in_progress',NULL,22,'TargetRank');
    INSERT INTO call_logs VALUES
      (1,1,'source-call',11,'Salesperson at creation'),
      (2,2,'target-call',22,'Target salesperson snapshot');
    INSERT INTO reminders VALUES(1,1),(2,2);
    INSERT INTO consultation_forms VALUES(1,1),(2,2);
    INSERT INTO loan_applications VALUES
      (1,1,101,NULL,NULL),(2,2,102,22,'Target loan salesperson'),
      (3,1,103,NULL,NULL),(4,1,104,NULL,NULL),(5,1,106,NULL,NULL),
      (6,1,101,11,NULL),(7,1,102,NULL,NULL),(8,2,101,NULL,NULL);
    INSERT INTO customer_credit_checks VALUES(1,1,900,'2025-01-02T00:00:00.000Z');
    INSERT INTO customer_verification_events VALUES(1,1,'source verification');
    INSERT INTO customer_identity_documents VALUES
      (1,1,'national_card_front','/private/source-front.png',1,1),
      (2,2,'national_card_front','/private/target-front.png',1,1);
    INSERT INTO goods_purchases VALUES(1,1);
    INSERT INTO loan_filing_fee_charges VALUES(1,1);
  `);
  // These application requesters have since been relinked to the newly selected
  // owner. Their mutable current associations are not historical evidence.
  db.prepare("UPDATE users SET salesperson_id=33 WHERE id IN (101,102)").run();
  if (collidingCalls) db.exec("INSERT INTO call_logs VALUES(3,1,'same-key',11,'Source snapshot'),(4,2,'same-key',22,'Target snapshot')");
  db.prepare("UPDATE customers SET national_code=? WHERE id=1").run(nationalSource);
  db.prepare("UPDATE customers SET national_code=? WHERE id=2").run(nationalTarget);
  installCustomerIdentityGuards(db);
  return db;
}

// Legacy dupes survive migration untouched, and unrelated updates do not
// trigger the identity guard. Writes using Persian digits/mobile variants do.
const db = fixture();
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE crm_customer_mobile_key(phone)=crm_customer_mobile_key('+989120000001')").get().n, 2);
db.prepare("UPDATE customers SET name='Target renamed' WHERE id=2").run();
assert.throws(() => db.prepare("INSERT INTO customers(id,name,phone,status) VALUES(3,'New','۰۹۱۲۰۰۰۰۰۰۱','in_progress')").run(), /ACTIVE_CUSTOMER_MOBILE_CONFLICT/);
assert.equal(isAdminRole("salesperson"), false, "the shared requireAdmin policy rejects non-admin roles");
assert.equal(isAdminRole("admin"), true);

// Rebuilding the legacy NOT NULL customers table drops attached triggers;
// the production migration reinstalls guards after that rebuild.
const rebuildDb = new DatabaseSync(":memory:");
rebuildDb.exec(`
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,national_code TEXT NOT NULL,status TEXT,merged_into_customer_id INTEGER);
  INSERT INTO customers VALUES(1,'Legacy 1','09120000001','1','in_progress',NULL),(2,'Legacy 2','۰۹۱۲۰۰۰۰۰۰۱','2','in_progress',NULL);
`);
installCustomerIdentityGuards(rebuildDb);
rebuildDb.exec(`
  CREATE TABLE customers_new(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL,national_code TEXT,status TEXT,merged_into_customer_id INTEGER);
  INSERT INTO customers_new SELECT id,name,phone,national_code,status,merged_into_customer_id FROM customers;
  DROP TABLE customers;
  ALTER TABLE customers_new RENAME TO customers;
`);
assert.equal(rebuildDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='customers'").get().n, 0);
installCustomerIdentityGuards(rebuildDb);
assert.equal(rebuildDb.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 2, "legacy duplicates survive rebuild");
assert.throws(() => rebuildDb.prepare("INSERT INTO customers VALUES(3,'New','۰۹۱۲۰۰۰۰۰۰۱','3','in_progress',NULL)").run(), /ACTIVE_CUSTOMER_MOBILE_CONFLICT/);

const validNationalCode = (code) => {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  const sum = [...code.slice(0, 9)].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  return Number(code[9]) === (remainder < 2 ? remainder : 11 - remainder);
};
const compareIdentity = (source, target) => {
  const sourceCode = String(source.national_code ?? "").replace(/\D/g, "");
  const targetCode = String(target.national_code ?? "").replace(/\D/g, "");
  const sourceValid = validNationalCode(sourceCode);
  const targetValid = validNationalCode(targetCode);
  const nationalCodeMatches = sourceValid && targetValid && sourceCode === targetCode;
  return {
    isDuplicate: normalizeCustomerMobile(source.phone) === normalizeCustomerMobile(target.phone) || nationalCodeMatches,
    nationalCodeMatches,
    conflictingNationalCodes: sourceValid && targetValid && sourceCode !== targetCode,
  };
};
const mergeFixture = (testDb) => mergeCustomerRecords(testDb, 1, 2, 99, 33, "2025-01-01T00:00:00.000Z", compareIdentity);
const success = mergeFixture(db);
assert.equal(db.prepare("SELECT merged_into_customer_id FROM customers WHERE id=1").get().merged_into_customer_id, 2);
assert.equal(db.prepare("SELECT salesperson_id FROM customers WHERE id=2").get().salesperson_id, 33);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM call_logs WHERE customer_id=2").get().n, 2);
assert.equal(db.prepare("SELECT salesperson_name_snapshot FROM call_logs WHERE id=1").get().salesperson_name_snapshot, "Salesperson at creation");
for (const id of [1,3,4,5,7,8]) {
  const attribution = db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=?").get(id);
  assert.equal(attribution.salesperson_id_snapshot, null, `legacy application ${id} owner remains unknown`);
  assert.equal(attribution.salesperson_name_snapshot, null, `legacy application ${id} name remains unknown`);
}
const survivorSnapshot = db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=2").get();
assert.equal(survivorSnapshot.salesperson_id_snapshot, 22, "preexisting survivor snapshot remains intact");
assert.equal(survivorSnapshot.salesperson_name_snapshot, "Target loan salesperson");
const partialSnapshot = db.prepare("SELECT salesperson_id_snapshot,salesperson_name_snapshot FROM loan_applications WHERE id=6").get();
assert.equal(partialSnapshot.salesperson_id_snapshot, 11, "existing snapshot ID is preserved");
assert.equal(partialSnapshot.salesperson_name_snapshot, null, "missing historical name stays unknown");
const mergeAudit = db.prepare("SELECT assigned_salesperson_id,details_json FROM customer_merge_audit").get();
assert.equal(mergeAudit.assigned_salesperson_id, 33);
const mergeDetails = JSON.parse(mergeAudit.details_json);
assert.deepEqual(mergeDetails.sourceOwnerAtMerge, {
  salespersonId: 11, salespersonName: "Historical Source Seller",
});
assert.deepEqual(mergeDetails.survivorOwnerAtMerge, {
  salespersonId: 22, salespersonName: "Previous Target Seller",
});
assert.equal(db.prepare("SELECT storage_path,is_latest FROM customer_identity_documents WHERE id=1").get().storage_path, "/private/source-front.png");
assert.equal(db.prepare("SELECT is_latest FROM customer_identity_documents WHERE id=1").get().is_latest, 0);
assert.equal(db.prepare("SELECT is_latest FROM customer_identity_documents WHERE id=2").get().is_latest, 1);
assert.equal(db.prepare("SELECT customer_id FROM goods_purchases WHERE id=1").get().customer_id, 1);
assert.equal(db.prepare("SELECT customer_id FROM loan_filing_fee_charges WHERE id=1").get().customer_id, 1);
assert.equal(db.prepare("SELECT customer_id FROM customer_credit_checks WHERE id=1").get().customer_id, 1);
assert.equal(db.prepare("SELECT credit_rank FROM customers WHERE id=2").get().credit_rank, "TargetRank");
assert.equal(db.prepare("SELECT customer_id FROM customer_verification_events WHERE id=1").get().customer_id, 1);
assert.ok(success.preservedFinancialArtifacts.some((item) => item.startsWith("customer_credit_checks: 1")));
assert.ok(success.preservedFinancialArtifacts.some((item) => item.startsWith("goods_purchases: 1")));
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_merge_audit").get().n, 1);
assert.equal(assertArchivedCustomerSurvivorAccess(db, 1, {
  role: "admin", customerScope: "all", salespersonId: null,
}), 2);
assert.equal(assertArchivedCustomerSurvivorAccess(db, 1, {
  role: "salesperson", customerScope: "assigned", salespersonId: 33,
}), 2);
assert.throws(() => assertArchivedCustomerSurvivorAccess(db, 1, {
  role: "salesperson", customerScope: "assigned", salespersonId: 11,
}), /Forbidden/);

const voipDb = new DatabaseSync(":memory:");
voipDb.exec(`
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,merged_into_customer_id INTEGER,salesperson_id INTEGER);
  CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
  INSERT INTO customers VALUES(10,'Archived source','+982111111111',20,11),(20,'Current survivor','09120000001',NULL,33);
  INSERT INTO customer_merge_audit VALUES(10,20);
`);
const normalizeVoip = (value) => {
  const text = String(value).trim();
  const plus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");
  return digits ? `${plus ? "+" : ""}${digits}` : null;
};
assert.deepEqual(listActiveVoipCustomers(voipDb, 33).map(({ id }) => id), [20]);
assert.equal(findVoipCustomerByPhone(voipDb, "+982111111111", normalizeVoip, 33).id, 20);
assert.equal(findVoipCustomerByPhone(voipDb, "+982111111111", normalizeVoip, 11), null,
  "archived-phone lookup is scoped by survivor's current owner");
assert.equal(findVoipCustomerByPhone(voipDb, "09120000001", normalizeVoip, null).id, 20);

const paymentDb = new DatabaseSync(":memory:");
paymentDb.exec(`
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,national_code TEXT,birth_date_jalali TEXT,
    salesperson_id INTEGER,merged_into_customer_id INTEGER);
  CREATE TABLE customer_merge_audit(source_customer_id INTEGER,survivor_customer_id INTEGER);
  CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY,customer_id INTEGER,stage TEXT,payout_amount_toman TEXT,salesperson_id INTEGER);
  CREATE TABLE customer_payment_orders(id INTEGER PRIMARY KEY,purchase_id INTEGER,customer_id INTEGER,
    salesperson_id INTEGER,stage TEXT,destination_iban TEXT,verified_national_code TEXT);
  CREATE TABLE customer_bank_accounts(id INTEGER PRIMARY KEY,customer_id INTEGER,iban TEXT,verified_national_code TEXT);
  INSERT INTO customers VALUES
    (1,'Archived source','1111111111','1370/01/01',11,2),
    (2,'Current survivor','2222222222','1375/01/01',33,NULL);
  INSERT INTO customer_merge_audit VALUES(1,2);
  INSERT INTO goods_purchases VALUES(50,1,'completed','500000',11);
  INSERT INTO customer_bank_accounts VALUES(70,1,'IR-original','1111111111');
  INSERT INTO customer_payment_orders VALUES(80,50,1,11,'awaiting_payment','IR-original','1111111111');
`);
const oldOwner = { role: "salesperson", customerScope: "assigned", salespersonId: 11 };
const newOwner = { role: "salesperson", customerScope: "assigned", salespersonId: 33 };
assert.equal(paymentCustomerForActor(paymentDb, 1, oldOwner), undefined);
const sourcePaymentIdentity = paymentCustomerForActor(paymentDb, 1, newOwner);
assert.equal(sourcePaymentIdentity.name, "Archived source");
assert.equal(sourcePaymentIdentity.national_code, "1111111111");
assert.equal(sourcePaymentIdentity.payment_scope_salesperson_id, 33);
const listScope = (scopeActor) => paymentOrderListScope(scopeActor);
const listFor = (scopeActor) => {
  const scope = listScope(scopeActor);
  return paymentDb.prepare(`SELECT o.id FROM customer_payment_orders o
    JOIN customers c ON c.id=o.customer_id WHERE 1=1${scope.sql}`).all(...scope.params).map(({ id }) => id);
};
assert.deepEqual(listFor(oldOwner), [], "old source owner cannot see survivor-scoped payout orders");
assert.deepEqual(listFor(newOwner), [80]);
const existingPurchase = paymentDb.prepare("SELECT * FROM goods_purchases WHERE id=50 AND customer_id=? AND stage='completed'")
  .get(sourcePaymentIdentity.id);
assert.ok(existingPurchase, "payout creation remains available for an existing completed source purchase");
paymentDb.prepare(`INSERT INTO customer_payment_orders
  VALUES(81,50,?,?,'sales_approval',NULL,NULL)`).run(
  existingPurchase.customer_id, existingPurchase.salesperson_id,
);
assert.equal(paymentDb.prepare("SELECT customer_id,salesperson_id FROM customer_payment_orders WHERE id=81").get().customer_id, 1);
assert.equal(paymentDb.prepare("SELECT salesperson_id FROM customer_payment_orders WHERE id=81").get().salesperson_id, 11,
  "payout order keeps the historical seller rather than paying the newly selected owner");
assert.equal(paymentDb.prepare("SELECT iban,verified_national_code FROM customer_bank_accounts WHERE id=70").get().iban, "IR-original");

// Any unique-key collision aborts the entire owner/archive/history operation.
const conflictDb = fixture({ collidingCalls: true });
assert.throws(() => mergeFixture(conflictDb), /UNIQUE constraint failed/);
assert.equal(conflictDb.prepare("SELECT merged_into_customer_id FROM customers WHERE id=1").get().merged_into_customer_id, null);
assert.equal(conflictDb.prepare("SELECT salesperson_id FROM customers WHERE id=2").get().salesperson_id, 22);
assert.equal(conflictDb.prepare("SELECT customer_id FROM call_logs WHERE id=1").get().customer_id, 1);
assert.equal(conflictDb.prepare("SELECT customer_id FROM reminders WHERE id=1").get().customer_id, 1);
assert.equal(conflictDb.prepare("SELECT COUNT(*) AS n FROM customer_merge_audit").get().n, 0);

const sameIdentityDb = fixture({ nationalSource: "1234567891", nationalTarget: "1234567891" });
const sameIdentityOutcome = mergeFixture(sameIdentityDb);
assert.equal(sameIdentityDb.prepare("SELECT customer_id FROM customer_credit_checks WHERE id=1").get().customer_id, 1);
assert.equal(sameIdentityDb.prepare("SELECT customer_id FROM customer_verification_events WHERE id=1").get().customer_id, 2);
assert.equal(sameIdentityDb.prepare("SELECT credit_rank FROM customers WHERE id=2").get().credit_rank, "TargetRank");
assert.equal(sameIdentityOutcome.reparentedHistoryCounts.customer_verification_events, 1);

const conflictingIdentityDb = fixture({ nationalSource: "1234567891", nationalTarget: "0499374363" });
assert.throws(() => mergeFixture(conflictingIdentityDb), /conflicting_national_codes/);
assert.equal(conflictingIdentityDb.prepare("SELECT merged_into_customer_id FROM customers WHERE id=1").get().merged_into_customer_id, null);
assert.equal(conflictingIdentityDb.prepare("SELECT customer_id FROM customer_credit_checks WHERE id=1").get().customer_id, 1);

db.close();
conflictDb.close();
sameIdentityDb.close();
conflictingIdentityDb.close();
rebuildDb.close();
voipDb.close();
paymentDb.close();
process.stdout.write("customer merge fixture passed\n");
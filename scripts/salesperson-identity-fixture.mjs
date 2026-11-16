import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureSalespersonIdentity,
  reconcileSalespersonUserIdentities,
  salespersonIdentityReport,
  resolveSalespersonIdentity,
} from "../src/lib/salesperson-identity.ts";
import {
  CreateUserBody,
  UpdateUserBody,
} from "../../../lib/api-zod/src/generated/api.ts";

const reconciliationWarnings = [];
const ignoreAmbiguity = (userId, reason) => {
  reconciliationWarnings.push({ userId, reason });
};

const createdUserInput = CreateUserBody.parse({
  username: "sales.test",
  password: "secure-password",
  role: "salesperson",
  salespersonId: 999,
});
assert.equal("salespersonId" in createdUserInput, false);
const updatedUserInput = UpdateUserBody.parse({ salespersonId: 999 });
assert.equal("salespersonId" in updatedUserInput, false);

function fixtureDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      full_name TEXT,
      mobile TEXT,
      role TEXT NOT NULL,
      salesperson_id INTEGER
    );
    CREATE TABLE salespersons (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      mobile TEXT
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Customer',
      salesperson_id INTEGER
    );
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  return db;
}

const db = fixtureDb();
db.exec(`
  INSERT INTO salespersons(id, name, created_at, mobile) VALUES(5, 'Legacy name', 'old', '09120000001');
  INSERT INTO users(id, username, full_name, mobile, role, salesperson_id)
    VALUES(1, 'legacy.user', 'Legacy User', '09120000001', 'salesperson', 5);
  INSERT INTO users(id, username, full_name, mobile, role, salesperson_id)
    VALUES(2, 'new.user', 'New User', '09120000002', 'salesperson', NULL);
  INSERT INTO users(id, username, full_name, mobile, role, salesperson_id)
    VALUES(3, 'prior.sales', 'Prior Sales', '09120000003', 'sales', NULL);
  INSERT INTO customers(id, salesperson_id) VALUES(1, 5);
`);

reconcileSalespersonUserIdentities(db, ignoreAmbiguity);
assert.equal(db.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, 5);
assert.equal(db.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 5);
assert.equal(db.prepare("SELECT name FROM salespersons WHERE id=5").get().name, "Legacy User");
const newId = db.prepare("SELECT salesperson_id FROM users WHERE id=2").get().salesperson_id;
assert.ok(newId);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM salespersons").get().count, 2);

db.prepare("UPDATE users SET role='sales' WHERE id=1").run();
assert.equal(ensureSalespersonIdentity(db, 1), 5);
db.prepare("UPDATE users SET role='salesperson' WHERE id=1").run();
assert.equal(ensureSalespersonIdentity(db, 1), 5);
assert.equal(db.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 5);
assert.equal(
  ensureSalespersonIdentity(db, 3),
  null,
  "non-salesperson accounts must retain no automatically assigned identity",
);
db.close();

const reuseDb = fixtureDb();
reuseDb.exec(`
  INSERT INTO salespersons(id, name, created_at, mobile) VALUES(17, 'Reusable Person', 'old', '09120000017');
  INSERT INTO users(id, username, full_name, mobile, role, salesperson_id)
    VALUES(1, 'reusable', 'Reusable Person', '09120000017', 'salesperson', NULL);
  INSERT INTO customers(id, salesperson_id) VALUES(1, 17);
`);
reconcileSalespersonUserIdentities(reuseDb, ignoreAmbiguity);
assert.equal(reuseDb.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, 17);
assert.equal(reuseDb.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 17);
assert.equal(reuseDb.prepare("SELECT COUNT(*) AS count FROM salespersons").get().count, 1);
reuseDb.close();

const conflictingMatchesDb = fixtureDb();
conflictingMatchesDb.exec(`
  INSERT INTO salespersons(id, name, mobile, created_at) VALUES
    (41, 'Another Person', '09120000041', 'old'),
    (42, 'Matching Name', '09120000042', 'old');
  INSERT INTO users(id, username, full_name, mobile, role)
    VALUES (1, 'mixed', 'Matching Name', '09120000041', 'salesperson');
`);
assert.throws(() => ensureSalespersonIdentity(conflictingMatchesDb, 1), /ambiguous_salesperson_identity/);
assert.deepEqual(salespersonIdentityReport(conflictingMatchesDb).issues[0].candidateIds, [41, 42]);
assert.equal(conflictingMatchesDb.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, null);
conflictingMatchesDb.close();

const conflictingMobileDb = fixtureDb();
conflictingMobileDb.exec(`
  INSERT INTO salespersons(id, name, mobile, created_at)
    VALUES (51, 'Same Name', '09120000051', 'old');
  INSERT INTO users(id, username, full_name, mobile, role)
    VALUES (1, 'same.name', 'Same Name', '09120000052', 'salesperson');
  INSERT INTO customers(id, salesperson_id) VALUES (51, 51);
`);
assert.equal(salespersonIdentityReport(conflictingMobileDb).issues[0].reason, "conflicting_mobile");
assert.deepEqual(salespersonIdentityReport(conflictingMobileDb).issues[0].candidateIds, [51]);
assert.throws(() => ensureSalespersonIdentity(conflictingMobileDb, 1), /ambiguous_salesperson_identity/);
reconcileSalespersonUserIdentities(conflictingMobileDb, ignoreAmbiguity);
assert.equal(conflictingMobileDb.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, null);
assert.equal(conflictingMobileDb.prepare("SELECT salesperson_id FROM customers WHERE id=51").get().salesperson_id, 51);
assert.equal(conflictingMobileDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 0);
conflictingMobileDb.close();

const ambiguousDb = fixtureDb();
ambiguousDb.exec(`
  INSERT INTO salespersons(id, name, created_at) VALUES(11, 'Duplicate Person', 'old');
  INSERT INTO salespersons(id, name, created_at) VALUES(12, 'Duplicate Person', 'old');
  INSERT INTO users(id, username, full_name, role, salesperson_id)
    VALUES(1, 'duplicate', 'Duplicate Person', 'salesperson', NULL);
  INSERT INTO customers(id, salesperson_id) VALUES(1, 11);
`);
reconcileSalespersonUserIdentities(ambiguousDb, ignoreAmbiguity);
assert.equal(ambiguousDb.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, null);
assert.equal(ambiguousDb.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 11);
assert.equal(ambiguousDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 0);
assert.equal(reconciliationWarnings.at(-1).userId, 1);
ambiguousDb.close();

const duplicateLinkDb = fixtureDb();
duplicateLinkDb.exec(`
  INSERT INTO salespersons(id, name, created_at) VALUES(23, 'Shared Link', 'old');
  INSERT INTO users(id, username, role, salesperson_id)
    VALUES(1, 'first', 'salesperson', 23);
  INSERT INTO users(id, username, role, salesperson_id)
    VALUES(2, 'second', 'salesperson', 23);
  INSERT INTO users(id, username, full_name, role, salesperson_id)
    VALUES(3, 'independent', 'Independent User', 'salesperson', NULL);
  INSERT INTO customers(id, salesperson_id) VALUES(1, 23);
`);
reconcileSalespersonUserIdentities(duplicateLinkDb, ignoreAmbiguity);
const independentlyCreatedId = duplicateLinkDb.prepare("SELECT salesperson_id FROM users WHERE id=3").get().salesperson_id;
assert.ok(independentlyCreatedId);
assert.notEqual(independentlyCreatedId, 23);
assert.equal(duplicateLinkDb.prepare("SELECT salesperson_id FROM users WHERE id=1").get().salesperson_id, 23);
assert.equal(duplicateLinkDb.prepare("SELECT salesperson_id FROM users WHERE id=2").get().salesperson_id, 23);
assert.equal(duplicateLinkDb.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 23);
assert.ok(
  reconciliationWarnings.some(({ userId, reason }) =>
    [1, 2].includes(userId) && reason === "ambiguous_salesperson_identity",
  ),
);
assert.equal(duplicateLinkDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 0);
assert.equal(
  duplicateLinkDb
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_users_salesperson_identity_unique'")
    .get().count,
  0,
  "do not install the unique index while ambiguous legacy links exist",
);
duplicateLinkDb.prepare("UPDATE users SET role='sales' WHERE id=2").run();
reconcileSalespersonUserIdentities(duplicateLinkDb, ignoreAmbiguity);
assert.equal(duplicateLinkDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
assert.equal(
  duplicateLinkDb
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_users_salesperson_identity_unique'")
    .get().count,
  1,
);
assert.equal(duplicateLinkDb.prepare("SELECT salesperson_id FROM customers WHERE id=1").get().salesperson_id, 23);
duplicateLinkDb.close();

const reviewDb = fixtureDb();
reviewDb.exec(`
  INSERT INTO salespersons(id, name, mobile, created_at) VALUES
    (31, 'Shared', '09120000031', 'old'),
    (32, 'Shared', '09120000032', 'old'),
    (33, 'Available', NULL, 'old');
  INSERT INTO users(id, username, full_name, mobile, role, salesperson_id) VALUES
    (1, 'owner', 'Shared', '09120000031', 'salesperson', 31),
    (2, 'other', 'Other', NULL, 'salesperson', 31),
    (3, 'unlinked', 'Shared', '09120000031', 'salesperson', NULL);
  INSERT INTO customers(id, salesperson_id) VALUES (10, 31), (11, 32);
  CREATE TABLE goods_purchases (id INTEGER, customer_id INTEGER, salesperson_id INTEGER, stage TEXT, commission_toman TEXT);
  CREATE TABLE goods_finance_ledger (id INTEGER, purchase_id INTEGER, salesperson_id INTEGER, kind TEXT, amount_toman TEXT);
  CREATE TABLE goods_salesperson_wallets (salesperson_id INTEGER, balance_toman TEXT);
  INSERT INTO goods_purchases VALUES (1, 10, 31, 'completed', '4000');
  INSERT INTO goods_finance_ledger VALUES (1, 1, 31, 'salesperson_commission', '4000');
  INSERT INTO goods_salesperson_wallets VALUES (31, '4000');
`);
const report = salespersonIdentityReport(reviewDb);
assert.deepEqual(report.issues.map((issue) => issue.userId), [1, 2, 3]);
assert.deepEqual(report.issues[2].candidateIds, [31, 32]);
assert.equal(report.identities.find((item) => item.id === 31).purchases[0].commissionToman, "4000");
assert.equal(report.identities.find((item) => item.id === 31).walletBalanceToman, "4000");
assert.throws(() => resolveSalespersonIdentity(reviewDb, 2, null, "new"), /identity_conflict/);
assert.throws(() => resolveSalespersonIdentity(reviewDb, 2, 31, 31), /identity_conflict/);
assert.throws(() => resolveSalespersonIdentity(reviewDb, 2, 31, 999), /identity_conflict/);
assert.equal(resolveSalespersonIdentity(reviewDb, 2, 31, 33), 33);
assert.throws(() => resolveSalespersonIdentity(reviewDb, 3, null, 33), /identity_conflict/);
const newIdentity = resolveSalespersonIdentity(reviewDb, 3, null, "new");
assert.ok(newIdentity > 33);
assert.equal(reviewDb.prepare("SELECT salesperson_id FROM customers WHERE id=10").get().salesperson_id, 31);
assert.equal(reviewDb.prepare("SELECT salesperson_id FROM customers WHERE id=11").get().salesperson_id, 32);
assert.equal(reviewDb.prepare("SELECT salesperson_id FROM goods_purchases WHERE id=1").get().salesperson_id, 31);
assert.equal(reviewDb.prepare("SELECT salesperson_id FROM goods_finance_ledger WHERE id=1").get().salesperson_id, 31);
assert.equal(reviewDb.prepare("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=31").get().balance_toman, "4000");
assert.equal(salespersonIdentityReport(reviewDb).issues.length, 0);
reconcileSalespersonUserIdentities(reviewDb, ignoreAmbiguity);
assert.equal(reviewDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
assert.equal(reviewDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='idx_users_salesperson_identity_unique'").get().count, 1);
reviewDb.close();

console.log("Salesperson identity fixture passed");
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// This fixture uses only an in-memory database; it never opens operational CRM data.
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE salespersons(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
  CREATE TABLE customers(
    id INTEGER PRIMARY KEY, salesperson_id INTEGER,
    merged_into_customer_id INTEGER
  );
  CREATE TABLE customer_merge_audit(
    source_customer_id INTEGER PRIMARY KEY,
    survivor_customer_id INTEGER NOT NULL
  );
  CREATE TABLE contract_generations(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL);
  CREATE TABLE wallet_rows(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL);
  CREATE TABLE wallet_transfers(
    id INTEGER PRIMARY KEY,from_customer_id INTEGER NOT NULL,to_customer_id INTEGER NOT NULL
  );
`);
db.exec(`
  INSERT INTO salespersons VALUES (11,'Old owner'),(22,'Intermediate owner'),(33,'Current owner'),(44,'Other owner');
  INSERT INTO customers VALUES
    (101,11,202),(202,22,303),(303,33,NULL),(404,44,NULL),(405,33,NULL),
    (606,11,303);
  INSERT INTO customer_merge_audit VALUES (101,202),(202,303);
  INSERT INTO contract_generations VALUES (1,101);
  INSERT INTO wallet_rows VALUES (1,101);
  INSERT INTO wallet_transfers VALUES (1,101,405),(2,101,404);
`);

function survivorOwnerId(customerIdSql) {
  return `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
    SELECT id,merged_into_customer_id FROM customers WHERE id=${customerIdSql}
    UNION ALL SELECT target.id,target.merged_into_customer_id
      FROM customer_chain previous
      JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
        AND audit.survivor_customer_id=previous.merged_into_customer_id
      JOIN customers target ON target.id=audit.survivor_customer_id
  )
  SELECT survivor.salesperson_id FROM customer_chain
  JOIN customers survivor ON survivor.id=customer_chain.id
  WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;
}

function visibleContract(id, salespersonId) {
  return Boolean(db.prepare(`SELECT 1 FROM contract_generations generation
    WHERE generation.id=? AND ${survivorOwnerId("generation.customer_id") }=?`)
    .get(id, salespersonId));
}
function visibleWalletRow(id, salespersonId) {
  return Boolean(db.prepare(`SELECT 1 FROM wallet_rows wallet_row
    WHERE wallet_row.id=? AND ${survivorOwnerId("wallet_row.customer_id") }=?`)
    .get(id, salespersonId));
}
function visibleTransfer(id, salespersonId) {
  return Boolean(db.prepare(`SELECT 1 FROM wallet_transfers transfer
    JOIN customers source ON source.id=transfer.from_customer_id
    JOIN customers target ON target.id=transfer.to_customer_id
    WHERE transfer.id=? AND ${survivorOwnerId("source.id") }=?
      AND ${survivorOwnerId("target.id") }=?`)
    .get(id, salespersonId, salespersonId));
}

assert.equal(visibleContract(1, 11), false, "archived contract must not remain visible to the historical owner");
assert.equal(visibleContract(1, 33), true, "archived contract must be visible to the audited active survivor owner");
assert.equal(visibleWalletRow(1, 11), false, "archived wallet row must not remain visible to the historical owner");
assert.equal(visibleWalletRow(1, 33), true, "archived wallet row must be visible to the audited active survivor owner");
assert.equal(visibleTransfer(1, 11), false, "transfer visibility must not use the archived source's old owner");
assert.equal(visibleTransfer(1, 33), true, "transfer visibility must scope both sides through their active owners");
assert.equal(visibleTransfer(2, 33), false, "transfer is hidden unless both active survivor owners match");
assert.equal(visibleTransfer(2, 44), false, "the other side cannot see a transfer assigned only to the survivor owner");
assert.equal(db.prepare(`SELECT ${survivorOwnerId("?")} salesperson_id`).get(606).salesperson_id, null,
  "archived rows without audited merge edges must not resolve to a guessed survivor");

db.close();
console.log("PASS isolated archived owner scope fixture: contract, wallet row, and both transfer sides use audited current owners");
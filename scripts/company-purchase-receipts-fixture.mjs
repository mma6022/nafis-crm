import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { ensureCompanyPurchaseReceiptSchema, postCompanyPurchaseReceipt } from "../src/lib/company-purchase-receipts.ts";

function fixture(type = "credit", oldReceipt = false) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE goods_purchases(id INTEGER PRIMARY KEY,customer_id INTEGER,credit_amount_toman TEXT,company_credit_toman TEXT);
    INSERT INTO goods_purchases VALUES(2,7,'300000000','249000000');
    CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER,wallet_type TEXT,balance TEXT);
    CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,wallet_id INTEGER REFERENCES wallet_accounts_v2(id),
      amount TEXT,kind TEXT,idempotency_key TEXT UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER);
    CREATE TABLE company_wallet_accounts(wallet_type TEXT PRIMARY KEY,balance TEXT);
    INSERT INTO company_wallet_accounts VALUES('cash','0'),('credit','0');
    CREATE TABLE company_wallet_ledger(id INTEGER PRIMARY KEY,wallet_type TEXT REFERENCES company_wallet_accounts(wallet_type),
      amount_toman TEXT,kind TEXT CHECK(kind IN ('filing_fee','manual_deposit','manual_withdrawal')),
      fee_charge_id INTEGER,reason TEXT,actor_user_id INTEGER,actor_customer_id INTEGER,
      idempotency_key TEXT UNIQUE,created_at TEXT);
  `);
  db.prepare("INSERT INTO wallet_accounts_v2 VALUES(1,7,?,'300000000')").run(type);
  if (oldReceipt) {
    db.exec(`INSERT INTO company_wallet_ledger VALUES(1,'credit','249000000','manual_deposit',NULL,
      'original authorized repair',NULL,NULL,'goods:2:nafisvam-credit:249000000','original');
      UPDATE company_wallet_accounts SET balance='249000000' WHERE wallet_type='credit';`);
  }
  ensureCompanyPurchaseReceiptSchema(db);
  ensureCompanyPurchaseReceiptSchema(db);
  return db;
}

function debit(db) {
  db.exec(`UPDATE wallet_accounts_v2 SET balance='0' WHERE id=1;
    INSERT INTO wallet_ledger_v2 VALUES(5,1,'300000000','goods_purchase_debit','goods:2:debit',103,NULL);`);
}

for (const type of ["cash", "credit"]) {
  const db = fixture(type);
  assert.throws(() => postCompanyPurchaseReceipt(db, 2), /source_mismatch/);
  db.exec("BEGIN");
  debit(db);
  assert.equal(postCompanyPurchaseReceipt(db, 2), true);
  db.exec("COMMIT");
  assert.equal(postCompanyPurchaseReceipt(db, 2), false);
  assert.equal(db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?").get(type).balance, "249000000");
  assert.equal(db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?").get(type === "cash" ? "credit" : "cash").balance, "0");
  assert.equal(db.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance, "0");
  assert.equal(db.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 1);
  const receipt = db.prepare("SELECT * FROM company_wallet_ledger").get();
  assert.equal(receipt.purchase_id, 2);
  assert.equal(receipt.source_ledger_id, 5);
  assert.equal(receipt.actor_user_id, 103);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.exec("UPDATE goods_purchases SET company_credit_toman='240000000'");
  assert.throws(() => postCompanyPurchaseReceipt(db, 2), /receipt_conflict/);
  assert.equal(db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?").get(type).balance, "249000000");
  db.close();
}

const adopted = fixture("credit", true);
debit(adopted);
assert.equal(postCompanyPurchaseReceipt(adopted, 2), false);
assert.equal(postCompanyPurchaseReceipt(adopted, 2), false);
assert.equal(adopted.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='credit'").get().balance, "249000000");
assert.equal(adopted.prepare("SELECT reason FROM company_wallet_ledger").get().reason, "original authorized repair");
assert.equal(adopted.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 1);
adopted.close();

const rollback = fixture();
rollback.exec("BEGIN");
debit(rollback);
postCompanyPurchaseReceipt(rollback, 2);
rollback.exec("ROLLBACK");
assert.equal(rollback.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=1").get().balance, "300000000");
assert.equal(rollback.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='credit'").get().balance, "0");
assert.equal(rollback.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 0);
assert.equal(rollback.prepare("SELECT count(*) n FROM wallet_ledger_v2").get().n, 0);
rollback.close();

for (const corrupt of [
  "UPDATE wallet_ledger_v2 SET amount='299000000'",
  "UPDATE wallet_accounts_v2 SET customer_id=8",
  "UPDATE wallet_ledger_v2 SET kind='cash_payment'",
  "UPDATE goods_purchases SET company_credit_toman='300000001'",
]) {
  const db = fixture();
  debit(db);
  db.exec(corrupt);
  assert.throws(() => postCompanyPurchaseReceipt(db, 2), /source_mismatch/);
  assert.equal(db.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 0);
  db.close();
}
console.log("PASS cash/credit net receipts, no double posting, adoption of authorized 249m, outer rollback, source/amount guards");

// Exercise the actual maintenance program with a synthetic DB only. Refuse to
// spawn it unless the production path has been completely removed.
const temp = await mkdtemp(path.join(os.tmpdir(), "company-wallet-reconcile-"));
try {
  const file = path.join(temp, "synthetic.db"), runner = path.join(temp, "reconcile.mjs");
  const template = await readFile(new URL("../../../.local/deploy/reconcile-company-wallet.mjs", import.meta.url), "utf8");
  const code = template
    .replace('new DatabaseSync("/var/lib/nafisvam/customers.db")', `new DatabaseSync(${JSON.stringify(file)})`)
    .replace("./company-purchase-receipts.mjs", pathToFileURL(path.resolve(new URL("../src/lib/company-purchase-receipts.ts", import.meta.url).pathname)).href);
  assert.ok(!code.includes("/var/lib/nafisvam"), "Production path was not removed");
  await writeFile(runner, code);
  const db = fixture();
  debit(db);
  db.exec(`ALTER TABLE goods_purchases ADD COLUMN stage TEXT DEFAULT 'completed';
    CREATE TABLE loan_filing_fee_charges(id INTEGER PRIMARY KEY,customer_id INTEGER,amount_toman TEXT);
    INSERT INTO loan_filing_fee_charges VALUES(8,7,'1000');
    INSERT INTO wallet_accounts_v2 VALUES(2,7,'cash','1200');
    INSERT INTO wallet_ledger_v2 VALUES(6,2,'1000','filing_fee_out','filing-fee:8:out',103,NULL);`);
  await backup(db, file);
  db.close();
  const run = () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", runner], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run();
  assert.equal(first.addedPurchases, 1);
  assert.equal(first.addedFees, 1);
  const second = run();
  assert.equal(second.addedPurchases, 0);
  assert.equal(second.addedFees, 0);
  const checked = new DatabaseSync(file);
  assert.equal(checked.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='cash'").get().balance, "1000");
  assert.equal(checked.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type='credit'").get().balance, "249000000");
  assert.equal(checked.prepare("SELECT balance FROM wallet_accounts_v2 WHERE id=2").get().balance, "1200");
  assert.equal(checked.prepare("SELECT count(*) n FROM company_wallet_ledger").get().n, 2);
  checked.close();
  console.log("PASS actual reconciler: missing cash filing-fee receipt, purchase receipt, replay and no repeat customer debit");
} finally {
  await rm(temp, { recursive: true, force: true });
}
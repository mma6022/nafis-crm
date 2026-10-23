import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { confirmCustomerCashTransfer, prepareCustomerCashTransfer, customerCashTransferSchema, CashTransferError, type TransferStore } from "../artifacts/api-server/src/lib/customer-cash-transfers";
import { normalizeCustomerMobile } from "../artifacts/api-server/src/lib/customer-integrity";

// Synthetic SQLite only. No CRM data, provider calls, sessions or background jobs.
const db = new DatabaseSync(":memory:");
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,merged_into_customer_id INTEGER);
  CREATE TABLE wallet_accounts_v2(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),wallet_type TEXT,balance TEXT,created_at TEXT,UNIQUE(customer_id,wallet_type));
  CREATE TABLE wallet_transfers(id INTEGER PRIMARY KEY,from_customer_id INTEGER REFERENCES customers(id),to_customer_id INTEGER REFERENCES customers(id),
    wallet_type TEXT,amount_toman TEXT,status TEXT,error_code TEXT,reason TEXT,actor_user_id INTEGER,actor_customer_id INTEGER,idempotency_key TEXT UNIQUE,created_at TEXT);
  CREATE TABLE wallet_ledger_v2(id INTEGER PRIMARY KEY,wallet_id INTEGER REFERENCES wallet_accounts_v2(id),
    amount TEXT,kind TEXT,idempotency_key TEXT UNIQUE,actor_user_id INTEGER,actor_customer_id INTEGER,created_at TEXT);
  INSERT INTO customers VALUES(1,'مشتری آزمایشی اول','09120000001',NULL),(2,'مشتری آزمایشی دوم','09120000002',NULL),(3,'مشتری آزمایشی سوم','09120000003',NULL);
  INSERT INTO wallet_accounts_v2 VALUES(1,1,'cash','10000000','2026-01-01'),(2,2,'cash','500000','2026-01-01'),(3,1,'credit','50000000','2026-01-01');
`);
db.exec(customerCashTransferSchema);
db.function("crm_customer_mobile_key", normalizeCustomerMobile);
const row = <T>(sql: string, params: any[] = []) => db.prepare(sql).get(...params) as T | undefined;
const count = (table: string) => row<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n;
const store: TransferStore = {
  row,
  rows: (sql, params = []) => db.prepare(sql).all(...params) as any[],
  insert: (sql, params = []) => Number(db.prepare(sql).run(...params).lastInsertRowid),
  changes: (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
  transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
  normalizeMobile: normalizeCustomerMobile,
  cashWallet: id => {
    const existing = row<{ id: number; balance: string }>("SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'", [id]);
    if (existing) return existing;
    const walletId = store.insert("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,'cash','0','2026-01-01')", [id]);
    return { id: walletId, balance: "0" };
  },
};
const balances = () => store.rows("SELECT customer_id,wallet_type,balance FROM wallet_accounts_v2 ORDER BY id");
const prepare = (amount = "1000000") => prepareCustomerCashTransfer(store, 1,
  "09120000002".replace(/\d/g, digit => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]), amount, "09120000001");
let key = 0;
const confirm = (p: ReturnType<typeof prepare>, extra: Record<string, unknown> = {}) =>
  confirmCustomerCashTransfer(store, 1, { recipientToken: p.recipientToken, amountToman: p.amountToman, confirmed: true, idempotencyKey: `synthetic-key-${++key}`, ...extra }, "09120000001");
const fails = (code: string, f: () => unknown) => assert.throws(f, e => e instanceof CashTransferError && e.code === code);
const prepared = prepare();
assert.equal(prepared.recipientName, "مشتری آزمایشی دوم");
const receipt = confirm(prepared, { idempotencyKey: "synthetic-success-key" });
assert.equal(receipt.cashBalanceToman, "9000000");
assert.equal(store.cashWallet(2).balance, "1500000");
assert.equal(count("wallet_ledger_v2"), 2);
assert.deepEqual(store.rows<object>("SELECT kind,actor_customer_id,actor_user_id FROM wallet_ledger_v2 ORDER BY id").map(row => ({ ...row })),
  [{ kind: "transfer_out", actor_customer_id: 1, actor_user_id: null }, { kind: "transfer_in", actor_customer_id: 1, actor_user_id: null }]);
const after = JSON.stringify(balances());
db.exec("UPDATE customer_wallet_transfer_preparations SET expires_at='2000-01-01' WHERE used_transfer_id IS NOT NULL");
assert.equal(confirm(prepared, { idempotencyKey: "synthetic-success-key" }).id, receipt.id);
assert.equal(JSON.stringify(balances()), after);
assert.equal(count("wallet_ledger_v2"), 2);
fails("transfer_already_confirmed", () => confirm(prepared));
fails("transfer_confirmation_mismatch", () => confirm(prepared, { amountToman: "2000000" }));
fails("transfer_confirmation_mismatch", () => confirmCustomerCashTransfer(store, 2,
  { recipientToken: prepared.recipientToken, amountToman: prepared.amountToman, confirmed: true, idempotencyKey: "synthetic-theft-key" }, "09120000002"));
fails("invalid_transfer_confirmation", () => confirm(prepared, { confirmed: false }));
fails("invalid_transfer_input", () => prepare("0"));
fails("invalid_transfer_input", () => prepare("-1"));
fails("invalid_transfer_input", () => prepare("100.5"));
fails("invalid_transfer_input", () => prepare("9007199254740992"));
fails("self_transfer_not_allowed", () => prepareCustomerCashTransfer(store, 1, "09120000001", "1", "09120000001"));
fails("recipient_not_found", () => prepareCustomerCashTransfer(store, 1, "09120000004", "1", "09120000001"));
const staleSource = prepare();
db.exec("UPDATE customers SET phone='09120000006' WHERE id=1");
fails("source_customer_unavailable", () => confirm(staleSource));
db.exec("UPDATE customers SET phone='09120000001' WHERE id=1");
const changed = prepare();
db.exec("UPDATE customers SET phone='09120000005' WHERE id=2");
fails("recipient_changed", () => confirm(changed));
db.exec("UPDATE customers SET phone='09120000002',name='نام آزمایشی تغییرکرده' WHERE id=2");
fails("recipient_changed", () => confirm(changed));
db.exec("UPDATE customers SET name='مشتری آزمایشی دوم' WHERE id=2");
const expired = prepare();
db.exec("UPDATE customer_wallet_transfer_preparations SET expires_at='2000-01-01' WHERE used_transfer_id IS NULL");
fails("transfer_confirmation_expired", () => confirm(expired));
const merged = prepare();
db.exec("UPDATE customers SET merged_into_customer_id=3 WHERE id=2");
fails("recipient_changed", () => confirm(merged));
db.exec("UPDATE customers SET merged_into_customer_id=NULL WHERE id=2");
// Two independently prepared requests cannot both spend the same current cash.
db.exec("UPDATE wallet_accounts_v2 SET balance='4000000' WHERE id=1");
const first = prepare("3000000"), second = prepare("3000000");
confirm(first);
fails("insufficient_cash_balance", () => confirm(second, { idempotencyKey: "synthetic-failed-key" }));
const afterFailure = JSON.stringify(balances());
fails("insufficient_cash_balance", () => confirm(second, { idempotencyKey: "synthetic-failed-key" }));
assert.equal(JSON.stringify(balances()), afterFailure);
assert.equal(count("wallet_ledger_v2"), 4);
assert.equal(row<{ balance: string }>("SELECT balance FROM wallet_accounts_v2 WHERE id=3")!.balance, "50000000");
assert.equal(row<{ n: number }>("SELECT COUNT(*) n FROM wallet_transfers WHERE status='failed' AND actor_customer_id=1")!.n, 1);
// Failure halfway through posting must roll back both balances, receipt and debit.
const rollback = prepare("500000");
const beforeRollback = JSON.stringify(balances()), transferCount = count("wallet_transfers");
db.exec("CREATE TRIGGER reject_synthetic_credit BEFORE INSERT ON wallet_ledger_v2 WHEN NEW.kind='transfer_in' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
assert.throws(() => confirm(rollback), /synthetic rollback/);
assert.equal(JSON.stringify(balances()), beforeRollback);
assert.equal(count("wallet_transfers"), transferCount);
assert.equal(count("wallet_ledger_v2"), 4);
db.exec("DROP TRIGGER reject_synthetic_credit");
db.exec("CREATE TRIGGER ignore_synthetic_debit BEFORE UPDATE OF balance ON wallet_accounts_v2 WHEN OLD.id=1 BEGIN SELECT RAISE(IGNORE); END");
fails("wallet_posting_failed", () => confirm(rollback));
assert.equal(JSON.stringify(balances()), beforeRollback);
assert.equal(count("wallet_transfers"), transferCount);
db.exec("DROP TRIGGER ignore_synthetic_debit");
for (let i = 0; i < 30; i++) { try { prepareCustomerCashTransfer(store, 1, "09120000004", "1", "09120000001"); } catch {} }
fails("recipient_lookup_rate_limited", () => prepare());
console.log("PASS: cash posting, actor audit, credit isolation, replay, stolen/mismatched/expired/used tokens, changed/merged recipient, self/missing recipient, amount guards, exhausted balance, failed replay, atomic rollback, lookup rate limit.");
db.close();

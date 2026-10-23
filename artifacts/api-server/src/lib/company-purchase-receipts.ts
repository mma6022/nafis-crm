import type { DatabaseSync } from "node:sqlite";

export function ensureCompanyPurchaseReceiptSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(company_wallet_ledger)").all() as Array<{ name: string }>;
  for (const [name, definition] of [
    ["purchase_id", "INTEGER REFERENCES goods_purchases(id)"],
    ["source_ledger_id", "INTEGER REFERENCES wallet_ledger_v2(id)"],
  ]) {
    if (!columns.some(column => column.name === name)) {
      db.exec(`ALTER TABLE company_wallet_ledger ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS company_receipt_purchase ON company_wallet_ledger(purchase_id);
    CREATE UNIQUE INDEX IF NOT EXISTS company_receipt_source ON company_wallet_ledger(source_ledger_id);`);
}

const amount = (value: string): bigint => {
  if (!/^\d{1,30}$/.test(value)) throw new Error("invalid_company_purchase_amount");
  return BigInt(value);
};

/**
 * Mirror a proven purchase debit into the same company wallet type.
 * The customer's gross debit is NOT repeated. Plan balances remain subledgers.
 * Savepoints allow this to be part of settlement's outer atomic transaction.
 */
export function postCompanyPurchaseReceipt(db: DatabaseSync, purchaseId: number): boolean {
  db.exec("SAVEPOINT company_purchase_receipt");
  try {
    const purchase = db.prepare("SELECT customer_id,credit_amount_toman,company_credit_toman FROM goods_purchases WHERE id=?")
      .get(purchaseId) as { customer_id: number; credit_amount_toman: string; company_credit_toman: string } | undefined;
    const source = db.prepare(`SELECT l.id,l.amount,l.actor_user_id,l.actor_customer_id,
        w.customer_id,w.wallet_type FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id
        WHERE l.idempotency_key=? AND l.kind='goods_purchase_debit'`)
      .get(`goods:${purchaseId}:debit`) as {
        id: number; amount: string; actor_user_id: number | null; actor_customer_id: number | null;
        customer_id: number; wallet_type: string;
      } | undefined;
    if (!purchase || !source || source.customer_id !== purchase.customer_id
      || !["cash", "credit"].includes(source.wallet_type)
      || amount(source.amount) !== amount(purchase.credit_amount_toman)
      || amount(purchase.company_credit_toman) > amount(source.amount)) {
      throw new Error("company_purchase_source_mismatch");
    }
    const net = amount(purchase.company_credit_toman).toString();
    // Matches the previously authorized one-time credit registration, so it is
    // adopted without adding its 249m balance a second time.
    const key = `goods:${purchaseId}:nafisvam-${source.wallet_type}:${net}`;
    const previous = db.prepare(`SELECT id,wallet_type,amount_toman,kind,fee_charge_id,purchase_id,source_ledger_id
      FROM company_wallet_ledger WHERE purchase_id=? OR source_ledger_id=? OR idempotency_key=?`)
      .all(purchaseId, source.id, key) as Array<{
        id: number; wallet_type: string; amount_toman: string; kind: string;
        fee_charge_id: number | null; purchase_id: number | null; source_ledger_id: number | null;
      }>;
    if (previous.length) {
      const receipt = previous[0];
      if (previous.length !== 1 || receipt.wallet_type !== source.wallet_type
        || receipt.amount_toman !== net || receipt.kind !== "manual_deposit" || receipt.fee_charge_id != null
        || (receipt.purchase_id != null && receipt.purchase_id !== purchaseId)
        || (receipt.source_ledger_id != null && receipt.source_ledger_id !== source.id)) {
        throw new Error("company_purchase_receipt_conflict");
      }
      db.prepare("UPDATE company_wallet_ledger SET purchase_id=?,source_ledger_id=? WHERE id=?")
        .run(purchaseId, source.id, receipt.id);
      db.exec("RELEASE company_purchase_receipt");
      return false;
    }
    const wallet = db.prepare("SELECT balance FROM company_wallet_accounts WHERE wallet_type=?")
      .get(source.wallet_type) as { balance: string } | undefined;
    if (!wallet) throw new Error("company_wallet_missing");
    const balance = amount(wallet.balance) + amount(net);
    db.prepare(`INSERT INTO company_wallet_ledger(wallet_type,amount_toman,kind,reason,actor_user_id,
        actor_customer_id,idempotency_key,purchase_id,source_ledger_id,created_at)
      VALUES(?,?,'manual_deposit',?,?,?,?,?,?,?)`).run(
        source.wallet_type, net, `دریافت خالص خرید کالای ${purchaseId} پس از تخفیف توسعه`,
        source.actor_user_id, source.actor_customer_id, key, purchaseId, source.id, new Date().toISOString(),
      );
    db.prepare("UPDATE company_wallet_accounts SET balance=? WHERE wallet_type=?").run(balance.toString(), source.wallet_type);
    db.exec("RELEASE company_purchase_receipt");
    return true;
  } catch (error) {
    db.exec("ROLLBACK TO company_purchase_receipt; RELEASE company_purchase_receipt");
    throw error;
  }
}
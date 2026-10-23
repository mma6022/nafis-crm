import { crmDb, databasePath, execute, queryRow, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";
import path from "node:path";
import fs from "node:fs";
import { paymentCustomerForActor } from "./payment-order-scope";
export { normalizedDigits, normalizeIban } from "./bank-verification";

export const paymentReceiptRoot = path.join(path.dirname(databasePath), "payment-order-receipts");
export function ensurePaymentOrdersSchema() {
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS finance_bank_accounts (
      id INTEGER PRIMARY KEY, bank_name TEXT NOT NULL, owner_name TEXT NOT NULL,
      fund_name TEXT NOT NULL, iban TEXT NOT NULL, owner_type TEXT NOT NULL CHECK(owner_type IN ('company','person')),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      UNIQUE(iban)
    );
    CREATE TABLE IF NOT EXISTS customer_bank_accounts (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
      iban TEXT NOT NULL, bank_name TEXT NOT NULL, owner_name TEXT NOT NULL,
      verified_national_code TEXT NOT NULL, provider_reference TEXT NOT NULL,
      verified_at TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
      UNIQUE(customer_id,iban)
    );
    CREATE TABLE IF NOT EXISTS customer_payment_orders (
      id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL UNIQUE REFERENCES goods_purchases(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id), salesperson_id INTEGER REFERENCES salespersons(id),
      amount_toman TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'sales_approval'
        CHECK(stage IN ('sales_approval','admin_approval','awaiting_payment','paid')),
      customer_bank_account_id INTEGER REFERENCES customer_bank_accounts(id),
      destination_iban TEXT, destination_owner_name TEXT, verified_national_code TEXT,
      source_bank_account_id INTEGER REFERENCES finance_bank_accounts(id),
      tracking_number TEXT, paid_at TEXT, receipt_filename TEXT, receipt_mime TEXT, receipt_sha256 TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      sales_approved_by INTEGER REFERENCES users(id), admin_approved_by INTEGER REFERENCES users(id),
      paid_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS customer_payment_order_events (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES customer_payment_orders(id),
      action TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_stage ON customer_payment_orders(stage,id);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_customer ON customer_payment_orders(customer_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_receipt_reference
      ON customer_payment_orders(source_bank_account_id,tracking_number) WHERE stage='paid';
  `);
}

export function paymentCustomer(id: number, actor: AuthUser): any | undefined {
  return paymentCustomerForActor(crmDb, id, actor);
}
export function paymentOrder(id: number, actor: AuthUser): any | undefined {
  const order = queryRow<any>(`SELECT o.*,c.name customer_name,current_salesperson.name customer_salesperson_name,
      p.base_payout_amount_toman,p.fee_discount_toman
    FROM customer_payment_orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN goods_purchases p ON p.id=o.purchase_id
    LEFT JOIN customers current_customer ON current_customer.id=COALESCE(c.merged_into_customer_id,c.id) AND current_customer.merged_into_customer_id IS NULL
    LEFT JOIN salespersons current_salesperson ON current_salesperson.id=current_customer.salesperson_id
    WHERE o.id=?`, [id]);
  if (!order || !paymentCustomer(order.customer_id, actor)) return undefined;
  return order;
}
export function paymentEvent(id: number, action: string, actorId: number) {
  execute("INSERT INTO customer_payment_order_events(order_id,action,actor_id,created_at) VALUES(?,?,?,?)",
    [id, action, actorId, new Date().toISOString()]);
}
export function paymentOrderView(row: any, details = false) {
  return {
    id: row.id, purchaseId: row.purchase_id, customerId: row.customer_id, customerName: row.customer_name,
    customerSalespersonName: row.customer_salesperson_name ?? null,
    salespersonId: row.salesperson_id, amountToman: row.amount_toman, stage: row.stage,
    basePayoutAmountToman: row.base_payout_amount_toman ?? null, feeDiscountToman: row.fee_discount_toman ?? null,
    customerBankAccountId: row.customer_bank_account_id, destinationIban: row.destination_iban,
    destinationOwnerName: row.destination_owner_name, sourceBankAccountId: row.source_bank_account_id,
    trackingNumber: row.tracking_number, paidAt: row.paid_at, createdAt: row.created_at, updatedAt: row.updated_at,
    receiptUrl: row.receipt_filename ? `/api/payment-orders/${row.id}/receipt` : null,
    ...(details ? { events: queryRows<any>("SELECT action,actor_id actorId,created_at createdAt FROM customer_payment_order_events WHERE order_id=? ORDER BY id", [row.id]) } : {}),
  };
}
export function bankAccountView(row: any) {
  return { id: row.id, bankName: row.bank_name, ownerName: row.owner_name, fundName: row.fund_name,
    iban: row.iban, ownerType: row.owner_type, verifiedAt: row.verified_at, customerId: row.customer_id };
}
export function ensureReceiptDirectory() {
  fs.mkdirSync(paymentReceiptRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(paymentReceiptRoot, 0o700);
}
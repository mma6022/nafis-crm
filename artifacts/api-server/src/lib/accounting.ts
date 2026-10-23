import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { crmDb, databasePath, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { ensurePaymentOrdersSchema, paymentReceiptRoot, normalizedDigits } from "./payment-orders";
import type { AuthUser } from "./auth";
import { paymentOrderListScope } from "./payment-order-scope";
import { normalizeIban } from "./bank-verification";

export const accountingFileRoot = path.join(path.dirname(databasePath), "accounting-attachments");
export class AccountingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function ensureAccountingSchema() {
  ensurePaymentOrdersSchema();
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS accounting_funds(
      fund_id INTEGER PRIMARY KEY REFERENCES finance_bank_accounts(id),
      balance_toman TEXT NOT NULL DEFAULT '0', initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)));
    CREATE TABLE IF NOT EXISTS accounting_documents(
      id INTEGER PRIMARY KEY, fund_id INTEGER NOT NULL REFERENCES finance_bank_accounts(id),
      document_date TEXT NOT NULL,transaction_date TEXT NOT NULL,amount_toman TEXT NOT NULL,purpose TEXT NOT NULL,
      document_type TEXT NOT NULL CHECK(document_type IN ('credit','debit')),
      transaction_type TEXT NOT NULL CHECK(transaction_type IN ('deposit','withdrawal')),
      source TEXT NOT NULL CHECK(source IN ('manual','payment_order','opening')),
      source_order_id INTEGER UNIQUE REFERENCES customer_payment_orders(id),
      request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
      balance_before_toman TEXT NOT NULL,balance_after_toman TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS accounting_one_opening ON accounting_documents(fund_id) WHERE source='opening';
    CREATE INDEX IF NOT EXISTS accounting_fund_documents ON accounting_documents(fund_id,id);
    CREATE TABLE IF NOT EXISTS accounting_attachments(
      id INTEGER PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES accounting_documents(id),
      name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
      stored_name TEXT NOT NULL,storage_kind TEXT NOT NULL CHECK(storage_kind IN ('accounting','payment')),
      created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
      UNIQUE(document_id,sha256,name));
    -- Retained in the shared database even after switching to an older release:
    -- old code must fail explicitly rather than silently pay without a journal.
    CREATE TRIGGER IF NOT EXISTS accounting_require_payment_journal
    BEFORE UPDATE OF stage ON customer_payment_orders
    WHEN NEW.stage='paid' AND OLD.stage<>'paid'
    BEGIN
      SELECT CASE WHEN NOT EXISTS(
        SELECT 1 FROM accounting_documents d WHERE d.source_order_id=NEW.id
          AND d.source='payment_order' AND d.transaction_type='withdrawal'
          AND d.fund_id=NEW.source_bank_account_id AND d.amount_toman=ltrim(NEW.amount_toman,'0')
      ) THEN RAISE(ABORT,'payment accounting journal required') END;
    END;
  `);
  const columns = queryRows<{ name: string }>("PRAGMA table_info(accounting_documents)");
  for (const name of ["counterparty_account_type", "counterparty_account_number", "counterparty_owner_name"]) {
    if (!columns.some(column => column.name === name)) crmDb.exec(`ALTER TABLE accounting_documents ADD COLUMN ${name} TEXT`);
  }
}
export type CounterpartyAccount = {
  counterpartyAccountType: "iban" | "card";
  counterpartyAccountNumber: string;
  counterpartyOwnerName: string;
};
export function counterpartyAccount(input: Record<string, unknown>): CounterpartyAccount | undefined {
  const keys = ["counterpartyAccountType", "counterpartyAccountNumber", "counterpartyOwnerName"] as const;
  if (keys.every(key => input[key] === undefined || input[key] === null || input[key] === "")) return undefined;
  if (keys.some(key => typeof input[key] !== "string")) throw new AccountingError(400,"مشخصات حساب طرف تراکنش معتبر نیست.");
  const type = input.counterpartyAccountType;
  const owner = (input.counterpartyOwnerName as string).trim();
  if (!owner || owner.length > 200) throw new AccountingError(400,"نام صاحب حساب باید بین ۱ تا ۲۰۰ نویسه باشد.");
  const value = normalizedDigits(input.counterpartyAccountNumber).replace(/[\s-]/g,"").toUpperCase();
  if (type === "iban") {
    const iban = normalizeIban(value.startsWith("IR") ? value : `IR${value}`);
    if (!iban) throw new AccountingError(400,"شماره شبای حساب طرف تراکنش معتبر نیست.");
    return {counterpartyAccountType:type,counterpartyAccountNumber:iban,counterpartyOwnerName:owner};
  }
  if (type === "card") {
    if (!/^\d{16}$/.test(value) || /^(\d)\1{15}$/.test(value)) throw new AccountingError(400,"شماره کارت باید ۱۶ رقم معتبر باشد.");
    const sum = [...value].reduce((total,digit,index)=>{
      const n = Number(digit) * (index % 2 === 0 ? 2 : 1);
      return total + (n > 9 ? n - 9 : n);
    },0);
    if (sum % 10 !== 0) throw new AccountingError(400,"شماره کارت معتبر نیست.");
    return {counterpartyAccountType:type,counterpartyAccountNumber:value,counterpartyOwnerName:owner};
  }
  throw new AccountingError(400,"نوع شماره حساب باید شبا یا کارت باشد.");
}
export function amount(value: unknown, allowZero = false) {
  const text = normalizedDigits(String(value ?? "")).replace(/[,\u066c\s]/g, "");
  if (!/^\d{1,24}$/.test(text) || (!allowZero && BigInt(text) === 0n))
    throw new AccountingError(400, "مبلغ باید عدد صحیح مثبت به تومان باشد.");
  return BigInt(text);
}
export function tehranDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Tehran",year:"numeric",month:"2-digit",day:"2-digit" }).formatToParts(date);
  return ["year","month","day"].map(k => parts.find(p=>p.type===k)!.value).join("-");
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0,10) === value;
}
export function accountingScope(actor: AuthUser) {
  const scope = paymentOrderListScope(actor);
  return {
    sql: ` AND (d.source_order_id IS NULL OR EXISTS(
      SELECT 1 FROM customer_payment_orders p JOIN customers c ON c.id=p.customer_id
      WHERE p.id=d.source_order_id${scope.sql}))`,
    params: scope.params,
  };
}
export function documentRow(id: number, actor: AuthUser) {
  const scope = accountingScope(actor);
  return queryRow<any>(`SELECT d.*,b.fund_name,COALESCE(u.full_name,u.username) actor_name FROM accounting_documents d
    JOIN finance_bank_accounts b ON b.id=d.fund_id JOIN users u ON u.id=d.created_by WHERE d.id=?${scope.sql}`, [id,...scope.params]);
}
export function documentView(row: any) {
  return {
    id: row.id, fundId: row.fund_id, fundName: row.fund_name, documentDate: row.document_date,
    transactionDate: row.transaction_date, amountToman: row.amount_toman, purpose: row.purpose,
    documentType: row.document_type, transactionType: row.transaction_type, source: row.source,
    sourceOrderId: row.source_order_id, balanceBeforeToman: row.balance_before_toman,
    balanceAfterToman: row.balance_after_toman, createdAt: row.created_at, createdByName: row.actor_name,
    counterpartyAccountType: row.counterparty_account_type ?? null,
    counterpartyAccountNumber: row.counterparty_account_number ?? null,
    counterpartyOwnerName: row.counterparty_owner_name ?? null,
    attachments: queryRows<any>("SELECT id,name,mime,size FROM accounting_attachments WHERE document_id=? ORDER BY id", [row.id]),
  };
}
type Posting = {
  fundId: number; documentDate: string; transactionDate: string; amount: bigint; purpose: string;
  documentType: "credit" | "debit"; transactionType: "deposit" | "withdrawal";
  source: "manual" | "payment_order" | "opening"; sourceOrderId?: number;
  requestKey: string; requestHash: string; actorId: number;
  counterparty?: CounterpartyAccount;
};
// Caller owns the transaction. No async work or nested transactions here.
export function postDocument(input: Posting) {
  if (input.amount < 0n || (input.source !== "opening" && input.amount === 0n)) throw new AccountingError(400,"مبلغ سند معتبر نیست.");
  if (!queryRow("SELECT id FROM finance_bank_accounts WHERE id=?", [input.fundId])) throw new AccountingError(404,"صندوق یافت نشد.");
  const existing = queryRow<any>("SELECT id,request_hash FROM accounting_documents WHERE request_key=?", [input.requestKey]);
  if (existing) {
    if (existing.request_hash !== input.requestHash) throw new AccountingError(409,"این درخواست قبلاً با اطلاعات متفاوت ثبت شده است.");
    return existing.id as number;
  }
  const fund = queryRow<any>("SELECT * FROM accounting_funds WHERE fund_id=?", [input.fundId]);
  if (input.source === "opening") {
    if (fund?.initialized) throw new AccountingError(409,"موجودی اولیه این صندوق قبلاً ثبت شده است.");
    executeChanges("INSERT OR IGNORE INTO accounting_funds(fund_id) VALUES(?)", [input.fundId]);
  } else if (!fund?.initialized) throw new AccountingError(422,"ابتدا مدیر باید موجودی اولیه این صندوق را ثبت کند.");
  const before = BigInt(fund?.balance_toman ?? "0");
  const after = input.transactionType === "deposit" ? before + input.amount : before - input.amount;
  if (after < 0n) throw new AccountingError(422,"موجودی صندوق برای این برداشت کافی نیست.");
  if (after.toString().length > 24) throw new AccountingError(422,"موجودی از محدوده مجاز فراتر می‌رود.");
  const id = execute(`INSERT INTO accounting_documents(
    fund_id,document_date,transaction_date,amount_toman,purpose,document_type,transaction_type,source,source_order_id,
       request_key,request_hash,balance_before_toman,balance_after_toman,created_by,created_at,
       counterparty_account_type,counterparty_account_number,counterparty_owner_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.fundId,input.documentDate,input.transactionDate,input.amount.toString(),input.purpose,input.documentType,
      input.transactionType,input.source,input.sourceOrderId ?? null,input.requestKey,input.requestHash,
      before.toString(),after.toString(),input.actorId,new Date().toISOString(),
      input.counterparty?.counterpartyAccountType ?? null,input.counterparty?.counterpartyAccountNumber ?? null,input.counterparty?.counterpartyOwnerName ?? null]);
  executeChanges("UPDATE accounting_funds SET balance_toman=?,initialized=1 WHERE fund_id=?", [after.toString(),input.fundId]);
  return id;
}
export function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function postPaymentDocument(order: any, actorId: number, fundId: number, paidAt: string, receipt: {
  name: string; mime: string; sha256: string; size: number;
}) {
  const existing = queryRow<{ id: number }>("SELECT id FROM accounting_documents WHERE source_order_id=?", [order.id]);
  if (existing) return existing.id;
  const date = tehranDate(new Date(paidAt));
  const id = postDocument({
    fundId,documentDate:tehranDate(),transactionDate:date,amount:amount(order.amount_toman),
    purpose:`پرداخت دستور پرداخت شماره ${order.id}`,documentType:"debit",transactionType:"withdrawal",
    source:"payment_order",sourceOrderId:order.id,requestKey:`payment:${order.id}`,
    requestHash:fingerprint({orderId:order.id,fundId,paidAt,hash:receipt.sha256}),actorId,
    ...(order.destination_iban && order.destination_owner_name ? {counterparty:{
      counterpartyAccountType:"iban" as const,counterpartyAccountNumber:order.destination_iban,counterpartyOwnerName:order.destination_owner_name,
    }} : {}),
  });
  execute(`INSERT INTO accounting_attachments(document_id,name,mime,size,sha256,stored_name,storage_kind,created_by,created_at)
    VALUES(?,?,?,?,?,?,'payment',?,?)`, [id,`رسید دستور پرداخت ${order.id}`,receipt.mime,receipt.size,receipt.sha256,receipt.name,actorId,new Date().toISOString()]);
  return id;
}
export function attachmentPath(row: { stored_name: string; storage_kind: string }) {
  if (path.basename(row.stored_name) !== row.stored_name) throw new AccountingError(404,"پیوست یافت نشد.");
  const root = row.storage_kind === "payment" ? paymentReceiptRoot : accountingFileRoot;
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) throw new AccountingError(404,"پیوست یافت نشد.");
  const file = path.join(root,row.stored_name);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new AccountingError(404,"پیوست یافت نشد.");
  return file;
}
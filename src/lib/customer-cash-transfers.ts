import { createHash, randomBytes } from "node:crypto";

export type TransferStore = {
  row<T>(sql: string, params?: any[]): T | undefined;
  rows<T>(sql: string, params?: any[]): T[];
  insert(sql: string, params?: any[]): number;
  changes(sql: string, params?: any[]): number;
  transaction<T>(fn: () => T): T;
  cashWallet(id: number): { id: number; balance: string };
  normalizeMobile(value: unknown): string;
};
export class CashTransferError extends Error {
  constructor(public code: string, public httpStatus = 409) { super(code); }
}
type Customer = { id: number; name: string; phone: string; merged_into_customer_id: number | null };
type Preparation = {
  token_hash: string; from_customer_id: number; to_customer_id: number; amount_toman: string;
  recipient_mobile: string; recipient_name: string; expires_at: string; used_transfer_id: number | null;
};
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const validAmount = (s: string) => /^[1-9]\d{0,15}$/.test(s) && BigInt(s) <= MAX_AMOUNT;

export const customerCashTransferSchema = `
CREATE TABLE IF NOT EXISTS customer_wallet_recipient_lookups (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_wallet_lookup ON customer_wallet_recipient_lookups(customer_id,created_at);
CREATE TABLE IF NOT EXISTS customer_wallet_transfer_preparations (
  token_hash TEXT PRIMARY KEY,
  from_customer_id INTEGER NOT NULL REFERENCES customers(id),
  to_customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_toman TEXT NOT NULL,
  recipient_mobile TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_transfer_id INTEGER REFERENCES wallet_transfers(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_wallet_preparation_expiry ON customer_wallet_transfer_preparations(expires_at);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet_id ON wallet_ledger_v2(wallet_id,id);
`;

export function prepareCustomerCashTransfer(db: TransferStore, sourceId: number, mobile: string, amount: string, sessionMobile: string) {
  const phone = db.normalizeMobile(mobile);
  if (!/^09\d{9}$/.test(phone) || !validAmount(amount)) throw new CashTransferError("invalid_transfer_input", 400);
  const ts = new Date().toISOString();
  // Count failures too: exact-number lookup must not become a customer directory.
  db.transaction(() => {
    const recent = db.row<{ count: number }>(
      "SELECT COUNT(*) count FROM customer_wallet_recipient_lookups WHERE customer_id=? AND created_at>?",
      [sourceId, new Date(Date.now() - 60 * 60 * 1000).toISOString()],
    )?.count ?? 0;
    if (recent >= 30) throw new CashTransferError("recipient_lookup_rate_limited", 429);
    db.insert("INSERT INTO customer_wallet_recipient_lookups(customer_id,created_at) VALUES(?,?)", [sourceId, ts]);
  });
  return db.transaction(() => {
    const source = db.row<Customer>("SELECT id,name,phone,merged_into_customer_id FROM customers WHERE id=?", [sourceId]);
    if (!source || source.merged_into_customer_id != null ||
      db.normalizeMobile(source.phone) !== db.normalizeMobile(sessionMobile)) throw new CashTransferError("source_customer_unavailable", 403);
    const balance = db.row<{ balance: string }>(
      "SELECT balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='cash'", [sourceId],
    )?.balance ?? "0";
    if (!/^\d+$/.test(balance) || BigInt(balance) < BigInt(amount)) throw new CashTransferError("insufficient_cash_balance");
    const matches = db.rows<Customer>(
      "SELECT id,name,phone,merged_into_customer_id FROM customers WHERE merged_into_customer_id IS NULL AND crm_customer_mobile_key(phone)=? LIMIT 2",
      [phone],
    );
    if (matches.length !== 1) throw new CashTransferError("recipient_not_found", 404);
    const recipient = matches[0];
    if (recipient.id === sourceId) throw new CashTransferError("self_transfer_not_allowed", 400);
    if (!recipient.name?.trim()) throw new CashTransferError("recipient_not_found", 404);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.insert(`INSERT INTO customer_wallet_transfer_preparations
      (token_hash,from_customer_id,to_customer_id,amount_toman,recipient_mobile,recipient_name,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, [hash(token), sourceId, recipient.id, amount, phone, recipient.name, expiresAt, ts]);
    return { recipientToken: token, recipientName: recipient.name, amountToman: amount, expiresAt };
  });
}

export function confirmCustomerCashTransfer(db: TransferStore, sourceId: number,
  input: { recipientToken: string; amountToman: string; confirmed: boolean; idempotencyKey: string }, sessionMobile: string) {
  if (input.confirmed !== true || !validAmount(input.amountToman) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.recipientToken) ||
    !/^[\x20-\x7e]{8,200}$/.test(input.idempotencyKey)) throw new CashTransferError("invalid_transfer_confirmation", 400);
  const key = `portal-cash:${sourceId}:${input.idempotencyKey}`;
  const result = db.transaction(() => {
    const prepared = db.row<Preparation>("SELECT * FROM customer_wallet_transfer_preparations WHERE token_hash=? AND from_customer_id=?",
      [hash(input.recipientToken), sourceId]);
    if (!prepared || prepared.amount_toman !== input.amountToman) throw new CashTransferError("transfer_confirmation_mismatch", 400);
    const source = db.row<Customer>("SELECT id,name,phone,merged_into_customer_id FROM customers WHERE id=?", [sourceId]);
    if (!source || source.merged_into_customer_id != null ||
      db.normalizeMobile(source.phone) !== db.normalizeMobile(sessionMobile)) throw new CashTransferError("source_customer_unavailable", 403);
    const previous = db.row<{ id: number; status: string; wallet_type: string; from_customer_id: number; to_customer_id: number; amount_toman: string; actor_customer_id: number | null }>(
      "SELECT * FROM wallet_transfers WHERE idempotency_key=?", [key]);
    if (previous) {
      if (previous.from_customer_id !== sourceId || previous.to_customer_id !== prepared.to_customer_id ||
        previous.amount_toman !== input.amountToman || previous.actor_customer_id !== sourceId || previous.wallet_type !== "cash")
        throw new CashTransferError("transfer_idempotency_conflict");
      return { id: previous.id, status: previous.status, amountToman: previous.amount_toman,
        cashBalanceToman: db.cashWallet(sourceId).balance, recipientName: prepared.recipient_name };
    }
    if (prepared.used_transfer_id != null) throw new CashTransferError("transfer_already_confirmed");
    if (Date.parse(prepared.expires_at) <= Date.now()) throw new CashTransferError("transfer_confirmation_expired");
    const target = db.row<Customer>("SELECT id,name,phone,merged_into_customer_id FROM customers WHERE id=?", [prepared.to_customer_id]);
    if (!target || target.merged_into_customer_id != null ||
      db.normalizeMobile(target.phone) !== prepared.recipient_mobile || target.name !== prepared.recipient_name)
      throw new CashTransferError("recipient_changed");
    if (sourceId === target.id) throw new CashTransferError("self_transfer_not_allowed", 400);
    const from = db.cashWallet(sourceId);
    const to = db.cashWallet(target.id);
    if (!/^\d+$/.test(from.balance) || !/^\d+$/.test(to.balance)) throw new CashTransferError("invalid_wallet_balance");
    const amount = BigInt(input.amountToman);
    const enough = BigInt(from.balance) >= amount;
    const status = enough ? "completed" : "failed";
    const ts = new Date().toISOString();
    const id = db.insert(`INSERT INTO wallet_transfers
      (from_customer_id,to_customer_id,wallet_type,amount_toman,status,error_code,reason,actor_user_id,actor_customer_id,idempotency_key,created_at)
      VALUES(?,?,'cash',?,?,?, ?,NULL,?,?,?)`,
      [sourceId, target.id, input.amountToman, status, enough ? null : "insufficient_cash_balance",
        "انتقال نقدی با تأیید مبلغ و نام مقصد توسط مشتری", sourceId, key, ts]);
    if (enough) {
      const debited = db.changes("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(from.balance) - amount).toString(), from.id]);
      const credited = db.changes("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(to.balance) + amount).toString(), to.id]);
      if (debited !== 1 || credited !== 1) throw new CashTransferError("wallet_posting_failed");
      for (const [idWallet, kind] of [[from.id, "transfer_out"], [to.id, "transfer_in"]] as const) {
        db.insert(`INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,actor_customer_id,created_at)
          VALUES(?,?,?,?,NULL,?,?)`, [idWallet, input.amountToman, kind, `wallet-transfer:${id}:${kind}`, sourceId, ts]);
      }
    }
    db.changes("UPDATE customer_wallet_transfer_preparations SET used_transfer_id=? WHERE token_hash=?", [id, prepared.token_hash]);
    return { id, status, amountToman: input.amountToman,
      cashBalanceToman: enough ? (BigInt(from.balance) - amount).toString() : from.balance, recipientName: prepared.recipient_name };
  });
  if (result.status !== "completed") throw new CashTransferError("insufficient_cash_balance");
  return { ...result, status: "completed" as const };
}

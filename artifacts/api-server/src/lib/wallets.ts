import { ensureCompanyPurchaseReceiptSchema } from "./company-purchase-receipts";
import { crmDb, execute, executeChanges, queryRow, runTransaction } from "./crm-db";
import { allocateGoodsLoanCredit } from "./goods-finance";

export type WalletType = "cash" | "credit";
export type WalletSummary = {
  type: WalletType;
  balanceToman: string;
  ledger: Array<{ amountToman: string; kind: string; idempotencyKey: string; createdAt: string }>;
};

const now = () => new Date().toISOString();

export function ensureWalletSchema(): void {
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS wallet_accounts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      wallet_type TEXT NOT NULL CHECK(wallet_type IN ('cash','credit')),
      balance TEXT NOT NULL DEFAULT '0' CHECK(balance GLOB '[0-9]*'),
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      UNIQUE(customer_id, wallet_type)
    );
    CREATE TABLE IF NOT EXISTS wallet_ledger_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      application_id INTEGER,
      amount TEXT NOT NULL CHECK(amount GLOB '[0-9]*'),
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(wallet_id) REFERENCES wallet_accounts_v2(id) ON DELETE CASCADE,
      FOREIGN KEY(application_id) REFERENCES loan_applications(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_payment_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      wallet_id INTEGER NOT NULL,
      amount_toman TEXT NOT NULL,
      amount_rial TEXT NOT NULL,
      authority TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'created',
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(wallet_id) REFERENCES wallet_accounts_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS wallet_share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      amount_toman TEXT NOT NULL,
      plan_id INTEGER REFERENCES loan_plans(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'created',
      payment_intent_id INTEGER UNIQUE REFERENCES wallet_payment_intents(id) ON DELETE SET NULL,
      start_claim TEXT,
      start_claim_expires_at TEXT,
      sms_status TEXT,
      sms_claim TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_share_links_expiry ON wallet_share_links(expires_at);
    CREATE TABLE IF NOT EXISTS wallet_payment_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      initiated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      payment_intent_id INTEGER UNIQUE REFERENCES wallet_payment_intents(id) ON DELETE SET NULL,
      amount_toman TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('requested','gateway_ready','failed','cancelled','credited','verification_pending','requires_reconciliation')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_payment_attempts_customer ON wallet_payment_attempts(customer_id,created_at);
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      to_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      wallet_type TEXT NOT NULL CHECK(wallet_type IN ('cash','credit')),
      amount_toman TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed','failed')),
      error_code TEXT,
      reason TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      CHECK(from_customer_id <> to_customer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_created ON wallet_transfers(created_at);
    CREATE TABLE IF NOT EXISTS company_wallet_accounts (
      wallet_type TEXT PRIMARY KEY CHECK(wallet_type IN ('cash','credit')),
      balance TEXT NOT NULL DEFAULT '0' CHECK(balance GLOB '[0-9]*')
    );
    CREATE TABLE IF NOT EXISTS loan_filing_fee_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      plan_id INTEGER NOT NULL REFERENCES loan_plans(id) ON DELETE RESTRICT,
      amount_toman TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      application_id INTEGER UNIQUE REFERENCES loan_applications(id) ON DELETE RESTRICT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS company_wallet_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_type TEXT NOT NULL REFERENCES company_wallet_accounts(wallet_type),
      amount_toman TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('filing_fee','manual_deposit','manual_withdrawal')),
      fee_charge_id INTEGER UNIQUE REFERENCES loan_filing_fee_charges(id) ON DELETE RESTRICT,
      reason TEXT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO company_wallet_accounts(wallet_type,balance) VALUES('cash','0'),('credit','0');
  `);
  const ledgerColumns = crmDb.prepare("PRAGMA table_info(wallet_ledger_v2)").all() as Array<{ name: string }>;
  if (!ledgerColumns.some((column) => column.name === "actor_user_id")) {
    crmDb.exec("ALTER TABLE wallet_ledger_v2 ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  if (!ledgerColumns.some((column) => column.name === "actor_customer_id")) {
    crmDb.exec("ALTER TABLE wallet_ledger_v2 ADD COLUMN actor_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL");
  }
  const customerActorColumns: Array<[string, string, string]> = [
    ["loan_filing_fee_charges", "actor_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
    ["company_wallet_ledger", "actor_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
    ["wallet_payment_intents", "created_by_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
    ["wallet_payment_attempts", "initiated_by_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
    ["wallet_share_links", "created_by_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
    ["wallet_transfers", "actor_customer_id", "INTEGER REFERENCES customers(id) ON DELETE SET NULL"],
  ];
  for (const [table, column, definition] of customerActorColumns) {
    const columns = crmDb.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    if (columns.length && !columns.some((item) => item.name === column)) {
      crmDb.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${definition}`);
    }
  }
  ensureCompanyPurchaseReceiptSchema(crmDb);
  const intentColumns = crmDb.prepare("PRAGMA table_info(wallet_payment_intents)").all() as Array<{ name: string }>;
  if (!intentColumns.some((column) => column.name === "provider_ref_id")) {
    crmDb.exec("ALTER TABLE wallet_payment_intents ADD COLUMN provider_ref_id TEXT");
  }
  if (!intentColumns.some((column) => column.name === "reconciled_by_user_id")) {
    crmDb.exec("ALTER TABLE wallet_payment_intents ADD COLUMN reconciled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  crmDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_payment_provider_ref ON wallet_payment_intents(provider_ref_id) WHERE provider_ref_id IS NOT NULL");
  const shareColumns = crmDb.prepare("PRAGMA table_info(wallet_share_links)").all() as Array<{ name: string }>;
  if (!shareColumns.some(column => column.name === "sms_token_hash")) {
    crmDb.exec("ALTER TABLE wallet_share_links ADD COLUMN sms_token_hash TEXT");
  }
  if (!shareColumns.some(column => column.name === "sms_message_id")) {
    crmDb.exec("ALTER TABLE wallet_share_links ADD COLUMN sms_message_id TEXT");
  }
  crmDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_sms_token ON wallet_share_links(sms_token_hash) WHERE sms_token_hash IS NOT NULL");
  if (!shareColumns.some((column) => column.name === "sms_status")) {
    crmDb.exec("ALTER TABLE wallet_share_links ADD COLUMN sms_status TEXT");
  }
  if (!shareColumns.some((column) => column.name === "sms_claim")) {
    crmDb.exec("ALTER TABLE wallet_share_links ADD COLUMN sms_claim TEXT");
  }
  // Preserve every historical intent as a reportable attempt; the initiator was
  // not recorded in the legacy table and must remain unknown rather than guessed.
  crmDb.exec(`
    INSERT OR IGNORE INTO wallet_payment_attempts(customer_id,payment_intent_id,amount_toman,idempotency_key,status,created_at,updated_at)
    SELECT customer_id,id,amount_toman,idempotency_key,
      CASE status WHEN 'created' THEN 'gateway_ready'
        WHEN 'provider_already_verified' THEN 'requires_reconciliation'
        ELSE status END,
      created_at,COALESCE(verified_at,created_at)
    FROM wallet_payment_intents
  `);
  // One-time, additive migration of the legacy single wallet. Legacy rows and
  // ledger history remain intact and are copied into the credit wallet.
  const marker = queryRow("SELECT 1 AS value FROM schema_migrations WHERE version=?", ["wallets-two-wallets-v1"]);
  if (!marker) {
    crmDb.exec("BEGIN");
    try {
      const old = crmDb.prepare("SELECT id, customer_id, balance, created_at FROM wallet_accounts").all() as Array<{ id: number; customer_id: number; balance: string; created_at: string }>;
      for (const account of old) {
        if (!/^\d+$/.test(String(account.balance))) throw new Error("invalid_legacy_wallet_balance");
        const existing = queryRow<{ id: number }>("SELECT id FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type='credit'", [account.customer_id]);
        const walletId = existing?.id ?? execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,?,?,?)", [account.customer_id, "credit", String(account.balance), account.created_at || now()]);
        if (!existing) {
          const entries = crmDb.prepare("SELECT application_id, amount, kind, idempotency_key, created_at FROM wallet_ledger WHERE account_id=?").all(account.id) as Array<{ application_id: number | null; amount: string; kind: string; idempotency_key: string; created_at: string }>;
          for (const entry of entries) {
            if (!/^\d+$/.test(String(entry.amount))) throw new Error("invalid_legacy_wallet_entry");
            execute("INSERT OR IGNORE INTO wallet_ledger_v2(wallet_id,application_id,amount,kind,idempotency_key,created_at) VALUES(?,?,?,?,?,?)", [walletId, entry.application_id, String(entry.amount), `legacy_${entry.kind}`, `legacy:${entry.idempotency_key}`, entry.created_at]);
          }
        }
      }
      execute("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", ["wallets-two-wallets-v1", now()]);
      crmDb.exec("COMMIT");
    } catch (error) {
      crmDb.exec("ROLLBACK");
      throw error;
    }
  }
}

function wallet(customerId: number, type: WalletType): { id: number; balance: string } {
  const row = queryRow<{ id: number; balance: string }>("SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?", [customerId, type]);
  if (row) return row;
  const id = execute("INSERT INTO wallet_accounts_v2(customer_id,wallet_type,balance,created_at) VALUES(?,?,?,?)", [customerId, type, "0", now()]);
  return { id, balance: "0" };
}

export function creditLoanWallet(applicationId: number, customerId: number, amountToman: string | number | bigint, actorId: number): void {
  const amount = BigInt(String(amountToman));
  if (amount < 0n) throw new Error("invalid_wallet_amount");
  const target = wallet(customerId, "credit");
  const key = `loan-application:${applicationId}:credit`;
  if (queryRow("SELECT id FROM wallet_ledger_v2 WHERE idempotency_key=?", [key])) return;
  const ledgerId = execute("INSERT INTO wallet_ledger_v2(wallet_id,application_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?)", [target.id, applicationId, amount.toString(), `loan_credit:actor:${actorId}`, key, actorId, now()]);
  executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(target.balance) + amount).toString(), target.id]);
  allocateGoodsLoanCredit(applicationId,customerId,amount.toString(),ledgerId);
}

export function getWalletSummary(customerId: number): { cash: WalletSummary; credit: WalletSummary } {
  const result = {} as { cash: WalletSummary; credit: WalletSummary };
  for (const type of ["cash", "credit"] as WalletType[]) {
    const account = wallet(customerId, type);
    const rows = crmDb.prepare("SELECT amount,kind,idempotency_key,created_at FROM wallet_ledger_v2 WHERE wallet_id=? ORDER BY id DESC LIMIT 100").all(account.id) as Array<{ amount: string; kind: string; idempotency_key: string; created_at: string }>;
    result[type] = { type, balanceToman: account.balance, ledger: rows.map((r) => ({ amountToman: r.amount, kind: r.kind, idempotencyKey: r.idempotency_key, createdAt: r.created_at })) };
  }
  return result;
}

export function getWalletSummaryReadOnly(customerId: number): { cash: WalletSummary; credit: WalletSummary } {
  const result = {} as { cash: WalletSummary; credit: WalletSummary };
  for (const type of ["cash", "credit"] as WalletType[]) {
    const account = queryRow<{ id: number; balance: string }>(
      "SELECT id,balance FROM wallet_accounts_v2 WHERE customer_id=? AND wallet_type=?",
      [customerId, type],
    );
    const rows = account
      ? crmDb.prepare("SELECT amount,kind,idempotency_key,created_at FROM wallet_ledger_v2 WHERE wallet_id=? ORDER BY id DESC LIMIT 100").all(account.id) as Array<{ amount: string; kind: string; idempotency_key: string; created_at: string }>
      : [];
    result[type] = {
      type,
      balanceToman: account?.balance ?? "0",
      ledger: rows.map((row) => ({
        amountToman: row.amount,
        kind: row.kind,
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
      })),
    };
  }
  return result;
}

export function creditVerifiedCashPayment(intentId: number, providerRefId: string, actorId: number | null): "credited" | "already_credited" {
  if (!/^[1-9]\d{0,30}$/.test(providerRefId)) throw new Error("invalid_provider_receipt");
  return runTransaction(() => {
    const intent = queryRow<{ id: number; customer_id: number; wallet_id: number; amount_toman: string; amount_rial: string; status: string; provider_ref_id: string | null; created_by_customer_id: number | null }>(
      "SELECT id,customer_id,wallet_id,amount_toman,amount_rial,status,provider_ref_id,created_by_customer_id FROM wallet_payment_intents WHERE id=?", [intentId]);
    if (!intent) throw new Error("payment_not_found");
    const account = queryRow<{ id: number; balance: string }>(
      "SELECT id,balance FROM wallet_accounts_v2 WHERE id=? AND customer_id=? AND wallet_type='cash'", [intent.wallet_id, intent.customer_id]);
    if (!account || !/^[1-9]\d*$/.test(intent.amount_toman) || BigInt(intent.amount_rial) !== BigInt(intent.amount_toman) * 10n) throw new Error("payment_intent_mismatch");
    if (intent.provider_ref_id && intent.provider_ref_id !== providerRefId) throw new Error("payment_receipt_mismatch");
    if (queryRow("SELECT id FROM wallet_payment_intents WHERE provider_ref_id=? AND id<>?", [providerRefId, intentId])) throw new Error("payment_receipt_already_used");
    const key = `cash-payment:${intent.id}`;
    const ledger = queryRow<{ wallet_id: number; amount: string; kind: string }>(
      "SELECT wallet_id,amount,kind FROM wallet_ledger_v2 WHERE idempotency_key=?", [key]);
    if (ledger && (ledger.wallet_id !== account.id || ledger.amount !== intent.amount_toman || ledger.kind !== "cash_payment")) throw new Error("payment_ledger_mismatch");
    if (intent.status === "credited") {
      if (!ledger) throw new Error("payment_ledger_missing");
      // Older credits may predate the receipt column.
      executeChanges("UPDATE wallet_payment_intents SET provider_ref_id=COALESCE(provider_ref_id,?) WHERE id=?", [providerRefId, intentId]);
      return "already_credited";
    }
    if (!ledger) {
      const attempt = queryRow<{ initiated_by_user_id: number | null; initiated_by_customer_id: number | null }>("SELECT initiated_by_user_id,initiated_by_customer_id FROM wallet_payment_attempts WHERE payment_intent_id=?", [intentId]);
      execute("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,actor_customer_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [account.id, intent.amount_toman, "cash_payment", key, attempt?.initiated_by_user_id ?? actorId,
          attempt?.initiated_by_customer_id ?? intent.created_by_customer_id ?? null, now()]);
      executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(account.balance) + BigInt(intent.amount_toman)).toString(), account.id]);
    }
    executeChanges("UPDATE wallet_payment_intents SET status='credited',verified_at=?,provider_ref_id=?,reconciled_by_user_id=? WHERE id=?",
      [now(), providerRefId, actorId, intentId]);
    executeChanges("UPDATE wallet_payment_attempts SET status='credited',error_code=NULL,updated_at=? WHERE payment_intent_id=?", [now(), intentId]);
    return "credited";
  });
}

export { wallet };
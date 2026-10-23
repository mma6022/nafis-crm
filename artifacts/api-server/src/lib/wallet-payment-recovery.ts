import { createHmac, timingSafeEqual } from "node:crypto";
import { queryRow, queryRows, executeChanges } from "./crm-db";
import { creditVerifiedCashPayment } from "./wallets";
import { logger } from "./logger";

export function updatePaymentAttempt(intentId: number, status: string, errorCode: string | null = null) {
  executeChanges(`UPDATE wallet_payment_attempts SET status=?,error_code=?,updated_at=?
    WHERE payment_intent_id=? AND (?='credited' OR NOT EXISTS
      (SELECT 1 FROM wallet_payment_intents i WHERE i.id=payment_intent_id AND i.status='credited'))`,
    [status, errorCode, new Date().toISOString(), intentId, status]);
}
export async function verifyProvider(authority: string, amountRial: string) {
  const merchant = process.env.ZARINPAL_MERCHANT_ID;
  if (!merchant || !/^[1-9]\d*$/.test(amountRial) || BigInt(amountRial) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("verification_configuration_or_amount");
  const response = await fetch("https://payment.zarinpal.com/pg/v4/payment/verify.json", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ merchant_id: merchant, amount: Number(amountRial), authority }),
    signal: AbortSignal.timeout(8000),
  });
  const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const payload = object(await response.json());
  const data = object(payload.data);
  const code = typeof data.code === "number" ? data.code : object(payload.errors).code;
  if (typeof code !== "number" || !Number.isInteger(code) || (!response.ok && code >= 0)) throw new Error("verification_invalid_response");
  const raw = data.ref_id;
  const receipt = typeof raw === "string" ? raw : Number.isSafeInteger(raw) ? String(raw) : "";
  return { code: code as number, refId: /^[1-9]\d{0,30}$/.test(receipt) ? receipt : null };
}
const checking = new Map<number, Promise<string>>();
export function verifyAndCreditWalletPayment(intentId: number): Promise<string> {
  const existing = checking.get(intentId);
  if (existing) return existing;
  const work = (async () => {
    const intent = queryRow<{ authority: string; amount_rial: string; status: string }>(
      "SELECT authority,amount_rial,status FROM wallet_payment_intents WHERE id=?", [intentId]);
    if (!intent) throw new Error("payment_not_found");
    if (intent.status === "credited") return "already_credited";
    try {
      const proof = await verifyProvider(intent.authority, intent.amount_rial);
      if (![100, 101].includes(proof.code)) {
        updatePaymentAttempt(intentId, "verification_pending", `provider_${proof.code}`);
        return "pending";
      }
      if (!proof.refId) {
        updatePaymentAttempt(intentId, "requires_reconciliation", "provider_receipt_missing");
        return "reconciliation";
      }
      // 101 means provider verification happened earlier, not that our ledger
      // was posted. Both successful codes require a real receipt and the same
      // atomic, idempotent amount/wallet/receipt checks.
      const result = creditVerifiedCashPayment(intentId, proof.refId, null);
      logger.info({ paymentId: intentId, status: result }, "Wallet payment verified and posted");
      return result;
    } catch (error) {
      updatePaymentAttempt(intentId, "verification_pending", "verification_or_posting_unavailable");
      logger.warn({ paymentId: intentId, reason: error instanceof Error ? error.name : "unknown" }, "Wallet payment will be retried");
      return "pending";
    }
  })().finally(() => checking.delete(intentId));
  checking.set(intentId, work);
  return work;
}

function receiptSignature(body: string) {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < 16) throw new Error("receipt_configuration_unavailable");
  return createHmac("sha256", key).update(`wallet-payment-receipt:${body}`).digest("hex");
}
export function createWalletPaymentReceipt(intentId: number) {
  const body = `${intentId}.${Math.floor(Date.now() / 1000) + 86400}`;
  return `${body}.${receiptSignature(body)}`;
}
export function readWalletPaymentReceipt(token: string): number | null {
  const match = /^([1-9]\d{0,15})\.([1-9]\d{9,11})\.([a-f0-9]{64})$/.exec(token);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[2]) < Date.now() / 1000 ||
    Number(match[2]) > Date.now() / 1000 + 86460) return null;
  const actual = Buffer.from(match[3], "hex");
  return timingSafeEqual(actual, Buffer.from(receiptSignature(`${match[1]}.${match[2]}`), "hex")) ? Number(match[1]) : null;
}
export function walletPaymentReceiptData(intentId: number) {
  const row = queryRow<{ amount_toman: string; status: string; provider_ref_id: string | null; verified_at: string | null;
    wallet_id: number; ledger_wallet_id: number | null; ledger_amount: string | null; ledger_kind: string | null }>(
    `SELECT i.amount_toman,i.status,i.provider_ref_id,i.verified_at,i.wallet_id,
      l.wallet_id ledger_wallet_id,l.amount ledger_amount,l.kind ledger_kind
     FROM wallet_payment_intents i LEFT JOIN wallet_ledger_v2 l ON l.idempotency_key=('cash-payment:'||i.id)
     WHERE i.id=?`, [intentId]);
  if (!row) return null;
  const posted = row.status === "credited" && row.verified_at != null && row.provider_ref_id != null &&
    row.ledger_wallet_id === row.wallet_id && row.ledger_amount === row.amount_toman && row.ledger_kind === "cash_payment";
  return { amountToman: row.amount_toman, status: posted ? "credited" : row.status === "credited" ? "reconciliation"
    : row.status === "cancelled" ? "cancelled" : "pending", providerRefId: posted ? row.provider_ref_id : null };
}
let recovering = false;
export async function recoverPendingWalletPayments() {
  if (recovering || !process.env.ZARINPAL_MERCHANT_ID) return;
  recovering = true;
  try {
    // Fair oldest-check-first selection; a customer who abandons the browser
    // cannot prevent verification. Recent payments are checked each minute,
    // older ones every 15 minutes, for the provider's useful recovery window.
    const rows = queryRows<{ id: number }>(`SELECT i.id FROM wallet_payment_intents i
      JOIN wallet_payment_attempts a ON a.payment_intent_id=i.id
      WHERE i.status IN ('created','provider_already_verified','cancelled')
        AND julianday(i.created_at)>=julianday('now','-2 days')
        AND julianday(a.updated_at)<=julianday('now',
          CASE WHEN julianday(i.created_at)>=julianday('now','-1 hour') THEN '-1 minute' ELSE '-15 minutes' END)
      GROUP BY i.id ORDER BY MIN(a.updated_at),i.id LIMIT 20`);
    for (const row of rows) await verifyAndCreditWalletPayment(row.id);
  } finally { recovering = false; }
}
export function startWalletPaymentRecovery() {
  // Development may contain copied/stale provider authorities. Never verify
  // real payments from a development preview.
  if (process.env.NODE_ENV !== "production") return;
  setTimeout(() => { void recoverPendingWalletPayments().catch(error => logger.error({ err: error }, "Wallet payment recovery failed")); }, 5000).unref();
  setInterval(() => { void recoverPendingWalletPayments().catch(error => logger.error({ err: error }, "Wallet payment recovery failed")); }, 60000).unref();
}

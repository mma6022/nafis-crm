// Customer-facing receipt view for one wallet payment (GET /wallet/share-links/receipt/:receipt).
// Pure function so it can be unit-tested without a database. Derived only from columns that already
// exist (wallet_payment_intents + wallet_payment_attempts): no schema change, no migration.
//
// Backward compatible: the existing fields (amountToman, status, providerRefId) keep their meaning;
// "failed" is a new status value and paidAt / updatedAt / gatewayMessage are new optional fields.
// "failed" is never written to the database. It is derived at read time, so if a later verification
// still credits the payment the receipt simply shows "credited".

export type ReceiptRow = {
  amount_toman: string; status: string; provider_ref_id: string | null; verified_at: string | null;
  created_at: string | null; wallet_id: number; ledger_wallet_id: number | null; ledger_amount: string | null; ledger_kind: string | null;
  attempt_status: string | null; attempt_error_code: string | null; attempt_updated_at: string | null;
};
export type ReceiptStatus = "credited" | "reconciliation" | "pending" | "cancelled" | "failed";
export type ReceiptView = {
  amountToman: string; status: ReceiptStatus; providerRefId: string | null;
  /** ISO time the payment was verified and credited (credited only). */
  paidAt?: string;
  /** ISO time of the last status change we know of (attempt update, else intent creation). */
  updatedAt?: string;
  /** Persian text for the gateway's answer (failed only). Never an internal error code. */
  gatewayMessage?: string;
};

/** Same window as recoverPendingWalletPayments: after it, nobody verifies the payment again. */
export const RECOVERY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** Zarinpal v4 verify codes that can never turn into a successful payment for this authority. */
const DEFINITIVE_PROVIDER_FAILURES: Record<string, string> = {
  "-50": "مبلغ پرداخت‌شده با مبلغ درخواست یکی نبود.",
  "-53": "این پرداخت متعلق به این پذیرنده نیست.",
  "-54": "شناسه‌ی پرداخت معتبر نیست.",
  "-55": "تراکنش در درگاه پیدا نشد.",
};
const PROVIDER_MESSAGES: Record<string, string> = {
  ...DEFINITIVE_PROVIDER_FAILURES,
  "-51": "پرداخت در درگاه ناموفق بود.",
  "-52": "درگاه پرداخت خطای غیرمنتظره برگرداند.",
};
const GENERIC_FAILURE = "درگاه پرداخت این پرداخت را تأیید نکرد.";
const EXPIRED = "مهلت تأیید پرداخت تمام شد.";

const providerCode = (errorCode: string | null) => /^provider_(-?\d{1,4})$/.exec(errorCode ?? "")?.[1] ?? null;
const iso = (v: string | null | undefined) => (v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : undefined);

export function walletReceiptView(row: ReceiptRow, now = Date.now()): ReceiptView {
  const posted = row.status === "credited" && row.verified_at != null && row.provider_ref_id != null &&
    row.ledger_wallet_id === row.wallet_id && row.ledger_amount === row.amount_toman && row.ledger_kind === "cash_payment";
  const updatedAt = iso(row.attempt_updated_at) ?? iso(row.created_at);
  const base = { amountToman: row.amount_toman, providerRefId: posted ? row.provider_ref_id : null, ...(updatedAt ? { updatedAt } : {}) };
  if (posted) return { ...base, status: "credited", ...(iso(row.verified_at) ? { paidAt: iso(row.verified_at) } : {}) };
  if (row.status === "credited") return { ...base, status: "reconciliation" };
  if (row.status === "provider_already_verified" || row.attempt_status === "requires_reconciliation") return { ...base, status: "pending" };

  const code = providerCode(row.attempt_error_code);
  const created = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const outOfWindow = Number.isFinite(created) && now - created > RECOVERY_WINDOW_MS;
  // Definitive gateway answer, or an attempt the server already marked failed.
  if ((code && code in DEFINITIVE_PROVIDER_FAILURES) || row.attempt_status === "failed")
    return { ...base, status: "failed", gatewayMessage: (code && PROVIDER_MESSAGES[code]) || GENERIC_FAILURE };
  // Cancelled at the gateway keeps its own screen (64) while it can still be recovered.
  if (row.status === "cancelled") return { ...base, status: "cancelled" };
  // Still unverified after the recovery window: nothing will credit it any more.
  if (outOfWindow) return { ...base, status: "failed", gatewayMessage: (code && PROVIDER_MESSAGES[code]) || EXPIRED };
  return { ...base, status: "pending" };
}

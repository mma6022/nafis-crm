import assert from "node:assert/strict";
import { walletReceiptView, RECOVERY_WINDOW_MS } from "../src/lib/wallet-payment-receipt-view.ts";

const now = Date.parse("2026-10-23T08:00:00Z");
const recent = new Date(now - 10 * 60 * 1000).toISOString();
const old = new Date(now - RECOVERY_WINDOW_MS - 60_000).toISOString();
const row = (o = {}) => ({ amount_toman: "2000000", status: "created", provider_ref_id: null, verified_at: null, created_at: recent, wallet_id: 5,
  ledger_wallet_id: null, ledger_amount: null, ledger_kind: null, attempt_status: "gateway_ready", attempt_error_code: null, attempt_updated_at: recent, ...o });

// Unchanged behaviour (old fields keep their meaning).
const paid = walletReceiptView(row({ status: "credited", provider_ref_id: "741029385", verified_at: "2026-10-23T06:54:00Z", ledger_wallet_id: 5, ledger_amount: "2000000", ledger_kind: "cash_payment", attempt_status: "credited" }), now);
assert.equal(paid.status, "credited"); assert.equal(paid.providerRefId, "741029385"); assert.equal(paid.paidAt, "2026-10-23T06:54:00.000Z");
assert.equal(paid.gatewayMessage, undefined);
const unposted = walletReceiptView(row({ status: "credited", provider_ref_id: "1", verified_at: recent }), now);
assert.equal(unposted.status, "reconciliation"); assert.equal(unposted.providerRefId, null); assert.equal(unposted.paidAt, undefined);
assert.equal(walletReceiptView(row(), now).status, "pending");
assert.equal(walletReceiptView(row({ status: "provider_already_verified" }), now).status, "pending");
assert.equal(walletReceiptView(row({ attempt_status: "verification_pending", attempt_error_code: "provider_-51" }), now).status, "pending", "-51 stays retryable inside the window");
assert.equal(walletReceiptView(row({ status: "cancelled", attempt_status: "cancelled", attempt_error_code: "provider_-51" }), now).status, "cancelled");
assert.equal(walletReceiptView(row({ status: "cancelled", attempt_status: "cancelled", created_at: old }), now).status, "cancelled");
assert.equal(walletReceiptView(row({ attempt_status: "requires_reconciliation", created_at: old }), now).status, "pending", "reconciliation never auto-fails");

// New: failed.
const mismatch = walletReceiptView(row({ attempt_status: "verification_pending", attempt_error_code: "provider_-50" }), now);
assert.equal(mismatch.status, "failed"); assert.match(mismatch.gatewayMessage, /مبلغ/);
const marked = walletReceiptView(row({ attempt_status: "failed", attempt_error_code: "configuration_unavailable" }), now);
assert.equal(marked.status, "failed"); assert.equal(marked.gatewayMessage, "درگاه پرداخت این پرداخت را تأیید نکرد.", "internal codes never leak");
const expired = walletReceiptView(row({ created_at: old, attempt_updated_at: old }), now);
assert.equal(expired.status, "failed"); assert.equal(expired.gatewayMessage, "مهلت تأیید پرداخت تمام شد.");
const expired51 = walletReceiptView(row({ created_at: old, attempt_status: "verification_pending", attempt_error_code: "provider_-51" }), now);
assert.equal(expired51.status, "failed"); assert.equal(expired51.gatewayMessage, "پرداخت در درگاه ناموفق بود.");
// A failed view never wins over a later credit (derived, never stored).
assert.equal(walletReceiptView(row({ status: "credited", provider_ref_id: "9", verified_at: recent, ledger_wallet_id: 5, ledger_amount: "2000000", ledger_kind: "cash_payment", attempt_error_code: "provider_-50", attempt_status: "credited" }), now).status, "credited");
// Time field.
assert.equal(walletReceiptView(row(), now).updatedAt, recent);
assert.equal(walletReceiptView(row({ attempt_updated_at: null }), now).updatedAt, recent);
console.log("PASS: wallet receipt view keeps old statuses and adds failed, paidAt, updatedAt and gatewayMessage.");

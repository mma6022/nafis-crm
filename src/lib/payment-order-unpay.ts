/**
 * Shared body of «برگرداندن پرداخت‌شده». Must run inside runTransaction.
 * Accounting compensating document + team-commission neutralization + snapshot.
 * Nothing is deleted. Extracted so t882 stage-back can reuse it without changing unpay behavior.
 */
import type { AuthUser } from "./auth";
import { execute, executeChanges, queryRow } from "./crm-db";
import { paidReversalCount, paymentEvent } from "./payment-orders";
import { reversePaymentDocument } from "./accounting";
import { unpayPurchaseCommission } from "./team-commission";

const now = () => new Date().toISOString();

export function revertPaidPaymentOrder(order: any, actor: AuthUser, reason: string): { revision: number; neutralizedCommissionRows: unknown } {
  if (order.stage !== "paid") throw new Error("wrong_payment_stage");
  const revision = paidReversalCount(order.id) + 1;
  const feed = Boolean(queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_notification_events'"));
  const preMax = feed ? Number(queryRow<any>("SELECT MAX(id) m FROM site_notification_events")?.m ?? 0) : -1;
  const snapshot = {
    sourceBankAccountId: order.source_bank_account_id, trackingNumber: order.tracking_number, paidAt: order.paid_at,
    receiptFilename: order.receipt_filename, receiptMime: order.receipt_mime, receiptSha256: order.receipt_sha256, paidBy: order.paid_by,
  };
  const commission = unpayPurchaseCommission(order.purchase_id, actor.id, reason);
  const doc = reversePaymentDocument(order, actor.id, revision, reason);
  if (executeChanges(`UPDATE customer_payment_orders SET stage='awaiting_payment',source_bank_account_id=NULL,tracking_number=NULL,paid_at=NULL,
    receipt_filename=NULL,receipt_mime=NULL,receipt_sha256=NULL,paid_by=NULL,updated_at=? WHERE id=? AND stage='paid'`, [now(), order.id]) !== 1) {
    throw new Error("payment_stage_changed");
  }
  execute(`INSERT INTO payment_order_paid_reversals(order_id,revision,reason,actor_id,created_at,snapshot_json,accounting_original_document_id,accounting_reversal_document_id)
    VALUES(?,?,?,?,?,?,?,?)`, [order.id, revision, reason, actor.id, now(), JSON.stringify({ ...snapshot, neutralizedCommissionRows: commission.neutralized }), doc.originalId, doc.reversalId]);
  paymentEvent(order.id, "payment_reverted", actor.id, { reason, revision, neutralizedCommissionRows: commission.neutralized });
  if (preMax >= 0) executeChanges("DELETE FROM site_notification_events WHERE id>?", [preMax]);
  return { revision, neutralizedCommissionRows: commission.neutralized };
}

import { Router } from "express";
import { crmDb, execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "../lib/crm-db";
import { customerPortalSession, requireCustomerPortal } from "../lib/customer-portal-auth";
import { normalizeCustomerMobile } from "../lib/customer-integrity";
import { ensureWalletSchema, wallet } from "../lib/wallets";
import { CashTransferError, confirmCustomerCashTransfer, customerCashTransferSchema, prepareCustomerCashTransfer, type TransferStore } from "../lib/customer-cash-transfers";

ensureWalletSchema();
crmDb.exec(customerCashTransferSchema);
const router = Router();
router.use(requireCustomerPortal);
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const store: TransferStore = {
  row: queryRow, rows: queryRows, insert: execute, changes: executeChanges,
  transaction: runImmediateTransaction, cashWallet: id => wallet(id, "cash"), normalizeMobile: normalizeCustomerMobile,
};
const descriptions: Record<string, string> = {
  transfer_in: "انتقال دریافتی", transfer_out: "انتقال ارسالی", filing_fee_out: "هزینه تشکیل پرونده",
  verified_cash_payment: "شارژ آنلاین", cash_payment: "شارژ آنلاین", loan_credit: "واریز اعتبار تسهیلات",
  loan_funding: "واریز اعتبار تسهیلات", legacy_credit: "اعتبار قبلی", admin_credit: "افزایش موجودی",
  admin_debit: "کسر موجودی", goods_purchase: "خرید کالا", goods_purchase_out: "خرید کالا",
};
router.get("/wallet/transactions", (req, res): void => {
  const id = customerPortalSession(res)?.customerId;
  if (!id) { res.status(403).json({ error: "customer_required" }); return; }
  const cursor = req.query.cursor == null ? null : String(req.query.cursor);
  if (cursor != null && (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
    res.status(400).json({ error: "invalid_wallet_cursor", message: "نشانی صفحه تراکنش معتبر نیست." }); return;
  }
  const rows = queryRows<{ id: number; wallet_type: "cash" | "credit"; amount: string; kind: string; created_at: string }>(
    `SELECT l.id,w.wallet_type,l.amount,l.kind,l.created_at
     FROM wallet_ledger_v2 l JOIN wallet_accounts_v2 w ON w.id=l.wallet_id
     WHERE w.customer_id=? ${cursor ? "AND l.id<?" : ""} ORDER BY l.id DESC LIMIT 21`,
    cursor ? [id, Number(cursor)] : [id],
  );
  const items = rows.slice(0, 20).map(row => ({
    id: Number(row.id), walletType: row.wallet_type, amountToman: row.amount, kind: row.kind,
    direction: /(?:_out$|debit|purchase|withdraw)/.test(row.kind) ? "out" : "in",
    createdAt: row.created_at, description: descriptions[row.kind] ??
      (row.kind.startsWith("loan_credit:") ? "واریز اعتبار تسهیلات" : row.kind.startsWith("legacy_") ? "اعتبار قبلی" : "تراکنش کیف پول"),
  }));
  res.json({ items, nextCursor: rows.length > 20 ? String(items[items.length - 1].id) : null });
});
const errors: Record<string, string> = {
  insufficient_cash_balance: "موجودی نقدی برای این انتقال کافی نیست.",
  recipient_not_found: "مشتری یکتایی با این شماره در سیستم نفیس پیدا نشد.",
  self_transfer_not_allowed: "انتقال به کیف پول خودتان مجاز نیست.",
  recipient_lookup_rate_limited: "تعداد جستجوها بیش از حد مجاز است. بعداً دوباره تلاش کنید.",
  invalid_transfer_input: "شماره همراه و مبلغ انتقال را درست وارد کنید.",
  invalid_transfer_confirmation: "اطلاعات تأیید انتقال معتبر نیست.",
  transfer_confirmation_mismatch: "مبلغ یا مقصد تغییر کرده است؛ مقصد را دوباره جستجو کنید.",
  transfer_confirmation_expired: "زمان تأیید تمام شده است؛ مقصد را دوباره جستجو کنید.",
  transfer_already_confirmed: "این انتقال قبلاً بررسی شده است؛ موجودی و تراکنش‌ها را به‌روزرسانی کنید.",
  transfer_idempotency_conflict: "اطلاعات این انتقال با تلاش قبلی یکسان نیست.",
  recipient_changed: "اطلاعات مقصد تغییر کرده است؛ مقصد را دوباره جستجو کنید.",
};
function failure(res: import("express").Response, error: unknown) {
  if (error instanceof CashTransferError) res.status(error.httpStatus).json({ error: error.code, message: errors[error.code] ?? "انتقال قابل انجام نیست." });
  else res.status(500).json({ error: "cash_transfer_failed", message: "نتیجه انتقال مشخص نشد؛ تراکنش‌ها را بررسی و با همان اطلاعات دوباره تلاش کنید." });
}
router.post("/wallet/transfer-recipient", (req, res): void => {
  const source = customerPortalSession(res)?.customerId;
  if (!source) { res.status(403).json({ error: "customer_required" }); return; }
  if (typeof req.body?.mobile !== "string" || typeof req.body?.amountToman !== "string" ||
    Object.keys(req.body).some(key => !["mobile", "amountToman"].includes(key))) {
    res.status(400).json({ error: "invalid_transfer_input", message: errors.invalid_transfer_input }); return;
  }
  try { res.json(prepareCustomerCashTransfer(store, source, req.body.mobile, req.body.amountToman, customerPortalSession(res)!.mobile)); }
  catch (error) { if (!(error instanceof CashTransferError)) req.log.error({ err: error }, "customer recipient preparation failed"); failure(res, error); }
});
router.post("/wallet/transfers", (req, res): void => {
  const source = customerPortalSession(res)?.customerId;
  if (!source) { res.status(403).json({ error: "customer_required" }); return; }
  const body = req.body;
  if (!body || typeof body.recipientToken !== "string" || typeof body.amountToman !== "string" || body.confirmed !== true ||
    Object.keys(body).some(key => !["recipientToken", "amountToman", "confirmed"].includes(key))) {
    res.status(400).json({ error: "invalid_transfer_confirmation", message: errors.invalid_transfer_confirmation }); return;
  }
  try {
    res.json(confirmCustomerCashTransfer(store, source, { ...body, idempotencyKey: req.header("Idempotency-Key") ?? "" }, customerPortalSession(res)!.mobile));
  } catch (error) { if (!(error instanceof CashTransferError)) req.log.error({ err: error }, "customer cash transfer failed"); failure(res, error); }
});
export default router;

import { Router, type RequestHandler } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AuthUser } from "../lib/auth";
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { paymentRegistrationSuggestions } from "../lib/registration-suggestions";
import {
  ensurePaymentOrdersSchema, ensureReceiptDirectory, paymentReceiptRoot, normalizedDigits, normalizeIban,
  paymentCustomer, paymentOrder, paymentEvent, paymentOrderView, bankAccountView,
} from "../lib/payment-orders";
import { paymentOrderListScope } from "../lib/payment-order-scope";
import { verifyCustomerBankAccount, normalizeBankBirthDate, lookupBankAccount } from "../lib/bank-verification";
import { ensureAccountingSchema, postPaymentDocument, AccountingError } from "../lib/accounting";

ensurePaymentOrdersSchema();
ensureAccountingSchema();
const router = Router();
const now = () => new Date().toISOString();
const actor = (res: any) => res.locals.authUser as AuthUser;
const id = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const permitted = (u: AuthUser, p: string) => u.role === "admin" || u.permissions.includes(p);
const permission = (p: string): RequestHandler => (_req, res, next) => {
  if (!res.locals.authUser) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!permitted(actor(res), p)) { res.status(403).json({ error: "forbidden" }); return; }
  res.setHeader("Cache-Control", "no-store"); next();
};
const fail = (res: any, status: number, error: string) => res.status(status).json({ error });
const text = (v: unknown, max = 150) => typeof v === "string" ? v.trim().slice(0, max) : "";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 } });

router.get("/bank-accounts", permission("bank_accounts.view"), (_req, res) => {
  res.json({ items: queryRows<any>("SELECT * FROM finance_bank_accounts ORDER BY id DESC").map(bankAccountView) });
});
router.post("/bank-accounts", permission("bank_accounts.manage"), async (req, res) => {
  const bankName = text(req.body?.bankName);
  const iban = normalizeIban(req.body?.iban), ownerType = req.body?.ownerType;
  if (!iban || !bankName || !["company", "person"].includes(ownerType)) return fail(res, 400, "invalid_bank_account");
  const existing = queryRow<any>("SELECT * FROM finance_bank_accounts WHERE iban=?", [iban]);
  if (existing) return fail(res, 409, "bank_account_exists");
  let verified: Awaited<ReturnType<typeof lookupBankAccount>>;
  try {
    verified = await lookupBankAccount(iban);
  } catch (error) {
    if (error instanceof Error && error.message === "bank_account_inactive") return fail(res, 422, "bank_account_inactive");
    return fail(res, 503, "bank_verification_unavailable");
  }
  // Recheck after the network call; never trust client-supplied owner/fund names.
  const account = runTransaction(() => {
    if (queryRow("SELECT id FROM finance_bank_accounts WHERE iban=?", [iban])) return null;
    const fundName = `${bankName} ${verified.ownerName}`;
    const accountId = execute("INSERT INTO finance_bank_accounts(bank_name,owner_name,fund_name,iban,owner_type,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      [bankName, verified.ownerName, fundName, iban, ownerType, actor(res).id, now()]);
    return queryRow("SELECT * FROM finance_bank_accounts WHERE id=?", [accountId]);
  });
  return account ? res.status(201).json(bankAccountView(account)) : fail(res, 409, "bank_account_exists");
});
router.get("/customers/:id/bank-accounts", permission("payment_orders.view"), (req, res) => {
  const c = paymentCustomer(id(req.params.id), actor(res));
  if (!c) return fail(res, 404, "customer_not_found");
  return res.json({ items: queryRows<any>("SELECT * FROM customer_bank_accounts WHERE customer_id=? AND verified_national_code=? ORDER BY id DESC", [c.id, c.national_code || ""]).map(bankAccountView) });
});
router.post("/customers/:id/bank-accounts/verify", permission("payment_orders.sales_approve"), async (req, res) => {
  const u = actor(res), c = paymentCustomer(id(req.params.id), u);
  if (!c) return fail(res, 404, "customer_not_found");
  if (u.role !== "admin" && (u.salespersonId === null || u.salespersonId !== c.payment_scope_salesperson_id)) return fail(res, 403, "assigned_salesperson_required");
  const nationalCode = normalizedDigits(c.national_code);
  const birthDate = normalizeBankBirthDate(c.birth_date_jalali);
  if (!birthDate) return fail(res, 422, "customer_birth_date_required");
  const iban = req.body?.iban ? normalizeIban(req.body.iban) : undefined;
  const cardNumber = req.body?.cardNumber ? normalizedDigits(req.body.cardNumber).replace(/\s/g, "") : undefined;
  if (!/^\d{10}$/.test(nationalCode) || (!!iban === !!cardNumber) || (req.body?.iban && !iban) || (cardNumber && !/^\d{16}$/.test(cardNumber))) return fail(res, 400, "invalid_verification_request");
  try {
    const verified = await verifyCustomerBankAccount({ nationalCode, birthDate, iban: iban || undefined, cardNumber });
    // The provider adapter must return authoritative ownership proof, not a name match.
    if (!normalizeIban(verified.iban) || !verified.providerReference || !verified.ownerName || !verified.bankName) return fail(res, 502, "invalid_bank_verification_response");
    const current = paymentCustomer(c.id, u);
    if (!current || normalizedDigits(current.national_code) !== nationalCode
      || normalizeBankBirthDate(current.birth_date_jalali) !== birthDate) return fail(res, 409, "customer_changed_during_verification");
    const account = runTransaction(() => {
      execute(`INSERT INTO customer_bank_accounts(customer_id,iban,bank_name,owner_name,verified_national_code,provider_reference,verified_at,created_by)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(customer_id,iban) DO UPDATE SET bank_name=excluded.bank_name,owner_name=excluded.owner_name,
        verified_national_code=excluded.verified_national_code,provider_reference=excluded.provider_reference,verified_at=excluded.verified_at`,
      [c.id, verified.iban, verified.bankName, verified.ownerName, nationalCode, verified.providerReference, now(), u.id]);
      return queryRow("SELECT * FROM customer_bank_accounts WHERE customer_id=? AND iban=?", [c.id, verified.iban]);
    });
    return res.json(bankAccountView(account));
  } catch (error) {
    if (error instanceof Error && error.message === "bank_ownership_mismatch") return fail(res, 422, "bank_ownership_mismatch");
    return fail(res, 503, "bank_verification_unavailable");
  }
});
router.get("/payment-orders/suggestions",permission("payment_orders.view"),permission("payment_orders.create"),(req,res)=>{
  try { return res.json(paymentRegistrationSuggestions(crmDb,actor(res),req.query)); }
  catch(error) {
    if(error instanceof Error && error.message==="invalid_suggestion_page") return fail(res,400,error.message);
    throw error;
  }
});
router.get("/payment-orders", permission("payment_orders.view"), (req, res) => {
  const u = actor(res), stage = text(req.query.stage, 30), search = text(req.query.q, 100);
  if (stage && !["sales_approval", "admin_approval", "awaiting_payment", "paid"].includes(stage)) return fail(res, 400, "invalid_stage");
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1)), limit = 25;
  const scope = paymentOrderListScope(u);
  const args: any[] = [...scope.params];
  let where = " WHERE 1=1" + scope.sql;
  if (req.query.mine === "1") {
    const actionable: string[] = [];
    if (permitted(u, "payment_orders.sales_approve") && u.salespersonId !== null) {
      actionable.push("o.stage='sales_approval'");
    }
    // Match the mutation authorization: admin approval cannot be delegated by permission alone.
    if (u.role === "admin") actionable.push("o.stage='admin_approval'");
    if (permitted(u, "payment_orders.pay")) actionable.push("o.stage='awaiting_payment'");
    where += ` AND (${actionable.length ? actionable.join(" OR ") : "0=1"})`;
  }
  if (stage) { where += " AND o.stage=?"; args.push(stage); }
  if (search) { where += " AND (crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR CAST(o.id AS TEXT)=?)"; args.push(`%${search}%`, search); }
  const rows = queryRows<any>(`SELECT o.*,c.name customer_name,current_salesperson.name customer_salesperson_name
    FROM customer_payment_orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN customers current_customer ON current_customer.id=COALESCE(c.merged_into_customer_id,c.id) AND current_customer.merged_into_customer_id IS NULL
    LEFT JOIN salespersons current_salesperson ON current_salesperson.id=current_customer.salesperson_id
    ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]);
  return res.json({ items: rows.map(r => paymentOrderView(r)), page, limit, total: queryRow<any>(`SELECT COUNT(*) total FROM customer_payment_orders o JOIN customers c ON c.id=o.customer_id${where}`, args)?.total ?? 0 });
});
router.post("/payment-orders", permission("payment_orders.create"), (req, res) => {
  const u = actor(res), purchaseId = id(req.body?.purchaseId);
  const purchase = queryRow<any>("SELECT * FROM goods_purchases WHERE id=?", [purchaseId]);
  if (!purchase || !paymentCustomer(purchase.customer_id, u)) return fail(res, 404, "purchase_not_found");
  if (purchase.stage !== "completed") return fail(res, 409, "purchase_not_completed");
  if (!/^[1-9]\d*$/.test(String(purchase.payout_amount_toman))) return fail(res, 409, "invalid_purchase_payout");
  const orderId = runTransaction(() => {
    const previous = queryRow<any>("SELECT id FROM customer_payment_orders WHERE purchase_id=?", [purchaseId]);
    if (previous) return previous.id;
    const n = now();
    const inserted = execute("INSERT INTO customer_payment_orders(purchase_id,customer_id,salesperson_id,amount_toman,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      [purchaseId, purchase.customer_id, purchase.salesperson_id, purchase.payout_amount_toman, u.id, n, n]);
    paymentEvent(inserted, "created", u.id); return inserted;
  });
  return res.json(paymentOrderView(paymentOrder(orderId, u), true));
});
router.get("/payment-orders/:id", permission("payment_orders.view"), (req, res) => {
  const order = paymentOrder(id(req.params.id), actor(res));
  return order ? res.json(paymentOrderView(order, true)) : fail(res, 404, "payment_order_not_found");
});
router.post("/payment-orders/:id/sales-approve", permission("payment_orders.sales_approve"), (req, res) => {
  const u = actor(res), order = paymentOrder(id(req.params.id), u);
  if (!order) return fail(res, 404, "payment_order_not_found");
  const c = paymentCustomer(order.customer_id, u);
  if (!c) return fail(res, 404, "payment_order_not_found");
  if (u.salespersonId === null || u.salespersonId !== c.payment_scope_salesperson_id) return fail(res, 403, "assigned_salesperson_required");
  const account = queryRow<any>("SELECT * FROM customer_bank_accounts WHERE id=? AND customer_id=? AND verified_national_code=?",
    [id(req.body?.customerBankAccountId), order.customer_id, c.national_code || ""]);
  if (!account) return fail(res, 422, "verified_customer_bank_account_required");
  if (order.stage !== "sales_approval") {
    return order.customer_bank_account_id === account.id ? res.json(paymentOrderView(order, true)) : fail(res, 409, "wrong_payment_stage");
  }
  runTransaction(() => {
    if (executeChanges(`UPDATE customer_payment_orders SET stage='admin_approval',customer_bank_account_id=?,destination_iban=?,
      destination_owner_name=?,verified_national_code=?,sales_approved_by=?,updated_at=? WHERE id=? AND stage='sales_approval'`,
    [account.id, account.iban, account.owner_name, account.verified_national_code, u.id, now(), order.id]) !== 1) throw new Error("payment_stage_changed");
    paymentEvent(order.id, "sales_approved", u.id);
  });
  return res.json(paymentOrderView(paymentOrder(order.id, u), true));
});
router.post("/payment-orders/:id/admin-approve", permission("payment_orders.admin_approve"), (req, res) => {
  const u = actor(res);
  if (u.role !== "admin") return fail(res, 403, "admin_required");
  const order = paymentOrder(id(req.params.id), u);
  if (!order) return fail(res, 404, "payment_order_not_found");
  if (["awaiting_payment", "paid"].includes(order.stage)) return res.json(paymentOrderView(order, true));
  if (order.stage !== "admin_approval") return fail(res, 409, "wrong_payment_stage");
  runTransaction(() => {
    executeChanges("UPDATE customer_payment_orders SET stage='awaiting_payment',admin_approved_by=?,updated_at=? WHERE id=? AND stage='admin_approval'", [u.id, now(), order.id]);
    paymentEvent(order.id, "admin_approved", u.id);
  });
  return res.json(paymentOrderView(paymentOrder(order.id, u), true));
});
const receiveReceipt: RequestHandler = (req, res, next) => upload.single("receipt")(req, res, err => {
  if (err) { fail(res, 400, "invalid_receipt_upload"); return; } next();
});
router.post("/payment-orders/:id/pay", permission("payment_orders.pay"), receiveReceipt, (req, res) => {
  const u = actor(res), order = paymentOrder(id(req.params.id), u);
  if (!order) return fail(res, 404, "payment_order_not_found");
  const sourceId = id(req.body?.sourceBankAccountId), tracking = text(req.body?.trackingNumber, 100);
  const dateInput = String(req.body?.paidAt ?? ""), date = new Date(dateInput);
  const file = req.file;
  const mime = file?.buffer.subarray(0, 5).toString() === "%PDF-" ? "application/pdf"
    : file?.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : file?.buffer[0] === 255 && file?.buffer[1] === 216 && file?.buffer[2] === 255 ? "image/jpeg" : null;
  if (!file || !mime || !tracking || !Number.isFinite(date.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(dateInput) || date.getTime() > Date.now() + 300000
    || !queryRow("SELECT id FROM finance_bank_accounts WHERE id=?", [sourceId])) return fail(res, 400, "invalid_payment_evidence");
  const hash = createHash("sha256").update(file.buffer).digest("hex");
  if (order.stage === "paid") {
    return order.source_bank_account_id === sourceId && order.tracking_number === tracking && order.paid_at === date.toISOString() && order.receipt_sha256 === hash
      ? res.json(paymentOrderView(order, true)) : fail(res, 409, "payment_already_recorded");
  }
  if (order.stage !== "awaiting_payment") return fail(res, 409, "wrong_payment_stage");
  if (queryRow("SELECT id FROM customer_payment_orders WHERE source_bank_account_id=? AND tracking_number=? AND stage='paid'", [sourceId, tracking])) return fail(res, 409, "payment_reference_already_used");
  const currentCustomer = paymentCustomer(order.customer_id, u);
  if (!currentCustomer || currentCustomer.national_code !== order.verified_national_code) return fail(res, 409, "customer_identity_changed");
  ensureReceiptDirectory();
  const name = `${randomUUID()}.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}`;
  const destination = path.join(paymentReceiptRoot, name);
  fs.writeFileSync(destination, file.buffer, { mode: 0o600, flag: "wx" });
  try {
    runTransaction(() => {
      postPaymentDocument(order,u.id,sourceId,date.toISOString(),{name,mime,sha256:hash,size:file.size});
      if (executeChanges(`UPDATE customer_payment_orders SET stage='paid',source_bank_account_id=?,tracking_number=?,paid_at=?,
        receipt_filename=?,receipt_mime=?,receipt_sha256=?,paid_by=?,updated_at=? WHERE id=? AND stage='awaiting_payment'`,
      [sourceId, tracking, date.toISOString(), name, mime, hash, u.id, now(), order.id]) !== 1) throw new Error("payment_stage_changed");
      paymentEvent(order.id, "payment_recorded", u.id);
    });
  } catch(error) {
    fs.unlinkSync(destination);
    if (error instanceof AccountingError) return fail(res,error.status,error.message);
    return fail(res, 409, "payment_recording_conflict");
  }
  return res.json(paymentOrderView(paymentOrder(order.id, u), true));
});
router.get("/payment-orders/:id/receipt", permission("payment_orders.view"), (req, res) => {
  const order = paymentOrder(id(req.params.id), actor(res));
  if (!order?.receipt_filename || path.basename(order.receipt_filename) !== order.receipt_filename) return fail(res, 404, "receipt_not_found");
  const filePath = path.join(paymentReceiptRoot, order.receipt_filename);
  if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) return fail(res, 404, "receipt_not_found");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  res.setHeader("Content-Type", order.receipt_mime);
  res.setHeader("Content-Disposition", `inline; filename="payment-${order.id}.${path.extname(filePath).slice(1)}"`);
  return res.sendFile(filePath);
});
export default router;
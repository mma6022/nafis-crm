import { Router, type RequestHandler } from "express";
import { conditionAcceptsCreditRank } from "../lib/credit-rank-eligibility";
import { loanCreditRankOverrideError, loanCreditRankOverrideReason } from "../lib/loan-credit-rank-override";
import { logCreditRankOverride } from "../lib/credit-rank-override-log";
import { guarantorGradeAllows, guarantorGradeVerdict } from "../lib/guarantor-grade-rule";
import { customerGuarantorGrade } from "../lib/guarantor-grade-source";
import { execute, queryRow, queryRows, executeChanges, runTransaction } from "../lib/crm-db";
import { creditVerifiedCashPayment, ensureWalletSchema, getWalletSummary, getWalletSummaryReadOnly, wallet } from "../lib/wallets";
import { requireAuth } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { createHash, randomBytes } from "node:crypto";
import { getNotificationSettings, normalizeIranianMobile, sendWalletShareSms } from "../lib/customer-notifications";
import { verifyProvider, updatePaymentAttempt, verifyAndCreditWalletPayment, createWalletPaymentReceipt, readWalletPaymentReceipt, walletPaymentReceiptData } from "../lib/wallet-payment-recovery";
import { conditionDurations as planConditionDurations } from "../lib/plan-condition-durations";

ensureWalletSchema();
const router = Router();
const staffRoles = new Set(["admin", "salesperson", "registrar"]);
const user = (res: any) => res.locals.authUser as AuthUser;
const updatedAt = () => new Date().toISOString();
const shareHash = (token: string) => createHash("sha256").update(token).digest("hex");
const shareToken = (value: unknown) => typeof value === "string" && /^(?:[A-Za-z0-9_-]{40,100}|~[A-Za-z0-9_-]{14})$/.test(value) ? value : null;
type SharePaymentStatus = "pending" | "processing" | "credited" | "cancelled" | "failed" | "verification_pending" | "requires_reconciliation" | "expired";
type ShareHistoryRow = {
  id: number;
  amount_toman: string;
  plan_id: number | null;
  plan_name: string | null;
  created_at: string;
  expires_at: string;
  sms_status: string | null;
  share_status: string;
  payment_intent_id: number | null;
  intent_status: string | null;
  attempt_status: string | null;
  intent_amount_toman: string | null;
  wallet_id: number | null;
  verified_at: string | null;
  ledger_wallet_id: number | null;
  ledger_amount: string | null;
  ledger_kind: string | null;
};
function sharePaymentState(share: ShareHistoryRow, now = Date.now()): { paymentStatus: SharePaymentStatus; isActive: boolean } {
  const actuallyPosted = share.intent_status === "credited"
    && share.verified_at !== null
    && share.ledger_wallet_id === share.wallet_id
    && share.ledger_amount === share.intent_amount_toman
    && share.ledger_kind === "cash_payment";
  if (actuallyPosted) return { paymentStatus: "credited", isActive: false };
  if (share.attempt_status === "requires_reconciliation" || share.intent_status === "provider_already_verified"
    || share.intent_status === "credited") {
    return { paymentStatus: "requires_reconciliation", isActive: true };
  }
  if (share.attempt_status === "verification_pending") return { paymentStatus: "verification_pending", isActive: true };
  if (share.intent_status === "cancelled" || share.attempt_status === "cancelled") return { paymentStatus: "cancelled", isActive: false };
  if (share.intent_status === "failed" || share.attempt_status === "failed" || (share.share_status === "failed" && share.payment_intent_id === null)) {
    return { paymentStatus: "failed", isActive: false };
  }
  const unresolvedPayment = share.payment_intent_id !== null
    || ["starting", "started"].includes(share.share_status)
    || ["requested", "gateway_ready"].includes(share.attempt_status ?? "");
  if (unresolvedPayment) return { paymentStatus: "processing", isActive: true };
  if (new Date(share.expires_at).getTime() <= now) return { paymentStatus: "expired", isActive: false };
  return { paymentStatus: "pending", isActive: true };
}
function customerShareHistory(customerId: number): ShareHistoryRow[] {
  return queryRows<ShareHistoryRow>(
    `SELECT s.id,s.amount_toman,s.plan_id,p.name plan_name,s.created_at,s.expires_at,
       s.sms_status,s.status share_status,s.payment_intent_id,i.status intent_status,
       a.status attempt_status,i.amount_toman intent_amount_toman,i.wallet_id,i.verified_at,
       l.wallet_id ledger_wallet_id,l.amount ledger_amount,l.kind ledger_kind
     FROM wallet_share_links s
     LEFT JOIN loan_plans p ON p.id=s.plan_id
     LEFT JOIN wallet_payment_intents i ON i.id=s.payment_intent_id
     LEFT JOIN wallet_payment_attempts a ON a.payment_intent_id=i.id
     LEFT JOIN wallet_ledger_v2 l ON l.idempotency_key=('cash-payment:' || i.id)
     WHERE s.customer_id=? ORDER BY s.id DESC`,
    [customerId],
  );
}
function paymentBase(): URL | null {
  try {
    const base = new URL(String(process.env.PAYMENT_CALLBACK_BASE_URL));
    if (base.protocol !== "https:" || base.search || base.hash || (base.pathname !== "/" && base.pathname !== "")) return null;
    return base;
  } catch { return null; }
}
const adminOnly: RequestHandler = (_req, res, next): void => {
  if (user(res).role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
  next();
};
const scopedCustomer: RequestHandler = (req, res, next): void => {
  const u = user(res);
  const id = Number(req.params.customerId);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_customer_id" }); return; }
  if (!staffRoles.has(u.role) || !u.permissions.includes("customers.view")) { res.status(403).json({ error: "Forbidden" }); return; }
  const customer = queryRow<{ id: number; salesperson_id: number | null }>("SELECT id,salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  if (u.customerScope === "assigned" && customer.salesperson_id !== u.salespersonId) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
};

router.get("/customers/:customerId/wallet", requireAuth, requirePermission("customers.view"), scopedCustomer, (req, res): void => {
  const customerId = Number(req.params.customerId);
  const archivedSources = queryRows<{ source_customer_id: number }>(
    "SELECT source_customer_id FROM customer_merge_audit WHERE survivor_customer_id=? ORDER BY created_at DESC,id DESC",
    [customerId],
  ).map((row) => ({
    sourceCustomerId: Number(row.source_customer_id),
    ...getWalletSummaryReadOnly(Number(row.source_customer_id)),
    goodsPurchases: queryRows(
      `SELECT id,plan_id AS planId,stage,credit_amount_toman AS creditAmountToman,
        principal_amount_toman AS principalAmountToman,payout_amount_toman AS payoutAmountToman,
        created_at AS createdAt,completed_at AS completedAt
       FROM goods_purchases WHERE customer_id=? ORDER BY id DESC LIMIT 100`,
      [Number(row.source_customer_id)],
    ),
    loanFilingFeeCharges: queryRows(
      `SELECT id,plan_id AS planId,amount_toman AS amountToman,application_id AS applicationId,created_at AS createdAt
       FROM loan_filing_fee_charges WHERE customer_id=? ORDER BY id DESC LIMIT 100`,
      [Number(row.source_customer_id)],
    ),
  }));
  res.json({
    customerId,
    ...getWalletSummary(customerId),
    archivedSourceWallets: archivedSources,
  });
});

router.get("/customers/:customerId/wallet/payments/:paymentId", requireAuth, requirePermission("customers.view"), scopedCustomer, (req, res): void => {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) { res.status(400).json({ error: "invalid_payment_id" }); return; }
  const intent = queryRow<{ id: number; amount_toman: string; status: string; verified_at: string | null }>(
    "SELECT id,amount_toman,status,verified_at FROM wallet_payment_intents WHERE id=? AND customer_id=?",
    [paymentId, Number(req.params.customerId)],
  );
  if (!intent) { res.status(404).json({ error: "payment_not_found" }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ id: intent.id, amountToman: intent.amount_toman, status: intent.status, verifiedAt: intent.verified_at });
});

router.get("/customers/:customerId/wallet/payment-reconciliation", requireAuth, adminOnly, scopedCustomer, (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const items = queryRows<{ id: number; amount_toman: string; amount_rial: string; authority: string; status: string; provider_ref_id: string | null; created_at: string; verified_at: string | null; attempt_status: string | null }>(
    `SELECT i.id,i.amount_toman,i.amount_rial,i.authority,i.status,i.provider_ref_id,i.created_at,i.verified_at,a.status attempt_status
     FROM wallet_payment_intents i LEFT JOIN wallet_payment_attempts a ON a.payment_intent_id=i.id
     WHERE i.customer_id=? ORDER BY i.id DESC LIMIT 50`, [Number(req.params.customerId)]);
  res.json({ items: items.map(i => ({ id: i.id, amountToman: i.amount_toman, amountRial: i.amount_rial, authority: i.authority, status: i.status, providerRefId: i.provider_ref_id, createdAt: i.created_at, verifiedAt: i.verified_at, attemptStatus: i.attempt_status })) });
});

router.post("/customers/:customerId/wallet/payments/:paymentId/reconcile", requireAuth, adminOnly, scopedCustomer, async (req, res): Promise<void> => {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) { res.status(400).json({ error: "invalid_payment_id" }); return; }
  const intent = queryRow<{ id: number; authority: string; amount_rial: string; status: string; provider_ref_id: string | null }>(
    "SELECT id,authority,amount_rial,status,provider_ref_id FROM wallet_payment_intents WHERE id=? AND customer_id=?",
    [paymentId, Number(req.params.customerId)]);
  if (!intent) { res.status(404).json({ error: "payment_not_found" }); return; }
  res.setHeader("Cache-Control", "no-store");
  if (intent.status === "credited") { res.json({ status: "already_credited", providerRefId: intent.provider_ref_id }); return; }
  let proof: { code: number; refId: string | null };
  try { proof = await verifyProvider(intent.authority, intent.amount_rial); }
  catch (error) {
    req.log.warn({ err: error, paymentId }, "Payment reconciliation provider check failed");
    res.status(503).json({ error: "provider_verification_unavailable" }); return;
  }
  if (![100, 101].includes(proof.code) || !proof.refId) {
    req.log.warn({ paymentId, providerCode: proof.code }, "Payment reconciliation requires provider receipt");
    res.status(409).json({ error: "provider_payment_not_proven", providerCode: proof.code }); return;
  }
  try {
    const status = creditVerifiedCashPayment(intent.id, proof.refId, user(res).id);
    req.log.info({ paymentId, actorId: user(res).id, status, providerRefId: proof.refId }, "Payment reconciled");
    res.json({ status, providerRefId: proof.refId });
  } catch (error) {
    req.log.error({ err: error, paymentId }, "Payment reconciliation rejected");
    res.status(409).json({ error: error instanceof Error ? error.message : "reconciliation_failed" });
  }
});

router.post("/customers/:customerId/wallet/cash-payment", requireAuth, requirePermission("customers.view"), scopedCustomer, async (req, res): Promise<void> => {
  const amount = String(req.body?.amountToman ?? "");
  if (!/^(0|[1-9]\d*)$/.test(amount) || BigInt(amount) <= 0n) { res.status(400).json({ error: "invalid_amount_toman" }); return; }
  const customerId = Number(req.params.customerId);
  const idempotencyKey = String(req.header("Idempotency-Key") || "");
  if (!/^[\x20-\x7e]{8,200}$/.test(idempotencyKey)) { res.status(400).json({ error: "Idempotency-Key is required" }); return; }
  const old = queryRow<{ customer_id: number; amount_toman: string; status: string; authority: string | null; intent_status: string | null }>(
    `SELECT a.customer_id,a.amount_toman,a.status,i.authority,i.status intent_status FROM wallet_payment_attempts a
     LEFT JOIN wallet_payment_intents i ON i.id=a.payment_intent_id WHERE a.idempotency_key=?`, [idempotencyKey]);
  if (old) {
    if (old.customer_id !== customerId || old.amount_toman !== amount || old.status !== "gateway_ready" || old.intent_status !== "created" || !old.authority) { res.status(409).json({ error: "payment_idempotency_conflict" }); return; }
    res.json({ paymentUrl: `https://www.zarinpal.com/pg/StartPay/${old.authority}`, authority: old.authority }); return;
  }
  const attemptId = execute(
    "INSERT INTO wallet_payment_attempts(customer_id,initiated_by_user_id,amount_toman,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    [customerId, user(res).id, amount, idempotencyKey, "requested", updatedAt(), updatedAt()],
  );
  const failAttempt = (code: string) => {
    executeChanges("UPDATE wallet_payment_attempts SET status='failed',error_code=?,updated_at=? WHERE id=?", [code, updatedAt(), attemptId]);
  };
  const merchant = process.env.ZARINPAL_MERCHANT_ID;
  const callback = process.env.PAYMENT_CALLBACK_BASE_URL;
  if (!merchant || !callback || !/^https:\/\//i.test(callback)) { failAttempt("configuration_unavailable"); res.status(503).json({ error: "Zarinpal payment configuration is unavailable" }); return; }
  const rial = (BigInt(amount) * 10n).toString();
  // The provider's JSON contract uses a number. Refuse values which cannot be
  // represented exactly rather than silently rounding a financial amount.
  if (BigInt(rial) > BigInt(Number.MAX_SAFE_INTEGER)) { failAttempt("amount_too_large"); res.status(400).json({ error: "amount_too_large" }); return; }
  let response: Response;
  try {
    response = await fetch("https://payment.zarinpal.com/pg/v4/payment/request.json", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ merchant_id: merchant, amount: Number(rial), currency: "IRR", description: `Cash wallet payment for customer ${customerId}`, callback_url: `${callback.replace(/\/$/, "")}/api/wallet/zarinpal/callback` }), signal: AbortSignal.timeout(8000) });
  } catch { failAttempt("gateway_unavailable"); res.status(503).json({ error: "Zarinpal request failed" }); return; }
  if (!response.ok) { failAttempt("gateway_http_error"); res.status(503).json({ error: "Zarinpal request failed" }); return; }
  let payload: any;
  try { payload = await response.json(); } catch { failAttempt("gateway_invalid_response"); res.status(503).json({ error: "Invalid Zarinpal response" }); return; }
  const authority = payload?.data?.authority;
  if (payload?.data?.code !== 100 || typeof authority !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(authority)) { failAttempt("gateway_rejected"); res.status(503).json({ error: "Zarinpal rejected payment request", code: payload?.data?.code ?? payload?.errors?.code }); return; }
  runTransaction(() => {
    const target = wallet(customerId, "cash");
    const intentId = execute("INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)", [customerId, target.id, amount, rial, authority, "created", idempotencyKey, updatedAt()]);
    executeChanges("UPDATE wallet_payment_attempts SET payment_intent_id=?,status='gateway_ready',updated_at=? WHERE id=?", [intentId, updatedAt(), attemptId]);
  });
  res.json({ paymentUrl: `https://www.zarinpal.com/pg/StartPay/${authority}`, authority });
});

// Public top-up links are opaque bearer credentials. Only their SHA-256 digest
// is stored, and every public request must repeat the immutable URL contract.
router.get("/customers/:customerId/wallet/share-links", requireAuth, requirePermission("customers.view"), scopedCustomer, (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const items = customerShareHistory(Number(req.params.customerId)).map((share) => {
    const state = sharePaymentState(share);
    return {
      id: share.id,
      amountToman: share.amount_toman,
      planId: share.plan_id,
      planName: share.plan_name,
      createdAt: share.created_at,
      expiresAt: share.expires_at,
      smsStatus: ["sending", "sent", "delivery_unknown"].includes(share.sms_status ?? "")
        ? share.sms_status
        : "not_sent",
      ...state,
    };
  });
  res.json({ items });
});

router.post("/customers/:customerId/wallet/share-links", requireAuth, requirePermission("customers.view"), scopedCustomer, (req, res): void => {
  const customerId = Number(req.params.customerId);
  const overrideError = loanCreditRankOverrideError(req.body?.ignoreCreditRank, user(res).role, false, req.body?.creditRankOverrideReason);
  if (overrideError) { res.status(overrideError.status).json({ error: overrideError.code }); return; }
  const ignoreCreditRank = req.body?.ignoreCreditRank === true;
  const overrideReason = ignoreCreditRank ? loanCreditRankOverrideReason(req.body?.creditRankOverrideReason) : null;
  const customer = queryRow<any>("SELECT id,name,national_code,phone,birth_date_jalali,verification_status FROM customers WHERE id=?", [customerId]);
  if (req.body?.confirmActiveRequest !== true && customerShareHistory(customerId).some((share) => sharePaymentState(share).isActive)) {
    res.status(409).json({ error: "active_share_link_exists" }); return;
  }
  const amountInput = req.body?.amountToman;
  const planInput = req.body?.planId;
  let amount: string;
  let planId: number | null = null;
  if (planInput !== undefined) {
    planId = Number(planInput);
    if (!Number.isSafeInteger(planId) || planId <= 0) { res.status(400).json({ error: "invalid_plan_id" }); return; }
    const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=? AND active=1 AND COALESCE(contract_template_id,primary_contract_template_id) IS NOT NULL", [planId]);
    const credit = queryRow<any>("SELECT score_label FROM customer_credit_checks WHERE customer_id=? AND status='report_generated' AND completed_at>=? ORDER BY completed_at DESC,id DESC LIMIT 1", [customerId, new Date(Date.now() - 86400000).toISOString()]);
    const conditions = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=?", [planId]);
    const guarantorRank = ignoreCreditRank ? null : customerGuarantorGrade(customerId).rank;
    const eligible = conditions.some((condition) => {
      let ranks: string[] = [];
      try { const parsed = JSON.parse(String(condition.customer_ranks ?? "[]")); ranks = Array.isArray(parsed) ? parsed.map(String) : []; } catch { ranks = String(condition.customer_ranks ?? "").split(/[,،]/).map((v) => v.trim()).filter(Boolean); }
      const conditionMaximum = BigInt(String(condition.max_principal ?? "0").replace(/\D/g, "") || "0");
      const planMaximum = BigInt(String(plan?.principal_amount ?? "0").replace(/\D/g, "") || "0");
      const maximum = ignoreCreditRank ? planMaximum : conditionMaximum === 0n ? planMaximum : planMaximum === 0n ? conditionMaximum : conditionMaximum < planMaximum ? conditionMaximum : planMaximum;
      let durations: unknown[] = [];
      try {
        const conditionDurations = JSON.parse(String(condition.installment_options ?? "[]"));
        const planTerms: unknown = JSON.parse(String(plan?.installment_terms ?? "[]"));
        // PLANS-49: only options the plan has a term for count (all invalid → not eligible, no fallback to the plan terms)
        durations = Array.isArray(conditionDurations) && conditionDurations.length ? planConditionDurations(conditionDurations, planTerms) : planTerms as unknown[];
      } catch { durations = []; }
      const validDurations = durations.map((d: any) => typeof d === "object" && d !== null ? Number(d.installments) : Number(d)).some((d) => Number.isInteger(d) && d > 0);
      return (ignoreCreditRank || (conditionAcceptsCreditRank(credit?.score_label, ranks)
        && guarantorGradeAllows(guarantorGradeVerdict(condition, guarantorRank, plan)))) && maximum > 0n && Array.isArray(durations) && validDurations;
    });
    if (!plan || !customer || !customer.national_code || !customer.phone || !customer.birth_date_jalali || customer.verification_status !== "verified" || (!ignoreCreditRank && !credit) || !eligible) { res.status(422).json({ error: "plan_not_eligible" }); return; }
    const cash = wallet(customerId, "cash").balance;
    const fee = String(plan.filing_fee_toman ?? "");
    if (!/^\d+$/.test(fee) || !/^\d+$/.test(cash) || BigInt(fee) <= BigInt(cash)) { res.status(422).json({ error: "no_positive_shortfall" }); return; }
    amount = (BigInt(fee) - BigInt(cash)).toString();
  } else {
    amount = String(amountInput ?? "");
    if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) { res.status(400).json({ error: "invalid_amount_toman" }); return; }
  }
  const callbackBase = paymentBase();
  if (!callbackBase) { res.status(503).json({ error: "payment_configuration_unavailable" }); return; }
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  execute("INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,plan_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
    [shareHash(token), customerId, amount, planId, "created", expires, updatedAt()]);
  if (overrideReason && planId !== null)
    logCreditRankOverride({ action: "wallet_share_link", actor: user(res), customerId, planId, reason: overrideReason });
  const query = new URLSearchParams({ token, customerId: String(customerId), amountToman: amount });
  if (planId !== null) query.set("planId", String(planId));
  res.json({ url: `${callbackBase.origin}/wallet/top-up?${query}`, amountToman: amount, customerName: customer.name });
});

router.post("/customers/:customerId/wallet/share-links/:token/send-sms", requireAuth, requirePermission("customers.view"), scopedCustomer, async (req, res): Promise<void> => {
  const customerId = Number(req.params.customerId);
  const token = shareToken(req.params.token);
  if (!token) { res.status(400).json({ error: "invalid_share_token" }); return; }
  const share = queryRow<any>(
    "SELECT id,customer_id,amount_toman,plan_id,expires_at,sms_status FROM wallet_share_links WHERE token_hash=? AND customer_id=?",
    [shareHash(token), customerId],
  );
  if (!share) { res.status(404).json({ error: "share_link_not_found" }); return; }
  if (new Date(share.expires_at).getTime() <= Date.now()) { res.status(404).json({ error: "share_link_expired" }); return; }
  const callbackBase = paymentBase();
  const customer = queryRow<{ id: number; name: string; phone: string }>("SELECT id,name,phone FROM customers WHERE id=?", [customerId]);
  let settings;
  try { settings = getNotificationSettings(); } catch { res.status(503).json({ error: "sms_configuration_unavailable" }); return; }
  // Validate all local/configuration conditions before creating the once-only claim.
  if (!callbackBase || !customer || !settings.ippanelEnabled || !process.env.IR_RELAY_SHARED_SECRET) {
    res.status(503).json({ error: "sms_configuration_unavailable" }); return;
  }
  // Approved IPPanel pattern accepts at most 40 characters for its link.
  // An 80-bit opaque alias stays bound to the same existing share and expiry.
  const smsToken = `~${randomBytes(10).toString("base64url")}`;
  const link = new URL(`/${smsToken}`, callbackBase.origin);
  if (link.toString().length > 40) { res.status(503).json({ error: "sms_link_too_long" }); return; }
  // Invalid phone is deterministic and should not consume the once-only claim.
  if (!normalizeIranianMobile(String(customer.phone))) {
    res.status(400).json({ error: "invalid_phone" }); return;
  }
  const claim = randomBytes(16).toString("hex");
  if (executeChanges("UPDATE wallet_share_links SET sms_status='sending',sms_claim=?,sms_token_hash=? WHERE id=? AND sms_status IS NULL", [claim, shareHash(smsToken), share.id]) !== 1) {
    const current = queryRow<{ sms_status: string | null }>("SELECT sms_status FROM wallet_share_links WHERE id=?", [share.id]);
    if (current?.sms_status === "sent") { res.status(409).json({ error: "already_sent" }); return; }
    if (current?.sms_status === "sending") { res.status(409).json({ error: "sending" }); return; }
    res.status(409).json({ error: "delivery_unknown" }); return;
  }
  try {
    const messageId = await sendWalletShareSms(customer, link.toString(), settings);
    executeChanges("UPDATE wallet_share_links SET sms_status='sent',sms_claim=NULL,sms_message_id=? WHERE id=? AND sms_claim=?", [messageId, share.id, claim]);
    res.json({ status: "sent" });
  } catch (error) {
    if (error instanceof Error && error.message === "sms_provider_rejected") {
      executeChanges("UPDATE wallet_share_links SET sms_status=NULL,sms_claim=NULL WHERE id=? AND sms_claim=?", [share.id, claim]);
      res.status(503).json({ error: "sms_provider_rejected" }); return;
    }
    executeChanges("UPDATE wallet_share_links SET sms_status='delivery_unknown' WHERE id=? AND sms_claim=?", [share.id, claim]);
    res.status(503).json({ error: "delivery_unknown" });
  }
});

function findShare(req: any, res: any, allowExpiredCompleted = false): any | null {
  const token = shareToken(req.params.token);
  if (!token) { res.status(400).json({ error: "invalid_share_token" }); return null; }
  const share = queryRow<any>(`SELECT s.*,c.name customer_name,c.merged_into_customer_id,p.name plan_name,a.status attempt_status
    FROM wallet_share_links s JOIN customers c ON c.id=s.customer_id
    LEFT JOIN wallet_payment_attempts a ON a.payment_intent_id=s.payment_intent_id
    LEFT JOIN loan_plans p ON p.id=s.plan_id WHERE s.token_hash=? OR s.sms_token_hash=?`, [shareHash(token), shareHash(token)]);
  if (!share) { res.status(404).json({ error: "share_link_not_found" }); return null; }
  if (share.merged_into_customer_id != null && !allowExpiredCompleted) { res.status(404).json({ error: "share_link_not_found" }); return null; }
  const linked = share.payment_intent_id ? queryRow<any>("SELECT status FROM wallet_payment_intents WHERE id=?", [share.payment_intent_id]) : null;
  if (new Date(share.expires_at).getTime() <= Date.now() && !(allowExpiredCompleted && linked)) { res.status(404).json({ error: "share_link_expired" }); return null; }
  const q = req.query;
  if ((!token.startsWith("~") || q.customerId !== undefined || q.amountToman !== undefined || q.planId !== undefined)
    && (String(q.customerId ?? "") !== String(share.customer_id) || String(q.amountToman ?? "") !== share.amount_toman
    || (share.plan_id === null ? q.planId !== undefined : String(q.planId ?? "") !== String(share.plan_id)))) {
    res.status(400).json({ error: "share_link_query_mismatch" }); return null;
  }
  return share;
}

router.get("/wallet/share-links/:token", (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  const share = findShare(req, res, true); if (!share) return;
  const intent = share.payment_intent_id ? queryRow<any>("SELECT status,id FROM wallet_payment_intents WHERE id=?", [share.payment_intent_id]) : null;
  const raw = share.attempt_status === "requires_reconciliation" || share.attempt_status === "verification_pending"
    ? share.attempt_status : (intent?.status ?? share.status);
  const status = raw === "credited" ? "credited" : raw === "created" ? "created" : ["cancelled"].includes(raw) ? "cancelled"
    : ["failed"].includes(raw) ? "failed" : ["provider_already_verified", "requires_reconciliation"].includes(raw) ? "reconciliation"
    : ["starting", "started", "created", "verification_pending", "pending"].includes(raw) ? "pending" : "pending";
  const result: any = { customerName: share.customer_name, amountToman: share.amount_toman, ...(share.plan_id ? { planName: share.plan_name } : {}), status };
  if (!intent && new Date(share.expires_at).getTime() <= Date.now()) result.expired = true;
  if (intent) result.paymentIntentId = intent.id;
  res.json(result);
});

router.post("/wallet/share-links/:token/start", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const share = findShare(req, res); if (!share) return;
  if (share.payment_intent_id) {
    const intent = queryRow<any>("SELECT authority,status,id FROM wallet_payment_intents WHERE id=?", [share.payment_intent_id]);
    if (intent?.status === "created" && intent.authority) { res.json({ paymentUrl: `https://www.zarinpal.com/pg/StartPay/${intent.authority}` }); return; }
    res.status(409).json({ error: "payment_not_restartable", status: intent?.status ?? "failed" }); return;
  }
  const claim = randomBytes(16).toString("hex");
  const claimExpiry = new Date(Date.now() + 120000).toISOString();
  const claimed = executeChanges("UPDATE wallet_share_links SET status='starting',start_claim=?,start_claim_expires_at=? WHERE id=? AND payment_intent_id IS NULL AND (start_claim IS NULL OR start_claim_expires_at<?)", [claim, claimExpiry, share.id, updatedAt()]);
  if (claimed !== 1) { res.status(409).json({ error: "payment_start_in_progress" }); return; }
  const merchant = process.env.ZARINPAL_MERCHANT_ID, callback = paymentBase();
  const rial = (BigInt(share.amount_toman) * 10n).toString();
  if (!merchant || !callback || BigInt(rial) > BigInt(Number.MAX_SAFE_INTEGER)) {
    executeChanges("UPDATE wallet_share_links SET status='failed',start_claim=NULL WHERE id=? AND start_claim=?", [share.id, claim]);
    res.status(503).json({ error: "payment_configuration_unavailable" }); return;
  }
  const cb = new URL(`${callback.origin}/api/wallet/zarinpal/callback`);
  let payload: any;
  try {
    const response = await fetch("https://payment.zarinpal.com/pg/v4/payment/request.json", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ merchant_id: merchant, amount: Number(rial), currency: "IRR", description: `Wallet top-up for customer ${share.customer_id}`, callback_url: cb.toString() }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("gateway_http_error");
    payload = await response.json();
  } catch { executeChanges("UPDATE wallet_share_links SET status='failed',start_claim=NULL WHERE id=? AND start_claim=?", [share.id, claim]); res.status(503).json({ error: "payment_request_failed" }); return; }
  const authority = payload?.data?.authority;
  if (payload?.data?.code !== 100 || typeof authority !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(authority)) {
    executeChanges("UPDATE wallet_share_links SET status='failed',start_claim=NULL WHERE id=? AND start_claim=?", [share.id, claim]); res.status(503).json({ error: "payment_request_rejected" }); return;
  }
  try {
    const intentId = runTransaction(() => {
      const current = queryRow<any>("SELECT payment_intent_id,start_claim FROM wallet_share_links WHERE id=?", [share.id]);
      if (!current || current.start_claim !== claim || current.payment_intent_id) throw new Error("share_claim_lost");
      const intent = execute("INSERT INTO wallet_payment_intents(customer_id,wallet_id,amount_toman,amount_rial,authority,status,idempotency_key,created_at,created_by_customer_id) VALUES(?,?,?,?,?,?,?,?,?)",
        [share.customer_id, wallet(share.customer_id, "cash").id, share.amount_toman, rial, authority, "created", `share:${share.id}`, updatedAt(), share.created_by_customer_id ?? null]);
      execute("INSERT INTO wallet_payment_attempts(customer_id,amount_toman,idempotency_key,status,created_at,updated_at,payment_intent_id,initiated_by_customer_id) VALUES(?,?,?,?,?,?,?,?)",
        [share.customer_id, share.amount_toman, `share:${share.id}`, "gateway_ready", updatedAt(), updatedAt(), intent, share.created_by_customer_id ?? null]);
      if (executeChanges("UPDATE wallet_share_links SET status='started',payment_intent_id=?,start_claim=NULL WHERE id=? AND start_claim=? AND payment_intent_id IS NULL", [intent, share.id, claim]) !== 1) throw new Error("share_claim_lost");
      return intent;
    });
    res.json({ paymentUrl: `https://www.zarinpal.com/pg/StartPay/${authority}` });
  } catch (error) {
    executeChanges("UPDATE wallet_share_links SET status='failed',start_claim=NULL WHERE id=? AND start_claim=? AND payment_intent_id IS NULL", [share.id, claim]);
    res.status(503).json({ error: error instanceof Error && error.message === "share_claim_lost" ? "payment_start_claim_lost" : "payment_persistence_failed" });
  }
});

router.get("/wallet/share-links/receipt/:receipt", (req, res): void => {
  res.setHeader("Cache-Control", "private, no-store");
  const id = readWalletPaymentReceipt(String(req.params.receipt));
  const data = id ? walletPaymentReceiptData(id) : null;
  if (!data) { res.status(404).json({ error: "invalid_or_expired_receipt" }); return; }
  res.json(data);
});

router.get("/wallet/zarinpal/callback", async (req, res): Promise<void> => {
  const authority = String(req.query.Authority || "");
  if (!authority || !/^[A-Za-z0-9_-]{1,100}$/.test(authority)) { res.status(400).send("Invalid payment authority"); return; }
  const intent = queryRow<{ id: number; customer_id: number; wallet_id: number; amount_toman: string; amount_rial: string; status: string }>("SELECT id,customer_id,wallet_id,amount_toman,amount_rial,status FROM wallet_payment_intents WHERE authority=?", [authority]);
  if (!intent) { res.status(404).send("Payment not found"); return; }
  const shared = queryRow<any>("SELECT id,customer_id,amount_toman,plan_id,token_hash FROM wallet_share_links WHERE payment_intent_id=?", [intent.id]);
  // Gateway return parameters are not payment proof and may be dropped. The
  // stored authority fixes the customer, amount and wallet. The receipt grants
  // read-only access to this payment, not to the original reusable share link.
  const receipt = shared ? createWalletPaymentReceipt(intent.id) : null;
  const returnToCustomer = () => shared
    ? res.redirect(303, `/wallet/top-up/result?receipt=${encodeURIComponent(receipt!)}`)
    : res.redirect(303, `/customers/${intent.customer_id}?paymentIntent=${intent.id}`);
  if (intent.status === "credited") { returnToCustomer(); return; }
  const outcome = await verifyAndCreditWalletPayment(intent.id);
  if (outcome === "pending" && String(req.query.Status).toUpperCase() === "NOK" &&
    queryRow<{ error_code: string }>("SELECT error_code FROM wallet_payment_attempts WHERE payment_intent_id=?", [intent.id])?.error_code === "provider_-51") {
    executeChanges("UPDATE wallet_payment_intents SET status='cancelled' WHERE id=? AND status='created'", [intent.id]);
    updatePaymentAttempt(intent.id, "cancelled");
  }
  returnToCustomer();
});

export default router;

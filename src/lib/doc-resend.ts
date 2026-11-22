/**
 * t882 «بازگشت مرحله / ارسال دوباره سند» for goods purchases and payment orders.
 * flag.doc_resend_v1 absent or ≠ '1' = OFF. Only plain admin and sales_manager (baseRole / salesManager).
 * Old goods_purchase_documents rows are never deleted or overwritten; invoices keep every signed/sent copy valid.
 * Stage-back past settlement or out of completed is refused: those steps have posted finance (ask Mohammad before reversing).
 */
import type { AuthUser } from "./auth";
import { execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { isSalesManagerUser } from "./sales-manager";
import { assertGoodsPurchaseScope, getGoodsPurchase, goodsEvent, saveGoodsInvoice } from "./goods-finance";
import { goodsDocumentHistory, generateGoodsDocument, type GoodsDocumentKind } from "./goods-documents";
import { paymentEvent, paymentOrder } from "./payment-orders";
import { revertPaidPaymentOrder } from "./payment-order-unpay";
import { cancelEmzameContract } from "./emzame-client";
import { srBotHasToken, srDeliver, srDefaultSignUrl, srKeyboard, srStartedChats } from "./bale-sign-reminder";

export const DOC_RESEND_FLAG = "flag.doc_resend_v1";
/** Sub-flag: notify the customer on Bale when a new invoice/acknowledgement is issued. Absent or ≠ '1' = OFF. Requires DOC_RESEND_FLAG too. No SMS, no paid messages. */
export const DOC_RESEND_BALE_NOTIFY_FLAG = "flag.doc_resend_bale_notify";
export const REASON_MIN = 5;
export const REASON_MAX = 2000;
const UNSIGNED_OPEN_STATUSES = new Set(["sent", "sending", "delivery_unknown"]);

export const GOODS_STAGES = [
  "discharge_pending", "invoice_draft", "invoice_signature", "settlement_pending",
  "acknowledgement_signature", "registrar_confirmation", "completed",
] as const;
export const PAYMENT_STAGES = ["sales_approval", "admin_approval", "awaiting_payment", "paid"] as const;

export const GOODS_STAGE_LABELS: Record<string, string> = {
  discharge_pending: "تخلیه اعتبار", invoice_draft: "پیش‌فاکتور", invoice_signature: "امضای فاکتور",
  settlement_pending: "تسویه با شرکت", acknowledgement_signature: "رسید و اقرارنامه",
  registrar_confirmation: "تأیید ثبت‌کننده", completed: "تکمیل",
};
export const PAYMENT_STAGE_LABELS: Record<string, string> = {
  sales_approval: "منتظر تأیید فروش", admin_approval: "منتظر تأیید مدیر",
  awaiting_payment: "در انتظار علامت پرداخت", paid: "پرداخت‌شده",
};

/** Stages at or after settleGoodsPurchase (wallet debit, lots consumed, company credit). */
const POST_SETTLEMENT = new Set(["acknowledgement_signature", "registrar_confirmation", "completed"]);

function settingValue(key: string): string | undefined {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value;
  } catch {
    return undefined;
  }
}

export function docResendOn(): boolean {
  return settingValue(DOC_RESEND_FLAG) === "1";
}

/** Both the main flag and the Bale sub-flag must be '1'. Absent = OFF. */
export function docResendBaleNotifyOn(): boolean {
  return docResendOn() && settingValue(DOC_RESEND_BALE_NOTIFY_FLAG) === "1";
}

/** Plain admin or sales manager only. Effective role is admin for both; distinguish via baseRole / salesManager. */
export function canDocResend(u: AuthUser | null | undefined): boolean {
  if (!u) return false;
  if (isSalesManagerUser(u)) return true;
  return u.role === "admin" && u.baseRole !== "sales_manager";
}


export type CancelEmzameFn = (providerContractId: string) => Promise<void>;
export type GenerateGoodsDocumentFn = typeof generateGoodsDocument;
export type NotifyDocResendFn = (opts: {
  purchaseId: number; kind: GoodsDocumentKind; actor: AuthUser; version?: number;
}) => Promise<{ sent: boolean; reason?: string }>;

let cancelEmzameFn: CancelEmzameFn | null = null;
let generateGoodsDocumentFn: GenerateGoodsDocumentFn | null = null;
let notifyDocResendFn: NotifyDocResendFn | null = null;

/** Test-only: mock the Emzame cancel call. Null restores the real client (still unused unless a test sets EMZAME_*). */
export function setCancelEmzameContractForTests(fn: CancelEmzameFn | null) { cancelEmzameFn = fn; }
/** Test-only: stub generate (e.g. startGoodsDocumentGeneration) so fixtures never run LibreOffice or sendContract. */
export function setGenerateGoodsDocumentForTests(fn: GenerateGoodsDocumentFn | null) { generateGoodsDocumentFn = fn; }
/** Test-only: intercept Bale notify. Null restores the real (still no-send unless the sub-flag is on and srDeliver is also mocked). */
export function setNotifyDocResendForTests(fn: NotifyDocResendFn | null) { notifyDocResendFn = fn; }
export function resetDocResendHooksForTests() {
  cancelEmzameFn = null;
  generateGoodsDocumentFn = null;
  notifyDocResendFn = null;
}

async function runCancelEmzame(providerContractId: string) {
  const run = cancelEmzameFn ?? cancelEmzameContract;
  await run(providerContractId);
}

/** Cancel previous UNSIGNED Emzame requests of this kind. Never touches signed rows. */
export async function cancelPreviousUnsignedGoodsRequests(purchaseId: number, kind: GoodsDocumentKind) {
  const rows = queryRows<{ id: number; status: string; provider_contract_id: string | null }>(
    `SELECT id, status, provider_contract_id FROM goods_purchase_documents
     WHERE purchase_id=? AND kind=? ORDER BY version`,
    [purchaseId, kind],
  );
  const cancelled: number[] = [];
  const skippedSigned: number[] = [];
  const stamp = new Date().toISOString();
  for (const row of rows) {
    if (row.status === "signed") { skippedSigned.push(row.id); continue; }
    if (!row.provider_contract_id) continue;
    if (!UNSIGNED_OPEN_STATUSES.has(row.status)) continue;
    await runCancelEmzame(String(row.provider_contract_id));
    if (executeChanges(
      `UPDATE goods_purchase_documents SET provider_status='cancelled', status='cancelled', updated_at=?
       WHERE id=? AND status<>'signed' AND provider_contract_id IS NOT NULL`,
      [stamp, row.id],
    ) !== 1) {
      fail(409, "provider_cancel_conflict");
    }
    cancelled.push(row.id);
  }
  return { cancelled, skippedSigned };
}

function firstNameOfCustomer(customerId: number): string {
  const c = queryRow<{ name: string | null; first_name: string | null }>("SELECT name, first_name FROM customers WHERE id=?", [customerId]);
  const first = String(c?.first_name ?? "").trim();
  if (first) return first;
  return String(c?.name ?? "مشتری").trim().split(/\s+/)[0] || "مشتری";
}

/** Notify the customer on Bale that a new document was issued. No SMS, no paid messages. Off unless both flags are '1'. */
export async function notifyDocResendViaBale(opts: {
  purchaseId: number; kind: GoodsDocumentKind; actor: AuthUser; version?: number;
}): Promise<{ sent: boolean; reason?: string }> {
  if (notifyDocResendFn) return notifyDocResendFn(opts);
  if (!docResendBaleNotifyOn()) return { sent: false, reason: "flag_off" };
  const p = getGoodsPurchase(opts.purchaseId);
  const chats = srStartedChats(p.customerId);
  if (!chats.length) return { sent: false, reason: "bot_not_started" };
  const target = chats[0];
  if (!srBotHasToken(target.bot_id)) return { sent: false, reason: "no_token" };
  const kindLabel = opts.kind === "invoice" ? "فاکتور" : "اقرارنامه";
  const text = `سلام ${firstNameOfCustomer(p.customerId)}، ${kindLabel} تازه‌ای برای درخواست خرید کالا صادر شد. در صورت نیاز از مسیر امضا اقدام کنید.`;
  const keyboard = srKeyboard(srDefaultSignUrl());
  let delivered: { ok: true; messageId: number } | { ok: false; message: string };
  try {
    delivered = await srDeliver({
      chatRow: target.id, botId: target.bot_id, text, keyboard, authorUserId: opts.actor.id, at: new Date().toISOString(),
    });
  } catch {
    return { sent: false, reason: "bale_failed" };
  }
  return delivered.ok ? { sent: true } : { sent: false, reason: "bale_failed" };
}

export class DocResendError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new DocResendError(status, code); };

export function parseReason(body: any): { reason: string; confirmed: boolean; expectedStage?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_doc_resend_input");
  if (body.confirmed !== true) fail(400, "admin_confirmation_required");
  if (typeof body.reason !== "string") fail(400, "admin_reason_required");
  const reason = body.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) fail(400, "admin_reason_required");
  const expectedStage = typeof body.expectedStage === "string" ? body.expectedStage : undefined;
  return { reason, confirmed: true, expectedStage };
}

function idx(list: readonly string[], stage: string) {
  const i = list.indexOf(stage);
  if (i < 0) fail(400, "invalid_admin_case_stage");
  return i;
}

function goodsAllowedTargets(stage: string): { targets: string[]; blocked: Array<{ stage: string; reason: string }> } {
  const i = idx(GOODS_STAGES, stage);
  const targets: string[] = [];
  const blocked: Array<{ stage: string; reason: string }> = [];
  for (let t = 0; t < i; t++) {
    const to = GOODS_STAGES[t];
    if (stage === "completed") {
      blocked.push({ stage: to, reason: "completed_financial_lock" });
      continue;
    }
    if (POST_SETTLEMENT.has(stage) && !POST_SETTLEMENT.has(to) && to !== "settlement_pending") {
      blocked.push({ stage: to, reason: "settlement_financial_lock" });
      continue;
    }
    targets.push(to);
  }
  // From ack/registrar, settlement_pending is allowed (no finance reversal; just before the acknowledgement).
  if (stage === "acknowledgement_signature" || stage === "registrar_confirmation") {
    if (!targets.includes("settlement_pending")) targets.push("settlement_pending");
  }
  targets.sort((a, b) => idx(GOODS_STAGES, a) - idx(GOODS_STAGES, b));
  return { targets, blocked };
}

function paymentAllowedTargets(stage: string, preOpening: boolean): { targets: string[]; blocked: Array<{ stage: string; reason: string }> } {
  const i = idx(PAYMENT_STAGES, stage);
  const targets: string[] = [];
  const blocked: Array<{ stage: string; reason: string }> = [];
  for (let t = 0; t < i; t++) {
    const to = PAYMENT_STAGES[t];
    if (stage === "paid" && preOpening) {
      blocked.push({ stage: to, reason: "pre_opening_unpay_forbidden" });
      continue;
    }
    targets.push(to);
  }
  return { targets, blocked };
}

function resendKinds(stage: string): GoodsDocumentKind[] {
  const kinds: GoodsDocumentKind[] = [];
  if (["invoice_draft", "invoice_signature", "settlement_pending"].includes(stage)) kinds.push("invoice");
  if (["acknowledgement_signature", "registrar_confirmation", "completed"].includes(stage)) kinds.push("acknowledgement");
  return kinds;
}

export function goodsAdminControls(purchaseId: number, actor: AuthUser) {
  assertGoodsPurchaseScope(purchaseId, actor);
  const p = getGoodsPurchase(purchaseId);
  const { targets, blocked } = goodsAllowedTargets(p.stage);
  const documents = {
    invoice: goodsDocumentHistory(purchaseId, "invoice"),
    acknowledgement: goodsDocumentHistory(purchaseId, "acknowledgement"),
  };
  return {
    kind: "goods" as const,
    id: p.id,
    stage: p.stage,
    stageLabel: GOODS_STAGE_LABELS[p.stage] ?? p.stage,
    stages: GOODS_STAGES.map((s) => ({ key: s, label: GOODS_STAGE_LABELS[s] })),
    allowedTargetStages: targets,
    blockedTargetStages: blocked,
    allowedResendKinds: resendKinds(p.stage),
    canReviseInvoice: p.stage === "invoice_draft",
    documents,
    invoiceVersion: p.invoice_version,
    invoiceSignedVersion: p.invoice_signed_version,
    acknowledgementSigned: !!p.acknowledgement_signed,
    baleNotify: docResendBaleNotifyOn(),
  };
}

function isPreOpening(orderId: number): boolean {
  try {
    return !!queryRow(`SELECT 1 FROM payment_order_prior_payments p
      WHERE p.pre_start=1 AND p.payment_order_id=?
        AND NOT EXISTS (SELECT 1 FROM payment_order_prior_payment_voids v WHERE v.prior_payment_id=p.id) LIMIT 1`, [orderId]);
  } catch { return false; }
}

export function paymentAdminControls(orderId: number, actor: AuthUser) {
  const order = paymentOrder(orderId, actor);
  if (!order) fail(404, "payment_order_not_found");
  const pre = isPreOpening(Number(order.id));
  const { targets, blocked } = paymentAllowedTargets(order.stage, pre);
  return {
    kind: "payment" as const,
    id: order.id,
    purchaseId: order.purchase_id,
    stage: order.stage,
    stageLabel: PAYMENT_STAGE_LABELS[order.stage] ?? order.stage,
    stages: PAYMENT_STAGES.map((s) => ({ key: s, label: PAYMENT_STAGE_LABELS[s] })),
    allowedTargetStages: targets,
    blockedTargetStages: blocked,
    allowedResendKinds: [] as GoodsDocumentKind[],
    preOpening: pre,
    canUnpay: order.stage === "paid" && !pre,
  };
}

function clearGoodsDownstream(from: string, to: string, purchaseId: number) {
  // Pre-settlement: a new invoice may be issued; keep old signed document rows, drop the pointer so a new signature can be recorded.
  if (idx(GOODS_STAGES, to) <= idx(GOODS_STAGES, "invoice_draft") || to === "invoice_signature") {
    if (idx(GOODS_STAGES, from) >= idx(GOODS_STAGES, "invoice_signature")) {
      executeChanges("UPDATE goods_purchases SET invoice_signed_version=NULL WHERE id=?", [purchaseId]);
    }
  }
  // Back to acknowledgement_signature: allow a new acknowledgement to move the case forward again; old signed ack rows stay.
  if (from === "registrar_confirmation" && (to === "acknowledgement_signature" || to === "settlement_pending")) {
    executeChanges("UPDATE goods_purchases SET acknowledgement_signed=0 WHERE id=?", [purchaseId]);
  }
}

export async function goodsStageBack(purchaseId: number, toStage: string, actor: AuthUser, reason: string, expectedStage?: string) {
  assertGoodsPurchaseScope(purchaseId, actor);
  const p = getGoodsPurchase(purchaseId);
  if (expectedStage && p.stage !== expectedStage) fail(409, "admin_case_revision_conflict");
  if (!GOODS_STAGES.includes(toStage as any)) fail(400, "invalid_admin_case_stage");
  if (p.stage === toStage) fail(409, "admin_case_no_changes");
  const { targets } = goodsAllowedTargets(p.stage);
  if (!targets.includes(toStage)) {
    if (p.stage === "completed") fail(409, "completed_financial_lock");
    fail(409, "settlement_financial_lock");
  }
  const from = p.stage;
  // Going back from invoice_signature cancels an in-flight UNSIGNED Emzami request (same helper as resend; never signed). Fail-closed: cancel failure aborts the stage change.
  let cancelledDocumentIds: number[] = [];
  if (from === "invoice_signature") {
    const cancelled = await cancelPreviousUnsignedGoodsRequests(purchaseId, "invoice");
    cancelledDocumentIds = cancelled.cancelled;
  }
  return runTransaction(() => {
    const again = getGoodsPurchase(purchaseId);
    if (again.stage !== from || (expectedStage && again.stage !== expectedStage)) fail(409, "admin_case_revision_conflict");
    if (executeChanges("UPDATE goods_purchases SET stage=? WHERE id=? AND stage=?", [toStage, purchaseId, from]) !== 1) {
      fail(409, "admin_case_revision_conflict");
    }
    clearGoodsDownstream(from, toStage, purchaseId);
    goodsEvent(purchaseId, "admin_stage_back", actor.id, { fromStage: from, toStage, reason, actorUserId: actor.id, cancelledDocumentIds });
    return getGoodsPurchase(purchaseId);
  });
}

export function paymentStageBack(orderId: number, toStage: string, actor: AuthUser, reason: string, expectedStage?: string) {
  return runTransaction(() => {
    const order = paymentOrder(orderId, actor);
    if (!order) fail(404, "payment_order_not_found");
    if (expectedStage && order.stage !== expectedStage) fail(409, "admin_case_revision_conflict");
    if (!PAYMENT_STAGES.includes(toStage as any)) fail(400, "invalid_admin_case_stage");
    if (order.stage === toStage) fail(409, "admin_case_no_changes");
    const pre = isPreOpening(Number(order.id));
    const { targets } = paymentAllowedTargets(order.stage, pre);
    if (!targets.includes(toStage)) {
      if (pre) fail(409, "pre_opening_unpay_forbidden");
      fail(409, "wrong_payment_stage");
    }
    const from = order.stage;
    let paidReversal: { revision: number; neutralizedCommissionRows: unknown } | null = null;
    if (from === "paid") {
      paidReversal = revertPaidPaymentOrder(order, actor, reason);
    }
    const now = new Date().toISOString();
    // After unpay the row is awaiting_payment; continue to an earlier stage if requested.
    const current = from === "paid" ? "awaiting_payment" : from;
    if (toStage !== current) {
      const fields: string[] = ["stage=?", "updated_at=?"];
      const args: unknown[] = [toStage, now];
      if (idx(PAYMENT_STAGES, toStage) <= idx(PAYMENT_STAGES, "admin_approval")) {
        fields.push("admin_approved_by=NULL");
      }
      if (idx(PAYMENT_STAGES, toStage) <= idx(PAYMENT_STAGES, "sales_approval")) {
        fields.push("sales_approved_by=NULL");
      }
      args.push(order.id, current);
      if (executeChanges(`UPDATE customer_payment_orders SET ${fields.join(",")} WHERE id=? AND stage=?`, args) !== 1) {
        fail(409, "admin_case_revision_conflict");
      }
    }
    paymentEvent(order.id, "admin_stage_back", actor.id, { fromStage: from, toStage, reason, actorUserId: actor.id, paidReversal });
    return paymentOrder(order.id, actor);
  });
}

export function reviseGoodsInvoice(purchaseId: number, items: any[], actor: AuthUser, reason: string, expectedStage?: string) {
  assertGoodsPurchaseScope(purchaseId, actor);
  const p = getGoodsPurchase(purchaseId);
  if (expectedStage && p.stage !== expectedStage) fail(409, "admin_case_revision_conflict");
  if (p.stage !== "invoice_draft") fail(409, "invalid_purchase_stage");
  const updated = saveGoodsInvoice(purchaseId, items, actor.id, { adminResend: true });
  goodsEvent(purchaseId, "admin_invoice_revised", actor.id, { reason, actorUserId: actor.id, invoiceVersion: updated.invoice_version });
  return getGoodsPurchase(purchaseId);
}

export async function resendGoodsDocument(purchaseId: number, kind: GoodsDocumentKind, actor: AuthUser, reason: string, expectedStage?: string, manual: Record<string, string> = {}) {
  assertGoodsPurchaseScope(purchaseId, actor);
  const p = getGoodsPurchase(purchaseId);
  if (expectedStage && p.stage !== expectedStage) fail(409, "admin_case_revision_conflict");
  if (!resendKinds(p.stage).includes(kind)) fail(409, "invalid_purchase_stage");
  const source = {
    id: p.id, customerId: p.customerId, planId: p.planId,
    creditAmountToman: p.creditAmountToman, principalAmountToman: p.principalAmountToman,
    payoutAmountToman: p.payoutAmountToman, acknowledgementTemplateId: p.acknowledgement_template_id,
    invoiceVersion: p.invoice_version,
    items: (p.items ?? []).map((i: any) => ({ title: i.title, quantity: i.quantity, unitPriceToman: i.unitPriceToman })),
  };
  if (kind === "invoice" && !(p.items ?? []).length) fail(409, "invoice_items_required");
  const cancelled = await cancelPreviousUnsignedGoodsRequests(purchaseId, kind);
  const generate = generateGoodsDocumentFn ?? generateGoodsDocument;
  const document = await generate(source, kind, actor.id, manual, { forceNew: true });
  const bale = await notifyDocResendViaBale({ purchaseId, kind, actor, version: document?.version });
  goodsEvent(purchaseId, "admin_document_resend", actor.id, {
    reason, kind, fromStage: p.stage, documentId: document?.id, version: document?.version, actorUserId: actor.id,
    cancelledDocumentIds: cancelled.cancelled, baleNotify: bale,
  });
  return { document, purchase: getGoodsPurchase(purchaseId), kind, cancelled, baleNotify: bale };
}

export function documentCounts(purchaseId: number) {
  return queryRows<{ kind: string; status: string; n: number; ids: string }>(
    `SELECT kind, status, COUNT(*) n, GROUP_CONCAT(id) ids FROM goods_purchase_documents WHERE purchase_id=? GROUP BY kind, status`,
    [purchaseId],
  );
}

export function documentRowCount(purchaseId: number) {
  return Number(queryRow<{ n: number }>("SELECT COUNT(*) n FROM goods_purchase_documents WHERE purchase_id=?", [purchaseId])?.n ?? 0);
}

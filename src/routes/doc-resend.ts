/**
 * t882 admin/sales-manager stage-back and document resend.
 * flag.doc_resend_v1 absent/≠'1' → /me returns enabled:false; other routes 404.
 * Cancel of a previous UNSIGNED Emzame request uses the provider client (mocked in tests; never a live send/cancel from fixtures).
 * Bale notify uses the sign-reminder deliver path, behind flag.doc_resend_bale_notify (absent=OFF). No SMS, no paid messages, no sendContract.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import {
  DOC_RESEND_FLAG, DOC_RESEND_BALE_NOTIFY_FLAG, docResendOn, docResendBaleNotifyOn, canDocResend, DocResendError, parseReason,
  goodsAdminControls, paymentAdminControls, goodsStageBack, paymentStageBack,
  reviseGoodsInvoice, resendGoodsDocument,
  GOODS_STAGE_LABELS, PAYMENT_STAGE_LABELS,
} from "../lib/doc-resend";
import { paymentOrderView } from "../lib/payment-orders";
import { AccountingError } from "../lib/accounting";
import { TeamCommissionError } from "../lib/team-commission";
import { GlPostingError } from "../lib/gl-posting";

const router: IRouter = Router();

function fail(res: Response, status: number, error: string, message?: string) {
  res.status(status).json({ error, ...(message ? { message } : {}) });
}

function handleError(res: Response, error: unknown) {
  if (error instanceof DocResendError) return fail(res, error.status, error.code);
  if (error instanceof TeamCommissionError || error instanceof AccountingError) return fail(res, error.status, error.message);
  if (error instanceof GlPostingError) return fail(res, 409, "gl_posting_failed");
  const code = error instanceof Error ? error.message : "doc_resend_failed";
  const status = /not_found/.test(code) ? 404 : /Forbidden|forbidden/.test(code) ? 403 : /lock|conflict|stage|changed|locked|required/.test(code) ? 409 : 500;
  return fail(res, status, code);
}

function requireActor(req: Request, res: Response, next: NextFunction): void {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!user) { fail(res, 401, "Unauthorized"); return; }
  if (!canDocResend(user)) { fail(res, 403, "doc_resend_forbidden", "این کار فقط برای مدیر سیستم و مدیر فروش است."); return; }
  next();
}

function guarded(_req: Request, res: Response, next: NextFunction): void {
  if (!docResendOn()) { fail(res, 404, "not_found"); return; }
  next();
}

router.get("/doc-resend/me", requireAuth, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  const enabled = docResendOn();
  const canAct = enabled && canDocResend(u);
  res.json({
    enabled,
    flag: DOC_RESEND_FLAG,
    baleNotify: docResendBaleNotifyOn(),
    baleNotifyFlag: DOC_RESEND_BALE_NOTIFY_FLAG,
    canAct,
    salesManager: !!u.salesManager,
    stageLabels: { goods: GOODS_STAGE_LABELS, payment: PAYMENT_STAGE_LABELS },
  });
});

router.get("/goods-purchases/:id/admin-controls", requireAuth, requireActor, guarded, (req, res) => {
  try { res.json(goodsAdminControls(Number(req.params.id), res.locals.authUser)); }
  catch (e) { handleError(res, e); }
});

router.post("/goods-purchases/:id/admin-stage", requireAuth, requireActor, guarded, (req, res) => {
  try {
    const { reason, expectedStage } = parseReason(req.body);
    const toStage = String(req.body?.stage ?? "");
    const purchase = goodsStageBack(Number(req.params.id), toStage, res.locals.authUser, reason, expectedStage);
    res.json(purchase);
  } catch (e) { handleError(res, e); }
});

router.post("/goods-purchases/:id/admin-invoice", requireAuth, requireActor, guarded, (req, res) => {
  try {
    const { reason, expectedStage } = parseReason(req.body);
    const purchase = reviseGoodsInvoice(Number(req.params.id), req.body?.items, res.locals.authUser, reason, expectedStage);
    res.json(purchase);
  } catch (e) { handleError(res, e); }
});

router.post("/goods-purchases/:id/admin-resend/:kind", requireAuth, requireActor, guarded, async (req, res) => {
  try {
    const kind = String(req.params.kind);
    if (kind !== "invoice" && kind !== "acknowledgement") { fail(res, 400, "invalid_document_request"); return; }
    const { reason, expectedStage } = parseReason(req.body);
    const values = req.body?.values ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values)) { fail(res, 400, "template_values_invalid"); return; }
    const result = await resendGoodsDocument(Number(req.params.id), kind, res.locals.authUser, reason, expectedStage, values);
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.get("/payment-orders/:id/admin-controls", requireAuth, requireActor, guarded, (req, res) => {
  try { res.json(paymentAdminControls(Number(req.params.id), res.locals.authUser)); }
  catch (e) { handleError(res, e); }
});

router.post("/payment-orders/:id/admin-stage", requireAuth, requireActor, guarded, (req, res) => {
  try {
    const { reason, expectedStage } = parseReason(req.body);
    const toStage = String(req.body?.stage ?? "");
    const row = paymentStageBack(Number(req.params.id), toStage, res.locals.authUser, reason, expectedStage);
    res.json(paymentOrderView(row, true));
  } catch (e) { handleError(res, e); }
});

export default router;

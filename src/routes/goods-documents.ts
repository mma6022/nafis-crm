import { Router, type RequestHandler } from "express";
import type { AuthUser } from "../lib/auth";
import { assertGoodsPurchaseScope, getGoodsPurchase, setGoodsDocumentStatus, goodsEvent } from "../lib/goods-finance";
import { sendUpdatedGoodsAcknowledgement } from "../lib/contract-template-updates";
import { generateGoodsDocument, goodsDocumentState, goodsDocumentRequirements, goodsPdf, sendGoodsDocument, refreshGoodsDocument, queryGoodsDocumentSignatureStatus, type GoodsDocumentKind, type GoodsDocumentSource } from "../lib/goods-documents";

const router = Router();
const guard: RequestHandler = (req, res, next) => {
  const actor = res.locals.authUser as AuthUser | undefined;
  if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
  const mutation = req.method !== "GET";
  const permission = mutation ? "goods_purchases.manage" : "goods_purchases.view";
  if (actor.role !== "admin" && (!actor.permissions.includes(permission) || (mutation && actor.role !== "registrar"))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !["invoice", "acknowledgement"].includes(String(req.params.kind))) {
    res.status(400).json({ error: "invalid_document_request" }); return;
  }
  try {
    const purchase = getGoodsPurchase(id);
    assertGoodsPurchaseScope(purchase.id, actor);
    res.locals.goodsPurchase = purchase;
    next();
  } catch { res.status(404).json({ error: "purchase_not_found" }); }
};
function source(p: any): GoodsDocumentSource {
  return {
    id: p.id, customerId: p.customerId, planId: p.planId,
    creditAmountToman: p.creditAmountToman, principalAmountToman: p.principalAmountToman,
    payoutAmountToman: p.payoutAmountToman, acknowledgementTemplateId: p.acknowledgement_template_id,
    invoiceVersion: p.invoice_version,
    items: p.items.map((i: any) => ({ title: i.title, quantity: i.quantity, unitPriceToman: i.unitPriceToman })),
  };
}
function documentStage(p: any, kind: GoodsDocumentKind) {
  if (kind === "invoice") {
    if (!["invoice_draft", "invoice_signature", "settlement_pending"].includes(p.stage) || !p.invoice_version) throw new Error("invalid_purchase_stage");
  } else if (!["acknowledgement_signature", "registrar_confirmation"].includes(p.stage)) throw new Error("invalid_purchase_stage");
}
function errorResponse(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : "document_operation_failed";
  const safe = /^(document_|invoice_|acknowledgement_|template_|pdf_|conversion_|provider_|certificate_|collaborator_|invalid_purchase_stage)/.test(message);
  res.status(message === "provider_configuration" ? 503 : message.startsWith("provider_") ? 502 : 409).json({ error: safe ? message : "document_operation_failed" });
}
router.post("/goods-purchases/:id/documents/:kind/generate", guard, async (req, res): Promise<void> => {
  try {
    const p = res.locals.goodsPurchase, kind = String(req.params.kind) as GoodsDocumentKind;
    documentStage(p, kind);
    const values = req.body?.values ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values) || JSON.stringify(values).length > 50000
      || Object.values(values).some(v => typeof v !== "string" || v.length > 5000)) {
      res.status(400).json({ error: "template_values_invalid" }); return;
    }
    const result = await generateGoodsDocument(source(p), kind, (res.locals.authUser as AuthUser).id, values);
    goodsEvent(p.id, `${kind}_generated`, res.locals.authUser.id, { documentId: result?.id });
    res.json(result);
  } catch (e) { errorResponse(res, e); }
});
router.post("/goods-purchases/:id/documents/:kind/send-updated", guard, async (req, res): Promise<void> => {
  try {
    if (req.params.kind !== "acknowledgement") { res.status(400).json({ error: "invalid_document_request" }); return; }
    const values = req.body?.values ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values) || JSON.stringify(values).length > 50000
      || Object.values(values).some(v => typeof v !== "string" || v.length > 5000)) {
      res.status(400).json({ error: "template_values_invalid" }); return;
    }
    const actor = res.locals.authUser as AuthUser;
    const result = await sendUpdatedGoodsAcknowledgement(Number(req.params.id), actor, values);
    goodsEvent(Number(req.params.id), "acknowledgement_updated_sent", actor.id, { documentId: result?.id });
    res.json(result);
  } catch (e) { errorResponse(res, e); }
});
router.get("/goods-purchases/:id/documents/:kind/pdf", guard, async (req, res): Promise<void> => {
  try {
    const kind = String(req.params.kind) as GoodsDocumentKind;
    const pdf = await goodsPdf(Number(req.params.id), kind);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="goods-${req.params.id}-${kind}.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(pdf);
  } catch (e) { errorResponse(res, e); }
});
router.post("/goods-purchases/:id/documents/:kind/send", guard, async (req, res): Promise<void> => {
  try {
    const p = res.locals.goodsPurchase, kind = String(req.params.kind) as GoodsDocumentKind;
    documentStage(p, kind);
    const result = await sendGoodsDocument(source(p), kind);
    if (result?.status === "sent" || result?.signed) setGoodsDocumentStatus(p.id, kind, result.signed ? "signed" : "pending", result.invoiceVersion, res.locals.authUser.id);
    res.json(result);
  } catch (e) { errorResponse(res, e); }
});
router.post("/goods-purchases/:id/documents/:kind/refresh", guard, async (req, res): Promise<void> => {
  try {
    const p = res.locals.goodsPurchase, kind = String(req.params.kind) as GoodsDocumentKind;
    const result = await refreshGoodsDocument(p.id, kind);
    if (result && ((kind === "invoice" && ["invoice_draft", "invoice_signature", "settlement_pending"].includes(p.stage))
      || (kind === "acknowledgement" && ["acknowledgement_signature", "registrar_confirmation"].includes(p.stage)))) {
      setGoodsDocumentStatus(p.id, kind, result.signed ? "signed" : result.status === "rejected" ? "rejected" : "pending", result.invoiceVersion, res.locals.authUser.id);
    }
    res.json(result);
  } catch (e) { errorResponse(res, e); }
});
router.get("/goods-purchases/:id/documents/:kind/signature-status", guard, async (req, res): Promise<void> => {
  try {
    const result = await queryGoodsDocumentSignatureStatus(
      Number(req.params.id),
      String(req.params.kind) as GoodsDocumentKind,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  } catch (e) { errorResponse(res, e); }
});
router.get("/goods-purchases/:id/documents/:kind", guard, (req, res) => {
  res.json(goodsDocumentState(Number(req.params.id), String(req.params.kind) as GoodsDocumentKind));
});
router.get("/goods-purchases/:id/documents/:kind/requirements", guard, (req, res) => {
  try { res.json(goodsDocumentRequirements(source(res.locals.goodsPurchase), String(req.params.kind) as GoodsDocumentKind)); }
  catch (e) { errorResponse(res, e); }
});
export default router;
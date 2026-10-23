import type { Request, Response } from "express";
import type { AuthUser } from "./auth";
import { crmDb, execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { emzameRequest } from "./emzame-client";
import { providerContractState } from "./emzame-signature";
import { generateGoodsDocument, goodsDocumentState, refreshGoodsDocument, sendGoodsDocument, type GoodsDocumentSource } from "./goods-documents";
import { getGoodsPurchase } from "./goods-finance";

type Handler = (req: Request, res: Response) => Promise<void>;
type Logger = { warn?: (...args: any[]) => void; error?: (...args: any[]) => void } | undefined;
let handlers: { generate: Handler; send: Handler } | null = null;
export function registerContractHandlers(value: { generate: Handler; send: Handler }) { handlers = value; }

const now = () => new Date().toISOString();
const GOODS_STAGES = ["acknowledgement_signature", "registrar_confirmation"];

crmDb.exec(`CREATE TABLE IF NOT EXISTS contract_update_notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('loan','goods')),
  subject_id INTEGER NOT NULL, target_id INTEGER NOT NULL, template_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('update_available','needs_attention')), detail TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_by INTEGER);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_update_notice_open ON contract_update_notices(kind,subject_id) WHERE resolved_at IS NULL;`);

function openNotice(kind: "loan" | "goods", subjectId: number, targetId: number, templateId: number | null, status: "update_available" | "needs_attention", detail: string | null) {
  crmDb.prepare("UPDATE contract_update_notices SET resolved_at=? WHERE kind=? AND subject_id=? AND resolved_at IS NULL").run(now(), kind, subjectId);
  execute("INSERT INTO contract_update_notices(kind,subject_id,target_id,template_id,status,detail,created_at) VALUES(?,?,?,?,?,?,?)",
    [kind, subjectId, targetId, templateId, status, detail, now()]);
}
export function resolveNotice(kind: "loan" | "goods", subjectId: number, by: number | null) {
  crmDb.prepare("UPDATE contract_update_notices SET resolved_at=?,resolved_by=? WHERE kind=? AND subject_id=? AND resolved_at IS NULL").run(now(), by, kind, subjectId);
}

export async function invokeHandler(handler: Handler, input: { params?: any; body?: any }, actor: AuthUser, log?: Logger) {
  const result: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    locals: { authUser: actor },
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; },
    send(body: unknown) { result.body = body; return this; },
    setHeader() { return this; },
  };
  await handler({ params: input.params ?? {}, body: input.body ?? {}, query: {}, log } as any, res as Response);
  return result;
}

const asAdmin = (actor: AuthUser): AuthUser => ({ ...actor, role: "admin" } as AuthUser);
const templateOf = (snapshot: any): number => Number(snapshot?.contract_template_id ?? snapshot?.primary_contract_template_id);
const parse = (text: unknown): any => { try { return JSON.parse(String(text ?? "{}")); } catch { return {}; } };

function applyPlanTemplateToUnsignedApplications(planId: number, templateId: number) {
  const apps = queryRows<any>("SELECT id,plan_snapshot_json FROM loan_applications WHERE plan_id=? AND deleted_at IS NULL AND status<>'rejected'", [planId]);
  for (const app of apps) {
    const signed = queryRow("SELECT 1 FROM contract_generations WHERE loan_application_id=? AND status='signed' AND deleted_at IS NULL AND superseded_at IS NULL LIMIT 1", [app.id]);
    const snapshot = parse(app.plan_snapshot_json);
    if (signed || !snapshot || templateOf(snapshot) === templateId) continue;
    snapshot.contract_template_id = templateId;
    if (snapshot.primary_contract_template_id !== undefined) snapshot.primary_contract_template_id = templateId;
    executeChanges("UPDATE loan_applications SET plan_snapshot_json=? WHERE id=?", [JSON.stringify(snapshot), app.id]);
  }
}

async function syncLoanApplications(templateId: number, planId: number | null, actor: AuthUser, log: Logger) {
  if (!handlers) return;
  const candidates = queryRows<any>(`SELECT g.* FROM contract_generations g JOIN loan_applications a ON a.id=g.loan_application_id
    WHERE g.deleted_at IS NULL AND g.superseded_at IS NULL AND a.deleted_at IS NULL AND a.status<>'rejected'
      AND COALESCE(g.generation_purpose,'primary')='primary' AND g.status IN ('generated','failed','sent')
      AND (g.template_id=? ${planId ? "OR a.plan_id=?" : ""})`, planId ? [templateId, planId] : [templateId]);
  for (const g of candidates) {
    const app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [g.loan_application_id]);
    if (!app || templateOf(parse(app.plan_snapshot_json)) !== templateId) continue;
    try {
      if (g.status === "sent") {
        if (g.provider_contract_id) openNotice("loan", Number(app.id), Number(g.id), templateId, "update_available", null);
        continue;
      }
      if (g.provider_contract_id) continue;
      const superseded = executeChanges(`UPDATE contract_generations SET superseded_at=?,updated_at=?
        WHERE id=? AND status IN ('generated','failed') AND provider_contract_id IS NULL AND superseded_at IS NULL`, [now(), now(), g.id]);
      if (superseded !== 1) continue;
      let ok = false; let detail = "generation_failed";
      try {
        const out = await invokeHandler(handlers.generate, { body: { loanApplicationId: Number(app.id) } }, asAdmin(actor), log);
        ok = out.status >= 200 && out.status < 300; if (!ok) detail = String(out.body?.error ?? detail);
      } catch (e) { detail = e instanceof Error ? e.message : detail; }
      if (!ok) {
        const replacement = queryRow("SELECT 1 FROM contract_generations WHERE loan_application_id=? AND generation_purpose=? AND superseded_at IS NULL AND deleted_at IS NULL", [app.id, g.generation_purpose ?? "primary"]);
        if (!replacement) executeChanges("UPDATE contract_generations SET superseded_at=NULL,updated_at=? WHERE id=?", [now(), g.id]);
        openNotice("loan", Number(app.id), Number(g.id), templateId, "needs_attention", detail.slice(0, 200));
      } else {
        resolveNotice("loan", Number(app.id), actor.id);
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
          [app.id, app.stage, app.stage, `contract_regenerated_for_template_update:${templateId}`, actor.id, now()]);
      }
    } catch (e) { log?.error?.({ err: e, applicationId: app.id }, "contract template sync failed"); }
  }
}

export function goodsSourceFromPurchase(p: any): GoodsDocumentSource {
  return {
    id: p.id, customerId: p.customerId, planId: p.planId, creditAmountToman: p.creditAmountToman,
    principalAmountToman: p.principalAmountToman, payoutAmountToman: p.payoutAmountToman,
    acknowledgementTemplateId: p.acknowledgement_template_id, invoiceVersion: p.invoice_version,
    items: p.items.map((i: any) => ({ title: i.title, quantity: i.quantity, unitPriceToman: i.unitPriceToman })),
  };
}

async function syncGoodsPurchases(templateId: number, actor: AuthUser, log: Logger) {
  const rows = queryRows<{ id: number }>("SELECT id FROM goods_purchases WHERE acknowledgement_template_id=? AND stage IN ('acknowledgement_signature','registrar_confirmation')", [templateId]);
  for (const { id } of rows) {
    try {
      const doc = queryRow<any>("SELECT * FROM goods_purchase_documents WHERE purchase_id=? AND kind='acknowledgement' ORDER BY version DESC LIMIT 1", [id]);
      if (!doc || doc.status === "signed") continue;
      if (doc.status === "sent") { openNotice("goods", id, Number(doc.id), templateId, "update_available", null); continue; }
      if (doc.status !== "generated" || doc.provider_contract_id || doc.provider_file_id) continue;
      await regenerateGoodsAcknowledgement(id, doc, templateId, actor, {});
    } catch (e) { log?.error?.({ err: e, purchaseId: id }, "goods contract sync failed"); }
  }
}

async function regenerateGoodsAcknowledgement(purchaseId: number, doc: any, templateId: number | null, actor: AuthUser, manual: Record<string, string>) {
  const freed = Number(crmDb.prepare("UPDATE goods_purchase_documents SET status='superseded',updated_at=? WHERE id=? AND status IN ('generated','sent') AND (provider_contract_id IS NULL OR status='sent')")
    .run(now(), doc.id).changes);
  if (freed !== 1) throw new Error("document_delivery_locked");
  try {
    const result = await generateGoodsDocument(goodsSourceFromPurchase(getGoodsPurchase(purchaseId)), "acknowledgement", actor.id, manual);
    resolveNotice("goods", purchaseId, actor.id);
    return result;
  } catch (e) {
    crmDb.prepare("DELETE FROM goods_purchase_documents WHERE purchase_id=? AND kind='acknowledgement' AND version>? AND status='failed'").run(purchaseId, doc.version);
    crmDb.prepare("UPDATE goods_purchase_documents SET status=?,updated_at=? WHERE id=?").run(doc.status, now(), doc.id);
    if (templateId !== null) openNotice("goods", purchaseId, Number(doc.id), templateId, "needs_attention", (e instanceof Error ? e.message : "generation_failed").slice(0, 200));
    throw e;
  }
}

/** Template edited or plan template changed: refresh every unsigned case, flag sent-but-unsigned ones. */
export function propagateContractTemplateChange(input: { templateId: number; actor: AuthUser; log?: Logger; planId?: number | null; goodsPlanId?: number | null }) {
  void (async () => {
    try {
      if (input.planId) applyPlanTemplateToUnsignedApplications(input.planId, input.templateId);
      if (input.goodsPlanId) {
        executeChanges(`UPDATE goods_purchases SET acknowledgement_template_id=? WHERE plan_id=? AND stage NOT IN ('completed') AND
          NOT EXISTS(SELECT 1 FROM goods_purchase_documents d WHERE d.purchase_id=goods_purchases.id AND d.kind='acknowledgement' AND d.status='signed')`,
        [input.templateId, input.goodsPlanId]);
      }
      await syncLoanApplications(input.templateId, input.planId ?? null, input.actor, input.log);
      await syncGoodsPurchases(input.templateId, input.actor, input.log);
    } catch (e) { input.log?.error?.({ err: e }, "contract template propagation failed"); }
  })();
}

export function openContractUpdateNotices(kind: "loan" | "goods", subjectId: number) {
  const rows = queryRows<any>("SELECT * FROM contract_update_notices WHERE kind=? AND subject_id=? AND resolved_at IS NULL", [kind, subjectId]);
  return rows.filter(n => {
    if (n.status === "needs_attention") return true;
    if (kind === "loan") {
      const g = queryRow<any>("SELECT status,superseded_at FROM contract_generations WHERE id=?", [n.target_id]);
      return Boolean(g && g.status === "sent" && !g.superseded_at);
    }
    const d = queryRow<any>("SELECT status FROM goods_purchase_documents WHERE id=?", [n.target_id]);
    return d?.status === "sent";
  }).map(n => ({ id: n.id, status: n.status, detail: n.detail, createdAt: n.created_at }));
}

const providerSigned = async (contractId: string) => {
  const r = await emzameRequest(`contracts/${encodeURIComponent(contractId)}`, { method: "GET" });
  if (!r.ok) throw new Error("provider_status_failed");
  return providerContractState(await r.json()).signed;
};

export async function sendUpdatedLoanContract(applicationId: number, actor: AuthUser, log?: Logger) {
  if (!handlers) throw new Error("handlers_unavailable");
  const app = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [applicationId]);
  const notice = queryRow<any>("SELECT * FROM contract_update_notices WHERE kind='loan' AND subject_id=? AND resolved_at IS NULL", [applicationId]);
  if (!app || !notice || notice.status !== "update_available") throw new Error("no_updated_contract");
  const g1 = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [notice.target_id]);
  const doc = queryRow<any>("SELECT * FROM loan_application_generated_documents WHERE application_id=? AND kind='primary' AND contract_generation_id=? ORDER BY id DESC LIMIT 1", [applicationId, notice.target_id]);
  if (!g1 || g1.status !== "sent" || g1.superseded_at || !g1.provider_contract_id || Number(app.current_primary_generation_id) !== Number(g1.id) ||
      !doc || String(doc.link ?? "").startsWith("signed:") || app.status === "rejected") throw new Error("contract_not_current");
  if (await providerSigned(String(g1.provider_contract_id))) throw new Error("contract_already_signed");
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    if (executeChanges("UPDATE contract_generations SET superseded_at=?,updated_at=? WHERE id=? AND status='sent' AND superseded_at IS NULL", [now(), now(), g1.id]) !== 1) throw new Error("contract_state_changed");
    execute(`INSERT INTO contract_generation_rejected_deliveries(generation_id,provider_contract_id,provider_file_id,provider_status,sent_at,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?)`,
      [g1.id, String(g1.provider_contract_id), g1.provider_file_id, "replaced_by_updated_contract", g1.sent_at, actor.id, now()]);
    crmDb.exec("COMMIT");
  } catch (e) { crmDb.exec("ROLLBACK"); throw e; }
  const restore = () => {
    executeChanges("UPDATE contract_generations SET superseded_at=NULL,updated_at=? WHERE id=?", [now(), g1.id]);
    crmDb.prepare("DELETE FROM contract_generation_rejected_deliveries WHERE generation_id=? AND provider_status='replaced_by_updated_contract'").run(g1.id);
  };
  let generated;
  try { generated = await invokeHandler(handlers.generate, { body: { loanApplicationId: applicationId } }, actor, log); }
  catch (e) { restore(); throw e; }
  const g2Id = Number(generated.body?.id ?? generated.body?.generation?.id);
  if (generated.status >= 300 || !g2Id) { restore(); throw new Error(String(generated.body?.error ?? "generation_failed")); }
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    executeChanges("UPDATE loan_application_generated_documents SET contract_generation_id=?,link=NULL,status='pending' WHERE id=?", [g2Id, doc.id]);
    if (executeChanges("UPDATE loan_applications SET current_primary_generation_id=?,updated_at=? WHERE id=? AND current_primary_generation_id=?", [g2Id, now(), applicationId, g1.id]) !== 1) throw new Error("contract_state_changed");
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
      [applicationId, app.stage, app.stage, `updated_contract_replaced:${g1.id}->${g2Id}`, actor.id, now()]);
    crmDb.exec("COMMIT");
  } catch (e) { crmDb.exec("ROLLBACK"); throw e; }
  resolveNotice("loan", applicationId, actor.id);
  const sent = await invokeHandler(handlers.send, { params: { id: String(g2Id) } }, actor, log);
  return { generationId: g2Id, sent: sent.status < 300, error: sent.status < 300 ? null : String(sent.body?.error ?? "send_failed") };
}

export async function sendUpdatedGoodsAcknowledgement(purchaseId: number, actor: AuthUser, manual: Record<string, string>) {
  const doc = queryRow<any>("SELECT * FROM goods_purchase_documents WHERE purchase_id=? AND kind='acknowledgement' ORDER BY version DESC LIMIT 1", [purchaseId]);
  const notice = queryRow<any>("SELECT * FROM contract_update_notices WHERE kind='goods' AND subject_id=? AND resolved_at IS NULL", [purchaseId]);
  if (!doc || !notice || doc.status !== "sent" || Number(notice.target_id) !== Number(doc.id)) throw new Error("document_no_updated_contract");
  const purchase = getGoodsPurchase(purchaseId);
  if (!GOODS_STAGES.includes(purchase.stage)) throw new Error("invalid_purchase_stage");
  const refreshed = await refreshGoodsDocument(purchaseId, "acknowledgement");
  if (refreshed?.signed) throw new Error("document_already_signed");
  const fresh = queryRow<any>("SELECT * FROM goods_purchase_documents WHERE id=?", [doc.id]);
  if (fresh.status !== "sent") throw new Error("document_not_current");
  await regenerateGoodsAcknowledgement(purchaseId, fresh, null, actor, manual);
  return sendGoodsDocument(goodsSourceFromPurchase(getGoodsPurchase(purchaseId)), "acknowledgement");
}
void goodsDocumentState;

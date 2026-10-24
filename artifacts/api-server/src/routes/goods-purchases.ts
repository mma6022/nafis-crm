import { Router, type RequestHandler } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "../lib/crm-db";
import { goodsRegistrationSuggestions } from "../lib/registration-suggestions";
import { propagateContractTemplateChange } from "../lib/contract-template-updates";
import { ensureWalletSchema } from "../lib/wallets";
import { salespersonBreakdown } from "../lib/team-commission";
import { ensureGoodsFinanceSchema, getGoodsPurchase, assertGoodsCustomerScope, assertGoodsPurchaseScope, createGoodsPurchase, saveGoodsInvoice, settleGoodsPurchase, completeGoodsPurchase, goodsEvent, money, percentBps, persianMonth, unassignedGoodsCredit } from "../lib/goods-finance";

ensureWalletSchema();
ensureGoodsFinanceSchema();
const router = Router();
router.use(requireAuth);
const user = (res: any) => res.locals.authUser as AuthUser;
const wrap = (fn: (req: any,res: any) => void): RequestHandler => (req,res) => {
  try { fn(req,res); } catch (e) {
    const error = e instanceof Error ? e.message : "goods_operation_failed";
    res.status(/not_found/.test(error) ? 404 : /Forbidden/.test(error) ? 403 : 422).json({error});
  }
};
const registrar = (u: AuthUser) => { if (u.role === "salesperson" || u.role === "accounting" || u.role === "funder") throw new Error("Forbidden"); };
const purchase = (id: unknown, u: AuthUser) => { const p = getGoodsPurchase(Number(id)); assertGoodsPurchaseScope(p.id,u); return p; };
const scope = (u: AuthUser) => u.role !== "admin" && u.customerScope === "assigned";
/**
 * Own-only commission (server-side): admin sees everything; the purchase's own salesperson keeps its commission columns;
 * everyone else gets them blanked and commission history details stripped to the action only.
 */
const COMMISSION_COLUMNS = ["commission_bps", "commission_toman", "commission_month", "commission_settings_json"];
export function redactPurchaseCommission(p: any, u: AuthUser): any {
  if (!p || typeof p !== "object" || u.role === "admin" || !("commission_toman" in p)) return p;
  const own = u.salespersonId != null && Number(p.salesperson_id) === Number(u.salespersonId);
  const out = { ...p };
  if (!own) for (const c of COMMISSION_COLUMNS) out[c] = null;
  if (Array.isArray(p.events)) out.events = p.events.map((e: any) => /commission/.test(String(e.action)) ? { ...e, detail: null } : e);
  return out;
}
router.use("/goods-purchases", (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: any) => {
    const u = res.locals.authUser as AuthUser | undefined;
    if (!u || !body || typeof body !== "object") return json(body);
    if (Array.isArray(body.items)) return json({ ...body, items: body.items.map((p: any) => redactPurchaseCommission(p, u)) });
    return json(redactPurchaseCommission(body, u));
  };
  next();
});

router.get("/goods-purchases/suggestions",requirePermission("goods_purchases.view"),requirePermission("goods_purchases.manage"),wrap((req,res)=>{
  registrar(user(res));
  res.setHeader("Cache-Control","no-store");
  res.json(goodsRegistrationSuggestions(crmDb,user(res),req.query));
}));
router.get("/goods-purchases/eligible",requirePermission("goods_purchases.view"),wrap((req,res) => {
  const u = user(res), q = String(req.query.q ?? "").trim().slice(0,100), plan = Number(req.query.planId || 0);
  const rows = queryRows<any>(`SELECT w.customer_id customerId,c.name customerName,s.name customerSalespersonName,c.phone,w.plan_id planId,p.name planName,w.balance_toman balanceToman
    FROM goods_plan_wallets w JOIN customers c ON c.id=w.customer_id JOIN loan_plans p ON p.id=w.plan_id
     LEFT JOIN salespersons s ON s.id=c.salesperson_id
     WHERE c.merged_into_customer_id IS NULL AND w.balance_toman<>'0' AND NOT EXISTS(SELECT 1 FROM goods_purchases g WHERE g.wallet_id=w.id AND g.stage IN ('discharge_pending','invoice_draft','invoice_signature','settlement_pending'))
    ${scope(u) ? "AND c.salesperson_id=?" : ""} ${plan ? "AND w.plan_id=?" : ""}
    ${q ? "AND (crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ? OR c.national_code LIKE ?)" : ""} ORDER BY c.name,w.plan_id LIMIT 500`,
    [...(scope(u)?[u.salespersonId]:[]),...(plan?[plan]:[]),...(q?[`%${q}%`,`%${q}%`,`%${q}%`]:[])]);
  res.json({items:rows,unassignedNotice:"اعتبار قدیمی بدون منشأ طرح، برای خرید قابل استفاده نیست و نیاز به تطبیق مالی دارد."});
}));
router.get("/goods-purchases",requirePermission("goods_purchases.view"),wrap((req,res)=>{
  const u=user(res);
  const rows=queryRows<any>(`SELECT p.id FROM goods_purchases p JOIN customers c ON c.id=p.customer_id
    ${scope(u)?"WHERE (c.merged_into_customer_id IS NULL AND c.salesperson_id=?) OR EXISTS (SELECT 1 FROM customer_merge_audit a JOIN customers survivor ON survivor.id=a.survivor_customer_id WHERE a.source_customer_id=c.id AND c.merged_into_customer_id=survivor.id AND survivor.merged_into_customer_id IS NULL AND survivor.salesperson_id=?)":""}
    ORDER BY p.id DESC LIMIT 500`,scope(u)?[u.salespersonId,u.salespersonId]:[]);
  res.json({items:rows.map(r=>getGoodsPurchase(r.id))});
}));
router.post("/goods-purchases",requirePermission("goods_purchases.manage"),wrap((req,res)=>{
  const u=user(res);registrar(u);res.status(201).json(createGoodsPurchase(Number(req.body.customerId),Number(req.body.planId),u));
}));
router.get("/goods-purchases/:id",requirePermission("goods_purchases.view"),wrap((req,res)=>res.json(purchase(req.params.id,user(res)))));
router.post("/goods-purchases/:id/discharge",requirePermission("goods_purchases.manage"),wrap((req,res)=>{
  const u=user(res);registrar(u);const p=purchase(req.params.id,u);
  runTransaction(()=>{
    if(p.stage!=="discharge_pending") { if(p.stage==="invoice_draft")return;throw new Error("invalid_purchase_stage"); }
    executeChanges("UPDATE goods_purchases SET stage='invoice_draft' WHERE id=? AND stage='discharge_pending'",[p.id]);goodsEvent(p.id,"external_discharge_confirmed",u.id);
  });res.json(getGoodsPurchase(p.id));
}));
router.put("/goods-purchases/:id/invoice",requirePermission("goods_purchases.manage"),wrap((req,res)=>{
  const u=user(res);registrar(u);const p=purchase(req.params.id,u);res.json(saveGoodsInvoice(p.id,req.body.items,u.id));
}));
router.post("/goods-purchases/:id/settle",requirePermission("goods_purchases.manage"),requirePermission("goods_finance.manage"),wrap((req,res)=>{
  const u=user(res);registrar(u);const p=purchase(req.params.id,u);res.json(settleGoodsPurchase(p.id,u.id,req.body?.feeDiscountToman));
}));
router.post("/goods-purchases/:id/complete",requirePermission("goods_purchases.manage"),wrap((req,res)=>{
  const u=user(res);registrar(u);const p=purchase(req.params.id,u);res.json(completeGoodsPurchase(p.id,u.id));
}));
router.get("/goods-finance/plans/:planId",requirePermission("goods_finance.view"),wrap((req,res)=>{
  const r=queryRow<any>("SELECT * FROM goods_plan_settings WHERE plan_id=?",[Number(req.params.planId)]);
  res.json(r?{customerPayoutPercent:r.customer_payout_bps/100,developmentDiscountPercent:r.development_discount_bps/100,acknowledgementTemplateId:r.acknowledgement_template_id}:null);
}));
router.put("/goods-finance/plans/:planId",requirePermission("goods_finance.manage"),wrap((req,res)=>{
  if(user(res).role!=="admin")throw new Error("Forbidden");
  const id=Number(req.params.planId),body=req.body;
  if(!queryRow("SELECT 1 FROM loan_plans WHERE id=?",[id]))throw new Error("plan_not_found");
  const payout=percentBps(body.customerPayoutPercent),discount=percentBps(body.developmentDiscountPercent),template=body.acknowledgementTemplateId===null?null:Number(body.acknowledgementTemplateId);
  if(payout<=0)throw new Error("positive_customer_payout_required");
  if(template!==null&&!queryRow("SELECT 1 FROM contract_templates WHERE id=?",[template]))throw new Error("template_not_found");
  const previousTemplate=queryRow<any>("SELECT acknowledgement_template_id t FROM goods_plan_settings WHERE plan_id=?",[id])?.t??null;
  execute(`INSERT INTO goods_plan_settings(plan_id,customer_payout_bps,development_discount_bps,acknowledgement_template_id,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(plan_id) DO UPDATE SET customer_payout_bps=excluded.customer_payout_bps,development_discount_bps=excluded.development_discount_bps,acknowledgement_template_id=excluded.acknowledgement_template_id,updated_at=excluded.updated_at`,
    [id,payout,discount,template,new Date().toISOString()]);
  if(template!==null&&template!==previousTemplate)propagateContractTemplateChange({templateId:template,goodsPlanId:id,actor:user(res),log:req.log});
  res.json({customerPayoutPercent:payout/100,developmentDiscountPercent:discount/100,acknowledgementTemplateId:template});
}));
function salesAccess(id:number,u:AuthUser):void { if(u.role!=="admin"&&u.salespersonId!==id)throw new Error("Forbidden"); }
router.get("/goods-finance/salespersons/:id/settings",requirePermission("goods_finance.view"),wrap((req,res)=>{
  const id=Number(req.params.id);salesAccess(id,user(res));const r=queryRow<any>("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?",[id]);
  res.json(r?{target1Toman:r.target1_toman,target2Toman:r.target2_toman,target3Toman:r.target3_toman,rate0Percent:r.rate0_bps/100,rate1Percent:r.rate1_bps/100,rate2Percent:r.rate2_bps/100,rate3Percent:r.rate3_bps/100}:null);
}));
router.put("/goods-finance/salespersons/:id/settings",requirePermission("goods_finance.manage"),wrap((req,res)=>{
  if(user(res).role!=="admin")throw new Error("Forbidden");
  const id=Number(req.params.id),b=req.body;
  if(!queryRow("SELECT 1 FROM salespersons WHERE id=?",[id]))throw new Error("salesperson_not_found");
  const targets=[money(b.target1Toman),money(b.target2Toman),money(b.target3Toman)];
  if(targets[0]<=0n||targets[1]<=targets[0]||targets[2]<=targets[1])throw new Error("targets_must_increase");
  const rates=[0,1,2,3].map(i=>percentBps(b[`rate${i}Percent`]));
  execute(`INSERT INTO goods_salesperson_settings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(salesperson_id) DO UPDATE SET target1_toman=excluded.target1_toman,target2_toman=excluded.target2_toman,target3_toman=excluded.target3_toman,rate0_bps=excluded.rate0_bps,rate1_bps=excluded.rate1_bps,rate2_bps=excluded.rate2_bps,rate3_bps=excluded.rate3_bps`,[id,...targets.map(String),...rates]);
  res.json({saved:true});
}));
router.get("/goods-finance/salespersons/:id/summary",requirePermission("goods_finance.view"),wrap((req,res)=>{
  const id=Number(req.params.id);salesAccess(id,user(res));
  const month=/^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month??""))?String(req.query.month):persianMonth();
  const kind=typeof req.query.kind==="string"&&req.query.kind?req.query.kind:null;
  // Sales volume: team-model purchases count on their stored basis (deposit by default); everything else as before.
  const rows=queryRows<any>("SELECT COALESCE(t.basis_amount_toman,g.base_payout_amount_toman,g.payout_amount_toman) payout_amount_toman,g.commission_month FROM goods_purchases g LEFT JOIN team_commission_purchases t ON t.purchase_id=g.id AND t.status<>'pending_payout' WHERE g.salesperson_id=? AND g.stage='completed' AND g.commission_month IS NOT NULL",[id]);
  const report=salespersonBreakdown(id,month,kind);
  res.json({balanceToman:queryRow<any>("SELECT balance_toman FROM goods_salesperson_wallets WHERE salesperson_id=?",[id])?.balance_toman??"0",
    totalSalesToman:rows.reduce((s,r)=>s+money(r.payout_amount_toman),0n).toString(),monthlySalesToman:rows.filter(r=>r.commission_month===month).reduce((s,r)=>s+money(r.payout_amount_toman),0n).toString(),month,
    kind:kind??"all",breakdown:report.breakdown,monthTotalToman:report.monthTotalToman,stats:report.stats,transactions:report.transactions});
}));
router.get("/goods-finance/company-wallets",requirePermission("goods_finance.view"),wrap((req,res)=>{
  if(user(res).role!=="admin"&&user(res).role!=="accounting")throw new Error("Forbidden");
  res.json({items:queryRows("SELECT w.plan_id planId,p.name planName,w.balance_toman balanceToman FROM goods_company_wallets w JOIN loan_plans p ON p.id=w.plan_id"),
    transactions:queryRows("SELECT purchase_id purchaseId,plan_id planId,kind,amount_toman amountToman,created_at createdAt FROM goods_finance_ledger WHERE kind IN ('company_credit','development_discount') ORDER BY id DESC LIMIT 500")});
}));
router.get("/customers/:id/plan-credit-wallets",requirePermission("goods_purchases.view"),wrap((req,res)=>{
  const id=Number(req.params.id);assertGoodsCustomerScope(id,user(res));
  const items=queryRows<any>("SELECT w.plan_id planId,p.name planName,w.balance_toman balanceToman FROM goods_plan_wallets w JOIN loan_plans p ON p.id=w.plan_id WHERE w.customer_id=?",[id]);
  const archivedSourceWallets=queryRows<any>(`SELECT w.customer_id sourceCustomerId,w.plan_id planId,p.name planName,w.balance_toman balanceToman
    FROM customer_merge_audit a JOIN goods_plan_wallets w ON w.customer_id=a.source_customer_id
    JOIN loan_plans p ON p.id=w.plan_id WHERE a.survivor_customer_id=? ORDER BY a.created_at DESC,w.plan_id`,[id]);
  res.json({items,unassignedBalanceToman:unassignedGoodsCredit(id).toString(),archivedSourceWallets});
}));
export default router;
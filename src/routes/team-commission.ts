import { Router, type RequestHandler } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRow, queryRows } from "../lib/crm-db";
import {
  ensureTeamCommissionSchema, settingsAt, settingsView, saveSettings, listSettingsVersions, teamMembers, DEFAULT_SETTINGS,
  reversePurchaseCommission, retryPurchasePosting, runTeamBonus, dataAccuracyState, recordDataAccuracy, TeamCommissionError,
} from "../lib/team-commission";

ensureTeamCommissionSchema();
const router = Router();
const user = (res: any) => res.locals.authUser as AuthUser;
const wrap = (fn: (req: any, res: any) => void): RequestHandler => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof TeamCommissionError) { res.status(e.status).json({ error: e.message, errors: e.errors }); return; }
    const msg = e instanceof Error ? e.message : "team_commission_failed";
    res.status(msg === "Forbidden" ? 403 : /not_found/.test(msg) ? 404 : 422).json({ error: msg });
  }
};
const admin = (u: AuthUser) => { if (u.role !== "admin") throw new TeamCommissionError(403, "فقط مدیر سیستم دسترسی دارد."); };
const intId = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new TeamCommissionError(400, "شناسه نامعتبر است."); return n; };

function settingsPayload() {
  const v = settingsAt();
  const { qualifierId, closerIds } = teamMembers();
  const members = [...closerIds.map(id => ({ id, role: "closer" as const })), { id: qualifierId, role: "qualifier" as const }].map(m => {
    const sp = queryRow<any>("SELECT name FROM salespersons WHERE id=?", [m.id]);
    const t = queryRow<any>("SELECT * FROM goods_salesperson_settings WHERE salesperson_id=?", [m.id]);
    return { salespersonId: m.id, name: sp?.name ?? `#${m.id}`, role: m.role,
      tiers: t ? { rate0Bps: t.rate0_bps, rate1Bps: t.rate1_bps, rate2Bps: t.rate2_bps, rate3Bps: t.rate3_bps, target1Toman: t.target1_toman, target2Toman: t.target2_toman, target3Toman: t.target3_toman } : null };
  });
  return { versionId: v.versionId, effectiveAt: v.effectiveAt, settings: settingsView(v.settings), defaults: settingsView(DEFAULT_SETTINGS), members, versions: listSettingsVersions() };
}

router.get("/goods-finance/team-settings", requireAuth, wrap((req, res) => { admin(user(res)); res.setHeader("Cache-Control", "no-store"); res.json(settingsPayload()); }));
router.put("/goods-finance/team-settings", requireAuth, wrap((req, res) => {
  admin(user(res));
  saveSettings(req.body, user(res).id);
  res.json(settingsPayload());
}));
router.get("/goods-finance/team-commission/purchases", requireAuth, wrap((req, res) => {
  admin(user(res));
  const status = ["pending_payout", "posted", "reversed"].includes(String(req.query.status)) ? String(req.query.status) : null;
  res.json({ items: queryRows<any>(`SELECT t.purchase_id purchaseId,t.customer_id customerId,c.name customerName,t.salesperson_id salespersonId,s.name salespersonName,
      t.status,t.basis,t.posting_moment postingMoment,t.basis_amount_toman basisAmountToman,t.commission_month commissionMonth,t.closer_rate_bps closerRateBps,
      t.closer_commission_toman closerCommissionToman,t.p1_kind p1Kind,t.p1_share_bps p1ShareBps,t.p1_share_toman p1ShareToman,t.settings_version_id settingsVersionId,
      t.last_error lastError,t.entered_at enteredAt,t.posted_at postedAt,t.reversed_at reversedAt,t.reversal_month reversalMonth,t.reversal_reason reversalReason,
      o.id paymentOrderId,o.stage paymentOrderStage
    FROM team_commission_purchases t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN salespersons s ON s.id=t.salesperson_id
    LEFT JOIN customer_payment_orders o ON o.purchase_id=t.purchase_id
    ${status ? "WHERE t.status=?" : ""} ORDER BY t.entered_at DESC LIMIT 200`, status ? [status] : []) });
}));
router.post("/goods-finance/team-commission/purchases/:id/reverse", requireAuth, wrap((req, res) => {
  admin(user(res)); res.json(reversePurchaseCommission(intId(req.params.id), user(res).id, req.body?.reason));
}));
router.post("/goods-finance/team-commission/purchases/:id/post", requireAuth, wrap((req, res) => {
  admin(user(res)); res.json(retryPurchasePosting(intId(req.params.id), user(res).id));
}));
router.post("/goods-finance/team-bonus/run", requireAuth, wrap((req, res) => {
  admin(user(res)); res.json(runTeamBonus(String(req.body?.month ?? ""), user(res).id));
}));
router.get("/goods-finance/team-bonus/runs", requireAuth, wrap((req, res) => {
  admin(user(res));
  res.json({ items: queryRows<any>("SELECT month,settings_version_id settingsVersionId,team_sales_toman teamSalesToman,bonus_toman bonusToman,detail_json,created_at createdAt FROM team_bonus_runs ORDER BY month DESC LIMIT 24")
    .map(({ detail_json, ...r }) => ({ ...r, detail: JSON.parse(detail_json) })) });
}));
router.get("/customers/:id/data-accuracy", requireAuth, requirePermission("customers.view"), wrap((req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.json(dataAccuracyState(intId(req.params.id), user(res)));
}));
router.post("/customers/:id/data-accuracy", requireAuth, requirePermission("customers.view"), wrap((req, res) => {
  res.json(recordDataAccuracy(intId(req.params.id), user(res), req.body));
}));
export default router;

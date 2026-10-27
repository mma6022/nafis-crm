/**
 * Plan rate freshness API (PM 2026-10-28). Paths avoid /loan-plans/:id so the numeric-id routes stay untouched.
 * GET /loan-plan-rates                 rate + rate_updated_at per plan (loan_plans.view)
 * GET /loan-plan-rates/:planId/history history rows, newest first (loan_plans.view)
 * GET /loan-plan-rates/settings        { staleDays, warnDays } (loan_plans.view)
 * PUT /loan-plan-rates/settings        admin + loan_plans.manage; 1 ≤ warn < stale
 * GET /loan-plan-rates/alerts          admin only: open «به‌زودی کهنه می‌شود» / «کهنه شد» rows
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { queryRows } from "../lib/crm-db";
import { RATE_TYPE, getRateSettings, installPlanRates, openRateAlerts, saveRateSettings, validateRateSettings } from "../lib/plan-rates";

installPlanRates();
const router: IRouter = Router();
const isAdmin = (u: AuthUser | undefined) => u?.role === "admin";

router.get("/loan-plan-rates", requirePermission("loan_plans.view"), (_req, res): void => {
  const rows = queryRows<{ id: number; name: string; active: number; annual_interest: string | null; rate_updated_at: string | null }>(
    "SELECT id, name, active, annual_interest, rate_updated_at FROM loan_plans ORDER BY id");
  res.json({ type: RATE_TYPE, settings: getRateSettings(), items: rows.map((r) => ({ planId: Number(r.id), name: r.name, active: Number(r.active) === 1,
    annualInterest: r.annual_interest, rateUpdatedAt: r.rate_updated_at })) });
});

router.get("/loan-plan-rates/settings", requirePermission("loan_plans.view"), (_req, res): void => {
  res.json(getRateSettings());
});

router.put("/loan-plan-rates/settings", requirePermission("loan_plans.manage"), (req, res): void => {
  const user = res.locals.authUser as AuthUser | undefined;
  if (!isAdmin(user)) { res.status(403).json({ error: "admin_only", message: "فقط ادمین تنظیمات نرخ را تغییر می‌دهد." }); return; }
  const v = validateRateSettings(req.body);
  if (typeof v === "string") { res.status(400).json({ error: "invalid_rate_settings", message: v }); return; }
  saveRateSettings(v, user?.id ?? null);
  res.json(getRateSettings());
});

router.get("/loan-plan-rates/alerts", requirePermission("loan_plans.view"), (_req, res): void => {
  if (!isAdmin(res.locals.authUser as AuthUser | undefined)) { res.json({ items: [] }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ items: openRateAlerts() });
});

router.get("/loan-plan-rates/:planId/history", requirePermission("loan_plans.view"), (req, res): void => {
  const planId = Number(req.params.planId);
  if (!Number.isSafeInteger(planId) || planId < 1) { res.status(400).json({ error: "invalid_plan_id" }); return; }
  const rows = queryRows<{ id: number; old_value: string | null; new_value: string | null; changed_by: number | null; changed_by_name: string | null; changed_at: string; source: string }>(
    "SELECT id, old_value, new_value, changed_by, changed_by_name, changed_at, source FROM loan_plan_rate_history WHERE plan_id = ? ORDER BY id DESC LIMIT 100", [planId]);
  res.json({ items: rows.map((r) => ({ id: Number(r.id), oldValue: r.old_value, newValue: r.new_value, changedBy: r.changed_by == null ? null : Number(r.changed_by),
    changedByName: r.changed_by_name, changedAt: r.changed_at, source: r.source })) });
});

export default router;

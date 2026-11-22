/**
 * شاخص‌های KPI فروش (flag.sales_kpi_v1).
 * OFF (absent or anything but '1') → /me returns enabled:false, other routes 404.
 * Access is enforced server-side: admin + sales_manager see all; expert/trainee see self + team totals.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { requireAuth, getAuthenticatedUser, type AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import {
  SK_FLAG,
  skFlagOn,
  ensureSalesKpiSchema,
  mePayload,
  salesKpiReport,
  accessOf,
  isKpiEditor,
  readSettings,
  writeSettings,
  jalaliMonthKey,
  type SettingsPatch,
} from "../lib/sales-kpi";
import { dayNumber } from "../lib/sales-report";

const router: IRouter = Router();

function fail(res: Response, status: number, error: string, message?: string) {
  res.status(status).json({ error, ...(message ? { message } : {}) });
}

function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { fail(res, 401, "unauthenticated"); return; }
  res.locals.authUser = user;
  next();
}

function guarded(_req: Request, res: Response, next: NextFunction): void {
  if (!skFlagOn(crmDb)) { fail(res, 404, "not_found"); return; }
  ensureSalesKpiSchema(crmDb);
  next();
}

router.get("/sales-kpi/me", requireAuth, requireUser, (req, res) => {
  void req;
  res.setHeader("Cache-Control", "private, no-store");
  res.json(mePayload(crmDb, res.locals.authUser as AuthUser));
});

router.get("/sales-kpi", requireAuth, requireUser, guarded, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const u = res.locals.authUser as AuthUser;
  if (accessOf(u, crmDb) === "none") {
    fail(res, 403, "forbidden", "این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.");
    return;
  }
  const q: Record<string, string> = {};
  for (const key of ["period", "anchor", "from", "to"]) {
    const v = req.query[key];
    if (v !== undefined && typeof v !== "string") { fail(res, 400, "پارامتر گزارش معتبر نیست."); return; }
    if (typeof v === "string") q[key] = v;
  }
  let expertId: number | null = null;
  let teamId: number | null = null;
  if (req.query.expertId != null && req.query.expertId !== "") {
    const n = Number(req.query.expertId);
    if (!Number.isInteger(n) || n <= 0) { fail(res, 400, "کارشناس انتخاب‌شده معتبر نیست."); return; }
    expertId = n;
  }
  if (req.query.teamId != null && req.query.teamId !== "") {
    const n = Number(req.query.teamId);
    if (!Number.isInteger(n) || n <= 0) { fail(res, 400, "تیم انتخاب‌شده معتبر نیست."); return; }
    teamId = n;
  }
  try {
    res.json(salesKpiReport(crmDb, u, { ...q, expertId, teamId }));
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 403) { fail(res, 403, "forbidden", err.message); return; }
    if (err.status === 404) { fail(res, 404, "not_found", err.message); return; }
    if (err instanceof Error && /تاریخ|بازه|نوع بازه|تیم|کارشناس/.test(err.message)) { fail(res, 400, err.message); return; }
    throw e;
  }
});

router.get("/sales-kpi/settings", requireAuth, requireUser, guarded, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  if (!isKpiEditor(u, crmDb)) { fail(res, 403, "forbidden", "تنظیمات این گزارش فقط برای مدیر و مدیر فروش است."); return; }
  const periodKey = typeof req.query.periodKey === "string" && req.query.periodKey
    ? req.query.periodKey
    : jalaliMonthKey(dayNumber(new Date().toISOString()));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ periodKey, ...readSettings(crmDb, periodKey) });
});

router.put("/sales-kpi/settings", requireAuth, requireUser, guarded, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  if (!isKpiEditor(u, crmDb)) { fail(res, 403, "forbidden", "تنظیمات این گزارش فقط برای مدیر و مدیر فروش است."); return; }
  const body = (req.body || {}) as SettingsPatch;
  try {
    const saved = writeSettings(crmDb, body, u);
    const periodKey = body.targets?.[0]?.periodKey ?? jalaliMonthKey(dayNumber(new Date().toISOString()));
    res.json({ periodKey, ...saved });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 400) { fail(res, 400, err.message); return; }
    throw e;
  }
});

export default router;
void SK_FLAG;

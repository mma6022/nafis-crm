/**
 * گزارش عملکرد فروش routes (flag.sales_performance_v1).
 * OFF (absent or anything but '1') → 404. Access is enforced server-side.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { getAuthenticatedUser, type AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import {
  accessOf,
  mePayload,
  salesPerformanceReport,
  spFlagOn,
  ensureSalesPerformanceSchema,
  seedMembershipHistoryIfEmpty,
} from "../lib/sales-performance";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;

function gate(req: Request, res: Response, next: NextFunction) {
  if (!spFlagOn(crmDb)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { res.status(401).json({ error: "unauthenticated" }); return; }
  res.locals.authUser = user;
  ensureSalesPerformanceSchema(crmDb);
  seedMembershipHistoryIfEmpty(crmDb);
  next();
}

router.get("/sales-performance/me", gate, (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const u = me(res);
  const payload = mePayload(crmDb, u);
  if (!payload.canView) { res.status(403).json({ error: "forbidden", message: "گزارش عملکرد فروش برای این نقش نیست." }); return; }
  res.json(payload);
});

router.get("/sales-performance", gate, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const u = me(res);
  if (accessOf(u, crmDb) === "none") {
    res.status(403).json({ error: "forbidden", message: "گزارش عملکرد فروش برای این نقش نیست." });
    return;
  }
  const q: Record<string, string> = {};
  for (const key of ["period", "anchor", "from", "to", "view", "metric"]) {
    const v = req.query[key];
    if (v !== undefined && typeof v !== "string") { res.status(400).json({ error: "پارامتر گزارش معتبر نیست." }); return; }
    if (typeof v === "string") q[key] = v;
  }
  let expertId: number | null = null;
  if (req.query.expertId != null && req.query.expertId !== "") {
    const n = Number(req.query.expertId);
    if (!Number.isInteger(n) || n <= 0) { res.status(400).json({ error: "کارشناس انتخاب‌شده معتبر نیست." }); return; }
    expertId = n;
  }
  try {
    const report = salesPerformanceReport(crmDb, u, { ...q, expertId });
    res.json(report);
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 403) { res.status(403).json({ error: "forbidden", message: "مشاهده گزارش کارشناس دیگر مجاز نیست." }); return; }
    if (err.status === 404) { res.status(404).json({ error: "not_found", message: "کارشناس پیدا نشد." }); return; }
    if (err instanceof Error && /تاریخ|بازه|نمودار|نوع بازه/.test(err.message)) { res.status(400).json({ error: err.message }); return; }
    throw e;
  }
});

export default router;

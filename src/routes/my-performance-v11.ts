/**
 * عملکرد من v1.1 routes (flag.my_performance_v1).
 * OFF (absent or anything but '1') → 404. Payload is always the caller's own report
 * (rank + team averages only; never colleagues' names).
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { getAuthenticatedUser, type AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { mpFlagOnDb, myWorkMePayload, myWorkReport } from "../lib/my-performance-v11";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;

function gate(req: Request, res: Response, next: NextFunction) {
  if (!mpFlagOnDb(crmDb)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { res.status(401).json({ error: "unauthenticated" }); return; }
  res.locals.authUser = user;
  next();
}

router.get("/my-work/me", gate, (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const payload = myWorkMePayload(crmDb, me(res));
  if (!payload.canView) { res.status(403).json({ error: "forbidden", message: "عملکرد من برای این نقش نیست." }); return; }
  res.json(payload);
});

router.get("/my-work", gate, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const u = me(res);
  const q: Record<string, string> = {};
  for (const key of ["period", "anchor", "from", "to"]) {
    const v = req.query[key];
    if (v !== undefined && typeof v !== "string") { res.status(400).json({ error: "پارامتر گزارش معتبر نیست." }); return; }
    if (typeof v === "string") q[key] = v;
  }
  try {
    res.json(myWorkReport(crmDb, u, q));
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 403) { res.status(403).json({ error: "forbidden", message: "مشاهده این گزارش مجاز نیست." }); return; }
    if (err.status === 404) { res.status(404).json({ error: "not_found" }); return; }
    if (err instanceof Error && /تاریخ|بازه|نوع بازه/.test(err.message)) { res.status(400).json({ error: err.message }); return; }
    throw e;
  }
});

export default router;

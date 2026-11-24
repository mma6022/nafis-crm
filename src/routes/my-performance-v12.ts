/**
 * عملکرد من v1.2 routes (flag.my_performance_v12).
 * OFF → 404. Expert payload never includes colleague names or scores.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { getAuthenticatedUser, type AuthUser } from "../lib/auth";
import { crmDb } from "../lib/crm-db";
import { mpV12FlagOnDb, myWorkCallReport, myWorkKpiReport } from "../lib/my-performance-v12";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;

function gate(_req: Request, res: Response, next: NextFunction) {
  if (!mpV12FlagOnDb(crmDb)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(_req);
  if (!user) { res.status(401).json({ error: "unauthenticated" }); return; }
  res.locals.authUser = user;
  next();
}

function queryOf(req: Request, keys: string[]): Record<string, string> | { error: string } {
  const q: Record<string, string> = {};
  for (const key of keys) {
    const v = req.query[key];
    if (v !== undefined && typeof v !== "string") return { error: "پارامتر گزارش معتبر نیست." };
    if (typeof v === "string") q[key] = v;
  }
  return q;
}

function sendErr(res: Response, e: unknown): boolean {
  const err = e as Error & { status?: number };
  if (err.status === 403) { res.status(403).json({ error: "forbidden", message: "مشاهده این گزارش مجاز نیست." }); return true; }
  if (err.status === 404) { res.status(404).json({ error: "not_found" }); return true; }
  if (err instanceof Error && /تاریخ|بازه|نوع بازه/.test(err.message)) { res.status(400).json({ error: err.message }); return true; }
  return false;
}

router.get("/my-work/kpis", gate, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const q = queryOf(req, ["period", "anchor", "from", "to"]);
  if ("error" in q) { res.status(400).json({ error: q.error }); return; }
  try { res.json(myWorkKpiReport(crmDb, me(res), q)); }
  catch (e) { if (!sendErr(res, e)) throw e; }
});

router.get("/my-work/calls", gate, (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const q = queryOf(req, ["period", "anchor", "from", "to", "direction", "result", "q", "waiting", "page"]);
  if ("error" in q) { res.status(400).json({ error: q.error }); return; }
  try { res.json(myWorkCallReport(crmDb, me(res), q)); }
  catch (e) { if (!sendErr(res, e)) throw e; }
});

export default router;

/** SALES-SHELL v2: the per-user flag read + spec §9 GET /nav-badges. Read-only. */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { ssNavBadges, ssOn } from "../lib/sales-shell";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser | undefined;
router.get("/sales-shell/me", (_req, res) => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ v2: ssOn(Number(u.id)) });
});
router.get("/nav-badges", (_req, res) => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  if (!ssOn(Number(u.id))) { res.status(404).json({ error: "not_found" }); return; }
  res.json(ssNavBadges(u));
});
export default router;

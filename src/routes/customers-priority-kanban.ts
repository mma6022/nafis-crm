/** customers-priority-kanban v1: flag probe only. OFF (absent/≠'1') → 404. No writes. */
import { Router, type IRouter, type RequestHandler, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { cpkOn } from "../lib/customers-priority-kanban";

const router: IRouter = Router();
const cpkGate: RequestHandler = (_req, _res, next): void => { if (cpkOn()) next(); else next("route"); };
const me = (res: Response) => res.locals.authUser as AuthUser | undefined;

router.get("/customers-priority-kanban/me", cpkGate, (_req, res): void => {
  const u = me(res);
  if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ enabled: true });
});

export default router;

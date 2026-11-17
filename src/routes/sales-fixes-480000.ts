/** SALES-FIXES 480000: centred search (enamad-style overlay) + «مشتریان من» for sales experts. Read-only; own customers only. */
import { Router, type IRouter } from "express";
import type { AuthUser } from "../lib/auth";
import { sf480MyCustomers, sf480NoPopups, sf480OpenLists, sf480OwnerPriority, sf480OwnerStatus, sf480Search, sf480Cases } from "../lib/sales-fixes-480000";

const router: IRouter = Router();
const me = (res: any) => res.locals.authUser as AuthUser | undefined;
router.get("/sales-fixes/me", (_req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.json({ openLists: sf480OpenLists(), noPopups: sf480NoPopups(), ownerPriority: sf480OwnerPriority(), ownerStatus: sf480OwnerStatus() });
});
router.get("/sales-fixes/search", (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const r = sf480Search(u as any, req.query?.q); res.status(r.status).json(r.body);
});
router.get("/sales-fixes/my-customers", (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const r = sf480MyCustomers(u as any, req.query?.q, req.query?.offset, req.query as Record<string, unknown>); res.status(r.status).json(r.body);
});
router.get("/sales-fixes/cases", (_req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const r = sf480Cases(u as any); res.status(r.status).json(r.body);
});
export default router;

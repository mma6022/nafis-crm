/** plan-advisor v1 (flag.plan_advisor_v1). OFF → every handler falls through = 404. */
import { Router, type IRouter, type RequestHandler } from "express";
import type { AuthUser } from "../lib/auth";
import { paOn, paQuote, paSuggest, paSaveChips, paSearchCustomers, paCustomerExists, ensurePaSchema } from "../lib/plan-advisor";
import { elTarget, elFlagOn, elCustomerAccess, elOwnCustomer } from "../lib/expert-lockdown";

const router: IRouter = Router();
const gate: RequestHandler = (_req, _res, next): void => { if (paOn()) { ensurePaSchema(); next(); } else next("route"); };
const me = (res: any) => res.locals.authUser as AuthUser | undefined;

function canSee(u: AuthUser, customerId: number): boolean {
  if (u.role === "admin" || u.role === "manager") return paCustomerExists(customerId);
  if (elTarget(u as any) && elFlagOn()) return elCustomerAccess(u as any, customerId) || elOwnCustomer(u as any, customerId);
  if (u.salespersonId == null) return false;
  return elOwnCustomer(u as any, customerId) || paCustomerExists(customerId) && elOwnCustomer(u as any, customerId);
}

function lockedExpert(u: AuthUser): boolean {
  return Boolean(elTarget(u as any) && elFlagOn());
}

router.get("/plan-advisor/me", gate, (_req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ enabled: true });
});

router.get("/plan-advisor/suggest", gate, (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const id = Number(req.query.customerId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_customer" }); return; }
  if (!canSee(u, id)) { res.status(403).json({ error: "forbidden", message: "این مشتری برای شما باز نیست." }); return; }
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const { answers: _a, ...body } = paSuggest(id);
    res.json(body);
  } catch (e: any) {
    res.status(e?.status === 404 ? 404 : 400).json({ error: e?.message === "not_found" ? "not_found" : "suggest_failed" });
  }
});

router.get("/plan-advisor/quote", gate, (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const planId = Number(req.query.planId);
  const principal = Number(String(req.query.principal ?? "").replace(/[^\d]/g, ""));
  const months = Number(req.query.term ?? req.query.months);
  const customerId = req.query.customerId != null ? Number(req.query.customerId) : null;
  if (customerId && !canSee(u, customerId)) { res.status(403).json({ error: "forbidden" }); return; }
  const q = paQuote(planId, principal, months);
  if ("error" in q) { res.status(400).json(q); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(q);
});

router.patch("/plan-advisor/conditions", gate, (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const id = Number((req.body as any)?.customerId ?? req.query.customerId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "invalid_customer" }); return; }
  if (!canSee(u, id)) { res.status(403).json({ error: "forbidden" }); return; }
  const patch = ((req.body as any)?.patch && typeof (req.body as any).patch === "object") ? (req.body as any).patch : (req.body as any);
  const { answers: _a, ...body } = paSaveChips(id, Number(u.id), patch ?? {});
  res.json(body);
});

router.get("/plan-advisor/customers", gate, (req, res): void => {
  const u = me(res); if (!u) { res.status(401).json({ error: "unauthorized" }); return; }
  const q = String(req.query.q ?? "");
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ items: paSearchCustomers(u as any, q, lockedExpert(u)) });
});

export default router;

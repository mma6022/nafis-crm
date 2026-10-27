/**
 * crm-default-owner admin API («قانون ثبت مشتری» + «ثبت‌شده‌ها بر اساس ثبت‌کننده»). Admin only (user 29 never).
 * GET  /admin/default-owner-rule           settings + options (active salespersons, registrars, sources)
 * PUT  /admin/default-owner-rule           save settings (validated, logged old → new)
 * GET  /admin/registered-by?from&to        counts by registrar + source (no customer ids / names / phones)
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { crmDb, queryRows } from "../lib/crm-db";
import { DEFAULT_OWNER_EXCLUDED_USER_IDS, REGISTRATION_SOURCES, getDefaultOwnerConfig, saveDefaultOwnerConfig, validateDefaultOwnerConfig } from "../lib/default-owner-rule";
import { registeredByRange, registeredByReport } from "../lib/registered-by-report";
import { excludeTestOn } from "../lib/test-customers";

const router: IRouter = Router();
const isAdmin = (u: AuthUser | undefined) => u?.role === "admin" && !DEFAULT_OWNER_EXCLUDED_USER_IDS.includes(Number(u.id));
const guard = requirePermission("customers.view");

function options() {
  return {
    salespersons: queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons WHERE active=1 ORDER BY id").map((s) => ({ id: Number(s.id), name: s.name })),
    registrars: queryRows<{ id: number; full_name: string | null; username: string; role: string; salesperson_id: number | null }>(
      "SELECT id, full_name, username, role, salesperson_id FROM users WHERE active=1 ORDER BY id")
      .filter((u) => !DEFAULT_OWNER_EXCLUDED_USER_IDS.includes(Number(u.id)))
      .map((u) => ({ id: Number(u.id), name: u.full_name || u.username, role: u.role, salespersonId: u.salesperson_id == null ? null : Number(u.salesperson_id) })),
    sources: Object.entries(REGISTRATION_SOURCES).map(([key, label]) => ({ key, label, reserved: key === "assistant" || key === "api" })),
  };
}

router.get("/admin/default-owner-rule", guard, (_req, res) => {
  if (!isAdmin(res.locals.authUser as AuthUser)) { res.status(403).json({ error: "forbidden" }); return; }
  res.json({ settings: getDefaultOwnerConfig(), options: options() });
});

router.put("/admin/default-owner-rule", guard, (req, res) => {
  const u = res.locals.authUser as AuthUser;
  if (!isAdmin(u)) { res.status(403).json({ error: "forbidden" }); return; }
  const v = validateDefaultOwnerConfig(req.body);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  saveDefaultOwnerConfig(v.config, Number(u.id), "admin_page");
  res.json({ settings: getDefaultOwnerConfig(), options: options() });
});

router.get("/admin/registered-by", guard, (req, res) => {
  if (!isAdmin(res.locals.authUser as AuthUser)) { res.status(403).json({ error: "forbidden" }); return; }
  const r = registeredByRange({ from: req.query.from, to: req.query.to }, new Date());
  if ("error" in r) { res.status(400).json({ error: r.error }); return; }
  res.json(registeredByReport(crmDb, r, { excludeTest: excludeTestOn(crmDb) }));
});

export default router;

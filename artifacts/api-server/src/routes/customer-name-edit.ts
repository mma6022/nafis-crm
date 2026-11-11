/**
 * ویرایش نام مشتری routes (flag.customer_name_edit, default OFF → 404).
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import {
  CNE_MSG, CNE_OFF, cneFlagOn, cneLoadCustomer, cnePatch, cneView, ensureCneSchema,
} from "../lib/customer-name-edit";

const router: IRouter = Router();

function actor(res: { locals: { authUser?: AuthUser } }): AuthUser | undefined {
  return res.locals.authUser;
}

router.get("/customers/:id/name-edit", requirePermission("customers.view"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = actor(res);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!cneFlagOn()) { res.status(404).json({ error: CNE_OFF, message: CNE_MSG.off }); return; }
  const id = Number(req.params.id);
  const row = cneLoadCustomer(id);
  if (!row) { res.status(404).json({ error: "not_found", message: CNE_MSG.notFound }); return; }
  ensureCneSchema();
  res.json(cneView(user, row));
});

router.patch("/customers/:id/name", requirePermission("customers.update"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = actor(res);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  try {
    const result = cnePatch(user, id, req.body ?? {});
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        message: result.message,
        ...(result.field ? { field: result.field } : {}),
      });
      return;
    }
    res.json({
      id: result.id,
      name: result.name,
      firstName: result.firstName,
      lastName: result.lastName,
      unchanged: result.unchanged,
      identityVerified: result.identityVerified,
      history: result.history,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code === "CNE_STALE") {
      res.status(409).json({ error: "stale", message: CNE_MSG.verified });
      return;
    }
    req.log?.error?.({ errorType: err instanceof Error ? err.name : "unknown" }, "customer name edit failed");
    res.status(500).json({ error: "save_failed", message: CNE_MSG.server });
  }
});

export default router;

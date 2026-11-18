/**
 * Extra customer mobile numbers (t853u). customers.phone stays the primary number.
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { elCustomerAccess, elFlagOn, elTarget } from "../lib/expert-lockdown";
import { redactForeignCustomer } from "../lib/cross-owner-search";
import {
  addCustomerPhone,
  deleteCustomerPhone,
  duplicatePhoneMessage,
  listCustomerPhones,
} from "../lib/customer-phones";

const router: IRouter = Router();

function actor(res: { locals: { authUser?: AuthUser } }): AuthUser | undefined {
  return res.locals.authUser;
}
function lockdownAccess(user: AuthUser, customerId: number): boolean {
  return Boolean(elFlagOn() && elTarget(user) && elCustomerAccess(user, customerId));
}


router.get("/customers/:id/phones", requirePermission("customers.view"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = actor(res);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "bad_customer", message: "مشتری معتبر نیست." }); return; }
  const result = listCustomerPhones(user, id, lockdownAccess(user, id));
  if (!result.ok) { res.status(result.status).json({ error: result.error, message: result.message }); return; }
  res.json(result.view);
});

router.post("/customers/:id/phones", requirePermission("customers.update"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = actor(res);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "bad_customer", message: "مشتری معتبر نیست." }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = addCustomerPhone(user, id, body.phone, body.label, new Date(), lockdownAccess(user, id));
  if (!result.ok) {
    const payload: Record<string, unknown> = { error: result.error, message: result.message, code: result.error };
    if (result.field) payload.field = result.field;
    if (result.customer) {
      const rawCustomer = {
        id: result.customer.id,
        name: result.customer.name,
        phone: result.customer.salespersonName, // placeholder replaced below; kept out of FOREIGN_KEEP except id/name/owner
        salespersonId: result.customer.salespersonId,
        salespersonName: result.customer.salespersonName,
        status: result.customer.status,
        priority: null,
        isUrgent: false,
        createdAt: null,
        activityCount: 0,
        pendingRepeatRequestCount: 0,
        mergedIntoCustomerId: result.customer.mergedIntoCustomerId,
      } as Record<string, unknown>;
      rawCustomer.phone = null;
      const redacted = redactForeignCustomer(user, rawCustomer);
      payload.customer = redacted;
      if (redacted?.name) {
        payload.message = duplicatePhoneMessage(String(redacted.name), (redacted.salespersonName as string | null) ?? result.customer.salespersonName);
      }
    }
    res.status(result.status).json(payload);
    return;
  }
  res.status(201).json(result.view);
});

router.delete("/customers/:id/phones/:phoneId", requirePermission("customers.update"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = actor(res);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  const phoneId = Number(req.params.phoneId);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "bad_customer", message: "مشتری معتبر نیست." }); return; }
  const result = deleteCustomerPhone(user, id, phoneId, lockdownAccess(user, id));
  if (!result.ok) { res.status(result.status).json({ error: result.error, message: result.message, code: result.error }); return; }
  res.json(result.view);
});

export default router;

/** REMINDERS-FOLLOW read feeds (server only; Armita's UI later). Read-only: nothing here writes. */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRow } from "../lib/crm-db";
import { maskCustomerName } from "../lib/cross-owner-search";
import { CUSTOMER_STATUS_LABELS, REMINDER_STATUS_LABELS, rfCustomerHistory, rfHandoffsFor, rfMyOpenReminders, rfOpenReminder } from "../lib/reminder-follow";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
/** Same visibility as the customer page: all-scope users see every customer; assigned-scope only their own (not merged). */
function canSee(u: AuthUser, customerId: number): boolean {
  const c = queryRow<{ salesperson_id: number | null; merged: number | null }>("SELECT salesperson_id, merged_into_customer_id merged FROM customers WHERE id=?", [customerId]);
  if (!c) return false;
  if (u.customerScope !== "assigned") return true;
  return c.merged == null && u.salespersonId != null && Number(c.salesperson_id) === Number(u.salespersonId);
}

router.get("/reminders/labels", (_req, res) => { res.json({ customerStatus: CUSTOMER_STATUS_LABELS, reminderStatus: REMINDER_STATUS_LABELS }); });
/** The caller's own open reminders with creator, note (≤80), «منتقل‌شده از» and replace fields. */
router.get("/reminders/follow-feed", requirePermission("reminders.view"), (_req, res) => { res.json({ items: rfMyOpenReminders(me(res).id) }); });
/** HANDOFF item 13: read-only «واگذارشده‌ها» of the caller (rows expire 7 days after the hand-off). */
router.get("/reminders/handoffs", requirePermission("reminders.view"), (_req, res) => { res.json({ items: rfHandoffsFor(me(res).id, maskCustomerName) }); });
/** HANDOFF item 12: the customer's single open reminder (creator + time) for the pre-save notice. */
router.get("/customers/:id/open-reminder", requirePermission("reminders.view"), (req, res) => {
  const id = idOf(req.params.id); if (!id || !canSee(me(res), id)) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json({ customerId: id, open: rfOpenReminder(id) });
});
/** History: every reminder of the customer (completed / cancelled / replaced with replaced_by, transferred_from) + reactivations. */
router.get("/customers/:id/reminder-history", requirePermission("reminders.view"), (req, res) => {
  const id = idOf(req.params.id); if (!id || !canSee(me(res), id)) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json(rfCustomerHistory(id));
});
export default router;

import { Router, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import {
  MAX_NOTES, assignCallback, callbackAssignees, callbackCounts, callbackEvents, convertCallback, getCallback, isCallbackStatus,
  listCallbacks, setCallbackNotes, setCallbackStatus, type CallbackActor, type CallbackError, type CallbackResult,
} from "../lib/callback-requests";

/** Staff API for «درخواست‌های تماس». Mounted under the authenticated /api router. */
const router = Router();
const view = requirePermission("callbacks.view");
const manage = [requirePermission("callbacks.view"), requirePermission("callbacks.manage")];

function actorOf(res: Response): CallbackActor {
  const user = res.locals.authUser as AuthUser;
  return { id: user.id, role: user.role, permissions: user.permissions, customerScope: user.customerScope };
}

function idOf(req: Request): number | undefined {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

const STATUS_OF: Record<CallbackError, number> = {
  not_found: 404, invalid_transition: 409, forbidden: 403, invalid_assignee: 400, already_converted: 409, cancelled: 409,
};

function send(res: Response, result: CallbackResult): void {
  if (!result.ok) {
    res.status(STATUS_OF[result.error]).json({ error: result.error });
    return;
  }
  res.json({ item: result.item, ...(result.created !== undefined ? { created: result.created } : {}) });
}

router.get("/callback-requests", view, (req, res): void => {
  const actor = actorOf(res);
  const v = req.query.view === "closed" ? "closed" : "open";
  res.json({ items: listCallbacks(actor, v), counts: callbackCounts(actor) });
});

router.get("/callback-requests/badge", view, (_req, res): void => {
  res.json({ new: callbackCounts(actorOf(res)).new });
});

router.get("/callback-requests/assignees", view, (_req, res): void => {
  res.json({ items: callbackAssignees() });
});

router.get("/callback-requests/:id", view, (req, res): void => {
  const id = idOf(req);
  const item = id ? getCallback(actorOf(res), id) : undefined;
  if (!item) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ item, events: callbackEvents(item.id) });
});

router.patch("/callback-requests/:id/status", ...manage, (req, res): void => {
  const id = idOf(req);
  const status = (req.body as { status?: unknown } | undefined)?.status;
  if (!id || !isCallbackStatus(status)) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  send(res, setCallbackStatus(actorOf(res), id, status));
});

router.patch("/callback-requests/:id/assign", ...manage, (req, res): void => {
  const id = idOf(req);
  const raw = (req.body as { userId?: unknown } | undefined)?.userId;
  const userId = raw === null ? null : typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  if (!id || userId === undefined) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  send(res, assignCallback(actorOf(res), id, userId));
});

router.patch("/callback-requests/:id/notes", ...manage, (req, res): void => {
  const id = idOf(req);
  const notes = (req.body as { notes?: unknown } | undefined)?.notes;
  if (!id || typeof notes !== "string" || notes.length > MAX_NOTES) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  send(res, setCallbackNotes(actorOf(res), id, notes));
});

router.post("/callback-requests/:id/convert", ...manage, (req, res): void => {
  const id = idOf(req);
  if (!id) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  // No notifyNewCustomer here on purpose: website leads must not trigger the customer SMS. The staff Telegram
  // alert for callbacks is wired to the website-lead alert (with preferredTime) once that lands on feat/public-leads.
  send(res, convertCallback(actorOf(res), id));
});

export default router;

import { Router, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { CALLBACK_CONFIG } from "../lib/callback-config";
import {
  MAX_NOTE, addCallbackNote, assignCallback, callbackAssignees, callbackCounts, callbackEvents, can, canSeePhone, convertCallback,
  getCallback, isCallbackStatus, isCancelReason, listCallbacks, recordContact, setCallbackStatus,
  type CallbackActor, type CallbackError, type CallbackFilter, type CallbackResult,
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
  cancel_reason_required: 400, max_attempts: 409, too_soon: 409, already_assigned: 409,
};

function send(res: Response, result: CallbackResult): void {
  if (!result.ok) {
    res.status(STATUS_OF[result.error]).json({ error: result.error, ...(result.retryAt ? { retryAt: result.retryAt } : {}) });
    return;
  }
  res.json({
    item: result.item,
    events: callbackEvents(result.item.id),
    ...(result.created !== undefined ? { created: result.created } : {}),
    ...(result.phone !== undefined ? { phone: result.phone } : {}),
  });
}

function meta(actor: CallbackActor) {
  return {
    slaMinutes: CALLBACK_CONFIG.slaMinutes,
    maxAttempts: CALLBACK_CONFIG.maxAttempts,
    minAttemptGapMinutes: CALLBACK_CONFIG.minAttemptGapMinutes,
    canManage: can(actor, "callbacks.manage"),
    canAssign: can(actor, "callbacks.assign"),
    canSeePhone: canSeePhone(actor),
    canConvert: can(actor, "callbacks.manage"),
    me: actor.id,
  };
}

router.get("/callback-requests", view, (req, res): void => {
  const actor = actorOf(res);
  const status = isCallbackStatus(req.query.status) ? req.query.status : "all";
  const who = req.query.who === "me" || req.query.who === "none" ? req.query.who : "all";
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 60) : undefined;
  const filter: CallbackFilter = { status, who, q };
  res.json({ items: listCallbacks(actor, filter), counts: callbackCounts(actor), meta: meta(actor) });
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
  const body = (req.body ?? {}) as { status?: unknown; cancelReason?: unknown };
  if (!id || !isCallbackStatus(body.status) || (body.cancelReason != null && !isCancelReason(body.cancelReason))) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  send(res, setCallbackStatus(actorOf(res), id, body.status, { cancelReason: isCancelReason(body.cancelReason) ? body.cancelReason : null }));
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

router.post("/callback-requests/:id/notes", ...manage, (req, res): void => {
  const id = idOf(req);
  const text = (req.body as { text?: unknown } | undefined)?.text;
  if (!id || typeof text !== "string" || !text.trim() || text.length > MAX_NOTE) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  send(res, addCallbackNote(actorOf(res), id, text));
});

/** Reveal the full number / start a call: both logged in the request's history (needs customers.view). */
for (const action of ["reveal", "call"] as const) {
  router.post(`/callback-requests/:id/${action}`, view, (req, res): void => {
    const id = idOf(req);
    if (!id) {
      res.status(400).json({ error: "invalid" });
      return;
    }
    send(res, recordContact(actorOf(res), id, action));
  });
}

router.post("/callback-requests/:id/convert", ...manage, (req, res): void => {
  const id = idOf(req);
  if (!id) {
    res.status(400).json({ error: "invalid" });
    return;
  }
  // No notifyNewCustomer here on purpose: website requests must not trigger the customer SMS.
  send(res, convertCallback(actorOf(res), id));
});

export default router;

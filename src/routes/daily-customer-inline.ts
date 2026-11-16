/**
 * daily-customer-inline v1.1 API. Flag OFF → status {enabled:false}, other routes 404 dci_off.
 * Does not register popup / csfields / ReminderMust / STT handlers.
 */
import { Router } from "express";
import { getAuthenticatedUser, type AuthUser } from "../lib/auth";
import type { RequestHandler } from "express";
import {
  DCI_OFF, DCI_OFF_MESSAGE, dciAccess, dciAddNote, dciBoard, dciDeniedBody, dciFlagOn,
  dciTodayTimeline, dciInboundCustomerId, dciSaveInboundNote, ensureDciSchema, dciHasExtension,
} from "../lib/daily-customer-inline";
import { DQ_OFF, dqFlagOn, dqManualOutgoing, dqMarkDone, dqNameUnknown, dqQueue } from "../lib/dci-queue";

const router = Router();
const actor = (res: { locals: { authUser?: AuthUser } }) => res.locals.authUser as AuthUser;
const dciAuth: RequestHandler = (req, res, next) => {
  const user = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!user) { res.status(401).json({ code: "unauthorized", error: "Unauthorized" }); return; }
  res.locals.authUser = user;
  next();
};

const off = (res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).json({ error: DCI_OFF, message: DCI_OFF_MESSAGE, enabled: false });
};

router.get("/daily-customer-inline/status", dciAuth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: dciFlagOn(actor(res)?.id) });
});

router.get("/daily-customer-inline/today", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id)) return off(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: true, ...dciTodayTimeline(user) });
});

router.get("/daily-customer-inline/customers/:id", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id)) return off(res);
  const customerId = Number(req.params.id);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    res.status(404).json({ error: "customer_not_found", message: "مشتری پیدا نشد." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const task = typeof req.query.task === "string" ? req.query.task : null;
  const board = dciBoard(user, customerId, task);
  if (board.access === "missing") {
    res.status(404).json({ error: "customer_not_found", message: "مشتری پیدا نشد." });
    return;
  }
  if (board.access === "denied") {
    res.status(403).json(board.denied ?? dciDeniedBody(customerId));
    return;
  }
  res.json({ enabled: true, ...board });
});

router.post("/daily-customer-inline/customers/:id/notes", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id)) return off(res);
  const customerId = Number(req.params.id);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    res.status(404).json({ error: "customer_not_found" });
    return;
  }
  const access = dciAccess(user, customerId);
  if (access === "missing") { res.status(404).json({ error: "customer_not_found" }); return; }
  if (access === "denied") { res.status(403).json(dciDeniedBody(customerId)); return; }
  ensureDciSchema();
  try {
    const notes = dciAddNote(customerId, user.id, String(req.body?.body ?? req.body?.note ?? ""));
    res.json({ ok: true, notes });
  } catch (e: any) {
    if (e?.code === "empty_note") { res.status(400).json({ error: "empty_note", message: "یادداشت خالی است." }); return; }
    throw e;
  }
});

router.post("/daily-customer-inline/inbounds/:id/note", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id)) return off(res);
  const eventId = Number(req.params.id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const customerId = dciInboundCustomerId(eventId);
  if (customerId == null) { res.status(404).json({ error: "not_found" }); return; }
  const access = dciAccess(user, customerId);
  if (access === "missing") { res.status(404).json({ error: "not_found" }); return; }
  if (access === "denied") { res.status(403).json(dciDeniedBody(customerId)); return; }
  try {
    dciSaveInboundNote(eventId, user.id, String(req.body?.body ?? req.body?.note ?? ""));
  } catch (e: any) {
    if (e?.code === "empty_note") { res.status(400).json({ error: "empty_note", message: "یادداشت خالی است." }); return; }
    throw e;
  }
  res.json({ ok: true, customerId });
});

// DCI-QUEUE v2.1–v2.3.1 (flag.dci_queue_v21[.user.<id>]; OFF → 404 dq_off and the page keeps the v2.0 timeline).
const dqOff = (res: any) => { res.setHeader("Cache-Control", "no-store"); res.status(404).json({ error: DQ_OFF, enabled: false }); };
router.get("/daily-customer-inline/queue", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id) || !dqFlagOn(user.id)) return dqOff(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: true, hasExtension: dciHasExtension(user.id), ...dqQueue(user) });
});
router.post("/daily-customer-inline/queue/done", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id) || !dqFlagOn(user.id)) return dqOff(res);
  const r = dqMarkDone(user, req.body); res.status(r.status).json(r.body);
});
router.post("/daily-customer-inline/queue/outgoing", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id) || !dqFlagOn(user.id)) return dqOff(res);
  const r = dqManualOutgoing(user, req.body); res.status(r.status).json(r.body);
});
router.post("/daily-customer-inline/queue/unknown/:eventId/name", dciAuth, (req, res) => {
  const user = actor(res);
  if (!dciFlagOn(user.id) || !dqFlagOn(user.id)) return dqOff(res);
  const id = Number(req.params.eventId);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(404).json({ error: "not_found" }); return; }
  const r = dqNameUnknown(user, id, req.body); res.status(r.status).json(r.body);
});

export default router;

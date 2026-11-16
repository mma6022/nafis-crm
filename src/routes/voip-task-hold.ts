/**
 * VOIP-TASK-HOLD endpoints (see lib/voip-task-hold.ts). flag.voip_task_hold_v1[.user.<id>] OFF → 404 voip_task_hold_off.
 */
import { Router, type IRouter } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { vthFlagOn, vthContext, vthStatusRetry, vthSaveResult, vthManualEnd, vthMePayload, ensureVthSchema } from "../lib/voip-task-hold";
import { queryRow } from "../lib/crm-db";

const router: IRouter = Router();
const me = (res: any): AuthUser => res.locals.user as AuthUser;
const off = (res: any): boolean => {
  if (vthFlagOn(me(res).id)) return false;
  res.status(404).json({ error: "voip_task_hold_off", message: "حفظ کار در تماس فعال نیست.", enabled: false }); return true;
};

router.get("/voip-task-hold/meta", requirePermission("calls.view"), (_req, res) => {
  const u = me(res);
  if (!vthFlagOn(u.id)) return void res.json({ on: false });
  ensureVthSchema();
  const call = queryRow<any>("SELECT * FROM voip_click_calls WHERE user_id=? AND (active=1 OR (dismissed_at IS NULL AND result_saved_at IS NULL)) ORDER BY active DESC, id DESC LIMIT 1", [u.id]);
  res.json({ on: true, ...(vthMePayload(u, call) ?? {}) });
});

router.get("/voip-task-hold/context", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  const cid = Number(req.query.customerId);
  if (!Number.isSafeInteger(cid) || cid <= 0) return void res.status(400).json({ error: "bad_customer", message: "مشتری معتبر نیست." });
  res.json(vthContext(me(res) as any, cid));
});

router.post("/voip-task-hold/:id/status-retry", requirePermission("calls.view"), async (req, res) => {
  if (off(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_call", message: "تماس معتبر نیست." });
  const r = await vthStatusRetry(me(res) as any, id);
  res.status(r.status).json(r.body);
});

router.post("/voip-task-hold/:id/result", requirePermission("calls.create"), (req, res) => {
  if (off(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_call", message: "تماس معتبر نیست." });
  const r = vthSaveResult(me(res) as any, id, req.body ?? {});
  res.status(r.status).json(r.body);
});

/** Server prep only (t984s4140). No client UI until Armita's design arrives. */
router.post("/voip-task-hold/:id/manual-end", requirePermission("calls.create"), (req, res) => {
  if (off(res)) return;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return void res.status(400).json({ error: "bad_call", message: "تماس معتبر نیست." });
  const r = vthManualEnd(me(res) as any, id);
  res.status(r.status).json(r.body);
});

export default router;

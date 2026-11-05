/**
 * REMINDER-VOIP endpoints (see lib/reminder-voip.ts). flag.reminder_voip[.user.<id>] OFF → 404 reminder_voip_off for every route.
 * No SMS, Bale, bell or staff notification. The call itself is the existing VoIP click call (vcStart), unchanged.
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { runImmediateTransaction } from "../lib/crm-db";
import { s132bLive, s132bOn } from "../lib/simotel132b";
import { rvMeta, rvOn, rvResult, rvStart } from "../lib/reminder-voip";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser as any;
const off = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (rvOn(me(res))) return false;
  res.status(404).json({ error: "reminder_voip_off", message: "تماس از یادآور فعال نیست.", enabled: false }); return true;
};
const send = (res: Response, r: { status: number; body: any }) => void res.status(r.status).json(r.body);
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

router.get("/reminder-voip/meta", requirePermission("reminders.view"), (req, res) => {
  if (off(res)) return;
  send(res, rvMeta(me(res), req.query.ids));
});
router.post("/reminder-voip/:id/start", requirePermission("calls.create"), async (req, res) => {
  if (off(res)) return;
  const id = idOf(req.params.id); if (!id) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
  // same one-call rule as POST /voip-call/start (SIMOTEL-132 B: a call on the VoIP phone itself also counts)
  if (s132bOn(me(res))) {
    let busy = false; try { busy = runImmediateTransaction(() => s132bLive(me(res))).busy; } catch { busy = false; }
    if (busy) return void res.status(409).json({ error: "one_call", message: "یک تماس در جریان است؛ بعد از قطع آن دوباره بزن." });
  }
  try { send(res, await rvStart(me(res), id)); }
  catch { res.status(500).json({ error: "start_failed", message: "شروع تماس ناموفق بود." }); }
});
router.post("/reminder-voip/:id/result", requirePermission("reminders.view"), (req, res) => {
  if (off(res)) return;
  const id = idOf(req.params.id); if (!id) return void res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." });
  try { send(res, rvResult(me(res), id, req.body ?? {})); }
  catch { res.status(500).json({ error: "save_failed", message: "ثبت نشد. دوباره تلاش کن." }); }
});
export default router;

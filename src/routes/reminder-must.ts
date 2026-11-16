/**
 * REMINDER-B endpoints (mandatory due-reminder popup). Users 8/2/3 (EL_USERS) while flag.reminder_must=1; else 404 reminder_must_off.
 * No SMS, Bale, customer message or staff bell. Never changes a stage, owner, priority, contract or template.
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { rmComplete, rmFeed, rmIsErr, rmOn, rmShown, rmSnooze, rmTarget } from "../lib/reminder-must";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser as any;
const off = (res: Response) => {
  if (rmOn(me(res))) return false;
  res.status(404).json({ error: "reminder_must_off", message: "یادآور اجباری فعال نیست.", details: null, enabled: false }); return true;
};
const send = (res: Response, r: any, ok = 200) => rmIsErr(r) ? void res.status(r.status).json({ error: r.error, message: r.message, details: r.details ?? null }) : void res.status(ok).json(r);
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
router.get("/reminder-must/config", (_req, res) => { const u = me(res); res.json({ enabled: Boolean(u && rmTarget(u) && rmOn(u)) }); });
router.get("/reminder-must/feed", (_req, res) => { if (off(res)) return; res.json(rmFeed(me(res))); });
router.post("/reminder-must/snooze", (_req, res) => { if (off(res)) return; send(res, rmSnooze(me(res))); });
router.post("/reminder-must/:id/shown", (req, res) => { if (off(res)) return; send(res, rmShown(me(res), idOf(req.params.id))); });
router.post("/reminder-must/:id/complete", (req, res) => { if (off(res)) return; send(res, rmComplete(me(res), idOf(req.params.id), req.body ?? {})); });
export default router;

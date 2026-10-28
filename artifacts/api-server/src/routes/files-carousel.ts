/**
 * FILES-61 expert endpoints «پرونده‌های من» تک‌کارتی. Only users 8/2/3 (EL_USERS) while flag.files_carousel=1; else 404 files_carousel_off.
 * No SMS, Bale, customer message or staff bell. Never changes a stage, contract, template or amount.
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { fcEnabledFor, fcExpertFollowup, fcExpertView, fcIsErr, fcTarget, fcOn } from "../lib/files-carousel";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const off = (res: Response) => {
  if (fcEnabledFor(me(res) as any)) return false;
  res.status(404).json({ error: "files_carousel_off", message: "«پرونده‌های من» تک‌کارتی فعال نیست.", details: null, enabled: false }); return true;
};
router.get("/files-carousel/config", (_req, res) => { const u = me(res) as any; res.json({ enabled: Boolean(fcTarget(u) && fcOn()) }); });
router.get("/files-carousel/today", (_req, res) => { if (off(res)) return; res.json(fcExpertView(me(res) as any)); });
router.post("/files-carousel/followup", (req, res) => {
  if (off(res)) return;
  const r = fcExpertFollowup(me(res) as any, req.body ?? {});
  if (fcIsErr(r)) return void res.status(r.status).json({ error: r.error, message: r.message, details: r.details ?? null });
  res.json(r);
});
export default router;

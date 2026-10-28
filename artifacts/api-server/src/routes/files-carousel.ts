/**
 * FILES-61 expert endpoints «پرونده‌های من» تک‌کارتی. Only users 8/2/3 (EL_USERS) while flag.files_carousel=1; else 404 files_carousel_off.
 * No SMS, Bale, customer message or staff bell. Never changes a stage, contract, template or amount.
 */
import { Router, type IRouter, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { fcAdminUncancel, fcCatOn, fcEnabledFor, fcExpertFollowup, fcExpertList, fcExpertOpened, fcExpertTel, fcExpertView, fcIsErr, fcTarget, fcOn } from "../lib/files-carousel";

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
/** REL-83 (flag.fc_categories): full list, «تازه برگشت» cleared on open, and the tel: number for the list's «پیگیری» sheet. Off → 404 fc_categories_off. */
const catOff = (res: Response) => {
  if (off(res)) return true;
  if (fcCatOn()) return false;
  res.status(404).json({ error: "fc_categories_off", message: "ترتیب اولویت فعال نیست.", details: null }); return true;
};
const send = (res: Response, r: any) => { if (fcIsErr(r)) return void res.status(r.status).json({ error: r.error, message: r.message, details: r.details ?? null }); res.json(r); };
router.get("/files-carousel/list", (req, res) => { if (catOff(res)) return; send(res, fcExpertList(me(res) as any, req.query ?? {})); });
router.post("/files-carousel/opened", (req, res) => { if (catOff(res)) return; send(res, fcExpertOpened(me(res) as any, req.body ?? {})); });
router.get("/files-carousel/tel/:fileId", (req, res) => { if (catOff(res)) return; res.setHeader("Cache-Control", "no-store"); send(res, fcExpertTel(me(res) as any, req.params.fileId)); });
/** FILES-CANCEL: admin-only un-cancel of a «لغو شده» file (no flag dependency; everyone else 403). */
router.post("/files/:id/uncancel", (req, res) => {
  const r = fcAdminUncancel(me(res) as any, req.params.id, req.body ?? {});
  if (fcIsErr(r)) return void res.status(r.status).json({ error: r.error, message: r.message, details: r.details ?? null });
  res.json(r);
});
export default router;

/** expert_lockdown (assistants54): status for the dashboard, «تماس ورودی دارم» search, admin daily counts. See lib/expert-lockdown.ts. */
import { Router, type IRouter } from "express";
import type { AuthUser } from "../lib/auth";
import { dpToday } from "../lib/daily-plan";
import { EL_ADMIN_USER_IDS, EL_ALLOWED_PAGES, EL_GRANT_MINUTES, elDailyCounts, elIncomingChoose, elIncomingOpen, elIncomingSearch, elLocked, elNewCheck, elNewCreate } from "../lib/expert-lockdown";

const router: IRouter = Router();
const me = (res: any) => res.locals.authUser as AuthUser | undefined;

router.get("/expert-lockdown/me", (_req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.json({ locked: false }); return; }
  res.json({ locked: true, allowedPages: EL_ALLOWED_PAGES, grantMinutes: EL_GRANT_MINUTES });
});
router.post("/expert-lockdown/incoming/open", (_req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.status(404).json({ error: "not_found" }); return; }
  res.json(elIncomingOpen(u!));
});
router.post("/expert-lockdown/incoming/search", (req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elIncomingSearch(u!, req.body?.q);
  res.status(r.result === "rate_limited" ? 429 : 200).json(r);
});
// incoming2-59: «تماس ورودی داشتم» → option click log, «ثبت مشتری جدید» step 1 (phone duplicate check) and create.
router.post("/expert-lockdown/incoming/choose", (req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elIncomingChoose(u!, req.body?.option);
  res.status(r.ok ? 200 : 400).json(r);
});
router.post("/expert-lockdown/incoming/new/check", (req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elNewCheck(u!, req.body?.phone);
  res.status(r.result === "rate_limited" ? 429 : r.result === "invalid" ? 400 : 200).json(r);
});
router.post("/expert-lockdown/incoming/new", (req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elNewCreate(u!, req.body && typeof req.body === "object" ? req.body : undefined);
  res.status(r.result === "rate_limited" ? 429 : r.result === "invalid" ? 400 : r.result === "duplicate" ? 409 : 201).json(r);
});
router.get("/expert-lockdown/admin/daily", (req, res): void => {
  const u = me(res);
  if (!u || u.role !== "admin" || !EL_ADMIN_USER_IDS.includes(Number(u.id))) { res.status(403).json({ error: "admin_only" }); return; }
  const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : dpToday();
  res.json(elDailyCounts(day));
});
export default router;

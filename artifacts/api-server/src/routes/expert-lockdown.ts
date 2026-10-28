/** expert_lockdown (assistants54): status for the dashboard, «تماس ورودی دارم» search, admin daily counts. See lib/expert-lockdown.ts. */
import { Router, type IRouter } from "express";
import type { AuthUser } from "../lib/auth";
import { dpIncomingFirstCallMirror, dpToday } from "../lib/daily-plan";
import { firstCallIncomplete } from "../lib/first-call-incomplete";
import { tcOn } from "../lib/today-carousel";
import { EL_ADMIN_USER_IDS, EL_ALLOWED_PAGES, EL_GRANT_MINUTES, elDailyCounts, elIncomingChoose, elIncomingOpen, elIncomingSearch, elLocked, elNewCheck, elNewCreate, elIncomingSuggest, elIncomingPick } from "../lib/expert-lockdown";

const router: IRouter = Router();
const me = (res: any) => res.locals.authUser as AuthUser | undefined;
/** incoming2-59: the «تماس ورودی داشتم» endpoints serve locked experts AND the carousel users (flag.today_carousel, same 3 users). */
const incomingOk = (u: AuthUser | undefined) => elLocked(u) || tcOn(u);

router.get("/expert-lockdown/me", (_req, res): void => {
  const u = me(res);
  if (!elLocked(u)) { res.json({ locked: false }); return; }
  res.json({ locked: true, allowedPages: EL_ALLOWED_PAGES, grantMinutes: EL_GRANT_MINUTES });
});
router.post("/expert-lockdown/incoming/open", (_req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  res.json(elIncomingOpen(u!));
});
router.post("/expert-lockdown/incoming/search", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elIncomingSearch(u!, req.body?.q);
  res.status(r.result === "rate_limited" ? 429 : 200).json(r);
});
// incoming2-59: «تماس ورودی داشتم» → option click log, «ثبت مشتری جدید» step 1 (phone duplicate check) and create.
router.post("/expert-lockdown/incoming/choose", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elIncomingChoose(u!, req.body?.option);
  res.status(r.ok ? 200 : 400).json(r);
});
// SEARCH-65b: live search over the caller's OWN customers (≤8, exact phone first, phone shown as last 4 only) + pick → the existing own path. incoming2-59: also reached from the wizard (carousel users 8/2/3 via incomingOk).
router.post("/expert-lockdown/incoming/suggest", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elIncomingSuggest(u!, req.body?.q);
  res.status(r.result === "rate_limited" ? 429 : 200).json(r);
});
router.post("/expert-lockdown/incoming/pick", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  res.json(elIncomingPick(u!, req.body?.pick));
});
// NEWCUST-65: «تماس ورودی داشتم › ثبت مشتری جدید» step 1 (phone duplicate check, owner name only) and create (owner = this expert). Locked experts only.
router.post("/expert-lockdown/incoming/new/check", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elNewCheck(u!, req.body?.phone);
  res.status(r.result === "rate_limited" ? 429 : r.result === "invalid" ? 400 : 200).json(r);
});
router.post("/expert-lockdown/incoming/new", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = elNewCreate(u!, req.body && typeof req.body === "object" ? req.body : undefined);
  res.status(r.result === "rate_limited" ? 429 : r.result === "invalid" ? 400 : r.result === "duplicate" ? 409 : 201).json(r);
});
/** incoming2-59 (PM (a)): the wizard's first-call-form call → done «خارج از لیست» on today's plan (see dpIncomingFirstCallMirror). */
router.post("/expert-lockdown/incoming/first-call-logged", (req, res): void => {
  const u = me(res);
  if (!incomingOk(u)) { res.status(404).json({ error: "not_found" }); return; }
  const r = dpIncomingFirstCallMirror(u as any, req.body);
  if ("status" in r) { res.status(r.status).json(r); return; }
  res.json(r);
});
/** incoming2-59 PM rule: is this customer's first-call form incomplete for me (qualifier only)? Read-only; the file page reopens the form. */
router.get("/team-sales/first-call-incomplete/:id", (req, res): void => {
  const u = me(res); const id = Number(req.params.id);
  if (!u || !Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "invalid" }); return; }
  res.json({ customerId: id, incomplete: firstCallIncomplete(u as any, id) });
});
router.get("/expert-lockdown/admin/daily", (req, res): void => {
  const u = me(res);
  if (!u || u.role !== "admin" || !EL_ADMIN_USER_IDS.includes(Number(u.id))) { res.status(403).json({ error: "admin_only" }); return; }
  const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : dpToday();
  res.json(elDailyCounts(day));
});
export default router;

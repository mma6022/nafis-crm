/**
 * social-hub v1.1 routes. flag.social_hub_v1 / flag.social_hub_phone_attach_v1 OFF → /social-hub/me {enabled:false} and every other
 * /social-hub route 404 with no schema created.
 * Send/connect/redirect live in social-hub-send.ts and stay no-ops (no network) while their flags are OFF.
 */
import express, { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  shBuildRedirectPreview, shConnectView, shIsSuperAdmin, shParseCount, shRedirectCampaignDone, shRedirectReadyForStart, shRedirectStatus,
  shRetrySend, shSaveConnectToken, shStartRedirect, shStopRedirect, shTestConnectToken, shTestSavedToken,
} from "../lib/social-hub-send";
import { requireAuth, getAuthenticatedUser, type AuthUser } from "../lib/auth";
import { elCustomerAccess, elFlagOn, elTarget } from "../lib/expert-lockdown";
import { addCustomerPhone } from "../lib/customer-phones";
import { s132bLinkToCustomer } from "../lib/simotel132b";
import {
  ShError, ensureSocialHubSchema, shAccess, shAddBot, shAddDoc, shArchiveDoc, shArchiveMessage, shAttachPhone, shBots, shCanSeeCustomer,
  shCreateMessage, shDocFile, shDocs, shIsManager, shIsStaff, shMarkMigrated, shUndoMigrated, shMe, shMessages, shOn, shPhoneOn, shPhoneSearch, shPlans,
  shSaveAccess, shSend, shSendRedirectOnce, shSetRedirectAuto, shSetRedirectText, shTodayBox, shUpdateDoc, shUpdateMessage,
  SH_DOC_MAX_BYTES,
} from "../lib/social-hub";

const router: IRouter = Router();
const fail = (res: Response, status: number, error: string, message?: string, extra: Record<string, unknown> = {}) => res.status(status).json({ error, ...(message ? { message } : {}), ...extra });
function user(req: Request, res: Response, next: NextFunction) {
  const u = (res.locals.authUser as AuthUser | undefined) ?? getAuthenticatedUser(req);
  if (!u) { fail(res, 401, "unauthenticated"); return; }
  res.locals.authUser = u; res.setHeader("Cache-Control", "private, no-store"); next();
}
const me = (res: Response) => res.locals.authUser as AuthUser;
const hubOn = (_q: Request, res: Response, next: NextFunction) => { if (!shOn()) { fail(res, 404, "not_found"); return; } ensureSocialHubSchema(); next(); };
const phoneOn = (_q: Request, res: Response, next: NextFunction) => { if (!shPhoneOn()) { fail(res, 404, "not_found"); return; } next(); };
const mgr = (_q: Request, res: Response, next: NextFunction) => { if (!shIsManager(me(res))) { fail(res, 403, "forbidden", "این صفحه فقط برای مدیر فروش و مدیر سیستم است."); return; } next(); };
const staff = (_q: Request, res: Response, next: NextFunction) => { if (!shIsStaff(me(res))) { fail(res, 403, "forbidden"); return; } next(); };
const id = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
function run(res: Response, fn: () => unknown, status = 200) {
  try { res.status(status).json(fn()); }
  catch (e) { if (e instanceof ShError) { fail(res, e.status, e.code, e.message, e.extra); return; } console.error("[social-hub]", (e as Error)?.message); fail(res, 500, "unknown", "انجام نشد؛ دوباره امتحان کنید."); }
}
function runAsync(res: Response, fn: () => Promise<unknown>, status = 200) {
  void fn().then((v) => res.status(status).json(v)).catch((e) => {
    if (e instanceof ShError) { fail(res, e.status, e.code, e.message, e.extra); return; }
    console.error("[social-hub]", (e as Error)?.message); fail(res, 500, "unknown", "انجام نشد؛ دوباره امتحان کنید.");
  });
}
const superAdm = (_q: Request, res: Response, next: NextFunction) => { if (!shIsSuperAdmin(me(res))) { fail(res, 403, "forbidden", "ارسال پیام انتقال فقط برای مدیر سیستم است."); return; } next(); };

const lockdown = (u: AuthUser, cid: number) => Boolean(elFlagOn() && elTarget(u) && elCustomerAccess(u, cid));

router.get("/social-hub/me", requireAuth, user, (_req, res) => { res.json(shMe(me(res))); });

/* -- page (manager) -- */
router.get("/social-hub/plans", requireAuth, user, hubOn, staff, (_q, res) => run(res, () => ({ plans: shPlans() })));
router.get("/social-hub/bots", requireAuth, user, hubOn, mgr, (_q, res) => run(res, () => { const d = shRedirectCampaignDone(); return { ...shBots(), connect: shConnectView(), isSuperAdmin: shIsSuperAdmin(me(res)), redirectDone: d.done, redirectDoneAt: d.finishedAt }; }));
router.post("/social-hub/bots", requireAuth, user, hubOn, mgr, express.json({ limit: "8kb" }), (req, res) => run(res, () => shAddBot(me(res), req.body), 201));
router.post("/social-hub/bots/test", requireAuth, user, hubOn, mgr, express.json({ limit: "4kb" }), (req, res) => runAsync(res, () => shTestConnectToken(me(res), req.body?.token)));
router.post("/social-hub/bots/connect", requireAuth, user, hubOn, mgr, express.json({ limit: "4kb" }), (req, res) => runAsync(res, () => shSaveConnectToken(me(res), req.body?.token), 201));
router.post("/social-hub/bots/test-saved", requireAuth, user, hubOn, mgr, (_q, res) => runAsync(res, () => shTestSavedToken()));
router.get("/social-hub/bots/:id/access", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => shAccess(id(req.params.id))));
router.put("/social-hub/bots/:id/access", requireAuth, user, hubOn, mgr, express.json({ limit: "64kb" }), (req, res) => run(res, () => shSaveAccess(me(res), id(req.params.id), req.body?.rows)));
router.put("/social-hub/legacy/:id/redirect", requireAuth, user, hubOn, mgr, express.json({ limit: "2kb" }), (req, res) => run(res, () => ({ legacy: shSetRedirectAuto(me(res), id(req.params.id), Boolean(req.body?.on)) })));
router.post("/social-hub/legacy/:id/send-once", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => shSendRedirectOnce(me(res), id(req.params.id))));
router.post("/social-hub/legacy/:id/migrated", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => ({ legacy: shMarkMigrated(me(res), id(req.params.id)) })));
router.post("/social-hub/legacy/:id/migrated/undo", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => ({ legacy: shUndoMigrated(me(res), id(req.params.id)) })));
router.put("/social-hub/redirect-text", requireAuth, user, hubOn, mgr, express.json({ limit: "16kb" }), (req, res) => run(res, () => ({ text: shSetRedirectText(me(res), req.body?.text) })));
router.get("/social-hub/messages", requireAuth, user, hubOn, mgr, (_q, res) => run(res, () => shMessages()));
router.post("/social-hub/messages", requireAuth, user, hubOn, mgr, express.json({ limit: "32kb" }), (req, res) => run(res, () => ({ message: shCreateMessage(me(res), req.body) }), 201));
router.patch("/social-hub/messages/:id", requireAuth, user, hubOn, mgr, express.json({ limit: "32kb" }), (req, res) => run(res, () => ({ message: shUpdateMessage(me(res), id(req.params.id), req.body) })));
router.delete("/social-hub/messages/:id", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => { shArchiveMessage(me(res), id(req.params.id)); return { ok: true }; }));
router.get("/social-hub/docs", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => ({
  docs: shDocs({ type: typeof req.query.type === "string" ? req.query.type : undefined, planId: req.query.plan === "none" ? 0 : req.query.plan ? id(req.query.plan) || null : null }), maxBytes: SH_DOC_MAX_BYTES })));
router.post("/social-hub/docs", requireAuth, user, hubOn, mgr,
  express.raw({ type: () => true, limit: SH_DOC_MAX_BYTES + 1024 }),
  (req, res) => run(res, () => {
    let meta: any = {}; try { meta = JSON.parse(decodeURIComponent(String(req.headers["x-sh-meta"] ?? "{}"))); } catch { meta = {}; }
    return { doc: shAddDoc(me(res), Buffer.isBuffer(req.body) ? req.body : null, meta) };
  }, 201));
router.patch("/social-hub/docs/:id", requireAuth, user, hubOn, mgr, express.json({ limit: "8kb" }), (req, res) => run(res, () => ({ doc: shUpdateDoc(me(res), id(req.params.id), req.body) })));
router.delete("/social-hub/docs/:id", requireAuth, user, hubOn, mgr, (req, res) => run(res, () => { shArchiveDoc(me(res), id(req.params.id)); return { ok: true }; }));
router.get("/social-hub/docs/:id/file", requireAuth, user, hubOn, staff, (req, res) => {
  const f = shDocFile(id(req.params.id)); if (!f) { fail(res, 404, "not_found"); return; }
  res.setHeader("Content-Type", f.mime); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`); res.sendFile(f.path);
});

/* -- today card (any staff with access to that customer) -- */
router.get("/social-hub/customers/:id/today", requireAuth, user, hubOn, staff, (req, res) => {
  const cid = id(req.params.id); const u = me(res);
  if (!cid || !shCanSeeCustomer(u, cid, lockdown(u, cid))) { fail(res, 404, "not_found"); return; }
  run(res, () => shTodayBox(u, cid));
});
router.post("/social-hub/customers/:id/send", requireAuth, user, hubOn, staff, express.json({ limit: "4kb" }), (req, res) => {
  const cid = id(req.params.id); const u = me(res);
  if (!cid || !shCanSeeCustomer(u, cid, lockdown(u, cid))) { fail(res, 404, "not_found"); return; }
  run(res, () => shSend(u, cid, req.body), 201);
});
router.post("/social-hub/customers/:id/sends/:sendId/retry", requireAuth, user, hubOn, staff, (req, res) => {
  const cid = id(req.params.id); const u = me(res);
  if (!cid || !shCanSeeCustomer(u, cid, lockdown(u, cid))) { fail(res, 404, "not_found"); return; }
  run(res, () => shRetrySend(u, id(req.params.sendId)));
});

router.get("/social-hub/redirect/preview", requireAuth, user, hubOn, superAdm, (_q, res) => run(res, () => shBuildRedirectPreview()));
router.post("/social-hub/redirect/start", requireAuth, user, hubOn, superAdm, express.json({ limit: "4kb" }), (req, res) => runAsync(res, async () => {
  const preview = await shRedirectReadyForStart(me(res));
  const r = shStartRedirect(me(res), { seen: req.body?.seen === true, count: req.body?.count }, preview);
  const { shRedirectTick } = await import("../lib/social-hub-send");
  shRedirectTick();
  return r;
}, 201));
router.post("/social-hub/redirect/stop", requireAuth, user, hubOn, superAdm, (_q, res) => run(res, () => shStopRedirect(me(res))));
router.get("/social-hub/redirect/status", requireAuth, user, hubOn, superAdm, (_q, res) => run(res, () => shRedirectStatus()));
void shParseCount;

/* -- unknown caller → existing customer -- */
router.get("/social-hub/phone-attach/search", requireAuth, user, phoneOn, staff, (req, res) => run(res, () => ({ rows: shPhoneSearch(me(res), req.query.q) })));
router.post("/social-hub/phone-attach", requireAuth, user, phoneOn, staff, express.json({ limit: "2kb" }), (req, res) => {
  const u = me(res); if (!u.permissions.includes("customers.update")) { fail(res, 403, "forbidden"); return; }
  const r = shAttachPhone(u, id(req.body?.customerId), req.body?.phone, { callEventId: id(req.body?.callEventId) || null, logCall: req.body?.logCall !== false },
    { add: (uu, cid, ph) => addCustomerPhone(uu, cid, ph, null), link: (uu, ev, cid) => s132bLinkToCustomer(uu, ev, cid) });
  if (!r.ok) { fail(res, r.status, r.error, r.message, r.customer ? { customer: r.customer } : {}); return; }
  res.status(201).json(r);
});

export default router;

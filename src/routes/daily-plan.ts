/**
 * crm-daily-plan «کارهای امروز» API (Armita v1.2). Behind flag.daily_plan (OFF): staff endpoints answer 404 {error:"daily_plan_off", enabled:false},
 * runner endpoints 423 daily_plan_off. Errors are {error, message, details}. Nothing here sends SMS, Bale or any customer message.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { cqManager } from "../lib/call-queue";
import { tcLogEvent, tcOn } from "../lib/today-carousel";
import {
  dpAdminCapacity, dpAssistantCapacity, dpAssistantGet, dpBoard, dpBoost, dpCapacityView, dpCheckExpertId, dpConfig, dpDecisionData, dpExpertView, dpIdem, dpIsErr, dpIsExpert,
  dpMarkReturned, dpMove, dpOn, dpRejectedEvent, dpReport, dpSaveSettings, dpScopeCustomers, dpSettings, dpStartCall, dpSkipItem, dpSupplementary, dpValidateSettings, dpWritePlan,
  dpExperts, dpToday, ensureDailyPlanSchema, type Asst, type DpErr,
} from "../lib/daily-plan";
import { fcAssistantFollowups, fcAssistantOpen, fcAssistantPriority } from "../lib/files-carousel";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const idOf = (v: unknown) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const sendErr = (res: Response, e: DpErr) => res.status(e.status).json({ error: e.error, message: e.message, details: e.details ?? null });
const send = (res: Response, r: any, ok = 200) => (dpIsErr(r) ? sendErr(res, r) : res.status(ok).json(r));
const off = (res: Response) => { if (dpOn()) return false; res.status(404).json({ error: "daily_plan_off", message: "«کارهای امروز» فعال نیست.", details: null, enabled: false }); return true; };
const admin = (res: Response) => { const u = me(res); if (!cqManager(u)) { sendErr(res, { status: 403, error: "forbidden", message: "فقط مدیر." }); return null; } return u; };

router.get("/daily-plans/config", requirePermission("customers.view"), (_req, res) => {
  ensureDailyPlanSchema(); const u = me(res);
  const c = dpConfig();
  // incoming2-59: `carousel` is added ONLY when flag.today_carousel applies to this user (off → response unchanged).
  res.json({ ...c, experts: cqManager(u) ? c.experts : [], eligible: dpOn() && dpIsExpert(u), manager: cqManager(u), today: dpToday(), ...(tcOn(u) ? { carousel: true } : {}) });
});
/* -------- expert -------- */
router.get("/daily-plans/today", requirePermission("customers.view"), (_req, res) => { if (off(res)) return; res.json(dpExpertView(me(res))); });
router.post("/daily-plans/today/carousel-event", requirePermission("customers.view"), (req, res) => {
  const r = tcLogEvent(me(res), req.body); res.status(r.status).json(r.body);
});
router.post("/daily-plans/items/:id/start", requirePermission("calls.create"), (req, res) => {
  if (off(res)) return; const id = idOf(req.params.id); if (!id) return void sendErr(res, { status: 400, error: "bad_type", message: "id", details: { field: "id" } });
  send(res, dpStartCall(me(res), id));
});
router.post("/daily-plans/calls/:id/returned", requirePermission("calls.create"), (req, res) => {
  if (off(res)) return; const id = idOf(req.params.id); if (!id) return void sendErr(res, { status: 400, error: "bad_type", message: "id", details: { field: "id" } });
  res.json({ ok: dpMarkReturned(me(res), id) });
});
router.post("/daily-plans/items/:id/move", requirePermission("calls.create"), (req, res) => {
  if (off(res)) return; const id = idOf(req.params.id); if (!id) return void sendErr(res, { status: 400, error: "bad_type", message: "id", details: { field: "id" } });
  send(res, dpMove(me(res) as any, id, req.body ?? {}));
});
/* -------- managers -------- */
router.get("/daily-plans/board", (req, res) => { if (off(res) || !admin(res)) return; res.json(dpBoard(req.query.date)); });
router.get("/daily-plans/report", (req, res) => { if (off(res) || !admin(res)) return; res.json(dpReport(req.query.from, req.query.to)); });
router.get("/daily-plans/:spId/:date", (req, res) => {
  if (off(res)) return; const u = me(res); const sp = idOf(req.params.spId);
  if (!sp) return void sendErr(res, { status: 400, error: "bad_type", message: "spId", details: { field: "spId" } });
  if (!cqManager(u) && Number(u.salespersonId) !== sp) return void sendErr(res, { status: 403, error: "forbidden", message: "فقط لیست خودت یا مدیر." });
  const b = dpBoard(req.params.date) as any; const e = (b.experts ?? []).find((x: any) => x.salespersonId === sp);
  if (!e) return void sendErr(res, { status: 404, error: "expert_not_eligible", message: "این کارشناس «کارهای امروز» ندارد." });
  res.json({ day: b.day, ...e });
});
router.get("/capacity/:spId", (req, res) => {
  if (off(res) || !admin(res)) return; const sp = idOf(req.params.spId);
  if (!sp || !dpExperts().some(e => e.salespersonId === sp)) return void sendErr(res, { status: 404, error: "expert_not_eligible", message: "این کارشناس «کارهای امروز» ندارد." });
  res.json(dpCapacityView(sp));
});
router.post("/admin/capacity/:spId/:date/override", (req, res) => {
  if (off(res)) return; const u = admin(res); if (!u) return; const sp = idOf(req.params.spId);
  if (!sp) return void sendErr(res, { status: 400, error: "bad_type", message: "spId", details: { field: "spId" } });
  send(res, dpAdminCapacity(u, sp, req.params.date, req.body ?? {}));
});
router.get("/admin/settings/daily-plan", (_req, res) => { if (!admin(res)) return; res.json({ settings: dpSettings(), flags: dpConfig().flags }); });
router.put("/admin/settings/daily-plan", (req, res) => {
  const u = admin(res); if (!u) return; ensureDailyPlanSchema();
  const v = dpValidateSettings(req.body ?? {});
  if (!v.ok) return void sendErr(res, { status: 422, error: "bad_setting", message: v.error, details: { field: v.field } });
  res.json({ ok: true, changed: dpSaveSettings(v.value, u.id), settings: dpSettings() });
});

/* -------- runner (assistant token, /api/assistant-runner) -------- */
export function mountDailyPlanRunner(runner: Router) {
  const A = (res: Response) => res.locals.assistant as Asst;
  const gate = (req: Request, res: Response) => {
    if (!dpOn()) { res.status(423).json({ error: "daily_plan_off", message: "«کارهای امروز» فعال نیست.", details: null }); return null; }
    const a = A(res); const e = dpCheckExpertId(a, req.body?.expertId ?? req.query.expertId); if (e) { sendErr(res, e); return null; }
    ensureDailyPlanSchema(); return a;
  };
  const write = (route: string, fn: (a: Asst, req: Request) => any) => (req: Request, res: Response) => {
    const a = gate(req, res); if (!a) return;
    const key = String(req.headers["idempotency-key"] ?? "").trim() || undefined;
    const r = dpIdem(a, key, `${route} ${req.path}`, req.body ?? null, () => {
      const out = fn(a, req);
      if (dpIsErr(out)) { dpRejectedEvent(a, `${route} ${req.path}`, out); return { status: out.status, body: { error: out.error, message: out.message, details: out.details ?? null } }; }
      return { status: 200, body: out };
    });
    res.status(r.status).json(r.body);
  };
  runner.get("/daily-plans/customers", (req, res) => { const a = gate(req, res); if (a) send(res, dpScopeCustomers(a, req.query)); });
  runner.get("/daily-plans/:date", (req, res) => { const a = gate(req, res); if (a) send(res, dpAssistantGet(a, req.params.date)); });
  runner.put("/daily-plans/:date", write("PUT /daily-plans", (a, req) => dpWritePlan(a, req.params.date, req.body ?? {})));
  runner.post("/daily-plans/:date/supplementary", write("POST /daily-plans/supplementary", (a, req) => dpSupplementary(a, req.params.date, req.body ?? {})));
  runner.post("/daily-plans/:date/boost", write("POST /daily-plans/boost", (a, req) => dpBoost(a, req.params.date, req.body ?? {})));
  // DUP-64: put aside ONE pending card of this assistant's own expert (reason required) → one replacement from the queue; logged in dp_skip_log.
  runner.post("/daily-plans/:date/items/:id/skip", write("POST /daily-plans/items/skip", (a, req) => dpSkipItem(a, req.params.date, req.params.id, req.body ?? {})));
  runner.put("/capacity/:date", write("PUT /capacity", (a, req) => dpAssistantCapacity(a, req.params.date, req.body ?? {})));
  /* FILES-61 «پرونده‌های من» — same gate / Idempotency-Key / rejected-event logging as boost. */
  runner.get("/files/open", (req, res) => { const a = gate(req, res); if (a) send(res, fcAssistantOpen(a as any)); });
  runner.put("/files/priority/:date", write("PUT /files/priority", (a, req) => fcAssistantPriority(a as any, req.params.date, req.body ?? {})));
  runner.get("/files/followups", (req, res) => { const a = gate(req, res); if (a) send(res, fcAssistantFollowups(a as any, req.query.date)); });
  runner.get("/decision-data", (req, res) => { const a = gate(req, res); if (a) send(res, dpDecisionData(a, req.query.from, req.query.to)); });
}
export default router;

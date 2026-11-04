/**
 * «موارد اجباری خلاصه‌ی تماس» API (design v1.2). Only while flag.call_summary_fields_v1 (or .user.<id>) is on; else 404 cs_off.
 * No messages / SMS / notifications. The file changes only through an explicit expert action (apply / apply-all / complete).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { ctAdminViewer, isCtManager } from "../lib/call-transcripts";
import { TeamSalesError } from "../lib/team-sales";
import {
  CsError, applyAll, callItems, confirmAll, csOn, customerItems, decideProposal, firstCallPrefill, report, reportDetail, setCallItem, setCustomerItem,
} from "../lib/call-summary-fields";

const router: IRouter = Router();
const me = (res: Response) => res.locals.authUser as AuthUser;
const off = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (csOn(me(res).id)) return false;
  res.status(404).json({ error: "cs_off", message: "موارد اجباری خلاصه‌ی تماس فعال نیست.", enabled: false }); return true;
};
const num = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const run = (res: Response, fn: () => unknown) => {
  try { res.json(fn()); } catch (e) {
    if (e instanceof CsError || e instanceof TeamSalesError) return void res.status(e.status).json({ error: e instanceof CsError ? e.code : "team_sales", message: e.message });
    console.error("[cs-fields]", e instanceof Error ? e.message : "error");
    res.status(500).json({ error: "cs_error", message: "ذخیره نشد؛ دوباره تلاش کن." });
  }
};
const idOr400 = (req: Request, res: Response, name: string) => { const id = num(req.params[name]); if (!id) res.status(400).json({ error: "bad_id", message: "شناسه معتبر نیست." }); return id; };

router.get("/call-summary-fields/config", (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const u = me(res);
  res.json(csOn(u.id) ? { enabled: true, report: ctAdminViewer(u) || isCtManager(u) } : { enabled: false });
});
router.get("/call-summary-fields/calls/:eventId", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "eventId"); if (!id) return;
  run(res, () => callItems(id, me(res)));
});
router.put("/call-summary-fields/calls/:eventId/items/:key", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "eventId"); if (!id) return;
  run(res, () => { setCallItem(id, String(req.params.key), req.body ?? {}, me(res)); return callItems(id, me(res)); });
});
router.post("/call-summary-fields/calls/:eventId/confirm", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "eventId"); if (!id) return;
  run(res, () => { confirmAll(id, me(res)); return callItems(id, me(res)); });
});
router.post("/call-summary-fields/proposals/:id/:action", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "id"); if (!id) return;
  const action = req.params.action;
  if (action !== "apply" && action !== "reject") return void res.status(404).json({ error: "not_found", message: "پیدا نشد." });
  run(res, () => { const ev = decideProposal(id, me(res), action); return callItems(ev, me(res)); });
});
router.post("/call-summary-fields/calls/:eventId/proposals/apply-all", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "eventId"); if (!id) return;
  run(res, () => { const n = applyAll(id, me(res)); return { applied: n, ...callItems(id, me(res)) }; });
});
router.get("/call-summary-fields/customers/:id/items", (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "id"); if (!id) return;
  run(res, () => customerItems(id, me(res)));
});
router.put("/call-summary-fields/customers/:id/items/:key", (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "id"); if (!id) return;
  run(res, () => { setCustomerItem(id, String(req.params.key), req.body?.value, me(res)); return customerItems(id, me(res)); });
});
router.get("/call-summary-fields/customers/:id/prefill", (req, res) => {
  if (off(res)) return; const id = idOr400(req, res, "id"); if (!id) return;
  run(res, () => firstCallPrefill(id, me(res)));
});
router.get("/call-summary-fields/report", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  run(res, () => report(me(res), req.query.from, req.query.to));
});
router.get("/call-summary-fields/report/detail", requirePermission("calls.view"), (req, res) => {
  if (off(res)) return;
  run(res, () => reportDetail(me(res), req.query.expert, req.query.from, req.query.to, req.query.page));
});
export default router;

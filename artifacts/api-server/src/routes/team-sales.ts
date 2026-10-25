/**
 * Team-sales API (qualifier Kazemi -> closers). Approved design: crm-team-sales screens 20-23, 30-35, 40-41.
 * All write endpoints return 404 unless team_sales_config.enabled = true. No SMS anywhere on these paths.
 */
import { Router, type IRouter, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { getCustomer } from "./crm";
import { queryRow } from "../lib/crm-db";
import {
  TeamSalesError, citySuggestions, editFirstCall, firstCallEditInfo, formatDue, getTeamSalesConfig, peekNextCloser, planOptions, previewQualification, priorityHistory, promoteToPriorityOne, submitQualification,
} from "../lib/team-sales";
import { addWorkingHours, type QualifierAnswers } from "../lib/team-sales-rules";
import { ConsultProfileError, canActOnCustomerProfile, consultProfile, editConsultProfile } from "../lib/consult-profile";
import { isAdminRole } from "../lib/customer-integrity";

const router: IRouter = Router();

function customerId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function actorOf(res: Response) {
  const u = res.locals.authUser as AuthUser;
  return { id: u.id, role: u.role, salespersonId: u.salespersonId, fullName: u.fullName };
}
function fail(res: Response, error: unknown): void {
  if (error instanceof TeamSalesError) { res.status(error.status).json({ error: error.message }); return; }
  throw error;
}
function answersOf(body: unknown): QualifierAnswers | null {
  const a = (body as { answers?: unknown } | null)?.answers;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as QualifierAnswers) : null;
}

router.get("/team-sales/config", requirePermission("customers.view"), (_req, res): void => {
  const cfg = getTeamSalesConfig();
  res.json({ enabled: cfg.enabled, qualifierSalespersonId: cfg.qualifierSalespersonId,
    closerSalespersonIds: cfg.closerSalespersonIds, noteMinLength: cfg.noteMinLength,
    closerFirstCallWorkingHours: cfg.closerFirstCallWorkingHours, workHours: cfg.workHours, workDays: cfg.workDays,
    maxNoAnswerAttempts: cfg.maxNoAnswerAttempts });
});

router.get("/customers/:id/priority-history", requirePermission("customers.view"), (req, res): void => {
  const id = customerId(req.params.id);
  if (!id || !getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json(priorityHistory(id));
});

/** Peek (no reservation) at whose turn is next, for the confirm dialog. */
router.get("/sales/next-closer", requirePermission("customers.view"), (_req, res): void => {
  const cfg = getTeamSalesConfig();
  const actor = actorOf(res);
  if (!cfg.enabled || (actor.role !== "admin" && actor.salespersonId !== cfg.qualifierSalespersonId)) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const next = peekNextCloser();
  if (!next) { res.status(409).json({ error: "هیچ کارشناس پیگیری فعالی تعریف نشده است." }); return; }
  const now = new Date();
  const due = addWorkingHours(now, cfg.closerFirstCallWorkingHours, cfg);
  res.json({ ...next, dueAt: due.toISOString(), dueLabel: formatDue(due, now), workingHours: cfg.closerFirstCallWorkingHours });
});

function upgrade(req: { params: { id?: string }; body?: { note?: unknown; reason?: unknown } }, res: Response): void {
  const id = customerId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid customer id" }); return; }
  const raw = typeof req.body?.note === "string" ? req.body.note : typeof req.body?.reason === "string" ? req.body.reason : "";
  const note = raw.trim().slice(0, 2000) || null; // optional
  try { res.json(promoteToPriorityOne(id, actorOf(res), note)); } catch (e) { fail(res, e); }
}
router.post("/customers/:id/upgrade-priority", requirePermission("customers.update"), (req, res): void => upgrade(req, res));
router.post("/customers/:id/team-sales/promote", requirePermission("customers.update"), (req, res): void => upgrade(req, res));

router.post("/customers/:id/team-sales/qualify/preview", requirePermission("customers.update"), (req, res): void => {
  const id = customerId(req.params.id);
  const answers = answersOf(req.body);
  if (!id || !answers) { res.status(400).json({ error: "Invalid request" }); return; }
  if (!getTeamSalesConfig().enabled) { res.status(404).json({ error: "Team sales is not enabled" }); return; }
  if (!getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  try { res.json(previewQualification(id, answers)); } catch (e) { fail(res, e); }
});

/** First-call form step 5: all active plans with status fit|depends|no and structured reasons (no writes). */
router.post("/customers/:id/team-sales/qualify/plans", requirePermission("customers.update"), (req, res): void => {
  const id = customerId(req.params.id);
  const answers = answersOf(req.body);
  if (!id || !answers) { res.status(400).json({ error: "Invalid request" }); return; }
  if (!getTeamSalesConfig().enabled) { res.status(404).json({ error: "Team sales is not enabled" }); return; }
  if (!getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  try { res.json(planOptions(id, answers)); } catch (e) { fail(res, e); }
});

router.post("/customers/:id/team-sales/qualify", requirePermission("calls.create"), (req, res): void => {
  const id = customerId(req.params.id);
  const answers = answersOf(req.body);
  if (!id || !answers) { res.status(400).json({ error: "Invalid request" }); return; }
  const note = typeof req.body?.note === "string" ? req.body.note : "";
  const selectedPlans = req.body?.selectedPlans ?? null;
  const noPlanNote = req.body?.noPlanNote ?? null;
  try { res.json(submitQualification(id, actorOf(res), answers, note, new Date(), selectedPlans, noPlanNote)); } catch (e) { fail(res, e); }
});

/**
 * crm-first-call-edit: «ویرایش» on «خلاصه‌ی تماس اول». Info = who may edit / send + the edit history.
 * Edit = no call record; optional «ذخیره و ارسال به کارشناس فروش» = the existing «ارتقا به اولویت ۱» path.
 */
router.get("/customers/:id/team-sales/first-call/edit-info", requirePermission("customers.view"), (req, res): void => {
  const id = customerId(req.params.id);
  if (!id || !getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  try { res.json(firstCallEditInfo(id, actorOf(res))); } catch (e) { fail(res, e); }
});
router.post("/customers/:id/team-sales/first-call/edit", requirePermission("customers.update"), (req, res): void => {
  const id = customerId(req.params.id);
  const answers = answersOf(req.body);
  if (!id || !answers) { res.status(400).json({ error: "Invalid request" }); return; }
  if (!getCustomer(id, res.locals.authUser as AuthUser)) { res.status(404).json({ error: "Customer not found" }); return; }
  const note = typeof req.body?.note === "string" ? req.body.note : "";
  try {
    res.json(editFirstCall(id, actorOf(res), answers, note, { selectedPlans: req.body?.selectedPlans ?? null,
      noPlanNote: req.body?.noPlanNote ?? null, send: req.body?.send === true, baseId: req.body?.baseId ?? null }));
  } catch (e) { fail(res, e); }
});

/** crm-no-plan-option: city autocomplete for the first-call form (existing customer city values; read-only). */
router.get("/team-sales/cities", requirePermission("customers.view"), (req, res): void => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  // Prefill: the customer's current city (only for a customer this user may see).
  const id = customerId(req.query.customerId);
  const visible = id ? Boolean(getCustomer(id, res.locals.authUser as AuthUser)) : false;
  const customerCity = visible ? queryRow<{ city: string | null }>("SELECT city FROM customers WHERE id=?", [id])?.city ?? null : null;
  res.json({ items: citySuggestions(q), customerCity });
});

/**
 * crm-no-plan-option (14:51) «اطلاعات مشاوره»: latest stored first-call answers + full history + official grade.
 * View: anyone who can see the customer (existing scoping). Edit: admin / registrar / the customer's own salesperson;
 * an edit is a new version (the old one stays) with the editor and the changed fields.
 */
function consultAccess(res: Response, raw: unknown) {
  const id = customerId(raw);
  const user = res.locals.authUser as AuthUser;
  if (!id || !getCustomer(id, user)) { res.status(404).json({ error: "Customer not found" }); return null; }
  const sp = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=?", [id])?.salesperson_id ?? null;
  return { id, user, canEdit: canActOnCustomerProfile(user, sp, isAdminRole) };
}
router.get("/customers/:id/consult-profile", requirePermission("customers.view"), (req, res): void => {
  const a = consultAccess(res, req.params.id); if (!a) return;
  res.json({ ...consultProfile(a.id), canEdit: a.canEdit });
});
router.patch("/customers/:id/consult-profile", requirePermission("customers.view"), (req, res): void => {
  const a = consultAccess(res, req.params.id); if (!a) return;
  if (!a.canEdit) { res.status(403).json({ error: "ویرایش اطلاعات مشاوره فقط برای کارشناس همین مشتری، ثبت‌نام‌کننده و مدیر است." }); return; }
  const patch = (req.body as { changes?: unknown } | null)?.changes;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) { res.status(400).json({ error: "تغییرات معتبر نیست." }); return; }
  try {
    const out = editConsultProfile(a.id, a.user, patch as Record<string, unknown>);
    res.json({ ...out.profile, canEdit: true, changed: out.changed });
  } catch (e) {
    if (e instanceof ConsultProfileError) { res.status(e.status).json({ error: e.message }); return; }
    throw e;
  }
});

export default router;

/** Read-only multi-case context. Flag OFF answers { enabled: false } and does not change other routes. */
import { Router } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { queryRow } from "../lib/crm-db";
import {
  customerVisible, ensureMultiCaseSchema, listCaseCalls, listCaseReminders, listCustomerCases, mcFlagOn,
} from "../lib/multi-case";

ensureMultiCaseSchema();
const router = Router();
const actor = (res: { locals: { authUser?: AuthUser } }) => res.locals.authUser as AuthUser;

router.get("/multi-case/status", requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: mcFlagOn(actor(res)?.id) });
});

router.get("/multi-case/customers/:id", requireAuth, (req, res) => {
  const user = actor(res);
  const customerId = Number(req.params.id);
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || !customerVisible(user, customerId)) {
    res.status(404).json({ error: "customer_not_found", message: "مشتری پیدا نشد یا در دسترس شما نیست." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  if (!mcFlagOn(user.id)) { res.json({ enabled: false, cases: [], calls: [], reminders: [] }); return; }
  res.json({
    enabled: true,
    cases: listCustomerCases(customerId),
    calls: listCaseCalls(customerId),
    reminders: listCaseReminders(customerId),
  });
});

router.get("/multi-case/cases/:id", requireAuth, (req, res) => {
  const user = actor(res);
  if (!mcFlagOn(user.id)) { res.json({ enabled: false }); return; }
  const applicationId = Number(req.params.id);
  const row = queryRow<{ id: number; customer_id: number; plan_id: number | null; plan_name: string | null; stage: string | null; status: string; deleted_at: string | null }>(
    `SELECT a.id, a.customer_id, a.plan_id, lp.name AS plan_name, a.stage, a.status, a.deleted_at
     FROM loan_applications a LEFT JOIN loan_plans lp ON lp.id=a.plan_id WHERE a.id=?`,
    [applicationId],
  );
  if (!row || row.deleted_at || !customerVisible(user, Number(row.customer_id))) {
    res.status(404).json({ error: "case_not_found", message: "این پرونده پیدا نشد یا در دسترس شما نیست." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    enabled: true,
    case: {
      id: Number(row.id), customerId: Number(row.customer_id),
      planId: row.plan_id == null ? null : Number(row.plan_id), planName: row.plan_name ?? null,
      stage: row.stage, status: row.status,
      open: row.status !== "rejected" && row.stage !== "completed",
    },
    calls: listCaseCalls(Number(row.customer_id), applicationId),
    reminders: listCaseReminders(Number(row.customer_id), applicationId),
  });
});

export default router;

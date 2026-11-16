import { createHash } from "node:crypto";
import type { Router } from "express";
import type { AuthUser } from "./auth";
import { requirePermission } from "./access-control";
import { execute, executeChanges, queryRow, queryRows, runImmediateTransaction } from "./crm-db";
import { TOMAN_REPLACEMENT_PURPOSE } from "./legacy-toman-replacement";
import { logCreditRankOverride } from "./credit-rank-override-log";

type Dependencies = {
  scoped: (id: number, actor: AuthUser) => any;
  stages: readonly string[];
  workflowStatus: (stage: any) => string;
  effectivePlanTerms: (plan: any, condition: any) => { maximum: bigint; durations: number[] };
  validatedPrimaryManualValues: (templateId: number, values: unknown) => {
    values?: Record<string, string>; error?: string; fieldErrors?: unknown;
  };
  loanRankOverrideSnapshot: (condition: any, actorId: number, at: string, maximum: string, reason?: string | null) => any;
  documentLabel: (key: string) => string;
};
const parse = (value: unknown): any => { try { return typeof value === "string" ? JSON.parse(value) : null; } catch { return null; } };
const digits = (value: unknown) => String(value ?? "").replace(/[۰-۹٠-٩]/g, c => String("۰۱۲۳۴۵۶۷۸۹".includes(c) ? "۰۱۲۳۴۵۶۷۸۹".indexOf(c) : "٠١٢٣٤٥٦٧٨٩".indexOf(c)));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const planIdOf = (a: any) => Number(a.plan_id ?? parse(a.plan_ids)?.[0] ?? a.plan_ids);
const stamp = () => new Date().toISOString();
function revisionPlan(a: any): any {
  const plan = parse(a.plan_snapshot_json);
  const replacement = a.current_primary_generation_id == null ? null : queryRow<any>(
    `SELECT g.template_id FROM contract_generations g JOIN loan_application_generated_documents d ON d.contract_generation_id=g.id
     WHERE d.application_id=? AND d.kind='primary' AND g.id=? AND g.generation_purpose=?
       AND g.deleted_at IS NULL AND g.superseded_at IS NULL`,
    [a.id, a.current_primary_generation_id, TOMAN_REPLACEMENT_PURPOSE]);
  // An approved Toman correction must not revert to the old Rial template.
  return plan && replacement ? { ...plan, contract_template_id: replacement.template_id } : plan;
}
class AdminCaseError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new AdminCaseError(status, code); };
function posted(id: number): boolean {
  return !!queryRow("SELECT 1 FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?", [id, `loan-application:${id}:credit`]);
}
export function loanCaseFinancialTermsLocked(a: any): boolean {
  return posted(Number(a.id)) || !!a.admin_approved_at || (a.stage === "completed" && a.status === "approved") ||
    !!queryRow(`SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action='admin-stage-corrected'
      AND json_valid(reason) AND json_extract(reason,'$.financialTermsLocked')=1 LIMIT 1`, [a.id]);
}
function guarantor(id: number): any {
  return queryRow<any>("SELECT * FROM loan_application_guarantors WHERE application_id=?", [id]);
}
function contracts(id: number): any[] {
  return queryRows<any>(`SELECT g.id,g.status,g.provider_status,g.superseded_at,g.deleted_at,g.send_claim_id,g.send_claim_expires_at
    FROM contract_generations g JOIN loan_application_generated_documents d ON d.contract_generation_id=g.id
    WHERE d.application_id=? ORDER BY g.id`, [id]);
}
function revision(a: any): string {
  const last = queryRow<any>("SELECT MAX(id) id FROM loan_application_stage_history WHERE application_id=?", [a.id]);
  return createHash("sha256").update(JSON.stringify([a, guarantor(a.id) ?? null, contracts(a.id), last?.id ?? 0])).digest("hex");
}
function beforeState(a: any) {
  const g = guarantor(a.id);
  return {
    stage: a.stage, status: a.status, planId: planIdOf(a), conditionId: parse(a.condition_snapshot_json)?.id ?? null,
    planName: parse(a.plan_snapshot_json)?.name ?? a.plan_name ?? null,
    conditionLabel: parse(a.condition_snapshot_json)?.name ?? null,
    requestedAmount: String(a.requested_amount), durationMonths: Number(a.requested_duration_months ?? a.duration_months),
    approvedAmount: a.approved_amount ?? null, notes: a.notes ?? null,
    netAmount: a.net_amount ?? null, approvedDurationMonths: Number(a.duration_months),
    initialApprovalAt: a.initial_approval_at ?? null,
    initialApprovalByUserId: a.initial_approval_by_user_id ?? null,
    initialApprovalReason: a.initial_approval_reason ?? null,
    currentPrimaryGenerationId: a.current_primary_generation_id ?? null,
    approvedAmountSource: a.approved_amount_source ?? null,
    approvedAmountGenerationId: a.approved_amount_generation_id ?? null,
    needsGuarantor: !!Number(parse(a.condition_snapshot_json)?.needs_guarantor),
    manualValues: parse(a.primary_manual_values_json) ?? {},
    guarantor: g ? { fullName: g.full_name, nationalCode: g.national_code ?? null, mobile: g.mobile ?? null } : null,
  };
}
function baseInput(body: any, allowed: string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) fail(400, "invalid_admin_case_input");
  if (body.confirmed !== true) fail(400, "admin_confirmation_required");
  if (typeof body.reason !== "string" || body.reason.trim().length < 2 || body.reason.trim().length > 2000)
    fail(400, "admin_reason_required");
  if (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision))
    fail(400, "admin_revision_required");
}
function record(a: any, stage: string, action: string, actor: AuthUser, payload: any) {
  execute(`INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at)
    VALUES(?,?,?,?,?,?,?)`, [a.id, a.stage, stage, action, JSON.stringify(payload), actor.id, stamp()]);
}

export function registerLoanCaseAdminControls(router: Router, deps: Dependencies): void {
  const handle = (fn: (req: any, res: any, actor: AuthUser) => unknown) => (req: any, res: any) => {
    const actor = res.locals.authUser as AuthUser | undefined;
    if (actor?.role !== "admin") return res.status(403).json({ error: "admin_only", code: "admin_only" });
    try { return fn(req, res, actor); } catch (error) {
      if (error instanceof AdminCaseError) return res.status(error.status).json({ error: error.code, code: error.code });
      throw error;
    }
  };
  const current = (id: unknown, actor: AuthUser, expected?: string) => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) fail(404, "loan_application_not_found");
    const a = deps.scoped(Number(id), actor);
    if (!a) fail(404, "loan_application_not_found");
    if (expected !== undefined && revision(a) !== expected) fail(409, "admin_case_revision_conflict");
    return a;
  };
  router.get("/loan-applications/:id/admin-controls", requirePermission("loan_applications.view"), handle((req, res, actor) => {
    const a = current(req.params.id, actor), defaults = beforeState(a);
    const currentPlan = revisionPlan(a), currentCondition = parse(a.condition_snapshot_json);
    const plans = queryRows<any>("SELECT * FROM loan_plans WHERE active=1 OR id=? ORDER BY id", [planIdOf(a)]).map(plan => {
      const choicePlan = Number(plan.id) === planIdOf(a) && currentPlan ? currentPlan : plan;
      const templateId = Number(choicePlan.contract_template_id ?? choicePlan.primary_contract_template_id);
      const template = queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]);
      const mappings = parse(template?.mappings_json);
      const choices = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY id", [plan.id]);
      return {
        id: Number(plan.id), name: String(plan.name), active: !!plan.active,
        conditions: choices.map(condition => {
          if (Number(plan.id) === planIdOf(a) && Number(condition.id) === Number(currentCondition?.id)) condition = currentCondition;
          const terms = deps.effectivePlanTerms(choicePlan, currentCondition?.credit_rank_ignored === true ? { ...condition, max_principal: "0" } : condition);
          return { id: Number(condition.id), label: String(condition.name || `شرایط ${condition.id}`),
            maxPrincipal: terms.maximum.toString(), durations: terms.durations, needsGuarantor: !!Number(condition.needs_guarantor) };
        }),
        manualVariables: (Array.isArray(mappings) ? mappings : [])
          .filter((m: any) => (m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual")) === "manual")
          .map((m: any) => ({ variable: String(m.variable), label: String(m.label ?? m.variable) })),
      };
    });
    const { guarantor: g } = defaults;
    const fields = { planId: defaults.planId, conditionId: defaults.conditionId, requestedAmount: defaults.requestedAmount,
      durationMonths: defaults.durationMonths, needsGuarantor: defaults.needsGuarantor, notes: defaults.notes, manualValues: defaults.manualValues };
    return res.json({ revision: revision(a), stage: a.stage, status: a.status, financialPosted: posted(a.id), financialTermsLocked: loanCaseFinancialTermsLocked(a),
      hasContracts: contracts(a.id).some(g => !g.deleted_at && !g.superseded_at), stages: deps.stages,
      defaults: { ...fields, ...(g ? { guarantor: g } : {}) }, plans });
  }));
  router.post("/loan-applications/:id/admin-stage", requirePermission("loan_applications.update"), handle((req, res, actor) => {
    const b = req.body;
    baseInput(b, ["expectedRevision", "stage", "reason", "confirmed"]);
    if (typeof b.stage !== "string" || !deps.stages.includes(b.stage)) fail(400, "invalid_admin_case_stage");
    const result = runImmediateTransaction(() => {
      const a = current(req.params.id, actor, b.expectedRevision);
      if (a.stage === b.stage && a.status !== "rejected") fail(409, "admin_case_no_changes");
      if (["completed", "final_invoice_pending_signature"].includes(b.stage) && !posted(a.id))
        fail(409, "admin_stage_requires_financial_posting");
      const before = beforeState(a), status = deps.workflowStatus(b.stage), ts = stamp();
      executeChanges("UPDATE loan_applications SET stage=?,status=?,updated_at=? WHERE id=?", [b.stage, status, ts, a.id]);
      record(a, b.stage, "admin-stage-corrected", actor, { reason: b.reason.trim(), before,
        after: { ...before, stage: b.stage, status }, financialPostingChanged: false,
        financialTermsLocked: loanCaseFinancialTermsLocked(a) });
      return { ok: true, applicationId: Number(a.id), stage: b.stage, requiresNewContract: false };
    });
    return res.json(result);
  }));
  router.patch("/loan-applications/:id/admin-edit", requirePermission("loan_applications.update"), handle((req, res, actor) => {
    const b = req.body;
    baseInput(b, ["expectedRevision", "reason", "confirmed", "acknowledgeContractRevision", "requestedAmount", "durationMonths",
      "planId", "conditionId", "needsGuarantor", "guarantor", "manualValues", "notes"]);
    if (b.acknowledgeContractRevision !== undefined && typeof b.acknowledgeContractRevision !== "boolean")
      fail(400, "invalid_admin_case_input");
    const result = runImmediateTransaction(() => {
      const a = current(req.params.id, actor, b.expectedRevision), before = beforeState(a);
      const oldPlan = parse(a.plan_snapshot_json), oldCondition = parse(a.condition_snapshot_json);
      const planId = b.planId === undefined ? planIdOf(a) : b.planId;
      const conditionId = b.conditionId === undefined ? oldCondition?.id ?? null : b.conditionId;
      if (!Number.isSafeInteger(planId) || planId < 1 ||
          (conditionId !== null && (!Number.isSafeInteger(conditionId) || conditionId < 1))) fail(400, "invalid_admin_case_input");
      const selectionChanged = planId !== planIdOf(a) || conditionId !== (oldCondition?.id ?? null);
      let plan = revisionPlan(a), condition = oldCondition;
      if (selectionChanged) {
        plan = planId === planIdOf(a) && oldPlan ? revisionPlan(a)
          : queryRow<any>("SELECT * FROM loan_plans WHERE id=? AND active=1", [planId]);
        condition = queryRow<any>("SELECT * FROM loan_plan_conditions WHERE id=? AND plan_id=?", [conditionId, planId]);
        if (!plan || !condition) fail(422, "admin_case_invalid_plan_condition");
        if (oldCondition?.credit_rank_ignored === true) {
          const terms = deps.effectivePlanTerms(plan, { ...condition, max_principal: "0" });
          // The case keeps its «نادیده گرفتن رتبه» exception on the new plan: log it with the admin's edit reason.
          const reason = `ویرایش ادمین (انتقال استثنای رتبه): ${String(b.reason).trim()}`;
          condition = deps.loanRankOverrideSnapshot(condition, actor.id, stamp(), terms.maximum.toString(), reason);
          logCreditRankOverride({ action: "admin_plan_change", actor, customerId: Number(a.customer_id), applicationId: Number(a.id),
            planId: Number(planId), conditionId: Number(conditionId), reason });
        }
      }
      if (b.requestedAmount !== undefined && typeof b.requestedAmount !== "string") fail(400, "invalid_admin_case_terms");
      const amount = b.requestedAmount === undefined ? before.requestedAmount : digits(b.requestedAmount).trim();
      const duration = b.durationMonths === undefined ? before.durationMonths : b.durationMonths;
      if (!/^[1-9]\d{0,17}$/.test(amount) || !Number.isSafeInteger(duration) || duration < 1 || duration > 600)
        fail(400, "invalid_admin_case_terms");
      if (b.needsGuarantor !== undefined && typeof b.needsGuarantor !== "boolean") fail(400, "invalid_admin_case_input");
      const needsGuarantor = b.needsGuarantor === undefined
        ? (selectionChanged ? !!Number(condition?.needs_guarantor) : before.needsGuarantor) : b.needsGuarantor;
      if (!condition && b.needsGuarantor !== undefined) fail(422, "admin_case_invalid_plan_condition");
      if (condition && needsGuarantor !== !!Number(condition.needs_guarantor)) condition = { ...condition, needs_guarantor: needsGuarantor ? 1 : 0 };
      const notes = b.notes === undefined ? before.notes : b.notes;
      if (notes !== null && (typeof notes !== "string" || notes.length > 2000)) fail(400, "invalid_application_notes");
      let manualValues = before.manualValues;
      if (b.manualValues !== undefined || selectionChanged) {
        const input = b.manualValues ?? before.manualValues;
        const validated = deps.validatedPrimaryManualValues(Number(plan?.contract_template_id ?? plan?.primary_contract_template_id), input);
        if (validated.error || !validated.values) fail(422, validated.error ?? "invalid_manual_values");
        manualValues = validated.values;
      }
      const priorGuarantor = guarantor(a.id);
      let g = before.guarantor;
      if (b.guarantor !== undefined) {
        const v = b.guarantor;
        if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["fullName", "nationalCode", "mobile"].includes(k)) ||
            typeof v.fullName !== "string" || v.fullName.trim().length < 2 || v.fullName.trim().length > 200 ||
            (v.nationalCode != null && typeof v.nationalCode !== "string") ||
            (v.mobile != null && typeof v.mobile !== "string")) fail(400, "invalid_guarantor");
        const nationalCode = v.nationalCode == null || v.nationalCode === "" ? null : digits(v.nationalCode).trim();
        const mobile = v.mobile == null || v.mobile === "" ? null : digits(v.mobile).trim();
        if ((nationalCode && !/^\d{10}$/.test(nationalCode)) || (mobile && !/^09\d{9}$/.test(mobile))) fail(400, "invalid_guarantor");
        g = { fullName: v.fullName.trim(), nationalCode, mobile };
      }
      const after = { ...before, planId, conditionId, requestedAmount: amount, durationMonths: duration,
        planName: plan?.name ?? null, conditionLabel: condition?.name ?? null,
        needsGuarantor, notes: notes?.trim() || null, manualValues, guarantor: g };
      const substantive = selectionChanged || amount !== before.requestedAmount || duration !== before.durationMonths ||
        needsGuarantor !== before.needsGuarantor || !same(manualValues, before.manualValues) || !same(g, before.guarantor);
      if (!substantive && after.notes === before.notes) fail(409, "admin_case_no_changes");
      if (substantive && loanCaseFinancialTermsLocked(a)) fail(409, "admin_case_financial_terms_locked");
      if (substantive) {
        const terms = plan && condition ? deps.effectivePlanTerms(plan, condition) : null;
        if (!terms || BigInt(amount) > terms.maximum || !terms.durations.includes(duration)) fail(422, "admin_case_terms_not_eligible");
        const linked = contracts(a.id).filter(g => !g.deleted_at && !g.superseded_at);
        if (linked.some(g => g.status === "sending" || (g.send_claim_id && String(g.send_claim_expires_at) > stamp())))
          fail(409, "admin_case_contract_send_in_progress");
        if (linked.length && b.acknowledgeContractRevision !== true) fail(409, "admin_case_contract_revision_consent_required");
        for (const document of linked) {
          if (queryRow("SELECT 1 FROM loan_application_generated_documents WHERE contract_generation_id=? AND application_id<>? LIMIT 1", [document.id, a.id]))
            fail(409, "admin_case_shared_contract");
        }
      }
      const ts = stamp(), stage = substantive ? "draft" : a.stage;
      const priorPhysicalChecks = substantive ? queryRows("SELECT * FROM loan_physical_checks WHERE application_id=?", [a.id]) : undefined;
      const priorCollateral = substantive ? queryRows("SELECT * FROM loan_application_collateral WHERE application_id=?", [a.id]) : undefined;
      if (substantive) {
        // Keep old files as additional requirements, never overwrite their
        // contents. Newly selected plan requirements must also be represented.
        if (selectionChanged) {
          const separate = new Set(["national_card", "national_card_front", "national_card_back", "birth_certificate_all_pages",
            "birth_cert_p1", "birth_cert_p2", "birth_cert_p3", "guarantee_check", "guarantee_promissory"]);
          const requirementKeys = parse(plan?.required_documents);
          if (plan?.required_documents != null && String(plan.required_documents).trim() !== "" && !Array.isArray(requirementKeys))
            fail(422, "admin_case_invalid_plan_condition");
          const requirements = (requirementKeys ?? []).filter((key: unknown) => !separate.has(String(key)))
            .map((key: unknown) => ({ key: String(key), label: deps.documentLabel(String(key)) }));
          executeChanges("UPDATE loan_applications SET document_requirements_snapshot_json=? WHERE id=?", [JSON.stringify(requirements), a.id]);
          for (const item of requirements) {
            if (!queryRow("SELECT 1 FROM loan_application_documents WHERE application_id=? AND requirement_key=? AND source='plan'", [a.id, item.key]))
              execute(`INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at)
                VALUES(?,?,?,'plan',?)`, [a.id, item.key, item.label, ts]);
          }
        }
        executeChanges(`UPDATE contract_generations SET superseded_at=?,updated_at=? WHERE id IN
          (SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=?)
          AND deleted_at IS NULL AND superseded_at IS NULL`, [ts, ts, a.id]);
        executeChanges(`UPDATE loan_applications SET plan_id=?,plan_ids=?,plan_snapshot_json=?,condition_snapshot_json=?,
          requested_amount=?,requested_duration_months=?,duration_months=?,primary_manual_values_json=?,notes=?,stage='draft',status='requested',
          approved_amount=NULL,net_amount=NULL,initial_approval_at=NULL,initial_approval_by_user_id=NULL,initial_approval_reason=NULL,
          approved_amount_source=NULL,approved_amount_generation_id=NULL,approved_amount_reconciled_at=NULL,approved_amount_reconciled_by_user_id=NULL,
          current_primary_generation_id=NULL,initial_contract_retained=0,new_case_workflow=1,
          funder_decision=NULL,funder_reason=NULL,updated_at=? WHERE id=?`,
        [planId, JSON.stringify([planId]), JSON.stringify(plan), JSON.stringify(condition), amount, duration, duration, JSON.stringify(manualValues), after.notes, ts, a.id]);
        executeChanges("UPDATE loan_physical_checks SET status='incomplete',reason=? WHERE application_id=?", ["ویرایش مدیریتی پرونده؛ بررسی مجدد لازم است.", a.id]);
        executeChanges("UPDATE loan_application_collateral SET status='submitted',reviewed_at=NULL WHERE application_id=?", [a.id]);
        if (!same(g, before.guarantor))
          executeChanges(`UPDATE loan_application_guarantor_documents SET status='rejected',rejection_reason=?
            WHERE guarantor_id IN (SELECT id FROM loan_application_guarantors WHERE application_id=?)`,
          ["اطلاعات ضامن توسط ادمین تغییر کرده است؛ بررسی یا بارگذاری مجدد لازم است.", a.id]);
      } else executeChanges("UPDATE loan_applications SET notes=?,updated_at=? WHERE id=?", [after.notes, ts, a.id]);
      if (g && !same(g, before.guarantor)) {
        execute(`INSERT INTO loan_application_guarantors(application_id,full_name,national_code,mobile,data_json,created_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET full_name=excluded.full_name,
          data_json=CASE WHEN national_code IS NOT excluded.national_code OR full_name IS NOT excluded.full_name
            THEN '{}' ELSE data_json END,national_code=excluded.national_code,mobile=excluded.mobile`,
        [a.id, g.fullName, g.nationalCode, g.mobile, "{}", ts]);
      }
      record(a, stage, "admin-case-edited", actor, { reason: b.reason.trim(), before,
        after: { ...after, stage, status: substantive ? "requested" : a.status, approvedAmount: substantive ? null : before.approvedAmount,
          ...(substantive ? { netAmount: null, approvedDurationMonths: duration, initialApprovalAt: null, initialApprovalByUserId: null,
            initialApprovalReason: null, currentPrimaryGenerationId: null, approvedAmountSource: null, approvedAmountGenerationId: null } : {}) },
        requiresNewContract: substantive, financialPostingChanged: false,
        priorPhysicalChecks, priorCollateral,
        priorGuarantorData: !same(g, before.guarantor) ? parse(priorGuarantor?.data_json) : undefined,
        priorPlanSnapshot: substantive ? oldPlan : undefined, priorConditionSnapshot: substantive ? oldCondition : undefined });
      return { ok: true, applicationId: Number(a.id), stage, requiresNewContract: substantive };
    });
    return res.json(result);
  }));
}

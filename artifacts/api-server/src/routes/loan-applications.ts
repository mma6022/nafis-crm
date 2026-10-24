import { Router } from "express";
import { customerSearchSql } from "../lib/customer-id-search";
import { conditionAcceptsCreditRank } from "../lib/credit-rank-eligibility";
import { loanCreditRankOverrideError, loanCreditRankOverrideReason, loanRankOverrideSnapshot } from "../lib/loan-credit-rank-override";
import { guarantorGradeAllows, guarantorGradeVerdict } from "../lib/guarantor-grade-rule";
import { customerGuarantorGrade } from "../lib/guarantor-grade-source";
import { creditRankOverridesForApplication, listCreditRankOverrides, logCreditRankOverride } from "../lib/credit-rank-override-log";
export { conditionAcceptsCreditRank } from "../lib/credit-rank-eligibility";
import { supportedDocumentUpload } from "../lib/document-upload-type";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { crmDb, databasePath, execute, executeChanges, queryRow, queryRows, runImmediateTransaction, runTransaction } from "../lib/crm-db";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { canCancelLoanCase, registerLoanCaseCancellation } from "../lib/loan-case-cancellation";
import { loanCaseFinancialTermsLocked, registerLoanCaseAdminControls } from "../lib/loan-case-admin-controls";
import { registerLoanCaseNotes } from "../lib/loan-case-notes";
import { canReapproveInitialDecision } from "../lib/initial-approval-reentry";
import { returnRejectedLoanCase } from "../lib/loan-rejection-return";
import { rejectedDeliveryReusesFile } from "../lib/rejected-contract-resend";
import { acceptedLegacyRialPrimary } from "../lib/accepted-legacy-rial-primary";
import { logger } from "../lib/logger";
import { loanPlanNetAmount } from "../lib/loan-plan-net-amount";
import { classifyProviderState, isStrictSignedProviderState, providerContractState } from "../lib/emzame-signature";
import { emzameRequest } from "../lib/emzame-client";
import { creditLoanWallet, wallet } from "../lib/wallets";
import {
  isAttestedTomanTemplate,
  renderedPdfContainsInstallmentCount,
  renderedPdfContainsLegacyRialPrincipal,
  renderedPdfContainsPrincipal,
  type RenderedPrincipalTemplateEvidence,
} from "../lib/contract-evidence";
import {
  TOMAN_REPLACEMENT_ACTION,
  TOMAN_REPLACEMENT_PURPOSE,
  parseTomanReplacementConsent,
  tomanReplacementGenerationTermsMatch,
  tomanReplacementDurationChanged,
  tomanReplacementNeedsInstallmentProof,
  type TomanReplacementConsent,
} from "../lib/legacy-toman-replacement";

const router = Router();
const stages = ["funder_initial_approval", "draft", "primary_contract_pending_signature", "approved_contract_pending_signature", "customer_documents_upload", "customer_documents_review",
  "guarantor_registration", "guarantor_documents_upload", "guarantor_documents_review", "collateral_upload", "collateral_review",
  "expert_approval", "funder_amendment_pending_signature", "funder_amendment_review", "funder_result_review", "funder_documents_correction", "physical_documents_submission", "physical_documents_review", "physical_documents_correction",
  "wallet_charge_pending", "admin_approval", "final_invoice_pending_signature", "completed"] as const;
type Stage = typeof stages[number];
import { closeDraftsForCase, draftForFeeCharge, draftForSubmit, linkDraftFee } from "../lib/loan-request-drafts";
const now = () => new Date().toISOString();
const user = (res: any) => res.locals.authUser as AuthUser;
const uploadRoot = path.join(path.dirname(databasePath), "loan-application-files");
const identityRoot = path.join(path.dirname(databasePath), "customer-identity-documents");
const contractTemplateRoot = path.resolve(process.env.CONTRACTS_STORAGE_DIR || path.join(path.dirname(databasePath), "contracts"), "templates");
const contractGenerationRoot = path.resolve(process.env.CONTRACTS_STORAGE_DIR || path.join(path.dirname(databasePath), "contracts"), "generations");
fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(identityRoot, { recursive: true, mode: 0o700 });
try { fs.chmodSync(uploadRoot, 0o700); } catch { /* explicit private mode */ }
const uploadRootReal = fs.realpathSync(uploadRoot);
const identityRootReal = fs.realpathSync(identityRoot);
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 }, storage: multer.memoryStorage() });
const fileType = supportedDocumentUpload;
const rasterImageType = (mime: unknown) => new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(String(mime).toLowerCase());
function safeExtension(filename: string): string {
  const extension = path.extname(path.basename(filename)).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : "bin";
}
function normalizedUploadName(filename: string): string {
  const name = path.basename(String(filename || "file"));
  if (!/[ÃØÙÚÛ]/.test(name)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded;
}
function storeFile(appId: number, f: Express.Multer.File): string {
  const dir = path.join(uploadRoot, String(appId)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${crypto.randomUUID()}.${safeExtension(f.originalname)}`);
  fs.writeFileSync(target, f.buffer, { mode: 0o600 }); return target;
}
function storeIdentityFile(customerId: number, f: Express.Multer.File): string {
  const dir = path.join(identityRoot, String(customerId)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${crypto.randomUUID()}.${f.mimetype === "application/pdf" ? "pdf" : f.mimetype === "image/png" ? "png" : "jpg"}`);
  fs.writeFileSync(target, f.buffer, { mode: 0o600 }); return target;
}

function scoped(id: number, u: AuthUser): any {
  const condition = u.role === "admin" || u.customerScope !== "assigned" ? "" : " AND current_customer.salesperson_id = ?";
  const params: any[] = [id]; if (condition) params.push(u.salespersonId);
  return queryRow<any>(`SELECT a.*,c.name customer_name,cs.id customer_salesperson_id,cs.name customer_salesperson_name,p.name plan_name
    FROM loan_applications a JOIN customers c ON c.id=a.customer_id
    LEFT JOIN customer_merge_audit merge_audit ON merge_audit.source_customer_id=c.id AND merge_audit.survivor_customer_id=c.merged_into_customer_id
    JOIN customers current_customer ON current_customer.id=CASE WHEN c.merged_into_customer_id IS NULL THEN c.id ELSE merge_audit.survivor_customer_id END AND current_customer.merged_into_customer_id IS NULL
    LEFT JOIN salespersons cs ON cs.id=current_customer.salesperson_id
    LEFT JOIN loan_plans p ON p.id=COALESCE(a.plan_id, CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END)
    WHERE a.id=? AND a.deleted_at IS NULL${condition}`, params);
}
function error(res: any, status: number, code: string) {
  if (res.req?.method === "POST" && res.req?.route?.path === "/loan-applications")
    res.req.log?.warn({ code, status }, "initial loan application rejected");
  return res.status(status).json({ error: code, code });
}
function fileExists(rawPath: unknown): boolean {
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;
  try { return fs.statSync(fs.realpathSync(rawPath)).isFile(); } catch { return false; }
}
function shape(r: any, actor: AuthUser): any {
  if (!r) return r;
  const cancellation = queryRow<{ reason: string }>(
    "SELECT reason FROM loan_application_stage_history WHERE application_id=? AND action='cancel-case' ORDER BY id DESC LIMIT 1", [r.id],
  );
  const primaryGenerationId = applicationPrimaryGenerationId(r);
  const registrarReview = ["customer_documents_review", "guarantor_documents_review", "collateral_review", "physical_documents_review"].includes(r.stage)
    ? { stage: r.stage, ...registrarReviewState(r) }
    : null;
  const planIds = parseJson(r.plan_ids);
  const actionRoles: Record<string, string> = {
    funder_initial_approval: "registrar",
    draft: "salesperson", primary_contract_pending_signature: "salesperson", approved_contract_pending_signature: "salesperson", customer_documents_upload: "salesperson",
    customer_documents_review: "registrar", guarantor_registration: "salesperson", guarantor_documents_upload: "salesperson",
    guarantor_documents_review: "registrar", collateral_upload: "salesperson", collateral_review: "registrar",
      expert_approval: "registrar", funder_amendment_pending_signature: "salesperson", funder_amendment_review: "registrar", funder_result_review: "registrar", physical_documents_submission: "salesperson", physical_documents_review: "registrar",
     funder_documents_correction: "salesperson", physical_documents_correction: "salesperson", wallet_charge_pending: "registrar",
     admin_approval: "admin", final_invoice_pending_signature: "salesperson",
  };
  const businessStatuses: Record<string, string> = {
    funder_initial_approval: "waiting_registration",
    draft: "waiting_sales", primary_contract_pending_signature: "waiting_customer_signature", approved_contract_pending_signature: "waiting_customer_signature", customer_documents_upload: "waiting_sales",
     customer_documents_review: "waiting_registration", guarantor_registration: "waiting_sales",
     guarantor_documents_upload: "waiting_sales", guarantor_documents_review: "waiting_registration",
     collateral_upload: "waiting_sales", collateral_review: "waiting_registration",
      expert_approval: "waiting_registration", funder_amendment_pending_signature: "waiting_sales", funder_amendment_review: "waiting_registration", funder_result_review: "waiting_registration",
      funder_documents_correction: "waiting_sales", physical_documents_submission: "waiting_sales", physical_documents_review: "waiting_registration", physical_documents_correction: "waiting_sales",
     wallet_charge_pending: "waiting_wallet_charge", admin_approval: "waiting_wallet_charge",
    final_invoice_pending_signature: "wallet_charged", completed: "completed",
  };
  const businessStatus = r.status === "rejected" ? "canceled" : (businessStatuses[r.stage] ?? r.stage);
  return { id: Number(r.id), customerSubmitted: !!r.created_by_customer_id, customerId: Number(r.customer_id), customerName: r.customer_name ?? "",
    customerSalespersonName: r.customer_salesperson_name ?? null,
    customerSalespersonId: r.customer_salesperson_id == null ? null : Number(r.customer_salesperson_id),
    salespersonIdSnapshot: r.salesperson_id_snapshot == null ? null : Number(r.salesperson_id_snapshot),
    salespersonNameSnapshot: r.salesperson_name_snapshot ?? null,
    planId: Number(r.plan_id ?? (Array.isArray(planIds) ? planIds[0] : r.plan_ids)), planIds: Array.isArray(planIds) ? planIds : [Number(r.plan_id ?? r.plan_ids)],
    planName: r.plan_name ?? null, consultationId: Number(r.consultation_id),
     requestedAmount: r.requested_amount, requestedDurationMonths: Number(r.requested_duration_months ?? r.duration_months), approvedAmount: r.approved_amount ?? null, netAmount: r.net_amount ?? null,
      approvedAmountSource: r.approved_amount_source ?? null,
      approvedAmountGenerationId: r.approved_amount_generation_id == null ? null : Number(r.approved_amount_generation_id),
      approvedAmountReconciledAt: r.approved_amount_reconciled_at ?? null,
      approvedAmountReconciledByUserId: r.approved_amount_reconciled_by_user_id == null ? null : Number(r.approved_amount_reconciled_by_user_id),
     durationMonths: r.duration_months, stage: r.stage, status: r.status,
     newCaseWorkflow: Number(r.new_case_workflow) === 1,
     initialContractRetained: Number(r.initial_contract_retained) === 1,
      planSnapshot: parseJson(r.plan_snapshot_json),
      primaryManualValues: parseJson(r.primary_manual_values_json) ?? {},
      primaryManualVariables: (() => {
        const snapshot = parseJson(r.plan_snapshot_json);
        const consent = latestTomanReplacementConsent(Number(r.id))?.consent;
        const templateId = Number(consent?.tomanTemplateId ?? snapshot?.contract_template_id ?? snapshot?.primary_contract_template_id);
        const template = templateId ? queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]) : null;
        return (parseJson(template?.mappings_json) ?? []).filter((mapping: any) =>
          (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "manual")
          .map((mapping: any) => ({ variable: String(mapping.variable), label: String(mapping.label ?? mapping.variable) }));
      })(),
    creditRankIgnored: parseJson(r.condition_snapshot_json)?.credit_rank_ignored === true,
    conditionSnapshot: parseJson(r.condition_snapshot_json), calculation: r.net_amount ? { requestedAmount: r.requested_amount, approvedAmount: r.approved_amount, netAmount: r.net_amount } : null,
    documents: r.documents ?? [], identityDocuments: r.identityDocuments ?? [], requiredCollateral: r.requiredCollateral ?? [],
     guarantor: r.guarantor ?? null, collateral: r.collateral ?? [], currentPrimaryGenerationId: primaryGenerationId,
     primaryContractStatus: primaryGenerationId == null ? null
       : (r.generatedDocuments ?? []).find((d: any) => d.kind === "primary" && Number(d.contract_generation_id) === primaryGenerationId)?.generation_status ?? null,
    generatedDocuments: (r.generatedDocuments ?? []).map((d: any) => ({
      ...d,
      contractGenerationId: d.contract_generation_id,
      resendRepairRequired: d.kind === "primary" && Number(d.contract_generation_id) === primaryGenerationId &&
        d.generation_status === "sent" && String(d.provider_status ?? "").toLowerCase() === "readyforsign" &&
        rejectedDeliveryReusesFile(queryRow("SELECT * FROM contract_generations WHERE id=?", [d.contract_generation_id]), queryRow),
       current: d.kind === "primary" && primaryGenerationId != null && Number(d.contract_generation_id) === primaryGenerationId,
      reviewReason: d.review_reason ?? null,
      supersededAt: d.generation_superseded_at ?? null,
      superseded: Boolean(d.generation_superseded_at),
      signed: typeof d.link === "string" && d.link.startsWith("signed:") && d.generation_status === "signed" &&
        isStrictSignedProviderState(d.provider_status),
      fileAvailable: Boolean(d.fileAvailable),
      downloadUrl: d.fileAvailable && d.contract_generation_id ? `/api/contracts/generations/${d.contract_generation_id}/download/pdf` : null,
    })),
      history: r.history ?? [], physicalChecks: r.physicalChecks ?? [], physicalDocuments: r.physicalDocuments ?? [], funderDefects: r.funderDefects ?? [],
       ...(Object.prototype.hasOwnProperty.call(r, "tomanReplacementEligibility")
         ? { tomanReplacementEligibility: r.tomanReplacementEligibility } : {}),
       ...(Object.prototype.hasOwnProperty.call(r, "tomanReplacement")
         ? { tomanReplacement: r.tomanReplacement } : {}),
     funderDecision: r.funder_decision ?? null, funderReason: r.funder_reason ?? null,
      initialProviderDecision: r.initial_approval_at ? { decision: r.status === "rejected" && !cancellation ? "rejected" : "approved",
        decidedAt: r.initial_approval_at,
        actorUserId: r.initial_approval_by_user_id == null ? null : Number(r.initial_approval_by_user_id),
        reason: r.initial_approval_reason ?? null } : null,
      registrarReview,
      canCancel: canCancelLoanCase(r, actor),
      cancellationReason: cancellation?.reason ?? null,
      actionRequired: !["primary_contract_pending_signature", "approved_contract_pending_signature"].includes(r.stage) && canAct(r.stage, actor, Number(r.customer_id), r.status), actionRole: actionRoles[r.stage] ?? "customer", businessStatus, createdAt: r.created_at, updatedAt: r.updated_at ?? r.created_at };
}
function parseJson(value: any) { try { return value ? JSON.parse(value) : null; } catch { return null; } }
export function freshSuccessfulCredit(customerId: number) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return queryRow<any>(
    `SELECT checks.status,checks.completed_at,checks.score,checks.score_label
     FROM customer_credit_checks checks
     JOIN customers c ON c.id=checks.customer_id
     WHERE checks.customer_id=? AND checks.status='report_generated' AND checks.completed_at>=?
       AND (c.identity_changed_at IS NULL OR (
         checks.created_at>c.identity_changed_at AND checks.completed_at>c.identity_changed_at
       ))
     ORDER BY checks.completed_at DESC,checks.id DESC LIMIT 1`,
    [customerId, cutoff],
  );
}
const freshIdentityDocumentTypes = new Set([
  "national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3",
]);
export function hasFreshIdentityDocuments(customerId: number): boolean {
  const rows = queryRows<{ document_type: string }>(
    `SELECT DISTINCT d.document_type
     FROM customer_identity_documents d
     JOIN customers c ON c.id=d.customer_id
     WHERE d.customer_id=? AND d.is_latest=1
       AND d.document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')
       AND (c.identity_changed_at IS NULL OR d.created_at>c.identity_changed_at)`,
    [customerId],
  );
  return rows.length === freshIdentityDocumentTypes.size &&
    [...freshIdentityDocumentTypes].every((type) => rows.some((row) => row.document_type === type));
}
export function reusableFilingFeeCharge(customerId: number, planId: number) {
  return queryRow<any>(
    `SELECT charge.*,active_application.id AS active_application_id
     FROM loan_filing_fee_charges charge
     LEFT JOIN loan_applications active_application
       ON active_application.id=charge.application_id
       AND active_application.customer_id=charge.customer_id
       AND active_application.plan_id=charge.plan_id
       AND active_application.deleted_at IS NULL
       AND active_application.status<>'rejected'
     WHERE charge.customer_id=? AND charge.plan_id=?
       AND (charge.application_id IS NULL OR active_application.id IS NOT NULL)
     ORDER BY CASE WHEN active_application.id IS NOT NULL THEN 0 ELSE 1 END,
       CASE WHEN active_application.id IS NOT NULL THEN charge.id END DESC,
       charge.id ASC
     LIMIT 1`,
    [customerId, planId],
  );
}
export function filingFeePrerequisiteError(customer: any, ignoreCreditRank = false): string | null {
  if (!String(customer?.national_code ?? "").trim() || !String(customer?.phone ?? "").trim()
    || !String(customer?.birth_date_jalali ?? "").trim()) return "customer_profile_incomplete";
  if (customer.verification_status !== "verified") return "customer_identity_not_verified";
  if (!ignoreCreditRank && !freshSuccessfulCredit(Number(customer.id))) return "credit_check_stale";
  return null;
}
export function planAcceptsCustomerCredit(planId: number, customerId: number, ignoreCreditRank = false): boolean {
  const credit = freshSuccessfulCredit(customerId);
  if (!ignoreCreditRank && !credit) return false;
  const guarantor = ignoreCreditRank ? null : customerGuarantorGrade(customerId);
  return queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=?", [planId]).some((condition) => {
    const ranks = parseJson(condition.customer_ranks)
      ?? String(condition.customer_ranks ?? "").split(/[,،]/).map((value: string) => value.trim()).filter(Boolean);
    const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=?", [planId]);
    const terms = effectivePlanTerms(plan, ignoreCreditRank ? { ...condition, max_principal: "0" } : condition);
    return (ignoreCreditRank || (conditionAcceptsCreditRank(credit.score_label, ranks)
      && guarantorGradeAllows(guarantorGradeVerdict(condition, guarantor?.rank, plan)))) && terms.maximum > 0n && terms.durations.length > 0;
  });
}
export function effectivePlanTerms(plan: any, condition: any) {
  const digits = (value: unknown) => BigInt(String(value ?? "0")
    .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/\D/g, "") || "0");
  const conditionMax = digits(condition.max_principal);
  const planMax = digits(plan.principal_amount);
  const maximum = conditionMax === 0n ? planMax : planMax === 0n ? conditionMax : conditionMax < planMax ? conditionMax : planMax;
  const conditionDurations = parseJson(condition.installment_options);
  const planDurations = (parseJson(plan.installment_terms) ?? []).map((term: any) => typeof term === "object" ? term.installments : term);
  const durations = (Array.isArray(conditionDurations) && conditionDurations.length ? conditionDurations : planDurations)
    .map(Number).filter((value: number) => Number.isInteger(value) && value > 0);
  return { maximum, durations };
}
export function payablePlan(planId: number): any | undefined {
  const plan = queryRow<any>(`SELECT * FROM loan_plans WHERE id=? AND active=1
    AND COALESCE(contract_template_id,primary_contract_template_id) IS NOT NULL`, [planId]);
  if (!plan) return undefined;
  const conditions = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=?", [planId]);
  return conditions.some((condition) => {
    const terms = effectivePlanTerms(plan, condition);
    return terms.maximum > 0n && terms.durations.length > 0;
  }) ? plan : undefined;
}
export function validatedPrimaryManualValues(templateId: number, input: unknown): { values?: Record<string, string>; error?: string; fieldErrors?: Record<string, string> } {
  const template = queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]);
  const mappings = parseJson(template?.mappings_json);
  if (!template || !Array.isArray(mappings)) return { error: "application_contract_template_missing" };
  const principalMappings = mappings.filter((mapping: any) =>
    (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
    mapping.loanPlanField === "loanPlan.principalAmount");
  if (principalMappings.length !== 1) return { error: "primary_template_missing_principal_mapping" };
  if (input == null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { error: "manual_values_invalid" };
  const manual = mappings.filter((mapping: any) =>
    (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "manual");
  const variables = manual.map((mapping: any) => String(mapping.variable ?? ""));
  if (variables.some((variable: string) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(variable)) || new Set(variables).size !== variables.length)
    return { error: "application_contract_template_invalid" };
  const values = input as Record<string, unknown>;
  const expected = new Set(variables);
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(values)) if (!expected.has(key)) fieldErrors[key] = "unknown_manual_variable";
  const normalized: Record<string, string> = {};
  let totalLength = 0;
  for (const variable of variables) {
    const value = values[variable];
    if (typeof value !== "string" || !value.trim()) {
      fieldErrors[variable] = "manual_value_required";
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 5000) {
      fieldErrors[variable] = "manual_value_too_long";
      continue;
    }
    normalized[variable] = trimmed;
    totalLength += trimmed.length;
  }
  if (totalLength > 50 * 1024) return { error: "manual_values_too_long" };
  return Object.keys(fieldErrors).length ? { error: "invalid_manual_values", fieldErrors } : { values: normalized };
}
const actionPolicy: Record<string, string[]> = {
  funder_initial_approval: ["registrar", "admin"],
  draft: ["salesperson", "admin"], customer_documents_upload: ["salesperson", "admin"],
  guarantor_registration: ["salesperson", "admin"], guarantor_documents_upload: ["salesperson", "admin"],
  collateral_upload: ["salesperson", "registrar", "admin"], customer_documents_review: ["registrar", "admin"],
  guarantor_documents_review: ["registrar", "admin"], collateral_review: ["registrar", "admin"],
    expert_approval: ["registrar", "admin"], funder_amendment_pending_signature: ["salesperson", "admin"], funder_amendment_review: ["registrar", "admin"], funder_result_review: ["registrar", "admin"],
    physical_documents_submission: ["salesperson", "registrar", "admin"], physical_documents_review: ["registrar", "admin"], physical_documents_correction: ["salesperson", "admin"],
   funder_documents_correction: ["salesperson", "admin"],
   wallet_charge_pending: ["registrar", "admin"], admin_approval: ["admin"],
  primary_contract_pending_signature: ["salesperson", "admin"], approved_contract_pending_signature: ["salesperson", "admin"],
  final_invoice_pending_signature: ["salesperson", "admin"], completed: [],
};
function canAct(stage: string, actor: AuthUser, customerId?: number, status?: string): boolean {
  if (status === "rejected") return false;
  if (actor.role === "admin") return Boolean(actionPolicy[stage]?.length);
  if (!actionPolicy[stage]?.includes(actor.role)) return false;
  return actor.role !== "salesperson" || actor.customerScope !== "assigned" || customerId == null ||
    queryRow("SELECT 1 FROM customers WHERE id=? AND salesperson_id=?", [customerId, actor.salespersonId]) != null;
}
type CollateralSlot = { key: string; party: "customer" | "guarantor"; type: string; side: "front" | "back" | "single"; label: string };
function requiredCollateralSlots(condition: any): CollateralSlot[] {
  const slots: CollateralSlot[] = [];
  const add = (party: "customer" | "guarantor", rawType: unknown) => {
    const type = String(rawType ?? "").trim();
    if (!type || ["none", "null", "undefined", "deposit"].includes(type)) return; // "deposit": removed option, legacy values ignored
    const normalized = type.includes("check") ? "check" : type.includes("promissory") ? "promissory" : type.includes("salary") ? "salary_deduction" : type;
    const title = normalized === "check" ? "چک" : normalized === "promissory" ? "سفته" : normalized === "salary_deduction" ? "گواهی کسر از حقوق" : "وثیقه";
    const owner = party === "customer" ? "مشتری" : "ضامن";
    for (const side of normalized === "check" ? ["front", "back"] as const : ["single"] as const) {
      const sideLabel = side === "front" ? "روی" : side === "back" ? "پشت" : "";
      const key = `${party}:${normalized}:${side}`;
      if (!slots.some((item) => item.key === key)) slots.push({ key, party, type: normalized, side, label: `${sideLabel} ${title} ${owner}`.trim() });
    }
  };
  add("customer", condition?.collateral_type ?? condition?.collateralType);
  if (condition?.needs_customer_check) add("customer", "check");
  if (condition?.needs_customer_promissory) add("customer", "promissory");
  if (condition?.needs_customer_salary_deduct) add("customer", "salary_deduction");
  if (condition?.needs_guarantor || condition?.needsGuarantor) {
    add("guarantor", condition?.guarantor_collateral_type ?? condition?.guarantorCollateralType);
    if (condition?.needs_guarantor_check) add("guarantor", "check");
    if (condition?.needs_guarantor_promissory) add("guarantor", "promissory");
    if (condition?.needs_guarantor_salary_deduct) add("guarantor", "salary_deduction");
  }
  return slots;
}
function collateralMetadata(row: any): any { return parseJson(row?.data_json) ?? {}; }
function collateralComplete(applicationId: number, approved: boolean): boolean {
  const app = queryRow<any>("SELECT condition_snapshot_json FROM loan_applications WHERE id=?", [applicationId]);
  const slots = requiredCollateralSlots(parseJson(app?.condition_snapshot_json));
  if (!slots.length) return true;
  const rows = queryRows<any>("SELECT * FROM loan_application_collateral WHERE application_id=?", [applicationId]);
  return slots.every((slot) => rows.some((row) => collateralMetadata(row).requirementKey === slot.key && fileExists(row.storage_path) && (!approved || row.status === "approved")));
}
function registrarReviewState(r: any): { allReviewed: boolean; allApproved: boolean; hasDefect: boolean } {
  let statuses: string[] = [];
  if (r.stage === "customer_documents_review") {
    const documents = loanProcessingDocuments(r.id);
    const identities = queryRows<any>("SELECT approved_at,review_reason,storage_path FROM customer_identity_documents WHERE customer_id=? AND is_latest=1 AND document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')", [r.customer_id]);
    const primary = applicationPrimaryDocument(r);
    const contract = primary ? {
      status: primary.document_status,
      link: primary.link,
      generation_status: primary.status,
      provider_status: primary.provider_status,
      pdf_path: primary.pdf_path,
      superseded_at: primary.superseded_at,
    } : null;
    statuses = [
      ...documents.map((d) => ["incomplete", "rejected"].includes(d.status) ? d.status : fileExists(d.storage_path) ? d.status : "pending"),
      ...(identities.length === 5 ? identities.map((d) => d.review_reason ? "incomplete" : fileExists(d.storage_path) && d.approved_at ? "approved" : "pending") : ["pending"]),
      contract && ["incomplete", "rejected"].includes(contract.status) ? contract.status
        : contract?.link?.startsWith("signed:") && contract.generation_status === "signed" &&
          isStrictSignedProviderState(contract.provider_status) && !contract.superseded_at && fileExists(contract.pdf_path) ? contract.status : "pending",
    ];
  } else if (r.stage === "guarantor_documents_review") {
    const guarantor = queryRow<any>("SELECT id FROM loan_application_guarantors WHERE application_id=?", [r.id]);
    const documents = queryRows<any>("SELECT d.status,d.storage_path FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=?", [r.id]);
    // No separate guarantor document is mandatory unless a row exists.
    // Cheques/promissory notes are reviewed later as collateral, not here.
    statuses = guarantor
      ? documents.map((d) => fileExists(d.storage_path) || ["incomplete", "rejected"].includes(d.status) ? d.status : "pending")
      : ["pending"];
  } else if (r.stage === "collateral_review") {
    const slots = requiredCollateralSlots(parseJson(r.condition_snapshot_json));
    const documents = queryRows<any>("SELECT status,data_json,storage_path FROM loan_application_collateral WHERE application_id=?", [r.id]);
    statuses = slots.map((slot) => {
      const document = documents.find((d) => collateralMetadata(d).requirementKey === slot.key);
      return document && (fileExists(document.storage_path) || ["incomplete", "rejected"].includes(document.status)) ? document.status : "pending";
    });
  } else if (r.stage === "physical_documents_review") {
    const checks = queryRows<any>("SELECT status FROM loan_physical_checks WHERE application_id=?", [r.id]);
    // Legacy cases may not have materialized their physical checklist yet.
    // Treat that as pending until the transition validates/builds real checks.
    statuses = checks.length ? checks.map((check) => check.status) : ["pending"];
  }
  const allReviewed = statuses.every((status) => ["approved", "incomplete", "rejected"].includes(status));
  const allApproved = allReviewed && statuses.every((status) => status === "approved");
  // A known defect is actionable as soon as it is recorded. It must not be
  // hidden just because another item is still awaiting review.
  const hasDefect = statuses.some((status) => status === "incomplete" || status === "rejected");
  return { allReviewed, allApproved, hasDefect };
}
function recordReview(applicationId: number, stage: string, action: string, reason: string | null, actorId: number) {
  execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
    [applicationId, stage, stage, action, reason, actorId, now()]);
}
function workflowStatus(stage: Stage): "requested" | "reviewing" | "approved" {
  if (stage === "draft" || stage === "primary_contract_pending_signature" || stage === "approved_contract_pending_signature") return "requested";
  if (stage === "completed") return "approved";
  return "reviewing";
}
const identityTypes = new Set(["national_card_front", "national_card_back", "birth_cert_p1", "birth_cert_p2", "birth_cert_p3"]);
const identityRequirementKeys = new Set([...identityTypes, "national_card", "birth_certificate_all_pages"]);
const collateralRequirementKeys = new Set(["guarantee_check", "guarantee_promissory"]);
const separateRequirementKeys = new Set([...identityRequirementKeys, ...collateralRequirementKeys]);
function loanProcessingDocuments(applicationId: number): any[] {
  return queryRows<any>(
    "SELECT * FROM loan_application_documents WHERE application_id=? AND source IN ('plan','manual') ORDER BY id",
    [applicationId],
  ).filter((document) => !separateRequirementKeys.has(String(document.requirement_key ?? "")));
}
const identityLabels: Record<string, string> = {
  national_card_front: "کارت ملی - روی کارت",
  national_card_back: "کارت ملی - پشت کارت",
  birth_cert_p1: "شناسنامه - صفحه اول",
  birth_cert_p2: "شناسنامه - صفحه دوم",
  birth_cert_p3: "شناسنامه - صفحه سوم",
};
export function documentLabel(key: string): string {
  return queryRow<{ label: string }>("SELECT label_fa AS label FROM consult_options WHERE field_key='required_document' AND option_value=?", [key])?.label ?? identityLabels[key] ?? "مدرک موردنیاز طرح";
}
router.post("/customers/:customerId/identity-documents", requirePermission("customers.update"), upload.single("file"), (req, res) => {
  const u = user(res), customerId = Number(req.params.customerId), type = String(req.body?.documentType || "");
  const customer = queryRow<any>("SELECT id,salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!customer || (u.customerScope === "assigned" && customer.salesperson_id !== u.salespersonId)) return error(res, 404, "customer_not_found");
  if (!req.file || !identityTypes.has(type) || !fileType(req.file)) return error(res, 400, "invalid_identity_document");
  const target = storeIdentityFile(customerId, req.file);
  const digest = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  const id = runTransaction(() => {
    executeChanges("UPDATE customer_identity_documents SET is_latest=0 WHERE customer_id=? AND document_type=? AND is_latest=1", [customerId, type]);
    const previous = queryRow<{ version: number }>("SELECT COALESCE(MAX(version),0) version FROM customer_identity_documents WHERE customer_id=? AND document_type=?", [customerId, type]);
    return execute("INSERT INTO customer_identity_documents(customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,created_by_user_id,created_at,version,is_latest) VALUES(?,?,?,?,?,?,?,?,?,?,1)",
      [customerId, type, target, req.file!.originalname, req.file!.mimetype, req.file!.size, digest, u.id, now(), Number(previous?.version ?? 0) + 1]);
  });
  for (const application of queryRows<any>("SELECT id,stage FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL", [customerId])) {
    recordReview(application.id, application.stage, `identity_document_uploaded:${type}:${id}`, null, u.id);
  }
  res.status(201).json(queryRow("SELECT id,customer_id AS customerId,document_type AS documentType,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,created_at AS createdAt FROM customer_identity_documents WHERE id=?", [id]));
});
router.get("/customers/:customerId/identity-documents", requirePermission("customers.view"), (req, res) => {
  const c = getScopedCustomer(Number(req.params.customerId), user(res));
  if (!c) return error(res, 404, "customer_not_found");
  res.json(queryRows("SELECT id,customer_id AS customerId,document_type AS documentType,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,sha256,created_at AS createdAt FROM customer_identity_documents WHERE customer_id=? AND is_latest=1 ORDER BY document_type", [c.id]));
});
router.get("/customers/:customerId/identity-documents/:documentId/download", requirePermission("customers.view"), (req, res) => {
  const c = getScopedCustomer(Number(req.params.customerId), user(res));
  const d = c && queryRow<any>("SELECT * FROM customer_identity_documents WHERE id=? AND customer_id=?", [Number(req.params.documentId), c.id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found");
  let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!p.startsWith(identityRootReal + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "document_not_found");
  if (req.query.preview === "1" && (rasterImageType(d.mime_type) || d.mime_type === "application/pdf")) { res.type(d.mime_type); res.setHeader("Content-Disposition", "inline"); return res.sendFile(p); }
  return res.download(p, d.original_name);
});
router.get("/loan-applications/:id/identity-documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  const d = r && queryRow<any>("SELECT * FROM customer_identity_documents WHERE id=? AND customer_id=? AND is_latest=1", [Number(req.params.documentId), r.customer_id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found");
  let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!p.startsWith(identityRootReal + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "document_not_found");
  if (req.query.preview === "1" && (rasterImageType(d.mime_type) || d.mime_type === "application/pdf")) { res.type(d.mime_type); res.setHeader("Content-Disposition", "inline"); return res.sendFile(p); }
  return res.download(p, normalizedUploadName(d.original_name));
});
router.post("/loan-applications/:id/identity-documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || ""); const reason = String(req.body?.reason || "").trim();
  if (!r || r.stage !== "customer_documents_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!["approved", "rejected"].includes(decision) || (decision === "rejected" && !reason)) return error(res, 400, "invalid_document_review");
  const d = queryRow<any>("SELECT id,storage_path FROM customer_identity_documents WHERE id=? AND customer_id=? AND is_latest=1", [Number(req.params.documentId), r.customer_id]);
  if (!d || !fileExists(d.storage_path)) return error(res, 404, "document_not_found");
  runTransaction(() => {
    executeChanges("UPDATE customer_identity_documents SET approved_at=?,approved_by_user_id=?,review_reason=? WHERE id=?", [decision === "approved" ? now() : null, decision === "approved" ? user(res).id : null, decision === "approved" ? null : reason, d.id]);
    recordReview(r.id, r.stage, `identity_document_${decision}:${d.id}`, reason || null, user(res).id);
  });
  res.json({ ok: true, status: decision });
});
function getScopedCustomer(id: number, u: AuthUser) {
  return queryRow<any>(`SELECT id,salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL${u.customerScope === "assigned" ? " AND salesperson_id=?" : ""}`, u.customerScope === "assigned" ? [id, u.salespersonId] : [id]);
}
function netLoanAmount(app: any): string {
  return loanPlanNetAmount(app);
}
function principalTemplateEvidence(generation: any): RenderedPrincipalTemplateEvidence {
  const template = queryRow<any>("SELECT storage_path,sha256 FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(generation?.template_id)]);
  return {
    templateId: generation?.template_id,
    templatePath: template?.storage_path,
    templateRoot: contractTemplateRoot,
    storedTemplateSha256: template?.sha256,
    mappings: parseJson(generation?.mappings_snapshot_json),
    renderedDocxPath: generation?.docx_path,
    renderedDocxRoot: contractGenerationRoot,
    renderedDocxSha256: generation?.docx_sha256,
    renderedValues: parseJson(generation?.manual_values_json),
    renderedPdfRoot: contractGenerationRoot,
    renderedPdfSha256: generation?.pdf_sha256,
  };
}
function latestTomanReplacementConsent(applicationId: number): { id: number; consent: TomanReplacementConsent } | null {
  const row = queryRow<any>(`SELECT id,reason FROM loan_application_stage_history
    WHERE application_id=? AND action=? AND id>COALESCE(
      (SELECT MAX(id) FROM loan_application_stage_history WHERE application_id=? AND action='admin-case-edited'
       AND json_valid(reason) AND json_extract(reason,'$.requiresNewContract')=1),0)
    ORDER BY id DESC LIMIT 1`, [applicationId, TOMAN_REPLACEMENT_ACTION, applicationId]);
  const consent = parseTomanReplacementConsent(row?.reason);
  return row && consent ? { id: Number(row.id), consent } : null;
}
function currentTomanReplacement(application: any): any | null {
  const entry = application && latestTomanReplacementConsent(Number(application.id));
  if (!entry) return null;
  const current = currentPrimaryDocument(application);
  const replacementGenerationId = current &&
    String(current.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE
    ? Number(current.id) : null;
  const completion = replacementGenerationId == null ? null : queryRow<any>(`SELECT created_at FROM loan_application_stage_history
    WHERE application_id=? AND action='toman-replacement-signature-verified'
      AND json_valid(reason)
      AND CAST(json_extract(reason,'$.sourceGenerationId') AS INTEGER)=?
      AND CAST(json_extract(reason,'$.replacementGenerationId') AS INTEGER)=?
    ORDER BY id DESC LIMIT 1`,
  [Number(application.id), entry.consent.sourceGenerationId, replacementGenerationId]);
  return {
    authorized: true,
    priorStage: entry.consent.priorStage,
    resumeStage: entry.consent.resumeStage,
    sourceGenerationId: entry.consent.sourceGenerationId,
    tomanTemplateId: entry.consent.tomanTemplateId,
    approvedAmount: entry.consent.approvedAmount,
    durationMonths: entry.consent.durationMonths,
    authorizedAt: entry.consent.authorizedAt,
    authorizedByUserId: entry.consent.authorizedByUserId,
    replacementGenerationId,
    completedAt: completion?.created_at ?? null,
  };
}
function tomanTemplateForPlan(application: any): any | null {
  const plan = queryRow<any>(`SELECT id,active,contract_template_id,primary_contract_template_id
    FROM loan_plans WHERE id=?`, [Number(application?.plan_id)]);
  if (!plan || Number(plan.active) !== 1) return null;
  const templateIds = [...new Set([plan.contract_template_id, plan.primary_contract_template_id]
    .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const candidates = templateIds.map((id) => queryRow<any>(
    "SELECT id,name,storage_path,sha256,mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [id],
  )).filter((template) => template && isAttestedTomanTemplate(
    template.id, template.storage_path, contractTemplateRoot, template.sha256,
  ));
  return candidates.length === 1 ? candidates[0] : null;
}
function tomanReplacementEligibility(application: any): {
  eligible: boolean;
  sourceGenerationId: number | null;
  approvedAmount: string;
  durationMonths: number;
  tomanTemplateId: number | null;
  tomanTemplateName: string | null;
  blockedReason?: string;
} {
  const amount = String(application?.approved_amount ?? "");
  const duration = Number(application?.duration_months);
  const base = {
    eligible: false,
    candidate: false,
    sourceGenerationId: null as number | null,
    approvedAmount: amount,
    durationMonths: Number.isSafeInteger(duration) ? duration : 0,
    tomanTemplateId: null as number | null,
    tomanTemplateName: null as string | null,
  };
  const block = (blockedReason: string) => ({ ...base, blockedReason });
  const existingConsent = application && latestTomanReplacementConsent(Number(application.id))?.consent;
  if (existingConsent) {
    const template = queryRow<any>("SELECT id,name FROM contract_templates WHERE id=?", [existingConsent.tomanTemplateId]);
    return {
      ...base,
      sourceGenerationId: existingConsent.sourceGenerationId,
      tomanTemplateId: existingConsent.tomanTemplateId,
      tomanTemplateName: template?.name == null ? null : String(template.name),
      blockedReason: "replacement_already_authorized",
    };
  }
  if (!application || application.status === "rejected" || application.stage === "completed")
    return block("application_not_eligible");
  if (!/^[1-9]\d{0,17}$/.test(amount) || !Number.isSafeInteger(duration) || duration < 1 || duration > 600 ||
      (!application.initial_approval_at && application.funder_decision !== "approved"))
    return block("approved_terms_missing");
  if (queryRow(`SELECT 1 FROM wallet_ledger_v2 WHERE application_id=?
      UNION ALL SELECT 1 FROM wallet_ledger WHERE application_id=? LIMIT 1`, [application.id, application.id]))
    return block("application_already_credited");
  const primary = applicationPrimaryDocument(application);
  if (!primary || !isApplicationPrimaryGeneration(application, primary.id) ||
      primary.status !== "signed" ||
      !primary.provider_contract_id || !isStrictSignedProviderState(primary.provider_status) ||
      primary.deleted_at || primary.superseded_at) return block("accepted_current_primary_required");
  // A matching, independently verified current contract needs no denomination
  // repair. Do not misclassify every accepted signature as a legacy Rial case.
  if (signedPrimaryMatchesApprovedTerms(application, amount, duration))
    return block("current_primary_terms_verified");
  base.candidate = true;
  base.sourceGenerationId = Number(primary.id);
  const template = tomanTemplateForPlan(application);
  if (!template) return { ...block("attested_active_toman_template_required"), sourceGenerationId: Number(primary.id) };
  base.sourceGenerationId = Number(primary.id);
  base.tomanTemplateId = Number(template.id);
  base.tomanTemplateName = String(template.name);
  const mappings = parseJson(template.mappings_json);
  const sourceType = (mapping: any) => mapping?.sourceType ?? (mapping?.customerField ? "customer" : mapping?.loanPlanField ? "loanPlan" : "manual");
  const principalMappings = Array.isArray(mappings) ? mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" && mapping?.loanPlanField === "loanPlan.principalAmount") : [];
  const durationMappings = Array.isArray(mappings) ? mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" && ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping?.loanPlanField))) : [];
  const variables = Array.isArray(mappings) ? mappings.map((mapping: any) => String(mapping?.variable ?? "")) : [];
  if (!Array.isArray(mappings) || variables.some((variable: string) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(variable)) ||
      new Set(variables).size !== variables.length ||
      principalMappings.length !== 1 || durationMappings.length > 1 ||
      (tomanReplacementDurationChanged(application) && durationMappings.length !== 1) ||
      principalMappings[0]?.variable === durationMappings[0]?.variable)
    return { ...base, blockedReason: "toman_template_terms_mapping_invalid" };
  if (!renderedPdfContainsLegacyRialPrincipal(primary.pdf_path, amount, principalTemplateEvidence(primary)))
    return { ...base, blockedReason: "legacy_rial_principal_not_proven" };
  return { ...base, eligible: true };
}
function tomanReplacementSignatureIdentityMatches(application: any, generation: any, consent: TomanReplacementConsent): boolean {
  const generationId = Number(generation?.contract_generation_id ?? generation?.id);
  return Boolean(application && generation && consent &&
    generationId !== consent.sourceGenerationId &&
    Number(application.current_primary_generation_id) === generationId &&
    Number(generation.loan_application_id ?? generation.generation_application_id) === Number(application.id) &&
    Number(generation.customer_id ?? generation.generation_customer_id) === Number(application.customer_id) &&
    Number(generation.loan_plan_id ?? generation.generation_plan_id) === Number(application.plan_id) &&
    String(generation.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE &&
    !generation.deleted_at && !generation.generation_deleted_at &&
    !generation.superseded_at && !generation.generation_superseded_at &&
    ["sent", "signed"].includes(String(generation.generation_status ?? generation.status)));
}
function tomanReplacementGenerationMatches(
  application: any,
  generation: any,
  consent: TomanReplacementConsent,
  requireProviderSend = false,
): boolean {
  if (!tomanReplacementGenerationTermsMatch(generation, application, consent) ||
      (requireProviderSend && (!generation.provider_contract_id ||
        !["sent", "signed"].includes(String(generation.status)) ||
        (generation.status === "signed" && !isStrictSignedProviderState(generation.provider_status))))) return false;
  return renderedPdfContainsPrincipal(generation.pdf_path, consent.approvedAmount, principalTemplateEvidence(generation)) &&
    (!tomanReplacementNeedsInstallmentProof(application, parseJson(generation.mappings_snapshot_json)) ||
      renderedPdfContainsInstallmentCount(generation.pdf_path, consent.durationMonths, principalTemplateEvidence(generation)));
}
function legacySignedPrimaryTerms(application: any): { amount: string; netAmount: string; generationId: number } {
  const fail = () => { throw new Error("legacy_signed_primary_terms_unverifiable"); };
  const replacementPrimary = applicationPrimaryDocument(application);
  const replacementConsent = application && latestTomanReplacementConsent(Number(application.id))?.consent;
  if (replacementConsent || String(replacementPrimary?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) {
    if (!application || application.initial_approval_at || !replacementConsent ||
        !verifiedTomanReplacementPrimary(application) ||
        String(application.approved_amount ?? "") !== replacementConsent.approvedAmount ||
        Number(application.duration_months) !== replacementConsent.durationMonths ||
        !/^[1-9]\d{0,17}$/.test(String(application.net_amount ?? ""))) return fail();
    return {
      amount: replacementConsent.approvedAmount,
      netAmount: String(application.net_amount),
      generationId: Number(replacementPrimary.id),
    };
  }
  if (!application || application.initial_approval_at) return fail();
  const untouchedLegacy = canUseUntouchedLegacyPrimaryFallback(application);
  const link = applicationPrimaryDocument(application);
  if (!link || !String(link.link ?? "").startsWith("signed:") ||
      (application.current_primary_generation_id != null &&
        Number(link.contract_generation_id) !== Number(application.current_primary_generation_id)) ||
      (application.current_primary_generation_id == null && !untouchedLegacy) ||
      (link.loan_application_id != null && Number(link.loan_application_id) !== Number(application.id)) ||
      link.deleted_at || link.superseded_at || link.status !== "signed" || !link.provider_contract_id ||
      !isStrictSignedProviderState(link.provider_status) ||
      !link.pdf_path || !link.pdf_sha256 || !link.created_at || !link.template_id || !link.loan_plan_id ||
      Number(link.customer_id) !== Number(application.customer_id) ||
      Number(link.loan_plan_id) !== Number(application.plan_id)) return fail();
  try {
    const pdfPath = fs.realpathSync(String(link.pdf_path));
    const pdfStat = fs.lstatSync(String(link.pdf_path));
    if (path.dirname(pdfPath) !== fs.realpathSync(contractGenerationRoot) ||
        !/^[a-f0-9-]{20,}\.pdf$/i.test(path.basename(pdfPath)) ||
        !pdfStat.isFile() || pdfStat.isSymbolicLink() || !fs.statSync(pdfPath).isFile() ||
        crypto.createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex") !== String(link.pdf_sha256)) return fail();
  } catch { return fail(); }

  const planSnapshot = parseJson(application.plan_snapshot_json);
  if (!planSnapshot || (planSnapshot.id != null && Number(planSnapshot.id) !== Number(application.plan_id))) return fail();
  const expectedTemplateId = Number(planSnapshot.contract_template_id ?? planSnapshot.primary_contract_template_id);
  if (!expectedTemplateId || Number(link.template_id) !== expectedTemplateId) return fail();
  const template = queryRow<any>("SELECT id,mappings_json,updated_at FROM contract_templates WHERE id=?", [expectedTemplateId]);
  if (!template) return fail();
  let mappings: any;
  if (typeof link.mappings_snapshot_json === "string" && link.mappings_snapshot_json.trim()) {
    mappings = parseJson(link.mappings_snapshot_json);
  } else {
    const created = Date.parse(String(link.created_at));
    const updated = Date.parse(String(template.updated_at ?? ""));
    if (!Number.isFinite(created) || !Number.isFinite(updated) || updated > created) return fail();
    mappings = parseJson(template.mappings_json);
  }
  const values = parseJson(link.manual_values_json);
  if (!Array.isArray(mappings) || !values || typeof values !== "object") return fail();
  const principalMappings = mappings.filter((mapping: any) =>
    (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "loanPlan" &&
    mapping.loanPlanField === "loanPlan.principalAmount");
  if (principalMappings.length !== 1) return fail();
  const rawAmount = values[principalMappings[0].variable];
  if (typeof rawAmount !== "string") return fail();
  const amount = rawAmount.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[,\u060c\u066c\s]/g, "");
  if (!/^[1-9]\d{0,17}$/.test(amount)) return fail();
  if (!renderedPdfContainsPrincipal(link.pdf_path, amount,
      application.new_case_workflow ? principalTemplateEvidence(link) : undefined)) return fail();
  const condition = parseJson(application.condition_snapshot_json);
  let ceiling: bigint;
  try { ceiling = effectivePlanTerms(planSnapshot, condition).maximum; } catch { return fail(); }
  if (ceiling <= 0n || BigInt(amount) > ceiling) return fail();
  const duration = Number(application.requested_duration_months ?? application.duration_months);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 600) return fail();
  let netAmount: string;
  try { netAmount = netLoanAmount({ ...application, approved_amount: amount, duration_months: duration }); } catch { return fail(); }
  return { amount, netAmount, generationId: Number(link.id) };
}
function signedPrimaryMatchesApprovedTerms(application: any, approvedAmount: string, durationMonths: number): boolean {
  const primary = currentPrimaryDocument(application);
  const consent = application && latestTomanReplacementConsent(Number(application.id))?.consent;
  if (consent || String(primary?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) {
    return Boolean(consent && primary &&
      signatureGenerationIdentityEligible(application, primary, "primary") &&
      isApplicationPrimaryGeneration(application, primary.contract_generation_id) &&
      String(primary.link ?? "") === `signed:${primary.provider_contract_id}` &&
      primary.status === "signed" && isStrictSignedProviderState(primary.provider_status) &&
      String(approvedAmount) === consent.approvedAmount &&
      Number(durationMonths) === consent.durationMonths &&
      verifiedTomanReplacementPrimary(application));
  }
  return Boolean(primary && signatureGenerationIdentityEligible(application, primary, "primary") &&
    String(primary.link ?? "").startsWith("signed:") && primary.status === "signed" &&
    verifiedPrimaryPrincipal(application, primary, approvedAmount, durationMonths));
}
function latestPrimaryDocument(applicationId: number): any {
  return queryRow<any>(`SELECT d.id AS document_id,d.kind,d.contract_generation_id,d.link,d.status AS document_status,
      d.created_at AS document_created_at,g.* FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.application_id=? AND d.kind='primary' ORDER BY d.id DESC LIMIT 1`, [applicationId]);
}
function currentPrimaryDocument(application: any): any {
  if (application?.current_primary_generation_id == null) return null;
  return queryRow<any>(`SELECT d.id AS document_id,d.kind,d.contract_generation_id,d.link,d.status AS document_status,
      d.created_at AS document_created_at,g.* FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.application_id=? AND d.kind='primary' AND d.contract_generation_id=?`,
  [application.id, application.current_primary_generation_id]);
}
function canUseUntouchedLegacyPrimaryFallback(application: any): boolean {
  if (!application || application.current_primary_generation_id != null ||
      Number(application.new_case_workflow) === 1 || application.initial_approval_at ||
      application.legacy_reopen_prior_stage != null || application.stage === "funder_initial_approval") return false;
  return !queryRow<any>(`SELECT 1 FROM loan_application_stage_history
    WHERE application_id=? AND action='legacy-applications-reopened-for-initial-provider-approval' LIMIT 1`, [application.id]);
}
function applicationPrimaryDocument(application: any): any {
  if (application?.current_primary_generation_id != null) return currentPrimaryDocument(application);
  if (!canUseUntouchedLegacyPrimaryFallback(application)) return null;
  const latest = latestPrimaryDocument(Number(application.id));
  if (!latest || latest.loan_application_id != null || latest.deleted_at || latest.superseded_at) return null;
  return latest;
}
function applicationPrimaryGenerationId(application: any): number | null {
  if (application?.current_primary_generation_id != null) return Number(application.current_primary_generation_id);
  const primary = applicationPrimaryDocument(application);
  return primary ? Number(primary.id) : null;
}
function isApplicationPrimaryGeneration(application: any, generationId: unknown): boolean {
  const currentId = applicationPrimaryGenerationId(application);
  return currentId != null && Number(generationId) === currentId;
}
function applicationBoundPlanId(application: any): number | null {
  const valid = (value: unknown) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : Number.NaN;
  };
  if (application?.plan_id != null) return valid(application.plan_id);
  const raw = String(application?.plan_ids ?? "").trim();
  if (!raw) return null;
  const planIds = parseJson(raw);
  if (Array.isArray(planIds)) return planIds.length ? valid(planIds[0]) : null;
  return valid(raw);
}
function signatureGenerationIdentityEligible(application: any, generation: any, kind: string): boolean {
  const planId = applicationBoundPlanId(application);
  if (!application || !generation ||
      Number(generation.customer_id ?? generation.generation_customer_id) !== Number(application.customer_id) ||
      (planId != null &&
        Number(generation.loan_plan_id ?? generation.generation_plan_id) !== planId)) return false;
  const generationApplicationId = generation.loan_application_id ?? generation.generation_application_id;
  if (generationApplicationId != null && Number(generationApplicationId) !== Number(application.id)) return false;
  if (kind === "primary") {
    const purpose = String(generation.generation_purpose ?? "primary");
    if (purpose === TOMAN_REPLACEMENT_PURPOSE) {
      const consent = latestTomanReplacementConsent(Number(application.id))?.consent;
      if (!consent || Number(application.current_primary_generation_id) !== Number(generation.contract_generation_id) ||
          !tomanReplacementSignatureIdentityMatches(application, generation, consent)) return false;
    } else if (purpose !== "primary") return false;
    // Only the pre-existing generic legacy link path permits an unbound primary.
    if (generationApplicationId == null &&
        (Number(application.new_case_workflow) === 1 || application.initial_approval_at ||
          application.legacy_reopen_prior_stage != null)) return false;
    return true;
  }
  if (kind === "amendment") {
    return generationApplicationId != null &&
      (Number(application.new_case_workflow) !== 1 || String(generation.generation_purpose ?? "") === "amendment");
  }
  // The existing final-document link policy permits only unbound generic
  // invoice/acknowledgement generations.
  return ["invoice", "acknowledgement"].includes(kind) && generationApplicationId == null;
}
function primarySignatureIdentityEligible(application: any, primary: any): boolean {
  const generationStatus = primary?.generation_status ?? primary?.status;
  return Boolean(primary && primary.kind === "primary" &&
    signatureGenerationIdentityEligible(application, primary, "primary") &&
    isApplicationPrimaryGeneration(application, primary.contract_generation_id) &&
    primary.document_status !== "rejected" &&
    !primary.deleted_at && !primary.generation_deleted_at && !primary.superseded_at &&
    !primary.generation_superseded_at &&
    ["sent", "signed"].includes(String(generationStatus)));
}
function primarySignatureDocumentSignedEligible(application: any, primary: any): boolean {
  const generationStatus = primary?.generation_status ?? primary?.status;
  return Boolean(primarySignatureIdentityEligible(application, primary) &&
    String(primary.link ?? "").startsWith("signed:") &&
    generationStatus === "signed" && isStrictSignedProviderState(primary.provider_status));
}
function verifiedPrimaryPrincipal(application: any, primary: any, approvedAmount: string, durationMonths: number): boolean {
  const consent = application && latestTomanReplacementConsent(Number(application.id))?.consent;
  if (consent || String(primary?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) {
    return Boolean(consent &&
      String(approvedAmount) === consent.approvedAmount &&
      Number(durationMonths) === consent.durationMonths &&
      verifiedTomanReplacementPrimary(application));
  }
  if (!application || !primary || Number(primary.customer_id) !== Number(application.customer_id) ||
      Number(primary.loan_plan_id) !== Number(application.plan_id) || Number(primary.template_id) <= 0 ||
      !primary.provider_contract_id || primary.deleted_at || primary.superseded_at ||
      !["sent", "signed"].includes(String(primary.status)) || !primary.pdf_path || !primary.pdf_sha256 ||
      (primary.loan_application_id != null && Number(primary.loan_application_id) !== Number(application.id))) return false;
  const providerClassification = classifyProviderState(primary.provider_status);
  if (!String(primary.provider_status ?? "").trim() || providerClassification === "negative" ||
      (primary.status === "signed" && providerClassification !== "signed")) return false;
  const snapshot = parseJson(application.plan_snapshot_json);
  const templateId = Number(snapshot?.contract_template_id ?? snapshot?.primary_contract_template_id);
  if (!snapshot || (snapshot.id != null && Number(snapshot.id) !== Number(application.plan_id)) ||
      !templateId || Number(primary.template_id) !== templateId) return false;
  try {
    const pdfPath = fs.realpathSync(String(primary.pdf_path));
    const stat = fs.lstatSync(String(primary.pdf_path));
    if (path.dirname(pdfPath) !== fs.realpathSync(contractGenerationRoot) ||
        !/^[a-f0-9-]{20,}\.pdf$/i.test(path.basename(pdfPath)) || !stat.isFile() || stat.isSymbolicLink() ||
        crypto.createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex") !== String(primary.pdf_sha256)) return false;
  } catch { return false; }
  const template = queryRow<any>("SELECT mappings_json,updated_at FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]);
  if (!template) return false;
  let mappings = parseJson(primary.mappings_snapshot_json);
  if (!Array.isArray(mappings) || !mappings.length) {
    const created = Date.parse(String(primary.created_at ?? ""));
    const updated = Date.parse(String(template.updated_at ?? ""));
    if (!Number.isFinite(created) || !Number.isFinite(updated) || updated > created) return false;
    mappings = parseJson(template.mappings_json);
  }
  const values = parseJson(primary.manual_values_json);
  if (!Array.isArray(mappings) || !values || typeof values !== "object") return false;
  const sourceType = (mapping: any) => mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
  const principalMappings = mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" && mapping.loanPlanField === "loanPlan.principalAmount");
  const durationMappings = mappings.filter((mapping: any) =>
    sourceType(mapping) === "loanPlan" && ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping.loanPlanField)));
  const normalize = (value: unknown) => String(value ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[,\u060c\u066c\s]/g, "");
  if (principalMappings.length !== 1 || normalize(values[principalMappings[0].variable]) !== approvedAmount ||
      (application.initial_approval_at && Number(application.duration_months) !== Number(application.requested_duration_months ?? application.duration_months) &&
        durationMappings.length === 0)) return false;
  return durationMappings.every((mapping: any) => normalize(values[mapping.variable]) === String(durationMonths)) &&
    (renderedPdfContainsPrincipal(primary.pdf_path, approvedAmount,
      application.new_case_workflow ? principalTemplateEvidence(primary) : undefined) ||
      acceptedLegacyRialPrimary(application, primary, approvedAmount, durationMonths, queryRow,
        () => renderedPdfContainsLegacyRialPrincipal(primary.pdf_path, approvedAmount, principalTemplateEvidence(primary)))) &&
    (Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      renderedPdfContainsInstallmentCount(primary.pdf_path, durationMonths, principalTemplateEvidence(primary)));
}
function signedPrimaryMatchesRequestedTerms(application: any): boolean {
  return Boolean(application && /^[1-9]\d{0,17}$/.test(String(application.requested_amount ?? "")) &&
    signedPrimaryMatchesApprovedTerms(application, String(application.requested_amount),
      Number(application.requested_duration_months ?? application.duration_months)));
}
function boundPrimaryMatchesApplication(generation: any, application: any, expectedAmount = String(application?.approved_amount ?? "")): boolean {
  if (!generation || Number(generation.loan_application_id) !== Number(application.id) ||
      Number(generation.customer_id) !== Number(application.customer_id) ||
      Number(generation.loan_plan_id) !== Number(application.plan_id) ||
      String(generation.generation_purpose ?? "primary") !== "primary" ||
      generation.deleted_at || generation.superseded_at || !generation.provider_contract_id ||
      !["sent", "signed"].includes(String(generation.status)) ||
      (generation.status === "signed" && !isStrictSignedProviderState(generation.provider_status)) ||
      !/^[1-9]\d{0,17}$/.test(expectedAmount)) return false;
  const snapshot = parseJson(application.plan_snapshot_json);
  const templateId = Number(snapshot?.contract_template_id ?? snapshot?.primary_contract_template_id);
  if (!templateId || Number(generation.template_id) !== templateId) return false;
  const mappings = parseJson(generation.mappings_snapshot_json);
  const values = parseJson(generation.manual_values_json);
  if (!Array.isArray(mappings) || !values || typeof values !== "object") return false;
  const sourceType = (mapping: any) => mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
  const principal = mappings.filter((mapping: any) => sourceType(mapping) === "loanPlan" && mapping.loanPlanField === "loanPlan.principalAmount");
  const duration = mappings.filter((mapping: any) => sourceType(mapping) === "loanPlan" && ["loanPlan.installments", "loanPlan.durationMonths"].includes(mapping.loanPlanField));
  const normalized = (value: unknown) => String(value ?? "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,\u060c\u066c\s]/g, "");
  const manualMappings = mappings.filter((mapping: any) => sourceType(mapping) === "manual");
  const persistedManual = parseJson(application.primary_manual_values_json) ?? {};
  const manualKeys = manualMappings.map((mapping: any) => mapping.variable);
  const manualMatches = (expected: string, actual: string) => {
    if (expected.trim() === actual.trim()) return true;
    const numeric = (value: string) => value.trim().replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،,\s]/g, "").replace(/٫/g, ".");
    const left = numeric(expected), right = numeric(actual);
    return /^[-+]?\d+(?:\.\d+)?$/.test(left) && left === right;
  };
  const manualValuesMatch = Object.keys(persistedManual).length === manualKeys.length && manualMappings.every((mapping: any) =>
    typeof persistedManual[mapping.variable] === "string" && typeof values[mapping.variable] === "string" &&
      manualMatches(persistedManual[mapping.variable], values[mapping.variable]));
  return principal.length === 1 &&
    normalized(values[principal[0].variable]) === expectedAmount &&
    manualValuesMatch &&
    (!application.initial_approval_at ||
      Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      duration.length > 0) &&
    duration.every((mapping: any) => normalized(values[mapping.variable]) === String(
      application.initial_approval_at ? application.duration_months : application.requested_duration_months ?? application.duration_months)) &&
    (!application.initial_approval_at ||
      Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      renderedPdfContainsInstallmentCount(generation.pdf_path, Number(application.duration_months), principalTemplateEvidence(generation))) &&
    (!application.new_case_workflow || renderedPdfContainsPrincipal(
      generation.pdf_path, expectedAmount, principalTemplateEvidence(generation),
    ));
}
function preparePhysicalChecks(id: number, submittedPhysicalDocuments = false) {
  if (submittedPhysicalDocuments) {
    const documents = queryRows<any>("SELECT id,original_name,storage_path FROM loan_physical_documents WHERE application_id=? ORDER BY id", [id]);
    if (!documents.length || documents.some((document) => !fileExists(document.storage_path))) throw new Error("physical_documents_missing");
    for (const document of documents) execute("INSERT OR IGNORE INTO loan_physical_checks(application_id,source,source_id,label) VALUES(?,?,?,?)",
      [id, "physical_upload", document.id, document.original_name]);
    return;
  }
  const docs = queryRows<any>("SELECT id,label,storage_path FROM loan_application_documents WHERE application_id=? AND source IN ('plan','manual') AND storage_path IS NOT NULL", [id])
    .filter((document) => fileExists(document.storage_path));
  const collateral = queryRows<any>("SELECT id,data_json,storage_path FROM loan_application_collateral WHERE application_id=? AND storage_path IS NOT NULL", [id])
    .filter((item) => fileExists(item.storage_path));
  for (const d of docs) execute("INSERT OR IGNORE INTO loan_physical_checks(application_id,source,source_id,label) VALUES(?,?,?,?)", [id, "document", d.id, d.label]);
  for (const d of collateral) execute("INSERT OR IGNORE INTO loan_physical_checks(application_id,source,source_id,label) VALUES(?,?,?,?)", [id, "collateral", d.id, collateralMetadata(d).label ?? "وثیقه"]);
  if (!docs.length && !collateral.length) throw new Error("physical_documents_missing");
}
function verifiedTomanReplacementPrimary(application: any): boolean {
  const primary = applicationPrimaryDocument(application);
  const entry = application && latestTomanReplacementConsent(Number(application.id));
  const consent = entry?.consent;
  if (!application || !primary || !entry || !consent ||
      String(primary.generation_purpose ?? "") !== TOMAN_REPLACEMENT_PURPOSE ||
      !isApplicationPrimaryGeneration(application, primary.id) ||
      String(primary.link ?? "") !== `signed:${primary.provider_contract_id}` ||
      primary.status !== "signed" || !primary.provider_contract_id ||
      !isStrictSignedProviderState(primary.provider_status) ||
      String(application.approved_amount ?? "") !== consent.approvedAmount ||
      Number(application.duration_months) !== consent.durationMonths ||
      application.status === "rejected" ||
      !tomanReplacementGenerationMatches(application, primary, consent, true)) return false;

  const completionEvents = queryRows<any>(`SELECT id,from_stage,to_stage,reason,created_at
    FROM loan_application_stage_history
    WHERE application_id=? AND action='toman-replacement-signature-verified' AND id>?
    ORDER BY id DESC`, [Number(application.id), entry.id]);
  return completionEvents.some((event) => {
    const detail = parseJson(event.reason);
    return event.from_stage === "approved_contract_pending_signature" &&
      event.to_stage === consent.resumeStage &&
      Number(detail?.sourceGenerationId) === consent.sourceGenerationId &&
      Number(detail?.replacementGenerationId) === Number(primary.id) &&
      Number(detail?.tomanTemplateId) === consent.tomanTemplateId &&
      String(detail?.approvedAmount ?? "") === consent.approvedAmount &&
      Number(detail?.durationMonths) === consent.durationMonths &&
      Number(detail?.authorizedByUserId) === consent.authorizedByUserId &&
      String(detail?.authorizedAt ?? "") === consent.authorizedAt &&
      String(detail?.resumedStage ?? "") === consent.resumeStage;
  });
}
function verifyPhysicalApprovalTerms(application: any) {
  const primary = applicationPrimaryDocument(application);
  const replacementAuthorized = Boolean(application && latestTomanReplacementConsent(Number(application.id)));
  if ((replacementAuthorized || String(primary?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) &&
      !verifiedTomanReplacementPrimary(application)) throw new Error("toman_replacement_terms_unverifiable");
  if (!application?.initial_approval_at) {
    if (application?.new_case_workflow && (!application.approved_amount ||
        !signedPrimaryMatchesApprovedTerms(application, String(application.approved_amount), Number(application.duration_months))))
      throw new Error("approved_primary_generation_evidence_missing");
    return;
  }
  if (!application.approved_amount ||
      !signedPrimaryMatchesApprovedTerms(application, String(application.approved_amount), Number(application.duration_months)) ||
      application.funder_decision !== "approved" ||
      (Number(application.new_case_workflow) === 1 &&
        Number(application.approved_amount_generation_id) !== Number(application.current_primary_generation_id)))
    throw new Error("approved_primary_generation_evidence_missing");
}
function transition(id: number, to: Stage, action: string, actor: AuthUser, reason?: string, beforeCommit?: () => void) {
  return runTransaction(() => {
    const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [id]);
    if (!current || !stages.includes(to)) throw new Error("invalid_transition");
    const ownership = queryRow<{ customer_id: number }>("SELECT customer_id FROM loan_applications WHERE id=?", [id]);
    if (!ownership || !canAct(current.stage, actor, ownership.customer_id, current.status)) throw new Error("action_forbidden");
    const allowed: Record<string, string[]> = {
      funder_initial_approval: ["draft"], draft: ["primary_contract_pending_signature"], primary_contract_pending_signature: ["customer_documents_upload"],
      customer_documents_upload: ["customer_documents_review"], customer_documents_review: ["guarantor_registration", "collateral_upload", "funder_initial_approval"],
      guarantor_registration: ["guarantor_documents_upload", "guarantor_documents_review", "funder_initial_approval"], guarantor_documents_upload: ["guarantor_documents_review"],
      guarantor_documents_review: ["collateral_upload"], collateral_upload: ["collateral_review"], collateral_review: ["expert_approval"],
        expert_approval: ["funder_result_review", "funder_amendment_pending_signature"], funder_amendment_pending_signature: ["funder_amendment_review"], funder_amendment_review: ["funder_result_review"], funder_result_review: ["physical_documents_submission"],
       funder_documents_correction: ["expert_approval"],
       physical_documents_correction: ["physical_documents_review"],
        physical_documents_submission: ["physical_documents_review"],
       physical_documents_review: ["wallet_charge_pending"],
       wallet_charge_pending: ["admin_approval"],
       admin_approval: ["completed"],
      final_invoice_pending_signature: ["completed"], completed: [],
    };
    if (!allowed[current.stage]?.includes(to)) throw new Error("invalid_transition");
    if (latestTomanReplacementConsent(Number(current.id)) &&
        !verifiedTomanReplacementPrimary(current))
      throw new Error("toman_replacement_terms_unverifiable");
    if (current.stage === "guarantor_registration" && ["guarantor_documents_upload", "guarantor_documents_review"].includes(to) &&
        !current.initial_approval_at && (Number(current.new_case_workflow) === 1 ||
          current.legacy_reopen_prior_stage != null))
      throw new Error("loan_amount_approval_required");
    if (current.stage === "draft" && to === "primary_contract_pending_signature") {
      const application = current;
      if (application?.initial_approval_at) {
        const primary = currentPrimaryDocument(application);
        if (!boundPrimaryMatchesApplication(primary, application)) throw new Error("approved_primary_generation_required");
       } else if (application?.new_case_workflow || application?.legacy_reopen_prior_stage != null) {
        const primary = currentPrimaryDocument(application);
        if (!primary || !renderedPdfContainsPrincipal(
          primary.pdf_path, String(application.requested_amount ?? ""), principalTemplateEvidence(primary),
        ))
          throw new Error("rendered_primary_principal_unverifiable");
        if (!boundPrimaryMatchesApplication(primary, application, String(application.requested_amount ?? "")))
          throw new Error("requested_primary_generation_required");
      }
    }
    if (to === "customer_documents_upload") {
      const primary = applicationPrimaryDocument(current);
      if (!primarySignatureDocumentSignedEligible(current, primary))
        throw new Error("primary_contract_not_signed");
    }
    if (to === "completed" && current.stage === "final_invoice_pending_signature") {
      const signedFinalDocuments = queryRows<any>(`SELECT d.kind,g.provider_status,g.status generation_status
        FROM loan_application_generated_documents d JOIN contract_generations g ON g.id=d.contract_generation_id
        WHERE d.application_id=? AND d.kind IN ('invoice','acknowledgement') AND d.link LIKE 'signed:%'
        AND g.superseded_at IS NULL AND g.deleted_at IS NULL`, [id])
        .filter((document) => document.generation_status === "signed" && isStrictSignedProviderState(document.provider_status));
      if (new Set(signedFinalDocuments.map((document) => document.kind)).size < 2) throw new Error("final_documents_not_signed");
    }
    if (current.stage === "admin_approval" && (to !== "completed" || action !== "admin-approve" || actor.role !== "admin")) throw new Error("action_forbidden");
    if (to === "customer_documents_review") {
      const app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]);
      const primary = applicationPrimaryDocument(app);
      // Handoff starts registration review, not financial approval. Verify the
      // current signature here; financial evidence is checked at approval/funding.
      if (!primarySignatureDocumentSignedEligible(app, primary)) throw new Error("current_primary_contract_required");
      const required = loanProcessingDocuments(id);
      if (required.some((document) => !fileExists(document.storage_path) || !["uploaded", "approved"].includes(document.status))) throw new Error("documents_missing");
    }
    if (to === "guarantor_documents_review" && !queryRow("SELECT 1 FROM loan_application_guarantors WHERE application_id=?", [id])) throw new Error("guarantor_required");
    if (to === "guarantor_documents_review" && queryRows<any>("SELECT d.storage_path,d.status FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=?", [id])
      .some((document) => !fileExists(document.storage_path) || !["uploaded", "approved"].includes(document.status))) throw new Error("documents_incomplete");
    if (to === "guarantor_documents_upload" && !queryRow("SELECT 1 FROM loan_application_guarantors WHERE application_id=?", [id])) throw new Error("guarantor_required");
    if (["customer_documents_review", "guarantor_documents_review", "collateral_review"].includes(current.stage) && !registrarReviewState(current).allApproved) throw new Error("documents_incomplete");
    if (current.stage === "customer_documents_review" &&
        ["guarantor_registration", "collateral_upload", "funder_initial_approval"].includes(to)) {
      if (loanProcessingDocuments(id).some((document) => document.status !== "approved")) throw new Error("documents_incomplete");
      const app = queryRow<{ customer_id: number }>("SELECT customer_id FROM loan_applications WHERE id=?", [id]);
      const identity = queryRow<{ total: number; approved: number }>(`SELECT COUNT(*) total,SUM(approved_at IS NOT NULL) approved FROM customer_identity_documents
        WHERE customer_id=? AND is_latest=1 AND document_type IN ('national_card_front','national_card_back','birth_cert_p1','birth_cert_p2','birth_cert_p3')`, [Number(app?.customer_id)]);
      if (Number(identity?.total) !== 5 || Number(identity?.approved) !== 5) throw new Error("identity_documents_not_approved");
       const approvedPrimary = applicationPrimaryDocument(current);
        if (!primarySignatureDocumentSignedEligible(current, approvedPrimary))
        throw new Error("primary_contract_not_approved");
       if (approvedPrimary.document_status !== "approved" || !String(approvedPrimary.link ?? "").startsWith("signed:"))
         throw new Error("primary_contract_not_approved");
    }
    if (to === "collateral_upload" && current.stage === "guarantor_documents_review" && queryRow("SELECT 1 FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE g.application_id=? GROUP BY g.application_id HAVING SUM(d.status='approved') < COUNT(*)", [id])) throw new Error("documents_incomplete");
    if (to === "collateral_review" && !collateralComplete(id, false)) throw new Error("collateral_incomplete");
    if (to === "expert_approval" && !collateralComplete(id, true)) throw new Error("collateral_incomplete");
      if (current.stage === "funder_result_review" && to === "physical_documents_submission") {
       const app = queryRow<any>("SELECT funder_decision FROM loan_applications WHERE id=?", [id]);
       if (app?.funder_decision !== "approved") throw new Error("funder_not_approved");
     }
      if (current.stage === "physical_documents_submission" && to === "physical_documents_review")
        preparePhysicalChecks(id, true);
     if (current.stage === "funder_documents_correction" && to === "expert_approval") {
       if (queryRow("SELECT 1 FROM loan_funder_defects WHERE application_id=? AND resolved_at IS NULL", [id])) throw new Error("funder_defects_pending");
       executeChanges("UPDATE loan_applications SET funder_decision=NULL,funder_reason=NULL WHERE id=?", [id]);
     }
     if (current.stage === "physical_documents_correction" && to === "physical_documents_review") {
       if (queryRow("SELECT 1 FROM loan_physical_checks WHERE application_id=? AND status IN ('incomplete','rejected')", [id])) throw new Error("physical_corrections_pending");
     }
       if (to === "wallet_charge_pending" && action === "approve-physical-documents") {
         const checks = queryRows<any>("SELECT status FROM loan_physical_checks WHERE application_id=?", [id]);
          const realChecks = queryRows<any>("SELECT status FROM loan_physical_checks WHERE application_id=? AND source IN ('document','collateral','physical_upload')", [id]);
         if (!realChecks.length) throw new Error("physical_documents_missing");
         if (checks.some((check) => check.status !== "approved")) throw new Error("physical_documents_incomplete");
           verifyPhysicalApprovalTerms(queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]));
       }
       if (to === "admin_approval" || to === "final_invoice_pending_signature") {
       const app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]);
         if (to === "admin_approval") {
           if (app?.initial_approval_at ||
               String(applicationPrimaryDocument(app)?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) {
             verifyPhysicalApprovalTerms(app);
           } else {
             legacySignedPrimaryTerms(app);
         }
         }
        if (app?.approved_amount != null) {
          const net = netLoanAmount(app);
          executeChanges("UPDATE loan_applications SET net_amount=?,updated_at=? WHERE id=?", [net, now(), id]);
        }
    }
    executeChanges("UPDATE loan_applications SET stage=?,status=?,is_pre_registration=CASE WHEN ?='primary_contract_pending_signature' THEN 0 ELSE is_pre_registration END,updated_at=? WHERE id=?", [to, workflowStatus(to), to, now(), id]);
       if (to === "completed" && current.stage === "admin_approval") {
       let app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]);
        const currentPrimary = applicationPrimaryDocument(app);
        if (!currentPrimary || !String(currentPrimary.link ?? "").startsWith("signed:") || currentPrimary.status !== "signed" ||
            !isStrictSignedProviderState(currentPrimary.provider_status) ||
            currentPrimary.superseded_at || currentPrimary.deleted_at) throw new Error("current_primary_contract_required");
         const replacementAuthorized = Boolean(latestTomanReplacementConsent(Number(app.id)));
         const replacementRequired = replacementAuthorized ||
           String(currentPrimary.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE;
         if (replacementRequired) {
          if (!verifiedTomanReplacementPrimary(app)) throw new Error("toman_replacement_terms_unverifiable");
          const reconciledAt = now();
          const changed = executeChanges(`UPDATE loan_applications SET approved_amount_generation_id=?,
            approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,updated_at=?
            WHERE id=? AND status<>'rejected' AND current_primary_generation_id=?`,
          [currentPrimary.id, reconciledAt, actor.id, reconciledAt, id, currentPrimary.id]);
          if (changed !== 1) throw new Error("approved_financial_terms_reconciliation_conflict");
          app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]);
         } else if (!app.initial_approval_at) {
         const reconciled = legacySignedPrimaryTerms(app);
         const reconciledAt = now();
         const changed = executeChanges(`UPDATE loan_applications SET approved_amount=?,net_amount=?,approved_amount_source='signed_primary_reconciliation',
           approved_amount_generation_id=?,approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,updated_at=? WHERE id=? AND initial_approval_at IS NULL`,
         [reconciled.amount, reconciled.netAmount, reconciled.generationId, reconciledAt, actor.id, reconciledAt, id]);
         if (changed !== 1) throw new Error("approved_financial_terms_reconciliation_conflict");
         execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
           [id, current.stage, current.stage, "legacy-signed-primary-terms-reconciled-before-credit",
             JSON.stringify({ generationId: reconciled.generationId, approvedAmount: reconciled.amount, netAmount: reconciled.netAmount }), actor.id, reconciledAt]);
         app = queryRow<any>("SELECT * FROM loan_applications WHERE id=?", [id]);
       }
       if (!/^[1-9]\d{0,17}$/.test(String(app?.approved_amount ?? "")) || !/^[1-9]\d{0,17}$/.test(String(app?.net_amount ?? ""))) {
         throw new Error("approved_financial_terms_missing");
       }
        if (app.initial_approval_at ||
            String(currentPrimary.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE)
          verifyPhysicalApprovalTerms(app);
        if (app.new_case_workflow &&
            (Number(app.approved_amount_generation_id) !== Number(app.current_primary_generation_id) ||
             !signedPrimaryMatchesApprovedTerms(app, String(app.approved_amount),
               Number(app.duration_months))))
          throw new Error("approved_primary_generation_evidence_missing");
        if (String(currentPrimary.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE &&
            (Number(app.approved_amount_generation_id) !== Number(currentPrimary.id) ||
              !verifiedTomanReplacementPrimary(app)))
          throw new Error("toman_replacement_terms_unverifiable");
       const priorCredit = queryRow<any>("SELECT amount FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?",
         [id, `loan-application:${id}:credit`]);
       if (priorCredit && String(priorCredit.amount) !== String(app.net_amount)) throw new Error("existing_wallet_credit_amount_conflict");
       creditLoanWallet(id, app.customer_id, app.net_amount, actor.id);
    }
     beforeCommit?.();
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
      [id, current.stage, to, action, reason ?? null, actor.id, now()]);
  });
}

router.get("/loan-applications", requirePermission("loan_applications.view"), (req, res): void => {
  const u = user(res), page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const where = `${u.role === "admin" || u.customerScope !== "assigned" ? "" : " AND current_customer.salesperson_id = ?"} AND (COALESCE(a.is_pre_registration,0)=0 OR a.stage<>'draft')`;
  const params: any[] = u.role === "admin" || u.customerScope !== "assigned" ? [] : [u.salespersonId];
  const filters: string[] = [];
  const add = (sql: string, value: any) => { filters.push(sql); params.push(value); };
  if (req.query.status) add("a.status=?", String(req.query.status));
  if (req.query.stage) add("a.stage=?", String(req.query.stage));
  if (req.query.actionable === "true") {
    filters.push("a.status <> 'rejected'");
    const actionableStages = Object.entries(actionPolicy)
      .filter(([, roles]) => roles.includes(u.role) || (u.role === "admin" && roles.length > 0))
      .map(([stage]) => stage);
    if (!actionableStages.length) filters.push("1=0");
    else {
      filters.push(`a.stage IN (${actionableStages.map(() => "?").join(",")})`);
      params.push(...actionableStages);
    }
  }
  if (req.query.caseScope === "in-progress") {
    filters.push("a.status <> 'rejected'");
    filters.push("a.stage <> 'completed'");
  }
  if (req.query.customerId) {
    // Survivor timelines include the archived source's historical applications.
    filters.push("(a.customer_id=? OR (c.merged_into_customer_id=? AND merge_audit.survivor_customer_id=?))");
    params.push(Number(req.query.customerId), Number(req.query.customerId), Number(req.query.customerId));
  }
  if (req.query.planId) add("COALESCE(a.plan_id,CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER))=?", Number(req.query.planId));
  const loanIdSearch = req.query.search ? customerSearchSql(String(req.query.search)) : null;
  if (req.query.search && loanIdSearch) {
    const s = `%${loanIdSearch.text}%`;
    // A number also matches the (current) customer id; «#n» means customer n or case n.
    const clause = loanIdSearch.where("(CAST(a.id AS TEXT) LIKE ? OR crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR p.name LIKE ?)", [s, s, s], "current_customer.id", { sql: "a.id=?", params: [loanIdSearch.idQuery?.id ?? 0] });
    filters.push(clause.sql); params.push(...clause.params);
  }
  const loanRank = loanIdSearch?.orderPrefix("current_customer.id") ?? { sql: "", params: [] };
  if (req.query.dateFrom) add("a.created_at>=?", String(req.query.dateFrom));
  if (req.query.dateTo) add("a.created_at<=?", String(req.query.dateTo));
  const source = `FROM loan_applications a JOIN customers c ON c.id=a.customer_id LEFT JOIN customer_merge_audit merge_audit ON merge_audit.source_customer_id=c.id AND merge_audit.survivor_customer_id=c.merged_into_customer_id JOIN customers current_customer ON current_customer.id=CASE WHEN c.merged_into_customer_id IS NULL THEN c.id ELSE merge_audit.survivor_customer_id END AND current_customer.merged_into_customer_id IS NULL LEFT JOIN salespersons cs ON cs.id=current_customer.salesperson_id LEFT JOIN loan_plans p ON p.id=COALESCE(a.plan_id,CASE WHEN json_valid(a.plan_ids) THEN CAST(json_extract(a.plan_ids,'$[0]') AS INTEGER) ELSE CAST(a.plan_ids AS INTEGER) END) WHERE a.deleted_at IS NULL${where}${filters.length ? ` AND ${filters.join(" AND ")}` : ""}`;
  const total = queryRow<{n:number}>(`SELECT COUNT(*) n ${source}`,params)?.n??0;
  const activity = `MAX(COALESCE(julianday(a.updated_at),julianday(a.created_at),0),
    COALESCE((SELECT MAX(julianday(h.created_at)) FROM loan_application_stage_history h WHERE h.application_id=a.id),0),
    COALESCE((SELECT MAX(julianday(n.created_at)) FROM loan_application_notes n WHERE n.application_id=a.id),0),
    COALESCE((SELECT MAX(julianday(e.created_at)) FROM site_notification_events e WHERE e.resource_type='loan' AND e.resource_id=a.id),0))`;
  const rows = queryRows<any>(`SELECT a.*,c.name customer_name,cs.name customer_salesperson_name,p.name plan_name ${source} ORDER BY ${loanRank.sql}${activity} DESC,a.id DESC LIMIT ? OFFSET ?`, [...params, ...loanRank.params, limit, (page - 1) * limit]);
  const items = rows.map((row) => shape(row, u));
  if (req.query.mode === "board") {
    const board: Record<string, any[]> = {};
    for (const item of items) (board[item.businessStatus] ??= []).push(item);
    res.json({ board, items, page, limit, total });
    return;
  }
  res.json({ items, page, limit, total });
});
// Historical ownership is never inferred from the customer's current assignment or
// the requester's current user link. Only a deliberate admin decision fills the snapshot.
router.get("/loan-applications/attribution-review", requirePermission("loan_applications.view"), (req, res) => {
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  const page = Number(req.query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) return error(res, 400, "invalid_page");
  const status = String(req.query.status ?? "pending");
  if (!["pending", "reviewed"].includes(status)) return error(res, 400, "invalid_status");
  const pending = status === "pending";
  const filter = pending
    ? "a.salesperson_id_snapshot IS NULL"
    : "EXISTS (SELECT 1 FROM loan_salesperson_attribution_audit audit WHERE audit.application_id=a.id)";
  const total = queryRow<{ count: number }>(`SELECT COUNT(*) count FROM loan_applications a WHERE a.deleted_at IS NULL AND ${filter}`)?.count ?? 0;
  const rows = queryRows<any>(`SELECT a.id,a.customer_id,a.consultation_id,a.requested_by_user_id,a.created_at,a.stage,a.status,a.requested_amount,a.approved_amount,
    a.salesperson_id_snapshot,a.salesperson_name_snapshot,c.name customer_name,c.salesperson_id current_salesperson_id,
    s.name current_salesperson_name,u.username requester_username,u.full_name requester_name,u.salesperson_id requester_current_salesperson_id,
    p.name plan_name
    FROM loan_applications a
    JOIN customers c ON c.id=a.customer_id
    LEFT JOIN salespersons s ON s.id=c.salesperson_id
    LEFT JOIN users u ON u.id=a.requested_by_user_id
    LEFT JOIN loan_plans p ON p.id=a.plan_id
    WHERE a.deleted_at IS NULL AND ${filter}
    ORDER BY a.id DESC LIMIT 20 OFFSET ?`, [(page - 1) * 20]);
  const items = rows.map((r) => ({
    id: r.id, customerId: r.customer_id, customerName: r.customer_name, consultationId: r.consultation_id,
    planName: r.plan_name, createdAt: r.created_at, stage: r.stage, status: r.status,
    requestedAmount: r.requested_amount, approvedAmount: r.approved_amount,
    salespersonId: r.salesperson_id_snapshot, salespersonName: r.salesperson_name_snapshot,
    currentSalespersonId: r.current_salesperson_id, currentSalespersonName: r.current_salesperson_name,
    requester: { id: r.requested_by_user_id, name: r.requester_name, username: r.requester_username,
      currentSalespersonId: r.requester_current_salesperson_id },
    calls: queryRows<any>(`SELECT id,created_at createdAt,salesperson_id salespersonId,
      salesperson_name_snapshot salespersonName FROM call_logs
      WHERE customer_id=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 5`, [r.customer_id, r.created_at]),
    history: queryRows<any>(`SELECT h.created_at createdAt,h.action,h.actor_id actorId,u.full_name actorName
      FROM loan_application_stage_history h LEFT JOIN users u ON u.id=h.actor_id
      WHERE h.application_id=? ORDER BY h.id LIMIT 5`, [r.id]),
    revisions: queryRows<any>(`SELECT audit.id,audit.previous_salesperson_id previousSalespersonId,
      audit.previous_salesperson_name previousSalespersonName,audit.salesperson_id salespersonId,
      audit.salesperson_name salespersonName,audit.reason,audit.created_at createdAt,
      audit.actor_user_id actorId,u.full_name actorName,u.username actorUsername
      FROM loan_salesperson_attribution_audit audit LEFT JOIN users u ON u.id=audit.actor_user_id
      WHERE audit.application_id=? ORDER BY audit.id DESC`, [r.id]),
  }));
  res.json({ items, total, page, pageSize: 20,
    salespersons: queryRows("SELECT id,name,active FROM salespersons ORDER BY name,id") });
});
router.post("/loan-applications/:id/attribution-review", requirePermission("loan_applications.view"), (req, res) => {
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  const id = Number(req.params.id), salespersonId = req.body?.salespersonId;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(salespersonId) || salespersonId < 1 || reason.length < 10 || reason.length > 1000)
    return error(res, 400, "invalid_attribution_review");
  const person = queryRow<{ id: number; name: string }>("SELECT id,name FROM salespersons WHERE id=?", [salespersonId]);
  if (!person) return error(res, 404, "salesperson_not_found");
  const result = runTransaction(() => {
    const app = queryRow<any>("SELECT id,salesperson_id_snapshot,salesperson_name_snapshot,deleted_at FROM loan_applications WHERE id=?", [id]);
    if (!app || app.deleted_at) return "not_found";
    const reviewed = queryRow("SELECT 1 FROM loan_salesperson_attribution_audit WHERE application_id=? LIMIT 1", [id]);
    // Existing contemporaneous snapshots cannot be overwritten by this legacy-only workflow.
    if (!reviewed && app.salesperson_id_snapshot != null) return "not_legacy";
    if (app.salesperson_id_snapshot === person.id) return "unchanged";
    const ts = now();
    execute("INSERT INTO loan_salesperson_attribution_audit(application_id,previous_salesperson_id,previous_salesperson_name,salesperson_id,salesperson_name,actor_user_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [id, app.salesperson_id_snapshot, app.salesperson_name_snapshot, person.id, person.name, user(res).id, reason, ts]);
    executeChanges("UPDATE loan_applications SET salesperson_id_snapshot=?,salesperson_name_snapshot=?,updated_at=? WHERE id=?",
      [person.id, person.name, ts, id]);
    return "saved";
  });
  if (result !== "saved") return error(res, result === "not_found" ? 404 : 409, result);
  res.json({ id, salespersonId: person.id, salespersonName: person.name });
});
// An estimate is a manual what-if, not a commission posting or a stored rate.
router.post("/loan-applications/:id/commission-estimate", requirePermission("loan_applications.view"), (req, res) => {
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  const id = Number(req.params.id), rate = req.body?.ratePercent;
  if (!Number.isSafeInteger(id) || id < 1 || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100 ||
    Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-8)
    return error(res, 400, "invalid_commission_rate");
  const app = queryRow<any>(`SELECT a.requested_amount,a.approved_amount,a.salesperson_id_snapshot,a.salesperson_name_snapshot
    FROM loan_applications a WHERE a.id=? AND a.deleted_at IS NULL`, [id]);
  if (!app) return error(res, 404, "loan_application_not_found");
  if (!queryRow("SELECT 1 FROM loan_salesperson_attribution_audit WHERE application_id=? LIMIT 1", [id]))
    return error(res, 409, "attribution_review_required");
  const baseAmount = app.approved_amount ?? app.requested_amount;
  if (!/^\d+$/.test(String(baseAmount))) return error(res, 422, "invalid_estimate_base");
  const estimatedAmountToman = (BigInt(baseAmount) * BigInt(Math.round(rate * 100)) / 10000n).toString();
  res.json({ baseAmountToman: String(baseAmount), baseType: app.approved_amount == null ? "requested" : "approved",
    ratePercent: rate, estimatedAmountToman, salespersonId: app.salesperson_id_snapshot,
    salespersonName: app.salesperson_name_snapshot, provisional: true });
});
router.get("/loan-applications/dashboard-stats", requirePermission("loan_applications.view"), (req, res): void => {
  const u = user(res);
  const actionableStages = Object.entries(actionPolicy)
    .filter(([, roles]) => roles.includes(u.role) || (u.role === "admin" && roles.length > 0))
    .map(([stage]) => stage);
  const scope = u.role === "admin" || u.customerScope !== "assigned" ? "" : " AND c.salesperson_id = ?";
  const params: any[] = [...actionableStages];
  if (scope) params.push(u.salespersonId);
  const row = queryRow<any>(`SELECT
      COALESCE(SUM(CASE WHEN a.status <> 'rejected' AND a.stage IN (${actionableStages.map(() => "?").join(",") || "NULL"}) THEN 1 ELSE 0 END),0) awaiting_action,
      COALESCE(SUM(CASE WHEN a.status <> 'rejected' AND a.stage <> 'completed' THEN 1 ELSE 0 END),0) in_progress,
      COALESCE(SUM(CASE WHEN a.status <> 'rejected' AND a.stage = 'completed' THEN 1 ELSE 0 END),0) completed
    FROM loan_applications a
    JOIN customers c ON c.id=a.customer_id
    WHERE a.deleted_at IS NULL
      AND (COALESCE(a.is_pre_registration,0)=0 OR a.stage<>'draft')${scope}`, params);
  res.json({
    awaitingAction: Number(row?.awaiting_action ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    completed: Number(row?.completed ?? 0),
  });
});
router.get("/customers/:customerId/eligible-plans", requirePermission("loan_applications.view"), (req, res) => {
  if (req.query.ignoreCreditRank !== undefined && (typeof req.query.ignoreCreditRank !== "string" || !["true", "false"].includes(req.query.ignoreCreditRank))) return error(res, 400, "invalid_ignore_credit_rank");
  const ignoreCreditRank = req.query.ignoreCreditRank === "true";
  const overrideError = loanCreditRankOverrideError(req.query.ignoreCreditRank, user(res).role, true, req.query.creditRankOverrideReason);
  if (overrideError) return error(res, overrideError.status, overrideError.code);
  const customer = getScopedCustomer(Number(req.params.customerId), user(res));
  if (!customer) return error(res, 404, "customer_not_found");
  const profile = queryRow<any>("SELECT * FROM customers WHERE id=?", [customer.id]);
  const credit = freshSuccessfulCredit(customer.id);
  const fresh = Boolean(credit);
  // Same guarantor-grade rule as the first-call form / consultation: a known non-matching grade drops the
  // condition, a missing / «نمی‌دونه» grade keeps it with a note. The rank override waives it too.
  const guarantor = customerGuarantorGrade(customer.id);
  const plans = queryRows<any>("SELECT * FROM loan_plans WHERE active=1 ORDER BY id").flatMap((plan) => {
    const conditions = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY sort_order,id", [plan.id]);
    if (ignoreCreditRank && !conditions.length) conditions.push({ id: 0, name: "بدون شرط پیکربندی‌شده" });
    const matches = conditions.filter((c) => {
      if (ignoreCreditRank) return true;
      const ranks = parseJson(c.customer_ranks) ?? String(c.customer_ranks ?? "").split(/[,،]/).map((x: string) => x.trim()).filter(Boolean);
      return conditionAcceptsCreditRank(credit?.score_label, ranks) && guarantorGradeAllows(guarantorGradeVerdict(c, guarantor.rank, plan));
    });
    return matches.filter((c) => {
      if (ignoreCreditRank) return true;
      const terms = effectivePlanTerms(plan, c);
      return profile.verification_status === "verified" && fresh && terms.maximum > 0n && terms.durations.length > 0;
    }).map((c, index) => {
       const required = (parseJson(plan.required_documents) ?? []).filter((key: unknown) => !separateRequirementKeys.has(String(key))).map((key: unknown) => documentLabel(String(key)));
      const terms = effectivePlanTerms(plan, ignoreCreditRank ? { ...c, max_principal: "0" } : c);
       const templateId = Number(plan.contract_template_id ?? plan.primary_contract_template_id) || null;
       const template = templateId ? queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]) : null;
       const manualVariables = (parseJson(template?.mappings_json) ?? []).filter((mapping: any) =>
         (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "manual"
       ).map((mapping: any) => ({ variable: String(mapping.variable), label: String(mapping.label || mapping.variable) }));
       return { planId: Number(plan.id), name: plan.name, conditionId: Number(c.id),
         conditionName: String(c.name ?? c.title ?? `شرط ${index + 1}`),
         conditionNotes: c.notes ? String(c.notes) : null, maximumAmount: terms.maximum.toString(),
        allowedDurations: terms.durations, requiredDocuments: required,
        needsGuarantor: Boolean(c.needs_guarantor ?? plan.needs_guarantor),
        ...(() => { const v = guarantorGradeVerdict(c, guarantor.rank, plan);
          return { guarantorRanks: v.ranks, guarantorGradeStatus: v.status, guarantorGradeNote: v.note }; })(),
         primaryContractPresent: Boolean(templateId), contractTemplateId: templateId, manualVariables };
    });
  });
  res.json({ customerId: customer.id, credit: { fresh, status: credit?.status ?? "missing", rank: credit?.score_label ?? null, checkedAt: credit?.completed_at ?? null },
    guarantor: { rank: guarantor.rank, hasGuarantor: guarantor.hasGuarantor, source: guarantor.source, at: guarantor.at }, plans });
});
// «نادیده گرفتن رتبه» switched on in the wizard: the reason is mandatory and the use is logged before any preview.
router.post("/customers/:customerId/credit-rank-override", requirePermission("loan_applications.create"), (req, res) => {
  const actor = user(res);
  const overrideError = loanCreditRankOverrideError(true, actor.role, false, req.body?.reason);
  if (overrideError) return error(res, overrideError.status, overrideError.code);
  const customer = getScopedCustomer(Number(req.params.customerId), actor);
  if (!customer) return error(res, 404, "customer_not_found");
  const id = logCreditRankOverride({ action: "preview_enabled", actor, customerId: customer.id, reason: loanCreditRankOverrideReason(req.body?.reason) });
  res.status(201).json({ id });
});
router.get("/loan-applications/:id/credit-rank-overrides", requirePermission("loan_applications.view"), (req, res) => {
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  res.json({ items: creditRankOverridesForApplication(Number(r.id), Number(r.customerId)) });
});
router.get("/credit-rank-overrides", requirePermission("loan_applications.view"), (req, res) => {
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  const limit = Number(req.query.limit ?? 200), offset = Number(req.query.offset ?? 0);
  res.json({ items: listCreditRankOverrides(Number.isSafeInteger(limit) ? limit : 200, Number.isSafeInteger(offset) ? offset : 0) });
});
router.get("/loan-applications/filing-fee-plans", requirePermission("loan_applications.create"), (req, res) => {
  const overrideError = loanCreditRankOverrideError(req.query.ignoreCreditRank, user(res).role, true, req.query.creditRankOverrideReason);
  if (overrideError) return error(res, overrideError.status, overrideError.code);
  const ignoreCreditRank = req.query.ignoreCreditRank === "true";
  const customer = getScopedCustomer(Number(req.query.customerId), user(res));
  if (!customer) return error(res, 404, "customer_not_found");
  const profile = queryRow<any>("SELECT * FROM customers WHERE id=?", [customer.id]);
  const cash = wallet(customer.id, "cash");
  const plans = queryRows<{ id: number; name: string; filing_fee_toman: string }>(
    "SELECT id,name,filing_fee_toman FROM loan_plans WHERE active=1 ORDER BY id")
    .filter((plan) => !filingFeePrerequisiteError(profile, ignoreCreditRank) && payablePlan(plan.id) && planAcceptsCustomerCredit(plan.id, customer.id, ignoreCreditRank));
  return res.json({ cashBalanceToman: cash.balance, plans: plans.map((p) => ({
    planId: p.id, name: p.name, filingFeeToman: p.filing_fee_toman,
  })) });
});
router.post("/loan-applications/filing-fee-charges", requirePermission("loan_applications.create"), (req, res) => {
  const overrideError = loanCreditRankOverrideError(req.body?.ignoreCreditRank, user(res).role, false, req.body?.creditRankOverrideReason);
  if (overrideError) return error(res, overrideError.status, overrideError.code);
  const ignoreCreditRank = req.body?.ignoreCreditRank === true;
  const overrideReason = ignoreCreditRank ? loanCreditRankOverrideReason(req.body?.creditRankOverrideReason) : null;
  const customerId = Number(req.body?.customerId), planId = Number(req.body?.planId);
  const key = String(req.header("Idempotency-Key") ?? "");
  if (!Number.isSafeInteger(customerId) || customerId <= 0 || !Number.isSafeInteger(planId) || planId <= 0
    || !/^[\x20-\x7e]{8,200}$/.test(key)) return error(res, 400, "invalid_filing_fee_request");
  const actor = user(res);
  const customer = getScopedCustomer(customerId, actor);
  if (!customer) return error(res, 404, "customer_not_found");
  try {
    const result = runImmediateTransaction(() => {
      // «در انتظار ثبت»: optional draftId only links the resulting charge to the draft; pricing and reuse below are unchanged.
      const draft = draftForFeeCharge(req.body?.draftId, customerId, planId, actor);
      const linked = <T extends { chargeId: number | string; applicationId: unknown }>(r: T): T => {
        if (draft && r.applicationId == null) linkDraftFee(draft, Number(r.chargeId), actor);
        return r;
      };
      const previous = queryRow<any>("SELECT * FROM loan_filing_fee_charges WHERE idempotency_key=?", [key]);
      if (previous) {
        if (previous.customer_id !== customerId || previous.plan_id !== planId) throw new Error("filing_fee_idempotency_conflict");
        return linked({ chargeId: previous.id, amountToman: previous.amount_toman, applicationId: previous.application_id, repeated: true });
      }
      if (draft?.fee_charge_id != null) {
        const own = queryRow<any>("SELECT * FROM loan_filing_fee_charges WHERE id=?", [draft.fee_charge_id]);
        if (own && own.application_id == null) return { chargeId: Number(own.id), amountToman: String(own.amount_toman), applicationId: null, repeated: true };
      }
      const reusable = reusableFilingFeeCharge(customerId, planId);
      if (reusable) {
        return linked({
          chargeId: Number(reusable.id),
          amountToman: String(reusable.amount_toman),
          applicationId: reusable.active_application_id == null ? null : Number(reusable.active_application_id),
          repeated: true,
        });
      }
      const profile = queryRow<any>("SELECT * FROM customers WHERE id=?", [customerId]);
      const prerequisiteError = filingFeePrerequisiteError(profile, ignoreCreditRank);
      if (prerequisiteError) throw new Error(prerequisiteError);
      const plan = payablePlan(planId);
      if (!plan) throw new Error("loan_plan_not_found");
      if (!planAcceptsCustomerCredit(planId, customerId, ignoreCreditRank)) throw new Error("loan_plan_condition_not_matched");
      const amount = String(plan.filing_fee_toman);
      if (!/^(0|[1-9]\d*)$/.test(amount)) throw new Error("invalid_filing_fee");
      const cash = wallet(customerId, "cash");
      const company = queryRow<{ balance: string }>("SELECT balance FROM company_wallet_accounts WHERE wallet_type='cash'");
      if (!company || !/^\d+$/.test(cash.balance) || !/^\d+$/.test(company.balance)) throw new Error("invalid_wallet_balance");
      if (BigInt(cash.balance) < BigInt(amount)) throw new Error("insufficient_cash_balance");
      const ts = now();
      const chargeId = execute(
        "INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
        [customerId, planId, amount, key, actor.id, ts]);
      if (overrideReason) logCreditRankOverride({ action: "filing_fee_charged", actor, customerId, planId, reason: overrideReason, at: ts });
      if (BigInt(amount) > 0n) {
        executeChanges("UPDATE wallet_accounts_v2 SET balance=? WHERE id=?", [(BigInt(cash.balance) - BigInt(amount)).toString(), cash.id]);
        executeChanges("UPDATE company_wallet_accounts SET balance=? WHERE wallet_type='cash'", [(BigInt(company.balance) + BigInt(amount)).toString()]);
        execute("INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,created_at) VALUES(?,?,?,?,?,?)",
          [cash.id, amount, "filing_fee_out", `filing-fee:${chargeId}:out`, actor.id, ts]);
        execute("INSERT INTO company_wallet_ledger(wallet_type,amount_toman,kind,fee_charge_id,actor_user_id,idempotency_key,created_at) VALUES('cash',?,'filing_fee',?,?,?,?)",
          [amount, chargeId, actor.id, `filing-fee:${chargeId}:in`, ts]);
      }
      return linked({ chargeId, amountToman: amount, applicationId: null, repeated: false });
    });
    return res.status(result.repeated ? 200 : 201).json({
      chargeId: result.chargeId, amountToman: result.amountToman, applicationId: result.applicationId,
    });
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (["filing_fee_idempotency_conflict", "insufficient_cash_balance", "draft_fee_plan_locked", "draft_closed"].includes(code)) return error(res, 409, code);
    if (["invalid_draft", "draft_not_found"].includes(code)) return error(res, code === "invalid_draft" ? 400 : 404, code);
    if (["customer_profile_incomplete", "customer_identity_not_verified", "credit_check_stale", "loan_plan_not_found",
      "loan_plan_condition_not_matched", "invalid_filing_fee", "invalid_wallet_balance"].includes(code)) return error(res, 422, code);
    req.log.error({ err: e }, "filing fee charge failed");
    return error(res, 500, "filing_fee_charge_failed");
  }
});
router.get("/loan-applications/:id", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  r.documents = loanProcessingDocuments(r.id)
    .map((document) => ({ ...document, original_name: normalizedUploadName(document.original_name), fileAvailable: fileExists(document.storage_path) }));
  r.history = queryRows("SELECT * FROM loan_application_stage_history WHERE application_id=? ORDER BY id", [r.id]);
  r.physicalChecks = queryRows("SELECT * FROM loan_physical_checks WHERE application_id=? ORDER BY id", [r.id]);
  r.physicalDocuments = queryRows<any>("SELECT id,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,created_at AS createdAt,storage_path FROM loan_physical_documents WHERE application_id=? ORDER BY id", [r.id])
    .map((document) => ({ ...document, fileAvailable: fileExists(document.storage_path), storage_path: undefined }));
  r.funderDefects = queryRows("SELECT * FROM loan_funder_defects WHERE application_id=? ORDER BY id", [r.id]);
  r.identityDocuments = queryRows<any>("SELECT id,customer_id AS customerId,document_type AS documentType,storage_path,original_name AS originalName,mime_type AS mimeType,size_bytes AS sizeBytes,approved_at AS approvedAt,approved_by_user_id AS approvedByUserId,review_reason AS reviewReason,created_at AS createdAt FROM customer_identity_documents WHERE customer_id=? AND is_latest=1 ORDER BY document_type", [r.customer_id])
    .map((document) => ({ ...document, fileAvailable: fileExists(document.storage_path), storage_path: undefined }));
  r.guarantor = queryRow("SELECT * FROM loan_application_guarantors WHERE application_id=?", [r.id]);
  if (r.guarantor) {
    r.guarantor.fullName = r.guarantor.full_name;
    r.guarantor.nationalCode = r.guarantor.national_code;
    r.guarantor.documents = queryRows<any>("SELECT * FROM loan_application_guarantor_documents WHERE guarantor_id=? ORDER BY id", [r.guarantor.id])
      .map((document) => ({ ...document, label: /[\u0600-\u06FF]/.test(String(document.requirement_key)) ? document.requirement_key : documentLabel(document.requirement_key), original_name: normalizedUploadName(document.original_name), fileAvailable: fileExists(document.storage_path) }));
  }
  r.collateral = queryRows<any>("SELECT * FROM loan_application_collateral WHERE application_id=?", [r.id])
    .map((item) => ({ ...item, dataJson: collateralMetadata(item), fileAvailable: fileExists(item.storage_path) }));
  r.requiredCollateral = requiredCollateralSlots(parseJson(r.condition_snapshot_json));
  r.generatedDocuments = queryRows<any>(`SELECT d.*,g.status generation_status,g.provider_status,g.pdf_path generation_pdf_path,g.superseded_at generation_superseded_at
    FROM loan_application_generated_documents d
    LEFT JOIN contract_generations g ON g.id=d.contract_generation_id AND g.deleted_at IS NULL
    WHERE d.application_id=? ORDER BY d.id`, [r.id])
    .map((document) => ({ ...document, fileAvailable: fileExists(document.generation_pdf_path), generation_pdf_path: undefined }));
  const replacementEligibility = tomanReplacementEligibility(r);
  r.tomanReplacementEligibility = replacementEligibility.sourceGenerationId == null ? null : replacementEligibility;
  r.tomanReplacement = currentTomanReplacement(r);
  return res.json(shape(r, user(res)));
});
router.post("/loan-applications/:id/authorize-toman-replacement", requirePermission("loan_applications.update"), (req, res) => {
  const actor = user(res);
  if (actor.role !== "admin") return error(res, 403, "admin_role_required");
  const body = req.body ?? {};
  const allowedKeys = new Set([
    "consent", "reason", "expectedGenerationId", "expectedApprovedAmount", "expectedDurationMonths",
  ]);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const expectedGenerationId = body.expectedGenerationId;
  const expectedApprovedAmount = body.expectedApprovedAmount;
  const expectedDurationMonths = body.expectedDurationMonths;
  if (Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      body.consent !== true || reason.length < 8 || reason.length > 1000 ||
      typeof expectedGenerationId !== "number" || !Number.isSafeInteger(expectedGenerationId) || expectedGenerationId < 1 ||
      typeof expectedApprovedAmount !== "string" || !/^[1-9]\d{0,17}$/.test(expectedApprovedAmount) ||
      typeof expectedDurationMonths !== "number" || !Number.isSafeInteger(expectedDurationMonths) || expectedDurationMonths < 1 || expectedDurationMonths > 600)
    return error(res, 400, "invalid_toman_replacement_consent");

  const applicationId = Number(req.params.id);
  const initial = scoped(applicationId, actor);
  if (!initial) return error(res, 404, "loan_application_not_found");
  const result = (() => {
    try {
      return runImmediateTransaction(() => {
        const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [applicationId]);
        if (!current) throw new Error("loan_application_not_found");
        const previousConsent = latestTomanReplacementConsent(applicationId);
        if (previousConsent) {
          const pin = previousConsent.consent;
          if (pin.sourceGenerationId === expectedGenerationId &&
              pin.approvedAmount === expectedApprovedAmount &&
              pin.durationMonths === expectedDurationMonths)
            return { repeated: true };
          throw new Error("replacement_already_authorized");
        }
        const eligibility = tomanReplacementEligibility(current);
        if (!eligibility.eligible || eligibility.sourceGenerationId !== expectedGenerationId ||
            eligibility.approvedAmount !== expectedApprovedAmount ||
            eligibility.durationMonths !== expectedDurationMonths)
          throw new Error(eligibility.blockedReason === "legacy_rial_principal_not_proven"
            ? "legacy_rial_principal_not_proven" : "toman_replacement_terms_stale");
        const priorStage = String(current.stage);
        const condition = parseJson(current.condition_snapshot_json);
        const resumeStage = priorStage === "approved_contract_pending_signature"
          ? (condition?.needs_guarantor || condition?.needsGuarantor
            ? "guarantor_documents_upload" : "collateral_upload")
          : ["draft", "primary_contract_pending_signature"].includes(priorStage)
            ? "customer_documents_upload" : priorStage;
        const authorizedAt = now();
        const consent: TomanReplacementConsent = {
          version: 1,
          priorStage,
          resumeStage,
          priorStatus: String(current.status),
          sourceGenerationId: expectedGenerationId,
          tomanTemplateId: Number(eligibility.tomanTemplateId),
          approvedAmount: expectedApprovedAmount,
          durationMonths: expectedDurationMonths,
          reason,
          authorizedAt,
          authorizedByUserId: actor.id,
        };
        const changed = executeChanges(`UPDATE loan_applications
          SET stage='approved_contract_pending_signature',updated_at=?
          WHERE id=? AND stage=? AND (current_primary_generation_id=? OR current_primary_generation_id IS NULL)
            AND approved_amount=? AND duration_months=? AND status<>'rejected'`,
        [authorizedAt, applicationId, priorStage, expectedGenerationId, expectedApprovedAmount, expectedDurationMonths]);
        if (changed !== 1) throw new Error("toman_replacement_terms_stale");
        execute(`INSERT INTO loan_application_stage_history
          (application_id,from_stage,to_stage,action,reason,actor_id,created_at)
          VALUES(?,?,?,?,?,?,?)`,
        [applicationId, priorStage, "approved_contract_pending_signature", TOMAN_REPLACEMENT_ACTION,
          JSON.stringify(consent), actor.id, authorizedAt]);
        return { repeated: false };
      });
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "toman_replacement_authorization_failed" };
    }
  })();
  if ("error" in result) {
    const status = result.error === "loan_application_not_found" ? 404
      : result.error === "legacy_rial_principal_not_proven" ? 409
        : 409;
    return error(res, status, result.error);
  }
  const updated = scoped(applicationId, actor);
  if (!updated) return error(res, 404, "loan_application_not_found");
  const replacementEligibility = tomanReplacementEligibility(updated);
  updated.tomanReplacementEligibility = replacementEligibility.sourceGenerationId == null ? null : replacementEligibility;
  updated.tomanReplacement = currentTomanReplacement(updated);
  return res.json(shape(updated, actor));
});
router.post("/loan-applications", requirePermission("loan_applications.create"), (req, res) => {
  const overrideError = loanCreditRankOverrideError(req.body?.ignoreCreditRank, user(res).role, false, req.body?.creditRankOverrideReason);
  if (overrideError) return error(res, overrideError.status, overrideError.code);
  const ignoreCreditRank = req.body?.ignoreCreditRank === true;
  const overrideReason = ignoreCreditRank ? loanCreditRankOverrideReason(req.body?.creditRankOverrideReason) : null;
  const b = req.body ?? {}, customerId = Number(b.customerId), planId = Number(b.planId);
  const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=? AND active=1", [planId]);
  const amount = String(b.requestedAmount ?? "").trim();
  const duration = Number(b.durationMonths);
  const conditionId = Number(b.conditionId);
  if (!customerId || !plan || !conditionId || !/^[1-9]\d*$/.test(amount) || !Number.isInteger(duration) || duration < 1) return error(res, 400, "invalid_application_input");
   const u = user(res), customer = queryRow<any>("SELECT * FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
   if (!customer || (u.customerScope === "assigned" && customer.salesperson_id !== u.salespersonId)) return error(res, 404, "loan_application_not_found");
  const feeChargeId = Number(b.feeChargeId);
  const charge = Number.isSafeInteger(feeChargeId) ? queryRow<any>(
    "SELECT * FROM loan_filing_fee_charges WHERE id=? AND customer_id=? AND plan_id=?", [feeChargeId, customerId, planId]) : null;
  if (!charge) return error(res, 422, "filing_fee_required");
  let draft: any = null;
  try { draft = draftForSubmit(b.draftId, customerId, charge.id, u); }
  catch (e) { const code = e instanceof Error ? e.message : "invalid_draft"; if (!(charge.application_id && code === "draft_closed")) return error(res, code === "draft_not_found" ? 404 : code === "invalid_draft" ? 400 : 409, code); }
  if (charge.application_id) {
    const existing = scoped(charge.application_id, u);
    return existing ? res.status(200).json(existing) : error(res, 409, "filing_fee_already_used");
  }
  if (customer.verification_status !== "verified") return error(res, 422, "customer_identity_not_verified");
  const credit = freshSuccessfulCredit(customerId);
  if (!ignoreCreditRank && !credit) return error(res, 422, "credit_check_stale");
  const conditions = queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY sort_order,id", [planId]);
  const condition = conditions.find((item) => Number(item.id) === conditionId);
  if (!condition) return error(res, 422, "loan_plan_condition_not_found");
  const ranks = parseJson(condition.customer_ranks) ?? String(condition.customer_ranks ?? "").split(/[,،]/).map((x: string) => x.trim()).filter(Boolean);
  if (!ignoreCreditRank && !conditionAcceptsCreditRank(credit.score_label, ranks)) return error(res, 422, "loan_plan_condition_not_matched");
  if (!ignoreCreditRank && !guarantorGradeAllows(guarantorGradeVerdict(condition, customerGuarantorGrade(customerId).rank, plan)))
    return error(res, 422, "loan_plan_guarantor_grade_not_matched");
  const terms = effectivePlanTerms(plan, ignoreCreditRank ? { ...condition, max_principal: "0" } : condition);
  const matches = terms.maximum > 0n && BigInt(amount) <= terms.maximum && terms.durations.includes(duration) ? [condition] : [];
  if (!matches.length) return error(res, 422, "loan_plan_condition_not_matched");
  const primaryTemplateId = Number(plan.contract_template_id ?? plan.primary_contract_template_id);
  const manualInput = validatedPrimaryManualValues(primaryTemplateId, b.manualValues);
  if (manualInput.error) {
    req.log.warn({ code: manualInput.error, status: 422 }, "initial loan application rejected");
    return res.status(422).json({
      error: manualInput.error, code: manualInput.error, ...(manualInput.fieldErrors ? { fieldErrors: manualInput.fieldErrors } : {}),
    });
  }
  if (!hasFreshIdentityDocuments(customerId)) return error(res, 422, "identity_documents_missing");
   const ts = now(), requirements = (() => { try { return (JSON.parse(plan.required_documents || "[]") as unknown[]).filter((key) => !separateRequirementKeys.has(String(key))); } catch { return []; } })();
   const id = runTransaction(() => {
     const currentCharge = queryRow<any>("SELECT application_id FROM loan_filing_fee_charges WHERE id=?", [charge.id]);
     if (currentCharge?.application_id) return Number(currentCharge.application_id);
    let consultationId = Number(b.consultationId);
    if (!consultationId || !queryRow("SELECT id FROM consultation_forms WHERE id=? AND customer_id=?", [consultationId, customerId])) {
      consultationId = execute("INSERT INTO consultation_forms(customer_id,requested_amount,extra_notes,updated_at) VALUES(?,?,?,?)", [customerId, amount, b.notes ?? null, ts]);
    }
     const preRegistration = b.preRegistration === true ? 1 : 0;
      const salespersonSnapshot = customer.salesperson_id == null
        ? null
        : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [customer.salesperson_id]);
      const appId = execute(`INSERT INTO loan_applications(consultation_id,customer_id,requested_by_user_id,plan_ids,plan_id,requested_amount,duration_months,requested_duration_months,stage,status,plan_snapshot_json,condition_snapshot_json,document_requirements_snapshot_json,primary_manual_values_json,is_pre_registration,salesperson_id_snapshot,salesperson_name_snapshot,new_case_workflow,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [consultationId, customerId, u.id, JSON.stringify([planId]), planId, amount, duration, duration, "draft", "requested", JSON.stringify(plan), JSON.stringify(ignoreCreditRank ? loanRankOverrideSnapshot(condition, u.id, ts, terms.maximum.toString(), overrideReason) : condition ?? null), JSON.stringify(requirements.map((key) => ({ key: String(key), label: documentLabel(String(key)) }))), JSON.stringify(manualInput.values), preRegistration, customer.salesperson_id ?? null, salespersonSnapshot?.name ?? null, 1, ts, ts]);
     for (const item of requirements) execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,?,?)", [appId, String(item), documentLabel(String(item)), "plan", ts]);
      execute("INSERT INTO loan_application_stage_history(application_id,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?)", [appId, "draft", "created", u.id, ts]);
     executeChanges("UPDATE loan_filing_fee_charges SET application_id=? WHERE id=? AND application_id IS NULL", [appId, charge.id]);
     // Same transaction: the «در انتظار ثبت» draft of this fee (or the one named by draftId) is closed as submitted.
     closeDraftsForCase(customerId, Number(charge.id), appId, u.id, draft ? Number(draft.id) : null);
    if (overrideReason) {
      logCreditRankOverride({ action: "case_created", actor: u, customerId, applicationId: appId, planId, conditionId, reason: overrideReason, at: ts });
      // Earlier uses for this customer (preview / filing fee) by the same person now belong to this case.
      executeChanges(`UPDATE loan_credit_rank_override_log SET application_id=? WHERE customer_id=? AND user_id=? AND application_id IS NULL
        AND action IN ('preview_enabled','filing_fee_charged')`, [appId, customerId, u.id]);
    }
    return appId;
  });
  res.status(201).json(scoped(id, u));
});
registerLoanCaseAdminControls(router, { scoped, stages, workflowStatus, effectivePlanTerms, validatedPrimaryManualValues, loanRankOverrideSnapshot, documentLabel });
registerLoanCaseNotes(router, scoped);

router.patch("/loan-applications/:id", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const actor = user(res);
  if (actor.role === "salesperson" && (actor.salespersonId == null ||
      Number(r.customer_salesperson_id) !== actor.salespersonId)) return error(res, 403, "action_forbidden");
  if (!["draft", "funder_initial_approval"].includes(r.stage) || r.status === "rejected") return error(res, 409, "application_not_editable");
  const hasPrimaryContract = Boolean(queryRow(
    `SELECT 1 FROM loan_application_generated_documents d
     JOIN contract_generations g ON g.id=d.contract_generation_id
     WHERE d.application_id=? AND d.kind='primary' AND g.deleted_at IS NULL LIMIT 1`,
    [r.id],
  ));
  if (r.initial_approval_at || r.current_primary_generation_id != null || hasPrimaryContract) return error(res, 409, "approved_application_terms_immutable");
  const allowedKeys = new Set(["requestedAmount", "durationMonths", "manualValues", "notes"]);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !allowedKeys.has(key)) || Object.keys(req.body).length === 0) {
    return error(res, 400, "invalid_application_input");
  }
  const requestedAmount = req.body.requestedAmount === undefined ? String(r.requested_amount) : String(req.body.requestedAmount).trim();
  const duration = req.body.durationMonths === undefined ? Number(r.requested_duration_months ?? r.duration_months) : Number(req.body.durationMonths);
  if (!/^[1-9]\d{0,17}$/.test(requestedAmount) || !Number.isSafeInteger(duration) || duration < 1 || duration > 600) {
    return error(res, 400, "invalid_application_input");
  }
  const condition = parseJson(r.condition_snapshot_json);
  const plan = parseJson(r.plan_snapshot_json);
  const credit = freshSuccessfulCredit(Number(r.customer_id));
  const ranks = parseJson(condition?.customer_ranks) ??
    String(condition?.customer_ranks ?? "").split(/[,،]/).map((value: string) => value.trim()).filter(Boolean);
  const terms = effectivePlanTerms(plan, condition);
  if (!condition || (condition.credit_rank_ignored !== true && (!credit || !conditionAcceptsCreditRank(credit.score_label, ranks))) ||
      BigInt(requestedAmount) > terms.maximum || !terms.durations.includes(duration)) {
    return error(res, 422, "application_terms_not_eligible");
  }
  const templateId = Number(plan?.contract_template_id ?? plan?.primary_contract_template_id);
  const manualInput: ReturnType<typeof validatedPrimaryManualValues> = req.body.manualValues === undefined
    ? { values: parseJson(r.primary_manual_values_json) ?? {} }
    : validatedPrimaryManualValues(templateId, req.body.manualValues);
  if (manualInput.error || !manualInput.values) {
    return res.status(422).json({
      error: manualInput.error ?? "invalid_manual_values",
      code: manualInput.error ?? "invalid_manual_values",
      ...(manualInput.fieldErrors ? { fieldErrors: manualInput.fieldErrors } : {}),
    });
  }
  const notes = req.body.notes === undefined ? r.notes ?? null : req.body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.trim().length > 2000)) return error(res, 400, "invalid_application_notes");
  const ts = now();
  try {
    runTransaction(() => {
      const changed = executeChanges(`UPDATE loan_applications SET requested_amount=?,duration_months=?,requested_duration_months=?,
        primary_manual_values_json=?,notes=?,updated_at=? WHERE id=? AND stage=? AND initial_approval_at IS NULL
        AND current_primary_generation_id IS NULL AND status<>'rejected'`,
      [requestedAmount, duration, duration, JSON.stringify(manualInput.values), notes?.trim?.() || null, ts, r.id, r.stage]);
      if (changed !== 1 || queryRow(
        `SELECT 1 FROM loan_application_generated_documents d
         JOIN contract_generations g ON g.id=d.contract_generation_id
         WHERE d.application_id=? AND d.kind='primary' AND g.deleted_at IS NULL LIMIT 1`,
        [r.id],
      )) throw new Error("application_not_editable");
      executeChanges("UPDATE consultation_forms SET requested_amount=?,extra_notes=?,updated_at=? WHERE id=?",
        [requestedAmount, notes?.trim?.() || null, ts, r.consultation_id]);
      recordReview(r.id, r.stage, "application_edited_before_provider_approval",
        JSON.stringify({ actorRole: actor.role, requestedAmount, durationMonths: duration }), actor.id);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "application_not_editable") return error(res, 409, "application_not_editable");
    throw e;
  }
  res.json(scoped(r.id, actor));
});
router.delete("/loan-applications/:id", requirePermission("loan_applications.delete"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  executeChanges("UPDATE loan_applications SET deleted_at=?,updated_at=? WHERE id=?", [now(), now(), r.id]); res.status(204).end();
});

router.post("/loan-applications/:id/manual-requirements", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "customer_documents_upload") return error(res, 409, "document_upload_stage_required");
  const label = String(req.body?.label || "").trim(); if (!label || !/[\u0600-\u06FF]/.test(label)) return error(res, 400, "invalid_document_requirement");
  const id = execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_at) VALUES(?,?,?,?,?)", [r.id, crypto.randomUUID(), label, "manual", now()]);
  res.status(201).json(queryRow("SELECT * FROM loan_application_documents WHERE id=?", [id]));
});
router.delete("/loan-applications/:id/manual-requirements/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  executeChanges("DELETE FROM loan_application_documents WHERE id=? AND application_id=? AND source='manual'", [Number(req.params.documentId), r.id]); res.status(204).end();
});
router.post("/loan-applications/:id/documents", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (!["customer_documents_upload", "funder_documents_correction"].includes(r.stage) || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 409, "document_upload_stage_required");
  if (!req.file) return error(res, 400, "file_required");
  const requirementKey = String(req.body?.requirementKey || "").trim();
  const existing = requirementKey && queryRow<any>("SELECT * FROM loan_application_documents WHERE application_id=? AND requirement_key=? AND source IN ('plan','manual') ORDER BY id LIMIT 1", [r.id, requirementKey]);
  if (r.stage === "funder_documents_correction" && (!existing || !queryRow("SELECT 1 FROM loan_funder_defects WHERE application_id=? AND source='document' AND source_id=? AND resolved_at IS NULL", [r.id, existing.id]))) return error(res, 409, "document_not_marked_for_correction");
  const originalName = normalizedUploadName(req.file.originalname);
  const requestedLabel = String(req.body?.label || "").trim();
  if (!existing && (!requestedLabel || !/[\u0600-\u06FF]/.test(requestedLabel))) return error(res, 400, "persian_document_label_required");
  const target = storeFile(r.id, req.file);
  let id: number;
  if (existing) {
    executeChanges("UPDATE loan_application_documents SET status='uploaded',storage_path=?,original_name=?,mime_type=?,size_bytes=?,incomplete_reason=NULL,reviewed_at=NULL WHERE id=?",
      [target, originalName, req.file.mimetype || "application/octet-stream", req.file.size, existing.id]);
    if (existing.storage_path) try { fs.unlinkSync(existing.storage_path); } catch { /* old upload cleanup is best effort */ }
    id = Number(existing.id);
    executeChanges("UPDATE loan_funder_defects SET resolved_at=? WHERE application_id=? AND source='document' AND source_id=?", [now(), r.id, id]);
  } else {
    const label = requestedLabel;
    id = execute("INSERT INTO loan_application_documents(application_id,requirement_key,label,source,status,storage_path,original_name,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [r.id, requirementKey || crypto.randomUUID(), label, "manual", "uploaded", target, originalName, req.file.mimetype || "application/octet-stream", req.file.size, now()]);
  }
  recordReview(r.id, r.stage, `customer_document_uploaded:${id}`, null, user(res).id);
  res.status(201).json(queryRow("SELECT * FROM loan_application_documents WHERE id=?", [id]));
});
router.post("/loan-applications/:id/guarantor/documents", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const g = r && queryRow<any>("SELECT id FROM loan_application_guarantors WHERE application_id=?", [r.id]);
  if (!r || !g || !req.file) return error(res, 400, "guarantor_or_file_required");
  if (loanCaseFinancialTermsLocked(r)) return error(res, 409, "admin_case_financial_terms_locked");
  if (!["guarantor_documents_upload", "guarantor_documents_review", "funder_documents_correction"].includes(r.stage) ||
      !canAct(r.stage === "guarantor_documents_review" ? "guarantor_documents_upload" : r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const requirementKey = String(req.body?.requirementKey || (typeof req.body?.label === "string" ? req.body.label.trim() : "") || "document");
  const file = req.file;
  const target = storeFile(r.id, req.file);
  const existing = queryRow<any>("SELECT * FROM loan_application_guarantor_documents WHERE guarantor_id=? AND requirement_key=? ORDER BY id DESC LIMIT 1", [g.id, requirementKey]);
  if (r.stage === "funder_documents_correction" && (!existing || !queryRow("SELECT 1 FROM loan_funder_defects WHERE application_id=? AND source='guarantor' AND source_id=? AND resolved_at IS NULL", [r.id, existing.id]))) return error(res, 409, "document_not_marked_for_correction");
  let id: number;
  try { id = runTransaction(() => {
  let savedId: number;
  if (existing) {
    executeChanges("UPDATE loan_application_guarantor_documents SET status='uploaded',storage_path=?,original_name=?,mime_type=?,size_bytes=?,rejection_reason=NULL WHERE id=?", [target, normalizedUploadName(file.originalname), file.mimetype, file.size, existing.id]);
    savedId = Number(existing.id);
    executeChanges("UPDATE loan_funder_defects SET resolved_at=? WHERE application_id=? AND source='guarantor' AND source_id=?", [now(), r.id, savedId]);
  } else {
    savedId = execute("INSERT INTO loan_application_guarantor_documents(guarantor_id,requirement_key,status,storage_path,original_name,mime_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)", [g.id, requirementKey, "uploaded", target, normalizedUploadName(file.originalname), file.mimetype, file.size, now()]);
  }
  recordReview(r.id, r.stage, `guarantor_document_uploaded:${savedId}`, null, user(res).id);
  if (r.stage === "guarantor_documents_review") {
    executeChanges("UPDATE loan_applications SET stage='guarantor_documents_upload',status=?,updated_at=? WHERE id=?", [workflowStatus("guarantor_documents_upload"), now(), r.id]);
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
      [r.id, r.stage, "guarantor_documents_upload", "guarantor-review-reopened-for-upload", "تکمیل مدارک ضامن؛ مبلغ، مدت و امضای قبلی بدون تغییر حفظ شدند.", user(res).id, now()]);
  }
  return savedId;
  }); } catch (cause) { try { fs.unlinkSync(target); } catch {} throw cause; }
  if (existing?.storage_path && existing.storage_path !== target) try { fs.unlinkSync(existing.storage_path); } catch {}
  res.status(201).json({ id, status: "uploaded" });
});
router.get("/loan-applications/:id/guarantor/documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT d.* FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [Number(req.params.documentId), r.id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found"); let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!p.startsWith(uploadRootReal + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "document_not_found");
  if (req.query.preview === "1" && (rasterImageType(d.mime_type) || d.mime_type === "application/pdf")) {
    res.type(d.mime_type);
    res.setHeader("Content-Disposition", "inline");
    return res.sendFile(p);
  }
  return res.download(p, d.original_name || "document");
});
router.delete("/loan-applications/:id/guarantor/documents/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT d.* FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [Number(req.params.documentId), r.id]);
  if (r && (r.stage !== "guarantor_documents_upload" || !canAct(r.stage, user(res), r.customer_id, r.status))) return error(res, 403, "action_forbidden");
  if (!d) return error(res, 404, "document_not_found"); if (d.storage_path) try { fs.unlinkSync(d.storage_path); } catch {} executeChanges("DELETE FROM loan_application_guarantor_documents WHERE id=?", [d.id]); res.status(204).end();
});
router.post("/loan-applications/:id/guarantor/documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || "");
  if (!r || !["approved", "incomplete", "rejected"].includes(decision) || (decision !== "approved" && !String(req.body?.reason || "").trim())) return error(res, 400, "invalid_document_review");
  if (r.stage !== "guarantor_documents_review" || !canAct("guarantor_documents_review", user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const doc = queryRow<any>("SELECT d.id,d.storage_path FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [Number(req.params.documentId), r.id]);
  if (!doc || !fileExists(doc.storage_path)) return error(res, 404, "document_not_found");
  runTransaction(() => {
    executeChanges("UPDATE loan_application_guarantor_documents SET status=?,rejection_reason=? WHERE id=?", [decision, decision === "approved" ? null : String(req.body.reason).trim(), doc.id]);
    recordReview(r.id, r.stage, `guarantor_document_${decision}:${doc.id}`, decision === "approved" ? null : String(req.body.reason).trim(), user(res).id);
  });
  res.json({ ok: true, status: decision, rejectionReason: decision === "approved" ? null : String(req.body.reason).trim() });
});
router.post("/loan-applications/:id/collateral", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r || !req.file) return error(res, 400, "invalid_collateral");
  if (!["collateral_upload", "funder_documents_correction"].includes(r.stage) || !canAct("collateral_upload", user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const slots = requiredCollateralSlots(parseJson(r.condition_snapshot_json));
  const requirementKey = String(req.body?.requirementKey || "");
  const slot = slots.find((item) => item.key === requirementKey);
  if (!slot) return error(res, 400, "invalid_collateral_requirement");
  const target = storeFile(r.id, req.file);
  const metadata = { requirementKey: slot.key, party: slot.party, side: slot.side, label: slot.label, originalName: normalizedUploadName(req.file.originalname), mimeType: req.file.mimetype || "application/octet-stream", sizeBytes: req.file.size };
  const existing = queryRow<any>("SELECT * FROM loan_application_collateral WHERE application_id=? AND json_extract(data_json,'$.requirementKey')=?", [r.id, slot.key]);
  if (r.stage === "funder_documents_correction" && (!existing || !queryRow("SELECT 1 FROM loan_funder_defects WHERE application_id=? AND source='collateral' AND source_id=? AND resolved_at IS NULL", [r.id, existing.id]))) return error(res, 409, "collateral_not_marked_for_correction");
  let id: number;
  if (existing) {
    executeChanges("UPDATE loan_application_collateral SET collateral_type=?,status='submitted',data_json=?,storage_path=?,reviewed_at=NULL,rejection_reason=NULL WHERE id=?", [slot.type, JSON.stringify(metadata), target, existing.id]);
    if (existing.storage_path) try { fs.unlinkSync(existing.storage_path); } catch {}
    id = Number(existing.id);
    executeChanges("UPDATE loan_funder_defects SET resolved_at=? WHERE application_id=? AND source='collateral' AND source_id=?", [now(), r.id, id]);
  } else {
    id = execute("INSERT INTO loan_application_collateral(application_id,collateral_type,status,data_json,storage_path,created_at) VALUES(?,?,?,?,?,?)", [r.id, slot.type, "submitted", JSON.stringify(metadata), target, now()]);
  }
  recordReview(r.id, r.stage, `collateral_uploaded:${slot.key}:${id}`, null, user(res).id);
  res.status(201).json({ id, status: "submitted", ...metadata });
});
router.get("/loan-applications/:id/collateral/:collateralId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_collateral WHERE id=? AND application_id=?", [Number(req.params.collateralId), r.id]);
  if (!d?.storage_path) return error(res, 404, "collateral_not_found");
  let p: string; try { p = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "collateral_not_found"); }
  if (!p.startsWith(uploadRootReal + path.sep) || !fs.statSync(p).isFile()) return error(res, 404, "collateral_not_found");
  const metadata = parseJson(d.data_json) ?? {};
  if (req.query.preview === "1" && (rasterImageType(metadata.mimeType) || metadata.mimeType === "application/pdf")) {
    res.type(metadata.mimeType);
    res.setHeader("Content-Disposition", "inline");
    return res.sendFile(p);
  }
  return res.download(p, metadata.originalName || `collateral-${d.id}.${safeExtension(p)}`);
});
router.delete("/loan-applications/:id/collateral/:collateralId", requirePermission("loan_applications.update"), (req, res) => {
  const app = scoped(Number(req.params.id), user(res));
  if (app && (app.stage !== "collateral_upload" || !canAct(app.stage, user(res), app.customer_id, app.status))) return error(res, 403, "action_forbidden");
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_collateral WHERE id=? AND application_id=?", [Number(req.params.collateralId), r.id]); if (!d) return error(res, 404, "collateral_not_found"); if (d.storage_path) try { fs.unlinkSync(d.storage_path); } catch {} executeChanges("DELETE FROM loan_application_collateral WHERE id=?", [d.id]); res.status(204).end();
});
router.post("/loan-applications/:id/collateral/:collateralId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || ""); if (!r || !["approved", "incomplete", "rejected"].includes(decision) || (decision !== "approved" && !String(req.body?.reason || "").trim())) return error(res, 400, "invalid_collateral_review");
  if (r.stage !== "collateral_review" || !canAct("collateral_review", user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const item = queryRow<any>("SELECT id,storage_path FROM loan_application_collateral WHERE id=? AND application_id=?", [Number(req.params.collateralId), r.id]);
  if (!item || !fileExists(item.storage_path)) return error(res, 404, "collateral_not_found");
  runTransaction(() => {
    executeChanges("UPDATE loan_application_collateral SET status=?,rejection_reason=?,reviewed_at=? WHERE id=?", [decision, decision === "approved" ? null : String(req.body.reason).trim(), now(), item.id]);
    recordReview(r.id, r.stage, `collateral_${decision}:${item.id}`, decision === "approved" ? null : String(req.body.reason).trim(), user(res).id);
  });
  res.json({ ok: true, status: decision, rejectionReason: decision === "approved" ? null : String(req.body.reason).trim() });
});
router.get("/loan-applications/:id/documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const d = r && queryRow<any>("SELECT * FROM loan_application_documents WHERE id=? AND application_id=?", [Number(req.params.documentId), r.id]);
  if (!d?.storage_path) return error(res, 404, "document_not_found");
  let real: string; try { real = fs.realpathSync(d.storage_path); } catch { return error(res, 404, "document_not_found"); }
  if (!real.startsWith(uploadRootReal + path.sep) || !fs.statSync(real).isFile() || !["plan", "manual"].includes(d.source)) return error(res, 404, "document_not_found");
  if (req.query.preview === "1" && (rasterImageType(d.mime_type) || d.mime_type === "application/pdf")) {
    res.type(d.mime_type);
    res.setHeader("Content-Disposition", "inline");
    return res.sendFile(real);
  }
  return res.download(real, normalizedUploadName(d.original_name) || "document");
});
router.delete("/loan-applications/:id/documents/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "customer_documents_upload" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const d = queryRow<any>("SELECT id,storage_path,source FROM loan_application_documents WHERE id=? AND application_id=?", [Number(req.params.documentId), r.id]);
  if (!d) return error(res, 404, "document_not_found");
  if (d.source === "identity_vault") return error(res, 409, "identity_document_immutable");
  if (d.storage_path) { try { fs.unlinkSync(d.storage_path); } catch { /* cleanup is best effort */ } }
  if (d.source === "plan") {
    executeChanges("UPDATE loan_application_documents SET status='pending',storage_path=NULL,original_name=NULL,mime_type=NULL,size_bytes=NULL,incomplete_reason=NULL,reviewed_at=NULL WHERE id=?", [d.id]);
  } else {
    executeChanges("DELETE FROM loan_application_documents WHERE id=? AND application_id=?", [d.id, r.id]);
  }
  res.status(204).end();
});
router.post("/loan-applications/:id/documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const decision = String(req.body?.decision || "");
  if (!r || !["approved", "incomplete", "rejected"].includes(decision)) return error(res, 400, "invalid_document_review");
  if (r.stage !== "customer_documents_review" || !canAct("customer_documents_review", user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (["incomplete", "rejected"].includes(decision) && !String(req.body?.reason || "").trim()) return error(res, 400, "review_reason_required");
  const document = queryRow<any>("SELECT id,storage_path FROM loan_application_documents WHERE id=? AND application_id=? AND source IN ('plan','manual') AND storage_path IS NOT NULL", [Number(req.params.documentId), r.id]);
  if (!document || !fileExists(document.storage_path)) return error(res, 404, "document_not_found");
  const reviewedAt = now();
  runTransaction(() => {
    executeChanges("UPDATE loan_application_documents SET status=?,incomplete_reason=?,reviewed_at=? WHERE id=? AND application_id=?", [decision, decision === "approved" ? null : String(req.body.reason).trim(), reviewedAt, Number(req.params.documentId), r.id]);
    recordReview(r.id, r.stage, `customer_document_${decision}:${req.params.documentId}`, decision === "approved" ? null : String(req.body.reason).trim(), user(res).id);
  });
  res.json({ ok: true, status: decision, stage: r.stage });
});

function action(pathSuffix: string, permission: any, to: Stage) {
  router.post(`/loan-applications/:id/${pathSuffix}`, requirePermission(permission), (req, res) => {
    const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
    try { transition(r.id, to, pathSuffix, user(res), req.body?.reason); res.json(scoped(r.id, user(res))); } catch (e) {
      const code = e instanceof Error ? e.message : "";
      return error(res, 409, code === "invalid_transition" ? "invalid_stage_transition" :
        ["rendered_primary_principal_unverifiable", "requested_primary_generation_required",
          "requested_primary_terms_not_verified", "current_primary_terms_not_verified",
          "approved_primary_generation_evidence_missing", "loan_amount_approval_required",
          "toman_replacement_terms_unverifiable"].includes(code) ? code : "workflow_error");
    }
  });
}
action("submit-primary-contract", "loan_applications.update", "primary_contract_pending_signature");
router.post("/loan-applications/:id/confirm-signed-primary", requirePermission("loan_applications.update"), async (req, res): Promise<void> => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) { error(res, 404, "loan_application_not_found"); return; }
  if (!["draft", "primary_contract_pending_signature"].includes(r.stage) ||
      !canAct(r.stage, user(res), r.customer_id, r.status)) {
    error(res, 403, "action_forbidden"); return;
  }
  const primary = applicationPrimaryDocument(r);
  if (!primary?.document_id) { error(res, 409, "primary_contract_not_signed"); return; }
  const d = queryRow<any>(`SELECT d.*,d.status document_status,g.status generation_status,
      g.customer_id generation_customer_id,g.loan_plan_id generation_plan_id,g.generation_purpose,
      g.loan_application_id generation_application_id,g.deleted_at generation_deleted_at,
      g.superseded_at generation_superseded_at,g.provider_status,g.provider_contract_id
    FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.id=? AND d.application_id=?`, [primary.document_id, r.id]);
  if (!d?.provider_contract_id || !primarySignatureIdentityEligible(r, d)) {
    error(res, 409, "primary_contract_not_signed"); return;
  }
  try {
    const observation = await observeGeneratedDocumentSignature(d, true, {
      allowDraftStageConfirmation: r.stage === "draft",
    });
    if (!observation.signed) { error(res, 409, "primary_contract_not_signed"); return; }
    res.json({ ...scoped(r.id, user(res)), workflowAdvanced: observation.workflowAdvanced, nextStage: observation.nextStage });
  } catch (err) {
    req.log.warn({ err, applicationId: r.id, documentId: d.id }, "confirmed primary signature refresh failed");
    error(res, 502, "provider_status_failed");
  }
});
action("submit-customer-documents", "loan_applications.update", "customer_documents_review");
action("start-guarantor-documents", "loan_applications.update", "guarantor_documents_upload");
action("submit-guarantor-documents", "loan_applications.update", "guarantor_documents_review");
action("review-guarantor-documents", "loan_applications.review", "collateral_upload");
action("submit-collateral", "loan_applications.update", "collateral_review");
action("review-collateral", "loan_applications.review", "expert_approval");
router.post("/loan-applications/:id/funder-initial-approve", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  const amount = req.body?.approvedAmount;
  const approvedDuration = req.body?.approvedDurationMonths;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!r) return error(res, 404, "loan_application_not_found");
  if (loanCaseFinancialTermsLocked(r)) return error(res, 409, "admin_case_financial_terms_locked");
  if (r.stage !== "funder_initial_approval" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (Object.keys(req.body ?? {}).some((key) => !["approvedAmount", "approvedDurationMonths", "reason"].includes(key)) ||
      typeof amount !== "string" || !/^[1-9]\d{0,17}$/.test(amount) || reason.length > 500 ||
      (approvedDuration !== undefined && (!Number.isSafeInteger(approvedDuration) || approvedDuration < 1 || approvedDuration > 600)))
    return error(res, 400, "invalid_initial_funder_approval");
  try {
    const plan = parseJson(r.plan_snapshot_json);
    const condition = parseJson(r.condition_snapshot_json);
    const terms = effectivePlanTerms(plan, condition);
    const ceiling = terms.maximum;
    if (ceiling <= 0n || BigInt(amount) > ceiling) return error(res, 422, "approved_amount_exceeds_plan_ceiling");
    const requestedDuration = Number(r.requested_duration_months ?? r.duration_months);
    if (!Number.isSafeInteger(requestedDuration) || requestedDuration < 1 || requestedDuration > 600)
      return error(res, 409, "invalid_requested_duration");
    const duration = approvedDuration ?? requestedDuration;
    // Preserve unchanged legacy decisions when their historical duration is no longer
    // in the plan options, but never permit a new duration outside the snapshot.
    if (duration !== requestedDuration && !terms.durations.includes(duration))
      return error(res, 422, "approved_duration_not_allowed");
    // This records the provider's proposed terms, not a financial posting.
    // Changed terms go to replacement-contract issuance. Its generation, signing
    // and funding guards still require actual approved-duration evidence.
    const net = netLoanAmount({ ...r, approved_amount: amount, duration_months: duration });
    const newCase = Number(r.new_case_workflow) === 1;
    const needsGuarantor = Boolean(condition?.needs_guarantor || condition?.needsGuarantor);
    // Legacy reopened cases may need a fresh primary contract before sales can
    // register a guarantor. Keep that registration mandatory downstream rather
    // than trapping the case in a stage where sales cannot register one.
    if (newCase) {
      const primary = currentPrimaryDocument(r);
      const reapproval = canReapproveInitialDecision(r, { queryRow, queryRows, documents: loanProcessingDocuments, fileExists });
      if (r.initial_approval_at && !reapproval) return error(res, 409, "initial_funder_decision_already_recorded");
      if (!primary || ["rejected", "incomplete"].includes(primary.document_status) ||
          (reapproval
            ? !signedPrimaryMatchesApprovedTerms(r, String(r.approved_amount), Number(r.duration_months))
            : primary.document_status !== "approved" || !signedPrimaryMatchesRequestedTerms(r)) ||
          (needsGuarantor && !queryRow("SELECT 1 FROM loan_application_guarantors WHERE application_id=?", [r.id])))
        return error(res, 409, "requested_primary_or_documents_not_verified");
      const sameTerms = reapproval
        ? amount === String(r.approved_amount) && duration === Number(r.duration_months) &&
          signedPrimaryMatchesApprovedTerms(r, amount, duration)
        : amount === String(r.requested_amount) && duration === requestedDuration;
      const nextStage: Stage = sameTerms
        ? needsGuarantor ? "guarantor_documents_upload" : "collateral_upload"
        : "approved_contract_pending_signature";
      const generationId = Number(primary.contract_generation_id);
      const ts = now(), actor = user(res);
      runTransaction(() => {
        const changed = executeChanges(`UPDATE loan_applications
          SET approved_amount=?,duration_months=?,net_amount=?,approved_amount_source='initial_provider_approval',
              approved_amount_generation_id=?,approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,
              initial_approval_at=?,initial_approval_by_user_id=?,initial_approval_reason=?,stage=?,status=?,
              current_primary_generation_id=?,initial_contract_retained=?,legacy_reopen_prior_stage=NULL,funder_decision=NULL,funder_reason=NULL,
              expert_reviewed_at=NULL,admin_approved_at=NULL,updated_at=?
          WHERE id=? AND stage='funder_initial_approval' AND status<>'rejected'
            AND (initial_approval_at IS NULL OR (?=1 AND initial_approval_at=? AND updated_at=?
              AND current_primary_generation_id=? AND admin_approved_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM wallet_ledger_v2 WHERE application_id=loan_applications.id)))`,
        [amount, duration, net, sameTerms ? generationId : null, sameTerms ? ts : null,
          sameTerms ? actor.id : null, ts, actor.id, reason || null, nextStage, workflowStatus(nextStage),
          sameTerms ? generationId : null, sameTerms ? 1 : 0, ts, r.id,
          reapproval ? 1 : 0, r.initial_approval_at ?? null, r.updated_at ?? null, r.current_primary_generation_id ?? null]);
        if (changed !== 1) throw new Error("initial_funder_decision_already_recorded");
        if (!sameTerms) {
          executeChanges("UPDATE contract_generations SET superseded_at=COALESCE(superseded_at,?),updated_at=? WHERE id=? AND superseded_at IS NULL",
            [ts, ts, generationId]);
        }
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
          [r.id, "funder_initial_approval", nextStage, "funder-initial-approve",
            JSON.stringify({ approvedAmount: amount, requestedAmount: r.requested_amount, requestedDurationMonths: requestedDuration,
              approvedDurationMonths: duration, netAmount: net, retainedPrimaryGenerationId: sameTerms ? generationId : null,
              supersededPrimaryGenerationId: sameTerms ? null : generationId, reason: reason || null,
              ...(reapproval ? { reapproval: true, previousDecision: {
                approvedAmount: r.approved_amount, durationMonths: r.duration_months,
                approvedAt: r.initial_approval_at, approvedByUserId: r.initial_approval_by_user_id,
                reason: r.initial_approval_reason,
              } } : {}) }), actor.id, ts]);
      });
      return res.json(shape(scoped(r.id, actor), actor));
    }
    const priorStage = String(r.legacy_reopen_prior_stage ?? "");
    const formerPrimary = priorStage ? latestPrimaryDocument(r.id) : null;
    const matchesFormer = Boolean(duration === requestedDuration &&
      formerPrimary && verifiedPrimaryPrincipal(r, formerPrimary, amount, duration));
    const formerPrimarySigned = formerPrimary?.status === "signed" && String(formerPrimary.link ?? "").startsWith("signed:");
    const signedReuse = matchesFormer && formerPrimarySigned;
    const pendingReuse = matchesFormer && !formerPrimarySigned && !String(formerPrimary.link ?? "").startsWith("signed:");
    let nextStage: Stage = "draft";
    let reusedGenerationId: number | null = null;
    if (signedReuse || pendingReuse) {
      const stageIndex = stages.indexOf(priorStage as Stage);
      const expertIndex = stages.indexOf("expert_approval");
      nextStage = pendingReuse ? "primary_contract_pending_signature"
        : ["draft", "primary_contract_pending_signature"].includes(priorStage) ? "customer_documents_upload"
        : priorStage === "guarantor_registration" ? "guarantor_documents_upload"
        : stageIndex > expertIndex ? "expert_approval" : priorStage as Stage;
      reusedGenerationId = Number(formerPrimary.contract_generation_id);
    }
    const ts = now(), actor = user(res);
    runTransaction(() => {
      const changed = executeChanges(`UPDATE loan_applications
        SET approved_amount=?,duration_months=?,net_amount=?,approved_amount_source='initial_provider_approval',
            approved_amount_generation_id=NULL,approved_amount_reconciled_at=NULL,approved_amount_reconciled_by_user_id=NULL,
            initial_approval_at=?,initial_approval_by_user_id=?,
            initial_approval_reason=?,stage=?,status=?,current_primary_generation_id=?,legacy_reopen_prior_stage=NULL,
            funder_decision=NULL,funder_reason=NULL,expert_reviewed_at=NULL,admin_approved_at=NULL,updated_at=?
        WHERE id=? AND stage='funder_initial_approval' AND status<>'rejected' AND initial_approval_at IS NULL`,
      [amount, duration, net, ts, actor.id, reason || null, nextStage, workflowStatus(nextStage), reusedGenerationId, ts, r.id]);
      if (changed !== 1) throw new Error("initial_funder_decision_already_recorded");
      if (!reusedGenerationId) {
        executeChanges(`UPDATE contract_generations SET superseded_at=COALESCE(superseded_at,?),updated_at=?
          WHERE loan_application_id=? AND superseded_at IS NULL AND deleted_at IS NULL`, [ts, ts, r.id]);
      }
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [r.id, "funder_initial_approval", nextStage, "funder-initial-approve",
          JSON.stringify({ approvedAmount: amount, requestedDurationMonths: requestedDuration, approvedDurationMonths: duration, netAmount: net,
            reusedPrimaryGenerationId: reusedGenerationId, reason: reason || null }), actor.id, ts]);
    });
    return res.json(shape(scoped(r.id, actor), actor));
  } catch (e) {
    const code = e instanceof Error ? e.message : "workflow_error";
    return error(res, code === "invalid_deduction_percent" ? 409 : 409, code);
  }
});
router.post("/loan-applications/:id/funder-initial-reject", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "funder_initial_approval" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!reason || reason.length > 1000 || Object.keys(req.body ?? {}).some((key) => key !== "reason")) return error(res, 400, "review_reason_required");
  const ts = now(), actor = user(res);
  try {
    returnRejectedLoanCase(r, actor, reason, "funder-initial-reject",
      { queryRow, executeChanges, execute, transaction: runTransaction, now });
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "initial_funder_decision_already_recorded"); }
  return res.json(shape(scoped(r.id, actor), actor));
});
router.post("/loan-applications/:id/expert-approve", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  const actor = user(res);
  if (Object.keys(req.body ?? {}).length) return error(res, 400, "final_funder_approval_has_no_term_inputs");
  if (r.stage !== "expert_approval" || !canAct(r.stage, actor, r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  try {
    const replacementRequired = Boolean(latestTomanReplacementConsent(Number(r.id))) ||
      String(applicationPrimaryDocument(r)?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE;
    if (replacementRequired) {
      if (!verifiedTomanReplacementPrimary(r)) throw new Error("toman_replacement_terms_unverifiable");
    } else if (r.initial_approval_at) {
      if (!r.approved_amount || !signedPrimaryMatchesApprovedTerms(r, String(r.approved_amount),
          Number(r.duration_months))) throw new Error("current_primary_terms_not_verified");
    }
    const ts = now(), to: Stage = "funder_result_review";
    runTransaction(() => {
      const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [r.id]);
      if (!current || current.stage !== "expert_approval" || current.status === "rejected") throw new Error("invalid_stage_transition");
      if (!canAct(current.stage, actor, r.customer_id, current.status)) throw new Error("action_forbidden");
      const currentPrimary = applicationPrimaryDocument(current);
      const currentReplacementRequired = Boolean(latestTomanReplacementConsent(Number(current.id))) ||
        String(currentPrimary?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE;
      if (currentReplacementRequired) {
        if (!verifiedTomanReplacementPrimary(current)) throw new Error("toman_replacement_terms_unverifiable");
        const reconciledAt = now();
        const changed = executeChanges(`UPDATE loan_applications SET approved_amount_generation_id=?,
          approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,updated_at=?
          WHERE id=? AND stage='expert_approval' AND status<>'rejected' AND current_primary_generation_id=?`,
        [currentPrimary.id, reconciledAt, actor.id, reconciledAt, current.id, currentPrimary.id]);
        if (changed !== 1) throw new Error("approved_financial_terms_reconciliation_conflict");
      } else if (current.initial_approval_at) {
        if (!current.approved_amount ||
            !signedPrimaryMatchesApprovedTerms(current, String(current.approved_amount),
              Number(current.duration_months))) throw new Error("current_primary_terms_not_verified");
        const primary = currentPrimaryDocument(current);
        const generationId = Number(primary?.contract_generation_id);
        if (!generationId || !isApplicationPrimaryGeneration(current, generationId) ||
            !signatureGenerationIdentityEligible(current, primary, "primary"))
          throw new Error("current_primary_terms_not_verified");
        const reconciledAt = now();
        const changed = executeChanges(`UPDATE loan_applications SET approved_amount_generation_id=?,
          approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,updated_at=?
          WHERE id=? AND stage='expert_approval' AND status<>'rejected' AND funder_decision IS NULL
            AND current_primary_generation_id=?`,
        [generationId, reconciledAt, actor.id, reconciledAt, r.id, generationId]);
        if (changed !== 1) throw new Error("approved_financial_terms_reconciliation_conflict");
      } else {
        const reconciled = legacySignedPrimaryTerms(current);
        const reconciledAt = now();
        const changed = executeChanges(`UPDATE loan_applications SET approved_amount=?,net_amount=?,approved_amount_source='signed_primary_reconciliation',
          approved_amount_generation_id=?,approved_amount_reconciled_at=?,approved_amount_reconciled_by_user_id=?,updated_at=?
          WHERE id=? AND initial_approval_at IS NULL AND stage='expert_approval' AND status<>'rejected'`,
        [reconciled.amount, reconciled.netAmount, reconciled.generationId, reconciledAt, actor.id, reconciledAt, r.id]);
        if (changed !== 1) throw new Error("approved_financial_terms_reconciliation_conflict");
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
          [r.id, current.stage, current.stage, "legacy-signed-primary-terms-reconciled",
            JSON.stringify({ generationId: reconciled.generationId, approvedAmount: reconciled.amount, netAmount: reconciled.netAmount }), actor.id, reconciledAt]);
      }
      const updated = executeChanges(`UPDATE loan_applications
        SET funder_decision='approved',funder_reason=NULL,expert_reviewed_at=?,stage=?,status='reviewing',updated_at=?
        WHERE id=? AND stage='expert_approval' AND status<>'rejected' AND funder_decision IS NULL`,
      [ts, to, ts, r.id]);
      if (updated !== 1) throw new Error("invalid_stage_transition");
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [r.id, "expert_approval", to, "expert-approve", null, actor.id, ts]);
    });
    res.json(shape(scoped(r.id, actor), actor));
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
});
action("complete", "loan_applications.update", "completed");
function workflowEndpoint(name: string, permission: "loan_applications.review" | "loan_applications.update" | "loan_applications.approve", from: Stage, to: Stage) {
  router.post(`/loan-applications/:id/${name}`, requirePermission(permission), (req, res) => {
    const r = scoped(Number(req.params.id), user(res));
    if (!r) return error(res, 404, "loan_application_not_found");
    if (r.stage !== from) return error(res, 409, "invalid_stage_transition");
    try { transition(r.id, to, name, user(res), String(req.body?.reason ?? "").trim()); res.json(shape(scoped(r.id, user(res)), user(res))); }
    catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
  });
}
workflowEndpoint("confirm-funder", "loan_applications.review", "funder_result_review", "physical_documents_submission");
workflowEndpoint("resubmit-funder-documents", "loan_applications.update", "funder_documents_correction", "expert_approval");
workflowEndpoint("resubmit-physical-documents", "loan_applications.update", "physical_documents_correction", "physical_documents_review");
workflowEndpoint("approve-physical-documents", "loan_applications.review", "physical_documents_review", "wallet_charge_pending");
workflowEndpoint("approve-wallet-charge", "loan_applications.review", "wallet_charge_pending", "admin_approval");
router.post("/loan-applications/:id/physical-documents", requirePermission("loan_applications.update"), upload.single("file"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_submission" || !canAct(r.stage, user(res), r.customer_id, r.status))
    return error(res, 403, "action_forbidden");
  if (!req.file || !fileType(req.file)) return error(res, 400, "invalid_physical_document");
  const target = storeFile(r.id, req.file);
  try {
    const id = runTransaction(() => {
      const documentId = execute("INSERT INTO loan_physical_documents(application_id,original_name,storage_path,mime_type,size_bytes,uploaded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [r.id, normalizedUploadName(req.file!.originalname), target, req.file!.mimetype, req.file!.size, user(res).id, now()]);
      recordReview(r.id, r.stage, `physical_document_uploaded:${documentId}`, null, user(res).id);
      return documentId;
    });
    res.status(201).json({ id, originalName: normalizedUploadName(req.file.originalname), mimeType: req.file.mimetype, sizeBytes: req.file.size, fileAvailable: true });
  } catch (e) {
    try { fs.unlinkSync(target); } catch { /* file cleanup is best effort */ }
    req.log.error({ err: e }, "physical document upload failed");
    return error(res, 500, "physical_document_upload_failed");
  }
});
router.get("/loan-applications/:id/physical-documents/:documentId/download", requirePermission("loan_applications.view"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  const document = queryRow<any>("SELECT * FROM loan_physical_documents WHERE application_id=? AND id=?", [r.id, Number(req.params.documentId)]);
  if (!document) return error(res, 404, "physical_document_not_found");
  let real: string;
  try { real = fs.realpathSync(document.storage_path); } catch { return error(res, 404, "physical_document_not_found"); }
  if (!real.startsWith(uploadRootReal + path.sep) || !fs.statSync(real).isFile())
    return error(res, 404, "physical_document_not_found");
  if (req.query.preview === "1") {
    res.type(document.mime_type);
    res.setHeader("Content-Disposition", "inline");
    return res.sendFile(real);
  }
  return res.download(real, document.original_name);
});
router.delete("/loan-applications/:id/physical-documents/:documentId", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_submission" || !canAct(r.stage, user(res), r.customer_id, r.status))
    return error(res, 403, "action_forbidden");
  const document = queryRow<any>("SELECT * FROM loan_physical_documents WHERE application_id=? AND id=?", [r.id, Number(req.params.documentId)]);
  if (!document) return error(res, 404, "physical_document_not_found");
  runTransaction(() => {
    executeChanges("DELETE FROM loan_physical_documents WHERE id=? AND application_id=?", [document.id, r.id]);
    recordReview(r.id, r.stage, `physical_document_removed:${document.id}`, null, user(res).id);
  });
  try { fs.unlinkSync(document.storage_path); } catch { /* cleanup is best effort */ }
  res.status(204).end();
});
router.post("/loan-applications/:id/submit-physical-documents", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_submission" || !canAct(r.stage, user(res), r.customer_id, r.status))
    return error(res, 403, "action_forbidden");
  if (typeof req.body?.noPhysicalDocuments !== "boolean") return error(res, 400, "physical_document_choice_required");
  try {
    if (req.body.noPhysicalDocuments) {
      runTransaction(() => {
        const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND stage='physical_documents_submission' AND status<>'rejected' AND deleted_at IS NULL", [r.id]);
        if (!current) throw new Error("invalid_stage_transition");
        if (queryRow("SELECT 1 FROM loan_physical_documents WHERE application_id=?", [r.id]) ||
            queryRow("SELECT 1 FROM loan_physical_checks WHERE application_id=?", [r.id]) ||
            queryRow("SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action='submit-physical-documents'", [r.id]))
          throw new Error("physical_documents_already_uploaded");
        verifyPhysicalApprovalTerms(current);
        const ts = now();
        executeChanges("UPDATE loan_applications SET stage='wallet_charge_pending',status='reviewing',updated_at=? WHERE id=?", [ts, r.id]);
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
          [r.id, "physical_documents_submission", "physical_documents_review", "physical-documents-none-declared", user(res).id, ts]);
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
          [r.id, "physical_documents_review", "wallet_charge_pending", "physical-review-auto-approved-no-documents", user(res).id, ts]);
      });
    } else {
      transition(r.id, "physical_documents_review", "submit-physical-documents", user(res));
    }
    res.json(shape(scoped(r.id, user(res)), user(res)));
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
});
router.post("/loan-applications/:id/prepare-physical-checks", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  if (user(res).role !== "registrar") return error(res, 403, "action_forbidden");
  if (r.stage !== "physical_documents_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 409, "physical_review_stage_required");
  try {
    runTransaction(() => preparePhysicalChecks(r.id,
      Boolean(queryRow("SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action='submit-physical-documents'", [r.id]))));
    return res.json({ ok: true, physicalChecks: queryRows<any>("SELECT * FROM loan_physical_checks WHERE application_id=? ORDER BY id", [r.id]) });
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "physical_documents_missing"); }
});
router.post("/loan-applications/:id/admin-approve", requirePermission("loan_applications.approve"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  if (!r) return error(res, 404, "loan_application_not_found");
  if (user(res).role !== "admin") return error(res, 403, "action_forbidden");
  if (r.stage === "completed" && queryRow("SELECT 1 FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?", [r.id, `loan-application:${r.id}:credit`])) {
    return res.json(shape(scoped(r.id, user(res)), user(res)));
  }
  if (loanCaseFinancialTermsLocked(r) && !queryRow("SELECT 1 FROM wallet_ledger_v2 WHERE application_id=? AND idempotency_key=?", [r.id, `loan-application:${r.id}:credit`]))
    return error(res, 409, "financial_posting_history_unverified");
  if (r.stage !== "admin_approval") return error(res, 409, "invalid_stage_transition");
  try {
    transition(r.id, "completed", "admin-approve", user(res), String(req.body?.reason ?? "").trim(),
      () => executeChanges("UPDATE loan_applications SET admin_approved_at=? WHERE id=?", [now(), r.id]));
    res.json(shape(scoped(r.id, user(res)), user(res)));
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
});
router.post("/loan-applications/:id/return-funder-documents", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)), defects = req.body?.defects;
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "funder_result_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (r.funder_decision !== "rejected" || !Array.isArray(defects) || !defects.length) return error(res, 400, "funder_defects_required");
  const valid = defects.every((d: any) => {
    if (!["document", "collateral", "guarantor"].includes(d.source) || !Number.isSafeInteger(d.id) || d.id <= 0 || !String(d.reason ?? "").trim()) return false;
    if (d.source === "document") return Boolean(queryRow("SELECT 1 FROM loan_application_documents WHERE id=? AND application_id=?", [d.id, r.id]));
    if (d.source === "collateral") return Boolean(queryRow("SELECT 1 FROM loan_application_collateral WHERE id=? AND application_id=?", [d.id, r.id]));
    return Boolean(queryRow("SELECT 1 FROM loan_application_guarantor_documents d JOIN loan_application_guarantors g ON g.id=d.guarantor_id WHERE d.id=? AND g.application_id=?", [d.id, r.id]));
  });
  if (!valid) return error(res, 400, "invalid_funder_defects");
  runTransaction(() => {
    for (const d of defects) execute("INSERT INTO loan_funder_defects(application_id,source,source_id,reason,resolved_at) VALUES(?,?,?,?,NULL) ON CONFLICT(application_id,source,source_id) DO UPDATE SET reason=excluded.reason,resolved_at=NULL", [r.id, d.source, d.id, String(d.reason).trim()]);
    executeChanges("UPDATE loan_applications SET stage='funder_documents_correction',status='reviewing',updated_at=? WHERE id=?", [now(), r.id]);
    recordReview(r.id, "funder_result_review", "return-funder-documents", String(req.body?.reason ?? r.funder_reason).trim(), user(res).id);
  });
  res.json(shape(scoped(r.id, user(res)), user(res)));
});
router.post("/loan-applications/:id/physical-checks/general/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)), reason = String(req.body?.reason ?? "").trim();
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!reason) return error(res, 400, "review_reason_required");
  if (!queryRow("SELECT 1 FROM loan_physical_checks WHERE application_id=? AND source IN ('document','collateral','physical_upload')", [r.id])) return error(res, 409, "physical_documents_missing");
  const id = runTransaction(() => {
    execute(`INSERT INTO loan_physical_checks(application_id,source,source_id,label,status,reason)
      VALUES(?,'general',0,'نقص عمومی مدارک فیزیکی','incomplete',?)
      ON CONFLICT(application_id,source,source_id) DO UPDATE SET status='incomplete',reason=excluded.reason`, [r.id, reason]);
    const checkId = queryRow<{ id: number }>("SELECT id FROM loan_physical_checks WHERE application_id=? AND source='general' AND source_id=0", [r.id]);
    recordReview(r.id, r.stage, "physical_general_incomplete", reason, user(res).id);
    return Number(checkId?.id);
  });
  res.json({ ok: true, id, status: "incomplete", reason });
});
router.post("/loan-applications/:id/physical-checks/:checkId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)), decision = String(req.body?.decision ?? ""), reason = String(req.body?.reason ?? "").trim();
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!["approved", "incomplete"].includes(decision) || (decision === "incomplete" && !reason)) return error(res, 400, "invalid_physical_review");
  const updated = executeChanges("UPDATE loan_physical_checks SET status=?,reason=? WHERE id=? AND application_id=?", [decision, decision === "approved" ? null : reason, Number(req.params.checkId), r.id]);
  if (!updated) return error(res, 404, "physical_check_not_found");
  recordReview(r.id, r.stage, `physical_${decision}:${req.params.checkId}`, reason || null, user(res).id);
  res.json({ ok: true });
});
router.post("/loan-applications/:id/return-physical-documents", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)), reason = String(req.body?.reason ?? "").trim();
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_review" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!reason) return error(res, 400, "physical_defects_required");
  if (!queryRow("SELECT 1 FROM loan_physical_checks WHERE application_id=? AND status IN ('incomplete','rejected')", [r.id])) return error(res, 409, "physical_defect_required");
  const uploadedHere = Boolean(queryRow("SELECT 1 FROM loan_application_stage_history WHERE application_id=? AND action='submit-physical-documents'", [r.id]));
  const correctionStage = uploadedHere ? "physical_documents_submission" : "physical_documents_correction";
  runTransaction(() => {
    executeChanges("UPDATE loan_applications SET stage=?,updated_at=? WHERE id=?", [correctionStage, now(), r.id]);
    if (uploadedHere) executeChanges("DELETE FROM loan_physical_checks WHERE application_id=?", [r.id]);
    execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)", [r.id, r.stage, correctionStage, "return-physical-documents", reason, user(res).id, now()]);
  });
  res.json(shape(scoped(r.id, user(res)), user(res)));
});
router.post("/loan-applications/:id/physical-checks/:checkId/correct", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)), note = String(req.body?.note ?? "").trim();
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "physical_documents_correction" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!note) return error(res, 400, "correction_note_required");
  const changed = executeChanges("UPDATE loan_physical_checks SET status='pending',reason=NULL WHERE application_id=? AND id=? AND status='incomplete'", [r.id, Number(req.params.checkId)]);
  if (!changed) return error(res, 409, "physical_check_not_incomplete");
  recordReview(r.id, r.stage, `physical_corrected:${req.params.checkId}`, note, user(res).id);
  res.json({ ok: true });
});
router.post("/loan-applications/:id/review-customer-documents", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  const condition = parseJson(r.condition_snapshot_json);
  const to: Stage = condition?.needs_guarantor || condition?.needsGuarantor
    ? "guarantor_registration" : r.new_case_workflow || r.legacy_reopen_prior_stage ? "funder_initial_approval" : "collateral_upload";
  try { transition(r.id, to, "review-customer-documents", user(res), req.body?.reason); res.json(shape(scoped(r.id, user(res)), user(res))); }
  catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
});
function returnForCorrection(pathSuffix: string, from: Stage, to: Stage) {
  router.post(`/loan-applications/:id/${pathSuffix}`, requirePermission("loan_applications.review"), (req, res) => {
    const r = scoped(Number(req.params.id), user(res)); const reason = String(req.body?.reason || "").trim();
    if (!r) return error(res, 404, "loan_application_not_found");
    if (!reason) return error(res, 400, "review_reason_required");
    if (r.stage !== from || !canAct(from, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
    if (!registrarReviewState(r).hasDefect) return error(res, 409, "review_not_complete_or_no_defect");
    runTransaction(() => {
      executeChanges("UPDATE loan_applications SET stage=?,status='reviewing',updated_at=? WHERE id=?", [to, now(), r.id]);
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)", [r.id, from, to, pathSuffix, reason, user(res).id, now()]);
    });
    res.json(shape(scoped(r.id, user(res)), user(res)));
  });
}
returnForCorrection("return-customer-documents", "customer_documents_review", "customer_documents_upload");
returnForCorrection("return-guarantor-documents", "guarantor_documents_review", "guarantor_documents_upload");
returnForCorrection("return-collateral", "collateral_review", "collateral_upload");
registerLoanCaseCancellation(router, scoped, shape, user);
for (const [name, permission, requiredStage] of [
  ["admin-reject", "loan_applications.approve", "admin_approval"],
] as const) {
  router.post(`/loan-applications/:id/${name}`, requirePermission(permission), (req, res) => {
    const r = scoped(Number(req.params.id), user(res)); const reason = String(req.body?.reason || "").trim();
    if (!r) return error(res, 404, "loan_application_not_found"); if (!reason) return error(res, 400, "review_reason_required");
    if (r.stage !== requiredStage || !canAct(requiredStage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
    try {
      returnRejectedLoanCase(r, user(res), reason, name,
        { queryRow, executeChanges, execute, transaction: runTransaction, now });
    } catch (e) { return error(res, 409, e instanceof Error ? e.message : "workflow_error"); }
    return res.json(shape(scoped(r.id, user(res)), user(res)));
  });
}
router.post("/loan-applications/:id/expert-reject", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!r) return error(res, 404, "loan_application_not_found");
  if (r.stage !== "expert_approval" || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  if (!reason || reason.length > 1000 || Object.keys(req.body ?? {}).some((key) => key !== "reason")) return error(res, 400, "review_reason_required");
  const ts = now(), actor = user(res);
  try {
    returnRejectedLoanCase(r, actor, reason, "expert-reject",
      { queryRow, executeChanges, execute, transaction: runTransaction, now });
  } catch (e) { return error(res, 409, e instanceof Error ? e.message : "final_funder_decision_already_recorded"); }
  return res.json(shape(scoped(r.id, actor), actor));
});

router.post("/loan-applications/:id/generated-documents", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); const kind = String(req.body?.kind || "");
  if (!r || !["primary", "invoice", "acknowledgement", "amendment"].includes(kind) ||
      !Number(req.body?.contractGenerationId)) return error(res, 400, "invalid_generated_document");
  if (!["admin", "salesperson"].includes(user(res).role)) return error(res, 403, "action_forbidden");
  const preapprovedPrimary = kind === "primary" && r.initial_approval_at != null;
  const newCasePrimary = kind === "primary" && (Number(r.new_case_workflow) === 1 ||
    (r.legacy_reopen_prior_stage != null && !preapprovedPrimary));
  const primaryExpectedAmount = preapprovedPrimary ? String(r.approved_amount ?? "") : String(r.requested_amount ?? "");
  const g = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [Number(req.body.contractGenerationId)]);
  const tomanConsent = kind === "primary" ? latestTomanReplacementConsent(Number(r.id))?.consent ?? null : null;
  const currentPrimaryId = applicationPrimaryGenerationId(r);
  const tomanReplacementPrimary = Boolean(tomanConsent &&
    String(g?.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE &&
    r.stage === "approved_contract_pending_signature" &&
    (currentPrimaryId === tomanConsent.sourceGenerationId || currentPrimaryId === Number(g?.id)) &&
    tomanReplacementGenerationMatches(r, g, tomanConsent) &&
    g.provider_contract_id && ["sent", "signed"].includes(String(g.status)) &&
    (g.status !== "signed" || isStrictSignedProviderState(g.provider_status)));
  const allowedStages = kind === "primary" && tomanReplacementPrimary
    ? ["approved_contract_pending_signature"]
    : kind === "primary" ? (newCasePrimary
      ? (preapprovedPrimary ? ["approved_contract_pending_signature"] : ["draft"])
      : (preapprovedPrimary ? ["draft"] : ["draft", "customer_documents_upload"])) : kind === "amendment"
      ? ["funder_amendment_pending_signature"] : ["final_invoice_pending_signature"];
  if (!g || g.deleted_at || g.superseded_at || g.customer_id !== r.customer_id || !g.provider_contract_id ||
      !["sent", "signed"].includes(String(g.status)) ||
      (kind === "amendment" ? Number(g.loan_application_id) !== r.id ||
          (Number(r.new_case_workflow) === 1 && String(g.generation_purpose) !== "amendment")
        : kind === "primary" && tomanReplacementPrimary ? false
          : kind === "primary" && preapprovedPrimary ? !boundPrimaryMatchesApplication(g, r)
            : kind === "primary" && newCasePrimary ? !boundPrimaryMatchesApplication(g, r, primaryExpectedAmount)
              : g.loan_application_id != null))
    return error(res, 409, "contract_generation_not_linkable");
  if (kind === "amendment") {
    const existing = queryRow<any>("SELECT id,application_id,kind,contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND kind='amendment' AND COALESCE(status,'')<>'rejected' ORDER BY id DESC LIMIT 1", [r.id]);
    if (existing) return Number(existing.contract_generation_id) === Number(g.id)
      ? res.json({ id: existing.id, applicationId: r.id, kind, contractGenerationId: g.id })
      : error(res, 409, "amendment_generation_already_linked");
  }
  if (tomanReplacementPrimary && currentPrimaryId === Number(g.id)) {
    const linked = queryRow<any>("SELECT id FROM loan_application_generated_documents WHERE application_id=? AND kind='primary' AND contract_generation_id=?", [r.id, g.id]);
    if (linked) return res.json({ id: linked.id, applicationId: r.id, kind, contractGenerationId: g.id });
  }
  if (!allowedStages.includes(r.stage)) return error(res, 409, "generated_document_link_stage_required");
  if (kind === "primary" && !tomanReplacementPrimary &&
      (preapprovedPrimary || (newCasePrimary && r.current_primary_generation_id != null))) {
    const existing = r.current_primary_generation_id == null ? null
      : queryRow<any>("SELECT id,contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND kind='primary' AND contract_generation_id=?", [r.id, r.current_primary_generation_id]);
    if (existing) return Number(existing.contract_generation_id) === Number(g.id)
      ? res.json({ id: existing.id, applicationId: r.id, kind, contractGenerationId: g.id })
      : error(res, 409, "primary_generation_already_linked");
  }
  let id: number;
  try {
    id = runImmediateTransaction(() => {
      if (tomanReplacementPrimary) {
        const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [r.id]);
        const currentConsent = latestTomanReplacementConsent(r.id)?.consent;
        if (!current || current.stage !== "approved_contract_pending_signature" ||
            (applicationPrimaryGenerationId(current) !== tomanConsent!.sourceGenerationId &&
              applicationPrimaryGenerationId(current) !== Number(g.id)) ||
            currentConsent?.sourceGenerationId !== tomanConsent!.sourceGenerationId ||
            currentConsent?.tomanTemplateId !== tomanConsent!.tomanTemplateId ||
            !tomanReplacementGenerationMatches(current, g, currentConsent!))
          throw new Error("toman_replacement_terms_stale");
        if (applicationPrimaryGenerationId(current) === Number(g.id)) {
          const linked = queryRow<any>("SELECT id FROM loan_application_generated_documents WHERE application_id=? AND kind='primary' AND contract_generation_id=?", [r.id, g.id]);
          if (linked) return Number(linked.id);
        }
        const superseded = executeChanges(`UPDATE contract_generations SET superseded_at=?,updated_at=?
          WHERE id=? AND status='signed' AND superseded_at IS NULL AND deleted_at IS NULL`,
        [now(), now(), tomanConsent!.sourceGenerationId]);
        if (superseded !== 1) throw new Error("toman_replacement_source_not_current");
      }
      const documentId = execute("INSERT INTO loan_application_generated_documents(application_id,kind,contract_generation_id,created_at) VALUES(?,?,?,?)", [r.id, kind, g.id, now()]);
      if (kind === "primary") {
        const changed = executeChanges("UPDATE loan_applications SET current_primary_generation_id=?,updated_at=? WHERE id=? AND stage=? AND status<>'rejected'",
          [g.id, now(), r.id, r.stage]);
        if (changed !== 1) throw new Error("generated_document_link_stage_required");
      }
      if (tomanReplacementPrimary) {
        execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
          [r.id, r.stage, r.stage, `generated_document_linked:primary:${documentId}`, user(res).id, now()]);
      }
      return documentId;
    });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "generated_document_link_failed";
    return error(res, 409, code);
  }
  if (!tomanReplacementPrimary) recordReview(r.id, r.stage, `generated_document_linked:${kind}:${id}`, null, user(res).id);
  res.status(201).json({ id, applicationId: r.id, kind, contractGenerationId: g.id });
});
export function applyGeneratedDocumentSignatureObservation(
  documentId: number,
  providerBody: unknown,
  options: { allowDraftStageConfirmation?: boolean } = {},
) {
  const state = providerContractState(providerBody);
  if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed:missing_state");
  const providerStatus = state.status ?? state.title ?? (state.signed ? "signed" : null);
  return runImmediateTransaction(() => {
    const d = queryRow<any>(`SELECT d.id document_id,d.application_id,d.kind,d.contract_generation_id,d.link,
        d.status document_status,g.status generation_status,g.provider_contract_id,
        g.customer_id generation_customer_id,g.loan_plan_id generation_plan_id,g.generation_purpose,
        g.loan_application_id generation_application_id,
        g.superseded_at generation_superseded_at,g.deleted_at generation_deleted_at,
        a.requested_by_customer_id signer_customer_id,
        a.id case_id,a.customer_id case_customer_id,a.plan_id case_plan_id,a.plan_ids case_plan_ids,
        a.stage,a.status application_status,a.deleted_at application_deleted_at,
        a.current_primary_generation_id,a.initial_approval_at,a.legacy_reopen_prior_stage,
      a.new_case_workflow,a.condition_snapshot_json
      FROM loan_application_generated_documents d
      JOIN contract_generations g ON g.id=d.contract_generation_id
      JOIN loan_applications a ON a.id=d.application_id
      WHERE d.id=?`, [documentId]);
    if (!d?.provider_contract_id) throw new Error("generated_document_not_found");
    const replacementConsent = d.kind === "primary"
      ? latestTomanReplacementConsent(Number(d.case_id))?.consent : null;
    const replacementSource = Boolean(replacementConsent &&
      (String(d.generation_purpose ?? "") !== TOMAN_REPLACEMENT_PURPOSE ||
        Number(d.contract_generation_id) === replacementConsent.sourceGenerationId));
    if (String(d.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE) {
      const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [d.case_id]);
      const generation = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [d.contract_generation_id]);
      if (current && Number(current.current_primary_generation_id) !== Number(d.contract_generation_id))
        throw new Error("primary_contract_not_current");
      if (!replacementConsent || !current ||
          !tomanReplacementSignatureIdentityMatches(current, generation, replacementConsent))
        throw new Error("toman_replacement_terms_unverifiable");
    }
    const ts = now();
    executeChanges(
      "UPDATE contract_generations SET provider_status=?,status=CASE WHEN ? THEN 'signed' ELSE status END,updated_at=? WHERE id=?",
      [providerStatus, state.signed ? 1 : 0, ts, d.contract_generation_id],
    );
    let workflowAdvanced = false;
    let nextStage: Stage | null = null;
    const signedLink = `signed:${d.provider_contract_id}`;
    const linkCompatible = !String(d.link ?? "").startsWith("signed:") || d.link === signedLink;
    const active = !d.application_deleted_at && d.application_status !== "rejected" &&
      !d.generation_deleted_at && !d.generation_superseded_at && d.document_status !== "rejected" &&
      ["sent", "signed"].includes(String(d.generation_status));
    const setSignedLink = () => executeChanges(
      "UPDATE loan_application_generated_documents SET link=? WHERE id=? AND (link IS NULL OR link NOT LIKE 'signed:%')",
      [signedLink, d.document_id],
    );
    if (state.signed && active && linkCompatible && !replacementSource) {
      const applicationIdentity = {
        id: Number(d.case_id),
        customer_id: Number(d.case_customer_id),
        plan_id: d.case_plan_id == null ? null : Number(d.case_plan_id),
        plan_ids: d.case_plan_ids,
        stage: d.stage,
        current_primary_generation_id: d.current_primary_generation_id,
        initial_approval_at: d.initial_approval_at,
        legacy_reopen_prior_stage: d.legacy_reopen_prior_stage,
        new_case_workflow: d.new_case_workflow,
      };
      const generationIdentity = {
        kind: d.kind,
        customer_id: d.generation_customer_id,
        loan_plan_id: d.generation_plan_id,
        generation_purpose: d.generation_purpose,
        loan_application_id: d.generation_application_id,
        generation_status: d.generation_status,
        document_status: d.document_status,
        generation_deleted_at: d.generation_deleted_at,
        generation_superseded_at: d.generation_superseded_at,
        contract_generation_id: d.contract_generation_id,
      };
      if (d.kind === "primary" && String(d.generation_purpose ?? "") === TOMAN_REPLACEMENT_PURPOSE &&
          d.stage === "approved_contract_pending_signature") {
        const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [d.case_id]);
        const currentPrimary = current && applicationPrimaryDocument(current);
        const consent = latestTomanReplacementConsent(Number(d.case_id))?.consent;
        if (!current || !consent || current.stage !== "approved_contract_pending_signature" ||
            Number(current.current_primary_generation_id) !== Number(d.contract_generation_id) ||
            Number(currentPrimary?.id) !== Number(d.contract_generation_id) ||
            currentPrimary.status !== "signed" || !isStrictSignedProviderState(currentPrimary.provider_status) ||
            !tomanReplacementSignatureIdentityMatches(current, currentPrimary, consent))
          throw new Error("toman_replacement_terms_unverifiable");
        setSignedLink();
        const completedAt = now();
        const changed = executeChanges(`UPDATE loan_applications SET stage=?,status=?,updated_at=?
          WHERE id=? AND stage='approved_contract_pending_signature' AND current_primary_generation_id=?
            AND status<>'rejected' AND deleted_at IS NULL`,
        [consent.resumeStage, consent.priorStatus, completedAt, d.case_id, d.contract_generation_id]);
        if (changed !== 1) throw new Error("toman_replacement_terms_stale");
        const event = {
          sourceGenerationId: consent.sourceGenerationId,
          replacementGenerationId: Number(d.contract_generation_id),
          tomanTemplateId: consent.tomanTemplateId,
          approvedAmount: consent.approvedAmount,
          durationMonths: consent.durationMonths,
          authorizedByUserId: consent.authorizedByUserId,
          authorizedAt: consent.authorizedAt,
          resumedStage: consent.resumeStage,
        };
        execute(
          "INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,actor_customer_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          [d.case_id, current.stage, consent.resumeStage, "toman-replacement-signature-verified",
            JSON.stringify(event), null, d.signer_customer_id ?? null, completedAt],
        );
        workflowAdvanced = true;
        nextStage = consent.resumeStage as Stage;
      } else if (d.kind === "primary" && primarySignatureIdentityEligible(applicationIdentity, generationIdentity) &&
          (["primary_contract_pending_signature", "approved_contract_pending_signature"].includes(d.stage) ||
            (options.allowDraftStageConfirmation && d.stage === "draft"))) {
        const condition = parseJson(d.condition_snapshot_json);
        const target: Stage = d.stage === "approved_contract_pending_signature"
          ? condition?.needs_guarantor || condition?.needsGuarantor ? "guarantor_documents_upload" : "collateral_upload"
          : "customer_documents_upload";
        const changed = executeChanges(`UPDATE loan_applications SET stage=?,status='reviewing',
          is_pre_registration=CASE WHEN ?='customer_documents_upload' THEN 0 ELSE is_pre_registration END,updated_at=?
          WHERE id=? AND stage=? AND status<>'rejected' AND deleted_at IS NULL
            AND current_primary_generation_id IS ?`,
        [target, target, ts, d.case_id, d.stage, d.current_primary_generation_id]);
        if (changed === 1) {
          setSignedLink();
          const action = d.stage === "draft" ? "existing_signed_primary_confirmed"
            : d.stage === "approved_contract_pending_signature" ? "approved-primary-signature-verified"
              : "primary_signature_verified";
          execute(
            "INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,actor_customer_id,created_at) VALUES(?,?,?,?,?,?,?)",
            [d.case_id, d.stage, target, action, null, d.signer_customer_id ?? null, ts],
          );
          workflowAdvanced = true;
          nextStage = target;
        }
      } else if (d.kind === "amendment" &&
          signatureGenerationIdentityEligible(applicationIdentity, generationIdentity, d.kind) &&
          d.stage === "funder_amendment_pending_signature" &&
          Number(queryRow<any>(`SELECT contract_generation_id FROM loan_application_generated_documents
            WHERE application_id=? AND kind='amendment' ORDER BY id DESC LIMIT 1`, [d.case_id])?.contract_generation_id) ===
            Number(d.contract_generation_id)) {
        const changed = executeChanges(`UPDATE loan_applications SET stage='funder_amendment_review',status='reviewing',updated_at=?
          WHERE id=? AND stage='funder_amendment_pending_signature' AND status<>'rejected' AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM loan_application_generated_documents latest
              WHERE latest.application_id=? AND latest.kind='amendment' AND latest.id=?
                AND latest.contract_generation_id=?)`,
        [ts, d.case_id, d.case_id, d.document_id, d.contract_generation_id]);
        if (changed === 1) {
          setSignedLink();
          execute(
            "INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,actor_customer_id,created_at) VALUES(?,?,?,?,?,?,?)",
            [d.case_id, "funder_amendment_pending_signature", "funder_amendment_review",
              "amendment_signature_verified", null, d.signer_customer_id ?? null, ts],
          );
          workflowAdvanced = true;
          nextStage = "funder_amendment_review";
        }
      } else if (["invoice", "acknowledgement"].includes(d.kind) &&
          signatureGenerationIdentityEligible(applicationIdentity, generationIdentity, d.kind) &&
          d.stage === "final_invoice_pending_signature" &&
          Number(queryRow<any>(`SELECT id FROM loan_application_generated_documents
            WHERE application_id=? AND kind=? ORDER BY id DESC LIMIT 1`, [d.case_id, d.kind])?.id) ===
            Number(d.document_id)) {
        setSignedLink();
      }
    }
    return {
      id: Number(d.document_id),
      signed: state.signed,
      kind: d.kind,
      providerStatus,
      workflowAdvanced,
      nextStage,
    };
  });
}

async function observeGeneratedDocumentSignature(
  d: any,
  fresh: boolean,
  options: { allowDraftStageConfirmation?: boolean } = {},
) {
  if (d.kind === "primary") {
    const consent = latestTomanReplacementConsent(Number(d.application_id))?.consent;
    const purpose = String(d.generation_purpose ?? "primary");
    if (purpose === TOMAN_REPLACEMENT_PURPOSE) {
      const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [d.application_id]);
      const generation = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [d.contract_generation_id]);
      if (current && Number(current.current_primary_generation_id) !== Number(d.contract_generation_id))
        throw new Error("primary_contract_not_current");
      if (!consent || !current ||
          !tomanReplacementSignatureIdentityMatches(current, generation, consent))
        throw new Error("toman_replacement_terms_unverifiable");
    }
  }
  // Manual checks force a provider read; only the guarded background caller may use a signed cache.
  let body: unknown;
  if (!fresh && providerContractState({ status: d.provider_status }).signed) {
    body = { status: d.provider_status };
  } else {
    const response = await emzameRequest(`contracts/${encodeURIComponent(String(d.provider_contract_id))}`);
    body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`provider_status_failed:${response.status}`);
  }
  const observed = providerContractState(body);
  if (!observed.status && !observed.title && !observed.signed)
    throw new Error("provider_status_failed:missing_state");
  try {
    return applyGeneratedDocumentSignatureObservation(Number(d.id), body, options);
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "";
    if (["generated_document_not_found", "primary_contract_not_current", "toman_replacement_signature_required",
      "toman_replacement_terms_unverifiable", "toman_replacement_terms_stale"].includes(code)) throw cause;
    throw new Error("signature_processing_failed", { cause });
  }
}

export async function refreshGeneratedDocumentSignature(applicationId: number, documentId: number) {
  const d = queryRow<any>(`SELECT d.*,g.provider_contract_id,g.provider_status,g.status generation_status,g.loan_application_id,
        g.generation_purpose,
        g.superseded_at,g.deleted_at generation_deleted_at,a.id case_id,a.stage,a.status application_status,
         a.current_primary_generation_id,a.initial_approval_at,a.legacy_reopen_prior_stage,
         a.new_case_workflow,a.requested_by_user_id,a.requested_by_customer_id
     FROM loan_application_generated_documents d
     JOIN contract_generations g ON g.id=d.contract_generation_id
     JOIN loan_applications a ON a.id=d.application_id
     WHERE d.id=? AND d.application_id=? AND a.deleted_at IS NULL`, [documentId, applicationId]);
  const applicationIdentity = d && {
    id: Number(d.case_id),
    stage: d.stage,
    current_primary_generation_id: d.current_primary_generation_id,
    initial_approval_at: d.initial_approval_at,
    legacy_reopen_prior_stage: d.legacy_reopen_prior_stage,
    new_case_workflow: d.new_case_workflow,
  };
  if (!d?.provider_contract_id) throw new Error("generated_document_not_found");
  if (d.kind === "primary" && !isApplicationPrimaryGeneration(applicationIdentity, d.contract_generation_id))
    throw new Error("primary_contract_not_current");
  if ((d.kind === "primary" &&
       (d.superseded_at || d.generation_deleted_at || d.application_status === "rejected")) || (d.kind === "amendment" &&
      (d.loan_application_id !== applicationId || d.superseded_at || d.status === "rejected" || d.stage !== "funder_amendment_pending_signature" ||
       Number(queryRow<any>("SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND kind='amendment' ORDER BY id DESC LIMIT 1", [applicationId])?.contract_generation_id) !== Number(d.contract_generation_id)))) {
    throw new Error("generated_document_not_found");
  }
  return observeGeneratedDocumentSignature(d, false);
}

export async function getGeneratedDocumentSignatureStatus(applicationId: number, documentId: number) {
  const d = queryRow<any>(`SELECT d.*,g.provider_contract_id,g.provider_status,g.status generation_status,g.loan_application_id,
        g.generation_purpose,g.superseded_at,g.deleted_at generation_deleted_at,
        a.id case_id,a.stage,a.status application_status,a.current_primary_generation_id,
        a.initial_approval_at,a.legacy_reopen_prior_stage,a.new_case_workflow,
        a.requested_by_user_id,a.requested_by_customer_id
      FROM loan_application_generated_documents d
      JOIN contract_generations g ON g.id=d.contract_generation_id
      JOIN loan_applications a ON a.id=d.application_id
      WHERE d.id=? AND d.application_id=? AND a.deleted_at IS NULL`,
  [documentId, applicationId]);
  const applicationIdentity = d && {
    id: Number(d.case_id),
    stage: d.stage,
    current_primary_generation_id: d.current_primary_generation_id,
    initial_approval_at: d.initial_approval_at,
    legacy_reopen_prior_stage: d.legacy_reopen_prior_stage,
    new_case_workflow: d.new_case_workflow,
  };
  if (!d?.provider_contract_id) throw new Error("generated_document_not_found");
  if (d.kind === "primary" && !isApplicationPrimaryGeneration(applicationIdentity, d.contract_generation_id))
    throw new Error("primary_contract_not_current");
  if ((d.kind === "primary" &&
       (d.superseded_at || d.generation_deleted_at || d.application_status === "rejected")) || (d.kind === "amendment" &&
      (d.loan_application_id !== applicationId || d.superseded_at || d.status === "rejected" || d.stage !== "funder_amendment_pending_signature" ||
       Number(queryRow<any>("SELECT contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND kind='amendment' ORDER BY id DESC LIMIT 1", [applicationId])?.contract_generation_id) !== Number(d.contract_generation_id)))) {
    throw new Error("generated_document_not_found");
  }
  if (d.kind === "primary" && String(d.generation_purpose ?? "primary") === TOMAN_REPLACEMENT_PURPOSE) {
    const consent = latestTomanReplacementConsent(Number(d.application_id))?.consent;
    const current = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [d.application_id]);
    const generation = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [d.contract_generation_id]);
    if (!consent || !current || !tomanReplacementSignatureIdentityMatches(current, generation, consent))
      throw new Error("toman_replacement_terms_unverifiable");
  }
  const response = await emzameRequest(`contracts/${encodeURIComponent(String(d.provider_contract_id))}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("provider_status_failed");
  const state = providerContractState(body);
  if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed");
  return {
    id: Number(d.id),
    kind: String(d.kind),
    providerStatus: state.status ?? (state.signed ? "signed" : null),
    providerStatusTitle: state.title,
    signed: state.signed,
    checkedAt: now(),
    readOnly: true as const,
  };
}

router.get("/loan-applications/:id/generated-documents/:documentId/signature-status", requirePermission("loan_applications.view"), async (req, res): Promise<void> => {
  const applicationId = Number(req.params.id);
  const r = scoped(applicationId, user(res));
  if (!r) { error(res, 404, "loan_application_not_found"); return; }
  try {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await getGeneratedDocumentSignatureStatus(applicationId, Number(req.params.documentId)));
  } catch (err) {
    req.log.warn({ err, applicationId: r.id, documentId: Number(req.params.documentId) }, "loan application read-only signature status lookup failed");
    const code = err instanceof Error ? err.message : "";
    if (["generated_document_not_found", "primary_contract_not_current", "toman_replacement_signature_required",
      "toman_replacement_terms_unverifiable", "toman_replacement_terms_stale"].includes(code)) {
      error(res, code === "generated_document_not_found" ? 404 : 409, code);
    } else {
      error(res, 502, "provider_status_failed");
    }
  }
});

router.post("/loan-applications/:id/generated-documents/:documentId/verify-signature", requirePermission("loan_applications.view"), async (req, res): Promise<void> => {
  const applicationId = Number(req.params.id);
  const r = scoped(applicationId, user(res));
  const d = r && queryRow<any>(`SELECT d.*,g.provider_status,g.provider_contract_id,g.generation_purpose
    FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.id=? AND d.application_id=? AND g.customer_id=?`,
  [Number(req.params.documentId), r.id, r.customer_id]);
  if (!d || !d.provider_contract_id) { error(res, 404, "generated_document_not_found"); return; }
  if (user(res).role === "salesperson") { error(res, 403, "read_only_signature_status"); return; }
  try {
    res.json(await observeGeneratedDocumentSignature(d, true));
  } catch (err) {
    req.log.warn({ err, applicationId: r.id, documentId: d.id }, "loan application signature status refresh failed");
    const code = err instanceof Error ? err.message : "";
    if (["primary_contract_not_current", "toman_replacement_signature_required", "toman_replacement_terms_unverifiable",
      "toman_replacement_terms_stale"].includes(code)) {
      error(res, 409, code);
    } else {
      error(res, code === "signature_processing_failed" ? 500 : 502,
        code === "signature_processing_failed" ? code : "provider_status_failed");
    }
    return;
  }
});

let signatureSyncRunning = false;
async function syncPendingCustomerSignatures() {
  if (signatureSyncRunning) return;
  signatureSyncRunning = true;
  try {
    const pending = queryRows<any>(`SELECT a.id application_id,d.id document_id
      FROM loan_applications a
      JOIN loan_application_generated_documents d ON d.application_id=a.id AND d.kind='primary'
       JOIN contract_generations g ON g.id=d.contract_generation_id AND g.deleted_at IS NULL AND g.superseded_at IS NULL
        WHERE a.deleted_at IS NULL AND a.stage IN ('primary_contract_pending_signature','approved_contract_pending_signature')
         AND (d.contract_generation_id=a.current_primary_generation_id OR
           (a.current_primary_generation_id IS NULL AND a.initial_approval_at IS NULL
             AND a.legacy_reopen_prior_stage IS NULL AND g.loan_application_id IS NULL
             AND d.id=(SELECT MAX(latest.id) FROM loan_application_generated_documents latest
               WHERE latest.application_id=a.id AND latest.kind='primary')
             AND NOT EXISTS (SELECT 1 FROM loan_application_stage_history h WHERE h.application_id=a.id
               AND h.action='legacy-applications-reopened-for-initial-provider-approval')))
         AND NOT EXISTS (SELECT 1 FROM loan_application_stage_history consent
           WHERE consent.application_id=a.id AND consent.action=? AND json_valid(consent.reason)
             AND CAST(json_extract(consent.reason,'$.sourceGenerationId') AS INTEGER)=d.contract_generation_id)
        AND (d.link IS NULL OR d.link NOT LIKE 'signed:%') AND g.provider_contract_id IS NOT NULL
       ORDER BY a.id LIMIT 50`, [TOMAN_REPLACEMENT_ACTION]);
    for (const item of pending) {
      try { await refreshGeneratedDocumentSignature(Number(item.application_id), Number(item.document_id)); }
      catch (err) { logger.warn({ err, applicationId: Number(item.application_id) }, "background signature refresh failed"); }
    }
    const amendments = queryRows<any>(`SELECT a.id application_id,d.id document_id
      FROM loan_applications a
      JOIN loan_application_generated_documents d ON d.application_id=a.id AND d.kind='amendment'
      JOIN contract_generations g ON g.id=d.contract_generation_id AND g.loan_application_id=a.id AND g.superseded_at IS NULL
      WHERE a.deleted_at IS NULL AND a.stage='funder_amendment_pending_signature'
        AND (d.link IS NULL OR d.link NOT LIKE 'signed:%') AND g.provider_contract_id IS NOT NULL
        AND d.id=(SELECT MAX(latest.id) FROM loan_application_generated_documents latest WHERE latest.application_id=a.id AND latest.kind='amendment')
      ORDER BY a.id LIMIT 50`);
    for (const item of amendments) {
      try { await refreshGeneratedDocumentSignature(Number(item.application_id), Number(item.document_id)); }
      catch (err) { logger.warn({ err, applicationId: Number(item.application_id) }, "background amendment signature refresh failed"); }
    }
  } finally {
    signatureSyncRunning = false;
  }
}
const signatureSyncStartup = setTimeout(() => void syncPendingCustomerSignatures(), 5_000);
const signatureSyncInterval = setInterval(() => void syncPendingCustomerSignatures(), 60_000);
signatureSyncStartup.unref();
signatureSyncInterval.unref();
router.post("/loan-applications/:id/generated-documents/:documentId/review", requirePermission("loan_applications.review"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res));
  const decision = String(req.body?.decision || "");
  const reason = String(req.body?.reason || "").trim();
  if (!r) return error(res, 404, "loan_application_not_found");
   const amendmentReview = r.stage === "funder_amendment_review";
   if ((!amendmentReview && r.stage !== "customer_documents_review") || !canAct(r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
   if (amendmentReview
     ? (!["approved", "rejected"].includes(decision) || (decision === "rejected" && !reason))
     : (!["approved", "incomplete", "rejected"].includes(decision) || (decision !== "approved" && !reason))) return error(res, 400, "invalid_document_review");
    const effectivePrimaryGenerationId = applicationPrimaryGenerationId(r);
    const document = queryRow<any>(`SELECT d.*,g.pdf_path,g.superseded_at,g.status generation_status,g.provider_status
    FROM loan_application_generated_documents d
     JOIN contract_generations g ON g.id=d.contract_generation_id AND g.deleted_at IS NULL AND g.superseded_at IS NULL
      WHERE d.id=? AND d.application_id=? AND d.kind=? AND (?=0 OR g.loan_application_id=?)
        AND (?=1 OR d.contract_generation_id=?)`,
    [Number(req.params.documentId), r.id, amendmentReview ? "amendment" : "primary", amendmentReview ? 1 : 0, r.id,
       amendmentReview ? 1 : 0, effectivePrimaryGenerationId]);
   if (!document || typeof document.link !== "string" || !document.link.startsWith("signed:") ||
       document.generation_status !== "signed" || !isStrictSignedProviderState(document.provider_status))
     return error(res, 409, amendmentReview ? "amendment_contract_not_signed" : "primary_contract_not_signed");
   if (!fileExists(document.pdf_path)) return error(res, 409, amendmentReview ? "amendment_contract_file_missing" : "primary_contract_file_missing");
   try {
     runTransaction(() => {
       if (amendmentReview) {
         const latest = queryRow<any>("SELECT id,contract_generation_id FROM loan_application_generated_documents WHERE application_id=? AND kind='amendment' ORDER BY id DESC LIMIT 1", [r.id]);
         if (Number(latest?.id) !== Number(document.id) || r.stage !== "funder_amendment_review") throw new Error("amendment_review_not_current");
         const current = queryRow<any>("SELECT stage,status FROM loan_applications WHERE id=?", [r.id]);
         if (current?.stage !== "funder_amendment_review" || current.status === "rejected") throw new Error("invalid_stage_transition");
         const ts = now();
         if (decision === "rejected") {
           const superseded = executeChanges("UPDATE contract_generations SET superseded_at=?,updated_at=? WHERE id=? AND loan_application_id=? AND status='signed' AND superseded_at IS NULL",
             [ts, ts, document.contract_generation_id, r.id]);
           if (superseded !== 1) throw new Error("amendment_generation_not_current");
         }
         const reviewed = executeChanges("UPDATE loan_application_generated_documents SET status=?,review_reason=?,reviewed_at=?,reviewed_by_user_id=? WHERE id=? AND application_id=?",
           [decision, decision === "rejected" ? reason : null, ts, user(res).id, document.id, r.id]);
         if (reviewed !== 1) throw new Error("amendment_review_not_current");
         const target: Stage = decision === "rejected" ? "funder_amendment_pending_signature" : "funder_result_review";
         const moved = executeChanges("UPDATE loan_applications SET stage=?,status='reviewing',updated_at=? WHERE id=? AND stage='funder_amendment_review' AND status<>'rejected'", [target, ts, r.id]);
         if (moved !== 1) throw new Error("invalid_stage_transition");
         execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
           [r.id, "funder_amendment_review", target, decision === "rejected" ? "amendment_contract_rejected" : "amendment_contract_approved",
             JSON.stringify({ generationId: document.contract_generation_id, reason: decision === "rejected" ? reason : null }), user(res).id, ts]);
       } else {
         executeChanges("UPDATE loan_application_generated_documents SET status=?,review_reason=?,reviewed_at=?,reviewed_by_user_id=? WHERE id=?", [decision, reason || null, now(), user(res).id, document.id]);
         recordReview(r.id, r.stage, `primary_contract_${decision}:${document.id}`, reason || null, user(res).id);
       }
     });
   } catch (e) {
     return error(res, 409, e instanceof Error ? e.message : "generated_document_review_failed");
   }
  res.json({ ok: true, status: decision });
});

router.post("/loan-applications/:id/guarantor", requirePermission("loan_applications.update"), (req, res) => {
  const r = scoped(Number(req.params.id), user(res)); if (!r) return error(res, 404, "loan_application_not_found");
  if (loanCaseFinancialTermsLocked(r)) return error(res, 409, "admin_case_financial_terms_locked");
  if (!["guarantor_registration", "guarantor_documents_upload", "guarantor_documents_review"].includes(r.stage) ||
      !canAct(r.stage === "guarantor_documents_review" ? "guarantor_documents_upload" : r.stage, user(res), r.customer_id, r.status)) return error(res, 403, "action_forbidden");
  const b = req.body ?? {}; if (typeof b.fullName !== "string" || b.fullName.trim().length < 2 || b.fullName.trim().length > 200) return error(res, 400, "invalid_guarantor");
  const prior = queryRow<any>("SELECT * FROM loan_application_guarantors WHERE application_id=?", [r.id]);
  const identityChanged = !!prior && (prior.full_name !== b.fullName.trim() || (prior.national_code ?? null) !== (b.nationalCode || null));
  const data = { ...(!identityChanged ? parseJson(prior?.data_json) ?? {} : {}), fullName: b.fullName.trim(), nationalCode: b.nationalCode || null, mobile: b.mobile || null };
  const ts = now();
  runTransaction(() => {
    execute("INSERT INTO loan_application_guarantors(application_id,full_name,national_code,mobile,data_json,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET full_name=excluded.full_name,national_code=excluded.national_code,mobile=excluded.mobile,data_json=excluded.data_json",
      [r.id, data.fullName, data.nationalCode, data.mobile, JSON.stringify(data), ts]);
    if (identityChanged) executeChanges("UPDATE loan_application_guarantor_documents SET status='rejected',rejection_reason=? WHERE guarantor_id=?",
      ["هویت ضامن تغییر کرده است؛ مدارک قبلی حفظ شده‌اند و بررسی مجدد لازم است.", prior.id]);
    if (identityChanged) executeChanges("UPDATE loan_application_collateral SET status='pending' WHERE application_id=? AND json_valid(data_json) AND json_extract(data_json,'$.party')='guarantor'", [r.id]);
    if ((r.new_case_workflow || r.legacy_reopen_prior_stage) && r.stage === "guarantor_registration") {
      // A returned/preapproved case must not remain on the registration step:
      // its initial decision is retained, so resume the guarantor document task.
      const nextStage = r.initial_approval_at ? "guarantor_documents_upload" : "funder_initial_approval";
      const changed = executeChanges("UPDATE loan_applications SET stage=?,status='reviewing',updated_at=? WHERE id=? AND stage='guarantor_registration' AND status<>'rejected'",
        [nextStage, ts, r.id]);
      if (changed !== 1) throw new Error("invalid_stage_transition");
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,actor_id,created_at) VALUES(?,?,?,?,?,?)",
        [r.id, "guarantor_registration", nextStage, "guarantor-registered", user(res).id, ts]);
    } else if (r.stage === "guarantor_documents_review") {
      executeChanges("UPDATE loan_applications SET stage='guarantor_documents_upload',status=?,updated_at=? WHERE id=?", [workflowStatus("guarantor_documents_upload"), ts, r.id]);
      execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
        [r.id, r.stage, "guarantor_documents_upload", "guarantor-review-reopened-for-upload",
          JSON.stringify({ reason: "تکمیل اطلاعات و مدارک ضامن؛ شرایط مالی و امضای قبلی حفظ شدند.", identityChanged, priorGuarantor: prior ?? null }), user(res).id, ts]);
    } else {
      recordReview(r.id, r.stage, "guarantor-registered", identityChanged ? JSON.stringify({ priorGuarantor: prior, identityChanged: true }) : null, user(res).id);
    }
  });
  res.status(201).json(queryRow("SELECT * FROM loan_application_guarantors WHERE application_id=?", [r.id]));
});

export default router;
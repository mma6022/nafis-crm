import express, { Router, type IRouter, type RequestHandler } from "express";
import { deleteCustomerIntro } from "../lib/expert-intro-sms-core";
import { callNoteError } from "../lib/call-note-rule";
import { crossOwnerEligible, findOtherOwnerMatches } from "../lib/cross-owner-search";
import { customerSearchSql } from "../lib/customer-id-search";
import { identityValuesChanged } from "../lib/identity-change";
import { propagateContractTemplateChange } from "../lib/contract-template-updates";
import { creditProviderFailure } from "../lib/credit-provider-failure";
import { publicDocumentLabel } from "../lib/public-document-labels";
import { saveUserVoipExtension } from "../lib/user-voip-extension";
import { savePendingAfterCallHistory } from "../lib/voip-after-call";
import { callReportDateBounds } from "../lib/call-report-filters";
import { callHistoryScope, callListActorScope, isCallExportRequest } from "../lib/call-history-scope";
import { systemSummaryForCall } from "../lib/call-reports";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CreateAllocationProgramBody,
  CreateAllocationProgramResponse,
  CreateCustomerBody,
  CreateCustomerResponse,
  DeleteCustomerParams,
  CreateCallBody,
  CreateCallResponse,
  CreateConsultationBody,
  CreateConsultationResponse,
  CreateLoanPlanBody,
  CreateLoanPlanResponse,
  CreateReminderBody,
  CreateReminderResponse,
  CreateUserBody,
  CreateUserResponse,
  GetCrmSummaryResponse,
  GetNotificationSettingsResponse,
  ListNotificationDeliveriesQueryParams,
  ListNotificationDeliveriesResponse,
  GetCustomerParams,
  GetCustomerResponse,
  GetConsultationParams,
  GetConsultationResponse,
  GetLoanPlanParams,
  GetLoanPlanResponse,
  AcknowledgeReminderParams,
  AcknowledgeReminderResponse,
  ListCustomerActivityParams,
  ListCustomerActivityResponse,
  LookupCustomerByPhoneQueryParams,
  LookupCustomerByPhoneResponse,
  CreateCustomerRepeatRequestBody,
  CreateCustomerRepeatRequestResponse,
  ListCustomerTagsResponse,
  CreateCustomerTagBody,
  CreateCustomerTagResponse,
  ListCustomerRepeatRequestsParams,
  ListCustomerRepeatRequestsResponse,
  AcknowledgeCustomerRepeatRequestsParams,
  AcknowledgeCustomerRepeatRequestsResponse,
  UpdateCustomerTagsParams,
  UpdateCustomerTagsBody,
  UpdateCustomerTagsResponse,
  ListCustomersQueryParams,
  ListCustomersResponse,
  ListCallsQueryParams,
  ListCallsResponse,
  ListConsultationsQueryParams,
  ListConsultationsResponse,
  ListConsultOptionsQueryParams,
  ListConsultOptionsResponse,
  ListLoanPlansQueryParams,
  ListLoanPlansResponse,
  ListRemindersQueryParams,
  ListRemindersResponse,
  ListSalespersonsResponse,
  ListAllocationProgramsResponse,
  ListUsersResponse,
  ListSalespersonIdentityAmbiguitiesResponse,
  ResolveSalespersonIdentityLinkBody,
  ResolveSalespersonIdentityLinkParams,
  ResolveSalespersonIdentityLinkResponse,
  MatchConsultationLoanPlansParams,
  MatchConsultationLoanPlansResponse,
  GetConsultationHistoricalLoanPlanMatchesResponse,
  ParseCustomerTextBody,
  ParseCustomerTextResponse,
  UpdateConsultationBody,
  UpdateConsultationParams,
  UpdateConsultationResponse,
  UpdateCustomerBody,
  UpdateCustomerParams,
  UpdateCustomerResponse,
  UpdateLoanPlanBody,
  UpdateLoanPlanParams,
  UpdateLoanPlanResponse,
  UpdateNotificationSettingsBody,
  UpdateNotificationSettingsResponse,
  UpdateReminderBody,
  UpdateReminderResponse,
  UpdateUserBody,
  UpdateUserParams,
  UpdateUserResponse,
  UpdateAllocationProgramBody,
  UpdateAllocationProgramParams,
  UpdateAllocationProgramResponse,
  ResetUserPasswordBody,
  ResetUserPasswordParams,
  ResetUserPasswordResponse,
  ListConsultationAiConversationsQueryParams,
  ListConsultationAiConversationsResponse,
  CreateConsultationAiConversationBody,
  CreateConsultationAiConversationResponse,
  ListConsultationAiMessagesParams,
  ListConsultationAiMessagesResponse,
  SendConsultationAiMessageParams,
  SendConsultationAiMessageBody,
  SendConsultationAiMessageResponse,
  SubmitConsultationAiFeedbackParams,
  SubmitConsultationAiFeedbackBody,
  SubmitConsultationAiFeedbackResponse,
  ListCustomerCreditChecksParams,
  ListCustomerCreditChecksResponse,
  ListDuplicateCustomersResponse,
  MergeCustomersBody,
  MergeCustomersResponse,
  InitiateCustomerCreditCheckParams,
  InitiateCustomerCreditCheckBody,
  InitiateCustomerCreditCheckResponse,
  ValidateCustomerCreditCheckParams,
  ValidateCustomerCreditCheckBody,
  ValidateCustomerCreditCheckResponse,
  RenewCustomerCreditCheckOtpParams,
  RenewCustomerCreditCheckOtpResponse,
  RefreshCustomerCreditCheckStatusParams,
  RefreshCustomerCreditCheckStatusResponse,
  CreateManualVerificationRequestParams,
  CreateManualVerificationRequestResponse,
  ListManualVerificationRequestsResponse,
  GetManualVerificationRequestParams,
  GetManualVerificationRequestResponse,
  ApproveManualVerificationRequestParams,
  ApproveManualVerificationRequestBody,
  ApproveManualVerificationRequestResponse,
  type ManualVerificationApproval,
} from "@workspace/api-zod";
import {
  execute,
  executeChanges,
  queryRow,
  queryRows,
  runImmediateTransaction,
  runTransaction,
  crmDb,
  type SqlValue,
} from "../lib/crm-db";
import {
  hashPassword,
  requireAdmin,
  revokeUserSessions,
  type AuthUser,
} from "../lib/auth";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  getNotificationSettings,
  notifyNewCustomer,
  saveNotificationSettings,
} from "../lib/customer-notifications";
import {
  createDatabaseBackup,
  validateSqliteDatabase,
} from "../lib/database-backup";
import { databasePath } from "../lib/crm-db";
import { PERMISSIONS, requirePermission } from "../lib/access-control";
import {
  deriveCreditRank,
  invalidCreditScoreMessage,
} from "../lib/credit-rank";
import * as ics24 from "../lib/ics24";
import { questionnaireError, consultationRankMatches, type QuestionnaireOption } from "../lib/consultation-questionnaire";
import { consultationMaximumAmount } from "../lib/consultation-limits";
import { verifyCustomer } from "../lib/sapi";
import { latestFirstCall, latestNoPlanFit, latestSelectedPlans, logPriorityChange } from "../lib/team-sales";
import { applyNonP1TransferInTx, NONP1_TRANSFER_HEADER, type NonP1Result } from "../lib/nonp1-transfer";
import { kazemiSourceFilterSql, kazemiSourceOf, kazemiSources } from "../lib/kazemi-source";
import { IDENTITY_LOG_TABLE, canActOnCustomerProfile, ensureIdentityLogSchema } from "../lib/consult-profile";
import { retainedIdentityChecks } from "../lib/identity-check-retention";
import { normalizeCustomerMobile, normalizeCustomerNationalCode, isAdminRole } from "../lib/customer-integrity";
import { mergeCustomerRecords } from "../lib/customer-merge";
import { insertCustomerRecord } from "../lib/customer-create";
import { publicPlanGuarantees } from "../lib/public-plan-guarantees";
import { isPortalRegistration } from "../lib/customer-portal-features";
import { acceptedGradeEdit, compactRankList, expandRankList, GRADE_EDIT_ERROR, isLegacyGradeLetter, parseStoredRanks } from "../lib/credit-subgrades";
import {
  ensureSalespersonIdentity,
  reconcileSalespersonUserIdentities,
  resolveSalespersonIdentity,
  salespersonIdentityReport,
} from "../lib/salesperson-identity";

const router: IRouter = Router();

function normalizeCustomerIdentity(value: string): string {
  return normalizeCustomerMobile(value);
}

function customerIdentityChanged(
  current: { phone: string; national_code: string | null; birth_date_jalali: string | null; postal_code: string | null },
  next: { phone: string; nationalCode: string | null; birthDateJalali: string | null; postalCode: string | null },
): boolean {
  return normalizeCustomerNationalCode(current.national_code ?? "") !==
      normalizeCustomerNationalCode(next.nationalCode ?? "") ||
    normalizeCustomerIdentity(current.phone) !== normalizeCustomerIdentity(next.phone) ||
    current.birth_date_jalali !== next.birthDateJalali ||
    current.postal_code !== next.postalCode;
}

// identity_changed_at moves only when an existing identity value is replaced (empty→filled is not a change).
function customerIdentityStampChanged(
  current: { phone: string; national_code: string | null; birth_date_jalali: string | null; postal_code: string | null },
  next: { phone: string; nationalCode: string | null; birthDateJalali: string | null; postalCode: string | null },
): boolean {
  const code = (value: string | null) => value ? normalizeCustomerNationalCode(value) : "";
  const phone = (value: string | null) => value ? normalizeCustomerIdentity(value) : "";
  return identityValuesChanged([
    [code(current.national_code), code(next.nationalCode)],
    [phone(current.phone), phone(next.phone)],
    [current.birth_date_jalali, next.birthDateJalali],
    [current.postal_code, next.postalCode],
  ]);
}

function compareCustomerIdentity(
  source: { phone: string; national_code: string | null },
  target: { phone: string; national_code: string | null },
) {
  const sourceCode = source.national_code ? normalizeCustomerNationalCode(source.national_code) : "";
  const targetCode = target.national_code ? normalizeCustomerNationalCode(target.national_code) : "";
  const sourceValidCode = Boolean(sourceCode && ics24.validNationalCode(sourceCode));
  const targetValidCode = Boolean(targetCode && ics24.validNationalCode(targetCode));
  const conflictingNationalCodes = sourceValidCode && targetValidCode && sourceCode !== targetCode;
  const nationalCodeMatches = sourceValidCode && targetValidCode && sourceCode === targetCode;
  const mobileMatches = normalizeCustomerIdentity(source.phone) === normalizeCustomerIdentity(target.phone);
  return {
    isDuplicate: mobileMatches || nationalCodeMatches,
    nationalCodeMatches,
    conflictingNationalCodes,
  };
}

function findActiveCustomerIdentityConflict(
  customerId: number | null,
  identity: { phone?: string; nationalCode?: string | null },
) {
  const rows = queryRows<{ id: number; phone: string; national_code: string | null }>(
    `SELECT id,phone,national_code FROM customers
     WHERE merged_into_customer_id IS NULL AND COALESCE(status,'in_progress') <> 'cancelled'`,
  );
  return rows.find((row) => {
    if (customerId !== null && Number(row.id) === customerId) return false;
    const mobileConflict = identity.phone !== undefined &&
      normalizeCustomerIdentity(row.phone) === normalizeCustomerIdentity(identity.phone);
    const code = identity.nationalCode ? normalizeCustomerNationalCode(identity.nationalCode) : "";
    const existingCode = row.national_code ? normalizeCustomerNationalCode(row.national_code) : "";
    const nationalConflict = Boolean(code && ics24.validNationalCode(code) && code === existingCode);
    return mobileConflict || nationalConflict;
  });
}

/** «کد ملی» is optional in the customer form (PM, 2026-10-24): '' / whitespace means "not entered" and is stored as NULL. */
function blankNationalCodeToNull(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).nationalCode;
    if (typeof value === "string" && value.trim() === "") return { ...(body as Record<string, unknown>), nationalCode: null };
  }
  return body;
}

/** crm-nid-optional: the only way to erase a stored national code is an explicit `clearNationalCode: true`. */
function explicitNationalCodeClear(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    (body as Record<string, unknown>).clearNationalCode === true);
}

function hasActiveCustomerIdentityConflict(
  customerId: number | null,
  identity: { phone?: string; nationalCode?: string | null },
): boolean {
  return Boolean(findActiveCustomerIdentityConflict(customerId, identity));
}

function findCustomerByPhone(phone: string): CustomerRow | undefined {
  const normalized = normalizeCustomerMobile(phone);
  if (!normalized) return undefined;
  const matches = queryRows<CustomerRow>(
    `${customerSelect}
     WHERE crm_customer_mobile_key(c.phone) = ?
     GROUP BY c.id
     ORDER BY CASE
       WHEN c.merged_into_customer_id IS NULL AND COALESCE(c.status,'in_progress') <> 'cancelled' THEN 0
       WHEN c.merged_into_customer_id IS NULL THEN 1
       ELSE 2 END,
       c.created_at DESC,c.id DESC`,
    [normalized],
  );
  for (const match of matches) {
    if (match.merged_into_customer_id == null) return match;
    const hasMergeAudit = Boolean(queryRow(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_merge_audit'",
    ));
    if (!hasMergeAudit) return match;
    const survivor = queryRow<{ id: number }>(
      `WITH RECURSIVE merge_chain(customer_id,depth) AS (
         SELECT ?,0
         UNION ALL
         SELECT audit.survivor_customer_id,chain.depth+1
         FROM merge_chain chain
         JOIN customer_merge_audit audit ON audit.source_customer_id=chain.customer_id
         WHERE chain.depth < 100
       )
       SELECT c.id FROM merge_chain chain JOIN customers c ON c.id=chain.customer_id
       WHERE c.merged_into_customer_id IS NULL
       ORDER BY chain.depth LIMIT 1`,
      [match.id],
    );
    if (survivor) {
      const profile = queryRow<CustomerRow>(
        `${customerSelect} WHERE c.id=? AND c.merged_into_customer_id IS NULL GROUP BY c.id`,
        [survivor.id],
      );
      if (profile) return profile;
    }
    // Keep a recognized historical number from being re-created when a legacy
    // merge audit is incomplete; where the chain is intact, the canonical
    // survivor above is always returned instead.
    return match;
  }
  return undefined;
}

function customerTags(customerId: number): string[] {
  return queryRows<{ tag: string }>(
    "SELECT tag FROM customer_tags WHERE customer_id=? ORDER BY tag",
    [customerId],
  ).map((row) => row.tag);
}

function customerPendingRepeatRequestCount(customerId: number): number {
  return Number(queryRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM customer_repeat_requests WHERE customer_id=? AND status='pending'",
    [customerId],
  )?.count ?? 0);
}

function customerOwnerOrAdmin(customerId: number, user: AuthUser): boolean {
  if (user.role === "admin") {
    return Boolean(queryRow(
      "SELECT id FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
      [customerId],
    ));
  }
  if (user.customerScope === "assigned") {
    if (user.salespersonId == null) return false;
    return Boolean(queryRow(
      "SELECT id FROM customers WHERE id=? AND salesperson_id=? AND merged_into_customer_id IS NULL",
      [customerId, user.salespersonId],
    ));
  }
  return Boolean(queryRow(
    `SELECT id FROM customers WHERE id=? AND merged_into_customer_id IS NULL
     AND COALESCE(status,'in_progress') <> 'cancelled'`,
    [customerId],
  ));
}

function countCustomerHistory(customerId: number) {
  const count = (table: string) => Number(queryRow<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE customer_id = ?`, [customerId],
  )?.count ?? 0);
  return {
    calls: count("call_logs"),
    reminders: count("reminders"),
    consultations: count("consultation_forms"),
    loanApplications: count("loan_applications"),
    identityDocuments: count("customer_identity_documents"),
    creditChecks: count("customer_credit_checks"),
  };
}

router.get("/customers/duplicates", requireAdmin, (_req, res): void => {
  const customers = queryRows<{
    id: number; name: string; phone: string; national_code: string | null;
    salesperson_name: string | null;
  }>(`SELECT c.id,c.name,c.phone,c.national_code,s.name salesperson_name
      FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id
      WHERE c.merged_into_customer_id IS NULL AND COALESCE(c.status,'in_progress') <> 'cancelled'
      ORDER BY c.id`);
  const groups = new Map<string, { matchType: "mobile" | "nationalCode"; normalizedValue: string; candidates: typeof customers }>();
  const byIdentity = (kind: "mobile" | "nationalCode", value: string | null, id: number) => {
    const normalizedValue = value
      ? kind === "mobile"
        ? normalizeCustomerIdentity(value)
        : normalizeCustomerNationalCode(value)
      : "";
    if (!normalizedValue || (kind === "nationalCode" && !ics24.validNationalCode(normalizedValue))) return;
    const key = `${kind}:${normalizedValue}`;
    let group = groups.get(key);
    if (!group) { group = { matchType: kind, normalizedValue, candidates: [] }; groups.set(key, group); }
    group.candidates.push(customers.find((item) => Number(item.id) === id)!);
  };
  for (const customer of customers) {
    byIdentity("mobile", customer.phone, Number(customer.id));
    byIdentity("nationalCode", customer.national_code, Number(customer.id));
  }
  const result = [...groups.values()].filter((group) => group.candidates.length > 1).map((group) => ({
    ...group,
    candidates: group.candidates.map((customer) => ({
      id: Number(customer.id), name: customer.name, phone: customer.phone,
      nationalCode: customer.national_code, salespersonName: customer.salesperson_name,
      historyCounts: countCustomerHistory(Number(customer.id)),
    })),
  }));
  res.json(ListDuplicateCustomersResponse.parse(result));
});

router.post("/customers/merge", requireAdmin, (req, res): void => {
  const parsed = MergeCustomersBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { sourceCustomerId, targetCustomerId, salespersonId } = parsed.data;
  if (sourceCustomerId === targetCustomerId) { res.status(400).json({ error: "Source and survivor must differ" }); return; }
  const source = queryRow<{ id: number; phone: string; national_code: string | null; merged_into_customer_id: number | null }>(
    "SELECT id,phone,national_code,merged_into_customer_id FROM customers WHERE id=?", [sourceCustomerId],
  );
  const target = queryRow<{ id: number; phone: string; national_code: string | null; merged_into_customer_id: number | null }>(
    "SELECT id,phone,national_code,merged_into_customer_id FROM customers WHERE id=?", [targetCustomerId],
  );
  if (!source || !target) { res.status(404).json({ error: "Customer not found" }); return; }
  if (source.merged_into_customer_id !== null || target.merged_into_customer_id !== null) {
    res.status(409).json({ error: "Merged customers cannot be merged again" }); return;
  }
  const identityComparison = compareCustomerIdentity(source, target);
  if (identityComparison.conflictingNationalCodes) {
    res.status(409).json({ error: "Merge rejected: both customers have different valid national codes" });
    return;
  }
  if (!identityComparison.isDuplicate) { res.status(409).json({ error: "Customers are not identified as duplicates" }); return; }
  if (!queryRow("SELECT id FROM salespersons WHERE id=?", [salespersonId])) {
    res.status(404).json({ error: "Salesperson not found" }); return;
  }
  let outcome: ReturnType<typeof mergeCustomerRecords>;
  try {
    const actor = res.locals.authUser as AuthUser;
    outcome = mergeCustomerRecords(
      crmDb,
      sourceCustomerId,
      targetCustomerId,
      actor.id,
      salespersonId,
      new Date().toISOString(),
      compareCustomerIdentity,
    );
  } catch (error) {
    if (error instanceof Error && /constraint failed|UNIQUE/i.test(error.message)) {
      res.status(409).json({ error: `Merge rolled back due to a history conflict: ${error.message}` });
      return;
    }
    if (error instanceof Error && error.message === "customer_not_found") {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    if (error instanceof Error && error.message === "customer_already_merged") {
      res.status(409).json({ error: "Merged customers cannot be merged again" });
      return;
    }
    if (error instanceof Error && error.message === "customers_not_duplicates") {
      res.status(409).json({ error: "Customers are not identified as duplicates" });
      return;
    }
    if (error instanceof Error && error.message === "conflicting_national_codes") {
      res.status(409).json({ error: "Merge rejected: both customers have different valid national codes" });
      return;
    }
    if (error instanceof Error && error.message === "salesperson_not_found") {
      res.status(404).json({ error: "Salesperson not found" });
      return;
    }
    throw error;
  }
  res.json(MergeCustomersResponse.parse({
    survivorCustomerId: targetCustomerId, archivedSourceCustomerId: sourceCustomerId,
    salespersonId,
    reparentedHistoryCounts: outcome!.reparentedHistoryCounts,
    preservedFinancialArtifacts: outcome!.preservedFinancialArtifacts,
  }));
});

router.get("/database-backup", requireAdmin, (_req, res): void => {
  let backupPath: string | undefined;
  try {
    backupPath = createDatabaseBackup("download");
    res.download(
      backupPath,
      `crm-backup-${new Date().toISOString().slice(0, 10)}.db`,
      (error) => {
        if (backupPath) fs.rmSync(backupPath, { force: true });
        if (error && !res.headersSent)
          res.status(500).json({ message: "دریافت نسخه پشتیبان انجام نشد." });
      },
    );
  } catch {
    if (backupPath) fs.rmSync(backupPath, { force: true });
    res.status(500).json({ message: "ساخت نسخه پشتیبان انجام نشد." });
  }
});

router.post(
  "/database-restore",
  requireAdmin,
  express.raw({ type: "application/octet-stream", limit: "1gb" }),
  (req, res): void => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      res.status(400).json({ message: "فایل دیتابیس معتبر نیست." });
      return;
    }
    const pendingPath = `${databasePath}.pending`;
    const temporaryPath = `${pendingPath}.upload`;
    try {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(temporaryPath, req.body, { flag: "wx" });
      validateSqliteDatabase(temporaryPath);
      fs.renameSync(temporaryPath, pendingPath);
      res
        .status(202)
        .json({
          message:
            "دیتابیس معتبر است و سامانه برای اعمال آن راه‌اندازی مجدد می‌شود.",
        });
      setTimeout(() => process.exit(0), 500).unref();
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      res.status(400).json({ message: "فایل آپلودشده دیتابیس سالم CRM نیست." });
    }
  },
);

export function consultationQuestionnaireOptions(): QuestionnaireOption[] {
  const options = queryRows<any>(`SELECT id,field_key,option_value,label_fa,sort_order
    FROM consult_options WHERE active=1 ORDER BY field_key,sort_order,id`).map(row => ({
      id: Number(row.id), fieldKey: row.field_key, value: row.option_value,
      labelFa: row.label_fa, sortOrder: Number(row.sort_order),
    }));
  const add = (fieldKey: string, value: string) => {
    if (!value || options.some(option => option.fieldKey === fieldKey && option.value === value)) return;
    const label = queryRow<{ label_fa: string }>("SELECT label_fa FROM consult_options WHERE option_value=? ORDER BY active DESC,id LIMIT 1", [value])?.label_fa ?? value;
    options.push({ id: -(options.length + 1), fieldKey, value, labelFa: label, sortOrder: options.length });
  };
  for (const option of [...options].filter(option => option.fieldKey === "credit_rank")) add("guarantor_credit_rank", option.value);
  for (const row of queryRows<any>(`SELECT pc.customer_ranks,pc.guarantor_ranks,pc.customer_jobs,pc.collateral_type,pc.guarantor_collateral_type
    FROM loan_plan_conditions pc JOIN loan_plans lp ON lp.id=pc.plan_id WHERE lp.active=1 ORDER BY pc.id`)) {
    // Grades: a bare letter left in a plan rule (A–E, retired) must never come back as a choice; sub-grades may.
    for (const rank of parseRankList(row.customer_ranks)) if (!isLegacyGradeLetter(rank)) add("credit_rank", rank);
    for (const rank of parseRankList(row.customer_ranks)) if (!isLegacyGradeLetter(rank)) add("guarantor_credit_rank", rank);
    for (const rank of parseRankList(row.guarantor_ranks)) if (!isLegacyGradeLetter(rank)) add("guarantor_credit_rank", rank);
    for (const job of parseJsonArray<string>(row.customer_jobs)) add("job_type", job);
    for (const [field, collateral] of [["customer_check_status", row.collateral_type], ["guarantor_check_type", row.guarantor_collateral_type]]) {
      if (collateral === "physical_check") add(field, "physical");
      if (collateral === "digital_check") add(field, "digital");
    }
  }
  return options;
}
router.get(
  "/consult-options",
  requirePermission("consultations.view"),
  (req, res): void => {
    const parsed = ListConsultOptionsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    res.json(ListConsultOptionsResponse.parse(consultationQuestionnaireOptions()
      .filter(option => !parsed.data.fieldKey || option.fieldKey === parsed.data.fieldKey)));
  },
);

function notificationSettingsResponse() {
  return {
    ...getNotificationSettings(),
    telegramBotTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  };
}

router.get(
  "/notification-settings",
  requirePermission("notifications.view"),
  (_req, res): void => {
    res.json(
      GetNotificationSettingsResponse.parse(notificationSettingsResponse()),
    );
  },
);

router.patch(
  "/notification-settings",
  requirePermission("notifications.manage"),
  (req, res): void => {
    const parsed = UpdateNotificationSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    saveNotificationSettings(parsed.data);
    res.json(
      UpdateNotificationSettingsResponse.parse(notificationSettingsResponse()),
    );
  },
);

router.get(
  "/notification-deliveries",
  requirePermission("notifications.view"),
  (req, res): void => {
    const parsed = ListNotificationDeliveriesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const rows = queryRows<{
      id: number;
      customer_id: number;
      customer_name: string;
      customer_salesperson_name: string | null;
      channel: string;
      status: string;
      error_message: string | null;
      created_at: string;
    }>(
      `SELECT nd.id, nd.customer_id, c.name AS customer_name, s.name AS customer_salesperson_name, nd.channel,
       nd.status, nd.error_message, nd.created_at
     FROM notification_deliveries nd
     JOIN customers c ON c.id = nd.customer_id
     LEFT JOIN salespersons s ON s.id = c.salesperson_id
     ORDER BY nd.created_at DESC, nd.id DESC
     LIMIT ?`,
      [parsed.data.limit ?? 20],
    );
    res.json(
      ListNotificationDeliveriesResponse.parse(
        rows.map((row) => ({
          id: Number(row.id),
          customerId: Number(row.customer_id),
          customerName: row.customer_name,
          customerSalespersonName: row.customer_salesperson_name ?? null,
          channel: row.channel,
          status: row.status,
          errorMessage: row.error_message,
          createdAt: row.created_at,
        })),
      ),
    );
  },
);

type CustomerRow = {
  id: number;
  name: string;
  phone: string;
  description: string | null;
  created_at: string;
  salesperson_id: number | null;
  salesperson_name: string | null;
  priority: number | null;
  status: string | null;
  activity_count: number;
  last_activity_at: string | null;
  last_call_at?: string | null;
  national_code: string | null;
  credit_score: number | null;
  credit_rank: string | null;
  credit_checked_at: string | null;
  birth_date_jalali: string | null;
  postal_code: string | null;
  father_name: string | null;
  address: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  verification_status: string | null;
  verification_checked_at: string | null;
  shahkar_status: string | null;
  person_info_status: string | null;
  postal_code_info_status: string | null;
  sana_status: string | null;
  shahkar_ok: number | null;
  person_info_ok: number | null;
  postal_code_info_ok: number | null;
  sana_ok: number | null;
  official_first_name: string | null;
  official_last_name: string | null;
  official_father_name: string | null;
  official_address: string | null;
  official_postal_code: string | null;
  is_urgent: number | null;
  merged_into_customer_id: number | null;
};

type ActivityRow = {
  id: number;
  customer_id: number;
  salesperson_id: number | null;
  salesperson_name: string | null;
  subject: string | null;
  customer_request: string | null;
  expert_notes: string | null;
  created_at: string;
};

type CallRecordRow = ActivityRow & {
  customer_name: string;
  customer_phone: string;
  customer_salesperson_name: string | null;
  customer_owner?: number | null;
  event_phone?: string | null;
  call_extension?: string | null;
};

type ConsultationRow = {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
  customer_salesperson_name: string | null;
  has_check: number | null;
  has_promissory: number | null;
  has_guarantor: number | null;
  has_guarantor_check: number | null;
  has_guarantor_promissory: number | null;
  job_type: string | null;
  has_business_license: number | null;
  has_account_turnover: number | null;
  credit_rank: string | null;
  customer_credit_rank: string | null;
  needs_fast_receive: number | null;
  has_avg_balance: number | null;
  loan_purpose: string | null;
  requested_amount: string | null;
  extra_notes: string | null;
  guarantor_credit_rank: string | null;
  guarantor_check_type: string | null;
  guarantor_job_type: string | null;
  collateral_type: string | null;
  guarantor_collateral_type: string | null;
  customer_check_status: string | null;
  receive_mode: string | null;
  loan_pref: string | null;
  need_days: string | null;
  has_customer_salary_deduct: number | null;
  has_guarantor_salary_deduct: number | null;
  updated_at: string;
};

type LoanPlanRow = {
  id: number;
  name: string;
  filing_fee_toman: string;
  bank_name: string | null;
  platform_name: string | null;
  principal_amount: string | null;
  annual_interest: string | null;
  installments: string | null;
  installment_terms: string | null;
  required_documents: string | null;
  deduct_percents: string | null;
  customer_ranks: string | null;
  customer_check: string | null;
  needs_customer_promissory: number | null;
  customer_jobs: string | null;
  process_mode: string | null;
  needs_guarantor: number | null;
  guarantor_ranks: string | null;
  guarantor_check: string | null;
  needs_guarantor_promissory: number | null;
  guarantor_jobs: string | null;
  loan_type: string | null;
  grant_days: string | null;
  needs_account_turnover: number | null;
  needs_avg_balance: number | null;
  notes: string | null;
  active: number | null;
  created_at: string;
  prepayment_percents: string | null;
  deposit_percents: string | null;
  needs_customer_salary_deduct: number | null;
  needs_guarantor_salary_deduct: number | null;
  contract_template_id: number | null;
  primary_contract_template_id: number | null;
  invoice_template_id: number | null;
  acknowledgement_template_id: number | null;
  platform_company_name: string | null;
  goods_store_name: string | null;
  commission_percent: number | null;
  operation_costs_percent: number | null;
  granted_discount_percent: number | null;
  purchase_commission_percent: number | null;
  sales_commission_percent: number | null;
  loan_acquisition_fee_percent: number | null;
  penalty_mode: string | null;
  penalty_value: number | null;
  contract_duration_days: number | null;
};

type ConditionRow = {
  id: number;
  plan_id: number;
  max_principal: string | null;
  customer_ranks: string | null;
  installment_options: string | null;
  customer_jobs: string | null;
  collateral_type: string | null;
  needs_guarantor: number | null;
  guarantor_ranks: string | null;
  guarantor_jobs: string | null;
  guarantor_collateral_type: string | null;
  needs_customer_promissory: number | null;
  needs_guarantor_promissory: number | null;
  needs_customer_salary_deduct: number | null;
  needs_guarantor_salary_deduct: number | null;
  needs_customer_check: number | null;
  needs_guarantor_check: number | null;
  needs_military_service: number | null;
  sort_order: number;
  notes: string | null;
};

type UserRow = {
  id: number;
  username: string;
  full_name: string | null;
  mobile: string | null;
  telegram_id: string | null;
  role: string;
  role_name: string | null;
  salesperson_id: number | null;
  salesperson_name: string | null;
  active: number;
  created_at: string;
};

type ReminderRow = {
  id: number;
  user_id: number;
  salesperson_id: number | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_salesperson_name: string | null;
  subject: string | null;
  message: string;
  remind_at: string;
  notified_at: string | null;
  sent_sms: number;
  done: number;
  created_at: string;
};

function customerFromRow(row: CustomerRow) {
  const id = Number(row.id);
  return {
    id,
    portalOrigin: isPortalRegistration(id),
    name: row.name,
    phone: row.phone,
    description: row.description ?? null,
    createdAt: row.created_at,
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    salespersonName: row.salesperson_name ?? null,
    priority: row.priority == null ? null : Number(row.priority),
    status: row.status ?? "in_progress",
    activityCount: Number(row.activity_count ?? 0),
    lastActivityAt: row.last_activity_at ?? null,
    lastCallAt: row.last_call_at ?? null,
    nationalCode: row.national_code ?? null,
    creditScore: row.credit_score == null ? null : Number(row.credit_score),
    creditRank: row.credit_rank ?? null,
    creditCheckedAt: row.credit_checked_at ?? null,
    birthDateJalali: row.birth_date_jalali ?? null,
    postalCode: row.postal_code ?? null,
    fatherName: row.father_name ?? null,
    address: row.address ?? null,
    email: row.email ?? null,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    verificationStatus:
      row.verification_status === "verified" ? "verified" : "unverified",
    verificationCheckedAt: row.verification_checked_at ?? null,
    verificationChecks: {
      shahkarLite: { ok: Boolean(row.shahkar_ok), providerStatus: row.shahkar_status ?? null },
      personInfo: { ok: Boolean(row.person_info_ok), providerStatus: row.person_info_status ?? null },
      postalCodeInfo: { ok: Boolean(row.postal_code_info_ok), providerStatus: row.postal_code_info_status ?? null },
      sana: { ok: Boolean(row.sana_ok), providerStatus: row.sana_status ?? null },
    },
    officialFirstName: row.official_first_name ?? null,
    officialLastName: row.official_last_name ?? null,
    officialFatherName: row.official_father_name ?? null,
    officialAddress: row.official_address ?? null,
    officialPostalCode: row.official_postal_code ?? null,
    isUrgent: Boolean(row.is_urgent),
    mergedIntoCustomerId: row.merged_into_customer_id == null ? null : Number(row.merged_into_customer_id),
    tags: customerTags(id),
    pendingRepeatRequestCount: customerPendingRepeatRequestCount(id),
  };
}

function activityFromRow(row: ActivityRow) {
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    salespersonName: row.salesperson_name ?? null,
    subject: row.subject ?? null,
    customerRequest: row.customer_request ?? null,
    expertNotes: row.expert_notes ?? null,
    createdAt: row.created_at,
  };
}

function callFromRow(row: CallRecordRow) {
  return {
    ...activityFromRow(row),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerSalespersonName: row.customer_salesperson_name ?? null,
    extension: row.call_extension ?? null,
  };
}

export function consultationFromRow(row: ConsultationRow) {
  const snapshot = row as ConsultationRow & { created_at?: string | null; questionnaire_version?: number };
  const preliminary = (snapshot.questionnaire_version ?? 0) >= 1;
  const bool = (value: number | null) =>
    value == null ? null : Boolean(value);
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerSalespersonName: row.customer_salesperson_name ?? null,
    hasCheck: bool(row.has_check),
    hasPromissory: snapshot.questionnaire_version === 1 ? null : bool(row.has_promissory),
    hasGuarantor: bool(row.has_guarantor),
    hasGuarantorCheck: bool(row.has_guarantor_check),
    hasGuarantorPromissory: snapshot.questionnaire_version === 1 ? null : bool(row.has_guarantor_promissory),
    jobType: row.job_type ?? null,
    hasBusinessLicense: bool(row.has_business_license),
    hasAccountTurnover: bool(row.has_account_turnover),
    // Declared rank belongs to this advice snapshot, not the verified credit profile.
    creditRank: preliminary ? row.credit_rank ?? null : row.customer_credit_rank ?? null,
    questionnaireVersion: snapshot.questionnaire_version ?? 0,
    createdAt: snapshot.created_at ?? row.updated_at,
    needsFastReceive: bool(row.needs_fast_receive),
    hasAvgBalance: bool(row.has_avg_balance),
    loanPurpose: row.loan_purpose ?? null,
    requestedAmount: row.requested_amount ?? null,
    extraNotes: row.extra_notes ?? null,
    guarantorCreditRank: row.guarantor_credit_rank ?? null,
    guarantorCheckType: row.guarantor_check_type ?? null,
    guarantorJobType: row.guarantor_job_type ?? null,
    collateralType: row.collateral_type ?? null,
    guarantorCollateralType: row.guarantor_collateral_type ?? null,
    customerCheckStatus: row.customer_check_status ?? null,
    receiveMode: row.receive_mode ?? null,
    loanPref: row.loan_pref ?? null,
    needDays: row.need_days ?? null,
    hasCustomerSalaryDeduct: bool(row.has_customer_salary_deduct),
    hasGuarantorSalaryDeduct: bool(row.has_guarantor_salary_deduct),
    updatedAt: row.updated_at,
  };
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function planConditions(planId: number) {
  return queryRows<ConditionRow>(
    `
      SELECT id, plan_id, max_principal, customer_ranks, installment_options,
        customer_jobs, collateral_type, needs_guarantor, guarantor_ranks,
        guarantor_jobs, guarantor_collateral_type,
        needs_customer_promissory, needs_guarantor_promissory,
        needs_customer_salary_deduct, needs_guarantor_salary_deduct,
        needs_customer_check, needs_guarantor_check, needs_military_service, sort_order, notes
      FROM loan_plan_conditions
      WHERE plan_id = ?
      ORDER BY sort_order, id
    `,
    [planId],
  ).map((row) => ({
    id: Number(row.id),
    planId: Number(row.plan_id),
    maxPrincipal: row.max_principal ?? null,
    customerRanks: row.customer_ranks ?? null,
    installmentOptions: parseJsonArray<number>(row.installment_options),
    customerJobs: parseJsonArray<string>(row.customer_jobs),
    collateralType: row.collateral_type ?? null,
    needsGuarantor: Boolean(row.needs_guarantor),
    guarantorRanks: row.guarantor_ranks ?? null,
    guarantorJobs: parseJsonArray<string>(row.guarantor_jobs),
    guarantorCollateralType: row.guarantor_collateral_type ?? null,
    needsCustomerPromissory: Boolean(row.needs_customer_promissory),
    needsGuarantorPromissory: Boolean(row.needs_guarantor_promissory),
    needsCustomerSalaryDeduct: Boolean(row.needs_customer_salary_deduct),
    needsGuarantorSalaryDeduct: Boolean(row.needs_guarantor_salary_deduct),
    needsCustomerCheck: Boolean(row.needs_customer_check),
    needsGuarantorCheck: Boolean(row.needs_guarantor_check),
    needsMilitaryService: Number(row.needs_military_service ?? 0) === 1,
    sortOrder: Number(row.sort_order),
    notes: row.notes ?? null,
  }));
}

function planFromRow(row: LoanPlanRow) {
  return {
    id: Number(row.id),
    name: row.name,
    filingFeeToman: row.filing_fee_toman ?? "0",
    bankName: row.bank_name ?? null,
    platformName: row.platform_name ?? null,
    principalAmount: row.principal_amount ?? null,
    annualInterest: row.annual_interest ?? null,
    installments: row.installments ?? null,
    installmentTerms: parseJsonArray<{
      installments: number;
      prepaymentPercent: number;
      deductionPercent: number;
      depositPercent: number;
    }>(row.installment_terms),
    requiredDocuments: parseJsonArray<string>(row.required_documents),
    deductPercents: row.deduct_percents ?? null,
    customerRanks: row.customer_ranks ?? null,
    customerCheck: row.customer_check ?? null,
    needsCustomerPromissory: Boolean(row.needs_customer_promissory),
    customerJobs: row.customer_jobs ?? null,
    processMode: row.process_mode ?? null,
    needsGuarantor: Boolean(row.needs_guarantor),
    guarantorRanks: row.guarantor_ranks ?? null,
    guarantorCheck: row.guarantor_check ?? null,
    needsGuarantorPromissory: Boolean(row.needs_guarantor_promissory),
    guarantorJobs: row.guarantor_jobs ?? null,
    loanType: row.loan_type ?? null,
    grantDays: row.grant_days ?? null,
    needsAccountTurnover: Boolean(row.needs_account_turnover),
    needsAvgBalance: Boolean(row.needs_avg_balance),
    notes: row.notes ?? null,
    prepaymentPercents: row.prepayment_percents ?? null,
    depositPercents: row.deposit_percents ?? null,
    needsCustomerSalaryDeduct: Boolean(row.needs_customer_salary_deduct),
    needsGuarantorSalaryDeduct: Boolean(row.needs_guarantor_salary_deduct),
    contractTemplateId: row.contract_template_id ?? row.primary_contract_template_id ?? null,
    primaryContractTemplateId: row.primary_contract_template_id ?? null,
    invoiceTemplateId: row.invoice_template_id ?? null,
    acknowledgementTemplateId: row.acknowledgement_template_id ?? null,
    platformCompanyName: row.platform_company_name ?? null,
    goodsStoreName: row.goods_store_name ?? null,
    commissionPercent: row.commission_percent ?? null,
    operationCostsPercent: row.operation_costs_percent ?? null,
    grantedDiscountPercent: row.granted_discount_percent ?? null,
    purchaseCommissionPercent: row.purchase_commission_percent ?? null,
    salesCommissionPercent: row.sales_commission_percent ?? null,
    loanAcquisitionFeePercent: row.loan_acquisition_fee_percent ?? null,
    penaltyMode: row.penalty_mode ?? null,
    penaltyValue: row.penalty_value ?? null,
    contractDurationDays: row.contract_duration_days ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    conditions: planConditions(Number(row.id)),
  };
}

type LoanPlan = ReturnType<typeof planFromRow>;

function publicPlanSummary(plan: LoanPlan) {
  return {
    id: plan.id,
    name: plan.name,
    bankName: plan.bankName,
    platformName: plan.platformName,
    principalAmount: plan.principalAmount,
    annualInterest: plan.annualInterest,
    installments: plan.installments,
    installmentTerms: plan.installmentTerms,
    loanType: plan.loanType,
    processMode: plan.processMode,
    grantDays: plan.grantDays,
    notes: plan.notes,
    // Derived from the plan's eligibility conditions (see public-plan-guarantees).
    ...publicPlanGuarantees(plan),
  };
}

function publicPlanDetails(plan: LoanPlan) {
  return {
    ...publicPlanSummary(plan),
    contractTemplateId: plan.contractTemplateId,
    platformCompanyName: plan.platformCompanyName,
    goodsStoreName: plan.goodsStoreName,
    commissionPercent: plan.commissionPercent,
    operationCostsPercent: plan.operationCostsPercent,
    grantedDiscountPercent: plan.grantedDiscountPercent,
    purchaseCommissionPercent: plan.purchaseCommissionPercent,
    salesCommissionPercent: plan.salesCommissionPercent,
    loanAcquisitionFeePercent: plan.loanAcquisitionFeePercent,
    penaltyMode: plan.penaltyMode,
    penaltyValue: plan.penaltyValue,
    contractDurationDays: plan.contractDurationDays,
    requiredDocuments: plan.requiredDocuments.map(key => {
      const configured = queryRow<{ label: string }>(
        "SELECT label_fa AS label FROM consult_options WHERE field_key='required_document' AND option_value=? LIMIT 1",
        [key],
      )?.label;
      return publicDocumentLabel(key, configured);
    }),
    deductPercents: plan.deductPercents,
    customerRanks: plan.customerRanks,
    customerCheck: plan.customerCheck,
    needsCustomerPromissory: plan.needsCustomerPromissory,
    customerJobs: plan.customerJobs,
    needsGuarantor: plan.needsGuarantor,
    guarantorRanks: plan.guarantorRanks,
    guarantorCheck: plan.guarantorCheck,
    needsGuarantorPromissory: plan.needsGuarantorPromissory,
    guarantorJobs: plan.guarantorJobs,
    needsAccountTurnover: plan.needsAccountTurnover,
    needsAvgBalance: plan.needsAvgBalance,
    prepaymentPercents: plan.prepaymentPercents,
    depositPercents: plan.depositPercents,
    needsCustomerSalaryDeduct: plan.needsCustomerSalaryDeduct,
    needsGuarantorSalaryDeduct: plan.needsGuarantorSalaryDeduct,
    conditions: plan.conditions,
  };
}

function userFromRow(row: UserRow) {
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name ?? null,
    mobile: row.mobile ?? null,
    telegramId: row.telegram_id ?? null,
    voipExtension: queryRow<{ extension: string | null }>(
      "SELECT extension FROM voip_extensions WHERE user_id=?", [row.id],
    )?.extension ?? null,
    role: row.role,
    roleName: row.role_name ?? row.role,
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    salespersonName: row.salesperson_name ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function reminderFromRow(row: ReminderRow, user: AuthUser) {
  const storedCallId = queryRow<{ call_id: number | null }>("SELECT call_id FROM reminders WHERE id=?", [row.id])?.call_id;
  const canReadCalls = user.role === "admin" || user.permissions.includes("calls.view");
  const callScope = callHistoryScope(user);
  const sourceCall = storedCallId != null && canReadCalls && row.customer_id != null
    ? queryRow<{ id: number; subject: string | null; customer_request: string | null; expert_notes: string | null; salesperson_name: string | null; created_at: string }>(
      `SELECT cl.id,cl.subject,cl.customer_request,cl.expert_notes,cl.created_at,
        COALESCE(cl.salesperson_name_snapshot,s.name) AS salesperson_name
       FROM call_logs cl JOIN customers c ON c.id=cl.customer_id
       LEFT JOIN salespersons s ON s.id=cl.salesperson_id
       WHERE cl.id=? AND cl.customer_id=?${callScope.sql ? ` AND (${callScope.sql})` : ""}`,
      [storedCallId,row.customer_id,...callScope.params],
    ) : undefined;
  const sms = queryRow<{ status: "pending" | "sending" | "sent" | "blocked" | "rejected" | "uncertain" | "legacy_skipped"; error_code: string | null }>(
    "SELECT status,error_code FROM reminder_sms_deliveries WHERE reminder_id=?", [row.id],
  );
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name ?? null,
    customerSalespersonName: row.customer_salesperson_name ?? null,
    subject: row.subject || row.message.slice(0, 80),
    message: row.message,
    remindAt: row.remind_at,
    notifiedAt: row.notified_at ?? null,
    smsSent: Boolean(row.sent_sms),
    done: Boolean(row.done),
    createdAt: row.created_at,
    sourceCall: sourceCall ? {
      id: Number(sourceCall.id), subject: sourceCall.subject,
      customerRequest: sourceCall.customer_request, expertNotes: sourceCall.expert_notes,
      salespersonName: sourceCall.salesperson_name, createdAt: sourceCall.created_at,
    } : null,
    callHistoryStatus: sourceCall ? "available" as const : storedCallId != null && !sourceCall ? "restricted" as const : "none" as const,
    smsStatus: Boolean(row.sent_sms) ? "sent" as const : sms?.status ?? "pending" as const,
    smsError: sms?.error_code ?? null,
  };
}

const customerSelect = `
  SELECT
    c.id,
    c.name,
    c.phone,
    c.description,
    c.national_code,
    c.credit_score,
    c.credit_rank,
    c.credit_checked_at,
    c.birth_date_jalali,
    c.postal_code,
    c.father_name,
    c.address,
    c.email,
    c.first_name,
    c.last_name,
    c.verification_status,
    c.verification_checked_at,
    c.shahkar_status,
    c.person_info_status,
    c.postal_code_info_status,
    c.sana_status,
    c.shahkar_ok,
    c.person_info_ok,
    c.postal_code_info_ok,
    c.sana_ok,
    c.official_first_name,
    c.official_last_name,
    c.official_father_name,
    c.official_address,
    c.official_postal_code,
    c.is_urgent,
    c.created_at,
    c.salesperson_id,
    c.merged_into_customer_id,
    s.name AS salesperson_name,
    c.priority,
    COALESCE(c.status, 'in_progress') AS status,
    COUNT(cl.id) AS activity_count,
    MAX(cl.created_at) AS last_activity_at,
    (SELECT latest_call.created_at FROM call_logs latest_call
      WHERE latest_call.customer_id=c.id AND julianday(latest_call.created_at) IS NOT NULL
      ORDER BY julianday(latest_call.created_at) DESC, latest_call.id DESC LIMIT 1) AS last_call_at
  FROM customers c
  LEFT JOIN salespersons s ON s.id = c.salesperson_id
  LEFT JOIN call_logs cl ON cl.customer_id = c.id
`;

router.get(
  "/customers/phone-match",
  requirePermission("customers.create"),
  (req, res): void => {
    const parsed = LookupCustomerByPhoneQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const row = findCustomerByPhone(parsed.data.phone);
    res.json(LookupCustomerByPhoneResponse.parse({
      customer: row ? customerFromRow(row) : null,
    }));
  },
);

router.post(
  "/customers/repeat-requests",
  requirePermission("customers.create"),
  (req, res): void => {
    const parsed = CreateCustomerRepeatRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    if (!body.explanation.trim() || !body.requestedName.trim()) {
      res.status(400).json({ error: "Requested name and explanation must not be blank" });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    let requestId: number;
    try {
      requestId = runTransaction(() => {
        const customer = findCustomerByPhone(body.phone);
        if (!customer) throw new Error("REPEAT_REQUEST_CUSTOMER_NOT_FOUND");
        const createdAt = new Date().toISOString();
        const id = execute(
          `INSERT INTO customer_repeat_requests
           (customer_id,requested_name,submitted_description,explanation,status,created_by_user_id,created_at)
           VALUES (?,?,?,?, 'pending',?,?)`,
          [
            customer.id,
            body.requestedName.trim(),
            body.submittedDescription ?? null,
            body.explanation.trim(),
            user.id,
            createdAt,
          ],
        );
        execute(
          "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES(?,'repeat_request',?)",
          [customer.id, createdAt],
        );
        return id;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "REPEAT_REQUEST_CUSTOMER_NOT_FOUND") {
        res.status(404).json({ error: "No active customer matches this phone" });
        return;
      }
      throw error;
    }
    const row = queryRow<{
      id: number; customer_id: number; requested_name: string;
      submitted_description: string | null; explanation: string; status: string;
      created_by_user_id: number | null; created_by_name: string | null;
      provenance: string; source_thread_id: number | null; source_message_id: string | null;
      created_at: string; acknowledged_at: string | null;
    }>(
      `SELECT r.*,u.full_name AS created_by_name
       FROM customer_repeat_requests r LEFT JOIN users u ON u.id=r.created_by_user_id
       WHERE r.id=?`,
      [requestId],
    );
    if (!row) {
      res.status(500).json({ error: "Repeat request was not recorded" });
      return;
    }
    res.status(201).json(CreateCustomerRepeatRequestResponse.parse({
      id: Number(row.id),
      customerId: Number(row.customer_id),
      requestedName: row.requested_name,
      submittedDescription: row.submitted_description,
      explanation: row.explanation,
      status: row.status,
      createdByUserId: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
      createdByName: row.created_by_name ?? null,
      provenance: row.provenance,
      sourceThreadId: row.source_thread_id == null ? null : Number(row.source_thread_id),
      sourceMessageId: row.source_message_id ?? null,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    }));
  },
);

router.get("/customer-tags", requirePermission("customers.view"), (_req, res): void => {
  const tags = queryRows<{ tag: string; label_fa: string }>(
    "SELECT tag,label_fa FROM customer_tag_catalog ORDER BY tag",
  ).map((row) => ({ key: row.tag, label: row.label_fa }));
  res.json(ListCustomerTagsResponse.parse(tags));
});

router.post("/customer-tags", requirePermission("customers.update"), (req, res): void => {
  const parsed = CreateCustomerTagBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const label = parsed.data.label.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!label) {
    res.status(400).json({ error: "Tag label must not be blank" });
    return;
  }
  const canonicalLabel = label.toLocaleLowerCase("fa");
  if (queryRow("SELECT tag FROM customer_tag_catalog WHERE canonical_label=?", [canonicalLabel])) {
    res.status(409).json({ error: "A customer tag with this label already exists" });
    return;
  }
  let key: string;
  try {
    key = runTransaction(() => {
      let customKey = "";
      do {
        customKey = `custom_${randomUUID().replaceAll("-", "")}`;
      } while (queryRow("SELECT tag FROM customer_tag_catalog WHERE tag=?", [customKey]));
      execute(
        "INSERT INTO customer_tag_catalog(tag,label_fa,canonical_label) VALUES(?,?,?)",
        [customKey, label, canonicalLabel],
      );
      return customKey;
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      res.status(409).json({ error: "A customer tag with this label already exists" });
      return;
    }
    throw error;
  }
  res.status(201).json(CreateCustomerTagResponse.parse({ key, label }));
});

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

function normalizeJalaliDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = normalizeDigits(value).trim().replace(/[-.]/g, "/");
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalized);
  if (!match) throw new Error("تاریخ تولد جلالی باید به شکل YYYY/MM/DD باشد.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const today = new Date();
  const formatter = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  });
  const currentYear = Number(
    formatter.formatToParts(today).find((part) => part.type === "year")?.value,
  );
  if (
    year < 1200 ||
    year > currentYear ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    throw new Error("تاریخ تولد جلالی معتبر نیست.");
  }
  // Validate against the runtime's actual Persian calendar conversion rather
  // than a 33-year leap approximation. Search only the relevant Gregorian
  // year, which is bounded to at most 367 dates.
  const target = `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  // A Persian year starts around March 20/21 and ends in March of the next
  // Gregorian year. Start shortly before Nowruz and scan far enough to include
  // the final months (Dey through Esfand) in the following Gregorian year.
  const start = Date.UTC(year + 621, 1, 15);
  let valid = false;
  for (let offset = 0; offset < 410; offset += 1) {
    const candidate = new Date(start + offset * 86400000);
    const parts = formatter.formatToParts(candidate);
    const actual = `${parts.find((part) => part.type === "year")?.value}/${parts.find((part) => part.type === "month")?.value}/${parts.find((part) => part.type === "day")?.value}`;
    if (actual === target) {
      valid = candidate <= today;
      break;
    }
  }
  if (!valid) throw new Error("تاریخ تولد جلالی معتبر نیست.");
  return `${match[1]}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function normalizePostalCode(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const digits = normalizeDigits(value).replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(digits))
    throw new Error("کد پستی باید دقیقا ۱۰ رقم باشد.");
  return digits;
}

export function getCustomer(id: number, user?: AuthUser, includeArchivedReadOnly = false) {
  const ownerFilter =
    user?.customerScope === "assigned" ? " AND c.salesperson_id = ?" : "";
  const archiveFilter = includeArchivedReadOnly && user && isAdminRole(user.role)
    ? ""
    : " AND c.merged_into_customer_id IS NULL";
  const row = queryRow<CustomerRow>(
    `${customerSelect} WHERE c.id = ?${ownerFilter}${archiveFilter} GROUP BY c.id ORDER BY c.created_at DESC`,
    user?.customerScope === "assigned" ? [id, user.salespersonId] : [id],
  );
  return row ? customerFromRow(row) : undefined;
}

type AllocationProgramItemRow = {
  salesperson_id: number;
  salesperson_name: string;
  quota: number;
  sort_order: number;
};

function getAllocationProgram(id: number) {
  const program = queryRow<{
    id: number;
    name: string;
    is_default: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, is_default, created_at, updated_at
     FROM allocation_programs WHERE id = ? AND active = 1`,
    [id],
  );
  if (!program) return undefined;
  const items = queryRows<AllocationProgramItemRow>(
    `SELECT api.salesperson_id, s.name AS salesperson_name, api.quota, api.sort_order
     FROM allocation_program_items api
     JOIN salespersons s ON s.id = api.salesperson_id
     WHERE api.program_id = ?
     ORDER BY api.sort_order, api.id`,
    [id],
  );
  return {
    id: Number(program.id),
    name: program.name,
    isDefault: Boolean(program.is_default),
    items: items.map((item) => ({
      salespersonId: Number(item.salesperson_id),
      salespersonName: item.salesperson_name,
      quota: Number(item.quota),
      sortOrder: Number(item.sort_order),
    })),
    createdAt: program.created_at,
    updatedAt: program.updated_at,
  };
}

function getActivity(customerId: number) {
  return queryRows<ActivityRow>(
    `
      SELECT
        cl.id,
        cl.customer_id,
        cl.salesperson_id,
        cl.salesperson_name_snapshot AS salesperson_name,
        cl.subject,
        cl.customer_request,
        cl.expert_notes,
        cl.created_at
      FROM call_logs cl
      WHERE cl.customer_id = ?
      ORDER BY cl.created_at DESC
    `,
    [customerId],
  ).map(activityFromRow);
}

router.get(
  "/crm/summary",
  requirePermission("dashboard.view"),
  (req, res): void => {
    const user = res.locals.authUser as AuthUser;
    const salespersonId =
      user.customerScope === "assigned" ? user.salespersonId : null;
    const customerScope =
      user.customerScope === "assigned" ? " WHERE salesperson_id = ?" : "";
    const customerScopeAnd =
      user.customerScope === "assigned" ? " AND salesperson_id = ?" : "";
    const customerParams: SqlValue[] =
      user.customerScope === "assigned" ? [salespersonId] : [];
    const totals = queryRow<{
      total_customers: number;
      active_customers: number;
      open_reminders: number;
      total_calls: number;
    }>(
      `
    SELECT
      (SELECT COUNT(*) FROM customers${customerScope}) AS total_customers,
      (SELECT COUNT(*) FROM customers WHERE COALESCE(status, 'in_progress') = 'in_progress'${customerScopeAnd}) AS active_customers,
      (SELECT COUNT(*) FROM reminders WHERE done = 0 AND user_id = ?) AS open_reminders,
      (SELECT COUNT(*) FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
        ${user.customerScope === "assigned" ? "WHERE c.salesperson_id = ?" : ""}) AS total_calls
  `,
      [...customerParams, ...customerParams, user.id, ...customerParams],
    );
    const statusCounts = queryRows<{ status: string; count: number }>(
      `
    SELECT COALESCE(status, 'in_progress') AS status, COUNT(*) AS count
    FROM customers
    ${customerScope}
    GROUP BY COALESCE(status, 'in_progress')
    ORDER BY count DESC
  `,
      customerParams,
    );
    const priorityCounts = queryRows<{ priority: number; count: number }>(
      `
    SELECT COALESCE(priority, 0) AS priority, COUNT(*) AS count
    FROM customers
    WHERE COALESCE(status, 'in_progress') = 'in_progress'${customerScopeAnd}
    GROUP BY COALESCE(priority, 0)
    ORDER BY priority DESC
  `,
      customerParams,
    );
    const recentActivity = queryRows<ActivityRow>(
      `
    SELECT
      cl.id,
      cl.customer_id,
      cl.salesperson_id,
      s.name AS salesperson_name,
      cl.subject,
      cl.customer_request,
      cl.expert_notes,
      cl.created_at
    FROM call_logs cl
    JOIN customers c ON c.id = cl.customer_id
    LEFT JOIN salespersons s ON s.id = cl.salesperson_id
    ${user.customerScope === "assigned" ? "WHERE c.salesperson_id = ?" : ""}
    ORDER BY cl.created_at DESC
    LIMIT 6
  `,
      customerParams,
    ).map(activityFromRow);

    res.json(
      GetCrmSummaryResponse.parse({
        totalCustomers: Number(totals?.total_customers ?? 0),
        activeCustomers: Number(totals?.active_customers ?? 0),
        openReminders: Number(totals?.open_reminders ?? 0),
        totalCalls: Number(totals?.total_calls ?? 0),
        statusCounts: statusCounts.map((item) => ({
          status: item.status,
          count: Number(item.count),
        })),
        priorityCounts: priorityCounts.map((item) => ({
          priority: Number(item.priority),
          count: Number(item.count),
        })),
        recentActivity,
      }),
    );
  },
);

router.get(
  "/customers",
  requirePermission("customers.view"),
  (req, res): void => {
    const parsed = ListCustomersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const {
      search,
      customerId,
      status,
      priority,
      hasPriority: parsedHasPriority,
      salespersonId,
      dateFrom,
      dateTo,
      minCallCount,
      maxCallCount,
      tag,
    } = parsed.data;
    const hasPriority =
      req.query.hasPriority === "false"
        ? false
        : req.query.hasPriority === "true"
          ? true
          : parsedHasPriority;
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const filters: string[] = ["c.merged_into_customer_id IS NULL"];
    const params: SqlValue[] = [];
    const user = res.locals.authUser as AuthUser;
    if (user.customerScope === "assigned") {
      filters.push("c.salesperson_id = ?");
      params.push(user.salespersonId);
    }

    const idSearch = search ? customerSearchSql(search) : null;
    if (search && idSearch) {
      const clause = idSearch.where(
        "(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ?)",
        [`%${idSearch.text}%`, `%${idSearch.text}%`],
        "c.id",
      );
      filters.push(clause.sql);
      params.push(...clause.params);
    }
    if (customerId !== undefined) {
      filters.push("c.id = ?");
      params.push(customerId);
    }
    if (tag) {
      filters.push("EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id=c.id AND ct.tag=?)");
      params.push(tag);
    }
    if (status) {
      if (status === "in_progress") {
        filters.push(`(
          COALESCE(c.status, 'in_progress') = ?
          OR (
            COALESCE(c.status, 'in_progress') = 'cancelled'
            AND EXISTS (SELECT 1 FROM customer_tags pending_tag
              WHERE pending_tag.customer_id=c.id AND pending_tag.tag='repeat_request')
            AND EXISTS (SELECT 1 FROM customer_repeat_requests pending_request
              WHERE pending_request.customer_id=c.id AND pending_request.status='pending')
          )
        )`);
        params.push(status);
      } else {
        filters.push("COALESCE(c.status, 'in_progress') = ?");
        params.push(status);
      }
    }
    if (priority !== undefined) {
      filters.push("c.priority = ?");
      params.push(priority);
    } else if (hasPriority === false) {
      filters.push("c.priority IS NULL");
    } else if (hasPriority === true) {
      filters.push("c.priority IS NOT NULL");
    }
    if (salespersonId !== undefined && user.customerScope !== "assigned") {
      filters.push("c.salesperson_id = ?");
      params.push(salespersonId);
    }
    // crm-kazemi-source: «منبع: همه / از کاظمی / مشتری قبلی» (display-only filter; read from the raw query, zod strips it).
    const sourceFilter = kazemiSourceFilterSql(req.query.source);
    if (sourceFilter) {
      filters.push(sourceFilter.sql);
      params.push(...sourceFilter.params);
    }
    if (dateFrom) {
      filters.push("date(c.created_at) >= date(?)");
      params.push(dateFrom);
    }
    if (dateTo) {
      filters.push("date(c.created_at) <= date(?)");
      params.push(dateTo);
    }

    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const havingFilters: string[] = [];
    const havingParams: SqlValue[] = [];
    if (minCallCount !== undefined) {
      havingFilters.push("COUNT(cl.id) >= ?");
      havingParams.push(minCallCount);
    }
    if (maxCallCount !== undefined) {
      havingFilters.push("COUNT(cl.id) <= ?");
      havingParams.push(maxCallCount);
    }
    const having = havingFilters.length
      ? ` HAVING ${havingFilters.join(" AND ")}`
      : "";
    const totalRow = queryRow<{ total: number }>(
      `SELECT COUNT(*) AS total FROM (
      SELECT c.id
      FROM customers c
      LEFT JOIN call_logs cl ON cl.customer_id = c.id
      ${where}
      GROUP BY c.id
      ${having}
    ) filtered_customers`,
      [...params, ...havingParams],
    );
    const orderBy = parsed.data.sortBy === "lastCallAt"
      ? `(last_call_at IS NULL) ASC, julianday(last_call_at) ${parsed.data.sortDirection === "asc" ? "ASC" : "DESC"}, c.id DESC`
      : parsed.data.sortBy === "boardTags"
      ? `CASE
          WHEN EXISTS (SELECT 1 FROM customer_portal_registrations portal_origin WHERE portal_origin.customer_id=c.id) THEN 0
          WHEN EXISTS (SELECT 1 FROM customer_tags board_tag WHERE board_tag.customer_id=c.id AND board_tag.tag='repeat_request') THEN 1
          WHEN c.is_urgent=1 THEN 2
          ELSE 3
        END ASC, c.created_at DESC, c.id DESC`
      : `(c.priority IS NOT NULL) ASC, CASE
          WHEN EXISTS (SELECT 1 FROM customer_portal_registrations portal_origin WHERE portal_origin.customer_id=c.id) THEN 0
          WHEN EXISTS (SELECT 1 FROM customer_tags board_tag WHERE board_tag.customer_id=c.id AND board_tag.tag='repeat_request') THEN 1
          WHEN c.is_urgent=1 THEN 2
          ELSE 3
        END ASC, c.created_at DESC, c.id DESC`;
    const rows = queryRows<CustomerRow>(
      `${customerSelect}${where} GROUP BY c.id${having} ORDER BY ${idSearch?.orderPrefix("c.id").sql ?? ""}${orderBy} LIMIT ? OFFSET ?`,
      [...params, ...havingParams, ...(idSearch?.orderPrefix("c.id").params ?? []), limit, offset],
    );

    const listBody = ListCustomersResponse.parse({
      items: rows.map(customerFromRow),
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
    });
    // crm-call-form-plans: plans picked in the latest first-call form (added after the zod parse, which strips unknown keys).
    const suggested = latestSelectedPlans(listBody.items.map((item) => Number(item.id)));
    // crm-id-search-everywhere: a salesperson's exact id / mobile / full-name search also returns
    // other salespersons' matches as minimal faded hints (id, name, owner) — after their own rows.
    const crossOwner = search && offset === 0 && customerId === undefined && crossOwnerEligible(user)
      ? findOtherOwnerMatches(user, search)
      : null;
    // crm-no-plan-option: grey «بدون طرح مناسب» chip.
    const noPlan = latestNoPlanFit(listBody.items.map((item) => Number(item.id)));
    // crm-kazemi-source: «از کاظمی» / «مشتری قبلی» chip (null = no chip).
    const sources = kazemiSources(listBody.items.map((item) => Number(item.id)));
    res.json({
      ...listBody,
      items: listBody.items.map((item) => ({ ...item, suggestedPlans: suggested.get(Number(item.id)) ?? [], noPlanFit: noPlan.has(Number(item.id)),
        kazemiSource: sources.get(Number(item.id)) ?? null })),
      ...(crossOwner ? { otherOwnerMatches: crossOwner.items, otherOwnerLimited: crossOwner.limited } : {}),
    });
  },
);

router.post(
  "/customers/parse-text",
  requirePermission("customers.create"),
  async (req, res): Promise<void> => {
    const parsed = ParseCustomerTextBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const normalizeDigits = (value: string) =>
      value
        .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
        .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
    const lines = normalizeDigits(parsed.data.text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const phoneLineIndex = lines.findIndex((line) => {
      const digits = line.replace(/[^\d+]/g, "");
      return /^(?:\+98|0098|98|0)?9\d{9}$/.test(digits);
    });
    const rawPhone =
      phoneLineIndex >= 0 ? lines[phoneLineIndex].replace(/[^\d+]/g, "") : "";
    const phone = rawPhone
      .replace(/^(?:\+98|0098|98)(?=9\d{9}$)/, "0")
      .replace(/[^\d]/g, "");
    let nameLineIndex = -1;
    let name = "";
    for (let index = 0; index < lines.length; index += 1) {
      if (index === phoneLineIndex) continue;
      const candidate = lines[index]
        .replace(/^(?:سلام(?:\s+و\s+وقت\s+بخیر)?[،,\s]*)?(?:من\s+)?/u, "")
        .replace(/\s+(?:هستم|ام)\s*[.!،,]*$/u, "")
        .replace(/[.!،,؛;:]+$/u, "")
        .trim();
      const words = candidate.split(/\s+/).filter(Boolean);
      if (
        words.length >= 2 &&
        words.length <= 5 &&
        words.every((word) => /^[\u0600-\u06FF‌]+$/u.test(word))
      ) {
        nameLineIndex = index;
        name = candidate;
        break;
      }
    }
    const localDescription = lines
      .filter((_, index) => index !== phoneLineIndex && index !== nameLineIndex)
      .join("\n")
      .trim();
    if (name && /^09\d{9}$/.test(phone)) {
      res.json(
        ParseCustomerTextResponse.parse({
          name,
          phone,
          description: localDescription,
        }),
      );
      return;
    }
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You extract CRM customer fields from Persian Instagram direct messages.
Return only a JSON object with exactly these string fields: name, phone, description.
Rules:
- name: the person's full name only. Remove introductions such as سلام، من، هستم، ام.
- phone: the mobile number only, normalized to Latin digits. Keep Iranian format as 09xxxxxxxxx when possible. Never invent a number.
- description: all meaningful remaining text, excluding the extracted name/introduction and phone. Preserve the user's wording and line order as much as possible.
- If name or phone is absent or uncertain, return an empty string for that field.
- Do not infer facts that are not written in the source.`,
          },
          { role: "user", content: parsed.data.text },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) {
        res.status(502).json({ error: "AI did not return a result" });
        return;
      }
      const result = JSON.parse(content) as Record<string, unknown>;
      res.json(
        ParseCustomerTextResponse.parse({
          name: typeof result.name === "string" ? result.name.trim() : name,
          phone:
            typeof result.phone === "string"
              ? normalizeDigits(result.phone).replace(/[^\d+]/g, "")
              : phone,
          description:
            typeof result.description === "string"
              ? result.description.trim()
              : localDescription,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "customer text extraction failed");
      if (name || phone) {
        res.json(
          ParseCustomerTextResponse.parse({
            name,
            phone,
            description: localDescription,
          }),
        );
        return;
      }
      res.status(502).json({ error: "Customer text extraction failed" });
    }
  },
);

router.post(
  "/customers",
  requirePermission("customers.create"),
  (req, res): void => {
    const parsed = CreateCustomerBody.safeParse(blankNationalCodeToNull(req.body));
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    const user = res.locals.authUser as AuthUser;
    if (body.salespersonId !== undefined && user.role !== "admin") {
      res.status(403).json({ error: "Only administrators may assign a salesperson" });
      return;
    }
    if (body.salespersonId != null && !queryRow("SELECT id FROM salespersons WHERE id=?", [body.salespersonId])) {
      res.status(400).json({ error: "Salesperson does not exist" });
      return;
    }
    const nationalCode = body.nationalCode
      ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") || null
      : null;
    if (nationalCode !== null && !ics24.validNationalCode(nationalCode)) {
      res.status(400).json({ error: "کد ملی معتبر نیست." });
      return;
    }
    const phoneMatch = findCustomerByPhone(body.phone);
    if (phoneMatch) {
      res.status(409).json({
        code: "duplicate_mobile",
        customer: CreateCustomerResponse.parse(customerFromRow(phoneMatch)),
      });
      return;
    }
    if (hasActiveCustomerIdentityConflict(null, { phone: body.phone, nationalCode })) {
      res.status(409).json({ error: "An active customer already has this mobile or national code" });
      return;
    }
    let birthDateJalali: string | null;
    let postalCode: string | null;
    try {
      birthDateJalali = normalizeJalaliDate(body.birthDateJalali);
      postalCode = normalizePostalCode(body.postalCode);
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "اطلاعات پروفایل معتبر نیست.",
        });
      return;
    }
    let id: number;
    let createdNonP1: NonP1Result | null = null;
    try {
      id = runTransaction(() => {
        const newId = insertCustomerRecord({
          name: body.name,
          phone: body.phone,
          description: body.description,
          nationalCode,
          birthDateJalali,
          postalCode,
          fatherName: body.fatherName,
          address: body.address,
          email: body.email,
          isUrgent: body.isUrgent,
          salespersonId: body.salespersonId,
          allocationProgramId: body.allocationProgramId,
          priority: body.priority,
          status: body.status,
          assignedSalespersonId: user.customerScope === "assigned" ? user.salespersonId : undefined,
        });
        // crm-nonp1-to-kazemi: an expert creating a P2 / P3 customer hands it to Kazemi in the same transaction
        // (an admin's explicit salesperson choice is respected; «بدون اولویت» on create is not a priority change).
        if (body.priority != null && body.priority !== 1) {
          createdNonP1 = applyNonP1TransferInTx({
            customerId: newId, oldPriority: null, oldSalespersonId: null,
            actor: { id: user.id, role: user.role, salespersonId: user.salespersonId ?? null },
            explicitSalespersonChange: user.role === "admin" && body.salespersonId != null,
            via: "ثبت مشتری",
          });
        }
        return newId;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ALLOCATION_PROGRAM_UNAVAILABLE"
      ) {
        res
          .status(400)
          .json({ error: "Allocation program has no active salespersons" });
        return;
      }
      if (error instanceof Error && error.message.includes("ACTIVE_CUSTOMER_MOBILE_CONFLICT")) {
        const duplicate = findCustomerByPhone(body.phone);
        if (duplicate) {
          res.status(409).json({
            code: "duplicate_mobile",
            customer: CreateCustomerResponse.parse(customerFromRow(duplicate)),
          });
          return;
        }
        res.status(409).json({ error: "An active customer already has this mobile" });
        return;
      }
      if (error instanceof Error && error.message.includes("ACTIVE_CUSTOMER_NATIONAL_CODE_CONFLICT")) {
        res.status(409).json({ error: "An active customer already has this mobile or national code" });
        return;
      }
      throw error;
    }
    const transferredOnCreate = (createdNonP1 as NonP1Result | null)?.transferred === true;
    const customer = transferredOnCreate ? getCustomer(id) : getCustomer(id, user);
    if (!customer) {
      res.status(500).json({ error: "Customer was not created" });
      return;
    }
    if (transferredOnCreate) res.setHeader(NONP1_TRANSFER_HEADER, String(id));
    res.status(201).json(CreateCustomerResponse.parse(customer));
    void notifyNewCustomer(id);
  },
);

router.get(
  "/customers/:id",
  requirePermission("customers.view"),
  (req, res): void => {
    const parsed = GetCustomerParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const customer = getCustomer(
      parsed.data.id,
      res.locals.authUser as AuthUser,
      true,
    );
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json({
      ...GetCustomerResponse.parse({
        ...customer,
        activity: getActivity(parsed.data.id),
      }),
      // crm-call-form-plans: latest answered first-call form (selected plans + answers summary); null for older forms.
      firstCall: latestFirstCall(parsed.data.id),
      // crm-kazemi-source: «از کاظمی» / «مشتری قبلی» chip next to the id badge (null = no chip).
      kazemiSource: kazemiSourceOf(parsed.data.id),
      // crm-no-plan-option: city of residence (first-call form prefill); null when empty.
      city: queryRow<{ city: string | null }>("SELECT city FROM customers WHERE id=?", [parsed.data.id])?.city ?? null,
    });
  },
);

const manualSapiChecks = ["shahkarLite", "personInfo", "postalCodeInfo", "sana"] as const;
type ManualSapiCheck = typeof manualSapiChecks[number];
type ManualCustomerIdentity = {
  id: number;
  name: string;
  phone: string;
  national_code: string | null;
  birth_date_jalali: string | null;
  postal_code: string | null;
  first_name: string | null;
  last_name: string | null;
  father_name: string | null;
  address: string | null;
  official_first_name: string | null;
  official_last_name: string | null;
  official_father_name: string | null;
  official_address: string | null;
  official_postal_code: string | null;
  verification_status: string | null;
  verification_version: number;
  verification_checked_at: string | null;
  verification_provider: string | null;
  shahkar_status: string | null;
  person_info_status: string | null;
  postal_code_info_status: string | null;
  sana_status: string | null;
  shahkar_ok: number | null;
  person_info_ok: number | null;
  postal_code_info_ok: number | null;
  sana_ok: number | null;
};
type ManualRequestRow = {
  id: number;
  customer_id: number;
  requested_by_user_id: number;
  requested_by_name: string | null;
  customer_name: string;
  status: "pending" | "approved" | "system_verified" | "superseded";
  original_values_json: string;
  source_failures_json: string;
  created_at: string;
  source_event_id: number | null;
};
type VerificationEventRow = {
  id: number;
  national_code: string | null;
  mobile: string | null;
  checks_json: string;
  input_json: string | null;
  status: string;
  created_at: string;
};
const manualCustomerFields = `
  id,name,phone,national_code,birth_date_jalali,postal_code,first_name,last_name,father_name,address,
  official_first_name,official_last_name,official_father_name,official_address,official_postal_code,
  verification_status,verification_version,shahkar_status,person_info_status,postal_code_info_status,sana_status,
  verification_checked_at,verification_provider,shahkar_ok,person_info_ok,postal_code_info_ok,sana_ok`;
function manualCustomer(id: number): ManualCustomerIdentity | undefined {
  return queryRow<ManualCustomerIdentity>(
    `SELECT ${manualCustomerFields} FROM customers WHERE id=? AND merged_into_customer_id IS NULL`,
    [id],
  );
}
function manualProfileSnapshot(customer: ManualCustomerIdentity) {
  return {
    name: customer.name,
    phone: customer.phone,
    nationalCode: customer.national_code,
    birthDateJalali: customer.birth_date_jalali,
    postalCode: customer.postal_code,
    firstName: customer.first_name,
    lastName: customer.last_name,
    fatherName: customer.father_name,
    address: customer.address,
    officialFirstName: customer.official_first_name,
    officialLastName: customer.official_last_name,
    officialFatherName: customer.official_father_name,
    officialAddress: customer.official_address,
    officialPostalCode: customer.official_postal_code,
  };
}
function currentManualChecks(customer: ManualCustomerIdentity) {
  const status = (ok: boolean, providerStatus: string | null) => ({
    ok,
    status: ok
      ? providerStatus === "manual_verified" ? "manual_verified" : "verified"
      : providerStatus === "manual_rejected" ? "manual_rejected" : providerStatus === "unavailable" ? "unavailable" : providerStatus == null ? null : "failed",
  });
  return {
    shahkarLite: status(customer.shahkar_ok === 1, customer.shahkar_status),
    personInfo: status(customer.person_info_ok === 1, customer.person_info_status),
    postalCodeInfo: status(customer.postal_code_info_ok === 1, customer.postal_code_info_status),
    sana: status(customer.sana_ok === 1, customer.sana_status),
  };
}
function getManualRequest(id: number): ManualRequestRow | undefined {
  return queryRow<ManualRequestRow>(
    `SELECT r.id,r.customer_id,r.requested_by_user_id,u.full_name AS requested_by_name,
       c.name AS customer_name,r.status,r.original_values_json,r.source_failures_json,r.created_at,r.source_event_id
     FROM customer_manual_verification_requests r
     JOIN customers c ON c.id=r.customer_id
     LEFT JOIN users u ON u.id=r.requested_by_user_id
     WHERE r.id=?`,
    [id],
  );
}
function manualRequestResponse(row: ManualRequestRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    sourceFailures: JSON.parse(row.source_failures_json) as ManualSapiCheck[],
    createdAt: row.created_at,
    requestedByUserId: row.requested_by_user_id,
    requestedByName: row.requested_by_name,
    originalValues: JSON.parse(row.original_values_json) as Record<string, unknown>,
  };
}
function latestVerificationEvent(customerId: number): VerificationEventRow | undefined {
  return queryRow<VerificationEventRow>(
    `SELECT id,national_code,mobile,checks_json,input_json,status,created_at
     FROM customer_verification_events WHERE customer_id=? AND is_current=1 ORDER BY id DESC LIMIT 1`,
    [customerId],
  );
}
function parseEventChecks(event: VerificationEventRow): Record<string, { ok?: boolean }> {
  try { return JSON.parse(event.checks_json) as Record<string, { ok?: boolean }>; }
  catch { return {}; }
}
function parseEventInput(event: VerificationEventRow): Record<string, unknown> | undefined {
  if (!event.input_json) return undefined;
  try { return JSON.parse(event.input_json) as Record<string, unknown>; }
  catch { return undefined; }
}
function eventMatchesCheck(event: VerificationEventRow, input: Record<string, unknown>, check: ManualSapiCheck): boolean {
  const stored = parseEventInput(event);
  if (!stored) return false;
  const keys: Record<ManualSapiCheck, string[]> = {
    shahkarLite: ["nationalCode", "mobile"],
    personInfo: ["nationalCode", "birthDateJalali"],
    postalCodeInfo: ["postalCode"],
    sana: ["nationalCode"],
  };
  return keys[check].every((key) => stored[key] === input[key]);
}
function checkInputs(customer: ManualCustomerIdentity) {
  return {
    nationalCode: customer.national_code,
    mobile: customer.phone,
    birthDateJalali: customer.birth_date_jalali,
    postalCode: customer.postal_code,
  };
}
function verificationWriteSnapshot(customer: ManualCustomerIdentity) {
  return {
    ...manualProfileSnapshot(customer),
    verificationStatus: customer.verification_status,
    verificationVersion: customer.verification_version,
    verificationCheckedAt: customer.verification_checked_at,
    verificationProvider: customer.verification_provider,
    shahkarStatus: customer.shahkar_status,
    personInfoStatus: customer.person_info_status,
    postalCodeInfoStatus: customer.postal_code_info_status,
    sanaStatus: customer.sana_status,
    ...currentManualChecks(customer),
  };
}
function eligibleManualFailures(
  event: VerificationEventRow | undefined,
  customer: ManualCustomerIdentity,
): ManualSapiCheck[] | undefined {
  if (!event || event.status !== "failed" ||
      event.national_code !== customer.national_code || event.mobile !== customer.phone) return undefined;
  const input = parseEventInput(event);
  const current = checkInputs(customer);
  if (!input || Object.entries(current).some(([key, value]) => input[key] !== value)) return undefined;
  const checks = parseEventChecks(event);
  const failures = manualSapiChecks.filter((check) => checks[check]?.ok !== true);
  return failures.length ? failures : undefined;
}

router.post(
  "/customers/:id/manual-verification-requests",
  requirePermission("customers.update"),
  (req, res): void => {
    const params = CreateManualVerificationRequestParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    const user = res.locals.authUser as AuthUser;
    if (!getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
    const now = new Date().toISOString();
    try {
      const result = runTransaction((): { kind: "created" | "existing" | "verified" | "ineligible" | "not_found"; id?: number } => {
        if (!getCustomer(params.data.id, user)) return { kind: "not_found" };
        const customer = manualCustomer(params.data.id);
        if (!customer) return { kind: "not_found" };
        const event = latestVerificationEvent(customer.id);
        const failures = eligibleManualFailures(event, customer);
        const pending = queryRow<{ id: number; original_values_json: string; source_event_id: number | null }>(
          "SELECT id,original_values_json,source_event_id FROM customer_manual_verification_requests WHERE customer_id=? AND status='pending'",
          [customer.id],
        );
        if (customer.verification_status === "verified") {
          if (pending) executeChanges(
            "UPDATE customer_manual_verification_requests SET status='superseded',resolved_at=? WHERE id=? AND status='pending'",
            [now, pending.id],
          );
          return { kind: "verified" };
        }
        const currentProfileJson = JSON.stringify(manualProfileSnapshot(customer));
        if (pending && failures && pending.source_event_id === event?.id &&
            pending.original_values_json === currentProfileJson) {
          return { kind: "existing", id: pending.id };
        }
        if (pending) executeChanges(
          "UPDATE customer_manual_verification_requests SET status='superseded',resolved_at=? WHERE id=? AND status='pending'",
          [now, pending.id],
        );
        if (!event || !failures) return { kind: "ineligible" };
        const inserted = execute(
          `INSERT INTO customer_manual_verification_requests
             (customer_id,requested_by_user_id,status,original_values_json,source_event_id,source_failures_json,created_at)
           VALUES (?,?,'pending',?,?,?,?)`,
          [customer.id, user.id, currentProfileJson, event.id, JSON.stringify(failures), now],
        );
        return { kind: "created", id: inserted };
      });
      if (result.kind === "not_found") { res.status(404).json({ error: "Customer not found" }); return; }
      if (result.kind === "verified") { res.status(409).json({ error: "Customer identity is already verified" }); return; }
      if (result.kind === "ineligible") {
        res.status(400).json({ error: "A matching failed or unavailable SAPI check is required for the current identity inputs" }); return;
      }
      const response = result.id === undefined ? undefined : getManualRequest(result.id);
      if (!response) throw new Error("Manual request was not stored");
      res.status(result.kind === "created" ? 201 : 200)
        .json(CreateManualVerificationRequestResponse.parse(manualRequestResponse(response)));
    } catch (error) {
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        const pendingId = queryRow<{ id: number }>(
          "SELECT id FROM customer_manual_verification_requests WHERE customer_id=? AND status='pending'",
          [params.data.id],
        );
        const pending = pendingId ? getManualRequest(pendingId.id) : undefined;
        const customer = manualCustomer(params.data.id);
        const event = customer ? latestVerificationEvent(customer.id) : undefined;
        if (pending && customer && event && eligibleManualFailures(event, customer) &&
            pending.source_event_id === event.id &&
            pending.original_values_json === JSON.stringify(manualProfileSnapshot(customer))) {
          res.status(200).json(CreateManualVerificationRequestResponse.parse(manualRequestResponse(pending)));
          return;
        }
        res.status(409).json({ error: "Customer or verification request changed concurrently; retry the request" });
        return;
      }
      throw error;
    }
  },
);

router.get("/manual-verifications", requireAdmin, (_req, res): void => {
  const rows = queryRows<ManualRequestRow>(
    `SELECT r.id,r.customer_id,r.requested_by_user_id,u.full_name AS requested_by_name,
       c.name AS customer_name,r.status,r.original_values_json,r.source_failures_json,r.created_at,r.source_event_id
     FROM customer_manual_verification_requests r
     JOIN customers c ON c.id=r.customer_id
     LEFT JOIN users u ON u.id=r.requested_by_user_id
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC`,
  );
  res.json(ListManualVerificationRequestsResponse.parse(rows.map(manualRequestResponse)));
});

router.get("/manual-verifications/:id", requireAdmin, (req, res): void => {
  const params = GetManualVerificationRequestParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const request = getManualRequest(params.data.id);
  const customer = request ? manualCustomer(request.customer_id) : undefined;
  if (!request || !customer) { res.status(404).json({ error: "Manual verification request not found" }); return; }
  const response = {
    ...manualRequestResponse(request),
    currentProfile: manualProfileSnapshot(customer),
    currentChecks: currentManualChecks(customer),
  };
  res.json(GetManualVerificationRequestResponse.parse(response));
});

router.post("/manual-verifications/:id/checks/:check/decision", requireAdmin, (req, res): void => {
  const id = Number(req.params.id);
  const check = req.params.check as ManualSapiCheck;
  const { decision, reason } = req.body ?? {};
  if (!Number.isSafeInteger(id) || id < 1 || !manualSapiChecks.includes(check) ||
      !["approved", "rejected"].includes(decision) || typeof reason !== "string" ||
      reason.trim().length < 1 || reason.trim().length > 1000) {
    res.status(400).json({ error: "نوع بررسی، تصمیم و دلیل معتبر الزامی است." }); return;
  }
  const actor = res.locals.authUser as AuthUser;
  try {
    runTransaction(() => {
      const request = getManualRequest(id);
      const customer = request && manualCustomer(request.customer_id);
      if (!request || !customer || request.status !== "pending") throw new Error("CHECK_REVIEW_STALE");
      if (decision === "approved" && (!customer.national_code || !ics24.validNationalCode(customer.national_code) ||
          !ics24.normalizeMobile(customer.phone) || !normalizeJalaliDate(customer.birth_date_jalali) ||
          !normalizePostalCode(customer.postal_code))) throw new Error("CHECK_REVIEW_INCOMPLETE");
      const original = JSON.parse(request.original_values_json);
      const snapshot = manualProfileSnapshot(customer);
      if (["phone", "nationalCode", "birthDateJalali", "postalCode"].some(key => original[key] !== snapshot[key as keyof typeof snapshot])) {
        throw new Error("CHECK_REVIEW_STALE");
      }
      if (!JSON.parse(request.source_failures_json).includes(check) || currentManualChecks(customer)[check].ok) {
        throw new Error("CHECK_REVIEW_NOT_FAILED");
      }
      const columns: Record<ManualSapiCheck, [string, string]> = {
        shahkarLite: ["shahkar_ok", "shahkar_status"], personInfo: ["person_info_ok", "person_info_status"],
        postalCodeInfo: ["postal_code_info_ok", "postal_code_info_status"], sana: ["sana_ok", "sana_status"],
      };
      const now = new Date().toISOString();
      const [okColumn, statusColumn] = columns[check];
      executeChanges(`UPDATE customers SET ${okColumn}=?,${statusColumn}=?,
        verification_version=COALESCE(verification_version,0)+1,verification_checked_at=?,
        verification_provider='sapi.ir+manual' WHERE id=?`,
      [decision === "approved" ? 1 : 0, decision === "approved" ? "manual_verified" : "manual_rejected", now, customer.id]);
      execute(`INSERT INTO customer_manual_check_decisions
        (request_id,customer_id,actor_user_id,check_key,decision,reason,input_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      [id, customer.id, actor.id, check, decision, reason.trim(), JSON.stringify(checkInputs(customer)), now]);
      const resolved = manualCustomer(customer.id)!;
      const verified = manualSapiChecks.every(key => currentManualChecks(resolved)[key].ok);
      executeChanges("UPDATE customers SET verification_status=? WHERE id=?", [verified ? "verified" : "unverified", customer.id]);
      if (verified) {
        executeChanges("UPDATE customer_manual_verification_requests SET status='approved',resolved_at=? WHERE id=? AND status='pending'", [now, id]);
        const methods = Object.fromEntries(manualSapiChecks.map(key => [key,
          currentManualChecks(resolved)[key].status === "manual_verified" ? "manual" : "system"]));
        const reasons = Object.fromEntries(manualSapiChecks.map(key => [key,
          queryRow<{ reason: string }>("SELECT reason FROM customer_manual_check_decisions WHERE request_id=? AND check_key=? AND decision='approved' ORDER BY id DESC LIMIT 1", [id, key])?.reason ?? null]));
        execute(`INSERT INTO customer_manual_verification_decisions
          (request_id,customer_id,actor_user_id,decision,source_failures_json,methods_json,reasons_json,original_values_json,corrected_values_json,created_at)
          VALUES(?,?,?,'approved',?,?,?,?,?,?)`,
        [id, customer.id, actor.id, request.source_failures_json, JSON.stringify(methods), JSON.stringify(reasons),
          request.original_values_json, JSON.stringify(manualProfileSnapshot(resolved)), now]);
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHECK_REVIEW_")) {
      res.status(409).json({ error: "فقط بررسی ناموفقِ درخواست فعال و اطلاعات هویتی بدون تغییر قابل تصمیم‌گیری است. وضعیت را تازه کنید." }); return;
    }
    throw error;
  }
  const request = getManualRequest(id)!;
  const customer = manualCustomer(request.customer_id)!;
  res.json(GetManualVerificationRequestResponse.parse({
    ...manualRequestResponse(request), currentProfile: manualProfileSnapshot(customer), currentChecks: currentManualChecks(customer),
  }));
});

const approveManualIdentity: RequestHandler = (req, res): void => {
  const direct = req.path.startsWith("/customers/");
  const params = ApproveManualVerificationRequestParams.safeParse(req.params);
  const parsed = ApproveManualVerificationRequestBody.safeParse(req.body);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const user = res.locals.authUser as AuthUser;
  const directCustomer = direct ? manualCustomer(params.data.id) : undefined;
  if (direct && !directCustomer) { res.status(404).json({ error: "Customer not found" }); return; }
  const request: ManualRequestRow | undefined = directCustomer ? {
    id: 0, customer_id: directCustomer.id, requested_by_user_id: user.id,
    requested_by_name: null, customer_name: directCustomer.name, status: "pending",
    original_values_json: JSON.stringify(manualProfileSnapshot(directCustomer)),
    source_failures_json: "[]", source_event_id: null, created_at: new Date().toISOString(),
  } : getManualRequest(params.data.id);
  if (!request) { res.status(404).json({ error: "Manual verification request not found" }); return; }
  if (request.status !== "pending") { res.status(409).json({ error: "Manual verification request is already resolved" }); return; }
  const customer = manualCustomer(request.customer_id);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  const originalRequestValues = JSON.parse(request.original_values_json) as Record<string, unknown>;
  const requestIdentity = originalRequestValues as Record<string, unknown>;
  const originalInputs = {
    nationalCode: requestIdentity.nationalCode ?? null,
    mobile: requestIdentity.phone ?? null,
    birthDateJalali: requestIdentity.birthDateJalali ?? null,
    postalCode: requestIdentity.postalCode ?? null,
  };
  const values = parsed.data.correctedValues ?? {};
  if (direct && (manualSapiChecks.some(check => parsed.data.checks[check].method !== "manual" ||
      !parsed.data.checks[check].reason?.trim()) ||
      !String(values.address ?? customer.address ?? "").trim() ||
      !String(values.name ?? customer.name ?? "").trim())) {
    res.status(400).json({ error: "برای احراز مستقیم، نشانی، نام و دلیل تأیید دستی تمام بررسی‌های هویت الزامی است." }); return;
  }
  if (values.name !== undefined && !values.name.trim()) {
    res.status(400).json({ error: "نام معتبر الزامی است." }); return;
  }
  let target: ReturnType<typeof checkInputs>;
  let corrections: Record<string, unknown>;
  try {
    const nationalCode = values.nationalCode === undefined
      ? customer.national_code
      : ics24.normalizeDigits(values.nationalCode).replace(/\D/g, "");
    if (!nationalCode || !ics24.validNationalCode(nationalCode)) throw new Error("کد ملی معتبر نیست.");
    const mobile = values.mobile === undefined ? customer.phone : ics24.normalizeMobile(values.mobile);
    if (!mobile) throw new Error("شماره همراه معتبر نیست.");
    const birthDateJalali = values.birthDateJalali === undefined
      ? customer.birth_date_jalali
      : normalizeJalaliDate(values.birthDateJalali);
    if (!birthDateJalali) throw new Error("تاریخ تولد جلالی معتبر الزامی است.");
    const postalCode = values.postalCode === undefined
      ? customer.postal_code
      : normalizePostalCode(values.postalCode);
    if (!postalCode) throw new Error("کد پستی معتبر الزامی است.");
    target = { nationalCode, mobile, birthDateJalali, postalCode };
    corrections = { ...values, nationalCode, mobile, birthDateJalali, postalCode };
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Corrected identity values are invalid" }); return;
  }
  if (hasActiveCustomerIdentityConflict(customer.id, { phone: target.mobile, nationalCode: target.nationalCode })) {
    res.status(409).json({ error: "An active customer already has this mobile or national code" }); return;
  }
  const latest = latestVerificationEvent(customer.id);
  const sourceFailures = JSON.parse(request.source_failures_json) as ManualSapiCheck[];
  const changed = (a: unknown, b: unknown) => a !== b;
  const affected: Record<ManualSapiCheck, boolean> = {
    shahkarLite: changed(target.nationalCode, customer.national_code) || changed(target.mobile, customer.phone),
    personInfo: changed(target.nationalCode, customer.national_code) || changed(target.birthDateJalali, customer.birth_date_jalali) ||
      values.name !== undefined || values.firstName !== undefined || values.lastName !== undefined || values.fatherName !== undefined,
    postalCodeInfo: changed(target.postalCode, customer.postal_code) || values.address !== undefined,
    sana: changed(target.nationalCode, customer.national_code),
  };
  const methods: Record<ManualSapiCheck, "system" | "manual"> = {
    shahkarLite: parsed.data.checks.shahkarLite.method,
    personInfo: parsed.data.checks.personInfo.method,
    postalCodeInfo: parsed.data.checks.postalCodeInfo.method,
    sana: parsed.data.checks.sana.method,
  };
  const reasons: Record<string, string | null> = {};
  for (const check of manualSapiChecks) {
    const decision = parsed.data.checks[check];
    reasons[check] = decision.reason?.trim() || null;
    if (decision.method === "manual" && (!decision.reason?.trim() || (!direct && !sourceFailures.includes(check)))) {
      res.status(400).json({ error: `${check} requires a reason and a matching failed or unavailable source check` }); return;
    }
    if (decision.method === "system" && customer[check === "shahkarLite" ? "shahkar_status" : check === "personInfo" ? "person_info_status" : check === "postalCodeInfo" ? "postal_code_info_status" : "sana_status"] === "manual_verified" && !affected[check]) {
      methods[check] = "manual";
      reasons[check] = "تأیید دستی پیشین همین مشخصات هویتی حفظ شد.";
    } else if (decision.method === "system") {
      if (!latest || parseEventChecks(latest)[check]?.ok !== true ||
          !eventMatchesCheck(latest, target, check)) {
        res.status(409).json({ error: `${check} must have a successful SAPI result matching the current corrected inputs` }); return;
      }
      if (affected[check] && latest.created_at <= request.created_at) {
        res.status(409).json({ error: `${check} must be manually reviewed or freshly re-queried after identity correction` }); return;
      }
    }
  }
  const now = new Date().toISOString();
  const originalValues = manualProfileSnapshot(customer);
  const correctedSnapshot = {
    ...originalValues,
    ...corrections,
    phone: target.mobile,
    firstName: values.firstName === undefined ? customer.first_name : values.firstName,
    lastName: values.lastName === undefined ? customer.last_name : values.lastName,
    fatherName: values.fatherName === undefined ? customer.father_name : values.fatherName,
    address: values.address === undefined ? customer.address : values.address,
  };
  try {
    runTransaction(() => {
      if (direct) {
        const fresh = manualCustomer(customer.id);
        if (!fresh || JSON.stringify(verificationWriteSnapshot(fresh)) !== JSON.stringify(verificationWriteSnapshot(customer))) {
          throw new Error("MANUAL_VERIFICATION_STALE");
        }
        executeChanges("UPDATE customer_manual_verification_requests SET status='superseded',resolved_at=? WHERE customer_id=? AND status='pending'", [now, customer.id]);
        request.id = execute(
          `INSERT INTO customer_manual_verification_requests
            (customer_id,requested_by_user_id,status,original_values_json,source_event_id,source_failures_json,created_at)
           VALUES (?,?,'pending',?,NULL,'[]',?)`,
          [customer.id, user.id, request.original_values_json, now],
        );
      }
      const freshRequest = queryRow<{ status: string }>(
        "SELECT status FROM customer_manual_verification_requests WHERE id=?",
        [request.id],
      );
      const freshCustomer = manualCustomer(customer.id);
      if (!freshRequest || freshRequest.status !== "pending" || !freshCustomer) throw new Error("MANUAL_VERIFICATION_STALE");
      const currentInputs = checkInputs(freshCustomer);
      if (JSON.stringify(currentInputs) !== JSON.stringify(originalInputs)) throw new Error("MANUAL_VERIFICATION_STALE");
      const identityChanged = customerIdentityStampChanged(freshCustomer, {
        phone: target.mobile,
        nationalCode: target.nationalCode,
        birthDateJalali: target.birthDateJalali,
        postalCode: target.postalCode,
      });
      const committedLatest = latestVerificationEvent(customer.id);
      for (const check of manualSapiChecks) {
        if (methods[check] !== "system") continue;
        if (!committedLatest || parseEventChecks(committedLatest)[check]?.ok !== true ||
            !eventMatchesCheck(committedLatest, target, check) ||
            (affected[check] && committedLatest.created_at <= request.created_at)) {
          throw new Error("MANUAL_VERIFICATION_STALE");
        }
      }
      if (hasActiveCustomerIdentityConflict(customer.id, { phone: target.mobile, nationalCode: target.nationalCode })) {
        throw new Error("ACTIVE_CUSTOMER_IDENTITY_CONFLICT");
      }
      const set: Array<[string, SqlValue]> = [
        ["national_code", target.nationalCode], ["phone", target.mobile],
        ["birth_date_jalali", target.birthDateJalali], ["postal_code", target.postalCode],
        ["verification_status", "verified"], ["verification_provider", direct ? "manual" : "sapi.ir+manual"],
        ["verification_checked_at", now], ["shahkar_ok", 1], ["person_info_ok", 1],
        ["postal_code_info_ok", 1], ["sana_ok", 1],
        ["shahkar_status", methods.shahkarLite === "manual" ? "manual_verified" : "verified"],
        ["person_info_status", methods.personInfo === "manual" ? "manual_verified" : "verified"],
        ["postal_code_info_status", methods.postalCodeInfo === "manual" ? "manual_verified" : "verified"],
        ["sana_status", methods.sana === "manual" ? "manual_verified" : "verified"],
      ];
      if (identityChanged) set.push(["identity_changed_at", now]);
      if (values.name !== undefined) set.push(["name", values.name]);
      if (values.firstName !== undefined) set.push(["first_name", values.firstName], ["official_first_name", values.firstName]);
      if (values.lastName !== undefined) set.push(["last_name", values.lastName], ["official_last_name", values.lastName]);
      if (values.firstName !== undefined || values.lastName !== undefined) {
        const first = values.firstName === undefined ? customer.first_name : values.firstName;
        const last = values.lastName === undefined ? customer.last_name : values.lastName;
        if (values.name === undefined) set.push(["name", [first, last].filter(Boolean).join(" ") || customer.name]);
      }
      if (values.fatherName !== undefined) set.push(["father_name", values.fatherName], ["official_father_name", values.fatherName]);
      if (values.address !== undefined) set.push(["address", values.address], ["official_address", values.address]);
      if (values.postalCode !== undefined) set.push(["official_postal_code", target.postalCode]);
      const changed = executeChanges(
        `UPDATE customers SET ${set.map(([field]) => `${field}=?`).join(",")},
           verification_version=COALESCE(verification_version,0)+1
         WHERE id=? ${direct ? "" : "AND verification_status<>'verified'"}`,
        [...set.map(([, value]) => value), customer.id],
      );
      if (!changed) throw new Error("MANUAL_VERIFICATION_STALE");
      const closed = executeChanges(
        "UPDATE customer_manual_verification_requests SET status='approved',resolved_at=? WHERE id=? AND status='pending'",
        [now, request.id],
      );
      if (!closed) throw new Error("MANUAL_VERIFICATION_STALE");
      execute(
        `INSERT INTO customer_manual_verification_decisions
          (request_id,customer_id,actor_user_id,decision,source_failures_json,methods_json,reasons_json,original_values_json,corrected_values_json,created_at)
         VALUES (?,?,?,'approved',?,?,?,?,?,?)`,
        [request.id, customer.id, user.id, request.source_failures_json, JSON.stringify(methods), JSON.stringify(reasons),
          request.original_values_json, JSON.stringify(correctedSnapshot), now],
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("ACTIVE_CUSTOMER_")) {
      res.status(409).json({ error: "An active customer already has this mobile or national code" }); return;
    }
    if (error instanceof Error && error.message === "MANUAL_VERIFICATION_STALE") {
      res.status(409).json({ error: "Manual verification request is stale or has already been resolved" }); return;
    }
    throw error;
  }
  const response = getManualRequest(request.id);
  if (!response) { res.status(404).json({ error: "Manual verification request not found" }); return; }
  res.json(ApproveManualVerificationRequestResponse.parse(manualRequestResponse(response)));
};
router.post("/manual-verifications/:id/approve", requireAdmin, approveManualIdentity);
router.post("/customers/:id/manual-verify", requireAdmin, approveManualIdentity);

router.post(
  "/customers/:id/verify",
  requirePermission("customers.update"),
  async (req, res): Promise<void> => {
    const params = GetCustomerParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
    const user = res.locals.authUser as AuthUser;
    const customer = getCustomer(params.data.id, user);
    if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
    const attemptCustomer = manualCustomer(params.data.id);
    if (!attemptCustomer) { res.status(404).json({ error: "Customer not found" }); return; }
    const attemptState = JSON.stringify(verificationWriteSnapshot(attemptCustomer));
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const nationalCode = typeof body.nationalCode === "string" ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") : customer.nationalCode;
    const mobileInput = typeof body.mobile === "string" ? body.mobile : customer.phone;
    if (!nationalCode || !ics24.validNationalCode(nationalCode)) {
      res.status(400).json({ error: "کد ملی معتبر الزامی است." }); return;
    }
    const mobile = ics24.normalizeMobile(mobileInput);
    if (!mobile) { res.status(400).json({ error: "شماره همراه معتبر نیست." }); return; }
    let birthDateJalali: string | null;
    let postalCode: string | null;
    try {
      birthDateJalali = normalizeJalaliDate(
        typeof body.birthDateJalali === "string" ? body.birthDateJalali : customer.birthDateJalali,
      );
      postalCode = normalizePostalCode(
        typeof body.postalCode === "string" ? body.postalCode : customer.postalCode,
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات هویتی معتبر نیست." }); return;
    }
    if (hasActiveCustomerIdentityConflict(params.data.id, { phone: mobile, nationalCode })) {
      res.status(409).json({ error: "An active customer already has this mobile or national code" }); return;
    }
    const input = { nationalCode, mobile, birthDateJalali, postalCode };
    const retained = retainedIdentityChecks(attemptCustomer, input);
    if (attemptCustomer.verification_status === "verified" && manualSapiChecks.every(check => retained[check]?.ok)) {
      res.json({ status: "verified", checks: retained, canonical: {
        officialFirstName: attemptCustomer.official_first_name, officialLastName: attemptCustomer.official_last_name,
        officialFatherName: attemptCustomer.official_father_name, officialAddress: attemptCustomer.official_address,
        officialPostalCode: attemptCustomer.official_postal_code,
      }, checkedAt: attemptCustomer.verification_checked_at });
      return;
    }
    try {
      const result = await verifyCustomer({
        nationalCode,
        mobile,
        birthDateJalali,
        postalCode,
        name: customer.name,
        fatherName: typeof body.fatherName === "string" ? body.fatherName : null,
      }, retained);
      const now = new Date().toISOString();
      let staleAttempt = false;
      runTransaction(() => {
        const currentCustomer = manualCustomer(params.data.id);
        staleAttempt = !currentCustomer ||
          JSON.stringify(verificationWriteSnapshot(currentCustomer)) !== attemptState;
        if (!currentCustomer) return;
        if (staleAttempt) {
          execute(
            `INSERT INTO customer_verification_events
              (customer_id,requested_by_user_id,national_code,mobile,checks_json,canonical_json,status,error_message,created_at,input_json,is_current)
             VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
            [params.data.id, user.id, nationalCode, mobile, JSON.stringify(result.checks),
              JSON.stringify(result.canonical), result.status, result.error ?? null, now, JSON.stringify(input)],
          );
          return;
        }
        const canonical = result.canonical;
        const officialFirstName = canonical.officialFirstName?.trim() || null;
        const officialLastName = canonical.officialLastName?.trim() || null;
        const officialFullName = [officialFirstName, officialLastName].filter(Boolean).join(" ") || null;
        const persistedPostalCode = canonical.officialPostalCode ?? postalCode;
        const identityChanged = customerIdentityStampChanged(currentCustomer, {
          phone: mobile,
          nationalCode,
          birthDateJalali,
          postalCode: persistedPostalCode,
        });
        executeChanges(
          `UPDATE customers SET national_code = ?, phone = ?, birth_date_jalali = ?, postal_code = ?,
             verification_status = ?, verification_checked_at = ?,
             verification_version=COALESCE(verification_version,0)+1,
             verification_provider = 'sapi.ir',
             shahkar_status = ?, person_info_status = ?, postal_code_info_status = ?, sana_status = ?,
             shahkar_ok = ?, person_info_ok = ?, postal_code_info_ok = ?, sana_ok = ?,
             first_name = COALESCE(?, first_name),
             last_name = COALESCE(?, last_name),
             name = COALESCE(?, name),
             father_name = COALESCE(?, father_name),
             address = COALESCE(?, address),
             official_first_name = COALESCE(?, official_first_name),
             official_last_name = COALESCE(?, official_last_name),
             official_father_name = COALESCE(?, official_father_name),
             official_address = COALESCE(?, official_address),
              official_postal_code = COALESCE(?, official_postal_code),
              identity_changed_at = CASE WHEN ? THEN ? ELSE identity_changed_at END
           WHERE id = ?`,
           [
             nationalCode, mobile, birthDateJalali, postalCode, result.status, now,
            result.checks.shahkarLite.providerStatus ?? null,
            result.checks.personInfo.providerStatus ?? null,
            result.checks.postalCodeInfo.providerStatus ?? null,
            result.checks.sana.providerStatus ?? null,
            result.checks.shahkarLite.ok ? 1 : 0,
            result.checks.personInfo.ok ? 1 : 0,
            result.checks.postalCodeInfo.ok ? 1 : 0,
            result.checks.sana.ok ? 1 : 0,
            officialFirstName,
            officialLastName,
            officialFullName,
            canonical.officialFatherName ?? null,
            canonical.officialAddress ?? null,
            officialFirstName,
            officialLastName,
            canonical.officialFatherName ?? null,
            canonical.officialAddress ?? null,
            canonical.officialPostalCode ?? null,
             identityChanged ? 1 : 0,
             now,
             params.data.id,
          ],
        );
        execute(
          `INSERT INTO customer_verification_events
             (customer_id, requested_by_user_id, national_code, mobile, checks_json, canonical_json, status, error_message, created_at,input_json,is_current)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,1)`,
          [params.data.id, user.id, nationalCode, mobile, JSON.stringify(result.checks),
            JSON.stringify(result.canonical), result.status, result.error ?? null, now, JSON.stringify(input)],
        );
        if (result.status === "verified" && manualSapiChecks.every((check) => result.checks[check].ok)) {
          const pending = queryRow<{ id: number; original_values_json: string }>(
            "SELECT id,original_values_json FROM customer_manual_verification_requests WHERE customer_id=? AND status='pending'",
            [params.data.id],
          );
          if (pending) {
            executeChanges(
              "UPDATE customer_manual_verification_requests SET status='system_verified',resolved_at=? WHERE id=? AND status='pending'",
              [now, pending.id],
            );
            const verifiedCustomer = manualCustomer(params.data.id);
            const methods = Object.fromEntries(manualSapiChecks.map((check) => [check, "system"]));
            execute(
              `INSERT INTO customer_manual_verification_decisions
                (request_id,customer_id,actor_user_id,decision,source_failures_json,methods_json,reasons_json,original_values_json,corrected_values_json,created_at)
               VALUES (?,?,?,'system_verified',?,?,?,?,?,?)`,
              [pending.id, params.data.id, user.id,
                queryRow<{ source_failures_json: string }>(
                  "SELECT source_failures_json FROM customer_manual_verification_requests WHERE id=?",
                  [pending.id],
                )?.source_failures_json ?? "[]",
                JSON.stringify(methods), JSON.stringify({}),
                pending.original_values_json, JSON.stringify(verifiedCustomer ? manualProfileSnapshot(verifiedCustomer) : {}), now],
            );
          }
        }
      });
      if (staleAttempt) {
        res.status(409).json({ error: "Customer verification state changed while the SAPI check was running; the result was recorded as historical" });
        return;
      }
      res.status(200).json({
        customerId: params.data.id, status: result.status,
        checks: Object.fromEntries(manualSapiChecks.map((check) => [
          check,
          { ok: result.checks[check].ok, providerStatus: result.checks[check].providerStatus?.startsWith("manual_")
            ? result.checks[check].providerStatus : result.checks[check].ok ? "success" : "failed" },
        ])),
        canonical: result.canonical, checkedAt: now, error: result.error ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("ACTIVE_CUSTOMER_")) {
        res.status(409).json({ error: "An active customer already has this mobile or national code" });
        return;
      }
      const now = new Date().toISOString();
      const unavailable = Object.fromEntries(manualSapiChecks.map((check) => [check, retained[check] ?? {
        ok: false,
        providerStatus: "unavailable",
      }]));
      let staleAttempt = false;
      let identityConflict = false;
      try {
        runTransaction(() => {
          const currentCustomer = manualCustomer(params.data.id);
          staleAttempt = !currentCustomer ||
            JSON.stringify(verificationWriteSnapshot(currentCustomer)) !== attemptState;
          if (!currentCustomer) return;
          if (!staleAttempt && hasActiveCustomerIdentityConflict(params.data.id, { phone: mobile, nationalCode })) {
            identityConflict = true;
            return;
          }
          const identityChanged = !staleAttempt && customerIdentityStampChanged(currentCustomer, {
            phone: mobile,
            nationalCode,
            birthDateJalali,
            postalCode,
          });
          if (!staleAttempt) executeChanges(
            `UPDATE customers SET national_code=?,phone=?,birth_date_jalali=?,postal_code=?,
               identity_changed_at=CASE WHEN ? THEN ? ELSE identity_changed_at END,
               verification_status='unverified',verification_checked_at=?,
               verification_provider='sapi.ir',verification_version=COALESCE(verification_version,0)+1,
               shahkar_status=?,person_info_status=?,postal_code_info_status=?,sana_status=?,
               shahkar_ok=?,person_info_ok=?,postal_code_info_ok=?,sana_ok=?
             WHERE id=?`,
            [nationalCode, mobile, birthDateJalali, postalCode, identityChanged ? 1 : 0, now, now,
              ...manualSapiChecks.map(check => unavailable[check].providerStatus ?? "unavailable"),
              ...manualSapiChecks.map(check => unavailable[check].ok ? 1 : 0), params.data.id],
          );
          execute(
            `INSERT INTO customer_verification_events
              (customer_id,requested_by_user_id,national_code,mobile,checks_json,canonical_json,status,error_message,created_at,input_json,is_current)
             VALUES (?,?,?,?,?,NULL,'failed','SAPI verification unavailable',?,?,?)`,
            [params.data.id, user.id, nationalCode, mobile, JSON.stringify(unavailable), now, JSON.stringify(input), staleAttempt ? 0 : 1],
          );
        });
      } catch (persistError) {
        if (persistError instanceof Error && persistError.message.includes("ACTIVE_CUSTOMER_")) {
          res.status(409).json({ error: "An active customer already has this mobile or national code" });
          return;
        }
        throw persistError;
      }
      if (staleAttempt) {
        res.status(409).json({ error: "Customer verification state changed while the SAPI check was running; the result was recorded as historical" });
        return;
      }
      if (identityConflict) {
        res.status(409).json({ error: "An active customer already has this mobile or national code" });
        return;
      }
      res.status(502).json({ error: "SAPI verification unavailable" });
    }
  },
);

router.patch(
  "/customers/:id",
  requirePermission("customers.update"),
  (req, res): void => {
    const params = UpdateCustomerParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (req.body && typeof req.body === "object" &&
        Object.prototype.hasOwnProperty.call(req.body, "verificationStatus")) {
      res.status(403).json({ error: "Identity verification status can only be changed by verification workflows" });
      return;
    }
    const parsed = UpdateCustomerBody.safeParse(blankNationalCodeToNull(req.body));
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const entries: Array<[string, SqlValue]> = [];
    const body = parsed.data;
    const user = res.locals.authUser as AuthUser;
    if (body.salespersonId !== undefined && user.role !== "admin") {
      res.status(403).json({ error: "Only administrators may assign a salesperson" });
      return;
    }
    if (body.salespersonId != null && !queryRow("SELECT id FROM salespersons WHERE id=?", [body.salespersonId])) {
      res.status(400).json({ error: "Salesperson does not exist" });
      return;
    }
    const existingCustomer = getCustomer(params.data.id, user);
    if (!existingCustomer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    if (body.name !== undefined) entries.push(["name", body.name]);
    if (body.phone !== undefined) {
      const mobile = ics24.normalizeMobile(body.phone);
      if (!mobile) { res.status(400).json({ error: "شماره همراه معتبر نیست." }); return; }
      entries.push(["phone", mobile]);
    }
    if (body.description !== undefined)
      entries.push(["description", body.description]);
    // crm-nid-optional (PM 16:03): «کد ملی» is optional for every customer edit (name included).
    //  - a valid 10-digit code with a correct check digit is saved;
    //  - an omitted / null / blank code keeps the stored value untouched;
    //  - the stored code is cleared ONLY with the explicit signal `clearNationalCode: true` (field touched and emptied).
    const clearNationalCode = explicitNationalCodeClear(req.body);
    const previousNationalCode = existingCustomer.nationalCode ? normalizeCustomerNationalCode(existingCustomer.nationalCode) : "";
    let nationalCodeLog: { previous: string; next: string } | null = null;
    {
      const nationalCode = body.nationalCode
        ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") || null
        : null;
      if (nationalCode !== null && !ics24.validNationalCode(nationalCode)) {
        res.status(400).json({ error: "کد ملی معتبر نیست." });
        return;
      }
      if (nationalCode !== null && clearNationalCode) {
        res.status(400).json({ error: "برای پاک کردن کد ملی، فیلد را خالی بگذارید." });
        return;
      }
      if (nationalCode !== null) {
        entries.push(["national_code", nationalCode]);
        if (nationalCode !== previousNationalCode) nationalCodeLog = { previous: previousNationalCode, next: nationalCode };
      } else if (clearNationalCode && previousNationalCode) {
        entries.push(["national_code", null]);
        nationalCodeLog = { previous: previousNationalCode, next: "" };
      }
    }
    const reactivating = existingCustomer.status === "cancelled" &&
      body.status !== undefined && body.status !== "cancelled";
    // crm-nid-quick (PM 16:37): only values that actually change (or a reactivation) are checked for conflicts,
    // so a name-only quick edit (which re-sends the unchanged phone) is never blocked, and the message names
    // the field that really collides instead of always mentioning «کد ملی».
    const phoneChanged = body.phone !== undefined &&
      normalizeCustomerIdentity(body.phone) !== normalizeCustomerIdentity(existingCustomer.phone ?? "");
    const conflictPhone = phoneChanged ? body.phone : reactivating ? existingCustomer.phone : undefined;
    const conflictNationalCode = entries.some(([field]) => field === "national_code")
      ? entries.find(([field]) => field === "national_code")?.[1] as string | null
      : reactivating ? existingCustomer.nationalCode : undefined;
    const identityConflict = findActiveCustomerIdentityConflict(params.data.id, {
      phone: conflictPhone,
      nationalCode: conflictNationalCode,
    });
    if (identityConflict) {
      const visibleConflict = getCustomer(Number(identityConflict.id), user);
      const mobileClash = conflictPhone !== undefined &&
        normalizeCustomerIdentity(identityConflict.phone) === normalizeCustomerIdentity(conflictPhone);
      const what = mobileClash ? "شماره همراه" : "کد ملی";
      res.status(409).json({ error: visibleConflict
        ? `${what} این پرونده با مشتری شماره ${visibleConflict.id} مشترک است. ${what} را بررسی کنید؛ اگر هر دو پرونده متعلق به یک نفر هستند، مدیر باید ادغام آن‌ها را بررسی کند.`
        : `${what} این پرونده با مشتری فعال دیگری مشترک است. برای بررسی و رفع تداخل با مدیر تماس بگیرید.` });
      return;
    }
    try {
      if (body.birthDateJalali !== undefined)
        entries.push([
          "birth_date_jalali",
          normalizeJalaliDate(body.birthDateJalali),
        ]);
      if (body.postalCode !== undefined)
        entries.push(["postal_code", normalizePostalCode(body.postalCode)]);
      if (body.fatherName !== undefined) entries.push(["father_name", body.fatherName]);
      if (body.address !== undefined) entries.push(["address", body.address]);
      if (body.email !== undefined) entries.push(["email", body.email]);
    } catch (error) {
      res
        .status(400)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "اطلاعات پروفایل معتبر نیست.",
        });
      return;
    }
    const updates = new Map(entries);
    const identityPrevious = {
      phone: existingCustomer.phone,
      national_code: existingCustomer.nationalCode,
      birth_date_jalali: existingCustomer.birthDateJalali,
      postal_code: existingCustomer.postalCode,
    };
    const identityChanged = customerIdentityChanged(
      {
        phone: existingCustomer.phone,
        national_code: existingCustomer.nationalCode,
        birth_date_jalali: existingCustomer.birthDateJalali,
        postal_code: existingCustomer.postalCode,
      },
      {
        phone: updates.has("phone") ? String(updates.get("phone") ?? "") : existingCustomer.phone,
        nationalCode: updates.has("national_code")
          ? updates.get("national_code") as string | null
          : existingCustomer.nationalCode,
        birthDateJalali: updates.has("birth_date_jalali")
          ? updates.get("birth_date_jalali") as string | null
          : existingCustomer.birthDateJalali,
        postalCode: updates.has("postal_code")
          ? updates.get("postal_code") as string | null
          : existingCustomer.postalCode,
      },
    );
    const identityStampChanged = identityChanged && customerIdentityStampChanged(identityPrevious, {
      phone: updates.has("phone") ? String(updates.get("phone") ?? "") : existingCustomer.phone,
      nationalCode: updates.has("national_code") ? updates.get("national_code") as string | null : existingCustomer.nationalCode,
      birthDateJalali: updates.has("birth_date_jalali")
        ? updates.get("birth_date_jalali") as string | null
        : existingCustomer.birthDateJalali,
      postalCode: updates.has("postal_code") ? updates.get("postal_code") as string | null : existingCustomer.postalCode,
    });
    if (identityStampChanged) entries.push(["identity_changed_at", new Date().toISOString()]);
    if (identityChanged) {
      entries.push(
        ["verification_status", "unverified"],
        ["verification_checked_at", null],
        ["verification_provider", null],
        ["shahkar_ok", null],
        ["person_info_ok", null],
        ["postal_code_info_ok", null],
        ["sana_ok", null],
        ["shahkar_status", null],
        ["person_info_status", null],
        ["postal_code_info_status", null],
        ["sana_status", null],
      );
    }
    if (body.isUrgent !== undefined)
      entries.push(["is_urgent", body.isUrgent ? 1 : 0]);
    if (body.salespersonId !== undefined && user.role === "admin")
      entries.push(["salesperson_id", body.salespersonId]);
    if (body.priority !== undefined) entries.push(["priority", body.priority]);
    if (body.status !== undefined) entries.push(["status", body.status]);
    if (!entries.length) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }
    const setClause = [
      ...entries.map(([field]) => `${field} = ?`),
      ...(identityChanged ? ["verification_version=COALESCE(verification_version,0)+1"] : []),
    ].join(", ");
    let changes: number;
    let nonP1: NonP1Result | null = null;
    try {
      if (nationalCodeLog) ensureIdentityLogSchema();
      changes = runTransaction(() => {
        const changed = executeChanges(
          `UPDATE customers SET ${setClause} WHERE id = ?`,
          [...entries.map(([, value]) => value), params.data.id],
        );
        // Same additive log as the quick-credit save; '' as new value = explicitly cleared.
        if (changed && nationalCodeLog) execute(
          `INSERT INTO ${IDENTITY_LOG_TABLE} (customer_id,old_national_code,new_national_code,identity_changed,source,actor_user_id,created_at)
           VALUES (?,?,?,?,'customer_update',?,?)`,
          [params.data.id, nationalCodeLog.previous || null, nationalCodeLog.next, identityStampChanged ? 1 : 0, user.id, new Date().toISOString()]);
        // crm-nonp1-to-kazemi: a non-1 priority on a closer's customer moves it to Kazemi in this same transaction.
        if (changed && body.priority !== undefined) {
          nonP1 = applyNonP1TransferInTx({
            customerId: params.data.id, oldPriority: existingCustomer.priority ?? null,
            oldSalespersonId: existingCustomer.salespersonId ?? null,
            actor: { id: user.id, role: user.role, salespersonId: user.salespersonId ?? null },
            explicitSalespersonChange: body.salespersonId !== undefined && (body.salespersonId ?? null) !== (existingCustomer.salespersonId ?? null),
            via: "ویرایش مشتری",
          });
        }
        return changed;
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("ACTIVE_CUSTOMER_")) {
        const what = error.message.includes("ACTIVE_CUSTOMER_MOBILE_CONFLICT") ? "شماره همراه"
          : error.message.includes("ACTIVE_CUSTOMER_NATIONAL_CODE_CONFLICT") ? "کد ملی" : "شماره همراه یا کد ملی";
        res.status(409).json({ error: `${what} این پرونده با مشتری فعال دیگری مشترک است. پیش از تغییر وضعیت یا اطلاعات، تداخل را با کمک مدیر برطرف کنید.` });
        return;
      }
      throw error;
    }
    if (!changes) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const nonP1Moved = (nonP1 as NonP1Result | null)?.transferred === true;
    if ((body.priority !== undefined || body.salespersonId !== undefined) && !nonP1Moved) {
      try {
        const after = queryRow<{ priority: number | null; salesperson_id: number | null }>(
          "SELECT priority, salesperson_id FROM customers WHERE id=?", [params.data.id]);
        logPriorityChange({
          customerId: params.data.id,
          oldPriority: existingCustomer.priority ?? null, newPriority: after?.priority ?? null,
          oldSalespersonId: existingCustomer.salespersonId ?? null, newSalespersonId: after?.salesperson_id ?? null,
          actorUserId: user.id, source: "customer_update",
        });
      } catch (error) {
        req.log.warn({ err: error }, "priority history logging failed");
      }
    }
    // After an auto-transfer an assigned-scope expert no longer sees the customer; answer with the saved record once.
    const customer = nonP1Moved ? getCustomer(params.data.id) : getCustomer(params.data.id, user);
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    if (nonP1Moved) res.setHeader(NONP1_TRANSFER_HEADER, String(params.data.id));
    res.json(UpdateCustomerResponse.parse(customer));
  },
);

router.patch(
  "/customers/:id/tags",
  requirePermission("customers.update"),
  (req, res): void => {
    const params = UpdateCustomerTagsParams.safeParse(req.params);
    const parsed = UpdateCustomerTagsBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const customerId = params.data.id;
    if (!customerOwnerOrAdmin(customerId, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const tags = [...new Set(parsed.data.tags)];
    const knownTags = queryRows<{ tag: string }>(
      `SELECT tag FROM customer_tag_catalog WHERE tag IN (${tags.map(() => "?").join(",") || "''"})`,
      tags,
    ).map((row) => row.tag);
    if (knownTags.length !== tags.length) {
      res.status(400).json({ error: "Unknown customer tag" });
      return;
    }
    const currentTags = customerTags(customerId);
    if (currentTags.includes("repeat_request") && !tags.includes("repeat_request")) {
      res.status(400).json({ error: "repeat_request can only be removed by acknowledgement" });
      return;
    }
    if (
      tags.includes("repeat_request") &&
      !currentTags.includes("repeat_request") &&
      customerPendingRepeatRequestCount(customerId) === 0
    ) {
      res.status(400).json({ error: "repeat_request requires a pending repeat request" });
      return;
    }
    runTransaction(() => {
      for (const tag of currentTags) {
        if (!tags.includes(tag)) executeChanges(
          "DELETE FROM customer_tags WHERE customer_id=? AND tag=?",
          [customerId, tag],
        );
      }
      const createdAt = new Date().toISOString();
      for (const tag of tags) execute(
        "INSERT OR IGNORE INTO customer_tags(customer_id,tag,created_at) VALUES(?,?,?)",
        [customerId, tag, createdAt],
      );
    });
    res.json(UpdateCustomerTagsResponse.parse({ tags: customerTags(customerId) }));
  },
);

router.get(
  "/customers/:id/repeat-requests",
  requirePermission("customers.view"),
  (req, res): void => {
    const params = ListCustomerRepeatRequestsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const customerId = params.data.id;
    if (!customerOwnerOrAdmin(customerId, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const rows = queryRows<{
      id: number; customer_id: number; requested_name: string;
      submitted_description: string | null; explanation: string; status: string;
      created_by_user_id: number | null; created_by_name: string | null;
      provenance: string; source_thread_id: number | null; source_message_id: string | null;
      created_at: string; acknowledged_at: string | null;
    }>(
      `SELECT r.id,r.customer_id,r.requested_name,r.submitted_description,r.explanation,r.status,
        r.created_by_user_id,r.provenance,r.source_thread_id,r.source_message_id,
        u.full_name AS created_by_name,r.created_at,r.acknowledged_at
       FROM customer_repeat_requests r LEFT JOIN users u ON u.id=r.created_by_user_id
       WHERE r.customer_id=? ORDER BY r.created_at DESC,r.id DESC`,
      [customerId],
    );
    res.json(ListCustomerRepeatRequestsResponse.parse(rows.map((row) => ({
      id: Number(row.id),
      customerId: Number(row.customer_id),
      requestedName: row.requested_name,
      submittedDescription: row.submitted_description,
      explanation: row.explanation,
      status: row.status,
      createdByUserId: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
      createdByName: row.created_by_name ?? null,
      provenance: row.provenance,
      sourceThreadId: row.source_thread_id == null ? null : Number(row.source_thread_id),
      sourceMessageId: row.source_message_id ?? null,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    }))));
  },
);

router.post(
  "/customers/:id/repeat-requests/acknowledge",
  requirePermission("customers.update"),
  (req, res): void => {
    const params = AcknowledgeCustomerRepeatRequestsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const customerId = params.data.id;
    if (!customerOwnerOrAdmin(customerId, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const acknowledgedCount = runTransaction(() => {
      const changes = executeChanges(
        `UPDATE customer_repeat_requests SET status='acknowledged',acknowledged_at=?
         WHERE customer_id=? AND status='pending'`,
        [new Date().toISOString(), customerId],
      );
      executeChanges("DELETE FROM customer_tags WHERE customer_id=? AND tag='repeat_request'", [customerId]);
      return changes;
    });
    res.json(AcknowledgeCustomerRepeatRequestsResponse.parse({
      acknowledgedCount,
      pendingRepeatRequestCount: customerPendingRepeatRequestCount(customerId),
      tags: customerTags(customerId),
    }));
  },
);

router.delete(
  "/customers/:id",
  requirePermission("customers.delete"),
  (req, res): void => {
    const parsed = DeleteCustomerParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const customer = getCustomer(parsed.data.id, user);
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    runTransaction(() => {
      executeChanges(
        "UPDATE reminders SET customer_id = NULL WHERE customer_id = ?",
        [parsed.data.id],
      );
      executeChanges(
        "DELETE FROM notification_deliveries WHERE customer_id = ?",
        [parsed.data.id],
      );
      executeChanges("DELETE FROM call_logs WHERE customer_id = ?", [
        parsed.data.id,
      ]);
      executeChanges("DELETE FROM consultation_forms WHERE customer_id = ?", [
        parsed.data.id,
      ]);
      deleteCustomerIntro(crmDb, parsed.data.id);
      executeChanges("DELETE FROM customers WHERE id = ?", [parsed.data.id]);
    });
    res.status(204).send();
  },
);

type CreditCheckRow = {
  id: number;
  customer_id: number;
  requested_by_user_id: number;
  national_code: string;
  provider_reference: string | null;
  provider_status: string | null;
  status: string;
  score: number | null;
  score_label: string | null;
  summary: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
const activeCreditStarts = new Set<number>();
function creditCheckFromRow(row: CreditCheckRow) {
  const score = row.score == null ? null : Number(row.score);
  const rank = deriveCreditRank(score);
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    status: row.status,
    nationalCode: row.national_code,
    providerReference: row.provider_reference ?? null,
    providerStatus: row.provider_status ?? null,
    score,
    scoreLabel: rank.ok ? rank.rank : null,
    summary: row.summary ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}
function getCreditCheck(customerId: number, checkId: number) {
  return queryRow<CreditCheckRow>(
    "SELECT * FROM customer_credit_checks WHERE id = ? AND customer_id = ?",
    [checkId, customerId],
  );
}
async function refreshCreditCheck(
  row: CreditCheckRow,
): Promise<CreditCheckRow> {
  if (
    !row.provider_reference ||
    row.status === "report_generated" ||
    row.status === "failed"
  )
    return row;
  const expired = creditProviderFailure("RequestExpired")!;
  if (creditProviderFailure(null, row.error_message) === expired || row.provider_status === "RequestExpired") {
    execute("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
      [expired, new Date().toISOString(), row.id]);
    return getCreditCheck(row.customer_id, row.id) ?? row;
  }
  try {
    const provider = await ics24.status(row.provider_reference);
    const now = new Date().toISOString();
    if (provider.status === "ReportGenerated" && provider.reportCode) {
      const summary = await ics24.report(provider.reportCode);
      const rank = deriveCreditRank(summary.score);
      if (!rank.ok) {
        const now = new Date().toISOString();
        execute(
          `UPDATE customer_credit_checks
            SET status = 'failed', provider_status = ?, score = ?, score_label = NULL,
                error_message = ?, updated_at = ?, completed_at = NULL
            WHERE id = ? AND status NOT IN ('report_generated', 'failed')`,
          [
            provider.status,
            summary.score,
            invalidCreditScoreMessage(rank.reason),
            now,
            row.id,
          ],
        );
        return getCreditCheck(row.customer_id, row.id) ?? row;
      }
      runTransaction(() => {
        const completedAt = now;
        const changed = executeChanges(
          `UPDATE customer_credit_checks
           SET status = 'report_generated', provider_status = ?, score = ?, score_label = ?, summary = ?,
               error_message = NULL, updated_at = ?, completed_at = ?
           WHERE id = ? AND status NOT IN ('report_generated', 'failed')`,
          [
            provider.status,
            summary.score,
            rank.rank,
            summary.summary,
            now,
            completedAt,
            row.id,
          ],
        );
        if (changed) {
          executeChanges(
            `UPDATE customers
             SET credit_score = ?, credit_rank = ?, credit_checked_at = ?
             WHERE id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM customer_credit_checks newer
                 WHERE newer.customer_id = ?
                   AND newer.status = 'report_generated'
                   AND (newer.created_at > ? OR (newer.created_at = ? AND newer.id > ?))
               )`,
            [
              summary.score,
              rank.rank,
              completedAt,
              row.customer_id,
              row.customer_id,
              row.created_at,
              row.created_at,
              row.id,
            ],
          );
        }
      });
    } else if (
      creditProviderFailure(provider.status, provider.statusTitle) !== null
    ) {
      execute(
        `UPDATE customer_credit_checks SET status = 'failed', provider_status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status NOT IN ('report_generated', 'failed')`,
        [
          provider.status,
          creditProviderFailure(provider.status, provider.statusTitle),
          now,
          row.id,
        ],
      );
    } else {
      execute(
        `UPDATE customer_credit_checks SET status = ?, provider_status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('report_generated', 'failed')`,
        [row.status === "awaiting_otp" ? "awaiting_otp" : "processing", provider.status, now, row.id],
      );
    }
  } catch (error) {
    const terminal = creditProviderFailure(null, error instanceof Error ? error.message : null);
    if (terminal) {
      execute("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
        [terminal, new Date().toISOString(), row.id]);
      return getCreditCheck(row.customer_id, row.id) ?? row;
    }
    execute(
      `UPDATE customer_credit_checks SET error_message = ?, updated_at = ? WHERE id = ?`,
      [
        error instanceof Error
          ? error.message.slice(0, 240)
          : "خطای سرویس اعتبارسنجی",
        new Date().toISOString(),
        row.id,
      ],
    );
  }
  return getCreditCheck(row.customer_id, row.id) ?? row;
}

/**
 * crm-no-plan-option (14:51) «اعتبارسنجی سریع» in the old call form: saves the customer's national code ONLY.
 * No inquiry is started here (the user then opens the existing inquiry step of the request wizard and clicks there).
 * - admin / registrar / the customer's own salesperson only; customer visibility via the existing scoping;
 * - 10 digits + check digit; active-customer identity conflict -> 409;
 * - replacing a DIFFERENT existing code needs confirmReplace=true (409 code "confirm_replace" otherwise) and is logged;
 * - a changed code applies the existing identity_changed_at rule (earlier inquiries no longer count).
 */
router.post(
  "/customers/:id/quick-credit/national-code",
  requirePermission("calls.create"),
  (req, res): void => {
    const id = Number(req.params.id);
    const user = res.locals.authUser as AuthUser;
    if (!Number.isInteger(id) || id <= 0 || !getCustomer(id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
    const current = queryRow<{ phone: string; national_code: string | null; postal_code: string | null; birth_date_jalali: string | null; salesperson_id: number | null }>(
      "SELECT phone,national_code,postal_code,birth_date_jalali,salesperson_id FROM customers WHERE id=?", [id]);
    if (!current) { res.status(404).json({ error: "Customer not found" }); return; }
    if (!canActOnCustomerProfile(user, current.salesperson_id, isAdminRole)) {
      res.status(403).json({ error: "اعتبارسنجی سریع فقط برای کارشناس همین مشتری، ثبت‌نام‌کننده و مدیر فعال است." }); return;
    }
    const body = (req.body ?? {}) as { nationalCode?: unknown; confirmReplace?: unknown };
    const nationalCode = typeof body.nationalCode === "string" ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") : "";
    if (!ics24.validNationalCode(nationalCode)) { res.status(400).json({ error: "کد ملی ۱۰ رقمی معتبر وارد کنید." }); return; }
    const previous = current.national_code ? normalizeCustomerNationalCode(current.national_code) : "";
    const replacing = Boolean(previous) && previous !== nationalCode;
    if (replacing && body.confirmReplace !== true) {
      res.status(409).json({ error: "این مشتری کد ملی دیگری دارد؛ برای جایگزینی تأیید کنید.", code: "confirm_replace" }); return;
    }
    if (hasActiveCustomerIdentityConflict(id, { nationalCode })) {
      res.status(409).json({ error: "An active customer already has this national code" }); return;
    }
    if (previous === nationalCode) { res.json({ customerId: id, nationalCode, changed: false, identityChanged: false }); return; }
    const nextIdentity = { phone: current.phone, nationalCode, postalCode: current.postal_code, birthDateJalali: current.birth_date_jalali };
    // Verification resets on any difference; identity_changed_at only when an existing code is replaced (live rule).
    const verificationReset = customerIdentityChanged(current, nextIdentity);
    const identityChanged = customerIdentityStampChanged(current, nextIdentity);
    const now = new Date().toISOString();
    ensureIdentityLogSchema();
    runImmediateTransaction(() => {
      executeChanges(
        `UPDATE customers SET national_code=?${identityChanged ? ",identity_changed_at=?" : ""}${verificationReset
          ? ",verification_version=COALESCE(verification_version,0)+1,verification_status='unverified',verification_checked_at=NULL,verification_provider=NULL,shahkar_ok=NULL,person_info_ok=NULL,postal_code_info_ok=NULL,sana_ok=NULL,shahkar_status=NULL,person_info_status=NULL,postal_code_info_status=NULL,sana_status=NULL"
          : ""} WHERE id=?`,
        [nationalCode, ...(identityChanged ? [now] : []), id]);
      execute(
        `INSERT INTO ${IDENTITY_LOG_TABLE} (customer_id,old_national_code,new_national_code,identity_changed,source,actor_user_id,created_at)
         VALUES (?,?,?,?,'quick_credit',?,?)`,
        [id, previous || null, nationalCode, identityChanged ? 1 : 0, user.id, now]);
    });
    res.json({ customerId: id, nationalCode, changed: true, replaced: replacing, identityChanged });
  },
);

router.get(
  "/customers/:id/credit-checks",
  requirePermission("customers.credit_check"),
  (req, res): void => {
    const parsed = ListCustomerCreditChecksParams.safeParse(req.params);
    const user = res.locals.authUser as AuthUser;
    if (!parsed.success || !getCustomer(parsed.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const rows = queryRows<CreditCheckRow>(
      "SELECT * FROM customer_credit_checks WHERE customer_id = ? ORDER BY created_at DESC, id DESC",
      [parsed.data.id],
    );
    res.json(
      ListCustomerCreditChecksResponse.parse(rows.map(creditCheckFromRow)),
    );
  },
);

router.post(
  "/customers/:id/credit-checks",
  requirePermission("customers.credit_check"),
  async (req, res): Promise<void> => {
    const params = InitiateCustomerCreditCheckParams.safeParse(req.params);
    const body = InitiateCustomerCreditCheckBody.safeParse(req.body);
    const user = res.locals.authUser as AuthUser;
    if (!params.success || !body.success) {
      res.status(400).json({ error: "اطلاعات استعلام معتبر نیست." });
      return;
    }
    if (!getCustomer(params.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const customer = getCustomer(params.data.id, user)!;
    const mobile = ics24.normalizeMobile(
      body.data.mobileNumber || customer.phone,
    );
    const nationalCode = ics24
      .normalizeDigits(body.data.nationalCode)
      .replace(/\D/g, "");
    if (!ics24.validNationalCode(nationalCode)) {
      res.status(400).json({ error: "کد ملی معتبر نیست." });
      return;
    }
    if (!mobile) {
      res.status(400).json({ error: "شماره موبایل معتبر ایرانی نیست." });
      return;
    }
    if (hasActiveCustomerIdentityConflict(params.data.id, { nationalCode })) {
      res.status(409).json({ error: "An active customer already has this national code" });
      return;
    }
    const staleBefore = new Date(
      Date.now() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const customerNationalCode = normalizeCustomerNationalCode(customer.nationalCode ?? "");
    const requestedNationalCode = normalizeCustomerNationalCode(nationalCode);
    const requestedMobileMatchesProfile =
      normalizeCustomerIdentity(customer.phone) === normalizeCustomerIdentity(mobile);
    const fresh = customerNationalCode === requestedNationalCode && requestedMobileMatchesProfile
      ? queryRow<any>(
        `SELECT checks.* FROM customer_credit_checks checks
         JOIN customers c ON c.id=checks.customer_id
         WHERE checks.customer_id=? AND checks.status='report_generated' AND checks.completed_at>=?
           AND (c.identity_changed_at IS NULL OR (
             checks.created_at>c.identity_changed_at AND checks.completed_at>c.identity_changed_at
           ))
         ORDER BY checks.completed_at DESC,checks.id DESC LIMIT 1`,
        [params.data.id, staleBefore],
      )
      : undefined;
    if (fresh) {
      res.json({ ...creditCheckFromRow(fresh), reused: true, freshUntil: new Date(Date.parse(fresh.completed_at) + 86400000).toISOString() });
      return;
    }
    if (activeCreditStarts.has(params.data.id)) {
      res
        .status(409)
        .json({ error: "برای این مشتری یک استعلام فعال وجود دارد." });
      return;
    }
    activeCreditStarts.add(params.data.id);
    let id: number | undefined;
    try {
      id = runImmediateTransaction(() => {
        const current = queryRow<{
          phone: string;
          national_code: string | null;
          birth_date_jalali: string | null;
          postal_code: string | null;
          identity_changed_at: string | null;
        }>("SELECT phone,national_code,birth_date_jalali,postal_code,identity_changed_at FROM customers WHERE id=?", [params.data.id]);
        if (!current) throw new Error("CUSTOMER_NOT_FOUND");
        const nextIdentity = {
          phone: current.phone,
          nationalCode,
          birthDateJalali: current.birth_date_jalali,
          postalCode: current.postal_code,
        };
        const verificationReset = customerIdentityChanged(current, nextIdentity);
        const identityChanged = customerIdentityStampChanged(current, nextIdentity);
        const now = new Date().toISOString();
        if (current.national_code !== nationalCode || verificationReset) {
          if (verificationReset) {
            executeChanges(
              `UPDATE customers SET national_code=?,identity_changed_at=CASE WHEN ? THEN ? ELSE identity_changed_at END,
                 verification_status='unverified',verification_checked_at=NULL,
                 verification_version=COALESCE(verification_version,0)+1,
                 verification_provider=NULL,shahkar_ok=NULL,person_info_ok=NULL,postal_code_info_ok=NULL,sana_ok=NULL,
                 shahkar_status=NULL,person_info_status=NULL,postal_code_info_status=NULL,sana_status=NULL
               WHERE id=?`,
              [nationalCode, identityChanged ? 1 : 0, now, params.data.id],
            );
          } else {
            executeChanges("UPDATE customers SET national_code=? WHERE id=?", [nationalCode, params.data.id]);
          }
        }
        execute(
          "UPDATE customer_credit_checks SET status='failed',error_message='مهلت استعلام منقضی شد.',updated_at=? WHERE customer_id=? AND status IN ('awaiting_otp','processing') AND created_at<?",
          [now, params.data.id, staleBefore],
        );
        const active = queryRow<{ id: number }>(
          `SELECT id FROM customer_credit_checks WHERE customer_id=? AND status IN ('awaiting_otp','processing')
             AND (? IS NULL OR created_at>?) LIMIT 1`,
          [params.data.id, identityChanged ? now : current.identity_changed_at, identityChanged ? now : current.identity_changed_at],
        );
        if (active) throw new Error("ACTIVE_CREDIT_CHECK");
        const createdAt = identityChanged
          ? new Date(Date.parse(now) + 1).toISOString()
          : new Date().toISOString();
        return execute(
          `INSERT INTO customer_credit_checks
           (customer_id,requested_by_user_id,national_code,status,created_at,updated_at)
           VALUES(?,?,?,'awaiting_otp',?,?)`,
          [params.data.id, user.id, `******${nationalCode.slice(-4)}`, createdAt, createdAt],
        );
      });
      const hash = await ics24.initiate(nationalCode, mobile);
      executeChanges(
        "UPDATE customer_credit_checks SET provider_reference = ?, updated_at = ? WHERE id = ?",
        [hash, new Date().toISOString(), id],
      );
      const result = getCreditCheck(params.data.id, id)!;
      res
        .status(201)
        .json(
          InitiateCustomerCreditCheckResponse.parse(creditCheckFromRow(result)),
        );
    } catch (error) {
      if (error instanceof Error && error.message === "ACTIVE_CREDIT_CHECK") {
        res.status(409).json({ error: "برای این مشتری یک استعلام فعال وجود دارد." });
        return;
      }
      if (error instanceof Error && error.message === "CUSTOMER_NOT_FOUND") {
        res.status(404).json({ error: "Customer not found" });
        return;
      }
      if (id === undefined) throw error;
      executeChanges(
        "UPDATE customer_credit_checks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
        [
          error instanceof Error
            ? error.message.slice(0, 240)
            : "شروع استعلام ناموفق بود.",
          new Date().toISOString(),
          id,
        ],
      );
      res
        .status(502)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "سرویس اعتبارسنجی در دسترس نیست.",
        });
    } finally {
      activeCreditStarts.delete(params.data.id);
    }
  },
);

router.post(
  "/customers/:id/credit-checks/:checkId/validate",
  requirePermission("customers.credit_check"),
  async (req, res): Promise<void> => {
    const params = ValidateCustomerCreditCheckParams.safeParse(req.params);
    const body = ValidateCustomerCreditCheckBody.safeParse(req.body);
    const user = res.locals.authUser as AuthUser;
    if (!params.success || !body.success) {
      res.status(400).json({ error: "رمز یک‌بارمصرف معتبر نیست." });
      return;
    }
    if (!getCustomer(params.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const row = getCreditCheck(params.data.id, params.data.checkId);
    if (!row || row.status !== "awaiting_otp") {
      res.status(404).json({ error: "Credit check not found" });
      return;
    }
    try {
      const current = await refreshCreditCheck(row);
      if (current.status === "report_generated" || current.status === "processing") {
        res.json(ValidateCustomerCreditCheckResponse.parse(creditCheckFromRow(current)));
        return;
      }
      if (current.status === "failed") {
        res.status(422).json({ error: current.error_message || "این استعلام پایان یافته است؛ استعلام جدیدی آغاز کنید." });
        return;
      }
      await ics24.validate(row.provider_reference!, body.data.otp);
      execute(
        "UPDATE customer_credit_checks SET status = 'processing', updated_at = ?, error_message = NULL WHERE id = ?",
        [new Date().toISOString(), row.id],
      );
      const result = await refreshCreditCheck(
        getCreditCheck(row.customer_id, row.id)!,
      );
      res.json(
        ValidateCustomerCreditCheckResponse.parse(creditCheckFromRow(result)),
      );
    } catch (error) {
      const terminal = creditProviderFailure(null, error instanceof Error ? error.message : null);
      if (terminal) {
        execute("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
          [terminal, new Date().toISOString(), row.id]);
        res.status(422).json({ error: terminal });
        return;
      }
      execute(
        "UPDATE customer_credit_checks SET error_message = ?, updated_at = ? WHERE id = ?",
        [
          error instanceof Error
            ? error.message.slice(0, 240)
            : "اعتبارسنجی OTP ناموفق بود.",
          new Date().toISOString(),
          row.id,
        ],
      );
      res
        .status(502)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "اعتبارسنجی OTP ناموفق بود.",
        });
    }
  },
);

router.post(
  "/customers/:id/credit-checks/:checkId/renew",
  requirePermission("customers.credit_check"),
  async (req, res): Promise<void> => {
    const params = RenewCustomerCreditCheckOtpParams.safeParse(req.params);
    const user = res.locals.authUser as AuthUser;
    if (!params.success || !getCustomer(params.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const row = getCreditCheck(params.data.id, params.data.checkId);
    if (!row || row.status !== "awaiting_otp") {
      res.status(404).json({ error: "Credit check not found" });
      return;
    }
    try {
      // A provider-side terminal result can arrive while our local row still
      // says awaiting_otp. Do not request another OTP for a closed request.
      const current = await refreshCreditCheck(row);
      if (current.status !== "awaiting_otp") {
        res.status(409).json({
          error: current.status === "failed"
            ? current.error_message || "این استعلام پایان یافته است؛ استعلام جدیدی آغاز کنید."
            : "استعلام دیگر منتظر کد نیست؛ وضعیت پرونده را به‌روزرسانی کنید.",
        });
        return;
      }
      await ics24.renew(row.provider_reference!);
      execute("UPDATE customer_credit_checks SET updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        row.id,
      ]);
      res.json(
        RenewCustomerCreditCheckOtpResponse.parse(
          creditCheckFromRow(getCreditCheck(row.customer_id, row.id)!),
        ),
      );
    } catch (error) {
      const reason = error instanceof Error
        ? error.message.slice(0, 240)
        : "ارسال مجدد رمز انجام نشد.";
      const terminal = creditProviderFailure(null, reason);
      if (terminal) {
        execute("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
          [terminal, new Date().toISOString(), row.id]);
        res.status(409).json({ error: terminal });
        return;
      }
      executeChanges(
        "UPDATE customer_credit_checks SET error_message = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_otp'",
        [reason, new Date().toISOString(), row.id],
      );
      res
        .status(502)
        .json({
          error: reason,
        });
    }
  },
);

router.post(
  "/customers/:id/credit-checks/:checkId/status",
  requirePermission("customers.credit_check"),
  async (req, res): Promise<void> => {
    const params = RefreshCustomerCreditCheckStatusParams.safeParse(req.params);
    const user = res.locals.authUser as AuthUser;
    if (!params.success || !getCustomer(params.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const row = getCreditCheck(params.data.id, params.data.checkId);
    if (!row) {
      res.status(404).json({ error: "Credit check not found" });
      return;
    }
    const result = await refreshCreditCheck(row);
    res.json(
      RefreshCustomerCreditCheckStatusResponse.parse(
        creditCheckFromRow(result),
      ),
    );
  },
);

router.get(
  "/customers/:id/credit-checks/:checkId/report.pdf",
  requirePermission("customers.credit_check"),
  async (req, res): Promise<void> => {
    const params = RefreshCustomerCreditCheckStatusParams.safeParse(req.params);
    const user = res.locals.authUser as AuthUser;
    if (!params.success || !getCustomer(params.data.id, user)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const row = getCreditCheck(params.data.id, params.data.checkId);
    if (!row?.provider_reference) {
      res.status(404).json({ error: "Credit check not found" });
      return;
    }
    try {
      const provider = await ics24.status(row.provider_reference);
      if (provider.status !== "ReportGenerated" || !provider.reportCode) {
        res.status(409).json({ error: "گزارش PDF هنوز آماده نیست." });
        return;
      }
      const pdf = await ics24.reportPdf(provider.reportCode);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="credit-report-${row.id}.pdf"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.send(Buffer.from(pdf));
    } catch (error) {
      res
        .status(502)
        .json({
          error:
            error instanceof Error
              ? error.message
              : "دریافت فایل گزارش انجام نشد.",
        });
    }
  },
);

router.get(
  "/customers/:id/activity",
  requirePermission("customers.view"),
  (req, res): void => {
    const parsed = ListCustomerActivityParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!getCustomer(parsed.data.id, res.locals.authUser as AuthUser)) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json(ListCustomerActivityResponse.parse(getActivity(parsed.data.id)));
  },
);

router.get(
  "/salespersons",
  requirePermission("customers.view"),
  (_req, res): void => {
    const user = res.locals.authUser as AuthUser;
    const ownIdentityOnly = user.customerScope === "assigned";
    const rows = queryRows<{
      id: number;
      name: string;
      mobile: string | null;
      active: number;
      customer_count: number;
    }>(`
    SELECT
      s.id,
      COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), s.name) AS name,
      s.mobile,
      s.active,
      COUNT(c.id) AS customer_count
    FROM salespersons s
    LEFT JOIN users u ON u.salesperson_id = s.id AND u.role = 'salesperson'
    LEFT JOIN customers c ON c.salesperson_id = s.id
    ${ownIdentityOnly ? "WHERE s.id = ?" : ""}
    GROUP BY s.id, u.id
    ORDER BY s.active DESC, name
  `, ownIdentityOnly && user.salespersonId !== null ? [user.salespersonId] : ownIdentityOnly ? [-1] : []);
    res.json(
      ListSalespersonsResponse.parse(
        rows.map((row) => ({
          id: Number(row.id),
          name: row.name,
          mobile: row.mobile ?? null,
          active: Boolean(row.active),
          customerCount: Number(row.customer_count),
        })),
      ),
    );
  },
);

router.get(
  "/allocation-programs",
  requirePermission("allocation_programs.view"),
  (_req, res): void => {
    const rows = queryRows<{ id: number }>(
      `SELECT id FROM allocation_programs WHERE active = 1 ORDER BY is_default DESC, name, id`,
    );
    res.json(
      ListAllocationProgramsResponse.parse(
        rows.map((row) => getAllocationProgram(Number(row.id))).filter(Boolean),
      ),
    );
  },
);

router.post(
  "/allocation-programs",
  requirePermission("allocation_programs.manage"),
  (req, res): void => {
    const parsed = CreateAllocationProgramBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    if (
      new Set(body.items.map((item) => item.salespersonId)).size !==
      body.items.length
    ) {
      res.status(400).json({ error: "Each salesperson can appear only once" });
      return;
    }
    const now = new Date().toISOString();
    const id = runTransaction(() => {
      if (body.isDefault)
        executeChanges("UPDATE allocation_programs SET is_default = 0");
      const programId = execute(
        `INSERT INTO allocation_programs
       (name, is_default, active, cursor_item_index, cursor_item_used, created_at, updated_at)
       VALUES (?, ?, 1, 0, 0, ?, ?)`,
        [body.name.trim(), body.isDefault ? 1 : 0, now, now],
      );
      body.items.forEach((item, index) =>
        execute(
          `INSERT INTO allocation_program_items (program_id, salesperson_id, quota, sort_order)
       VALUES (?, ?, ?, ?)`,
          [programId, item.salespersonId, item.quota, index],
        ),
      );
      return programId;
    });
    const program = getAllocationProgram(id);
    res.status(201).json(CreateAllocationProgramResponse.parse(program));
  },
);

router.patch(
  "/allocation-programs/:id",
  requirePermission("allocation_programs.manage"),
  (req, res): void => {
    const params = UpdateAllocationProgramParams.safeParse(req.params);
    const parsed = UpdateAllocationProgramBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!getAllocationProgram(params.data.id)) {
      res.status(404).json({ error: "Allocation program not found" });
      return;
    }
    const body = parsed.data;
    if (
      new Set(body.items.map((item) => item.salespersonId)).size !==
      body.items.length
    ) {
      res.status(400).json({ error: "Each salesperson can appear only once" });
      return;
    }
    runTransaction(() => {
      if (body.isDefault)
        executeChanges("UPDATE allocation_programs SET is_default = 0");
      executeChanges(
        `UPDATE allocation_programs
       SET name = ?, is_default = ?, cursor_item_index = 0, cursor_item_used = 0, updated_at = ?
       WHERE id = ?`,
        [
          body.name.trim(),
          body.isDefault ? 1 : 0,
          new Date().toISOString(),
          params.data.id,
        ],
      );
      executeChanges(
        "DELETE FROM allocation_program_items WHERE program_id = ?",
        [params.data.id],
      );
      body.items.forEach((item, index) =>
        execute(
          `INSERT INTO allocation_program_items (program_id, salesperson_id, quota, sort_order)
       VALUES (?, ?, ?, ?)`,
          [params.data.id, item.salespersonId, item.quota, index],
        ),
      );
    });
    res.json(
      UpdateAllocationProgramResponse.parse(
        getAllocationProgram(params.data.id),
      ),
    );
  },
);

router.get(
  "/reminders",
  requirePermission("reminders.view"),
  (req, res): void => {
    const parsed = ListRemindersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const done =
      req.query.done === "false"
        ? false
        : req.query.done === "true"
          ? true
          : parsed.data.done;
    const due =
      req.query.due === "false"
        ? false
        : req.query.due === "true"
          ? true
          : parsed.data.due;
    const filters = ["r.user_id = ?"];
    const params: SqlValue[] = [user.id];
    if (user.customerScope === "assigned") {
      filters.push("(r.customer_id IS NULL OR (c.merged_into_customer_id IS NULL AND c.salesperson_id = ?))");
      params.push(user.salespersonId);
    }
    if (done !== undefined) {
      filters.push("r.done = ?");
      params.push(done ? 1 : 0);
    }
    if (due === true) {
      filters.push("r.remind_at <= ?");
      filters.push("r.notified_at IS NULL");
      params.push(new Date().toISOString());
    }
    const rows = queryRows<ReminderRow>(
      `
      SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
        s.name AS customer_salesperson_name,
        r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
      FROM reminders r
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN salespersons s ON s.id = c.salesperson_id
      WHERE ${filters.join(" AND ")}
      ORDER BY r.done ASC, r.remind_at ASC
    `,
      params,
    );
    res.json(ListRemindersResponse.parse(rows.map(row => reminderFromRow(row, user))));
  },
);

router.post(
  "/reminders",
  requirePermission("reminders.manage"),
  (req, res): void => {
    const parsed = CreateReminderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    if (Number.isNaN(Date.parse(parsed.data.remindAt))) {
      res.status(400).json({ error: "Invalid reminder date" });
      return;
    }
    if (Date.parse(parsed.data.remindAt) <= Date.now()) {
      res.status(400).json({ error: "موعد یادآور باید در آینده باشد." });
      return;
    }
    if (parsed.data.customerId != null) {
      const customer = getCustomer(parsed.data.customerId, user);
      if (!customer) {
        res.status(404).json({ error: "Customer not found" });
        return;
      }
    }
    const id = execute(
      `INSERT INTO reminders
      (user_id, salesperson_id, customer_id, subject, message, remind_at, sent_sms, done, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        user.id,
        user.salespersonId,
        parsed.data.customerId ?? null,
        parsed.data.subject.trim(),
        parsed.data.message.trim(),
        new Date(parsed.data.remindAt).toISOString(),
        new Date().toISOString(),
      ],
    );
    const row = queryRow<ReminderRow>(
      `SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
       s.name AS customer_salesperson_name,
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
      FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN salespersons s ON s.id = c.salesperson_id WHERE r.id = ?`,
      [id],
    );
    if (!row) {
      res.status(500).json({ error: "Reminder was not created" });
      return;
    }
    res.status(201).json(CreateReminderResponse.parse(reminderFromRow(row, user)));
  },
);

router.patch(
  "/reminders",
  requirePermission("reminders.manage"),
  (req, res): void => {
    const parsed = UpdateReminderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const scope = user.customerScope === "assigned"
      ? " AND (r.customer_id IS NULL OR EXISTS (SELECT 1 FROM customers owner WHERE owner.id=r.customer_id AND owner.merged_into_customer_id IS NULL AND owner.salesperson_id=?))"
      : "";
    const params = user.customerScope === "assigned" ? [user.salespersonId] : [];
    const changes = executeChanges(
      `UPDATE reminders AS r SET done = ? WHERE r.id = ? AND r.user_id = ?${scope}`,
      [parsed.data.done ? 1 : 0, parsed.data.id, user.id, ...params],
    );
    if (!changes) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    const row = queryRow<ReminderRow>(
      `SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
       s.name AS customer_salesperson_name,
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
     FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN salespersons s ON s.id = c.salesperson_id
     WHERE r.id = ? AND r.user_id = ?${scope}`,
      [parsed.data.id, user.id, ...params],
    );
    if (!row) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    res.json(UpdateReminderResponse.parse(reminderFromRow(row, user)));
  },
);

router.post(
  "/reminders/:id/acknowledge",
  requirePermission("reminders.manage"),
  (req, res): void => {
    const parsed = AcknowledgeReminderParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    const scope = user.customerScope === "assigned"
      ? " AND (r.customer_id IS NULL OR EXISTS (SELECT 1 FROM customers owner WHERE owner.id=r.customer_id AND owner.merged_into_customer_id IS NULL AND owner.salesperson_id=?))"
      : "";
    const params = user.customerScope === "assigned" ? [user.salespersonId] : [];
    executeChanges(
      `UPDATE reminders AS r SET notified_at = COALESCE(notified_at, ?) WHERE r.id = ? AND r.user_id = ?${scope}`,
      [new Date().toISOString(), parsed.data.id, user.id, ...params],
    );
    const row = queryRow<ReminderRow>(
      `SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
       s.name AS customer_salesperson_name,
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
     FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN salespersons s ON s.id = c.salesperson_id
     WHERE r.id = ? AND r.user_id = ?${scope}`,
      [parsed.data.id, user.id, ...params],
    );
    if (!row) {
      res.status(404).json({ error: "Reminder not found" });
      return;
    }
    res.json(AcknowledgeReminderResponse.parse(reminderFromRow(row, user)));
  },
);

const callSelect = `
  SELECT
    cl.id,
    cl.customer_id,
    cl.salesperson_id,
    cl.salesperson_name_snapshot AS salesperson_name,
    cl.subject,
    cl.customer_request,
    cl.expert_notes,
    cl.created_at,
    c.name AS customer_name,
    c.phone AS customer_phone,
    c.salesperson_id AS customer_owner,
    (SELECT e.phone FROM voip_after_call_events e WHERE e.call_log_id=cl.id) AS event_phone,
    (SELECT e.extension FROM voip_after_call_events e WHERE e.call_log_id=cl.id) AS call_extension,
    s.name AS customer_salesperson_name
  FROM call_logs cl
  JOIN customers c ON c.id = cl.customer_id
  LEFT JOIN salespersons s ON s.id = c.salesperson_id
`;

router.get("/calls", requirePermission("calls.view"), (req, res): void => {
  const parsed = ListCallsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, customerId, from, to } = parsed.data;
  // CSV export (?purpose=export) keeps the old salesperson scope; the list uses the new one.
  const actorScope = callListActorScope(res.locals.authUser as AuthUser, isCallExportRequest(req.query as Record<string, unknown>) ? "export" : "list");
  const salespersonId = actorScope.forcedSalespersonId ?? parsed.data.salespersonId;
  let dates: ReturnType<typeof callReportDateBounds>;
  try { dates = callReportDateBounds({ from, to }); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const filters: string[] = [];
  const params: SqlValue[] = [];
  const user = res.locals.authUser as AuthUser;
  filters.push(...actorScope.filters); params.push(...actorScope.params);
  const callIdSearch = search ? customerSearchSql(search) : null;
  // Name / id search: the customer must be owned now, or the call logged by this salesperson.
  // (CSV export: owned now only, as before.)
  const ownerOnly = actorScope.ownerOnly.sql;
  const ownerParams = actorScope.ownerOnly.params;
  if (search && callIdSearch?.idQuery?.explicit) {
    // «#1234»: only that customer's calls (same ownership rule as the name match).
    filters.push(`(cl.customer_id=? AND ${ownerOnly})`);
    params.push(callIdSearch.idQuery.id, ...ownerParams);
  } else if (search && callIdSearch) {
    const text = callIdSearch.text;
    filters.push(
      `((crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) AND ${ownerOnly})
        OR COALESCE((SELECT e.phone FROM voip_after_call_events e WHERE e.call_log_id=cl.id),c.phone) LIKE ?
        OR LOWER(COALESCE(cl.subject, '')) LIKE LOWER(?) OR LOWER(COALESCE(cl.customer_request, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(cl.expert_notes,'')) LIKE LOWER(?)${callIdSearch.idQuery ? ` OR (cl.customer_id=? AND ${ownerOnly})` : ""})`,
    );
    params.push(`%${text}%`, ...ownerParams,
      `%${text}%`, `%${text}%`, `%${text}%`, `%${text}%`,
      ...(callIdSearch.idQuery ? [callIdSearch.idQuery.id, ...ownerParams] : []));
  }
  if (customerId !== undefined) {
    if (!getCustomer(customerId, user)) { res.status(404).json({ error: "Customer not found" }); return; }
    filters.push("cl.customer_id = ?");
    params.push(customerId);
  }
  if (salespersonId !== undefined) {
    filters.push("cl.salesperson_id = ?");
    params.push(salespersonId);
  }
  if (dates.start) { filters.push("julianday(cl.created_at)>=julianday(?)"); params.push(dates.start); }
  if (dates.endExclusive) { filters.push("julianday(cl.created_at)<julianday(?)"); params.push(dates.endExclusive); }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const unmatchedFilters=["e.call_log_id IS NULL", "COALESCE(json_extract(e.completed_payload,'$.discardHistory'),0)=0",
    "julianday(e.started_at)>=julianday(?)", "NOT EXISTS(SELECT 1 FROM voip_call_display_exclusions h WHERE h.phone=e.phone)"];
  const unmatchedParams:SqlValue[]=["2026-10-04T00:00:00+03:30"];
  if(customerId!==undefined)unmatchedFilters.push("0=1");
  if(user.role!=="admin"){
    unmatchedFilters.push("e.expert_user_id=? AND EXISTS(SELECT 1 FROM voip_extensions own WHERE own.user_id=? AND own.extension=e.extension)");
    unmatchedParams.push(user.id,user.id);
  }
  if(search&&callIdSearch?.idQuery?.explicit){
    unmatchedFilters.push("0=1");
  }else if(search){
    const text=callIdSearch?.text??search;
    unmatchedFilters.push("(e.phone LIKE ? OR COALESCE(e.report_subject,'') LIKE ? OR e.expert_notes LIKE ?)");
    unmatchedParams.push(`%${text}%`,`%${text}%`,`%${text}%`);
  }
  if(salespersonId!==undefined){unmatchedFilters.push("e.salesperson_id=?");unmatchedParams.push(salespersonId);}
  if(dates.start){unmatchedFilters.push("julianday(e.started_at)>=julianday(?)");unmatchedParams.push(dates.start);}
  if(dates.endExclusive){unmatchedFilters.push("julianday(e.started_at)<julianday(?)");unmatchedParams.push(dates.endExclusive);}
  const unmatchedWhere=unmatchedFilters.join(" AND ");
  const unmatchedSelect=`SELECT -e.id id,NULL customer_id,e.salesperson_id,e.expert_name salesperson_name,e.report_subject subject,
    NULL customer_request,e.expert_notes,e.started_at created_at,'مخاطب تماس داخلی' customer_name,e.phone customer_phone,
    NULL customer_owner,e.phone event_phone,e.extension call_extension,NULL customer_salesperson_name
    FROM voip_after_call_events e WHERE ${unmatchedWhere}`;
  const combined=`${callSelect}${where} UNION ALL ${unmatchedSelect}`;
  const total = queryRow<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${combined})`,
    [...params,...unmatchedParams],
  );
  const rows = queryRows<CallRecordRow>(
    `SELECT * FROM (${combined}) ORDER BY ${callIdSearch?.orderPrefix("customer_id").sql ?? ""}created_at DESC,id DESC LIMIT ? OFFSET ?`,
    [...params,...unmatchedParams, ...(callIdSearch?.orderPrefix("customer_id").params ?? []), limit, offset],
  );
  res.json(
    ListCallsResponse.parse({
      items: rows.map(row => {
        const call = {...callFromRow(row),customerId:row.customer_id==null?null:Number(row.customer_id),systemSummary:systemSummaryForCall(row.id)};
        return user.role !== "admin" && user.customerScope === "assigned" && (user.salespersonId == null || row.customer_owner !== user.salespersonId)
          ? { ...call, customerId: null, customerName: "مخاطب تماس داخلی", customerPhone: row.event_phone ?? "", customerSalespersonName: null }
          : call;
      }),
      total: Number(total?.total ?? 0),
      limit,
      offset,
    }),
  );
});

router.post("/calls", requirePermission("calls.create"), (req, res): void => {
  // crm-nid-optional: a blank «کد ملی» in the call profile means "not entered" (never a wipe).
  if (req.body?.profile && typeof req.body.profile === "object" && typeof req.body.profile.nationalCode === "string" && !req.body.profile.nationalCode.trim())
    req.body.profile.nationalCode = null;
  const parsed = CreateCallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  // crm-call-note-min: «یادداشت کارشناس» is required (trimmed, >= 10 characters).
  const callNoteErr = callNoteError(body.expertNotes);
  if (callNoteErr) {
    res.status(400).json({ error: callNoteErr });
    return;
  }
  body.expertNotes = String(body.expertNotes).trim();
  const user = res.locals.authUser as AuthUser;
  if (!getCustomer(body.customerId, user)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  if (
    body.reminder &&
    user.role !== "admin" &&
    !user.permissions.includes("reminders.manage")
  ) {
    res
      .status(403)
      .json({ error: "Forbidden", permission: "reminders.manage" });
    return;
  }
  if (body.reminder && Number.isNaN(Date.parse(body.reminder.remindAt))) {
    res.status(400).json({ error: "Invalid reminder date" });
    return;
  }
  if (body.reminder && Date.parse(body.reminder.remindAt) <= Date.now()) {
    res.status(400).json({ error: "موعد یادآور باید در آینده باشد." });
    return;
  }
  let profile: {
    nationalCode: string | null;
    postalCode: string | null;
    birthDateJalali: string | null;
  } | null = null;
  try {
    if (body.profile) {
      const nationalCode = body.profile.nationalCode
        ? ics24.normalizeDigits(body.profile.nationalCode).replace(/\D/g, "") ||
          null
        : null;
      if (nationalCode !== null && !ics24.validNationalCode(nationalCode))
        throw new Error("کد ملی معتبر نیست.");
      profile = {
        nationalCode,
        postalCode: normalizePostalCode(body.profile.postalCode),
        birthDateJalali: normalizeJalaliDate(body.profile.birthDateJalali),
      };
    }
  } catch (error) {
    res
      .status(400)
      .json({
        error:
          error instanceof Error
            ? error.message
            : "اطلاعات پروفایل معتبر نیست.",
      });
    return;
  }
  if (profile && hasActiveCustomerIdentityConflict(body.customerId, { nationalCode: profile.nationalCode })) {
    res.status(409).json({ error: "An active customer already has this national code" });
    return;
  }
  const id = runTransaction(() => {
    if (profile) {
      const current = queryRow<{ phone: string; national_code: string | null; postal_code: string | null; birth_date_jalali: string | null }>(
        "SELECT phone,national_code,postal_code,birth_date_jalali FROM customers WHERE id=?",
        [body.customerId],
      );
      // crm-nid-optional: an empty «کد ملی» in the call form never erases the stored code.
      if (profile.nationalCode === null && current?.national_code) profile.nationalCode = current.national_code;
      const nextIdentity = {
        phone: current?.phone ?? "",
        nationalCode: profile.nationalCode,
        postalCode: profile.postalCode,
        birthDateJalali: profile.birthDateJalali,
      };
      const changed = !current || customerIdentityChanged(current, nextIdentity);
      const stampChanged = !!current && customerIdentityStampChanged(current, nextIdentity);
      const prevCode = current?.national_code ? normalizeCustomerNationalCode(current.national_code) : "";
      if (current && profile.nationalCode && profile.nationalCode !== prevCode) {
        ensureIdentityLogSchema();
        execute(
          `INSERT INTO ${IDENTITY_LOG_TABLE} (customer_id,old_national_code,new_national_code,identity_changed,source,actor_user_id,created_at)
           VALUES (?,?,?,?,'call_profile',?,?)`,
          [body.customerId, prevCode || null, profile.nationalCode, stampChanged ? 1 : 0, user.id, new Date().toISOString()]);
      }
      executeChanges(
        `UPDATE customers SET national_code=?,postal_code=?,birth_date_jalali=?${stampChanged
          ? ",identity_changed_at=?"
          : ""}${changed
          ? ",verification_version=COALESCE(verification_version,0)+1"
          : ""}${changed
          ? ",verification_status='unverified',verification_checked_at=NULL,verification_provider=NULL,shahkar_ok=NULL,person_info_ok=NULL,postal_code_info_ok=NULL,sana_ok=NULL,shahkar_status=NULL,person_info_status=NULL,postal_code_info_status=NULL,sana_status=NULL"
          : ""} WHERE id=?`,
        [
          profile.nationalCode, profile.postalCode, profile.birthDateJalali,
          ...(stampChanged ? [new Date().toISOString()] : []),
          body.customerId,
        ],
      );
    }
    const callSalespersonId =
      user.customerScope === "assigned"
        ? user.salespersonId
        : (body.salespersonId ?? null);
    const callSalesperson = callSalespersonId == null
      ? null
      : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [callSalespersonId]);
    const callId = savePendingAfterCallHistory(body.customerId, user, {
      subject: body.subject ?? null, customerRequest: body.customerRequest ?? null,
      expertNotes: body.expertNotes ?? null,
    }) ?? execute(
      `
      INSERT INTO call_logs
        (customer_id, salesperson_id, salesperson_name_snapshot, subject, customer_request, expert_notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        body.customerId,
        callSalespersonId,
        callSalesperson?.name ?? null,
        body.subject ?? null,
        body.customerRequest ?? null,
        body.expertNotes ?? null,
        new Date().toISOString(),
      ],
    );
    if (body.reminder)
      execute(
        `INSERT INTO reminders
        (user_id, salesperson_id, customer_id, subject, message, remind_at, sent_sms, done, created_at, call_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [
          user.id,
          user.salespersonId,
          body.customerId,
          body.reminder.subject.trim(),
          body.reminder.message.trim(),
          new Date(body.reminder.remindAt).toISOString(),
          new Date().toISOString(),
          callId,
        ],
      );
    return callId;
  });
  const row = queryRow<CallRecordRow>(`${callSelect} WHERE cl.id = ?`, [id]);
  if (!row) {
    res.status(500).json({ error: "Call log was not created" });
    return;
  }
  res.status(201).json(CreateCallResponse.parse(callFromRow(row)));
});

const consultationSelect = `
  SELECT
    cf.*,
    c.name AS customer_name,
    c.phone AS customer_phone,
    c.credit_rank AS customer_credit_rank,
    s.name AS customer_salesperson_name
  FROM consultation_forms cf
  JOIN customers c ON c.id = cf.customer_id
  LEFT JOIN salespersons s ON s.id = c.salesperson_id
`;

export function getConsultation(id: number, user?: AuthUser) {
  const ownerFilter =
    user?.customerScope === "assigned" ? " AND c.salesperson_id = ?" : "";
  const row = queryRow<ConsultationRow>(
    `${consultationSelect} WHERE cf.id = ?${ownerFilter}`,
    user?.customerScope === "assigned" ? [id, user.salespersonId] : [id],
  );
  return row ? consultationFromRow(row) : undefined;
}

export function consultationFields(body: Record<string, unknown>) {
  const values: Array<[string, SqlValue]> = [];
  const boolFields = new Set([
    "hasCheck",
    "hasPromissory",
    "hasGuarantor",
    "hasGuarantorCheck",
    "hasGuarantorPromissory",
    "hasBusinessLicense",
    "hasAccountTurnover",
    "needsFastReceive",
    "hasAvgBalance",
    "hasCustomerSalaryDeduct",
    "hasGuarantorSalaryDeduct",
  ]);
  const columns: Record<string, string> = {
    customerId: "customer_id",
    questionnaireVersion: "questionnaire_version",
    hasCheck: "has_check",
    hasPromissory: "has_promissory",
    hasGuarantor: "has_guarantor",
    hasGuarantorCheck: "has_guarantor_check",
    hasGuarantorPromissory: "has_guarantor_promissory",
    jobType: "job_type",
    hasBusinessLicense: "has_business_license",
    hasAccountTurnover: "has_account_turnover",
    creditRank: "credit_rank",
    needsFastReceive: "needs_fast_receive",
    hasAvgBalance: "has_avg_balance",
    loanPurpose: "loan_purpose",
    requestedAmount: "requested_amount",
    extraNotes: "extra_notes",
    guarantorCreditRank: "guarantor_credit_rank",
    guarantorCheckType: "guarantor_check_type",
    guarantorJobType: "guarantor_job_type",
    collateralType: "collateral_type",
    guarantorCollateralType: "guarantor_collateral_type",
    customerCheckStatus: "customer_check_status",
    receiveMode: "receive_mode",
    loanPref: "loan_pref",
    needDays: "need_days",
    hasCustomerSalaryDeduct: "has_customer_salary_deduct",
    hasGuarantorSalaryDeduct: "has_guarantor_salary_deduct",
  };
  for (const [key, column] of Object.entries(columns)) {
    // Applicant rank is handled separately below: v1 keeps a declared advice
    // snapshot, while legacy requests retain the verified-profile behavior.
    if (key === "creditRank") continue;
    if (body[key] !== undefined) {
      const value = body[key];
      values.push([
        column,
        boolFields.has(key) ? (value ? 1 : 0) : (value as SqlValue),
      ]);
    }
  }
  return values;
}

function activeGradeOptions(fieldKey: string): string[] {
  return queryRows<{ option_value: string }>(
    "SELECT option_value FROM consult_options WHERE active=1 AND field_key=?", [fieldKey],
  ).map(row => row.option_value);
}

function authoritativeCreditRank(customerId: number): string | null {
  const row = queryRow<{ credit_rank: string | null }>(
    "SELECT credit_rank FROM customers WHERE id = ?",
    [customerId],
  );
  return row?.credit_rank?.trim() || null;
}

router.get(
  "/consultations",
  requirePermission("consultations.view"),
  (req, res): void => {
    const parsed = ListConsultationsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { search, customerId } = parsed.data;
    const limit = parsed.data.limit ?? 50;
    const offset = parsed.data.offset ?? 0;
    const filters: string[] = [];
    const params: SqlValue[] = [];
    const user = res.locals.authUser as AuthUser;
    if (user.customerScope === "assigned") {
      filters.push("c.salesperson_id = ?");
      params.push(user.salespersonId);
    }
    const consultIdSearch = search ? customerSearchSql(search) : null;
    if (search && consultIdSearch) {
      const t = consultIdSearch.text;
      const clause = consultIdSearch.where(
        "(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ? OR LOWER(COALESCE(cf.loan_purpose, '')) LIKE LOWER(?))",
        [`%${t}%`, `%${t}%`, `%${t}%`],
        "c.id",
      );
      filters.push(clause.sql);
      params.push(...clause.params);
    }
    if (customerId !== undefined) {
      filters.push("cf.customer_id = ?");
      params.push(customerId);
    }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const total = queryRow<{ total: number }>(
      `SELECT COUNT(*) AS total FROM consultation_forms cf JOIN customers c ON c.id = cf.customer_id${where}`,
      params,
    );
    const rows = queryRows<ConsultationRow>(
      `${consultationSelect}${where} ORDER BY ${consultIdSearch?.orderPrefix("c.id").sql ?? ""}cf.created_at DESC,cf.id DESC LIMIT ? OFFSET ?`,
      [...params, ...(consultIdSearch?.orderPrefix("c.id").params ?? []), limit, offset],
    );
    res.json(
      ListConsultationsResponse.parse({
        items: rows.map(consultationFromRow),
        total: Number(total?.total ?? 0),
        limit,
        offset,
      }),
    );
  },
);

router.post(
  "/consultations",
  requirePermission("consultations.create"),
  (req, res): void => {
    const parsed = CreateConsultationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data as Record<string, unknown>;
    if (
      !getCustomer(Number(body.customerId), res.locals.authUser as AuthUser)
    ) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const questionnaireIssue = questionnaireError(body, consultationQuestionnaireOptions());
    if (questionnaireIssue) {
      res.status(400).json({ error: questionnaireIssue });
      return;
    }
    if (body.questionnaireVersion === 1 || body.questionnaireVersion === 2) {
      body.hasCheck = body.customerCheckStatus !== "none";
      body.hasGuarantorCheck = Boolean(body.hasGuarantor && body.guarantorCheckType !== "none");
      if (body.questionnaireVersion === 2) {
        body.hasPromissory = true;
        body.hasGuarantorPromissory = Boolean(body.hasGuarantor);
      }
      if (!body.hasGuarantor) {
        body.guarantorCreditRank = null;
        body.guarantorCheckType = "none";
        body.hasGuarantorSalaryDeduct = false;
      }
    }
    if (body.guarantorCreditRank !== undefined) {
      const grade = acceptedGradeEdit(body.guarantorCreditRank, null, activeGradeOptions("guarantor_credit_rank"));
      if (!grade.ok) {
        res.status(400).json({ error: GRADE_EDIT_ERROR });
        return;
      }
      body.guarantorCreditRank = grade.value;
    }
    const values = consultationFields(body);
    const currentCreditRank = body.questionnaireVersion === 1 || body.questionnaireVersion === 2
      ? String(body.creditRank) : authoritativeCreditRank(Number(body.customerId));
    const rank = values.find(([column]) => column === "credit_rank");
    if (rank) rank[1] = currentCreditRank;
    else values.push(["credit_rank", currentCreditRank]);
    const columns = values.map(([column]) => column);
    const params = values.map(([, value]) => value);
    const savedAt = new Date().toISOString();
    columns.push("updated_at", "created_at");
    params.push(savedAt, savedAt);
    const id = runTransaction(() => {
      const id = execute(
        `INSERT INTO consultation_forms (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        params,
      );
      const saved = getConsultation(id, res.locals.authUser as AuthUser);
      if (!saved) throw new Error("Consultation was not created");
      const matches = MatchConsultationLoanPlansResponse.parse(computeConsultationPlanMatches(saved));
      executeChanges(
        "UPDATE consultation_forms SET plan_matches_snapshot = ? WHERE id = ?",
        [JSON.stringify({ capturedAt: savedAt, requestedAmount: saved.requestedAmount, matches }), id],
      );
      return id;
    });
    const consultation = getConsultation(id, res.locals.authUser as AuthUser);
    if (!consultation) {
      res.status(500).json({ error: "Consultation was not created" });
      return;
    }
    res.status(201).json(CreateConsultationResponse.parse(consultation));
  },
);

router.get(
  "/consultations/:id",
  requirePermission("consultations.view"),
  (req, res): void => {
    const parsed = GetConsultationParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const consultation = getConsultation(
      parsed.data.id,
      res.locals.authUser as AuthUser,
    );
    if (!consultation) {
      res.status(404).json({ error: "Consultation not found" });
      return;
    }
    res.json(GetConsultationResponse.parse(consultation));
  },
);

router.patch(
  "/consultations/:id",
  requirePermission("consultations.update"),
  (req, res): void => {
    const params = UpdateConsultationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateConsultationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const user = res.locals.authUser as AuthUser;
    if (!getConsultation(params.data.id, user)) {
      res.status(404).json({ error: "Consultation not found" });
      return;
    }
    if (
      parsed.data.customerId !== undefined &&
      !getCustomer(parsed.data.customerId, user)
    ) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const values = consultationFields(parsed.data as Record<string, unknown>);
    const hadUpdateFields = values.length > 0;
    const existing = getConsultation(params.data.id, user);
    if ((existing?.questionnaireVersion ?? 0) >= 1) {
      res.status(409).json({ error: "این مشاوره سابقهٔ مستقل وضعیت مشتری است؛ برای تغییر وضعیت، مشاورهٔ جدید ثبت کنید." });
      return;
    }
    const guarantorGrade = values.find(([column]) => column === "guarantor_credit_rank");
    if (guarantorGrade) {
      // An old value left unchanged (even a retired A–E letter) is kept; a changed one must be a sub-grade.
      const grade = acceptedGradeEdit(guarantorGrade[1], existing?.guarantorCreditRank ?? null, activeGradeOptions("guarantor_credit_rank"));
      if (!grade.ok) {
        res.status(400).json({ error: GRADE_EDIT_ERROR });
        return;
      }
      guarantorGrade[1] = grade.value;
    }
    const effectiveCustomerId = parsed.data.customerId ?? existing?.customerId;
    const currentCreditRank = effectiveCustomerId
      ? authoritativeCreditRank(effectiveCustomerId)
      : null;
    const rank = values.find(([column]) => column === "credit_rank");
    if (rank) rank[1] = currentCreditRank;
    else if (hadUpdateFields) values.push(["credit_rank", currentCreditRank]);
    if (!hadUpdateFields) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }
    const setClause = values.map(([column]) => `${column} = ?`).join(", ");
    executeChanges(
      `UPDATE consultation_forms SET ${setClause}, updated_at = ? WHERE id = ?`,
      [
        ...values.map(([, value]) => value),
        new Date().toISOString(),
        params.data.id,
      ],
    );
    const consultation = getConsultation(params.data.id, user);
    if (!consultation) {
      res.status(404).json({ error: "Consultation not found" });
      return;
    }
    res.json(UpdateConsultationResponse.parse(consultation));
  },
);

const planSelect = `
  SELECT id, name, filing_fee_toman, bank_name, platform_name, principal_amount, annual_interest,
    installments, installment_terms, required_documents, deduct_percents,
    customer_ranks, customer_check,
    needs_customer_promissory, customer_jobs, process_mode, needs_guarantor,
    guarantor_ranks, guarantor_check, needs_guarantor_promissory, guarantor_jobs,
    loan_type, grant_days, needs_account_turnover, needs_avg_balance, notes,
    active, created_at, prepayment_percents, deposit_percents,
    needs_customer_salary_deduct, needs_guarantor_salary_deduct
    ,contract_template_id, primary_contract_template_id, invoice_template_id, acknowledgement_template_id
    ,platform_company_name, goods_store_name, commission_percent,
    operation_costs_percent, granted_discount_percent, purchase_commission_percent,
    sales_commission_percent, loan_acquisition_fee_percent, penalty_mode, penalty_value,
    contract_duration_days
  FROM loan_plans
`;

function getPlan(id: number) {
  const row = queryRow<LoanPlanRow>(`${planSelect} WHERE id = ?`, [id]);
  return row ? planFromRow(row) : undefined;
}

const planColumns: Record<string, string> = {
  name: "name",
  filingFeeToman: "filing_fee_toman",
  bankName: "bank_name",
  platformName: "platform_name",
  principalAmount: "principal_amount",
  annualInterest: "annual_interest",
  installments: "installments",
  installmentTerms: "installment_terms",
  requiredDocuments: "required_documents",
  deductPercents: "deduct_percents",
  customerRanks: "customer_ranks",
  customerCheck: "customer_check",
  needsCustomerPromissory: "needs_customer_promissory",
  customerJobs: "customer_jobs",
  processMode: "process_mode",
  needsGuarantor: "needs_guarantor",
  guarantorRanks: "guarantor_ranks",
  guarantorCheck: "guarantor_check",
  needsGuarantorPromissory: "needs_guarantor_promissory",
  guarantorJobs: "guarantor_jobs",
  loanType: "loan_type",
  grantDays: "grant_days",
  needsAccountTurnover: "needs_account_turnover",
  needsAvgBalance: "needs_avg_balance",
  notes: "notes",
  prepaymentPercents: "prepayment_percents",
  depositPercents: "deposit_percents",
  needsCustomerSalaryDeduct: "needs_customer_salary_deduct",
  needsGuarantorSalaryDeduct: "needs_guarantor_salary_deduct",
  contractTemplateId: "contract_template_id",
  platformCompanyName: "platform_company_name",
  goodsStoreName: "goods_store_name",
  commissionPercent: "commission_percent",
  operationCostsPercent: "operation_costs_percent",
  grantedDiscountPercent: "granted_discount_percent",
  purchaseCommissionPercent: "purchase_commission_percent",
  salesCommissionPercent: "sales_commission_percent",
  loanAcquisitionFeePercent: "loan_acquisition_fee_percent",
  penaltyMode: "penalty_mode",
  penaltyValue: "penalty_value",
  contractDurationDays: "contract_duration_days",
  active: "active",
};

function planFields(body: Record<string, unknown>) {
  const boolFields = new Set([
    "needsCustomerPromissory",
    "needsGuarantor",
    "needsGuarantorPromissory",
    "needsAccountTurnover",
    "needsAvgBalance",
    "needsCustomerSalaryDeduct",
    "needsGuarantorSalaryDeduct",
    "active",
  ]);
  const values: Array<[string, SqlValue]> = [];
  for (const [key, column] of Object.entries(planColumns)) {
    if (body[key] !== undefined) {
      const isJsonField =
        key === "installmentTerms" || key === "requiredDocuments";
      values.push([
        column,
        boolFields.has(key)
          ? body[key]
            ? 1
            : 0
          : isJsonField
            ? JSON.stringify(body[key])
            : (key === "customerRanks" || key === "guarantorRanks") && typeof body[key] === "string" && String(body[key]).trim()
              // Retired A–E letters in a saved rule become their three sub-grades (A → A1,A2,A3).
              ? JSON.stringify(expandRankList(parseStoredRanks(body[key])))
              : (body[key] as SqlValue),
      ]);
    }
  }
  return values;
}

const goodsPlanFields = [
  "platformCompanyName", "goodsStoreName", "commissionPercent",
  "operationCostsPercent", "grantedDiscountPercent", "purchaseCommissionPercent",
  "salesCommissionPercent", "loanAcquisitionFeePercent", "penaltyMode",
  "penaltyValue", "contractDurationDays",
] as const;

function normalizePlanInput(body: Record<string, unknown>, existing?: ReturnType<typeof planFromRow>) {
  const normalized = { ...body };
  if (normalized.filingFeeToman !== undefined) {
    const fee = String(normalized.filingFeeToman);
    if (!/^(0|[1-9]\d*)$/.test(fee) || fee.length > 30) throw new Error("هزینه ثابت تشکیل پرونده باید عدد صحیح غیرمنفی به تومان باشد.");
    normalized.filingFeeToman = fee;
  }
  if (normalized.contractTemplateId === undefined && normalized.primaryContractTemplateId !== undefined) {
    normalized.contractTemplateId = normalized.primaryContractTemplateId;
  }
  delete normalized.primaryContractTemplateId;
  delete normalized.invoiceTemplateId;
  delete normalized.acknowledgementTemplateId;
  const template = normalized.contractTemplateId;
  if (template !== undefined && template !== null && template !== "") {
    const id = Number(template);
    if (!Number.isSafeInteger(id) || id <= 0 ||
      !queryRow("SELECT id FROM contract_templates WHERE id=? AND deleted_at IS NULL", [id])) {
      throw new Error("قالب قرارداد انتخاب‌شده معتبر نیست.");
    }
    normalized.contractTemplateId = id;
  } else if (template === "") {
    normalized.contractTemplateId = null;
  }
  const loanType = normalized.loanType ?? existing?.loanType;
  if (loanType !== "goods") {
    for (const key of goodsPlanFields) normalized[key] = null;
    return normalized;
  }
  const requiredGoodsValues = {
    platformCompanyName: normalized.platformCompanyName ?? existing?.platformCompanyName,
    goodsStoreName: normalized.goodsStoreName ?? existing?.goodsStoreName,
    commissionPercent: normalized.commissionPercent ?? existing?.commissionPercent,
    operationCostsPercent: normalized.operationCostsPercent ?? existing?.operationCostsPercent,
    grantedDiscountPercent: normalized.grantedDiscountPercent ?? existing?.grantedDiscountPercent,
    purchaseCommissionPercent: normalized.purchaseCommissionPercent ?? existing?.purchaseCommissionPercent,
    salesCommissionPercent: normalized.salesCommissionPercent ?? existing?.salesCommissionPercent,
    loanAcquisitionFeePercent: normalized.loanAcquisitionFeePercent ?? existing?.loanAcquisitionFeePercent,
    penaltyMode: normalized.penaltyMode ?? existing?.penaltyMode,
    penaltyValue: normalized.penaltyValue ?? existing?.penaltyValue,
    contractDurationDays: normalized.contractDurationDays ?? existing?.contractDurationDays,
  };
  if (!String(requiredGoodsValues.platformCompanyName ?? "").trim() ||
    !String(requiredGoodsValues.goodsStoreName ?? "").trim() ||
    Object.entries(requiredGoodsValues).some(([key, value]) =>
      key !== "platformCompanyName" && key !== "goodsStoreName" && (value === null || value === undefined || value === ""))) {
    throw new Error("تمام اطلاعات و درصدهای طرح خرید کالا الزامی است.");
  }
  for (const key of ["commissionPercent", "operationCostsPercent", "grantedDiscountPercent",
    "purchaseCommissionPercent", "salesCommissionPercent", "loanAcquisitionFeePercent"] as const) {
    const value = normalized[key];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error("درصدهای طرح خرید کالا باید بین ۰ تا ۱۰۰ باشند.");
    }
  }
  const mode = normalized.penaltyMode;
  const penalty = normalized.penaltyValue;
  if (mode != null && mode !== "amount" && mode !== "percent") {
    throw new Error("نوع وجه التزام معتبر نیست.");
  }
  if (penalty != null && (typeof penalty !== "number" || !Number.isFinite(penalty) || penalty < 0)) {
    throw new Error("مبلغ وجه التزام معتبر نیست.");
  }
  if (mode === "percent" && typeof penalty === "number" && penalty > 100) {
    throw new Error("درصد وجه التزام باید بین ۰ تا ۱۰۰ باشد.");
  }
  const days = normalized.contractDurationDays;
  if (days !== undefined && days !== null &&
    (!Number.isInteger(days) || Number(days) <= 0)) {
    throw new Error("مدت قرارداد باید تعداد روز مثبت باشد.");
  }
  return normalized;
}

type PlanConditionInput = {
  maxPrincipal?: string;
  customerRanks?: string[];
  installmentOptions?: number[];
  customerJobs?: string[];
  collateralType?: string;
  needsGuarantor?: boolean;
  guarantorRanks?: string[];
  guarantorJobs?: string[];
  guarantorCollateralType?: string;
  needsCustomerPromissory?: boolean;
  needsGuarantorPromissory?: boolean;
  needsCustomerSalaryDeduct?: boolean;
  needsGuarantorSalaryDeduct?: boolean;
  needsCustomerCheck?: boolean;
  needsGuarantorCheck?: boolean;
  needsMilitaryService?: boolean;
  sortOrder?: number;
  notes?: string;
};

function replacePlanConditions(
  planId: number,
  conditions: PlanConditionInput[],
) {
  executeChanges("DELETE FROM loan_plan_conditions WHERE plan_id = ?", [
    planId,
  ]);
  conditions.forEach((condition, index) => {
    execute(
      `
        INSERT INTO loan_plan_conditions (
          plan_id, max_principal, customer_ranks, installment_options,
          customer_jobs, collateral_type, needs_guarantor, guarantor_ranks,
          guarantor_jobs, guarantor_collateral_type, needs_customer_promissory,
          needs_guarantor_promissory, needs_customer_salary_deduct,
          needs_guarantor_salary_deduct, needs_customer_check,
          needs_guarantor_check, sort_order, notes, needs_military_service
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        planId,
        condition.maxPrincipal?.trim() || null,
        JSON.stringify(expandRankList(condition.customerRanks ?? [])),
        JSON.stringify(condition.installmentOptions ?? []),
        JSON.stringify(condition.customerJobs ?? []),
        condition.collateralType?.trim() || null,
        condition.needsGuarantor ? 1 : 0,
        JSON.stringify(expandRankList(condition.guarantorRanks ?? [])),
        JSON.stringify(condition.guarantorJobs ?? []),
        condition.guarantorCollateralType?.trim() || null,
        condition.needsCustomerPromissory ? 1 : 0,
        condition.needsGuarantorPromissory ? 1 : 0,
        condition.needsCustomerSalaryDeduct ? 1 : 0,
        condition.needsGuarantorSalaryDeduct ? 1 : 0,
        condition.needsCustomerCheck ? 1 : 0,
        condition.needsGuarantorCheck ? 1 : 0,
        condition.sortOrder ?? index,
        condition.notes?.trim() || null,
        // crm-no-plan-option: NULL = no requirement (default); only an admin ticking it in the plan editor sets 1.
        condition.needsMilitaryService ? 1 : null,
      ],
    );
  });
}

function parseRankList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((rank) => String(rank).trim().toUpperCase())
        .filter(Boolean);
    }
  } catch {
    // Older rows may contain comma-separated values instead of JSON.
  }
  return value
    .split(/[,،]/)
    .map((rank) =>
      rank
        .trim()
        .replace(/[\[\]"]/g, "")
        .toUpperCase(),
    )
    .filter(Boolean);
}

function parseAmount(value: string | null) {
  if (!value) return null;
  const normalized = value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[^\d.]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function evaluatePlanCondition(
  consultation: ReturnType<typeof consultationFromRow>,
  condition: ReturnType<typeof planConditions>[number],
) {
  const failedRequirements: string[] = [];
  const missingInformation: string[] = [];
  const needsGuarantor = Boolean(condition.needsGuarantor || parseRankList(condition.guarantorRanks).length ||
    condition.guarantorJobs.length || condition.needsGuarantorCheck ||
    condition.needsGuarantorSalaryDeduct || condition.needsGuarantorPromissory ||
    (condition.guarantorCollateralType && condition.guarantorCollateralType !== "none"));
  const requireBoolean = (
    required: boolean,
    actual: boolean | null,
    label: string,
  ) => {
    if (!required) return;
    if (actual == null) missingInformation.push(label);
    else if (!actual) failedRequirements.push(label);
  };

  const maximum = parseAmount(condition.maxPrincipal);
  if (maximum != null) {
    const requested = parseAmount(consultation.requestedAmount);
    if (requested != null && requested > maximum) {
      failedRequirements.push(
        `مبلغ درخواستی بیشتر از سقف ${condition.maxPrincipal} است`,
      );
    }
  }

  const customerRanks = parseRankList(condition.customerRanks);
  if (customerRanks.length) {
    const rank = consultation.creditRank?.trim().toUpperCase();
    if (!rank) missingInformation.push("رتبه اعتباری مشتری");
    else if (!consultationRankMatches(rank, customerRanks)) {
      failedRequirements.push(`رتبه اعتباری مجاز: ${compactRankList(customerRanks).join("، ")}`);
    }
  }

  const guarantorRanks = parseRankList(condition.guarantorRanks);
  if (guarantorRanks.length) {
    const rank = consultation.guarantorCreditRank?.trim().toUpperCase();
    if (!rank) missingInformation.push("رتبه اعتباری ضامن");
    else if (!consultationRankMatches(rank, guarantorRanks)) {
      failedRequirements.push(`رتبه مجاز ضامن: ${compactRankList(guarantorRanks).join("، ")}`);
    }
  }

  const customerJobs = condition.customerJobs;
  if (customerJobs.length) {
    if (!consultation.jobType) missingInformation.push("شغل مشتری");
    else if (!customerJobs.includes(consultation.jobType)) {
      failedRequirements.push("شغل مشتری در مشاغل مجاز این مسیر نیست");
    }
  }

  // Consultation policy: guarantor occupation is assumed compatible.
  // Do not alter recorded answers or the separate final lending checks.

  const requireCollateral = (
    type: string | null,
    selectedType: string | null,
    owner: "مشتری" | "ضامن",
    hasPromissory: boolean | null,
    checkType: string | null,
    hasSalaryDeduct: boolean | null,
  ) => {
    if (!type || type === "none") return;
    if (type === "promissory") {
      // Everyone can provide a promissory note; availability is not an eligibility barrier.
      return;
    }
    if (type === "salary_deduction") {
      requireBoolean(
        true,
        selectedType === type || hasSalaryDeduct,
        `گواهی کسر از حقوق ${owner}`,
      );
      return;
    }
    if (type === "digital_check" || type === "physical_check") {
      if (selectedType === type) return;
      if (!checkType) {
        missingInformation.push(`نوع چک ${owner}`);
        return;
      }
      const expected = type === "digital_check" ? "digital" : "physical";
      if (checkType !== expected && checkType !== "both") {
        failedRequirements.push(
          `${owner} باید چک ${expected === "digital" ? "دیجیتال" : "فیزیکی"} داشته باشد`,
        );
      }
      return;
    }
    if (!selectedType) {
      missingInformation.push(`وثیقه ${owner}`);
    } else if (selectedType !== type) {
      failedRequirements.push(`وثیقه مورد نیاز ${owner}: ${type}`);
    }
  };

  requireCollateral(
    condition.collateralType,
    consultation.collateralType,
    "مشتری",
    consultation.hasPromissory,
    consultation.customerCheckStatus,
    consultation.hasCustomerSalaryDeduct,
  );
  if (needsGuarantor) {
    requireCollateral(
      condition.guarantorCollateralType,
      consultation.guarantorCollateralType,
      "ضامن",
      consultation.hasGuarantorPromissory,
      consultation.guarantorCheckType,
      consultation.hasGuarantorSalaryDeduct,
    );
  }

  requireBoolean(
    needsGuarantor,
    consultation.hasGuarantor,
    "وجود ضامن",
  );
  requireBoolean(
    condition.needsCustomerPromissory,
    true,
    "سفته مشتری",
  );
  requireBoolean(
    condition.needsGuarantorPromissory,
    consultation.hasGuarantor,
    "سفته ضامن",
  );
  requireBoolean(
    condition.needsCustomerCheck,
    consultation.hasCheck,
    "چک مشتری",
  );
  requireBoolean(
    condition.needsGuarantorCheck,
    consultation.hasGuarantorCheck,
    "چک ضامن",
  );
  requireBoolean(
    condition.needsCustomerSalaryDeduct,
    consultation.hasCustomerSalaryDeduct,
    "گواهی کسر از حقوق مشتری",
  );
  requireBoolean(
    condition.needsGuarantorSalaryDeduct,
    consultation.hasGuarantorSalaryDeduct,
    "گواهی کسر از حقوق ضامن",
  );
  // crm-no-plan-option: consultations do not ask military service → a requirement is information to check, never a rejection.
  requireBoolean(condition.needsMilitaryService, null, "پایان خدمت متقاضی");

  return {
    status:
      failedRequirements.length > 0
        ? ("not_eligible" as const)
        : missingInformation.length > 0
          ? ("needs_review" as const)
          : ("eligible" as const),
    failedRequirements,
    missingInformation,
  };
}

router.get("/public/loan-plans", (_req, res): void => {
  const rows = queryRows<LoanPlanRow>(
    `${planSelect} WHERE active = 1 ORDER BY id DESC`,
  );
  res.json(rows.map(planFromRow).map(publicPlanSummary));
});

router.get("/public/loan-plans/:id", (req, res): void => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid loan plan id" });
    return;
  }
  const plan = getPlan(id);
  if (!plan?.active) {
    res.status(404).json({ error: "Loan plan not found" });
    return;
  }
  res.json(publicPlanDetails(plan));
});

router.get(
  "/loan-plans",
  requirePermission("loan_plans.view"),
  (req, res): void => {
    const parsed = ListLoanPlansQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const params: SqlValue[] = [];
    const where = parsed.data.active === undefined ? "" : "WHERE active = ?";
    if (parsed.data.active !== undefined)
      params.push(parsed.data.active ? 1 : 0);
    const rows = queryRows<LoanPlanRow>(
      `${planSelect}${where} ORDER BY active DESC, id DESC`,
      params,
    );
    res.json(ListLoanPlansResponse.parse(rows.map(planFromRow)));
  },
);

router.post(
  "/loan-plans",
  requirePermission("loan_plans.manage"),
  (req, res): void => {
    const parsed = CreateLoanPlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    let input: Record<string, unknown>;
    try {
      input = normalizePlanInput(parsed.data as Record<string, unknown>);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات طرح معتبر نیست." });
      return;
    }
    const values = planFields(input);
    const columns = values.map(([column]) => column);
    const params = values.map(([, value]) => value);
    columns.push("created_at");
    params.push(new Date().toISOString());
    const id = runTransaction(() => {
      const createdId = execute(
        `INSERT INTO loan_plans (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        params,
      );
      replacePlanConditions(createdId, (input.conditions as PlanConditionInput[] | undefined) ?? []);
      return createdId;
    });
    const plan = getPlan(id);
    if (!plan) {
      res.status(500).json({ error: "Loan plan was not created" });
      return;
    }
    res.status(201).json(CreateLoanPlanResponse.parse(plan));
  },
);

router.get(
  "/loan-plans/:id",
  requirePermission("loan_plans.view"),
  (req, res): void => {
    const parsed = GetLoanPlanParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const plan = getPlan(parsed.data.id);
    if (!plan) {
      res.status(404).json({ error: "Loan plan not found" });
      return;
    }
    res.json(GetLoanPlanResponse.parse(plan));
  },
);

// Read-only: rank lists of this plan's conditions that the credit-subgrades migration converted from A–E letters
// and that still hold the converted value (an edit after the release clears the note). Empty before the migration.
router.get(
  "/loan-plans/:id/grade-conversion",
  requirePermission("loan_plans.view"),
  (req, res): void => {
    const parsed = GetLoanPlanParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const hasSnapshot = queryRow("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='credit_subgrades_snapshot'");
    const items = hasSnapshot ? queryRows<{ row_id: number; column_name: string; original_value: string }>(
      `SELECT s.row_id, s.column_name, s.original_value FROM credit_subgrades_snapshot s
         JOIN loan_plan_conditions pc ON pc.id = s.row_id
        WHERE s.kind = 'rank_list' AND s.table_name = 'loan_plan_conditions' AND s.rolled_back_at IS NULL
          AND pc.plan_id = ? AND s.column_name IN ('customer_ranks','guarantor_ranks')
          AND ((s.column_name = 'customer_ranks' AND pc.customer_ranks = s.migrated_value)
            OR (s.column_name = 'guarantor_ranks' AND pc.guarantor_ranks = s.migrated_value))
        ORDER BY s.id`, [parsed.data.id],
    ).map(row => ({ conditionId: Number(row.row_id), field: row.column_name === "customer_ranks" ? "customerRanks" : "guarantorRanks",
      original: parseStoredRanks(row.original_value) })) : [];
    res.json({ items });
  },
);

router.patch(
  "/loan-plans/:id",
  requirePermission("loan_plans.manage"),
  (req, res): void => {
    const params = UpdateLoanPlanParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateLoanPlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!getPlan(params.data.id)) {
      res.status(404).json({ error: "Loan plan not found" });
      return;
    }
    const existingPlan = getPlan(params.data.id);
    let input: Record<string, unknown>;
    try {
      input = normalizePlanInput(parsed.data as Record<string, unknown>, existingPlan);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات طرح معتبر نیست." });
      return;
    }
    const values = planFields(input);
    if (!values.length && input.conditions === undefined) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }
    runTransaction(() => {
      if (values.length) {
        const setClause = values.map(([column]) => `${column} = ?`).join(", ");
        executeChanges(`UPDATE loan_plans SET ${setClause} WHERE id = ?`, [
          ...values.map(([, value]) => value),
          params.data.id,
        ]);
      }
      if (input.conditions !== undefined) {
        replacePlanConditions(params.data.id, input.conditions as PlanConditionInput[]);
      }
    });
    {
      const newTemplate = Number(input.contractTemplateId);
      const oldTemplate = Number(existingPlan?.contractTemplateId);
      if (input.contractTemplateId !== undefined && Number.isSafeInteger(newTemplate) && newTemplate > 0 && newTemplate !== oldTemplate) {
        propagateContractTemplateChange({ templateId: newTemplate, planId: params.data.id, actor: res.locals.authUser, log: req.log });
      }
    }
    const plan = getPlan(params.data.id);
    if (!plan) {
      res.status(404).json({ error: "Loan plan not found" });
      return;
    }
    res.json(UpdateLoanPlanResponse.parse(plan));
  },
);

router.get(
  "/consultations/:id/loan-plan-matches",
  requirePermission("consultations.view"),
  (req, res): void => {
    const parsed = MatchConsultationLoanPlansParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const consultation = getConsultation(
      parsed.data.id,
      res.locals.authUser as AuthUser,
    );
    if (!consultation) {
      res.status(404).json({ error: "Consultation not found" });
      return;
    }

    res.json(MatchConsultationLoanPlansResponse.parse(computeConsultationPlanMatches(consultation)));
  },
);

router.get(
  "/consultations/:id/historical-loan-plan-matches",
  requirePermission("consultations.view"),
  (req, res): void => {
    const parsed = MatchConsultationLoanPlansParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // Apply exactly the same current customer scope as the live match endpoint.
    if (!getConsultation(parsed.data.id, res.locals.authUser as AuthUser)) {
      res.status(404).json({ error: "Consultation not found" });
      return;
    }
    const row = queryRow<{ plan_matches_snapshot: string | null }>(
      "SELECT plan_matches_snapshot FROM consultation_forms WHERE id = ?", [parsed.data.id],
    );
    res.json(GetConsultationHistoricalLoanPlanMatchesResponse.parse({
      snapshot: row?.plan_matches_snapshot == null ? null : JSON.parse(row.plan_matches_snapshot),
    }));
  },
);

/** Active plans as the live matcher reads them (consult report: loaded once for a whole list). */
export function activeMatchPlans() {
  return queryRows<LoanPlanRow>(`${planSelect} WHERE active = 1 ORDER BY id DESC`).map(planFromRow);
}

export function computeConsultationPlanMatches(consultation: ReturnType<typeof consultationFromRow>, preloadedPlans?: ReturnType<typeof activeMatchPlans>) {
    const plans = preloadedPlans ?? activeMatchPlans();
    const matches = plans.map((plan) => {
      if (!plan.conditions.length) {
        return {
          plan,
          status: "needs_review" as const,
          matchedConditionId: null,
          customerMaximumAmount: null,
          failedRequirements: [],
          missingInformation: ["برای این طرح شرط احراز تعریف نشده است"],
        };
      }

      const evaluations = plan.conditions.map((condition) => {
        const result = evaluatePlanCondition(consultation, condition);
        const maximumAmount = consultationMaximumAmount(condition.maxPrincipal, plan.principalAmount);
        const requested = parseAmount(consultation.requestedAmount);
        if (maximumAmount != null && requested != null && requested > maximumAmount) {
          result.failedRequirements.push(`مبلغ درخواستی بیشتر از سقف قابل دریافت مشتری (${maximumAmount.toLocaleString("fa-IR")} تومان) است`);
        }
        // Everyone can supply average balance and account turnover in advice.
        // Their absence/negative legacy answer is not an advice eligibility barrier.
        result.status = result.failedRequirements.length ? "not_eligible" :
          result.missingInformation.length ? "needs_review" : "eligible";
        return { condition, maximumAmount, ...result };
      });
      const eligible = evaluations.filter(evaluation => evaluation.status === "eligible")
        .sort((left, right) => (right.maximumAmount ?? -1) - (left.maximumAmount ?? -1))[0];
      if (eligible) {
        return {
          plan,
          status: eligible.maximumAmount == null ? "needs_review" as const : eligible.status,
          matchedConditionId: eligible.condition.id,
          customerMaximumAmount: eligible.maximumAmount == null ? null : String(eligible.maximumAmount),
          failedRequirements: [],
          missingInformation: eligible.maximumAmount == null ? ["سقف مبلغ این مسیر طرح مشخص یا معتبر نیست"] : [],
        };
      }
      const review = evaluations
        .filter((evaluation) => evaluation.status === "needs_review")
        .sort(
          (left, right) =>
            left.missingInformation.length - right.missingInformation.length,
        )[0];
      if (review) {
        return {
          plan,
          status: review.status,
          matchedConditionId: review.condition.id,
          customerMaximumAmount: null,
          failedRequirements: [],
          missingInformation: review.missingInformation,
        };
      }
      const closest = evaluations.sort(
        (left, right) =>
          left.failedRequirements.length - right.failedRequirements.length,
      )[0];
      return {
        plan,
        status: "not_eligible" as const,
        matchedConditionId: null,
        customerMaximumAmount: null,
        failedRequirements: closest?.failedRequirements ?? [],
        missingInformation: closest?.missingInformation ?? [],
      };
    });

    const statusOrder = { eligible: 0, needs_review: 1, not_eligible: 2 };
    matches.sort(
      (left, right) => statusOrder[left.status] - statusOrder[right.status],
    );
    return matches;
}

function roleResponse(slug: string) {
  const role = queryRow<{
    slug: string;
    name: string;
    description: string | null;
    customer_scope: string;
    is_system: number;
  }>(
    "SELECT slug, name, description, customer_scope, is_system FROM app_roles WHERE slug = ?",
    [slug],
  );
  if (!role) return undefined;
  return {
    slug: role.slug,
    name: role.name,
    description: role.description,
    customerScope: role.customer_scope,
    system: Boolean(role.is_system),
    permissions: queryRows<{ permission: string }>(
      "SELECT permission FROM role_permissions WHERE role_slug = ? ORDER BY permission",
      [slug],
    ).map((item) => item.permission),
  };
}

router.get("/roles", requirePermission("users.view"), (_req, res): void => {
  const roles = queryRows<{ slug: string }>(
    "SELECT slug FROM app_roles ORDER BY is_system DESC, name",
  );
  res.json({
    roles: roles.map((role) => roleResponse(role.slug)),
    availablePermissions: PERMISSIONS,
  });
});

router.post("/roles", requireAdmin, (req, res): void => {
  const body = req.body as {
    slug?: string;
    name?: string;
    description?: string | null;
    customerScope?: string;
    permissions?: string[];
  };
  const slug = body.slug?.trim().toLowerCase();
  if (!slug || !/^[a-z][a-z0-9_-]{2,49}$/.test(slug) || !body.name?.trim()) {
    res.status(400).json({ error: "Invalid role name or slug" });
    return;
  }
  const permissions = [...new Set(body.permissions ?? [])].filter(
    (item): item is (typeof PERMISSIONS)[number] =>
      PERMISSIONS.includes(item as (typeof PERMISSIONS)[number]),
  );
  try {
    execute(
      "INSERT INTO app_roles (slug, name, description, customer_scope, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      [
        slug,
        body.name.trim(),
        body.description?.trim() || null,
        body.customerScope === "assigned" ? "assigned" : "all",
        new Date().toISOString(),
      ],
    );
    for (const permission of permissions)
      execute(
        "INSERT INTO role_permissions (role_slug, permission) VALUES (?, ?)",
        [slug, permission],
      );
  } catch {
    res.status(409).json({ error: "Role already exists" });
    return;
  }
  res.status(201).json(roleResponse(slug));
});

router.patch("/roles/:slug", requireAdmin, (req, res): void => {
  const slug = String(req.params.slug);
  const existing = roleResponse(slug);
  if (!existing) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  if (slug === "admin") {
    res.status(400).json({ error: "The admin role cannot be changed" });
    return;
  }
  const body = req.body as {
    name?: string;
    description?: string | null;
    customerScope?: string;
    permissions?: string[];
  };
  const permissions =
    body.permissions === undefined
      ? existing.permissions
      : [...new Set(body.permissions)].filter(
          (item): item is (typeof PERMISSIONS)[number] =>
            PERMISSIONS.includes(item as (typeof PERMISSIONS)[number]),
        );
  runTransaction(() => {
    executeChanges(
      "UPDATE app_roles SET name = ?, description = ?, customer_scope = ? WHERE slug = ?",
      [
        body.name?.trim() || existing.name,
        body.description === undefined
          ? existing.description
          : body.description?.trim() || null,
        body.customerScope === "assigned" ? "assigned" : "all",
        slug,
      ],
    );
    executeChanges("DELETE FROM role_permissions WHERE role_slug = ?", [slug]);
    for (const permission of permissions)
      execute(
        "INSERT INTO role_permissions (role_slug, permission) VALUES (?, ?)",
        [slug, permission],
      );
  });
  res.json(roleResponse(slug));
});

router.delete("/roles/:slug", requireAdmin, (req, res): void => {
  const slug = String(req.params.slug);
  const role = roleResponse(slug);
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  if (role.system) {
    res.status(400).json({ error: "System roles cannot be deleted" });
    return;
  }
  const users = queryRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM users WHERE role = ?",
    [slug],
  );
  if (Number(users?.count ?? 0) > 0) {
    res.status(409).json({ error: "Role is assigned to users" });
    return;
  }
  runTransaction(() => {
    executeChanges("DELETE FROM role_permissions WHERE role_slug = ?", [slug]);
    executeChanges("DELETE FROM app_roles WHERE slug = ?", [slug]);
  });
  res.status(204).end();
});

router.get("/users/salesperson-identities/ambiguities", requireAdmin, (_req, res): void => {
  res.json(ListSalespersonIdentityAmbiguitiesResponse.parse(salespersonIdentityReport(crmDb)));
});

router.post("/users/:id/salesperson-identity", requireAdmin, (req, res): void => {
  const params = ResolveSalespersonIdentityLinkParams.safeParse(req.params);
  const body = ResolveSalespersonIdentityLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid identity selection" });
    return;
  }
  try {
    const salespersonId = resolveSalespersonIdentity(
      crmDb, params.data.id, body.data.expectedSalespersonId, body.data.choice,
    );
    // Keep other unresolved accounts available in the report; completing one
    // resolution must not force an automatic reassignment of another.
    reconcileSalespersonUserIdentities(crmDb, (userId, reason) => {
      req.log.warn({ userId, reason }, "Salesperson identity still requires review");
    });
    res.json(ResolveSalespersonIdentityLinkResponse.parse({ salespersonId }));
  } catch (error) {
    if (error instanceof Error && error.message === "identity_conflict") {
      res.status(409).json({ error: "Identity selection changed; refresh the report" });
      return;
    }
    throw error;
  }
});

router.get("/users", requirePermission("users.view"), (_req, res): void => {
  const rows = queryRows<UserRow>(`
    SELECT u.id, u.username, u.full_name, u.mobile, u.telegram_id, u.role, r.name AS role_name, u.salesperson_id,
      s.name AS salesperson_name, u.active, u.created_at
    FROM users u
    LEFT JOIN app_roles r ON r.slug = u.role
    LEFT JOIN salespersons s ON s.id = u.salesperson_id
    ORDER BY u.active DESC, u.id
  `);
  res.json(ListUsersResponse.parse(rows.map(userFromRow)));
});

router.post("/users", requirePermission("users.manage"), (req, res): void => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  if (!queryRow("SELECT slug FROM app_roles WHERE slug = ?", [body.role])) {
    res.status(400).json({ error: "Role does not exist" });
    return;
  }
  let id = 0;
  try {
    runTransaction(() => {
      id = execute(
        `
          INSERT INTO users
            (username, password_hash, full_name, mobile, role, salesperson_id, active, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
        `,
        [
          body.username.trim().toLowerCase(),
          hashPassword(body.password),
          body.fullName ?? null,
          body.mobile?.trim() || null,
          body.role,
          body.active === false ? 0 : 1,
          new Date().toISOString(),
        ],
      );
      if (body.role === "salesperson") ensureSalespersonIdentity(crmDb, id);
      if (body.voipExtension !== undefined) saveUserVoipExtension(id, body.voipExtension, (res.locals.authUser as AuthUser).id);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "voip_extension_conflict") {
      res.status(409).json({ error: "این داخلی تلفن قبلاً به کاربر دیگری اختصاص داده شده است." });
      return;
    }
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    if (error instanceof Error && error.message === "ambiguous_salesperson_identity") {
      res.status(409).json({ error: "Salesperson identity is ambiguous" });
      return;
    }
    throw error;
  }
  const row = queryRow<UserRow>(
    `
      SELECT u.id, u.username, u.full_name, u.mobile, u.telegram_id, u.role, r.name AS role_name, u.salesperson_id,
        s.name AS salesperson_name, u.active, u.created_at
      FROM users u
      LEFT JOIN app_roles r ON r.slug = u.role
      LEFT JOIN salespersons s ON s.id = u.salesperson_id
      WHERE u.id = ?
    `,
    [id],
  );
  if (!row) {
    res.status(500).json({ error: "User was not created" });
    return;
  }
  res.status(201).json(CreateUserResponse.parse(userFromRow(row)));
});

router.patch(
  "/users/:id",
  requirePermission("users.manage"),
  (req, res): void => {
    const params = UpdateUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const body = parsed.data;
    if (
      body.role !== undefined &&
      !queryRow("SELECT slug FROM app_roles WHERE slug = ?", [body.role])
    ) {
      res.status(400).json({ error: "Role does not exist" });
      return;
    }
    const existing = queryRow<{
      role: string;
      active: number;
      salesperson_id: number | null;
    }>(
      "SELECT role, active, salesperson_id FROM users WHERE id = ?",
      [params.data.id],
    );
    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const removesAdmin =
      existing.role === "admin" &&
      existing.active === 1 &&
      ((body.role !== undefined && body.role !== "admin") ||
        body.active === false);
    if (removesAdmin) {
      const activeAdmins = queryRow<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1",
      );
      if (Number(activeAdmins?.count ?? 0) <= 1) {
        res
          .status(400)
          .json({ error: "The last active admin cannot be disabled" });
        return;
      }
    }
    const values: Array<[string, SqlValue]> = [];
    if (body.username !== undefined)
      values.push(["username", body.username.trim().toLowerCase()]);
    if (body.password !== undefined)
      values.push(["password_hash", hashPassword(body.password)]);
    if (body.fullName !== undefined) values.push(["full_name", body.fullName]);
    if (body.mobile !== undefined)
      values.push(["mobile", body.mobile?.trim() || null]);
    if (body.telegramId !== undefined)
      values.push(["telegram_id", body.telegramId?.trim() || null]);
    if (body.role !== undefined) values.push(["role", body.role]);
    if (body.active !== undefined) values.push(["active", body.active ? 1 : 0]);
    if (!values.length && body.voipExtension === undefined) {
      res.status(400).json({ error: "At least one field is required" });
      return;
    }
    if (
      (body.role ?? existing.role) === "salesperson" &&
      existing.salesperson_id !== null &&
      queryRow(
        `SELECT 1 FROM users
         WHERE role = 'salesperson' AND salesperson_id = ? AND id <> ?`,
        [existing.salesperson_id, params.data.id],
      )
    ) {
      res.status(409).json({ error: "Salesperson identity is ambiguous" });
      return;
    }
    try {
      runTransaction(() => {
        if (values.length) executeChanges(
          `UPDATE users SET ${values.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
          [...values.map(([, value]) => value), params.data.id],
        );
        if (body.voipExtension !== undefined) saveUserVoipExtension(params.data.id, body.voipExtension, (res.locals.authUser as AuthUser).id);
        const resultingRole = body.role ?? existing.role;
        if (resultingRole === "salesperson") {
          ensureSalespersonIdentity(crmDb, params.data.id);
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "voip_extension_conflict") {
        res.status(409).json({ error: "این داخلی تلفن قبلاً به کاربر دیگری اختصاص داده شده است." });
        return;
      }
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        res.status(409).json({ error: "Username already exists" });
        return;
      }
      if (error instanceof Error && error.message === "ambiguous_salesperson_identity") {
        res.status(409).json({ error: "Salesperson identity is ambiguous" });
        return;
      }
      throw error;
    }
    if (body.active === false || body.password !== undefined)
      revokeUserSessions(params.data.id);
    const row = queryRow<UserRow>(
      `
      SELECT u.id, u.username, u.full_name, u.mobile, u.telegram_id, u.role, r.name AS role_name, u.salesperson_id,
        s.name AS salesperson_name, u.active, u.created_at
      FROM users u
      LEFT JOIN app_roles r ON r.slug = u.role
      LEFT JOIN salespersons s ON s.id = u.salesperson_id
      WHERE u.id = ?
    `,
      [params.data.id],
    );
    if (!row) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(UpdateUserResponse.parse(userFromRow(row)));
  },
);

router.post(
  "/users/:id/password",
  requirePermission("users.manage"),
  (req, res): void => {
    const params = ResetUserPasswordParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ResetUserPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const changes = executeChanges(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      [hashPassword(parsed.data.password), params.data.id],
    );
    if (!changes) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    revokeUserSessions(params.data.id);
    ResetUserPasswordResponse.parse(undefined);
    res.status(204).end();
  },
);

export default router;

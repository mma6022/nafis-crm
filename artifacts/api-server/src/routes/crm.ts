import express, { Router, type IRouter } from "express";
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
  CreateConsultationLoanApplicationBody,
  CreateConsultationLoanApplicationParams,
  CreateConsultationLoanApplicationResponse,
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
  MatchConsultationLoanPlansParams,
  MatchConsultationLoanPlansResponse,
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
} from "@workspace/api-zod";
import {
  execute,
  executeChanges,
  queryRow,
  queryRows,
  runTransaction,
  type SqlValue,
} from "../lib/crm-db";
import { hashPassword, requireAdmin, revokeUserSessions, type AuthUser } from "../lib/auth";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  getNotificationSettings,
  notifyNewCustomer,
  saveNotificationSettings,
} from "../lib/customer-notifications";
import { createDatabaseBackup, validateSqliteDatabase } from "../lib/database-backup";
import { databasePath } from "../lib/crm-db";
import { PERMISSIONS, requirePermission } from "../lib/access-control";
import { deriveCreditRank, invalidCreditScoreMessage } from "../lib/credit-rank";
import * as ics24 from "../lib/ics24";

const router: IRouter = Router();

router.get("/database-backup", requireAdmin, (_req, res): void => {
  let backupPath: string | undefined;
  try {
    backupPath = createDatabaseBackup("download");
    res.download(backupPath, `crm-backup-${new Date().toISOString().slice(0, 10)}.db`, (error) => {
      if (backupPath) fs.rmSync(backupPath, { force: true });
      if (error && !res.headersSent) res.status(500).json({ message: "دریافت نسخه پشتیبان انجام نشد." });
    });
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
      res.status(202).json({ message: "دیتابیس معتبر است و سامانه برای اعمال آن راه‌اندازی مجدد می‌شود." });
      setTimeout(() => process.exit(0), 500).unref();
    } catch {
      fs.rmSync(temporaryPath, { force: true });
      res.status(400).json({ message: "فایل آپلودشده دیتابیس سالم CRM نیست." });
    }
  },
);

router.get("/consult-options", requirePermission("consultations.view"), (req, res): void => {
  const parsed = ListConsultOptionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = queryRows<{
    id: number;
    field_key: string;
    option_value: string;
    label_fa: string;
    sort_order: number;
  }>(
    `
      SELECT id, field_key, option_value, label_fa, sort_order
      FROM consult_options
      WHERE active = 1
        ${parsed.data.fieldKey ? "AND field_key = ?" : ""}
      ORDER BY field_key, sort_order, id
    `,
    parsed.data.fieldKey ? [parsed.data.fieldKey] : [],
  );
  res.json(
    ListConsultOptionsResponse.parse(
      rows.map((row) => ({
        id: Number(row.id),
        fieldKey: row.field_key,
        value: row.option_value,
        labelFa: row.label_fa,
        sortOrder: Number(row.sort_order),
      })),
    ),
  );
});

function notificationSettingsResponse() {
  return {
    ...getNotificationSettings(),
    telegramBotTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  };
}

router.get("/notification-settings", requirePermission("notifications.view"), (_req, res): void => {
  res.json(GetNotificationSettingsResponse.parse(notificationSettingsResponse()));
});

router.patch("/notification-settings", requirePermission("notifications.manage"), (req, res): void => {
  const parsed = UpdateNotificationSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  saveNotificationSettings(parsed.data);
  res.json(UpdateNotificationSettingsResponse.parse(notificationSettingsResponse()));
});

router.get("/notification-deliveries", requirePermission("notifications.view"), (req, res): void => {
  const parsed = ListNotificationDeliveriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = queryRows<{
    id: number;
    customer_id: number;
    customer_name: string;
    channel: string;
    status: string;
    error_message: string | null;
    created_at: string;
  }>(
    `SELECT nd.id, nd.customer_id, c.name AS customer_name, nd.channel,
       nd.status, nd.error_message, nd.created_at
     FROM notification_deliveries nd
     JOIN customers c ON c.id = nd.customer_id
     ORDER BY nd.created_at DESC, nd.id DESC
     LIMIT ?`,
    [parsed.data.limit ?? 20],
  );
  res.json(ListNotificationDeliveriesResponse.parse(rows.map((row) => ({
    id: Number(row.id),
    customerId: Number(row.customer_id),
    customerName: row.customer_name,
    channel: row.channel,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }))));
});

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
  national_code: string | null;
  credit_score: number | null;
  credit_rank: string | null;
  credit_checked_at: string | null;
  birth_date_jalali: string | null;
  postal_code: string | null;
  verification_status: string | null;
  is_urgent: number | null;
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
};

type ConsultationRow = {
  id: number;
  customer_id: number;
  customer_name: string;
  customer_phone: string;
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
  primary_contract_template_id: number | null;
  invoice_template_id: number | null;
  acknowledgement_template_id: number | null;
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
  subject: string | null;
  message: string;
  remind_at: string;
  notified_at: string | null;
  sent_sms: number;
  done: number;
  created_at: string;
};

function customerFromRow(row: CustomerRow) {
  return {
    id: Number(row.id),
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
    nationalCode: row.national_code ?? null,
    creditScore: row.credit_score == null ? null : Number(row.credit_score),
    creditRank: row.credit_rank ?? null,
    creditCheckedAt: row.credit_checked_at ?? null,
    birthDateJalali: row.birth_date_jalali ?? null,
    postalCode: row.postal_code ?? null,
    verificationStatus: row.verification_status === "verified" ? "verified" : "unverified",
    isUrgent: Boolean(row.is_urgent),
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
  };
}

function consultationFromRow(row: ConsultationRow) {
  const bool = (value: number | null) => (value == null ? null : Boolean(value));
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    hasCheck: bool(row.has_check),
    hasPromissory: bool(row.has_promissory),
    hasGuarantor: bool(row.has_guarantor),
    hasGuarantorCheck: bool(row.has_guarantor_check),
    hasGuarantorPromissory: bool(row.has_guarantor_promissory),
    jobType: row.job_type ?? null,
    hasBusinessLicense: bool(row.has_business_license),
    hasAccountTurnover: bool(row.has_account_turnover),
    // Customer credit rank is authoritative. A consultation's stored rank is
    // legacy/request data and must not leak into matching or API responses.
    creditRank: row.customer_credit_rank ?? null,
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
        needs_customer_check, needs_guarantor_check, sort_order, notes
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
    sortOrder: Number(row.sort_order),
    notes: row.notes ?? null,
  }));
}

function planFromRow(row: LoanPlanRow) {
  return {
    id: Number(row.id),
    name: row.name,
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
    primaryContractTemplateId: row.primary_contract_template_id ?? null,
    invoiceTemplateId: row.invoice_template_id ?? null,
    acknowledgementTemplateId: row.acknowledgement_template_id ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    conditions: planConditions(Number(row.id)),
  };
}

function userFromRow(row: UserRow) {
  return {
    id: Number(row.id),
    username: row.username,
    fullName: row.full_name ?? null,
    mobile: row.mobile ?? null,
    telegramId: row.telegram_id ?? null,
    role: row.role,
    roleName: row.role_name ?? row.role,
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    salespersonName: row.salesperson_name ?? null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function reminderFromRow(row: ReminderRow) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    salespersonId:
      row.salesperson_id == null ? null : Number(row.salesperson_id),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name ?? null,
    subject: row.subject || row.message.slice(0, 80),
    message: row.message,
    remindAt: row.remind_at,
    notifiedAt: row.notified_at ?? null,
    smsSent: Boolean(row.sent_sms),
    done: Boolean(row.done),
    createdAt: row.created_at,
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
    c.verification_status,
    c.is_urgent,
    c.created_at,
    c.salesperson_id,
    s.name AS salesperson_name,
    c.priority,
    COALESCE(c.status, 'in_progress') AS status,
    COUNT(cl.id) AS activity_count,
    MAX(cl.created_at) AS last_activity_at
  FROM customers c
  LEFT JOIN salespersons s ON s.id = c.salesperson_id
  LEFT JOIN call_logs cl ON cl.customer_id = c.id
`;

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
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC",
  });
  const currentYear = Number(formatter.formatToParts(today).find((part) => part.type === "year")?.value);
  if (year < 1200 || year > currentYear || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("تاریخ تولد جلالی معتبر نیست.");
  }
  // Validate against the runtime's actual Persian calendar conversion rather
  // than a 33-year leap approximation. Search only the relevant Gregorian
  // year, which is bounded to at most 367 dates.
  const target = `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  const start = Date.UTC(year - 622, 0, 1);
  let valid = false;
  for (let offset = 0; offset < 367; offset += 1) {
    const candidate = new Date(start + offset * 86400000);
    const parts = formatter.formatToParts(candidate);
    const actual = `${parts.find((part) => part.type === "year")?.value}/${parts.find((part) => part.type === "month")?.value}/${parts.find((part) => part.type === "day")?.value}`;
    if (actual === target) { valid = candidate <= today; break; }
  }
  if (!valid) throw new Error("تاریخ تولد جلالی معتبر نیست.");
  return `${match[1]}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function normalizePostalCode(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const digits = normalizeDigits(value).replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(digits)) throw new Error("کد پستی باید دقیقا ۱۰ رقم باشد.");
  return digits;
}

export function getCustomer(id: number, user?: AuthUser) {
  const ownerFilter = user?.customerScope === "assigned" ? " AND c.salesperson_id = ?" : "";
  const row = queryRow<CustomerRow>(
    `${customerSelect} WHERE c.id = ?${ownerFilter} GROUP BY c.id ORDER BY c.created_at DESC`,
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

function nextAllocatedSalesperson(programId: number): number | undefined {
  const program = queryRow<{
    cursor_item_index: number;
    cursor_item_used: number;
  }>(
    `SELECT cursor_item_index, cursor_item_used
     FROM allocation_programs WHERE id = ? AND active = 1`,
    [programId],
  );
  if (!program) return undefined;
  const items = queryRows<{ salesperson_id: number; quota: number }>(
    `SELECT api.salesperson_id, api.quota
     FROM allocation_program_items api
     JOIN salespersons s ON s.id = api.salesperson_id
     WHERE api.program_id = ? AND s.active = 1
     ORDER BY api.sort_order, api.id`,
    [programId],
  );
  if (!items.length) return undefined;
  const index = Math.max(0, Number(program.cursor_item_index)) % items.length;
  const used = Math.max(0, Number(program.cursor_item_used));
  const item = items[index];
  const reachedQuota = used + 1 >= Number(item.quota);
  executeChanges(
    `UPDATE allocation_programs
     SET cursor_item_index = ?, cursor_item_used = ?, updated_at = ?
     WHERE id = ?`,
    [
      reachedQuota ? (index + 1) % items.length : index,
      reachedQuota ? 0 : used + 1,
      new Date().toISOString(),
      programId,
    ],
  );
  return Number(item.salesperson_id);
}

function getActivity(customerId: number) {
  return queryRows<ActivityRow>(
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
      LEFT JOIN salespersons s ON s.id = cl.salesperson_id
      WHERE cl.customer_id = ?
      ORDER BY cl.created_at DESC
    `,
    [customerId],
  ).map(activityFromRow);
}

router.get("/crm/summary", requirePermission("dashboard.view"), (req, res): void => {
  const user = res.locals.authUser as AuthUser;
  const salespersonId = user.customerScope === "assigned" ? user.salespersonId : null;
  const customerScope = user.customerScope === "assigned" ? " WHERE salesperson_id = ?" : "";
  const customerScopeAnd = user.customerScope === "assigned" ? " AND salesperson_id = ?" : "";
  const customerParams: SqlValue[] = user.customerScope === "assigned" ? [salespersonId] : [];
  const totals = queryRow<{
    total_customers: number;
    active_customers: number;
    open_reminders: number;
    total_calls: number;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM customers${customerScope}) AS total_customers,
      (SELECT COUNT(*) FROM customers WHERE COALESCE(status, 'in_progress') = 'in_progress'${customerScopeAnd}) AS active_customers,
      (SELECT COUNT(*) FROM reminders WHERE done = 0 AND user_id = ?) AS open_reminders,
      (SELECT COUNT(*) FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
        ${user.customerScope === "assigned" ? "WHERE c.salesperson_id = ?" : ""}) AS total_calls
  `, [...customerParams, ...customerParams, user.id, ...customerParams]);
  const statusCounts = queryRows<{ status: string; count: number }>(`
    SELECT COALESCE(status, 'in_progress') AS status, COUNT(*) AS count
    FROM customers
    ${customerScope}
    GROUP BY COALESCE(status, 'in_progress')
    ORDER BY count DESC
  `, customerParams);
  const priorityCounts = queryRows<{ priority: number; count: number }>(`
    SELECT COALESCE(priority, 0) AS priority, COUNT(*) AS count
    FROM customers
    ${customerScope}
    GROUP BY COALESCE(priority, 0)
    ORDER BY priority DESC
  `, customerParams);
  const recentActivity = queryRows<ActivityRow>(`
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
  `, customerParams).map(activityFromRow);

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
});

router.get("/customers", requirePermission("customers.view"), (req, res): void => {
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
  } = parsed.data;
  const hasPriority =
    req.query.hasPriority === "false"
      ? false
      : req.query.hasPriority === "true"
        ? true
        : parsedHasPriority;
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const filters: string[] = [];
  const params: SqlValue[] = [];
  const user = res.locals.authUser as AuthUser;
  if (user.customerScope === "assigned") {
    filters.push("c.salesperson_id = ?");
    params.push(user.salespersonId);
  }

  if (search) {
    filters.push("(LOWER(c.name) LIKE LOWER(?) OR c.phone LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (customerId !== undefined) {
    filters.push("c.id = ?");
    params.push(customerId);
  }
  if (status) {
    filters.push("COALESCE(c.status, 'in_progress') = ?");
    params.push(status);
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
  const rows = queryRows<CustomerRow>(
    `${customerSelect}${where} GROUP BY c.id${having} ORDER BY (c.priority IS NOT NULL) ASC, c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    [...params, ...havingParams, limit, offset],
  );

  res.json(
    ListCustomersResponse.parse({
      items: rows.map(customerFromRow),
      total: Number(totalRow?.total ?? 0),
      limit,
      offset,
    }),
  );
});

router.post("/customers/parse-text", requirePermission("customers.create"), async (req, res): Promise<void> => {
  const parsed = ParseCustomerTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const normalizeDigits = (value: string) => value
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
  const rawPhone = phoneLineIndex >= 0 ? lines[phoneLineIndex].replace(/[^\d+]/g, "") : "";
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
      words.length >= 2
      && words.length <= 5
      && words.every((word) => /^[\u0600-\u06FF‌]+$/u.test(word))
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
    res.json(ParseCustomerTextResponse.parse({ name, phone, description: localDescription }));
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
    res.json(ParseCustomerTextResponse.parse({
      name: typeof result.name === "string" ? result.name.trim() : name,
      phone: typeof result.phone === "string" ? normalizeDigits(result.phone).replace(/[^\d+]/g, "") : phone,
      description: typeof result.description === "string" ? result.description.trim() : localDescription,
    }));
  } catch (error) {
    req.log.error({ err: error }, "customer text extraction failed");
    if (name || phone) {
      res.json(ParseCustomerTextResponse.parse({ name, phone, description: localDescription }));
      return;
    }
    res.status(502).json({ error: "Customer text extraction failed" });
  }
});

router.post("/customers", requirePermission("customers.create"), (req, res): void => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const nationalCode = body.nationalCode ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") || null : null;
  if (nationalCode !== null && !ics24.validNationalCode(nationalCode)) {
    res.status(400).json({ error: "کد ملی معتبر نیست." });
    return;
  }
  let birthDateJalali: string | null;
  let postalCode: string | null;
  try {
    birthDateJalali = normalizeJalaliDate(body.birthDateJalali);
    postalCode = normalizePostalCode(body.postalCode);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات پروفایل معتبر نیست." });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  let id: number;
  try {
    id = runTransaction(() => {
      const allocatedSalespersonId = body.allocationProgramId
        ? nextAllocatedSalesperson(body.allocationProgramId)
        : undefined;
      if (body.allocationProgramId && !allocatedSalespersonId) {
        throw new Error("ALLOCATION_PROGRAM_UNAVAILABLE");
      }
      return execute(
        `
           INSERT INTO customers (name, phone, description, national_code, birth_date_jalali, postal_code, verification_status, is_urgent, created_at, salesperson_id, priority, status)
           VALUES (?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?)
        `,
        [
          body.name,
          body.phone,
          body.description ?? null,
           nationalCode,
           birthDateJalali,
           postalCode,
           body.isUrgent ? 1 : 0,
          new Date().toISOString(),
          user.customerScope === "assigned"
            ? user.salespersonId
            : allocatedSalespersonId ?? body.salespersonId ?? null,
          body.priority ?? null,
          body.status ?? "in_progress",
        ],
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ALLOCATION_PROGRAM_UNAVAILABLE") {
      res.status(400).json({ error: "Allocation program has no active salespersons" });
      return;
    }
    throw error;
  }
  const customer = getCustomer(id, user);
  if (!customer) {
    res.status(500).json({ error: "Customer was not created" });
    return;
  }
  res.status(201).json(CreateCustomerResponse.parse(customer));
  void notifyNewCustomer(id);
});

router.get("/customers/:id", requirePermission("customers.view"), (req, res): void => {
  const parsed = GetCustomerParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const customer = getCustomer(parsed.data.id, res.locals.authUser as AuthUser);
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(
    GetCustomerResponse.parse({
      ...customer,
      activity: getActivity(parsed.data.id),
    }),
  );
});

router.patch("/customers/:id", requirePermission("customers.update"), (req, res): void => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries: Array<[string, SqlValue]> = [];
  const body = parsed.data;
  const user = res.locals.authUser as AuthUser;
  if (!getCustomer(params.data.id, user)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  if (body.name !== undefined) entries.push(["name", body.name]);
  if (body.phone !== undefined) entries.push(["phone", body.phone]);
  if (body.description !== undefined) entries.push(["description", body.description]);
  if (body.nationalCode !== undefined) {
    const nationalCode = body.nationalCode ? ics24.normalizeDigits(body.nationalCode).replace(/\D/g, "") || null : null;
    if (nationalCode !== null && !ics24.validNationalCode(nationalCode)) {
      res.status(400).json({ error: "کد ملی معتبر نیست." });
      return;
    }
    entries.push(["national_code", nationalCode]);
  }
  try {
    if (body.birthDateJalali !== undefined) entries.push(["birth_date_jalali", normalizeJalaliDate(body.birthDateJalali)]);
    if (body.postalCode !== undefined) entries.push(["postal_code", normalizePostalCode(body.postalCode)]);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات پروفایل معتبر نیست." });
    return;
  }
  if (body.verificationStatus !== undefined) entries.push(["verification_status", body.verificationStatus]);
  if (body.isUrgent !== undefined) entries.push(["is_urgent", body.isUrgent ? 1 : 0]);
  if (body.salespersonId !== undefined && user.customerScope !== "assigned") entries.push(["salesperson_id", body.salespersonId]);
  if (body.priority !== undefined) entries.push(["priority", body.priority]);
  if (body.status !== undefined) entries.push(["status", body.status]);
  if (!entries.length) {
    res.status(400).json({ error: "At least one field is required" });
    return;
  }
  const setClause = entries.map(([field]) => `${field} = ?`).join(", ");
  const changes = executeChanges(
    `UPDATE customers SET ${setClause} WHERE id = ?`,
    [...entries.map(([, value]) => value), params.data.id],
  );
  if (!changes) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const customer = getCustomer(params.data.id, user);
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json(UpdateCustomerResponse.parse(customer));
});

router.delete("/customers/:id", requirePermission("customers.delete"), (req, res): void => {
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
    executeChanges("UPDATE reminders SET customer_id = NULL WHERE customer_id = ?", [parsed.data.id]);
    executeChanges("DELETE FROM notification_deliveries WHERE customer_id = ?", [parsed.data.id]);
    executeChanges("DELETE FROM call_logs WHERE customer_id = ?", [parsed.data.id]);
    executeChanges("DELETE FROM consultation_forms WHERE customer_id = ?", [parsed.data.id]);
    executeChanges("DELETE FROM customers WHERE id = ?", [parsed.data.id]);
  });
  res.status(204).send();
});

type CreditCheckRow = {
  id: number; customer_id: number; requested_by_user_id: number; national_code: string;
  provider_reference: string | null; provider_status: string | null; status: string;
  score: number | null; score_label: string | null; summary: string | null;
  error_message: string | null; created_at: string; updated_at: string; completed_at: string | null;
};
const activeCreditStarts = new Set<number>();
function creditCheckFromRow(row: CreditCheckRow) {
  const score = row.score == null ? null : Number(row.score);
  const rank = deriveCreditRank(score);
  return {
    id: Number(row.id), customerId: Number(row.customer_id), status: row.status,
    nationalCode: row.national_code, providerReference: row.provider_reference ?? null,
    providerStatus: row.provider_status ?? null, score,
    scoreLabel: rank.ok ? rank.rank : null, summary: row.summary ?? null,
    errorMessage: row.error_message ?? null, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at ?? null,
  };
}
function getCreditCheck(customerId: number, checkId: number) {
  return queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id = ? AND customer_id = ?", [checkId, customerId]);
}
async function refreshCreditCheck(row: CreditCheckRow): Promise<CreditCheckRow> {
  if (!row.provider_reference || row.status === "report_generated" || row.status === "failed") return row;
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
           [provider.status, summary.score, invalidCreditScoreMessage(rank.reason), now, row.id],
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
           [provider.status, summary.score, rank.rank, summary.summary, now, completedAt, row.id],
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
             [summary.score, rank.rank, completedAt, row.customer_id, row.customer_id, row.created_at, row.created_at, row.id],
          );
        }
      });
    } else if (provider.status === "ReportGenerationFailed" || provider.status === "ReportGeneratedButDataLost") {
      execute(`UPDATE customer_credit_checks SET status = 'failed', provider_status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        [provider.status, provider.statusTitle || "تولید گزارش ناموفق بود.", now, row.id]);
    } else {
      execute(`UPDATE customer_credit_checks SET status = 'processing', provider_status = ?, updated_at = ? WHERE id = ?`, [provider.status, now, row.id]);
    }
  } catch (error) {
    execute(`UPDATE customer_credit_checks SET error_message = ?, updated_at = ? WHERE id = ?`,
      [error instanceof Error ? error.message.slice(0, 240) : "خطای سرویس اعتبارسنجی", new Date().toISOString(), row.id]);
  }
  return getCreditCheck(row.customer_id, row.id) ?? row;
}

router.get("/customers/:id/credit-checks", requirePermission("customers.credit_check"), (req, res): void => {
  const parsed = ListCustomerCreditChecksParams.safeParse(req.params);
  const user = res.locals.authUser as AuthUser;
  if (!parsed.success || !getCustomer(parsed.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const rows = queryRows<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE customer_id = ? ORDER BY created_at DESC, id DESC", [parsed.data.id]);
  res.json(ListCustomerCreditChecksResponse.parse(rows.map(creditCheckFromRow)));
});

router.post("/customers/:id/credit-checks", requirePermission("customers.credit_check"), async (req, res): Promise<void> => {
  const params = InitiateCustomerCreditCheckParams.safeParse(req.params);
  const body = InitiateCustomerCreditCheckBody.safeParse(req.body);
  const user = res.locals.authUser as AuthUser;
  if (!params.success || !body.success) { res.status(400).json({ error: "اطلاعات استعلام معتبر نیست." }); return; }
  if (!getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const customer = getCustomer(params.data.id, user)!;
  const mobile = ics24.normalizeMobile(body.data.mobileNumber || customer.phone);
  const nationalCode = ics24.normalizeDigits(body.data.nationalCode).replace(/\D/g, "");
  if (!ics24.validNationalCode(nationalCode)) { res.status(400).json({ error: "کد ملی معتبر نیست." }); return; }
  if (!mobile) { res.status(400).json({ error: "شماره موبایل معتبر ایرانی نیست." }); return; }
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  execute(
    "UPDATE customer_credit_checks SET status = 'failed', error_message = 'مهلت استعلام منقضی شد.', updated_at = ? WHERE customer_id = ? AND status IN ('awaiting_otp','processing') AND created_at < ?",
    [new Date().toISOString(), params.data.id, staleBefore],
  );
  const active = queryRow<{ id: number }>("SELECT id FROM customer_credit_checks WHERE customer_id = ? AND status IN ('awaiting_otp','processing') LIMIT 1", [params.data.id]);
  if (active || activeCreditStarts.has(params.data.id)) { res.status(409).json({ error: "برای این مشتری یک استعلام فعال وجود دارد." }); return; }
  activeCreditStarts.add(params.data.id);
  const now = new Date().toISOString();
  const id = execute(
    `INSERT INTO customer_credit_checks
      (customer_id, requested_by_user_id, national_code, status, created_at, updated_at)
     VALUES (?, ?, ?, 'awaiting_otp', ?, ?)`,
    [params.data.id, user.id, `******${nationalCode.slice(-4)}`, now, now],
  );
  executeChanges("UPDATE customers SET national_code = ? WHERE id = ?", [nationalCode, params.data.id]);
  try {
    const hash = await ics24.initiate(nationalCode, mobile);
    executeChanges(
      "UPDATE customer_credit_checks SET provider_reference = ?, updated_at = ? WHERE id = ?",
      [hash, new Date().toISOString(), id],
    );
    const result = getCreditCheck(params.data.id, id)!;
    res.status(201).json(InitiateCustomerCreditCheckResponse.parse(creditCheckFromRow(result)));
  } catch (error) {
    executeChanges(
      "UPDATE customer_credit_checks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
      [error instanceof Error ? error.message.slice(0, 240) : "شروع استعلام ناموفق بود.", new Date().toISOString(), id],
    );
    res.status(502).json({ error: error instanceof Error ? error.message : "سرویس اعتبارسنجی در دسترس نیست." });
  } finally {
    activeCreditStarts.delete(params.data.id);
  }
});

router.post("/customers/:id/credit-checks/:checkId/validate", requirePermission("customers.credit_check"), async (req, res): Promise<void> => {
  const params = ValidateCustomerCreditCheckParams.safeParse(req.params);
  const body = ValidateCustomerCreditCheckBody.safeParse(req.body);
  const user = res.locals.authUser as AuthUser;
  if (!params.success || !body.success) { res.status(400).json({ error: "رمز یک‌بارمصرف معتبر نیست." }); return; }
  if (!getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const row = getCreditCheck(params.data.id, params.data.checkId);
  if (!row || row.status !== "awaiting_otp") { res.status(404).json({ error: "Credit check not found" }); return; }
  try {
    await ics24.validate(row.provider_reference!, body.data.otp);
    execute("UPDATE customer_credit_checks SET status = 'processing', updated_at = ?, error_message = NULL WHERE id = ?", [new Date().toISOString(), row.id]);
    const result = await refreshCreditCheck(getCreditCheck(row.customer_id, row.id)!);
    res.json(ValidateCustomerCreditCheckResponse.parse(creditCheckFromRow(result)));
  } catch (error) {
    execute("UPDATE customer_credit_checks SET error_message = ?, updated_at = ? WHERE id = ?", [error instanceof Error ? error.message.slice(0, 240) : "اعتبارسنجی OTP ناموفق بود.", new Date().toISOString(), row.id]);
    res.status(502).json({ error: error instanceof Error ? error.message : "اعتبارسنجی OTP ناموفق بود." });
  }
});

router.post("/customers/:id/credit-checks/:checkId/renew", requirePermission("customers.credit_check"), async (req, res): Promise<void> => {
  const params = RenewCustomerCreditCheckOtpParams.safeParse(req.params);
  const user = res.locals.authUser as AuthUser;
  if (!params.success || !getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const row = getCreditCheck(params.data.id, params.data.checkId);
  if (!row || row.status !== "awaiting_otp") { res.status(404).json({ error: "Credit check not found" }); return; }
  try {
    await ics24.renew(row.provider_reference!);
    execute("UPDATE customer_credit_checks SET updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
    res.json(RenewCustomerCreditCheckOtpResponse.parse(creditCheckFromRow(getCreditCheck(row.customer_id, row.id)!)));
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "ارسال مجدد رمز انجام نشد." }); }
});

router.post("/customers/:id/credit-checks/:checkId/status", requirePermission("customers.credit_check"), async (req, res): Promise<void> => {
  const params = RefreshCustomerCreditCheckStatusParams.safeParse(req.params);
  const user = res.locals.authUser as AuthUser;
  if (!params.success || !getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const row = getCreditCheck(params.data.id, params.data.checkId);
  if (!row) { res.status(404).json({ error: "Credit check not found" }); return; }
  const result = await refreshCreditCheck(row);
  res.json(RefreshCustomerCreditCheckStatusResponse.parse(creditCheckFromRow(result)));
});

router.get("/customers/:id/credit-checks/:checkId/report.pdf", requirePermission("customers.credit_check"), async (req, res): Promise<void> => {
  const params = RefreshCustomerCreditCheckStatusParams.safeParse(req.params);
  const user = res.locals.authUser as AuthUser;
  if (!params.success || !getCustomer(params.data.id, user)) { res.status(404).json({ error: "Customer not found" }); return; }
  const row = getCreditCheck(params.data.id, params.data.checkId);
  if (!row?.provider_reference) { res.status(404).json({ error: "Credit check not found" }); return; }
  try {
    const provider = await ics24.status(row.provider_reference);
    if (provider.status !== "ReportGenerated" || !provider.reportCode) {
      res.status(409).json({ error: "گزارش PDF هنوز آماده نیست." });
      return;
    }
    const pdf = await ics24.reportPdf(provider.reportCode);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="credit-report-${row.id}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(Buffer.from(pdf));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "دریافت فایل گزارش انجام نشد." });
  }
});

router.get("/customers/:id/activity", requirePermission("customers.view"), (req, res): void => {
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
});

router.get("/salespersons", requirePermission("customers.view"), (_req, res): void => {
  const rows = queryRows<{
    id: number;
    name: string;
    mobile: string | null;
    active: number;
    customer_count: number;
  }>(`
    SELECT
      s.id,
      s.name,
      s.mobile,
      s.active,
      COUNT(c.id) AS customer_count
    FROM salespersons s
    LEFT JOIN customers c ON c.salesperson_id = s.id
    GROUP BY s.id
    ORDER BY s.active DESC, s.name
  `);
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
});

router.get("/allocation-programs", requirePermission("allocation_programs.view"), (_req, res): void => {
  const rows = queryRows<{ id: number }>(
    `SELECT id FROM allocation_programs WHERE active = 1 ORDER BY is_default DESC, name, id`,
  );
  res.json(
    ListAllocationProgramsResponse.parse(
      rows.map((row) => getAllocationProgram(Number(row.id))).filter(Boolean),
    ),
  );
});

router.post("/allocation-programs", requirePermission("allocation_programs.manage"), (req, res): void => {
  const parsed = CreateAllocationProgramBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  if (new Set(body.items.map((item) => item.salespersonId)).size !== body.items.length) {
    res.status(400).json({ error: "Each salesperson can appear only once" });
    return;
  }
  const now = new Date().toISOString();
  const id = runTransaction(() => {
    if (body.isDefault) executeChanges("UPDATE allocation_programs SET is_default = 0");
    const programId = execute(
      `INSERT INTO allocation_programs
       (name, is_default, active, cursor_item_index, cursor_item_used, created_at, updated_at)
       VALUES (?, ?, 1, 0, 0, ?, ?)`,
      [body.name.trim(), body.isDefault ? 1 : 0, now, now],
    );
    body.items.forEach((item, index) => execute(
      `INSERT INTO allocation_program_items (program_id, salesperson_id, quota, sort_order)
       VALUES (?, ?, ?, ?)`,
      [programId, item.salespersonId, item.quota, index],
    ));
    return programId;
  });
  const program = getAllocationProgram(id);
  res.status(201).json(CreateAllocationProgramResponse.parse(program));
});

router.patch("/allocation-programs/:id", requirePermission("allocation_programs.manage"), (req, res): void => {
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
  if (new Set(body.items.map((item) => item.salespersonId)).size !== body.items.length) {
    res.status(400).json({ error: "Each salesperson can appear only once" });
    return;
  }
  runTransaction(() => {
    if (body.isDefault) executeChanges("UPDATE allocation_programs SET is_default = 0");
    executeChanges(
      `UPDATE allocation_programs
       SET name = ?, is_default = ?, cursor_item_index = 0, cursor_item_used = 0, updated_at = ?
       WHERE id = ?`,
      [body.name.trim(), body.isDefault ? 1 : 0, new Date().toISOString(), params.data.id],
    );
    executeChanges("DELETE FROM allocation_program_items WHERE program_id = ?", [params.data.id]);
    body.items.forEach((item, index) => execute(
      `INSERT INTO allocation_program_items (program_id, salesperson_id, quota, sort_order)
       VALUES (?, ?, ?, ?)`,
      [params.data.id, item.salespersonId, item.quota, index],
    ));
  });
  res.json(UpdateAllocationProgramResponse.parse(getAllocationProgram(params.data.id)));
});

router.get("/reminders", requirePermission("reminders.view"), (req, res): void => {
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
        r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
      FROM reminders r
      LEFT JOIN customers c ON c.id = r.customer_id
      WHERE ${filters.join(" AND ")}
      ORDER BY r.done ASC, r.remind_at ASC
    `,
    params,
  );
  res.json(
    ListRemindersResponse.parse(rows.map(reminderFromRow)),
  );
});

router.post("/reminders", requirePermission("reminders.manage"), (req, res): void => {
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
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
     FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
    [id],
  );
  if (!row) {
    res.status(500).json({ error: "Reminder was not created" });
    return;
  }
  res.status(201).json(CreateReminderResponse.parse(reminderFromRow(row)));
});

router.patch("/reminders", requirePermission("reminders.manage"), (req, res): void => {
  const parsed = UpdateReminderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  const changes = executeChanges(
    "UPDATE reminders SET done = ? WHERE id = ? AND user_id = ?",
    [parsed.data.done ? 1 : 0, parsed.data.id, user.id],
  );
  if (!changes) {
    res.status(404).json({ error: "Reminder not found" });
    return;
  }
  const row = queryRow<ReminderRow>(
    `SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
     FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.id = ? AND r.user_id = ?`,
    [parsed.data.id, user.id],
  );
  if (!row) {
    res.status(404).json({ error: "Reminder not found" });
    return;
  }
  res.json(
    UpdateReminderResponse.parse(reminderFromRow(row)),
  );
});

router.post("/reminders/:id/acknowledge", requirePermission("reminders.manage"), (req, res): void => {
  const parsed = AcknowledgeReminderParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  executeChanges(
    "UPDATE reminders SET notified_at = COALESCE(notified_at, ?) WHERE id = ? AND user_id = ?",
    [new Date().toISOString(), parsed.data.id, user.id],
  );
  const row = queryRow<ReminderRow>(
    `SELECT r.id, r.user_id, r.salesperson_id, r.customer_id, c.name AS customer_name,
      r.subject, r.message, r.remind_at, r.notified_at, r.sent_sms, r.done, r.created_at
     FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.id = ? AND r.user_id = ?`,
    [parsed.data.id, user.id],
  );
  if (!row) {
    res.status(404).json({ error: "Reminder not found" });
    return;
  }
  res.json(AcknowledgeReminderResponse.parse(reminderFromRow(row)));
});

const callSelect = `
  SELECT
    cl.id,
    cl.customer_id,
    cl.salesperson_id,
    s.name AS salesperson_name,
    cl.subject,
    cl.customer_request,
    cl.expert_notes,
    cl.created_at,
    c.name AS customer_name,
    c.phone AS customer_phone
  FROM call_logs cl
  JOIN customers c ON c.id = cl.customer_id
  LEFT JOIN salespersons s ON s.id = cl.salesperson_id
`;

router.get("/calls", requirePermission("calls.view"), (req, res): void => {
  const parsed = ListCallsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, customerId, salespersonId } = parsed.data;
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const filters: string[] = [];
  const params: SqlValue[] = [];
  const user = res.locals.authUser as AuthUser;
  if (user.customerScope === "assigned") {
    filters.push("c.salesperson_id = ?");
    params.push(user.salespersonId);
  }
  if (search) {
    filters.push(
      "(LOWER(c.name) LIKE LOWER(?) OR c.phone LIKE ? OR LOWER(COALESCE(cl.subject, '')) LIKE LOWER(?) OR LOWER(COALESCE(cl.customer_request, '')) LIKE LOWER(?))",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (customerId !== undefined) {
    filters.push("cl.customer_id = ?");
    params.push(customerId);
  }
  if (salespersonId !== undefined && user.customerScope !== "assigned") {
    filters.push("cl.salesperson_id = ?");
    params.push(salespersonId);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const total = queryRow<{ total: number }>(
    `SELECT COUNT(*) AS total FROM call_logs cl JOIN customers c ON c.id = cl.customer_id${where}`,
    params,
  );
  const rows = queryRows<CallRecordRow>(
    `${callSelect}${where} ORDER BY cl.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json(
    ListCallsResponse.parse({
      items: rows.map(callFromRow),
      total: Number(total?.total ?? 0),
      limit,
      offset,
    }),
  );
});

router.post("/calls", requirePermission("calls.create"), (req, res): void => {
  const parsed = CreateCallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const user = res.locals.authUser as AuthUser;
  if (!getCustomer(body.customerId, user)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  if (body.reminder && user.role !== "admin" && !user.permissions.includes("reminders.manage")) {
    res.status(403).json({ error: "Forbidden", permission: "reminders.manage" });
    return;
  }
  if (body.reminder && Number.isNaN(Date.parse(body.reminder.remindAt))) {
    res.status(400).json({ error: "Invalid reminder date" });
    return;
  }
  let profile: { nationalCode: string | null; postalCode: string | null; birthDateJalali: string | null } | null = null;
  try {
    if (body.profile) {
      const nationalCode = body.profile.nationalCode
        ? ics24.normalizeDigits(body.profile.nationalCode).replace(/\D/g, "") || null
        : null;
      if (nationalCode !== null && !ics24.validNationalCode(nationalCode)) throw new Error("کد ملی معتبر نیست.");
      profile = {
        nationalCode,
        postalCode: normalizePostalCode(body.profile.postalCode),
        birthDateJalali: normalizeJalaliDate(body.profile.birthDateJalali),
      };
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "اطلاعات پروفایل معتبر نیست." });
    return;
  }
  const id = runTransaction(() => {
    if (profile) executeChanges(
      "UPDATE customers SET national_code = ?, postal_code = ?, birth_date_jalali = ? WHERE id = ?",
      [profile.nationalCode, profile.postalCode, profile.birthDateJalali, body.customerId],
    );
    const callId = execute(
      `
      INSERT INTO call_logs
        (customer_id, salesperson_id, subject, customer_request, expert_notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
      body.customerId,
      user.customerScope === "assigned" ? user.salespersonId : body.salespersonId ?? null,
      body.subject ?? null,
      body.customerRequest ?? null,
      body.expertNotes ?? null,
      new Date().toISOString(),
      ],
    );
    if (body.reminder) execute(
      `INSERT INTO reminders
        (user_id, salesperson_id, customer_id, subject, message, remind_at, sent_sms, done, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [user.id, user.salespersonId, body.customerId, body.reminder.subject.trim(),
        body.reminder.message.trim(), new Date(body.reminder.remindAt).toISOString(), new Date().toISOString()],
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
    c.credit_rank AS customer_credit_rank
  FROM consultation_forms cf
  JOIN customers c ON c.id = cf.customer_id
`;

function getConsultation(id: number, user?: AuthUser) {
  const ownerFilter = user?.customerScope === "assigned" ? " AND c.salesperson_id = ?" : "";
  const row = queryRow<ConsultationRow>(
    `${consultationSelect} WHERE cf.id = ?${ownerFilter}`,
    user?.customerScope === "assigned" ? [id, user.salespersonId] : [id],
  );
  return row ? consultationFromRow(row) : undefined;
}

function consultationFields(body: Record<string, unknown>) {
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
    // A consultation never owns the customer's rank. It is always read from
    // the customer profile; only guarantorCreditRank is caller supplied.
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

function authoritativeCreditRank(customerId: number): string | null {
  const row = queryRow<{ credit_rank: string | null }>(
    "SELECT credit_rank FROM customers WHERE id = ?",
    [customerId],
  );
  return row?.credit_rank?.trim() || null;
}

router.get("/consultations", requirePermission("consultations.view"), (req, res): void => {
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
  if (search) {
    filters.push(
      "(LOWER(c.name) LIKE LOWER(?) OR c.phone LIKE ? OR LOWER(COALESCE(cf.loan_purpose, '')) LIKE LOWER(?))",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
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
    `${consultationSelect}${where} ORDER BY cf.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json(
    ListConsultationsResponse.parse({
      items: rows.map(consultationFromRow),
      total: Number(total?.total ?? 0),
      limit,
      offset,
    }),
  );
});

router.post("/consultations", requirePermission("consultations.create"), (req, res): void => {
  const parsed = CreateConsultationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data as Record<string, unknown>;
  if (!getCustomer(Number(body.customerId), res.locals.authUser as AuthUser)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const values = consultationFields(body);
  const currentCreditRank = authoritativeCreditRank(Number(body.customerId));
  const rank = values.find(([column]) => column === "credit_rank");
  if (rank) rank[1] = currentCreditRank;
  else values.push(["credit_rank", currentCreditRank]);
  const columns = values.map(([column]) => column);
  const params = values.map(([, value]) => value);
  columns.push("updated_at");
  params.push(new Date().toISOString());
  const id = execute(
    `INSERT INTO consultation_forms (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
  );
  const consultation = getConsultation(id, res.locals.authUser as AuthUser);
  if (!consultation) {
    res.status(500).json({ error: "Consultation was not created" });
    return;
  }
  res.status(201).json(CreateConsultationResponse.parse(consultation));
});

router.get("/consultations/:id", requirePermission("consultations.view"), (req, res): void => {
  const parsed = GetConsultationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const consultation = getConsultation(parsed.data.id, res.locals.authUser as AuthUser);
  if (!consultation) {
    res.status(404).json({ error: "Consultation not found" });
    return;
  }
  res.json(GetConsultationResponse.parse(consultation));
});

router.patch("/consultations/:id", requirePermission("consultations.update"), (req, res): void => {
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
  if (parsed.data.customerId !== undefined && !getCustomer(parsed.data.customerId, user)) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const values = consultationFields(parsed.data as Record<string, unknown>);
  const hadUpdateFields = values.length > 0;
  const existing = getConsultation(params.data.id, user);
  const effectiveCustomerId = parsed.data.customerId ?? existing?.customerId;
  const currentCreditRank = effectiveCustomerId ? authoritativeCreditRank(effectiveCustomerId) : null;
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
    [...values.map(([, value]) => value), new Date().toISOString(), params.data.id],
  );
  const consultation = getConsultation(params.data.id, user);
  if (!consultation) {
    res.status(404).json({ error: "Consultation not found" });
    return;
  }
  res.json(UpdateConsultationResponse.parse(consultation));
});

const planSelect = `
  SELECT id, name, bank_name, platform_name, principal_amount, annual_interest,
    installments, installment_terms, required_documents, deduct_percents,
    customer_ranks, customer_check,
    needs_customer_promissory, customer_jobs, process_mode, needs_guarantor,
    guarantor_ranks, guarantor_check, needs_guarantor_promissory, guarantor_jobs,
    loan_type, grant_days, needs_account_turnover, needs_avg_balance, notes,
    active, created_at, prepayment_percents, deposit_percents,
    needs_customer_salary_deduct, needs_guarantor_salary_deduct
    ,primary_contract_template_id, invoice_template_id, acknowledgement_template_id
  FROM loan_plans
`;

function getPlan(id: number) {
  const row = queryRow<LoanPlanRow>(`${planSelect} WHERE id = ?`, [id]);
  return row ? planFromRow(row) : undefined;
}

const planColumns: Record<string, string> = {
  name: "name",
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
  primaryContractTemplateId: "primary_contract_template_id",
  invoiceTemplateId: "invoice_template_id",
  acknowledgementTemplateId: "acknowledgement_template_id",
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
      const isJsonField = key === "installmentTerms" || key === "requiredDocuments";
      values.push([
        column,
        boolFields.has(key)
          ? (body[key] ? 1 : 0)
          : isJsonField
            ? JSON.stringify(body[key])
            : (body[key] as SqlValue),
      ]);
    }
  }
  return values;
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
  sortOrder?: number;
  notes?: string;
};

function replacePlanConditions(
  planId: number,
  conditions: PlanConditionInput[],
) {
  executeChanges("DELETE FROM loan_plan_conditions WHERE plan_id = ?", [planId]);
  conditions.forEach((condition, index) => {
    execute(
      `
        INSERT INTO loan_plan_conditions (
          plan_id, max_principal, customer_ranks, installment_options,
          customer_jobs, collateral_type, needs_guarantor, guarantor_ranks,
          guarantor_jobs, guarantor_collateral_type, needs_customer_promissory,
          needs_guarantor_promissory, needs_customer_salary_deduct,
          needs_guarantor_salary_deduct, needs_customer_check,
          needs_guarantor_check, sort_order, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        planId,
        condition.maxPrincipal?.trim() || null,
        JSON.stringify(condition.customerRanks ?? []),
        JSON.stringify(condition.installmentOptions ?? []),
        JSON.stringify(condition.customerJobs ?? []),
        condition.collateralType?.trim() || null,
        condition.needsGuarantor ? 1 : 0,
        JSON.stringify(condition.guarantorRanks ?? []),
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
      ],
    );
  });
}

function parseRankList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((rank) => String(rank).trim().toUpperCase()).filter(Boolean);
    }
  } catch {
    // Older rows may contain comma-separated values instead of JSON.
  }
  return value
    .split(/[,،]/)
    .map((rank) => rank.trim().replace(/[\[\]"]/g, "").toUpperCase())
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
    if (requested == null) missingInformation.push("مبلغ درخواستی مشتری");
    else if (requested > maximum) {
      failedRequirements.push(
        `مبلغ درخواستی بیشتر از سقف ${condition.maxPrincipal} است`,
      );
    }
  }

  const customerRanks = parseRankList(condition.customerRanks);
  if (customerRanks.length) {
    const rank = consultation.creditRank?.trim().toUpperCase();
    if (!rank) missingInformation.push("رتبه اعتباری مشتری");
    else if (!customerRanks.includes(rank)) {
      failedRequirements.push(`رتبه اعتباری مجاز: ${customerRanks.join("، ")}`);
    }
  }

  const guarantorRanks = parseRankList(condition.guarantorRanks);
  if (guarantorRanks.length) {
    const rank = consultation.guarantorCreditRank?.trim().toUpperCase();
    if (!rank) missingInformation.push("رتبه اعتباری ضامن");
    else if (!guarantorRanks.includes(rank)) {
      failedRequirements.push(`رتبه مجاز ضامن: ${guarantorRanks.join("، ")}`);
    }
  }

  const customerJobs = condition.customerJobs;
  if (customerJobs.length) {
    if (!consultation.jobType) missingInformation.push("شغل مشتری");
    else if (!customerJobs.includes(consultation.jobType)) {
      failedRequirements.push("شغل مشتری در مشاغل مجاز این مسیر نیست");
    }
  }

  const guarantorJobs = condition.guarantorJobs;
  if (condition.needsGuarantor && guarantorJobs.length) {
    if (!consultation.guarantorJobType) missingInformation.push("شغل ضامن");
    else if (!guarantorJobs.includes(consultation.guarantorJobType)) {
      failedRequirements.push("شغل ضامن در مشاغل مجاز این مسیر نیست");
    }
  }

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
      requireBoolean(true, selectedType === type || hasPromissory, `سفته ${owner}`);
      return;
    }
    if (type === "salary_deduction") {
      requireBoolean(true, selectedType === type || hasSalaryDeduct, `گواهی کسر از حقوق ${owner}`);
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
  if (condition.needsGuarantor) {
    requireCollateral(
      condition.guarantorCollateralType,
      consultation.guarantorCollateralType,
      "ضامن",
      consultation.hasGuarantorPromissory,
      consultation.guarantorCheckType,
      consultation.hasGuarantorSalaryDeduct,
    );
  }

  requireBoolean(condition.needsGuarantor, consultation.hasGuarantor, "وجود ضامن");
  requireBoolean(
    condition.needsCustomerPromissory,
    consultation.hasPromissory,
    "سفته مشتری",
  );
  requireBoolean(
    condition.needsGuarantorPromissory,
    consultation.hasGuarantorPromissory,
    "سفته ضامن",
  );
  requireBoolean(condition.needsCustomerCheck, consultation.hasCheck, "چک مشتری");
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

router.get("/loan-plans", requirePermission("loan_plans.view"), (req, res): void => {
  const parsed = ListLoanPlansQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const params: SqlValue[] = [];
  const where = parsed.data.active === undefined ? "" : "WHERE active = ?";
  if (parsed.data.active !== undefined) params.push(parsed.data.active ? 1 : 0);
  const rows = queryRows<LoanPlanRow>(
    `${planSelect}${where} ORDER BY active DESC, id DESC`,
    params,
  );
  res.json(ListLoanPlansResponse.parse(rows.map(planFromRow)));
});

router.post("/loan-plans", requirePermission("loan_plans.manage"), (req, res): void => {
  const parsed = CreateLoanPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const values = planFields(parsed.data as Record<string, unknown>);
  const columns = values.map(([column]) => column);
  const params = values.map(([, value]) => value);
  columns.push("created_at");
  params.push(new Date().toISOString());
  const id = runTransaction(() => {
    const createdId = execute(
      `INSERT INTO loan_plans (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params,
    );
    replacePlanConditions(createdId, parsed.data.conditions ?? []);
    return createdId;
  });
  const plan = getPlan(id);
  if (!plan) {
    res.status(500).json({ error: "Loan plan was not created" });
    return;
  }
  res.status(201).json(CreateLoanPlanResponse.parse(plan));
});

router.get("/loan-plans/:id", requirePermission("loan_plans.view"), (req, res): void => {
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
});

router.patch("/loan-plans/:id", requirePermission("loan_plans.manage"), (req, res): void => {
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
  const values = planFields(parsed.data as Record<string, unknown>);
  if (!values.length && parsed.data.conditions === undefined) {
    res.status(400).json({ error: "At least one field is required" });
    return;
  }
  runTransaction(() => {
    if (values.length) {
      const setClause = values.map(([column]) => `${column} = ?`).join(", ");
      executeChanges(
        `UPDATE loan_plans SET ${setClause} WHERE id = ?`,
        [...values.map(([, value]) => value), params.data.id],
      );
    }
    if (parsed.data.conditions !== undefined) {
      replacePlanConditions(params.data.id, parsed.data.conditions);
    }
  });
  const plan = getPlan(params.data.id);
  if (!plan) {
    res.status(404).json({ error: "Loan plan not found" });
    return;
  }
  res.json(UpdateLoanPlanResponse.parse(plan));
});

router.get("/consultations/:id/loan-plan-matches", requirePermission("consultations.view"), (req, res): void => {
  const parsed = MatchConsultationLoanPlansParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const consultation = getConsultation(parsed.data.id, res.locals.authUser as AuthUser);
  if (!consultation) {
    res.status(404).json({ error: "Consultation not found" });
    return;
  }

  const plans = queryRows<LoanPlanRow>(
    `${planSelect} WHERE active = 1 ORDER BY id DESC`,
  ).map(planFromRow);
  const matches = plans.map((plan) => {
    if (!plan.conditions.length) {
      return {
        plan,
        status: "needs_review" as const,
        matchedConditionId: null,
        failedRequirements: [],
        missingInformation: ["برای این طرح شرط احراز تعریف نشده است"],
      };
    }

    const evaluations = plan.conditions.map((condition) => ({
      condition,
      ...evaluatePlanCondition(consultation, condition),
    }));
    const eligible = evaluations.find((evaluation) => evaluation.status === "eligible");
    if (eligible) {
      return {
        plan,
        status: eligible.status,
        matchedConditionId: eligible.condition.id,
        failedRequirements: [],
        missingInformation: [],
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
      failedRequirements: closest?.failedRequirements ?? [],
      missingInformation: closest?.missingInformation ?? [],
    };
  });

  const statusOrder = { eligible: 0, needs_review: 1, not_eligible: 2 };
  matches.sort((left, right) => statusOrder[left.status] - statusOrder[right.status]);
  res.json(MatchConsultationLoanPlansResponse.parse(matches));
});

router.post("/consultations/:id/loan-applications", requirePermission("consultations.update"), (req, res): void => {
  const params = CreateConsultationLoanApplicationParams.safeParse(req.params);
  const body = CreateConsultationLoanApplicationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "اطلاعات درخواست وام معتبر نیست." });
    return;
  }
  const user = res.locals.authUser as AuthUser;
  const consultation = getConsultation(params.data.id, user);
  if (!consultation) {
    res.status(404).json({ error: "Consultation not found" });
    return;
  }
  const uniquePlanIds = [...new Set(body.data.planIds)];
  const placeholders = uniquePlanIds.map(() => "?").join(",");
  const validPlans = queryRows<{ id: number }>(
    `SELECT id FROM loan_plans WHERE active = 1 AND id IN (${placeholders})`,
    uniquePlanIds,
  );
  if (validPlans.length !== uniquePlanIds.length) {
    res.status(400).json({ error: "یک یا چند طرح انتخاب‌شده معتبر نیست." });
    return;
  }
  const now = new Date().toISOString();
  const id = execute(
    `INSERT INTO loan_applications
      (consultation_id, customer_id, requested_by_user_id, plan_ids, requested_amount, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`,
    [
      consultation.id,
      consultation.customerId,
      user.id,
      JSON.stringify(uniquePlanIds),
      consultation.requestedAmount ?? "0",
      body.data.notes?.trim() || null,
      now,
    ],
  );
  res.status(201).json(CreateConsultationLoanApplicationResponse.parse({
    id,
    consultationId: consultation.id,
    customerId: consultation.customerId,
    planIds: uniquePlanIds,
    requestedAmount: consultation.requestedAmount ?? "0",
    status: "requested",
    notes: body.data.notes?.trim() || null,
    createdAt: now,
  }));
});

function roleResponse(slug: string) {
  const role = queryRow<{ slug: string; name: string; description: string | null; customer_scope: string; is_system: number }>(
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
    permissions: queryRows<{ permission: string }>("SELECT permission FROM role_permissions WHERE role_slug = ? ORDER BY permission", [slug]).map((item) => item.permission),
  };
}

router.get("/roles", requirePermission("users.view"), (_req, res): void => {
  const roles = queryRows<{ slug: string }>("SELECT slug FROM app_roles ORDER BY is_system DESC, name");
  res.json({ roles: roles.map((role) => roleResponse(role.slug)), availablePermissions: PERMISSIONS });
});

router.post("/roles", requireAdmin, (req, res): void => {
  const body = req.body as { slug?: string; name?: string; description?: string | null; customerScope?: string; permissions?: string[] };
  const slug = body.slug?.trim().toLowerCase();
  if (!slug || !/^[a-z][a-z0-9_-]{2,49}$/.test(slug) || !body.name?.trim()) {
    res.status(400).json({ error: "Invalid role name or slug" });
    return;
  }
  const permissions = [...new Set(body.permissions ?? [])].filter((item): item is typeof PERMISSIONS[number] => PERMISSIONS.includes(item as typeof PERMISSIONS[number]));
  try {
    execute("INSERT INTO app_roles (slug, name, description, customer_scope, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)", [
      slug, body.name.trim(), body.description?.trim() || null, body.customerScope === "assigned" ? "assigned" : "all", new Date().toISOString(),
    ]);
    for (const permission of permissions) execute("INSERT INTO role_permissions (role_slug, permission) VALUES (?, ?)", [slug, permission]);
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
  const body = req.body as { name?: string; description?: string | null; customerScope?: string; permissions?: string[] };
  const permissions = body.permissions === undefined
    ? existing.permissions
    : [...new Set(body.permissions)].filter((item): item is typeof PERMISSIONS[number] => PERMISSIONS.includes(item as typeof PERMISSIONS[number]));
  runTransaction(() => {
    executeChanges("UPDATE app_roles SET name = ?, description = ?, customer_scope = ? WHERE slug = ?", [
      body.name?.trim() || existing.name,
      body.description === undefined ? existing.description : body.description?.trim() || null,
      body.customerScope === "assigned" ? "assigned" : "all",
      slug,
    ]);
    executeChanges("DELETE FROM role_permissions WHERE role_slug = ?", [slug]);
    for (const permission of permissions) execute("INSERT INTO role_permissions (role_slug, permission) VALUES (?, ?)", [slug, permission]);
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
  const users = queryRow<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = ?", [slug]);
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
  let id: number;
  try {
    id = execute(
      `
        INSERT INTO users
          (username, password_hash, full_name, mobile, role, salesperson_id, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        body.username.trim().toLowerCase(),
        hashPassword(body.password),
        body.fullName ?? null,
        body.mobile?.trim() || null,
        body.role,
        body.salespersonId ?? null,
        body.active === false ? 0 : 1,
        new Date().toISOString(),
      ],
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
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

router.patch("/users/:id", requirePermission("users.manage"), (req, res): void => {
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
  if (body.role !== undefined && !queryRow("SELECT slug FROM app_roles WHERE slug = ?", [body.role])) {
    res.status(400).json({ error: "Role does not exist" });
    return;
  }
  const existing = queryRow<{ role: string; active: number }>(
    "SELECT role, active FROM users WHERE id = ?",
    [params.data.id],
  );
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const removesAdmin =
    existing.role === "admin" &&
    existing.active === 1 &&
    (body.role !== undefined && body.role !== "admin" || body.active === false);
  if (removesAdmin) {
    const activeAdmins = queryRow<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1",
    );
    if (Number(activeAdmins?.count ?? 0) <= 1) {
      res.status(400).json({ error: "The last active admin cannot be disabled" });
      return;
    }
  }
  const values: Array<[string, SqlValue]> = [];
  if (body.username !== undefined) values.push(["username", body.username.trim().toLowerCase()]);
  if (body.password !== undefined) values.push(["password_hash", hashPassword(body.password)]);
  if (body.fullName !== undefined) values.push(["full_name", body.fullName]);
  if (body.mobile !== undefined) values.push(["mobile", body.mobile?.trim() || null]);
  if (body.telegramId !== undefined) values.push(["telegram_id", body.telegramId?.trim() || null]);
  if (body.role !== undefined) values.push(["role", body.role]);
  if (body.salespersonId !== undefined) values.push(["salesperson_id", body.salespersonId]);
  if (body.active !== undefined) values.push(["active", body.active ? 1 : 0]);
  if (!values.length) {
    res.status(400).json({ error: "At least one field is required" });
    return;
  }
  try {
    executeChanges(
      `UPDATE users SET ${values.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
      [...values.map(([, value]) => value), params.data.id],
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    throw error;
  }
  if (body.active === false || body.password !== undefined) revokeUserSessions(params.data.id);
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
});

router.post("/users/:id/password", requirePermission("users.manage"), (req, res): void => {
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
});

export default router;
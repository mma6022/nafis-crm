import { Router } from "express";
import { guarantorGradeAllows, guarantorGradeVerdict } from "../lib/guarantor-grade-rule";
import { customerGuarantorGrade } from "../lib/guarantor-grade-source";
import { creditProviderFailure } from "../lib/credit-provider-failure";
import { supportedDocumentUpload } from "../lib/document-upload-type";
import { customerApplicationPayout } from "../lib/customer-application-payout";
import { applicationInstallment, calculatorQuote, eligibleConditionId, maximumCustomerPayout } from "../lib/plan-quote-math";
import { createQuoteRateLimit, parseQuoteBody } from "../lib/plan-quote-guard";
import { trustedClientIp } from "../lib/client-ip";
import { activeQuotePlan as crmActiveQuotePlan } from "./crm";

/** Full plan (rates) for server-side quotes only; never serialized. Fails closed (unknown amount) like the old browser fetch. */
function activeQuotePlan(id: number) {
  try { return crmActiveQuotePlan(id); } catch { return undefined; }
}
import fs from "node:fs";
import path from "node:path";
import crypto, { randomBytes } from "node:crypto";
import multer from "multer";
import { databasePath, execute, executeChanges, queryRow, queryRows, runImmediateTransaction, runTransaction } from "../lib/crm-db";
import { customerPortalSession, requireCustomerPortal } from "../lib/customer-portal-auth";
import { ensureWalletSchema, getWalletSummaryReadOnly, wallet } from "../lib/wallets";
import { normalizeMobile, validNationalCode, normalizeDigits } from "../lib/ics24";
import * as ics24 from "../lib/ics24";
import { deriveCreditRank, invalidCreditScoreMessage } from "../lib/credit-rank";
import { isStrictSignedProviderState } from "../lib/emzame-signature";
import { portalDocumentsState } from "../lib/portal-intake-documents";
import { rowAllowsProfile } from "../lib/plan-profile-match";
import { latestApplicantProfile } from "../lib/team-sales";
import {
  conditionAcceptsCreditRank,
  documentLabel,
  effectivePlanTerms,
  filingFeePrerequisiteError,
  freshSuccessfulCredit,
  hasFreshIdentityDocuments,
  payablePlan,
  planAcceptsCustomerCredit,
  reusableFilingFeeCharge,
  validatedPrimaryManualValues,
} from "./loan-applications";

const router = Router();
router.use(requireCustomerPortal);
ensureWalletSchema();

const now = () => new Date().toISOString();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 }, storage: multer.memoryStorage() });
const identityRoot = path.join(path.dirname(databasePath), "customer-identity-documents");
const applicationRoot = path.join(path.dirname(databasePath), "loan-application-files");
fs.mkdirSync(identityRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(applicationRoot, { recursive: true, mode: 0o700 });
try { fs.chmodSync(identityRoot, 0o700); } catch { /* keep private mode where supported */ }
try { fs.chmodSync(applicationRoot, 0o700); } catch { /* keep private mode where supported */ }
const identityRootReal = fs.realpathSync(identityRoot);
const applicationRootReal = fs.realpathSync(applicationRoot);

const identityTypeAliases: Record<string, string> = {
  national_card_front: "national_card_front",
  national_card_back: "national_card_back",
  birth_cert_p1: "birth_cert_p1",
  birth_cert_p2: "birth_cert_p2",
  birth_cert_p3: "birth_cert_p3",
  birth_certificate_first_page: "birth_cert_p1",
  birth_certificate_second_page: "birth_cert_p2",
  birth_certificate_last_page: "birth_cert_p3",
};
const identityTypeOutput: Record<string, string> = {
  national_card_front: "national_card_front",
  national_card_back: "national_card_back",
  birth_cert_p1: "birth_certificate_first_page",
  birth_cert_p2: "birth_certificate_second_page",
  birth_cert_p3: "birth_certificate_last_page",
};
const identityTypeSet = new Set(Object.values(identityTypeAliases));
const separateRequirementKeys = new Set([
  ...identityTypeSet,
  "national_card",
  "birth_certificate_all_pages",
  "guarantee_check",
  "guarantee_promissory",
]);
const safeUploadType = supportedDocumentUpload;
const normalizedName = (value: string) =>
  path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "document";
const fileSuffix = (filename: string) => {
  const ext = path.extname(path.basename(filename)).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "bin";
};
const parseJson = <T = any>(input: unknown): T | undefined => {
  try { return JSON.parse(String(input ?? "")) as T; } catch { return undefined; }
};
const filingFeeMessages: Record<string, string> = {
  invalid_identity_document: "فایل معتبر نیست. تصویر JPG، PNG یا JFIF یا فایل PDF انتخاب کنید.",
  identity_document_too_large: "حجم فایل بیشتر از ۱۰ مگابایت است. تصویر کم‌حجم‌تری انتخاب کنید.",
  identity_document_upload_failed: "مدرک ذخیره نشد. فایل را دوباره انتخاب کنید؛ اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.",
  identity_document_not_found: "این مدرک در دسترس نیست. فهرست مدارک را به‌روزرسانی کنید.",
  loan_plan_condition_not_matched: "شرایط انتخاب‌شده با رتبه اعتباری، مبلغ یا مدت بازپرداخت شما سازگار نیست. شرایط طرح را به‌روزرسانی و دوباره انتخاب کنید؛ هزینه‌ای کسر نشده است.",
  credit_check_stale: "اعتبار استعلام شما پایان یافته است. ابتدا اعتبارسنجی را دوباره انجام دهید.",
  insufficient_cash_balance: "موجودی نقدی کیف پول برای هزینه تشکیل پرونده کافی نیست. موجودی را به‌روزرسانی یا کیف پول را شارژ کنید.",
  loan_plan_not_found: "این طرح دیگر قابل ثبت نیست. طرح‌های موجود را به‌روزرسانی کنید.",
  customer_profile_incomplete: "ابتدا مشخصات هویتی موردنیاز را تکمیل کنید.",
  filing_fee_idempotency_conflict: "این شناسه پرداخت متعلق به درخواست دیگری است. صفحه را دوباره باز کنید.",
  invalid_filing_fee: "هزینه تشکیل پرونده طرح درست تنظیم نشده است. با پشتیبانی تماس بگیرید.",
  invalid_wallet_balance: "امکان بررسی موجودی کیف پول وجود ندارد. با پشتیبانی تماس بگیرید؛ هزینه‌ای کسر نشده است.",
  filing_fee_charge_failed: "پرداخت هزینه تشکیل پرونده ثبت نشد. موجودی را به‌روزرسانی و دوباره تلاش کنید.",
};
const jsonError = (res: any, status: number, code: string) => res.status(status).json({
  error: code, code, ...(filingFeeMessages[code] ? { message: filingFeeMessages[code] } : {}),
});

type PortalCustomer = {
  id: number;
  name: string;
  phone: string;
  national_code: string | null;
  birth_date_jalali: string | null;
  verification_status: string | null;
  identity_changed_at: string | null;
  salesperson_id: number | null;
  merged_into_customer_id: number | null;
};

function portalCustomer(res: any): PortalCustomer | undefined {
  const session = customerPortalSession(res);
  if (!session) {
    jsonError(res, 401, "customer_authentication_required");
    return undefined;
  }
  if (session.customerId == null) {
    jsonError(res, 409, "customer_profile_required");
    return undefined;
  }
  const customer = queryRow<PortalCustomer>(
    `SELECT id,name,phone,national_code,birth_date_jalali,verification_status,identity_changed_at,salesperson_id,merged_into_customer_id
     FROM customers WHERE id=? AND merged_into_customer_id IS NULL`,
    [session.customerId],
  );
  if (!customer || normalizeMobile(customer.phone) !== normalizeMobile(session.mobile)) {
    jsonError(res, 404, "customer_not_found");
    return undefined;
  }
  return customer;
}

function mapIdentityDocument(row: any) {
  return {
    id: Number(row.id),
    documentType: identityTypeOutput[row.document_type] ?? row.document_type,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    status: row.approved_at ? "approved" : row.review_reason ? "rejected" : "pending",
    reviewReason: row.review_reason ?? null,
    createdAt: row.created_at,
  };
}

function currentIdentityDocuments(customerId: number) {
  return queryRows<any>(
    `SELECT id,document_type,original_name,mime_type,size_bytes,approved_at,review_reason,created_at
     FROM customer_identity_documents
     WHERE customer_id=? AND is_latest=1
       AND (
         (SELECT identity_changed_at FROM customers WHERE id=?) IS NULL
         OR created_at > (SELECT identity_changed_at FROM customers WHERE id=?)
       )
     ORDER BY document_type`,
    [customerId, customerId, customerId],
  ).map(mapIdentityDocument);
}

function activeContractExists(applicationId: number): boolean {
  return Boolean(queryRow(
    `SELECT 1 FROM loan_application_generated_documents d
     JOIN contract_generations g ON g.id=d.contract_generation_id
     WHERE d.application_id=? AND d.kind='primary' AND g.deleted_at IS NULL LIMIT 1`,
    [applicationId],
  ));
}

function currentPrimaryContractSigned(application: any): boolean {
  if (application?.current_primary_generation_id == null) return false;
  const generation = queryRow<any>(`SELECT d.link,g.status,g.provider_status,g.superseded_at,g.deleted_at
    FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.application_id=? AND d.kind='primary' AND d.contract_generation_id=?
    ORDER BY d.id DESC LIMIT 1`,
  [application.id, application.current_primary_generation_id]);
  return Boolean(generation && typeof generation.link === "string" && generation.link.startsWith("signed:") &&
    generation.status === "signed" && !generation.superseded_at && !generation.deleted_at &&
    isStrictSignedProviderState(generation.provider_status));
}

function hasSignedPrimaryContract(applicationId: number): boolean {
  const generations = queryRows<any>(`SELECT d.link,g.status,g.provider_status
    FROM loan_application_generated_documents d
    JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.application_id=? AND d.kind='primary' AND d.link LIKE 'signed:%' AND g.status='signed'`,
  [applicationId]);
  return generations.some((generation) => isStrictSignedProviderState(generation.provider_status));
}

function portalApplication(applicationId: number, customerId: number) {
  const row = queryRow<any>(
    `SELECT a.*,p.name AS plan_name
     FROM loan_applications a
     LEFT JOIN loan_plans p ON p.id=a.plan_id
     WHERE a.id=? AND a.customer_id=? AND a.deleted_at IS NULL`,
    [applicationId, customerId],
  );
  if (!row) return undefined;
  // Contact follows current ownership, not historical commission attribution.
  const expert = queryRow<{ name: string; mobile: string | null }>(
    `SELECT s.name,
       (SELECT NULLIF(trim(u.mobile),'') FROM users u
        WHERE u.salesperson_id=s.id AND u.active=1 AND NULLIF(trim(u.mobile),'') IS NOT NULL
        ORDER BY u.id LIMIT 1) AS mobile
     FROM customers c JOIN salespersons s ON s.id=c.salesperson_id
     WHERE c.id=? AND s.active=1`,
    [customerId],
  );
  const documents = queryRows<any>(
    `SELECT id,requirement_key,label,status,incomplete_reason,original_name,mime_type,size_bytes,created_at
     FROM loan_application_documents
     WHERE application_id=? AND source IN ('plan','manual')
       AND requirement_key NOT IN ('guarantee_check','guarantee_promissory')
     ORDER BY id`,
    [applicationId],
  ).map((document) => ({
    id: Number(document.id),
    requirementKey: document.requirement_key,
    label: document.label,
    status: document.status,
    reviewReason: document.incomplete_reason ?? null,
    originalName: document.original_name ?? null,
    mimeType: document.mime_type ?? null,
    sizeBytes: document.size_bytes == null ? null : Number(document.size_bytes),
    createdAt: document.created_at,
  }));
  const condition = parseJson<any>(row.condition_snapshot_json);
  const currentPrimarySigned = currentPrimaryContractSigned(row);
  const editable = row.stage === "draft" &&
    row.status !== "rejected" && row.initial_approval_at == null &&
    row.current_primary_generation_id == null && !activeContractExists(Number(row.id)) &&
    !currentPrimarySigned && !hasSignedPrimaryContract(Number(row.id));
  return {
    id: Number(row.id),
    planId: Number(row.plan_id),
    planName: row.plan_name ?? parseJson<any>(row.plan_snapshot_json)?.name ?? null,
    status: row.status,
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requestedAmount: String(row.requested_amount),
    ...customerApplicationPayout(row),
    approvedAmount: row.approved_amount == null ? null : String(row.approved_amount),
    // Monthly installment on today's plan terms (was computed in the browser from public rates).
    installmentAmount: applicationInstallment(activeQuotePlan(Number(row.plan_id)),
      Number(row.approved_amount ?? row.requested_amount), Number(row.duration_months) || Number(row.requested_duration_months ?? 0)),
    requestedDurationMonths: Number(row.requested_duration_months ?? row.duration_months),
    durationMonths: Number(row.duration_months),
    conditionId: condition?.id == null ? null : Number(condition.id),
    notes: row.notes ?? null,
    editable: false,
    salesExpert: expert ? { name: expert.name, mobile: expert.mobile ?? null } : null,
    currentPrimaryContractSigned: currentPrimarySigned,
    initialContractRetained: Number(row.initial_contract_retained) === 1,
    documents,
    requiredDocuments: documents.map(({ requirementKey, label, status, reviewReason }) => ({
      key: requirementKey, label, status, reviewReason,
    })),
    identityDocuments: currentIdentityDocuments(customerId),
  };
}

function creditCheckView(row: any) {
  const expiresAt = row.completed_at
    ? new Date(new Date(row.completed_at).getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;
  return {
    id: Number(row.id),
    status: row.status,
    score: row.score == null ? null : Number(row.score),
    scoreLabel: row.score_label ?? null,
    message: row.error_message ?? (row.status === "failed" ? "اعتبارسنجی ناموفق بود." : null),
    createdAt: row.created_at,
    expiresAt,
  };
}

type CreditCheckRow = {
  id: number;
  customer_id: number;
  requested_by_customer_id: number | null;
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

const creditStartInProgress = new Set<number>();

async function refreshCreditCheck(row: CreditCheckRow): Promise<CreditCheckRow> {
  if (!row.provider_reference || row.status === "report_generated" || row.status === "failed") return row;
  if (creditProviderFailure(null, row.error_message) || row.provider_status === "RequestExpired") {
    executeChanges("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
      [creditProviderFailure("RequestExpired"), now(), row.id]);
    return queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=?", [row.id]) ?? row;
  }
  try {
    const provider = await ics24.status(row.provider_reference);
    const updatedAt = now();
    if (provider.status === "ReportGenerated" && provider.reportCode) {
      const summary = await ics24.report(provider.reportCode);
      const rank = deriveCreditRank(summary.score);
      if (!rank.ok) {
        execute(
          `UPDATE customer_credit_checks SET status='failed',provider_status=?,score=?,score_label=NULL,
             error_message=?,updated_at=?,completed_at=NULL
           WHERE id=? AND status NOT IN ('report_generated','failed')`,
          [provider.status, summary.score, invalidCreditScoreMessage(rank.reason), updatedAt, row.id],
        );
      } else {
        runTransaction(() => {
          const changed = executeChanges(
            `UPDATE customer_credit_checks SET status='report_generated',provider_status=?,score=?,score_label=?,
               summary=?,error_message=NULL,updated_at=?,completed_at=?
             WHERE id=? AND status NOT IN ('report_generated','failed')`,
            [provider.status, summary.score, rank.rank, summary.summary, updatedAt, updatedAt, row.id],
          );
          if (changed) {
            executeChanges(
              `UPDATE customers SET credit_score=?,credit_rank=?,credit_checked_at=?
               WHERE id=? AND NOT EXISTS (
                 SELECT 1 FROM customer_credit_checks newer
                 WHERE newer.customer_id=? AND newer.status='report_generated'
                   AND (newer.created_at>? OR (newer.created_at=? AND newer.id>?))
               )`,
              [summary.score, rank.rank, updatedAt, row.customer_id, row.customer_id, row.created_at, row.created_at, row.id],
            );
          }
        });
      }
    } else if (creditProviderFailure(provider.status, provider.statusTitle) !== null) {
      execute(
        `UPDATE customer_credit_checks SET status='failed',provider_status=?,error_message=?,updated_at=?
         WHERE id=? AND status NOT IN ('report_generated','failed')`,
        [provider.status, creditProviderFailure(provider.status, provider.statusTitle), updatedAt, row.id],
      );
    } else {
      execute(
        `UPDATE customer_credit_checks SET status=?,provider_status=?,updated_at=?
         WHERE id=? AND status NOT IN ('report_generated','failed')`,
        [row.status === "awaiting_otp" ? "awaiting_otp" : "processing", provider.status, updatedAt, row.id],
      );
      executeChanges(
        "UPDATE customer_credit_checks SET error_message=NULL WHERE id=? AND status NOT IN ('report_generated','failed')",
        [row.id],
      );
    }
  } catch (error) {
    const terminal = creditProviderFailure(null, error instanceof Error ? error.message : null);
    if (terminal) {
      executeChanges("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND status IN ('awaiting_otp','processing')",
        [terminal, now(), row.id]);
      return queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=?", [row.id]) ?? row;
    }
    // Provider exceptions can include sensitive request material; keep codes and
    // raw provider payloads out of both logs and database error text.
    executeChanges(
      "UPDATE customer_credit_checks SET error_message=?,updated_at=? WHERE id=? AND status NOT IN ('report_generated','failed')",
      ["credit_check_status_temporarily_unavailable", now(), row.id],
    );
  }
  return queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=? AND customer_id=?", [row.id, row.customer_id]) ?? row;
}

function uploadPath(root: string, originalName: string): string {
  const rootReal = root === identityRoot ? identityRootReal : applicationRootReal;
  // Releases link their upload directories to persistent private storage.
  // Generate inside the canonical root, not the release's symlink spelling.
  const real = path.join(rootReal, `${crypto.randomUUID()}.${fileSuffix(originalName)}`);
  if (!real.startsWith(`${rootReal}${path.sep}`)) throw new Error("invalid_upload_path");
  return real;
}

function parseConditionRanks(value: unknown): unknown[] {
  return parseJson<unknown[]>(value) ??
    String(value ?? "").split(/[,،]/).map((part) => part.trim()).filter(Boolean);
}

function profilePrerequisite(customer: PortalCustomer): string | null {
  if (!customer.national_code || !String(customer.phone ?? "").trim() || !customer.birth_date_jalali) return "customer_profile_incomplete";
  return null;
}

function planConditions(planId: number, customerId: number, requireRank = false) {
  const credit = freshSuccessfulCredit(customerId);
  const guarantorRank = requireRank ? customerGuarantorGrade(customerId).rank : null;
  // crm-no-plan-option: same job / guarantor job / military rule as the first-call form and the staff wizard.
  const profile = latestApplicantProfile(customerId);
  return queryRows<any>("SELECT * FROM loan_plan_conditions WHERE plan_id=? ORDER BY sort_order,id", [planId])
    .map((condition) => {
      const plan = queryRow<any>("SELECT * FROM loan_plans WHERE id=?", [planId]);
      const terms = effectivePlanTerms(plan, condition);
      const ranks = parseConditionRanks(condition.customer_ranks);
      return { condition, terms, ranks, eligibleRank: (!requireRank || (credit != null && conditionAcceptsCreditRank(credit.score_label, ranks)
        && guarantorGradeAllows(guarantorGradeVerdict(condition, guarantorRank, plan))))
        && rowAllowsProfile(condition, profile) };
    });
}

function customerLoanOptions(customer: { id: number }) {
  const plans = queryRows<any>(
    "SELECT * FROM loan_plans WHERE active=1 ORDER BY id",
  ).filter((plan) => payablePlan(Number(plan.id)));
  return plans.map((plan) => {
      // Before credit inquiry show the plan preview. After inquiry, never offer
      // a condition that the filing-fee/final-submission guards would reject.
      const hasCredit = freshSuccessfulCredit(customer.id) != null;
      const conditions = planConditions(Number(plan.id), customer.id, hasCredit)
        .filter(({ eligibleRank }) => eligibleRank)
        .filter(({ terms }) => terms.maximum > 0n && terms.durations.length > 0)
        .map(({ condition, terms }) => ({
          id: Number(condition.id),
          name: condition.name ?? condition.title ?? `شرط ${condition.id}`,
          description: condition.description ?? null,
          minimumAmount: String(condition.min_principal ?? "0"),
          maximumAmount: terms.maximum.toString(),
          allowedDurations: terms.durations,
        }));
      const maximum = conditions.reduce((value, item) => BigInt(item.maximumAmount) > value ? BigInt(item.maximumAmount) : value, 0n);
      const durations = [...new Set(conditions.flatMap((condition) => condition.allowedDurations))].sort((a, b) => a - b);
      const templateId = Number(plan.contract_template_id ?? plan.primary_contract_template_id);
      const mappings = parseJson<any[]>(
        queryRow<{ mappings_json: string }>(
          "SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL",
          [templateId],
        )?.mappings_json,
      ) ?? [];
      const manualFields = mappings
        .filter((mapping) => (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "manual")
        .map((mapping) => ({
          variable: String(mapping.variable ?? ""),
          label: String(mapping.label ?? mapping.title ?? mapping.name ?? mapping.variable ?? ""),
          required: true,
          maxLength: 5000,
        }));
      return {
        planId: Number(plan.id),
        name: String(plan.name ?? ""),
        bankName: plan.bank_name == null ? null : String(plan.bank_name),
        description: plan.description ?? null,
        maximumAmount: maximum.toString(),
        minimumAmount: plan.min_principal == null ? "0" : String(plan.min_principal),
        allowedDurations: durations,
        conditionId: conditions.length === 1 ? conditions[0].id : null,
        conditionName: conditions.length === 1 ? conditions[0].name : null,
        conditions,
        terms: plan.terms ?? plan.description ?? null,
        filingFeeToman: String(plan.filing_fee_toman ?? "0"),
        contractTemplateId: templateId || null,
        manualFields,
      };
  });
}

/** The customer's own option plus the server-computed payout ceiling (rates stay on the server).
 *  PM item 2 (Mohammad): the principal never reaches the customer, not even in the API response — the min/max loan amount
 *  (plan and condition level) stay on the server; the form works from minPayout/maxPayout (plan-quote) and the server
 *  picks the condition and validates the principal (filing-fee + applications). */
function withMaximumPayout(option: ReturnType<typeof customerLoanOptions>[number]) {
  const plan = activeQuotePlan(option.planId);
  const { minimumAmount: _min, maximumAmount: _max, conditions, ...rest } = option;
  return {
    ...rest,
    conditions: conditions.map(({ minimumAmount: _cmin, maximumAmount: _cmax, ...condition }) => condition),
    maximumPayout: plan ? maximumCustomerPayout(plan, option) : null,
  };
}

/** Server-side lower bound of a condition's principal (was only enforced in the browser). */
function belowConditionMinimum(condition: any, amount: string): boolean {
  const min = String(condition?.min_principal ?? "0").replace(/\D/g, "") || "0";
  return BigInt(amount) < BigInt(min);
}

router.get("/loan-options", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  return res.json({ plans: customerLoanOptions(customer).map(withMaximumPayout) });
});

const customerQuoteRateLimit = createQuoteRateLimit(120, 60_000, (req) => {
  const session = req.res ? customerPortalSession(req.res) : undefined;
  return session ? `customer:${session.mobile}` : `ip:${trustedClientIp(req)}`;
});

// Calculator quote for a logged-in customer: payout + installment from the customer's own eligible option (if any),
// plus requestedAmount — the principal the apply form submits (the customer's own request amount, never a rate).
router.post("/plan-quote", customerQuoteRateLimit, (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const body = parseQuoteBody(req.body, ["planId", "months", "cash", "amount", "eligible"]);
  if (!body || body.planId == null || (body.eligible != null && body.eligible !== 1)) return jsonError(res, 400, "invalid_quote_input");
  const plan = activeQuotePlan(body.planId);
  if (!plan) return jsonError(res, 404, "loan_plan_not_found");
  const option = body.eligible === 1 ? customerLoanOptions(customer).find((item) => item.planId === plan.id) : undefined;
  if (body.eligible === 1 && !option) return jsonError(res, 404, "loan_plan_not_found");
  const q = calculatorQuote(plan, { months: body.months, cash: body.cash, amount: body.amount }, option);
  return res.json({
    months: q.months, durations: q.durations, minPayout: q.minPayout, maxPayout: q.maxPayout,
    payout: q.payout, installment: q.installment,
    requestedAmount: q.principal == null ? null : String(q.principal),
    conditionId: option && q.principal != null ? eligibleConditionId(option, String(q.principal), q.months) : null,
  });
});

// PM item 2: the browser no longer gets min/max principal, so the server picks the condition for (principal, months)
// with the same rule the portal used to run (allowed duration + min ≤ principal ≤ max). Response: ids and months only.
router.post("/loan-options/selection", customerQuoteRateLimit, (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["planId", "amount", "months"].includes(k)))
    return jsonError(res, 400, "invalid_selection_input");
  const planId = Number(body.planId), months = Number(body.months);
  const amount = String(body.amount ?? "").trim();
  if (!Number.isSafeInteger(planId) || planId <= 0 || !Number.isSafeInteger(months) || months < 0 || months > 600 ||
    !/^([1-9]\d{0,17})?$/.test(amount)) return jsonError(res, 400, "invalid_selection_input");
  const option = customerLoanOptions(customer).find((item) => item.planId === planId);
  if (!option) return jsonError(res, 404, "loan_plan_not_found");
  const conditionId = amount && months > 0 ? eligibleConditionId(option, amount, months) : null;
  const condition = option.conditions.find((item) => item.id === conditionId);
  return res.json({ planId, conditionId, durations: condition?.allowedDurations ?? option.allowedDurations });
});

router.get("/identity-documents", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  return res.json({ documents: currentIdentityDocuments(customer.id) });
});

router.get("/identity-documents/:documentId/preview", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const id = Number(req.params.documentId);
  if (!Number.isSafeInteger(id) || id <= 0) return jsonError(res, 404, "identity_document_not_found");
  const document = queryRow<{ storage_path: string; mime_type: string }>(
    `SELECT storage_path,mime_type FROM customer_identity_documents
     WHERE id=? AND customer_id=? AND is_latest=1
       AND (? IS NULL OR created_at>?)`,
    [id, customer.id, customer.identity_changed_at, customer.identity_changed_at],
  );
  if (!document || !["image/jpeg", "image/png", "application/pdf"].includes(document.mime_type))
    return jsonError(res, 404, "identity_document_not_found");
  let real: string;
  try {
    real = fs.realpathSync(document.storage_path);
    if (!real.startsWith(identityRootReal + path.sep) || !fs.statSync(real).isFile())
      return jsonError(res, 404, "identity_document_not_found");
  } catch { return jsonError(res, 404, "identity_document_not_found"); }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.type(document.mime_type);
  return res.sendFile(real);
});

router.post("/identity-documents", (req, res, next) => {
  upload.single("file")(req, res, error => {
    if (error) {
      jsonError(res, error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
        error.code === "LIMIT_FILE_SIZE" ? "identity_document_too_large" : "invalid_identity_document");
      return;
    }
    next();
  });
}, (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const rawType = String(req.body?.documentType ?? "");
  const documentType = identityTypeAliases[rawType];
  if (!documentType || !req.file || !safeUploadType(req.file)) return jsonError(res, 400, "invalid_identity_document");
  const target = uploadPath(identityRoot, req.file.originalname);
  const digest = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  try {
    fs.writeFileSync(target, req.file.buffer, { flag: "wx", mode: 0o600 });
    const documentId = runTransaction(() => {
      executeChanges(
        "UPDATE customer_identity_documents SET is_latest=0 WHERE customer_id=? AND document_type=? AND is_latest=1",
        [customer.id, documentType],
      );
      const previous = queryRow<{ version: number }>(
        "SELECT COALESCE(MAX(version),0) version FROM customer_identity_documents WHERE customer_id=? AND document_type=?",
        [customer.id, documentType],
      );
      return execute(
        `INSERT INTO customer_identity_documents(
          customer_id,document_type,storage_path,original_name,mime_type,size_bytes,sha256,
          created_by_user_id,created_by_customer_id,created_at,version,is_latest
        ) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,1)`,
        [customer.id, documentType, target, normalizedName(req.file!.originalname), req.file!.mimetype,
          req.file!.size, digest, customer.id, now(), Number(previous?.version ?? 0) + 1],
      );
    });
    const saved = queryRow<any>(
      `SELECT id,document_type,original_name,mime_type,size_bytes,approved_at,review_reason,created_at
       FROM customer_identity_documents WHERE id=? AND customer_id=?`,
      [documentId, customer.id],
    );
    return res.status(201).json(mapIdentityDocument(saved));
  } catch {
    try { fs.unlinkSync(target); } catch { /* preserve the primary persistence failure */ }
    return jsonError(res, 500, "identity_document_upload_failed");
  }
});

router.get("/credit-checks", async (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const rows = queryRows<CreditCheckRow>(
    `SELECT * FROM customer_credit_checks
     WHERE customer_id=? AND (? IS NULL OR (
       created_at>? AND (status<>'report_generated' OR completed_at>?)
     ))
     ORDER BY created_at DESC,id DESC LIMIT 20`,
    [customer.id, customer.identity_changed_at, customer.identity_changed_at, customer.identity_changed_at],
  );
  const latest = rows[0];
  if (latest && latest.status !== "report_generated" && latest.status !== "failed" && latest.provider_reference) {
    rows[0] = await refreshCreditCheck(latest);
  }
  return res.json({ checks: rows.map(creditCheckView) });
});

router.post("/credit-checks", async (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const prerequisite = profilePrerequisite(customer);
  if (prerequisite) return jsonError(res, 422, prerequisite);
  const cached=freshSuccessfulCredit(customer.id);
  if(cached)return res.json(creditCheckView(cached as CreditCheckRow));
  if (!customer.national_code || !validNationalCode(customer.national_code)) return jsonError(res, 422, "invalid_customer_national_code");
  const mobile = normalizeMobile(customer.phone);
  if (!mobile) return jsonError(res, 422, "invalid_customer_mobile");
  const current = queryRow<CreditCheckRow>(
    `SELECT * FROM customer_credit_checks WHERE customer_id=? AND status IN ('awaiting_otp','processing')
       AND (? IS NULL OR created_at>?)
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [customer.id, customer.identity_changed_at, customer.identity_changed_at],
  );
  if (current) return res.status(200).json(creditCheckView(await refreshCreditCheck(current)));
  if (creditStartInProgress.has(customer.id)) return jsonError(res, 429, "credit_check_start_in_progress");
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  if (queryRow(
    `SELECT id FROM customer_credit_checks WHERE customer_id=? AND created_at>=?
      AND (? IS NULL OR created_at>?) LIMIT 1`,
    [customer.id, cutoff, customer.identity_changed_at, customer.identity_changed_at],
  )) {
    return jsonError(res, 429, "credit_check_rate_limited");
  }
  creditStartInProgress.add(customer.id);
  try {
    const providerReference = await ics24.initiate(customer.national_code, mobile);
    const id = execute(
      `INSERT INTO customer_credit_checks(
        customer_id,requested_by_user_id,requested_by_customer_id,provider,national_code,provider_reference,status,created_at,updated_at
      ) VALUES(?,NULL,?,'ics24',?,?,'awaiting_otp',?,?)`,
      [customer.id, customer.id, customer.national_code, providerReference, now(), now()],
    );
    const row = queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=? AND customer_id=?", [id, customer.id]);
    if (!row) return jsonError(res, 500, "credit_check_create_failed");
    return res.status(201).json(creditCheckView(row));
  } catch {
    return jsonError(res, 502, "credit_check_provider_unavailable");
  } finally {
    creditStartInProgress.delete(customer.id);
  }
});

router.post("/credit-checks/:id/validate", async (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const id = Number(req.params.id);
  const rawCode = req.body?.code ?? req.body?.otp;
  const code = typeof rawCode === "string" ? normalizeDigits(rawCode).trim() : "";
  if (!Number.isSafeInteger(id) || id <= 0 || !/^\d{4,8}$/.test(code)) return jsonError(res, 400, "invalid_credit_check_otp");
  const row = queryRow<CreditCheckRow>(
    "SELECT * FROM customer_credit_checks WHERE id=? AND customer_id=?",
    [id, customer.id],
  );
  if (!row || !row.provider_reference) return jsonError(res, 404, "credit_check_not_found");
  if (row.status !== "awaiting_otp") return jsonError(res, 409, "credit_check_otp_not_expected");
  try {
    const current = await refreshCreditCheck(row);
    if (current.status === "report_generated" || current.status === "processing") return res.json(creditCheckView(current));
    if (current.status === "failed") return res.status(422).json({ error: current.error_message ?? "استعلام پایان یافته است؛ استعلام جدید بگیرید." });
    await ics24.validate(row.provider_reference, code);
    executeChanges(
      "UPDATE customer_credit_checks SET status='processing',updated_at=? WHERE id=? AND customer_id=? AND status='awaiting_otp'",
      [now(), id, customer.id],
    );
    const refreshed = await refreshCreditCheck({ ...row, status: "processing" });
    return res.json(creditCheckView(refreshed));
  } catch (error) {
    const terminal = creditProviderFailure(null, error instanceof Error ? error.message : null);
    if (terminal) {
      executeChanges("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND customer_id=? AND status IN ('awaiting_otp','processing')",
        [terminal, now(), id, customer.id]);
      return res.status(422).json({ error: terminal });
    }
    return jsonError(res, 422, "credit_check_otp_rejected");
  }
});

router.post("/credit-checks/:id/renew", async (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) && id > 0
    ? queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=? AND customer_id=?", [id, customer.id])
    : undefined;
  if (!row || !row.provider_reference) return jsonError(res, 404, "credit_check_not_found");
  if (row.status !== "awaiting_otp") return jsonError(res, 409, "credit_check_otp_not_expected");
  try {
    const current = await refreshCreditCheck(row);
    if (current.status !== "awaiting_otp") return res.json(creditCheckView(current));
    await ics24.renew(row.provider_reference);
    executeChanges("UPDATE customer_credit_checks SET updated_at=? WHERE id=? AND customer_id=?", [now(), id, customer.id]);
    return res.json(creditCheckView(queryRow<CreditCheckRow>("SELECT * FROM customer_credit_checks WHERE id=?", [id]) ?? row));
  } catch (error) {
    const terminal = creditProviderFailure(null, error instanceof Error ? error.message : null);
    if (terminal) {
      executeChanges("UPDATE customer_credit_checks SET status='failed',provider_status='RequestExpired',error_message=?,updated_at=? WHERE id=? AND customer_id=? AND status IN ('awaiting_otp','processing')",
        [terminal, now(), id, customer.id]);
      return res.status(409).json({ error: terminal });
    }
    return jsonError(res, 502, "credit_check_provider_unavailable");
  }
});

router.get("/wallet", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const summary = getWalletSummaryReadOnly(customer.id);
  return res.json({ cashBalanceToman: summary.cash.balanceToman, creditBalanceToman: summary.credit.balanceToman });
});

router.post("/wallet/top-up", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const amount = String(req.body?.amountToman ?? "");
  if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) * 10n > BigInt(Number.MAX_SAFE_INTEGER)) {
    return jsonError(res, 400, "invalid_amount_toman");
  }
  let callbackBase: URL;
  try {
    callbackBase = new URL(String(process.env.PAYMENT_CALLBACK_BASE_URL));
    if (callbackBase.protocol !== "https:" || callbackBase.search || callbackBase.hash ||
      (callbackBase.pathname !== "/" && callbackBase.pathname !== "")) throw new Error("invalid_base");
  } catch {
    return jsonError(res, 503, "payment_configuration_unavailable");
  }
  const ts = now();
  if (queryRow(
    `SELECT 1 FROM wallet_share_links s
     LEFT JOIN wallet_payment_intents i ON i.id=s.payment_intent_id
     WHERE s.customer_id=? AND s.expires_at>? AND (
       (s.payment_intent_id IS NULL AND s.status IN ('created','starting','started'))
       OR i.status IN ('created','provider_already_verified')
     ) LIMIT 1`,
    [customer.id, ts],
  )) return jsonError(res, 409, "active_top_up_exists");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  execute(
    `INSERT INTO wallet_share_links(token_hash,customer_id,amount_toman,plan_id,status,expires_at,created_at,created_by_customer_id)
     VALUES(?,?,?,NULL,'created',?,?,?)`,
    [crypto.createHash("sha256").update(token).digest("hex"), customer.id, amount, expiresAt, ts, customer.id],
  );
  const query = new URLSearchParams({ token, customerId: String(customer.id), amountToman: amount });
  return res.status(201).json({
    paymentUrl: `${callbackBase.origin}/wallet/top-up?${query}`,
    amountToman: amount,
  });
});

router.post("/filing-fee", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const planId = Number(req.body?.planId);
  const key = String(req.header("Idempotency-Key") ?? "");
  const conditionId=Number(req.body?.conditionId),duration=Number(req.body?.durationMonths);
  const amount=String(req.body?.requestedAmount??"").trim();
  if (!Number.isSafeInteger(planId) || planId <= 0 || !/^[\x20-\x7e]{8,200}$/.test(key) ||
      !Number.isSafeInteger(conditionId)||conditionId<=0||!Number.isSafeInteger(duration)||duration<=0||
      !/^[1-9]\d{0,17}$/.test(amount)||Object.keys(req.body??{}).some(k=>!["planId","conditionId","durationMonths","requestedAmount"].includes(k))) {
    return jsonError(res, 400, "invalid_filing_fee_request");
  }
  try {
    const result = runImmediateTransaction(() => {
      const previous = queryRow<any>("SELECT * FROM loan_filing_fee_charges WHERE idempotency_key=?", [key]);
      if (previous) {
        if (Number(previous.customer_id) !== customer.id || Number(previous.plan_id) !== planId) {
          throw new Error("filing_fee_idempotency_conflict");
        }
        const application = previous.application_id == null ? undefined : queryRow<{ id: number }>(
          "SELECT id FROM loan_applications WHERE id=? AND customer_id=? AND deleted_at IS NULL AND status<>'rejected'",
          [previous.application_id, customer.id],
        );
        return {
          chargeId: Number(previous.id),
          amountToman: String(previous.amount_toman),
          applicationId: application?.id ?? null,
          repeated: true,
        };
      }
      const reusable = reusableFilingFeeCharge(customer.id, planId);
      if (reusable) {
        return {
          chargeId: Number(reusable.id),
          amountToman: String(reusable.amount_toman),
          applicationId: reusable.active_application_id == null ? null : Number(reusable.active_application_id),
          repeated: true,
        };
      }
      // Mobile ownership and basic identity were checked by portal middleware.
      // Postal/Sana are intentionally after this fixed-fee-only intake charge.
      const prerequisite = profilePrerequisite(customer);
      if (prerequisite) throw new Error(prerequisite);
      const plan = payablePlan(planId);
      if (!plan) throw new Error("loan_plan_not_found");
      if (!planAcceptsCustomerCredit(planId, customer.id)) throw new Error("loan_plan_condition_not_matched");
      const condition=queryRow<any>("SELECT * FROM loan_plan_conditions WHERE id=? AND plan_id=?",[conditionId,planId]);
      const credit=freshSuccessfulCredit(customer.id);
      if(!condition||!credit||!conditionAcceptsCreditRank(credit.score_label,parseConditionRanks(condition.customer_ranks))
        ||!guarantorGradeAllows(guarantorGradeVerdict(condition,customerGuarantorGrade(customer.id).rank,plan)))
        throw new Error("loan_plan_condition_not_matched");
      const terms=effectivePlanTerms(plan,condition);
      if(terms.maximum<=0n||BigInt(amount)>terms.maximum||belowConditionMinimum(condition,amount)||!terms.durations.includes(duration))throw new Error("loan_plan_condition_not_matched");
      const feeAmount = String(plan.filing_fee_toman ?? "");
      if (!/^(0|[1-9]\d*)$/.test(feeAmount)) throw new Error("invalid_filing_fee");
      const account = wallet(customer.id, "cash");
      const company = queryRow<{ balance: string }>("SELECT balance FROM company_wallet_accounts WHERE wallet_type='cash'");
      if (!company || !/^\d+$/.test(account.balance) || !/^\d+$/.test(company.balance)) throw new Error("invalid_wallet_balance");
      if (BigInt(account.balance) < BigInt(feeAmount)) throw new Error("insufficient_cash_balance");
      const ts = now();
      const chargeId = execute(
        `INSERT INTO loan_filing_fee_charges(customer_id,plan_id,amount_toman,idempotency_key,actor_user_id,actor_customer_id,created_at)
         VALUES(?,?,?,?,NULL,?,?)`,
        [customer.id, planId, feeAmount, key, customer.id, ts],
      );
      if (BigInt(feeAmount) > 0n) {
        executeChanges(
          "UPDATE wallet_accounts_v2 SET balance=? WHERE id=?",
          [(BigInt(account.balance) - BigInt(feeAmount)).toString(), account.id],
        );
        executeChanges(
          "UPDATE company_wallet_accounts SET balance=? WHERE wallet_type='cash'",
          [(BigInt(company.balance) + BigInt(feeAmount)).toString()],
        );
        execute(
          `INSERT INTO wallet_ledger_v2(wallet_id,amount,kind,idempotency_key,actor_user_id,actor_customer_id,created_at)
           VALUES(?,?,?, ?,NULL,?,?)`,
          [account.id, feeAmount, "filing_fee_out", `filing-fee:${chargeId}:out`, customer.id, ts],
        );
        execute(
          `INSERT INTO company_wallet_ledger(wallet_type,amount_toman,kind,fee_charge_id,actor_user_id,actor_customer_id,idempotency_key,created_at)
           VALUES('cash',?,'filing_fee',?,NULL,?,?,?)`,
          [feeAmount, chargeId, customer.id, `filing-fee:${chargeId}:in`, ts],
        );
      }
      return { chargeId, amountToman: feeAmount, applicationId: null, repeated: false };
    });
    return res.status(result.repeated ? 200 : 201).json({
      chargeId: result.chargeId,
      planId,
      amountToman: result.amountToman,
      applicationId: result.applicationId,
      status: result.applicationId == null ? "charged" : "application_exists",
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["filing_fee_idempotency_conflict", "insufficient_cash_balance"].includes(code)) return jsonError(res, 409, code);
    if ([
      "customer_profile_incomplete", "customer_identity_not_verified", "credit_check_stale",
      "loan_plan_not_found", "loan_plan_condition_not_matched", "invalid_filing_fee", "invalid_wallet_balance",
    ].includes(code)) return jsonError(res, 422, code);
    return jsonError(res, 500, "filing_fee_charge_failed");
  }
});

router.use("/applications/:id",(req,res,next)=>{
  if(["GET","HEAD"].includes(req.method)){next();return;}
  const customer=portalCustomer(res);if(!customer)return;
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||!portalApplication(id,customer.id)){jsonError(res,404,"application_not_found");return;}
  jsonError(res,409,"customer_application_read_only");
});
router.get("/applications", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const rows = queryRows<{ id: number }>(
    `SELECT id FROM loan_applications WHERE customer_id=? AND deleted_at IS NULL
      ${req.query.active === "true" ? "AND status NOT IN ('rejected','cancelled','completed','closed') AND COALESCE(stage,'')<>'completed'" : ""}
      ORDER BY created_at DESC,id DESC`,
    [customer.id],
  );
  return res.json({ applications: rows.map((row) => portalApplication(Number(row.id), customer.id)).filter(Boolean) });
});

router.get("/applications/:id", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const applicationId = Number(req.params.id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) return jsonError(res, 404, "loan_application_not_found");
  const application = portalApplication(applicationId, customer.id);
  if (!application) return jsonError(res, 404, "loan_application_not_found");
  return res.json(application);
});

router.post("/applications", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const body = req.body;
  const allowed = new Set(["planId", "conditionId", "requestedAmount", "durationMonths", "feeChargeId", "notes"]);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.has(key))) return jsonError(res, 400, "invalid_application_input");
  const planId = Number(body.planId), conditionId = Number(body.conditionId), feeChargeId = Number(body.feeChargeId);
  const amount = String(body.requestedAmount ?? "").trim();
  const duration = Number(body.durationMonths);
  if (!Number.isSafeInteger(planId) || planId <= 0 || !Number.isSafeInteger(conditionId) || conditionId <= 0 ||
    !Number.isSafeInteger(feeChargeId) || feeChargeId <= 0 || !/^[1-9]\d{0,17}$/.test(amount) ||
    !Number.isSafeInteger(duration) || duration < 1 || duration > 600) return jsonError(res, 400, "invalid_application_input");
  const charge = queryRow<any>(
    "SELECT * FROM loan_filing_fee_charges WHERE id=? AND customer_id=? AND plan_id=?",
    [feeChargeId, customer.id, planId],
  );
  if (!charge) return jsonError(res, 422, "filing_fee_required");
  if (charge.application_id) {
    const existing = portalApplication(Number(charge.application_id), customer.id);
    return existing ? res.status(200).json(existing) : jsonError(res, 409, "filing_fee_already_used");
  }
  const prerequisite = filingFeePrerequisiteError(customer);
  if (prerequisite) return jsonError(res, 422, prerequisite);
  const credit = freshSuccessfulCredit(customer.id);
  if (!credit) return jsonError(res, 422, "credit_check_stale");
  if (!hasFreshIdentityDocuments(customer.id)||!portalDocumentsState(customer.id,charge.created_at).documentsComplete) return jsonError(res, 422, "identity_documents_missing");
  const plan = payablePlan(planId);
  if (!plan) return jsonError(res, 422, "loan_plan_not_found");
  const condition = queryRow<any>("SELECT * FROM loan_plan_conditions WHERE id=? AND plan_id=?", [conditionId, planId]);
  if (!condition) return jsonError(res, 422, "loan_plan_condition_not_found");
  const ranks = parseConditionRanks(condition.customer_ranks);
  if (!conditionAcceptsCreditRank(credit.score_label, ranks)) return jsonError(res, 422, "loan_plan_condition_not_matched");
  if (!guarantorGradeAllows(guarantorGradeVerdict(condition, customerGuarantorGrade(customer.id).rank, plan)))
    return jsonError(res, 422, "loan_plan_condition_not_matched");
  if (!rowAllowsProfile(condition, latestApplicantProfile(customer.id))) return jsonError(res, 422, "loan_plan_condition_not_matched");
  const terms = effectivePlanTerms(plan, condition);
  if (terms.maximum <= 0n || BigInt(amount) > terms.maximum || belowConditionMinimum(condition, amount) || !terms.durations.includes(duration)) {
    return jsonError(res, 422, "loan_plan_condition_not_matched");
  }
  const notes = body.notes === undefined ? null : body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.trim().length > 2000)) return jsonError(res, 400, "invalid_application_notes");
  const ts = now();
  try {
    const applicationId = runTransaction(() => {
      const currentCharge = queryRow<{ application_id: number | null }>(
        "SELECT application_id FROM loan_filing_fee_charges WHERE id=? AND customer_id=? AND plan_id=?",
        [charge.id, customer.id, planId],
      );
      if (currentCharge?.application_id) return Number(currentCharge.application_id);
      const consultationId = execute(
        "INSERT INTO consultation_forms(customer_id,requested_amount,extra_notes,updated_at) VALUES(?,?,?,?)",
        [customer.id, amount, notes, ts],
      );
      const salesperson = customer.salesperson_id == null
        ? null
        : queryRow<{ name: string }>("SELECT name FROM salespersons WHERE id=?", [customer.salesperson_id]);
      const requirements = (() => {
        try {
          return (JSON.parse(plan.required_documents || "[]") as unknown[])
            .filter((key) => !separateRequirementKeys.has(String(key)));
        } catch { return []; }
      })();
      const id = execute(
        `INSERT INTO loan_applications(
          consultation_id,customer_id,requested_by_user_id,requested_by_customer_id,plan_ids,plan_id,
          requested_amount,duration_months,requested_duration_months,stage,status,plan_snapshot_json,
          condition_snapshot_json,document_requirements_snapshot_json,primary_manual_values_json,notes,
          is_pre_registration,salesperson_id_snapshot,salesperson_name_snapshot,new_case_workflow,created_at,updated_at
        ) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,1,?,?)`,
        [
          consultationId, customer.id, customer.id, JSON.stringify([planId]), planId, amount, duration,
          duration, "draft", "requested", JSON.stringify(plan), JSON.stringify(condition),
          JSON.stringify(requirements.map((key) => ({ key: String(key), label: documentLabel(String(key)) }))),
          "{}", notes?.trim?.() || null, customer.salesperson_id ?? null,
          salesperson?.name ?? null, ts, ts,
        ],
      );
      for (const item of requirements) {
        execute(
          "INSERT INTO loan_application_documents(application_id,requirement_key,label,source,created_by_customer_id,created_at) VALUES(?,?,?,?,?,?)",
          [id, String(item), documentLabel(String(item)), "plan", customer.id, ts],
        );
      }
      execute(
        `INSERT INTO loan_application_stage_history(application_id,to_stage,action,reason,actor_id,actor_customer_id,created_at)
         VALUES(?,?,?,?,NULL,?,?)`,
        [id, "draft", "customer_portal_created",
          JSON.stringify({ actorType: "customer", customerId: customer.id }), customer.id, ts],
      );
      const changed = executeChanges(
        "UPDATE loan_filing_fee_charges SET application_id=? WHERE id=? AND customer_id=? AND application_id IS NULL",
        [id, charge.id, customer.id],
      );
      if (changed !== 1) throw new Error("filing_fee_already_used");
      return id;
    });
    const application = portalApplication(applicationId, customer.id);
    if (!application) return jsonError(res, 500, "loan_application_create_failed");
    return res.status(201).json(application);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "filing_fee_already_used") return jsonError(res, 409, code);
    return jsonError(res, 500, "loan_application_create_failed");
  }
});

router.patch("/applications/:id", (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const id = Number(req.params.id);
  const application = Number.isSafeInteger(id) && id > 0
    ? queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND customer_id=? AND deleted_at IS NULL", [id, customer.id])
    : undefined;
  if (!application) return jsonError(res, 404, "loan_application_not_found");
  if (application.stage !== "draft" || application.status === "rejected") {
    return jsonError(res, 409, "application_not_editable");
  }
  if (application.initial_approval_at || application.current_primary_generation_id != null ||
      activeContractExists(id) || hasSignedPrimaryContract(id)) {
    return jsonError(res, 409, "approved_application_terms_immutable");
  }
  const body = req.body;
  const allowed = new Set(["requestedAmount", "durationMonths", "manualValues", "notes"]);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !allowed.has(key))) return jsonError(res, 400, "invalid_application_input");
  const amount = body.requestedAmount === undefined ? String(application.requested_amount) : String(body.requestedAmount).trim();
  const duration = body.durationMonths === undefined
    ? Number(application.requested_duration_months ?? application.duration_months)
    : Number(body.durationMonths);
  if (!/^[1-9]\d{0,17}$/.test(amount) || !Number.isSafeInteger(duration) || duration < 1 || duration > 600) {
    return jsonError(res, 400, "invalid_application_input");
  }
  const plan = parseJson<any>(application.plan_snapshot_json);
  const condition = parseJson<any>(application.condition_snapshot_json);
  const credit = freshSuccessfulCredit(customer.id);
  const ranks = parseConditionRanks(condition?.customer_ranks);
  const terms = effectivePlanTerms(plan, condition);
  if (!condition || (condition.credit_rank_ignored !== true && (!credit || !conditionAcceptsCreditRank(credit.score_label, ranks))) ||
    terms.maximum <= 0n || BigInt(amount) > terms.maximum || !terms.durations.includes(duration)) {
    return jsonError(res, 422, "application_terms_not_eligible");
  }
  const templateId = Number(plan?.contract_template_id ?? plan?.primary_contract_template_id);
  const manualInput = body.manualValues === undefined
    ? { values: parseJson<Record<string, string>>(application.primary_manual_values_json) ?? {} }
    : validatedPrimaryManualValues(templateId, body.manualValues);
  if (manualInput.error || !manualInput.values) {
    return res.status(422).json({
      error: manualInput.error ?? "invalid_manual_values",
      code: manualInput.error ?? "invalid_manual_values",
      ...(manualInput.fieldErrors ? { fieldErrors: manualInput.fieldErrors } : {}),
    });
  }
  const notes = body.notes === undefined ? application.notes ?? null : body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.trim().length > 2000)) return jsonError(res, 400, "invalid_application_notes");
  const ts = now();
  try {
    runTransaction(() => {
      const changed = executeChanges(
        `UPDATE loan_applications SET requested_amount=?,duration_months=?,requested_duration_months=?,
           primary_manual_values_json=?,notes=?,updated_at=?
         WHERE id=? AND customer_id=? AND stage=? AND initial_approval_at IS NULL
           AND current_primary_generation_id IS NULL AND status<>'rejected'`,
        [amount, duration, duration, JSON.stringify(manualInput.values), notes?.trim?.() || null,
          ts, id, customer.id, application.stage],
      );
      if (changed !== 1 || activeContractExists(id) || hasSignedPrimaryContract(id))
        throw new Error("application_not_editable");
      executeChanges("UPDATE consultation_forms SET requested_amount=?,extra_notes=?,updated_at=? WHERE id=?",
        [amount, notes?.trim?.() || null, ts, application.consultation_id]);
      execute(
        `INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,actor_customer_id,created_at)
         VALUES(?,?,?,?,?,NULL,?,?)`,
        [id, application.stage, application.stage, "customer_portal_edited_before_provider_approval",
          JSON.stringify({ actorType: "customer", customerId: customer.id, amount, durationMonths: duration }),
          customer.id, ts],
      );
    });
  } catch {
    return jsonError(res, 409, "application_not_editable");
  }
  const result = portalApplication(id, customer.id);
  return result ? res.json(result) : jsonError(res, 404, "loan_application_not_found");
});

router.post("/applications/:id/documents", upload.single("file"), (req, res) => {
  const customer = portalCustomer(res); if (!customer) return;
  const id = Number(req.params.id);
  const application = Number.isSafeInteger(id) && id > 0
    ? queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND customer_id=? AND deleted_at IS NULL", [id, customer.id])
    : undefined;
  if (!application) return jsonError(res, 404, "loan_application_not_found");
  if (!["customer_documents_upload", "funder_documents_correction"].includes(application.stage)) {
    return jsonError(res, 409, "document_upload_stage_required");
  }
  const requirementKey = String(req.body?.requirementKey ?? "");
  if (!req.file || !safeUploadType(req.file) || !requirementKey || separateRequirementKeys.has(requirementKey)) {
    return jsonError(res, 400, "invalid_application_document");
  }
  const document = queryRow<{ id: number }>(
    `SELECT id FROM loan_application_documents
     WHERE application_id=? AND requirement_key=? AND source IN ('plan','manual')
     AND requirement_key NOT IN ('guarantee_check','guarantee_promissory')`,
    [id, requirementKey],
  );
  if (!document) return jsonError(res, 404, "application_document_requirement_not_found");
  const target = uploadPath(applicationRoot, req.file.originalname);
  try {
    fs.writeFileSync(target, req.file.buffer, { flag: "wx", mode: 0o600 });
    runTransaction(() => {
      const changed = executeChanges(
        `UPDATE loan_application_documents SET status='uploaded',storage_path=?,original_name=?,mime_type=?,
           size_bytes=?,incomplete_reason=NULL,reviewed_at=NULL,created_by_customer_id=?
         WHERE id=? AND application_id=? AND EXISTS(
           SELECT 1 FROM loan_applications a WHERE a.id=? AND a.customer_id=? AND a.stage=?
         )`,
        [target, normalizedName(req.file!.originalname), req.file!.mimetype, req.file!.size,
          customer.id, document.id, id, id, customer.id, application.stage],
      );
      if (changed !== 1) throw new Error("document_upload_stage_required");
      execute(
        `INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,actor_customer_id,created_at)
         VALUES(?,?,?,?,?,NULL,?,?)`,
        [id, application.stage, application.stage, `customer_document_uploaded:${document.id}`,
          JSON.stringify({ actorType: "customer", customerId: customer.id, documentId: document.id }), customer.id, now()],
      );
    });
    const current = portalApplication(id, customer.id);
    const uploaded = current?.documents?.find((item) => item.id === Number(document.id));
    return uploaded ? res.status(201).json(uploaded) : jsonError(res, 500, "application_document_upload_failed");
  } catch {
    try { fs.unlinkSync(target); } catch { /* preserve the primary persistence failure */ }
    return jsonError(res, 409, "document_upload_stage_required");
  }
});

export default router;
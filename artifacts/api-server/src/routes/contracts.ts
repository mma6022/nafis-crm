import { Router, type Request, type Response } from "express";
import { isCertificatePreflightRetry, isInterruptedDeliveryRetry } from "../lib/contract-preflight-retry";
import { emzameProviderId as providerId } from "../lib/emzame-response";
import multer from "multer";
import JSZip from "jszip";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import yauzl from "yauzl";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { classifyProviderState, isStrictSignedProviderState, providerContractState } from "../lib/emzame-signature";
import { groupContractNumber, isContractMoneyMapping, ungroupContractNumber } from "../lib/contract-number-format";
import { emzameAuth, emzameRequest } from "../lib/emzame-client";
import { rejectedDeliveryReusesFile } from "../lib/rejected-contract-resend";
import { propagateContractTemplateChange, registerContractHandlers } from "../lib/contract-template-updates";
import { appendApprovedInstallments, canRebuildUnsentInstallments } from "../lib/approved-contract-installments";
import {
  isAttestedTomanTemplate,
  renderedPdfContainsInstallmentCount,
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
import { applyGeneratedDocumentSignatureObservation } from "./loan-applications";
import { crmDb, databasePath, execute, queryRow, queryRows, runImmediateTransaction } from "../lib/crm-db";

const router = Router();
const root = path.resolve(process.env.CONTRACTS_STORAGE_DIR || path.join(path.dirname(databasePath), "contracts"));
const analysisDir = path.join(root, "analyses");
const templateDir = path.join(root, "templates");
const generationDir = path.join(root, "generations");
for (const dir of [root, analysisDir, templateDir, generationDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const MAX_DOCX = 20 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED = 80 * 1024 * 1024;
const MAX_ENTRY = 50 * 1024 * 1024;
const MAX_RATIO = 200;
const placeholderPattern = () => /%%([A-Za-z][A-Za-z0-9_.-]*)%%|%([A-Za-z][A-Za-z0-9_.-]*)%/g;
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function normalizeTemplatePercentDelimiters(xml: string, variables: string[]): string {
  let normalized = xml.replaceAll("%%", "%");
  const markers: Array<{ open: string; close: string }> = [];
  for (const [index, variable] of [...new Set(variables)].entries()) {
    const open = `__NAFIS_CONTRACT_OPEN_${index}__`;
    const close = `__NAFIS_CONTRACT_CLOSE_${index}__`;
    const gap = "(?:<[^>]+>)*";
    const pattern = new RegExp([...`%${variable}%`].map(regexEscape).join(gap), "g");
    normalized = normalized.replace(pattern, (match) => {
      const first = match.indexOf("%");
      const last = match.lastIndexOf("%");
      return `${match.slice(0, first)}${open}${match.slice(first + 1, last)}${close}${match.slice(last + 1)}`;
    });
    markers.push({ open, close });
  }
  normalized = normalized.replaceAll("%", "&#37;");
  for (const marker of markers) {
    normalized = normalized.replaceAll(marker.open, "%").replaceAll(marker.close, "%");
  }
  return normalized;
}
const conversionQueue: Array<{ input: string; resolve: (path: string) => void; reject: (error: Error) => void }> = [];
const activeConversionPids = new Set<number>();
let activeConversions = 0;
const pumpConversions = () => {
  while (activeConversions < 2 && conversionQueue.length) {
    const job = conversionQueue.shift()!; activeConversions++;
    runConversion(job.input).then(job.resolve, job.reject).finally(() => { activeConversions--; pumpConversions(); });
  }
};
for (const file of fs.readdirSync(analysisDir)) {
  const full = path.join(analysisDir, file);
  try { if (Date.now() - fs.statSync(full).mtimeMs > 30 * 60_000) fs.rmSync(full, { force: true }); } catch { /* stale cleanup is best effort */ }
}
const sending = new Set<number>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCX, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.originalname.toLowerCase().endsWith(".docx")),
});
const now = () => new Date().toISOString();
const sha = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const tokenHash = (token: string) => sha(Buffer.from(token));
function cleanupAnalyses(): void {
  const expired = queryRows<{ staged_path: string }>("SELECT staged_path FROM contract_template_analyses WHERE expires_at < ? AND consumed_at IS NULL", [now()]);
  for (const row of expired) { try { fs.rmSync(row.staged_path, { force: true }); } catch { /* cleanup is best effort */ } }
  execute("DELETE FROM contract_template_analyses WHERE expires_at < ? OR consumed_at IS NOT NULL", [now()]);
}
const analysisCleanup = setInterval(cleanupAnalyses, 30 * 60_000);
analysisCleanup.unref();
function reconcileGenerations(): void {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  crmDb.prepare("UPDATE contract_generations SET status='failed',error_message='stale_job',updated_at=? WHERE status='processing' AND updated_at < ?").run(now(), cutoff);
  crmDb.prepare("UPDATE contract_generations SET status='failed',error_message='stale_send',send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE status='sending' AND send_claim_expires_at < ?").run(now(), now());
}
reconcileGenerations();
const safePath = (file: string) => {
  const absolute = path.resolve(file);
  return path.relative(root, absolute).startsWith("..") || path.isAbsolute(path.relative(root, absolute)) ? null : absolute;
};
function regularPath(file: string, expectedDir?: string): string {
  const safe = safePath(file);
  if (!safe) throw new Error("Unsafe storage path");
  if (expectedDir && path.dirname(safe) !== path.join(root, expectedDir)) throw new Error("Invalid artifact directory");
  if (!/^[a-f0-9-]{20,}\.(docx|pdf)$/i.test(path.basename(safe))) throw new Error("Invalid artifact filename");
  const stat = fs.lstatSync(safe);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Stored artifact is not a regular file");
  return safe;
}
function json<T>(value: unknown, fallback: T): T { try { return JSON.parse(String(value)); } catch { return fallback; } }
function normalizeNumber(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[٬،]/g, "")
    .replace(/٫/g, ".")
    .replace(/,/g, "")
    .trim();
}
type FormulaToken =
  | { type: "field"; field: string }
  | { type: "literal"; value: string | number }
  | { type: "operator"; value: "+" | "-" | "*" | "/" };
type ContractMappingInput = {
  variable: string;
  sourceType?: "customer" | "loanPlan" | "manual" | "constant" | "formula" | "date" | "contractNumber";
  customerField?: string | null;
  loanPlanField?: string | null;
  label?: string;
  constantValue?: string | null;
  formula?: { tokens: FormulaToken[] } | null;
  date?: { mode: "contract_date" | "contract_date_plus_days"; offsetDays?: number } | null;
};
function normalizeMappings(variables: string[], mappings: unknown): ContractMappingInput[] | null {
  if (!Array.isArray(mappings) || mappings.length !== variables.length) return null;
  const typed = mappings as ContractMappingInput[];
  if (new Set(typed.map((mapping) => mapping.variable)).size !== typed.length) return null;
  const normalized = typed.map((mapping) => ({
    variable: String(mapping.variable || ""),
    sourceType: mapping.sourceType,
    customerField: mapping.customerField ?? null,
    loanPlanField: mapping.loanPlanField ?? null,
    label: mapping.label?.trim() || mapping.variable,
    constantValue: mapping.constantValue ?? null,
    formula: mapping.formula ?? null,
    date: mapping.date ?? null,
  }));
  const provided = new Map(normalized.map((mapping) => [mapping.variable, mapping]));
  if (variables.some((variable) => !provided.has(variable))) return null;
  if ([...provided.keys()].some((variable) => !variables.includes(variable))) return null;
  for (const mapping of normalized) {
    const inferred = mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
    if (!["customer", "loanPlan", "manual", "constant", "formula", "date", "contractNumber"].includes(inferred)) return null;
    mapping.sourceType = inferred as ContractMappingInput["sourceType"];
    if (inferred === "customer" && (!mapping.customerField || !fields[mapping.customerField] || mapping.loanPlanField)) return null;
    if (inferred === "loanPlan" && (!mapping.loanPlanField || !loanPlanFields[mapping.loanPlanField] || mapping.customerField)) return null;
    if (inferred === "manual" && (!mapping.label?.trim() || mapping.customerField || mapping.loanPlanField || mapping.constantValue || mapping.formula || mapping.date)) return null;
    if (inferred === "constant" && (typeof mapping.constantValue !== "string" || mapping.constantValue.length > 5000 ||
      mapping.customerField || mapping.loanPlanField || mapping.formula || mapping.date)) return null;
    if (inferred === "formula") {
      if (mapping.customerField || mapping.loanPlanField || mapping.constantValue || mapping.date) return null;
      const tokens = mapping.formula?.tokens;
      if (!Array.isArray(tokens) || tokens.length < 3 || tokens.length > 31 || tokens.length % 2 === 0) return null;
      if (tokens.some((token, index) => {
        if (index % 2 === 0) {
          if (token?.type === "literal") return !Number.isFinite(Number(normalizeNumber(String(token.value))));
          return token?.type !== "field" || (!fields[token.field] && !loanPlanFields[token.field]);
        }
        return token?.type !== "operator" || !["+", "-", "*", "/"].includes(token.value);
      })) return null;
    }
    if (inferred === "date") {
      if (mapping.customerField || mapping.loanPlanField || mapping.constantValue || mapping.formula) return null;
      if (!mapping.date || !["contract_date", "contract_date_plus_days"].includes(mapping.date.mode)) return null;
      if (mapping.date.mode === "contract_date_plus_days" &&
        (!Number.isInteger(mapping.date.offsetDays) || Math.abs(Number(mapping.date.offsetDays)) > 36500)) return null;
    }
    if (inferred === "contractNumber" && (mapping.customerField || mapping.loanPlanField || mapping.constantValue || mapping.formula || mapping.date)) return null;
  }
  return normalized;
}
function templateResponse(row: any) {
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    variables: json(row.variables_json, []),
    mappings: json(row.mappings_json, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    downloadUrl: `/api/contracts/templates/${row.id}/download`,
  };
}
function user(req: Request, res: Response) { return res.locals.authUser as AuthUser; }
const survivorSalespersonId = (customerId: string) => `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
  SELECT id,merged_into_customer_id FROM customers WHERE id=${customerId}
  UNION ALL SELECT target.id,target.merged_into_customer_id
    FROM customer_chain previous
    JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
      AND audit.survivor_customer_id=previous.merged_into_customer_id
    JOIN customers target ON target.id=audit.survivor_customer_id
)
SELECT survivor.salesperson_id FROM customer_chain
JOIN customers survivor ON survivor.id=customer_chain.id
WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;
const survivorSalespersonName = (customerId: string) => `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
  SELECT id,merged_into_customer_id FROM customers WHERE id=${customerId}
  UNION ALL SELECT target.id,target.merged_into_customer_id
    FROM customer_chain previous
    JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
      AND audit.survivor_customer_id=previous.merged_into_customer_id
    JOIN customers target ON target.id=audit.survivor_customer_id
)
SELECT salesperson.name FROM customer_chain
JOIN customers survivor ON survivor.id=customer_chain.id
LEFT JOIN salespersons salesperson ON salesperson.id=survivor.salesperson_id
WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;
const survivorCustomerName = (customerId: string) => `(WITH RECURSIVE customer_chain(id,merged_into_customer_id) AS (
  SELECT id,merged_into_customer_id FROM customers WHERE id=${customerId}
  UNION ALL SELECT target.id,target.merged_into_customer_id
    FROM customer_chain previous
    JOIN customer_merge_audit audit ON audit.source_customer_id=previous.id
      AND audit.survivor_customer_id=previous.merged_into_customer_id
    JOIN customers target ON target.id=audit.survivor_customer_id
)
SELECT survivor.name FROM customer_chain
JOIN customers survivor ON survivor.id=customer_chain.id
WHERE customer_chain.merged_into_customer_id IS NULL LIMIT 1)`;
function canCustomer(auth: AuthUser, customerId: number): boolean {
  if (auth.customerScope !== "assigned") return true;
  const owner = queryRow<{ salesperson_id: number | null }>(
    `SELECT ${survivorSalespersonId("?")} salesperson_id`,
    [customerId],
  );
  return owner?.salesperson_id != null && owner.salesperson_id === auth.salespersonId;
}
function customer(id: number) {
  return queryRow<Record<string, unknown>>(
    `SELECT c.*, s.name salesperson_name FROM customers c LEFT JOIN salespersons s ON s.id=c.salesperson_id WHERE c.id=? AND c.merged_into_customer_id IS NULL`, [id],
  );
}
const fields: Record<string, string> = {
  "customer.id": "شناسه مشتری", "customer.name": "نام کامل مشتری", "customer.firstName": "نام مشتری",
  "customer.lastName": "نام خانوادگی مشتری", "customer.phone": "تلفن",
  "customer.nationalCode": "کد ملی", "customer.postalCode": "کد پستی", "customer.birthDateJalali": "تاریخ تولد",
  "customer.fatherName": "نام پدر", "customer.address": "نشانی", "customer.email": "ایمیل",
  "customer.shahkarStatus": "نتیجه شاهکار", "customer.sanaStatus": "نتیجه ثنا", "customer.verificationCheckedAt": "تاریخ احراز",
  "customer.creditScore": "امتیاز اعتبار", "customer.creditRank": "رتبه اعتبار", "customer.creditCheckedAt": "تاریخ بررسی اعتبار",
  "customer.verificationStatus": "وضعیت احراز", "customer.isUrgent": "فوری", "customer.salespersonName": "کارشناس فروش",
  "customer.createdAt": "تاریخ ایجاد", "current.dateJalali": "تاریخ جاری",
};
const loanPlanFields: Record<string, string> = {
  "loanPlan.id": "شناسه طرح",
  "loanPlan.name": "نام طرح",
  "loanPlan.bankName": "نام بانک",
  "loanPlan.platformName": "نام پلتفرم",
  "loanPlan.principalAmount": "مبلغ اصل تسهیلات",
  "loanPlan.annualInterest": "نرخ سود سالانه",
  "loanPlan.installments": "تعداد/شرح اقساط",
  "loanPlan.durationMonths": "مدت بازپرداخت (ماه)",
  "loanPlan.deductPercents": "درصد کسورات",
  "loanPlan.customerRanks": "رتبه‌های اعتباری مجاز",
  "loanPlan.customerCheck": "شرط چک مشتری",
  "loanPlan.processMode": "روش فرایند",
  "loanPlan.loanType": "نوع تسهیلات",
  "loanPlan.grantDays": "مدت زمان پرداخت",
  "loanPlan.prepaymentPercents": "درصد پیش‌پرداخت",
  "loanPlan.depositPercents": "درصد واریز به مشتری",
  "loanPlan.platformCompanyName": "نام شرکت پلتفرم",
  "loanPlan.goodsStoreName": "نام فروشگاه خریدار کالا",
  "loanPlan.commissionPercent": "درصد حق‌العمل",
  "loanPlan.operationCostsPercent": "درصد هزینه‌های عملیات",
  "loanPlan.grantedDiscountPercent": "درصد تخفیف اعطایی",
  "loanPlan.customerPayoutPercent": "درصد واریز به مشتری",
  "loanPlan.purchaseCommissionPercent": "درصد حق‌العمل خرید",
  "loanPlan.salesCommissionPercent": "درصد حق‌العمل فروش",
  "loanPlan.loanAcquisitionFeePercent": "درصد کارمزد اخذ وام",
  "loanPlan.penaltyValue": "مبلغ/درصد وجه التزام",
  "loanPlan.contractDurationDays": "مدت قرارداد به روز",
  "loanPlan.notes": "توضیحات طرح",
};
function fieldValue(c: Record<string, unknown>, key: string): string {
  if (key === "current.dateJalali") return new Intl.DateTimeFormat("fa-IR-u-ca-persian").format(new Date());
  const map: Record<string, string> = { id: "id", name: "name", firstName: "first_name", lastName: "last_name", phone: "phone", nationalCode: "national_code", postalCode: "postal_code", birthDateJalali: "birth_date_jalali", fatherName: "father_name", address: "address", email: "email", shahkarStatus: "shahkar_status", sanaStatus: "sana_status", verificationCheckedAt: "verification_checked_at", creditScore: "credit_score", creditRank: "credit_rank", creditCheckedAt: "credit_checked_at", verificationStatus: "verification_status", isUrgent: "is_urgent", salespersonName: "salesperson_name", createdAt: "created_at" };
  const value = c[map[key.replace("customer.", "")] || key];
  return value == null ? "" : String(value);
}
export function loanPlanFieldValue(plan: Record<string, unknown>, key: string, durationMonths?: number): string {
  if (key === "loanPlan.customerPayoutPercent") {
    // A goods acknowledgement must use the settled purchase's percentage,
    // not a plan percentage that may have changed since that purchase.
    const bps = plan._goods_customer_payout_bps !== undefined
      ? plan._goods_customer_payout_bps
      : queryRow<{ customer_payout_bps: number }>(
        "SELECT customer_payout_bps FROM goods_plan_settings WHERE plan_id=?", [Number(plan.id)],
      )?.customer_payout_bps;
    if (typeof bps !== "number" || !Number.isSafeInteger(bps) || bps < 0 || bps > 10000) {
      throw new Error("formula_value_invalid");
    }
    return String(bps / 100);
  }
  if (key === "loanPlan.principalAmount" && plan._approved_principal_amount != null) return String(plan._approved_principal_amount);
  if (["loanPlan.durationMonths", "loanPlan.installments"].includes(key) && plan._approved_duration_months != null) return String(plan._approved_duration_months);
  const map: Record<string, string> = {
    id: "id", name: "name", bankName: "bank_name", platformName: "platform_name", durationMonths: "duration_months",
    principalAmount: "principal_amount", annualInterest: "annual_interest",
    installments: "installments", deductPercents: "deduct_percents",
    customerRanks: "customer_ranks", customerCheck: "customer_check",
    processMode: "process_mode", loanType: "loan_type", grantDays: "grant_days",
    prepaymentPercents: "prepayment_percents", depositPercents: "deposit_percents", notes: "notes",
    platformCompanyName: "platform_company_name", goodsStoreName: "goods_store_name",
    commissionPercent: "commission_percent", operationCostsPercent: "operation_costs_percent",
    grantedDiscountPercent: "granted_discount_percent", purchaseCommissionPercent: "purchase_commission_percent",
    salesCommissionPercent: "sales_commission_percent", loanAcquisitionFeePercent: "loan_acquisition_fee_percent",
    penaltyValue: "penalty_value", contractDurationDays: "contract_duration_days",
  };
  const value = plan[map[key.replace("loanPlan.", "")] || key];
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const options = JSON.parse(value) as Record<string, unknown>;
      if (durationMonths && options[String(durationMonths)] != null) return String(options[String(durationMonths)]);
      const available = Object.values(options).filter((item) => item != null && String(item).trim());
      if (available.length === 1) return String(available[0]);
    } catch { /* legacy scalar text is returned below */ }
  }
  return value == null ? "" : String(value);
}
function contractDateValue(offsetDays = 0): string {
  const date = new Date();
  const tehran = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const year = Number(tehran.find((part) => part.type === "year")?.value);
  const month = Number(tehran.find((part) => part.type === "month")?.value);
  const day = Number(tehran.find((part) => part.type === "day")?.value);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(shifted);
}
function currentContractPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value?.padStart(2, "0");
  if (!year || !month) throw new Error("contract_number_date_failed");
  return `${year}${month}`;
}
function allocateContractNumber(): string {
  const period = currentContractPeriod();
  crmDb.exec("BEGIN IMMEDIATE");
  try {
    const row = queryRow<{ next_value: number }>("SELECT next_value FROM contract_number_sequences WHERE period=?", [period]);
    const sequence = row?.next_value ?? 1001;
    execute(`INSERT INTO contract_number_sequences(period,next_value,updated_at) VALUES(?,?,?)
      ON CONFLICT(period) DO UPDATE SET next_value=excluded.next_value,updated_at=excluded.updated_at`, [period, sequence + 1, now()]);
    crmDb.exec("COMMIT");
    return `${period}${sequence}`;
  } catch (error) {
    crmDb.exec("ROLLBACK");
    throw error;
  }
}
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("فرمول مقدار عددی معتبر تولید نکرد.");
  return Number(value.toFixed(10)).toString();
}
function shouldGroupContractValue(mapping: ContractMappingInput, plan?: Record<string, unknown>): boolean {
  return isContractMoneyMapping(mapping, plan);
}
export function evaluateFormulaTokens(
  formula: { tokens: FormulaToken[] },
  customerRow: Record<string, unknown>,
  plan: Record<string, unknown>,
  durationMonths?: number,
): string {
  const values = formula.tokens.map((token) => {
    if (token.type === "literal") {
      const value = Number(normalizeNumber(String(token.value)));
      if (!Number.isFinite(value)) throw new Error("عدد ثابت فرمول معتبر نیست.");
      return value;
    }
    if (token.type === "field") {
      const raw = fields[token.field] ? fieldValue(customerRow, token.field) : loanPlanFieldValue(plan, token.field, durationMonths);
      const value = Number(normalizeNumber(raw));
      if (!Number.isFinite(value)) throw new Error(`مقدار متغیر ${token.field} عددی نیست.`);
      return value;
    }
    return token.value;
  });
  const operands: number[] = [values[0] as number];
  const operators: string[] = [];
  const precedence = (operator: string) => operator === "*" || operator === "/" ? 2 : 1;
  const apply = () => {
    const operator = operators.pop()!;
    const right = operands.pop()!;
    const left = operands.pop()!;
    if (operator === "/" && right === 0) throw new Error("تقسیم بر صفر در فرمول مجاز نیست.");
    operands.push(operator === "+" ? left + right : operator === "-" ? left - right : operator === "*" ? left * right : left / right);
  };
  for (let index = 1; index < values.length; index += 2) {
    const operator = values[index] as string;
    while (operators.length && precedence(operators[operators.length - 1]) >= precedence(operator)) apply();
    operators.push(operator);
    operands.push(values[index + 1] as number);
  }
  while (operators.length) apply();
  return formatNumber(operands[0]);
}
const formulaValue = evaluateFormulaTokens;
const decodeXml = (value: string) => value
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#([0-9]+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const storyText = (xml: string) => decodeXml(xml.replace(/<[^>]*>/g, ""));
function validateZip(data: Buffer): Promise<void> {
  if (data.length > MAX_DOCX || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return Promise.reject(new Error("Invalid DOCX ZIP"));
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("Invalid DOCX ZIP"));
      const names = new Set<string>(); let total = 0; let count = 0; let done = false;
      const fail = (message: string) => { if (done) return; done = true; try { zip.close(); } catch { /* closed */ } reject(new Error(message)); };
      zip.readEntry();
      zip.on("entry", (entry) => {
        count++; const name = entry.fileName; const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
        const isDirectory = name.endsWith("/") || (entry.externalFileAttributes & 0x10) !== 0;
        if (count > MAX_ENTRIES || names.has(name) || !name || name.includes("\\") || path.posix.isAbsolute(name) ||
          normalized !== name || normalized === ".." || normalized.startsWith("../") || unixType === 0o120000 ||
          (isDirectory && !name.endsWith("/"))) return fail("Unsafe DOCX ZIP entry");
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) return fail("Encrypted DOCX is not supported");
        const size = Number(entry.uncompressedSize); const compressed = Number(entry.compressedSize);
        if (isDirectory && (size !== 0 || compressed !== 0)) return fail("Unsafe DOCX ZIP entry");
        if (!Number.isSafeInteger(size) || size > MAX_ENTRY || (compressed === 0 ? size > 0 : size / compressed > MAX_RATIO))
          return fail("DOCX compression limits exceeded");
        total += size; if (total > MAX_UNCOMPRESSED) return fail("DOCX uncompressed size limit exceeded");
        names.add(name); zip.readEntry();
      });
      zip.on("end", () => { if (!done) { done = true; resolve(); } });
      zip.on("error", () => fail("Malformed DOCX ZIP"));
    });
  });
}
async function xmlEntries(data: Buffer) {
  await validateZip(data);
  if (data.length > MAX_DOCX || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("Invalid DOCX ZIP");
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new Error("DOCX contains too many ZIP entries");
  let total = 0;
  for (const name of names) {
    const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized !== name.replaceAll("\\", "/")) throw new Error("Unsafe DOCX ZIP entry");
    if (zip.files[name].dir) {
      if (!name.endsWith("/")) throw new Error("Unsafe DOCX ZIP entry");
      continue;
    }
    const entry = zip.files[name] as any;
    const size = Number(entry.uncompressedSize ?? 0);
    const compressed = Number(entry.compressedSize ?? 0);
    if (size > MAX_ENTRY || (compressed > 0 && size / compressed > MAX_RATIO)) throw new Error("DOCX ZIP compression limits exceeded");
    total += size;
    if (total > MAX_UNCOMPRESSED) throw new Error("DOCX uncompressed size limit exceeded");
  }
  const entries: Array<{ name: string; text: string }> = [];
  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes || !(await contentTypes.async("string")).includes("wordprocessingml.document.main+xml")) throw new Error("Invalid DOCX content types");
  for (const name of names) if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
    const text = await zip.file(name)!.async("string");
    if (!text.includes("<") || !text.includes(">")) throw new Error(`Malformed XML in ${name}`);
    entries.push({ name, text });
  }
  for (const name of names) if (/^word\/.*\.xml$/.test(name) && !entries.some((entry) => entry.name === name)) {
    const text = await zip.file(name)!.async("string");
    if (placeholderPattern().test(storyText(text))) throw new Error(`Placeholders in unsupported Word part: ${name}`);
  }
  if (!entries.some((x) => x.name === "word/document.xml") || !zip.file("word/_rels/document.xml.rels")) throw new Error("DOCX document or relationships missing");
  return { zip, entries };
}
function detect(entries: Array<{ text: string }>): string[] {
  const out = new Set<string>();
  for (const { text } of entries) {
    // Word frequently splits a placeholder over several w:r/w:t runs.
    // Matching the XML-stripped stream catches both normal and split runs.
    const streams = [text, storyText(text)];
    for (const stream of streams) {
      for (const match of stream.matchAll(placeholderPattern())) out.add(match[1] ?? match[2]);
    }
  }
  return [...out].sort();
}
function assignedGeneration(id: number, auth: AuthUser) {
  const row = queryRow<Record<string, unknown>>(`SELECT g.*, t.name template_name FROM contract_generations g JOIN contract_templates t ON t.id=g.template_id WHERE g.id=? AND g.deleted_at IS NULL`, [id]);
  return row && canCustomer(auth, Number(row.customer_id)) ? row : undefined;
}
function principalTemplateEvidence(generation: any): RenderedPrincipalTemplateEvidence {
  const template = queryRow<any>("SELECT storage_path,sha256 FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(generation?.template_id)]);
  return {
    templateId: generation?.template_id,
    templatePath: template?.storage_path,
    templateRoot: templateDir,
    storedTemplateSha256: template?.sha256,
    mappings: json(generation?.mappings_snapshot_json, null),
    renderedDocxPath: generation?.docx_path,
    renderedDocxRoot: generationDir,
    renderedDocxSha256: generation?.docx_sha256,
    renderedValues: json(generation?.manual_values_json, null),
    renderedPdfRoot: generationDir,
    renderedPdfSha256: generation?.pdf_sha256,
  };
}

function latestTomanReplacementConsent(applicationId: number): TomanReplacementConsent | null {
  const row = queryRow<any>(`SELECT reason FROM loan_application_stage_history
    WHERE application_id=? AND action=? ORDER BY id DESC LIMIT 1`, [applicationId, TOMAN_REPLACEMENT_ACTION]);
  return parseTomanReplacementConsent(row?.reason);
}
function downloadUrl(id: number, kind: string) { return `/api/contracts/generations/${id}/download/${kind}`; }
function preapprovedGenerationMatches(application: any, generation: any, expectedAmount = String(application.approved_amount ?? ""), allowCertificateRetry = false): boolean {
  const planId = Number(application.plan_id);
  const snapshot = json<Record<string, any> | null>(application.plan_snapshot_json, null);
  const templateId = Number(snapshot?.contract_template_id ?? snapshot?.primary_contract_template_id);
  const providerState = classifyProviderState(generation.provider_status);
  // Certificate checks happen before file upload or contract creation. Reuse this
  // verified PDF on retry, but never treat it as a sent/signed contract elsewhere.
  // Interrupted uploads may resume only their already saved delivery identity;
  // this issuance-only allowance never skips the scope/terms/PDF checks below.
  const certificateRetry = allowCertificateRetry &&
    (isCertificatePreflightRetry(generation) || isInterruptedDeliveryRetry(generation));
  if (!snapshot || !templateId || Number(generation.loan_application_id) !== Number(application.id) ||
      Number(generation.customer_id) !== Number(application.customer_id) || Number(generation.loan_plan_id) !== planId ||
      Number(generation.template_id) !== templateId || generation.deleted_at || generation.superseded_at ||
      (!["generated", "sent", "signed"].includes(String(generation.status)) && !certificateRetry) ||
      providerState === "negative" || (generation.status === "signed" && !isStrictSignedProviderState(generation.provider_status)) ||
      !generation.pdf_path || !generation.pdf_sha256) return false;
  try {
    const pdf = fs.realpathSync(String(generation.pdf_path));
    const stat = fs.lstatSync(String(generation.pdf_path));
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(pdf)) !== String(generation.pdf_sha256)) return false;
  } catch { return false; }
  const mappings = json<ContractMappingInput[]>(generation.mappings_snapshot_json, []);
  const values = json<Record<string, unknown> | null>(generation.manual_values_json, null);
  if (!Array.isArray(mappings) || !values) return false;
  const template = queryRow<any>("SELECT mappings_json,updated_at FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]);
  if (!template) return false;
  if (generation.mappings_snapshot_json == null) {
    const generatedAt = Date.parse(String(generation.created_at ?? ""));
    const updatedAt = Date.parse(String(template.updated_at ?? ""));
    if (!Number.isFinite(generatedAt) || !Number.isFinite(updatedAt) || updatedAt > generatedAt) return false;
    mappings.push(...json<ContractMappingInput[]>(template.mappings_json, []));
  }
  const sourceType = (mapping: ContractMappingInput) => mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
  const principal = mappings.filter((mapping) => sourceType(mapping) === "loanPlan" && mapping.loanPlanField === "loanPlan.principalAmount");
  const duration = mappings.filter((mapping) => sourceType(mapping) === "loanPlan" &&
    ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping.loanPlanField)));
  const normalized = (value: unknown) => normalizeNumber(String(value ?? "")).replace(/[,\u060c\u066c\s]/g, "");
  const expectedDuration = String(application.initial_approval_at
    ? application.duration_months : application.requested_duration_months ?? application.duration_months);
  const manualMappings = mappings.filter((mapping) => sourceType(mapping) === "manual");
  const applicationManualValues = json<Record<string, string>>(application.primary_manual_values_json, {}) ?? {};
  const manualKeys = manualMappings.map((mapping) => mapping.variable);
  const storedKeys = Object.keys(applicationManualValues);
  const manualValuesMatch = manualKeys.length === storedKeys.length && manualMappings.every((mapping) => {
    const expected = applicationManualValues[mapping.variable];
    const rendered = values[mapping.variable];
    if (typeof expected !== "string" || typeof rendered !== "string") return false;
    const normalizeManual = (value: string) => {
      const text = value.trim();
      const numeric = text.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
        .replace(/[٬،,\s]/g, "").replace(/٫/g, ".");
      return /^[-+]?\d+(?:\.\d+)?$/.test(numeric) ? `number:${numeric}` : `text:${text}`;
    };
    return normalizeManual(expected) === normalizeManual(rendered);
  });
  return principal.length === 1 && manualValuesMatch &&
    (!application.initial_approval_at ||
      Number(application.duration_months) === Number(application.requested_duration_months ?? application.duration_months) ||
      duration.length > 0) &&
    normalized(values[principal[0].variable]) === expectedAmount &&
    duration.every((mapping) => normalized(values[mapping.variable]) === expectedDuration);
}
function isCurrentApplicationPrimaryGeneration(application: any, generationId: number): boolean {
  if (!application) return false;
  if (application.current_primary_generation_id != null) {
    return Number(application.current_primary_generation_id) === generationId;
  }
  if (application.initial_approval_at || application.legacy_reopen_prior_stage != null ||
      application.stage === "funder_initial_approval" || queryRow<any>(`SELECT 1 FROM loan_application_stage_history
        WHERE application_id=? AND action='legacy-applications-reopened-for-initial-provider-approval' LIMIT 1`,
      [application.id])) return false;
  const latest = queryRow<any>(`SELECT g.id,g.loan_application_id,g.deleted_at,g.superseded_at
    FROM loan_application_generated_documents d JOIN contract_generations g ON g.id=d.contract_generation_id
    WHERE d.application_id=? AND d.kind='primary' ORDER BY d.id DESC LIMIT 1`, [application.id]);
  return Number(latest?.id) === generationId && latest.loan_application_id == null &&
    !latest.deleted_at && !latest.superseded_at;
}

router.get("/contracts/customer-fields", requirePermission("contracts.view"), (_req, res) => {
  res.json({
    fields: Object.entries(fields).map(([value, label]) => ({ value, label })),
    loanPlanFields: Object.entries(loanPlanFields).map(([value, label]) => ({ value, label })),
    loanPlans: queryRows<{ id: number; name: string }>("SELECT id,name FROM loan_plans WHERE active=1 ORDER BY name,id"),
  });
});

router.post("/contracts/templates/analyze", requirePermission("contracts.manage"), upload.single("file"), async (req, res): Promise<void> => {
  try {
    if (!req.file?.buffer) { res.status(400).json({ error: "DOCX file is required" }); return; }
    const { entries } = await xmlEntries(req.file.buffer);
    cleanupAnalyses();
    const token = crypto.randomBytes(24).toString("base64url");
    const stagedPath = path.join(analysisDir, `${crypto.randomUUID()}.docx`);
    await fsp.writeFile(stagedPath, req.file.buffer, { mode: 0o600 });
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    execute("INSERT INTO contract_template_analyses(token_hash,user_id,staged_path,original_filename,variables_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      [tokenHash(token), user(req, res).id, stagedPath, req.file.originalname.slice(0, 255), JSON.stringify(detect(entries)), expires, now()]);
    res.json({ uploadToken: token, variables: detect(entries), expiresAt: expires });
  } catch (e) { res.status(400).json({ error: "Invalid DOCX template" }); }
});

router.post("/contracts/templates", requirePermission("contracts.manage"), async (req, res): Promise<void> => {
  const { name, uploadToken, mappings } = req.body as { name?: string; uploadToken?: string; mappings?: ContractMappingInput[] };
  if (!name?.trim() || name.trim().length > 160 || !uploadToken || !/^[A-Za-z0-9_-]{20,}$/.test(uploadToken)) { res.status(400).json({ error: "name and uploadToken are required" }); return; }
  cleanupAnalyses();
  const metadata = queryRow<any>("SELECT * FROM contract_template_analyses WHERE token_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at > ?", [tokenHash(uploadToken), user(req, res).id, now()]);
  const source = metadata?.staged_path ? safePath(String(metadata.staged_path)) : null;
  if (!source || !metadata) { res.status(400).json({ error: "Upload analysis expired" }); return; }
  try { const stat = fs.lstatSync(source); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid"); } catch { res.status(400).json({ error: "Upload analysis expired" }); return; }
  try {
    const data = await fsp.readFile(source); const { entries } = await xmlEntries(data); const variables = detect(entries);
    if (JSON.stringify(variables) !== String(metadata.variables_json)) throw new Error("Upload analysis changed");
    const normalizedMappings = normalizeMappings(variables, mappings);
    if (!normalizedMappings) { res.status(400).json({ error: "Every detected variable requires a valid mapping" }); return; }
    const destination = path.join(templateDir, `${crypto.randomUUID()}.docx`);
    let id: number;
    try {
      crmDb.exec("BEGIN IMMEDIATE");
      const locked = queryRow<any>("SELECT * FROM contract_template_analyses WHERE id=? AND user_id=? AND consumed_at IS NULL AND expires_at > ?", [metadata.id, user(req, res).id, now()]);
      if (!locked || String(locked.staged_path) !== source || String(locked.variables_json) !== String(metadata.variables_json)) {
        throw new Error("Upload analysis expired");
      }
      await fsp.rename(source, destination);
      id = execute(`INSERT INTO contract_templates (name,original_filename,storage_path,sha256,variables_json,mappings_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [name.trim(), String(metadata.original_filename), destination, sha(data), JSON.stringify(variables), JSON.stringify(normalizedMappings), user(req, res).id, now(), now()]);
      crmDb.prepare("UPDATE contract_template_analyses SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now(), metadata.id);
      crmDb.exec("COMMIT");
    } catch (error) {
      try { crmDb.exec("ROLLBACK"); } catch { /* rollback best effort */ }
      await fsp.rm(destination, { force: true }); throw error;
    }
    const created = queryRow<any>("SELECT * FROM contract_templates WHERE id=?", [id]);
    res.status(201).json(templateResponse(created));
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : "Invalid template" }); }
});

router.get("/contracts/templates", requirePermission("contracts.view"), (_req, res) => res.json(queryRows("SELECT * FROM contract_templates WHERE deleted_at IS NULL ORDER BY created_at DESC").map(templateResponse)));
router.get("/contracts/templates/:id", requirePermission("contracts.view"), (req, res) => {
  const r = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(req.params.id)]);
  if (!r) return res.status(404).json({ error: "Template not found" }); return res.json(templateResponse(r));
});
router.patch("/contracts/templates/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isSafeInteger(id) && id > 0 ? queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [id]) : undefined;
  if (!row) { res.status(404).json({ error: "Template not found" }); return; }
  const { name, mappings } = req.body as { name?: string; mappings?: ContractMappingInput[] };
  const normalizedName = name?.trim();
  const normalizedMappings = normalizeMappings(json<string[]>(row.variables_json, []), mappings);
  if (!normalizedName || normalizedName.length > 160 || !normalizedMappings) { res.status(400).json({ error: "Template name and mappings are invalid" }); return; }
  const updatedAt = now();
  execute("UPDATE contract_templates SET name=?,mappings_json=?,updated_at=? WHERE id=? AND deleted_at IS NULL", [normalizedName, JSON.stringify(normalizedMappings), updatedAt, id]);
  // Unsigned cases follow the edited template immediately; signed history is untouched.
  propagateContractTemplateChange({ templateId: id, actor: user(req, res), log: req.log });
  res.json(templateResponse({ ...row, name: normalizedName, mappings_json: JSON.stringify(normalizedMappings), updated_at: updatedAt }));
});
router.delete("/contracts/templates/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(404).json({ error: "Template not found" }); return; }
  if (queryRow("SELECT 1 FROM loan_plans WHERE contract_template_id=? AND deleted_at IS NULL LIMIT 1", [id])) {
    res.status(409).json({ error: "Template is referenced by a loan plan" }); return;
  }
  const deleted = crmDb.prepare("UPDATE contract_templates SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(), now(), id);
  if (!deleted.changes) { res.status(404).json({ error: "Template not found" }); return; }
  res.status(204).send();
});
router.get("/contracts/templates/:id/download", requirePermission("contracts.view"), (req, res) => {
  const r = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [Number(req.params.id)]); let p: string | null = null;
  try { if (r) p = regularPath(r.storage_path, "templates"); } catch { p = null; }
  if (!r || !p) return res.status(404).json({ error: "Template not found" });
  return res.download(p, `${String(r.name).replace(/[^a-zA-Z0-9._-]/g, "_")}.docx`);
});

const generateContractHandler = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { templateId?: number; customerId?: number; loanPlanId?: number; durationMonths?: number; loanApplicationId?: number; manualValues?: Record<string, string> };
  const auth = user(req, res);
  let { templateId, customerId, loanPlanId, durationMonths, manualValues = {} } = body;
  let application: any = null;
  let approvedPlan: Record<string, unknown> | undefined;
  let applicationBinding: number | null = null;
  let generationPurpose = "primary";
  let preapprovedPrimary = false;
  let requestedPrimary = false;
  let approvedReplacementPrimary = false;
  let legacyTomanReplacement = false;

  let tomanReplacementConsent: TomanReplacementConsent | null = null;
  let primaryApplicationGeneration = false;
  let applicationPrincipalAmount = "";
  if (body.loanApplicationId != null) {
    const applicationId = Number(body.loanApplicationId);
    application = queryRow<any>(`SELECT a.*,c.id canonical_customer_id FROM loan_applications a
      JOIN customers c ON c.id=a.customer_id WHERE a.id=? AND a.deleted_at IS NULL`, [applicationId]);
    if (!application) { res.status(404).json({ error: "loan_application_not_found" }); return; }
    if (auth.role !== "admin" && auth.role !== "salesperson") { res.status(403).json({ error: "action_forbidden" }); return; }
    if (!canCustomer(auth, Number(application.customer_id))) { res.status(403).json({ error: "Customer is outside your assignment" }); return; }
    tomanReplacementConsent = activeTomanReplacementConsent(application);
    legacyTomanReplacement = Boolean(tomanReplacementConsent);
    preapprovedPrimary = Boolean(application.initial_approval_at);
    const newCase = Number(application.new_case_workflow) === 1;
    // Reopened legacy cases resequenced before approval need a requested-terms
    // contract too; they must not be forced to approve an unsigned amount first.
    requestedPrimary = (newCase || application.legacy_reopen_prior_stage != null) && !preapprovedPrimary;
    approvedReplacementPrimary = newCase && preapprovedPrimary && application.stage === "approved_contract_pending_signature";
    primaryApplicationGeneration = preapprovedPrimary || requestedPrimary || approvedReplacementPrimary || legacyTomanReplacement;
    if ((preapprovedPrimary && application.stage !== "draft" && !approvedReplacementPrimary && !legacyTomanReplacement) ||
        (requestedPrimary && application.stage !== "draft") ||
        (!primaryApplicationGeneration && application.stage !== "funder_amendment_pending_signature") ||
        application.status === "rejected") {
      res.status(409).json({ error: primaryApplicationGeneration ? "primary_generation_stage_required" : "amendment_generation_stage_required" }); return;
    }
    const contractDuration = legacyTomanReplacement ? Number(tomanReplacementConsent!.durationMonths) : Number(preapprovedPrimary
      ? application.duration_months : application.requested_duration_months ?? application.duration_months);
    applicationPrincipalAmount = legacyTomanReplacement ? tomanReplacementConsent!.approvedAmount
      : requestedPrimary ? String(application.requested_amount ?? "") : String(application.approved_amount ?? "");
    if (!/^[1-9]\d{0,17}$/.test(applicationPrincipalAmount) ||
        !Number.isSafeInteger(contractDuration) || contractDuration < 1 || contractDuration > 600) {
      res.status(409).json({ error: "approved_application_terms_missing" }); return;
    }
    const planId = Number(application.plan_id ?? (Array.isArray(json(application.plan_ids, [])) ? json(application.plan_ids, [])[0] : application.plan_ids));
    const currentPlan = queryRow<Record<string, unknown>>("SELECT id FROM loan_plans WHERE id=?", [planId]);
    const snapshot = json<Record<string, unknown> | null>(application.plan_snapshot_json, null);

    if (!currentPlan || !snapshot || (snapshot.id != null && Number(snapshot.id) !== planId)) {
      res.status(409).json({ error: "application_plan_snapshot_invalid" }); return;
    }
    approvedPlan = snapshot;
    const snapshotTemplateId = Number(approvedPlan.contract_template_id ?? approvedPlan.primary_contract_template_id);
    const configuredTemplateId = legacyTomanReplacement ? Number(tomanReplacementConsent!.tomanTemplateId) : snapshotTemplateId;
    if (!configuredTemplateId || (templateId != null && Number(templateId) !== configuredTemplateId) ||
        (loanPlanId != null && Number(loanPlanId) !== planId) ||
        (customerId != null && Number(customerId) !== Number(application.customer_id)) ||
        (durationMonths != null && Number(durationMonths) !== contractDuration)) {
      res.status(409).json({ error: primaryApplicationGeneration ? "primary_generation_scope_mismatch" : "amendment_generation_scope_mismatch" }); return;
    }
    templateId = configuredTemplateId;
    customerId = Number(application.customer_id);
    loanPlanId = planId;
    durationMonths = contractDuration;
    applicationBinding = applicationId;
    generationPurpose = legacyTomanReplacement ? TOMAN_REPLACEMENT_PURPOSE
      : Number(application.new_case_workflow) === 1 && application.stage === "funder_amendment_pending_signature"
        ? "amendment" : "primary";
    const savedManualValues = json<Record<string, string>>(application.primary_manual_values_json, {}) ?? {};
    if (primaryApplicationGeneration) {
      if (body.manualValues === undefined) {
        manualValues = savedManualValues;
        if (legacyTomanReplacement) {
          const template = queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [configuredTemplateId]);
          const mappings = json<ContractMappingInput[]>(template?.mappings_json, []);
          const keys = mappings.filter((m) => (m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual")) === "manual").map((m) => m.variable);
          manualValues = Object.fromEntries(keys.map((key) => [key, savedManualValues[key] ?? ""]));
        }
      }
      else {
        if (!manualValues || typeof manualValues !== "object" || Array.isArray(manualValues)) {
          res.status(400).json({ error: "manual_values_invalid" }); return;
        }
        const template = queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=? AND deleted_at IS NULL", [configuredTemplateId]);
        const mappings = json<ContractMappingInput[]>(template?.mappings_json, []);
        const keys = mappings.filter((m) => (m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual")) === "manual").map((m) => m.variable);
        if (new Set(keys).size !== keys.length || Object.keys(manualValues).length !== keys.length ||
            keys.some((key) => typeof manualValues[key] !== "string" || !manualValues[key].trim() || manualValues[key].trim().length > 5000) ||
            Object.keys(manualValues).some((key) => !keys.includes(key)) ||
            Object.values(manualValues).reduce((sum, value) => sum + value.length, 0) > 50 * 1024) {
          res.status(400).json({ error: "invalid_manual_values" }); return;
        }
        manualValues = Object.fromEntries(Object.entries(manualValues).map(([key, value]) => [key, value.trim()]));
      }
    } else if (Object.keys(manualValues ?? {}).length) {
      res.status(400).json({ error: "amendment_manual_values_are_derived" }); return;
    }
    let previous = queryRow<any>(`SELECT g.* FROM contract_generations g
      WHERE g.loan_application_id=? AND g.generation_purpose=? AND g.deleted_at IS NULL AND g.superseded_at IS NULL`, [applicationId, generationPurpose]);
    if (previous) {
      if (primaryApplicationGeneration) {
        const prior = json<Record<string, string>>(previous.manual_values_json, {});
        const keys = Object.keys(manualValues);
        if (keys.length !== Object.keys(savedManualValues).length ||
            keys.some((key) => manualValues[key] !== savedManualValues[key] ||
              (prior[key] !== savedManualValues[key] && prior[key] !== groupContractNumber(savedManualValues[key])))) {
          res.status(409).json({ error: "existing_contract_manual_values_locked" }); return;
        }
      }
      if (!legacyTomanReplacement && primaryApplicationGeneration &&
          canRebuildUnsentInstallments(application, previous, () =>
            preapprovedGenerationMatches({ ...application, requested_duration_months: application.duration_months },
              previous, applicationPrincipalAmount, true) &&
            renderedPdfContainsPrincipal(previous.pdf_path, applicationPrincipalAmount, principalTemplateEvidence(previous)))) {
        try {
          runImmediateTransaction(() => {
            const ts = now();
            const retired = crmDb.prepare(`UPDATE contract_generations SET superseded_at=?,updated_at=?
              WHERE id=? AND status='generated' AND provider_contract_id IS NULL AND provider_file_id IS NULL
              AND deleted_at IS NULL AND superseded_at IS NULL
              AND EXISTS(SELECT 1 FROM loan_applications a WHERE a.id=? AND a.stage='approved_contract_pending_signature'
                AND a.status<>'rejected' AND a.approved_amount=? AND a.duration_months=? AND a.updated_at=?
                AND (a.current_primary_generation_id IS NULL OR a.current_primary_generation_id=?))`)
              .run(ts, ts, previous.id, applicationId, applicationPrincipalAmount, contractDuration, application.updated_at, previous.id).changes;
            if (retired !== 1) throw Error("application_primary_generation_mismatch");
            crmDb.prepare("UPDATE loan_applications SET current_primary_generation_id=NULL,updated_at=? WHERE id=? AND current_primary_generation_id=?")
              .run(ts, applicationId, previous.id);
            execute("INSERT INTO loan_application_stage_history(application_id,from_stage,to_stage,action,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?)",
              [applicationId, application.stage, application.stage, "unsigned-contract-rebuilt",
                JSON.stringify({ reason: "بازسازی قرارداد ارسال‌نشده برای درج تعداد اقساط مصوب، بدون تغییر قرارداد امضاشده یا شرایط مالی",
                  previousGenerationId: previous.id, amount: applicationPrincipalAmount, durationMonths: contractDuration }), user(req, res).id, ts]);
          });
          previous = null;
        } catch { res.status(409).json({ error: "application_primary_generation_mismatch" }); return; }
      }
      if (previous && (legacyTomanReplacement
        ? !tomanReplacementDocumentTermsMatch(application, previous, tomanReplacementConsent!, true)
        : primaryApplicationGeneration && !preapprovedGenerationMatches(application, previous, applicationPrincipalAmount, true))) {
        res.status(409).json({ error: "application_primary_generation_mismatch" }); return;
      }
      if (previous) { res.status(200).json({ id: previous.id, status: previous.status, contractNumber: previous.contract_number,
        docxUrl: downloadUrl(Number(previous.id), "docx"), pdfUrl: previous.pdf_path ? downloadUrl(Number(previous.id), "pdf") : null,
        loanApplicationId: applicationId });
      return; }
    }
    if (primaryApplicationGeneration && body.manualValues !== undefined &&
        JSON.stringify(manualValues) !== JSON.stringify(savedManualValues)) {
      crmDb.prepare("UPDATE loan_applications SET primary_manual_values_json=?,updated_at=? WHERE id=?").run(
        JSON.stringify(manualValues), now(), applicationId);
      application.primary_manual_values_json = JSON.stringify(manualValues);
    }
    if (!primaryApplicationGeneration) {
    const primary = queryRow<any>(`SELECT g.* FROM loan_application_generated_documents d
      JOIN contract_generations g ON g.id=d.contract_generation_id AND g.deleted_at IS NULL
      JOIN loan_applications a ON a.id=d.application_id
      WHERE d.application_id=? AND d.kind='primary' AND d.link LIKE 'signed:%'
      ORDER BY d.id DESC LIMIT 1`, [applicationId]);
    if (!primary || !isCurrentApplicationPrimaryGeneration(application, Number(primary.id)) ||
        primary.status !== "signed" || !isStrictSignedProviderState(primary.provider_status) ||
        !primary.provider_contract_id || !primary.pdf_path || !fs.existsSync(String(primary.pdf_path))) {
      res.status(409).json({ error: "signed_primary_contract_required" }); return;
    }
    if (Number(primary.template_id) !== configuredTemplateId || Number(primary.loan_plan_id) !== planId) {
      res.status(409).json({ error: "signed_primary_template_mismatch" }); return;
    }
    const previousValues = json<Record<string, string>>(primary.manual_values_json, {});
    const amendmentTemplate = queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [configuredTemplateId]);
    if (!amendmentTemplate) { res.status(409).json({ error: "application_contract_template_missing" }); return; }
    const amendmentMappings = json<ContractMappingInput[]>(amendmentTemplate.mappings_json, []);
    const sourceMappings = json<ContractMappingInput[]>(queryRow<any>("SELECT mappings_json FROM contract_templates WHERE id=?", [primary.template_id])?.mappings_json, []);
    const oldManualKeys = new Set(sourceMappings.filter((m) => (m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual")) === "manual").map((m) => m.variable));
    const derivedManual: Record<string, string> = {};
    for (const mapping of amendmentMappings) {
      const manual = (mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual")) === "manual";
      if (!manual) continue;
      if (!oldManualKeys.has(mapping.variable) || typeof previousValues[mapping.variable] !== "string" || !previousValues[mapping.variable].trim()) {
        res.status(409).json({ error: "amendment_manual_value_unavailable", variable: mapping.variable }); return;
      }
      derivedManual[mapping.variable] = previousValues[mapping.variable];
    }
    const fieldUsed = (field: string) => amendmentMappings.some((mapping) =>
      (mapping.sourceType === "loanPlan" && mapping.loanPlanField === field) ||
      (mapping.sourceType === "formula" && mapping.formula?.tokens.some((token) => token.type === "field" && token.field === field)));
    if (!fieldUsed("loanPlan.principalAmount") ||
        !(fieldUsed("loanPlan.installments") || fieldUsed("loanPlan.durationMonths"))) {
      res.status(422).json({ error: "amendment_template_missing_approved_terms_mappings" }); return;
    }
    manualValues = derivedManual;
    }
  }
  const t = templateId && queryRow<any>("SELECT * FROM contract_templates WHERE id=? AND deleted_at IS NULL", [templateId]);
  const c = customerId && customer(Number(customerId));
  if (!t || !c) { res.status(404).json({ error: "Template or customer not found" }); return; } if (!canCustomer(auth, Number(customerId))) { res.status(403).json({ error: "Customer is outside your assignment" }); return; }
  if (!manualValues || typeof manualValues !== "object" || Array.isArray(manualValues)) { res.status(400).json({ error: "manualValues must be an object" }); return; }
  if (durationMonths != null && (!Number.isInteger(durationMonths) || durationMonths <= 0 || durationMonths > 600)) {
    res.status(400).json({ error: "durationMonths is invalid" }); return;
  }
  const mappings = json<ContractMappingInput[]>(t.mappings_json, []);
   const referencedPlans = queryRows<Record<string, unknown>>("SELECT * FROM loan_plans WHERE contract_template_id=? OR primary_contract_template_id=? ORDER BY active DESC,id", [Number(templateId), Number(templateId)]);
  const selectedPlanId = Number.isSafeInteger(loanPlanId) && Number(loanPlanId) > 0 ? Number(loanPlanId) :
    referencedPlans.length === 1 ? Number(referencedPlans[0].id) : null;
  let plan = selectedPlanId ? queryRow<Record<string, unknown>>(
     "SELECT * FROM loan_plans WHERE id=? AND (contract_template_id=? OR primary_contract_template_id=?)",
     [selectedPlanId, Number(templateId), Number(templateId)],
  ) : undefined;
   if (applicationBinding && approvedPlan && selectedPlanId === Number(loanPlanId)) {
    const configuredId = Number(approvedPlan.contract_template_id ?? approvedPlan.primary_contract_template_id);
     if (!legacyTomanReplacement && configuredId !== Number(templateId)) { res.status(409).json({ error: primaryApplicationGeneration ? "primary_generation_scope_mismatch" : "amendment_generation_scope_mismatch" }); return; }
     plan = { ...approvedPlan, _approved_principal_amount: applicationPrincipalAmount,
       _approved_duration_months: application.duration_months ?? application.requested_duration_months };
  }
  if (loanPlanId != null && !plan) { res.status(400).json({ error: "Selected loan plan does not reference this template" }); return; }
  const typedMappings = mappings;
    if (primaryApplicationGeneration) {
     const sourceType = (mapping: ContractMappingInput) => mapping.sourceType ?? (mapping.customerField ? "customer" : mapping.loanPlanField ? "loanPlan" : "manual");
     const principalMappings = typedMappings.filter((mapping) => sourceType(mapping) === "loanPlan" && mapping.loanPlanField === "loanPlan.principalAmount");
      if (principalMappings.length !== 1) {
        res.status(422).json({ error: "primary_template_missing_principal_mapping" }); return;
     }
     if (legacyTomanReplacement && tomanReplacementDurationChanged(application) && typedMappings.filter((mapping) =>
       sourceType(mapping) === "loanPlan" &&
       ["loanPlan.installments", "loanPlan.durationMonths"].includes(String(mapping.loanPlanField))).length !== 1) {
       res.status(422).json({ error: "toman_template_missing_duration_mapping" }); return;
     }
   }
  if (typedMappings.some((m) => m.loanPlanField || m.sourceType === "loanPlan" || m.sourceType === "formula") && !plan) {
    res.status(409).json({ error: "A loan plan referencing this template is required" }); return;
  }
  const manualKeys = new Set(typedMappings.filter((m) => !m.sourceType || m.sourceType === "manual").map((m) => m.variable));
  if (Object.keys(manualValues).some((key) => !manualKeys.has(key))) { res.status(400).json({ error: "Unknown manual variable" }); return; }
  let manualTotal = 0; for (let [key, value] of Object.entries(manualValues)) {
    if (typeof value !== "string" || !(value = value.trim())) { res.status(400).json({ error: `Missing value for ${key}` }); return; }
    if (value.length > 5000) { res.status(400).json({ error: "Manual values are too long" }); return; } manualTotal += value.length;
  }
  if (manualTotal > 50 * 1024) { res.status(400).json({ error: "Manual values are too long" }); return; }
  const values: Record<string, string> = {};
  let contractNumber: string | null = null;
  try {
    for (const m of typedMappings) {
      const sourceType = m.sourceType ?? (m.customerField ? "customer" : m.loanPlanField ? "loanPlan" : "manual");
      values[m.variable] = sourceType === "customer"
        ? fieldValue(c, m.customerField ?? "")
        : sourceType === "loanPlan" && plan && m.loanPlanField
          ? loanPlanFieldValue(plan, m.loanPlanField, durationMonths)
          : sourceType === "constant"
            ? String(m.constantValue ?? "")
            : sourceType === "formula" && plan && m.formula
              ? formulaValue(m.formula, c, plan, durationMonths)
              : sourceType === "date"
                ? contractDateValue(m.date?.mode === "contract_date_plus_days" ? Number(m.date.offsetDays ?? 0) : 0)
                : sourceType === "contractNumber"
                  ? "__CONTRACT_NUMBER_PENDING__"
                : String(manualValues[m.variable] ?? "");
      values[m.variable] = shouldGroupContractValue(m, plan)
        ? groupContractNumber(values[m.variable]) : ungroupContractNumber(values[m.variable]);
      if (!values[m.variable].trim()) { res.status(400).json({ error: `Missing value for ${m.variable}` }); return; }
    }
  } catch (error) {
    req.log.warn({ err: error, templateId: Number(templateId), loanPlanId: selectedPlanId, durationMonths }, "contract formula evaluation failed");
    res.status(422).json({ error: "formula_value_invalid" });
    return;
  }
  const contractNumberMappings = typedMappings.filter((mapping) => mapping.sourceType === "contractNumber");
  let generationId = 0; let partialDocx = ""; let partialPdf = ""; let stage = "read_template";
  try {
    const source = await fsp.readFile(regularPath(t.storage_path, "templates"));
    // docxtemplater merges placeholders split across w:r/w:t nodes while retaining
    // the first run's formatting. Custom delimiters avoid interpreting Word fields.
    stage = "prepare_template";
    const sourceZip = await JSZip.loadAsync(source);
    for (const name of Object.keys(sourceZip.files)) {
      if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) {
        const xml = await sourceZip.file(name)!.async("string");
        sourceZip.file(name, normalizeTemplatePercentDelimiters(xml, typedMappings.map((mapping) => mapping.variable)));
      }
    }
    stage = "compile_template";
    if (primaryApplicationGeneration && !legacyTomanReplacement) {
      const documentXml = await sourceZip.file("word/document.xml")!.async("string");
      sourceZip.file("word/document.xml", appendApprovedInstallments(documentXml, application, typedMappings, values));
    }
    const templater = new Docxtemplater(new PizZip(await sourceZip.generateAsync({ type: "nodebuffer" })), {
      delimiters: { start: "%", end: "%" },
      paragraphLoop: true,
      linebreaks: true,
    });
    if (contractNumberMappings.length) {
      contractNumber = allocateContractNumber();
      for (const mapping of contractNumberMappings) values[mapping.variable] = contractNumber;
    }
    stage = "render_template";
    templater.render(values);
    const docx = templater.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
    stage = "validate_rendered_document";
    const rendered = await xmlEntries(docx);
    if (detect(rendered.entries).length) throw new Error("Rendered DOCX contains unresolved placeholders");
    stage = "save_generation";
    const id = execute(`INSERT INTO contract_generations (template_id,customer_id,loan_plan_id,loan_application_id,generation_purpose,mappings_snapshot_json,contract_number,docx_path,docx_sha256,manual_values_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [t.id, customerId, selectedPlanId, applicationBinding, generationPurpose, JSON.stringify(typedMappings), contractNumber, "", sha(docx), JSON.stringify(manualValues), auth.id, now(), now()]);
    generationId = id;
    const docxPath = path.join(generationDir, `${crypto.randomUUID()}.docx`);
    partialDocx = docxPath;
    await fsp.writeFile(docxPath, docx, { mode: 0o600 });
    crmDb.prepare("UPDATE contract_generations SET docx_path=?,manual_values_json=?,status='processing' WHERE id=?")
      .run(docxPath, JSON.stringify(values), id);
    stage = "convert_pdf";
    const pdfPath = await convertPdf(docxPath);
    partialPdf = pdfPath;
    crmDb.prepare("UPDATE contract_generations SET pdf_path=?,pdf_sha256=?,status='generated',updated_at=? WHERE id=?")
      .run(pdfPath, sha(await fsp.readFile(pdfPath)), now(), id);
    if (primaryApplicationGeneration && !legacyTomanReplacement && application?.initial_approval_at) {
      stage = "validate_approved_terms";
      const generated = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [id]);
      if (!renderedPdfContainsPrincipal(generated.pdf_path, applicationPrincipalAmount, principalTemplateEvidence(generated)) ||
          (Number(application.duration_months) !== Number(application.requested_duration_months ?? application.duration_months) &&
            !renderedPdfContainsInstallmentCount(generated.pdf_path, Number(application.duration_months), principalTemplateEvidence(generated))))
        throw Error("approved_contract_terms_not_rendered");
    }
    if (legacyTomanReplacement) {
      stage = "validate_toman_replacement";
      const generated = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [id]);
      const latestApplication = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [applicationBinding]);
      const latestConsent = latestApplication && activeTomanReplacementConsent(latestApplication);
      if (!generated || !latestApplication || !latestConsent ||
          latestConsent.sourceGenerationId !== tomanReplacementConsent?.sourceGenerationId ||
          latestConsent.tomanTemplateId !== tomanReplacementConsent?.tomanTemplateId ||
          !tomanReplacementDocumentTermsMatch(latestApplication, generated, latestConsent))
        throw new Error("toman_replacement_terms_unverifiable");
    }
    res.status(201).json({ id, status: "generated", contractNumber, docxUrl: downloadUrl(id, "docx"), pdfUrl: downloadUrl(id, "pdf"), ...(applicationBinding ? { loanApplicationId: applicationBinding } : {}) });
  } catch (e) {
    req.log.error({ err: e, stage, templateId: Number(templateId), customerId: Number(customerId), generationId: generationId || undefined }, "contract generation failed");
    if (generationId) crmDb.prepare(`UPDATE contract_generations SET status='failed',error_message=?,superseded_at=CASE
       WHEN ? IN ('save_generation','convert_pdf','validate_toman_replacement','validate_approved_terms') AND loan_application_id IS NOT NULL AND provider_contract_id IS NULL
       THEN COALESCE(superseded_at,?) ELSE superseded_at END,updated_at=? WHERE id=?`)
      .run("Document generation failed", stage, now(), now(), generationId);
    for (const file of [partialDocx, partialPdf]) if (file) fs.rmSync(file, { force: true });
    const code = e instanceof Error && e.message === "approved_contract_terms_not_rendered"
      ? "approved_contract_terms_not_rendered"
      : e instanceof Error && e.message === "toman_replacement_terms_unverifiable"
      ? "toman_replacement_terms_unverifiable"
      : e instanceof Error && e.message === "conversion_queue_full"
        ? "conversion_queue_full"
        : ["read_template", "prepare_template", "compile_template", "render_template", "validate_rendered_document"].includes(stage)
          ? "invalid_contract_template" : stage === "convert_pdf" ? "pdf_conversion_failed" : "document_generation_failed";
    if (applicationBinding && String(e).includes("UNIQUE constraint failed")) {
      const existing = queryRow<any>("SELECT * FROM contract_generations WHERE loan_application_id=? AND generation_purpose=? AND superseded_at IS NULL", [applicationBinding, generationPurpose]);
      if (existing && (legacyTomanReplacement
          ? tomanReplacementDocumentTermsMatch(application, existing, tomanReplacementConsent!)
          : !primaryApplicationGeneration || preapprovedGenerationMatches(application, existing, applicationPrincipalAmount, true))) {
        res.status(200).json({ id: existing.id, status: existing.status, contractNumber: existing.contract_number, docxUrl: downloadUrl(Number(existing.id), "docx"), pdfUrl: existing.pdf_path ? downloadUrl(Number(existing.id), "pdf") : null, loanApplicationId: applicationBinding }); return;
      }
    }
    res.status(code === "approved_contract_terms_not_rendered" ? 409 : code === "invalid_contract_template" ? 422
      : code === "toman_replacement_terms_unverifiable" ? 409 : 503).json({ error: code });
  }
};
router.post("/contracts/generate", requirePermission("contracts.generate"), generateContractHandler);
async function runConversion(input: string): Promise<string> {
  const out = path.join(root, `convert-${crypto.randomUUID()}`), profile = path.join(root, `lo-${crypto.randomUUID()}`);
  await fsp.mkdir(out, { mode: 0o700 }); await fsp.mkdir(profile, { mode: 0o700 });
  let child: ReturnType<typeof spawn> | undefined; let settled = false;
  const kill = () => { if (!child?.pid) return; try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* exited */ } } };
  try {
    const result = await new Promise<number>((resolve, reject) => {
      const conversionEnv = { ...process.env };
      if (process.env.CONTRACT_FONTCONFIG_FILE) conversionEnv.FONTCONFIG_FILE = process.env.CONTRACT_FONTCONFIG_FILE;
      child = spawn("soffice", ["--headless", `-env:UserInstallation=file://${profile}`, "--convert-to", "pdf", "--outdir", out, input], { stdio: "ignore", detached: true, env: conversionEnv });
      if (child.pid) activeConversionPids.add(child.pid);
      const timer = setTimeout(() => { kill(); if (!settled) { settled = true; reject(new Error("converter_timeout")); } }, 30_000);
      child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error("converter_unavailable")); } });
      child.once("exit", (code) => { clearTimeout(timer); if (child?.pid) activeConversionPids.delete(child.pid); if (!settled) { settled = true; resolve(code ?? 1); } });
    });
    const pdf = path.join(out, `${path.basename(input, ".docx")}.pdf`); const stat = await fsp.lstat(pdf);
    const pdfBytes = await fsp.readFile(pdf);
    const sourceZip = await JSZip.loadAsync(await fsp.readFile(input));
    const appXml = await sourceZip.file("docProps/app.xml")?.async("string");
    const declaredPages = Number(appXml?.match(/<Pages>(\d+)<\/Pages>/)?.[1] ?? 0);
    const renderedPages = (pdfBytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
    if (
      result !== 0 ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size === 0 ||
      stat.size > 80 * 1024 * 1024 ||
      pdfBytes.subarray(0, 5).toString() !== "%PDF-" ||
      renderedPages < 1 ||
      (declaredPages > 0 && renderedPages !== declaredPages)
    ) throw new Error("conversion_invalid");
    const finalPath = path.join(generationDir, `${crypto.randomUUID()}.pdf`);
    await fsp.rename(pdf, finalPath); const finalStat = await fsp.lstat(finalPath);
    if (!finalStat.isFile() || finalStat.isSymbolicLink()) throw new Error("conversion_invalid");
    return finalPath;
  } finally { if (child?.pid) activeConversionPids.delete(child.pid); await fsp.rm(out, { recursive: true, force: true }); await fsp.rm(profile, { recursive: true, force: true }); }
}
function convertPdf(input: string): Promise<string> {
  if (conversionQueue.length >= 20) return Promise.reject(new Error("conversion_queue_full"));
  return new Promise((resolve, reject) => { conversionQueue.push({ input, resolve, reject }); pumpConversions(); });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    for (const pid of activeConversionPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    }
    process.exit(0);
  });
}
router.get("/contracts/generations/:id", requirePermission("contracts.view"), (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); if (!r) return res.status(404).json({ error: "Generation not found" }); const customerId = Number(r.customer_id); return res.json({ id: r.id, templateId: r.template_id, templateName: r.template_name, customerId: r.customer_id, customerName: queryRow<any>(`SELECT ${survivorCustomerName("?")} name`, [customerId])?.name ?? null, customerSalespersonName: queryRow<any>(`SELECT ${survivorSalespersonName("?")} name`, [customerId])?.name ?? null, loanPlanId: r.loan_plan_id ?? null, loanApplicationId: r.loan_application_id ?? null, contractNumber: r.contract_number ?? null, status: r.status, supersededAt: r.superseded_at ?? null, providerFileId: r.provider_file_id, providerContractId: r.provider_contract_id, providerStatus: r.provider_status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, manualValues: json(r.manual_values_json, {}), docxUrl: downloadUrl(Number(r.id), "docx"), pdfUrl: r.pdf_path ? downloadUrl(Number(r.id), "pdf") : null }); });
const rejectedBySigner = (value: unknown): boolean =>
  ["reject", "rejected", "declined", "ردشد", "ردشده"].includes(
    String(value ?? "").toLowerCase().replace(/[\s_\-\u200c]+/g, ""),
  );
router.post("/contracts/generations/:id/prepare-resend", requirePermission("contracts.send"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const auth = user(req, res);
  const row = assignedGeneration(id, auth);
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  const repairFileReuse = rejectedDeliveryReusesFile(row, queryRow);
  if (row.status !== "sent" || !row.provider_contract_id || row.deleted_at || row.superseded_at ||
      row.send_claim_id || !(rejectedBySigner(row.provider_status) || repairFileReuse)) {
    res.status(409).json({ error: "contract_not_rejected" }); return;
  }
  if (row.loan_application_id == null && queryRow(`SELECT 1 FROM loan_application_generated_documents
    WHERE contract_generation_id=? LIMIT 1`, [id])) {
    res.status(409).json({ error: "contract_not_current" }); return;
  }
  if (row.loan_application_id != null) {
    if (!["admin", "salesperson"].includes(auth.role)) { res.status(403).json({ error: "action_forbidden" }); return; }
    const application = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [Number(row.loan_application_id)]);
    const document = queryRow<any>(`SELECT link,status FROM loan_application_generated_documents
      WHERE application_id=? AND kind='primary' AND contract_generation_id=? ORDER BY id DESC LIMIT 1`,
    [Number(row.loan_application_id), id]);
    if (!application || application.status === "rejected" ||
        !["primary_contract_pending_signature", "approved_contract_pending_signature"].includes(String(application.stage)) ||
        Number(application.current_primary_generation_id) !== id ||
        !["primary", TOMAN_REPLACEMENT_PURPOSE].includes(String(row.generation_purpose ?? "primary")) ||
        !document || String(document.link ?? "").startsWith("signed:") ||
        !["pending", "incomplete"].includes(String(document.status))) {
      res.status(409).json({ error: "contract_not_current" }); return;
    }
  }
  // A cached rejection is not enough: a late provider signature must never be reset.
  try {
    const observation = await emzameRequest(`contracts/${encodeURIComponent(String(row.provider_contract_id))}`, { method: "GET" });
    if (!observation.ok) { res.status(502).json({ error: "provider_status_failed" }); return; }
    const state = providerContractState(await observation.json());
    if (state.signed || !(rejectedBySigner(state.status ?? state.title) ||
        (repairFileReuse && String(state.status ?? "").toLowerCase() === "readyforsign"))) {
      res.status(409).json({ error: "provider_contract_not_rejected" }); return;
    }
    runImmediateTransaction(() => {
      const current = queryRow<any>("SELECT * FROM contract_generations WHERE id=?", [id]);
      if (!current || current.deleted_at || current.superseded_at || current.status !== "sent" ||
          current.send_claim_id || current.provider_contract_id !== row.provider_contract_id ||
          !(rejectedBySigner(current.provider_status) ||
            (repairFileReuse && rejectedDeliveryReusesFile(current, queryRow)))) {
        throw new Error("contract_state_changed");
      }
      if (current.loan_application_id != null) {
        const application = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [current.loan_application_id]);
        const document = queryRow<any>(`SELECT link,status FROM loan_application_generated_documents
          WHERE application_id=? AND kind='primary' AND contract_generation_id=? ORDER BY id DESC LIMIT 1`,
        [current.loan_application_id, id]);
        if (!application || application.status === "rejected" ||
            !["primary_contract_pending_signature", "approved_contract_pending_signature"].includes(String(application.stage)) ||
            Number(application.current_primary_generation_id) !== id ||
            !document || String(document.link ?? "").startsWith("signed:") ||
            !["pending", "incomplete"].includes(String(document.status))) {
          throw new Error("contract_state_changed");
        }
      }
      execute(`INSERT INTO contract_generation_rejected_deliveries
        (generation_id,provider_contract_id,provider_file_id,provider_status,sent_at,recorded_by,recorded_at)
        VALUES (?,?,?,?,?,?,?)`,
      [id, String(current.provider_contract_id), current.provider_file_id,
        String(state.status ?? state.title), current.sent_at, auth.id, now()]);
      const updated = crmDb.prepare(`UPDATE contract_generations
        SET status='generated',provider_file_id=NULL,provider_contract_id=NULL,provider_status=NULL,
            provider_idempotency_key=NULL,sent_at=NULL,error_message=NULL,updated_at=?
        WHERE id=? AND status='sent' AND provider_contract_id=?`)
        .run(now(), id, current.provider_contract_id);
      if (Number(updated.changes) !== 1) throw new Error("contract_state_changed");
    });
    res.json({ id, status: "generated" });
  } catch (err) {
    req.log.warn({ err, generationId: id }, "rejected contract resend preparation failed");
    res.status(409).json({ error: "contract_resend_preparation_failed" });
  }
});
router.get("/contracts/generations/:id/download/:kind", requirePermission("contracts.view"), async (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); let p: string | null = null; try { if (r) p = regularPath(req.params.kind === "pdf" ? String(r.pdf_path) : String(r.docx_path), "generations"); } catch { p = null; } if (!r || !p) return res.status(404).json({ error: "Generation not found" }); if (req.params.kind === "pdf" && req.query.preview === "1") { res.type("application/pdf"); res.setHeader("Content-Disposition", "inline"); return res.sendFile(p); } return res.download(p, `contract-${r.id}.${req.params.kind === "pdf" ? "pdf" : "docx"}`); });
router.get("/contracts/generations/:id", requirePermission("contracts.view"), (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); if (!r) return res.status(404).json({ error: "Generation not found" }); const customerId = Number(r.customer_id); return res.json({ id: r.id, templateId: r.template_id, templateName: r.template_name, customerId: r.customer_id, customerName: queryRow<any>(`SELECT ${survivorCustomerName("?")} name`, [customerId])?.name ?? null, customerSalespersonName: queryRow<any>(`SELECT ${survivorSalespersonName("?")} name`, [customerId])?.name ?? null, loanPlanId: r.loan_plan_id ?? null, loanApplicationId: r.loan_application_id ?? null, contractNumber: r.contract_number ?? null, status: r.status, supersededAt: r.superseded_at ?? null, providerFileId: r.provider_file_id, providerContractId: r.provider_contract_id, providerStatus: r.provider_status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, manualValues: json(r.manual_values_json, {}), docxUrl: downloadUrl(Number(r.id), "docx"), pdfUrl: r.pdf_path ? downloadUrl(Number(r.id), "pdf") : null }); });
router.get("/contracts/generations/:id", requirePermission("contracts.view"), (req, res) => { const r = assignedGeneration(Number(req.params.id), user(req, res)); if (!r) return res.status(404).json({ error: "Generation not found" }); const customerId = Number(r.customer_id); return res.json({ id: r.id, templateId: r.template_id, templateName: r.template_name, customerId: r.customer_id, customerName: queryRow<any>(`SELECT ${survivorCustomerName("?")} name`, [customerId])?.name ?? null, customerSalespersonName: queryRow<any>(`SELECT ${survivorSalespersonName("?")} name`, [customerId])?.name ?? null, loanPlanId: r.loan_plan_id ?? null, loanApplicationId: r.loan_application_id ?? null, contractNumber: r.contract_number ?? null, status: r.status, supersededAt: r.superseded_at ?? null, providerFileId: r.provider_file_id, providerContractId: r.provider_contract_id, providerStatus: r.provider_status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, manualValues: json(r.manual_values_json, {}), docxUrl: downloadUrl(Number(r.id), "docx"), pdfUrl: r.pdf_path ? downloadUrl(Number(r.id), "pdf") : null }); });
router.delete("/contracts/generations/:id", requirePermission("contracts.manage"), (req, res) => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  if (!row) return res.status(404).json({ error: "Generation not found" });
  if (row.status === "sending") return res.status(409).json({ error: "Generation is already being sent" });
  const result = crmDb.prepare("UPDATE contract_generations SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(), now(), id);
  if (Number(result.changes) !== 1) return res.status(404).json({ error: "Generation not found" });
  return res.status(204).end();
});
router.get("/contracts/generations", requirePermission("contracts.view"), (req, res) => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  const rows = queryRows<any>(`SELECT g.id,g.template_id,g.customer_id,g.loan_plan_id,g.loan_application_id,g.contract_number,g.status,g.superseded_at,g.pdf_path,g.provider_file_id,g.provider_contract_id,g.provider_status,g.created_at,g.updated_at,t.name template_name,
      ${survivorCustomerName("g.customer_id")} customer_name,
      ${survivorSalespersonName("g.customer_id")} customer_salesperson_name
    FROM contract_generations g JOIN contract_templates t ON t.id=g.template_id
    WHERE g.deleted_at IS NULL ${auth.customerScope === "assigned" ? `AND ${survivorSalespersonId("g.customer_id")}=?` : ""}
    ORDER BY g.created_at DESC`, auth.customerScope === "assigned" ? [auth.salespersonId] : []);
  return res.json(rows.map((row) => ({
    id: row.id, templateId: row.template_id, templateName: row.template_name, customerId: row.customer_id,
    customerName: row.customer_name ?? null, customerSalespersonName: row.customer_salesperson_name ?? null,
     loanPlanId: row.loan_plan_id ?? null, loanApplicationId: row.loan_application_id ?? null, contractNumber: row.contract_number ?? null,
    status: row.status, supersededAt: row.superseded_at ?? null, providerFileId: row.provider_file_id, providerContractId: row.provider_contract_id, providerStatus: row.provider_status,
    createdAt: row.created_at, updatedAt: row.updated_at,
    docxUrl: downloadUrl(row.id, "docx"), pdfUrl: row.pdf_path ? downloadUrl(row.id, "pdf") : null,
  })));
});

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, retry = false): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (retry && attempt === 0 && response.status >= 500) { await response.body?.cancel(); continue; }
      return response;
    } catch (error) { if (!retry || attempt > 0) throw error; }
    finally { clearTimeout(timer); }
  }
}
function certificateActive(body: any): boolean {
  const candidates = [body?.active, body?.isActive, body?.data?.active, body?.data?.isActive, body?.result?.active];
  const explicit = candidates.find((value) => typeof value === "boolean");
  if (typeof explicit === "boolean") return explicit;
  const certificate = body?.data && typeof body.data === "object" ? body.data : body;
  return Boolean(
    certificate
    && typeof certificate === "object"
    && String(certificate.nationalCode ?? "").trim()
    && String(certificate.phoneNumber ?? "").trim()
    && (String(certificate.firstName ?? "").trim() || String(certificate.lastName ?? "").trim()),
  );
}
function latinDigits(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}
function normalizeIranNationalCode(value: unknown): string | null {
  const normalized = latinDigits(value).replace(/[\s-]/g, "");
  return /^\d{10}$/.test(normalized) ? normalized : null;
}
function normalizeIranMobile(value: unknown): string | null {
  let normalized = latinDigits(value).replace(/[\s().-]/g, "");
  if (normalized.startsWith("+98")) normalized = `0${normalized.slice(3)}`;
  else if (normalized.startsWith("0098")) normalized = `0${normalized.slice(4)}`;
  else if (/^98\d{10}$/.test(normalized)) normalized = `0${normalized.slice(2)}`;
  else if (/^9\d{9}$/.test(normalized)) normalized = `0${normalized}`;
  return /^09\d{9}$/.test(normalized) ? normalized : null;
}
function safeProviderPdfFilename(title: string, fallback: string): string {
  const basename = title
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return `${basename || fallback}.pdf`;
}
function providerErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["persianMessage", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && value.length <= 500) return value.trim();
  }
  return undefined;
}
function providerResponsePaths(body: unknown): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (depth > 4 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      paths.add(`${prefix}[]`);
      if (value.length) visit(value[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      visit(child, path, depth + 1);
    }
  };
  visit(body, "", 0);
  return [...paths].slice(0, 80);
}
router.get("/contracts/generations/:id/check-status", requirePermission("contracts.view"), async (req, res): Promise<void> => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  if (row.superseded_at) { res.status(409).json({ error: "generation_superseded" }); return; }
  if (!row.provider_contract_id) { res.status(409).json({ error: "Contract has not been sent" }); return; }
  const linkedPrimary = queryRow<any>(`SELECT a.* FROM loan_application_generated_documents d
    JOIN loan_applications a ON a.id=d.application_id
    WHERE d.kind='primary' AND d.contract_generation_id=? ORDER BY d.id DESC LIMIT 1`, [id]);
  if (linkedPrimary && !isCurrentApplicationPrimaryGeneration(linkedPrimary, id)) {
    res.status(409).json({ error: "primary_generation_not_current" }); return;
  }
  try {
    const response = await emzameRequest(`contracts/${encodeURIComponent(String(row.provider_contract_id))}`, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("provider_status_failed");
    const state = providerContractState(body);
    if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed");
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      id,
      kind: queryRow<{ kind: string }>(
        "SELECT kind FROM loan_application_generated_documents WHERE contract_generation_id=? ORDER BY id DESC LIMIT 1",
        [id],
      )?.kind ?? null,
      providerStatus: state.status ?? (state.signed ? "signed" : null),
      providerStatusTitle: state.title,
      signed: state.signed,
      checkedAt: now(),
      readOnly: true,
    });
  } catch (err) {
    req.log.warn({ err, generationId: id }, "contract read-only signature status lookup failed");
    res.status(502).json({ error: "provider_status_failed" });
  }
});

router.post("/contracts/generations/:id/check-status", requirePermission("contracts.view"), async (req, res): Promise<void> => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  if (auth.role === "salesperson") { res.status(403).json({ error: "read_only_signature_status" }); return; }
  if (row.superseded_at) { res.status(409).json({ error: "generation_superseded" }); return; }
  if (!row.provider_contract_id) { res.status(409).json({ error: "Contract has not been sent" }); return; }
  const linkedPrimary = queryRow<any>(`SELECT a.* FROM loan_application_generated_documents d
    JOIN loan_applications a ON a.id=d.application_id
    WHERE d.kind='primary' AND d.contract_generation_id=? ORDER BY d.id DESC LIMIT 1`, [id]);
  if (linkedPrimary && !isCurrentApplicationPrimaryGeneration(linkedPrimary, id)) {
    res.status(409).json({ error: "primary_generation_not_current" }); return;
  }
  let providerObserved = false;
  try {
    const response = await emzameRequest(`contracts/${encodeURIComponent(String(row.provider_contract_id))}`, {
      method: "GET",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("provider_status_failed");
    const state = providerContractState(body);
    if (!state.status && !state.title && !state.signed) throw new Error("provider_status_failed");
    providerObserved = true;
    const checkedAt = now();
    const linkedDocuments = queryRows<{ id: number }>(
      "SELECT id FROM loan_application_generated_documents WHERE contract_generation_id=? ORDER BY id",
      [id],
    );
    let applications: Array<ReturnType<typeof applyGeneratedDocumentSignatureObservation>> = [];
    if (linkedDocuments.length) {
      applications = linkedDocuments.map((document) => applyGeneratedDocumentSignatureObservation(document.id, body));
    } else {
      const providerStatus = state.status ?? state.title ?? (state.signed ? "signed" : null);
      crmDb.prepare(
        "UPDATE contract_generations SET provider_status=?,status=CASE WHEN ? THEN 'signed' ELSE status END,updated_at=? WHERE id=?",
      ).run(providerStatus, state.signed ? 1 : 0, checkedAt, id);
    }
    const advanced = applications.find((application) => application.workflowAdvanced);
    res.json({
      id,
      providerStatus: state.status,
      providerStatusTitle: state.title,
      signed: state.signed,
      checkedAt,
      workflowAdvanced: Boolean(advanced),
      nextStage: advanced?.nextStage ?? null,
    });
  } catch (err) {
    req.log.warn({ err, generationId: id }, "contract signature status refresh failed");
    res.status(providerObserved ? 500 : 502).json({
      error: providerObserved ? "signature_processing_failed" : "provider_status_failed",
    });
  }
});
const sendGenerationHandler = async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id); const auth = user(req, res); const row = assignedGeneration(id, auth);
  reconcileGenerations();
  if (!row) { res.status(404).json({ error: "Generation not found" }); return; }
  if (row.superseded_at) { res.status(409).json({ error: "generation_superseded" }); return; }
  const alreadySent = ["sent", "signed"].includes(String(row.status)) && Boolean(row.provider_contract_id);
  if (row.loan_application_id != null) {
    if (!["admin", "salesperson"].includes(auth.role)) { res.status(403).json({ error: "action_forbidden" }); return; }
    const app = queryRow<any>("SELECT * FROM loan_applications WHERE id=? AND deleted_at IS NULL", [Number(row.loan_application_id)]);
    const selectedPlan = app && json<any>(app.plan_snapshot_json, {});
    if (!app) { res.status(409).json({ error: "application_generation_not_current" }); return; }
    const generationPurpose = String(row.generation_purpose ?? "primary");

    const tomanConsent = generationPurpose === TOMAN_REPLACEMENT_PURPOSE
      ? activeTomanReplacementConsent(app) : null;
    const appId = Number(app.id);
    const isLinkedAmendment = Boolean(queryRow<any>(`SELECT 1 FROM loan_application_generated_documents d
      WHERE d.application_id=? AND d.kind='amendment' AND d.contract_generation_id=?
        AND d.id=(SELECT MAX(latest.id) FROM loan_application_generated_documents latest
          WHERE latest.application_id=d.application_id AND latest.kind='amendment')`,
    [appId, id]));
    const amendmentGeneration = generationPurpose === "amendment" || isLinkedAmendment ||
      (app.stage === "funder_amendment_pending_signature" && alreadySent);
    const expectedTemplateId = Number(selectedPlan?.contract_template_id ?? selectedPlan?.primary_contract_template_id);
    const applicationScopeMatches = Number(row.loan_application_id) === appId &&
      Number(app.customer_id) === Number(row.customer_id) &&
      Number(app.plan_id) === Number(row.loan_plan_id) &&
      (generationPurpose === TOMAN_REPLACEMENT_PURPOSE
        ? Boolean(tomanConsent && Number(row.template_id) === tomanConsent.tomanTemplateId)
        : Number(expectedTemplateId) === Number(row.template_id));
    const currentPurposeGeneration = queryRow<any>(`SELECT id FROM contract_generations
      WHERE loan_application_id=? AND generation_purpose=? AND deleted_at IS NULL AND superseded_at IS NULL`,
    [appId, generationPurpose]);

    if (amendmentGeneration) {
      const amendmentStage = app.stage === "funder_amendment_pending_signature" ||
        (alreadySent && ["funder_amendment_review", "funder_result_review", "physical_documents_review",
          "physical_documents_correction", "funder_documents_correction", "wallet_charge_pending",
          "admin_approval", "final_invoice_pending_signature", "completed"].includes(String(app.stage)));
      const purposeGenerationCurrent = Number(currentPurposeGeneration?.id) === id;
      if (app.status === "rejected" || !applicationScopeMatches || !amendmentStage ||
          row.deleted_at || row.superseded_at || !purposeGenerationCurrent) {
        res.status(409).json({ error: "amendment_generation_not_current" }); return;
      }
      if (Number(app.new_case_workflow) === 1 && generationPurpose === "amendment") {
        const expectedAmount = String(app.approved_amount ?? "");
        const principalEvidence = renderedPdfContainsPrincipal(row.pdf_path, expectedAmount, principalTemplateEvidence(row));
        if (app.initial_approval_at && Number(app.duration_months) !== Number(app.requested_duration_months ?? app.duration_months) &&
            !renderedPdfContainsInstallmentCount(row.pdf_path, Number(app.duration_months), principalTemplateEvidence(row))) {
          res.status(409).json({ error: "rendered_installment_count_unverifiable" }); return;
        }
        if (!principalEvidence) {
          res.status(409).json({ error: "rendered_amendment_principal_unverifiable" }); return;
        }
        if (!preapprovedGenerationMatches(app, row, expectedAmount, true)) {
          res.status(409).json({ error: "amendment_generation_scope_mismatch" }); return;
        }
      }
    } else if (generationPurpose === TOMAN_REPLACEMENT_PURPOSE) {
      const purposeGenerationCurrent = Number(currentPurposeGeneration?.id) === id;
      if (!tomanConsent || app.stage !== "approved_contract_pending_signature" ||
          app.status === "rejected" || !applicationScopeMatches || !purposeGenerationCurrent ||
          row.deleted_at || row.superseded_at ||
          (app.current_primary_generation_id != null &&
            Number(app.current_primary_generation_id) !== tomanConsent.sourceGenerationId &&
            Number(app.current_primary_generation_id) !== id)) {
        res.status(409).json({ error: "toman_replacement_generation_not_current" }); return;
      }
      if (!tomanReplacementDocumentTermsMatch(app, row, tomanConsent, true)) {
        res.status(409).json({ error: "toman_replacement_terms_unverifiable" }); return;
      }
    } else if (generationPurpose === "primary") {
      if (app.current_primary_generation_id != null && Number(app.current_primary_generation_id) !== id) {
        res.status(409).json({ error: "primary_generation_not_current" }); return;
      }
      const purposeGenerationCurrent = Number(currentPurposeGeneration?.id) === id;
      if (app.status === "rejected" || !applicationScopeMatches || !purposeGenerationCurrent) {
        res.status(409).json({ error: "primary_generation_not_current" }); return;
      }
      if (Number(app.new_case_workflow) === 1 ||
          (Boolean(app.initial_approval_at) && app.stage === "approved_contract_pending_signature") ||
          (app.legacy_reopen_prior_stage != null && !app.initial_approval_at)) {
        const expectedAmount = app.initial_approval_at ? String(app.approved_amount ?? "") : String(app.requested_amount ?? "");
        const stageAllowed = alreadySent || (app.initial_approval_at
          ? app.stage === "approved_contract_pending_signature"
          : ["draft", "primary_contract_pending_signature"].includes(String(app.stage)));
        const principalEvidence = renderedPdfContainsPrincipal(row.pdf_path, expectedAmount, principalTemplateEvidence(row));
        if (app.initial_approval_at && Number(app.duration_months) !== Number(app.requested_duration_months ?? app.duration_months) &&
            !renderedPdfContainsInstallmentCount(row.pdf_path, Number(app.duration_months), principalTemplateEvidence(row))) {
          res.status(409).json({ error: "rendered_installment_count_unverifiable" }); return;
        }
        if (!stageAllowed || !principalEvidence) {
          res.status(409).json({ error: !principalEvidence
            ? "rendered_primary_principal_unverifiable" : "primary_generation_not_current" }); return;
        }
        if (!preapprovedGenerationMatches(app, row, expectedAmount, true)) {
          res.status(409).json({ error: "primary_generation_not_current" }); return;
        }
      } else if (app.initial_approval_at) {
        const rejectedDeliveryRetry = app.stage === "primary_contract_pending_signature" &&
          Number(app.current_primary_generation_id) === id &&
          Boolean(queryRow("SELECT 1 FROM contract_generation_rejected_deliveries WHERE generation_id=? LIMIT 1", [id]));
        if (!preapprovedGenerationMatches(app, row, undefined, true) ||
            (!alreadySent && app.stage !== "draft" && !rejectedDeliveryRetry)) {
          res.status(409).json({ error: "approved_primary_generation_not_sendable" }); return;
        }
      } else {
        res.status(409).json({ error: "primary_generation_stage_required" }); return;
      }
    } else {
      res.status(409).json({ error: "application_generation_purpose_invalid" }); return;
    }
  } else {
    const linkedApplication = queryRow<any>(`SELECT a.*
      FROM loan_application_generated_documents d JOIN loan_applications a ON a.id=d.application_id
      WHERE d.kind='primary' AND d.contract_generation_id=? ORDER BY d.id DESC LIMIT 1`, [id]);
    if (linkedApplication && (linkedApplication.deleted_at || linkedApplication.status === "rejected" ||
        !isCurrentApplicationPrimaryGeneration(linkedApplication, id))) {
      res.status(409).json({ error: "primary_generation_not_current" }); return;
    }
  }
  if (alreadySent) {
    res.json({ id, status: row.status, providerContractId: row.provider_contract_id, providerFileId: row.provider_file_id }); return;
  }
  if (!row.pdf_path) { res.status(409).json({ error: "PDF is not available" }); return; }
  const claimId = crypto.randomUUID(); const claimExpires = new Date(Date.now() + 10 * 60_000).toISOString();
  const claimed = crmDb.prepare("UPDATE contract_generations SET status='sending',send_claim_id=?,send_claim_expires_at=?,error_message=NULL,updated_at=? WHERE id=? AND (status IN ('generated','failed') OR (status='sending' AND send_claim_expires_at < ?))").run(claimId, claimExpires, now(), id, now());
  if (Number(claimed.changes) !== 1) { res.status(409).json({ error: "Generation is already being sent" }); return; }
  let deliveryStage = "configuration";
  let providerHttpStatus: number | undefined;
  let providerResponseKeys: string[] | undefined;
  let providerMessage: string | undefined;
  try {
    const base = (process.env.EMZAME_BASE_URL || "https://core.emzame.com/api/v1/backoffice").replace(/\/+$/, "");
    const businessId = process.env.EMZAME_BUSINESS_ID?.trim(); if (!businessId) throw new Error("provider_configuration");
    const c = customer(Number(row.customer_id)); if (!c || !String(c.name ?? "").trim()) throw new Error("collaborator_required");
    const customerName = String(c.name).trim();
    let providerTitle = `contract-${id}`;
    if (row.loan_plan_id != null) {
      const selectedPlan = queryRow<{ name: string }>("SELECT name FROM loan_plans WHERE id=?", [Number(row.loan_plan_id)]);
      const planName = String(selectedPlan?.name ?? "").trim();
      if (!planName) throw new Error("loan_plan_required");
      providerTitle = `قرارداد طرح ${planName} - ${customerName}`;
    }
    const collaboratorNationalCode = normalizeIranNationalCode(c.national_code);
    const collaboratorPhone = normalizeIranMobile(c.phone);
    if (!collaboratorNationalCode || !collaboratorPhone) throw new Error("collaborator_invalid");
    const pdfPath = regularPath(String(row.pdf_path), "generations"); const pdf = await fsp.readFile(pdfPath);
    if (!row.pdf_sha256 || sha(pdf) !== String(row.pdf_sha256)) throw new Error("artifact_integrity");
    deliveryStage = "authentication";
    const token = await emzameAuth(base); const headers = { authorization: `Bearer ${token}` };
    deliveryStage = "certificate_check";
    const certPath = process.env.EMZAME_CERTIFICATE_PATH || "users/checkUserActiveCertificate/";
    const certUrl = `${base}/${certPath.replace(/^\/+/, "")}${certPath.includes("?") ? "&" : "?"}nationalCode=${encodeURIComponent(collaboratorNationalCode)}`;
    const cert = await fetchWithTimeout(certUrl, { method: "GET", headers }, 20_000, true); const certBody = await cert.json().catch(() => ({}));
    providerHttpStatus = cert.status;
    if (cert.status === 404) throw new Error("certificate_inactive");
    if (!cert.ok) throw new Error("provider_certificate_check_failed");
    if (!certificateActive(certBody)) throw new Error("certificate_inactive");
    let fileId = row.provider_file_id ? String(row.provider_file_id) : "";
    const idempotency = row.provider_idempotency_key ? String(row.provider_idempotency_key) : crypto.randomUUID();
    if (!row.provider_idempotency_key) crmDb.prepare("UPDATE contract_generations SET provider_idempotency_key=?,updated_at=? WHERE id=? AND send_claim_id=?").run(idempotency, now(), id, claimId);
    if (!fileId) {
      deliveryStage = "file_upload";
      const form = new FormData();
      form.append("file", new Blob([pdf], { type: "application/pdf" }), safeProviderPdfFilename(providerTitle, `contract-${id}`));
      form.append("name", providerTitle);
      const uploaded = await fetchWithTimeout(`${base}/files`, { method: "POST", headers: { ...headers, "X-Idempotency-Key": idempotency }, body: form }, 60_000, true); const uploadedBody = await uploaded.json().catch(() => ({})) as any;
      providerResponseKeys = providerResponsePaths(uploadedBody);
      fileId = providerId(uploadedBody, ["fileId", "id", "file_id"]) || "";
      providerHttpStatus = uploaded.status;
      if (!uploaded.ok || !fileId) throw new Error("provider_file_upload_failed");
      crmDb.prepare("UPDATE contract_generations SET provider_file_id=?,updated_at=? WHERE id=? AND send_claim_id=?").run(fileId, now(), id, claimId);
    }
    const collaborator = { status: "checked", fullName: customerName, nationalCode: collaboratorNationalCode, phoneNumber: collaboratorPhone, order: 1 };
    const sendBody = {
       collaboratorList: [collaborator], title: providerTitle, provider: process.env.EMZAME_PROVIDER || "gica",
      signType: process.env.EMZAME_SIGN_TYPE || "e-sign", isBlankPageRequired: false,
       isElectronicSignatureRequired: true, isSignatureDescriptionRequired: true,
       shouldEveryPageHaveSignatureImage: true, staticFileId: fileId, businessId: businessId,
    };
    deliveryStage = "contract_send";
    const sent = await fetchWithTimeout(`${base}/contracts/sendContract`, { method: "POST", headers: { ...headers, "content-type": "application/json", "X-Idempotency-Key": idempotency }, body: JSON.stringify(sendBody) }, 60_000); const sentBody = await sent.json().catch(() => ({})) as any;
    providerHttpStatus = sent.status;
    providerResponseKeys = providerResponsePaths(sentBody);
    providerMessage = providerErrorMessage(sentBody);
    const contractId = providerId(sentBody, ["contractId", "id", "contract_id"]);
    if (!sent.ok || !contractId) throw new Error("provider_contract_send_failed");
    const providerStatus = String(sentBody.status ?? sentBody.data?.status ?? "sent");

    const sentAt = now();
    const persisted = crmDb.prepare(
      "UPDATE contract_generations SET status='sent',provider_file_id=?,provider_contract_id=?,provider_status=?,sent_at=?,send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NULL AND provider_contract_id IS NULL",
    ).run(fileId, contractId, providerStatus, sentAt, sentAt, id);
    if (Number(persisted.changes) !== 1) {
      const existing = queryRow<any>("SELECT provider_file_id,provider_contract_id,status FROM contract_generations WHERE id=? AND deleted_at IS NULL", [id]);
      if (!existing?.provider_contract_id) throw new Error("provider_state_persist_failed");
      res.json({ id, status: existing.status, providerFileId: existing.provider_file_id, providerContractId: existing.provider_contract_id });
      return;
    }
    res.json({ id, status: "sent", providerFileId: fileId, providerContractId: contractId });
  } catch (e) {
    const knownCodes = [
      "provider_configuration", "provider_auth_failed", "provider_certificate_check_failed",
      "provider_file_upload_failed", "provider_contract_send_failed", "collaborator_required",
      "collaborator_invalid", "artifact_integrity", "certificate_inactive", "provider_state_persist_failed",
      "loan_plan_required",
    ];
    let code = e instanceof Error && knownCodes.includes(e.message) ? e.message : "provider_delivery_failed";
    if (e instanceof Error && e.name === "AbortError") code = "provider_timeout";
    else if (e instanceof TypeError) code = "provider_unavailable";
    req.log.error({ err: e, generationId: id, stage: deliveryStage, providerHttpStatus, providerResponseKeys, providerMessage, code }, "contract delivery failed");
    crmDb.prepare("UPDATE contract_generations SET status='failed',error_message=?,send_claim_id=NULL,send_claim_expires_at=NULL,updated_at=? WHERE id=? AND send_claim_id=?").run(code, now(), id, claimId);
    const status = code === "certificate_inactive" || code === "collaborator_required" || code === "collaborator_invalid"
      ? 422
      : code === "artifact_integrity" || code === "provider_state_persist_failed" || code === "loan_plan_required"
        ? 409
        : code === "provider_configuration"
          ? 503
          : 502;
    res.status(status).json({ error: code, ...(providerMessage ? { message: providerMessage } : {}) });
  }
};
router.post("/contracts/generations/:id/send", requirePermission("contracts.send"), sendGenerationHandler);

registerContractHandlers({ generate: generateContractHandler, send: sendGenerationHandler });

export default router;

function tomanReplacementDocumentTermsMatch(
  application: any,
  generation: any,
  consent: TomanReplacementConsent,
  allowCertificateRetry = false,
): boolean {
  if (allowCertificateRetry && isCertificatePreflightRetry(generation)) {
    try {
      const pdf = fs.realpathSync(String(generation.pdf_path));
      const stat = fs.lstatSync(String(generation.pdf_path));
      if (!stat.isFile() || stat.isSymbolicLink() ||
          sha(fs.readFileSync(pdf)) !== String(generation.pdf_sha256)) return false;
    } catch { return false; }
  }
  return tomanReplacementGenerationTermsMatch(generation, application, consent, allowCertificateRetry) &&
    renderedPdfContainsPrincipal(generation.pdf_path, consent.approvedAmount, principalTemplateEvidence(generation)) &&
    (!tomanReplacementNeedsInstallmentProof(application, json(generation.mappings_snapshot_json, null)) ||
      renderedPdfContainsInstallmentCount(generation.pdf_path, consent.durationMonths, principalTemplateEvidence(generation)));
}

function activeTomanReplacementConsent(application: any): TomanReplacementConsent | null {
  if (!application || application.status === "rejected" ||
      application.stage !== "approved_contract_pending_signature") return null;
  const consent = latestTomanReplacementConsent(Number(application.id));
  if (!consent || String(application.approved_amount ?? "") !== consent.approvedAmount ||
      Number(application.duration_months) !== consent.durationMonths) return null;
  if (application.current_primary_generation_id != null &&
      Number(application.current_primary_generation_id) !== consent.sourceGenerationId) {
    const currentGeneration = queryRow<any>(`SELECT generation_purpose,template_id,loan_application_id,superseded_at,deleted_at
      FROM contract_generations WHERE id=?`, [Number(application.current_primary_generation_id)]);
    if (!currentGeneration ||
        Number(currentGeneration.loan_application_id) !== Number(application.id) ||
        Number(currentGeneration.template_id) !== consent.tomanTemplateId ||
        String(currentGeneration.generation_purpose) !== TOMAN_REPLACEMENT_PURPOSE ||
        currentGeneration.superseded_at || currentGeneration.deleted_at) return null;
  }
  const plan = queryRow<any>("SELECT active,contract_template_id,primary_contract_template_id FROM loan_plans WHERE id=?",
    [Number(application.plan_id)]);
  const template = queryRow<any>("SELECT id,storage_path,sha256 FROM contract_templates WHERE id=? AND deleted_at IS NULL",
    [consent.tomanTemplateId]);
  if (!plan || Number(plan.active) !== 1 ||
      ![Number(plan.contract_template_id), Number(plan.primary_contract_template_id)].includes(consent.tomanTemplateId) ||
      !template || !isAttestedTomanTemplate(template.id, template.storage_path, templateDir, template.sha256)) return null;
  return consent;
}

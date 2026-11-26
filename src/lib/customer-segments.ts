/**
 * t878 «گزارش مشتریان» — read-only customer segmentation across the customer file
 * (dossier / first-call / consult) and website forms (site_apply / public_leads / callback).
 * flag.customer_segments_v1 absent or ≠ '1' = OFF. Never writes customer data.
 * The only write is the export audit table, created on first export when the flag is on.
 */
import { execute, queryRow, queryRows } from "./crm-db";
import type { AuthUser } from "./auth";
import { isSalesManagerUser } from "./sales-manager";
import { smcAccessScope } from "./smc-access-scope";
import { buildXlsx } from "./customer-segments-xlsx";
import { tehranJalaliFileDay } from "./jalali-file-day";

export const SEGMENTS_FLAG = "flag.customer_segments_v1";
export const EXPORT_AUDIT_TABLE = "customer_segment_export_log";

export function segmentsOn(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [SEGMENTS_FLAG])?.value === "1";
  } catch {
    return false;
  }
}

/**
 * «مشتری خود» = customers.salesperson_id of the current owner equals the viewer's users.salesperson_id.
 * Same rule as the rest of the CRM when customerScope === "assigned" (customer list, consult report, loan files, …).
 * Not registered_by, not the first-call author. Merged customers are excluded.
 * Unlinked site leads (callback without customer_id) have no owner and are visible only to admin / sales_manager.
 * Admin and sales_manager (effective role admin) see everyone. Salespersons and trainees (salesperson role) see only their own.
 * Registrar and other roles cannot use this report.
 */
export type ActorScope = { kind: "all" } | { kind: "team"; salespersonIds: Set<number> } | { kind: "own"; salespersonId: number };

export class SegmentScopeError extends Error {
  status = 403;
  error = "Forbidden";
  publicMessage: string;
  constructor(message: string) {
    super(message);
    this.publicMessage = message;
  }
}

export function actorScope(u: AuthUser | null | undefined): ActorScope | null {
  if (!u) return null;
  if (u.role === "admin" || isSalesManagerUser(u)) return { kind: "all" };
  if (u.role === "salesperson") {
    const smc = smcAccessScope(u, "customers");
    if (smc.kind === "all") return { kind: "all" };
    if (smc.kind === "team") return { kind: "team", salespersonIds: smc.salespersonIds };
    if (u.salespersonId != null) return { kind: "own", salespersonId: Number(u.salespersonId) };
  }
  return null;
}

export function isSegmentsViewer(u: AuthUser | null | undefined): boolean {
  return actorScope(u) != null;
}

/** 403 if an assigned viewer asks for another owner's customers or another customer's id. */
export function assertQueryScope(q: SegmentQuery, scope: ActorScope): void {
  if (scope.kind === "all") return;
  const allowed = scope.kind === "own" ? new Set([scope.salespersonId]) : scope.salespersonIds;
  const msg = scope.kind === "own"
    ? "فقط مشتری‌های خودتان را می‌توانید ببینید یا خروجی بگیرید."
    : "فقط مشتری‌های تیم خودتان را می‌توانید ببینید یا خروجی بگیرید.";
  for (const c of q.conditions) {
    if (c.field === "ownerId") {
      const vals = (c.values ?? []).map(String).filter(Boolean);
      if (c.op === "exists" || c.op === "not_exists") continue;
      if (vals.length && vals.some((v) => !allowed.has(Number(v)))) {
        throw new SegmentScopeError(msg);
      }
    }
    if (c.field === "customerId") {
      const ids: number[] = [];
      for (const v of c.values ?? []) { const n = Number(v); if (Number.isFinite(n)) ids.push(n); }
      const min = c.min == null || c.min === "" ? null : Number(c.min);
      const max = c.max == null || c.max === "" ? null : Number(c.max);
      if (c.op === "eq" || c.op === "in") {
        for (const id of ids) {
          const row = queryRow<{ salesperson_id: number | null }>("SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]);
          if (!row || row.salesperson_id == null || !allowed.has(Number(row.salesperson_id))) {
            throw new SegmentScopeError(msg);
          }
        }
      }
      if (c.op === "range" && (min != null || max != null)) {
        // Range of ids could include others; refuse rather than silently widen.
        throw new SegmentScopeError(msg);
      }
    }
  }
}

export function applyActorScope(rows: Profile[], scope: ActorScope): Profile[] {
  if (scope.kind === "all") return rows;
  if (scope.kind === "team") return rows.filter((p) => p.kind === "customer" && p.ownerId != null && scope.salespersonIds.has(Number(p.ownerId)));
  const own = String(scope.salespersonId);
  return rows.filter((p) => p.kind === "customer" && p.ownerId === own);
}

const tableOk = (name: string): boolean => {
  try { return !!queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]); }
  catch { return false; }
};

const colOk = (table: string, col: string): boolean => {
  try { return queryRows<{ name: string }>(`PRAGMA table_info(${table})`).some((r) => r.name === col); }
  catch { return false; }
};

export function ensureExportAuditSchema(): void {
  execute(`CREATE TABLE IF NOT EXISTS ${EXPORT_AUDIT_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER NOT NULL,
    actor_name TEXT,
    actor_role TEXT,
    filter_json TEXT NOT NULL,
    columns_json TEXT,
    row_count INTEGER NOT NULL,
    include_phones INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
}

function parseJson(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
function parseArr(s: string | null | undefined): unknown[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const nonempty = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "null";
  if (Array.isArray(v)) return v.length > 0;
  return true;
};
const yn = (v: unknown): "yes" | "no" | "" => {
  const s = str(v).toLowerCase();
  if (s === "yes" || s === "1" || s === "true") return "yes";
  if (s === "no" || s === "0" || s === "false") return "no";
  return "";
};

/** Canonical job for cross-source filters. */
export const JOB_CANON: Record<string, string> = {
  retired: "retired",
  employee: "employee",
  employee_with_insurance: "employee",
  employee_no_insurance: "employee",
  self_employed: "self_employed",
  business: "self_employed",
  no_fixed_income: "no_fixed_income",
  unemployed: "no_fixed_income",
  no_doc: "no_doc",
  unknown: "unknown",
};
export function canonJob(v: unknown): string {
  const s = str(v);
  return JOB_CANON[s] || (s ? "other" : "");
}

export const LABELS = {
  job: { employee: "کارمند", retired: "بازنشسته", self_employed: "آزاد", no_fixed_income: "بدون درآمد ثابت", no_doc: "بدون مدرک شغلی", unknown: "نامشخص", other: "سایر" } as Record<string, string>,
  jobRaw: {
    employee: "کارمند", retired: "بازنشسته", self_employed: "آزاد", no_fixed_income: "بدون درآمد ثابت",
    employee_with_insurance: "کارمند با بیمه", employee_no_insurance: "کارمند بدون بیمه", business: "کسب‌وکار",
    no_doc: "بدون مدرک شغلی", unemployed: "بیکار", unknown: "نامشخص",
  } as Record<string, string>,
  yn: { yes: "بله", no: "خیر" } as Record<string, string>,
  military: { yes: "دارد", no: "ندارد", not_applicable: "مشمول نیست", female: "خانم", has_card: "دارد", no_card: "ندارد", unknown: "نامشخص" } as Record<string, string>,
  purpose: { goods: "خرید کالا", wedding: "جهیزیه و ازدواج", medical: "درمان", home: "خانه و تعمیرات", business: "کسب‌وکار", other: "کار دیگر", cash_goods: "نقدی / کالا" } as Record<string, string>,
  amountRange: {
    up_to_50m: "تا ۵۰ میلیون تومان", "50m_100m": "۵۰ تا ۱۰۰ میلیون تومان", "100m_300m": "۱۰۰ تا ۳۰۰ میلیون تومان",
    "300m_500m": "۳۰۰ تا ۵۰۰ میلیون تومان", over_500m: "بیشتر از ۵۰۰ میلیون تومان", not_sure: "هنوز نمی‌داند",
  } as Record<string, string>,
  timing: { this_week: "همین هفته", this_month: "این ماه", just_browsing: "فقط بررسی می‌کند", now: "همین حالا", later: "بعداً", curious: "کنجکاو", month: "این ماه" } as Record<string, string>,
  need: { cash: "نقد", goods: "کالا", help: "مشاوره / راهنمایی" } as Record<string, string>,
  contact: { morning: "صبح", evening: "عصر", any: "هر ساعت", now: "الان" } as Record<string, string>,
  docs: { payslip: "فیش حقوقی", salary_deduction_cert: "گواهی کسر از حقوق", sayadi_cheque: "چک صیادی", guarantor: "ضامن", none: "هیچ‌کدام", national_card: "کارت ملی", birth_cert: "شناسنامه", retirement_decree: "حکم بازنشستگی", sayadi_or_promissory: "چک صیادی یا سفته" } as Record<string, string>,
  docsReady: { all: "کامل", partial: "ناقص", none: "هیچ‌کدام" } as Record<string, string>,
  status: { in_progress: "در جریان", cancelled: "لغو شده", completed: "تکمیل شده" } as Record<string, string>,
  priority: { "1": "اولویت ۱", "2": "اولویت ۲", "3": "اولویت ۳", P1: "اولویت ۱", P2: "اولویت ۲", P3: "اولویت ۳" } as Record<string, string>,
  verification: { unverified: "تأیید نشده", verified: "تأیید شده", failed: "ناموفق" } as Record<string, string>,
  leadSource: { site: "سایت", inbound_call: "تماس ورودی", instagram: "اینستاگرام", other: "سایر", none: "نامشخص" } as Record<string, string>,
  regSource: { site_lead: "سرنخ سایت", staff_form: "فرم کارشناس", portal: "پورتال" } as Record<string, string>,
  custSource: { form: "فرم", staff: "کارشناس", instagram: "اینستاگرام", site: "سایت" } as Record<string, string>,
  loanStatus: { requested: "درخواست شده", reviewing: "در بررسی", approved: "تأیید شده", rejected: "رد شده" } as Record<string, string>,
  funder: { approved: "تأیید تأمین‌کننده", rejected: "رد تأمین‌کننده" } as Record<string, string>,
  sso: { none: "خیر", self: "خودش بازنشسته تأمین اجتماعی است", family: "بستهٔ خانواده‌اش بازنشسته است" } as Record<string, string>,
  checkStatus: { any: "دارد", none: "ندارد", physical: "چک فیزیکی", digital: "چک دیجیتال", both: "هر دو" } as Record<string, string>,
  siteOutcome: { new_customer: "مشتری جدید", existing_customer: "مشتری قبلی" } as Record<string, string>,
  callbackStatus: { new: "جدید", in_progress: "در حال پیگیری", done: "انجام شده", cancelled: "لغو شده" } as Record<string, string>,
  sourceName: {
    dossier: "پرونده", first_call: "فرم تماس اول", consult: "فرم مشاوره", site: "فرم سایت",
    lead: "سرنخ سایت", callback: "درخواست تماس سایت", customer: "مشتری", cs: "خلاصه تماس", loan: "پرونده تسهیلات",
  } as Record<string, string>,
  loanStage: {
    draft: "پیش‌نویس", primary_contract_pending_signature: "در انتظار امضای قرارداد توسط مشتری",
    approved_contract_pending_signature: "امضای قرارداد جایگزین توسط مشتری",
    customer_documents_upload: "بارگذاری مدارک مشتری", customer_documents_review: "بررسی مدارک مشتری",
    guarantor_registration: "ثبت ضامن", funder_initial_approval: "تصویب مبلغ وام",
    guarantor_documents_upload: "بارگذاری مدارک ضامن", guarantor_documents_review: "بررسی مدارک ضامن",
    collateral_upload: "بارگذاری وثیقه", collateral_review: "بررسی وثیقه",
    physical_documents_correction: "رفع نقص مدارک فیزیکی", physical_documents_submission: "ارسال مدارک فیزیکی",
    physical_documents_review: "بررسی مدارک فیزیکی", expert_approval: "ثبت تصمیم تأمین‌کننده مالی",
    funder_documents_correction: "اصلاح مدارک مردود تأمین‌کننده", funder_result_review: "بررسی نتیجه تأمین‌کننده",
    funder_amendment_pending_signature: "در انتظار امضای الحاقیه", funder_amendment_review: "بررسی الحاقیه",
    admin_approval: "تأیید نهایی مدیر و شارژ اعتبار", wallet_charge_pending: "در انتظار تأیید شارژ توسط کارشناس ثبت",
    final_invoice_pending_signature: "امضای صورت‌حساب نهایی", completed: "تکمیل شده",
  } as Record<string, string>,
};

export type FieldType = "enum" | "multi_enum" | "text" | "number" | "date" | "yn" | "bool";
export type FieldCatalog = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  ops: Array<"in" | "eq" | "contains" | "range" | "date_range" | "exists" | "not_exists">;
  options?: Array<{ value: string; label: string }>;
  defaultColumn?: boolean;
  sensitive?: "phone" | "national";
  description?: string;
};

const opt = (map: Record<string, string>, extra: string[] = []) =>
  [...Object.entries(map).map(([value, label]) => ({ value, label })), ...extra.map((v) => ({ value: v, label: v }))];

export const FIELD_GROUPS: Array<{ id: string; label: string }> = [
  { id: "profile", label: "مشخصات و مالک" },
  { id: "job", label: "شغل و خدمت و معرفی" },
  { id: "cheque", label: "چک برگشتی و معوقه" },
  { id: "credit", label: "اعتبار و رتبه" },
  { id: "need", label: "مبلغ و نیاز" },
  { id: "docs", label: "مدارک و ضامن" },
  { id: "site", label: "فرم‌ها و سرنخ‌های سایت" },
  { id: "loan", label: "پرونده تسهیلات" },
];

export const FIELDS: FieldCatalog[] = [
  { key: "name", label: "نام", group: "profile", type: "text", ops: ["contains", "exists", "not_exists"], defaultColumn: true },
  { key: "customerId", label: "شناسه مشتری", group: "profile", type: "number", ops: ["eq", "range"], defaultColumn: true },
  { key: "phone", label: "شماره تماس", group: "profile", type: "text", ops: ["contains", "exists", "not_exists"], defaultColumn: true, sensitive: "phone" },
  { key: "nationalCode", label: "کد ملی", group: "profile", type: "text", ops: ["contains", "exists", "not_exists"], sensitive: "national" },
  { key: "city", label: "شهر", group: "profile", type: "text", ops: ["contains", "in", "exists", "not_exists"], defaultColumn: true },
  { key: "ownerId", label: "کارشناس مالک", group: "profile", type: "enum", ops: ["in", "exists", "not_exists"], defaultColumn: true },
  { key: "status", label: "وضعیت مشتری", group: "profile", type: "enum", ops: ["in"], options: opt(LABELS.status), defaultColumn: true },
  { key: "priority", label: "اولویت", group: "profile", type: "enum", ops: ["in"], options: opt(LABELS.priority), defaultColumn: true },
  { key: "isUrgent", label: "فوری", group: "profile", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "tags", label: "برچسب", group: "profile", type: "multi_enum", ops: ["in", "exists", "not_exists"] },
  { key: "leadSource", label: "منبع جذب", group: "profile", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.leadSource) },
  { key: "registrationSource", label: "منبع ثبت", group: "profile", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.regSource) },
  { key: "verificationStatus", label: "وضعیت احراز هویت", group: "profile", type: "enum", ops: ["in"], options: opt(LABELS.verification) },
  { key: "createdAt", label: "تاریخ ایجاد", group: "profile", type: "date", ops: ["date_range", "exists"] },
  { key: "registeredAt", label: "تاریخ ثبت", group: "profile", type: "date", ops: ["date_range", "exists", "not_exists"] },

  { key: "job", label: "شغل (ادغام‌شده)", group: "job", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.job), defaultColumn: true, description: "اول پرونده، بعد تماس اول، بعد مشاوره، بعد فرم سایت" },
  { key: "jobFile", label: "شغل در پرونده", group: "job", type: "enum", ops: ["in", "exists", "not_exists"], options: opt({ ...LABELS.job, ...LABELS.jobRaw }) },
  { key: "jobSite", label: "شغل در فرم سایت", group: "job", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.job) },
  { key: "ssoRetiree", label: "بازنشسته تأمین اجتماعی", group: "job", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.sso) },
  { key: "canReferRetiree", label: "می‌تواند بازنشسته معرفی کند", group: "job", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn), defaultColumn: true },
  { key: "canReferRetireeFile", label: "معرفی بازنشسته در پرونده", group: "job", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },
  { key: "canReferRetireeSite", label: "معرفی بازنشسته در فرم سایت", group: "job", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },
  { key: "military", label: "پایان خدمت", group: "job", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.military) },

  { key: "bounced", label: "چک برگشتی (ادغام‌شده)", group: "cheque", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn), defaultColumn: true, description: "اول پرونده، بعد تماس اول، بعد فرم سایت (سایت چک و معوق را با هم پرسیده)" },
  { key: "bouncedAny", label: "چک برگشتی در هر منبع", group: "cheque", type: "yn", ops: ["in"], options: opt(LABELS.yn), description: "اگر حتی یک منبع «بله» گفته باشد" },
  { key: "bouncedFile", label: "چک برگشتی در پرونده", group: "cheque", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },
  { key: "bouncedSite", label: "چک برگشتی / معوق در فرم سایت", group: "cheque", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },
  { key: "arrears", label: "معوقه بانکی", group: "cheque", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },
  { key: "checkStatus", label: "وضعیت چک مشتری", group: "cheque", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.checkStatus) },
  { key: "canPromissory", label: "می‌تواند سفته بدهد", group: "cheque", type: "yn", ops: ["in", "exists", "not_exists"], options: opt(LABELS.yn) },

  { key: "creditRankAny", label: "رتبه اعتباری (هر فرم یا استعلام)", group: "credit", type: "multi_enum", ops: ["in", "range", "exists", "not_exists"], description: "اگر در هر جا (استعلام اعتبار، پرونده، تماس اول، فرم مشاوره، فرم سایت، ثبت‌کننده) این رتبه ثبت شده باشد" },
  { key: "creditRank", label: "رتبه اعتباری (ادغام‌شده)", group: "credit", type: "enum", ops: ["in", "range", "exists", "not_exists"], defaultColumn: true, description: "فقط یک رتبه: اولین مقدار موجود به ترتیب پرونده، تماس اول، مشاوره، سایت" },
  { key: "creditRankFile", label: "رتبه در پرونده / استعلام", group: "credit", type: "enum", ops: ["in", "range", "exists", "not_exists"] },
  { key: "creditRankSite", label: "رتبه در فرم سایت", group: "credit", type: "enum", ops: ["in", "range", "exists", "not_exists"] },
  { key: "creditScore", label: "امتیاز اعتباری", group: "credit", type: "number", ops: ["range", "exists", "not_exists"] },

  { key: "amountToman", label: "مبلغ دقیق (تومان)", group: "need", type: "number", ops: ["range", "exists", "not_exists"] },
  { key: "amountRange", label: "بازه مبلغ", group: "need", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.amountRange), defaultColumn: true },
  { key: "amountMillion", label: "مبلغ (میلیون تومان، تماس اول)", group: "need", type: "number", ops: ["range", "exists", "not_exists"] },
  { key: "loanPurpose", label: "هدف وام", group: "need", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.purpose) },
  { key: "needTiming", label: "زمان نیاز", group: "need", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.timing) },
  { key: "need", label: "نوع نیاز (سرنخ)", group: "need", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.need) },
  { key: "contactTime", label: "ساعت تماس ترجیحی", group: "need", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.contact) },

  { key: "documents", label: "مدارک", group: "docs", type: "multi_enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.docs) },
  { key: "docsReady", label: "وضعیت مدارک", group: "docs", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.docsReady) },
  { key: "guarantorAvailable", label: "ضامن دارد", group: "docs", type: "enum", ops: ["in", "exists", "not_exists"], options: [{ value: "yes", label: "بله" }, { value: "no", label: "خیر" }, { value: "unknown", label: "نامشخص" }] },
  { key: "guarantorJob", label: "شغل ضامن", group: "docs", type: "enum", ops: ["in", "exists", "not_exists"], options: opt({ ...LABELS.job, ...LABELS.jobRaw }) },
  { key: "guarantorRank", label: "رتبه ضامن", group: "docs", type: "enum", ops: ["in", "range", "exists", "not_exists"] },
  { key: "guarantorCheque", label: "چک ضامن", group: "docs", type: "enum", ops: ["in", "exists", "not_exists"], options: [{ value: "yes", label: "بله" }, { value: "no", label: "خیر" }, { value: "unknown", label: "نامشخص" }] },

  { key: "hasSiteApply", label: "فرم ثبت درخواست سایت دارد", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "hasPublicLead", label: "سرنخ سایت دارد", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "hasCallback", label: "درخواست تماس سایت دارد", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "hasDossier", label: "پرونده مشتری پر شده", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "hasFirstCall", label: "فرم تماس اول پاسخ‌داده‌شده دارد", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "hasConsult", label: "فرم مشاوره دارد", group: "site", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "siteSrc", label: "صفحهٔ ورود از سایت", group: "site", type: "text", ops: ["contains", "in", "exists", "not_exists"] },
  { key: "utmSource", label: "منبع UTM", group: "site", type: "text", ops: ["contains", "in", "exists", "not_exists"] },
  { key: "siteOutcome", label: "نتیجه فرم سایت", group: "site", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.siteOutcome) },
  { key: "callbackStatus", label: "وضعیت درخواست تماس", group: "site", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.callbackStatus) },

  { key: "hasLoan", label: "پرونده تسهیلات دارد", group: "loan", type: "yn", ops: ["in"], options: opt(LABELS.yn) },
  { key: "loanStatus", label: "وضعیت پرونده تسهیلات", group: "loan", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.loanStatus) },
  { key: "loanStage", label: "مرحله پرونده تسهیلات", group: "loan", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.loanStage) },
  { key: "funderDecision", label: "تصمیم تأمین‌کننده", group: "loan", type: "enum", ops: ["in", "exists", "not_exists"], options: opt(LABELS.funder) },
];

export const DEFAULT_COLUMNS = FIELDS.filter((f) => f.defaultColumn).map((f) => f.key);

export type SourceMode = "both" | "file" | "site";
export type Condition = {
  field: string;
  op: "in" | "eq" | "contains" | "range" | "date_range" | "exists" | "not_exists";
  values?: string[];
  min?: string | number | null;
  max?: string | number | null;
};
export type SegmentQuery = {
  source: SourceMode;
  includeUnlinkedLeads?: boolean;
  conditions: Condition[];
  /** t963: "all" (default) = every active condition (AND); "any" = at least one active condition (OR). */
  match?: "all" | "any";
  columns?: string[];
};

export type Profile = {
  kind: "customer" | "unlinked_lead";
  customerId: number | null;
  leadKey: string;
  name: string;
  phone: string;
  nationalCode: string;
  city: string;
  ownerId: string;
  ownerName: string;
  status: string;
  priority: string;
  isUrgent: string;
  tags: string[];
  tagLabels: string[];
  leadSource: string;
  registrationSource: string;
  verificationStatus: string;
  createdAt: string;
  registeredAt: string;
  job: string;
  jobRaw: string;
  jobFile: string;
  jobSite: string;
  ssoRetiree: string;
  canReferRetiree: string;
  canReferRetireeFile: string;
  canReferRetireeSite: string;
  military: string;
  bounced: string;
  bouncedAny: string;
  bouncedFile: string;
  bouncedSite: string;
  arrears: string;
  checkStatus: string;
  canPromissory: string;
  creditRank: string;
  creditRankFile: string;
  creditRankSite: string;
  /** t963: every rank stored anywhere (ICS24 check, customer, dossier, first call, consult, site, intake, repeat). */
  creditRankAny: string[];
  creditRankAnyFile: string[];
  creditRankAnySite: string[];
  creditScore: string;
  amountToman: string;
  amountRange: string;
  amountMillion: string;
  loanPurpose: string;
  needTiming: string;
  need: string;
  contactTime: string;
  documents: string[];
  docsReady: string;
  guarantorAvailable: string;
  guarantorJob: string;
  guarantorRank: string;
  guarantorCheque: string;
  hasSiteApply: string;
  hasPublicLead: string;
  hasCallback: string;
  hasDossier: string;
  hasFirstCall: string;
  hasConsult: string;
  hasLoan: string;
  siteSrc: string;
  utmSource: string;
  siteOutcome: string;
  callbackStatus: string;
  loanStatus: string;
  loanStage: string;
  funderDecision: string;
  sources: Record<string, string>;
};

type Pick = { value: string; source: string };

function firstPick(parts: Array<[unknown, string]>, map?: (v: string) => string): Pick {
  for (const [raw, source] of parts) {
    const v = str(raw);
    if (!v || v === "null") continue;
    return { value: map ? map(v) : v, source };
  }
  return { value: "", source: "" };
}

function emptyProfile(): Profile {
  return {
    kind: "customer", customerId: null, leadKey: "", name: "", phone: "", nationalCode: "", city: "",
    ownerId: "", ownerName: "", status: "", priority: "", isUrgent: "no", tags: [], tagLabels: [],
    leadSource: "", registrationSource: "", verificationStatus: "", createdAt: "", registeredAt: "",
    job: "", jobRaw: "", jobFile: "", jobSite: "", ssoRetiree: "", canReferRetiree: "", canReferRetireeFile: "",
    canReferRetireeSite: "", military: "", bounced: "", bouncedAny: "", bouncedFile: "", bouncedSite: "",
    arrears: "", checkStatus: "", canPromissory: "", creditRank: "", creditRankFile: "", creditRankSite: "", creditRankAny: [], creditRankAnyFile: [], creditRankAnySite: [],
    creditScore: "", amountToman: "", amountRange: "", amountMillion: "", loanPurpose: "", needTiming: "",
    need: "", contactTime: "", documents: [], docsReady: "", guarantorAvailable: "", guarantorJob: "",
    guarantorRank: "", guarantorCheque: "", hasSiteApply: "no", hasPublicLead: "no", hasCallback: "no",
    hasDossier: "no", hasFirstCall: "no", hasConsult: "no", hasLoan: "no", siteSrc: "", utmSource: "",
    siteOutcome: "", callbackStatus: "", loanStatus: "", loanStage: "", funderDecision: "", sources: {},
  };
}

type JsonRow = Record<string, unknown>;

function latestByCustomer<T extends { customer_id: number | null }>(rows: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const r of rows) {
    const id = Number(r.customer_id);
    if (!Number.isFinite(id) || m.has(id)) continue;
    m.set(id, r);
  }
  return m;
}

export function loadTagCatalog(): Array<{ tag: string; label: string }> {
  if (!tableOk("customer_tag_catalog")) return [];
  return queryRows<{ tag: string; label_fa: string | null; canonical_label: string | null }>(
    "SELECT tag, label_fa, canonical_label FROM customer_tag_catalog",
  ).map((r) => ({ tag: r.tag, label: r.label_fa || r.canonical_label || r.tag }));
}

export function loadOwners(): Array<{ value: string; label: string }> {
  return queryRows<{ id: number; name: string }>("SELECT id, name FROM salespersons ORDER BY name, id")
    .map((r) => ({ value: String(r.id), label: r.name }));
}

export function loadCityOptions(): Array<{ value: string; label: string }> {
  const rows = queryRows<{ city: string }>(
    "SELECT city FROM customers WHERE merged_into_customer_id IS NULL AND city IS NOT NULL AND TRIM(city)<>'' GROUP BY city ORDER BY COUNT(*) DESC, city LIMIT 80",
  );
  return rows.map((r) => ({ value: r.city, label: r.city }));
}

const RANK_LETTER: Record<string, string> = { A: "الف", B: "ب", C: "ج", D: "د", E: "ه" };
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export function faDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

/** Preview/filter label for a stored credit rank. Values stay Latin (A, C1, unknown) for filtering. */
export function creditLabel(v: string | null | undefined): string {
  const raw = (v ?? "").trim();
  if (!raw || /^unknown$/i.test(raw) || raw === "نمی‌داند") return "نامشخص";
  const u = raw.toUpperCase();
  const m = /^([A-E])([1-3])?$/.exec(u);
  if (m) {
    const letter = RANK_LETTER[m[1]];
    return m[2] ? `رتبه ${letter}${faDigits(m[2])}` : `رتبه ${letter}`;
  }
  return raw;
}

export const RANK_FIELD_KEYS = ["creditRankAny", "creditRank", "creditRankFile", "creditRankSite", "guarantorRank"] as const;
export const isRankField = (key: string): boolean => (RANK_FIELD_KEYS as readonly string[]).includes(key);
const RANK_ORDER = ["A", "B", "C", "D", "E"].flatMap((l) => [1, 2, 3].map((n) => `${l}${n}`));

/** A stored/entered rank → A1…E3, a bare legacy letter A…E, "unknown", or "" when it is not a rank. */
export function normRank(v: unknown): string {
  const raw = str(v);
  if (!raw) return "";
  if (/^unknown$/i.test(raw) || raw === "نمی‌داند") return "unknown";
  const u = raw.toUpperCase();
  return /^[A-E][1-3]?$/.test(u) ? u : "";
}
/** Position span in A1(0)…E3(14). A bare letter spans its three sub-grades. unknown / junk → null. */
export function rankSpan(v: unknown): [number, number] | null {
  const r = normRank(v);
  if (!r || r === "unknown") return null;
  if (r.length === 1) { const i = RANK_ORDER.indexOf(`${r}1`); return [i, i + 2]; }
  const i = RANK_ORDER.indexOf(r);
  return i < 0 ? null : [i, i];
}
/** Sorted, de-duplicated ranks; «unknown» only when nothing better exists. */
function collectRanks(parts: unknown[]): string[] {
  const set = new Set<string>();
  for (const v of parts) { const r = normRank(v); if (r) set.add(r); }
  const real = [...set].filter((r) => r !== "unknown");
  if (!real.length) return set.has("unknown") ? ["unknown"] : [];
  const pos = (r: string) => (r.length === 1 ? RANK_ORDER.indexOf(`${r}1`) + 1.5 : RANK_ORDER.indexOf(r));
  return real.sort((a, b) => pos(a) - pos(b));
}

function creditOptions(): Array<{ value: string; label: string }> {
  const letters = ["A", "B", "C", "D", "E"];
  const out: Array<{ value: string; label: string }> = [];
  for (const L of letters) {
    out.push({ value: L, label: creditLabel(L) });
    for (const n of [1, 2, 3]) out.push({ value: `${L}${n}`, label: creditLabel(`${L}${n}`) });
  }
  out.push({ value: "unknown", label: "نامشخص" });
  return out;
}

export function fieldCatalog(): { groups: typeof FIELD_GROUPS; fields: FieldCatalog[]; owners: Array<{ value: string; label: string }>; tags: Array<{ tag: string; label: string }> } {
  const owners = loadOwners();
  const tags = loadTagCatalog();
  const cities = loadCityOptions();
  const fields = FIELDS.map((f) => {
    if (f.key === "ownerId") return { ...f, options: owners };
    if (f.key === "tags") return { ...f, options: tags.map((t) => ({ value: t.tag, label: t.label })) };
    if (f.key === "city") return { ...f, options: cities };
    if (isRankField(f.key)) {
      return { ...f, options: creditOptions() };
    }
    return f;
  });
  return { groups: FIELD_GROUPS, fields, owners, tags };
}

/** Collapse obvious city duplicates so a picker value matches spelling variants. */
export function canonCity(v: unknown): string {
  let s = str(v).replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
  if (!s) return "";
  const parts = s.split(" / ");
  if (parts.length === 2 && parts[0] === parts[1]) s = parts[0];
  const aliases: Record<string, string> = {
    "خراسان رضوی / مشهد": "مشهد",
    "فارس / شیراز": "شیراز",
    "فارس/ شیراز": "شیراز",
  };
  return aliases[s] || s;
}

export type ValueOpt = { value: string; label: string; count: number };
export type FieldValues = {
  field: string;
  type: FieldType;
  filled: number;
  empty: number;
  values: ValueOpt[];
  min?: number | string;
  max?: number | string;
};

function labelForStored(key: string, value: string): string {
  const p = emptyProfile();
  if (key === "tags") { p.tags = [value]; p.tagLabels = []; }
  else if (key === "creditRankAny") p.creditRankAny = [value];
  else if (key === "documents") p.documents = [value];
  else if (key === "ownerId") {
    p.ownerId = value;
    const owners = loadOwners();
    p.ownerName = owners.find((o) => o.value === value)?.label || "";
  } else {
    (p as unknown as Record<string, unknown>)[key] = value;
  }
  const shown = displayValue(key, p);
  return shown || value;
}

/** t963: the full A1…E3 grid (plus bare letters and «نامشخص») with counts that use the same matching as the filter. */
function rankValueOptions(rows: Profile[], key: string): ValueOpt[] {
  const codes: string[] = [];
  for (const l of ["A", "B", "C", "D", "E"]) codes.push(l, `${l}1`, `${l}2`, `${l}3`);
  codes.push("unknown");
  const out: ValueOpt[] = [];
  for (const value of codes) {
    const cond: Condition = { field: key, op: "in", values: [value] };
    const count = rows.reduce((n, p) => n + (matchesCondition(p, cond) ? 1 : 0), 0);
    if (value === "unknown" && !count) continue;
    out.push({ value, label: labelForStored(key, value), count });
  }
  return out;
}

/** Distinct values + counts for the value picker. Respects source and actor scope. Never lists phone/national/name. */
export function fieldValues(
  all: Profile[],
  q: Pick<SegmentQuery, "source" | "includeUnlinkedLeads">,
  scope: ActorScope = { kind: "all" },
): FieldValues[] {
  const includeUnlinked = q.includeUnlinkedLeads !== false && scope.kind === "all";
  const rows: Profile[] = [];
  for (const raw of applyActorScope(all, scope)) {
    if (!sourceEligible(raw, q.source, includeUnlinked)) continue;
    rows.push(profileForSource(raw, q.source));
  }
  const total = rows.length;
  const out: FieldValues[] = [];
  for (const field of FIELDS) {
    const skipList = field.sensitive === "phone" || field.sensitive === "national" || field.key === "name" || field.key === "customerId";
    const counts = new Map<string, number>();
    let empty = 0;
    const nums: number[] = [];
    const dates: string[] = [];
    for (const p of rows) {
      const raw = getValue(p, field.key);
      if (field.type === "multi_enum") {
        const arr = Array.isArray(raw) ? raw.map(String).filter((v) => nonempty(v)) : (nonempty(raw) ? [str(raw)] : []);
        if (!arr.length) { empty++; continue; }
        for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
        continue;
      }
      if (!nonempty(raw)) { empty++; continue; }
      if (field.type === "number") {
        const n = num(raw);
        if (n == null) { empty++; continue; }
        nums.push(n);
        continue;
      }
      if (field.type === "date") {
        const iso = str(raw);
        if (asDate(iso) == null) { empty++; continue; }
        dates.push(iso);
        continue;
      }
      let s = str(raw);
      if (field.key === "city") s = canonCity(s) || s;
      if (!s) { empty++; continue; }
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    const rec: FieldValues = {
      field: field.key,
      type: field.type,
      filled: total - empty,
      empty,
      values: skipList ? [] : [...counts.entries()]
        .map(([value, count]) => ({ value, label: labelForStored(field.key, value), count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "fa"))
        .slice(0, 200),
    };
    if (isRankField(field.key)) rec.values = rankValueOptions(rows, field.key);
    if (field.type === "number" && nums.length) {
      rec.min = Math.min(...nums);
      rec.max = Math.max(...nums);
    }
    if (field.type === "date" && dates.length) {
      const sorted = dates.slice().sort();
      rec.min = sorted[0];
      rec.max = sorted[sorted.length - 1];
    }
    out.push(rec);
  }
  return out;
}


export function loadProfiles(): Profile[] {
  const tagLabel = new Map(loadTagCatalog().map((t) => [t.tag, t.label]));
  const customers = queryRows<{
    id: number; name: string | null; phone: string | null; national_code: string | null; city: string | null;
    status: string | null; priority: number | null; is_urgent: number | null; salesperson_id: number | null;
    salesperson_name: string | null; lead_source: string | null; registration_source: string | null;
    verification_status: string | null; created_at: string | null; registered_at: string | null;
    credit_rank: string | null; credit_score: number | null; intake_credit_rank: string | null;
  }>(`SELECT c.id, c.name, c.phone, c.national_code, c.city, c.status, c.priority, c.is_urgent,
      c.salesperson_id, s.name AS salesperson_name, c.lead_source, c.registration_source,
      c.verification_status, c.created_at, c.registered_at, c.credit_rank, c.credit_score,
      ${colOk("customers", "intake_credit_rank") ? "c.intake_credit_rank" : "NULL"} AS intake_credit_rank
    FROM customers c LEFT JOIN salespersons s ON s.id = c.salesperson_id
    WHERE c.merged_into_customer_id IS NULL`);

  const dossier = tableOk("customer_dossier")
    ? queryRows<{ customer_id: number; city: string | null; amount_toman: number | null; credit_rank: string | null;
        g_job_status: string | null; g_credit_rank: string | null; answers_json: string | null }>(
      "SELECT customer_id, city, amount_toman, credit_rank, g_job_status, g_credit_rank, answers_json FROM customer_dossier")
    : [];
  const dossierBy = new Map(dossier.map((r) => [Number(r.customer_id), r]));

  const siteRows = tableOk("site_apply_answers")
    ? queryRows<{ customer_id: number; amount_range: string | null; loan_purpose: string | null; job_status: string | null;
        documents_json: string | null; has_military_card: string | null; can_refer_retiree: string | null;
        has_bounced_or_overdue: string | null; need_timing: string | null; credit_rank: string | null;
        src: string | null; outcome: string | null }>(
      `SELECT customer_id, amount_range, loan_purpose, job_status, documents_json, has_military_card,
        can_refer_retiree, has_bounced_or_overdue, need_timing, credit_rank, src, outcome
       FROM site_apply_answers WHERE id IN (SELECT MAX(id) FROM site_apply_answers GROUP BY customer_id)`)
    : [];
  const siteBy = latestByCustomer(siteRows);

  const leadRows = tableOk("public_leads")
    ? queryRows<{ customer_id: number; need: string | null; amount_band: string | null; contact_time: string | null;
        utm_source: string | null; outcome: string | null }>(
      `SELECT customer_id, need, amount_band, contact_time, utm_source, outcome
       FROM public_leads WHERE id IN (SELECT MAX(id) FROM public_leads WHERE customer_id IS NOT NULL GROUP BY customer_id)`)
    : [];
  const leadBy = latestByCustomer(leadRows);

  const cbRows = tableOk("callback_requests")
    ? queryRows<{ id: number; customer_id: number | null; name: string | null; phone: string | null;
        contact_time: string | null; need: string | null; status: string | null; created_at: string | null }>(
      "SELECT id, customer_id, name, phone, contact_time, need, status, created_at FROM callback_requests ORDER BY id DESC")
    : [];
  const cbBy = latestByCustomer(cbRows.filter((r) => r.customer_id != null) as Array<typeof cbRows[number] & { customer_id: number }>);
  const unlinkedCb = cbRows.filter((r) => r.customer_id == null);

  const qRows = tableOk("team_sales_qualifications")
    ? queryRows<{ customer_id: number; answers_json: string | null }>(
      `SELECT customer_id, answers_json FROM team_sales_qualifications
       WHERE call_result='answered' AND id IN
         (SELECT MAX(id) FROM team_sales_qualifications WHERE call_result='answered' GROUP BY customer_id)`)
    : [];
  const qBy = new Map(qRows.map((r) => [Number(r.customer_id), parseJson(r.answers_json)]));

  const consultRows = tableOk("consultation_forms")
    ? queryRows<{ customer_id: number; job_type: string | null; credit_rank: string | null; has_guarantor: number | null;
        customer_check_status: string | null; guarantor_job_type: string | null; guarantor_credit_rank: string | null;
        loan_purpose: string | null; requested_amount_toman: number | null; requested_amount: number | null;
        military_status: string | null; is_retired: number | null }>(
      `SELECT customer_id, job_type, credit_rank, has_guarantor, customer_check_status, guarantor_job_type,
        guarantor_credit_rank, loan_purpose, requested_amount_toman, requested_amount, military_status, is_retired
       FROM consultation_forms WHERE id IN (SELECT MAX(id) FROM consultation_forms GROUP BY customer_id)`)
    : [];
  const consultBy = latestByCustomer(consultRows);

  const tagRows = tableOk("customer_tags")
    ? queryRows<{ customer_id: number; tag: string }>("SELECT customer_id, tag FROM customer_tags")
    : [];
  const tagsBy = new Map<number, string[]>();
  for (const r of tagRows) {
    const id = Number(r.customer_id);
    const arr = tagsBy.get(id) ?? [];
    arr.push(r.tag);
    tagsBy.set(id, arr);
  }

  const loanRows = tableOk("loan_applications")
    ? queryRows<{ customer_id: number; status: string | null; stage: string | null; funder_decision: string | null }>(
      `SELECT customer_id, status, stage, funder_decision FROM loan_applications
       WHERE deleted_at IS NULL AND id IN
         (SELECT MAX(id) FROM loan_applications WHERE deleted_at IS NULL GROUP BY customer_id)`)
    : [];
  const loanBy = latestByCustomer(loanRows);

  const csRows = tableOk("cs_file_values")
    ? queryRows<{ customer_id: number; item_key: string; value_json: string | null }>(
      `SELECT customer_id, item_key, value_json FROM cs_file_values
       WHERE id IN (SELECT MAX(id) FROM cs_file_values GROUP BY customer_id, item_key)`)
    : [];
  const csBy = new Map<number, Record<string, unknown>>();
  for (const r of csRows) {
    const id = Number(r.customer_id);
    const slot = csBy.get(id) ?? {};
    let v: unknown = r.value_json;
    try { v = r.value_json ? JSON.parse(r.value_json) : null; } catch { /* keep raw */ }
    slot[r.item_key] = v;
    csBy.set(id, slot);
  }

  // t963: every other place a customer rank is stored (read-only).
  const checkRows = tableOk("customer_credit_checks") && colOk("customer_credit_checks", "score_label")
    ? queryRows<{ customer_id: number; score_label: string | null }>(
      `SELECT customer_id, score_label FROM customer_credit_checks
       WHERE status='report_generated' AND score_label IS NOT NULL AND TRIM(score_label)<>''
       ORDER BY created_at DESC, id DESC`)
    : [];
  const checkBy = latestByCustomer(checkRows);
  const repeatRows = tableOk("customer_repeat_requests") && colOk("customer_repeat_requests", "intake_credit_rank")
    ? queryRows<{ customer_id: number; intake_credit_rank: string | null }>(
      `SELECT customer_id, intake_credit_rank FROM customer_repeat_requests
       WHERE intake_credit_rank IS NOT NULL AND TRIM(intake_credit_rank)<>'' ORDER BY id DESC`)
    : [];
  const repeatBy = latestByCustomer(repeatRows);

  const out: Profile[] = [];
  for (const c of customers) {
    const p = emptyProfile();
    p.kind = "customer";
    p.customerId = Number(c.id);
    p.leadKey = `c:${c.id}`;
    p.name = str(c.name);
    p.phone = str(c.phone);
    p.nationalCode = str(c.national_code);
    p.city = str(c.city);
    p.ownerId = c.salesperson_id != null ? String(c.salesperson_id) : "";
    p.ownerName = str(c.salesperson_name);
    p.status = str(c.status);
    p.priority = c.priority != null ? String(c.priority) : "";
    p.isUrgent = Number(c.is_urgent) === 1 ? "yes" : "no";
    p.leadSource = str(c.lead_source);
    p.registrationSource = str(c.registration_source);
    p.verificationStatus = str(c.verification_status);
    p.createdAt = str(c.created_at);
    p.registeredAt = str(c.registered_at);
    p.creditScore = c.credit_score != null ? String(c.credit_score) : "";
    p.tags = tagsBy.get(Number(c.id)) ?? [];
    p.tagLabels = p.tags.map((t) => tagLabel.get(t) || t);

    const d = dossierBy.get(Number(c.id));
    const da = d ? parseJson(d.answers_json) ?? {} : {};
    const site = siteBy.get(Number(c.id));
    const lead = leadBy.get(Number(c.id));
    const cb = cbBy.get(Number(c.id));
    const q = qBy.get(Number(c.id));
    const cf = consultBy.get(Number(c.id));
    const loan = loanBy.get(Number(c.id));
    const cs = csBy.get(Number(c.id)) ?? {};

    p.hasDossier = d ? "yes" : "no";
    p.hasSiteApply = site ? "yes" : "no";
    p.hasPublicLead = lead ? "yes" : "no";
    p.hasCallback = cb ? "yes" : "no";
    p.hasFirstCall = q ? "yes" : "no";
    p.hasConsult = cf ? "yes" : "no";
    p.hasLoan = loan ? "yes" : "no";
    if (loan) {
      p.loanStatus = str(loan.status);
      p.loanStage = str(loan.stage);
      p.funderDecision = str(loan.funder_decision);
      p.sources.loanStatus = "loan";
    }
    if (site) {
      p.siteSrc = str(site.src);
      p.siteOutcome = str(site.outcome);
    }
    if (lead) p.utmSource = str(lead.utm_source);
    if (cb) p.callbackStatus = str(cb.status);

    if (d && str(d.city) && !p.city) { p.city = str(d.city); p.sources.city = "dossier"; }

    const jobFile = firstPick([
      [da.job_status, "dossier"],
      [q?.jobType, "first_call"],
      [cf?.job_type, "consult"],
      [cf?.is_retired === 1 ? "retired" : "", "consult"],
    ]);
    p.jobFile = jobFile.value;
    if (jobFile.source) p.sources.jobFile = jobFile.source;
    p.jobSite = str(site?.job_status);
    if (p.jobSite) p.sources.jobSite = "site";
    const job = firstPick([
      [da.job_status, "dossier"],
      [q?.jobType, "first_call"],
      [cf?.job_type, "consult"],
      [site?.job_status, "site"],
    ]);
    p.jobRaw = job.value;
    p.job = canonJob(job.value);
    if (job.source) p.sources.job = job.source;

    const sso = firstPick([[da.retired_kind ?? q?.ssoRetiree, da.retired_kind ? "dossier" : "first_call"], [cs.sso, "cs"]]);
    p.ssoRetiree = sso.value;
    if (sso.source) p.sources.ssoRetiree = sso.source;

    p.canReferRetireeFile = yn(da.can_refer_retiree);
    if (p.canReferRetireeFile) p.sources.canReferRetireeFile = "dossier";
    p.canReferRetireeSite = yn(site?.can_refer_retiree);
    if (p.canReferRetireeSite) p.sources.canReferRetireeSite = "site";
    const refer = firstPick([[da.can_refer_retiree, "dossier"], [site?.can_refer_retiree, "site"]], (v) => yn(v));
    p.canReferRetiree = refer.value;
    if (refer.source) p.sources.canReferRetiree = refer.source;

    const mil = firstPick([
      [da.has_military_card, "dossier"],
      [q?.military, "first_call"],
      [cf?.military_status, "consult"],
      [site?.has_military_card, "site"],
    ]);
    p.military = mil.value;
    if (mil.source) p.sources.military = mil.source;

    const bouncedFile = firstPick([
      [da.has_cheque_bounced, "dossier"],
      [q?.bouncedCheque, "first_call"],
      [cs.bounced, "cs"],
    ], (v) => yn(v));
    p.bouncedFile = bouncedFile.value;
    if (bouncedFile.source) p.sources.bouncedFile = bouncedFile.source;
    p.bouncedSite = yn(site?.has_bounced_or_overdue);
    if (p.bouncedSite) p.sources.bouncedSite = "site";
    const bounced = firstPick([
      [da.has_cheque_bounced, "dossier"],
      [q?.bouncedCheque, "first_call"],
      [cs.bounced, "cs"],
      [site?.has_bounced_or_overdue, "site"],
    ], (v) => yn(v));
    p.bounced = bounced.value;
    if (bounced.source) p.sources.bounced = bounced.source;
    const anyYes = [p.bouncedFile, p.bouncedSite, yn(da.has_bounced_or_overdue), yn(q?.bouncedCheque), yn(cs.bounced)].includes("yes");
    const anyNo = [p.bouncedFile, p.bouncedSite, yn(da.has_bounced_or_overdue), yn(q?.bouncedCheque), yn(cs.bounced)].includes("no");
    p.bouncedAny = anyYes ? "yes" : anyNo ? "no" : "";

    const arrears = firstPick([[da.has_overdue, "dossier"], [q?.arrears, "first_call"], [cs.arrears, "cs"]], (v) => yn(v));
    p.arrears = arrears.value;
    if (arrears.source) p.sources.arrears = arrears.source;

    const checkSt = firstPick([[q?.checkStatus, "first_call"], [cf?.customer_check_status, "consult"]]);
    p.checkStatus = checkSt.value;
    if (checkSt.source) p.sources.checkStatus = checkSt.source;
    p.canPromissory = yn(q?.canPromissory);
    if (p.canPromissory) p.sources.canPromissory = "first_call";

    p.creditRankFile = str(c.credit_rank) || str(d?.credit_rank) || str(q?.creditRank) || str(cf?.credit_rank);
    if (str(c.credit_rank)) p.sources.creditRankFile = "customer";
    else if (str(d?.credit_rank)) p.sources.creditRankFile = "dossier";
    else if (str(q?.creditRank)) p.sources.creditRankFile = "first_call";
    else if (str(cf?.credit_rank)) p.sources.creditRankFile = "consult";
    p.creditRankSite = str(site?.credit_rank);
    if (p.creditRankSite) p.sources.creditRankSite = "site";
    const cr = firstPick([
      [c.credit_rank, "customer"],
      [d?.credit_rank, "dossier"],
      [q?.creditRank, "first_call"],
      [cf?.credit_rank, "consult"],
      [site?.credit_rank, "site"],
    ]);
    p.creditRank = cr.value;
    if (cr.source) p.sources.creditRank = cr.source;
    // t963 «هر فرم یا استعلام»: a customer has every rank that any source holds.
    const fileRanks: unknown[] = [
      c.credit_rank, checkBy.get(Number(c.id))?.score_label, d?.credit_rank, q?.creditRank, cs.creditRank,
      cf?.credit_rank, c.intake_credit_rank, repeatBy.get(Number(c.id))?.intake_credit_rank,
    ];
    p.creditRankAnyFile = collectRanks(fileRanks);
    p.creditRankAnySite = collectRanks([site?.credit_rank]);
    p.creditRankAny = collectRanks([...fileRanks, site?.credit_rank]);

    if (d?.amount_toman != null) { p.amountToman = String(d.amount_toman); p.sources.amountToman = "dossier"; }
    else if (cf?.requested_amount_toman != null) { p.amountToman = String(cf.requested_amount_toman); p.sources.amountToman = "consult"; }
    const ar = firstPick([[da.amount_range, "dossier"], [site?.amount_range, "site"], [lead?.amount_band, "lead"]]);
    p.amountRange = ar.value && String(ar.value).startsWith("apply:") ? String(ar.value).slice(6) : ar.value;
    if (ar.source) p.sources.amountRange = ar.source;
    if (q?.amountMillion != null && q.amountMillion !== "") { p.amountMillion = String(q.amountMillion); p.sources.amountMillion = "first_call"; }

    const purpose = firstPick([[da.loan_purpose, "dossier"], [site?.loan_purpose, "site"], [cf?.loan_purpose, "consult"]]);
    p.loanPurpose = purpose.value;
    if (purpose.source) p.sources.loanPurpose = purpose.source;
    const timing = firstPick([[da.need_timing, "dossier"], [q?.urgency, "first_call"], [site?.need_timing, "site"]]);
    p.needTiming = timing.value;
    if (timing.source) p.sources.needTiming = timing.source;
    const need = firstPick([[da.need, "dossier"], [lead?.need, "lead"], [cb?.need, "callback"]]);
    p.need = need.value;
    if (need.source) p.sources.need = need.source;
    const ct = firstPick([[da.contactTime, "dossier"], [lead?.contact_time, "lead"], [cb?.contact_time, "callback"]]);
    p.contactTime = ct.value;
    if (ct.source) p.sources.contactTime = ct.source;

    const docsSite = parseArr(site?.documents_json).map(String);
    const docsFile = Array.isArray(da.documents) ? (da.documents as unknown[]).map(String) : [];
    const docsCs = Array.isArray(cs.docs) ? (cs.docs as unknown[]).map(String) : [];
    p.documents = docsFile.length ? docsFile : docsSite.length ? docsSite : docsCs;
    if (docsFile.length) p.sources.documents = "dossier";
    else if (docsSite.length) p.sources.documents = "site";
    else if (docsCs.length) p.sources.documents = "cs";
    const docsReady = firstPick([[q?.docsReady, "first_call"]]);
    p.docsReady = docsReady.value;
    if (docsReady.source) p.sources.docsReady = docsReady.source;

    const gAvail = firstPick([
      [q?.guarantorAvailable, "first_call"],
      [cf?.has_guarantor == null ? "" : Number(cf.has_guarantor) === 1 ? "yes" : "no", "consult"],
      [p.documents.includes("guarantor") ? "yes" : "", p.sources.documents || "site"],
    ]);
    p.guarantorAvailable = gAvail.value;
    if (gAvail.source) p.sources.guarantorAvailable = gAvail.source;
    const gJob = firstPick([[da.g_job_status ?? d?.g_job_status, "dossier"], [q?.gJobType, "first_call"], [cf?.guarantor_job_type, "consult"]]);
    p.guarantorJob = gJob.value;
    if (gJob.source) p.sources.guarantorJob = gJob.source;
    const gRank = firstPick([[d?.g_credit_rank, "dossier"], [q?.gRank, "first_call"], [cf?.guarantor_credit_rank, "consult"]]);
    p.guarantorRank = gRank.value;
    if (gRank.source) p.sources.guarantorRank = gRank.source;
    const gCh = firstPick([[q?.guarantorCheque, "first_call"]]);
    p.guarantorCheque = gCh.value;
    if (gCh.source) p.sources.guarantorCheque = gCh.source;

    out.push(p);
  }

  // Unlinked callback leads (no customer_id). Phone match is applied in production at intake;
  // leftover rows stay as their own rows when the caller asks for them.
  for (const r of unlinkedCb) {
    const p = emptyProfile();
    p.kind = "unlinked_lead";
    p.leadKey = `callback:${r.id}`;
    p.name = str(r.name);
    p.phone = str(r.phone);
    p.contactTime = str(r.contact_time);
    p.need = str(r.need);
    p.callbackStatus = str(r.status);
    p.hasCallback = "yes";
    p.createdAt = str(r.created_at);
    p.sources.contactTime = "callback";
    out.push(p);
  }
  return out;
}

function profileForSource(p: Profile, source: SourceMode): Profile {
  if (source === "both") return p;
  if (source === "site") {
    const q = { ...p, sources: { ...p.sources } };
    q.job = canonJob(p.jobSite);
    q.jobRaw = p.jobSite;
    q.canReferRetiree = p.canReferRetireeSite;
    q.bounced = p.bouncedSite;
    q.creditRank = p.creditRankSite || p.creditRank;
    q.creditRankAny = p.creditRankAnySite;
    return q;
  }
  const q = { ...p, sources: { ...p.sources } };
  q.job = canonJob(p.jobFile);
  q.jobRaw = p.jobFile;
  q.canReferRetiree = p.canReferRetireeFile;
  q.bounced = p.bouncedFile;
  q.creditRank = p.creditRankFile;
  q.creditRankAny = p.creditRankAnyFile;
  return q;
}

function sourceEligible(p: Profile, source: SourceMode, includeUnlinked: boolean): boolean {
  if (p.kind === "unlinked_lead") return includeUnlinked && source !== "file";
  if (source === "site") return p.hasSiteApply === "yes" || p.hasPublicLead === "yes" || p.hasCallback === "yes";
  if (source === "file") return p.hasDossier === "yes" || p.hasFirstCall === "yes" || p.hasConsult === "yes" || p.hasLoan === "yes" || true;
  return true;
}

function asDate(v: string): number | null {
  if (!v) return null;
  // Accept YYYY-MM-DD or ISO
  const d = new Date(v.length <= 10 ? `${v}T12:00:00+03:30` : v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

function getValue(p: Profile, key: string): unknown {
  if (key === "tags") return p.tags;
  if (key === "documents") return p.documents;
  return (p as unknown as Record<string, unknown>)[key];
}

export function matchesCondition(p: Profile, c: Condition): boolean {
  const field = FIELDS.find((f) => f.key === c.field);
  if (!field) return false;
  const raw = getValue(p, c.field);
  if (c.op === "exists") return Array.isArray(raw) ? raw.length > 0 : nonempty(raw);
  if (c.op === "not_exists") return Array.isArray(raw) ? raw.length === 0 : !nonempty(raw);
  if (c.op === "contains") {
    const q = (c.values?.[0] ?? "").trim();
    if (!q) return true;
    return String(raw ?? "").includes(q);
  }
  if (c.op === "eq") {
    const q = str(c.values?.[0] ?? c.min ?? "");
    return String(raw ?? "") === q;
  }
  if (c.op === "in") {
    const set = new Set((c.values ?? []).map(String));
    if (!set.size) return true;
    if (isRankField(field.key)) {
      // credit rank: a picked bare letter (A) also matches A1–A3
      const vals = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v ?? ""));
      return vals.some((v) => set.has(v) || (/^[A-E][1-3]$/.test(v) && set.has(v[0])));
    }
    if (Array.isArray(raw)) return raw.some((v) => set.has(String(v)));
    // credit rank: letter A matches A1–A3 too when the user picked a bare letter
    const val = String(raw ?? "");
    if (set.has(val)) return true;
    if (field.key.startsWith("credit") || field.key === "guarantorRank") {
      if (val && set.has(val[0]) && /^[A-E][1-3]$/.test(val)) return true;
    }
    if (field.key === "job" || field.key === "jobFile" || field.key === "jobSite" || field.key === "guarantorJob") {
      if (set.has(canonJob(val))) return true;
    }
    if (field.key === "city") {
      const want = new Set([...set].map((v) => canonCity(v) || v));
      if (want.has(canonCity(val) || val)) return true;
    }
    return false;
  }
  if (c.op === "range" && isRankField(field.key)) {
    // t963 rank range A1…E3 (best → worst); a bare stored letter counts when its A1–A3 span overlaps.
    const lo = rankSpan(c.min)?.[0] ?? 0;
    const hi = rankSpan(c.max)?.[1] ?? RANK_ORDER.length - 1;
    if (rankSpan(c.min) == null && rankSpan(c.max) == null) return true;
    return (Array.isArray(raw) ? raw : [raw]).some((v) => {
      const s = rankSpan(v);
      return s != null && s[1] >= lo && s[0] <= hi;
    });
  }
  if (c.op === "range") {
    const n = num(raw);
    if (n == null) return false;
    const min = c.min == null || c.min === "" ? null : num(c.min);
    const max = c.max == null || c.max === "" ? null : num(c.max);
    if (min != null && n < min) return false;
    if (max != null && n > max) return false;
    return true;
  }
  if (c.op === "date_range") {
    const t = asDate(String(raw ?? ""));
    if (t == null) return false;
    const min = c.min == null || c.min === "" ? null : asDate(String(c.min));
    const max = c.max == null || c.max === "" ? null : asDate(String(c.max));
    if (min != null && t < min) return false;
    if (max != null && t > max + 86_400_000 - 1) return false;
    return true;
  }
  return true;
}

/** A condition with nothing picked yet does not filter (hint «چیزی انتخاب نشده؛ همه می‌آیند»), in both AND and OR. */
export function conditionActive(c: Condition): boolean {
  if (c.op === "exists" || c.op === "not_exists" || c.op === "eq") return true;
  if (c.op === "in") return (c.values ?? []).some((v) => str(v) !== "");
  if (c.op === "contains") return str(c.values?.[0]) !== "";
  const has = (v: unknown) => v != null && String(v).trim() !== "";
  if (c.op === "range" && isRankField(c.field)) return rankSpan(c.min) != null || rankSpan(c.max) != null;
  return has(c.min) || has(c.max);
}

export function parseQuery(body: unknown): SegmentQuery {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const source: SourceMode = b.source === "file" || b.source === "site" ? b.source : "both";
  const conditions: Condition[] = [];
  const raw = Array.isArray(b.conditions) ? b.conditions : [];
  const ops = new Set(["in", "eq", "contains", "range", "date_range", "exists", "not_exists"]);
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const field = str(c.field);
    if (!FIELDS.some((f) => f.key === field)) continue;
    const op = str(c.op);
    if (!ops.has(op)) continue;
    conditions.push({
      field,
      op: op as Condition["op"],
      values: Array.isArray(c.values) ? c.values.map((v) => String(v)) : (c.value != null ? [String(c.value)] : []),
      min: c.min == null ? null : (c.min as string | number),
      max: c.max == null ? null : (c.max as string | number),
    });
  }
  const columns = Array.isArray(b.columns) ? (b.columns as unknown[]).map(String).filter((k) => FIELDS.some((f) => f.key === k)) : undefined;
  const match: "all" | "any" = b.match === "any" ? "any" : "all";
  return { source, includeUnlinkedLeads: b.includeUnlinkedLeads !== false, conditions, match, columns };
}

export function filterProfiles(all: Profile[], q: SegmentQuery, scope: ActorScope = { kind: "all" }): Profile[] {
  const includeUnlinked = q.includeUnlinkedLeads !== false && scope.kind === "all";
  const out: Profile[] = [];
  const active = q.conditions.filter(conditionActive);
  for (const raw of applyActorScope(all, scope)) {
    if (!sourceEligible(raw, q.source, includeUnlinked)) continue;
    const p = profileForSource(raw, q.source);
    if (!active.length) { out.push(p); continue; }
    const ok = q.match === "any" ? active.some((c) => matchesCondition(p, c)) : active.every((c) => matchesCondition(p, c));
    if (ok) out.push(p);
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || (b.customerId ?? 0) - (a.customerId ?? 0));
  return out;
}

export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (!phone) return "";
  if (d.length < 4) return "پوشیده";
  return `پوشیده ${faDigits(d.slice(-4))}`;
}

export function displayValue(key: string, p: Profile, opts?: { phones?: boolean; national?: boolean }): string {
  const raw = getValue(p, key);
  if (key === "phone") return opts?.phones ? String(raw ?? "") : maskPhone(String(raw ?? ""));
  if (key === "nationalCode") return opts?.national ? String(raw ?? "") : (raw ? "پوشیده" : "");
  if (key === "tags") return (p.tagLabels.length ? p.tagLabels : p.tags).join("، ");
  if (key === "documents") return p.documents.map((d) => LABELS.docs[d] || d).join("، ");
  if (key === "ownerId") return p.ownerName || p.ownerId;
  if (key === "customerId") return p.customerId != null ? String(p.customerId) : "";
  if (isRankField(key)) {
    if (Array.isArray(raw)) return raw.map((v) => creditLabel(str(v))).join("، ");
    return creditLabel(str(raw));
  }
  if (Array.isArray(raw)) return raw.map(String).join("، ");
  const s = str(raw);
  if (!s) return "";
  if (/^unknown$/i.test(s)) return "نامشخص";
  const maps: Record<string, Record<string, string>> = {
    job: LABELS.job, jobFile: { ...LABELS.job, ...LABELS.jobRaw }, jobSite: LABELS.job,
    canReferRetiree: LABELS.yn, canReferRetireeFile: LABELS.yn, canReferRetireeSite: LABELS.yn,
    bounced: LABELS.yn, bouncedAny: LABELS.yn, bouncedFile: LABELS.yn, bouncedSite: LABELS.yn,
    arrears: LABELS.yn, canPromissory: LABELS.yn, isUrgent: LABELS.yn,
    hasSiteApply: LABELS.yn, hasPublicLead: LABELS.yn, hasCallback: LABELS.yn,
    hasDossier: LABELS.yn, hasFirstCall: LABELS.yn, hasConsult: LABELS.yn, hasLoan: LABELS.yn,
    military: LABELS.military, loanPurpose: LABELS.purpose, amountRange: LABELS.amountRange,
    needTiming: LABELS.timing, need: LABELS.need, contactTime: LABELS.contact,
    docsReady: LABELS.docsReady, status: LABELS.status, priority: LABELS.priority,
    verificationStatus: LABELS.verification, leadSource: LABELS.leadSource,
    registrationSource: LABELS.regSource, loanStatus: LABELS.loanStatus,
    funderDecision: LABELS.funder, ssoRetiree: LABELS.sso, checkStatus: LABELS.checkStatus,
    siteOutcome: LABELS.siteOutcome, callbackStatus: LABELS.callbackStatus, loanStage: LABELS.loanStage,
    guarantorAvailable: { yes: "بله", no: "خیر", unknown: "نامشخص" },
    guarantorCheque: { yes: "بله", no: "خیر", unknown: "نامشخص" },
    guarantorJob: { ...LABELS.job, ...LABELS.jobRaw },
  };
  const m = maps[key];
  if (m && m[s]) return m[s];
  return s;
}

export type PublicRow = {
  kind: Profile["kind"];
  customerId: number | null;
  leadKey: string;
  values: Record<string, string>;
  sources: Record<string, string>;
  sourceLabels: Record<string, string>;
};

export function toPublicRow(p: Profile, columns: string[], opts?: { phones?: boolean; national?: boolean }): PublicRow {
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const sourceLabels: Record<string, string> = {};
  for (const k of columns) {
    values[k] = displayValue(k, p, opts);
    if (p.sources[k]) {
      sources[k] = p.sources[k];
      sourceLabels[k] = LABELS.sourceName[p.sources[k]] || p.sources[k];
    }
  }
  return { kind: p.kind, customerId: p.customerId, leadKey: p.leadKey, values, sources, sourceLabels };
}


/** Name first (sticky in the UI), then id and masked phone, then the rest in catalog order. */
export function orderPreviewColumns(cols: string[]): string[] {
  const set = new Set(cols.filter((k) => k && k !== "nationalCode"));
  if (!set.has("name") && DEFAULT_COLUMNS.includes("name")) set.add("name");
  if (!set.has("phone")) set.add("phone");
  const head = ["name", "customerId", "phone"].filter((k) => set.has(k));
  const rest = FIELDS.map((f) => f.key).filter((k) => set.has(k) && !head.includes(k));
  const extra = [...set].filter((k) => !head.includes(k) && !rest.includes(k));
  return [...head, ...rest, ...extra];
}

export function preview(q: SegmentQuery, actor: AuthUser, page = 1, pageSize = 20): { total: number; page: number; pageSize: number; columns: string[]; rows: PublicRow[]; scope: "all" | "own" } {
  const scope = actorScope(actor);
  if (!scope) throw new SegmentScopeError("این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.");
  assertQueryScope(q, scope);
  const wanted = (q.columns && q.columns.length ? q.columns : DEFAULT_COLUMNS).filter((k) => k !== "nationalCode");
  const unique = orderPreviewColumns(wanted);
  const all = filterProfiles(loadProfiles(), q, scope);
  const safePage = Math.max(1, page);
  const size = Math.min(100, Math.max(1, pageSize));
  const start = (safePage - 1) * size;
  const rows = all.slice(start, start + size).map((p) => toPublicRow(p, unique, { phones: false, national: false }));
  return { total: all.length, page: safePage, pageSize: size, columns: unique, rows, scope: scope.kind === "all" ? "all" : "own" };
}

export function exportXlsx(q: SegmentQuery, actor: AuthUser, includePhones: boolean): { buffer: Buffer; filename: string; rowCount: number; columns: string[] } {
  const scope = actorScope(actor);
  if (!scope) throw new SegmentScopeError("این گزارش فقط برای مدیر، مدیر فروش و کارشناس است.");
  assertQueryScope(q, scope);
  const wanted = q.columns && q.columns.length ? q.columns : [...DEFAULT_COLUMNS, "canReferRetiree", "creditRank", "amountRange"];
  const columns = wanted.filter((k) => {
    const f = FIELDS.find((x) => x.key === k);
    if (!f) return false;
    if (f.sensitive === "phone" && !includePhones) return false;
    if (f.sensitive === "national" && !includePhones) return false;
    return true;
  });
  const unique = [...new Set(columns.length ? columns : DEFAULT_COLUMNS)];
  const all = filterProfiles(loadProfiles(), q, scope);
  const headers = unique.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k);
  // Add a source column after fields that have sources, as a single «منبع مقدار» summary? Keep one «منبع شغل» etc. for key fields.
  const sourceCols = ["job", "bounced", "canReferRetiree", "creditRank"];
  const headerOut = [...headers];
  const sourceHeaderFor: string[] = [];
  for (const k of unique) {
    if (sourceCols.includes(k)) {
      headerOut.push(`منبع ${FIELDS.find((f) => f.key === k)?.label ?? k}`);
      sourceHeaderFor.push(k);
    }
  }
  const rows = all.map((p) => {
    const vals = unique.map((k) => displayValue(k, p, { phones: includePhones, national: includePhones }));
    for (const k of sourceHeaderFor) vals.push(LABELS.sourceName[p.sources[k]] || p.sources[k] || "");
    return vals;
  });
  const buffer = buildXlsx(headerOut, rows);
  const filename = `gozaresh-moshtarian-${tehranJalaliFileDay()}.xlsx`;
  ensureExportAuditSchema();
  execute(
    `INSERT INTO ${EXPORT_AUDIT_TABLE}(actor_user_id, actor_name, actor_role, filter_json, columns_json, row_count, include_phones, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      actor.id,
      actor.fullName || actor.username,
      actor.baseRole || actor.role,
      JSON.stringify({ source: q.source, includeUnlinkedLeads: q.includeUnlinkedLeads !== false, conditions: q.conditions, match: q.match === "any" ? "any" : "all", scope: scope.kind }),
      JSON.stringify(unique),
      all.length,
      includePhones ? 1 : 0,
      new Date().toISOString(),
    ],
  );
  return { buffer, filename, rowCount: all.length, columns: unique };
}

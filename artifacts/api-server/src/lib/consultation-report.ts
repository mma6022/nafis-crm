/**
 * crm-consult-filters (Mohammad 2026-10-24 18:35): filters + report for the «مشاوره‌ها» list.
 *
 * Pure helpers (no DB access): query parsing, the per-consult derived facts, the filter predicate,
 * the summary and the CSV. The route (routes/consultation-report.ts) loads the role-scoped rows and
 * calls these, so the fixture can test the same code on a DB copy.
 *
 * Data source of each filter (also in CONSULTFILTERS-RELEASE.md):
 *  - date            consultation_forms.created_at (fallback updated_at), compared as a Tehran calendar day
 *  - salesperson     customers.salesperson_id (the customer's CURRENT owner; consultations have no author column)
 *  - plan result / specific plan / plan type
 *                    plan_matches_snapshot (what was shown when the consult was saved, v2) else the live matcher
 *                    (computeConsultationPlanMatches, same as the «طرح‌ها» modal); plan type = loan_plans.loan_type (admin only)
 *  - applicant grade the consult's grade as the list shows it (v≥1: consultation_forms.credit_rank, v0: customers.credit_rank)
 *  - guarantor       consultation_forms.has_guarantor / guarantor_credit_rank
 *  - jobs            consultation_forms.job_type / guarantor_job_type (the 6 consult_options codes)
 *  - cheque          consultation_forms.customer_check_status, else has_check, else the latest first-call checkStatus;
 *                    «چک برگشتی» = latest answered first-call form bouncedCheque = yes
 *  - military        latest «اطلاعات مشاوره» version (customer_consult_profile_versions.military), else latest
 *                    answered first-call form; null / «نمی‌دونه» = «ثبت نشده»
 *  - city            latest profile version city, else latest first-call city, else customers.city
 *  - amount          consultation_forms.requested_amount, parsed (see parseConsultAmountToman)
 *  - next status     a non-deleted loan_applications row with consultation_id = the consult («پرونده تشکیل شد»)
 */

export const JOB_CODES = ["employee_with_insurance", "employee_no_insurance", "business", "no_doc", "retired", "unemployed"] as const;
export const PLAN_RESULTS = ["eligible", "review", "none"] as const;
export const CHEQUE_FILTERS = ["has", "no", "bounced"] as const;
export const MILITARY_FILTERS = ["has_card", "no_card", "female", "unrecorded"] as const;
export const PLAN_TYPES = ["score", "goods"] as const;
const GRADE_RE = /^[A-E][1-3]?$/;

export type PlanResult = (typeof PLAN_RESULTS)[number];
export type ConsultFilters = {
  search?: string;
  from?: string; to?: string;
  salespersonIds: number[];
  planResult?: PlanResult;
  planId?: number;
  planType?: (typeof PLAN_TYPES)[number];
  grades: string[];
  guarantor?: "yes" | "no";
  guarantorGrades: string[];
  jobs: string[];
  guarantorJobs: string[];
  cheque?: (typeof CHEQUE_FILTERS)[number];
  military?: (typeof MILITARY_FILTERS)[number];
  city?: string;
  amountMin?: number; amountMax?: number;
  caseStatus?: "opened" | "not";
};

const one = (v: unknown): string | undefined => {
  const x = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
};
const list = (v: unknown): string[] => {
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? x.split(",") : []));
  return [...new Set(parts.map((x) => x.trim()).filter(Boolean))];
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function oneOf<T extends string>(raw: unknown, allowed: readonly T[], name: string): T | undefined {
  const v = one(raw);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`مقدار «${name}» معتبر نیست.`);
  return v as T;
}

/** Query string → filters. Throws Error(message) on an invalid value (route answers 400). */
export function parseConsultFilters(q: Record<string, unknown>): ConsultFilters {
  const from = one(q.from), to = one(q.to);
  for (const [k, d] of [["from", from], ["to", to]] as const) if (d && !DAY_RE.test(d)) throw new Error(`تاریخ «${k}» معتبر نیست.`);
  if (from && to && from > to) throw new Error("تاریخ شروع نباید بعد از تاریخ پایان باشد.");
  const ints = (raw: unknown, name: string) => list(raw).map((x) => {
    const n = Number(x); if (!Number.isInteger(n) || n <= 0) throw new Error(`مقدار «${name}» معتبر نیست.`); return n;
  });
  const grades = (raw: unknown, name: string) => list(raw).map((g) => {
    const u = g.toUpperCase(); if (!GRADE_RE.test(u)) throw new Error(`رتبه‌ی «${name}» معتبر نیست.`); return u;
  });
  const jobs = (raw: unknown, name: string) => list(raw).map((j) => {
    if (!(JOB_CODES as readonly string[]).includes(j)) throw new Error(`شغل «${name}» معتبر نیست.`); return j;
  });
  const money = (raw: unknown, name: string) => {
    const v = one(raw); if (v === undefined) return undefined;
    const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`مبلغ «${name}» معتبر نیست.`); return n;
  };
  const planId = ints(q.planId, "planId")[0];
  const amountMin = money(q.amountMin, "amountMin"), amountMax = money(q.amountMax, "amountMax");
  if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) throw new Error("حداقل مبلغ نباید از حداکثر بیشتر باشد.");
  const city = one(q.city);
  if (city && [...city].length > 60) throw new Error("شهر حداکثر ۶۰ نویسه است.");
  const search = one(q.search);
  return {
    search: search?.slice(0, 100), from, to,
    salespersonIds: ints(q.salespersonIds, "salespersonIds"),
    planResult: oneOf(q.planResult, PLAN_RESULTS, "planResult"),
    planId,
    planType: oneOf(q.planType, PLAN_TYPES, "planType"),
    grades: grades(q.grades, "grades"),
    guarantor: oneOf(q.guarantor, ["yes", "no"] as const, "guarantor"),
    guarantorGrades: grades(q.guarantorGrades, "guarantorGrades"),
    jobs: jobs(q.jobs, "jobs"),
    guarantorJobs: jobs(q.guarantorJobs, "guarantorJobs"),
    cheque: oneOf(q.cheque, CHEQUE_FILTERS, "cheque"),
    military: oneOf(q.military, MILITARY_FILTERS, "military"),
    city, amountMin, amountMax,
    caseStatus: oneOf(q.caseStatus, ["opened", "not"] as const, "caseStatus"),
  };
}

const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/**
 * requested_amount is free text in old consults («300000000», «500 میلیون تومن», «150 تا 200»).
 * Rule: the FIRST number (thousands separators removed); «میلیارد» → ×1e9; «میلیون» or a number below 100,000 → ×1e6
 * (a bare «300» was typed in million toman); otherwise the number is toman. A range gives its lower bound.
 * (crm.ts parseAmount strips every non-digit, which turns «150 تا 200» into 150200; it is left as is for plan matching.)
 */
export function parseConsultAmountToman(raw: unknown): number | null {
  if (raw == null) return null;
  const s = latin(String(raw)).replace(/(\d)[,٬،](?=\d{3})/g, "$1");
  const m = s.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/میلیارد/.test(s)) return Math.round(n * 1e9);
  if (/میلیون/.test(s) || n < 100000) return Math.round(n * 1e6);
  return Math.round(n);
}

/** Tehran calendar day (YYYY-MM-DD) of a stored timestamp («2026-08-23 04:02:19» = UTC, or ISO). */
const tehranFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" });
export function tehranDayOf(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(stored) ? `${stored.replace(" ", "T")}Z` : stored;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : tehranFmt.format(d);
}

export const normalizeCity = (s: string | null | undefined) =>
  (s ?? "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export type PlanRef = { id: number; name: string; loanType: string | null };
export type MatchLike = { plan: { id: number; name: string; loanType?: string | null }; status: string };
export type DerivedFacts = {
  createdDay: string | null;
  salespersonId: number | null;
  creditRank: string | null;
  hasGuarantor: boolean | null;
  guarantorCreditRank: string | null;
  jobType: string | null;
  guarantorJobType: string | null;
  cheque: "has" | "no" | null;
  bouncedCheque: boolean | null;
  military: "has_card" | "no_card" | "female" | null;
  city: string | null;
  amountToman: number | null;
  planSource: "snapshot" | "live";
  eligiblePlans: PlanRef[];
  reviewPlans: PlanRef[];
  planResult: PlanResult;
  caseId: number | null;
};

/** Per-customer data outside the consult row (latest profile version / first-call form), already parsed. */
export type CustomerExtras = {
  profile?: { military?: unknown; city?: unknown } | null;
  firstCall?: { military?: unknown; city?: unknown; checkStatus?: unknown; bouncedCheque?: unknown } | null;
  customerCity?: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const MIL = ["has_card", "no_card", "female"];

export function deriveFacts(input: {
  createdAt: string | null; salespersonId: number | null; creditRank: string | null;
  hasGuarantor: boolean | null; guarantorCreditRank: string | null; jobType: string | null; guarantorJobType: string | null;
  customerCheckStatus: string | null; hasCheck: boolean | null; requestedAmount: string | null; caseId: number | null;
  planSource: "snapshot" | "live"; matches: MatchLike[]; planTypes: Map<number, string | null>;
}, extras: CustomerExtras): DerivedFacts {
  const ref = (m: MatchLike): PlanRef => ({ id: Number(m.plan.id), name: m.plan.name, loanType: input.planTypes.get(Number(m.plan.id)) ?? m.plan.loanType ?? null });
  const eligiblePlans = input.matches.filter((m) => m.status === "eligible").map(ref);
  const reviewPlans = input.matches.filter((m) => m.status === "needs_review").map(ref);
  const cs = input.customerCheckStatus;
  const fcCheck = str(extras.firstCall?.checkStatus);
  const cheque: DerivedFacts["cheque"] = cs ? (cs === "none" ? "no" : "has")
    : input.hasCheck != null ? (input.hasCheck ? "has" : "no")
      : fcCheck ? (fcCheck === "none" ? "no" : "has") : null;
  const bounced = str(extras.firstCall?.bouncedCheque);
  const milRaw = str(extras.profile?.military) ?? str(extras.firstCall?.military);
  const military = milRaw && MIL.includes(milRaw) ? (milRaw as DerivedFacts["military"]) : null;
  const city = str(extras.profile?.city) ?? str(extras.firstCall?.city) ?? str(extras.customerCity);
  return {
    createdDay: tehranDayOf(input.createdAt),
    salespersonId: input.salespersonId,
    creditRank: input.creditRank?.trim().toUpperCase() || null,
    hasGuarantor: input.hasGuarantor,
    guarantorCreditRank: input.guarantorCreditRank?.trim().toUpperCase() || null,
    jobType: input.jobType, guarantorJobType: input.guarantorJobType,
    cheque, bouncedCheque: bounced === "yes" ? true : bounced === "no" ? false : null,
    military, city,
    amountToman: parseConsultAmountToman(input.requestedAmount),
    planSource: input.planSource, eligiblePlans, reviewPlans,
    planResult: eligiblePlans.length ? "eligible" : reviewPlans.length ? "review" : "none",
    caseId: input.caseId,
  };
}

/**
 * Grade match. A picked sub-grade (B2) matches that sub-grade; a picked letter (B) matches B and B1–B3.
 * A legacy letter-only grade on the consult (B, from before sub-grades) matches any picked B / B1–B3.
 */
export function gradeMatches(value: string | null, picked: string[]): boolean {
  if (!picked.length) return true;
  if (!value) return false;
  return picked.some((p) => p === value || (p.length === 1 && value[0] === p) || (value.length === 1 && p[0] === value));
}

/** Everything except search / salesperson / scope, which the route puts in SQL. */
export function matchesFilters(f: DerivedFacts, q: ConsultFilters): boolean {
  if (q.from && (!f.createdDay || f.createdDay < q.from)) return false;
  if (q.to && (!f.createdDay || f.createdDay > q.to)) return false;
  if (q.salespersonIds.length && (f.salespersonId == null || !q.salespersonIds.includes(f.salespersonId))) return false;
  if (q.planResult && f.planResult !== q.planResult) return false;
  if (q.planId && !f.eligiblePlans.some((p) => p.id === q.planId)) return false;
  if (q.planType && !f.eligiblePlans.some((p) => p.loanType === q.planType)) return false;
  if (!gradeMatches(f.creditRank, q.grades)) return false;
  if (q.guarantor === "yes" && f.hasGuarantor !== true) return false;
  if (q.guarantor === "no" && f.hasGuarantor !== false) return false;
  if (!gradeMatches(f.guarantorCreditRank, q.guarantorGrades)) return false;
  if (q.jobs.length && (!f.jobType || !q.jobs.includes(f.jobType))) return false;
  if (q.guarantorJobs.length && (!f.guarantorJobType || !q.guarantorJobs.includes(f.guarantorJobType))) return false;
  if (q.cheque === "has" && f.cheque !== "has") return false;
  if (q.cheque === "no" && f.cheque !== "no") return false;
  if (q.cheque === "bounced" && f.bouncedCheque !== true) return false;
  if (q.military === "unrecorded" ? f.military != null : q.military && f.military !== q.military) return false;
  if (q.city && !normalizeCity(f.city).includes(normalizeCity(q.city))) return false;
  if ((q.amountMin !== undefined || q.amountMax !== undefined) && f.amountToman == null) return false;
  if (q.amountMin !== undefined && (f.amountToman ?? 0) < q.amountMin) return false;
  if (q.amountMax !== undefined && (f.amountToman ?? 0) > q.amountMax) return false;
  if (q.caseStatus === "opened" && f.caseId == null) return false;
  if (q.caseStatus === "not" && f.caseId != null) return false;
  return true;
}

export type ConsultSummary = { total: number; withPlan: number; reviewOnly: number; noPlan: number; cases: number };
export function summarize(facts: DerivedFacts[]): ConsultSummary {
  return {
    total: facts.length,
    withPlan: facts.filter((f) => f.planResult === "eligible").length,
    reviewOnly: facts.filter((f) => f.planResult === "review").length,
    noPlan: facts.filter((f) => f.planResult === "none").length,
    cases: facts.filter((f) => f.caseId != null).length,
  };
}

/** True when a non-admin asked for an admin-only filter. */
export const usesAdminOnlyFilter = (q: ConsultFilters) => q.planType !== undefined;

// ---- CSV (admin only; customer ID, never the national code; no phone) ----
const JOB_LABEL: Record<string, string> = {
  business: "آزاد با جواز کسب", employee_with_insurance: "کارمند با لیست بیمه", employee_no_insurance: "کارمند بدون لیست بیمه",
  retired: "بازنشسته", no_doc: "آزاد بدون مدرک شغلی", unemployed: "بدون شغل",
};
const MIL_LABEL: Record<string, string> = { has_card: "دارد", no_card: "ندارد", female: "خانم" };
const RESULT_LABEL: Record<PlanResult, string> = { eligible: "طرح مناسب دارد", review: "فقط باید بررسی شود", none: "طرح مناسبی نبود" };
const jalaliFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" });
const jalaliDay = (day: string | null) => (day ? jalaliFmt.format(new Date(`${day}T12:00:00Z`)) : "");
/** Spreadsheet formula injection guard + RFC 4180 quoting. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const CSV_HEADER = ["شناسه مشاوره", "شناسه مشتری", "نام مشتری", "کارشناس", "تاریخ ثبت", "رتبه متقاضی", "شغل متقاضی", "ضامن", "رتبه ضامن",
  "شغل ضامن", "چک", "چک برگشتی", "پایان خدمت", "شهر", "مبلغ درخواستی (تومان)", "نتیجه طرح", "طرح‌های مناسب", "تعداد باید بررسی شود", "پرونده"];
export function csvRow(c: { id: number; customerId: number; customerName: string; customerSalespersonName: string | null }, f: DerivedFacts): string {
  return [
    c.id, `#${c.customerId}`, c.customerName, c.customerSalespersonName ?? "", jalaliDay(f.createdDay), f.creditRank ?? "",
    f.jobType ? JOB_LABEL[f.jobType] ?? f.jobType : "", f.hasGuarantor == null ? "" : f.hasGuarantor ? "دارد" : "ندارد", f.guarantorCreditRank ?? "",
    f.guarantorJobType ? JOB_LABEL[f.guarantorJobType] ?? f.guarantorJobType : "", f.cheque === "has" ? "دارد" : f.cheque === "no" ? "ندارد" : "",
    f.bouncedCheque == null ? "" : f.bouncedCheque ? "دارد" : "ندارد", f.military ? MIL_LABEL[f.military] : "ثبت نشده", f.city ?? "",
    f.amountToman ?? "", RESULT_LABEL[f.planResult], f.eligiblePlans.map((p) => p.name).join("، "), f.reviewPlans.length,
    f.caseId == null ? "" : `#${f.caseId}`,
  ].map(csvCell).join(",");
}

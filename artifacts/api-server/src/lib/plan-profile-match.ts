/**
 * crm-no-plan-option: the applicant/guarantor profile part of plan matching (job, guarantor job, military service),
 * shared by Kazemi's first-call form (team-sales-rules evaluateCondition), the staff request wizard
 * (routes/loan-applications.ts) and the customer portal (routes/customer-portal-loans.ts), so all three agree.
 *
 * Rule (Mohammad 2026-10-24 14:32): a KNOWN answer that a condition rules out makes the condition «نامناسب» with a reason;
 * an unknown / empty answer never removes a plan (first-call form: «بستگی دارد» with the explicit condition).
 * Pure: no DB access.
 */
export const JOB_CODES = ["employee_with_insurance", "employee_no_insurance", "business", "no_doc", "retired", "unemployed"] as const;
export const MILITARY_STATUSES = ["has_card", "no_card", "female", "unknown"] as const;
export type MilitaryStatus = (typeof MILITARY_STATUSES)[number];

/** Labels of consult_options job_type / guarantor_job_type (the list the plan editor uses), for reason texts. */
export const JOB_LABELS: Record<string, string> = {
  business: "آزاد با جواز کسب", employee_with_insurance: "کارمند با لیست بیمه", employee_no_insurance: "کارمند بدون لیست بیمه",
  retired: "بازنشسته", no_doc: "آزاد بدون مدرک شغلی", unemployed: "بدون شغل",
};
export const MILITARY_LABELS: Record<MilitaryStatus, string> = {
  has_card: "دارای پایان خدمت", no_card: "بدون پایان خدمت", female: "مشتری خانم است", unknown: "نمی‌دونه",
};

export type ProfileCondition = {
  /** applicant jobs the condition allows ([] or all six = no restriction) */
  jobs: string[];
  /** guarantor jobs the condition allows ([] or all six = no restriction) */
  gJobs: string[];
  /** loan_plan_conditions.needs_military_service = 1 (NULL/0 = no requirement, the default for every plan) */
  needsMilitary: boolean;
};
export type ApplicantProfile = {
  jobType?: string | null;
  gJobType?: string | null;
  military?: string | null;
};
export type ProfileReasonCode =
  | "job_ok" | "job_not_allowed" | "job_unknown"
  | "guarantor_job_ok" | "guarantor_job_not_allowed" | "guarantor_job_unknown"
  | "military_ok" | "military_required" | "military_unknown";
export type ProfileReason = {
  code: ProfileReasonCode; kind: "met" | "unknown" | "violated";
  have?: string; jobs?: string[]; excludedJobs?: string[];
};

const known = (v: unknown): v is string => typeof v === "string" && (JOB_CODES as readonly string[]).includes(v);
/** Allowed jobs of a rule, or null when the rule does not restrict (empty, or every job listed). */
export function jobRestriction(list: unknown): string[] | null {
  const jobs = [...new Set((Array.isArray(list) ? list : []).map(String))].filter(known);
  return jobs.length && jobs.length < JOB_CODES.length ? jobs : null;
}

/**
 * Reasons for one condition. `guarantor`: "yes" when the customer brings a guarantor (guarantor job is compared),
 * "unknown" when it is not known yet (a guarantor-job rule becomes a «بستگی دارد» condition), "no"/null = skip.
 */
export function profileReasons(c: ProfileCondition, p: ApplicantProfile, guarantor: "yes" | "unknown" | "no" | null = "yes"): ProfileReason[] {
  const out: ProfileReason[] = [];
  const jobs = jobRestriction(c.jobs);
  if (jobs) {
    const excludedJobs = JOB_CODES.filter((j) => !jobs.includes(j));
    if (!known(p.jobType)) out.push({ code: "job_unknown", kind: "unknown", jobs, excludedJobs });
    else if (jobs.includes(p.jobType)) out.push({ code: "job_ok", kind: "met", have: p.jobType, jobs });
    else out.push({ code: "job_not_allowed", kind: "violated", have: p.jobType, jobs, excludedJobs });
  }
  const gJobs = jobRestriction(c.gJobs);
  if (gJobs && (guarantor === "yes" || guarantor === "unknown")) {
    const excludedJobs = JOB_CODES.filter((j) => !gJobs.includes(j));
    if (guarantor === "unknown" || !known(p.gJobType)) out.push({ code: "guarantor_job_unknown", kind: "unknown", jobs: gJobs, excludedJobs });
    else if (gJobs.includes(p.gJobType)) out.push({ code: "guarantor_job_ok", kind: "met", have: p.gJobType, jobs: gJobs });
    else out.push({ code: "guarantor_job_not_allowed", kind: "violated", have: p.gJobType, jobs: gJobs, excludedJobs });
  }
  if (c.needsMilitary) {
    // A woman is exempt from military service: the requirement does not apply.
    if (p.military === "has_card" || p.military === "female") out.push({ code: "military_ok", kind: "met", have: p.military });
    else if (p.military === "no_card") out.push({ code: "military_required", kind: "violated", have: p.military });
    else out.push({ code: "military_unknown", kind: "unknown" });
  }
  return out;
}

const fa = (xs: string[]) => xs.map((j) => JOB_LABELS[j] ?? j);
const or = (xs: string[]) => fa(xs).join(" یا ");
/** Persian text (the dashboard mirrors it in features/team-sales/plan-reasons.ts). */
export function profileReasonText(r: ProfileReason): string {
  switch (r.code) {
    case "job_ok": return `شغل متقاضی: ${JOB_LABELS[r.have ?? ""] ?? r.have}`;
    case "job_not_allowed": return `شغل متقاضی (${JOB_LABELS[r.have ?? ""] ?? r.have}) مجاز نیست؛ فقط ${or(r.jobs ?? [])}`;
    case "job_unknown": {
      const ex = r.excludedJobs ?? [];
      return ex.length && ex.length <= 2 ? `اگر شغل متقاضی ${or(ex)} نباشد` : `اگر شغل متقاضی ${or(r.jobs ?? [])} باشد`;
    }
    case "guarantor_job_ok": return `شغل ضامن: ${JOB_LABELS[r.have ?? ""] ?? r.have}`;
    case "guarantor_job_not_allowed": return `شغل ضامن (${JOB_LABELS[r.have ?? ""] ?? r.have}) مجاز نیست؛ فقط ${or(r.jobs ?? [])}`;
    case "guarantor_job_unknown": {
      const ex = r.excludedJobs ?? [];
      return ex.length && ex.length <= 2 ? `اگر شغل ضامن ${or(ex)} نباشد` : `اگر شغل ضامن ${or(r.jobs ?? [])} باشد`;
    }
    case "military_ok": return r.have === "female" ? "پایان خدمت لازم نیست (خانم)" : "پایان خدمت دارد";
    case "military_required": return "نیاز به پایان خدمت";
    case "military_unknown": return "اگر پایان خدمت داشته باشد";
    default: return "";
  }
}

const parseList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try { const x = JSON.parse(String(v ?? "[]")); return Array.isArray(x) ? x.map(String) : []; } catch { return []; }
};
/** A raw loan_plan_conditions row → the profile part of the rule. */
export function profileConditionFromRow(row: Record<string, unknown> | null | undefined): ProfileCondition {
  return {
    jobs: parseList(row?.customer_jobs), gJobs: parseList(row?.guarantor_jobs),
    needsMilitary: Number(row?.needs_military_service ?? 0) === 1,
  };
}
/** Wizard / portal: a condition stays offered unless a KNOWN answer rules it out. */
export function rowAllowsProfile(row: Record<string, unknown> | null | undefined, profile: ApplicantProfile | null): boolean {
  if (!profile) return true;
  return !profileReasons(profileConditionFromRow(row), profile, profile.gJobType ? "yes" : null).some((r) => r.kind === "violated");
}
/** Normalises a stored/submitted answer: unknown values become null («نمی‌دونه» is kept as "unknown" for military). */
export function cleanProfile(a: Record<string, unknown> | null | undefined): ApplicantProfile {
  const job = (v: unknown) => (known(v) ? v : v === "unknown" ? "unknown" : null);
  const mil = typeof a?.military === "string" && (MILITARY_STATUSES as readonly string[]).includes(a.military) ? a.military : null;
  return { jobType: job(a?.jobType), gJobType: job(a?.gJobType), military: mil };
}

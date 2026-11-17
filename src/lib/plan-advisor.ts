/**
 * plan-advisor v1 («دستیار مشاوره»: پیشنهاد طرح + ماشین‌حساب کارشناس).
 * Flag: flag.plan_advisor_v1 (call_queue_settings, global, absent/≠'1' = OFF). OFF → every route 404s.
 * Calculator reuses plan-quote-math.ts, plan-profile-match.ts (via evaluatePlans) and loan-plan-net-amount percents.
 * No writes to loan_plans, contracts, team_sales_config or notification_settings. No sapi/credit/identity calls.
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import {
  applicationInstallment, calculatorCeiling, customerPayout, displayPlanTerms, parseCalculatorAmount,
  planAnnualInterest, planPayoutPercent, principalCeiling, type PublicLoanPlanDetails,
} from "./plan-quote-math";
import { evaluatePlans, plansFromRows, planReasonText, type QualifierAnswers } from "./team-sales-rules";
import { siteAnswersForCustomer } from "./site-apply";
import { JOB_LABELS } from "./plan-profile-match";

export const PA_FLAG = "flag.plan_advisor_v1";
export const paOn = (): boolean => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [PA_FLAG])?.value === "1"; }
  catch { return false; }
};

const OVERRIDE_TABLE = "plan_advisor_overrides";
let ready = false;
/** Additive, flag-gated store for chip edits on the case. Created only when the flag is ON. */
export function ensurePaSchema(): void {
  if (ready || !paOn()) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS ${OVERRIDE_TABLE} (
      customer_id INTEGER PRIMARY KEY,
      actor_user_id INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ready = true;
}

type PlanRow = Record<string, unknown>;
function activePlanRows(): PlanRow[] {
  return queryRows<PlanRow>("SELECT * FROM loan_plans WHERE active=1 ORDER BY id");
}
function activePlansForMatch() {
  return plansFromRows(activePlanRows(), queryRows<PlanRow>("SELECT * FROM loan_plan_conditions ORDER BY plan_id, sort_order, id"));
}

function toPublicPlan(row: PlanRow): PublicLoanPlanDetails {
  let terms: PublicLoanPlanDetails["installmentTerms"] = null;
  try {
    const raw = row.installment_terms;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) terms = parsed as any;
  } catch { /* keep null */ }
  return {
    principalAmount: row.principal_amount as any,
    annualInterest: row.annual_interest as any,
    installments: row.installments == null ? null : String(row.installments),
    installmentTerms: terms,
    depositPercents: row.deposit_percents as any,
    prepaymentPercents: row.prepayment_percents as any,
    deductPercents: row.deduct_percents as any,
  };
}

export type PaQuote = {
  planId: number; planName: string; principal: number; months: number;
  ceiling: number | null; overCeiling: boolean;
  depositAmount: number | null; installment: number | null; count: number;
  annualInterest: number | null; depositPercent: number | null;
  downPayment: number; deduction: number | null; filingFee: number;
  commission: number | null; commissionPercent: number | null;
  installmentsTotal: number | null; totalPayable: number | null;
};

type PaQuoteMeta = { planId: number; planName: string; filingFee: number; commissionPercent: number | null };

/** Same formulas as paQuote, for a plan object — used by tests with the mockup inputs (no loan_plans writes). */
export function paQuoteFromPlan(plan: PublicLoanPlanDetails, meta: PaQuoteMeta, principal: number, months: number): PaQuote | { error: string } {
  if (!Number.isSafeInteger(principal) || principal <= 0) return { error: "invalid_principal" };
  if (!Number.isInteger(months) || months <= 0 || months > 600) return { error: "invalid_term" };
  const durations = displayPlanTerms(plan).map((t) => t.installments);
  if (durations.length && !durations.includes(months)) return { error: "term_not_allowed" };
  const ceiling = calculatorCeiling(plan, months) ?? principalCeiling(plan);
  const overCeiling = ceiling != null && principal > ceiling;
  const term = displayPlanTerms(plan).find((t) => t.installments === months);
  const depositAmount = overCeiling ? null : customerPayout(plan, principal, months);
  const installment = overCeiling ? null : applicationInstallment(plan, principal, months);
  const annualInterest = planAnnualInterest(plan, months);
  const depositPercent = planPayoutPercent(plan, months);
  const downPayment = !overCeiling && term?.prepaymentPercent ? Math.round(principal * term.prepaymentPercent / 100) : 0;
  const deduction = !overCeiling && term?.deductionPercent != null ? Math.round(principal * term.deductionPercent / 100) : null;
  const filingFee = meta.filingFee || 0;
  const commissionPercent = meta.commissionPercent;
  const commission = !overCeiling && commissionPercent != null && Number.isFinite(commissionPercent)
    ? Math.round(principal * commissionPercent / 100) : null;
  const installmentsTotal = installment != null ? installment * months : null;
  const totalPayable = installmentsTotal != null ? installmentsTotal + downPayment + filingFee : null;
  return {
    planId: meta.planId, planName: meta.planName, principal, months, ceiling, overCeiling,
    depositAmount, installment, count: months, annualInterest, depositPercent,
    downPayment, deduction, filingFee, commission, commissionPercent,
    installmentsTotal, totalPayable,
  };
}

/** Exact expert calculator. Inputs: principal + term. Deposit is an output. Commission is separate from total payable. */
export function paQuote(planId: number, principal: number, months: number): PaQuote | { error: string } {
  const row = queryRow<PlanRow>("SELECT * FROM loan_plans WHERE id=? AND active=1", [planId]);
  if (!row) return { error: "plan_not_found" };
  const plan = toPublicPlan(row);
  const commissionPercent = row.loan_type === "goods" || row.loan_type === "purchase"
    ? (parseCalculatorAmount(row.commission_percent) != null ? Number(row.commission_percent) : (Number(row.commission_percent) || null))
    : (Number(row.commission_percent) > 0 ? Number(row.commission_percent) : null);
  const name = [row.name, row.bank_name].filter(Boolean).map(String).join(" — ");
  return paQuoteFromPlan(plan, {
    planId, planName: name || String(row.name ?? ""),
    filingFee: parseCalculatorAmount(row.filing_fee_toman) ?? 0,
    commissionPercent,
  }, principal, months);
}

type ChipSource = "site" | "inquiry" | "file";
export type PaChip = { key: string; label: string; value: string; raw: unknown; source: ChipSource | null; editable: boolean };
export type PaCredit = {
  rank: string | null; chequeColor: string | null; bouncedCount: number | null;
  loanDebtToman: number | null; inquiryAt: string | null;
};
export type PaPlanCard = {
  planId: number; name: string; bankName: string; loanType: string; status: "fit" | "depends" | "no";
  max: number; installments: number[]; reasons: string[]; info: string[];
};

function overrideOf(customerId: number): Record<string, unknown> {
  if (!paOn()) return {};
  try {
    const r = queryRow<{ payload_json: string }>(`SELECT payload_json FROM ${OVERRIDE_TABLE} WHERE customer_id=?`, [customerId]);
    return r ? (JSON.parse(r.payload_json) ?? {}) : {};
  } catch { return {}; }
}

function latestAnswers(customerId: number): QualifierAnswers {
  const ov = overrideOf(customerId);
  let a: QualifierAnswers = { callResult: "answered", formVersion: 2, mode: "simple" };
  try {
    const row = queryRow<{ answers_json: string }>(
      `SELECT answers_json FROM team_sales_qualifications WHERE customer_id=? AND call_result='answered' ORDER BY id DESC LIMIT 1`, [customerId]);
    if (row) a = { ...a, ...(JSON.parse(row.answers_json) ?? {}) };
  } catch { /* none */ }
  const site = (() => { try { return siteAnswersForCustomer(customerId).latest?.answers ?? null; } catch { return null; } })();
  const jobMap: Record<string, string> = {
    employee: "employee_with_insurance", employed: "employee_with_insurance",
    self_employed: "business", business: "business", retired: "retired", unemployed: "unemployed",
  };
  if (!a.jobType && site?.job_status) a.jobType = jobMap[String(site.job_status)] ?? (site.job_status as any);
  if (!a.creditRank && site?.credit_rank) a.creditRank = site.credit_rank as any;
  if (!a.loanPref && site?.loan_purpose) a.loanPref = site.loan_purpose === "goods" || String(site.loan_purpose).includes("کالا") ? "goods" : a.loanPref;
  if (a.amountMillion == null && site?.amount_range) {
    const n = Number(String(site.amount_range).replace(/[^\d]/g, ""));
    if (n > 0) a.amountMillion = n >= 1000 ? Math.round(n / 1e6) : n;
  }
  if (!a.military && site?.has_military_card) a.military = site.has_military_card === "yes" ? "has_card" : site.has_military_card === "no" ? "no_card" : a.military;
  if (!a.bouncedCheque && site?.has_bounced_or_overdue) a.bouncedCheque = site.has_bounced_or_overdue === "yes" ? "yes" : site.has_bounced_or_overdue === "no" ? "no" : a.bouncedCheque;
  if (!a.guarantorAvailable) a.guarantorAvailable = (Number(a.guarantorCount) > 0 || a.guarantorAvailable === "yes") ? "yes" : a.guarantorAvailable;
  // official ICS24 rank on the customer row wins as inquiry when present
  try {
    const c = queryRow<{ credit_rank: string | null }>("SELECT credit_rank FROM customers WHERE id=?", [customerId]);
    if (c?.credit_rank) a.creditRank = c.credit_rank;
  } catch { /* col may be absent */ }
  return { ...a, ...ov, callResult: "answered", formVersion: 2, mode: "simple" };
}

function chipSource(customerId: number, key: string, fromInquiry = false): ChipSource | null {
  if (fromInquiry) return "inquiry";
  try {
    const site = siteAnswersForCustomer(customerId).latest;
    if (!site) return "file";
    const a = site.answers;
    const has: Record<string, boolean> = {
      jobType: Boolean(a.job_status),
      creditRank: Boolean(a.credit_rank),
      loanPref: Boolean(a.loan_purpose),
      amountMillion: Boolean(a.amount_range),
      military: Boolean(a.has_military_card),
      bouncedCheque: Boolean(a.has_bounced_or_overdue),
    };
    return has[key] ? "site" : "file";
  } catch { return "file"; }
}

function jobFa(v: unknown): string {
  if (v == null || v === "unknown") return "نامشخص";
  return JOB_LABELS[String(v)] ?? String(v);
}
function purposeFa(v: unknown): string {
  if (v === "goods") return "خرید کالا";
  if (v === "score" || v === "cash") return "نقدی";
  if (v === "both") return "کالا یا نقدی";
  return v ? String(v) : "نامشخص";
}
function tomanFaLabel(n: number): string {
  return `${n.toLocaleString("fa-IR")} تومان`;
}

function readCredit(customerId: number): PaCredit {
  const out: PaCredit = { rank: null, chequeColor: null, bouncedCount: null, loanDebtToman: null, inquiryAt: null };
  try {
    const c = queryRow<{ credit_rank: string | null }>("SELECT credit_rank FROM customers WHERE id=?", [customerId]);
    if (c?.credit_rank) out.rank = c.credit_rank;
  } catch { /* */ }
  try {
    const exists = queryRow("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='customer_debt_inquiries'");
    if (!exists) return out;
    const r = queryRow<{ created_at: string; unpaid_json: string | null; color_json: string | null; loans_json: string | null }>(
      `SELECT created_at, unpaid_json, color_json, loans_json FROM customer_debt_inquiries WHERE customer_id=? ORDER BY id DESC LIMIT 1`, [customerId]);
    if (!r) return out;
    out.inquiryAt = r.created_at;
    if (r.color_json) {
      try {
        const j = JSON.parse(r.color_json);
        out.chequeColor = j?.chequeColor ?? j?.data?.chequeColor ?? null;
      } catch { /* */ }
    }
    if (r.unpaid_json) {
      try {
        const j = JSON.parse(r.unpaid_json);
        const n = j?.count ?? j?.data?.count ?? (Array.isArray(j?.chequeList) ? j.chequeList.length : null);
        out.bouncedCount = n == null ? null : Number(n);
      } catch { /* */ }
    }
    if (r.loans_json) {
      try {
        const j = JSON.parse(r.loans_json);
        const rial = j?.info?.debtTotalAmount ?? j?.data?.info?.debtTotalAmount ?? j?.debtTotalAmount;
        if (rial != null && Number.isFinite(Number(rial))) out.loanDebtToman = Math.round(Number(rial) / 10);
      } catch { /* */ }
    }
  } catch { /* no credit-panel table */ }
  return out;
}

export function paSuggest(customerId: number): {
  customer: { id: number; name: string };
  chips: PaChip[];
  credit: PaCredit;
  plans: PaPlanCard[];
  answers: QualifierAnswers;
} {
  const c = queryRow<{ id: number; name: string }>("SELECT id, name FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c) throw Object.assign(new Error("not_found"), { status: 404 });
  const answers = latestAnswers(customerId);
  const credit = readCredit(customerId);
  if (credit.rank) answers.creditRank = credit.rank;
  const amount = Number(answers.amountMillion) || 0;
  const chips: PaChip[] = [
    { key: "jobType", label: "شغل", value: `شغل: ${jobFa(answers.jobType)}`, raw: answers.jobType ?? null, source: chipSource(customerId, "jobType"), editable: true },
    { key: "creditRank", label: "رتبه", value: `رتبه: ${answers.creditRank && answers.creditRank !== "unknown" ? answers.creditRank : "نامشخص"}`, raw: answers.creditRank ?? null, source: credit.rank ? "inquiry" : chipSource(customerId, "creditRank"), editable: true },
    { key: "guarantorAvailable", label: "ضامن", value: answers.guarantorAvailable === "yes" || Number(answers.guarantorCount) > 0 ? "ضامن دارد" : answers.guarantorAvailable === "no" ? "بدون ضامن" : "ضامن نامشخص", raw: answers.guarantorAvailable ?? null, source: "file", editable: true },
    { key: "loanPref", label: "برای", value: `برای: ${purposeFa(answers.loanPref)}`, raw: answers.loanPref ?? null, source: chipSource(customerId, "loanPref"), editable: true },
    { key: "amountMillion", label: "مبلغ", value: amount ? `مبلغ: ${tomanFaLabel(amount * 1_000_000)}` : "مبلغ نامشخص", raw: amount || null, source: chipSource(customerId, "amountMillion"), editable: true },
  ];
  if (credit.chequeColor) {
    chips.push({ key: "chequeColor", label: "رنگ چک", value: `رنگ چک: ${colorFa(credit.chequeColor)}`, raw: credit.chequeColor, source: "inquiry", editable: false });
  }
  if (credit.loanDebtToman != null) {
    chips.push({ key: "loanDebt", label: "مانده بدهی", value: `مانده بدهی: ${tomanFaLabel(credit.loanDebtToman)}`, raw: credit.loanDebtToman, source: "inquiry", editable: false });
  }
  const evals = evaluatePlans(answers, activePlansForMatch());
  const plans: PaPlanCard[] = evals.map((e) => {
    const row = queryRow<PlanRow>("SELECT * FROM loan_plans WHERE id=?", [e.planId]);
    const plan = row ? toPublicPlan(row) : null;
    const terms = plan ? displayPlanTerms(plan).map((t) => t.installments) : (e.installments ?? []);
    const reasons = e.reasons.filter((r) => r.kind === "met" || r.kind === "unknown" || r.kind === "warning").slice(0, 3).map((r) => shortReason(r.code, planReasonText(r), e));
    const info: string[] = [];
    if (credit.bouncedCount && credit.bouncedCount > 0) info.push(`${credit.bouncedCount.toLocaleString("fa-IR")} چک برگشتی`);
    const name = [e.planName, e.bankName].filter(Boolean).join(" — ") || e.planName;
    return { planId: e.planId, name, bankName: e.bankName, loanType: e.loanType, status: e.status, max: e.max, installments: terms.length ? terms : e.installments, reasons, info };
  });
  return { customer: { id: Number(c.id), name: String(c.name ?? "") }, chips, credit, plans, answers };
}

function colorFa(v: string): string {
  const m: Record<string, string> = { yellow: "زرد", red: "قرمز", orange: "نارنجی", green: "سبز", white: "سفید", brown: "قهوه‌ای", black: "سیاه" };
  return m[v.toLowerCase()] ?? v;
}
function shortReason(code: string, text: string, e: { loanType?: string }): string {
  if (code === "rank_ok") return text.replace(/^رتبه\s+/i, "رتبه ");
  if (code === "guarantor_ok") return "ضامن دارد";
  if (code === "applicant_salary" || code.includes("salary")) return "کسر از حقوق";
  if (code === "job_ok") return text.replace(/^شغل\s*/i, "") || "شغل";
  if (e.loanType === "goods" || e.loanType === "purchase") return text === "خرید کالا" ? text : text;
  return text.length > 28 ? text.slice(0, 28) : text;
}

export function paSaveChips(customerId: number, actorUserId: number, patch: Record<string, unknown>): ReturnType<typeof paSuggest> {
  ensurePaSchema();
  const allowed = ["jobType", "creditRank", "guarantorAvailable", "loanPref", "amountMillion", "military", "bouncedCheque", "gRank", "salaryDeduct"];
  const prev = overrideOf(customerId);
  const next: Record<string, unknown> = { ...prev };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  if ("amountMillion" in patch) {
    const n = Number(patch.amountMillion);
    next.amountMillion = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (next.guarantorAvailable === "yes") next.guarantorCount = 1;
  if (next.guarantorAvailable === "no") next.guarantorCount = 0;
  execute(
    `INSERT INTO ${OVERRIDE_TABLE}(customer_id, actor_user_id, payload_json, updated_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(customer_id) DO UPDATE SET actor_user_id=excluded.actor_user_id, payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
    [customerId, actorUserId, JSON.stringify(next)],
  );
  return paSuggest(customerId);
}

export type PaCustomerHit = { id: number; name: string };
/** Locked experts: first 30 of the today short list (GET /sales-fixes/my-customers shape). Others: own (or all for admin). */
export function paSearchCustomers(u: { id: number; role: string; salespersonId: number | null }, q: string, locked: boolean): PaCustomerHit[] {
  const text = String(q ?? "").trim();
  const like = `%${text.replace(/[%_]/g, "")}%`;
  const match = (c: PaCustomerHit) => !text || c.name.includes(text) || String(c.id) === text;
  /** Official today short list: first 30 owned, newest activity first (same order as GET /sales-fixes/my-customers). */
  const shortList = (sp: number, limit: number) => queryRows<PaCustomerHit>(
    `SELECT c.id, c.name FROM customers c
     WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id=?
     ORDER BY COALESCE((SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id), c.created_at) DESC, c.id DESC
     LIMIT ?`, [sp, limit]);
  if (locked) {
    if (u.salespersonId == null) return [];
    return shortList(Number(u.salespersonId), 30).filter(match);
  }
  if (u.role === "admin" || u.role === "manager") {
    return queryRows<PaCustomerHit>(
      `SELECT c.id, c.name FROM customers c WHERE c.merged_into_customer_id IS NULL
       ${text.length >= 1 ? "AND (c.name LIKE ? OR CAST(c.id AS TEXT)=?)" : ""}
       ORDER BY c.id DESC LIMIT 20`, text.length >= 1 ? [like, text] : []);
  }
  if (u.salespersonId == null) return [];
  return queryRows<PaCustomerHit>(
    `SELECT c.id, c.name FROM customers c
     WHERE c.merged_into_customer_id IS NULL AND c.salesperson_id=?
       ${text.length >= 1 ? "AND (c.name LIKE ? OR CAST(c.id AS TEXT)=?)" : ""}
     ORDER BY COALESCE((SELECT MAX(l.created_at) FROM call_logs l WHERE l.customer_id=c.id), c.created_at) DESC, c.id DESC
     LIMIT 20`, text.length >= 1 ? [u.salespersonId, like, text] : [u.salespersonId]);
}

export function paCustomerExists(id: number): boolean {
  return Boolean(queryRow("SELECT 1 x FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [id]));
}

/**
 * crm-consult-filters: GET /consultations/report (filtered list + summary, every role with consultations.view,
 * same customer scope as GET /consultations) and GET /consultations/report/export (CSV, admin only).
 * Read-only: no writes, no SMS. Mounted before crmRouter so «/consultations/report» never reaches «/consultations/:id».
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { requirePermission } from "../lib/access-control";
import type { AuthUser } from "../lib/auth";
import { queryRows, type SqlValue } from "../lib/crm-db";
import { customerSearchSql } from "../lib/customer-id-search";
import {
  CSV_HEADER, csvRow, deriveFacts, matchesFilters, parseConsultFilters, summarize, usesAdminOnlyFilter,
  type ConsultFilters, type CustomerExtras, type DerivedFacts, type MatchLike,
} from "../lib/consultation-report";
import { activeMatchPlans, computeConsultationPlanMatches, consultationFromRow } from "./crm";

type Row = Parameters<typeof consultationFromRow>[0] & {
  plan_matches_snapshot?: string | null; customer_salesperson_id?: number | null; customer_city?: string | null; case_id?: number | null;
};
type Consultation = ReturnType<typeof consultationFromRow>;
export type ReportEntry = { consultation: Consultation; facts: DerivedFacts };

const isAdmin = (u: AuthUser) => u.role === "admin";
/** The consult's salesperson for the filter: the author's salesperson, else the customer's current one. */
const OWNER_SQL = "COALESCE((SELECT u.salesperson_id FROM users u WHERE u.id = cf.author_user_id), c.salesperson_id)";
const tableExists = (name: string) => queryRows<{ x: number }>("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
const parseJson = (s: string | null | undefined): Record<string, unknown> | null => {
  if (!s) return null;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
};

function customerExtras(ids: number[]): Map<number, CustomerExtras> {
  const out = new Map<number, CustomerExtras>();
  const uniq = [...new Set(ids)];
  const hasProfiles = tableExists("customer_consult_profile_versions");
  const hasFirstCall = tableExists("team_sales_qualifications");
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500), marks = chunk.map(() => "?").join(",");
    if (hasProfiles) for (const r of queryRows<{ customer_id: number; data_json: string }>(
      `SELECT customer_id, data_json FROM customer_consult_profile_versions WHERE id IN
        (SELECT MAX(id) FROM customer_consult_profile_versions WHERE customer_id IN (${marks}) GROUP BY customer_id)`, chunk)) {
      out.set(Number(r.customer_id), { ...out.get(Number(r.customer_id)), profile: parseJson(r.data_json) });
    }
    if (hasFirstCall) for (const r of queryRows<{ customer_id: number; answers_json: string }>(
      `SELECT customer_id, answers_json FROM team_sales_qualifications WHERE id IN
        (SELECT MAX(id) FROM team_sales_qualifications WHERE call_result='answered' AND customer_id IN (${marks}) GROUP BY customer_id)`, chunk)) {
      const a = parseJson(r.answers_json);
      if (a?.formVersion === 2) out.set(Number(r.customer_id), { ...out.get(Number(r.customer_id)), firstCall: a });
    }
  }
  return out;
}

/** Role-scoped rows (SQL: scope, search, salesperson), then derived facts + the remaining filters in memory. */
export function consultationReport(user: AuthUser, q: ConsultFilters): ReportEntry[] {
  const where: string[] = [], params: SqlValue[] = [];
  if (user.customerScope === "assigned") { where.push("c.salesperson_id = ?"); params.push(user.salespersonId); }
  const idSearch = q.search ? customerSearchSql(q.search) : null;
  if (q.search && idSearch) {
    const t = idSearch.text;
    const clause = idSearch.where(
      "(crm_persian_search_key(c.name) LIKE crm_persian_search_key(?) OR c.phone LIKE ? OR LOWER(COALESCE(cf.loan_purpose, '')) LIKE LOWER(?))",
      [`%${t}%`, `%${t}%`, `%${t}%`], "c.id");
    where.push(clause.sql); params.push(...clause.params);
  }
  // crm-plans-consult (PM 2026-10-25): «کارشناس» = the consult's author (their salesperson) when recorded, else the
  // customer's current salesperson (every consult saved before author_user_id existed).
  if (q.salespersonIds.length) { where.push(`${OWNER_SQL} IN (${q.salespersonIds.map(() => "?").join(",")})`); params.push(...q.salespersonIds); }
  const order = idSearch?.orderPrefix("c.id") ?? { sql: "", params: [] };
  const rows = queryRows<Row>(`
    SELECT cf.*, c.name AS customer_name, c.phone AS customer_phone, c.credit_rank AS customer_credit_rank,
      s.name AS customer_salesperson_name, ${OWNER_SQL} AS customer_salesperson_id, c.city AS customer_city,
      au.full_name AS author_name,
      (SELECT MIN(la.id) FROM loan_applications la WHERE la.consultation_id = cf.id AND la.deleted_at IS NULL) AS case_id
    FROM consultation_forms cf JOIN customers c ON c.id = cf.customer_id LEFT JOIN salespersons s ON s.id = c.salesperson_id
    LEFT JOIN users au ON au.id = cf.author_user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order.sql}cf.created_at DESC, cf.id DESC`, [...params, ...order.params]);
  const extras = customerExtras(rows.map((r) => Number(r.customer_id)));
  const planTypes = new Map(queryRows<{ id: number; loan_type: string | null }>("SELECT id, loan_type FROM loan_plans").map((p) => [Number(p.id), p.loan_type]));
  let livePlans: ReturnType<typeof activeMatchPlans> | undefined;
  const out: ReportEntry[] = [];
  for (const row of rows) {
    const consultation = consultationFromRow(row);
    const snap = parseJson(row.plan_matches_snapshot);
    const snapMatches = Array.isArray(snap?.matches) ? (snap.matches as MatchLike[]) : null;
    const matches: MatchLike[] = snapMatches ?? computeConsultationPlanMatches(consultation, (livePlans ??= activeMatchPlans()));
    const facts = deriveFacts({
      createdAt: consultation.createdAt ?? null, salespersonId: row.customer_salesperson_id == null ? null : Number(row.customer_salesperson_id),
      creditRank: consultation.creditRank, hasGuarantor: consultation.hasGuarantor, guarantorCreditRank: consultation.guarantorCreditRank,
      jobType: consultation.jobType, guarantorJobType: consultation.guarantorJobType, customerCheckStatus: consultation.customerCheckStatus,
      hasCheck: consultation.hasCheck, requestedAmount: consultation.requestedAmount,
      requestedAmountToman: consultation.requestedAmountToman, militaryStatus: consultation.militaryStatus, caseId: row.case_id == null ? null : Number(row.case_id),
      planSource: snapMatches ? "snapshot" : "live", matches, planTypes,
    }, { ...extras.get(Number(row.customer_id)), customerCity: row.customer_city ?? null });
    if (matchesFilters(facts, q)) out.push({ consultation, facts });
  }
  return out;
}

function parse(req: Request, res: Response): ConsultFilters | null {
  const user = res.locals.authUser as AuthUser;
  let q: ConsultFilters;
  try { q = parseConsultFilters(req.query as Record<string, unknown>); } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "فیلتر معتبر نیست." }); return null;
  }
  if (usesAdminOnlyFilter(q) && !isAdmin(user)) { res.status(403).json({ error: "فیلتر نوع طرح فقط برای مدیر است." }); return null; }
  return q;
}
/** Non-admins never receive plan types. */
const publicFacts = (f: DerivedFacts, admin: boolean): DerivedFacts => admin ? f : {
  ...f, eligiblePlans: f.eligiblePlans.map((p) => ({ ...p, loanType: null })), reviewPlans: f.reviewPlans.map((p) => ({ ...p, loanType: null })),
};

const router: IRouter = Router();

router.get("/consultations/report", requirePermission("consultations.view"), (req, res): void => {
  const user = res.locals.authUser as AuthUser;
  const q = parse(req, res); if (!q) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const all = consultationReport(user, q);
  const admin = isAdmin(user);
  const plans = queryRows<{ id: number; name: string; active: number; loan_type: string | null }>(
    "SELECT id, name, active, loan_type FROM loan_plans ORDER BY active DESC, name, id");
  res.json({
    items: all.slice(offset, offset + limit).map(({ consultation, facts }) => ({ ...consultation, facts: publicFacts(facts, admin) })),
    total: all.length, limit, offset,
    summary: summarize(all.map((e) => e.facts)),
    plans: plans.map((p) => ({ id: Number(p.id), name: p.name, active: Boolean(p.active), ...(admin ? { loanType: p.loan_type } : {}) })),
    canExport: admin, canFilterPlanType: admin, salespersonScoped: user.customerScope === "assigned",
  });
});

router.get("/consultations/report/export", requirePermission("consultations.view"), (req, res): void => {
  const user = res.locals.authUser as AuthUser;
  if (!isAdmin(user)) { res.status(403).json({ error: "خروجی فقط برای مدیر است." }); return; }
  const q = parse(req, res); if (!q) return;
  const all = consultationReport(user, q);
  const body = "\ufeff" + [CSV_HEADER.join(","), ...all.map((e) => csvRow(e.consultation, e.facts))].join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="consultations-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(body);
});

export default router;

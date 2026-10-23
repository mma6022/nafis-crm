import { Router, type IRouter } from "express";
import { requireAuth, type AuthUser } from "../lib/auth";
import { requirePermission } from "../lib/access-control";
import { queryRows, type SqlValue } from "../lib/crm-db";
import { buildSalesReport, reportQueryWindow, type CustomerRow, type CallRow, type ApplicationRow } from "../lib/sales-report";

const router: IRouter = Router();
router.get("/sales-reports", requireAuth, requirePermission("reports.view"), (req, res): void => {
  const user = res.locals.authUser as AuthUser;
  const canSelectSalesperson = user.role === "admin" && user.customerScope === "all";
  const selected = req.query.salespersonId;
  if (selected !== undefined && (typeof selected !== "string" || !/^[1-9]\d*$/.test(selected) || !Number.isSafeInteger(Number(selected)))) {
    res.status(400).json({ error: "فروشنده انتخاب‌شده معتبر نیست." }); return;
  }
  if (!canSelectSalesperson && selected !== undefined && Number(selected) !== user.salespersonId) {
    res.status(403).json({ error: "مشاهده گزارش فروشنده دیگر مجاز نیست." }); return;
  }
  const salespersonId = canSelectSalesperson ? (selected === undefined ? null : Number(selected)) : user.salespersonId;
  // Never let an unlinked non-admin account silently obtain an all-customer report.
  const scope = canSelectSalesperson && salespersonId === null ? "" : " AND c.salesperson_id = ?";
  const params: SqlValue[] = scope ? [salespersonId ?? -1] : [];
  const input: Record<string, string> = {};
  for (const key of ["period", "anchor", "from", "to", "granularity"]) {
    const value = req.query[key];
    if (value !== undefined && typeof value !== "string") { res.status(400).json({ error: "پارامتر گزارش معتبر نیست." }); return; }
    if (typeof value === "string") input[key] = value;
  }
  try {
    const window = reportQueryWindow(input);
    const activityParams: SqlValue[] = [...params, window.from, window.until];
    const customers = queryRows<CustomerRow>(`SELECT c.id,c.phone,c.created_at,c.salesperson_id FROM customers c WHERE c.merged_into_customer_id IS NULL${scope}`, params);
    const calls = queryRows<CallRow>(`
      SELECT cl.customer_id,COALESCE(e.started_at,cl.created_at) AS created_at,e.status,e.mobile_answered_at
      FROM call_logs cl JOIN customers c ON c.id=cl.customer_id
      LEFT JOIN voip_after_call_events e ON e.call_log_id=cl.id
      WHERE c.merged_into_customer_id IS NULL${scope} AND COALESCE(e.is_live,0)=0
        AND julianday(COALESCE(e.started_at,cl.created_at))>=julianday(?) AND julianday(COALESCE(e.started_at,cl.created_at))<julianday(?)
      UNION ALL
      SELECT e.customer_id,e.started_at AS created_at,e.status,e.mobile_answered_at
      FROM voip_after_call_events e JOIN customers c ON c.id=e.customer_id
      WHERE e.call_log_id IS NULL AND e.is_live=0 AND c.merged_into_customer_id IS NULL${scope}
        AND julianday(e.started_at)>=julianday(?) AND julianday(e.started_at)<julianday(?)`, [...activityParams, ...activityParams]);
    const applications = queryRows<ApplicationRow>(`SELECT a.id,a.customer_id,a.created_at,a.requested_amount,a.is_pre_registration
      FROM loan_applications a JOIN customers c ON c.id=a.customer_id
      WHERE a.deleted_at IS NULL AND c.merged_into_customer_id IS NULL${scope}
        AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?)`, activityParams);
    const report = buildSalesReport(customers, calls, applications, input);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ ...report, scope: { salespersonId, canSelectSalesperson },
      salespeople: canSelectSalesperson ? queryRows<{id:number;name:string}>("SELECT id,name FROM salespersons ORDER BY name,id") : [] });
  } catch (error) {
    if (error instanceof Error && /تاریخ|بازه|نمودار/.test(error.message)) { res.status(400).json({ error: error.message }); return; }
    throw error;
  }
});
export default router;

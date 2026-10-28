/**
 * incoming2-59 · PM rule (10:56): a customer's first-call form is "incomplete" for the qualifier (Kazemi) when:
 *   the qualifier's own customer, status in_progress, priority NULL (= the useCallLauncher / sales-assist 'simple' rule), AND
 *   no team_sales_qualifications row covers the customer's latest call_log, OR there is no call_log and the customer came in through
 *   the «تماس ورودی داشتم» wizard (lead_source inbound_call, registered by this user) with no qualification at all.
 * Inferred from existing data only; never writes; no reminders/tasks. Closers (Hasani/Ghasemi) and everyone else: always false.
 */
import { queryRow } from "./crm-db";
import { getTeamSalesConfig } from "./team-sales";

export type FcUser = { id: number; salespersonId: number | null };
export function firstCallIncomplete(user: FcUser, customerId: number): boolean {
  const cfg = getTeamSalesConfig() as any;
  const sp = user.salespersonId == null ? null : Number(user.salespersonId);
  if (!cfg?.enabled || sp == null || sp !== Number(cfg.qualifierSalespersonId)) return false;
  const c = queryRow<{ salesperson_id: number | null; priority: number | null; status: string | null; lead_source: string | null; registered_by: number | null }>(
    "SELECT salesperson_id, priority, status, lead_source, registered_by FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c || Number(c.salesperson_id) !== sp || c.priority != null || (c.status ?? "in_progress") !== "in_progress") return false;
  const last = queryRow<{ id: number }>("SELECT id FROM call_logs WHERE customer_id=? ORDER BY id DESC LIMIT 1", [customerId]);
  if (last) return !queryRow("SELECT id FROM team_sales_qualifications WHERE customer_id=? AND call_log_id=? LIMIT 1", [customerId, last.id]);
  return c.lead_source === "inbound_call" && Number(c.registered_by) === Number(user.id)
    && !queryRow("SELECT id FROM team_sales_qualifications WHERE customer_id=? LIMIT 1", [customerId]);
}

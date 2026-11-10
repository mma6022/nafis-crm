/**
 * sales-experts-priority-status v1 — flag.sales_experts_priority_status_v1 (call_queue_settings). Default OFF.
 *
 * OFF: no change. PATCH /customers/:id and the Today (DCI) board behave exactly as they do today.
 *
 * ON (global flag.sales_experts_priority_status_v1=1 or flag.sales_experts_priority_status_v1.user.<id>=1):
 *  every salesperson (کارشناس فروش) can change a customer's priority and set status to
 *  in_progress / completed / cancelled, on their own customers only (assigned scope is unchanged).
 *  The expert_lockdown guard allows a status/priority-only PATCH for an own customer.
 *  The daily-customer-inline board exposes canEditPriorityStatus so the existing chips can appear.
 *
 * Does not change assignment, P1-revert-admin-only, reactivation rules, urgent, team_sales_config,
 * notification_settings, loan_plans, or contracts.
 *
 * Activate:
 *   INSERT INTO call_queue_settings(key, value, updated_at)
 *   VALUES ('flag.sales_experts_priority_status_v1', '1', datetime('now'))
 *   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
 * Off:
 *   UPDATE call_queue_settings SET value = '0', updated_at = datetime('now')
 *   WHERE key = 'flag.sales_experts_priority_status_v1' OR key LIKE 'flag.sales_experts_priority_status_v1.user.%';
 */
import { queryRow } from "./crm-db";

export const PS_FLAG = "flag.sales_experts_priority_status_v1";
export const PS_STATUSES = ["in_progress", "completed", "cancelled"] as const;
export type PsStatus = (typeof PS_STATUSES)[number];

const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; }
  catch { return null; }
};

export function psGlobalOn(): boolean { return setting(PS_FLAG) === "1"; }

/** Global flag=1, or per-user flag=1. Anything else is OFF. */
export function psFlagOn(userId: number | null | undefined): boolean {
  if (psGlobalOn()) return true;
  if (!userId) return false;
  return setting(`${PS_FLAG}.user.${Number(userId)}`) === "1";
}

/** True when the body is only a customer status and/or priority change (the chip quick-update). */
export function psIsStatusPriorityOnlyBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body as object);
  if (!keys.length) return false;
  return keys.every((k) => k === "status" || k === "priority");
}

export function psIsSalesExpert(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === "salesperson";
}

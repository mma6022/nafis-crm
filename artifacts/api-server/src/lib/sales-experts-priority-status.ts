/**
 * sales-experts-priority-status v1 — flag.sales_experts_priority_status_v1 (call_queue_settings). Default OFF.
 *
 * OFF: no change. PATCH /customers/:id and the Today (DCI) board behave exactly as they do today.
 *
 * ON (global flag.sales_experts_priority_status_v1=1 or flag.sales_experts_priority_status_v1.user.<id>=1):
 *  every salesperson can change a customer's priority (own customers only; assigned scope unchanged).
 *  Case status chips (در حال انجام / اتمام / لغو شده) sit on each loan case card.
 *  «لغو شده» reuses POST /loan-applications/:id/cancel (reason required). Completing a mid-workflow
 *  case is not a shortcut here. When the flag is ON, that cancel also writes an fc_cancels row
 *  (same shape as files-carousel) so admin can undo via POST /files/:id/uncancel. Flag OFF does not
 *  write fc_cancels. Un-cancel stays admin-only.
 *  The expert_lockdown guard still allows a status/priority-only PATCH for an own customer.
 *  The daily-customer-inline board exposes canEditPriorityStatus and per-case canCancel.
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
import { execute, queryRow } from "./crm-db";
import { ensureFcSchema } from "./files-carousel";
import { getTeamSalesConfig } from "./team-sales";
import {
  NONP1_PROTECTED_CUSTOMER_IDS,
  NONP1_TRAINEE_SALESPERSON_IDS,
  nonP1QualifierDisplayName,
  openCaseReason,
} from "./nonp1-transfer";

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

/** Display name of the current first-call expert (qualifier), e.g. «آقای کاظمی». Never a fixed string. */
export function psQualifierExpertName(): string | null {
  return nonP1QualifierDisplayName();
}

/**
 * If this actor demoting the customer's current priority 1 to 2/3/none would auto-transfer
 * to the first-call expert, return that expert's name. Read-only; does not write or change
 * the transfer rule. Uses the same exceptions as nonP1Decision (open case, trainee, etc.).
 */
export function psPriorityDemoteTransferName(
  customerId: number,
  actor: { id?: number | null; role?: string | null; salespersonId?: number | null },
): string | null {
  try {
    const cfg = getTeamSalesConfig();
    const qualifier = Number(cfg.qualifierSalespersonId);
    if (!cfg.enabled || !Number.isFinite(qualifier)) return null;
    const c = queryRow<{ priority: number | null; salesperson_id: number | null; status: string | null; merged_into_customer_id: number | null }>(
      "SELECT priority, salesperson_id, status, merged_into_customer_id FROM customers WHERE id=?",
      [customerId],
    );
    if (!c) return null;
    if (c.priority != 1) return null;
    const sp = c.salesperson_id == null ? null : Number(c.salesperson_id);
    if (actor.salespersonId != null && Number(actor.salespersonId) === qualifier) return null;
    if (NONP1_PROTECTED_CUSTOMER_IDS.includes(customerId)) return null;
    if (sp != null && NONP1_TRAINEE_SALESPERSON_IDS.includes(sp)) return null;
    if (sp == null || !cfg.closerSalespersonIds.map(Number).includes(sp)) return null;
    if (c.merged_into_customer_id != null) return null;
    if ((c.status ?? "in_progress") !== "in_progress") return null;
    if (openCaseReason(customerId)) return null;
    return psQualifierExpertName();
  } catch {
    return null;
  }
}

export function psCaseLife(loanStatus: string | null | undefined, stage: string | null | undefined): PsStatus {
  if (loanStatus === "rejected") return "cancelled";
  if (stage === "completed") return "completed";
  return "in_progress";
}

/** When the flag is ON, record a files-carousel-shaped fc_cancels row for this loan-application cancel
 *  so POST /files/:id/uncancel can restore it. Additive and idempotent: flag OFF is a no-op; an already
 *  open (not uncancelled) row for the same file is left alone. Does not change the cancel itself. */
export function psRecordFcCancel(opts: {
  userId: number;
  fileId: number;
  customerId: number;
  salespersonId: number;
  reason: string;
  prevStatus: string;
  prevStage: string;
  at: string;
}): void {
  if (!psFlagOn(opts.userId)) return;
  const fileId = Number(opts.fileId);
  const customerId = Number(opts.customerId);
  const salespersonId = Number(opts.salespersonId);
  const userId = Number(opts.userId);
  const reason = String(opts.reason || "").trim();
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return;
  if (!Number.isSafeInteger(customerId) || customerId <= 0) return;
  if (!Number.isSafeInteger(salespersonId) || salespersonId <= 0) return;
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  if (!reason) return;
  ensureFcSchema();
  const open = queryRow<{ id: number }>(
    "SELECT id FROM fc_cancels WHERE file_id=? AND uncancelled_at IS NULL ORDER BY id DESC LIMIT 1",
    [fileId],
  );
  if (open) return;
  execute(
    "INSERT INTO fc_cancels(file_id,customer_id,salesperson_id,user_id,reason,prev_status,prev_stage,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [fileId, customerId, salespersonId, userId, reason, String(opts.prevStatus), String(opts.prevStage), opts.at],
  );
}

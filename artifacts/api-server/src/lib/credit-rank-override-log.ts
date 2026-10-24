import { crmDb, execute, queryRows } from "./crm-db";
import { normalizeOverrideReason } from "./credit-rank-override-reason";
export { CREDIT_RANK_OVERRIDE_REASON_MAX, CREDIT_RANK_OVERRIDE_REASON_MIN, normalizeOverrideReason } from "./credit-rank-override-reason";

/**
 * «نادیده گرفتن رتبه» audit (crm-grade-followups, additive). Every staff use of the credit-rank override is logged with
 * the actor, time, customer / case and a mandatory free-text reason. The server refuses an override without a reason.
 * Table is created on first use; scripts/credit-rank-override-log-migrate.mjs creates it ahead of time and
 * scripts/credit-rank-override-log-rollback.mjs removes it (after a backup + JSON export).
 */
export const CREDIT_RANK_OVERRIDE_TABLE = "loan_credit_rank_override_log";
export type CreditRankOverrideAction =
  | "preview_enabled" | "filing_fee_charged" | "wallet_share_link" | "case_created" | "admin_plan_change";

let schemaReady = false;
export function ensureCreditRankOverrideSchema(): void {
  if (schemaReady) return;
  crmDb.exec(`
    CREATE TABLE IF NOT EXISTS ${CREDIT_RANK_OVERRIDE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      user_role TEXT,
      customer_id INTEGER NOT NULL,
      application_id INTEGER,
      plan_id INTEGER,
      condition_id INTEGER,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_rank_override_customer ON ${CREDIT_RANK_OVERRIDE_TABLE}(customer_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_credit_rank_override_application ON ${CREDIT_RANK_OVERRIDE_TABLE}(application_id, id DESC);
  `);
  schemaReady = true;
}

export type OverrideActor = { id: number; username?: string | null; fullName?: string | null; role?: string | null };
export function logCreditRankOverride(entry: {
  action: CreditRankOverrideAction; actor: OverrideActor; customerId: number; reason: string;
  applicationId?: number | null; planId?: number | null; conditionId?: number | null; at?: string;
}): number {
  // Defence in depth: routes validate first; a log row without a valid reason must never be written.
  const checked = normalizeOverrideReason(entry.reason);
  if ("error" in checked) throw Object.assign(new Error(checked.error), { status: 400, code: checked.error });
  ensureCreditRankOverrideSchema();
  return execute(
    `INSERT INTO ${CREDIT_RANK_OVERRIDE_TABLE}(action,user_id,user_name,user_role,customer_id,application_id,plan_id,condition_id,reason,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [entry.action, entry.actor.id, entry.actor.fullName || entry.actor.username || null, entry.actor.role ?? null,
      entry.customerId, entry.applicationId ?? null, entry.planId ?? null, entry.conditionId ?? null,
      checked.reason, entry.at ?? new Date().toISOString()],
  );
}

export type CreditRankOverrideEntry = {
  id: number; action: string; userId: number; userName: string | null; userRole: string | null; customerId: number;
  applicationId: number | null; planId: number | null; conditionId: number | null; reason: string; createdAt: string;
};
const mapEntry = (r: any): CreditRankOverrideEntry => ({
  id: Number(r.id), action: String(r.action), userId: Number(r.user_id), userName: r.user_name ?? null, userRole: r.user_role ?? null,
  customerId: Number(r.customer_id), applicationId: r.application_id == null ? null : Number(r.application_id),
  planId: r.plan_id == null ? null : Number(r.plan_id), conditionId: r.condition_id == null ? null : Number(r.condition_id),
  reason: String(r.reason), createdAt: String(r.created_at),
});

/** Case page: this case's own entries plus the customer's uses that happened before the case existed (preview / fee). */
export function creditRankOverridesForApplication(applicationId: number, customerId: number): CreditRankOverrideEntry[] {
  ensureCreditRankOverrideSchema();
  return queryRows<any>(
    `SELECT * FROM ${CREDIT_RANK_OVERRIDE_TABLE}
     WHERE application_id=? OR (customer_id=? AND application_id IS NULL) ORDER BY id DESC LIMIT 200`,
    [applicationId, customerId]).map(mapEntry);
}

/** Admin report: newest first. */
export function listCreditRankOverrides(limit = 200, offset = 0): CreditRankOverrideEntry[] {
  ensureCreditRankOverrideSchema();
  return queryRows<any>(`SELECT * FROM ${CREDIT_RANK_OVERRIDE_TABLE} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [Math.max(1, Math.min(500, limit)), Math.max(0, offset)]).map(mapEntry);
}

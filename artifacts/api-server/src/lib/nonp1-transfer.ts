/**
 * crm-nonp1-to-kazemi (Mohammad 2026-10-25 16:19):
 * «هر کدوم از کارشناسا مشتری رو میبرن به اولویت دوم یا سوم مشتری خودکار منتقل میشه به اقای کاظمی.
 *  خانم حسنی و قاسمی فقط اولویت های یک رو باید زنگ بزنن بقیه اولویت ها دست اقای کاظمیه»
 *
 * When a sales expert (closer) or an admin changes a closer's customer to any priority other than 1
 * (2, 3 or «بدون اولویت»), the customer moves to the qualifier (Kazemi) IN THE SAME TRANSACTION.
 *
 * Also fires on REACTIVATION (status cancelled / completed → in_progress) when the priority after the write is not 1,
 * even if the priority did not change (history reason 'reactivation'); all exceptions below still apply.
 *
 * Fires only when ALL hold (anything else keeps the customer where it is):
 *  - team sales is enabled and the priority really changed (old ≠ new) to a value other than 1;
 *  - the customer's salesperson after the write is a closer (team_sales_config closerSalespersonIds, today 3 / 4);
 *  - the customer is in_progress and not merged;
 *  - the actor is not the qualifier (Kazemi's own priority changes never trigger anything);
 *  - the same save did not explicitly assign a different salesperson (an admin's explicit choice wins);
 *  - not a trainee's customer (salespersons 5, 19, 20: never touched), not customer #181 / #649;
 *  - no OPEN CASE (contract / payment in progress) — see openCaseReason() for the exact definition.
 *
 * Effects: customers.salesperson_id = qualifier, one customer_priority_history row (source 'nonp1_auto_transfer',
 * old → new priority, old salesperson → qualifier, actor), NO bell (the trigger rows of the move are dropped and the
 * customer's older events are marked read for the qualifier's users, as promoteInTx does), NO SMS (a move TO the
 * qualifier never queues the expert-intro SMS; its switch is OFF anyway). Commission is untouched: it reads the
 * per-purchase salesperson_id and only history rows with new_priority=1 and source qualifier_form / promote.
 */
import { rfTagHandoff } from "./reminder-follow";
import { executeChanges, queryRow } from "./crm-db";
import { getTeamSalesConfig, logPriorityChange } from "./team-sales";

export const NONP1_TRANSFER_SOURCE = "nonp1_auto_transfer" as const;
/** Response header set by every endpoint whose write moved the customer; the dashboard shows the toast from it. */
export const NONP1_TRANSFER_HEADER = "X-Nafis-Customer-Transferred";
/** customer_priority_history.reason of a transfer caused by reactivating a cancelled / completed customer. */
export const NONP1_REACTIVATION_REASON = "reactivation" as const;
export const NONP1_TOAST = "مشتری به آقای کاظمی منتقل شد";
/** Trainees (کارآموز): never touched. */
export const NONP1_TRAINEE_SALESPERSON_IDS: readonly number[] = [5, 19, 20];
/** Customers the PM explicitly excluded. */
export const NONP1_PROTECTED_CUSTOMER_IDS: readonly number[] = [181, 649];
/** A wallet payment intent younger than this is an in-progress payment; older 'created' intents are abandoned. */
export const NONP1_WALLET_INTENT_OPEN_MS = 24 * 60 * 60 * 1000;

const tableExists = (name: string) => Boolean(queryRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]));

/**
 * «پرونده باز» (contract or payment in progress). First match wins; null = no open case.
 *  - loan_application:  loan_applications not deleted, status requested / reviewing (same rule as the 848 transfer)
 *  - goods_purchase:    goods_purchases stage ≠ completed (invoice_draft / invoice_signature / acknowledgement_signature)
 *  - payment_order:     customer_payment_orders stage ≠ paid (sales_approval / admin_approval / awaiting_payment)
 *  - loan_draft:        loan_request_drafts not deleted, status pending_registration
 *  - contract:          contract_generations not deleted / superseded, status generated / sent (not yet signed)
 *  - wallet_payment:    wallet_payment_intents status created within the last 24h
 */
export function openCaseReason(customerId: number, now: Date = new Date()): string | null {
  const has = (table: string, sql: string, params: unknown[] = []) =>
    tableExists(table) && Boolean(queryRow(`SELECT 1 FROM ${table} WHERE customer_id=? AND ${sql} LIMIT 1`, [customerId, ...params] as never[]));
  if (has("loan_applications", "deleted_at IS NULL AND status IN ('requested','reviewing')")) return "loan_application";
  if (has("goods_purchases", "COALESCE(stage,'') <> 'completed'")) return "goods_purchase";
  if (has("customer_payment_orders", "COALESCE(stage,'') <> 'paid'")) return "payment_order";
  if (has("loan_request_drafts", "deleted_at IS NULL AND status='pending_registration'")) return "loan_draft";
  if (has("contract_generations", "deleted_at IS NULL AND superseded_at IS NULL AND status IN ('generated','sent')")) return "contract";
  if (has("wallet_payment_intents", "status='created' AND created_at >= ?", [new Date(now.getTime() - NONP1_WALLET_INTENT_OPEN_MS).toISOString()])) return "wallet_payment";
  return null;
}

export type NonP1Input = {
  customerId: number;
  /** Priority before the write (null = «بدون اولویت»). */
  oldPriority: number | null;
  /** Salesperson before the write. */
  oldSalespersonId: number | null;
  actor: { id: number | null; role?: string | null; salespersonId?: number | null };
  /** True when the same save explicitly assigned a DIFFERENT salesperson (admin's choice wins). */
  explicitSalespersonChange?: boolean;
  /** What wrote the priority (kept in the history reason). */
  via: string;
  /**
   * PM 2026-10-25 16:48: a cancelled / completed customer set back to in_progress whose priority is not 1 gets the
   * same auto-transfer (same exceptions) even when the priority itself did not change. History reason = 'reactivation'.
   */
  reactivation?: boolean;
  now?: Date;
};
export type NonP1Result = { transferred: boolean; skip: string | null; fromSalespersonId: number | null; toSalespersonId: number | null };

/** Pure decision on the post-write state (read inside the caller's transaction). */
export function nonP1Decision(input: NonP1Input): NonP1Result & { newPriority: number | null } {
  const no = (skip: string, newPriority: number | null = null, from: number | null = null) =>
    ({ transferred: false, skip, fromSalespersonId: from, toSalespersonId: null, newPriority });
  const cfg = getTeamSalesConfig();
  const c = queryRow<{ priority: number | null; salesperson_id: number | null; status: string | null; merged_into_customer_id: number | null }>(
    "SELECT priority, salesperson_id, status, merged_into_customer_id FROM customers WHERE id=?", [input.customerId]);
  if (!c) return no("missing");
  const newPriority = c.priority == null ? null : Number(c.priority);
  const sp = c.salesperson_id == null ? null : Number(c.salesperson_id);
  const qualifier = Number(cfg.qualifierSalespersonId);
  if (!cfg.enabled || !Number.isFinite(qualifier)) return no("team_sales_disabled", newPriority, sp);
  if (!input.reactivation && (input.oldPriority ?? null) === newPriority) return no("priority_unchanged", newPriority, sp);
  if (newPriority === 1) return no("priority_1", newPriority, sp);
  if (input.actor.salespersonId != null && Number(input.actor.salespersonId) === qualifier) return no("actor_is_qualifier", newPriority, sp);
  if (input.explicitSalespersonChange) return no("explicit_salesperson", newPriority, sp);
  if (NONP1_PROTECTED_CUSTOMER_IDS.includes(input.customerId)) return no("protected_customer", newPriority, sp);
  if (sp != null && NONP1_TRAINEE_SALESPERSON_IDS.includes(sp)) return no("trainee", newPriority, sp);
  if (sp == null || !cfg.closerSalespersonIds.map(Number).includes(sp)) return no("not_closer", newPriority, sp);
  if (c.merged_into_customer_id != null) return no("merged", newPriority, sp);
  if ((c.status ?? "in_progress") !== "in_progress") return no("not_in_progress", newPriority, sp);
  const open = openCaseReason(input.customerId, input.now ?? new Date());
  if (open) return no(`open_case:${open}`, newPriority, sp);
  return { transferred: true, skip: null, fromSalespersonId: sp, toSalespersonId: qualifier, newPriority };
}

/**
 * MUST run inside the caller's write transaction, right after its priority write.
 * Returns transferred=true when the customer was moved (history row already written; caller must NOT log its own
 * row for the same change).
 */
export function applyNonP1TransferInTx(input: NonP1Input): NonP1Result {
  const d = nonP1Decision(input);
  if (!d.transferred || d.fromSalespersonId == null || d.toSalespersonId == null) {
    return { transferred: false, skip: d.skip, fromSalespersonId: d.fromSalespersonId, toSalespersonId: null };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const bells = tableExists("site_notification_events");
  const preMax = bells ? Number(queryRow<{ m: number | null }>("SELECT MAX(id) AS m FROM site_notification_events")?.m ?? 0) : 0;
  const changed = executeChanges(
    "UPDATE customers SET salesperson_id=? WHERE id=? AND salesperson_id=? AND status='in_progress' AND merged_into_customer_id IS NULL",
    [d.toSalespersonId, input.customerId, d.fromSalespersonId]);
  if (changed !== 1) return { transferred: false, skip: "concurrent_change", fromSalespersonId: d.fromSalespersonId, toSalespersonId: null };
  // REMINDERS-FOLLOW: the owner trigger already moved the open reminders and wrote the hand-off row (7-day read-only); label it.
  rfTagHandoff(input.customerId, input.reactivation ? "reactivation" : "nonp1_auto_transfer");
  if (bells) {
    // No staff notification: drop the bell rows fired by THIS move, and mark the customer's earlier events (incl. the
    // priority edit just written) read for the qualifier's users, since bell scope follows the current owner.
    executeChanges("DELETE FROM site_notification_events WHERE id>? AND customer_id=?", [preMax, input.customerId]);
    if (tableExists("site_notification_reads")) {
      executeChanges(
        `INSERT OR IGNORE INTO site_notification_reads(user_id,event_id,read_at)
         SELECT u.id, e.id, ? FROM users u JOIN site_notification_events e ON e.customer_id=? AND e.id<=?
         WHERE u.salesperson_id=? AND u.active=1`,
        [nowIso, input.customerId, preMax, d.toSalespersonId]);
    }
  }
  logPriorityChange({
    customerId: input.customerId, oldPriority: input.oldPriority ?? null, newPriority: d.newPriority,
    oldSalespersonId: d.fromSalespersonId, newSalespersonId: d.toSalespersonId, actorUserId: input.actor.id ?? null,
    source: NONP1_TRANSFER_SOURCE,
    reason: input.reactivation ? NONP1_REACTIVATION_REASON : `انتقال خودکار به کارشناس تماس اول (اولویت غیر ۱) — ${input.via}`, at: nowIso, always: true,
  });
  return { transferred: true, skip: null, fromSalespersonId: d.fromSalespersonId, toSalespersonId: d.toSalespersonId };
}

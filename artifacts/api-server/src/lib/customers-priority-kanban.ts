/**
 * «مشتریان من» priority column view (kanban) v1.
 * Flag: flag.customers_priority_kanban_v1 (call_queue_settings, global, absent/≠'1' = OFF).
 * OFF → GET /customers-priority-kanban/me falls through (404) and GET /customers is unchanged
 * (no nextReminderAt). ON by an explicit row value '1' only; never seeded.
 * Priority writes stay on the existing PATCH /customers/:id path (permissions, expert_lockdown,
 * trainee lock, customer_priority_history with source customer_update).
 */
import { queryRow, queryRows } from "./crm-db";

export const CPK_FLAG = "flag.customers_priority_kanban_v1";

export const cpkOn = (): boolean => {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [CPK_FLAG])?.value === "1";
  } catch {
    return false;
  }
};

/** Same open-reminder rule as daily plan: the viewer's next undone, non-voided reminder for that customer. */
export function cpkNextReminderAt(customerIds: number[], userId: number): Map<number, string> {
  const ids = customerIds.filter((id) => Number.isInteger(id) && id > 0);
  const out = new Map<number, string>();
  if (!ids.length || !Number.isInteger(userId) || userId <= 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = queryRows<{ customer_id: number; next_rem: string }>(
    `SELECT customer_id, MIN(remind_at) AS next_rem
       FROM reminders
      WHERE customer_id IN (${placeholders})
        AND user_id=? AND done=0 AND voided_at IS NULL
      GROUP BY customer_id`,
    [...ids, userId],
  );
  for (const r of rows) {
    if (r.next_rem) out.set(Number(r.customer_id), r.next_rem);
  }
  return out;
}

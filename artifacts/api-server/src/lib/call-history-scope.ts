import type { AuthUser } from "./auth";

// Call history attribution is independent of customer ownership. PBX history
// follows the user's current internal extension; manual history follows the
// authenticated salesperson identity and ordinary customer access.
export function callHistoryScope(actor: AuthUser) {
  if (actor.role === "admin") return { sql: "", params: [] as (number | string | null)[] };
  const customer = actor.customerScope === "assigned" ? " AND c.salesperson_id=?" : "";
  return {
    sql: `((EXISTS (SELECT 1 FROM voip_after_call_events mobile WHERE mobile.call_log_id=cl.id AND mobile.mobile_device_id IS NOT NULL AND mobile.expert_user_id=?))
      OR (EXISTS (SELECT 1 FROM voip_after_call_events e
      JOIN voip_extensions own ON own.user_id=? AND (own.extension=e.extension
        OR EXISTS (SELECT 1 FROM json_each(e.extensions_json) participant WHERE participant.value=own.extension))
      WHERE e.call_log_id=cl.id))
      OR (NOT EXISTS (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=cl.id)
        AND cl.salesperson_id=?${customer}))`,
    params: [actor.id, actor.id, actor.salespersonId ?? -1, ...(actor.customerScope === "assigned" ? [actor.salespersonId ?? -1] : [])],
  };
}

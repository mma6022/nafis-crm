import type { AuthUser } from "./auth";

// Call history attribution is independent of customer ownership. PBX history
// follows the user's current internal extension; manual history follows the
// authenticated salesperson identity and ordinary customer access.
//
// Salesperson scope ("assigned", 2026-10-24): every call the salesperson logged themselves
// (including first-call forms whose customer was later handed off) PLUS every call on a
// customer they currently own. Nothing else: other salespeople's calls on customers they
// don't own stay hidden. "all"-scope roles (registrar, funder, accounting) are unchanged.
export function callAuthoredBySql(actor: AuthUser) {
  return {
    sql: `(cl.salesperson_id=? OR EXISTS (SELECT 1 FROM team_sales_qualifications authored
      WHERE authored.call_log_id=cl.id AND authored.actor_user_id=?))`,
    params: [actor.salespersonId ?? -1, actor.id] as (number | string | null)[],
  };
}

export function callHistoryScope(actor: AuthUser) {
  if (actor.role === "admin") return { sql: "", params: [] as (number | string | null)[] };
  if (actor.customerScope === "assigned") {
    return {
      sql: `((EXISTS (SELECT 1 FROM voip_after_call_events mobile WHERE mobile.call_log_id=cl.id AND mobile.mobile_device_id IS NOT NULL AND mobile.expert_user_id=?))
      OR (EXISTS (SELECT 1 FROM voip_after_call_events e
      JOIN voip_extensions own ON own.user_id=? AND (own.extension=e.extension
        OR EXISTS (SELECT 1 FROM json_each(e.extensions_json) participant WHERE participant.value=own.extension))
      WHERE e.call_log_id=cl.id))
      OR (NOT EXISTS (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=cl.id) AND cl.salesperson_id=?)
      OR EXISTS (SELECT 1 FROM team_sales_qualifications authored WHERE authored.call_log_id=cl.id AND authored.actor_user_id=?)
      OR c.salesperson_id=?)`,
      params: [actor.id, actor.id, actor.salespersonId ?? -1, actor.id, actor.salespersonId ?? -1],
    };
  }
  return {
    sql: `((EXISTS (SELECT 1 FROM voip_after_call_events mobile WHERE mobile.call_log_id=cl.id AND mobile.mobile_device_id IS NOT NULL AND mobile.expert_user_id=?))
      OR (EXISTS (SELECT 1 FROM voip_after_call_events e
      JOIN voip_extensions own ON own.user_id=? AND (own.extension=e.extension
        OR EXISTS (SELECT 1 FROM json_each(e.extensions_json) participant WHERE participant.value=own.extension))
      WHERE e.call_log_id=cl.id))
      OR (NOT EXISTS (SELECT 1 FROM voip_after_call_events e WHERE e.call_log_id=cl.id)
        AND cl.salesperson_id=?))`,
    params: [actor.id, actor.id, actor.salespersonId ?? -1],
  };
}

// Calls page (2026-10-24 decision 7): a user whose only customer-facing access is
// calls.view (no customers.view) sees only the calls they registered. The
// salesperson filter is forced here so a client-supplied salespersonId can never widen it;
// with no linked salesperson the filter matches nothing (-1).
export function forcedCallSalespersonId(actor: AuthUser): number | undefined {
  if (actor.role === "admin" || actor.permissions.includes("customers.view")) return undefined;
  // Salesperson scope uses forcedCallScope (authored + currently owned) instead.
  if (actor.customerScope === "assigned") return undefined;
  return actor.salespersonId ?? -1;
}

/** Calls-only salesperson: the forced filter is "logged by me OR on a customer I own"; a client salespersonId can only narrow it. */
export function forcedCallScope(actor: AuthUser): { sql: string; params: (number | string | null)[] } | undefined {
  if (actor.role === "admin" || actor.permissions.includes("customers.view") || actor.customerScope !== "assigned") return undefined;
  const authored = callAuthoredBySql(actor);
  return { sql: `(${authored.sql} OR c.salesperson_id=?)`, params: [...authored.params, actor.salespersonId ?? -1] };
}

// CSV export keeps the pre-2026-10-24 salesperson scope (PM decision: «registrar and CSV export stay as they are»).
// Exact copy of the rule at 8d97c9e: manual calls they logged on customers they currently own, plus their
// own PBX/mobile calls. "all"-scope roles and admin are identical to callHistoryScope.
export function legacyExportCallHistoryScope(actor: AuthUser) {
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
    params: [actor.id, actor.id, actor.salespersonId ?? -1, ...(actor.customerScope === "assigned" ? [actor.salespersonId ?? -1] : [])] as (number | string | null)[],
  };
}

/** Export: the calls-only forced salesperson filter exactly as at 8d97c9e. */
export function legacyExportForcedCallSalespersonId(actor: AuthUser): number | undefined {
  if (actor.role === "admin" || actor.permissions.includes("customers.view")) return undefined;
  return actor.salespersonId ?? -1;
}

/** GET /calls?purpose=export (the CSV button) uses the legacy scope; the on-screen list uses the new one. */
export function isCallExportRequest(query: Record<string, unknown>): boolean {
  return query.purpose === "export";
}

/**
 * Everything GET /calls derives from the actor, for the on-screen list or the CSV export.
 * `filters` are ANDed into the WHERE; `ownerOnly` guards name / id search matches;
 * `forcedSalespersonId` overrides any client-supplied salespersonId.
 */
export function callListActorScope(actor: AuthUser, purpose: "list" | "export") {
  const filters: string[] = [];
  const params: (number | string | null)[] = [];
  const scope = purpose === "export" ? legacyExportCallHistoryScope(actor) : callHistoryScope(actor);
  if (scope.sql) { filters.push(scope.sql); params.push(...scope.params); }
  const forced = purpose === "export" ? undefined : forcedCallScope(actor);
  if (forced) { filters.push(forced.sql); params.push(...forced.params); }
  const unrestricted = actor.role === "admin" || actor.customerScope === "all";
  const authoredBy = callAuthoredBySql(actor);
  const ownerOnly = unrestricted
    ? { sql: "1=1", params: [] as (number | string | null)[] }
    : purpose === "export"
      ? { sql: "c.salesperson_id=?", params: [actor.salespersonId] as (number | string | null)[] }
      : { sql: `(c.salesperson_id=? OR ${authoredBy.sql})`, params: [actor.salespersonId, ...authoredBy.params] as (number | string | null)[] };
  const forcedSalespersonId = purpose === "export" ? legacyExportForcedCallSalespersonId(actor) : forcedCallSalespersonId(actor);
  return { filters, params, ownerOnly, forcedSalespersonId };
}

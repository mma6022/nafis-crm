/**
 * VOIP-ANYWHERE registrar scope (t836u; Mohammad: «آره، خانم تاجیک هم دکمه‌ی تماس ویپ داشته باشه»).
 *
 * flag.voip_call.registrar_scope = '1' (global) or flag.voip_call.registrar_scope.user.<id> = '1'. Absent / anything else = OFF → today's rule
 * (a registrar with customer_scope 'all' passes vcCustomerAllowed for every customer — the existing, wider behaviour; see the report).
 *
 * While ON, a REGISTRAR (role 'registrar', no salesperson id, not an admin) may start / read a VoIP click call ONLY for a customer
 * (not merged) where at least one holds:
 *   A. registered: customers.registered_by = her user id (she registered this customer — even if an expert owns it now; she is its registrar);
 *   B. open filing: an open smart-filing job for the customer (finished_at IS NULL) that she created or whose submit she approved
 *      (smart_filing_jobs.created_by_user_id / submit_approved_by_user_id = her id) — she is that file's registrar;
 *   C. incoming grant: an unexpired el_grants row for her user id and this customer (the incoming-call window).
 * Everything else → false → 403 not_own_customer. customer_scope 'all' is NOT used; other experts' customers only through A/B/C.
 * Experts, admins and managers are untouched (this returns null → the caller keeps its own rule).
 * Read-only SQL, no schema changes.
 */
import { queryRow } from "./crm-db";

type U = { id: number; role?: string | null; salespersonId?: number | null };
const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; }
};
export function vcRegistrarScopeFlagOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting("flag.voip_call.registrar_scope") === "1" || setting(`flag.voip_call.registrar_scope.user.${Number(userId)}`) === "1";
}
/** A registrar this rule governs: role registrar, no salesperson, flag on for her. */
export function vcIsScopedRegistrar(u: U | null | undefined): boolean {
  return !!u && u.role === "registrar" && (u.salespersonId == null || Number(u.salespersonId) <= 0) && vcRegistrarScopeFlagOn(u.id);
}
export type VcRegistrarWhy = "registered" | "open_filing" | "incoming_grant";
/** Why she may call this customer, or null (denied). Only meaningful when vcIsScopedRegistrar(u). */
export function vcRegistrarWhy(u: U, customerId: number, now = new Date()): VcRegistrarWhy | null {
  const uid = Number(u.id);
  const c = queryRow<{ registered_by: number | null }>("SELECT registered_by FROM customers WHERE id=? AND merged_into_customer_id IS NULL", [customerId]);
  if (!c) return null;
  if (c.registered_by != null && Number(c.registered_by) === uid) return "registered";
  try {
    if (queryRow("SELECT 1 x FROM smart_filing_jobs WHERE customer_id=? AND finished_at IS NULL AND (created_by_user_id=? OR submit_approved_by_user_id=?) LIMIT 1", [customerId, uid, uid])) return "open_filing";
  } catch { /* table absent */ }
  try {
    if (queryRow("SELECT 1 x FROM el_grants WHERE user_id=? AND customer_id=? AND expires_at>? LIMIT 1", [uid, customerId, now.toISOString()])) return "incoming_grant";
  } catch { /* table absent */ }
  return null;
}

/**
 * VOIP-ANYWHERE (t836u): «تماس» (the existing VoIP click call) for the expert's OWN customers from more places
 * (incoming wizard, LockedInbound own block, customer lists / search rows, site-leads queue, lead-intake queue cards, smart-filing jobs).
 *
 * UI GATE ONLY. Nothing here changes who may start a call: POST /voip-call/start → vcStart keeps vcCustomerAllowed (not_own_customer 403),
 * the expert-lockdown middleware, one_call, needs_result and no_extension exactly as before.
 *
 * On for a user only when ALL hold (absent / anything else = OFF; ships OFF so live is unchanged):
 *   - flag.voip_call_anywhere = '1' (global) or flag.voip_call_anywhere.user.<id> = '1'
 *   - vcOn(u): flag.voip_call(.user.<id>) + a voip_extensions row
 *   - s132On(u): SIMOTEL-132 saves the call by itself (status from the CDR, note from the summary; first call → required first-call form)
 *   - the user has a salesperson id (own = customers.salesperson_id match), OR is a registrar under flag.voip_call.registrar_scope
 *     (voip-registrar-scope.ts: registered by her / her open smart-filing job / incoming grant; that flag also narrows vcStart for her).
 *     Admins / managers (no salesperson, not registrar) → never on.
 */
import { queryRow, queryRows } from "./crm-db";
import { vcOn } from "./voip-call";
import { s132On } from "./simotel132";
import { vcIsScopedRegistrar, vcRegistrarWhy } from "./voip-registrar-scope";

type U = { id: number; role?: string | null; salespersonId?: number | null };
const setting = (key: string): string | null => {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; }
};
export function vcAnywhereFlagOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return setting("flag.voip_call_anywhere") === "1" || setting(`flag.voip_call_anywhere.user.${Number(userId)}`) === "1";
}
const spOf = (u: U | null | undefined): number | null => (u && u.salespersonId != null && Number.isSafeInteger(Number(u.salespersonId)) && Number(u.salespersonId) > 0 ? Number(u.salespersonId) : null);
export function vcAnywhereOn(u: U | null | undefined): boolean {
  return !!u && (spOf(u) != null || vcIsScopedRegistrar(u)) && vcAnywhereFlagOn(u.id) && vcOn(u) && s132On(u);
}
export const VCA_MAX_IDS = 200;
/** Which of these customer ids are this expert's own (salesperson match, not merged). Others are simply left out (no owner data). */
export function vcAnywhereOwnIds(u: U, raw: unknown): number[] {
  const sp = spOf(u);
  const ids = [...new Set(String(raw ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, VCA_MAX_IDS);
  if (!ids.length) return [];
  if (sp == null) return vcIsScopedRegistrar(u) ? ids.filter((id) => vcRegistrarWhy(u, id) != null).sort((a, b) => a - b) : [];
  return queryRows<{ id: number }>(`SELECT id FROM customers WHERE id IN (${ids.map(() => "?").join(",")}) AND merged_into_customer_id IS NULL AND salesperson_id=?`, [...ids, sp])
    .map((r) => Number(r.id)).sort((a, b) => a - b);
}

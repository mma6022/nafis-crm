/** SALES-SHELL v2 (Armita sales-shell-redesign v1.0.1): bottom dock / mobile tab bar instead of the sidebar.
 *  Behind the PER-USER flag call_queue_settings key `flag.sales_shell_v2.user.<userId>` = '1' (absent / anything else = OFF;
 *  shipped OFF for everyone; switched only by the ops script shell-flag.py). Read-only here: nothing in this file writes. */
import { queryRow } from "./crm-db";
import type { AuthUser } from "./auth";

export const SS_FLAG_PREFIX = "flag.sales_shell_v2.user.";
export function ssOn(userId: number | null | undefined): boolean {
  if (!userId) return false;
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [`${SS_FLAG_PREFIX}${Number(userId)}`])?.value === "1"; }
  catch { return false; }
}

/** Tehran day bounds (UTC ISO) for «today» (Iran has no DST since 2022: fixed +03:30). */
function tehranDay(now: Date): { start: string; end: string } {
  const off = 210 * 60_000;
  const t = new Date(now.getTime() + off);
  const s = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - off;
  return { start: new Date(s).toISOString(), end: new Date(s + 86_400_000).toISOString() };
}

/** spec §9 GET /nav-badges: one counts read for the dock. Own reminders only (same scope as GET /reminders), plus the DND end.
 *  Chat / internal / callbacks / drafts / goods / payment counts keep coming from their existing endpoints (spec §9: phase 2). */
export function ssNavBadges(u: AuthUser, now = new Date()) {
  const scope = u.customerScope === "assigned";
  const base = `FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.user_id = ? AND r.done = 0 AND r.voided_at IS NULL AND r.closed_at IS NULL
    ${scope ? "AND (r.customer_id IS NULL OR (c.merged_into_customer_id IS NULL AND c.salesperson_id = ?))" : ""}`;
  const p = scope ? [u.id, u.salespersonId ?? -1] : [u.id];
  const iso = now.toISOString(), d = tehranDay(now);
  let overdue = 0, laterToday = 0;
  try {
    overdue = Number(queryRow<{ n: number }>(`SELECT count(*) n ${base} AND julianday(r.remind_at) <= julianday(?)`, [...p, iso])?.n ?? 0);
    laterToday = Number(queryRow<{ n: number }>(`SELECT count(*) n ${base} AND julianday(r.remind_at) > julianday(?) AND julianday(r.remind_at) < julianday(?)`, [...p, iso, d.end])?.n ?? 0);
  } catch { /* reminders schema not ready: zero counts */ }
  let dndUntil: string | null = null;
  try {
    const r = queryRow<{ dnd_until: string | null }>("SELECT dnd_until FROM assistant_user_prefs WHERE user_id=?", [u.id]);
    if (r?.dnd_until && Date.parse(r.dnd_until) > now.getTime()) dndUntil = r.dnd_until;
  } catch { /* table created lazily by the assistants feature */ }
  return { reminders: { overdue, laterToday }, dndUntil, at: iso };
}

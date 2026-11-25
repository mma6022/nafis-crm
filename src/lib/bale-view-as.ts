/**
 * t927 (Mohammad t927u): a per-user grant so one expert can read another expert's
 * Bale inbox and open those experts' customer files. Send-as is NOT included.
 *
 * Flag: flag.bale_view_as_v1 (call_queue_settings; absent / ≠'1' = OFF).
 * OFF → every helper returns empty / false; callers keep today's SQL and answers.
 *
 * Setting: bale_view_as.user.<viewer users.id> = comma-separated owner user ids
 * (e.g. Hasani 2 → "8,3" for Kazemi and Ghasemi). User 29 is never a viewer or an owner.
 * Customer ownership is never changed. team_sales_config / notification_settings are never written.
 */
import { queryRow, queryRows } from "./crm-db";

export const BVA_FLAG = "flag.bale_view_as_v1";
export const BVA_NEVER_USER_ID = 29;
export const bvaUserKey = (userId: number) => `bale_view_as.user.${userId}`;

type Viewer = { id: number; salespersonId?: number | null; salesperson_id?: number | null };

function setting(k: string): string | null {
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [k])?.value ?? null; }
  catch { return null; }
}

export function bvaOn(): boolean {
  return setting(BVA_FLAG) === "1";
}

/** Owner user ids this viewer may read Bale chats of. Empty when the flag is off, the setting is absent, or the viewer is 29. */
export function bvaOwnerUserIds(viewer: { id: number } | null | undefined): number[] {
  if (!viewer || !bvaOn() || Number(viewer.id) === BVA_NEVER_USER_ID) return [];
  const raw = setting(bvaUserKey(Number(viewer.id)));
  if (!raw) return [];
  const out: number[] = [];
  for (const part of String(raw).split(/[,،\s]+/)) {
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 1) continue;
    if (n === BVA_NEVER_USER_ID || n === Number(viewer.id)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function bvaCanSeeBotOwner(viewer: { id: number } | null | undefined, ownerUserId: number | null | undefined): boolean {
  if (ownerUserId == null) return false;
  return bvaOwnerUserIds(viewer).includes(Number(ownerUserId));
}

/** Salesperson ids of the granted owners (active users with a salesperson_id). */
export function bvaSalespersonIds(viewer: { id: number } | null | undefined): number[] {
  const owners = bvaOwnerUserIds(viewer);
  if (!owners.length) return [];
  const rows = queryRows<{ salesperson_id: number | null }>(
    `SELECT salesperson_id FROM users WHERE id IN (${owners.map(() => "?").join(",")}) AND active=1 AND salesperson_id IS NOT NULL`,
    owners,
  );
  const out: number[] = [];
  for (const r of rows) {
    const n = Number(r.salesperson_id);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

export function bvaCanAccessSalesperson(viewer: { id: number } | null | undefined, salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  return bvaSalespersonIds(viewer).includes(Number(salespersonId));
}

export function bvaOwnsOrDelegated(u: Viewer, salespersonId: number | null | undefined): boolean {
  if (salespersonId == null) return false;
  const own = u.salespersonId ?? u.salesperson_id;
  if (own != null && Number(salespersonId) === Number(own)) return true;
  return bvaCanAccessSalesperson(u, salespersonId);
}

/** For customerScope==="assigned" single-resource filters. Flag off / no grant → identical to today's `AND col = ?`. */
export function bvaAssignedOwnerClause(u: Viewer, column: string): { sql: string; params: unknown[] } {
  const own = u.salespersonId ?? u.salesperson_id;
  const extra = bvaSalespersonIds(u);
  const ids = [own, ...extra].map(Number).filter((n, i, a) => Number.isSafeInteger(n) && n > 0 && a.indexOf(n) === i);
  if (ids.length <= 1) return { sql: ` AND ${column} = ?`, params: [own] };
  return { sql: ` AND ${column} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

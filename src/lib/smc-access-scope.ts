/**
 * Read-only helper for «مدیریت فروش» → «دسترسی کارشناس‌ها» (smc_settings section='access').
 * Applies `team` («تیمش») and `all` («همه») read/list/search/open grants on top of base assigned scope
 * while flag.sales_manager_console_v1 = '1'.
 *
 * Strictly read-only: never creates tables, never mutates rows, never grants write/send/delete
 * permissions, and never widens user 29. Flag OFF → always returns { kind: "none" }.
 */
import type { AuthUser } from "./auth";
import { bvaSalespersonIds } from "./bale-view-as";
import { queryRow, queryRows } from "./crm-db";
import { isSalesManagerUser } from "./sales-manager";

export const SMC_SCOPE_FLAG = "flag.sales_manager_console_v1";
export const SMC_SCOPE_NEVER_USER = 29;
export type SmcResource = "customers" | "loan_files";
export type SmcScope =
  | { kind: "none" }
  | { kind: "team"; salespersonIds: Set<number> }
  | { kind: "all" };

type ScopeActor = Pick<AuthUser, "id" | "role" | "salespersonId" | "customerScope"> & {
  salesManager?: boolean;
  baseRole?: string;
};

type AccessPolicy = { customers?: string; loan_files?: string };
type TeamExpert = { id: string; userId: number | null; salespersonId: number | null; teamId: string | null };
type TeamsPayload = { experts?: TeamExpert[] };
type AccessPayload = { policies?: Record<string, AccessPolicy> };

function smcFlagEnabled(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [SMC_SCOPE_FLAG])?.value === "1";
  } catch {
    return false;
  }
}

function readSmcDoc<T>(section: string): T | null {
  try {
    if (!queryRow("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='smc_settings'")) return null;
    const r = queryRow<{ payload_json: string }>("SELECT payload_json FROM smc_settings WHERE section=?", [section]);
    if (!r) return null;
    return JSON.parse(r.payload_json) as T;
  } catch {
    return null;
  }
}

function readFallbackTeams(): TeamExpert[] {
  try {
    const rows = queryRows<{ user_id: number; salesperson_id: number | null; team_id: number | null }>(
      `SELECT u.id AS user_id, u.salesperson_id, m.team_id
       FROM users u
       LEFT JOIN sales_team_members m ON m.salesperson_id = u.salesperson_id
       WHERE u.active = 1 AND u.role = 'salesperson' AND u.id <> ?`,
      [SMC_SCOPE_NEVER_USER],
    );
    return rows.map((r) => ({
      id: r.salesperson_id != null ? `e${r.salesperson_id}` : `u${r.user_id}`,
      userId: Number(r.user_id),
      salespersonId: r.salesperson_id == null ? null : Number(r.salesperson_id),
      teamId: r.team_id == null ? null : `t${r.team_id}`,
    }));
  } catch {
    return [];
  }
}

export function smcAccessScope(u: ScopeActor | null | undefined, resource: SmcResource): SmcScope {
  if (!u || !u.id || Number(u.id) === SMC_SCOPE_NEVER_USER) return { kind: "none" };
  if (u.role !== "salesperson" || (u.customerScope != null && u.customerScope !== "assigned") || isSalesManagerUser(u)) return { kind: "none" };
  if (!smcFlagEnabled()) return { kind: "none" };
  const access = readSmcDoc<AccessPayload>("access");
  if (!access?.policies) return { kind: "none" };
  const teams = readSmcDoc<TeamsPayload>("teams");
  const experts = Array.isArray(teams?.experts) ? teams!.experts : readFallbackTeams();
  const me = experts.find((e) => e.userId != null && Number(e.userId) === Number(u.id));
  if (!me) return { kind: "none" };
  const level = access.policies[me.id]?.[resource] ?? "own";
  if (level === "all") return { kind: "all" };
  if (level === "team") {
    const ids = new Set<number>();
    if (u.salespersonId != null && Number.isSafeInteger(Number(u.salespersonId)) && Number(u.salespersonId) > 0) {
      ids.add(Number(u.salespersonId));
    }
    if (me.teamId) {
      for (const x of experts) {
        const sp = Number(x.salespersonId);
        if (x.teamId === me.teamId && Number.isSafeInteger(sp) && sp > 0) ids.add(sp);
      }
    }
    return { kind: "team", salespersonIds: ids };
  }
  return { kind: "none" };
}

export function smcCanViewSalesperson(
  u: ScopeActor | null | undefined,
  salespersonId: number | null | undefined,
  resource: SmcResource = "customers",
): boolean {
  const sc = smcAccessScope(u, resource);
  if (sc.kind === "all") return true;
  if (sc.kind === "team") return salespersonId != null && sc.salespersonIds.has(Number(salespersonId));
  return false;
}

export function smcCanViewCustomer(
  u: ScopeActor | null | undefined,
  customerId: number,
  resource: SmcResource = "customers",
): boolean {
  const sc = smcAccessScope(u, resource);
  if (sc.kind === "none") return false;
  const row = queryRow<{ salesperson_id: number | null }>(
    "SELECT salesperson_id FROM customers WHERE id=? AND merged_into_customer_id IS NULL",
    [customerId],
  );
  if (!row) return false;
  if (sc.kind === "all") return true;
  return row.salesperson_id != null && sc.salespersonIds.has(Number(row.salesperson_id));
}

export function smcCanViewLoanFile(u: ScopeActor | null | undefined, applicationId: number): boolean {
  const sc = smcAccessScope(u, "loan_files");
  if (sc.kind === "none") return false;
  const row = queryRow<{ salesperson_id: number | null }>(
    `SELECT current_customer.salesperson_id
     FROM loan_applications a
     JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_merge_audit merge_audit ON merge_audit.source_customer_id = c.id AND merge_audit.survivor_customer_id = c.merged_into_customer_id
     JOIN customers current_customer ON current_customer.id = CASE WHEN c.merged_into_customer_id IS NULL THEN c.id ELSE merge_audit.survivor_customer_id END AND current_customer.merged_into_customer_id IS NULL
     WHERE a.id = ? AND a.deleted_at IS NULL`,
    [applicationId],
  );
  if (!row) return false;
  if (sc.kind === "all") return true;
  return row.salesperson_id != null && sc.salespersonIds.has(Number(row.salesperson_id));
}

/**
 * Returns null when smc access does NOT widen (own / locked / flag OFF).
 * When widened (`team` or `all`), returns `{ kind, sql, params }` starting with ` AND ...` (or `""` for `all`).
 * Optionally unions extra salesperson ids (e.g. `bvaSalespersonIds(u)`).
 */
export function smcAssignedOwnerClause(
  u: ScopeActor | null | undefined,
  column: string,
  resource: SmcResource = "customers",
  includeBva = false,
): { kind: "team" | "all"; sql: string; params: number[]; salespersonIds: number[] | null } | null {
  const sc = smcAccessScope(u, resource);
  if (sc.kind === "none") return null;
  if (sc.kind === "all") return { kind: "all", sql: "", params: [], salespersonIds: null };
  const extra = includeBva && u ? bvaSalespersonIds(u) : [];
  const ids = [...new Set([...sc.salespersonIds, ...extra])].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) return { kind: "team", sql: " AND 1=0", params: [], salespersonIds: [] };
  return {
    kind: "team",
    sql: ids.length === 1 ? ` AND ${column} = ?` : ` AND ${column} IN (${ids.map(() => "?").join(",")})`,
    params: ids,
    salespersonIds: ids,
  };
}

/**
 * «مدیر فروش» (sales_manager): a separate role with admin-equivalent access (Mohammad, 2026-11-03).
 * Everything role-based treats it as admin (effective role 'admin'); only the sales-manager-only surfaces
 * (Ahmad, the call-center manager views, call popups) look at the base role. Plain admins no longer see Ahmad.
 * Kept import-free so any module can use it without cycles.
 */
export const SALES_MANAGER_ROLE = "sales_manager";
export const ADMIN_LIKE_ROLES = ["admin", SALES_MANAGER_ROLE] as const;
/** Effective role for every admin check: sales_manager acts as admin. */
export const effectiveRole = (role: unknown): string => (role === SALES_MANAGER_ROLE ? "admin" : String(role ?? ""));
/** SQL expression for an effective role column, e.g. `${roleSql("u.role")} AS role`. */
export const roleSql = (col = "role"): string => `(CASE WHEN ${col}='${SALES_MANAGER_ROLE}' THEN 'admin' ELSE ${col} END)`;
/** SQL list for `role IN ${ADMIN_LIKE_SQL}`. */
export const ADMIN_LIKE_SQL = `('admin','${SALES_MANAGER_ROLE}')`;
/** True only for a sales manager (AuthUser.salesManager, or a DB row's base_role / raw role). */
export function isSalesManagerUser(u: { salesManager?: boolean; baseRole?: string; base_role?: string; role?: string } | null | undefined): boolean {
  if (!u) return false;
  if (u.salesManager === true) return true;
  return u.baseRole === SALES_MANAGER_ROLE || u.base_role === SALES_MANAGER_ROLE || u.role === SALES_MANAGER_ROLE;
}

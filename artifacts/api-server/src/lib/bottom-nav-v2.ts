/**
 * bottom-nav-v2 (flag.bottom_nav_v2, default OFF).
 * Global call_queue_settings key `flag.bottom_nav_v2` = '1' turns the new dock / tab bar on.
 * Absent or anything else = OFF, so the existing sales-shell nav is unchanged.
 * Display only: this never grants a route the user cannot already open.
 */
import { queryRow } from "./crm-db";

export const BNV2_FLAG = "flag.bottom_nav_v2";

export function bnv2On(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [BNV2_FLAG])?.value === "1";
  } catch {
    return false;
  }
}

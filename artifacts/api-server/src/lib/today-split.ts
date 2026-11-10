/**
 * TODAY-SPLIT (stage 1 of Armita today-split-files-board v1.0.1; Mohammad t709s2756 «طرح تأییده، بده آدیتیا بسازه»):
 * «کارهای امروز من» gets two tabs, «مشتریان بالقوه» (the existing daily list, unchanged) and «مشتریان بالفعل» (today's FILES-61 file tasks).
 * Behind the PER-USER flag call_queue_settings key `flag.today_split.user.<userId>` = '1' (absent / anything else = OFF; shipped OFF
 * for everyone; never seeded). Only users 8 / 2 / 3 (EL_USERS) and only while flag.files_carousel + flag.fc_categories are on.
 * Read-only here: nothing in this file writes.
 */
import { queryRow } from "./crm-db";
import { EL_USERS, elUsers } from "./expert-lockdown";

export const TS_FLAG_PREFIX = "flag.today_split.user.";
export function tsOn(userId: number | null | undefined): boolean {
  if (!userId || elUsers()[Number(userId)] == null) return false;
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [`${TS_FLAG_PREFIX}${Number(userId)}`])?.value === "1"; }
  catch { return false; }
}
/** The flag of the (single) expert user bound to a salesperson id, via EL_USERS. */
export function tsOnSp(sp: number | null | undefined): boolean {
  if (sp == null) return false;
  const uid = Object.entries(elUsers()).find(([, s]) => Number(s) === Number(sp))?.[0];
  return uid != null && tsOn(Number(uid));
}

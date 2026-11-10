/**
 * FILES-LOCK (stage 2 of today-split-files-board v1.0.4 §2; PM defaults 1/5/7): while the expert still has «مشتریان بالفعل» tasks today,
 * «پرونده‌های من» is closed: a WRITE on any of their own open files other than today's current card → 423 files_lock (reads stay open;
 * creating a new file stays open, and a file created today stays writable so the wizard can finish). Unlock = the deck runs out
 * (fc_days.list_opened_at, REL-83) and never re-locks that day.
 * Behind the PER-USER flag call_queue_settings key `flag.files_lock.user.<userId>` = '1' (absent / anything else = OFF; shipped OFF,
 * never seeded). Only users 8 / 2 / 3 and only while that user's flag.today_split is on. Read-only here: nothing in this file writes.
 */
import { queryRow } from "./crm-db";
import { EL_USERS, elUsers } from "./expert-lockdown";
import { tsOn } from "./today-split";

export const FL_FLAG_PREFIX = "flag.files_lock.user.";
export function flOn(userId: number | null | undefined): boolean {
  if (!userId || elUsers()[Number(userId)] == null || !tsOn(Number(userId))) return false;
  try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [`${FL_FLAG_PREFIX}${Number(userId)}`])?.value === "1"; }
  catch { return false; }
}
export const FL_MESSAGE = "اول تسک‌های مشتریان بالفعل رو تموم کن، بعد پرونده‌ها باز می‌شه.";

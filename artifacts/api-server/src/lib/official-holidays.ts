/**
 * «تعطیلات رسمی» — one shared table of official holidays (PM 2026-10-27, AR30). Admin-defined dates; every module that needs
 * «closed like Friday» reads this table (Bale auto-reply now; the call queue later). Dates are Tehran calendar days, Gregorian
 * "YYYY-MM-DD" (the UI shows / picks them in Jalali). Nothing here sends anything or turns anything on.
 */
import type { DatabaseSync } from "node:sqlite";

export type OfficialHoliday = { id: number; date: string; label: string | null };
export const HOLIDAY_YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const HOLIDAY_LABEL_MAX = 40;
export const HOLIDAYS_MAX = 200;

const hasTable = (db: DatabaseSync, n: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));

/** Idempotent. One-time migration: dates stored in the AR29 setting bale_settings.autoreply_holidays move into the table once. */
export function ensureOfficialHolidaysSchema(db: DatabaseSync, nowIso = new Date().toISOString()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS official_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE CHECK(length(date)=10), label TEXT,
    created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL)`);
  if (!hasTable(db, "bale_settings")) return;
  const done = db.prepare("SELECT value FROM bale_settings WHERE key='official_holidays_migrated'").get() as { value?: string } | undefined;
  if (done?.value === "1") return;
  const old = db.prepare("SELECT value FROM bale_settings WHERE key='autoreply_holidays'").get() as { value?: string } | undefined;
  let list: any[] = [];
  try { const l = JSON.parse(String(old?.value ?? "[]")); if (Array.isArray(l)) list = l; } catch { /* ignore */ }
  const ins = db.prepare("INSERT OR IGNORE INTO official_holidays(date,label,created_by,created_at,updated_by,updated_at) VALUES(?,?,NULL,?,NULL,?)");
  for (const h of list) if (h && HOLIDAY_YMD.test(String(h.date))) ins.run(String(h.date), h.label ? String(h.label).slice(0, HOLIDAY_LABEL_MAX) : null, nowIso, nowIso);
  db.prepare("INSERT INTO bale_settings(key,value,updated_at) VALUES('official_holidays_migrated','1',?) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at").run(nowIso);
}

export function listOfficialHolidays(db: DatabaseSync): OfficialHoliday[] {
  if (!hasTable(db, "official_holidays")) return [];
  return (db.prepare("SELECT id,date,label FROM official_holidays ORDER BY date").all() as any[]).map(h => ({ id: Number(h.id), date: String(h.date), label: h.label ?? null }));
}
export function isOfficialHoliday(db: DatabaseSync, ymd: string): boolean {
  return hasTable(db, "official_holidays") && Boolean(db.prepare("SELECT 1 FROM official_holidays WHERE date=?").get(ymd));
}
/** JSON in the AR29 arInDay() shape ([{date,label}]). */
export const officialHolidaysJson = (db: DatabaseSync) => JSON.stringify(listOfficialHolidays(db).map(h => ({ date: h.date, label: h.label })));

export type HolidayIn = { date: string; label?: string | null };
export function validateHoliday(h: HolidayIn): string | null {
  if (!h || !HOLIDAY_YMD.test(String(h.date ?? ""))) return "invalid_date";
  const d = new Date(`${h.date}T12:00:00Z`); if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== h.date) return "invalid_date";
  if (h.label != null && String(h.label).length > HOLIDAY_LABEL_MAX) return "label_too_long";
  return null;
}
export function addOfficialHoliday(db: DatabaseSync, h: HolidayIn, by: number | null, nowIso: string): { ok: true; id: number; created: boolean } | { ok: false; error: string } {
  const e = validateHoliday(h); if (e) return { ok: false, error: e };
  const label = h.label ? String(h.label).trim().slice(0, HOLIDAY_LABEL_MAX) || null : null;
  const ex = db.prepare("SELECT id FROM official_holidays WHERE date=?").get(h.date) as { id: number } | undefined;
  if (ex) { db.prepare("UPDATE official_holidays SET label=?, updated_by=?, updated_at=? WHERE id=?").run(label, by, nowIso, ex.id); return { ok: true, id: Number(ex.id), created: false }; }
  if (Number((db.prepare("SELECT count(*) n FROM official_holidays").get() as any).n) >= HOLIDAYS_MAX) return { ok: false, error: "too_many" };
  const id = Number(db.prepare("INSERT INTO official_holidays(date,label,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?)").run(h.date, label, by, nowIso, by, nowIso).lastInsertRowid);
  return { ok: true, id, created: true };
}
export function deleteOfficialHoliday(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM official_holidays WHERE id=?").run(id).changes) === 1;
}
/** Replace the whole set (AR29 settings form sends the full list). Returns {added, removed}. */
export function replaceOfficialHolidays(db: DatabaseSync, list: HolidayIn[], by: number | null, nowIso: string): { added: number; removed: number } {
  const want = new Map<string, string | null>(); for (const h of list) want.set(h.date, h.label ? String(h.label).slice(0, HOLIDAY_LABEL_MAX) : null);
  let added = 0, removed = 0;
  for (const h of listOfficialHolidays(db)) if (!want.has(h.date)) { deleteOfficialHoliday(db, h.id); removed++; }
  for (const [date, label] of want) { const r = addOfficialHoliday(db, { date, label }, by, nowIso); if (r.ok && r.created) added++; }
  return { added, removed };
}

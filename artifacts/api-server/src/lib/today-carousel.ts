/**
 * incoming2-59 — «کارهای امروز من» as a one-card carousel (Armita crm-daily-plan-cards v1.0).
 * Behind flag.today_carousel (call_queue_settings, '1' = on; missing/anything else = off) AND only for the
 * expert-lockdown users (EL_USERS: 8, 2, 3 with their own salesperson id). Everyone else, and everybody while the
 * flag is off, gets byte-identical responses: /daily-plans/config only gains `carousel: true` when it applies.
 * The cards themselves are built in the browser from GET /daily-plans/today (same data, same order, same locks).
 * UI clicks are logged as snake_case events in tc_events (no customer phone / name, ids only).
 */
import { crmDb, execute, queryRow, queryRows } from "./crm-db";
import { cqRaw } from "./call-queue";
import { EL_USERS } from "./expert-lockdown";

export const TC_FLAG_KEY = "flag.today_carousel";
type U = { id: number; role: string; salespersonId: number | null } | null | undefined;

export const tcFlagOn = (): boolean => { try { return cqRaw(TC_FLAG_KEY) === "1"; } catch { return false; } };
export const tcTarget = (u: U): boolean =>
  Boolean(u && u.role === "salesperson" && EL_USERS[Number(u.id)] != null && Number(u.salespersonId) === EL_USERS[Number(u.id)]);
export const tcOn = (u: U): boolean => tcTarget(u) && tcFlagOn();

export const TC_EVENTS = [
  "today_carousel_view", "today_carousel_auto_advance", "today_carousel_page_back", "today_carousel_page_forward", "today_carousel_back_to_current",
  "today_carousel_incoming_open", "today_carousel_incoming_search", "today_carousel_incoming_discard", "today_carousel_incoming_own_saved", "today_carousel_incoming_other_closed",
  "today_carousel_incoming_new_open", "today_carousel_incoming_new_created", "today_carousel_incoming_new_saved", "today_carousel_incoming_cancel",
  "today_carousel_finished_view",
] as const;
const ALLOWED = new Set<string>(TC_EVENTS);

let ready = false;
function ensure(): void {
  if (ready) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS tc_events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, salesperson_id INTEGER,
      name TEXT NOT NULL, item_id INTEGER, card_index INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tc_events_user ON tc_events(user_id, created_at);`);
  ready = true;
}
const int = (v: unknown): number | null => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 && n < 1e9 ? n : null; };

/** POST /daily-plans/today/carousel-event — 404 unless tcOn; unknown names → 400; ≤ 600 per user per hour. */
export function tcLogEvent(u: NonNullable<U>, body: any, now = new Date()): { status: number; body: any } {
  if (!tcOn(u)) return { status: 404, body: { error: "today_carousel_off", message: "نمای کارتی فعال نیست." } };
  const name = String(body?.name ?? "");
  if (!ALLOWED.has(name)) return { status: 400, body: { error: "unknown_event", message: "رویداد ناشناخته." } };
  ensure();
  const n = Number(queryRow<{ n: number }>("SELECT count(*) n FROM tc_events WHERE user_id=? AND created_at>?", [Number(u.id), new Date(now.getTime() - 3_600_000).toISOString()])?.n ?? 0);
  if (n >= 600) return { status: 200, body: { ok: true, dropped: true } };
  execute("INSERT INTO tc_events(user_id,salesperson_id,name,item_id,card_index,created_at) VALUES(?,?,?,?,?,?)",
    [Number(u.id), u.salespersonId == null ? null : Number(u.salespersonId), name, int(body?.itemId), int(body?.cardIndex ?? body?.index), now.toISOString()]);
  return { status: 200, body: { ok: true } };
}

/** Admin read (counts per user/event for one Tehran day). */
export function tcDailyCounts(day: string) {
  ensure();
  const from = new Date(`${day}T00:00:00+03:30`).toISOString(), to = new Date(new Date(`${day}T00:00:00+03:30`).getTime() + 86_400_000).toISOString();
  return { day, flag: tcFlagOn(), rows: queryRows<{ user_id: number; name: string; n: number }>(
    "SELECT user_id, name, count(*) n FROM tc_events WHERE created_at>=? AND created_at<? GROUP BY user_id, name ORDER BY user_id, name", [from, to]) };
}

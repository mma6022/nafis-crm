/**
 * SIMOTEL-456 flags (design simotel v1.2, parts 4–6; Mohammad t735s2898). All default OFF. The only write here is viExtState (report flag on only).
 *   flag.voip_incoming (+ .user.<id>) → part 4 «تماس ورودی» popup
 *   flag.voip_missed   (+ .user.<id>) → part 5 «تماس‌های بی‌پاسخ امروز» in «کارهای امروز من»
 *   flag.voip_report   (global only)  → part 6 «گزارش کارشناسان» tab in /call-center (+ extension live-state capture from NewState)
 * Support role (Tajik, ext 220): role 'registrar' or setting voip_role.user.<id>=support.
 * Kept free of other lib imports (only crm-db) so expert-lockdown can import it without a cycle.
 */
import type { Request } from "express";
import { crmDb, executeChanges, queryRow } from "./crm-db";

export const VI_FLAGS = { incoming: "flag.voip_incoming", missed: "flag.voip_missed", report: "flag.voip_report" } as const;
const setting = (key: string): string | null => { try { return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [key])?.value ?? null; } catch { return null; } };
export const viSetting = setting;
export function viFlag(kind: "incoming" | "missed", userId: number | null | undefined): boolean {
  if (userId == null || !Number.isSafeInteger(Number(userId))) return false;
  return setting(VI_FLAGS[kind]) === "1" || setting(`${VI_FLAGS[kind]}.user.${Number(userId)}`) === "1";
}
export function viAnyOn(kind: "incoming" | "missed"): boolean {
  try { return setting(VI_FLAGS[kind]) === "1" || !!queryRow(`SELECT 1 x FROM call_queue_settings WHERE key LIKE '${VI_FLAGS[kind]}.user.%' AND value='1' LIMIT 1`); } catch { return false; }
}
export const viReportOn = (): boolean => setting(VI_FLAGS.report) === "1";
export function viExtension(userId: number): string | null {
  try { const e = queryRow<{ extension: string | null }>("SELECT extension FROM voip_extensions WHERE user_id=?", [userId])?.extension ?? null; return e && /^[0-9]{2,6}$/.test(e) ? e : null; }
  catch { return null; }
}
/** Part 4 popup audience: flag + own extension, never the admin role (experts, sales_manager, support). */
export function viIncomingFor(u: { id: number; role?: string | null } | null | undefined): boolean {
  return !!u && u.role !== "admin" && viFlag("incoming", u.id) && viExtension(u.id) != null;
}
export function viIsSupport(u: { id: number; role?: string | null }): boolean {
  return setting(`voip_role.user.${Number(u.id)}`) === "support" || (u.role === "registrar" && setting(`voip_role.user.${Number(u.id)}`) !== "expert");
}
/** Lockdown: every /voip-incoming/* endpoint scopes itself to the caller (own extension / own missed rows / own customers via vcStart's
 *  own-customer check), so a locked expert gets [] (own-only) while one of the user flags is on; null (= normal lockdown) otherwise. */
export function viLockdownIds(req: Request, path: string, userId: number): number[] | null {
  if (!path.startsWith("/voip-incoming/")) return null;
  if (!viFlag("incoming", userId) && !viFlag("missed", userId)) return null;
  void req; return [];
}

/** Part 6 live status: last NewState per extension (Idle / Ringing / InUse / Pause / Unavailable). Written only while flag.voip_report = 1,
 *  so with the flag off the webhook stays byte-for-byte the old path. `since` changes only when the state changes. */
const VI_STATES: Record<string, string> = { idle: "idle", ringing: "ringing", inuse: "inuse", busy: "inuse", pause: "pause", paused: "pause", unavailable: "unavailable" };
let extEnsured = false;
export function ensureViExtState(): void {
  if (extEnsured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_extension_state(extension TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL, cuid TEXT, updated_at TEXT NOT NULL)`);
  extEnsured = true;
}
export function viExtState(body: Record<string, unknown>, now = new Date()): boolean {
  if (!viReportOn()) return false;
  const ext = typeof body.exten === "string" || typeof body.exten === "number" ? String(body.exten).trim() : "";
  const raw = typeof body.state === "string" ? body.state.toLowerCase().replace(/[\s_-]/g, "") : "";
  const state = VI_STATES[raw];
  if (!/^[0-9]{2,6}$/.test(ext) || !state) return false;
  const cuidRaw = body.unique_id ?? body.cuid; const cuid = typeof cuidRaw === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(cuidRaw.trim()) ? cuidRaw.trim() : null;
  ensureViExtState(); const at = now.toISOString();
  executeChanges(`INSERT INTO voip_extension_state(extension,state,since,cuid,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(extension) DO UPDATE SET since=CASE WHEN voip_extension_state.state=excluded.state THEN voip_extension_state.since ELSE excluded.since END,
    state=excluded.state, cuid=excluded.cuid, updated_at=excluded.updated_at`, [ext, state, at, cuid, at]);
  return true;
}

/** Marks the user leaves on an incoming call: closed (بستن پنجره) · later (بعداً) · log (ثبت تماس ورودی) · transfer (انتقال درخواست شد). */
let marksEnsured = false;
export function ensureViMarks(): void {
  if (marksEnsured) return;
  crmDb.exec(`CREATE TABLE IF NOT EXISTS voip_incoming_marks(event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY(event_id, user_id, action))`);
  marksEnsured = true;
}
/** Part 4: while flag.voip_incoming is on for the call's expert, an incoming call is NOT queued in the old after-call popup («تماس در جریان» / «نتیجه تماس»);
 *  the new popup shows it, and «ثبت تماس ورودی» (mark 'log') hands it back to the after-call editor. Flag off everywhere → "" (query unchanged). */
/** When the popup took over for this user: updated_at of the flag row that turned it on (user key first, then global). Calls that started
 *  earlier stay in the old after-call queue, so switching the flag on never moves an existing pending item out of it. */
export function viSince(userId: number): string | null {
  try {
    for (const k of [`${VI_FLAGS.incoming}.user.${Number(userId)}`, VI_FLAGS.incoming]) {
      const r = queryRow<{ value: string; updated_at: string | null }>("SELECT value,updated_at FROM call_queue_settings WHERE key=?", [k]);
      if (r?.value === "1") return r.updated_at || "1970-01-01T00:00:00Z";
    }
  } catch { /* table absent */ }
  return null;
}
export function viPendingFilterSql(): string {
  if (!viAnyOn("incoming")) return "";
  ensureViMarks();
  // Admin role never gets the new popup (parent steer 2026-11-03: call popups hidden for admin) → their incoming calls stay in the old queue.
  let users: { id: number; since: string }[] = [];
  try {
    users = (crmDb.prepare("SELECT u.id FROM users u JOIN voip_extensions e ON e.user_id=u.id WHERE u.role<>'admin' AND e.extension IS NOT NULL").all() as { id: number }[])
      .map(r => ({ id: Number(r.id), since: viSince(Number(r.id)) })).filter((x): x is { id: number; since: string } => Number.isSafeInteger(x.id) && !!x.since);
  } catch { return ""; }
  if (!users.length) return "";
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const who = users.map(x => `(e.expert_user_id=${x.id} AND julianday(e.started_at)>=julianday(${q(x.since)}))`).join(" OR ");
  return ` AND NOT (e.direction='incoming' AND (${who}) AND e.mobile_device_id IS NULL AND NOT EXISTS (SELECT 1 FROM voip_incoming_marks vim WHERE vim.event_id=e.id AND vim.action='log'))`;
}

/**
 * Attendance (t869): flag.attendance_v1 (absent = OFF). Additive schema only.
 * Pulls logs from a ZKTeco device (read-only) into attendance_logs, maps device PINs to CRM users,
 * and builds today's present/absent board and a monthly hours report.
 * Shift defaults are placeholders — no salary is computed.
 */
import { execute, executeChanges, queryRow, queryRows } from "./crm-db";
import { openCommKey, sealCommKey, commKeyNumber } from "./attendance-crypto";
import { zkErrorCode, zkRead } from "./zk-client";
import { ZK_PORT } from "./zk-protocol";

export const ATTENDANCE_FLAG = "flag.attendance_v1";
export const ATTENDANCE_MIGRATION = "attendance_v1";
export const ATTENDANCE_EXCLUDED_USER_IDS = [29];

/** Placeholder defaults — not confirmed payroll rules. Friday off, 09:00–18:00, 15 min grace. */
export const PLACEHOLDER_SHIFT_START = "09:00";
export const PLACEHOLDER_SHIFT_END = "18:00";
export const PLACEHOLDER_GRACE_MINUTES = 15;
/** ISO weekday: 0 Sun … 5 Fri … 6 Sat. Default off: Friday. */
export const PLACEHOLDER_WEEKLY_OFF = "5";

export function attendanceOn(): boolean {
  try {
    return queryRow<{ value: string }>("SELECT value FROM call_queue_settings WHERE key=?", [ATTENDANCE_FLAG])?.value === "1";
  } catch { return false; }
}

export function ensureAttendanceSchema(): void {
  execute(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  execute(`CREATE TABLE IF NOT EXISTS attendance_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 4370,
    comm_key_ct TEXT,
    device_sn TEXT,
    device_name TEXT,
    shift_start TEXT NOT NULL DEFAULT '09:00',
    shift_end TEXT NOT NULL DEFAULT '18:00',
    grace_minutes INTEGER NOT NULL DEFAULT 15,
    weekly_off TEXT NOT NULL DEFAULT '5',
    last_sync_at TEXT,
    last_error TEXT,
    last_ok_at TEXT,
    updated_by INTEGER,
    updated_at TEXT,
    configured_at TEXT
  )`);
  execute(`CREATE TABLE IF NOT EXISTS attendance_user_map (
    device_user_id TEXT PRIMARY KEY,
    device_user_name TEXT,
    crm_user_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  execute(`CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_user_id TEXT NOT NULL,
    punched_at TEXT NOT NULL,
    punch_status INTEGER,
    verify_type INTEGER,
    device_sn TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(device_user_id, punched_at, punch_status)
  )`);
  execute(`CREATE INDEX IF NOT EXISTS attendance_logs_punched ON attendance_logs(punched_at)`);
  if (!queryRow("SELECT 1 x FROM schema_migrations WHERE version=?", [ATTENDANCE_MIGRATION])) {
    execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", [ATTENDANCE_MIGRATION, new Date().toISOString()]);
  }
}

export type AttSettings = {
  host: string;
  port: number;
  hasCommKey: boolean;
  deviceSn: string | null;
  deviceName: string | null;
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  weeklyOff: number[];
  lastSyncAt: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  configured: boolean;
  defaultsArePlaceholders: true;
  placeholderNote: string;
  reachabilityWarning: string | null;
};

const PLACEHOLDER_NOTE = "ساعت شیفت، دقیقهٔ ارفاق و روز تعطیل هفته هنوز از طرف شما تأیید نشده‌اند و فعلاً مقدار پیش‌فرض هستند. مبلغ حقوق محاسبه نمی‌شود.";

export function isPrivateOrLocalHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h === "127.0.0.1" || h.startsWith("127.")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = m.map(Number);
  if (a[1] === 10) return true;
  if (a[1] === 192 && a[2] === 168) return true;
  if (a[1] === 172 && a[2] >= 16 && a[2] <= 31) return true;
  if (a[1] === 169 && a[2] === 254) return true;
  return false;
}

export function reachabilityWarning(host: string): string | null {
  if (!host) return null;
  if (!isPrivateOrLocalHost(host)) return null;
  return "این نشانی یک آی‌پی داخلی یا محلی است و از سرور CRM دیده نمی‌شود، مگر اینکه در دفتر آی‌پی عمومی ثابت داشته باشید و پورت ۴۳۷۰ را به دستگاه فوروارد کرده باشید. همان نشانی عمومی را اینجا وارد کنید.";
}

function parseWeeklyOff(raw: string | null | undefined): number[] {
  const parts = String(raw ?? PLACEHOLDER_WEEKLY_OFF).split(/[,،\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return parts.length ? [...new Set(parts)].sort() : [5];
}

type SettingsRow = {
  host: string; port: number; comm_key_ct: string | null; device_sn: string | null; device_name: string | null;
  shift_start: string; shift_end: string; grace_minutes: number; weekly_off: string;
  last_sync_at: string | null; last_error: string | null; last_ok_at: string | null; configured_at: string | null;
};

function rowToSettings(r: SettingsRow | undefined): AttSettings {
  const host = r?.host ?? "";
  return {
    host,
    port: r?.port ?? ZK_PORT,
    hasCommKey: Boolean(r?.comm_key_ct),
    deviceSn: r?.device_sn ?? null,
    deviceName: r?.device_name ?? null,
    shiftStart: r?.shift_start || PLACEHOLDER_SHIFT_START,
    shiftEnd: r?.shift_end || PLACEHOLDER_SHIFT_END,
    graceMinutes: r?.grace_minutes ?? PLACEHOLDER_GRACE_MINUTES,
    weeklyOff: parseWeeklyOff(r?.weekly_off),
    lastSyncAt: r?.last_sync_at ?? null,
    lastError: r?.last_error ?? null,
    lastOkAt: r?.last_ok_at ?? null,
    configured: Boolean(r?.configured_at && r.host),
    defaultsArePlaceholders: true,
    placeholderNote: PLACEHOLDER_NOTE,
    reachabilityWarning: reachabilityWarning(host),
  };
}

export function getSettings(): AttSettings {
  ensureAttendanceSchema();
  return rowToSettings(queryRow<SettingsRow>("SELECT * FROM attendance_settings WHERE id=1"));
}

function rawSettings(): SettingsRow | undefined {
  ensureAttendanceSchema();
  return queryRow<SettingsRow>("SELECT * FROM attendance_settings WHERE id=1");
}

function readCommKey(): number {
  const r = rawSettings();
  if (!r?.comm_key_ct) return 0;
  try { return commKeyNumber(openCommKey(r.comm_key_ct)); }
  catch { throw new Error("comm_key_unavailable"); }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type SaveSettingsInput = {
  host: string;
  port?: number;
  commKey?: string | null; // plaintext; omit/blank keeps existing; "-" or empty string after trim with clearCommKey clears
  clearCommKey?: boolean;
  shiftStart?: string;
  shiftEnd?: string;
  graceMinutes?: number;
  weeklyOff?: number[];
  deviceSn?: string | null;
  deviceName?: string | null;
  updatedBy?: number | null;
};

export function saveSettings(input: SaveSettingsInput): AttSettings {
  ensureAttendanceSchema();
  const cur = rawSettings();
  const host = String(input.host ?? cur?.host ?? "").trim();
  const port = input.port != null ? Number(input.port) : (cur?.port ?? ZK_PORT);
  if (!host) throw Object.assign(new Error("host_required"), { status: 400, publicMessage: "نشانی دستگاه را وارد کنید." });
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("bad_port"), { status: 400, publicMessage: "پورت نامعتبر است." });
  const shiftStart = String(input.shiftStart ?? cur?.shift_start ?? PLACEHOLDER_SHIFT_START);
  const shiftEnd = String(input.shiftEnd ?? cur?.shift_end ?? PLACEHOLDER_SHIFT_END);
  if (!HHMM.test(shiftStart) || !HHMM.test(shiftEnd)) throw Object.assign(new Error("bad_shift"), { status: 400, publicMessage: "ساعت شیفت را به صورت HH:MM وارد کنید." });
  const grace = input.graceMinutes != null ? Number(input.graceMinutes) : (cur?.grace_minutes ?? PLACEHOLDER_GRACE_MINUTES);
  if (!Number.isInteger(grace) || grace < 0 || grace > 180) throw Object.assign(new Error("bad_grace"), { status: 400, publicMessage: "دقیقهٔ ارفاق نامعتبر است." });
  const weeklyOff = input.weeklyOff ? parseWeeklyOff(input.weeklyOff.join(",")) : parseWeeklyOff(cur?.weekly_off);
  let commCt = cur?.comm_key_ct ?? null;
  if (input.clearCommKey) commCt = null;
  else if (input.commKey != null && String(input.commKey).trim() !== "") {
    commKeyNumber(String(input.commKey)); // validate
    commCt = sealCommKey(String(input.commKey).trim());
  }
  const now = new Date().toISOString();
  const configuredAt = host ? (cur?.configured_at || now) : cur?.configured_at || null;
  if (!cur) {
    execute(
      `INSERT INTO attendance_settings (id,host,port,comm_key_ct,device_sn,device_name,shift_start,shift_end,grace_minutes,weekly_off,updated_by,updated_at,configured_at)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [host, port, commCt, input.deviceSn ?? null, input.deviceName ?? null, shiftStart, shiftEnd, grace, weeklyOff.join(","), input.updatedBy ?? null, now, configuredAt],
    );
  } else {
    executeChanges(
      `UPDATE attendance_settings SET host=?, port=?, comm_key_ct=?, device_sn=COALESCE(?, device_sn), device_name=COALESCE(?, device_name),
        shift_start=?, shift_end=?, grace_minutes=?, weekly_off=?, updated_by=?, updated_at=?, configured_at=? WHERE id=1`,
      [host, port, commCt, input.deviceSn ?? null, input.deviceName ?? null, shiftStart, shiftEnd, grace, weeklyOff.join(","), input.updatedBy ?? null, now, configuredAt],
    );
  }
  return getSettings();
}

export type StaffRow = { id: number; name: string; username: string; role: string; suggestedDeviceUserId: string | null };

function normName(s: string): string {
  return String(s || "").replace(/[ي]/g, "ی").replace(/[ك]/g, "ک").replace(/\s+/g, " ").trim().toLowerCase();
}

export function listStaff(deviceUsers: { userId: string; name: string }[] = []): StaffRow[] {
  ensureAttendanceSchema();
  const users = queryRows<{ id: number; username: string; full_name: string | null; role: string }>(
    `SELECT id, username, full_name, role FROM users WHERE active=1 AND id NOT IN (${ATTENDANCE_EXCLUDED_USER_IDS.join(",") || "-1"}) ORDER BY COALESCE(NULLIF(full_name,''), username), id`,
  );
  return users.map((u) => {
    const name = (u.full_name || u.username || `کاربر ${u.id}`).trim();
    const n = normName(name);
    const un = normName(u.username);
    const hit = deviceUsers.find((d) => {
      const dn = normName(d.name);
      return (dn && (dn === n || n.includes(dn) || dn.includes(n))) || (d.userId && d.userId === String(u.id)) || (dn && dn === un);
    });
    return { id: u.id, name, username: u.username, role: u.role, suggestedDeviceUserId: hit?.userId ?? null };
  });
}

export function listMap(): { deviceUserId: string; deviceUserName: string | null; crmUserId: number }[] {
  ensureAttendanceSchema();
  return queryRows<{ device_user_id: string; device_user_name: string | null; crm_user_id: number }>(
    "SELECT device_user_id, device_user_name, crm_user_id FROM attendance_user_map ORDER BY device_user_id",
  ).map((r) => ({ deviceUserId: r.device_user_id, deviceUserName: r.device_user_name, crmUserId: r.crm_user_id }));
}

export function saveMap(entries: { deviceUserId: string; deviceUserName?: string | null; crmUserId: number | null }[]): void {
  ensureAttendanceSchema();
  const now = new Date().toISOString();
  for (const e of entries) {
    const pin = String(e.deviceUserId || "").trim();
    if (!pin) continue;
    if (e.crmUserId == null) {
      executeChanges("DELETE FROM attendance_user_map WHERE device_user_id=?", [pin]);
      continue;
    }
    const uid = Number(e.crmUserId);
    if (!Number.isInteger(uid) || ATTENDANCE_EXCLUDED_USER_IDS.includes(uid)) continue;
    const exists = queryRow("SELECT 1 x FROM users WHERE id=? AND active=1", [uid]);
    if (!exists) continue;
    execute(
      `INSERT INTO attendance_user_map(device_user_id, device_user_name, crm_user_id, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(device_user_id) DO UPDATE SET device_user_name=excluded.device_user_name, crm_user_id=excluded.crm_user_id, updated_at=excluded.updated_at`,
      [pin, e.deviceUserName ?? null, uid, now],
    );
  }
}

export type TestResult = {
  ok: boolean;
  error: string | null;
  info: { firmware: string | null; serial: string | null; deviceName: string | null } | null;
  users: { userId: string; name: string }[];
  punchCount: number;
  reachabilityWarning: string | null;
};

function deviceWallToIso(deviceLocal: Date): string {
  // Device clock is treated as Asia/Tehran wall time (no zone in the protocol).
  const y = deviceLocal.getUTCFullYear();
  const mo = deviceLocal.getUTCMonth();
  const d = deviceLocal.getUTCDate();
  const h = deviceLocal.getUTCHours();
  const mi = deviceLocal.getUTCMinutes();
  const s = deviceLocal.getUTCSeconds();
  const asTehran = tehranWallToUtc(y, mo + 1, d, h, mi, s);
  return asTehran.toISOString();
}

/** Convert a Tehran wall-clock timestamp to a UTC Date. Offset is +03:30 year-round (Iran DST abolished). */
export function tehranWallToUtc(year: number, month: number, day: number, hour: number, minute: number, second = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 3.5 * 3600 * 1000);
}

export function tehranParts(d = new Date()): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number; ymd: string; hm: string } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  return {
    year: Number(g("year")), month: Number(g("month")), day: Number(g("day")),
    hour: Number(g("hour")) % 24, minute: Number(g("minute")), second: Number(g("second")),
    weekday: weekdayMap[g("weekday")] ?? 0,
    ymd, hm: `${g("hour").padStart(2, "0")}:${g("minute")}`,
  };
}

export function jalaliParts(d = new Date()): { year: number; month: number; day: number; label: string } {
  const p = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value || 0);
  const label = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
  return { year: g("year"), month: g("month"), day: g("day"), label };
}

export function formatJalali(d: Date): string {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}

export function formatTehranClock(iso: string): string {
  return new Intl.DateTimeFormat("fa-IR-u-nu-latn", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

async function connectAndRead(host: string, port: number, commKey: number, timeoutMs?: number) {
  return zkRead({ host, port, commKey, timeoutMs });
}

export async function testConnection(opts?: { host?: string; port?: number; commKey?: string | null }): Promise<TestResult> {
  ensureAttendanceSchema();
  const cur = getSettings();
  const host = String(opts?.host ?? cur.host).trim();
  const port = Number(opts?.port ?? cur.port ?? ZK_PORT);
  let key = 0;
  if (opts?.commKey != null && String(opts.commKey).trim() !== "") key = commKeyNumber(String(opts.commKey));
  else key = readCommKey();
  const warn = reachabilityWarning(host);
  if (!host) return { ok: false, error: "host_required", info: null, users: [], punchCount: 0, reachabilityWarning: warn };
  try {
    const r = await connectAndRead(host, port, key);
    return {
      ok: true, error: null, info: r.info,
      users: r.users.map((u) => ({ userId: u.userId, name: u.name })),
      punchCount: r.punches.length,
      reachabilityWarning: warn,
    };
  } catch (e) {
    return { ok: false, error: zkErrorCode(e), info: null, users: [], punchCount: 0, reachabilityWarning: warn };
  }
}

export async function pullLogs(): Promise<{ ok: boolean; error: string | null; inserted: number; total: number }> {
  ensureAttendanceSchema();
  const cur = rawSettings();
  if (!cur?.host) return { ok: false, error: "not_configured", inserted: 0, total: 0 };
  const now = new Date().toISOString();
  executeChanges("UPDATE attendance_settings SET last_sync_at=? WHERE id=1", [now]);
  try {
    const key = readCommKey();
    const r = await connectAndRead(cur.host, cur.port, key);
    let inserted = 0;
    for (const p of r.punches) {
      const iso = deviceWallToIso(p.punchedAtDevice);
      const ch = executeChanges(
        `INSERT OR IGNORE INTO attendance_logs (device_user_id, punched_at, punch_status, verify_type, device_sn, created_at)
         VALUES (?,?,?,?,?,?)`,
        [p.userId, iso, p.status, p.punch, r.info.serial, now],
      );
      if (ch > 0) inserted++;
    }
    // also refresh seen device users into map names (do not invent crm links)
    const seenAt = now;
    for (const u of r.users) {
      executeChanges("UPDATE attendance_user_map SET device_user_name=COALESCE(?, device_user_name) WHERE device_user_id=?", [u.name || null, u.userId]);
    }
    void seenAt;
    executeChanges(
      "UPDATE attendance_settings SET last_ok_at=?, last_error=NULL, device_sn=COALESCE(?, device_sn), device_name=COALESCE(?, device_name) WHERE id=1",
      [now, r.info.serial, r.info.deviceName],
    );
    const total = queryRow<{ n: number }>("SELECT COUNT(*) n FROM attendance_logs")?.n ?? 0;
    return { ok: true, error: null, inserted, total };
  } catch (e) {
    const code = zkErrorCode(e);
    executeChanges("UPDATE attendance_settings SET last_error=? WHERE id=1", [code]);
    return { ok: false, error: code, inserted: 0, total: queryRow<{ n: number }>("SELECT COUNT(*) n FROM attendance_logs")?.n ?? 0 };
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function ymdRangeUtc(ymd: string): { from: string; to: string } {
  const [y, mo, d] = ymd.split("-").map(Number);
  const from = tehranWallToUtc(y, mo, d, 0, 0, 0);
  const to = tehranWallToUtc(y, mo, d + 1, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export type BoardPerson = {
  crmUserId: number;
  name: string;
  deviceUserId: string | null;
  status: "present" | "left" | "not_yet" | "absent" | "off" | "unmapped";
  statusLabel: string;
  firstIn: string | null;
  lastOut: string | null;
  firstInClock: string | null;
  lastOutClock: string | null;
  late: boolean;
};

export function todayBoard(now = new Date(), ymd?: string): {
  date: string; jalaliLabel: string; timezone: "Asia/Tehran";
  shiftStart: string; shiftEnd: string; graceMinutes: number;
  defaultsArePlaceholders: true; placeholderNote: string;
  lastSyncAt: string | null; lastError: string | null;
  people: BoardPerson[];
} {
  ensureAttendanceSchema();
  const settings = getSettings();
  const tp = ymd ? (() => {
    const [y, mo, d] = ymd.split("-").map(Number);
    const dt = tehranWallToUtc(y, mo, d, 12, 0, 0);
    return { ...tehranParts(dt), ymd };
  })() : tehranParts(now);
  const day = ymd || tp.ymd;
  const { from, to } = ymdRangeUtc(day);
  const isOff = settings.weeklyOff.includes(tp.weekday);
  const nowMin = tp.ymd === day ? tp.hour * 60 + tp.minute : 24 * 60;
  const startMin = minutesOf(settings.shiftStart);
  const logs = queryRows<{ device_user_id: string; punched_at: string; punch_status: number | null }>(
    "SELECT device_user_id, punched_at, punch_status FROM attendance_logs WHERE punched_at >= ? AND punched_at < ? ORDER BY punched_at, id",
    [from, to],
  );
  const byPin = new Map<string, typeof logs>();
  for (const l of logs) {
    const a = byPin.get(l.device_user_id) || [];
    a.push(l);
    byPin.set(l.device_user_id, a);
  }
  const staff = listStaff();
  const map = listMap();
  const used = new Set<number>();
  const people: BoardPerson[] = [];
  const label: Record<BoardPerson["status"], string> = {
    present: "حاضر", left: "خارج‌شده", not_yet: "هنوز نیامده", absent: "غایب", off: "تعطیل", unmapped: "بدون تناظر",
  };

  const pushFor = (crmUserId: number, name: string, pin: string | null) => {
    const punches = pin ? (byPin.get(pin) || []) : [];
    const first = punches[0]?.punched_at ?? null;
    const last = punches.length > 1 ? punches[punches.length - 1]!.punched_at : null;
    let status: BoardPerson["status"];
    if (isOff && punches.length === 0) status = "off";
    else if (!pin) status = "unmapped";
    else if (punches.length === 0) status = nowMin < startMin + settings.graceMinutes ? "not_yet" : "absent";
    else if (punches.length > 1) status = "left";
    else status = "present";
    const firstMin = first ? (() => { const t = tehranParts(new Date(first)); return t.hour * 60 + t.minute; })() : null;
    const late = Boolean(firstMin != null && !isOff && firstMin > startMin + settings.graceMinutes);
    people.push({
      crmUserId, name, deviceUserId: pin, status, statusLabel: label[status],
      firstIn: first, lastOut: last,
      firstInClock: first ? formatTehranClock(first) : null,
      lastOutClock: last ? formatTehranClock(last) : null,
      late,
    });
  };

  for (const s of staff) {
    const m = map.find((x) => x.crmUserId === s.id);
    used.add(s.id);
    pushFor(s.id, s.name, m?.deviceUserId ?? null);
  }
  // mapped pins whose CRM user was missed (shouldn't happen if active)
  for (const m of map) {
    if (used.has(m.crmUserId)) continue;
    const u = queryRow<{ id: number; full_name: string | null; username: string }>("SELECT id, full_name, username FROM users WHERE id=?", [m.crmUserId]);
    if (!u || ATTENDANCE_EXCLUDED_USER_IDS.includes(u.id)) continue;
    pushFor(u.id, (u.full_name || u.username).trim(), m.deviceUserId);
  }

  const order: Record<BoardPerson["status"], number> = { absent: 0, not_yet: 1, present: 2, left: 3, off: 4, unmapped: 5 };
  people.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, "fa"));

  const noon = tehranWallToUtc(tp.year, tp.month, tp.day, 12, 0, 0);
  return {
    date: day,
    jalaliLabel: formatJalali(noon),
    timezone: "Asia/Tehran",
    shiftStart: settings.shiftStart,
    shiftEnd: settings.shiftEnd,
    graceMinutes: settings.graceMinutes,
    defaultsArePlaceholders: true,
    placeholderNote: PLACEHOLDER_NOTE,
    lastSyncAt: settings.lastSyncAt,
    lastError: settings.lastError,
    people,
  };
}

export type MonthDay = {
  date: string;
  jalaliDay: number;
  off: boolean;
  firstInClock: string | null;
  lastOutClock: string | null;
  workMinutes: number | null;
  late: boolean;
  absent: boolean;
};

export type MonthPerson = {
  crmUserId: number;
  name: string;
  deviceUserId: string | null;
  workMinutes: number;
  workHoursLabel: string;
  lateDays: number;
  absentDays: number;
  days: MonthDay[];
};

function jalaliMonthRange(jy: number, jm: number): { start: Date; end: Date; days: { date: string; jalaliDay: number; weekday: number }[] } {
  // Scan Tehran midnights around Gregorian (jy+621) until the Jalali month is covered.
  const days: { date: string; jalaliDay: number; weekday: number }[] = [];
  const startScan = tehranWallToUtc(jy + 621, 2, 1, 12, 0, 0);
  let start: Date | null = null;
  for (let i = 0; i < 400; i++) {
    const d = new Date(startScan.getTime() + i * 86400000);
    const jp = jalaliParts(d);
    if (jp.year === jy && jp.month === jm) {
      if (!start) start = d;
      const tp = tehranParts(d);
      days.push({ date: tp.ymd, jalaliDay: jp.day, weekday: tp.weekday });
    } else if (start) break;
  }
  if (!start || !days.length) throw new Error("bad_jalali_month");
  const end = new Date(start.getTime() + days.length * 86400000);
  return { start, end, days };
}

function hoursLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const fa = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
  if (h && m) return `${fa(h)} ساعت و ${fa(m)} دقیقه`;
  if (h) return `${fa(h)} ساعت`;
  return `${fa(m)} دقیقه`;
}

export function monthlyReport(jy: number, jm: number, now = new Date()): {
  jalaliYear: number; jalaliMonth: number; jalaliMonthLabel: string; timezone: "Asia/Tehran";
  shiftStart: string; shiftEnd: string; graceMinutes: number;
  defaultsArePlaceholders: true; placeholderNote: string; noSalaryComputed: true;
  lastSyncAt: string | null; lastError: string | null;
  people: MonthPerson[];
} {
  ensureAttendanceSchema();
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || jm < 1 || jm > 12 || jy < 1300 || jy > 1600) {
    throw Object.assign(new Error("bad_month"), { status: 400, publicMessage: "ماه نامعتبر است." });
  }
  const settings = getSettings();
  const range = jalaliMonthRange(jy, jm);
  const from = ymdRangeUtc(range.days[0]!.date).from;
  const lastDay = range.days[range.days.length - 1]!.date;
  const to = ymdRangeUtc(lastDay).to;
  const logs = queryRows<{ device_user_id: string; punched_at: string }>(
    "SELECT device_user_id, punched_at FROM attendance_logs WHERE punched_at >= ? AND punched_at < ? ORDER BY punched_at, id",
    [from, to],
  );
  const today = tehranParts(now).ymd;
  const staff = listStaff();
  const map = listMap();
  const startMin = minutesOf(settings.shiftStart);

  const punchesOn = (pin: string | null, date: string) => {
    if (!pin) return [];
    const { from: f, to: t } = ymdRangeUtc(date);
    return logs.filter((l) => l.device_user_id === pin && l.punched_at >= f && l.punched_at < t);
  };

  const people: MonthPerson[] = staff.map((s) => {
    const pin = map.find((m) => m.crmUserId === s.id)?.deviceUserId ?? null;
    const days: MonthDay[] = range.days.map((d) => {
      const off = settings.weeklyOff.includes(d.weekday);
      const future = d.date > today;
      const ps = punchesOn(pin, d.date);
      const first = ps[0]?.punched_at ?? null;
      const last = ps.length > 1 ? ps[ps.length - 1]!.punched_at : null;
      const firstMin = first ? (() => { const t = tehranParts(new Date(first)); return t.hour * 60 + t.minute; })() : null;
      const lastMin = last ? (() => { const t = tehranParts(new Date(last)); return t.hour * 60 + t.minute; })() : null;
      const workMinutes = firstMin != null && lastMin != null ? Math.max(0, lastMin - firstMin) : null;
      const late = Boolean(!off && !future && firstMin != null && firstMin > startMin + settings.graceMinutes);
      const absent = Boolean(!off && !future && pin && ps.length === 0);
      return {
        date: d.date, jalaliDay: d.jalaliDay, off,
        firstInClock: first ? formatTehranClock(first) : null,
        lastOutClock: last ? formatTehranClock(last) : null,
        workMinutes, late, absent,
      };
    });
    const workMinutes = days.reduce((a, d) => a + (d.workMinutes || 0), 0);
    return {
      crmUserId: s.id, name: s.name, deviceUserId: pin,
      workMinutes, workHoursLabel: hoursLabel(workMinutes),
      lateDays: days.filter((d) => d.late).length,
      absentDays: days.filter((d) => d.absent).length,
      days,
    };
  });

  const monthLabel = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", { timeZone: "Asia/Tehran", month: "long", year: "numeric" }).format(range.start);
  return {
    jalaliYear: jy, jalaliMonth: jm, jalaliMonthLabel: monthLabel, timezone: "Asia/Tehran",
    shiftStart: settings.shiftStart, shiftEnd: settings.shiftEnd, graceMinutes: settings.graceMinutes,
    defaultsArePlaceholders: true, placeholderNote: PLACEHOLDER_NOTE, noSalaryComputed: true,
    lastSyncAt: settings.lastSyncAt, lastError: settings.lastError,
    people,
  };
}

let pullTimer: ReturnType<typeof setInterval> | null = null;
let pullRunning = false;

export async function attendanceTick(): Promise<void> {
  if (!attendanceOn()) return;
  ensureAttendanceSchema();
  const s = getSettings();
  if (!s.configured) return;
  if (pullRunning) return;
  pullRunning = true;
  try { await pullLogs(); }
  catch (e) {
    try { executeChanges("UPDATE attendance_settings SET last_error=? WHERE id=1", [zkErrorCode(e)]); } catch { /* ignore */ }
  }
  finally { pullRunning = false; }
}

export function startAttendanceJobs(): ReturnType<typeof setInterval> | null {
  if (pullTimer) return pullTimer;
  const ms = Number(process.env.ATTENDANCE_PULL_MS) > 0 ? Number(process.env.ATTENDANCE_PULL_MS) : 3 * 60_000;
  pullTimer = setInterval(() => { void attendanceTick(); }, ms);
  pullTimer.unref?.();
  return pullTimer;
}

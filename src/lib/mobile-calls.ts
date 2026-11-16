import { createHash, randomBytes } from "node:crypto";
import { crmDb, execute, executeChanges, queryRow, queryRows, runTransaction } from "./crm-db";
import { getAuthUserById, type AuthUser } from "./auth";
import { canAccessAfterCallCustomer, customerMatcher, ensureAfterCallSchema, eventFor, finishSavedLiveReport, normalizePhone, type AfterCallEvent } from "./voip-after-call";
import { notifyCallReport } from "./voip-call-notifications";

export class MobileCallError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function ensureMobileCallSchema() {
  ensureAfterCallSchema();
  crmDb.exec(`CREATE TABLE IF NOT EXISTS mobile_call_devices(
    id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,device_name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,created_by INTEGER NOT NULL,last_seen_at TEXT,
    revoked_at TEXT,revoked_by INTEGER,FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS idx_mobile_call_devices_user ON mobile_call_devices(user_id,active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_call_unique ON voip_after_call_events(mobile_device_id,mobile_call_id)
      WHERE mobile_device_id IS NOT NULL;`);
}
type Device = { id: number; user_id: number; device_name: string; active: number; created_at: string; last_seen_at: string | null; expert_name: string };
const deviceSelect = `SELECT d.*,COALESCE(NULLIF(u.full_name,''),u.username) expert_name
  FROM mobile_call_devices d JOIN users u ON u.id=d.user_id`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const deviceDTO = (d: Device) => ({
  id: d.id, userId: d.user_id, expertName: d.expert_name, deviceName: d.device_name,
  active: !!d.active, createdAt: d.created_at, lastSeenAt: d.last_seen_at,
});
export function listMobileDevices() { return queryRows<Device>(`${deviceSelect} ORDER BY d.id DESC`).map(deviceDTO); }
export function mobileExperts() {
  return queryRows<{id: number}>("SELECT id FROM users WHERE active=1 ORDER BY id")
    .map(row => getAuthUserById(row.id)!)
    .filter(user => user.role === "admin" || user.permissions.includes("calls.view"))
    .map(user => ({ id: user.id, name: user.fullName || user.username }));
}
export function createMobileDevice(actor: AuthUser, userId: number, name: string) {
  const user = getAuthUserById(userId);
  if (!user?.active || (user.role !== "admin" && !user.permissions.includes("calls.view")))
    throw new MobileCallError(422, "کارشناس فعال با مجوز مشاهدهٔ تماس انتخاب کنید.");
  if (!name.trim()) throw new MobileCallError(400, "نام دستگاه لازم است.");
  const token = `mcall_${randomBytes(32).toString("base64url")}`;
  const id = execute("INSERT INTO mobile_call_devices(user_id,device_name,token_hash,created_at,created_by) VALUES(?,?,?,?,?)",
    [user.id, name.trim(), hash(token), new Date().toISOString(), actor.id]);
  return { device: deviceDTO(queryRow<Device>(`${deviceSelect} WHERE d.id=?`, [id])!), token };
}
export function revokeMobileDevice(id: number, actor: AuthUser) {
  if (!queryRow("SELECT id FROM mobile_call_devices WHERE id=?", [id])) throw new MobileCallError(404, "دستگاه یافت نشد.");
  executeChanges("UPDATE mobile_call_devices SET active=0,revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?) WHERE id=?",
    [new Date().toISOString(), actor.id, id]);
  return { ok: true };
}
export function authenticateMobileDevice(authorization?: string) {
  const token = /^Bearer (mcall_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? "")?.[1];
  if (!token) throw new MobileCallError(401, "کلید اتصال اپلیکیشن معتبر نیست.");
  const device = queryRow<Device>(`${deviceSelect} WHERE d.token_hash=? AND d.active=1`, [hash(token)]);
  const user = device ? getAuthUserById(device.user_id) : undefined;
  if (!device || !user?.active || (user.role !== "admin" && !user.permissions.includes("calls.view")))
    throw new MobileCallError(401, "کلید اتصال غیرفعال یا لغو شده است.");
  return { device, user };
}
export function mobileCallDTO(e: AfterCallEvent, actor?: AuthUser) {
  const device = queryRow<{device_name: string}>("SELECT device_name FROM mobile_call_devices WHERE id=?", [e.mobile_device_id]);
  return {
    id: e.id, callId: e.mobile_call_id!, deviceId: e.mobile_device_id!, deviceName: device?.device_name ?? "دستگاه حذف‌شده",
    expertUserId: e.expert_user_id!, expertName: e.expert_name ?? "کارشناس",
    direction: e.direction as "incoming" | "outgoing", callerNumber: e.caller_number!, calleeNumber: e.callee_number!,
    contactName: e.contact_name ?? "", startedAt: e.started_at, answeredAt: e.mobile_answered_at,
    endedAt: e.is_live ? null : e.ended_at, durationSeconds: e.duration_seconds, status: e.status, isLive: !!e.is_live,
    subject: e.report_subject, expertNotes: e.expert_notes, reportSavedAt: e.report_saved_at,
    customerId: actor && canAccessAfterCallCustomer(e, actor) ? e.actual_customer_id : null,
  };
}
type Start = { callId: string; direction: "incoming" | "outgoing"; callerNumber: string; calleeNumber: string; contactName: string; startedAt: string | Date; answeredAt?: string | Date | null };
type End = Start & { endedAt: string | Date; durationSeconds: number; status: "completed" | "missed" | "rejected" | "failed" };
function dateISO(value: string | Date): string {
  if (typeof value === "string" && !/(Z|[+-]\d\d:\d\d)$/i.test(value)) throw new MobileCallError(400, "زمان تماس باید دارای منطقهٔ زمانی باشد.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 300_000) throw new MobileCallError(400, "زمان تماس معتبر نیست یا در آینده است.");
  return date.toISOString();
}
function phone(value: string) {
  const text = value.trim().replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (text === "unknown") return text; // Withheld caller identity must not lose the call.
  const clean = text.replace(/[\s()-]/g, "");
  if (!/^\+?\d{1,20}$/.test(clean)) throw new MobileCallError(400, "شمارهٔ تماس معتبر نیست؛ برای شمارهٔ مخفی مقدار unknown بفرستید.");
  return normalizePhone(clean) ?? clean;
}
export function ingestMobileCall(connection: ReturnType<typeof authenticateMobileDevice>, input: Start | End, ending: boolean) {
  const { device, user } = connection;
  const caller = phone(input.callerNumber), callee = phone(input.calleeNumber), started = dateISO(input.startedAt);
  const answered = input.answeredAt ? dateISO(input.answeredAt) : null;
  const end = ending ? input as End : null, ended = end ? dateISO(end.endedAt) : null;
  if ((answered && answered < started) || (ended && (ended < started || (answered && answered > ended))))
    throw new MobileCallError(400, "ترتیب زمان‌های شروع، پاسخ و پایان تماس معتبر نیست.");
  if (end && (end.durationSeconds > Math.floor((Date.parse(ended!) - Date.parse(answered ?? started)) / 1000) + 1 ||
    (end.status !== "completed" && (end.durationSeconds !== 0 || answered))))
    throw new MobileCallError(400, "مدت مکالمه با زمان یا وضعیت تماس سازگار نیست.");
  let id = 0;
  runTransaction(() => {
    const existing = queryRow<{id: number}>("SELECT id FROM voip_after_call_events WHERE mobile_device_id=? AND mobile_call_id=?", [device.id, input.callId]);
    let event = existing ? eventFor(existing.id)! : undefined;
    if (event && (event.started_at !== started || event.direction !== input.direction ||
      event.caller_number !== caller || event.callee_number !== callee || event.contact_name !== input.contactName.trim()))
      throw new MobileCallError(409, "این شناسهٔ تماس قبلاً با اطلاعات متفاوت ثبت شده است.");
    if (event && answered && event.mobile_answered_at && answered !== event.mobile_answered_at)
      throw new MobileCallError(409, "زمان پاسخ تماس با سابقهٔ ثبت‌شده متفاوت است.");
    const effectiveAnswered = answered ?? event?.mobile_answered_at;
    const effectiveEnd = ended ?? (event && !event.is_live ? event.ended_at : null);
    const effectiveDuration = end?.durationSeconds ?? event?.duration_seconds;
    if (effectiveAnswered && effectiveEnd && (effectiveAnswered > effectiveEnd ||
      (effectiveDuration != null && effectiveDuration > Math.floor((Date.parse(effectiveEnd) - Date.parse(effectiveAnswered)) / 1000) + 1) ||
      (end?.status ?? event?.status) !== "completed"))
      throw new MobileCallError(400, "زمان پاسخ با پایان یا مدت مکالمهٔ ثبت‌شده سازگار نیست.");
    if (event && end && !event.is_live && (event.ended_at !== ended || event.duration_seconds !== end.durationSeconds || event.status !== end.status))
      throw new MobileCallError(409, "پایان این تماس قبلاً با اطلاعات دیگری ثبت شده است.");
    if (!event) {
      const otherPhone = input.direction === "incoming" ? caller : callee;
      const customer = customerMatcher()(otherPhone);
      id = execute(`INSERT INTO voip_after_call_events(
        external_id,phone,direction,status,started_at,ended_at,extension,extensions_json,expert_user_id,expert_name,
        salesperson_id,customer_id,has_recording,is_live,auto_capture,mobile_device_id,mobile_call_id,caller_number,callee_number,
        contact_name,mobile_answered_at,duration_seconds)
        VALUES(?,?,?,?,?,?,NULL,'[]',?,?,?,?,0,?,1,?,?,?,?,?,?,?)`,
        [`mobile:${device.id}:${input.callId}`, otherPhone, input.direction, end?.status ?? (answered ? "active" : "ringing"),
          started, ended ?? started, user.id, user.fullName || user.username, user.salespersonId, customer?.id ?? null,
          ending ? 0 : 1, device.id, input.callId, caller, callee, input.contactName.trim(), answered, end?.durationSeconds ?? null]);
      event = eventFor(id)!;
      if (customer) {
        const callLogId = execute(`INSERT INTO call_logs(customer_id,salesperson_id,salesperson_name_snapshot,subject,customer_request,expert_notes,created_at)
          VALUES(?,?,?,NULL,NULL,'',?)`, [customer.id, user.salespersonId, user.fullName || user.username, started]);
        executeChanges("UPDATE voip_after_call_events SET call_log_id=? WHERE id=?", [callLogId, id]);
      }
    } else {
      id = event.id;
      if (ending && event.is_live) executeChanges("UPDATE voip_after_call_events SET is_live=0,status=?,ended_at=?,duration_seconds=? WHERE id=?",
        [end!.status, ended, end!.durationSeconds, id]);
      if (answered && !event.mobile_answered_at) executeChanges("UPDATE voip_after_call_events SET mobile_answered_at=?,status=CASE WHEN is_live=1 THEN 'active' ELSE status END WHERE id=?", [answered, id]);
    }
    // Completion is independent of report edits; never overwrite subject/notes.
    finishSavedLiveReport(id);
    executeChanges("UPDATE mobile_call_devices SET last_seen_at=? WHERE id=?", [new Date().toISOString(), device.id]);
  });
  notifyCallReport(user.id);
  // Device credentials announce calls; they do not grant CRM report/profile reads.
  return { ...mobileCallDTO(eventFor(id)!), subject: null, expertNotes: "", reportSavedAt: null };
}
type Filters = { fromDate?: string; toDate?: string; direction?: string; expertUserId?: number; search?: string; limit?: number; offset?: number };
export function listMobileCalls(actor: AuthUser, filters: Filters) {
  const where = ["e.mobile_device_id IS NOT NULL"], params: (string | number)[] = [];
  const expert = actor.role === "admin" ? filters.expertUserId : actor.id;
  if (actor.role !== "admin" && filters.expertUserId && filters.expertUserId !== actor.id)
    throw new MobileCallError(403, "فقط تماس‌های خودتان در دسترس است.");
  if (expert) { where.push("e.expert_user_id=?"); params.push(expert); }
  for (const day of [filters.fromDate, filters.toDate]) if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day))
    throw new MobileCallError(400, "تاریخ فیلتر معتبر نیست.");
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) throw new MobileCallError(400, "بازهٔ تاریخ معتبر نیست.");
  if (filters.fromDate) { where.push("julianday(e.started_at)>=julianday(?)"); params.push(`${filters.fromDate}T00:00:00+03:30`); }
  if (filters.toDate) { where.push("julianday(e.started_at)<julianday(?,'+1 day')"); params.push(`${filters.toDate}T00:00:00+03:30`); }
  if (filters.direction) { where.push("e.direction=?"); params.push(filters.direction); }
  if (filters.search?.trim()) {
    where.push("(instr(e.caller_number,?)>0 OR instr(e.callee_number,?)>0 OR instr(e.contact_name,?)>0)");
    params.push(...Array<string>(3).fill(filters.search.trim()));
  }
  const sql = where.join(" AND ");
  const stats = queryRow<{total: number; totalDurationSeconds: number; incomingCount: number; outgoingCount: number}>(`SELECT COUNT(*) total,
    COALESCE(SUM(duration_seconds),0) totalDurationSeconds,COALESCE(SUM(direction='incoming'),0) incomingCount,
    COALESCE(SUM(direction='outgoing'),0) outgoingCount FROM voip_after_call_events e WHERE ${sql}`, params)!;
  const ids = queryRows<{id: number}>(`SELECT e.id FROM voip_after_call_events e WHERE ${sql} ORDER BY e.started_at DESC,e.id DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit ?? 50, filters.offset ?? 0]);
  return { ...stats, items: ids.map(row => mobileCallDTO(eventFor(row.id)!, actor)) };
}
